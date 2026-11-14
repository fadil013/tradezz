// Claude Code session: the user picks a model label, a time limit and a bankroll in the UI,
// then a Claude Code terminal session takes over through the local REST API (no API key).
// The server enforces the limits: trades are refused outside the session, above the remaining
// bankroll, or after time is up.
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS } from './config.js';

const MODELS = ['haiku', 'sonnet', 'opus'];
const INDS = ['sma', 'ema', 'bb', 'dc'];
const OVERS = ['fib', 'sr', 'sd', 'ob', 'fvg', 'sweep', 'bos', 'trend', 'channel', 'pitch', 'ext', 'wave', 'hs', 'pos', 'vp'];
const round2 = (n) => Math.round(n * 100) / 100;

export class CCSession {
  constructor({ feed, broker, agent, file }) {
    Object.assign(this, { feed, broker, agent, file });
    this.s = { active: false, model: 'sonnet', minutes: 30, budget: 500, startedAt: 0, endsAt: 0, endedReason: '', lastSeen: 0, prompt: '', promptAt: 0, pending: false, reply: '', summary: null };
    try { this.s = { ...this.s, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
    if (this.s.active && Date.now() >= this.s.endsAt) this.finish('time is up');
    this.timer = setInterval(() => this.tick(), 1000);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.s));
    } catch { /* ignore */ }
  }

  mine() {
    return this.broker.trades.filter((t) => t.source === 'claude-code' && t.openTime >= this.s.startedAt);
  }

  money() {
    const mine = this.mine();
    const pnl = round2(mine.filter((t) => t.status !== 'open').reduce((a, t) => a + (t.profit || 0), 0));
    const openStake = round2(mine.filter((t) => t.status === 'open').reduce((a, t) => a + t.amount, 0));
    const left = round2(Math.max(0, this.s.budget + pnl - openStake));
    return { pnl, openStake, left, trades: mine.length, wins: mine.filter((t) => t.status === 'won').length, losses: mine.filter((t) => t.status === 'lost').length };
  }

  state() {
    const m = this.s.startedAt ? this.money() : { pnl: 0, openStake: 0, left: this.s.budget, trades: 0, wins: 0, losses: 0 };
    return {
      ...this.s,
      remainingSec: this.s.active ? Math.max(0, Math.round((this.s.endsAt - Date.now()) / 1000)) : 0,
      connected: this.s.active && Date.now() - this.s.lastSeen < 90000,
      ...m,
    };
  }

  // The user's instruction from the UI box. A Claude Code session reads it, sets the limits and trades.
  submit({ model, prompt }) {
    prompt = String(prompt || '').trim().slice(0, 2000);
    if (!prompt) throw new Error('Write what you want Claude Code to do');
    this.s.model = MODELS.includes(model) ? model : this.s.model;
    this.s.prompt = prompt;
    this.s.promptAt = Date.now();
    this.s.pending = true;
    this.s.reply = '';
    this.save();
    this.agent.push();
  }

  // A short message from Claude Code shown in the UI (questions, status).
  say(text) {
    this.s.reply = String(text || '').slice(0, 600);
    this.s.pending = false;
    this.touch();
    this.save();
    this.agent.push();
  }

  start({ model, minutes, budget }) {
    model = MODELS.includes(model) ? model : 'sonnet';
    minutes = Math.min(1440, Math.max(1, Math.round(Number(minutes)) || 30));
    budget = Math.min(this.broker.balance, Math.max(1, Number(budget) || 500));
    const now = Date.now();
    this.s = { active: true, model, minutes, budget: round2(budget), startedAt: now, endsAt: now + minutes * 60000, endedReason: '', lastSeen: 0, prompt: this.s.prompt, promptAt: this.s.promptAt, pending: false, reply: this.s.reply, summary: null };
    this.save();
    this.agent.push();
  }

  finish(reason) {
    if (!this.s.active) return;
    this.s.active = false;
    this.s.endedReason = reason;
    this.save();
    this.agent.push();
  }

  stop() { this.finish('stopped by you'); }

  // Live "process" shown on screen while Claude analyses: which asset is in focus and the steps so far.
  stage(symbol, line) {
    if (symbol === null) this.s.stage = null;
    else { const st = this.s.stage || { lines: [] }; st.symbol = symbol; st.lines = [...st.lines, line].slice(-12); this.s.stage = st; }
    this.agent.push();
  }

  // Once every trade of the session has settled, post a plain summary (count, won, lost, net).
  summarize() {
    if (this.busy) return;
    const mine = this.mine();
    if (!mine.length || mine.some((t) => t.status === 'open')) return;
    const key = mine.length + ':' + mine[mine.length - 1].id;
    if (this.sumKey === key) return;
    this.sumKey = key;
    const won = mine.filter((t) => t.status === 'won');
    const lost = mine.filter((t) => t.status === 'lost');
    const gain = round2(won.reduce((a, t) => a + t.profit, 0));
    const loss = round2(lost.reduce((a, t) => a + t.amount, 0));
    const net = round2(gain - loss);
    const dec = won.length + lost.length;
    const volume = round2(mine.reduce((a, t) => a + t.amount, 0));
    this.s.summary = { n: mine.length, won: won.length, lost: lost.length, gain, loss, net, at: Date.now(), winRate: dec ? Math.round((won.length / dec) * 1000) / 10 : null, volume, roi: volume ? Math.round((net / volume) * 1000) / 10 : 0, trades: mine.slice(-12).map((t) => ({ sym: t.symbol, dir: t.dir, amount: t.amount, profit: t.profit || 0, status: t.status, dur: t.duration })) };
    this.say(`Summary: ${mine.length} trades, ${won.length} won, ${lost.length} lost. Won +$${gain}, lost -$${loss}. Net ${net >= 0 ? '+' : '-'}$${Math.abs(net)}.`);
  }

  tick() {
    this.summarize();
    if (!this.s.active) return;
    if (Date.now() >= this.s.endsAt) return this.finish('time is up');
    const m = this.money();
    if (m.left < LIMITS.minStake && m.openStake === 0) this.finish('bankroll used up');
  }

  touch() {
    if (!this.s.active) return;
    const first = !this.s.lastSeen;
    this.s.lastSeen = Date.now();
    if (first) this.agent.push();
  }

  // Called before a claude-code trade is opened. Returns the model label to record.
  guard(amount) {
    if (!this.s.active) throw new Error('No Claude Code session is running. The user must press START in Claude > Claude Code first.');
    const m = this.money();
    if (Number(amount) > m.left) throw new Error(`Session bankroll left is $${m.left.toFixed(2)} - stake is too big`);
    this.touch();
    return 'claude-code';
  }

  // Chart drawing from Claude Code: levels, trendlines, indicators, note.
  draw(d) {
    if (!this.s.active) throw new Error('No Claude Code session is running');
    this.touch();
    const sym = d.symbol;
    if (!this.feed.price(sym)?.p) throw new Error('Unknown symbol');
    const clean = this.agent.sanitizeDrawing({ symbol: sym, levels: d.levels, lines: d.lines });
    this.agent.drawings[sym] = {
      time: Date.now(),
      strategy: String(d.strategy || 'Analysis').slice(0, 60),
      action: ['call', 'put'].includes(d.action) ? d.action : 'skip',
      duration: Number(d.duration) || 60,
      confidence: Math.round(Number(d.confidence) || 0),
      reasoning: String(d.reasoning || '').slice(0, 600),
      levels: clean.levels,
      lines: clean.lines,
      indicators: (Array.isArray(d.indicators) ? d.indicators : []).filter((i) => INDS.includes(i)),
      overlays: (Array.isArray(d.overlays) ? d.overlays : []).filter((o) => OVERS.includes(o)),
      by: 'claude-code',
      tradeId: null,
    };
    this.agent.save();
    this.agent.push();
    return this.agent.drawings[sym];
  }
}

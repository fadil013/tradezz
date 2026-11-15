// Claude as the trader. Every cycle it receives a market snapshot (live candles + indicators
// + its own track record), analyses every asset like a professional, DRAWS its strategy
// (support / resistance / trendlines) and decides call / put / skip. The broker then executes
// those decisions with FAKE money. Everything it says and does is logged for review.

import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { SYMBOLS, AGENT_MODELS, LIMITS } from './config.js';
import { signal as modelSignal } from './model.js';
import * as ind from './indicators.js';

const DURATIONS = [30, 60, 120, 180, 300];
const hhmmss = (sec) => new Date(sec * 1000).toISOString().slice(11, 19);
const pct = (n, d = 2) => (n == null ? 'n/a' : (n >= 0 ? '+' : '') + n.toFixed(d) + '%');
const num = (n, d) => (n == null ? 'n/a' : n.toFixed(d));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function rows(candles, d) {
  return candles
    .map((c, i) => `${hhmmss(c[0])} ${c[1].toFixed(d)} ${c[2].toFixed(d)} ${c[3].toFixed(d)} ${c[4].toFixed(d)}${i === candles.length - 1 ? '  <- forming' : ''}`)
    .join('\n');
}

// Plain-text market snapshot. Used by the Claude agent and by GET /api/snapshot (so a Claude Code
// session can read exactly the same thing and trade through the HTTP API).
export function buildSnapshot(feed, broker) {
  const L = [];
  const cs = broker.stats('claude');
  const open = broker.openTrades();
  L.push(`NOW: ${new Date().toISOString()} (UTC)`);
  try {
    const sg = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'].map((id) => modelSignal(feed, id, 60)).filter(Boolean);
    if (sg.length) L.push('QUANT MODEL (logistic regression on order flow + returns, walk-forward tested ~52% overall, ~54% on edge>=5%; one input, not an oracle): ' + sg.map((g) => `${g.id.replace('USDT', '')} P(up,60s)=${g.p.toFixed(3)}`).join(', '));
  } catch { /* model optional */ }
  L.push(`ACCOUNT: demo balance $${broker.balance.toFixed(2)} | open trades: ${open.length}`);
  L.push(
    `YOUR RECORD SO FAR: ${cs.trades} settled trades, ${cs.wins}W/${cs.losses}L/${cs.draws}D, win rate ${cs.winRate ?? 'n/a'}%, P/L $${cs.pnl.toFixed(2)}`,
  );

  if (open.length) {
    L.push('\nOPEN TRADES:');
    for (const t of open) {
      const s = SYMBOLS.find((x) => x.id === t.symbol);
      const { p } = feed.price(t.symbol);
      const win = t.dir === 'buy' ? p > t.openPrice : p < t.openPrice;
      L.push(
        `#${t.id} ${s.short} ${t.dir === 'buy' ? 'call' : 'put'} $${t.amount} entry ${t.openPrice.toFixed(s.decimals)} | ${Math.max(0, Math.round((t.expiry - Date.now()) / 1000))}s left | now ${win ? 'winning' : p === t.openPrice ? 'flat' : 'losing'} (${t.source})`,
      );
    }
  }

  const recent = broker.trades.filter((t) => t.source === 'claude' && t.status !== 'open' && t.status !== 'void').slice(-12);
  if (recent.length) {
    L.push('\nYOUR LAST SETTLED TRADES (oldest first):');
    for (const t of recent) {
      const s = SYMBOLS.find((x) => x.id === t.symbol);
      L.push(
        `${s.short} ${t.dir === 'buy' ? 'call' : 'put'} ${t.duration}s${t.strategy ? ` [${t.strategy}]` : ''} -> ${t.status.toUpperCase()} ${t.profit >= 0 ? '+' : ''}$${t.profit.toFixed(2)} (entry ${t.openPrice.toFixed(s.decimals)}, exit ${t.closePrice.toFixed(s.decimals)})`,
      );
    }
  }

  for (const s of SYMBOLS) {
    const d = s.decimals;
    const { p } = feed.price(s.id);
    const tk = feed.sym.get(s.id).ticker;
    const m1 = feed.candles(s.id, 60, 220);
    const s15 = feed.candles(s.id, 15, 120);
    const m5 = feed.candles(s.id, 300, 60);
    const c1 = m1.map((c) => c[4]);
    const c15 = s15.map((c) => c[4]);
    const bb = ind.bollinger(c1, 20, 2);
    const breakEven = (10000 / (100 + s.payout)).toFixed(1);
    const rng = (n) => {
      const sl = m1.slice(-n);
      return sl.length ? `${Math.min(...sl.map((c) => c[3])).toFixed(d)} - ${Math.max(...sl.map((c) => c[2])).toFixed(d)}` : 'n/a';
    };
    L.push(`\n=== ${s.short}/USDT | payout ${s.payout}% (break-even win rate ${breakEven}%) ===`);
    L.push(
      `price ${p != null ? p.toFixed(d) : 'n/a'} | 24h ${tk ? pct(tk.change) : 'n/a'} (hi ${tk ? tk.high.toFixed(d) : 'n/a'}, lo ${tk ? tk.low.toFixed(d) : 'n/a'}) | taker-buy share last 45s: ${feed.sentiment(s.id)}%`,
    );
    L.push(`Price ranges (low - high): last 30m ${rng(30)} | 1h ${rng(60)} | 3h ${rng(180)}`);
    L.push(
      `M1 indicators: RSI14 ${num(ind.rsi(c1, 14), 1)} | EMA9 ${num(ind.ema(c1, 9), d)} | EMA21 ${num(ind.ema(c1, 21), d)} | SMA20 ${num(ind.sma(c1, 20), d)} | Bollinger %B ${num(bb && bb.pctB, 2)} (bands ${bb ? bb.lower.toFixed(d) + ' - ' + bb.upper.toFixed(d) : 'n/a'}) | ATR14 ${num(ind.atr(m1, 14), d)} | momentum 5m ${pct(ind.momentum(c1, 5), 3)}, 15m ${pct(ind.momentum(c1, 15), 3)}`,
    );
    L.push(`S15 indicators: RSI14 ${num(ind.rsi(c15, 14), 1)} | ATR14 ${num(ind.atr(s15, 14), d)} | momentum 1m ${pct(ind.momentum(c15, 4), 3)}, 3m ${pct(ind.momentum(c15, 12), 3)}`);
    L.push(`15-second candles (UTC o h l c), last ${Math.min(24, s15.length)}:\n${rows(s15.slice(-24), d)}`);
    L.push(`1-minute candles, last ${Math.min(30, m1.length)}:\n${rows(m1.slice(-30), d)}`);
    L.push(`5-minute candles, last ${Math.min(12, m5.length)}:\n${rows(m5.slice(-12), d)}`);
  }
  return L.join('\n');
}

// Risk styles: how selective Claude has to be, and the biggest stake it may use.
export const RISK = {
  conservative: {
    maxStake: 1,
    minConf: 66,
    text: 'Style: CONSERVATIVE. Trade only A-grade setups with at least three independent confirmations and confidence >= 66. Expect to trade rarely - often zero or one asset per round.',
  },
  balanced: {
    maxStake: 2,
    minConf: 60,
    text: 'Style: BALANCED. Trade B+ or better setups with at least two independent confirmations and confidence >= 60.',
  },
  aggressive: {
    maxStake: 3,
    minConf: 55,
    text: 'Style: ACTIVE. Take any setup that has a clear, specific reason and confidence >= 55. Trade more often, but never without a reason.',
  },
};

const RESEARCH_NOTE = `

Research mode (you are the strongest model; take control of this decision)
- Before deciding you may use web_search (up to 4 times) to refresh proven short-term trading knowledge: order-flow / taker-buy imbalance, volatility regimes, session effects, mean reversion vs momentum, support/resistance and liquidity. Prefer sources with measured results over hype.
- Then review ALL the snapshot data (every asset, every timeframe, the QUANT MODEL line, your track record) and decide. Skipping is a valid and often correct answer. Short-term moves are close to a coin flip, so only trade where several independent signals agree. State the real numbers you relied on in each reasoning. Never claim certainty.`;

function systemPrompt(risk) {
  return `You are Claude, working as a professional short-term trader on "Tradezz", a demo (fake money) binary-options platform that runs on REAL live Binance prices. This is an experiment to measure how well you can actually trade. No real money is involved, so be honest and calibrated - disciplined, not timid and not reckless.

How a trade works
- Pick an asset, a direction - "call" (price HIGHER at expiry than at entry) or "put" (LOWER) - a duration (30, 60, 120, 180 or 300 seconds) and a stake (% of the demo balance).
- The trade opens at the live price when your analysis finishes (a few seconds after the snapshot) and settles at the live price when the timer ends. An exactly equal price is a refund.
- A win pays stake x payout (86-92%, per asset); a loss loses the whole stake. You must win more often than the break-even rate shown for each asset just to avoid losing money.
- Short-horizon moves are noisy and close to a random walk. Without a real edge, expected value is negative, so "skip" is often correct.

Your process - top-down, for EVERY asset, EVERY round
1. Structure (5-minute candles + the 30m/1h/3h ranges): identify the dominant trend and the nearest support and resistance (swing highs/lows, range extremes, round numbers).
2. Context (1-minute candles + indicators): is trend aligned (EMA9 vs EMA21 vs SMA20)? RSI and Bollinger %B - stretched or neutral? ATR - is there enough volatility to travel beyond the noise within your duration? Taker-buy share - does order flow agree?
3. Timing (15-second candles): is there an actual trigger - a rejection wick at a level, a breakout candle with follow-through, a pullback that has ended, momentum exhaustion?
4. Decide call / put / skip and NAME the setup. Playbook: "Trend pullback" (with-trend entry after a dip/rally into EMA or support/resistance); "Mean reversion" (Bollinger/RSI extreme PLUS a rejection candle - never just because RSI is high inside a strong trend); "Support bounce" / "Resistance rejection"; "Breakout retest"; "Momentum burst" (strong candle confirmed by order flow). Require confluence of independent signals; do not trade chop (tiny ATR, flat EMAs, price mid-range) or against a strong trend without clear exhaustion.
5. Size and time: stake_pct scales with confidence (more conviction, larger stake; low conviction = skip, not a tiny stake). Match the duration to the setup horizon: 30-60s for 15-second triggers, 120-180s for 1-minute setups, 300s for 5-minute structure. The expected move must exceed the typical ATR noise over that duration.
6. Draw your analysis: for every asset give 2-4 key price levels (support / resistance / target / entry) near the current price and, where there is one, a trendline or channel edge. These are drawn on the user's chart, so use real prices from the data, never invented numbers. Draw even when you skip.
7. Reflect: study "YOUR LAST SETTLED TRADES" - if a setup keeps failing, say so and stop using it; if one works, keep it.

${RISK[risk] ? RISK[risk].text : RISK.balanced.text}

Rules
- One decision per asset, all five assets. Never open a trade on an asset that already has an open trade from you.
- Keep each reasoning to 1-2 concrete sentences citing actual numbers from the snapshot.
- Finish by calling the submit_decisions tool exactly once. Do not answer in plain text.`;
}

const TOOL = {
  name: 'submit_decisions',
  description: 'Submit the analysis, chart drawings and trading decisions for this round - exactly one entry per asset. Call this tool exactly once.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      market_view: { type: 'string', description: 'Your overall read of the market right now, 1-3 sentences.' },
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            symbol: { type: 'string', enum: SYMBOLS.map((s) => s.id) },
            action: { type: 'string', enum: ['call', 'put', 'skip'] },
            strategy: { type: 'string', description: 'Name of the setup, e.g. "Trend pullback", "Mean reversion", "Support bounce", "Breakout retest", "Momentum burst" - or "No setup" when skipping.' },
            duration_sec: { type: 'integer', enum: DURATIONS, description: 'Trade length in seconds (ignored for skip).' },
            stake_pct: { type: 'number', description: 'Stake as a percent of the demo balance, 0.25 to 3 (ignored for skip).' },
            confidence: { type: 'integer', description: 'Your honest probability (0-100) that this call/put wins; for skip use 50.' },
            reasoning: { type: 'string', description: '1-2 sentences citing numbers from the snapshot.' },
            levels: {
              type: 'array',
              description: '2-4 key price levels to draw on this asset chart (even when skipping). Real prices near the current price.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  price: { type: 'number' },
                  kind: { type: 'string', enum: ['support', 'resistance', 'target', 'entry'] },
                  label: { type: 'string', description: 'Very short label, e.g. "Swing low" or "1h high".' },
                },
                required: ['price', 'kind', 'label'],
              },
            },
            lines: {
              type: 'array',
              description: '0-2 trendlines or channel edges to draw. secs_ago = how many seconds before now the point is (0 = now, max 7200). Empty array if none.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  start_secs_ago: { type: 'integer' },
                  start_price: { type: 'number' },
                  end_secs_ago: { type: 'integer' },
                  end_price: { type: 'number' },
                  label: { type: 'string' },
                },
                required: ['start_secs_ago', 'start_price', 'end_secs_ago', 'end_price', 'label'],
              },
            },
          },
          required: ['symbol', 'action', 'strategy', 'duration_sec', 'stake_pct', 'confidence', 'reasoning', 'levels', 'lines'],
        },
      },
    },
    required: ['market_view', 'decisions'],
  },
};

const DEFAULTS = { enabled: false, intervalSec: 60, model: 'claude-haiku-5-5', effort: 'medium', risk: 'balanced', maxStakePct: 2, maxOpen: 3 };
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const KINDS = ['support', 'resistance', 'target', 'entry'];

export class Agent {
  constructor({ feed, broker, emit, file, envFile }) {
    this.feed = feed;
    this.broker = broker;
    this.emit = emit || (() => {});
    this.file = file;
    this.envFile = envFile;
    this.s = { ...DEFAULTS };
    this.status = 'off'; // off | idle | thinking | error | nokey
    this.lastError = '';
    this.nextRunAt = 0;
    this.running = false;
    this.timer = null;
    this.totals = { cycles: 0, cost: 0, inTok: 0, outTok: 0 };
    this.log = [];
    this.drawings = {}; // latest analysis + chart drawings per symbol
    this.client = null;
    this.load();
    this.s.enabled = false; // never auto-resume spending after a restart
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.s = { ...DEFAULTS, ...(d.settings || {}) };
      this.totals = { ...this.totals, ...(d.totals || {}) };
      this.log = d.log || [];
      this.drawings = d.drawings || {};
    } catch {
      /* first run */
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ settings: this.s, totals: this.totals, log: this.log.slice(0, 80), drawings: this.drawings }));
    } catch (e) {
      console.error('[agent] save failed:', e.message);
    }
  }

  keySet() {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  setKey(key) {
    key = String(key || '').trim();
    if (!KEY_RE.test(key)) throw new Error('That does not look like an Anthropic API key (sk-ant-...)');
    process.env.ANTHROPIC_API_KEY = key;
    this.client = null;
    try {
      let txt = '';
      try { txt = fs.readFileSync(this.envFile, 'utf8'); } catch { /* new file */ }
      const lines = txt.split(/\r?\n/).filter((l) => l && !l.startsWith('ANTHROPIC_API_KEY='));
      lines.push(`ANTHROPIC_API_KEY=${key}`);
      fs.writeFileSync(this.envFile, lines.join('\n') + '\n');
    } catch (e) {
      console.error('[agent] could not write .env:', e.message);
    }
    if (this.status === 'nokey' || this.status === 'error') this.status = this.s.enabled ? 'idle' : 'off';
    this.lastError = '';
    this.push();
  }

  configure(p) {
    const s = this.s;
    if (p.model && AGENT_MODELS.some((m) => m.id === p.model)) s.model = p.model;
    if (['low', 'medium', 'high'].includes(p.effort)) s.effort = p.effort;
    if (p.risk && RISK[p.risk]) { s.risk = p.risk; s.maxStakePct = RISK[p.risk].maxStake; }
    if (p.intervalSec != null) s.intervalSec = clamp(Math.round(Number(p.intervalSec)) || s.intervalSec, 20, 900);
    if (p.maxStakePct != null) s.maxStakePct = clamp(Number(p.maxStakePct) || s.maxStakePct, 0.25, 10);
    if (p.maxOpen != null) s.maxOpen = clamp(Math.round(Number(p.maxOpen)) || s.maxOpen, 1, 10);
    if (typeof p.enabled === 'boolean' && p.enabled !== s.enabled) this.setEnabled(p.enabled);
    this.save();
    this.push();
  }

  setEnabled(on) {
    this.s.enabled = on;
    clearTimeout(this.timer);
    if (on) {
      this.status = this.running ? 'thinking' : 'idle';
      this.scheduleNext(1500);
    } else {
      this.status = 'off';
      this.nextRunAt = 0;
    }
  }

  scheduleNext(ms) {
    clearTimeout(this.timer);
    this.nextRunAt = Date.now() + ms;
    this.timer = setTimeout(async () => {
      await this.runOnce();
      if (this.s.enabled) this.scheduleNext(Math.max(this.s.intervalSec * 1000, this.status === 'error' ? 30000 : 0));
    }, ms);
    this.push();
  }

  state() {
    return {
      settings: this.s,
      status: this.status,
      lastError: this.lastError,
      nextRunAt: this.nextRunAt,
      keySet: this.keySet(),
      totals: this.totals,
      models: AGENT_MODELS,
      drawings: this.drawings,
      cc: this.cc ? this.cc.state() : null,
    };
  }

  push(entry) {
    this.emit('agent', { state: this.state(), entry: entry || null });
  }

  getClient() {
    if (!this.client) this.client = new Anthropic();
    return this.client;
  }

  async call(text) {
    const client = this.getClient();
    const fable = this.s.model.includes('fable');
    const base = {
      model: this.s.model,
      max_tokens: 16000,
      system: systemPrompt(this.s.risk) + (fable ? RESEARCH_NOTE : ''),
      messages: [{ role: 'user', content: text }],
      output_config: { effort: fable ? 'high' : this.s.effort },
    };
    // Forced tool_choice is rejected by the newest models, so use auto + strict schema + an explicit instruction.
    const strictTools = [{ ...TOOL, strict: true }];
    // Fable may search the web first (server-side tool) for current trading knowledge, then must submit decisions.
    const webTool = { type: 'web_search_20260209', name: 'web_search', max_uses: 4 };
    const fetchOnce = async (messages, tools, plain) => {
      const req = { ...base, messages, tools };
      if (plain || this.s.model.includes('haiku')) return client.messages.create(req);
      return client.beta.messages.create({ ...req, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    };
    let messages = base.messages;
    let tools = fable ? [webTool, ...strictTools] : strictTools;
    try {
      let res = await fetchOnce(messages, tools, false);
      // A search-heavy turn can pause; continue it (max 3 times) until decisions are submitted.
      for (let i = 0; i < 3 && res.stop_reason === 'pause_turn'; i++) {
        messages = [...messages, { role: 'assistant', content: res.content }];
        res = await fetchOnce(messages, tools, false);
      }
      return res;
    } catch (e) {
      if (e && e.status === 400) {
        // Some option was rejected (e.g. web search not enabled on the account) - retry once with the plainest valid request.
        return await client.messages.create({ ...base, tools: [TOOL] });
      }
      throw e;
    }
  }

  async runOnce() {
    if (this.running) return null;
    this.running = true;
    this.status = 'thinking';
    this.push();
    const started = Date.now();
    const entry = { id: started, time: started, model: this.s.model, marketView: '', decisions: [], error: null, ms: 0, inTok: 0, outTok: 0, cost: 0 };
    try {
      if (!this.feed.historyReady) throw new Error('Market data is still loading - try again in a few seconds');
      if (!SYMBOLS.some((s) => this.feed.fresh(s.id, 30000))) throw new Error('No live prices right now');
      const snapshot = buildSnapshot(this.feed, this.broker);
      const res = await this.call(snapshot);
      entry.ms = Date.now() - started;
      const u = res.usage || {};
      entry.inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      entry.outTok = u.output_tokens || 0;
      entry.model = res.model || this.s.model;
      const price = AGENT_MODELS.find((m) => m.id === this.s.model) || AGENT_MODELS[0];
      entry.cost = (entry.inTok * price.in + entry.outTok * price.out) / 1e6;

      const tu = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_decisions');
      if (!tu) {
        if (res.stop_reason === 'refusal') throw new Error('Claude declined to answer this request (safety refusal)');
        throw new Error(`Claude did not submit decisions (stop reason: ${res.stop_reason})`);
      }
      const input = tu.input || {};
      entry.marketView = String(input.market_view || '');
      for (const d of Array.isArray(input.decisions) ? input.decisions : []) entry.decisions.push(this.execute(d));
    } catch (e) {
      entry.error = (e && e.message) || String(e);
      entry.ms = Date.now() - started;
      this.lastError = entry.error;
      const auth = e && (e.status === 401 || e.status === 403 || /authentication|api key|credential/i.test(entry.error));
      if (auth) {
        this.lastError = 'Claude needs a valid Anthropic API key. Paste one in the Claude panel.';
        this.setEnabled(false);
        this.status = 'nokey';
      } else {
        this.status = 'error';
      }
    } finally {
      this.running = false;
      this.totals.cycles += 1;
      this.totals.cost += entry.cost || 0;
      this.totals.inTok += entry.inTok || 0;
      this.totals.outTok += entry.outTok || 0;
      this.log.unshift(entry);
      this.log = this.log.slice(0, 80);
      if (!entry.error) {
        this.lastError = '';
        this.status = this.s.enabled ? 'idle' : 'off';
      }
      this.save();
      this.push(entry);
    }
    return entry;
  }

  // Validate what Claude wants to draw: real prices near the market only.
  sanitizeDrawing(d) {
    const cur = this.feed.price(d.symbol).p;
    const now = Date.now();
    const okPrice = (p) => Number.isFinite(p) && cur && Math.abs(p / cur - 1) <= 0.04;
    const levels = (Array.isArray(d.levels) ? d.levels : [])
      .filter((l) => l && okPrice(Number(l.price)))
      .slice(0, 4)
      .map((l) => ({ price: Number(l.price), kind: KINDS.includes(l.kind) ? l.kind : 'support', label: String(l.label || '').slice(0, 40) }));
    const lines = (Array.isArray(d.lines) ? d.lines : [])
      .filter((l) => l && okPrice(Number(l.start_price)) && okPrice(Number(l.end_price)))
      .slice(0, 2)
      .map((l) => ({
        t1: Math.round(now / 1000 - clamp(Math.round(Number(l.start_secs_ago) || 0), 0, 7200)),
        p1: Number(l.start_price),
        t2: Math.round(now / 1000 - clamp(Math.round(Number(l.end_secs_ago) || 0), 0, 7200)),
        p2: Number(l.end_price),
        label: String(l.label || '').slice(0, 40),
      }));
    return { levels, lines };
  }

  execute(d) {
    const sym = SYMBOLS.find((s) => s.id === d.symbol);
    const out = {
      symbol: d.symbol,
      action: d.action,
      strategy: String(d.strategy || '').slice(0, 60),
      duration: d.duration_sec,
      stakePct: d.stake_pct,
      confidence: d.confidence,
      reasoning: String(d.reasoning || ''),
      tradeId: null,
      stake: null,
      error: null,
    };
    if (!sym) return out;

    // chart drawings are saved for every asset, traded or skipped
    const drawing = this.sanitizeDrawing(d);
    this.drawings[d.symbol] = {
      time: Date.now(),
      strategy: out.strategy,
      action: d.action,
      duration: d.duration_sec,
      confidence: d.confidence,
      reasoning: out.reasoning,
      levels: drawing.levels,
      lines: drawing.lines,
      tradeId: null,
    };

    if (d.action !== 'call' && d.action !== 'put') return out;
    try {
      const risk = RISK[this.s.risk] || RISK.balanced;
      if (!(Number(d.confidence) >= risk.minConf)) throw new Error(`confidence ${d.confidence}% is below the ${risk.minConf}% needed for the ${this.s.risk} style - passed`);
      const mine = this.broker.openTrades().filter((t) => t.source === 'claude');
      if (mine.length >= this.s.maxOpen) throw new Error(`max ${this.s.maxOpen} open trades reached`);
      if (mine.some((t) => t.symbol === d.symbol)) throw new Error('already has an open trade on this asset');
      const duration = DURATIONS.reduce((a, b) => (Math.abs(b - d.duration_sec) < Math.abs(a - d.duration_sec) ? b : a), 60);
      const p = clamp(Number(d.stake_pct) || 1, 0.25, this.s.maxStakePct);
      const amount = Math.max(LIMITS.minStake, Math.floor(this.broker.balance * p) / 100);
      const t = this.broker.open({
        symbol: d.symbol,
        dir: d.action === 'call' ? 'buy' : 'sell',
        amount,
        duration,
        source: 'claude',
        reasoning: d.reasoning,
        confidence: d.confidence,
        model: this.s.model,
        strategy: out.strategy,
      });
      out.tradeId = t.id;
      out.stake = t.amount;
      out.duration = t.duration;
      this.drawings[d.symbol].tradeId = t.id;
    } catch (e) {
      out.error = e.message;
    }
    return out;
  }
}

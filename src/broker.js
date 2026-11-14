// The paper broker: a fake-money account that opens and settles binary-options trades
// against the REAL live price from the feed. Nothing here touches a real exchange.

import fs from 'node:fs';
import path from 'node:path';
import { SYMBOLS, START_BALANCE, LIMITS, TRADE_SOURCES } from './config.js';

const round2 = (n) => Math.round(n * 100) / 100;

export class Broker {
  constructor({ feed, file, emit }) {
    this.feed = feed;
    this.file = file;
    this.emit = emit || (() => {});
    this.balance = START_BALANCE;
    this.trades = [];
    this.nextId = 1;
    this.timers = new Map();
    this._saveT = null;
    this.load();
  }

  // ---- persistence ----------------------------------------------------
  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.balance = s.balance ?? START_BALANCE;
      this.trades = s.trades || [];
      this.nextId = s.nextId || this.trades.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    } catch {
      /* fresh account */
    }
    // trades that were open when the server stopped
    for (const t of this.trades) {
      if (t.status !== 'open') continue;
      if (t.expiry > Date.now()) {
        this.schedule(t);
      } else {
        t.status = 'void';
        t.closeTime = Date.now();
        this.balance = round2(this.balance + t.amount);
      }
    }
    this.save();
  }

  save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const trades = this.trades.slice(-3000);
      fs.writeFileSync(this.file, JSON.stringify({ balance: this.balance, nextId: this.nextId, trades }));
    } catch (e) {
      console.error('[broker] save failed:', e.message);
    }
  }

  // ---- trading --------------------------------------------------------
  open({ symbol, dir, amount, duration, source = 'user', reasoning = '', confidence = null, model = null, strategy = '' }) {
    const sym = SYMBOLS.find((s) => s.id === symbol);
    if (!sym) throw new Error('Unknown asset');
    if (dir !== 'buy' && dir !== 'sell') throw new Error('Direction must be buy or sell');
    amount = round2(Number(amount));
    duration = Math.round(Number(duration));
    if (!Number.isFinite(amount) || amount < LIMITS.minStake) throw new Error(`Minimum amount is $${LIMITS.minStake}`);
    if (!Number.isFinite(duration) || duration < LIMITS.minDuration || duration > LIMITS.maxDuration) {
      throw new Error(`Time must be between ${LIMITS.minDuration}s and ${LIMITS.maxDuration / 60} min`);
    }
    if (amount > this.balance) throw new Error('Not enough balance');
    if (this.openTrades().length >= LIMITS.maxOpenTrades) throw new Error('Too many open trades');
    if (!this.feed.fresh(symbol, LIMITS.staleMs)) throw new Error('No live price right now - try again in a moment');
    if (!TRADE_SOURCES.includes(source)) source = 'user';

    const { p } = this.feed.price(symbol);
    const now = Date.now();
    const trade = {
      id: this.nextId++,
      symbol,
      dir,
      amount,
      payout: sym.payout,
      duration,
      openTime: now,
      expiry: now + duration * 1000,
      openPrice: p,
      status: 'open',
      source,
      reasoning: String(reasoning || '').slice(0, 1200),
      confidence: confidence == null ? null : Math.round(confidence),
      model,
      strategy: String(strategy || '').slice(0, 60),
    };
    this.balance = round2(this.balance - amount);
    this.trades.push(trade);
    this.schedule(trade);
    this.save();
    this.emit('trade', trade);
    this.emit('balance', this.balance);
    return trade;
  }

  schedule(trade) {
    const ms = Math.max(0, trade.expiry - Date.now());
    this.timers.set(trade.id, setTimeout(() => this.settle(trade.id), ms));
  }

  settle(id) {
    const t = this.trades.find((x) => x.id === id);
    this.timers.delete(id);
    if (!t || t.status !== 'open') return;
    const { p } = this.feed.price(t.symbol);
    const close = p ?? t.openPrice;
    t.closePrice = close;
    t.closeTime = Date.now();
    if (close === t.openPrice) {
      t.status = 'draw';
      t.profit = 0;
      this.balance = round2(this.balance + t.amount);
    } else if ((t.dir === 'buy' && close > t.openPrice) || (t.dir === 'sell' && close < t.openPrice)) {
      t.status = 'won';
      t.profit = round2((t.amount * t.payout) / 100);
      this.balance = round2(this.balance + t.amount + t.profit);
    } else {
      t.status = 'lost';
      t.profit = -t.amount;
    }
    this.save();
    this.emit('trade', t);
    this.emit('balance', this.balance);
  }

  openTrades() {
    return this.trades.filter((t) => t.status === 'open');
  }

  recent(limit = 100) {
    return this.trades.slice(-limit).reverse();
  }

  topUp(amount) {
    amount = round2(Number(amount));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e7) throw new Error('Invalid amount');
    this.balance = round2(this.balance + amount);
    this.save();
    this.emit('balance', this.balance);
    return this.balance;
  }

  reset() {
    for (const tm of this.timers.values()) clearTimeout(tm);
    this.timers.clear();
    this.balance = START_BALANCE;
    this.trades = [];
    this.nextId = 1;
    this.saveNow();
    this.emit('reset', null);
    this.emit('balance', this.balance);
  }

  // ---- statistics -----------------------------------------------------
  stats(source = null) {
    const list = this.trades.filter((t) => t.status !== 'open' && t.status !== 'void' && (!source || t.source === source));
    const wins = list.filter((t) => t.status === 'won').length;
    const losses = list.filter((t) => t.status === 'lost').length;
    const draws = list.filter((t) => t.status === 'draw').length;
    const pnl = round2(list.reduce((s, t) => s + (t.profit || 0), 0));
    const volume = round2(list.reduce((s, t) => s + t.amount, 0));
    const decided = wins + losses;
    // streaks
    let best = 0;
    let cur = 0;
    for (const t of list) {
      if (t.status === 'won') { cur++; best = Math.max(best, cur); } else if (t.status === 'lost') cur = 0;
    }
    return {
      trades: list.length,
      wins,
      losses,
      draws,
      winRate: decided ? Math.round((wins / decided) * 1000) / 10 : null,
      pnl,
      volume,
      avgStake: list.length ? round2(volume / list.length) : 0,
      bestStreak: best,
    };
  }

  allStats() {
    return {
      all: this.stats(),
      user: this.stats('user'),
      claude: this.stats('claude'),
      'claude-code': this.stats('claude-code'),
    };
  }
}

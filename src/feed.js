// Live market data from Binance public endpoints (no account / API key needed).
// - WebSocket trade stream  -> real-time prices (every executed trade)
// - REST klines             -> recent history so charts are populated instantly
// Candles are built here from the raw trade stream so every timeframe stays in sync.

import { EventEmitter } from 'node:events';
import { SYMBOLS } from './config.js';

const REST = ['https://api.binance.com', 'https://data-api.binance.vision'];
const WSH = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];

const SEC_CAP = 14000; // keep ~3.9h of 1-second candles
const MIN_CAP = 1600; // keep ~26h of 1-minute candles
const FLOW_MS = 45000; // taker buy/sell window used for the sentiment bar

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function upsert(arr, t, price, qty, bq = 0) {
  const last = arr[arr.length - 1];
  if (last && last.t === t) {
    if (price > last.h) last.h = price;
    if (price < last.l) last.l = price;
    last.c = price;
    last.v += qty;
    last.b = (last.b || 0) + bq;
  } else if (!last || t > last.t) {
    arr.push({ t, o: price, h: price, l: price, c: price, v: qty, b: bq });
  } else {
    // slightly out-of-order trade (exchange time): put it in the candle of its own second if we still have it
    let c = last;
    for (let i = arr.length - 2; i >= Math.max(0, arr.length - 12); i--) { if (arr[i].t === t) { c = arr[i]; break; } if (arr[i].t < t) break; }
    if (price > c.h) c.h = price;
    if (price < c.l) c.l = price;
    if (c === last) c.c = price;
    c.v += qty;
    c.b = (c.b || 0) + bq;
  }
}

function mergeHistory(live, hist) {
  const map = new Map();
  for (const c of hist) map.set(c.t, c);
  for (const c of live) {
    const h = map.get(c.t);
    if (h) {
      map.set(c.t, { t: c.t, o: h.o, h: Math.max(h.h, c.h), l: Math.min(h.l, c.l), c: c.c, v: h.v, b: h.b });
    } else {
      map.set(c.t, c);
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

function aggregate(base, tf) {
  const out = [];
  let cur = null;
  for (const c of base) {
    const b = Math.floor(c.t / tf) * tf;
    if (!cur || cur.t !== b) {
      if (cur) out.push(cur);
      cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    } else {
      if (c.h > cur.h) cur.h = c.h;
      if (c.l < cur.l) cur.l = c.l;
      cur.c = c.c;
      cur.v += c.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export class Feed extends EventEmitter {
  constructor() {
    super();
    this.sym = new Map();
    SYMBOLS.forEach((s, i) =>
      this.sym.set(s.id, { id: s.id, idx: i, price: null, ts: 0, sec: [], min: [], flow: [], ticker: null }),
    );
    this.hostIdx = 0;
    this.ws = null;
    this.lastMsg = 0;
    this.failures = 0;
    this.connected = false;
    this.historyReady = false;
    this.lastError = '';
  }

  async start() {
    await this.pickHost();
    this.connect();
    this.loadHistory().catch((e) => console.error('[feed] history failed:', e.message));
    this.syncClock();
    setInterval(() => this.syncClock(), 300000);
    this.pollTicker();
    setInterval(() => this.pollTicker(), 20000);
    setInterval(() => this.watchdog(), 5000);
  }

  // Offset between Binance's clock and ours, so "the last completed second" means the same thing as in the training data.
  async syncClock() {
    try {
      const t0 = Date.now();
      const j = await this.getJson('/api/v3/time');
      const t1 = Date.now();
      if (j && j.serverTime) this.skew = j.serverTime - (t0 + t1) / 2;
    } catch { /* keep the old value */ }
  }

  exchangeNow() { return Date.now() + (this.skew || 0); }

  async pickHost() {
    for (let i = 0; i < REST.length; i++) {
      try {
        const r = await fetch(`${REST[i]}/api/v3/ping`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          this.hostIdx = i;
          console.log(`[feed] using ${REST[i]}`);
          return;
        }
      } catch {
        /* try next */
      }
    }
    this.lastError = 'Cannot reach Binance (blocked or offline)';
    console.error('[feed] ' + this.lastError);
  }

  async getJson(path) {
    let err;
    for (let attempt = 0; attempt < 2; attempt++) {
      const host = REST[(this.hostIdx + attempt) % REST.length];
      try {
        const r = await fetch(host + path, { signal: AbortSignal.timeout(12000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        err = e;
      }
    }
    throw err;
  }

  async klines(symbol, interval, limit, endTime) {
    let p = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    if (endTime) p += `&endTime=${endTime}`;
    const rows = await this.getJson(p);
    return rows.map((k) => ({ t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], b: +k[9] }));
  }

  async loadHistory() {
    await Promise.all(
      SYMBOLS.map(async (s) => {
        const st = this.sym.get(s.id);
        try {
          const m = await this.klines(s.id, '1m', 1000);
          st.min = mergeHistory(st.min, m);
        } catch (e) {
          console.error(`[feed] ${s.id} 1m history: ${e.message}`);
        }
        try {
          let all = [];
          let end;
          for (let p = 0; p < 12; p++) {
            const k = await this.klines(s.id, '1s', 1000, end);
            if (!k.length) break;
            all = k.concat(all);
            end = k[0].t * 1000 - 1;
          }
          st.sec = mergeHistory(st.sec, all);
        } catch (e) {
          console.error(`[feed] ${s.id} 1s history: ${e.message}`);
        }
        if (st.price == null && st.min.length) st.price = st.min[st.min.length - 1].c;
      }),
    );
    this.historyReady = true;
    console.log('[feed] history loaded');
  }

  // After a reconnect, patch the hole that was missed while offline.
  async refreshRecent() {
    for (const s of SYMBOLS) {
      const st = this.sym.get(s.id);
      try {
        st.sec = mergeHistory(st.sec, await this.klines(s.id, '1s', 600));
        st.min = mergeHistory(st.min, await this.klines(s.id, '1m', 30));
      } catch {
        /* best effort */
      }
    }
  }

  connect() {
    const streams = SYMBOLS.map((s) => s.id.toLowerCase() + '@trade').join('/');
    let ws;
    try {
      ws = new WebSocket(`${WSH[this.hostIdx]}/stream?streams=${streams}`);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const recovered = this.failures > 0;
      this.connected = true;
      this.failures = 0;
      this.lastMsg = Date.now();
      console.log('[feed] live stream connected');
      if (recovered && this.historyReady) this.refreshRecent();
    };
    ws.onmessage = (ev) => {
      this.lastMsg = Date.now();
      try {
        const d = JSON.parse(ev.data).data;
        if (d && d.e === 'trade') this.onTrade(d.s, +d.p, +d.q, d.m, +d.T);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* noop */ }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.connected = false;
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this._rt) return;
    this.failures++;
    if (this.failures % 3 === 0) this.hostIdx = (this.hostIdx + 1) % WSH.length;
    const delay = Math.min(10000, 500 * 2 ** Math.min(this.failures, 5));
    this._rt = setTimeout(() => {
      this._rt = null;
      this.connect();
    }, delay);
  }

  watchdog() {
    if (this.ws && Date.now() - this.lastMsg > 20000) {
      try { this.ws.close(); } catch { /* noop */ }
    }
  }

  onTrade(id, price, qty, buyerIsMaker, tradeTs) {
    const st = this.sym.get(id);
    if (!st || !(price > 0)) return;
    const now = Date.now();
    // bucket by the EXCHANGE trade time (same as Binance klines), not by when we received it
    const t = Math.floor((tradeTs > 0 ? tradeTs : now) / 1000);
    const bq = buyerIsMaker ? 0 : qty; // taker-buy base volume
    upsert(st.sec, t, price, qty, bq);
    upsert(st.min, Math.floor(t / 60) * 60, price, qty, bq);
    st.price = price;
    st.ts = now;
    st.flow.push([now, price * qty, buyerIsMaker ? 0 : 1]);
    while (st.flow.length && st.flow[0][0] < now - FLOW_MS) st.flow.shift();
    if (st.sec.length > SEC_CAP + 600) st.sec.splice(0, st.sec.length - SEC_CAP);
    if (st.min.length > MIN_CAP + 100) st.min.splice(0, st.min.length - MIN_CAP);
    this.emit('trade', st.idx, price, now, qty);
  }

  async pollTicker() {
    try {
      const q = encodeURIComponent(JSON.stringify(SYMBOLS.map((s) => s.id)));
      const rows = await this.getJson(`/api/v3/ticker/24hr?symbols=${q}`);
      for (const r of rows) {
        const st = this.sym.get(r.symbol);
        if (!st) continue;
        st.ticker = {
          last: +r.lastPrice,
          change: +r.priceChangePercent,
          high: +r.highPrice,
          low: +r.lowPrice,
          volume: +r.quoteVolume,
        };
        if (st.price == null) st.price = +r.lastPrice;
      }
      this.emit('ticker', this.tickers());
    } catch (e) {
      /* next poll will retry */
    }
  }

  // ---- read API -------------------------------------------------------

  price(id) {
    const st = this.sym.get(id);
    return st ? { p: st.price, ts: st.ts } : { p: null, ts: 0 };
  }

  fresh(id, maxAge) {
    const st = this.sym.get(id);
    return !!st && st.price != null && Date.now() - st.ts <= maxAge;
  }

  // [[t,o,h,l,c], ...] oldest -> newest. Candles are made continuous (open = previous close)
  // so charts look smooth like a regular broker terminal.
  candles(id, tf, limit = 300) {
    const st = this.sym.get(id);
    if (!st) return [];
    const base = tf < 60 ? st.sec : st.min;
    let out = tf === (tf < 60 ? 1 : 60) ? base.map((c) => ({ ...c })) : aggregate(base, tf);
    if (out.length > limit) out = out.slice(-limit);
    const res = [];
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      let o = c.o;
      if (i > 0) o = res[i - 1][4];
      res.push([c.t, o, Math.max(c.h, o), Math.min(c.l, o), c.c]);
    }
    return res;
  }

  // Share of taker volume that was buying over the last ~45s (0-100).
  sentiment(id) {
    const st = this.sym.get(id);
    if (!st) return 50;
    const cutoff = Date.now() - FLOW_MS;
    let buy = 0;
    let tot = 0;
    for (const [t, v, b] of st.flow) {
      if (t < cutoff) continue;
      tot += v;
      if (b) buy += v;
    }
    return tot > 0 ? Math.round((buy / tot) * 100) : 50;
  }

  secRaw(id) {
    const st = this.sym.get(id);
    return st ? st.sec : [];
  }

  sentiments() {
    return SYMBOLS.map((s) => this.sentiment(s.id));
  }

  tickers() {
    return SYMBOLS.map((s) => this.sym.get(s.id).ticker);
  }

  status() {
    return {
      connected: this.connected,
      historyReady: this.historyReady,
      error: this.lastError,
      prices: SYMBOLS.map((s) => this.sym.get(s.id).price),
    };
  }
}

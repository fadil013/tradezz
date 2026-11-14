// Short-term direction model: logistic regression over price-stretch (z-scores), taker order flow,
// volatility ratio, time of day and BTC's own recent move. Trained on 13 days of 1-second Binance data
// (BTC, ETH, BNB) and validated walk-forward (train on earlier days, test on the next day).
// Out-of-sample (7 unseen days): 30s trades ~52.1% overall / ~55% when confident; 60s ~51.6% / ~54%; 300s ~51.6% / ~56%.
// A small, uncertain edge, strongest on the confident calls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'model.json'), 'utf8'));
const LOOK = 700;

// arrays are per-second, aligned, oldest first, last element = the second being evaluated
export function zFeatures(c) {
  const n = c.length - 1;
  let q = 0;
  for (let i = n - 599; i <= n; i++) { const r = Math.log(c[i] / c[i - 1]); q += r * r; }
  const vol = Math.sqrt(q / 600) + 1e-9;
  let q60 = 0;
  for (let i = n - 59; i <= n; i++) { const r = Math.log(c[i] / c[i - 1]); q60 += r * r; }
  const vol60 = Math.sqrt(q60 / 60) + 1e-9;
  const z = (k) => Math.log(c[n] / c[n - k]) / (vol * Math.sqrt(k));
  return { z: [5, 15, 30, 60, 180, 600].map(z), volratio: vol60 / vol };
}

export function featureVector(c, v, b, utcSec, btcZ) {
  const n = c.length - 1;
  const { z, volratio } = zFeatures(c);
  const flow = (k) => { let sv = 0, sb = 0; for (let i = n - k + 1; i <= n; i++) { sv += v[i]; sb += b[i]; } return sv > 0 ? sb / Math.max(sv, 1e-12) - 0.5 : 0; };
  const hr = (utcSec % 86400) / 3600;
  return [...z, flow(10), flow(30), flow(60), flow(180), flow(600), volratio, Math.sin((hr / 24) * 2 * Math.PI), Math.cos((hr / 24) * 2 * Math.PI), btcZ[0], btcZ[1]];
}

export function predict(x, horizon) {
  const m = MODEL.models[String(horizon <= 45 ? 30 : horizon <= 120 ? 60 : 300)];
  let s = m.b0;
  for (let i = 0; i < x.length; i++) s += ((x[i] - m.mu[i]) / m.sd[i]) * m.w[i];
  return 1 / (1 + Math.exp(-s)); // probability that price is higher at expiry
}

// Build aligned per-second arrays for one symbol from the live feed (last completed second = last element).
export function liveArrays(feed, id) {
  const cs = feed.secRaw(id);
  if (!cs || cs.length < LOOK) return null;
  const nowS = Math.floor((feed.exchangeNow() - 300) / 1000) - 1; // last second that is complete on Binance's clock (+300ms for network delay)
  const map = new Map(cs.map((x) => [x.t, x]));
  const c = [], v = [], b = [];
  let last = cs[0].c;
  for (let t = nowS - LOOK + 1; t <= nowS; t++) {
    const x = map.get(t);
    if (x) { last = x.c; c.push(x.c); v.push(x.v || 0); b.push(x.b || 0); } else { c.push(last); v.push(0); b.push(0); }
  }
  return { c, v, b, utc: nowS };
}

// p = chance of UP, edge = |p - 0.5|. Trade the side the model prefers.
export function signal(feed, id, horizon) {
  const a = liveArrays(feed, id);
  if (!a) return null;
  const btc = id === 'BTCUSDT' ? a : liveArrays(feed, 'BTCUSDT');
  if (!btc) return null;
  const bz = zFeatures(btc.c).z;
  const x = featureVector(a.c, a.v, a.b, a.utc, [bz[2], bz[3]]);
  const p = predict(x, horizon);
  return { id, p, edge: Math.abs(p - 0.5), dir: p >= 0.5 ? 'buy' : 'sell' };
}

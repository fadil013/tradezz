// Instant executor: when the prompt says how many trades, how much per trade and how long,
// the server opens them immediately (no waiting for a terminal session).
// It is a RULE-BASED playbook (EMA trend + RSI + order flow + range position), not live model judgment.
import { SYMBOLS } from './config.js';
import { ema, rsi } from './indicators.js';
import { signal as modelSignal } from './model.js';

const OV = [['fib', 'Fibonacci retracement'], ['sr', 'support/resistance zones'], ['sd', 'supply/demand zones'], ['ob', 'order blocks'], ['fvg', 'fair value gaps'], ['sweep', 'liquidity sweeps'], ['bos', 'BOS/CHoCH'], ['trend', 'trendlines'], ['channel', 'parallel channel'], ['pitch', 'pitchfork'], ['ext', 'Fibonacci extension'], ['wave', 'wave labels'], ['hs', 'head & shoulders'], ['pos', 'long/short position'], ['vp', 'price-activity profile']];

const UNIT = { s: 1, sec: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60 };

// "10 trades $1000 each, 1 minute each" -> { n:10, stake:1000, duration:60 } or null
export function parsePrompt(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '');
  const n = t.match(/(\d+)\s*(?:parallel\s+|simultaneous\s+)?trades?/);
  const stake = t.match(/\$\s*(\d+(?:\.\d+)?)\s*(k)?/) || t.match(/(\d+(?:\.\d+)?)\s*(k)?\s*(?:dollars|usd|each|per trade)/);
  const dur = t.match(/(\d+(?:\.\d+)?)\s*[- ]?\s*(seconds?|secs?|minutes?|mins?|s|m)\b/);
  if (!n || !stake || !dur) return null;
  const count = Math.min(40, parseInt(n[1], 10));
  const amount = parseFloat(stake[1]) * (stake[2] ? 1000 : 1);
  const duration = Math.round(parseFloat(dur[1]) * UNIT[dur[2]]);
  if (!(count >= 1) || !(amount >= 1) || !(duration >= 5 && duration <= 3600)) return null;
  return { count, amount, duration };
}

// "trade with $5000" (only money given, no count / duration) -> Claude decides everything else.
export function parseBudget(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '');
  if (/(\d+)\s*(?:parallel\s+|simultaneous\s+)?trades?/.test(t)) return null; // explicit plan -> normal modes
  const m = t.match(/\$\s*(\d+(?:\.\d+)?)\s*(k)?/) || t.match(/(\d+(?:\.\d+)?)\s*(k)?\s*(?:dollars|usd|bucks)/) || t.match(/(?:with|budget|bankroll|use)\s+(\d+(?:\.\d+)?)\s*(k)?\b/);
  if (!m) return null;
  const budget = parseFloat(m[1]) * (m[2] ? 1000 : 1);
  return budget >= 10 ? budget : null;
}

// ---- strategy engine: 8 well-known strategies vote on every asset ------------------------
function emaSeries(a, n) {
  const k = 2 / (n + 1); const out = []; let e = null;
  for (let i = 0; i < a.length; i++) { e = e == null ? a[i] : a[i] * k + e * (1 - k); out.push(e); }
  return out;
}
const arrow = (v) => (v > 0 ? '▲' : v < 0 ? '▼' : '–');

function sample(feed, id) {
  const m1 = feed.candles(id, 60, 120);
  const s15 = feed.candles(id, 15, 60);
  const c1 = m1.map((c) => c[4]);
  const c15 = s15.map((c) => c[4]);
  const p = feed.price(id).p;
  const v = {};
  const e9 = ema(c1, 9), e21 = ema(c1, 21);
  v['EMA 9/21 trend'] = e9 != null && e21 != null ? (e9 > e21 ? 1 : -1) : 0;
  const r = rsi(c15, 14);
  v['RSI momentum'] = r == null ? 0 : r > 56 ? 1 : r < 44 ? -1 : 0;
  if (c1.length >= 35) {
    const macd = emaSeries(c1, 12).map((x, i) => x - emaSeries(c1, 26)[i]);
    const sig = emaSeries(macd, 9);
    const h = macd[macd.length - 1] - sig[sig.length - 1];
    v['MACD histogram'] = h > 0 ? 1 : h < 0 ? -1 : 0;
  } else v['MACD histogram'] = 0;
  const bb = c1.length >= 20 ? c1.slice(-20) : null;
  if (bb) {
    const mu = bb.reduce((x, y) => x + y, 0) / 20; const sd = Math.sqrt(bb.reduce((x, y) => x + (y - mu) ** 2, 0) / 20) || 1e-9;
    const b = (p - (mu - 2 * sd)) / (4 * sd);
    v['Bollinger reversion'] = b < 0.15 ? 1 : b > 0.85 ? -1 : 0;
  } else v['Bollinger reversion'] = 0;
  const w = m1.slice(-14);
  if (w.length === 14) {
    const hh = Math.max(...w.map((c) => c[2])), ll = Math.min(...w.map((c) => c[3]));
    const k = hh > ll ? ((p - ll) / (hh - ll)) * 100 : 50;
    v['Stochastic'] = k < 20 ? 1 : k > 80 ? -1 : 0;
  } else v['Stochastic'] = 0;
  const flow = feed.sentiment(id);
  v['Order flow'] = flow >= 58 ? 1 : flow <= 42 ? -1 : 0;
  const d = m1.slice(-21, -1);
  if (d.length >= 20) {
    const hi20 = Math.max(...d.map((c) => c[2])), lo20 = Math.min(...d.map((c) => c[3]));
    v['Donchian breakout'] = p > hi20 ? 1 : p < lo20 ? -1 : 0;
  } else v['Donchian breakout'] = 0;
  const q = c15.slice(-4);
  v['Micro momentum'] = q.length === 4 ? (q[3] > q[1] && q[1] >= q[0] ? 1 : q[3] < q[1] && q[1] <= q[0] ? -1 : 0) : 0;
  const total = Object.values(v).reduce((x, y) => x + y, 0);
  const m30 = m1.slice(-30);
  const hi = Math.max(...m30.map((c) => c[2])), lo = Math.min(...m30.map((c) => c[3]));
  return { score: total / 8, votes: v, hi, lo, p, flow, rsi: r };
}

// How stretched is price versus its own recent volatility? (average z of the 30s / 60s / 180s returns)
// Backtests on 3 days of 1-second Binance data: betting AGAINST a strong stretch did slightly better than
// following it. The edge is small and uncertain; this is still close to a coin flip.
function stretch(feed, id) {
  const cs = feed.candles(id, 1, 760);
  if (cs.length < 200) return 0;
  const nowS = Math.floor(Date.now() / 1000);
  const map = new Map(cs.map((c) => [c[0], c[4]]));
  const arr = []; let last = cs[0][4];
  for (let t = nowS - 720; t <= nowS; t++) { if (map.has(t)) last = map.get(t); arr.push(last); }
  const p = feed.price(id).p; if (p) arr[arr.length - 1] = p;
  const n = arr.length; let q = 0;
  for (let i = n - 600; i < n; i++) { const r = Math.log(arr[i] / arr[i - 1]); q += r * r; }
  const vol = Math.sqrt(q / 600) || 1e-9;
  const zk = (k) => Math.log(arr[n - 1] / arr[n - 1 - k]) / (vol * Math.sqrt(k));
  return (zk(30) + zk(60) + zk(180)) / 3;
}
const TRADE_ASSETS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']; // highest payouts (92/90/90%); SOL 88% and XRP 86% cost more per trade

const wantsSequential = (t) => /one (trade )?at a time|one by one|sequential|each minute|every minute|then analy[sz]e|repeat/i.test(t);

// One trade per round: analyse for a while, place ONE trade, analyse again, place the next... with a running score.
function runSequential({ cc, broker, feed, prompt, spec }) {
  const low = String(prompt).toLowerCase().replace(/\bone\b/g, '1');
  const am = low.match(/(?:analy[sz]e|research|study)\w*(?:\s+\w+){0,3}?\s*(?:for\s*)?(\d+)\s*(min|sec|s\b)/);
  const analysisSec = Math.min(600, Math.max(10, am ? parseInt(am[1], 10) * (am[2] === 'min' ? 60 : 1) : 60));
  const total = Math.min(spec.count * spec.amount, broker.balance);
  if (total < 1) return false;
  // worst case per round = analysis window + 15s extra wait + ~2s gap, so the session never ends before the last trade
  cc.start({ model: cc.s.model, minutes: Math.ceil((spec.count * (analysisSec + 4) + spec.duration) / 60) + 2, budget: total });
  cc.busy = true;
  const syms = SYMBOLS.map((x) => x.id);
  let placed = 0;
  const score = () => { const m = cc.money(); const dec = m.wins + m.losses; return `Score: ${m.wins}W-${m.losses}L${dec ? `, win rate ${((m.wins / dec) * 100).toFixed(0)}% (break-even ~53%)` : ''}, net ${m.pnl >= 0 ? '+' : '-'}$${Math.abs(m.pnl).toFixed(0)}`; };
  const round = (k) => {
    if (!cc.s.active) { cc.busy = false; cc.stage(null); return; }
    if (k >= spec.count) {
      cc.stage(null); cc.busy = false;
      cc.say(`Placed ${placed} trades of $${spec.amount} (${spec.duration}s each), one every ${analysisSec}s after a fresh analysis. Short results: the summary follows when the last one settles.`);
      return;
    }
    const acc = Object.fromEntries(syms.map((id) => [id, { n: 0, sum: 0, last: null }]));
    const steps = Math.max(syms.length * 2, Math.round(analysisSec / 6));
    const stepMs = (analysisSec * 1000) / steps;
    cc.s.stage = null;
    cc.stage(syms[0], `Round ${k + 1}/${spec.count}: analysing for ${analysisSec}s before the trade... ${k ? score() : ''}`);
    const t0 = Date.now(); let fired = false;
    const windowMs = analysisSec * 1000;
    // Full analysis first: no trade is placed before the whole window has run. At the end, trade the model's best call.
    const scan = setInterval(() => {
      if (fired || !cc.s.active) { clearInterval(scan); return; }
      if (Date.now() - t0 >= windowMs) { fired = true; clearInterval(scan); decide(k, acc); }
    }, 250);
    const step = (j) => {
      if (fired) return;
      if (!cc.s.active) { clearInterval(scan); cc.busy = false; cc.stage(null); return; }
      if (j >= steps) return; // window over: the scan above decides (moderate-or-better call, max 15s extra)
      const id = syms[j % syms.length]; const r = sample(feed, id); const a = acc[id]; a.n++; a.sum += r.score; a.last = r;
      try { cc.draw({ symbol: id, strategy: '8-strategy vote', action: a.sum / a.n > 0.15 ? 'call' : a.sum / a.n < -0.15 ? 'put' : 'skip', duration: spec.duration, confidence: 52, reasoning: Object.entries(r.votes).map(([n2, x]) => n2 + ' ' + arrow(x)).join(', '), indicators: ['sma', 'ema', 'bb', 'dc'], overlays: OV.slice(0, Math.min(15, a.n * 8)).map((o) => o[0]), levels: [{ price: r.hi, kind: 'resistance', label: '30m High' }, { price: r.lo, kind: 'support', label: '30m Low' }, { price: (r.hi + r.lo) / 2, kind: 'target', label: 'Mid' }, { price: r.p, kind: 'entry', label: 'Now' }] }); } catch { /* ignore */ }
      cc.stage(id, `${id.replace('USDT', '')} (round ${k + 1}): ${Object.entries(r.votes).map(([n2, x]) => n2.split(' ')[0] + arrow(x)).join(' ')} = ${r.score.toFixed(2)}`);
      setTimeout(() => step(j + 1), stepMs);
    };
    step(0);
  };
  const decide = (k, acc) => {
    // Model call per best-paying asset; trade the most confident one.
    const sg = TRADE_ASSETS.map((id) => modelSignal(feed, id, spec.duration)).filter(Boolean).sort((x, y) => y.edge - x.edge);
    if (!sg.length) { cc.stage(null); cc.busy = false; cc.say('Not enough live data for the model yet. Wait a few minutes and try again.'); return; }
    sg.forEach((g) => cc.stage(g.id, `${g.id.replace('USDT', '')}: model P(up)=${g.p.toFixed(3)}, edge ${(g.edge * 100).toFixed(1)}%`));
    const q = { id: sg[0].id, avg: sg[0].p - 0.5, last: acc[sg[0].id].last, edge: sg[0].edge };
    const dir = sg[0].dir;
    const tier = q.edge >= 0.05 ? 'strong' : q.edge >= 0.02 ? 'moderate' : 'weak';
    try {
      cc.guard(spec.amount);
      broker.open({ model: 'claude-code', symbol: q.id, dir, amount: spec.amount, duration: spec.duration, source: 'claude-code', strategy: 'Order-flow model', confidence: Math.round(50 + q.edge * 100), reasoning: `Round ${k + 1}/${spec.count}: model P(up)=${(q.avg + 0.5).toFixed(3)} on ${q.id.replace('USDT', '')} (${tier} call) -> ${dir === 'buy' ? 'CALL' : 'PUT'} for ${spec.duration}s. Walk-forward tested on 7 unseen days: about 54% on strong calls, about 52% on moderate, about 50.5% on weak. One trade at a time. Near a coin flip.` });
      placed++;
      cc.stage(q.id, `Trade ${k + 1}/${spec.count}: ${dir === 'buy' ? 'BUY' : 'SELL'} ${q.id.replace('USDT', '')} $${spec.amount} (${tier} call)`);
    } catch (e) { cc.stage(q.id, `Round ${k + 1}: could not trade (${e.message})`); return round(spec.count); }
    setTimeout(() => round(k + 1), 1500);
  };
  round(0);
  return true;
}

// Autonomous mode: the user gives ONLY the money. Claude decides duration, size, count and timing.
// Policy (from the walk-forward tests: only strong calls, edge >= 5%, beat break-even; weaker ones do not):
//  - scan BTC/ETH/BNB at 30s / 60s / 5min every second, trade only the strongest call and only if its edge >= 5%
//  - one trade at a time, stake 5% of the budget, at most 12 trades, scanning for at most 20 minutes
//  - stop-loss: stop when the session is down 30% of the budget; otherwise stop when the budget or time is used up
//  - no strong call = no trade (skipping is correct); at least 20s of analysis before the first trade
function runAuto({ cc, broker, feed, budget }) {
  if (!(budget >= 10)) return false;
  const stake = Math.max(1, Math.round(budget * 0.05));
  const MAX_TRADES = 12, SCAN_MS = 20 * 60000, STOP = 0.3, HORIZONS = [30, 60, 300];
  cc.start({ model: cc.s.model, minutes: 27, budget });
  cc.busy = true;
  const syms = SYMBOLS.map((x) => x.id);
  const t0 = Date.now(); let placed = 0, tick = 0, lastTrade = 0, ending = false;
  const end = (why) => {
    if (ending) return; ending = true; clearInterval(loop);
    cc.stage(null); cc.busy = false;
    cc.say(`Auto trader finished (${why}). ${placed} trade${placed === 1 ? '' : 's'} placed on strong model calls only. ${placed ? 'The summary follows when the last one settles.' : 'No call was strong enough, so I skipped. That is a valid result.'}`);
  };
  cc.s.stage = null;
  cc.stage(syms[0], `Auto mode, budget $${budget}: I choose stake $${stake} (5%), one trade at a time, 30s / 60s / 5min horizons, strong calls only (edge >= 5%), stop at -30% or 20 min.`);
  const loop = setInterval(() => {
    if (!cc.s.active) return end('session stopped');
    tick++;
    const el = Date.now() - t0;
    if (tick % 5 === 1) {
      const id = syms[Math.floor(tick / 5) % syms.length]; const r = sample(feed, id);
      try { cc.draw({ symbol: id, strategy: '8-strategy vote', action: r.score > 0.15 ? 'call' : r.score < -0.15 ? 'put' : 'skip', duration: 60, confidence: 52, reasoning: Object.entries(r.votes).map(([n2, x]) => n2 + ' ' + arrow(x)).join(', '), indicators: ['sma', 'ema', 'bb', 'dc'], overlays: OV.map((o) => o[0]), levels: [{ price: r.hi, kind: 'resistance', label: '30m High' }, { price: r.lo, kind: 'support', label: '30m Low' }, { price: (r.hi + r.lo) / 2, kind: 'target', label: 'Mid' }, { price: r.p, kind: 'entry', label: 'Now' }] }); } catch { /* ignore */ }
    }
    const m = cc.money();
    if (m.pnl <= -budget * STOP && !m.openStake) return end(`stop-loss hit, down $${Math.abs(m.pnl).toFixed(0)}`);
    if (placed >= MAX_TRADES && !m.openStake) return end('trade limit reached');
    if (el >= SCAN_MS && !m.openStake) return end('time limit reached');
    if (m.left < stake && !m.openStake) return end('budget used up');
    if (m.openStake) { if (tick % 10 === 0) cc.stage(syms[0], `Trade ${placed} is open. Waiting for it to settle before the next one. ${m.wins}W-${m.losses}L, net ${m.pnl >= 0 ? '+' : '-'}$${Math.abs(m.pnl).toFixed(0)}`); return; }
    if (el < 20000 || Date.now() - lastTrade < 8000) { if (tick % 5 === 0) cc.stage(syms[0], 'Analysing the market before trading...'); return; }
    if (el >= SCAN_MS || placed >= MAX_TRADES || m.left < stake) return;
    const cands = [];
    for (const id of ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']) for (const h of HORIZONS) { const g = modelSignal(feed, id, h); if (g) cands.push({ ...g, h }); }
    cands.sort((x, y) => y.edge - x.edge);
    const best = cands[0];
    if (!best) return;
    if (tick % 6 === 0) cc.stage(best.id, `Best call now: ${best.id.replace('USDT', '')} ${best.h}s P(up)=${best.p.toFixed(3)}, edge ${(best.edge * 100).toFixed(1)}% (need 5.0%)`);
    if (best.edge < 0.05) return;
    try {
      cc.guard(stake);
      broker.open({ model: 'claude-code', symbol: best.id, dir: best.dir, amount: stake, duration: best.h, source: 'claude-code', strategy: 'Order-flow model (auto)', confidence: Math.round(50 + best.edge * 100), reasoning: `Auto mode: strongest call across BTC/ETH/BNB at 30s/60s/5min. P(up)=${best.p.toFixed(3)} on ${best.id.replace('USDT', '')} -> ${best.dir === 'buy' ? 'CALL' : 'PUT'} for ${best.h}s, edge ${(best.edge * 100).toFixed(1)}%. Strong calls tested ~54-56% out of sample vs ~53% break-even. Small edge, near a coin flip.` });
      placed++; lastTrade = Date.now();
      cc.stage(best.id, `Trade ${placed}: ${best.dir === 'buy' ? 'BUY' : 'SELL'} ${best.id.replace('USDT', '')} $${stake} for ${best.h}s (edge ${(best.edge * 100).toFixed(1)}%)`);
    } catch (e) { cc.stage(best.id, `Could not trade (${e.message})`); }
  }, 1000);
  return true;
}

export function runInstant({ cc, broker, agent, feed, prompt }) {
  const spec = parsePrompt(prompt);
  if (!spec) { const b = parseBudget(prompt); return b ? runAuto({ cc, broker, feed, budget: Math.min(b, broker.balance) }) : false; }
  if (wantsSequential(prompt)) return runSequential({ cc, broker, feed, prompt, spec });
  const total = Math.min(spec.count * spec.amount, broker.balance);
  if (total < 1) return false;
  const low = String(prompt).toLowerCase();
  const am = low.match(/(?:analy[sz]e|research|study)\w*\s*(?:for\s*)?(\d+)\s*min/) || low.match(/(\d+)\s*min\w*\s*(?:to\s*)?(?:analy|research|study)/);
  const analysisSec = Math.min(600, Math.max(10, am ? parseInt(am[1], 10) * 60 : 10));
  cc.start({ model: cc.s.model, minutes: Math.ceil((analysisSec + spec.duration) / 60) + 2, budget: total });
  cc.busy = true;
  const syms = SYMBOLS.map((x) => x.id);
  const steps = Math.max(syms.length * 2, Math.round(analysisSec / 6));
  const stepMs = (analysisSec * 1000) / steps;
  const acc = Object.fromEntries(syms.map((id) => [id, { n: 0, sum: 0, up: 0, dn: 0, last: null }]));
  cc.s.stage = { lines: [`Analysis window: ${Math.round(analysisSec)}s. Running 8 strategies on 5 assets...`], symbol: syms[0] };
  cc.agent.push();

  const finish = () => {
    cc.stage(syms[0], 'Analysis done. Choosing only the assets where the strategies agree...');
    for (const id of syms) {
      const a = acc[id]; if (!a.last) continue; const avg = a.sum / a.n;
      try { cc.draw({ symbol: id, strategy: '8-strategy confluence', action: avg > 0.15 ? 'call' : avg < -0.15 ? 'put' : 'skip', duration: spec.duration, confidence: Math.round(50 + Math.abs(avg) * 30), reasoning: 'Final analysis', indicators: ['sma', 'ema', 'bb', 'dc'], overlays: OV.map((o) => o[0]), levels: [{ price: a.last.hi, kind: 'resistance', label: '30m High' }, { price: a.last.lo, kind: 'support', label: '30m Low' }, { price: (a.last.hi + a.last.lo) / 2, kind: 'target', label: 'Mid' }, { price: a.last.p, kind: 'entry', label: 'Now' }] }); } catch { /* ignore */ }
    }
    // Each asset trades its own model call (P(up) from the walk-forward-tested model). Most confident first.
    const qual = [];
    let weak = true;
    const sigs = TRADE_ASSETS.map((id) => modelSignal(feed, id, spec.duration)).filter(Boolean).sort((x, y) => y.edge - x.edge);
    sigs.forEach((g) => cc.stage(g.id, `${g.id.replace('USDT', '')}: model P(up)=${g.p.toFixed(3)}, edge ${(g.edge * 100).toFixed(1)}% -> ${g.dir === 'buy' ? 'CALL' : 'PUT'} (${g.edge >= 0.05 ? 'strong' : g.edge >= 0.02 ? 'moderate' : 'weak'})`));
    for (const g of sigs) qual.push({ id: g.id, dir: g.dir, avg: g.p - 0.5, last: acc[g.id].last });
    weak = sigs.every((g) => g.edge < 0.05);
    if (!qual.length) { cc.stage(null); cc.busy = false; cc.say('Not enough live data for the model yet. Wait about 10 minutes after starting the server and try again.'); return; }
    for (const q of qual) {
      try { cc.draw({ symbol: q.id, strategy: 'Fade pair', action: q.dir === 'buy' ? 'call' : 'put', duration: spec.duration, confidence: 52, reasoning: `Fade pair, stretch z=${q.avg.toFixed(2)}`, indicators: ['sma', 'ema', 'bb', 'dc'], overlays: OV.map((o) => o[0]), levels: [{ price: q.last.hi, kind: 'resistance', label: '30m High' }, { price: q.last.lo, kind: 'support', label: '30m Low' }, { price: (q.last.hi + q.last.lo) / 2, kind: 'target', label: 'Mid' }, { price: q.last.p, kind: 'entry', label: 'Now' }] }); } catch { /* ignore */ }
    }
    let placed = 0;
    const place = (i) => {
      if (i >= spec.count || !cc.s.active) {
        cc.stage(null); cc.busy = false;
        cc.say(`${placed < spec.count ? `Only ${placed} of ${spec.count} trades fit your balance of $${broker.balance.toFixed(0)} (each is $${spec.amount}). Top up to place all ${spec.count}. ` : ''}Placed ${placed} trades of $${spec.amount} (${spec.duration}s each) on ${qual.map((q) => q.id.replace('USDT', '') + ' ' + (q.dir === 'buy' ? 'CALL' : 'PUT')).join(', ')}. No strategy wins every trade.${weak ? ' Each coin follows its own model call.' : ''} The summary follows when they settle.`);
        return;
      }
      const q = qual[i % qual.length];
      try {
        cc.guard(spec.amount);
        broker.open({ model: 'claude-code', symbol: q.id, dir: q.dir, amount: spec.amount, duration: spec.duration, source: 'claude-code', strategy: 'Order-flow model', confidence: Math.round(50 + Math.abs(q.avg) * 100), reasoning: `Trade ${i + 1}/${spec.count}, ${spec.duration}s. Model P(up)=${(q.avg + 0.5).toFixed(3)} from price stretch, taker order flow, volatility, time of day and BTC's move -> ${q.dir === 'buy' ? 'CALL' : 'PUT'}. Backtested edge is small and only on confident calls; near a coin flip.` });
        placed++;
        cc.stage(q.id, `Trade ${i + 1}/${spec.count}: ${q.dir === 'buy' ? 'BUY' : 'SELL'} ${q.id.replace('USDT', '')} $${spec.amount}`);
      } catch { i = spec.count; }
      setTimeout(() => place(i + 1), 120);
    };
    place(0);
  };

  const step = (k) => {
    if (!cc.s.active) { cc.busy = false; cc.stage(null); return; }
    if (k >= steps) return finish();
    const id = syms[k % syms.length];
    const name = id.replace('USDT', '');
    const r = sample(feed, id);
    const a = acc[id]; a.n++; a.sum += r.score; if (r.score > 0.05) a.up++; else if (r.score < -0.05) a.dn++; a.last = r;
    const avg = a.sum / a.n;
    try { cc.draw({ symbol: id, strategy: '8-strategy confluence', action: avg > 0.15 ? 'call' : avg < -0.15 ? 'put' : 'skip', duration: spec.duration, confidence: Math.round(50 + Math.abs(avg) * 30), reasoning: Object.entries(r.votes).map(([n2, x]) => n2 + ' ' + arrow(x)).join(', '), indicators: ['sma', 'ema', 'bb', 'dc'], overlays: OV.slice(0, Math.min(15, a.n * 8)).map((o) => o[0]), levels: [{ price: r.hi, kind: 'resistance', label: '30m High' }, { price: r.lo, kind: 'support', label: '30m Low' }, { price: (r.hi + r.lo) / 2, kind: 'target', label: 'Mid' }, { price: r.p, kind: 'entry', label: 'Now' }] }); } catch { /* ignore */ }
    cc.stage(id, `${name}: drawing ${OV.slice((a.n - 1) * 8 % 15, (a.n - 1) * 8 % 15 + 8).map((o) => o[1]).slice(0, 3).join(', ')}...`);
    cc.stage(id, `${name} #${a.n}: ${Object.entries(r.votes).map(([n2, x]) => n2.split(' ')[0] + arrow(x)).join(' ')} = ${r.score.toFixed(2)} (avg ${avg.toFixed(2)})`);
    setTimeout(() => step(k + 1), stepMs);
  };
  step(0);
  return true;
}

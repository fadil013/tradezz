// Tradezz - local server. Serves the web app, streams live prices, runs the paper broker and the Claude trader.
// Bound to 127.0.0.1 only. Demo money only - there is no connection to any real trading account.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (ANTHROPIC_API_KEY, PORT)
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* no .env */
}

const { PORT, HOST, SYMBOLS, LIMITS, START_BALANCE, AGENT_MODELS } = await import('./src/config.js');
const { Feed } = await import('./src/feed.js');
const { Broker } = await import('./src/broker.js');
const { Agent, buildSnapshot } = await import('./src/agent.js');
const { CCSession } = await import('./src/cc.js');

const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');

// ---- SSE -------------------------------------------------------------------
const clients = new Set();
function broadcast(event, data) {
  if (!clients.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---- core objects ------------------------------------------------------------
const feed = new Feed();
const broker = new Broker({
  feed,
  file: path.join(DATA, 'state.json'),
  emit: (type, payload) => broadcast(type === 'trade' ? 'trade' : type === 'balance' ? 'bal' : type, payload),
});
const agent = new Agent({
  feed,
  broker,
  emit: (type, payload) => broadcast(type, payload),
  file: path.join(DATA, 'agent.json'),
  envFile: path.join(ROOT, '.env'),
});

const cc = new CCSession({ feed, broker, agent, file: path.join(DATA, 'cc.json') });
agent.cc = cc;

// Batch ticks every 50ms so the browser gets every trade without flooding it.
let pending = [];
feed.on('trade', (idx, price, ts, qty) => pending.push([idx, price, ts, qty]));
setInterval(() => {
  if (pending.length) {
    broadcast('t', pending);
    pending = [];
  }
}, 50);
setInterval(() => broadcast('s', feed.sentiments()), 1000);
feed.on('ticker', (t) => broadcast('ticker', t));
setInterval(() => clients.forEach((res) => res.write(': ping\n\n')), 15000);

// ---- helpers ---------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Protects the local API from other websites (CSRF / DNS-rebinding).
function hostOk(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return false;
  return true;
}

function tradeView(t) {
  return t;
}

function initPayload() {
  return {
    symbols: SYMBOLS,
    limits: LIMITS,
    startBalance: START_BALANCE,
    balance: broker.balance,
    openTrades: broker.openTrades(),
    recent: broker.recent(60),
    stats: broker.allStats(),
    tickers: feed.tickers(),
    sentiments: feed.sentiments(),
    feed: feed.status(),
    agent: agent.state(),
    now: Date.now(),
  };
}

// ---- routes ------------------------------------------------------------------
async function api(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const post = req.method === 'POST';

  if (p === '/api/init') return json(res, 200, initPayload());

  if (p === '/api/candles') {
    const id = q.get('symbol');
    if (!SYMBOLS.some((s) => s.id === id)) return json(res, 400, { error: 'Unknown symbol' });
    const tf = Math.min(14400, Math.max(5, parseInt(q.get('tf'), 10) || 15));
    const limit = Math.min(2500, Math.max(10, parseInt(q.get('limit'), 10) || 400));
    return json(res, 200, { symbol: id, tf, candles: feed.candles(id, tf, limit), price: feed.price(id).p });
  }

  if (p === '/api/spark') {
    const out = {};
    for (const s of SYMBOLS) out[s.id] = feed.candles(s.id, 60, 60).map((c) => c[4]);
    return json(res, 200, out);
  }

  if (p === '/api/trades') return json(res, 200, { trades: broker.recent(Math.min(1000, parseInt(q.get('limit'), 10) || 100)) });
  if (p === '/api/stats') return json(res, 200, broker.allStats());

  if (p === '/api/snapshot') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(buildSnapshot(feed, broker));
  }

  if (p === '/api/cc' && !post) { cc.touch(); return json(res, 200, cc.state()); }

  if (p === '/api/agent' && !post) return json(res, 200, { state: agent.state(), log: agent.log });

  if (!post) return json(res, 404, { error: 'Not found' });

  // ---- POST (state-changing) ----
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }

  if (p === '/api/cc/start') { cc.start(body); return json(res, 200, cc.state()); }
  if (p === '/api/cc/stop') { cc.stop(); return json(res, 200, cc.state()); }
  if (p === '/api/cc/draw') {
    try { cc.draw(body); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (p === '/api/trade') {
    try {
      const model = body.source === 'claude-code' ? cc.guard(body.amount) : null;
      const t = broker.open({
        model,
        symbol: body.symbol,
        dir: body.dir,
        amount: body.amount,
        duration: body.duration,
        source: body.source,
        reasoning: body.reasoning,
        confidence: body.confidence,
        strategy: body.strategy,
      });
      return json(res, 200, { trade: tradeView(t), balance: broker.balance });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (p === '/api/topup') {
    try { return json(res, 200, { balance: broker.topUp(body.amount) }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/reset') {
    broker.reset();
    return json(res, 200, { balance: broker.balance });
  }
  if (p === '/api/agent/config') {
    agent.configure(body || {});
    return json(res, 200, { state: agent.state() });
  }
  if (p === '/api/agent/key') {
    try { agent.setKey(body.key); return json(res, 200, { state: agent.state() }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/agent/run') {
    if (agent.running) return json(res, 409, { error: 'Claude is already analysing' });
    agent.runOnce(); // async - result arrives over SSE
    return json(res, 200, { started: true });
  }
  return json(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req)) { res.writeHead(403); return res.end('Forbidden'); }
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 1000\n\nevent: hello\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is already in use. Close the other Tradezz window or run with a different port:  set PORT=3001 && node server.js\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Tradezz is running  ->  http://localhost:${PORT}\n  (demo money only - live prices from Binance)\n`);
  feed.start().catch((e) => console.error('[feed]', e));
});

function shutdown() {
  broker.saveNow();
  agent.save();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

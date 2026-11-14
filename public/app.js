import { TradeChart } from './chart.js';
import { icon, hydrate } from './icons.js';

// ======================================================================
// helpers
// ======================================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad2 = (n) => String(n).padStart(2, '0');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (n) => (n < 0 ? '-' : '') + '$' + fmt(Math.abs(n));
const signed = (n) => (n >= 0 ? '+' : '-') + '$' + fmt(Math.abs(n));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem('trade.' + k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('trade.' + k, v); } catch { /* private mode */ } },
};

async function api(path, body) {
  const opt = body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined;
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

const TFS = [
  [5, 'S5'], [10, 'S10'], [15, 'S15'], [30, 'S30'], [60, 'M1'], [120, 'M2'], [300, 'M5'], [600, 'M10'], [900, 'M15'], [1800, 'M30'], [3600, 'H1'],
];
const tfLabel = (tf) => (TFS.find((x) => x[0] === tf) || [0, tf + 's'])[1];
const DURS = [5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600];
const AMTS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const fmtDur = (s) => `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
const durName = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : `${s / 3600}h`);
function parseDur(txt) {
  txt = String(txt).trim();
  if (/^\d+$/.test(txt)) return parseInt(txt, 10);
  const p = txt.split(':').map((x) => parseInt(x, 10));
  if (p.some((x) => !Number.isFinite(x))) return null;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return null;
}
const clockStr = (ms, sec = true) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` + (sec ? ':' + pad2(d.getSeconds()) : ''); };
function dateTimeStr(ms) {
  const d = new Date(ms);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return (same ? '' : `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} `) + clockStr(ms);
}

// ======================================================================
// state
// ======================================================================
const S = {
  symbols: [], idx: 0, tf: Number(ls.get('tf', 15)), type: ls.get('type', 'candles'),
  duration: Number(ls.get('dur', 15)), amount: Number(ls.get('amt', 100)),
  balance: 0, shownBalance: 0, open: [], recent: [], stats: null, tickers: [], sent: [], prices: [],
  agent: null, agentLog: [], drawings: {}, aiCollapsed: false, tabs: [], spark: {}, sparkMin: {},
  sheet: null, soundOn: ls.get('sound', '1') !== '0', unseenClaude: 0, unseenAct: 0,
  loading: true, sseDown: false, lastTick: 0, reqId: 0, tradeTab: 'open', analysing: false,
  ind: JSON.parse(ls.get('ind', '{"sma":false,"ema":false,"bb":false}')),
};
let chart;
const cur = () => S.symbols[S.idx];

// ======================================================================
// sound + toasts
// ======================================================================
let actx;
function beep(freqs, dur = 0.09, vol = 0.05) {
  if (!S.soundOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = actx.currentTime;
    freqs.forEach((f, i) => {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * dur);
      g.gain.linearRampToValueAtTime(vol, t0 + i * dur + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + (i + 1) * dur + 0.09);
      o.connect(g).connect(actx.destination);
      o.start(t0 + i * dur);
      o.stop(t0 + (i + 1) * dur + 0.12);
    });
  } catch { /* audio unavailable */ }
}

function toast(kind, title, sub = '', ms = 4200) {
  const box = $('#toasts');
  while (box.children.length >= 3) box.firstChild.remove();
  const ic = kind === 'win' ? 'check' : kind === 'lose' ? 'close' : kind === 'err' ? 'close' : 'bell';
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="ticon">${icon(ic)}</div><div><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}

// ======================================================================
// background art (soft mountains, like the broker terminal)
// ======================================================================
function setMountainBg() {
  // Plain deep-navy backdrop with a fine dot grid. No decoration competing with the candles.
  const W = 1280, H = 720;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const base = g.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, '#171d36'); base.addColorStop(1, '#1d2543');
  g.fillStyle = base; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(170,190,240,0.06)';
  for (let y = 16; y < H; y += 24) for (let x = 16; x < W; x += 24) g.fillRect(x, y, 1.5, 1.5);
  $('#chartwrap').style.backgroundImage = `url("${cv.toDataURL('image/jpeg', 0.92)}")`;
}

// ======================================================================
// asset tabs + sparklines
// ======================================================================
function coinHtml(s, size) {
  const st = size ? `style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.52)}px;background:${s.color}"` : `style="background:${s.color}"`;
  return `<span class="coin" ${st}>${s.glyph}</span>`;
}

function buildTabs() {
  const box = $('#tabs');
  box.innerHTML = '';
  for (const i of S.tabs) {
    const s = S.symbols[i];
    const b = document.createElement('button');
    b.className = 'tab' + (i === S.idx ? ' sel' : '');
    b.dataset.i = i;
    b.innerHTML = `<canvas></canvas><div class="tt"><span class="tx" data-close="${i}">✕</span><span class="tn">${s.pair}</span><span class="tp">+${s.payout}%</span></div>`;
    box.appendChild(b);
  }
  if (S.tabs.length < S.symbols.length) {
    const a = document.createElement('button');
    a.className = 'tab-add';
    a.id = 'tabAdd';
    a.innerHTML = `${icon('plus', 16)}<span>Add</span>`;
    box.appendChild(a);
  }
  drawSparks();
}

function drawSparks() {
  $$('#tabs .tab').forEach((tab) => {
    const i = Number(tab.dataset.i);
    const data = S.spark[S.symbols[i].id];
    const cv = $('canvas', tab);
    const dpr = window.devicePixelRatio || 1;
    const w = tab.clientWidth;
    const h = tab.clientHeight;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!data || data.length < 2) return;
    let mn = Math.min(...data);
    let mx = Math.max(...data);
    if (mx === mn) { mx += 1e-9; mn -= 1e-9; }
    const top = 26;
    const bot = h - 4;
    const pts = data.map((v, k) => [(k / (data.length - 1)) * w, bot - ((v - mn) / (mx - mn)) * (bot - top)]);
    const g = ctx.createLinearGradient(0, top, 0, h);
    g.addColorStop(0, 'rgba(45,100,185,0.62)');
    g.addColorStop(1, 'rgba(35,70,130,0.22)');
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = '#3f86ec';
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();
  });
}

async function loadSpark() {
  try {
    S.spark = await api('/api/spark');
    const now = Math.floor(Date.now() / 60000);
    for (const s of S.symbols) S.sparkMin[s.id] = now;
    drawSparks();
  } catch { /* retry on next resync */ }
}

function sparkTick(idx, price, ts) {
  const id = S.symbols[idx].id;
  const arr = S.spark[id];
  if (!arr || !arr.length) return;
  const m = Math.floor(ts / 60000);
  if (m > S.sparkMin[id]) { arr.push(price); if (arr.length > 60) arr.shift(); S.sparkMin[id] = m; } else arr[arr.length - 1] = price;
}

// ======================================================================
// symbol / candles
// ======================================================================
async function selectSymbol(i, first = false) {
  if (!S.tabs.includes(i)) S.tabs.push(i);
  S.idx = i;
  ls.set('sym', i);
  ls.set('tabs', JSON.stringify(S.tabs));
  const s = cur();
  $('#chartwrap').dataset.sym = s.pair;
  $('#assetName').textContent = s.name;
  $('#assetCoin').outerHTML = coinHtml(s).replace('<span ', '<span id="assetCoin" ');
  $('#favBtn').classList.toggle('on', Number(ls.get('fav', -1)) === i);
  chart.setSymbol(s.decimals);
  chart.hlines = [];
  chart.candles = [];
  chart.trades = [];
  chart.closed = [];
  chart.ai = null;
  buildTabs();
  updatePayout();
  updateSent();
  syncChartTrades();
  syncAi();
  renderOpenMini();
  if (S.sheet === 'insights') renderSheet();
  await loadCandles();
}

async function loadCandles() {
  const id = ++S.reqId;
  S.loading = true;
  const s = cur();
  try {
    const r = await api(`/api/candles?symbol=${s.id}&tf=${S.tf}&limit=900`);
    if (id !== S.reqId) return;
    chart.setCandles(r.candles, S.tf);
    chart.expirySec = S.duration;
  } catch (e) {
    if (id === S.reqId) toast('err', 'Could not load candles', e.message);
  } finally {
    if (id === S.reqId) S.loading = false;
  }
}

function setTf(tf) {
  S.tf = tf;
  ls.set('tf', tf);
  $('#tfBadge').textContent = tfLabel(tf);
  $('#tfLabel').textContent = tfLabel(tf);
  loadCandles();
}

function syncChartTrades() {
  const s = cur();
  if (!s || !chart) return;
  chart.trades = S.open.filter((t) => t.symbol === s.id);
  const since = Date.now() - 3 * 3600 * 1000;
  chart.closed = S.recent.filter((t) => t.symbol === s.id && (t.status === 'won' || t.status === 'lost' || t.status === 'draw') && t.openTime > since).slice(0, 40);
}

// ======================================================================
// balance / payout / sentiment
// ======================================================================
let balAnim = null;
function setBalance(v, animate = true) {
  const old = S.balance;
  S.balance = v;
  if (balAnim) cancelAnimationFrame(balAnim);
  const el = $('#balance');
  if (!animate || old === v) { S.shownBalance = v; el.textContent = fmt(v); return; }
  el.classList.remove('up', 'down');
  void el.offsetWidth;
  el.classList.add(v > old ? 'up' : 'down');
  const from = S.shownBalance;
  const t0 = performance.now();
  const step = (t) => {
    const k = clamp((t - t0) / 500, 0, 1);
    S.shownBalance = from + (v - from) * (1 - Math.pow(1 - k, 3));
    el.textContent = fmt(S.shownBalance);
    if (k < 1) balAnim = requestAnimationFrame(step);
  };
  balAnim = requestAnimationFrame(step);
  if (S.sheet === 'finance') renderSheet();
}

function updatePayout() {
  const s = cur();
  if (!s) return;
  $('#payPct').textContent = `+${s.payout}%`;
  $('#payVal').textContent = `+$${fmt((S.amount * s.payout) / 100)}`;
}

function updateSent() {
  const buy = S.sent[S.idx] ?? 50;
  $('#sentFill').style.height = buy + '%';
  $('#sentMark').style.top = buy + '%';
  $('#sentTop').textContent = buy + '%';
  $('#sentBot').textContent = 100 - buy + '%';
}

// ======================================================================
// trading panel
// ======================================================================
function setDuration(sec, fromInput = false) {
  sec = clamp(Math.round(sec), 5, 3600);
  S.duration = sec;
  ls.set('dur', sec);
  if (!fromInput) $('#timeInput').value = fmtDur(sec);
  if (chart) chart.expirySec = sec;
}

function setAmount(v, fromInput = false) {
  v = Math.round(clamp(Number.isFinite(v) ? v : 1, 1, 1e7) * 100) / 100;
  S.amount = v;
  ls.set('amt', v);
  if (!fromInput) $('#amtInput').value = v % 1 ? fmt(v, 2) : fmt(v, 0);
  updatePayout();
}

function stepDur(dir) {
  const i = DURS.findIndex((d) => d >= S.duration);
  const cur2 = DURS[i === -1 ? DURS.length - 1 : i];
  let k = DURS.indexOf(cur2);
  if (cur2 !== S.duration && dir > 0) k = Math.max(0, k - 1);
  setDuration(DURS[clamp(k + dir, 0, DURS.length - 1)]);
}

function buildPops() {
  $('#timePop').innerHTML = DURS.map((d) => `<button data-dur="${d}" class="${d === S.duration ? 'on' : ''}"><span>${fmtDur(d)}</span><span class="mut">${durName(d)}</span></button>`).join('');
  $('#amtPop').innerHTML = `<div class="two"><button data-amt="half">½</button><button data-amt="x2">×2</button></div>` +
    AMTS.map((a) => `<button data-amt="${a}" class="${a === S.amount ? 'on' : ''}"><span>$${fmt(a, 0)}</span></button>`).join('') +
    `<button data-amt="max"><span>Max</span><span class="mut">$${fmt(S.balance)}</span></button>`;
}

function closeFieldPops() { $('#timePop').classList.add('hidden'); $('#amtPop').classList.add('hidden'); }

async function place(dir) {
  const s = cur();
  const btn = dir === 'buy' ? $('#buyBtn') : $('#sellBtn');
  btn.classList.add('press');
  setTimeout(() => btn.classList.remove('press'), 140);
  try {
    const r = await api('/api/trade', { symbol: s.id, dir, amount: S.amount, duration: S.duration, source: 'user' });
    upsertTrade(r.trade);
    beep([620, 840], 0.06, 0.04);
  } catch (e) {
    toast('err', 'Trade not placed', e.message);
    beep([200], 0.12, 0.05);
  }
}

// ======================================================================
// trades state
// ======================================================================
function upsertTrade(t) {
  const prevOpen = S.open.findIndex((x) => x.id === t.id);
  const wasOpen = prevOpen >= 0;
  if (t.status === 'open') {
    if (!wasOpen) S.open.push(t); else S.open[prevOpen] = t;
  } else if (wasOpen) {
    S.open.splice(prevOpen, 1);
  }
  const ri = S.recent.findIndex((x) => x.id === t.id);
  if (ri >= 0) S.recent[ri] = t; else S.recent.unshift(t);
  S.recent = S.recent.slice(0, 300);

  if (t.status !== 'open' && wasOpen) onSettled(t);
  syncChartTrades();
  renderOpenMini();
  if (['trades', 'activities', 'leaders', 'profile', 'claude'].includes(S.sheet)) renderSheet();
  refreshStats();
}

function onSettled(t) {
  const s = S.symbols.find((x) => x.id === t.symbol);
  const who = t.source === 'claude' ? ' · Claude' : t.source === 'claude-code' ? ' · Claude Code' : '';
  const sub = `${s.pair} · ${t.dir === 'buy' ? 'BUY' : 'SELL'} · ${durName(t.duration)}${who}`;
  if (t.status === 'won') { toast('win', `WIN  ${signed(t.profit)}`, sub); beep([660, 880, 1100], 0.08, 0.05); }
  else if (t.status === 'lost') { toast('lose', `LOSS  ${signed(t.profit)}`, sub); beep([330, 250], 0.12, 0.05); }
  else if (t.status === 'draw') toast('info', 'DRAW - stake returned', sub);
  if (!S.sheet || S.sheet !== 'activities') { S.unseenAct++; setBadge('#badgeAct', S.unseenAct); }
}

function setBadge(sel, n) {
  const el = $(sel);
  el.textContent = n > 99 ? '99+' : n;
  el.classList.toggle('hidden', !n);
}

let statsTimer;
function refreshStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(async () => {
    try { S.stats = await api('/api/stats'); if (['leaders', 'profile', 'claude', 'trades'].includes(S.sheet)) renderSheet(); } catch { /* ignore */ }
  }, 300);
}

function renderOpenMini() {
  const box = $('#openMini');
  if (!S.open.length) { box.innerHTML = ''; return; }
  const now = Date.now();
  box.innerHTML = `<h6>Open trades</h6>` + S.open.slice().sort((a, b) => a.expiry - b.expiry).slice(0, 8).map((t) => {
    const s = S.symbols.find((x) => x.id === t.symbol);
    const left = Math.max(0, Math.ceil((t.expiry - now) / 1000));
    return `<div class="mini" data-exp="${t.expiry}"><span class="md ${t.dir}">${t.dir === 'buy' ? '▲' : '▼'}</span><b>${s.short}</b><span class="ma">$${fmt(t.amount, 0)}</span><span class="mt">${fmtDur(left).replace(/^00:/, '')}</span></div>`;
  }).join('');
}

// ======================================================================
// popups (chart toolbar)
// ======================================================================
let popAnchor = null;
function showPopup(anchor, html, up = false) {
  const pop = $('#popup');
  if (!pop.classList.contains('hidden') && popAnchor === anchor) { hidePopup(); return; }
  pop.innerHTML = html;
  pop.classList.remove('hidden');
  const w = $('#chartwrap').getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  pop.style.left = clamp(a.left - w.left, 8, Math.max(8, w.width - pop.offsetWidth - 8)) + 'px';
  if (up) { pop.style.top = 'auto'; pop.style.bottom = w.bottom - a.top + 8 + 'px'; } else { pop.style.bottom = 'auto'; pop.style.top = a.bottom - w.top + 8 + 'px'; }
  popAnchor = anchor;
  anchor.classList.add('open');
}
function hidePopup() {
  $('#popup').classList.add('hidden');
  if (popAnchor) popAnchor.classList.remove('open');
  popAnchor = null;
}
const chk = (on) => (on ? `<span class="chk">${icon('check', 16)}</span>` : '');

function tfPopup(anchor, up) {
  const types = [['candles', 'Candlesticks'], ['heikin', 'Heikin-Ashi'], ['line', 'Line'], ['area', 'Area']];
  showPopup(anchor,
    `<h6>Candle period</h6><div class="grid">${TFS.map(([tf, l]) => `<button data-pa="tf" data-v="${tf}" class="${tf === S.tf ? 'on' : ''}">${l}</button>`).join('')}</div>` +
    `<h6>Chart type</h6>${types.map(([k, l]) => `<button class="opt ${S.type === k ? 'on' : ''}" data-pa="type" data-v="${k}">${l}${chk(S.type === k)}</button>`).join('')}`, up);
}
function indPopup(anchor) {
  const rows = [['sma', 'SMA (20)', '#ffb020'], ['ema', 'EMA (20)', '#3cc8ff'], ['bb', 'Bollinger Bands (20, 2)', '#a78bfa']];
  showPopup(anchor, `<h6>Indicators</h6>` + rows.map(([k, l, c]) => `<button class="opt" data-pa="ind" data-v="${k}"><span style="width:10px;height:10px;border-radius:50%;background:${c}"></span>${l}${chk(S.ind[k])}</button>`).join(''));
}
function drawPopup(anchor) {
  showPopup(anchor, `<h6>Drawing</h6><button class="opt" data-pa="hline">${icon('line', 18)}Horizontal line</button><button class="opt" data-pa="clearlines">${icon('trash', 18)}Remove all lines</button>`);
}
function morePopup(anchor) {
  showPopup(anchor, `<h6>Chart</h6><button class="opt" data-pa="sound">Sound effects${chk(S.soundOn)}</button><button class="opt" data-pa="resetview">Reset view</button><button class="opt" data-pa="dim">Dim background${chk(document.body.classList.contains('dim'))}</button>`);
}
function assetPopup(anchor) {
  showPopup(anchor, `<h6>Assets</h6>` + S.symbols.map((s, i) => {
    const p = S.prices[i];
    return `<button class="assetrow" data-pa="asset" data-v="${i}">${coinHtml(s)}<span><div class="nm">${s.pair}</div><div class="pr">${p != null ? fmt(p, s.decimals) : '…'}</div></span><span class="po">+${s.payout}%</span></button>`;
  }).join(''));
}

function onPopupAction(el) {
  const a = el.dataset.pa;
  const v = el.dataset.v;
  if (a === 'tf') { setTf(Number(v)); hidePopup(); }
  else if (a === 'type') { S.type = v; chart.type = v; ls.set('type', v); hidePopup(); }
  else if (a === 'ind') { S.ind[v] = !S.ind[v]; chart.ind = { ...S.ind }; ls.set('ind', JSON.stringify(S.ind)); $('#indBtn').classList.toggle('act', Object.values(S.ind).some(Boolean)); indPopupRefresh(); }
  else if (a === 'hline') { chart.tool = 'hline'; hidePopup(); toast('info', 'Click on the chart to place the line'); }
  else if (a === 'clearlines') { chart.hlines = []; hidePopup(); }
  else if (a === 'sound') { S.soundOn = !S.soundOn; ls.set('sound', S.soundOn ? '1' : '0'); hidePopup(); toast('info', S.soundOn ? 'Sound on' : 'Sound off'); }
  else if (a === 'resetview') { chart.resetView(); hidePopup(); }
  else if (a === 'dim') { document.body.classList.toggle('dim'); ls.set('dim', document.body.classList.contains('dim') ? '1' : '0'); hidePopup(); }
  else if (a === 'asset') { hidePopup(); selectSymbol(Number(v)); }
}
function indPopupRefresh() { const anchor = popAnchor; hidePopup(); if (anchor) indPopup(anchor); }

// ======================================================================
// sheets (side panels)
// ======================================================================
const LEFT = ['finance', 'profile', 'market', 'activities', 'claude', 'help'];
function openSheet(name) {
  if (name === 'trading') { closeSheet(); return; }
  if (S.sheet === name) { closeSheet(); return; }
  S.sheet = name;
  const sh = $('#sheet');
  sh.className = 'sheet ' + (LEFT.includes(name) ? 'left' : 'right');
  if (name === 'claude') { S.unseenClaude = 0; setBadge('#badgeClaude', 0); loadAgent(); }
  if (name === 'activities') { S.unseenAct = 0; setBadge('#badgeAct', 0); }
  renderSheet();
  $$('.nav[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === name || (!name && b.dataset.nav === 'trading')));
}
function closeSheet() {
  S.sheet = null;
  $('#sheet').classList.add('hidden');
  $$('.nav[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === 'trading'));
}

const dirTag = (d) => `<span class="tag ${d === 'buy' ? 'buy' : 'sell'}">${d === 'buy' ? 'BUY' : 'SELL'}</span>`;
const srcTag = (s) => (s === 'claude' ? '<span class="tag claude">Claude</span>' : s === 'claude-code' ? '<span class="tag code">Claude Code</span>' : '<span class="tag">You</span>');
const symOf = (id) => S.symbols.find((x) => x.id === id);

function tradeRows(list, withResult = true) {
  if (!list.length) return `<div class="empty">Nothing here yet.</div>`;
  return `<table class="t"><thead><tr><th>Asset</th><th>Side</th><th class="r">Amount</th><th class="r">${withResult ? 'Result' : 'Time left'}</th></tr></thead><tbody>` + list.map((t) => {
    const s = symOf(t.symbol);
    const res = t.status === 'open'
      ? `<span data-exp="${t.expiry}">${fmtDur(Math.max(0, Math.ceil((t.expiry - Date.now()) / 1000))).replace(/^00:/, '')}</span>`
      : t.status === 'won' ? `<span class="pos">${signed(t.profit)}</span>` : t.status === 'lost' ? `<span class="neg">${signed(t.profit)}</span>` : `<span class="mut">${t.status === 'void' ? 'void' : 'draw'}</span>`;
    const why = t.reasoning ? `<tr><td colspan="4" class="mut" style="padding:0 6px 10px;font-size:12.5px;line-height:1.45">${t.strategy ? `<b style="color:#c9a4ff">✦ ${esc(t.strategy)}</b> · ` : ''}${t.confidence != null ? `<b>${t.confidence}%</b> · ` : ''}${esc(t.reasoning)}</td></tr>` : '';
    return `<tr><td><b>${s.short}</b><div class="mut" style="font-size:11.5px">${dateTimeStr(t.openTime)} · ${durName(t.duration)}</div></td><td>${dirTag(t.dir)}<div style="margin-top:3px">${srcTag(t.source)}</div></td><td class="r">$${fmt(t.amount)}<div class="mut" style="font-size:11.5px">${fmt(t.openPrice, s.decimals)}${t.closePrice ? ' → ' + fmt(t.closePrice, s.decimals) : ''}</div></td><td class="r">${res}</td></tr>${why}`;
  }).join('') + `</tbody></table>`;
}

function statCard(label, st) {
  if (!st) return '';
  return `<div class="card"><small>${label}</small><b class="${st.pnl >= 0 ? 'pos' : 'neg'}">${signed(st.pnl)}</b><div class="mut" style="margin-top:5px;font-size:12.5px">${st.trades} trades · ${st.winRate == null ? 'no win rate yet' : st.winRate + '% wins'}</div></div>`;
}

const SHEETS = {
  trades() {
    const closed = S.recent.filter((t) => t.status !== 'open');
    return {
      title: 'Trades',
      html: `<div class="seg" style="margin-bottom:14px"><button data-act="ttab" data-v="open" class="${S.tradeTab === 'open' ? 'on' : ''}">Open (${S.open.length})</button><button data-act="ttab" data-v="closed" class="${S.tradeTab === 'closed' ? 'on' : ''}">Closed (${closed.length})</button></div>` +
        (S.tradeTab === 'open' ? tradeRows(S.open.slice().sort((a, b) => a.expiry - b.expiry), false) : tradeRows(closed.slice(0, 60))),
    };
  },
  activities() {
    const closed = S.recent.filter((t) => t.status !== 'open');
    return { title: 'Activities', html: `<h4>History (latest ${Math.min(200, closed.length)})</h4>` + tradeRows(closed.slice(0, 200)) };
  },
  leaders() {
    const st = S.stats || {};
    const row = (name, tag, x) => `<tr><td>${tag}</td><td class="r">${x ? x.trades : 0}</td><td class="r">${x && x.winRate != null ? x.winRate + '%' : '–'}</td><td class="r ${x && x.pnl >= 0 ? 'pos' : 'neg'}">${signed(x ? x.pnl : 0)}</td></tr>`;
    return {
      title: 'Leaderboard',
      html: `<h4>Who trades better?</h4><table class="t"><thead><tr><th>Trader</th><th class="r">Trades</th><th class="r">Win rate</th><th class="r">P/L</th></tr></thead><tbody>${row('You', srcTag('user'), st.user)}${row('Claude', srcTag('claude'), st.claude)}${row('Claude Code', srcTag('claude-code'), st['claude-code'])}</tbody></table>
<h4>Break-even math</h4><div class="note">A win pays only 84-92% of the stake while a loss costs all of it, so you need to win about <b>52-54%</b> of trades just to break even. Short-term price moves are close to a coin flip, which is why most traders (and most AIs) end up slightly negative. A win rate that stays above ~54% over a few hundred trades is a real edge.</div>`,
    };
  },
  hotkeys() {
    const k = (a, b) => `<div class="row sp" style="padding:9px 0;border-bottom:1px solid #252e49"><span>${a}</span><span>${b}</span></div>`;
    return {
      title: 'Hotkeys',
      html: k('Buy', '<span class="kbd">Shift</span> + <span class="kbd">W</span>') + k('Sell', '<span class="kbd">Shift</span> + <span class="kbd">S</span>') +
        k('Amount up / down', '<span class="kbd">Shift</span> + <span class="kbd">↑</span> <span class="kbd">↓</span>') + k('Time longer / shorter', '<span class="kbd">Shift</span> + <span class="kbd">→</span> <span class="kbd">←</span>') +
        k('Switch asset', '<span class="kbd">1</span> … <span class="kbd">5</span>') + k('Back to live view', '<span class="kbd">Space</span>') + k('Full screen', '<span class="kbd">F</span>') + k('Close panel', '<span class="kbd">Esc</span>') +
        `<div class="note" style="margin-top:16px">On the chart: <b>scroll</b> to zoom, <b>drag</b> to move through time, <b>drag the price axis</b> to stretch it, <b>double-click</b> to snap back to live.</div>`,
    };
  },
  finance() {
    return {
      title: 'Finance',
      html: `<div class="card" style="margin-bottom:14px"><small>Demo balance</small><b style="font-size:30px">${money(S.balance)}</b></div>
<h4>Top up (demo money)</h4><div class="cards">${[1000, 10000, 100000].map((a) => `<button class="btn" data-act="topup" data-v="${a}">+ $${fmt(a, 0)}</button>`).join('')}</div>
<h4>Start over</h4><button class="btn danger block" data-act="reset">Reset account &amp; clear all history</button>
<div class="note" style="margin-top:16px">Everything here is <b>demo money</b>. Prices are real and live (Binance), but nothing connects to a real trading account.</div>`,
    };
  },
  profile() {
    const a = (S.stats || {}).all;
    return {
      title: 'Profile',
      html: `<div class="row" style="margin-bottom:18px"><div class="avatar" style="width:64px;height:64px;font-size:30px">${icon('user')}</div><div><b style="font-size:19px">Demo Trader</b><div class="mut">Paper account · USD</div></div></div>
<div class="cards">${statCard('All trades', a)}<div class="card"><small>Balance</small><b>${money(S.balance)}</b></div>
<div class="card"><small>Best win streak</small><b>${a ? a.bestStreak : 0}</b></div><div class="card"><small>Volume traded</small><b>${money(a ? a.volume : 0)}</b></div></div>
<h4>Settings</h4><div class="row sp" style="padding:8px 0"><span>Sound effects</span><button class="switch ${S.soundOn ? 'on' : ''}" data-act="sound"></button></div>`,
    };
  },
  market() {
    return {
      title: 'Market',
      html: `<table class="t"><thead><tr><th>Asset</th><th class="r">Price</th><th class="r">24h</th><th class="r">Payout</th><th></th></tr></thead><tbody>` + S.symbols.map((s, i) => {
        const tk = S.tickers[i];
        const p = S.prices[i];
        return `<tr><td><div class="row">${coinHtml(s, 28)}<div><b>${s.short}</b><div class="mut" style="font-size:11.5px">${s.name}</div></div></div></td><td class="r">${p != null ? fmt(p, s.decimals) : '…'}</td><td class="r ${tk && tk.change >= 0 ? 'pos' : 'neg'}">${tk ? (tk.change >= 0 ? '+' : '') + tk.change.toFixed(2) + '%' : '–'}</td><td class="r pos">+${s.payout}%</td><td class="r"><button class="btn" style="height:32px;padding:0 12px" data-act="trade" data-v="${i}">Trade</button></td></tr>`;
      }).join('') + `</tbody></table>
<h4>24h range</h4>` + S.symbols.map((s, i) => { const tk = S.tickers[i]; return tk ? `<div class="row sp" style="padding:7px 0;border-bottom:1px solid #232c46"><b>${s.short}</b><span class="mut">${fmt(tk.low, s.decimals)} – ${fmt(tk.high, s.decimals)} · vol $${fmt(tk.volume / 1e6, 1)}M</span></div>` : ''; }).join(''),
    };
  },
  insights() {
    const s = cur();
    const cs = chart.candles.map((c) => c.c);
    const tk = S.tickers[S.idx];
    const ema = (a, n) => { if (a.length < n) return null; const k = 2 / (n + 1); let e = a.slice(0, n).reduce((x, y) => x + y, 0) / n; for (let i = n; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; };
    const rsi = (a, n = 14) => { if (a.length < n + 1) return null; let g = 0; let l = 0; for (let i = 1; i <= n; i++) { const d = a[i] - a[i - 1]; if (d >= 0) g += d; else l -= d; } g /= n; l /= n; for (let i = n + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); };
    const e9 = ema(cs, 9); const e21 = ema(cs, 21); const r = rsi(cs);
    const trend = e9 == null || e21 == null ? '–' : e9 > e21 ? 'Up' : 'Down';
    const buy = S.sent[S.idx] ?? 50;
    return {
      title: `Insights · ${s.pair}`,
      html: `<div class="cards"><div class="card"><small>Price</small><b>${S.prices[S.idx] != null ? fmt(S.prices[S.idx], s.decimals) : '…'}</b></div><div class="card"><small>24h change</small><b class="${tk && tk.change >= 0 ? 'pos' : 'neg'}">${tk ? (tk.change >= 0 ? '+' : '') + tk.change.toFixed(2) + '%' : '–'}</b></div>
<div class="card"><small>Trend (EMA 9 / 21, ${tfLabel(S.tf)})</small><b class="${trend === 'Up' ? 'pos' : trend === 'Down' ? 'neg' : ''}">${trend}</b></div><div class="card"><small>RSI (14, ${tfLabel(S.tf)})</small><b>${r == null ? '–' : r.toFixed(1)}</b></div>
<div class="card"><small>Buyers now (45s)</small><b class="pos">${buy}%</b></div><div class="card"><small>Sellers now (45s)</small><b class="neg">${100 - buy}%</b></div></div>
<h4>All assets</h4><table class="t"><thead><tr><th>Asset</th><th class="r">24h</th><th class="r">Buyers</th></tr></thead><tbody>${S.symbols.map((x, i) => `<tr><td><b>${x.short}</b></td><td class="r ${S.tickers[i] && S.tickers[i].change >= 0 ? 'pos' : 'neg'}">${S.tickers[i] ? (S.tickers[i].change >= 0 ? '+' : '') + S.tickers[i].change.toFixed(2) + '%' : '–'}</td><td class="r">${S.sent[i] ?? 50}%</td></tr>`).join('')}</tbody></table>
<div class="note" style="margin-top:14px">Indicators describe what price has just done. They do not predict the next few seconds - treat them as context, not a signal.</div>`,
    };
  },
  help() {
    return {
      title: 'Help',
      html: `<h4>How Tradezz works</h4><div class="note">Pick an asset, set a <b>time</b> and an <b>amount</b>, then press <b>BUY</b> if you think the price will be <b>higher</b> when the timer ends, or <b>SELL</b> if <b>lower</b>. Right = you earn the payout (e.g. +92%). Wrong = you lose the amount. Exactly equal = stake back.</div>
<h4>Real prices, fake money</h4><div class="note">Prices stream live from Binance's public market data. The money is a demo balance on your computer - top it up or reset it any time in <b>Finance</b>.</div>
<h4>Let Claude trade</h4><div class="note">Open <b>Claude</b> in the left menu, add your Anthropic API key, choose Haiku or Sonnet, and switch it on. Claude reads the live candles and indicators, decides call / put / skip for every asset, and the platform executes it. Check <b>Leaderboard</b> to see if it beats you.</div>
<h4>Claude Code mode</h4><div class="note">A Claude Code session can trade too, with no API key: it reads <span class="kbd">GET /api/snapshot</span> and places trades with <span class="kbd">POST /api/trade</span>. See <b>CLAUDE.md</b> in the project folder.</div>`,
    };
  },
  claude() {
    const A = S.agent;
    if (!A) return { title: 'Claude trader', html: '<div class="empty"><span class="spin"></span></div>' };
    const st = A.settings;
    const model = A.models.find((m) => m.id === st.model) || A.models[0];
    const cs = (S.stats || {}).claude;
    const statusText = { off: 'Off', idle: 'On - waiting for the next round', thinking: 'Analysing the market…', error: 'Last round failed', nokey: 'Needs an API key' }[A.status] || A.status;
    const sel = (key, opts, val) => `<select class="select" data-cfg="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const avg = A.totals.cycles ? A.totals.cost / A.totals.cycles : 0;
    return {
      title: 'Claude trader',
      html: `<div class="card" style="margin-bottom:12px"><div class="row sp"><div><small style="margin:0">Status</small><b style="font-size:17px">${A.status === 'thinking' ? '<span class="spin"></span> ' : ''}${statusText}</b>${A.status === 'idle' ? `<div class="mut" id="cNext" style="font-size:12.5px;margin-top:3px"></div>` : ''}</div>
<button class="switch ${st.enabled ? 'on' : ''}" data-act="agentToggle" title="Turn Claude trading on or off"></button></div></div>
${A.lastError ? `<div class="note err" style="margin-bottom:12px">${esc(A.lastError)}</div>` : ''}
${!A.keySet ? `<div class="note warn" style="margin-bottom:12px"><b>Add your Anthropic API key</b> so Claude can run. It is saved only in a local <span class="kbd">.env</span> file on this computer and sent only to Anthropic.<div class="row" style="margin-top:10px"><input class="input" id="keyIn" type="password" placeholder="sk-ant-..." autocomplete="off"><button class="btn primary" data-act="saveKey">Save</button></div></div>` : ''}
<div class="row" style="gap:10px;margin-bottom:6px"><button class="btn primary" style="flex:1" data-act="agentRun" ${A.status === 'thinking' ? 'disabled' : ''}>${icon('play', 14)} Analyse &amp; trade now</button></div>
<h4>Results</h4><div class="cards">${statCard('Claude P/L', cs)}<div class="card"><small>API cost so far</small><b>$${A.totals.cost.toFixed(3)}</b><div class="mut" style="margin-top:5px;font-size:12.5px">${A.totals.cycles} rounds · ~$${avg.toFixed(4)}/round</div></div></div>
<h4>Settings</h4>
<label class="fl">Model</label>${sel('model', A.models.map((m) => [m.id, `${m.label} · $${m.in}/$${m.out} per M tokens`]), st.model)}
<label class="fl">Trading style</label>${sel('risk', [['conservative', 'Conservative - rare, A-grade setups only'], ['balanced', 'Balanced'], ['aggressive', 'Active - trades more often']], st.risk || 'balanced')}
<label class="fl">Analyse every</label>${sel('intervalSec', [[30, '30 seconds'], [60, '1 minute'], [90, '90 seconds'], [120, '2 minutes'], [180, '3 minutes'], [300, '5 minutes']], st.intervalSec)}
<label class="fl">Thinking effort</label>${sel('effort', [['low', 'Low - fastest'], ['medium', 'Medium'], ['high', 'High - slowest']], st.effort)}
<div class="row" style="gap:10px"><div style="flex:1"><label class="fl">Max open trades</label>${sel('maxOpen', [1, 2, 3, 4, 5].map((n) => [n, n]), st.maxOpen)}</div><div style="flex:1"><label class="fl">Max stake</label>${sel('maxStakePct', [[1, '1% of balance'], [2, '2%'], [3, '3%'], [5, '5%']], st.maxStakePct)}</div></div>
<div class="note" style="margin-top:12px">${model.label}: roughly $${(model.in * 0.012 + model.out * 0.002).toFixed(4)} per round (≈ ${Math.round(3600 / st.intervalSec)} rounds/hour).</div>
<h4>What Claude decided</h4>${S.agentLog.length ? S.agentLog.slice(0, 15).map(logEntry).join('') : '<div class="empty">No rounds yet. Turn Claude on or press "Analyse &amp; trade now".</div>'}`,
    };
  },
};

function logEntry(e) {
  const trades = e.decisions.filter((d) => d.action !== 'skip');
  const skips = e.decisions.filter((d) => d.action === 'skip');
  const dec = (d) => {
    const s = symOf(d.symbol);
    const t = d.tradeId ? S.recent.find((x) => x.id === d.tradeId) : null;
    let res = '';
    if (d.error) res = `<span class="neg">not placed: ${esc(d.error)}</span>`;
    else if (t) res = t.status === 'open' ? '<span class="mut">running…</span>' : t.status === 'won' ? `<span class="pos">WIN ${signed(t.profit)}</span>` : t.status === 'lost' ? `<span class="neg">LOSS ${signed(t.profit)}</span>` : '<span class="mut">draw</span>';
    return `<div class="dec"><div class="dh"><b>${s ? s.short : d.symbol}</b> ${dirTag(d.action === 'call' ? 'buy' : 'sell')}<div style="font-size:12px;margin-top:3px;color:#c9a4ff">✦ ${esc(d.strategy || '')}</div><div class="mut" style="font-size:12px;margin-top:3px">${d.stake ? '$' + fmt(d.stake) + ' · ' : ''}${d.duration}s · ${d.confidence}%</div><div style="margin-top:3px;font-size:12.5px">${res}</div></div><div class="dr">${esc(d.reasoning)}</div></div>`;
  };
  return `<div class="clog"><div class="ch"><span>${clockStr(e.time)} · ${esc((e.model || '').replace('claude-', ''))}</span><span>${(e.ms / 1000).toFixed(1)}s · $${(e.cost || 0).toFixed(4)}</span></div>
${e.error ? `<div class="note err">${esc(e.error)}</div>` : `<div class="mv">${esc(e.marketView)}</div>${trades.map(dec).join('')}${skips.length ? `<div class="dec"><div class="dh"><span class="tag">SKIP</span> <b>${skips.map((d) => symOf(d.symbol)?.short).join(', ')}</b></div><div class="dr">${skips.map((d) => `<b>${symOf(d.symbol)?.short}</b>: ${esc(d.reasoning)}`).join('<br>')}</div></div>` : ''}`}</div>`;
}

function renderSheet() {
  const name = S.sheet;
  if (!name || !SHEETS[name]) return;
  const sh = $('#sheet');
  const body = $('.body', sh);
  const scroll = body ? body.scrollTop : 0;
  const keyVal = $('#keyIn') ? $('#keyIn').value : '';
  const keyFocus = document.activeElement && document.activeElement.id === 'keyIn';
  const r = SHEETS[name]();
  sh.classList.remove('hidden');
  sh.innerHTML = `<header><span>${r.title}</span><button data-act="close">${icon('close')}</button></header><div class="body">${r.html}</div>`;
  const nb = $('.body', sh);
  nb.scrollTop = scroll;
  if ($('#keyIn') && keyVal) { $('#keyIn').value = keyVal; if (keyFocus) $('#keyIn').focus(); }
  updateCNext();
}

function updateCNext() {
  const el = $('#cNext');
  if (!el || !S.agent) return;
  const s = Math.max(0, Math.round((S.agent.nextRunAt - Date.now()) / 1000));
  el.textContent = S.agent.nextRunAt ? `Next analysis in ${Math.floor(s / 60)}:${pad2(s % 60)}` : '';
}

async function loadAgent() {
  try {
    const r = await api('/api/agent');
    adoptAgent(r.state);
    S.agentLog = r.log;
    if (S.sheet === 'claude') renderSheet();
    updateClaudePill();
  } catch { /* ignore */ }
}

function updateClaudePill() {
  const A = S.agent;
  const pill = $('#claudePill');
  if (!A) return;
  pill.classList.remove('on', 'think', 'err');
  let t = 'Claude · OFF';
  const cc = A.cc;
  if (cc && cc.active) {
    pill.classList.add(cc.connected ? 'on' : 'think');
    t = cc.connected ? `Claude Code · ${Math.floor(cc.remainingSec / 60)}:${pad2(cc.remainingSec % 60)}` : 'Claude Code · waiting';
  } else if (A.status === 'thinking') { pill.classList.add('think'); t = 'Claude · analysing…'; }
  else if (A.status === 'nokey') { pill.classList.add('err'); t = 'Claude · add API key'; }
  else if (A.status === 'error') { pill.classList.add('err'); t = 'Claude · error'; }
  else if (A.settings.enabled) {
    pill.classList.add('on');
    const s = Math.max(0, Math.round((A.nextRunAt - Date.now()) / 1000));
    t = `Claude · ON · ${Math.floor(s / 60)}:${pad2(s % 60)}`;
  }
  $('#claudePillText').textContent = t;
  const on = A.settings.enabled || A.status === 'thinking';
  $('#claudeBtn').classList.toggle('on', on);
  $('#claudeBtnText').textContent = A.status === 'thinking' ? 'CLAUDE THINKING…' : A.settings.enabled ? 'CLAUDE ON' : 'CLAUDE';
}

// ---- Claude's chart drawings + strategy card ----------------------------
function adoptAgent(st) {
  if (!st) return;
  S.agent = st;
  S.drawings = st.drawings || {};
  syncAi();
  updateClaudePill();
  if (!$('#modal').classList.contains('hidden') && ccPick.tab === 'code') renderClaudeModal();
}

// Claude Code may switch indicators on for the asset you are viewing.
let lastIndStamp = 0;
function applyAiIndicators() {
  const d = cur() && S.drawings[cur().id];
  if (!d || !d.indicators || !d.indicators.length || d.time <= lastIndStamp) return;
  lastIndStamp = d.time;
  S.ind = { sma: false, ema: false, bb: false };
  for (const k of d.indicators) S.ind[k] = true;
  chart.ind = { ...S.ind };
  $('#indBtn').classList.add('act');
}

function syncAi() {
  if (!chart || !cur()) return;
  const d = S.drawings[cur().id];
  chart.setAi(d && Date.now() - d.time < 1500000 ? d : null);
  applyAiIndicators();
  updateAiCard();
}

const AI_KIND_COL = { support: '#3fcf6e', resistance: '#ff5a4a', target: '#6aa5ff', entry: '#ffc24d' };
function updateAiCard() {
  const card = $('#aiCard');
  const d = cur() && S.drawings[cur().id];
  if (!d || Date.now() - d.time > 1500000) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const act = d.action === 'call' ? ['buy', 'CALL'] : d.action === 'put' ? ['sell', 'PUT'] : ['', 'SKIP'];
  const kinds = [...new Set(d.levels.map((l) => l.kind))];
  card.innerHTML = `<div class="ah" data-ai="toggle"><span class="aspark">✦</span><b>Claude</b><span class="ast">${esc(d.strategy || 'Analysis')}</span><button class="ax" data-ai="toggle">${S.aiCollapsed ? '+' : '–'}</button></div>` +
    (S.aiCollapsed ? '' : `<div class="ab"><span class="tag ${act[0]}">${act[1]}${d.action !== 'skip' ? ` · ${d.duration}s · ${d.confidence}%` : ''}</span><div>${esc(d.reasoning)}</div>` +
      `<div class="lg">${kinds.map((k) => `<span><i style="background:${AI_KIND_COL[k]}"></i>${k}</span>`).join('')}${d.lines.length ? '<span><i style="background:#c9a4ff"></i>trendline</span>' : ''}</div></div>`);
}

// ---- Claude Trade window (pick model -> start) ---------------------------
const MODEL_INFO = {
  'claude-haiku-5-5': ['Haiku 5.5', 'Fastest and cheapest. Ideal for testing.', '≈ $0.002 / round'],
  'claude-sonnet-5-5': ['Sonnet 5.5', 'Sharper analysis at a balanced cost.', '≈ $0.04 / round'],
  'claude-opus-5-5': ['Opus 5.5', 'Deepest reasoning. Highest cost.', '≈ $0.09 / round'],
};
const STYLE_INFO = {
  conservative: 'Only A-grade setups with 3+ confirmations and 66%+ confidence. Trades rarely, 1% max stake.',
  balanced: 'B+ setups or better with 2+ confirmations and 60%+ confidence. 2% max stake.',
  aggressive: 'Any setup with a clear reason and 55%+ confidence. Trades more often, 3% max stake.',
};
let cm = { model: 'claude-haiku-5-5', risk: 'balanced', interval: 60 };

function openClaudeModal() {
  const A = S.agent;
  if (!A) return;
  cm = { model: A.settings.model, risk: A.settings.risk || 'balanced', interval: A.settings.intervalSec };
  renderClaudeModal();
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }

const CC_MODELS = [['haiku', 'Haiku 5.5', 'Fast and light'], ['sonnet', 'Sonnet 5.5', 'Balanced'], ['opus', 'Opus 5.5', 'Deepest reasoning']];
const CC_TIMES = [[15, '15 min'], [30, '30 min'], [60, '1 hour'], [120, '2 hours']];
const CC_BUDGETS = [100, 500, 1000, 2500, 5000];
const CC_PROMPT = 'Take over my Tradezz session now. Read CLAUDE.md, then run the Claude Code trading loop until the session ends.';
let ccPick = { tab: 'code', model: 'sonnet', minutes: 30, budget: 500 };

function ccBody() {
  const c = S.agent.cc || {};
  if (c.active) {
    const m = Math.floor(c.remainingSec / 60), s = c.remainingSec % 60;
    const pnl = `<span class="${c.pnl >= 0 ? 'pos' : 'neg'}">${c.pnl >= 0 ? '+' : '-'}$${fmt(Math.abs(c.pnl), 2)}</span>`;
    return `<div class="ccstat ${c.connected ? 'live' : 'wait'}"><span class="cdot"></span>${c.connected ? 'Claude Code is connected and trading' : 'Waiting for Claude Code to connect…'}</div>
<div class="cards" style="margin-top:12px"><div class="card"><small>Time left</small><b>${m}:${pad2(s)}</b></div><div class="card"><small>Bankroll left</small><b>$${fmt(c.left, 2)}</b></div><div class="card"><small>Session P/L</small><b>${pnl}</b></div><div class="card"><small>Trades · W/L</small><b>${c.trades} · ${c.wins}/${c.losses}</b></div></div>
${c.connected ? '' : `<h5>Paste this into your Claude Code terminal</h5><div class="ccprompt" id="ccPrompt">${esc(CC_PROMPT)}</div><button class="btn block" style="margin-top:8px" data-mact="copy">Copy prompt</button>`}
<button class="btn danger block big" data-mact="ccstop">Stop session</button>`;
  }
  const ended = c.endedReason ? `<div class="note" style="margin-bottom:12px">Last session ended: ${esc(c.endedReason)}. P/L ${c.pnl >= 0 ? '+' : '-'}$${fmt(Math.abs(c.pnl), 2)} over ${c.trades} trades.</div>` : '';
  return `${ended}<h5>Model</h5><div class="mcards">${CC_MODELS.map(([k, n, d]) => `<button class="mcard ${ccPick.model === k ? 'on' : ''}" data-mact="ccmodel" data-v="${k}"><b>${n}</b><span>${d}</span></button>`).join('')}</div>
<div class="mnote">Type <span class="kbd">/model</span> in your Claude Code terminal to match this choice. The label is recorded on every trade.</div>
<h5>Session length</h5><div class="ccin"><input class="input" id="ccMin" type="number" min="5" max="1440" step="1" value="${ccPick.minutes}"><span>minutes</span></div>
<div class="chips">${[15, 30, 60, 120, 240].map((v) => `<button data-mact="cctime" data-v="${v}" class="${ccPick.minutes === v ? 'on' : ''}">${v >= 60 ? v / 60 + 'h' : v + 'm'}</button>`).join('')}</div>
<h5>Money to trade with</h5><div class="ccin"><span>$</span><input class="input" id="ccBud" type="number" min="10" step="10" value="${ccPick.budget}"></div>
<div class="chips">${CC_BUDGETS.map((v) => `<button data-mact="ccbudget" data-v="${v}" class="${ccPick.budget === v ? 'on' : ''}">$${v}</button>`).join('')}</div>
<div class="mnote">Claude Code can never stake more than this bankroll. It stops when time is up or the money is gone.</div>
<button class="btn green block big" data-mact="ccstart">${icon('play', 14)} Start Claude Code session</button>`;
}

function renderClaudeModal() {
  const A = S.agent;
  const running = A.settings.enabled;
  const keyIn = $('#mKey') ? $('#mKey').value : '';
  const tabs = `<div class="seg" style="margin:14px 0 4px"><button data-mact="tab" data-v="code" class="${ccPick.tab === 'code' ? 'on' : ''}">Claude Code (no key)</button><button data-mact="tab" data-v="api" class="${ccPick.tab === 'api' ? 'on' : ''}">API key</button></div>`;
  if (ccPick.tab === 'code') {
    $('#modal').innerHTML = `<div class="mbox"><button class="mclose" data-mact="close">${icon('close')}</button>
<div class="mhead"><div class="mlogo">${icon('claude')}</div><div><h3>Claude Code</h3><p>Your own Claude Code terminal takes over: it studies the 5 markets, draws levels and indicators on the chart and places the trades.</p></div></div>${tabs}${ccBody()}
<div class="mfoot">Demo money only · live prices · runs on localhost</div></div>`;
    return;
  }
  $('#modal').innerHTML = `<div class="mbox"><button class="mclose" data-mact="close">${icon('close')}</button>
<div class="mhead"><div class="mlogo">${icon('claude')}</div><div><h3>Claude (API key)</h3><p>Pick a model. Claude studies all 5 markets, draws its strategy on your chart, then places demo trades like a professional.</p></div></div>${tabs}
<h5>Model</h5><div class="mcards">${A.models.map((m) => { const i = MODEL_INFO[m.id] || [m.label, '', '']; return `<button class="mcard ${cm.model === m.id ? 'on' : ''}" data-mact="model" data-v="${m.id}"><b>${i[0]}</b><span>${i[1]}</span><em>${i[2]}</em></button>`; }).join('')}</div>
<h5>Trading style</h5><div class="seg">${['conservative', 'balanced', 'aggressive'].map((k) => `<button data-mact="risk" data-v="${k}" class="${cm.risk === k ? 'on' : ''}">${k === 'aggressive' ? 'Active' : k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
<div class="mnote">${STYLE_INFO[cm.risk]}</div>
<h5>Analyse every</h5><select class="select" id="mInterval">${[[30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes']].map(([v, l]) => `<option value="${v}" ${Number(cm.interval) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
${!A.keySet ? `<h5>Anthropic API key</h5><input class="input" id="mKey" type="password" placeholder="sk-ant-..." autocomplete="off" value="${esc(keyIn)}"><div class="mnote">Saved only in a local <span class="kbd">.env</span> file on this computer. Needed once.</div>` : ''}
${running ? `<div class="note" style="margin-top:18px"><b>Claude is trading now</b> with ${esc((MODEL_INFO[A.settings.model] || [A.settings.model])[0])}. Change the options above and press Apply, or stop it.</div>
<div class="row" style="gap:10px;margin-top:12px"><button class="btn primary" style="flex:1" data-mact="apply">Apply changes</button><button class="btn danger" style="flex:1" data-mact="stop">Stop Claude</button></div>`
  : `<button class="btn green block big" data-mact="start">${icon('play', 16)} Start Claude Trade</button>`}
<div class="mfoot">Demo money only · prices are real and live · Claude's analysis is drawn on the chart</div></div>`;
}

async function claudeStart(applyOnly = false) {
  try {
    const kin = $('#mKey');
    if (kin && kin.value.trim()) { const r = await api('/api/agent/key', { key: kin.value.trim() }); adoptAgent(r.state); }
    if (!S.agent.keySet) { toast('err', 'Add your Anthropic API key first'); return; }
    const r = await api('/api/agent/config', { model: cm.model, risk: cm.risk, intervalSec: Number($('#mInterval').value), ...(applyOnly ? {} : { enabled: true }) });
    adoptAgent(r.state);
    closeModal();
    toast('info', applyOnly ? 'Claude settings updated' : 'Claude is on', applyOnly ? '' : 'Analysing the markets and drawing its strategy…', 4500);
  } catch (e) { toast('err', 'Could not start Claude', e.message); }
}

$('#modal').addEventListener('click', async (e) => {
  if (e.target === $('#modal')) { closeModal(); return; }
  const el = e.target.closest('[data-mact]');
  if (!el) return;
  const a = el.dataset.mact;
  if (a === 'close') closeModal();
  else if (a === 'tab') { ccPick.tab = el.dataset.v; renderClaudeModal(); }
  else if (a === 'ccmodel') { ccPick.model = el.dataset.v; renderClaudeModal(); }
  else if (a === 'cctime') { ccPick.minutes = Number(el.dataset.v); renderClaudeModal(); }
  else if (a === 'ccbudget') { ccPick.budget = Number(el.dataset.v); renderClaudeModal(); }
  else if (a === 'copy') { try { await navigator.clipboard.writeText(CC_PROMPT); toast('info', 'Prompt copied', 'Paste it into Claude Code'); } catch { toast('err', 'Copy failed', 'Select the text and copy it'); } }
  else if (a === 'ccstart') {
    try { const mi = $('#ccMin'), bu = $('#ccBud'); if (mi) ccPick.minutes = Number(mi.value); if (bu) ccPick.budget = Number(bu.value); if (!(ccPick.minutes >= 5)) throw new Error('Session length must be at least 5 minutes'); if (!(ccPick.budget >= 10)) throw new Error('Money must be at least $10'); await api('/api/cc/start', { model: ccPick.model, minutes: ccPick.minutes, budget: ccPick.budget }); renderClaudeModal(); } catch (er) { toast('err', 'Could not start', er.message); }
  }
  else if (a === 'ccstop') { try { await api('/api/cc/stop', {}); renderClaudeModal(); } catch (er) { toast('err', er.message); } }
  else if (a === 'model') { cm.model = el.dataset.v; renderClaudeModal(); }
  else if (a === 'risk') { cm.risk = el.dataset.v; renderClaudeModal(); }
  else if (a === 'start') claudeStart(false);
  else if (a === 'apply') claudeStart(true);
  else if (a === 'stop') { try { const r = await api('/api/agent/config', { enabled: false }); adoptAgent(r.state); closeModal(); toast('info', 'Claude stopped'); } catch (er) { toast('err', er.message); } }
});
$('#modal').addEventListener('change', (e) => { if (e.target.id === 'mInterval') cm.interval = Number(e.target.value); });
$('#modal').addEventListener('input', (e) => { if (e.target.id === 'ccMin') ccPick.minutes = Number(e.target.value); if (e.target.id === 'ccBud') ccPick.budget = Number(e.target.value); });
$('#aiCard').addEventListener('click', (e) => { if (e.target.closest('[data-ai]')) { S.aiCollapsed = !S.aiCollapsed; updateAiCard(); } });

async function agentCfg(patch) {
  try {
    const r = await api('/api/agent/config', patch);
    adoptAgent(r.state);
    renderSheet();
    updateClaudePill();
  } catch (e) { toast('err', 'Could not update Claude', e.message); }
}

// sheet click / change delegation
$('#sheet').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const v = el.dataset.v;
  if (act === 'close') closeSheet();
  else if (act === 'ttab') { S.tradeTab = v; renderSheet(); }
  else if (act === 'sound') { S.soundOn = !S.soundOn; ls.set('sound', S.soundOn ? '1' : '0'); renderSheet(); }
  else if (act === 'trade') { closeSheet(); selectSymbol(Number(v)); }
  else if (act === 'topup') { try { await api('/api/topup', { amount: Number(v) }); toast('info', `+$${fmt(Number(v), 0)} added`, 'Demo money'); } catch (er) { toast('err', er.message); } }
  else if (act === 'reset') {
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = 'Click again to confirm reset'; setTimeout(() => { if (el.isConnected) { el.dataset.armed = '0'; el.innerHTML = 'Reset account &amp; clear all history'; } }, 3500); return; }
    try { await api('/api/reset', {}); toast('info', 'Account reset', 'Balance $10,000'); } catch (er) { toast('err', er.message); }
  }
  else if (act === 'agentToggle') agentCfg({ enabled: !S.agent.settings.enabled });
  else if (act === 'agentRun') { try { await api('/api/agent/run', {}); } catch (er) { toast('err', er.message); } }
  else if (act === 'saveKey') {
    const key = $('#keyIn').value.trim();
    try { const r = await api('/api/agent/key', { key }); adoptAgent(r.state); renderSheet(); toast('info', 'API key saved'); } catch (er) { toast('err', er.message); }
  }
});
$('#sheet').addEventListener('change', (e) => {
  const el = e.target.closest('[data-cfg]');
  if (!el) return;
  const k = el.dataset.cfg;
  agentCfg({ [k]: ['model', 'effort', 'risk'].includes(k) ? el.value : Number(el.value) });
});

// ======================================================================
// live connection
// ======================================================================
function connect() {
  const es = new EventSource('/events');
  es.addEventListener('t', (e) => {
    const ticks = JSON.parse(e.data);
    for (const [idx, price, ts] of ticks) {
      S.prices[idx] = price;
      sparkTick(idx, price, ts);
      if (idx === S.idx && !S.loading) chart.applyTick(price, ts);
    }
    S.lastTick = Date.now();
  });
  es.addEventListener('s', (e) => { S.sent = JSON.parse(e.data); updateSent(); });
  es.addEventListener('ticker', (e) => { S.tickers = JSON.parse(e.data); });
  es.addEventListener('trade', (e) => upsertTrade(JSON.parse(e.data)));
  es.addEventListener('bal', (e) => setBalance(JSON.parse(e.data)));
  es.addEventListener('reset', () => { S.open = []; S.recent = []; S.stats = null; syncChartTrades(); renderOpenMini(); refreshStats(); if (S.sheet) renderSheet(); });
  es.addEventListener('agent', (e) => {
    const d = JSON.parse(e.data);
    adoptAgent(d.state);
    if (d.entry) {
      S.agentLog.unshift(d.entry);
      S.agentLog = S.agentLog.slice(0, 80);
      if (S.sheet !== 'claude') { S.unseenClaude++; setBadge('#badgeClaude', S.unseenClaude); }
      if (d.entry.error) toast('err', 'Claude had a problem', d.entry.error, 6000);
      else {
        const n = d.entry.decisions.filter((x) => x.tradeId).length;
        toast('info', n ? `Claude placed ${n} trade${n > 1 ? 's' : ''}` : 'Claude passed this round', d.entry.marketView.slice(0, 110), 5200);
      }
    }
    updateClaudePill();
    if (S.sheet === 'claude') renderSheet();
  });
  es.onopen = () => {
    if (S.sseDown) { S.sseDown = false; resync(); }
    refreshLive();
  };
  es.onerror = () => { S.sseDown = true; refreshLive(); };
}

async function resync() {
  try {
    const init = await api('/api/init');
    S.open = init.openTrades;
    S.recent = init.recent;
    adoptAgent(init.agent);
    setBalance(init.balance, false);
    syncChartTrades();
    renderOpenMini();
    loadSpark();
    await loadCandles();
  } catch { /* next reconnect */ }
}

function refreshLive() {
  const stale = S.lastTick && Date.now() - S.lastTick > 15000;
  const down = S.sseDown || stale;
  $('#offline').classList.toggle('hidden', !down);
  const tag = $('#liveTag');
  tag.textContent = down ? 'Offline' : 'Live';
  tag.classList.toggle('off', down);
  $('#buyBtn').disabled = $('#sellBtn').disabled = false;
}

// ======================================================================
// periodic UI (clock, countdowns)
// ======================================================================
function tzLabel() {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? ':' + pad2(a % 60) : ''}`;
}
function tickUI() {
  const now = Date.now();
  $('#clock').textContent = `${clockStr(now)} ${tzLabel()}`;
  $$('[data-exp]').forEach((el) => {
    const left = Math.max(0, Math.ceil((Number(el.dataset.exp) - now) / 1000));
    const txt = fmtDur(left).replace(/^00:/, '');
    const t = el.querySelector('.mt');
    if (t) t.textContent = txt; else if (!el.classList.contains('mini')) el.textContent = txt;
  });
  updateClaudePill();
  updateCNext();
  refreshLive();
  if (now - (tickUI.lastDraw || 0) > 700) { tickUI.lastDraw = now; drawSparks(); }
}

// ======================================================================
// wiring
// ======================================================================
function wire() {
  // chart view state
  chart.onViewChange = (v) => {
    $('#snapBtn').classList.toggle('hidden', v.follow);
    $('#autoBtn').classList.toggle('on', v.auto);
  };
  chart.onHlines = () => {};
  chart.type = S.type;
  chart.ind = { ...S.ind };
  $('#indBtn').classList.toggle('act', Object.values(S.ind).some(Boolean));
  if (ls.get('dim') === '1') document.body.classList.add('dim');

  $('#snapBtn').onclick = () => { chart.follow = true; chart.notify(); };
  $('#autoBtn').onclick = () => chart.setAuto(!chart.auto);

  // toolbar
  $('#assetBtn').onclick = (e) => { e.stopPropagation(); assetPopup($('#assetBtn')); };
  $('#tfBtn').onclick = (e) => { e.stopPropagation(); tfPopup($('#tfBtn'), false); };
  $('#tfBottom').onclick = (e) => { e.stopPropagation(); tfPopup($('#tfBottom'), true); };
  $('#indBtn').onclick = (e) => { e.stopPropagation(); indPopup($('#indBtn')); };
  $('#drawBtn').onclick = (e) => { e.stopPropagation(); drawPopup($('#drawBtn')); };
  $('#moreBtn').onclick = (e) => { e.stopPropagation(); morePopup($('#moreBtn')); };
  $('#gearBtn').onclick = (e) => { e.stopPropagation(); morePopup($('#gearBtn')); };
  $('#popup').addEventListener('click', (e) => { const el = e.target.closest('[data-pa]'); if (el) { e.stopPropagation(); onPopupAction(el); } });

  // strip
  $('#tabs').addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) {
      e.stopPropagation();
      const i = Number(close.dataset.close);
      if (S.tabs.length <= 1) return;
      S.tabs = S.tabs.filter((x) => x !== i);
      if (S.idx === i) selectSymbol(S.tabs[0]); else { ls.set('tabs', JSON.stringify(S.tabs)); buildTabs(); }
      return;
    }
    if (e.target.closest('#tabAdd')) {
      const hidden = S.symbols.map((s, i) => i).filter((i) => !S.tabs.includes(i));
      const anchor = $('#tabAdd');
      const pop = $('#popup');
      pop.innerHTML = `<h6>Add asset</h6>` + hidden.map((i) => `<button class="assetrow" data-pa="asset" data-v="${i}">${coinHtml(S.symbols[i])}<span><div class="nm">${S.symbols[i].pair}</div></span><span class="po">+${S.symbols[i].payout}%</span></button>`).join('');
      pop.classList.remove('hidden');
      const w = $('#chartwrap').getBoundingClientRect();
      const a = anchor.getBoundingClientRect();
      pop.style.left = clamp(a.left - w.left, 8, w.width - 220) + 'px';
      pop.style.top = '8px';
      pop.style.bottom = 'auto';
      popAnchor = anchor;
      e.stopPropagation();
      return;
    }
    const tab = e.target.closest('.tab');
    if (tab) selectSymbol(Number(tab.dataset.i));
  });
  $('#stripL').onclick = () => $('#tabs').scrollBy({ left: -240, behavior: 'smooth' });
  $('#stripR').onclick = () => $('#tabs').scrollBy({ left: 240, behavior: 'smooth' });

  // panel fields
  const ti = $('#timeInput');
  ti.value = fmtDur(S.duration);
  ti.addEventListener('focus', () => ti.select());
  ti.addEventListener('blur', () => { const v = parseDur(ti.value); setDuration(v == null ? S.duration : v); });
  ti.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ti.blur();
    else if (e.key === 'ArrowUp') { e.preventDefault(); stepDur(1); } else if (e.key === 'ArrowDown') { e.preventDefault(); stepDur(-1); }
  });
  ti.addEventListener('wheel', (e) => { e.preventDefault(); stepDur(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  $('#timeBtn').onclick = (e) => { e.stopPropagation(); const open = !$('#timePop').classList.contains('hidden'); closeFieldPops(); hideAcc(); if (!open) { buildPops(); $('#timePop').classList.remove('hidden'); } };
  $('#timePop').addEventListener('click', (e) => { const b = e.target.closest('[data-dur]'); if (b) { setDuration(Number(b.dataset.dur)); closeFieldPops(); } });

  const ai = $('#amtInput');
  setAmount(S.amount);
  ai.addEventListener('focus', () => { ai.value = String(S.amount); ai.select(); });
  ai.addEventListener('input', () => { const v = parseFloat(ai.value.replace(/,/g, '')); if (Number.isFinite(v)) { S.amount = v; updatePayout(); } });
  ai.addEventListener('blur', () => { const v = parseFloat(ai.value.replace(/,/g, '')); setAmount(Number.isFinite(v) ? v : S.amount); });
  ai.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ai.blur();
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAmount(S.amount + (S.amount >= 100 ? 10 : 1)); ai.value = String(S.amount); } else if (e.key === 'ArrowDown') { e.preventDefault(); setAmount(S.amount - (S.amount > 100 ? 10 : 1)); ai.value = String(S.amount); }
  });
  $('#amtBtn').onclick = (e) => { e.stopPropagation(); const open = !$('#amtPop').classList.contains('hidden'); closeFieldPops(); hideAcc(); if (!open) { buildPops(); $('#amtPop').classList.remove('hidden'); } };
  $('#amtPop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-amt]');
    if (!b) return;
    const v = b.dataset.amt;
    setAmount(v === 'half' ? S.amount / 2 : v === 'x2' ? S.amount * 2 : v === 'max' ? Math.floor(S.balance * 100) / 100 : Number(v));
    closeFieldPops();
  });
  $('#buyBtn').onclick = () => place('buy');
  $('#sellBtn').onclick = () => place('sell');

  // header
  const accMenu = $('#accMenu');
  const hideAcc = () => accMenu.classList.add('hidden');
  $('#account').onclick = (e) => {
    e.stopPropagation();
    if (!accMenu.classList.contains('hidden')) { hideAcc(); return; }
    closeFieldPops();
    accMenu.innerHTML = `<button class="mi" data-m="none"><span>Demo account</span><small>${money(S.balance)} ✓</small></button><div class="sep"></div><button class="mi" data-m="topup"><span>Top up $10,000</span></button><button class="mi" data-m="finance"><span>Finance &amp; reset…</span></button>`;
    accMenu.classList.remove('hidden');
  };
  accMenu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    e.stopPropagation();
    hideAcc();
    if (b.dataset.m === 'topup') { try { await api('/api/topup', { amount: 10000 }); toast('info', '+$10,000 added', 'Demo money'); } catch (er) { toast('err', er.message); } }
    if (b.dataset.m === 'finance') openSheet('finance');
  });
  $('#topUpBtn').onclick = () => openSheet('finance');
  $('#avatarBtn').onclick = () => openSheet('profile');
  $('#claudePill').onclick = () => openSheet('claude');
  $('#claudeBtn').onclick = openClaudeModal;
  $('#dimBtn').onclick = () => { document.body.classList.toggle('dim'); ls.set('dim', document.body.classList.contains('dim') ? '1' : '0'); };
  $('#favBtn').onclick = () => { ls.set('fav', S.idx); $('#favBtn').classList.add('on'); toast('info', `${cur().pair} is now your start asset`); };

  // side navs
  $$('.nav[data-nav]').forEach((b) => (b.onclick = () => openSheet(b.dataset.nav)));
  $$('.nav[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === 'trading'));
  $('#fullBtn').onclick = toggleFull;

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#popup')) hidePopup();
    if (!e.target.closest('.field')) closeFieldPops();
    if (!e.target.closest('#account')) hideAcc();
  });
  document.addEventListener('fullscreenchange', () => {
    const f = !!document.fullscreenElement;
    $('#fullBtn').innerHTML = `${icon(f ? 'exitfull' : 'fullscreen')}<span>${f ? 'Exit' : 'Full screen'}</span>`;
    $('#fullBtn i, #fullBtn svg'); // no-op keep layout
  });

  // hotkeys
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    if (e.key === 'Escape') { hidePopup(); closeFieldPops(); closeModal(); closeSheet(); chart.tool = null; return; }
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'w') { e.preventDefault(); place('buy'); }
      else if (k === 's') { e.preventDefault(); place('sell'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setAmount(S.amount * 2); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setAmount(S.amount / 2); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepDur(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepDur(-1); }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[1-5]$/.test(e.key)) { const i = Number(e.key) - 1; if (S.symbols[i]) selectSymbol(i); }
    else if (e.key === ' ') { e.preventDefault(); chart.follow = true; chart.notify(); }
    else if (e.key.toLowerCase() === 'f') toggleFull();
  });
}

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
}

// ======================================================================
// boot
// ======================================================================
async function boot() {
  hydrate();
  setMountainBg();
  let init;
  try {
    init = await api('/api/init');
  } catch (e) {
    document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:0;display:grid;place-items:center;background:#161c2e;color:#fff;font:18px sans-serif">Cannot reach the Tradezz server. Start it with start.bat, then refresh.</div>`);
    return;
  }
  S.symbols = init.symbols;
  S.open = init.openTrades;
  S.recent = init.recent;
  S.stats = init.stats;
  S.tickers = init.tickers;
  S.sent = init.sentiments;
  S.agent = init.agent;
  S.drawings = init.agent.drawings || {};
  S.prices = init.feed.prices;
  const saved = (() => { try { return JSON.parse(ls.get('tabs', 'null')); } catch { return null; } })();
  S.tabs = Array.isArray(saved) && saved.length && saved.every((i) => init.symbols[i]) ? saved : init.symbols.map((_, i) => i);
  const fav = Number(ls.get('fav', -1));
  const startIdx = init.symbols[fav] ? fav : Number(ls.get('sym', 0));
  S.idx = S.tabs.includes(startIdx) ? startIdx : S.tabs[0];
  $('#balance').textContent = fmt(init.balance);
  S.balance = S.shownBalance = init.balance;

  chart = new TradeChart($('#cv'), $('#chartwrap'));
  $('#tfBadge').textContent = tfLabel(S.tf);
  $('#tfLabel').textContent = tfLabel(S.tf);
  wire();
  setDuration(S.duration);
  await Promise.all([selectSymbol(S.idx, true), loadSpark()]);
  renderOpenMini();
  connect();
  updateClaudePill();
  setInterval(tickUI, 250);
  window.__trade = { S, chart, syncAi, openClaudeModal }; // handy for debugging in the console
}
boot();

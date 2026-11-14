// Canvas candlestick chart engine for Tradezz.
// - 60fps requestAnimationFrame loop: the chart scrolls continuously with real time,
//   the last candle and the price axis ease smoothly (no jumps).
// - Candles / Heikin-Ashi / Line / Area, SMA / EMA / Bollinger, horizontal lines.
// - Draws open-trade markers, the expiration line, price tag, crosshair, high/low tags.

const pad2 = (n) => String(n).padStart(2, '0');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function fmtClock(sec, withSeconds = true) {
  const d = new Date(sec * 1000);
  return withSeconds ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const C = {
  grid: 'rgba(255,255,255,0.055)',
  axis: '#8a94ad',
  up: '#34b73c',
  down: '#fb3b24',
  priceLine: 'rgba(92,134,214,0.85)',
  priceTag: '#3d65ad',
  cross: 'rgba(170,180,205,0.55)',
  crossTag: '#4b5470',
  exp: 'rgba(138,158,205,0.65)',
  hint: 'rgba(160,170,196,0.78)',
};

const AI_COLORS = { support: '#3fcf6e', resistance: '#ff5a4a', target: '#6aa5ff', entry: '#ffc24d' };

const TIME_STEPS =[5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400];

function niceStep(range, target) {
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class TradeChart {
  constructor(canvas, wrap) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.wrap = wrap;
    this.W = 0;
    this.H = 0;
    this.dpr = 1;

    this.axisW = 74;
    this.axisH = 30;
    this.topInset = 78;
    this.botInset = 46;

    this.tf = 15;
    this.type = 'candles';
    this.candles = [];
    this.decimals = 2;
    this.spacing = 14;
    this.follow = true;
    this.auto = true;
    this.rightTime = Date.now() / 1000 + 60;
    this.padPx = 0;
    this.min = 0;
    this.max = 1;
    this.rangeInit = false;
    this.dispC = null;
    this.lastPrice = null;
    this.expirySec = 15;
    this.trades = [];
    this.closed = [];
    this.ind = { sma: false, ema: false, bb: false };
    this.hlines = [];
    this.ai = null; // Claude's drawings for the current asset: { time, levels, lines }
    this.tool = null;
    this.mouse = null;
    this.drag = null;
    this.onViewChange = null;
    this.onHlines = null;
    this.timeLabel = 'Expiration time';
    this.last = performance.now();

    this.bind();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(wrap);
    this.resize();
    requestAnimationFrame((t) => this.loop(t));
  }

  // ---- data -------------------------------------------------------------
  setSymbol(decimals) {
    this.decimals = decimals;
  }

  setCandles(arr, tf) {
    this.tf = tf;
    this.candles = arr.map((c) => ({ t: c[0], o: c[1], h: c[2], l: c[3], c: c[4] }));
    const last = this.candles[this.candles.length - 1];
    this.dispC = last ? last.c : null;
    this.lastPrice = last ? last.c : null;
    this.rangeInit = false;
    this.follow = true;
    this.auto = true;
    this.padPx = 0;
    this.notify();
  }

  applyTick(price, tMs) {
    this.lastPrice = price;
    const tf = this.tf;
    const bucket = Math.floor(tMs / 1000 / tf) * tf;
    const cs = this.candles;
    const last = cs[cs.length - 1];
    if (last && last.t === bucket) {
      if (price > last.h) last.h = price;
      if (price < last.l) last.l = price;
      last.c = price;
    } else if (!last || bucket > last.t) {
      const o = last ? last.c : price;
      cs.push({ t: bucket, o, h: Math.max(o, price), l: Math.min(o, price), c: price });
      if (cs.length > 3200) cs.splice(0, cs.length - 3000);
      if (this.dispC == null) this.dispC = o;
    }
    if (this.dispC == null) this.dispC = price;
  }

  notify() {
    if (this.onViewChange) this.onViewChange({ follow: this.follow, auto: this.auto });
  }

  resetView() {
    this.follow = true;
    this.auto = true;
    this.notify();
  }

  setAuto(v) {
    this.auto = v;
    if (v) this.rangeInit = false;
    this.notify();
  }

  // ---- geometry ---------------------------------------------------------
  get plotW() { return this.W - this.axisW; }
  get plotTop() { return this.topInset; }
  get plotBot() { return this.H - this.axisH - this.botInset; }
  get pps() { return this.spacing / this.tf; }
  tx(t) { return this.plotW - (this.rightTime - t) * this.pps; }
  tOf(x) { return this.rightTime - (this.plotW - x) / this.pps; }
  ty(p) { return this.plotTop + ((this.max - p) / (this.max - this.min)) * (this.plotBot - this.plotTop); }
  pOf(y) { return this.max - ((y - this.plotTop) / (this.plotBot - this.plotTop)) * (this.max - this.min); }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.W = Math.max(100, Math.floor(r.width));
    this.H = Math.max(100, Math.floor(r.height));
    this.cv.width = Math.round(this.W * this.dpr);
    this.cv.height = Math.round(this.H * this.dpr);
    this.cv.style.width = this.W + 'px';
    this.cv.style.height = this.H + 'px';
    this.axisW = this.W < 700 ? 62 : 74;
  }

  // ---- interaction ------------------------------------------------------
  bind() {
    const cv = this.cv;
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    cv.addEventListener('pointermove', (e) => {
      const p = pos(e);
      this.mouse = p;
      if (this.drag) {
        const dx = p.x - this.drag.x;
        const dy = p.y - this.drag.y;
        if (Math.abs(p.x - this.drag.sx) + Math.abs(p.y - this.drag.sy) > 3) this.drag.moved = true;
        if (this.drag.axis) {
          // vertical scale from the price axis
          const f = Math.exp(dy * 0.006);
          const mid = (this.drag.min + this.drag.max) / 2;
          const half = ((this.drag.max - this.drag.min) / 2) * f;
          this.min = mid - half;
          this.max = mid + half;
          if (this.auto) { this.auto = false; this.notify(); }
        } else if (this.drag.moved) {
          this.rightTime = this.drag.rt - dx / this.pps;
          if (this.follow) { this.follow = false; this.notify(); }
          if (!this.auto) {
            const per = (this.drag.max - this.drag.min) / (this.plotBot - this.plotTop);
            this.min = this.drag.min + dy * per;
            this.max = this.drag.max + dy * per;
          }
        }
      }
      cv.style.cursor = this.drag && this.drag.moved ? 'grabbing' : p.x > this.plotW ? 'ns-resize' : this.tool ? 'crosshair' : 'default';
    });
    cv.addEventListener('pointerleave', () => { if (!this.drag) this.mouse = null; });
    cv.addEventListener('pointerdown', (e) => {
      const p = pos(e);
      cv.setPointerCapture(e.pointerId);
      this.drag = { x: p.x, y: p.y, sx: p.x, sy: p.y, rt: this.rightTime, min: this.min, max: this.max, axis: p.x > this.plotW, moved: false };
    });
    const up = (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (!d.moved && !d.axis && this.tool === 'hline') {
        const p = pos(e);
        this.hlines.push(this.pOf(p.y));
        this.tool = null;
        if (this.onHlines) this.onHlines(this.hlines);
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', () => { this.drag = null; });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      const f = Math.exp(-e.deltaY * 0.0014);
      const old = this.spacing;
      const ns = clamp(old * f, 3, 60);
      if (ns === old) return;
      if (!this.follow) {
        const tUnder = this.tOf(p.x);
        this.spacing = ns;
        this.rightTime = tUnder + (this.plotW - p.x) / this.pps;
      } else {
        this.spacing = ns;
      }
    }, { passive: false });
    cv.addEventListener('dblclick', () => this.resetView());
  }

  // ---- main loop --------------------------------------------------------
  loop(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    try {
      this.frame(dt);
    } catch (e) {
      console.error('chart frame error', e);
    }
    requestAnimationFrame((t) => this.loop(t));
  }

  frame(dt) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    const cs = this.candles;
    if (!cs.length) {
      ctx.fillStyle = C.hint;
      ctx.font = '600 14px "Noto Sans","Segoe UI",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Loading live market data…', this.plotW / 2, this.H / 2);
      return;
    }

    const nowSec = Date.now() / 1000;
    const tf = this.tf;
    const pps = this.pps;

    // follow the present moment, leaving room on the right for the expiration line
    const wantPad = clamp(this.expirySec * pps + 96, this.plotW * 0.2, this.plotW * 0.64);
    if (!this.padPx) this.padPx = wantPad;
    else this.padPx += (wantPad - this.padPx) * (1 - Math.exp(-dt * 6));
    if (this.follow) this.rightTime = nowSec + this.padPx / pps;

    // ease the live candle close
    const lastC = cs[cs.length - 1];
    if (this.dispC == null) this.dispC = lastC.c;
    this.dispC += (lastC.c - this.dispC) * (1 - Math.exp(-dt * 20));
    if (Math.abs(this.dispC - lastC.c) < (lastC.c || 1) * 1e-9) this.dispC = lastC.c;

    // visible index range
    const tLeft = this.rightTime - this.plotW / pps - tf;
    let lo = 0;
    let hi = cs.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cs[m].t < tLeft) lo = m + 1; else hi = m;
    }
    const i0 = Math.max(0, lo - 1);
    const view = this.type === 'heikin' ? this.heikin() : null;
    const get = (i) => {
      if (view) return view[i];
      return cs[i];
    };
    const closeOf = (i) => (i === cs.length - 1 ? this.dispC : cs[i].c);

    // auto price range
    if (this.auto) {
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = i0; i < cs.length; i++) {
        const c = get(i);
        if (c.t > this.rightTime) break;
        const h = i === cs.length - 1 ? Math.max(c.h, this.dispC) : c.h;
        const l = i === cs.length - 1 ? Math.min(c.l, this.dispC) : c.l;
        if (h > mx) mx = h;
        if (l < mn) mn = l;
      }
      for (const t of this.trades) { mx = Math.max(mx, t.openPrice); mn = Math.min(mn, t.openPrice); }
      if (!isFinite(mn)) { mn = this.dispC * 0.999; mx = this.dispC * 1.001; }
      let span = mx - mn;
      const minSpan = Math.max(this.dispC * 0.00018, Math.pow(10, -this.decimals) * 12);
      if (span < minSpan) { const mid = (mx + mn) / 2; mn = mid - minSpan / 2; mx = mid + minSpan / 2; span = minSpan; }
      const tMin = mn - span * 0.06;
      const tMax = mx + span * 0.06;
      if (!this.rangeInit) { this.min = tMin; this.max = tMax; this.rangeInit = true; }
      else {
        const k = 1 - Math.exp(-dt * 9);
        this.min += (tMin - this.min) * k;
        this.max += (tMax - this.max) * k;
      }
    } else if (!this.rangeInit) {
      this.rangeInit = true;
    }
    if (!(this.max > this.min)) { this.max = this.min + 1e-9; }

    const pw = this.plotW;
    const top = this.plotTop;
    const bot = this.plotBot;
    const fullBot = this.H - this.axisH;

    // ---- grid --------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, pw, fullBot);
    ctx.clip();
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.grid;
    ctx.fillStyle = C.axis;
    const range = this.max - this.min;
    const pStep = niceStep(range, (bot - top) / 64);
    const stepDec = Math.max(0, -Math.floor(Math.log10(pStep) + 1e-9));
    const priceDec = Math.max(this.decimals, Math.min(8, stepDec));
    const gridPrices = [];
    const gStart = Math.ceil(this.min / pStep) * pStep;
    ctx.beginPath();
    for (let p = gStart; p <= this.max + pStep * 0.01; p += pStep) {
      const y = Math.round(this.ty(p)) + 0.5;
      if (y < top - 30 || y > fullBot) continue;
      ctx.moveTo(0, y);
      ctx.lineTo(pw, y);
      gridPrices.push([p, y]);
    }
    // vertical grid / time labels
    const tz = -new Date().getTimezoneOffset() * 60;
    let tStep = TIME_STEPS.find((s) => s * pps >= 92) || 86400;
    const labels = [];
    const tR = this.rightTime;
    for (let t = Math.ceil((tLeft + tz) / tStep) * tStep - tz; t <= tR; t += tStep) {
      const x = Math.round(this.tx(t)) + 0.5;
      if (x < 0 || x > pw) continue;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, fullBot);
      labels.push([t, x]);
    }
    ctx.stroke();
    ctx.restore();

    // ---- series ------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, pw, fullBot);
    ctx.clip();

    if (this.type === 'line' || this.type === 'area') {
      ctx.beginPath();
      let started = false;
      let firstX = 0;
      let lastX = 0;
      for (let i = i0; i < cs.length; i++) {
        const c = cs[i];
        const x = this.tx(c.t + tf / 2);
        if (x > pw + 20) break;
        const y = this.ty(closeOf(i));
        if (!started) { ctx.moveTo(x, y); firstX = x; started = true; } else ctx.lineTo(x, y);
        lastX = x;
      }
      if (this.type === 'area' && started) {
        const g = ctx.createLinearGradient(0, top, 0, bot);
        g.addColorStop(0, 'rgba(61,123,255,0.35)');
        g.addColorStop(1, 'rgba(61,123,255,0.02)');
        ctx.save();
        ctx.lineTo(lastX, fullBot);
        ctx.lineTo(firstX, fullBot);
        ctx.closePath();
        ctx.fillStyle = g;
        ctx.fill();
        ctx.restore();
        // redraw stroke path on top
        ctx.beginPath();
        started = false;
        for (let i = i0; i < cs.length; i++) {
          const c = cs[i];
          const x = this.tx(c.t + tf / 2);
          if (x > pw + 20) break;
          const y = this.ty(closeOf(i));
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = '#4a86ff';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
    } else {
      const bw = Math.max(1, Math.round(this.spacing * 0.66));
      const snap = (v) => Math.round(v * dpr) / dpr;
      for (let i = i0; i < cs.length; i++) {
        const c = get(i);
        const x = snap(this.tx(c.t + tf / 2));
        if (x - bw > pw) break;
        const isLast = i === cs.length - 1;
        const cc = isLast ? (view ? (c.o + c.h + c.l + this.dispC) / 4 : this.dispC) : c.c;
        const h = isLast ? Math.max(c.h, cc) : c.h;
        const l = isLast ? Math.min(c.l, cc) : c.l;
        const up = cc >= c.o;
        ctx.fillStyle = up ? C.up : C.down;
        const yH = this.ty(h);
        const yL = this.ty(l);
        const yO = this.ty(c.o);
        const yC = this.ty(cc);
        const wick = Math.max(1, Math.round(dpr) / dpr);
        ctx.fillRect(x - wick / 2, yH, wick, Math.max(wick, yL - yH));
        const y0 = Math.min(yO, yC);
        ctx.fillRect(x - bw / 2, y0, bw, Math.max(1, Math.abs(yC - yO)));
      }
    }

    this.drawIndicators(ctx, i0, pw);

    // user horizontal lines
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,205,80,0.8)';
    for (const p of this.hlines) {
      const y = Math.round(this.ty(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(pw, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // visible high / low tags (like the broker terminal)
    if (this.type !== 'line' && this.type !== 'area') this.drawExtremes(ctx, i0, get);

    this.drawAi(ctx, nowSec);
    this.drawClosedMarkers(ctx);
    this.drawTrades(ctx, nowSec);
    this.drawExpiry(ctx, nowSec);

    // current price line
    const py = this.ty(this.dispC);
    ctx.strokeStyle = C.priceLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(py) + 0.5);
    ctx.lineTo(pw, Math.round(py) + 0.5);
    ctx.stroke();

    // crosshair
    const m = this.mouse;
    const showCross = m && m.x >= 0 && m.x <= pw && m.y >= 0 && m.y <= fullBot && !(this.drag && this.drag.moved);
    if (showCross) {
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = C.cross;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(m.y) + 0.5);
      ctx.lineTo(pw, Math.round(m.y) + 0.5);
      ctx.moveTo(Math.round(m.x) + 0.5, 0);
      ctx.lineTo(Math.round(m.x) + 0.5, fullBot);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    // ---- axes ----------------------------------------------------------
    ctx.font = '500 12.5px "Noto Sans","Segoe UI",sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.axis;
    ctx.textAlign = 'right';
    for (const [p, y] of gridPrices) {
      if (Math.abs(y - py) < 14) continue;
      ctx.fillText(p.toFixed(priceDec), this.W - 12, y);
    }
    ctx.textAlign = 'center';
    for (const [t, x] of labels) {
      ctx.fillText(fmtClock(t, tStep < 60), x, this.H - this.axisH / 2 + 1);
    }

    // price tag
    this.tag(ctx, this.dispC === null ? '' : this.fmtP(this.lastPrice ?? this.dispC), py, C.priceTag, '#fff', true);
    for (const p of this.hlines) this.tag(ctx, this.fmtP(p), this.ty(p), '#c99a2e', '#1a1a1a', false);
    if (this.ai) {
      const fade = this.aiFade();
      if (fade > 0.2) {
        const t0 = this.ai.shownAt;
        this.ai.levels.forEach((l, i) => {
          if (performance.now() - t0 - i * 220 < 300) return;
          const y = this.ty(l.price);
          if (y < this.plotTop - 10 || y > this.H - this.axisH - 10) return;
          this.tag(ctx, this.fmtP(l.price), y, AI_COLORS[l.kind] || '#8a94ad', '#0e1424', false);
        });
      }
    }
    if (showCross) {
      if (m.x <= pw) this.tag(ctx, this.fmtP(this.pOf(m.y)), m.y, C.crossTag, '#e8ecf6', false);
      const tt = this.tOf(m.x);
      const label = fmtClock(tt, true);
      const w = ctx.measureText(label).width + 16;
      const x = clamp(m.x - w / 2, 0, pw - w + this.axisW * 0.4);
      ctx.fillStyle = C.crossTag;
      roundRect(ctx, x, this.H - this.axisH + 3, w, 22, 5);
      ctx.fill();
      ctx.fillStyle = '#e8ecf6';
      ctx.textAlign = 'center';
      ctx.fillText(label, x + w / 2, this.H - this.axisH / 2 + 3);
    }
  }

  fmtP(p) {
    return p.toFixed(Math.max(this.decimals, Math.min(8, Math.max(0, -Math.floor(Math.log10((this.max - this.min) / 14) + 1e-9)))));
  }

  tag(ctx, text, y, bg, fg, bold) {
    ctx.font = `${bold ? 600 : 500} 12.5px "Noto Sans","Segoe UI",sans-serif`;
    const h = 22;
    const w = this.axisW - 4;
    const yy = clamp(y - h / 2, 0, this.H - this.axisH - h);
    ctx.fillStyle = bg;
    roundRect(ctx, this.plotW - 6, yy, w + 6, h, 5);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, this.plotW + 3 + w / 2, yy + h / 2 + 0.5);
  }

  heikin() {
    const cs = this.candles;
    const ha = new Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      const cl = i === cs.length - 1 ? this.dispC : c.c;
      const hc = (c.o + c.h + c.l + cl) / 4;
      const ho = i ? (ha[i - 1].o + ha[i - 1].c) / 2 : (c.o + cl) / 2;
      ha[i] = { t: c.t, o: ho, c: hc, h: Math.max(c.h, ho, hc), l: Math.min(c.l, ho, hc) };
    }
    return ha;
  }

  drawIndicators(ctx, i0, pw) {
    const cs = this.candles;
    const n = cs.length;
    const tf = this.tf;
    const line = (arr, color, width = 1.6) => {
      ctx.beginPath();
      let on = false;
      for (let i = i0; i < n; i++) {
        const v = arr[i];
        const x = this.tx(cs[i].t + tf / 2);
        if (x > pw + 20) break;
        if (v == null) continue;
        const y = this.ty(v);
        if (!on) { ctx.moveTo(x, y); on = true; } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    const closes = cs.map((c, i) => (i === n - 1 ? this.dispC : c.c));
    const sma = (p) => {
      const out = new Array(n).fill(null);
      let s = 0;
      for (let i = 0; i < n; i++) {
        s += closes[i];
        if (i >= p) s -= closes[i - p];
        if (i >= p - 1) out[i] = s / p;
      }
      return out;
    };
    if (this.ind.sma) line(sma(20), '#ffb020');
    if (this.ind.ema) {
      const k = 2 / 21;
      const out = new Array(n).fill(null);
      let e = null;
      for (let i = 0; i < n; i++) {
        e = e == null ? closes[i] : closes[i] * k + e * (1 - k);
        if (i >= 19) out[i] = e;
      }
      line(out, '#3cc8ff');
    }
    if (this.ind.bb) {
      const m = sma(20);
      const up = new Array(n).fill(null);
      const dn = new Array(n).fill(null);
      for (let i = 19; i < n; i++) {
        let v = 0;
        for (let j = i - 19; j <= i; j++) v += (closes[j] - m[i]) ** 2;
        const sd = Math.sqrt(v / 20);
        up[i] = m[i] + 2 * sd;
        dn[i] = m[i] - 2 * sd;
      }
      ctx.beginPath();
      let started = false;
      const pts = [];
      for (let i = i0; i < n; i++) {
        if (up[i] == null) continue;
        const x = this.tx(cs[i].t + tf / 2);
        if (x > pw + 20) break;
        pts.push([x, this.ty(up[i]), this.ty(dn[i])]);
      }
      if (pts.length > 1) {
        ctx.beginPath();
        pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        for (let k = pts.length - 1; k >= 0; k--) ctx.lineTo(pts[k][0], pts[k][2]);
        ctx.closePath();
        ctx.fillStyle = 'rgba(167,139,250,0.08)';
        ctx.fill();
      }
      line(up, 'rgba(167,139,250,0.9)', 1.2);
      line(dn, 'rgba(167,139,250,0.9)', 1.2);
      line(m, 'rgba(167,139,250,0.5)', 1);
      void started;
    }
  }

  drawExtremes(ctx, i0, get) {
    const cs = this.candles;
    const tf = this.tf;
    let hi = -Infinity;
    let lo = Infinity;
    let hx = 0;
    let lx = 0;
    for (let i = i0; i < cs.length; i++) {
      const c = get(i);
      const x = this.tx(c.t + tf / 2);
      if (x < 0) continue;
      if (x > this.plotW) break;
      if (c.h > hi) { hi = c.h; hx = x; }
      if (c.l < lo) { lo = c.l; lx = x; }
    }
    if (!isFinite(hi)) return;
    ctx.font = '500 12.5px "Noto Sans","Segoe UI",sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const tagAt = (txt, x, y) => {
      const w = ctx.measureText(txt).width + 18;
      const xx = clamp(x - w / 2, 4, this.plotW - w - 4);
      ctx.fillStyle = 'rgba(120,135,170,0.16)';
      roundRect(ctx, xx, y - 11, w, 22, 6);
      ctx.fill();
      ctx.fillStyle = C.hint;
      ctx.fillText(txt, xx + w / 2, y + 0.5);
    };
    const yh = this.ty(hi) - 22;
    const yl = this.ty(lo) + 22;
    if (yh > 56) tagAt(this.fmtP(hi), hx, yh);
    if (yl < this.H - this.axisH - 14 && Math.abs(hi - lo) > 0) tagAt(this.fmtP(lo), lx, Math.min(yl, this.H - this.axisH - 14));
  }

  setAi(d) {
    if (!d) { this.ai = null; return; }
    if (this.ai && this.ai.time === d.time) return; // same analysis - keep the animation state
    this.ai = { time: d.time, levels: d.levels || [], lines: d.lines || [], shownAt: performance.now() };
  }

  aiFade() {
    if (!this.ai) return 0;
    const age = (Date.now() - this.ai.time) / 1000;
    return age > 1200 ? clamp(1 - (age - 1200) / 300, 0, 1) : 1; // fades out between 20 and 25 minutes
  }

  // Claude's strategy drawings: they animate in one by one (like being drawn).
  drawAi(ctx, nowSec) {
    const ai = this.ai;
    if (!ai) return;
    const fade = this.aiFade();
    if (fade <= 0) return;
    const pw = this.plotW;
    const el = performance.now() - ai.shownAt;
    ctx.save();
    ctx.font = '600 12px "Noto Sans","Segoe UI",sans-serif';
    ctx.textBaseline = 'middle';

    ai.levels.forEach((l, i) => {
      const prog = clamp((el - i * 220) / 520, 0, 1);
      if (prog <= 0) return;
      const e = 1 - Math.pow(1 - prog, 3);
      const y = Math.round(this.ty(l.price)) + 0.5;
      if (y < this.plotTop - 10 || y > this.H - this.axisH) return;
      const col = AI_COLORS[l.kind] || '#8a94ad';
      ctx.setLineDash([8, 5]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = col;
      ctx.globalAlpha = fade * 0.9;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(pw * e, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (prog > 0.5) {
        const txt = `✦ ${l.label ? l.label + '  ' : ''}${l.kind}`;
        const w = ctx.measureText(txt).width + 18;
        const x = pw - w - 12;
        const yy = y - 24 < this.plotTop - 8 ? y + 5 : y - 24;
        ctx.globalAlpha = fade * clamp((prog - 0.5) * 2, 0, 1);
        ctx.fillStyle = 'rgba(14,20,36,0.82)';
        roundRect(ctx, x, yy, w, 19, 9.5);
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.textAlign = 'left';
        ctx.fillText(txt, x + 9, yy + 10);
      }
    });

    ai.lines.forEach((ln, i) => {
      const prog = clamp((el - (ai.levels.length + i) * 220 - 100) / 700, 0, 1);
      if (prog <= 0) return;
      const e = 1 - Math.pow(1 - prog, 3);
      const x1 = this.tx(ln.t1);
      const y1 = this.ty(ln.p1);
      const x2 = this.tx(ln.t2);
      const y2 = this.ty(ln.p2);
      const xe = x1 + (x2 - x1) * e;
      const ye = y1 + (y2 - y1) * e;
      ctx.globalAlpha = fade;
      ctx.strokeStyle = '#c9a4ff';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(xe, ye);
      ctx.stroke();
      ctx.fillStyle = '#c9a4ff';
      ctx.beginPath();
      ctx.arc(x1, y1, 3.6, 0, 6.2832);
      ctx.fill();
      if (prog >= 1 && Math.abs(x2 - x1) > 4) {
        const slope = (y2 - y1) / (x2 - x1);
        const xr = Math.min(pw, this.tx(nowSec + this.expirySec));
        if (xr > x2) {
          ctx.setLineDash([4, 5]);
          ctx.globalAlpha = fade * 0.7;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(xr, y2 + slope * (xr - x2));
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.globalAlpha = fade;
        ctx.beginPath();
        ctx.arc(x2, y2, 3.6, 0, 6.2832);
        ctx.fill();
        if (ln.label) {
          ctx.textAlign = 'left';
          ctx.fillStyle = '#d9c2ff';
          ctx.fillText('✦ ' + ln.label, clamp(x2 + 8, 6, pw - 120), y2 - 12);
        }
      }
    });
    ctx.restore();
  }

  drawClosedMarkers(ctx) {
    for (const t of this.closed) {
      const x = this.tx(t.openTime / 1000);
      if (x < -10 || x > this.plotW + 10) continue;
      const y = this.ty(t.openPrice);
      const col = t.status === 'won' ? C.up : t.status === 'lost' ? C.down : '#9aa4bd';
      ctx.fillStyle = 'rgba(15,20,36,0.85)';
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, 6.2832);
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath();
      if (t.dir === 'buy') { ctx.moveTo(x, y - 2.6); ctx.lineTo(x + 2.6, y + 2); ctx.lineTo(x - 2.6, y + 2); } else { ctx.moveTo(x, y + 2.6); ctx.lineTo(x + 2.6, y - 2); ctx.lineTo(x - 2.6, y - 2); }
      ctx.closePath();
      ctx.fill();
    }
  }

  drawTrades(ctx, nowSec) {
    for (const t of this.trades) {
      const x0 = this.tx(t.openTime / 1000);
      const x1 = this.tx(t.expiry / 1000);
      const y = this.ty(t.openPrice);
      const col = t.dir === 'buy' ? C.up : C.down;
      const price = this.dispC;
      const winning = t.dir === 'buy' ? price > t.openPrice : price < t.openPrice;
      const flat = price === t.openPrice;
      // entry -> expiry line
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      // expiry marker line
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(Math.round(x1) + 0.5, 0);
      ctx.lineTo(Math.round(x1) + 0.5, this.H - this.axisH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // countdown pill on the expiry line
      const left = Math.max(0, Math.ceil(t.expiry / 1000 - nowSec));
      const txt = `${pad2(Math.floor(left / 60))}:${pad2(left % 60)}`;
      ctx.font = '600 12px "Noto Sans","Segoe UI",sans-serif';
      const tw = ctx.measureText(txt).width + 14;
      ctx.fillStyle = col;
      roundRect(ctx, x1 - tw / 2, this.plotTop - 14 + (t.id % 3) * 0, tw, 20, 10);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(txt, x1, this.plotTop - 3.5);
      // entry dot
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x0, y, 5.5, 0, 6.2832);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      // live status pill
      const profit = winning ? (t.amount * t.payout) / 100 : flat ? 0 : -t.amount;
      const label = `${t.dir === 'buy' ? '▲' : '▼'} $${t.amount.toFixed(2)}   ${profit >= 0 ? '+' : '-'}$${Math.abs(profit).toFixed(2)}${t.source === 'claude' ? '  · ✦ ' + (t.strategy || 'Claude') : t.source === 'claude-code' ? '  · Code' : ''}`;
      ctx.font = '600 12.5px "Noto Sans","Segoe UI",sans-serif';
      const w = ctx.measureText(label).width + 20;
      const px = clamp(x0 + 12, 6, this.plotW - w - 6);
      const py = y - 30 < this.plotTop - 20 ? y + 10 : y - 30;
      ctx.fillStyle = flat ? '#6b7690' : winning ? 'rgba(40,160,52,0.96)' : 'rgba(228,52,36,0.96)';
      roundRect(ctx, px, py, w, 22, 11);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(label, px + 10, py + 11.5);
    }
  }

  drawExpiry(ctx, nowSec) {
    const exp = nowSec + this.expirySec;
    const x = Math.round(this.tx(exp)) + 0.5;
    if (x < 0 || x > this.plotW) return;
    ctx.strokeStyle = C.exp;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, this.H - this.axisH);
    ctx.stroke();
    // flag
    ctx.fillStyle = '#e6eaf4';
    ctx.beginPath();
    ctx.moveTo(x - 15, 0);
    ctx.lineTo(x + 1, 0);
    ctx.lineTo(x + 1, 14);
    ctx.lineTo(x - 7, 9);
    ctx.lineTo(x - 15, 14);
    ctx.closePath();
    ctx.fill();
    // label (right of the line, or left when there is no room)
    ctx.font = '500 14px "Noto Sans","Segoe UI",sans-serif';
    ctx.textBaseline = 'alphabetic';
    const l1 = this.timeLabel;
    const l2 = fmtClock(exp, true);
    const w = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width);
    const left = x + 10 + w > this.plotW;
    ctx.textAlign = left ? 'right' : 'left';
    const tx = left ? x - 10 : x + 10;
    ctx.fillStyle = 'rgba(176,186,210,0.9)';
    ctx.fillText(l1, tx, 39);
    ctx.fillStyle = 'rgba(138,149,176,0.9)';
    ctx.fillText(l2, tx, 60);
    ctx.textBaseline = 'middle';
  }
}

// Chart overlays Claude draws while analysing. Everything is computed from the candles on screen.
// These are standard technical-analysis tools; they are shown to explain the analysis, they do not predict price.

export const OVERLAYS = [
  ['fib', 'Fibonacci retracement'],
  ['sr', 'Support / resistance zones'],
  ['sd', 'Supply / demand zones'],
  ['ob', 'Order blocks'],
  ['fvg', 'Fair value gaps'],
  ['sweep', 'Liquidity sweeps'],
  ['bos', 'BOS / CHoCH'],
  ['trend', 'Automatic trendlines'],
  ['channel', 'Parallel channel'],
  ['pitch', 'Pitchfork'],
  ['ext', 'Fibonacci extension'],
  ['wave', 'Wave labels (approx.)'],
  ['hs', 'Head & shoulders'],
  ['pos', 'Long / short position'],
  ['vp', 'Price-activity profile'],
];
export const OVERLAY_IDS = OVERLAYS.map((o) => o[0]);

const UP = '#3fcf6e';
const DN = '#ff5a4a';
const BLUE = '#6aa5ff';
const GOLD = '#ffc24d';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function pivots(cs, k = 3) {
  const out = [];
  for (let i = k; i < cs.length - k; i++) {
    let hi = true, lo = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (cs[j].h >= cs[i].h) hi = false;
      if (cs[j].l <= cs[i].l) lo = false;
    }
    if (hi) out.push({ i, type: 'H', p: cs[i].h });
    else if (lo) out.push({ i, type: 'L', p: cs[i].l });
  }
  return out;
}

// keep alternating high/low pivots (take the more extreme of consecutive same-type ones)
function zigzag(pv) {
  const z = [];
  for (const p of pv) {
    const last = z[z.length - 1];
    if (!last || last.type !== p.type) z.push(p);
    else if ((p.type === 'H' && p.p > last.p) || (p.type === 'L' && p.p < last.p)) z[z.length - 1] = p;
  }
  return z;
}

export function drawOverlays(chart, ctx, names, action, elapsed, fast = false) {
  const all = chart.candles;
  if (!all || all.length < 30 || !names || !names.length) return;
  const tf = chart.tf;
  const pw = chart.plotW;
  // visible candles only
  let first = 0;
  while (first < all.length - 1 && chart.tx(all[first].t + tf / 2) < 0) first++;
  const cs = all.slice(first);
  if (cs.length < 25) return;
  const Y = (p) => chart.ty(p);
  const xi = (i) => chart.tx(cs[i].t + tf / 2);
  const top = chart.plotTop, bot = chart.plotBot;
  const last = cs[cs.length - 1];
  const price = chart.dispC ?? last.c;
  const fmtP = (p) => chart.fmtP(p);
  const bodies = cs.map((c) => Math.abs(c.c - c.o));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / bodies.length || 1e-9;
  const zz = zigzag(pivots(cs, 3));

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, pw, bot - top);
  ctx.clip();
  ctx.font = '600 11px "Noto Sans","Segoe UI",sans-serif';
  ctx.textBaseline = 'middle';
  // while dragging/zooming (fast) skip the expensive translucent fills and labels so panning stays smooth
  const fr = (...a) => { if (!fast) ctx.fillRect(...a); };
  const fl = () => { if (!fast) ctx.fill(); };

  const label = (txt, x, y, col, align = 'left') => {
    if (fast) return;
    const w = ctx.measureText(txt).width + 12;
    const bx = align === 'right' ? x - w : x;
    ctx.fillStyle = 'rgba(14,20,36,0.85)';
    ctx.beginPath(); ctx.roundRect(bx, y - 9, w, 18, 6); fl();
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = col; ctx.textAlign = 'left';
    ctx.fillText(txt, bx + 6, y + 0.5);
  };
  const line = (x1, y1, x2, y2, col, w = 1.6, dash = null) => {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]);
  };
  const extend = (a, b) => { // extend a->b line to the right edge of the plot
    const x1 = xi(a.i), y1 = Y(a.p), x2 = xi(b.i), y2 = Y(b.p);
    const k = (y2 - y1) / (x2 - x1 || 1);
    return [x1, y1, pw, y1 + k * (pw - x1)];
  };

  names.forEach((name, idx) => {
    const prog = clamp((elapsed - idx * 450) / 600, 0, 1); // each tool fades in one after another
    if (prog <= 0) return;
    ctx.globalAlpha = prog;

    if (name === 'fib') {
      let hiI = 0, loI = 0;
      cs.forEach((c, i) => { if (c.h > cs[hiI].h) hiI = i; if (c.l < cs[loI].l) loI = i; });
      const hi = cs[hiI].h, lo = cs[loI].l, up = loI < hiI;
      const lv = [[0, '#8a94ad'], [0.236, '#6aa5ff'], [0.382, '#3cc8ff'], [0.5, '#ffc24d'], [0.618, '#ff9f43'], [0.786, '#ff6b81'], [1, '#8a94ad']];
      const px = (r) => (up ? hi - (hi - lo) * r : lo + (hi - lo) * r);
      for (let i = 0; i < lv.length - 1; i++) {
        ctx.fillStyle = lv[i][1] + '14';
        fr(0, Math.min(Y(px(lv[i][0])), Y(px(lv[i + 1][0]))), pw, Math.abs(Y(px(lv[i + 1][0])) - Y(px(lv[i][0]))));
      }
      lv.forEach(([r, col]) => {
        const y = Y(px(r));
        line(0, y, pw, y, col + 'cc', 1, [4, 4]);
        label(`${(r * 100).toFixed(1)}%  ${fmtP(px(r))}`, 8, y, col);
      });
    }

    if (name === 'sr') {
      const zones = [];
      const pts = zz.map((z) => z.p).concat([Math.max(...cs.map((c) => c.h)), Math.min(...cs.map((c) => c.l))]);
      const tol = price * 0.0007;
      pts.sort((a, b) => a - b);
      let cl = [];
      for (const p of pts) { if (cl.length && p - cl[cl.length - 1] > tol) { zones.push(cl); cl = []; } cl.push(p); }
      if (cl.length) zones.push(cl);
      zones.filter((z) => z.length >= 2).sort((a, b) => b.length - a.length).slice(0, 4).forEach((z) => {
        const lo = Math.min(...z), hi = Math.max(...z), mid = (lo + hi) / 2;
        const col = mid > price ? DN : UP;
        const y1 = Y(hi + tol * 0.4), y2 = Y(lo - tol * 0.4);
        ctx.fillStyle = col + '22'; fr(0, y1, pw, y2 - y1);
        line(0, Y(mid), pw, Y(mid), col + 'aa', 1, [8, 5]);
        label(`${mid > price ? 'Resistance' : 'Support'} ${fmtP(mid)} x${z.length}`, pw - 8, Y(mid), col, 'right');
      });
    }

    if (name === 'sd' || name === 'ob') {
      const strong = name === 'ob' ? 2.4 : 1.6;
      let n = 0;
      for (let i = cs.length - 3; i >= 3 && n < (name === 'ob' ? 3 : 2); i--) {
        const body = Math.abs(cs[i].c - cs[i].o);
        if (body < avgBody * strong) continue;
        const bull = cs[i].c > cs[i].o;
        const base = cs[i - 1];
        if ((bull && base.c > base.o) || (!bull && base.c < base.o)) continue; // base candle must be opposite colour
        const col = bull ? UP : DN;
        const x1 = xi(i - 1);
        const yH = Y(base.h), yL = Y(base.l);
        if (name === 'sd') {
          ctx.fillStyle = col + '1f'; fr(x1, yH, pw - x1, yL - yH);
          line(x1, bull ? yL : yH, pw, bull ? yL : yH, col + 'cc', 1.2);
          label(bull ? 'Demand' : 'Supply', x1 + 4, bull ? yL + 12 : yH - 12, col);
        } else {
          const x2 = Math.min(pw, xi(Math.min(cs.length - 1, i + 12)));
          ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.strokeRect(x1 - 2, yH, x2 - x1 + 4, yL - yH);
          ctx.fillStyle = col + '30'; fr(x1 - 2, yH, x2 - x1 + 4, yL - yH);
          label(bull ? 'Bull OB' : 'Bear OB', x1, yH - 12, col);
        }
        n++;
      }
    }

    if (name === 'fvg') {
      let n = 0;
      for (let i = cs.length - 3; i >= 0 && n < 4; i--) {
        const a = cs[i], c = cs[i + 2];
        let lo, hi, col;
        if (c.l > a.h) { lo = a.h; hi = c.l; col = UP; } else if (c.h < a.l) { lo = c.h; hi = a.l; col = DN; } else continue;
        if (hi - lo < avgBody * 0.25) continue;
        const filled = cs.slice(i + 3).some((k) => k.l <= hi && k.h >= lo);
        if (filled) continue;
        const x1 = xi(i + 1);
        ctx.fillStyle = col + '2a'; fr(x1, Y(hi), pw - x1, Y(lo) - Y(hi));
        ctx.strokeStyle = col + '88'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.strokeRect(x1, Y(hi), pw - x1, Y(lo) - Y(hi)); ctx.setLineDash([]);
        label('FVG', x1 + 4, Y(hi) - 10, col);
        n++;
      }
    }

    if (name === 'sweep') {
      let n = 0;
      for (let i = cs.length - 2; i > 8 && n < 4; i--) {
        const prevHi = Math.max(...cs.slice(i - 8, i).map((c) => c.h));
        const prevLo = Math.min(...cs.slice(i - 8, i).map((c) => c.l));
        const c = cs[i];
        if (c.h > prevHi && c.c < prevHi) { const x = xi(i), y = Y(c.h); line(x - 40, Y(prevHi), x + 6, Y(prevHi), DN + 'aa', 1, [3, 3]); ctx.fillStyle = DN; ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x - 6, y - 16); ctx.lineTo(x + 6, y - 16); ctx.closePath(); fl(); label('Sweep', x + 8, y - 14, DN); n++; }
        else if (c.l < prevLo && c.c > prevLo) { const x = xi(i), y = Y(c.l); line(x - 40, Y(prevLo), x + 6, Y(prevLo), UP + 'aa', 1, [3, 3]); ctx.fillStyle = UP; ctx.beginPath(); ctx.moveTo(x, y + 4); ctx.lineTo(x - 6, y + 16); ctx.lineTo(x + 6, y + 16); ctx.closePath(); fl(); label('Sweep', x + 8, y + 14, UP); n++; }
      }
    }

    if (name === 'bos') {
      let trend = 0, lastH = null, lastL = null, n = 0;
      const marks = [];
      for (let i = 4; i < cs.length; i++) {
        const confirmed = zz.filter((p) => p.i <= i - 3);
        lastH = [...confirmed].reverse().find((p) => p.type === 'H') || lastH;
        lastL = [...confirmed].reverse().find((p) => p.type === 'L') || lastL;
        if (lastH && cs[i].c > lastH.p && !lastH.broken) { lastH.broken = true; marks.push({ from: lastH, i, kind: trend === -1 ? 'CHoCH' : 'BOS', col: UP }); trend = 1; }
        if (lastL && cs[i].c < lastL.p && !lastL.broken) { lastL.broken = true; marks.push({ from: lastL, i, kind: trend === 1 ? 'CHoCH' : 'BOS', col: DN }); trend = -1; }
      }
      zz.forEach((p) => delete p.broken);
      marks.slice(-3).forEach((m) => {
        const y = Y(m.from.p);
        line(xi(m.from.i), y, xi(m.i), y, m.col, 1.4, [5, 4]);
        label(m.kind, (xi(m.from.i) + xi(m.i)) / 2 - 18, m.col === UP ? y - 12 : y + 12, m.kind === 'CHoCH' ? GOLD : m.col);
        n++;
      });
    }

    const hs = zz.filter((p) => p.type === 'H'), ls = zz.filter((p) => p.type === 'L');

    if (name === 'trend') {
      if (ls.length >= 2) { const [a, b] = ls.slice(-2); const [x1, y1, x2, y2] = extend(a, b); line(x1, y1, x2, y2, UP, 1.8); label('Trendline ▲', xi(b.i) + 6, Y(b.p) + 14, UP); }
      if (hs.length >= 2) { const [a, b] = hs.slice(-2); const [x1, y1, x2, y2] = extend(a, b); line(x1, y1, x2, y2, DN, 1.8); label('Trendline ▼', xi(b.i) + 6, Y(b.p) - 14, DN); }
    }

    if (name === 'channel') {
      const pts = hs.length >= 2 && (ls.length < 2 || hs[hs.length - 1].i > ls[ls.length - 1].i - 10) ? hs.slice(-2) : ls.slice(-2);
      if (pts.length === 2) {
        const [a, b] = pts;
        const [x1, y1, x2, y2] = extend(a, b);
        const opp = pts[0].type === 'H' ? ls : hs;
        const far = opp.filter((p) => p.i >= a.i).sort((p, q) => (pts[0].type === 'H' ? p.p - q.p : q.p - p.p))[0];
        if (far) {
          const k = (Y(b.p) - Y(a.p)) / (xi(b.i) - xi(a.i) || 1);
          const off = Y(far.p) - (Y(a.p) + k * (xi(far.i) - xi(a.i)));
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 + off); ctx.lineTo(x1, y1 + off); ctx.closePath();
          ctx.fillStyle = BLUE + '16'; fl();
          line(x1, y1, x2, y2, BLUE, 1.7); line(x1, y1 + off, x2, y2 + off, BLUE, 1.7);
          label('Channel', xi(b.i) + 6, y1 + (xi(b.i) - x1) * k + off / 2, BLUE);
        }
      }
    }

    if (name === 'pitch') {
      const q = zz.slice(-3);
      if (q.length === 3) {
        const [p1, p2, p3] = q;
        const mx = (xi(p2.i) + xi(p3.i)) / 2, my = (Y(p2.p) + Y(p3.p)) / 2;
        const x1 = xi(p1.i), y1 = Y(p1.p);
        const k = (my - y1) / (mx - x1 || 1);
        const yAt = (x0, y0, x) => y0 + k * (x - x0);
        line(x1, y1, pw, yAt(x1, y1, pw), GOLD, 1.8);
        line(xi(p2.i), Y(p2.p), pw, yAt(xi(p2.i), Y(p2.p), pw), GOLD + 'aa', 1.2);
        line(xi(p3.i), Y(p3.p), pw, yAt(xi(p3.i), Y(p3.p), pw), GOLD + 'aa', 1.2);
        label('Pitchfork', xi(p3.i) + 8, Y(p3.p) + (p3.type === 'H' ? -14 : 14), GOLD);
      }
    }

    if (name === 'ext') {
      const q = zz.slice(-3);
      if (q.length === 3) {
        const [a, b, c] = q;
        const ab = b.p - a.p;
        [[1, BLUE], [1.272, '#3cc8ff'], [1.618, GOLD]].forEach(([r, col]) => {
          const p = c.p + ab * r;
          const y = Y(p);
          line(xi(c.i), y, pw, y, col, 1.3, [6, 4]);
          label(`Ext ${r}  ${fmtP(p)}`, pw - 8, y, col, 'right');
        });
        line(xi(a.i), Y(a.p), xi(b.i), Y(b.p), '#8a94ad', 1, [2, 3]); line(xi(b.i), Y(b.p), xi(c.i), Y(c.p), '#8a94ad', 1, [2, 3]);
      }
    }

    if (name === 'wave') {
      const q = zz.slice(-6);
      q.forEach((p, i) => {
        const x = xi(p.i), y = Y(p.p);
        ctx.fillStyle = 'rgba(14,20,36,.85)'; ctx.beginPath(); ctx.arc(x, y + (p.type === 'H' ? -14 : 14), 9, 0, 7); fl();
        ctx.strokeStyle = '#c9a4ff'; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.fillStyle = '#c9a4ff'; ctx.textAlign = 'center'; ctx.fillText(String(i), x, y + (p.type === 'H' ? -13.5 : 14.5));
        if (i) { const o = q[i - 1]; line(xi(o.i), Y(o.p), x, y, '#c9a4ff99', 1.2, [4, 3]); }
      });
    }

    if (name === 'hs') {
      const q = zz.slice(-7);
      for (let s = 0; s + 4 < q.length; s++) {
        const [a, b, c, d, e] = q.slice(s, s + 5);
        const bull = a.type === 'L';
        const A = a.p, C = c.p, E = e.p;
        const head = bull ? C < A && C < E : C > A && C > E;
        const sym = Math.abs(A - E) / Math.abs(C - (A + E) / 2 || 1) < 0.45;
        if (!(head && sym)) continue;
        const col = bull ? UP : DN;
        line(xi(b.i), Y(b.p), xi(d.i) + 0, Y(d.p), col, 1.6, [6, 4]);
        [[a, 'LS'], [c, 'Head'], [e, 'RS']].forEach(([p, t]) => label(t, xi(p.i) - 14, Y(p.p) + (bull ? 16 : -16), col));
        label(bull ? 'Inverse H&S' : 'H&S', xi(d.i) + 8, Y(d.p), col);
        break;
      }
    }

    if (name === 'pos' && (action === 'call' || action === 'put')) {
      const rng = cs.slice(-14).map((c) => c.h - c.l);
      const atr = rng.reduce((a, b) => a + b, 0) / rng.length;
      const long = action === 'call';
      const entry = price, stop = long ? entry - atr * 1.5 : entry + atr * 1.5, tgt = long ? entry + atr * 2.5 : entry - atr * 2.5;
      const x1 = clamp(xi(cs.length - 1) + 6, 0, pw - 150), x2 = Math.min(pw, x1 + 150);
      ctx.fillStyle = UP + '26'; fr(x1, Math.min(Y(entry), Y(tgt)), x2 - x1, Math.abs(Y(tgt) - Y(entry)));
      ctx.fillStyle = DN + '26'; fr(x1, Math.min(Y(entry), Y(stop)), x2 - x1, Math.abs(Y(stop) - Y(entry)));
      line(x1, Y(entry), x2, Y(entry), '#ffffffcc', 1.4);
      label(`${long ? 'LONG' : 'SHORT'} entry ${fmtP(entry)}`, x1 + 4, Y(entry), '#fff');
      label(`Target ${fmtP(tgt)}`, x1 + 4, Y(tgt) + (long ? 12 : -12), UP);
      label(`Stop ${fmtP(stop)}`, x1 + 4, Y(stop) + (long ? -12 : 12), DN);
    }

    if (name === 'vp') {
      const hi = Math.max(...cs.map((c) => c.h)), lo = Math.min(...cs.map((c) => c.l));
      const bins = 28, step = (hi - lo) / bins || 1e-9;
      const w = new Array(bins).fill(0);
      cs.forEach((c) => { for (let b = Math.floor((c.l - lo) / step); b <= Math.min(bins - 1, Math.floor((c.h - lo) / step)); b++) w[b] += 1; });
      const mx = Math.max(...w), poc = w.indexOf(mx);
      w.forEach((v, b) => {
        const y1 = Y(lo + step * (b + 1)), y2 = Y(lo + step * b);
        const len = (v / mx) * Math.min(150, pw * 0.22);
        ctx.fillStyle = b === poc ? GOLD + 'cc' : BLUE + '55';
        fr(0, y1 + 0.5, len, Math.max(1, y2 - y1 - 1));
      });
      label(`POC ${fmtP(lo + step * (poc + 0.5))}`, 6, Y(lo + step * (poc + 0.5)) - 12, GOLD);
    }
  });
  ctx.globalAlpha = 1;
  ctx.restore();
}

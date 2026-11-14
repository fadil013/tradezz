// Small, dependency-free technical indicators (used to give Claude a clean view of the market).

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

export const sma = (a, n) => (a.length < n ? null : mean(a.slice(-n)));

export function ema(a, n) {
  if (a.length < n) return null;
  const k = 2 / (n + 1);
  let e = mean(a.slice(0, n));
  for (let i = n; i < a.length; i++) e = a[i] * k + e * (1 - k);
  return e;
}

export function rsi(a, n = 14) {
  if (a.length < n + 1) return null;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= n; i++) {
    const d = a[i] - a[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  g /= n;
  l /= n;
  for (let i = n + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

// candles: [[t,o,h,l,c], ...]
export function atr(candles, n = 14) {
  if (candles.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const [, , h, l] = candles[i];
    const pc = candles[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return mean(trs.slice(-n));
}

export function bollinger(a, n = 20, k = 2) {
  if (a.length < n) return null;
  const s = a.slice(-n);
  const m = mean(s);
  const sd = Math.sqrt(mean(s.map((x) => (x - m) ** 2)));
  const upper = m + k * sd;
  const lower = m - k * sd;
  const last = a[a.length - 1];
  return { mid: m, upper, lower, pctB: upper === lower ? 0.5 : (last - lower) / (upper - lower) };
}

export const momentum = (a, n) => (a.length > n ? (a[a.length - 1] / a[a.length - 1 - n] - 1) * 100 : null);

// Central configuration for Tradezz (demo money, real live prices from Binance public data).

export const PORT = Number(process.env.PORT) || 3000;
export const HOST = '127.0.0.1'; // local only - never exposed to the network

export const START_BALANCE = 10000;

// The five tradable assets. `payout` is what a winning trade returns on top of the stake.
export const SYMBOLS = [
  { id: 'BTCUSDT', name: 'Bitcoin',  short: 'BTC', pair: 'BTC/USDT', payout: 92, decimals: 2, color: '#f7931a', glyph: '₿' },
  { id: 'ETHUSDT', name: 'Ethereum', short: 'ETH', pair: 'ETH/USDT', payout: 90, decimals: 2, color: '#627eea', glyph: 'Ξ' },
  { id: 'SOLUSDT', name: 'Solana',   short: 'SOL', pair: 'SOL/USDT', payout: 88, decimals: 2, color: '#9945ff', glyph: '◎' },
  { id: 'XRPUSDT', name: 'XRP',      short: 'XRP', pair: 'XRP/USDT', payout: 86, decimals: 4, color: '#3b82c4', glyph: '✕' },
  { id: 'BNBUSDT', name: 'BNB',      short: 'BNB', pair: 'BNB/USDT', payout: 90, decimals: 2, color: '#f3ba2f', glyph: '◆' },
];

export const LIMITS = {
  minStake: 1,
  minDuration: 5,
  maxDuration: 3600,
  maxOpenTrades: 40,
  staleMs: 10000, // refuse trades if the last tick is older than this
};

// Models Claude can trade with. Prices are USD per million tokens (input/output).
export const AGENT_MODELS = [
  { id: 'claude-haiku-5-5',  label: 'Claude Haiku 5.5 (cheapest)', in: 0.1, out: 0.5 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5',           in: 2,   out: 10 },
  { id: 'claude-opus-5-5',   label: 'Claude Opus 5.5',             in: 4,   out: 20 },
  { id: 'claude-fable-5-2',  label: 'Claude Fable 5.2 (strongest, web research)', in: 6, out: 30 },
];

export const TRADE_SOURCES = ['user', 'claude', 'claude-code'];

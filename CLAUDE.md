# Trade - demo binary-options platform (fake money, real live prices)

Local app: `node server.js` (or double-click `start.bat`) -> http://localhost:3000
Prices stream live from Binance public data (BTC, ETH, SOL, XRP, BNB vs USDT). The money is a demo balance. Nothing connects to a real account.

## Trading as Claude Code (no API key needed)
The server only listens on 127.0.0.1. A Claude Code session can act as the trader:

1. Read the market:  `curl -s http://localhost:3000/api/snapshot`
   (live candles S15 / M1 / M5, indicators, open trades, your track record)
2. Decide call / put / skip per asset, then place trades:
   `curl -s -X POST http://localhost:3000/api/trade -H "Content-Type: application/json" -d '{"symbol":"BTCUSDT","dir":"buy","amount":100,"duration":60,"source":"claude-code","strategy":"Trend pullback","reasoning":"..."}'`
   - `dir`: `buy` (price higher at expiry) or `sell` (lower). `duration` in seconds (5-3600). `amount` in USD (min 1).
   - Always send `"source":"claude-code"` so the leaderboard can compare you against the user and the API-driven Claude.
3. Results: `GET /api/trades`, `GET /api/stats`, balance in `GET /api/init`.

## Rules of the game
- Win pays stake x payout (BTC 92%, ETH 90%, SOL 88%, XRP 86%, BNB 90%); loss loses the stake; equal price refunds.
- Break-even win rate is 100/(100+payout) ~ 52-54%. Short-term moves are near a coin flip, so skipping is often right.
- Be honest about uncertainty; cite real numbers from the snapshot in `reasoning`.

## Claude via the API (button "CLAUDE TRADE" in the UI)
`src/agent.js` calls the Anthropic API (key in `.env` as `ANTHROPIC_API_KEY`), default model Haiku 5.5, selectable Sonnet 5.5 / Opus 5.5.
Claude returns per-asset decisions plus chart drawings (support/resistance levels, trendlines) that the UI draws.

## Project layout
- `server.js` HTTP + SSE + REST API; `src/feed.js` Binance data; `src/broker.js` paper broker; `src/agent.js` Claude trader
- `public/` web app (`chart.js` canvas chart engine, `app.js` UI)
- `data/` saved account + Claude log (git-ignored)

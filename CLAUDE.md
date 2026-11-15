# Tradezz - demo binary-options platform (fake money, real live prices)

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

## Claude Code session (prompt box in the UI)
The user opens Claude > Claude Code and types an instruction in a box. It is stored on the server:
`GET /api/cc` -> `pending` (true while an instruction waits), `prompt`, `promptAt`, plus session fields
(`active`, `remainingSec`, `left` = bankroll left, `pnl`). When `pending` is true, read `prompt` and:
1. Work out the time limit and the money from the user's words. NEVER invent them. If either is missing or unclear,
   reply with `POST /api/cc/say {"text":"..."}` asking for it, and stop.
2. Otherwise open the session: `POST /api/cc/start {"minutes":N,"budget":N}` (only the user's numbers).
   Trades with `source:"claude-code"` are refused unless a session is active, and stakes cannot exceed `left`.
3. Report progress to the user in the box with `/api/cc/say` (short, factual).
4. Trade loop until `active` is false: `curl -s localhost:3000/api/snapshot` (all 5 assets), then per asset draw your
   analysis with `POST /api/cc/draw {"symbol","strategy","action":"call|put|skip","duration","confidence","reasoning","indicators":["sma|ema|bb|dc"],"levels":[{"price","kind":"support|resistance|target|entry","label"}],"lines":[{"start_price","start_secs_ago","end_price","end_secs_ago","label"}]}`
   (prices within 4% of market) and place trades with `/api/trade` (`source:"claude-code"`, `strategy`, `reasoning`, `confidence`).
   Obey every rule in the user's prompt (assets, style, max stake, stop-loss). Close early with `POST /api/trade/close {"id":N}` or `{"all":true}`.
5. At the end report real P/L and win rate honestly. 99% accuracy is impossible; short-term moves are near a coin flip, skipping is often right.

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

## Fable as the trader (two ways, neither runs automatically)
1. **API button (CLAUDE TRADE):** pick "Fable 5.2" (`claude-fable-5-2`). It runs on the user's API key, uses `effort: high`, may call the
   server-side `web_search` tool (max 4 searches) to refresh trading knowledge, then reviews the whole snapshot (including the QUANT MODEL
   line) and submits decisions. If web search is unavailable on the account the call retries without it. Fable is the priciest option,
   so the user compares it against Haiku/Sonnet on small stakes first. The Fable price in `src/config.js` is an estimate; check the real price.
2. **Claude Code session on Fable:** the user runs `/model` and picks Fable, then types the instruction in the Claude box (or tells the session).
   The session follows "Claude Code session" above, and additionally: use WebSearch to research current short-term trading edges, read
   `/api/snapshot` and `GET /api/signal?duration=30` (the logistic model's P(up) for BTC/ETH/BNB, ~52% tested, one input only), and trade only
   where several signals agree. Skip is valid. Never invent time or money; never promise wins.

## Autonomous mode (the user gives only the money)
If the Claude box prompt has just an amount (e.g. "trade with $5000", no trade count and no duration), `runAuto` in `src/instant.js` takes over:
Claude chooses stake (5% of the budget), horizon (30s / 60s / 5min), timing and when to stop. It trades only the strongest quant-model call
(edge >= 5%, the only region that tested above break-even), one trade at a time, max 12 trades, 20 min of scanning, stop-loss at -30%.
No strong call means no trade. This is a deliberate exception to "never invent time": the user explicitly delegated it by giving only money.
Money always comes from the user; never raise the budget.

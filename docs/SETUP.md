# Setup guide

## Requirements
- [Node.js](https://nodejs.org) 22 or newer (developed on 24)
- Internet access to Binance's public market data (no account, no key)
- Optional: an [Anthropic API key](https://console.anthropic.com/) for the CLAUDE TRADE button
- Optional: [Claude Code](https://claude.com/claude-code) to let a session trade through the REST API

## 1. Install and run
```bash
git clone https://github.com/fadil013/tradezz.git
cd tradezz
npm install
npm start          # or double-click start.bat on Windows
```
Open http://localhost:3000. The server listens on `127.0.0.1` only. Wait about a minute on first start so the 1-second history loads.

## 2. Trade with the Claude box (no API key)
Open **Claude** in the left menu, choose **Claude Trades**, type a prompt and press **Make Trade**.

| Prompt | What happens |
|---|---|
| `trade with $5000` | Autonomous: Claude chooses stake, duration and timing. Only strong calls. You set only the money. |
| `make 7 trades $1000 each, 30 seconds each, one at a time, analyze the market 30 seconds before each trade` | Sequential: full analysis, one trade, repeat. |
| `make 10 trades $500 each, 1 minute each` | Batch: analyse about 10s, then place all trades. |

These use the built-in statistical model. No AI model is called and nothing costs money.

## 3. Trade with a Claude model through the API
1. Click **CLAUDE TRADE**, pick a model (Haiku, Sonnet, Opus or Fable 5.2) and a style.
2. Paste your Anthropic API key once. It is saved to a local `.env` (git-ignored) and sent only to Anthropic. Or copy `.env.example` to `.env` and fill it in.
3. Press **Start**. Fable also runs a few web searches before deciding. Prices per round are estimates, so start with Haiku.

## 4. Let a Claude Code session trade
1. Run Claude Code in this folder and optionally pick a model with `/model`.
2. Tell it your budget. It follows [CLAUDE.md](../CLAUDE.md): reads `GET /api/snapshot` and `GET /api/signal`, opens a session with
   `POST /api/cc/start`, trades with `POST /api/trade` (`source: "claude-code"`) and reports with `POST /api/cc/say`.
3. The server enforces the limits: no trades outside an active session, none above the remaining budget.

## 5. Useful API calls
```bash
curl -s localhost:3000/api/snapshot        # live candles, indicators, open trades
curl -s "localhost:3000/api/signal?duration=30"   # model P(up) for BTC, ETH, BNB
curl -s localhost:3000/api/trades          # trade history
curl -s localhost:3000/api/stats           # win rate and P/L
curl -s -X POST localhost:3000/api/trade/close -H "Content-Type: application/json" -d '{"all":true}'
```

## 6. Troubleshooting
| Problem | Fix |
|---|---|
| Page looks old after an update | Hard refresh with Ctrl+F5 |
| "Not enough live data for the model" | Wait a few minutes after starting the server |
| Port 3000 busy | Set `PORT=3001` in `.env` |
| Trades refused | A Claude Code session must be active, and the stake must not exceed the budget left |

## Configuration
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port |
| `ANTHROPIC_API_KEY` | none | Enables CLAUDE TRADE |

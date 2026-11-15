# Architecture

All diagrams are [Mermaid](https://mermaid.js.org/) and render on GitHub.

## 1. System overview

```mermaid
flowchart LR
  B[(Binance public<br/>WebSocket + klines)] --> F[src/feed.js<br/>1s / 5s / 1m candles,<br/>taker-buy flow, clock sync]
  F --> M[src/model.js<br/>logistic regression<br/>P up for BTC / ETH / BNB]
  F --> S[server.js<br/>REST + SSE on 127.0.0.1]
  M --> I[src/instant.js<br/>Make Trade modes]
  M --> A[src/agent.js<br/>Claude API trader]
  I --> BR[src/broker.js<br/>paper broker<br/>orders, settlement, stats]
  A --> BR
  CC[Claude Code session<br/>via curl / REST] --> S
  S --> BR
  S -->|SSE| UI[public/<br/>canvas chart + UI]
  UI -->|prompt, buttons| S
  BR --> D[(data/ JSON<br/>git-ignored)]
```

The balance is demo money. Only the prices are real. Nothing connects to a broker, exchange or wallet.

## 2. Three ways to trade

```mermaid
flowchart TD
  U[User] --> P{What did you type?}
  P -->|"only an amount<br/>e.g. trade with $5000"| AU[Autonomous mode<br/>runAuto]
  P -->|"N trades $X each,<br/>duration, one at a time"| SQ[Sequential mode<br/>runSequential]
  P -->|"N trades $X each,<br/>duration"| BA[Batch mode<br/>runInstant]
  U -->|CLAUDE TRADE button| API[Claude API trader<br/>Haiku / Sonnet / Opus / Fable]
  U -->|tell a Claude Code session| CCS[Claude Code session<br/>reads snapshot, trades by REST]
  AU --> BR[(paper broker)]
  SQ --> BR
  BA --> BR
  API --> BR
  CCS --> BR
```

## 3. One round of the sequential mode

```mermaid
sequenceDiagram
  participant U as User
  participant S as Server
  participant M as Model
  participant BR as Broker
  U->>S: "7 trades $1000 each, 30s, analyze 30s before each"
  S->>S: parse count, stake, duration, analysis window
  loop each round
    S->>U: draw indicators and zones while analysing (full window)
    S->>M: P(up) for BTC, ETH, BNB
    M-->>S: best call (largest edge)
    S->>BR: open trade (stake, direction, 30s)
    BR-->>U: settle at expiry, win / loss / refund
  end
  S->>U: summary card (net, win rate, trade list)
```

## 4. How a trade is decided

```mermaid
flowchart LR
  X[Last 600s of 1s candles] --> Z[Features<br/>z-scores of 5 to 600s returns,<br/>taker-buy flow, volume ratio,<br/>hour of day, BTC move]
  Z --> LR[Logistic regression<br/>horizon 30 / 60 / 300s]
  LR --> P[P up]
  P --> E{edge = abs P minus 0.5}
  E -->|">= 0.05"| T[Strong call: trade]
  E -->|"0.02 to 0.05"| W[Moderate: only in fixed-count modes]
  E -->|"< 0.02"| SK[Skip in autonomous mode]
```

The eight classic indicators and the 15 drawing tools on the chart are for display. The model makes the decision.

## 5. Autonomous mode (user gives only the money)

```mermaid
flowchart TD
  A[Budget from user] --> B[Stake = 5% of budget]
  B --> C[Analyse at least 20s]
  C --> D{Open trade?}
  D -->|yes| W[Wait for it to settle]
  D -->|no| E[Scan BTC/ETH/BNB at 30s, 60s, 5min]
  E --> F{Best edge >= 5%?}
  F -->|no| E
  F -->|yes| G[Open one trade]
  G --> H{Stop?}
  H -->|"down 30%, 12 trades,<br/>20 min or budget used"| Z[Finish and show summary]
  H -->|no| D
  W --> D
```

## 6. Settlement

A trade opens at the live price and settles at the live price when the timer ends. Higher for a buy or lower for a sell wins the payout
(BTC 92%, ETH 90%, SOL 88%, XRP 86%, BNB 90%). A wrong call loses the stake. An equal price refunds it.

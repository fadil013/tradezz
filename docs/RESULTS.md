# Results and honesty notes

This project is a **demo simulator (demo money)**. Nothing here is a proven or profitable trading system.

## The model
A logistic regression trained on 13 days of Binance 1-second data for BTC, ETH and BNB, with walk-forward testing on 7 unseen days.

| Horizon | All calls | Edge >= 0.05 (about 16% of seconds) |
|---|---|---|
| 30s | 52.1% | 55.0% |
| 60s | 51.6% | 54.2% |
| 300s | 51.6% | 55.9% |

Break-even at a 90% payout is about 52.4%. The edge is small and uncertain. Eight classic indicator strategies tested earlier showed no stable edge, and one idea ("fade") that looked good on 3 recent days failed on 10 older days.

## Live demo results
Live runs have been close to or below a coin flip. As of November 2026, over the last 100 recorded demo trades: 37 wins, 60 losses (38%). The order-flow model on its own was 17 wins and 20 losses (46%) over 37 trades. That is a small sample, so it neither proves nor disproves an edge, but it shows the offline numbers did not carry over cleanly. A 40-trade test with small stakes is the right way to measure it.

## Reading this fairly
- The balance is demo money and the platform has no costs, slippage or real counterparty.
- Do not present demo profit as evidence of skill. If you show this project, disclose that it is demo money and show the full trade log.
- This is not financial advice.

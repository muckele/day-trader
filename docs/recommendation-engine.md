# Recommendation Engine

## Goal
Replace narrow SMA-only ranking with a deterministic, explainable multi-factor engine.

## Inputs
- Daily bars from Alpaca
- Technical indicators from `backend/signal/indicators.js`
- Quality gate from `backend/signal/qualityGate.js`
- Market regime from `backend/signal/regimeDetector.js`
- Feature flags and risk config from centralized trading config

## Factors
- moving-average alignment
- 20/60 day momentum
- relative strength vs benchmark
- trend quality / slope
- ATR-normalized volatility
- average dollar volume
- average range percentage as spread proxy
- drawdown behavior
- breakout proximity and volatility compression
- RSI mean-reversion context

## Output lists
- momentum longs
- mean reversion setups
- short candidates
- swing trade candidates
- intraday candidates
- ETF rotation ideas
- options candidates
- do-not-trade list with reason codes

## Output fields
Each ranked idea includes:
- symbol
- asset class
- bias
- confidence score
- thesis tags
- why it ranked highly
- disqualifying risks
- preferred entry type
- suggested stop / take-profit framework
- suggested holding period
- strategy bucket
- paper/live eligibility

## Persistence
When Mongo is available, the engine stores recommendation snapshots for auditability and future analytics.

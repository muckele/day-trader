# RoboTrader Phase 1

RoboTrader Phase 1 is a backend automation layer. The React UI can enable, disable, configure, and audit RoboTrader, but the trading loop runs on the server through the existing scheduler.

## Safety Defaults

- Paper trading is the default mode.
- Live trading requires explicit user opt-in and the confirmation phrase `I understand live trading risk`.
- Alpaca API secrets are never sent to the frontend.
- Every order is validated against the Alpaca capability matrix before submission.
- Every submitted Alpaca order uses a unique `client_order_id`.
- Emergency stop disables RoboTrader and can cancel open RoboTrader-created orders.

## New Backend Surface

- `backend/models/RoboTradeDecision.js`
- `backend/models/RoboTradeOrder.js`
- `backend/robotrader/settingsService.js`
- `backend/robotrader/alpacaCapabilities.js`
- `backend/robotrader/alpacaOrderBuilder.js`
- `backend/robotrader/alpacaBroker.js`
- `backend/robotrader/researchService.js`
- `backend/robotrader/strategyEngine.js`
- `backend/robotrader/riskGate.js`
- `backend/robotrader/worker.js`
- `backend/robotrader/reconciliation.js`
- `backend/routes/robotrader.js`

## Current Strategy Scope

The first-pass engine evaluates normalized research snapshots with modular strategies:

- Momentum breakout
- Mean reversion
- Trend following
- Risk-off protection

The engine does not promise profit or ROI. It records algorithmic decisions based on available market data, risk settings, and strategy rules.

## Alpaca Capability Matrix

The Phase 1 matrix blocks invalid combinations before Alpaca submission:

- Crypto blocks `trailing_stop`, `bracket`, `oco`, and `oto`.
- Crypto allows `market`, `limit`, and `stop_limit` with `gtc` or `ioc`.
- Options allow `market` and `limit`, `simple` and `mleg`, and `day` time-in-force.
- Options reject equity-only fields such as stops, trailing stops, take-profit, and stop-loss.
- Stocks support `market`, `limit`, `stop`, `stop_limit`, `trailing_stop`, `simple`, `bracket`, `oco`, and `oto` where compatible.

## Worker Behavior

The scheduler calls the Phase 1 worker when Mongo is connected and `ROBOTRADER_WORKER_DISABLED` is not `true`. The older Robo signal loop is disabled by default and only runs when `ROBO_LEGACY_SCHEDULER_ENABLED=true`; dual automation also requires `ROBO_ALLOW_DUAL_AUTOMATION=true`.

The backend Fly service keeps at least one machine running so the scheduler can continue working while the user is logged out.

For each enabled user, the worker:

- Loads settings.
- Pulls Alpaca account, positions, and open orders.
- Builds normalized research for the configured universe.
- Scores opportunities.
- Runs the risk gate.
- Saves every decision.
- Submits the first approved order for the run.
- Saves Alpaca responses.
- Writes audit events.

## Reconciliation

The scheduled reconciliation job checks local `RoboTradeOrder` records against Alpaca and updates status, filled quantity, filled average price, terminal timestamps, and discrepancy flags.

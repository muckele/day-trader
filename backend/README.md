# Backend

## Local Run

```bash
cp .env.example .env
npm install
npm start
```

Server default: `http://localhost:4000`

Local development now prefers `MONGO_LOCAL_URI` before Atlas by default. If you are not running a local MongoDB instance, either:

- start local MongoDB on `127.0.0.1:27017`, or
- set `MONGO_PREFER_LOCAL=false` in `backend/.env` to try Atlas first

Recommended local dev setting:

```env
MONGO_LOCAL_URI=mongodb://127.0.0.1:27017/daytrader
MONGO_PREFER_LOCAL=true
```

## Tests

```bash
npm test
```

## Mongo / Atlas Connectivity Check

Run a deterministic check for URI + DNS + Atlas connectivity:

```bash
npm run mongo:check
```

This script verifies:

- local MongoDB connectivity first in development when `MONGO_PREFER_LOCAL=true`
- `MONGO_URI` if provided
- SRV DNS lookup for `mongodb+srv://` URIs
- fallback connection via `MONGO_URI_DIRECT` if provided

## API Smoke Check

Run a fast response-shape smoke pass against local or deployed backend:

```bash
npm run smoke:api
# or
npm run smoke:api -- --base-url https://<backend>.fly.dev
```

For local dev, you can also force-kill stale `:4000` listeners, restart backend, and verify Robo run-once routes in one step:

```bash
npm run restart:check
```

Or run a full local verification chain:

```bash
npm run verify:local
```

The smoke script validates these checks:

- `/health` (includes `services.mongo`)
- `/api/market/intraday/AAPL`
- `/api/market/historical/AAPL`
- `/api/company/AAPL`
- `/api/analyze/AAPL`
- `/api/recommendations/AAPL`
- `POST /api/robo/run-once` returns `401` (route exists and auth is enforced)

## Robo Trader

Robo Trader adds:

- User settings (`enabled`, `dailyLimit`, `weeklyLimit`, `monthlyLimit`)
- Usage buckets (`day`, `week`, `month`) tracked in UTC
- Audit trail events (`trade_executed`, `trade_skipped_limit`, `robo_disabled`, `email_sent`, `email_failed`, etc.)
- Signal idempotency (`userId + signalId`) to prevent duplicate order placement on retries

Phase 1 RoboTrader adds a richer server-side automation layer without removing the older `/api/robo` routes:

- Extended per-user settings with `isEnabled`, paper/live mode, allowed/blocked symbols, asset-class permissions, max trade size, max daily loss, max open positions, max trades per day, fractional/extended-hours/options/crypto toggles, risk level, manual approval threshold, `lastRunAt`, and `pausedReason`
- Paper mode remains the default. Live mode requires explicit opt-in plus the confirmation phrase `I understand live trading risk`.
- Background execution runs from the backend scheduler when Mongo is connected and `ROBOTRADER_WORKER_DISABLED` is not `true`.
- Alpaca order validation uses a code-level capability matrix before submitting orders.
- Decisions are persisted in `RoboTradeDecision`; submitted/reconciled broker orders are persisted in `RoboTradeOrder`.
- Emergency stop disables RoboTrader immediately and can cancel open RoboTrader-created Alpaca orders.
- Reconciliation checks local RoboTrader orders against Alpaca and records status changes/discrepancies.

API endpoints:

- `GET /api/robo/settings`
- `PUT /api/robo/settings`
- `GET /api/robo/audit?from=&to=&limit=`
- `GET /api/robo/status`
- `POST /api/robo/run-once`
- `GET /api/robotrader/settings`
- `PUT /api/robotrader/settings`
- `POST /api/robotrader/enable`
- `POST /api/robotrader/disable`
- `POST /api/robotrader/emergency-stop`
- `GET /api/robotrader/decisions`
- `GET /api/robotrader/orders`
- `POST /api/robotrader/orders/:orderId/cancel`
- `POST /api/robotrader/orders/:orderId/replace`
- `POST /api/robotrader/positions/:symbol/close`
- `GET /api/robotrader/performance`
- `GET /api/robotrader/audit`
- `POST /api/robotrader/run-once-paper`
- `POST /api/robotrader/reconcile`

Execution quality endpoint:

- `GET /api/analytics/execution-quality?range=30d`

## Environment Variables

Core:

- `MONGO_LOCAL_URI` (default local dev URI: `mongodb://127.0.0.1:27017/daytrader`)
- `MONGO_PREFER_LOCAL` (default `true` outside production; set `false` to try Atlas first)
- `MONGO_URI`
- `MONGO_URI_DIRECT` (optional fallback non-SRV URI if your network blocks SRV DNS lookups)
- `MONGO_DNS_SERVERS` (optional comma-separated DNS servers for SRV lookups, e.g. `8.8.8.8,1.1.1.1`)
- `MONGO_IP_FAMILY` (optional `4` or `6`; production defaults to `4` to avoid IPv6/SRV edge cases on some hosts)
- `MONGO_RETRY_MS` (optional, default `10000`; retry delay when Mongo is unavailable)
- `MONGO_SERVER_SELECTION_TIMEOUT_MS` (optional, default `5000`; Mongo connect timeout per attempt)
- `JWT_SECRET`
- `APCA_API_KEY_ID`
- `APCA_API_SECRET_KEY`
- `APCA_BASE_URL` (use `https://paper-api.alpaca.markets` for paper trading)
- `APCA_DATA_URL`
- `APCA_DATA_FEED` (recommended: `iex`)
- `APP_PAPER_TRADES_SYNC_TO_ALPACA` (`true` to submit app paper trades to Alpaca paper before recording the local paper ledger)
- `PAPER_TRADING_ENABLED` (default `true`)
- `LIVE_TRADING_ENABLED` (default `false`)
- `SHORT_SELLING_ENABLED` (default `false`)
- `MARGIN_TRADING_ENABLED` (default `false`)
- `OPTIONS_TRADING_ENABLED` (default `false`)
- `CRYPTO_TRADING_ENABLED` (default `true`)
- `LEVERAGED_ETF_ENABLED` (default `false`)
- `INVERSE_ETF_ENABLED` (default `false`)
- `RECOMMENDATION_BENCHMARK` (default `SPY`)
- `RECOMMENDATION_UNIVERSE` (optional comma-separated universe override)
- `RECOMMENDATION_MAX_IDEAS_PER_LIST` (default `5`)
- `RECOMMENDATION_TOP_COUNT` (default `5`)

Robo Trader:

- `ROBO_SCHEDULER_DISABLED` (`true` to disable background loop)
- `ROBO_SCHEDULER_REQUIRE_DB` (`true` by default; skips scheduler ticks when Mongo is disconnected)
- `ROBO_SCHEDULER_SKIP_LOG_INTERVAL_MS` (default `60000`; throttle interval for DB-unavailable skip logs)
- `ROBO_EXECUTION_BACKEND` (`paper` default; set `alpaca` to send Robo orders to Alpaca `/v2/orders`)
- `ROBO_SIGNAL_SYMBOL` (placeholder scheduler symbol, default `AAPL`)
- `ROBO_SIGNAL_UNIVERSE` (comma-separated symbols for multi-symbol Robo selection, e.g. `AAPL,MSFT,SPY,TLT,AGG`)
- `ROBO_SIGNAL_QTY` (default `1`)
- `ROBO_SIGNAL_SIDE` (`buy`/`sell`; aliases `short=>sell`, `cover/long=>buy`; default `buy`)
- `ROBO_ALLOWED_SIDES` (comma-separated auto-selection sides, same aliases supported; default `buy,sell`)
- `ROBO_SIGNAL_CHANGE_THRESHOLD_PCT` (default `0.25`; % move threshold for direction selection)
- `ROBO_SIGNAL_RECENT_LOOKBACK_MINUTES` (default `180`; avoid recently traded symbols in this window)
- `ROBO_SIGNAL_RECENT_WINDOW_LIMIT` (default `20`; max recent executions inspected for rotation)
- `ROBO_TARGET_NOTIONAL` (optional; if set, auto-derives quantity from notional/price)
- `ROBO_FALLBACK_EMAIL` (optional fallback recipient)
- `ROBO_SIGNAL_RETENTION_DAYS` (default `90`; cleanup age for idempotency records)
- `ROBO_SIGNAL_CLEANUP_INTERVAL_MS` (default `21600000` = 6 hours)
- `ROBO_CIRCUIT_FAILURE_THRESHOLD` (default `3`; consecutive failures before pause)
- `ROBO_CIRCUIT_COOLDOWN_MINUTES` (default `60`; pause duration after threshold hit)
- `ROBO_MIN_MINUTES_BETWEEN_EXECUTIONS` (default `0`; set `>0` to enforce cooldown between Robo executions)
- `ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS` (default `0`; symbol-level cooldown window)
- `ROBO_MAX_EXECUTIONS_PER_DAY` (default `0`; set `>0` to cap daily Robo trades)
- `ROBO_MAX_EXECUTIONS_PER_STRATEGY_PER_DAY` (default `0`; per-strategy daily cap)
- `ROBO_ALLOW_EXTENDED_HOURS` (`true`/`false`, default `true`)
- `ROBO_KILL_SWITCH` (`true` to halt all Robo executions)
- `ROBO_SLIPPAGE_ANOMALY_BPS_THRESHOLD` (default `0`; set `>0` to block executions when recent slippage spikes)
- `ROBO_SLIPPAGE_ANOMALY_LOOKBACK` (default `5`; recent trade samples used for anomaly detection)
- `ROBOTRADER_WORKER_DISABLED` (`true` to disable the Phase 1 RoboTrader worker loop)
- `ROBOTRADER_RECONCILIATION_DISABLED` (`true` to disable scheduled RoboTrader order reconciliation)
- `ROBOTRADER_RECONCILIATION_INTERVAL_MS` (default `300000`)
- `ROBOTRADER_SYMBOL_UNIVERSE` (optional comma-separated symbols for the Phase 1 worker)
- `ROBOTRADER_MAX_SYMBOLS_PER_RUN` (default `5`)
- `APCA_PAPER_BASE_URL`, `APCA_PAPER_API_KEY_ID`, `APCA_PAPER_API_SECRET_KEY` (optional paper-specific Alpaca credentials; falls back to existing `APCA_*`)
- `APCA_LIVE_BASE_URL`, `APCA_LIVE_API_KEY_ID`, `APCA_LIVE_API_SECRET_KEY` (live credentials; live mode remains disabled unless user settings explicitly opt in)

Paper trading + risk:

- `SHORT_HARD_TO_BORROW_SYMBOLS` (comma-separated list, optional)
- `SHORT_NON_BORROWABLE_SYMBOLS` (comma-separated list, optional)
- `SHORT_BORROW_FEE_APR` (default `8`)
- `SHORT_HARD_TO_BORROW_FEE_APR` (default `28`)

Paper mode now supports:

- Equity + crypto order flow (`assetClass` aware)
- Multi-symbol Robo selection across equities/ETFs/bond ETFs (symbols supported by your Alpaca market data entitlement)
- Advanced order fields (`timeInForce`, `goodTilDate`, `takeProfitPrice`, `stopLossPrice`, `trailingStopPct`, `stop_limit`)
- Unified risk checks (per-symbol, sector, correlation-cluster, and projected VaR guardrails)

Notes:

- For reliable local development, prefer a local MongoDB instance and reserve Atlas for integration/staging.
- Direct mutual funds and direct bond instruments are typically not available through this Alpaca equity/crypto routing path; use tradable ETF proxies (for example `AGG`, `BND`, `TLT`, `LQD`, `HYG`).
- Institutional-grade trading controls introduced in Phase 1 are exposed under `GET /api/trading-system/status` and documented in `../docs/`.
- Atlas connectivity failures with `querySrv` often indicate DNS/network restrictions or an invalid cluster hostname. In Atlas:
  - verify the cluster host in the connection string
  - add your current public IP to Network Access (or temporary `0.0.0.0/0` for testing)
  - verify DB user credentials and database user permissions
  - if your host has IPv6/DNS edge cases, set `MONGO_IP_FAMILY=4`
  - if SRV DNS is blocked on your network, set `MONGO_DNS_SERVERS=8.8.8.8,1.1.1.1` and rerun `npm run mongo:check`
  - if SRV still fails, set `MONGO_URI_DIRECT` from Atlas "Standard connection string" and rerun `npm run mongo:check`

Robo email provider:

- `ROBO_EMAIL_PROVIDER` (`log` or `smtp`; default auto-selects `smtp` if `SMTP_HOST` exists, otherwise `log`)
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

## Fly Deploy Notes

Recommended `fly secrets` include:

- `MONGO_URI`
- `JWT_SECRET`
- `APCA_API_KEY_ID`
- `APCA_API_SECRET_KEY`
- `APCA_BASE_URL=https://paper-api.alpaca.markets`
- `APCA_DATA_URL`
- `APCA_DATA_FEED=iex`
- `APP_PAPER_TRADES_SYNC_TO_ALPACA=true`
- Any SMTP variables if using real email notifications

Example:

```bash
cd backend
fly secrets set APCA_DATA_FEED=iex
fly deploy
```

Do not commit real API keys, SMTP credentials, or database URIs.

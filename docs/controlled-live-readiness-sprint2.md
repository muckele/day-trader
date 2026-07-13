# Controlled Live Readiness — Sprint 2

## Outcome

Sprint 2 adds deterministic execution-quality and portfolio-state vetoes around the Sprint 1 intent/authorization boundary. It also adds a shadow-live operating mode and an approval queue for exact live intents.

This sprint does not enable live trading, install live credentials, deploy the application, or submit a real order.

The canonical policy version is now:

```text
controlled-live-readiness-v2
```

Pending Sprint 1 authorizations are intentionally invalid after this policy upgrade. Their intents must be regenerated and reviewed under the Sprint 2 checks.

## Execution-quality policy

RoboTrader settings include:

```json
{
  "executionPolicy": {
    "maxQuoteAgeSeconds": 15,
    "maxSpreadBps": 35,
    "minAverageDailyDollarVolume": 20000000,
    "maxEstimatedSlippageBps": 25,
    "cutoffMinutesBeforeClose": 15,
    "regularSessionCutoffEt": "15:45"
  }
}
```

Shadow and live candidates fail closed when any of these checks fail:

- Alpaca's exchange-aware clock does not report the primary equity session as open.
- A new equity entry is evaluated at or after 3:45 PM ET.
- An early-close calendar session is within `cutoffMinutesBeforeClose` of its actual close.
- The open-session exchange close is missing, invalid, stale, or belongs to another trading date.
- The quote is not explicitly marked non-mock data from a trusted Alpaca source.
- The quote is missing or older than `maxQuoteAgeSeconds`.
- Bid/ask spread exceeds `maxSpreadBps`.
- Average 20-day dollar volume is missing or below `minAverageDailyDollarVolume`.
- Estimated slippage exceeds `maxEstimatedSlippageBps`.

Estimated slippage includes:

- half the quoted bid/ask spread
- estimated order participation in average daily dollar volume
- adverse movement from the exact reference price reviewed on the intent

The new-entry cutoff does not block a quantity-bounded risk-reducing exit. Other execution-quality checks remain in force.

Paper mode records informational execution checks but does not apply the shadow/live vetoes.

## Market data

Normalized quotes now retain:

- bid and ask prices
- bid and ask sizes
- provider timestamp
- provider/source name
- an explicit mock-data marker

Shadow/live research bypasses the general quote cache. Direct submission of an authorized intent fetches another fresh quote before revalidation.

## Portfolio exposure and drawdown

RoboTrader settings include:

```json
{
  "portfolioPolicy": {
    "maxGrossExposurePct": 100,
    "maxNetExposurePct": 100,
    "maxDailyDrawdownPct": 2,
    "maxTotalDrawdownPct": 5,
    "pauseOnBreach": true
  }
}
```

Each worker or authorized-intent submission captures a `RoboExposureSnapshot` containing:

- equity, last equity, cash, and buying power
- filled-position and reserved working-order long, short, gross, and net exposure
- working-order valuation status, including a fail-closed veto for unpriced risk-increasing orders
- gross and absolute-net exposure percentages
- daily drawdown from `last_equity`
- total drawdown from the persisted peak equity
- normalized positions
- configured limits and deterministic checks
- breach reason codes

Snapshots carry a 90-day TTL so the operational time series remains bounded.

Exposure and drawdown failures are canonical vetoes for risk-increasing orders. When `pauseOnBreach` is enabled, a breach in shadow or live mode disables RoboTrader and writes a `robotrader_portfolio_risk_pause` audit event. A risk-increasing current candidate remains blocked even if the settings update races with the active worker run.

Every candidate also receives projected gross and absolute-net exposure checks. An account at 95% gross exposure cannot approve a proposed 10%-of-equity entry under a 100% cap. Quantity-bounded risk-reducing exits remain eligible even when the current account is above an exposure or drawdown threshold.

Working orders are aggregated by symbol and side before exposure is reserved. Multiple closing orders that collectively exceed an existing position reserve the excess as new long or short exposure. A notional-only working order is conservatively treated as risk-increasing because it cannot be proven to be a quantity-bounded close.

## Shadow-live mode

`mode: "shadow"` is a first-class environment.

Shadow mode:

- uses the Alpaca paper account for account, position, asset, order, and exchange-clock context
- requests fresh market data
- applies live-like score, notional, session, quote, spread, liquidity, slippage, exposure, and drawdown gates
- persists decisions, immutable order intents, policy results, execution-quality metrics, exposure links, and audit events
- never calls the broker submission method
- never requires live credentials or live opt-in

An approved shadow candidate remains `policy_approved`; no `RoboTradeOrder` is created.

Manual shadow execution:

```http
POST /api/robotrader/run-once-shadow
```

RoboTrader must be enabled and its saved mode must be `shadow`.

## Approval queue

The Sprint 2 dashboard loads:

```http
GET /api/robotrader/approval-queue
```

The queue is available only while live mode and explicit live opt-in are both active. It shows immutable fingerprints, policy versions, request/expiry times, authorization status, and the last execution-quality result.

Operator actions are deliberately separate:

```http
POST /api/robotrader/intents/:intentId/authorize
POST /api/robotrader/intents/:intentId/submit
POST /api/robotrader/intents/:intentId/revoke
```

Authorization still requires the exact phrase:

```text
I authorize this specific live order.
```

Submission performs a fresh account, positions, open-orders, exchange-clock, asset, quote, execution-quality, exposure, drawdown, risk, fingerprint, policy-version, and authorization revalidation. The authorization is atomically consumed only after all checks pass.

Every persisted settings mutation advances a monotonic control generation. Worker and direct authorized-intent submissions compare the captured generation immediately before authorization consumption and broker submission. A disable, emergency stop, or concurrent settings change invalidates the in-flight submission, and worker completion updates only `lastRunAt` so stale state cannot re-enable automation.

Revocation atomically marks the active authorization revoked and returns the intent to `awaiting_authorization`.

## Exposure API

```http
GET /api/robotrader/exposure?environment=paper|shadow|live&limit=50
```

The endpoint returns the latest snapshot and bounded history for the authenticated user and environment. Live exposure history requires active live mode and explicit opt-in.

## Stable Sprint 2 reason codes

The canonical policy maps execution and portfolio failures to stable codes including:

- `MARKET_DATA_NOT_LIVE`
- `QUOTE_STALE`
- `SPREAD_TOO_WIDE`
- `LIQUIDITY_TOO_LOW`
- `SLIPPAGE_TOO_HIGH`
- `NEW_ORDER_CUTOFF_REACHED`
- `GROSS_EXPOSURE_LIMIT_EXCEEDED`
- `NET_EXPOSURE_LIMIT_EXCEEDED`
- `DAILY_DRAWDOWN_LIMIT_EXCEEDED`
- `TOTAL_DRAWDOWN_LIMIT_EXCEEDED`
- `WORKING_ORDER_EXPOSURE_UNVERIFIED`

## Remaining production-readiness work

Sprint 2 completes the application phase defined above, but production live readiness still requires operational evidence rather than additional authorization logic alone:

- a sustained shadow-live observation period across normal, volatile, closed, and early-close sessions
- alerting and operator runbooks for risk pauses, stale data, reconciliation discrepancies, and rejected orders
- credential/secrets review and least-privilege deployment configuration
- database migration/index verification in the target environment
- disaster-recovery and kill-switch exercises
- broker-specific acceptance testing with deliberately tiny paper orders
- a formal go/no-go checklist before any live credential is configured

# Controlled Live Readiness — Sprint 1

## Outcome

Sprint 1 establishes a canonical, fail-closed trust boundary between RoboTrader decisions and broker submission.

Paper automation remains automatic. Live candidates use an explicit approval policy and, by default, require a short-lived authorization bound to the exact canonical order fingerprint.

This phase does not enable live trading, configure live credentials, or expand supported asset classes.

## Canonical policy

`backend/services/canonicalTradingPolicyService.js` owns:

- policy versioning
- stable reason codes
- canonical order normalization
- SHA-256 order fingerprints
- explicit approval modes
- exact-order authorization validation
- conversion of existing risk-gate checks into durable policy results
- conservative order-notional derivation from explicit notional or quantity and executable/reference price
- the standing score bands: below 70 is no-trade; 70–79 is review-only for live; 80+ is execution-eligible subject to every other gate

Every RoboTrader candidate now records:

- `policyVersion`
- `reasonCodes`
- `orderFingerprint`
- approval policy and authorization status
- the original risk checks and human-readable rejection reasons

## Approval modes

RoboTrader settings now use:

```json
{
  "approvalPolicy": {
    "mode": "every_trade",
    "thresholdUsd": 0,
    "authorizationTtlSeconds": 300,
    "requireExactOrderMatch": true
  }
}
```

Modes:

- `every_trade`: every live order requires authorization.
- `above_threshold`: live orders over `thresholdUsd` require authorization.
- `autonomous`: no per-order authorization; requires a separate autonomous-risk confirmation when configured.

Paper mode does not require per-order authorization.

The legacy `requireManualApprovalAboveDollarAmount` field remains readable for compatibility. A positive legacy value maps to `above_threshold`. A zero or missing value maps to the safer `every_trade` default for live trading.

## Trade intents

The existing `OrderIntent` model is now the canonical trade-intent record. RoboTrader creates one for each recommended order that reaches policy evaluation.

Important immutable fields include:

- policy version
- canonical order snapshot
- order fingerprint
- approval policy snapshot

Intent lifecycle:

```text
created
  -> policy_blocked
  -> policy_approved
  -> awaiting_authorization
  -> authorized
  -> submitting
  -> submitted
  -> filled / cancelled / rejected / submission_uncertain
```

Broker-order records link back to both the RoboTrader decision and the canonical intent.

## One-time authorizations

`TradeAuthorization` records are:

- scoped to user and account
- linked to one originating intent
- bound to the policy version used to evaluate that intent
- bound to one order fingerprint
- short-lived
- atomically consumed before broker submission
- non-reusable after consumption

The exact confirmation text is:

```text
I authorize this specific live order.
```

If an authorization expires, is revoked, is already consumed, was created for another intent or policy version, or does not match the exact fingerprint, the worker does not call the broker.

## API

Authenticated RoboTrader routes added in Sprint 1:

- `GET /api/robotrader/intents`
- `GET /api/robotrader/intents/:intentId`
- `POST /api/robotrader/intents/:intentId/authorize`
- `POST /api/robotrader/intents/:intentId/submit`

Authorization request:

```json
{
  "orderFingerprint": "<exact fingerprint returned by the intent>",
  "confirmation": "I authorize this specific live order."
}
```

The authorization route verifies user scope, active live mode and opt-in, intent status, live environment, current policy version, and exact fingerprint before creating an authorization.

Submission is a separate operation. The submit route reloads that exact persisted intent, acquires the per-user worker lock, refreshes account/position/open-order context, reruns risk and canonical policy checks, verifies the immutable fingerprint and current policy version, and only then atomically consumes the intent-bound authorization before calling the broker.

## Fail-closed behavior

- Live mode still requires the existing live-risk confirmation.
- `every_trade` is the default live approval policy.
- An approval is consumed atomically before the broker submission path.
- A failed authorization claim results in no local broker order and no broker call.
- A changed account, environment, symbol, side, size, order type, price, time in force, protection field, extended-hours flag, or strategy changes the fingerprint.
- Risk and approval thresholds use the greatest credible notional from explicit notional, the submitted estimate, and quantity multiplied by an executable/reference price.
- Unknown live notional fails closed.
- Broker reconciliation propagates filled, cancelled/expired, and rejected states to the linked intent and decision.
- Switching to paper mode clears the live opt-in; a stale opt-in cannot authorize live-only actions.
- Existing paper behavior remains automatic and covered by the complete regression suite.

## Deferred to Sprint 2+

The execution-quality, shadow-live, portfolio-risk, and approval-queue items below are implemented by [Controlled Live Readiness — Sprint 2](./controlled-live-readiness-sprint2.md). Live credential configuration and deployment remain out of scope.

- Exchange-calendar and 3:45 PM ET cutoff policy
- Quote-age, spread, liquidity, and slippage execution-quality gates
- Shadow-live environment
- Portfolio exposure snapshots and drawdown orchestration
- Full approval queue UI
- Live credential configuration or deployment

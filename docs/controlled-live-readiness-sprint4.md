# Controlled Live Readiness — Sprint 4

## Outcome

Sprint 4 implements a fail-closed controlled-live activation boundary. It does not configure credentials, set `LIVE_TRADING_ENABLED=true`, deploy the application, approve the current environment, or place an order.

No live broker submission is now possible through RoboTrader unless all Sprint 1–4 controls pass at the final submission boundary.

## Required control chain

A live submission requires all of the following at the time of submission:

1. Saved live mode and explicit user live opt-in.
2. The canonical Sprint 2 policy, current quote/session/execution checks, portfolio limits, and any required exact-order authorization.
3. A passing Sprint 3 readiness assessment with no changed or expired evidence.
4. A current Sprint 4 approval bound to the exact readiness fingerprint.
5. A non-expired controlled-live activation.
6. `LIVE_TRADING_ENABLED=true` in the deployment environment.
7. Explicit live-only Alpaca key and secret variables and a non-paper endpoint.
8. An explicitly allowlisted canary symbol.
9. Verified order notional within the activation limits.
10. Remaining daily order-count and cumulative-notional capacity.

Failure of the Sprint 4 guard changes the intent to `policy_blocked`, rejects the decision, creates a `robotrader_controlled_live_blocked` audit event, creates a critical operational alert, revokes any approved/active canary record, and makes no broker call. Any other critical Sprint 3 operational alert also revokes the current canary record.

The legacy Robo engine may continue using the Alpaca paper endpoint for paper acceptance testing, but it now rejects any non-paper Alpaca endpoint with `CONTROLLED_LIVE_WORKER_REQUIRED`. Live execution is available only through the canonical Sprint 1–4 worker path.

## Approval and activation

Approval and activation are deliberately separate.

Approval requires a currently passing readiness assessment and the exact phrase:

```text
I approve a controlled live canary.
```

The approval stores a SHA-256 fingerprint of the passing gates and evidence-expiration values. It expires after 24 hours.

Activation requires the approval fingerprint still to match, the live deployment flag, explicit live-only credentials, and:

```text
Activate controlled live canary now.
```

Any readiness gate failure, evidence renewal/expiry, critical alert, or reconciliation change invalidates the approved fingerprint and blocks submission until a new approval is recorded.

## Hard canary envelope

User-requested limits are clamped to immutable application maximums:

- maximum $100 verified notional per order
- maximum 1 live broker-submission attempt per UTC day, including rejected or later-cancelled attempts
- maximum $100 cumulative live notional per UTC day
- maximum 24-hour activation

The dashboard proposes the more conservative initial envelope of $25 per order, one order, $25 cumulative notional, and four hours. Symbols must be explicitly entered; an empty or implicit universe is not accepted.

## Revocation

Revocation requires:

```text
Revoke controlled live canary now.
```

Revocation marks the activation revoked and then invokes the existing Emergency Stop, which disables RoboTrader and advances the control generation. The operator can also cancel locally owned open live orders. Cancellation never targets broker orders whose local ownership cannot be established.

## API

```http
GET  /api/robotrader/live-activation
POST /api/robotrader/live-activation/approve
POST /api/robotrader/live-activation/activate
POST /api/robotrader/live-activation/revoke
```

The status response reports limits, readiness state, credential/flag presence, confirmation phrases, expiry, and the current activation record without exposing credentials.

## Activation runbook

1. Complete Sprint 3 and resolve every active critical alert.
2. Independently review the current readiness dashboard and canary limits.
3. Record the approval while the deployment live flag remains disabled.
4. Apply explicit live-only credentials and `LIVE_TRADING_ENABLED=true` through a separately reviewed deployment change.
5. Confirm the application reports the expected live endpoint, approval, allowlist, and limits.
6. Activate for the shortest practical window.
7. Authorize and submit at most one deliberately tiny exact intent.
8. Reconcile the broker result, fill, protection, exposure, and audit records before any later activation.
9. Revoke immediately and remove/disable live deployment configuration after the acceptance exercise.

## Remaining human responsibility

Sprint 4 provides enforcement, not financial authorization. A human remains responsible for deciding whether to configure live credentials, enable the deployment flag, accept the stated maximum loss, supervise the canary, reconcile its result, and exercise rollback authority.

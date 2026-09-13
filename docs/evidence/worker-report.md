# Worker, scheduling, and risk safety implementation evidence

Implemented in the shared working tree; no deployment, broker request, email delivery, destructive database operation, or commit performed by this worker task.

## Changes

- Worker completion writes only `lastRunAt`; it no longer rewrites persisted enabled flags from the pre-research snapshot.
- New entries re-fetch account, positions, open orders, market clock, asset metadata, and mapped persisted controls after intent persistence. They fail closed on disabled/pause/mode/configuration changes and fresh risk rejection, then renew and check the worker lease before the broker call.
- Workers require configured `OWNER_USER_ID`, and scheduler selection and post-query filtering restrict execution to that owner. Live mode is rejected regardless of user opt-in or override.
- Lock ownership now uses a random UUID per run. Missing lock implementation fails closed; renewal requires the matching owner and an unexpired lease, validates exactly one matching record, and heartbeat failures latch for the submission boundary.
- Broker acceptance is tracked separately from subsequent save/audit errors. An acknowledged order retains its broker status and client ID, receives an acknowledgement-persistence discrepancy, and is never relabeled a definite broker rejection or submitted again by that run. Stable persisted intent remains available for reconciliation if acknowledgement saving fails.
- Notification enqueue failures are isolated from accepted/rejected/uncertain order state. The independent notification sweep runs after reconciliation and is guarded by configured owner and database availability.
- Legacy scheduler and live reconciliation are permanently disabled for this release. Entry worker failures are isolated so paper reconciliation still runs. Scheduler shutdown prevents new ticks.
- Legacy `/api/robo/run-once`, `/run_once`, `/runOnce` return 410 with canonical API guidance. Legacy enable writes are rejected; legacy read and disable operations remain.
- Emergency stop keeps persistent disable/pause behavior. Cancellation selects only app-owned buys with known zero broker fills, preserves protective sells and partially filled or unknown groups with explicit diagnostics, and stores cancellation requests as `pending_cancel` pending broker reconciliation.
- Risk policy requires paper mode, long-only whole-share equity entries, known asset tradability, known equity/prior equity/cash/P&L, a verified regular session, positive estimated value, and attached stop protection. Fractional/notional and extended-hours automation are blocked. Cash is used instead of margin buying power. Daily-loss, trade-count, and cooldown restrictions exempt risk-reducing exits.
- Canonical settings reject live and unsupported automation flags/classes. Fractional automation defaults and mapped effective setting are false. Explicit owner enable clears an emergency-stop/user-disable pause; it does not silently clear unrelated circuit-breaker reasons.

## Test evidence

Observed regression-red runs before implementation:

| Suite | Passed | Failed | Failure purpose |
| --- | ---: | ---: | --- |
| Worker | 17 | 3 | Telemetry control overwrite, disable during research, acknowledged save failure |
| Scheduler | 7 | 4 | Legacy/live disabled contract and entry failure starving reconciliation |
| Risk gate | 16 | 6 | Fractional/unknown context/cash/live failures |
| Legacy routes | 4 | 3 | Run-once aliases and enable endpoint remain executable |

Settings regression-red also captured in `settings-red.log` before settings changes. Additional lease, ownership, cancellation preservation, fresh-risk, heartbeat, and audit/outbox failure tests were added.

Final command:

```sh
node --test backend/tests/robotraderSettings.test.js backend/tests/robotraderWorker.test.js backend/tests/robotraderRiskGate.test.js backend/tests/roboScheduler.test.js backend/tests/roboRoute.test.js
```

Result: **79 tests passed, 0 failed, 0 skipped**. Tests use injected broker/database/notification dependencies. Captured output: `worker-targeted-tests.log`. Whole-repository verification belongs to the coordinating task.

## Material limits / remaining release gaps

- Lock schema remains owner-user scoped. Owner-only, paper-only execution serializes the designated owner's canonical worker, but this is not a shared account-capacity reservation mechanism across manual/trade-plan/other paths. No real MongoDB multi-process lease test was run here.
- Daily/weekly/monthly spending reservations and atomic cross-path capacity accounting remain unimplemented in this bounded task. The displayed fields must not be treated as verified spending enforcement.
- Persisted controls and lease are checked immediately before submission, but an already-in-flight broker request cannot be recalled. There remains a narrow distributed race between the final read/renewal and the actual broker write; no transactional ordering across MongoDB and Alpaca is claimed.
- Emergency cancellation preserves known partial groups; an order can fill between broker snapshot and cancel request. Broker sandbox group/partial-fill and restart evidence is still required.
- Broker-attached bracket protection is inactive before complete entry fill. Partial-fill exposure and rejected/missing child protection still require separate reconciliation and broker-sandbox evidence.
- Instrument checks here ensure stock class and verified tradability; complete leveraged/inverse ETF eligibility classification relies on shared broker policy and is not established by these unit tests.
- Tests do not establish real account identity, SMTP receipt, exchange staleness guarantees, profitability, or production readiness. Existing settings may require owner migration to the narrower scope; UI affordances must match the settings rejection rules.

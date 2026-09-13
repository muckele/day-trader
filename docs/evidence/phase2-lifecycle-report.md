# Phase 2 lifecycle and spending evidence

Foundation: `a2fdefa`. No commits or external broker/SMTP actions made by this implementation task.

Implemented `backend/services/orderLifecycleService.js` factory `createOrderLifecycle` and persisted-settings production `getOrderLifecycle`. Existing OrderIntent, BrokerOrder and Fill remain authoritative. New AccountCapacity and SpendingBucket records carry account-scoped integer cents. Simulator records are excluded by explicit executionSource predicates and partial unique indexes.

A Mongo replica-set transaction reserves UTC day / Monday ISO week / calendar month capacity together. An account document write serializes competing manual and automated entries. Every current-period check includes all account outstanding reservations, including earlier periods. Confirmed fills are charged to the intent's original period keys; sells do not replenish spending. Cash is conservatively capped by the lowest observed original cash floor less confirmed spending and unresolved reservations; deposits/sales do not automatically increase this floor. This intentionally may reject otherwise affordable later entries until an explicit safe operator cash-resynchronization workflow is designed.

Canonical order payload fingerprints and a unique account/environment/idempotency key prevent duplicate logical requests. Stable broker client IDs exist before a compare-and-set grants the sole POST permission. Network/500 or post-acceptance persistence errors retain capacity; reconciliation looks up original/successor IDs and never POSTs. After five minutes unresolved state becomes reconciliation_required with reservations intact. Known 400/403/422 submission rejection releases capacity. Unsubmitted control rejection releases capacity transactionally.

Cumulative fills use exact decimal/BigInt arithmetic for broker sub-cent average prices, round the cumulative notional half-up to cents, and persist only increasing quantities. Duplicate/stale events do not charge twice. Terminal broker evidence releases unused reservations. Audit and notification outbox records are committed in the same transaction as changed broker/fill state and local reserved/submitting/uncertain/rejected/reconciliation-required/cancel/replace transitions. Notification delivery is not invoked here.

A single replacement successor is supported per intent. Only quantity/limit-price reductions are permitted; order type, time-in-force, and protective terms are immutable. Its existing conservative capacity is retained before PATCH; accepted successor stays in the logical intent with cumulative accounting. Timeout retains the maximum. Explicit replacement rejection keeps the original live and retains its capacity; downstream errors after a successful PATCH cannot be mistaken for broker rejection. Multiple generations and sell replacements reject clearly. Cancel requires known identity and terminal broker evidence before release; uncertain replacement cancellation requires reconciliation.

Production enforces the supported ordinary equity universe, price-capped whole-share limit entries, fresh open market clock, paper account identity, persisted paper mode and positive budget/risk limits. Market orders require explicit maxPricePerShare conversion. Positions, pending exposure, daily trade count, daily loss and automated enable state are checked. Reducing exits bypass entry spending/loss thresholds, validate available position, and share the protection account lease. Existing protective reservations block conflicting manual exits. Production hooks invoke managed protection after reconciliation and block new automated risk when protection is unresolved.

## TDD and actual verification

Initial `node --test backend/tests/orderLifecycle.financial.test.js` failed MODULE_NOT_FOUND before the financial helper existed. Implemented helper; final unit suite: 3 passed.

Real Mongo tests use explicit fixture brokers and freshly randomized disposable `mvp_test_*` databases at loopback 27189, replica set `mvp`, directConnection. They load no inherited brokerage or SMTP credentials. Sandbox first denied loopback EPERM; scoped escalation enabled the local tests. Initial connection without directConnection failed primary selection; directConnection resolved the local replica member advertisement.

Latest combined command:

`node --test backend/integration/orderLifecycle.mongo.test.js backend/integration/orderLifecycle.faults.test.js`

Expanded result: 22 passed, 0 failed, 0 skipped (including parent test containers). Scenarios: all three origin race pairings; duplicate concurrent key/fingerprint conflict; accepted timeout/lookup miss/restart; post-acceptance persistence failure; HTTP500 after acceptance; uncertainty expiry without release; DB failure before submission; partial/duplicate/out-of-order fill; cancel remainder; sub-cent cumulative fill; pre-submit control rollback; explicit entry rejection; replacement timeout/recovery; replacement rejection; partial-fill successor cumulative accounting; forbidden risk-increasing/protection-changing replacements; downstream 403 after accepted replacement; weekly/monthly binding races; old-period reservation carryover; reducing exit after spending/loss thresholds; production strict risk defaults; durable uncertainty/submitting/rejection outbox events. An additional independent position-market-value regression was subsequently added by the reviewer and passed its own suite. Syntax check passed.

## Explicit limitations

No external Alpaca contract acceptance occurred. Replacement cumulative-fill semantics are modeled and tested against controlled adapters; external broker confirmation remains a release gate. Broad full-stack acceptance is owned by the root task and remains separately gated. One successor per logical intent and conservative cash-floor behavior are deliberate supported-scope restrictions. Durable reconciliation requires the worker to revisit unresolved/terminal-with-protection intents; no background scheduler is created by this module.

Final control-ordering regression: the worker-supplied beforeSubmit callback is re-run after all account/settings/clock/protection awaits and the durable submitting claim, immediately before broker POST alongside the exit lease assertion. A known failure at that point transactionally rejects the still-unsubmitted intent, releases capacity, and emits the rejection event. Added real Mongo test where protection checks invalidate the control callback between initial validation and final POST permission: zero POSTs, zero remaining reservation, rejected intent. Final combined core/fault command passed **24 tests, 0 failures, 0 skipped**.

Final root verification added an exact daily-loss boundary regression: manual buys at the threshold now reject consistently with the worker risk gate. The final full verifier passed lifecycle16 + faults9, with 0 failures/skips; see phase2-verification raw logs.

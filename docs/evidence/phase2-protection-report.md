# Phase 2 worker and protection evidence

Implemented against the existing foundation in the shared Phase 2 working tree. No commits, external broker requests, SMTP messages, or live mode changes performed by this workstream.

## Authority and worker delegation

- RoboTrader sends stable decision idempotency through `getOrderLifecycle().submit`. It converts stock entry recommendations to capped whole-share simple limit entries and retains the requested stop price for managed protection.
- `RoboTradeOrder` now references `intentId` and explicit `alpaca-paper` execution source. It is a compatibility projection. Broker external IDs come from `BrokerOrder.externalOrderId`, never its Mongo virtual `id`.
- Reconciliation walks shared authoritative intents, including canceled/filled entries with exposure, delegates lifecycle reconciliation, and updates projections. It cannot create execution from simulator data or unattributed legacy projections.
- Cancel/replace routes require an intent-linked order and delegate lifecycle operations. Legacy modifications return 409 for operator reconciliation. Position close submits a reducing sell through the same lifecycle and requires caller idempotency.
- Emergency stop discovers Robo entry ownership from durable OrderIntent client IDs even if projection persistence failed. It cancels simple partial-entry remainders through lifecycle while preserving protective sells and legacy/native linked groups needing review.

## Durable protection

`OrderProtection` is unique per intent. The account-wide `OrderProtectionLock` serializes protective operations and lifecycle manual exits. The stop record uses optimistic concurrency, persisted deterministic generation/client IDs, an expiring account lease with heartbeat, and an immediate lease check after account verification before writes.

Actual cumulative confirmed fills are capped by current broker position, available quantity, and other outstanding sell exits (including nested legs). Unresolved local sell intents block protective submission. Stop acknowledgement must match client ID, symbol, side, stop type, price, and requested quantity. Held or pending activation is not accepted as confirmed protection.

Quantity changes use cancel-confirm-new: persist cancel pending, request cancellation once, wait for broker terminal evidence, then persist a new deterministic generation before submission. Consequently resizing can leave a visible temporary protection gap; automated risk is blocked throughout. This favors avoiding overlapping oversized stops over pretending cancellation immediately removed an order.

Transport failures, missing lookups, and post-ack persistence failures retain the client identity; reconciliation only observes it and never automatically retries the same POST. Rejections require review. Protection problems update intent state, durable audit, and idempotent NotificationOutbox alerts. Actual delivery was not invoked.

All Robo entries require protection; manual entries requesting a stop receive the same maintenance. Manual entries without a requested stop do not implicitly gain one. Existing required unresolved protection blocks additional entry risk through the production lifecycle hook.

## Validation

- `node --test backend/tests/robotraderWorker.test.js backend/tests/robotraderReconciliation.test.js`: 34 passed, 0 failed, 0 skipped.
- `node --test backend/integration/orderProtection.test.js`: 8 passed, 0 failed, 0 skipped, against loopback replica-set Mongo at port 27189 with a fresh random `mvp_test_protection_*` database removed after the run.
- Real Mongo scenarios: 4 then 6 fills; concurrent/duplicate reconciliation; 4 then canceled remainder; accepted timeout with lookup misses and reconstructed service recovery; durable blocked-risk alert; manual requested stop and held broker stop; shared manual/protection account lease; nested sell legs and pending uncertain reducing orders; reduced position before initial and subsequent stop maintenance.
- Unit adoption scenarios preserve control changes, lost worker lease, fresh risk failure, uncertainty/rejection projection, projection DB failure after authoritative acknowledgement, and emergency-stop partial entry with missing projection. Broker financial semantics are additionally covered by the separate lifecycle real-Mongo suites; worker fixtures validate delegation rather than reimplementing authority.

## Practical limits

This is deterministic provider-boundary verification, not external Alpaca acceptance. Broker external position changes cannot be made atomic with Mongo; stop sizing uses fresh broker context, shared local exit serialization, and conservative rejection/reconciliation. A required stop that is rejected or indefinitely absent remains blocked for operator review. Legacy projection-only orders require explicit reconciliation instead of silently inventing durable intent ownership. The broader MVP release acceptance remains outside this workstream.

## Follow-up adoption checks

- Fixed the existing risk gate's bracket-only check to admit managed simple whole-share limit entries with a positive stop below the entry cap; 23 risk-gate tests passed including the new valid/invalid managed-stop regression.
- Added `manualAlpacaDispatch.test.js`: 2 passed. Actual `paperBroker.placeOrder` and Alpaca execution adapter dispatch into the lifecycle with stable key/origin. Simulator model access traps prove neither simulator records nor account math are touched on acknowledged or uncertain responses. Broker provider IDs remain distinct from Mongo IDs.
- Emergency stop now maps replacement successor client/broker IDs to the original intent and reconciles accepted-timeout/replacement intent state before cancellation. Worker tests cover both successor projection loss and uncertain acceptance. Latest worker plus manual dispatch run: 32 passed (30 worker, 2 dispatch); reconciliation suite remains 6 passed.

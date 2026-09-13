# Owner-only paper MVP implementation plan

Historical foundation/Phase2 plan below. Phase3 continuation and completed local tasks are in `superpowers/plans/2026-09-13-phase3-release-acceptance.md`; current release status and external gates are in `mvp-checkpoint.md` and `mvp-verification.md`. The unchecked historical entries below are preserved as planning history, not the current acceptance ledger.

**Goal:** Complete and verify the existing application against mvp-request.txt.
**Architecture:** Retain React, Express, MongoDB and Fly. Consolidate safety at broker boundaries and deterministic policy; use existing worker/order persistence.
**Spec:** mvp-request.txt

## Global constraints
No live trading, external writes, deployment, destructive cleanup, fabricated success, credential output or test bypasses. Preserve unrelated work. Reproduce defects before fixes. Local simulation is not broker confirmation.

## Bounded tasks and acceptance

- [ ] Baseline: install committed lockfiles; run backend tests, frontend tests/build; record runtime and failures in mvp-verification.md. Files: scripts/verify-mvp.mjs, docs/evidence.
- [ ] Owner isolation: backend/middleware/auth.js, server.js, models/User.js and operator bootstrap script. Tests: existing non-owner JWT denied, DB unavailable fails closed, registration disabled, owner binding explicit, logout invalidates sessions. Dependencies: none.
- [ ] Paper broker boundary: services/alpacaTradingClient.js, robotrader/alpacaBroker.js, config/tradingConfig.js. Regressions: lookalike URL rejected, live settings cannot write, redirect blocked, mismatched account cannot submit/cancel/replace/close. Dependencies: none.
- [ ] Worker controls: robotrader/worker.js, services/roboScheduler.js. Regressions: telemetry cannot re-enable after disable, controls rechecked after research and at submit, lease loss fails closed, only one entry engine, reconciliation independent of entry errors.
- [ ] Durable lifecycle and spending: existing OrderIntent/RoboTradeOrder/paperBrokerClient/reconciliation, riskGate. Persist stable identity, reserve budgets atomically, reconcile partial and uncertain execution; tests require isolated MongoDB and competing requests. Depends on broker and worker safety.
- [ ] Protection contract: verify Alpaca docs; disable fractional automation until protected lifecycle verified; detect missing/rejected protective legs and block new risk. Dependencies: lifecycle.
- [ ] Notifications: install SMTP dependency; durable outbox, deduplication, retries and clear acknowledgement/fill events. Test injected SMTP and restart recovery. Depends on lifecycle.
- [ ] Core screens: actual frontend/backend contracts, errors/unavailable states, paper/simulator separation, disabled advanced/live controls; verify real auth lifecycle in browser with external provider boundary fixtures. Depends on owner/lifecycle.
- [ ] CI and reproducible verification: actual checks with nonzero failure exit, real Mongo integration/E2E, reports/traces; no credentials in PR jobs.
- [ ] External acceptance and operations: opt-in dedicated account bounded test command, Fly readiness, owner runbook, emergency stop/rollback. No external invocation without authorization.
- [ ] Final review: full deterministic verification on final code, inspect diff and secrets, update all acceptance states; no-go until required evidence exists.

Each code task: add regression, run red, implement smallest correction, run covering tests, review diff, update evidence. No completion percentage. Remaining work stays explicit.

## Session checkpoint

Implemented bounded portions of owner isolation, broker safety, worker controls, notifications, UI scope and verification. Phase 2 implements the common lifecycle and atomic budgets below. This plan remains incomplete for full-stack E2E, the complete fault matrix and external tooling. Resume from mvp-checkpoint.md, using mvp-acceptance.md as the status authority. Component reports preserve actual red/green evidence.

## Phase 2 — financial integrity (starting foundation a2fdefa)

Spec: mvp-phase2-request.txt. Retain the foundation; no external broker or SMTP actions.

### Authority and lifecycle

- OrderIntent: one logical owner/account/paper request; unique account/environment/idempotencyKey, payload fingerprint and stable clientOrderId persisted before any broker write. Contains reservation reference, cumulative confirmed quantity/notional and protection state.
- BrokerOrder: one broker ID in the intent's submission/replacement chain. Broker states and cumulative fills, never inferred execution.
- Fill: idempotent broker-confirmed cumulative deltas, keyed by intent/broker ID/cumulative quantity. Account/source always explicit; no simulator records enter Alpaca totals.
- Spending buckets: transactional day/week/month spent and reserved integer cents plus account-wide outstanding reservation/cash serialization. Use existing models where safe; a new budget bucket is permitted because existing RoboUsage mixes legacy origins and lacks broker-account identity.
- RoboTradeOrder and PaperOrder/PaperTrade: compatibility projections/local simulator only, not authoritative for Alpaca budgets or fills.

State machine: intent_created -> reserved -> submitting -> acknowledged -> partially_filled -> filled. Submission transport failures/5xx or lost local acknowledgement -> submission_uncertain; lookup misses retain capacity and never permit a second POST. After a bounded observation window use reconciliation_required (operator review; still no automatic resubmit). Cancellation: cancel_pending -> canceled only with broker terminal evidence. Replacement: replace_pending -> replaced broker record, successor bound to the original logical intent. Definitive broker rejection -> rejected; broker expiry -> expired. Unused reservation releases only on confirmed terminal state. Persistence/audit failures never imply broker rejection.

### Spending contract

UTC day begins 00:00, ISO week Monday 00:00, calendar month first day 00:00. Entry buying expenditure counts; sells never replenish spending. Missing/null/invalid/zero limits fail closed for entries. Positive finite currency uses exact cents; whole-share limit entries reserve quantity * limit ceiling. Unbounded market entries must become explicitly price-capped limit orders or reject clearly. Cumulative confirmed fills move reservation to spent; terminal unused remainder releases. Uncertain submissions/replacements retain the conservative maximum. Outstanding reservations from older periods still count in current entry checks; charges are attributed consistently without resetting away unresolved risk. All three periods are updated in one Mongo replica-set transaction; competing manual/Robo requests serialize on account capacity. Reducing exits bypass entry spending/loss thresholds but still require ownership, identity, quantity availability and order validity.

### Implementation tasks and interfaces

1. Shared service `createOrderLifecycle(deps)` in services/orderLifecycleService.js, existing model extensions and financial tests. Interface: submit({userId, idempotencyKey, origin, orderInput, beforeSubmit?}); reconcile({intentId}); cancel({intentId}); replace({intentId, changes, idempotencyKey}). Factory deps include broker boundary adapter, ownerId, expectedAccountId; production wrapper loads settings and guarded broker. Return {intent, order, brokerOrder, executionSource:'alpaca-paper'}; no assumed trade/fill. Tests: duplicate key/fingerprint, concurrent budgets, accepted timeout/5xx, post-acceptance save failure, restart, partial/terminal/out-of-order reconcile, replacements.
2. Route/worker adoption: manual trade and paper order paths carry a stable browser idempotency key through trade-plan/research. Alpaca mode bypasses simulator math completely. Worker uses stable decision identity and shared lifecycle. Provider-only fixtures, never auth bypass. Tests inspect actual routing/delegation and source separation.
3. Protection maintenance: durable per-intent protection state, actual filled/remaining position quantities, serialized stop creation/replacement, stable protective client IDs, uncertain recovery and no duplicate exits. Integrate through common reconciliation; flag unprotected and block new automated risk. Prefer simple capped entry + managed stop to native bracket whose child remains inactive on partial entry. Test 4+6 fills, 4+cancel, failure, duplicate reconcile and reduced position.
4. Real replica-set integration suites and verifier wiring. Add exact race/fault scenarios; preserve blocked full-stack release acceptance. Review changes and commit coherent Phase 2 work only after full final checks.

### Final supported restrictions

Only one non-increasing quantity/limit successor is permitted, with order type, TIF and protective terms unchanged. Broker cumulative replacement fills are modeled in controlled adapters; external contract acceptance remains required. Cash uses a conservative non-replenishing floor; sales/deposits cannot silently expand entry capacity. Required protective orders reserve the position against conflicting manual exits. Browser identical-payload retry keys remain session-stable; a deliberate new-identical-order workflow is a follow-on UI acceptance item. These choices fail closed and are not claims of complete operational release readiness.

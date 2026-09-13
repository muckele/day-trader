# Owner-only paper MVP implementation plan

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

Implemented bounded portions of owner isolation, broker safety, worker controls, notifications, UI scope and verification. This plan is intentionally not checked complete: common lifecycle, atomic budgets, full-stack E2E, complete fault matrix and external tooling remain code work. Resume from mvp-checkpoint.md, using mvp-acceptance.md as the status authority. Component reports preserve actual red/green evidence.

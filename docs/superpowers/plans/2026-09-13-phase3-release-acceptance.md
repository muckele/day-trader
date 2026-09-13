# Phase 3 release acceptance implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded implementation and review tasks. The user's Phase 3 specification governs scope and final release gates.

**Goal:** Prove the owner-only paper application across browser, real auth, backend processes, Mongo and controlled provider boundaries; resolve documented cash/close/new-intent limitations.

**Architecture:** Retain the Phase 2 lifecycle. A test-only launcher starts the production backend with a transport preload routing only explicit provider destinations to a loopback HTTP server. The production paper origin, account validation and execution readiness remain active. Serve a production frontend through a local proxy and use real login forms. No application API interception or fake browser tokens.

**Tech stack:** Node 20, Express, React production build, Mongo 7 replica set, Playwright Chromium, local HTTP/SMTP fixtures.

**Spec:** docs/mvp-phase3-request.txt

## Constraints and baseline

Starting SHA 0dcc4d0dad7f47768a5613573b0a828bda0667ff, branch codex/owner-paper-mvp, initial working tree clean. No broker orders, external SMTP, deployment, push, live mode or persistent production activation. All fixtures use scrubbed environment/dummy credentials, randomized disposable DB names, loopback listeners and test-owned cleanup. Do not weaken exact paper endpoint validation. Every required local acceptance category must execute and pass before a release-candidate claim.

## Tasks

- [x] 1. Baseline: run complete existing verify-mvp against disposable Mongo and preserve output separately; distinguish expected blocked exit1 from check failures.
- [x] 2. Harness: scripts/acceptance provider HTTP server, test-only transport preload, server/frontend launcher, real owner bootstrap and Playwright configuration. Program account/clock/assets/orders/positions/fill/cancel/replace/fault state at provider HTTP controls. Browser asserts login and backend readiness; no API routes manufactured in browser.
- [x] 3. Financial follow-ups: targeted cash synchronization and coordinated close services extending existing account transactions/exit lease. Write real Mongo concurrent/fault tests first. Preserve consumed period budgets; unknown cash fails closed; cancellation must be terminal before closing; uncertain closes retain identity and visible bounded recovery.
- [x] 4. Browser contracts: explicit new-identical-order action after terminal resolution, stable retries; wire close and visible source/fill/notification/provenance states. Test real browser manual/partial/final/rejection/uncertainty/cancel/reload, research/trade-plan and all core screens.
- [x] 5. Process acceptance: real separate Node worker processes and controlled provider barriers; browser logout then worker entry, abstention, disable during research/pre-submit, emergency stop acknowledged/uncertain, lost leases and concurrent workers. Observe actual Mongo records and HTTP write counts.
- [x] 6. Notification acceptance: local SMTP capture using actual outbox/transport; queued/accepted/retry/restart/dedup scenarios including protection and uncertain orders. Never equate provider acceptance with inbox receipt.
- [x] 7. External tooling/security: implement opt-in/dry-run bounded external paper command, unit-test refusal/ownership cleanup. Rerun audits, analyze each high finding and safe compatible remediation. Validate Actions YAML/commands and secret isolation, without push or CI claims.
- [x] 8. Verifier and review: discover required process/browser suites, declare explicit local release threshold and separate external/deployment gates. Run complete fresh verification, inspect diff/secrets, update checkpoint/runbook/ledger/evidence, commit internally consistent work. A missing acceptance scenario remains a failing gate, never a fabricated pass.

## Review ledger

Initial design: test transport substitution is confined to launcher preload, not production flags or weakened endpoint rules. Services and destination/account checks execute unchanged; only provider network transport is controlled. Local UI requests always reach the actual backend.

Final local verifier: exit0, all19gates pass. Backend377, Mongo/HTTP60, frontend34, verifier10, provider1, process9, browser22. External/deployment gates remain NOT RUN. See docs/mvp-verification.md and committed Phase3 evidence for exact counts and reviewed limits.

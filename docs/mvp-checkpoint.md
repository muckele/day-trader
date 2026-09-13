# Implementation checkpoint — resume here

Status: **IMPLEMENTATION INCOMPLETE / NO-GO for release**. Repository muckele/day-trader, branch `codex/owner-paper-mvp`.

The prior dirty tree was inspected, matched its documented checkpoint, and passed deterministic checks before preservation as `a2fdefaac8cce02fe721251eae6d8fc2191af7c8` (`feat: harden owner-only paper MVP foundation`). That is the Phase 2 starting SHA. The earlier starting SHA was `4b3425153b7f3dc3816246cf5d5da7e41d42670e`. Phase 2 is recorded by the subsequent financial-integrity commit; use `git log -2` for its exact SHA rather than embedding a self-referential commit hash.

## Completed bounded work

Foundation: owner authorization/bootstrap/logout revocation, exact paper endpoint and expected-account write guards, readiness index/write gating, worker disable/lease checks, legacy entry shutdown, conservative settings, durable notification outbox, release-scope UI and deterministic verification.

Phase 2: manual/research/trade-plan and Robo entries share OrderIntent/BrokerOrder/Fill and atomic AccountCapacity/SpendingBucket transactions. Stable logical request keys and client IDs prevent repost after timeout, lost acknowledgement or restart. Cumulative confirmed fills charge integer cents; uncertainty retains capacity and reaches reconciliation_required after five minutes without automatic resubmission. UTC day/Monday week/calendar month budgets are configurable in the Robo settings screen and apply to all Alpaca entries. Simulator records are excluded from Alpaca portfolio data and budgets.

Managed stops protect actual filled quantities, resize through cancel-confirm-new generations, recover by stable client ID, and emit durable failure events. Protection and reducing manual exits share an account lease. Emergency stop discovers authoritative app intents even when compatibility projection persistence failed. Replacements permit one successor with non-increasing quantity/limit and unchanged protective terms; unresolved successors preserve reservations. Read the three Phase 2 component reports and plan for supported behavior and limitations.

## Next unfinished task: full-stack release acceptance

Build actual frontend → backend → real login/auth → isolated Mongo → controlled provider adapter E2E. Do not inject browser auth tokens or mock application API responses and call that full-stack verification. Existing browser evidence remains API-fixture-only. Include manual/research/trade-plan/worker, duplicate requests, pending/partial/final UI states and source identity.

Extend complete fault/concurrency acceptance around server process restarts, lease expiry during broker I/O, settings changes during in-flight operations, linked replacement/emergency stop, source-specific core screen contracts, and unavailable notifications. Phase 2's real Mongo suites establish bounded invariants, not exhaustive release acceptance.

## Deliberate restrictions and remaining local work

- Entries require positive spending/risk limits and whole-share capped prices in the supported equity universe. Missing/zero limits block entries. Selling does not replenish period spending.
- Conservative account cash floor does not automatically increase after sales/deposits. Design a reconciled, serialized cash resynchronization operation before expanding repeated cash recycling; do not clear capacity records or bypass reservations.
- One replacement successor; only reductions with unchanged protection/order terms. Sell replacement and uncertain replacement cancellation fail closed. Reconcile first.
- Existing protective reservation blocks a conflicting manual exit. A coordinated operator cancel-stop/close workflow and its fault acceptance still need product-level completion. Protection resizing can leave a temporary gap while cancellation is confirmed; new automated risk is blocked during unresolved coverage.
- Browser identical payloads retain their logical key through retries/reloads for the session. A deliberate “new identical order” action needs full-stack acceptance; do not silently rotate keys on timeout.
- Historical unmarked simulator equity is excluded because its source cannot be established. Alpaca cash/positions/history come from broker reads; local confirmed Fill records supply execution history. Full history/provenance and all core-screen contracts need release acceptance.
- External Alpaca replacement/stop semantics, real broker account identity, SMTP receipt, unattended worker operation and deployment remain unobserved. No external orders, SMTP sends, persistent activation or deployment are authorized by this phase.
- Dependency findings are documented individually in `docs/evidence/phase2-dependencies.md`. No forced upgrade or framework migration was performed.

## Verification and operational state

Run `node scripts/verify-mvp.mjs` with Node 20 and disposable MongoDB 7 replica set `mvp` on `127.0.0.1:27189`. Phase 2 used test-owned Docker container `day-trader-mvp-phase2`; tests create and drop random `mvp_test_*` databases. Credentials/scheduler flags are scrubbed by the verifier. The latest report under `docs/evidence/verification` is the actual result authority.

The verifier includes lifecycle, fault and protection Mongo gates and must still exit 1 while full-stack and complete release acceptance are blocked. `--checks-only` is not a release signal. Live trading remains disabled. No additional user input is needed for the remaining local acceptance work.

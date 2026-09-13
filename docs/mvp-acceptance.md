# MVP acceptance ledger

Current status: **IMPLEMENTATION INCOMPLETE**. Decision: **NO-GO**. Passing bounded checks does not imply the complete product contract is implemented.

| Acceptance item | Status | Evidence / remaining requirement |
|---|---|---|
| Repository identity and baseline | VERIFIED | Clean starting HEAD 4b3425153b7f3dc3816246cf5d5da7e41d42670e; baseline 270 backend + 3 frontend, build passed on host Node 24 |
| Explicit owner binding, disabled signup, non-owner isolation | VERIFIED | Owner tests and real Mongo/HTTP login/logout integration; full browser/server route-tree E2E remains separate |
| Session expiration and persistent logout revocation | VERIFIED | Owner middleware and real DB session-version revocation tests |
| Exact paper destination and account identity before broker writes | VERIFIED | brokerBoundarySafety tests; no external account observed |
| Readiness based on indexes and majority write probe | IMPLEMENTED | Unit/race regressions pass; actual production capacity and automatic driver reconnect remain unobserved |
| Immutable advanced/live restrictions and UI controls | VERIFIED | Backend restrictions, 9 frontend unit tests and 2 earlier API-fixture browser cases |
| Single canonical automated entry loop | VERIFIED | Legacy run aliases/enable blocked; legacy/live scheduler tests pass |
| Disable-state overwrite and lost-lease rejection | VERIFIED | Worker regressions + real Mongo unique lock and expired/lost renewal checks |
| Account/environment concurrency across manual, worker, reconciliation | NOT STARTED | Current worker user lock does not reserve shared account capacity |
| Stable durable common order lifecycle and simulator separation | IN PROGRESS | Worker acceptance-save handling improved; manual sync and mixed accounting still require consolidation |
| Atomic daily/weekly/monthly expenditure reservations | NOT STARTED | Active worker settings do not constitute enforced budget accounting |
| Cash-aware, conservative whole-share regular-hours entries | IMPLEMENTED | Risk regressions pass; exhaustive instrument eligibility/shared manual policy incomplete |
| Risk-reducing exit exemptions | IMPLEMENTED | Targeted risk tests; full cross-path fault acceptance incomplete |
| Emergency stop persistent state and selective cancellation | IMPLEMENTED | Unit regressions preserve known protective/partial orders; in-flight linked-group race not fully verified |
| Partial-fill and protective child lifecycle | IN PROGRESS | Fractional automation disabled; complete partial bracket protection missing |
| Durable SMTP outbox, retries/dedup/restart | IMPLEMENTED | Unit tests and real Mongo concurrent claim/dedup/reconnect tests pass; real SMTP receipt not observed |
| Protection-failure notification events and operational UI | IN PROGRESS | Event formatting is not complete protection failure production |
| Core screen/API contracts, provenance and accounting | IN PROGRESS | Robo unavailable states fixed; all other core workflows need systematic verification |
| Complete full-stack lifecycle E2E | NOT STARTED | Existing browser tests use API fixtures, not full auth/backend/Mongo/broker lifecycle |
| Complete fault/concurrency acceptance | IN PROGRESS | Limited lease/outbox/race coverage; spending/uncertainty/partial fill matrix incomplete |
| Reproducible verification command | VERIFIED | Final report in evidence/verification; returns nonzero for incomplete required layers |
| GitHub Actions and branch protection | IMPLEMENTED | Workflow configured; no GitHub run or administrative branch protection observed |
| External acceptance command | NOT STARTED | Full guarded order/fill acceptance command still needs implementation |
| External paper orders, fills, logout worker operation and receipt | BLOCKED | No external trading/SMTP authorization; local code requirements also incomplete |
| Fly deployment and deployed acceptance | BLOCKED | Not authorized and current code is not release-ready |
| Runbook and resumable checkpoint | IMPLEMENTED | mvp-runbook.md and mvp-checkpoint.md disclose missing steps |

See mvp-checkpoint.md for the exact next unfinished task. No live trading was enabled.

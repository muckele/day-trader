# Implementation checkpoint — resume here

Status: IMPLEMENTATION INCOMPLETE. Do not deploy or activate unattended trading. Branch codex/owner-paper-mvp; starting HEAD 4b3425153b7f3dc3816246cf5d5da7e41d42670e. No commits or external trading performed. Uncommitted changes are this session's implementation.

## Completed bounded work

Owner authorization/bootstrap/logout revocation, immutable paper-only exact origin and expected-account write guards, readiness index/write gating, worker disable-state race and lease checks, legacy entry shutdown, conservative automation settings/risk restrictions, durable notification outbox/SMTP dependency, release-scope UI, verification script/CI configuration, and isolated MongoDB/HTTP regression tests. Read component reports in docs/evidence before changing these again.

## Next unfinished task

Unify the manual paper path and canonical worker on a durable account/environment order intent and reservation lifecycle. Start by reading backend/paper/paperBrokerClient.js placeOrder/reconcileAlpacaPaperOrder, backend/services/executionTelemetryService.js, backend/models/OrderIntent.js, backend/models/BrokerOrder.js, backend/models/Fill.js and backend/robotrader/reconciliation.js. Existing manual sync can classify post-acceptance polling errors as rejection and mix simulator-derived accounting with broker data. Existing active worker does not atomically enforce dailyLimit/weeklyLimit/monthlyLimit expenditure.

Implement tests FIRST against the disposable replica set: duplicate logical request -> one stable client_order_id and one reservation; timeout after broker acceptance -> uncertain intent retained/reconciled; database failure before submit -> no broker write; persistence failure after broker acceptance -> no rejection/retry; partial fill then cancel -> confirmed spent capacity retained; concurrent workers/manual requests -> no overspend. Use dedicated broker boundary fixture adapter; never real credentials. Use decimal/cents arithmetic and document UTC or explicit market timezone boundaries. Do not sell to replenish spending budgets. Bind unique indexes to designated account and paper environment and gate readiness on them.

## Further required work

1. Complete instrument eligibility (explicit ordinary ETF/stock allowlist), shared reducing-exit policy, global/manual control parity and approval limits.
2. Partial-fill protection, child orders, replacement chains, emergency linked-group races, protected exits while entries disabled. Current bracket use does not protect every partial exposure.
3. Account-scoped concurrency across all execution paths; current worker lock is user-scoped, adequate only for its single-owner loop, not manual/reconciliation coordination.
4. Finish notification protection-failure events, operational UI and SMTP receipt evidence; bounded retries/local dedup do not mean exactly-once delivery.
5. Actual frontend/backend/auth/Mongo order E2E with external providers stubbed only at their boundary. Existing browser tests are UI fixtures.
6. Full fault/concurrency acceptance and opt-in external paper order command with dedicated account/capped exposure/test-owned cleanup. No such full external order acceptance command exists yet.
7. Complete all core screen contracts, simulator isolation, research provenance/staleness and backtest accounting audit.
8. Address remaining dependency advisories without uncontrolled upgrades; validate deploy artifact, Fly/cookie configuration, CI run/branch protections, complete runbook gaps.

## Verification

Run `node scripts/verify-mvp.mjs` with Node 20 and disposable MongoDB on 127.0.0.1:27189. The command scrubs credentials, installs lockfiles, runs implemented tests and records unmet required layers as BLOCKED with exit 1. `--checks-only` deliberately tests only implemented checks; it is never a release-candidate signal. See final report.json for actual latest results. Full-stack lifecycle acceptance remains incomplete even when unit tests/build pass.

External access cannot solve the unfinished local code. No additional user permission is needed for remaining local implementation. External trading, real SMTP recipient tests, persistent activation and deployment require explicit authorization when the actual tooling is ready for review.

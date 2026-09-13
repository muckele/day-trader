# Implementation checkpoint — Phase 3

Status: **VERIFIED RELEASE CANDIDATE — GO for deterministic local acceptance.** Final complete verifier exit 0; all 19 required gates passed. Deployment and external operational acceptance remain NOT RUN.

Repository `muckele/day-trader`, branch `codex/owner-paper-mvp`. Phase 3 started from clean `0dcc4d0dad7f47768a5613573b0a828bda0667ff`. Phase 2 remains in history; no reset or architecture replacement occurred. The earlier foundation is `a2fdefaac8cce02fe721251eae6d8fc2191af7c8`.

Current release decision is the latest complete `docs/evidence/verification/report.json` and `docs/mvp-verification.md`. Only all required deterministic local gates passing earns **VERIFIED RELEASE CANDIDATE**. This does not establish **DEPLOYED PAPER MVP VERIFIED**. External Alpaca acceptance, external SMTP receipt, deployed acceptance and persistent operational activation have not been run or authorized. Live trading remains disabled.

## Implemented Phase 3 continuation

The acceptance harness uses the production frontend, actual form login, real backend, disposable Mongo replica set and local provider HTTP/SMTP boundaries. It exercises manual/research entries, partial/final fills, timeout/reload/retry, deliberate new identical requests, coordinated closes, browser logout followed by independent workers, separate-process control/lease races, and core screen contracts. Historical non-owner HTTP authorization is separate from the real browser login tests.

Coordinated closes share the account protection lease. Only known app protections are canceled; a DELETE response alone is insufficient. Fresh terminal order status and actual remaining whole-share position determine the close size. Unrelated exits block the workflow. Uncertain cancellation stays visible and prohibits overlapping exits. A two-minute deadline and independent 30-second close recovery tick cancel/confirm expired exits and restore remaining protection. Restoration work remains durable until confirmed; broker/database outages can extend the interval and require operator review. Disabling entries does not stop this recovery, but disabling the entire scheduler does.

Cash synchronization uses confirmed broker/account cash, refuses unresolved local buys/reservations or broker open buys, and serializes with new reservations. It refreshes the cash ceiling using an absolute snapshot, without double-crediting proceeds or clearing historical day/week/month spending. Unknown/stale account state blocks entry. Owner API: `POST /api/robotrader/cash/synchronize`.

Browser request records survive reload. Double-click and uncertainty retry reuse one identity. After terminal resolution, Prepare another identical order creates an explicit new intent without POST; Submit prepared order sends that new request. Known normalized risk refusals persist a rejected identity and permit a corrected ticket. Ambiguous responses remain unresolved until authoritative reconciliation.

Activity exposes account-scoped notification delivery states; canonical lifecycle/protection/close events appear in the Robo audit. Provider acceptance is never labeled inbox receipt. Market state uses the broker clock in Alpaca mode; unavailable P&L and authentication-service failures have explicit UI states. Backtest same-close timing, one-share/fixed-cash assumptions and omitted fees/slippage are disclosed.

The guarded external command is implemented at `backend/scripts/external-paper-acceptance.js`; only local dry-run/controlled tests were executed. See the runbook for exact later operator commands and cleanup limits.

## Retained scope and deferred operational work

- Whole-share, supported US-equity, long entries with capped prices and positive configured risk/spending limits. No live execution or new strategy features.
- Selling does not replenish period spending; unknown submission state retains capacity. Do not delete records or rotate keys to escape uncertainty.
- One non-increasing replacement with unchanged protective terms; uncertain replacements remain conservative.
- Simulator balances/fills/history remain separate from Alpaca cash/positions/confirmed fills.
- Backend dependency audit: zero findings after compatible lock update. Frontend findings and individual high-risk dispositions are in `docs/evidence/phase3-security-report.md`; no forced upgrade or framework migration.
- GitHub Actions YAML/commands reviewed locally. No push or actual hosted run; branch protection and deployed configuration have not been observed.
- Next external work requires separate authorization: dedicated paper-account command, hosted CI, deployed login/readiness/reconciliation/notifications/emergency controls and required operational checks. Available credentials do not authorize these actions.

## Resume and verify

Read `docs/mvp-phase3-request.txt`, acceptance ledger, verification record, runbook, and `docs/evidence/phase3-review.md`. Use Node 20, OpenSSL, matching Playwright Chromium and test-owned MongoDB 7 replica set `mvp` on loopback port 27189. `node scripts/verify-mvp.mjs` runs all required gates; missing/failed/skipped acceptance is not promotable. Tests create/drop only randomized `mvp_test_*` databases and scrub provider credentials. The Phase 3 test container `day-trader-mvp-phase3` was removed after final verification. The final Phase 3 commit is the commit containing this checkpoint; use `git log -1` for its immutable SHA rather than embedding a self-referential hash.

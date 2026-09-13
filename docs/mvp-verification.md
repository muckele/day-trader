> **2026-09-13 repair checkpoint: RC-001 and RC-002 repaired; NO-GO pending supported-runtime and Linux image acceptance.** Final safety verifier passed all23 required gates, exit0, with no skipped scenarios. This Node20 run preserves historical comparison and is not a supported-runtime release pass. See `docs/evidence/rc-repair/safety-final-verifier/report.json` and `docs/evidence/rc-repair/repair-decision.md`. The Phase3 GO statements below are historical; original19/19 reports remain unchanged.

# MVP verification record — Phase 3

Status: **VERIFIED RELEASE CANDIDATE — GO for the defined deterministic local owner-only Alpaca PAPER MVP.** Complete verifier exit: **0**. All **19 required gates passed** on one fresh run. This is not DEPLOYED PAPER MVP VERIFIED.

Starting SHA: `0dcc4d0dad7f47768a5613573b0a828bda0667ff`, initially clean branch `codex/owner-paper-mvp`. Phase 2 and its earlier foundation remain preserved. The final Phase 3 commit is the commit containing this record; use `git log -1` for its exact immutable SHA.

## Exact complete command and environment

```sh
env -i PATH="/private/tmp/day-trader-mvp-runtime/node_modules/node-bin-darwin-arm64/bin:$PATH" HOME="$HOME" \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Users/Matt/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell' \
  node scripts/verify-mvp.mjs
```

Node **20.20.2**, Google Chrome for Testing **151.0.7922.34**, OpenSSL **3.6.4**, MongoDB **7** replica set `mvp` on `127.0.0.1:27189`. The Chrome executable is an explicit local cached binary; CI installs the browser matching its Playwright package. Both committed-lockfile npm ci installs and the production frontend build passed. No build warning was waived. External credentials and activation flags were scrubbed. Every integration fixture creates/drops its own random `mvp_test_*` database. The test-owned container `day-trader-mvp-phase3` was removed after testing.

## Actual final counts

| Check | Result |
|---|---|
| Verifier regression tests | 10 passed, 0 failed, 0 skipped |
| Backend unit/regression tests | 377 passed, 0 failed, 0 skipped |
| Mongo/HTTP foundation | 4 passed, 0 failed, 0 skipped |
| Mongo order lifecycle | 16 passed, 0 failed, 0 skipped |
| Mongo lifecycle fault boundaries | 9 passed, 0 failed, 0 skipped |
| Mongo protection | 8 passed, 0 failed, 0 skipped |
| Mongo cash/coordinated close/recovery | 17 passed, 0 failed, 0 skipped |
| Real Mongo + STARTTLS SMTP | 4 passed, 0 failed, 0 skipped |
| Historical non-owner HTTP authorization | 1 passed, 0 failed, 0 skipped |
| Durable admission rejection HTTP/Mongo | 1 passed, 0 failed, 0 skipped |
| Frontend unit tests | 34 passed, 0 failed, 0 skipped |
| Controlled HTTP provider contract | 1 passed, 0 failed, 0 skipped |
| Separate-process acceptance | 9 passed, 0 failed, 0 skipped |
| Browser lifecycle acceptance | 14 passed, 0 failed, 0 skipped |
| Browser core-screen matrix | 8 passed, 0 failed, 0 skipped |
| Backend/frontend lockfile installation | Passed |
| Production frontend build | Passed |
| Complete release verifier | Exit 0; 19/19 required gates VERIFIED |

The eight Mongo/HTTP suites total **60 Node test entries**, including five parent suite-container entries (55 substantive child/standalone tests). The negative authorization test makes **30 actual protected HTTP requests**, all 403 with no provider request/write or persisted trading mutation. Backend tests include **12 guarded external-tool tests**, all controlled/no external calls. Frontend tests span **12 suites**. Playwright totals **22 passed, 0 failed, 0 skipped, 0 flaky**. The eight screen scenarios each exercise all nine screens, providing 72 named screen checks in addition to API/source assertions. The nine process scenarios include a browser configure/logout/context-close/reopen path.

## What the acceptance proves

Browser lifecycle: real owner form login, protected routes and revoked cookies; real non-owner form denial; manual acknowledgement/partial/final fill/accounting/reload; accepted timeout/reload/same-key retry and explicit new identical action; broker rejection; partial-fill cancellation; coordinated stop-cancel-confirm-close; core route availability; expiry of an actually issued session; research eligibility/provenance/shared spending; rapid double-click; unfilled cancellation; uncertain stop cancellation blocking overlapping exit; and confirmed admission rejection followed by a corrected ticket.

The separate-process suite proves flat-market abstention, two competing workers producing one entry, disabling during research and immediately before submission, lease loss after decision persistence and immediately before POST, emergency stop during acknowledged and uncertain submissions while preserving unrelated orders, reconciliation with entries disabled, and independent worker activity after browser logout/closure. Decisions, intent, broker order, reservation, audit and notification records are inspected in real Mongo.

The screen matrix covers Home/watchlist, Stock, Research, Trade Plan, Portfolio, Activity, Analytics, RoboTrader and Trading System across loading, valid data, persisted empty data, provider outage, empty/stale market observations, session expiration and backend failure. Real plan/backtest generation is exercised. Actual simulator fixtures with $777 P&L remain in explicitly labeled simulator Analytics, while Alpaca Portfolio shows broker cash/positions/history and Activity shows actual source-filtered fills. Research timestamps/provider provenance and explicit backtest assumptions are visible. Loading observation uses a DOM observer and browser network latency, not manufactured API responses.

SMTP acceptance uses actual outbox code, Nodemailer, real STARTTLS sockets and a loopback capture provider. Three substantive scenarios verify acknowledgement/partial/final/rejected/uncertain/protection events, deduplication, temporary SMTP failure then retry in another process, and killed sending-worker lease recovery. Eight messages were captured. UI states distinguish queued, sending, retrying, provider accepted and failed. This proves local provider acceptance, not external inbox receipt.

## Review, corrections and limits

The first full run correctly failed an old request-key regression fixture after admission rejection became durable. Both original risk refusals remain asserted with distinct keys; old keys stay rejected after settings improve, and only a fresh valid key submits. Its failed report is preserved in `evidence/phase3-first-complete/`. A subsequent full run passed; final review then added refusal of missing/contradictory fill quantities in the external tool, followed by the complete fresh run reported here. No failed, skipped or flaky check was waived. See `evidence/phase3-review.md` for concrete product defects found by browser/review work.

Fresh dependency audit: backend **0 findings**; frontend **57** (28 high, 15 moderate, 14 low, 0 critical). Compatible body-parser and lodash lock updates were installed and tested. Every remaining high is analyzed in `evidence/phase3-security-report.md`; no confirmed deployed static-app runtime exploit path was established in that bounded review. Tooling/developer/CI risks remain deferred, not declared harmless. No forced upgrade or framework migration occurred.

GitHub Actions YAML and bounded semantics passed local validation: Node20, Chromium installation, writable Mongo primary, complete verifier, read-only repository permissions and no broker/SMTP secret references. **Hosted CI NOT RUN**; no push was performed. After separate authorization, the operator can push this branch and run `gh workflow run mvp.yml --ref codex/owner-paper-mvp`, or open a PR. An actual successful hosted run is still required before claiming CI passed.

**External Alpaca acceptance: NOT RUN / BLOCKED BY AUTHORIZATION. External SMTP receipt: NOT RUN / BLOCKED BY AUTHORIZATION. Deployment and deployed operational acceptance: NOT RUN.** No external brokerage order, external email, production deployment, live execution or persistent production activation occurred. Live trading remains disabled. These are separate external/deployment gates, not fabricated local passes. No deterministic local blocker remains in the verified scope.

Machine-readable current report: `evidence/verification/report.json`. Committed final command outputs and browser JSON reports: `evidence/phase3-verification/`. Baseline, financial, UI, security and independent review reports remain alongside them. Secret-pattern and final diff checks are recorded in the final review evidence; they are bounded scans, not an exhaustive security audit.

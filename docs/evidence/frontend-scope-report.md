# Frontend owner-only paper release scope

## Changes

- `/register` now explains owner-only, operator-configured access and links to login. It contains no credential collection or public registration request.
- Login and legacy Navbar no longer offer signup links.
- RoboTrader displays Alpaca paper-only mode; Live is visibly disabled and the opt-in checkbox/confirmation interaction is removed.
- Stocks remain the supported asset category (including ordinary unleveraged ETFs). Crypto, options, fractional automation, extended hours and short-selling controls are disabled with an explanation of the whole-share, long-only, regular-hours release scope.
- Settings defaults, all presets, and outgoing save/enable/preview payloads use paper-only scope. Previously saved unsupported settings produce an explicit warning explaining the difference between saved settings and the supported form, and that saving replaces unsupported values.
- Existing backend and advanced modules were preserved. This frontend task made no backend changes.

## Regression and build evidence

The three new tests in `frontend/src/pages/ReleaseScope.test.js` failed against the original UI: registration still showed a form; login offered signup; Live mode remained enabled. After implementation:

```sh
CI=true npm test --prefix frontend -- --watchAll=false --runInBand
```

**3 suites / 6 tests passed**, including all three new release-scope tests. Evidence: `frontend-scope-unit.txt`.

```sh
cd frontend
CI=true npm run build
```

**Passed**, production bundle generated. Evidence: `frontend-scope-build.txt`.

## Rendered QA

Browser plugin not available; used the repository Playwright workflow. Target: `http://127.0.0.1:3199`. Viewports: desktop 1280×720 and mobile 390×844. All `/api` requests were intercepted with explicit UI contract fixtures; no external provider calls, real account mutation, real authentication, or database persistence are claimed by these browser tests.

The ordinary dev-server command could not bind inside the sandbox. Approved escalation allowed a loopback-only server, but CRA then failed its allowedHosts schema validation. The test server used process-local `DANGEROUSLY_DISABLE_HOST_CHECK=true` while bound to `127.0.0.1`; no production or committed dev-server configuration changed.

The lockfile's expected Chromium headless revision 1208 was not installed. Used existing cached Chromium revision 1234 via `/tmp/day-trader-scope-playwright.config.cjs`, without downloading or changing dependencies. Browser launch required approved escalation because macOS denied Mach port creation in the sandbox.

Final command:

```sh
CI=true E2E_BASE_URL=http://127.0.0.1:3199 npm run test:e2e -- --config=/tmp/day-trader-scope-playwright.config.cjs e2e/release-scope.spec.js --workers=1
```

**2 passed (3.3s)**. Evidence: `frontend-scope-e2e.txt`.

| Check | Result |
| --- | --- |
| Page identity | `/register` and `/robo`, title `DayTrader`, verified |
| Nonblank content | Owner notice and RoboTrader heading rendered |
| Framework overlay | No overlay observed; target interactions succeeded |
| Console/runtime health | No page errors or relevant warning/error console entries; expected unauthenticated `/api/me` 401 fixture excluded |
| Registration interaction | Notice → log in link → login form; no signup link |
| Robo settings interaction | Unsupported controls disabled/unchecked; save produces success state with fixture API |
| Responsive scope panel | Desktop/mobile screenshots inspected; paper-only notice and disabled Live control visible without clipping |

Screenshots outside repository:
- `/tmp/day-trader-owner-register.png`
- `/tmp/day-trader-paper-scope-desktop.png`
- `/tmp/day-trader-paper-scope-mobile.png`

## Remaining scope and findings

This verifies the visible release controls and frontend payload contract. Real MongoDB sessions, broker safety, durable worker behavior, and real backend persistence are separate verification owned by the parent task.

Existing unrelated unavailable-state issue observed with empty health fixtures: RoboTrader shows reconciliation `READY` while health data is absent; some performance counters also default to zero. Those existing behaviors were reported to the parent for the broader MVP acceptance work. No claim is made that all research, portfolio, or advanced-module interfaces have been fully audited.

## Follow-up: unavailable-state correction

The missing-data issue noted above was subsequently fixed in RoboTrader only. Missing Alpaca/worker health shows `Unknown`; reconciliation displays `Ready` only when a valid reconciliation timestamp exists and no discrepancy is reported. Missing performance and reconciliation counters display `Unavailable`, while explicit zero counts remain zero. Missing positions and missing reconciliation lists are distinguished from confirmed empty lists. A failed health/performance/reconciliation refresh clears the previous successful response so stale values cannot continue looking current.

Added three regressions: absent health/performance, explicit zero with a confirmed reconciliation check, and a failed refresh after an earlier success. Before fixes, the two defect regressions failed and the positive case passed. After changes, the full frontend Jest suite passed **3 suites / 9 tests**, recorded in `frontend-unavailable-unit.txt`.

No dev server, browser run or install was started for this follow-up because the parent was coordinating final dependency installation and verification. The earlier browser evidence remains evidence for the release controls; this follow-up has component-level rendered regression coverage and awaits the parent's final build/integration verification.

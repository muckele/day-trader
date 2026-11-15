# Quant Platform Release Scorecard

Evaluated: 2026-08-14
Overall live/production release decision: **NO-GO**
Scoped private Paper MVP decision: **READY_FOR_ISOLATED_STAGING**
Completed milestone: **X0.1 — `PASS`**
Current milestone: **X0.2 — `PAPER-MVP DURABILITY PASS / REAL ALPACA VALIDATION APPROVAL-REQUIRED`**

The scoped Paper MVP decision is supported by the current aggregate, real-Mongo,
fake-broker, browser, smoke, audit, container, and Fly evidence in
[`PAPER_MVP_RELEASE_EVIDENCE.md`](./PAPER_MVP_RELEASE_EVIDENCE.md). The broader
quant/live scorecard remains fail-closed; paper staging readiness does not change the
live or production `NO-GO`.

## Status rules

- `PASS`: every required criterion has direct, current evidence.
- `FAIL`: a directly verified release-blocking criterion is violated.
- `UNKNOWN`: evidence is missing, incomplete, stale, skipped, or not evaluated.
- Missing or unknown evidence is never `PASS`.
- A milestone-level `PASS` does not automatically make a release domain `PASS`.
- `APPROVAL_REQUIRED` is an authorization boundary, not evidence of readiness.

## Domain scorecard

| Domain | Status | Direct evidence | Required before `PASS` |
| --- | --- | --- | --- |
| DATA | `UNKNOWN` | Not evaluated in this cycle. | Point-in-time provenance, requested-history coverage, corporate-action versioning, synthetic-contamination controls, causal timing, hashes, and direct tests. |
| MODEL | `UNKNOWN` | Not evaluated in this cycle. | Versioned model and prompt evidence, calibration, leakage controls, uncertainty/abstention, and locked out-of-sample validation. |
| STRATEGY | `UNKNOWN` | Not evaluated in this cycle. | One executable versioned strategy contract, executable stored parameters, and golden parity across backtest, paper, shadow, and live semantics. |
| RISK | `PASS — PAPER MVP LOCAL / FAIL — LIVE` | The Paper MVP clamps AAPL to $100/order, $250/position, $50/day loss, one position, and one trade/day; mock/stale/wrong-symbol data vetoes; real Mongo proves one cross-path POST boundary and restart freeze. X0.3-X0.5 and funded/live capital controls remain open. | Keep the scoped paper envelope unchanged; complete the later live-only milestones before any funded consideration. |
| EXECUTION | `PASS — PAPER MVP LOCAL / FAIL — LIVE` | `SUBMIT_UNKNOWN`, `NOT_ATTEMPTED`, and confirmed rejection are distinct; original identity and broker request ID are preserved; unknown/orderless claimed intents block replay after restart; fake-broker and real-Mongo tests pass with no skips. No real Alpaca call was authorized. | Separately approve and pass the isolated Alpaca paper contract; complete terminal lifecycle and live-only milestones before live use. |
| OPERATIONS | `PASS — PAPER MVP LOCAL / UNKNOWN — DEPLOYED` | Backend 578/578, frontend 8/8, browser 5/5, smoke 8/8, two Docker builds, and four Fly validations passed; no material skips or orphan process. `/health` and fail-closed `/ready` passed locally. | Provision isolated staging and collect deployed health/readiness/rollback evidence under separate approval. |
| SECURITY | `PASS — PAPER MVP LOCAL / UNKNOWN — DEPLOYED` | Backend/frontend production and full dependency graphs report 0 vulnerabilities. Private registration, single operator, session cookie, trusted-origin, auth/rate-limit/account-scope/input/CSV controls, secret scan, and explicit paper credential/account binding have local evidence. | Validate staging origin/cookie/TLS and exact staging-only secret/account binding without logging secrets. |
| GOVERNANCE | `UNKNOWN` | Three bounded cycles, a chronologically structured current ledger that preserves prior failures/skips, dirty-worktree accounting, two independent final source reviews, and an independent state consistency re-review are current. Because all three state files remain untracked, append-only mutation history cannot be independently proven until a committed or otherwise sealed baseline exists. See `QP-20260723-0027`-`QP-20260723-0037`. | Establish a sealed ledger baseline, then continue append-only evidence, milestone-by-milestone independent acceptance, release controls, and broader governance review. |
| ALPACA_PAPER | `READY_FOR_ISOLATED_STAGING` | Real-Mongo race/restart/lease/index proof and the full socket fake-broker contract pass; exact paper endpoint/credential/account binding is enforced; frozen AAPL preview/submit/reconcile browser flow passes. No Alpaca API was contacted. | Separately approve staging paper reads, then one exact AAPL paper order and its bounded cancellation/Emergency Stop validation. |
| ROBINHOOD_READ | `UNKNOWN` | Search found only a `robinhood` enum placeholder in `backend/models/OrderIntent.js:10`; no connection or schema discovery was attempted. | Explicit approval to connect when reached, runtime schema discovery, official read-only contract, typed fixtures, account binding, and reconciliation evidence. |
| ROBINHOOD_REVIEW | `UNKNOWN` | No review runner or verified contract implementation was found; no review call was attempted. | Separate approval when reached, runtime tool schema, typed preview/warnings, preview hash binding, exact operator confirmation, and reconciliation design. |
| ROBINHOOD_LIVE | `FAIL` | No adapter, live evidence, approval, or release authorization exists. Live action is explicitly `NO-GO` and approval-required. | Every prior gate plus a separate explicit approval for each exact supervised canary order and its maximum exposure. |

## Milestone controls

| Milestone | Status | Evidence and decision |
| --- | --- | --- |
| X0.1 — Disable live replacement | `PASS` | Route and adapter containment, 28 focused passes, 433 backend passes with one known sandbox skip, 0 backend audit vulnerabilities, source search, documentation alignment, and final independent acceptance are recorded in `QP-20260723-0011`-`QP-20260723-0019`. No unresolved X0.1 blocker remains. |
| X0.2 — Unified ambiguous-submit semantics | `PASS — PAPER MVP LOCAL` | The 2026-08-14 cycle closes the prior real-Mongo race/restart/lease/index, exact paper-account binding, and socket fake-broker gaps for the scoped private AAPL MVP. Real Alpaca and all live/funded behavior remain approval-required and outside this pass. |
| X0.3 — Canonical order state machine and event journal | `UNKNOWN` | Not accepted or evaluated in this cycle. |
| X0.4 — Account, endpoint, credential, deployment, policy, and limits binding | `UNKNOWN` | Not accepted or evaluated in this cycle. |
| X0.5 — Global discrepancy circuit breakers | `UNKNOWN` | Not accepted or evaluated in this cycle. |
| Q0-Q9 | `UNKNOWN` | Existing code and documentation are not treated as direct milestone acceptance evidence. |

## Executed validation evidence

| Scope | Result | Release interpretation |
| --- | --- | --- |
| Targeted baseline: `node --test tests/robotraderRoute.test.js tests/robotraderAlpacaBroker.test.js` | 25 passed, 0 failed, 0 skipped | Useful baseline only; no live replacement route test existed. |
| Full backend baseline: `npm test` | 430 passed, 0 failed, 1 skipped | Backend regression baseline with an open loopback fake-broker evidence gap. |
| Focused post-remediation: `node --test tests/robotraderRoute.test.js tests/robotraderAlpacaBroker.test.js` | 28 passed, 0 failed, 0 skipped | Direct route, adapter, mutation, HTTP, and paper-behavior evidence confirmed by final independent review. |
| Full backend post-remediation: `npm test` | 433 passed, 0 failed, 1 skipped | Full executable backend regression passed; known sandbox loopback skip remains open. |
| Backend production dependencies: `npm audit --omit=dev` | 0 vulnerabilities | Backend production graph only; not a frontend or source/runtime security review. |
| Replacement source search | One guarded route call and one guarded PATCH; no alternate application path found | Static call-site evidence confirmed by final independent review. |
| Final independent X0.1 review | `PASS` — no unresolved X0.1 blocker | Acceptance is limited to disabling live replacement; it does not authorize amendments or alter the release `NO-GO`. |
| X0.2 paper focused baseline | 27 passed, 0 failed, 0 skipped | Baseline only; the ambiguity, replay, freeze, polling-failure, and client-ID recovery cases were absent. |
| X0.2 Cycle 2 shared/RoboTrader focus | 71 passed, 0 failed, 0 skipped | Useful implementation evidence, but superseded as acceptance evidence by the independent cross-path challenge failure. |
| X0.2 Cycle 2 shared/paper focus | 48 passed, 0 failed, 0 skipped | Useful path-local evidence; it omitted poll-identity mismatch, cross-path concurrency, durable request retry, and generic-telemetry faults. |
| X0.2 Cycle 2 backend regression | 472 passed, 0 failed, 1 skipped | Regression passed, but the independent review proved untested release blockers; the loopback skip also remains open. |
| X0.2 Cycle 2 independent challenge | `FAIL` | P0 poll-identity and cross-path race findings plus P1 idempotency, telemetry, reconciliation-coverage, and legacy-bypass findings require Cycle 3 remediation. |
| X0.2 final strict classifier/adapters | 46 passed, 0 failed, 0 skipped | Numeric/boolean and other schema-inconsistent fills are unknown through both adapters; canonical bounded decimal-string fills remain accepted. |
| X0.2 account/lease/workflow focus | 182 passed, 0 failed, 0 skipped | Manual, worker, protective, legacy-disable, route, account-scope, idempotency, late-race, and zero-I/O evidence. Real storage is not exercised. |
| X0.2 final ten-file consolidated suite | 236 passed, 0 failed, 0 skipped | Coordinator and two independent audits agreed; source-level X0.2 challenge passed. |
| X0.2 final independent review | `SOURCE PASS_WITH_DURABILITY_GAPS` | No automatic unknown replay, replacement identity, false rejection, malformed fill, or new-risk source bypass remained. Real Mongo, crash/clock, index/migration, account-binding, and real broker evidence remain open. |
| Current full backend serial: `node --test --test-concurrency=1` | 560 passed, 0 failed, 1 skipped (561 total) | All executable backend tests passed; the sandbox-restricted loopback fake-broker test is not counted as pass evidence. |
| Isolated loopback fake broker | 0 passed, 0 failed, 1 skipped | Local socket binding is blocked by the sandbox; rerun with loopback permission. |
| Default backend runner: `npm test` | `INCOMPLETE`, exit 137 | The parallel run stopped making progress and was terminated; it is not pass or fail evidence. |
| Current backend production dependencies | 0 vulnerabilities | Backend production graph only; not a frontend or source/runtime security review. |
| X0.2 syntax, patch, and submit-path search | `PASS_WITH_SCOPE_LIMITS` | Syntax and diff checks passed; two order-creation POST implementations and their reviewed callers were found, with legacy direct Alpaca disabled. Static evidence is not runtime proof. |
| Frontend tests/build/e2e | Not run | `UNKNOWN`; no positive claim. |
| Frontend dependency audit | Not run | `UNKNOWN`; no positive claim. |
| Container builds and Fly validation | Not run | `UNKNOWN`; no positive claim. |
| GitHub Actions CI | Not run | Workflow configuration was inspected only. |
| External broker checks | Not run and not authorized | No broker readiness or behavior claim. |

X0.1 `PASS` and the X0.2 source pass do not change the overall `NO-GO`. `RISK` and
`EXECUTION` remain `FAIL` until X0.2 durability evidence and the remaining X0 release
blockers are directly resolved. The three-cycle boundary is exhausted; X0.3 was not
started.

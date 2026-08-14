# Quant Platform Implementation State

Last updated: 2026-08-14
Repository: `day-trader-sprint1`
Baseline branch: `codex/sprint1-policy-approval`
Starting baseline HEAD: `058f962cc0bdd48a084be33fe379763f81a59f27`
Current local code HEAD before this documentation commit:
`627c1a2f8c67b04a0a3712b072807a85999b3659`
Release posture: **NO-GO for all live trading**
Paper MVP posture: **READY_TO_PUSH_FOR_REMOTE_CI**

Current Paper MVP evidence and the final-SHA release ladder are recorded in
[`PAPER_MVP_RELEASE_EVIDENCE.md`](./PAPER_MVP_RELEASE_EVIDENCE.md). This scoped
decision closes the locally achievable paper-only stabilization gates; it does not
promote any live, funded, production, profitability, compliance, or autonomous
milestone.

## Program objective

Build an evidence-driven quantitative research, portfolio-risk, and broker-execution
platform that can discover whether a reproducible after-cost edge exists, reject false
edges, bound losses, and fail safely.

## Non-negotiable boundaries

- All live trading remains **NO-GO**.
- No live broker connection, authentication, order review, placement, cancellation,
  replacement, deployment, secret change, or funded-account mutation is authorized.
- No risk or capital limit may be widened.
- Promotion is manual; demotion is automatic.
- Missing, stale, skipped, or unknown evidence is not `PASS`.
- Preserve every pre-existing user change. Do not reset, delete, overwrite, stage, or
  reformat unrelated work.
- A passing software suite does not override a failed data, research, risk, execution,
  paper, shadow, security, operations, or governance gate.

## Current milestone

Milestone: **X0.2 — Unify ambiguous-submit semantics for the Paper MVP**
Status: `PASS — PAPER_MVP_LOCAL / REMOTE_CI_AND_REAL_ALPACA_REQUIRED`
Current cycle: Paper MVP stabilization, 2026-08-14
Cycle status: `COMPLETED — SIX LOCAL COMMITS APPROVED; PUSH NOT AUTHORIZED`
Initialized: 2026-07-23

The prior Cycle 3 source-pass/durability-open record below remains as historical
evidence. The 2026-08-14 cycle added a real temporary MongoDB primary race, restart
and orphan-intent freeze proof, renewed/expired lease proof, compatible legacy index
creation, a zero-skip loopback fake-broker matrix, exact paper account binding,
trusted-data gating, the frozen AAPL two-step workflow, clean aggregate/browser/
container/config/audit evidence, and an ordered operator/deployment runbook. The
committed backend scope passes 563 tests, the committed frontend scope passes 6 unit
tests and 5 browser tests, and the durable integration suites have no skips. Real Alpaca
paper validation remains an explicit external-authorization boundary, not a local
test gap that was called passed.

### Acceptance criteria

- Main entry, protective exit, and Alpaca-synced paper submission use one shared,
  fail-conservative classification contract.
- Payload/configuration failure proven to occur before broker I/O is distinguished
  from broker-confirmed rejection and from an ambiguous request outcome.
- Timeout, no response, duplicate client identity, HTTP 408/425/429/5xx, supported
  transport failures, malformed acknowledgement, and any unproven post-attempt outcome
  become the exact durable state `SUBMIT_UNKNOWN`.
- Each path durably persists one original client-order identity and attempt claim
  before broker I/O. An unresolved or legacy pending attempt never mints or submits a
  replacement identity.
- An unresolved unknown is queryable by broker account and environment and blocks
  every new submission before broker I/O, including a different symbol. Reads,
  reconciliation, cancellation/emergency controls, and lookup of an existing
  protective order remain available.
- Protective submission ambiguity stays pending and non-retryable. Confirmed
  protective rejection is also not automatically replayed; a later order requires a
  separately modeled and approved command/intent.
- Reconciliation uses only the original external order ID or original client order ID.
  Lookup timeout, 404, 429, or 5xx retains `SUBMIT_UNKNOWN`; no lookup branch submits
  an order or authorizes a new identity.
- A successful broker POST followed by a polling failure retains the acknowledgement
  and broker ID. A persistence or audit failure after acknowledgement cannot rewrite
  the submission as rejected.
- Paper unknowns remain open, create no rejected execution telemetry, and produce no
  fill/trade. Both paper routes return a stable typed unknown response and do not
  create duplicate rejection records.
- Every post-submit status response must match the immutable client identity and the
  acknowledged external order identity. Empty, malformed, or mismatched polling
  responses retain the original acknowledgement and require later reconciliation.
- Manual Alpaca-paper commands persist a caller-supplied idempotency key under a
  unique account/broker/key invariant before broker I/O. Repeating the same command
  returns the original attempt after unknown, reconciliation, fill, or rejection and
  never mints another broker identity.
- Manual Alpaca-paper and RoboTrader Alpaca-paper submissions share one durable
  account lock and inspect unresolved rows from both order collections before I/O.
  A concurrent cross-path race can produce at most one broker POST.
- Only an affirmative broker-confirmed rejection may create broker-rejected
  execution telemetry. Preflight, configuration, lock, persistence, unknown, and
  post-ack local failures create no rejected broker record or synthetic fill.
- Focused classifier, main-entry, protective-stop, paper-client, paper-broker, and
  route fault tests pass; relevant backend regression and dependency audit evidence is
  recorded with every skip explicit.
- Independent review finds no automatic unknown replay, client-identity replacement,
  false-rejection path, or new-risk submission bypass.
- The scoped Paper MVP X0.2 criteria are `PASS` locally. Broader live lifecycle,
  production migration, and real-broker criteria remain outside this scoped pass.

## Verified findings and remediation history

### X0.2-F005 — Cycle 2 independent challenge found cross-path P0 gaps

Severity: **P0 / critical**

- The Cycle 2 focused implementation passed 71 RoboTrader/shared tests, 48 paper/shared
  tests, and the 472-test backend regression it could execute, but the independent
  challenge found missing adversarial invariants.
- Paper status polling trusted an empty or mismatched HTTP 200 body and could replace
  the external and client identities established by the POST acknowledgement.
- `RoboTradeOrder` and `PaperOrder` unresolved checks were isolated, while the worker
  lock and paper account lock were different. Manual and automated Alpaca-paper paths
  could therefore race and both submit for the same account.
- Manual routes had no durable request idempotency key, so a retry after an unknown
  was reconciled to submitted could mint a new client identity and POST again.
- Generic route and legacy-engine catches could still create false broker-rejection
  telemetry for pre-submit, coordination, unknown, or post-ack local failures.
- The legacy RoboTrader engine retained a separate direct Alpaca POST path outside the
  new submission-state contract.

Decision: the Cycle 2 result is `FAIL`, not promotion evidence. Cycle 3 must remediate
these findings and pass a fresh independent challenge; otherwise X0.2 remains failed.

### X0.2-F006 — Cycle 3 remediation contract supersedes deferred-lock decisions

The final allowed local cycle will:

- validate every status poll against both immutable correlation identities and retain
  the original acknowledgement on any anomaly;
- use the existing durable paper-account lock as the shared Alpaca-paper critical
  section for manual and RoboTrader submissions, and query both order collections;
- persist a route idempotency key with a unique partial account/broker/key invariant
  before broker I/O and return the existing attempt for every same-key retry;
- make `NOT_ATTEMPTED` explicit with zero attempts, no `filledAt`, and no rejected
  execution telemetry, while reserving rejection telemetry for
  `REJECTED_CONFIRMED`;
- keep every client identity immutable and reconcile all open client-ID-only rows;
- fail closed the legacy direct Alpaca execution branch rather than attempting to
  retrofit another submission path inside X0.2.

This supersedes X0.2-F004's claims that separate path-local unresolved rows were
sufficient and that HTTP idempotency could be deferred. A production index build
still requires a separate legacy-duplicate audit and controlled migration; no
deployment or external database mutation is authorized in this loop.

### X0.2-F007 — Cycle 3 source containment implemented

The Cycle 3 implementation now provides one fail-conservative submission boundary for
manual Alpaca-paper entry, modern RoboTrader entry, and protective submission:

- `backend/services/submissionOutcomeService.js:26-279` recognizes only canonical
  broker statuses and string identities; distinguishes `NOT_ATTEMPTED`,
  `REJECTED_CONFIRMED`, and exact `SUBMIT_UNKNOWN`; and requires strict
  decimal-string fill evidence coherent with the immutable requested quantity or
  notional.
- `backend/services/alpacaPaperSubmissionGuardService.js:33-155` queries unresolved
  rows across both `PaperOrder` and `RoboTradeOrder` and supplies one owner-scoped,
  expiring, strictly renewable durable Alpaca-paper account lease.
- `backend/models/PaperOrder.js:9-79` persists the original client identity,
  idempotency key and fingerprint, submission state and attempt evidence, plus unique
  partial account/broker/idempotency and broker/client-identity indexes.
- Manual paper, modern worker, and protective workflows persist a pending identity,
  renew or validate coordination, and repeat the bidirectional unresolved check before
  broker I/O. Lease loss, coordination failure, or a late unresolved row is durably
  `NOT_ATTEMPTED` with zero broker attempts.
- Both paper HTTP routes forward the caller's idempotency key and return the stable
  typed unknown contract without synthesizing broker-rejection telemetry.
- Reconciliation uses only the persisted external ID or original client-order ID,
  retains unknown on inconclusive lookup, and cannot manufacture a fill or replacement
  identity from malformed broker data.
- Generated client-order IDs stay within Alpaca's 48-character limit while preserving
  timestamp and cryptographic-entropy suffixes; oversized caller IDs fail before I/O.
- The legacy direct Alpaca execution branch is disabled with
  `LEGACY_ALPACA_EXECUTION_DISABLED`.

This is source containment, not evidence that deployed indexes, real storage failure
semantics, or broker behavior satisfy the same contract.

### X0.2-F008 — Cycle 3 independent challenge findings were remediated

The independent reviewer initially withheld acceptance and repeatedly challenged:

- username/ObjectId/default account-scope divergence;
- missing final lease renewal and late unresolved checks after durable row creation;
- coordination exceptions or zero-I/O adapter failures recorded as attempted;
- duplicate-client error variants and weak 4xx rejection classification;
- missing, malformed, mismatched, padded, or non-string correlation identities;
- unrecognized or malformed status payloads;
- a live protective path that did not share the unresolved latch;
- client-order IDs exceeding the broker's documented length;
- coercive, missing, impossible, overfilled, underfilled, unbounded, or
  schema-inconsistent fill evidence;
- reconciliation rows that had only one original correlation identity.

Each credible challenge was treated as a failed gate, remediated, and rerun. The final
strict-type remediation accepts broker fill quantities and prices only as canonical
decimal strings; numeric, boolean, object, hexadecimal, signed, scientific, blank,
overflowing, or incoherent values remain unknown and create no fill or protection.

### X0.2-F009 — Final source verdict passes; durable integration evidence remains open

Two independent post-remediation audits returned `PASS` for the reviewed X0.2 source
paths. The consolidated ten-file suite passed 236 tests with zero failures or skips,
and the final full serial backend run passed 560 of 561 tests with the single known
sandbox-restricted loopback fake-broker test skipped. The backend production
dependency audit reported zero vulnerabilities.

No reviewed source path still automatically replays unknown, replaces the original
identity, creates rejection telemetry without affirmative broker evidence,
manufactures a fill from malformed evidence, or bypasses the unresolved latch to add
new risk.

The milestone nevertheless remains `IN_PROGRESS`. Direct durable evidence is still
missing for a real MongoDB-primary cross-workflow race, process-kill/restart windows,
multi-process or clock-skew lease expiry, production unique-index creation and legacy
data compatibility, and exact broker-account binding. Positive fills attached to
terminal non-fill lifecycle statuses are conservatively frozen for X0.3 rather than
fully journaled and protected.

Historical note: X0.2-F001 through X0.2-F004 below record the Cycle 2 baseline and
contract for traceability. They do not describe the final Cycle 3 source. X0.2-F006
through X0.2-F009 supersede their implementation claims while preserving the original
failed findings.

### X0.2-F001 — Main-entry handling is partially contained but lacks a durable freeze

Severity: **P1 / high**

- `backend/robotrader/worker.js:1071-1110` persists the main-entry client identity and
  pending order before broker I/O.
- `backend/robotrader/worker.js:1231-1272` keeps selected ambiguous errors pending and
  preserves the client identity, while an explicit 422 becomes rejected.
- `backend/robotrader/reconciliation.js:481-488` can recover a main entry by its
  original client ID and does not resubmit it.
- The ambiguity predicate is fragmented across `pending_submit`,
  `submit_error_pending_reconciliation`, `submission_uncertain`, and
  `SUBMISSION_UNCERTAIN`; there is no exact durable `SUBMIT_UNKNOWN` field.
- Recent local orders are limited to 24 hours and only provide trade-count and
  same-symbol cooldown effects. A later decision, including a different symbol, can
  submit while broker truth remains unresolved.
- The submit catch encloses persistence, lifecycle, protection, decision, and audit
  work after the broker call; a downstream local failure can be mislabeled as a broker
  submit failure.

### X0.2-F002 — Protective ambiguity can create duplicate exits

Severity: **P0 / critical**

- `backend/robotrader/reconciliation.js:387-413` converts every protective-submit
  exception to `rejected`, including timeout, reset, 408, 429, and 5xx.
- `backend/robotrader/reconciliation.js:12,241-245` makes rejected protection
  retryable.
- `backend/robotrader/reconciliation.js:282-351` generates a new client ID and
  overwrites the same local parent/exit record before replay.
- A first stop accepted with a lost response can therefore coexist with a second sell
  stop under a new identity, risking an over-close and unintended short exposure.
- The existing test at `backend/tests/robotraderReconciliation.test.js:385-443`
  explicitly expects the unsafe new identity and must be replaced.

### X0.2-F003 — Alpaca-synced paper ambiguity becomes false rejection

Severity: **P0 / critical evidence-integrity blocker**

- `backend/paper/paperBrokerClient.js:1182-1201` correctly persists a client identity
  and pending local paper order before broker I/O.
- `backend/paper/paperBrokerClient.js:1221-1235` converts every thrown submission
  error to local and telemetry rejection.
- `backend/services/alpacaTradingClient.js:231-262` places POST and subsequent polling
  inside one catch. A polling failure after a successful POST discards the known broker
  acknowledgement and becomes rejection.
- `backend/paper/paperBrokerClient.js:565-622` requires an external order ID and cannot
  recover a pending/unknown paper order by its original client ID.
- The transient account mutex is always released and no durable unresolved-state
  predicate blocks a later request from generating a fresh random client ID.
- `backend/routes/trade.js:40-51` also records a second rejection even when the paper
  broker already persisted the outcome.

### X0.2-F004 — Cycle 2 contract decision

The smallest coherent implementation will:

- add one shared outcome classifier and exact `SUBMIT_UNKNOWN` constant;
- add an additive `submissionState` field to `RoboTradeOrder` and `PaperOrder`, while
  treating legacy pending ambiguity as unresolved for compatibility;
- use each unresolved order row itself as the durable, account-scoped fail-closed
  latch; no separate lock model is required for this cycle;
- disable all automatic protective replay instead of designing a new amendment or
  replacement-intent lifecycle inside X0.2;
- make all unknown reconciliation lookup-only and retain unknown after a single 404;
- preserve successful paper POST acknowledgement when later polling fails;
- return HTTP `409` with stable code `SUBMIT_UNKNOWN` for an unresolved paper outcome
  or account freeze;
- defer a general paper HTTP idempotency-key/index migration until legacy duplicates
  can be audited safely. The durable account freeze and one-attempt local row must
  still prove zero replay for the X0.2 paths.

### X0.1-F001 — Live replacement was not contained at baseline

Severity: **P0 / critical**

- `backend/routes/robotrader.js:1001-1035` registered the order-replacement route.
- The baseline live branch at `backend/routes/robotrader.js:1010-1015` checked
  broker-operator identity and settings-level live opt-in, then invoked
  `broker.replaceOrder(...)`.
- `backend/routes/robotrader.js:155-170` showed that the settings helper checked only
  live mode and explicit settings opt-in.
- The baseline replacement route did not check or claim the deployment live flag, a
  controlled-live activation, an attempt, a new immutable intent/fingerprint, exact
  authorization, or a fresh notional/exposure/risk envelope.
- `backend/robotrader/alpacaBroker.js:104-150` accepted replacement economic fields
  including quantity, price, stop, trailing, time-in-force, and client-order identity.
- `backend/robotrader/alpacaBroker.js:207` issued `PATCH /v2/orders/:orderId`.

Baseline decision at initialization: release remained `NO-GO`; X0.1 was
`IN_PROGRESS`.

### X0.1-F002 — Baseline tests did not prove live replacement containment

The narrow relevant suite passed, but no pre-existing route test sent a live
replacement request or proved that replacement broker I/O was unreachable.

The full backend baseline also passed all tests it could execute, but one loopback
fake-paper-broker integration test was skipped because the sandbox prohibited the
required socket operation. That skip is not replacement-containment evidence.

### X0.1-F003 — Route and broker-adapter containment implemented

- `backend/robotrader/alpacaBroker.js:105-113` defines
  `assertOrderReplacementAllowed`, which throws HTTP `409` with stable code
  `LIVE_ORDER_REPLACEMENT_DISABLED` for live mode.
- `backend/routes/robotrader.js:1004-1035` invokes that guard immediately after the
  authenticated, user-scoped order lookup and before external-order-ID validation,
  broker construction, payload handling, local mutation, save, or audit creation.
- `backend/robotrader/alpacaBroker.js:218-221` invokes the same guard inside the
  adapter before replacement-payload sanitization and the broker PATCH request.
- Focused tests cover legacy flags/settings/operator permutations, missing broker
  identity, invalid and widening payloads, no settings read, no save, no audit write,
  no HTTP call, unchanged local fields, and one preserved paper replacement PATCH.
- Source search found exactly one application route call to `replaceOrder` and exactly
  one replacement PATCH implementation; both are preceded by the live-mode guard.

Decision: code containment is implemented and the baseline reachable path is no longer
present in the searched application code. This does not implement or authorize live
amendments.

### X0.1-F004 — Initial independent challenge and remediation

The first independent challenge accepted the route and adapter containment design but
withheld milestone acceptance because the route immutability assertion did not yet
include `lastReconciledAt`, and final regression, audit, documentation, state, and
re-review evidence were incomplete.

`backend/tests/robotraderRoute.test.js:639,656,688` now seeds, snapshots, and compares
`lastReconciledAt` across every blocked live-replacement scenario. Focused and full
backend suites passed after that remediation.

### X0.1-F005 — Final independent acceptance

The final independent reviewer re-examined the route and adapter guards, stable
response contract, route-state immutability assertions including `lastReconciledAt`,
no-settings/no-save/no-audit/no-HTTP evidence, preserved paper replacement behavior,
focused and full backend results, dependency audit, source-search result,
documentation alignment, and persistent evidence.

Result: `PASS`. No unresolved X0.1 blocker remains. Entry
The historical Cycle 1 review record contains the independent gate decision.

This acceptance is limited to disabling live replacement. It does not implement a
live amendment lifecycle, resolve X0.2-X0.5, authorize a broker action, or change the
overall `NO-GO` release posture.

### GOV-F001 — Persistent program state was absent

At initialization, `docs/quant-program/` and all three required state files were
absent. This governance wave created the state files; it does not establish any prior
milestone `PASS`.

### GOV-F002 — Worktree overlap

Before program-state initialization, the actual nested repository had 80 modified
tracked files and 29 untracked files. X0.1-relevant files already containing user work
included:

- `backend/routes/robotrader.js`
- `backend/tests/robotraderRoute.test.js`
- `backend/robotrader/alpacaBroker.js`
- `backend/tests/robotraderAlpacaBroker.test.js`
- `backend/README.md`

The repository is `/Users/Matt/Documents/Codex Agentic Trading/day-trader-sprint1`.
The directory above it is a different, empty Git repository and must not be used as
the program's Git-state source.

### GOV-F003 — Repository instructions

No applicable `AGENTS.md` was found by the initialization scan. System, user, and
program authorization boundaries remain fully applicable.

## Decisions and rejected alternatives

Cycle 2 X0.2 contract:

- Use one shared submission-outcome service for worker, protective, and paper paths.
- Store exact `SUBMIT_UNKNOWN` in an additive `submissionState` model field and retain
  compatible local lifecycle statuses until X0.3 defines the complete state machine.
- Treat 408, 425, 429, 5xx, duplicate identity, network/no-response failures, and
  malformed acknowledgements conservatively as unknown.
- Require structured affirmative 4xx broker evidence for broker-confirmed rejection;
  mark proven local preflight failures as not attempted.
- Persist one order/client identity before I/O and query unresolved rows immediately
  before any later submission.
- Remove automatic protective replay, including after confirmed rejection.
- Keep a 404 lookup unresolved; a 404 is not a terminal broker rejection and cannot
  license a replay.
- Separate broker-call classification from later persistence, polling, lifecycle, and
  audit failures.

Cycle 3 X0.2 remediation contract:

- Use one durable account lease and one bidirectional unresolved predicate across
  manual paper, modern worker, and protective paths.
- Persist the original identity before I/O, then renew coordination and recheck the
  unresolved latch immediately before dispatch.
- Require caller-supplied paper idempotency keys and exact request fingerprints;
  return the original durable attempt for every same-command retry.
- Accept only canonical broker identifiers, official lowercase statuses, and
  strict decimal-string fill fields with an immutable quantity or notional bound.
- Treat missing, malformed, duplicate, incoherent, or schema-inconsistent broker
  evidence as unknown and non-replayable.
- Keep confirmed protective rejection non-retryable until a separately modeled
  command/intent exists.
- Disable the legacy direct Alpaca submission path instead of creating a fourth
  lifecycle implementation.
- Keep X0.2 `IN_PROGRESS` after source acceptance until real-storage durability,
  index/migration, and broker-account binding evidence is direct.

Rejected for X0.2:

- Keeping three independent ambiguity classifiers or vocabularies.
- Treating `LIVE_TRADING_ENABLED=false`, a 24-hour history window, same-symbol cooldown,
  transient account mutex, or broker open-order list as the durable freeze.
- Rewriting an unknown outcome as rejected to simplify existing analytics.
- Reusing a local protective row while replacing its top-level client identity.
- Automatically retrying a confirmed protective rejection without a new approved
  command/intent.
- Clearing unknown after one broker 404.
- Deploying a unique paper client-ID or idempotency index without first auditing
  legacy duplicates. The schema invariant may be implemented and tested locally, but
  production index creation remains a migration gate.
- Treating a mocked lease unit test as proof of multi-process crash consistency.
- Using application ObjectIds, `default`, or an inferred broker identity when the
  canonical stored username is unavailable.
- Accepting JSON numbers or JavaScript-coercible broker fill fields as broker truth.
- Treating a canceled/expired/replaced response carrying positive fill data as a
  complete lifecycle before X0.3 defines append-only fill and order events.

Implemented X0.1 approach:

- Use one stable `assertOrderReplacementAllowed` guard and reason code at both the
  authenticated route and broker-adapter boundary.
- Guard immediately after authenticated user-scoped order lookup so live requests fail
  before external-order-ID, operator, settings, deployment-flag, or payload branches.
- Retain the adapter guard as defense in depth so a future direct adapter caller also
  fails before payload validation or HTTP.
- Return HTTP `409` with `LIVE_ORDER_REPLACEMENT_DISABLED`.
- Prove that legacy flag/settings/operator combinations cannot reach broker
  replacement or mutate local order state.
- Preserve a single sanitized paper replacement PATCH; do not broaden non-live
  behavior.

Rejected for X0.1:

- Relying only on `LIVE_TRADING_ENABLED=false`.
- Treating settings-level live opt-in as containment.
- Removing all replacement primitives and thereby changing paper behavior.
- Designing the complete immutable amendment lifecycle in the same first change.
- Weakening another gate, adding a neutral fallback, or documenting the defect as if
  documentation alone contained it.

## Historical Cycle 1–3 file accounting

Cycle 1 governance initialization created:

- `docs/quant-program/IMPLEMENTATION_STATE.md`
- `docs/quant-program/EVIDENCE_LEDGER.md` (historical shared-worktree ledger;
  intentionally outside the Paper MVP release commit)
- `docs/quant-program/RELEASE_SCORECARD.md`

Scoped X0.1 containment, test, and documentation hunks were then added to these
already-dirty or untracked files:

- `backend/robotrader/alpacaBroker.js`
- `backend/routes/robotrader.js`
- `backend/tests/robotraderAlpacaBroker.test.js`
- `backend/tests/robotraderRoute.test.js`
- `backend/README.md`
- `docs/quant-platform-research-blueprint.md`
- `docs/paper-to-robinhood-agentic-rollout.md`

Scoped X0.2 Cycle 2 and Cycle 3 implementation/test hunks were added to:

- `backend/models/PaperOrder.js`
- `backend/models/RoboTradeOrder.js`
- `backend/paper/paperBrokerClient.js`
- `backend/robotrader/alpacaBroker.js`
- `backend/robotrader/reconciliation.js`
- `backend/robotrader/worker.js`
- `backend/routes/paperTrades.js`
- `backend/routes/trade.js`
- `backend/services/alpacaPaperSubmissionGuardService.js`
- `backend/services/alpacaTradingClient.js`
- `backend/services/roboTraderEngine.js`
- `backend/services/submissionOutcomeService.js`
- `backend/services/tradingIndexService.js`
- `backend/tests/accountScope.test.js`
- `backend/tests/alpacaPaperSubmissionGuardService.test.js`
- `backend/tests/alpacaTradingClient.test.js`
- `backend/tests/paperBrokerClient.test.js`
- `backend/tests/roboScheduler.test.js`
- `backend/tests/roboTraderEngine.test.js`
- `backend/tests/robotraderAlpacaBroker.test.js`
- `backend/tests/robotraderReconciliation.test.js`
- `backend/tests/robotraderWorker.test.js`
- `backend/tests/submissionOutcomeService.test.js`
- `backend/tests/tradeRoutes.test.js`

The shared pre-existing `backend/models/PaperAccountLock.js` and
`backend/utils/accountScope.js` primitives were reused. The repository remains a
shared dirty worktree: at the final accounting point it had 92 modified tracked files
and 34 untracked paths. These counts include extensive pre-existing user work and do
not attribute every dirty hunk to this program. At that historical Cycle 3 accounting
point, nothing was staged or committed.

No deployment, secret, live flag, broker account, or external system was changed.

## Historical Cycle 1–3 tests

| Date | Command | Result | Important skips and limitations |
| --- | --- | --- | --- |
| 2026-07-23 | `cd backend && node --test tests/robotraderRoute.test.js tests/robotraderAlpacaBroker.test.js` | `PASS` — 25 passed, 0 failed, 0 skipped | No pre-existing test exercised a live replacement request. |
| 2026-07-23 | `cd backend && npm test` | `PASS_WITH_SKIP` — 430 passed, 0 failed, 1 skipped | The loopback fake-paper-broker integration test was skipped because the sandbox restricted the required socket operation. The skip is not `PASS` evidence for that fault path. |
| 2026-07-23 | `cd backend && node --test tests/robotraderRoute.test.js tests/robotraderAlpacaBroker.test.js` | `PASS` — 28 passed, 0 failed, 0 skipped | Post-change focused rerun after the `lastReconciledAt` assertion remediation. |
| 2026-07-23 | `cd backend && npm test` | `PASS_WITH_SKIP` — 433 passed, 0 failed, 1 skipped | Post-remediation full backend rerun. The same loopback fake-paper-broker integration test was skipped because the sandbox restricted the required socket operation. |
| 2026-07-23 | `cd backend && npm audit --omit=dev` | `PASS` — 0 vulnerabilities | Backend production-dependency audit only; this is not a frontend audit or runtime security review. |
| 2026-07-23 | `cd backend && npm test` | `INCOMPLETE / NOT_PASS` — the default parallel run stopped making progress and was terminated; shell exit 137 | This interrupted command is not regression evidence. The deterministic serial command below completed. |
| 2026-07-23 | `cd backend && node --test --test-concurrency=1 tests/submissionOutcomeService.test.js tests/alpacaTradingClient.test.js tests/robotraderAlpacaBroker.test.js` | `PASS` — 46 passed, 0 failed, 0 skipped | Strict status, correlation, fill-shape, fill-bound, and adapter propagation faults, including numeric/boolean broker fill fields. |
| 2026-07-23 | `cd backend && node --test --test-concurrency=1 tests/accountScope.test.js tests/alpacaPaperSubmissionGuardService.test.js tests/paperBrokerClient.test.js tests/tradeRoutes.test.js tests/roboTraderEngine.test.js tests/robotraderWorker.test.js tests/robotraderReconciliation.test.js` | `PASS` — 182 passed, 0 failed, 0 skipped | Account scope, shared lease, idempotency, late-race, zero-I/O, reconciliation, worker, and protective workflow evidence. Storage is mocked/in-memory, not a real multi-process MongoDB primary. |
| 2026-07-23 | `cd backend && node --test tests/submissionOutcomeService.test.js tests/alpacaPaperSubmissionGuardService.test.js tests/alpacaTradingClient.test.js tests/paperBrokerClient.test.js tests/tradeRoutes.test.js tests/robotraderAlpacaBroker.test.js tests/robotraderWorker.test.js tests/robotraderReconciliation.test.js tests/roboTraderEngine.test.js tests/roboScheduler.test.js` | `PASS` — 236 passed, 0 failed, 0 skipped | Coordinator rerun and two independent audits agreed. This is the final X0.2 source-focused suite. |
| 2026-07-23 | `cd backend && node --test --test-concurrency=1` | `PASS_WITH_SKIP` — 560 passed, 0 failed, 1 skipped (561 total) | Current full serial backend regression. The loopback fake-paper-broker integration remains skipped by sandbox socket restrictions. |
| 2026-07-23 | `cd backend && node --test --test-concurrency=1 tests/robotraderFakeBroker.integration.test.js` | `SKIP` — 0 passed, 0 failed, 1 skipped | Exact skip: local socket binding is blocked by this sandbox; rerun with local loopback permission. |
| 2026-07-23 | `cd backend && npm audit --omit=dev` | `PASS` — 0 vulnerabilities | Current post-Cycle 3 backend production-dependency audit only. |
| 2026-07-23 | `node --check` on the shared outcome, account guard, both Alpaca adapters, paper broker, worker, reconciliation, legacy engine, and both paper routes; then `git diff --check` | `PASS` | Syntax and patch-whitespace validation only; not runtime or external-system evidence. |

Not run or not established by the historical Cycle 3 state:

- frontend unit tests;
- frontend production build;
- browser/e2e tests;
- frontend dependency audit;
- container builds;
- Fly configuration validation;
- GitHub Actions CI;
- real MongoDB multi-process/concurrency/crash/clock-skew fault injection;
- deployed unique-index and historical-data compatibility audit;
- any broker connection, broker authentication, account read, order review, or order
  write.

## 2026-08-14 Paper MVP stabilization state

The current cycle resolved the historical local durability gaps without contacting a
broker or remote database:

- exact committed backend scope: 563 passed, 0 failed, 0 skipped;
- temporary real-Mongo replica-set proof: one admitted cross-path POST, preserved
  correlation across restart, orphan-intent restart freeze, lease renewal/expiry and
  compatible legacy index creation;
- loopback fake-broker proof: 2 passed, 0 failed, 0 skipped;
- isolated API smoke: 8/8;
- exact committed frontend scope: 6 unit tests and 5 browser tests passed;
- frontend production build: 743 modules transformed;
- backend and frontend production audits: 0 vulnerabilities; and
- five approved code commits plus this documentation commit, with cached-diff review
  and no push.

The exact endpoint/account boundary now uses the broker account as the shared scope
for release paper submissions. Generic credential fallback is rejected in
staging/production. Ambiguous outcomes retain the original identity and block new
account risk until reconciliation.

The former Cycle 3 resume record is preserved above as historical evidence; it is
superseded for current work by this section and the Paper MVP release ledger.

## Current unresolved risks

- Remote GitHub Actions have not run for the final six-commit SHA.
- No staging apps, staging-only MongoDB, Fly network path, complete secret manifest,
  private operator, or frozen parameter record has been provisioned.
- No exact-final-SHA release artifact has been deployed.
- No Alpaca API was contacted. Actual paper account binding, data entitlement,
  headers, acknowledgement, status, reconciliation and cancellation remain unknown.
- Live amendments remain unimplemented and prohibited. The live replacement guard is
  containment, not a complete amendment lifecycle.
- Broader terminal-state journaling, funded/live controls, strategy-edge evidence,
  point-in-time research data and autonomous-capital governance remain outside the
  Paper MVP pass.
- Container base tags are mutable. Docker's normal buildx metadata remains root-owned.
  Upstream deprecation warnings remain even though production audits are clean.
- The worktree still contains unrelated user-owned controlled-live and research work.
  It must not be blanket-staged or attributed to this release.

Overall live and production posture remains `NO-GO`.

## Next highest-priority safe action

After a separate push approval, require GitHub Actions to pass for the exact final
SHA. Only then decide and provision the isolated MongoDB/Fly network path. Continue
in the approval-gated order documented in
[`../robotrader-prelive-test-plan.md`](../robotrader-prelive-test-plan.md): complete
secret manifest, exact artifact deployment, private operator and parameter
provisioning, Alpaca read-only checks, zero-write preview, and exactly one separately
approved AAPL paper order.

## Current resume record

`cycle=paper-mvp-stabilization|milestone=X0.2|local=PASS|live=NO_GO|backend=563_pass_0_fail_0_skip|frontend=6_pass|browser=5_pass|mongo=PASS|fake_broker=2_pass|external=NOT_RUN|next=push_approval_then_exact_sha_ci`

# Quant Platform Evidence Ledger

This file is append-only. Never delete, reorder, or rewrite an earlier entry to turn a
failure, skip, or unknown result into a pass. Append remediation, correction, rerun,
and gate-decision entries under new IDs. Each entry records what was directly
observed, its limits, and the decision it supports.

## QP-20260723-0001 — Repository instruction and state discovery

- Date: 2026-07-23
- Milestone: X0.1
- Type: `GOVERNANCE_FINDING`
- Result: `OBSERVED`
- Evidence:
  - `rg --files -uu -g 'AGENTS.md' -g '!**/node_modules/**'` found no applicable
    repository instruction file.
  - `docs/quant-program/` did not exist.
  - `IMPLEMENTATION_STATE.md`, `EVIDENCE_LEDGER.md`, and `RELEASE_SCORECARD.md` were
    absent.
- Decision: initialize persistent state; do not infer any prior milestone `PASS`.
- Limitation: absence of `AGENTS.md` does not waive system, user, authorization, or
  safety boundaries.

## QP-20260723-0002 — Dirty-worktree baseline

- Date: 2026-07-23
- Milestone: X0.1
- Type: `GOVERNANCE_FINDING`
- Result: `OBSERVED`
- Evidence:
  - Repository: `/Users/Matt/Documents/Codex Agentic Trading/day-trader-sprint1`
  - Branch: `codex/sprint1-policy-approval`
  - Upstream: `origin/codex/sprint1-policy-approval`
  - HEAD: `058f962` (`Complete controlled-live trading readiness`)
  - Modified tracked files before program-state initialization: 80
  - Untracked files before program-state initialization: 29
  - X0.1 overlaps pre-existing changes in:
    - `backend/routes/robotrader.js`
    - `backend/tests/robotraderRoute.test.js`
    - `backend/robotrader/alpacaBroker.js`
    - `backend/tests/robotraderAlpacaBroker.test.js`
    - `backend/README.md`
- Decision: treat all existing changes as user work; use one writer per owned file and
  inspect focused diffs before and after every edit.
- Limitation: this entry does not attribute authorship of any dirty hunk.

## QP-20260723-0003 — Live replacement lifecycle bypass

- Date: 2026-07-23
- Milestone: X0.1
- Type: `RELEASE_BLOCKING_FINDING`
- Severity: **P0 / critical**
- Result: `FAIL`
- Evidence:
  - `backend/routes/robotrader.js:1001-1035`
  - `backend/routes/robotrader.js:155-170`
  - `backend/robotrader/alpacaBroker.js:104-150`
  - `backend/robotrader/alpacaBroker.js:207`
- Observed claim: the baseline route could send a user-owned live order replacement
  after operator and settings checks without the deployment live flag, controlled-live
  activation, attempt claim, new immutable intent/fingerprint, exact authorization, or
  fresh notional/exposure/risk envelope.
- Decision: X0.1 is `IN_PROGRESS`; all live trading remains `NO-GO`.
- Limitation: this finding covers replacement only and does not claim other broker
  paths safe.

## QP-20260723-0004 — Replacement payload and broker call

- Date: 2026-07-23
- Milestone: X0.1
- Type: `CODE_FINDING`
- Result: `OBSERVED`
- Evidence:
  - `backend/robotrader/alpacaBroker.js:104-150` accepted quantity, limit price, stop
    price, trailing parameters, time in force, and client-order ID.
  - `backend/robotrader/alpacaBroker.js:207` issued
    `PATCH /v2/orders/:orderId`.
- Decision: a settings-only guard is insufficient because the route can change the
  economic terms and identity of a live working order.
- Limitation: payload sanitization tests validate shape; they do not establish the
  missing immutable amendment, authorization, or risk lifecycle.

## QP-20260723-0005 — Narrow baseline test run

- Date: 2026-07-23
- Milestone: X0.1
- Type: `TEST_RESULT`
- Result: `PASS_WITH_GAP`
- Command:
  `cd backend && node --test tests/robotraderRoute.test.js tests/robotraderAlpacaBroker.test.js`
- Exact result: 25 passed, 0 failed, 0 skipped, exit 0.
- Gap: no pre-existing test exercised `POST /orders/:orderId/replace` with a live
  order or proved that replacement broker I/O was unreachable.
- Decision: the green narrow baseline does not satisfy X0.1.

## QP-20260723-0006 — Full backend baseline test run

- Date: 2026-07-23
- Milestone: X0.1
- Type: `TEST_RESULT`
- Result: `PASS_WITH_SKIP`
- Command: `cd backend && npm test`
- Exact result: 430 passed, 0 failed, 1 skipped.
- Skip: the loopback fake-paper-broker integration test could not run because the
  sandbox restricted the required socket operation.
- Decision: record the 430 passing tests as backend regression baseline evidence, but
  do not treat the skipped fake-broker path as passing or as alternate proof of live
  replacement containment.
- Limitation: this command did not run frontend tests, builds, e2e, audits, containers,
  CI, or any external broker check.

## QP-20260723-0007 — CI contract inspection

- Date: 2026-07-23
- Milestone: X0.1
- Type: `BUILD_CONFIGURATION_FINDING`
- Result: `OBSERVED_NOT_RUN`
- Evidence: `.github/workflows/ci.yml:18-79`
- Configured checks:
  - repository environment-file safety;
  - backend install, tests, and production dependency audit;
  - frontend install, tests, production build, browser/e2e, and production dependency
    audit;
  - backend and frontend container builds.
- Decision: record only commands actually run in entries QP-20260723-0005 and
  QP-20260723-0006. Do not claim configured CI jobs passed locally.
- Limitation: `.github/workflows/ci.yml` was untracked at the dirty-worktree baseline.

## QP-20260723-0008 — Replacement documentation audit

- Date: 2026-07-23
- Milestone: X0.1
- Type: `DOCUMENTATION_FINDING`
- Result: `UPDATE_REQUIRED_AFTER_REMEDIATION`
- Evidence:
  - `backend/README.md:132` listed the replace endpoint without an environment caveat.
  - `docs/robotrader-prelive-test-plan.md:83` explicitly described replacement of a
    working paper order.
  - `docs/quant-platform-research-blueprint.md:13,37,50-61,404,411` described the
    current live replacement defect and its required containment.
  - `docs/paper-to-robinhood-agentic-rollout.md:31,106` required live replacement to
    be disabled.
  - `docs/codex-multi-agent-implementation-loop.md:78-92,199-200` defined the
    baseline blocker and X0.1.
- Decision: after code and tests verify containment, qualify the README endpoint and
  add evidence-linked containment status to current-tense defect descriptions. Do not
  delete the original finding or future immutable-amendment requirements.
- Limitation: paper replacement scenarios and future broker-lifecycle replacement
  tests remain valid and should not be removed.

## QP-20260723-0009 — Robinhood implementation search

- Date: 2026-07-23
- Milestone: X0.1
- Type: `CAPABILITY_FINDING`
- Result: `UNKNOWN / NOT_IMPLEMENTED_IN_SEARCHED_CODE`
- Evidence: application-code search found only
  `backend/models/OrderIntent.js:10`, where `robinhood` is an enum value.
- Decision: no Robinhood read, review, or live capability receives `PASS`; all
  Robinhood live actions remain approval-required and `NO-GO`.
- Limitation: no Robinhood connection, authentication, schema discovery, review, or
  order action was attempted.

## QP-20260723-0010 — Governance state initialized

- Date: 2026-07-23
- Milestone: X0.1
- Type: `GOVERNANCE_IMPLEMENTATION`
- Result: `IN_PROGRESS`
- Files created:
  - `docs/quant-program/IMPLEMENTATION_STATE.md`
  - `docs/quant-program/EVIDENCE_LEDGER.md`
  - `docs/quant-program/RELEASE_SCORECARD.md`
- Decision: persistent state now has an initialization baseline. This does not promote
  X0.1, any release-scorecard domain, or the overall release posture.
- Limitation: application containment, post-change tests, documentation correction,
  and independent review remain outstanding.

## QP-20260723-0011 — Live replacement contained at route and adapter boundaries

- Date: 2026-07-23
- Milestone: X0.1
- Type: `IMPLEMENTATION_EVIDENCE`
- Result: `IMPLEMENTED_PENDING_FINAL_REVIEW`
- Evidence:
  - `backend/robotrader/alpacaBroker.js:105-113` defines
    `assertOrderReplacementAllowed`, which rejects live mode with HTTP `409` and
    `LIVE_ORDER_REPLACEMENT_DISABLED`.
  - `backend/routes/robotrader.js:1010` invokes the guard immediately after the
    authenticated, user-scoped order lookup and before external-order-ID validation,
    broker construction, payload handling, local mutation, save, or audit creation.
  - `backend/robotrader/alpacaBroker.js:218-221` invokes the same guard before
    replacement-payload sanitization and the broker PATCH.
- Decision: the baseline reachable live replacement path is contained at two
  boundaries. Live amendments remain prohibited and unimplemented.
- Limitation: implementation evidence is not final milestone acceptance; independent
  re-review remains outstanding.

## QP-20260723-0012 — Focused post-change validation

- Date: 2026-07-23
- Milestone: X0.1
- Type: `TEST_RESULT`
- Result: `PASS`
- Command:
  `cd backend && node --test tests/robotraderRoute.test.js tests/robotraderAlpacaBroker.test.js`
- Exact result: 28 passed, 0 failed, 0 skipped.
- Covered behavior:
  - HTTP `409` and stable reason code for live replacement;
  - deployment flag, settings, operator, external-ID, and payload permutations;
  - no settings read, local save, audit creation, or adapter HTTP for blocked live
    replacement;
  - unchanged order economics, identity, status, reconciliation state, and response;
  - adapter-level live rejection before payload validation or HTTP;
  - one sanitized non-live paper replacement PATCH.
- Decision: focused implementation behavior passed; final independent re-review is
  still required.

## QP-20260723-0013 — First independent challenge

- Date: 2026-07-23
- Milestone: X0.1
- Type: `INDEPENDENT_REVIEW`
- Result: `CODE_PASS_WITH_ACCEPTANCE_GAPS`
- Finding: the reviewer accepted the route and adapter containment design and found no
  code-level live replacement bypass in the reviewed change.
- Acceptance gaps:
  - the route immutability assertion did not yet include `lastReconciledAt`;
  - post-remediation full regression, backend audit, documentation alignment,
    persistent evidence, and final re-review were not yet complete.
- Decision: do not mark X0.1 `PASS`; remediate the assertion and complete the remaining
  evidence.

## QP-20260723-0014 — `lastReconciledAt` assertion remediated

- Date: 2026-07-23
- Milestone: X0.1
- Type: `TEST_REMEDIATION`
- Result: `IMPLEMENTED`
- Evidence:
  - `backend/tests/robotraderRoute.test.js:639` seeds the original
    `lastReconciledAt`.
  - `backend/tests/robotraderRoute.test.js:656` includes it in the immutable original
    state.
  - `backend/tests/robotraderRoute.test.js:688` includes it in the post-request state
    comparison.
- Decision: a blocked live replacement must leave reconciliation time unchanged in
  every route scenario.
- Limitation: final independent confirmation of the remediation remains pending.

## QP-20260723-0015 — Full backend post-remediation validation

- Date: 2026-07-23
- Milestone: X0.1
- Type: `TEST_RESULT`
- Result: `PASS_WITH_SKIP`
- Command: `cd backend && npm test`
- Exact result: 433 passed, 0 failed, 1 skipped.
- Skip: the known loopback fake-paper-broker integration test could not run because
  the sandbox restricted the required socket operation.
- Decision: the full executable backend regression passed after remediation; the
  environmental skip remains open and is not counted as passing fault evidence.
- Limitation: this command did not run frontend tests, builds, e2e, audits, containers,
  Fly validation, CI, or external broker checks.

## QP-20260723-0016 — Backend production dependency audit

- Date: 2026-07-23
- Milestone: X0.1
- Type: `DEPENDENCY_AUDIT`
- Result: `PASS`
- Command: `cd backend && npm audit --omit=dev`
- Exact result: 0 vulnerabilities.
- Decision: no vulnerability was reported in the audited backend production
  dependency graph.
- Limitation: this is not a frontend dependency audit, source-code security review,
  runtime penetration test, or broker security assessment.

## QP-20260723-0017 — Replacement call-site and PATCH source search

- Date: 2026-07-23
- Milestone: X0.1
- Type: `SOURCE_SEARCH`
- Result: `PASS_PENDING_FINAL_REVIEW`
- Scope: application code under `backend/`, excluding `backend/tests/`.
- Evidence:
  - one replacement route:
    `backend/routes/robotrader.js:1004`;
  - one route call to `broker.replaceOrder`:
    `backend/routes/robotrader.js:1015`, preceded by the guard at line 1010;
  - one adapter replacement method:
    `backend/robotrader/alpacaBroker.js:218`;
  - one replacement PATCH:
    `backend/robotrader/alpacaBroker.js:220`, preceded by the adapter guard at line
    219;
  - no alternate application replacement route, direct replacement PATCH, or
    unguarded `replaceOrder` caller was found.
- Decision: the searched application call graph contains one guarded route call and
  one guarded PATCH implementation.
- Limitation: source search complements but does not replace executable tests or final
  independent review.

## QP-20260723-0018 — Replacement documentation aligned with containment

- Date: 2026-07-23
- Milestone: X0.1
- Type: `DOCUMENTATION_REMEDIATION`
- Result: `IMPLEMENTED`
- Files:
  - `backend/README.md`
  - `docs/quant-platform-research-blueprint.md`
  - `docs/paper-to-robinhood-agentic-rollout.md`
- Evidence:
  - the README qualifies replacement as paper/non-live maintenance and documents HTTP
    `409` with `LIVE_ORDER_REPLACEMENT_DISABLED` for live requests;
  - the blueprint preserves the historical baseline bypass, records dated X0.1
    route-containment status, and keeps immutable amendments prohibited;
  - the rollout marks the baseline bypass contained while prohibiting re-enablement
    until the complete lifecycle exists;
  - focused documentation `git diff --check` returned exit 0.
- Decision: behavior documentation agrees with route containment without claiming
  broader execution safety or a complete amendment lifecycle.
- Limitation: documentation alignment is not final independent milestone acceptance.

## QP-20260723-0019 — Final independent X0.1 gate decision

- Date: 2026-07-23
- Milestone: X0.1
- Type: `INDEPENDENT_GATE_DECISION`
- Result: `PASS`
- Evidence reviewed:
  - route guard at `backend/routes/robotrader.js:1010`, before external-order-ID
    validation, broker construction, payload handling, local mutation, save, and
    audit creation;
  - adapter guard at `backend/robotrader/alpacaBroker.js:219`, before replacement
    payload sanitization and the PATCH at line 220;
  - stable HTTP `409` response code `LIVE_ORDER_REPLACEMENT_DISABLED`;
  - route scenarios covering live flag, settings, operator, broker-ID, invalid payload,
    and widening economics;
  - assertions for no settings read, save, audit creation, adapter HTTP, or mutation of
    economic, identity, status, reconciliation, response, and `lastReconciledAt`
    fields;
  - preserved single sanitized paper replacement PATCH;
  - focused post-remediation result: 28 passed, 0 failed, 0 skipped;
  - full backend post-remediation result: 433 passed, 0 failed, 1 known
    sandbox-restricted loopback fake-paper-broker skip;
  - backend production dependency audit: 0 vulnerabilities;
  - application source search: one guarded route call and one guarded replacement
    PATCH, with no alternate replacement path found;
  - documentation and persistent-state alignment.
- Independent finding: no unresolved X0.1 blocker remains.
- Decision: mark X0.1 `PASS` and complete Cycle 1.
- Residual boundaries:
  - overall release posture remains `NO-GO`;
  - live amendments remain unimplemented and prohibited;
  - the known sandbox loopback integration skip remains visible and must be rerun in a
    socket-capable environment;
  - X0.2-X0.5 and all later milestones remain unresolved or unevaluated;
  - no broker connection, authentication, review, order action, deployment, secret
    change, or external write was authorized or performed.

## QP-20260723-0020 — X0.2 parallel truth pass

- Date: 2026-07-23
- Milestone: X0.2
- Type: `CODE_FINDING`
- Result: `FAIL`
- Independent read-only findings:
  - main entry already persists one client identity and leaves selected transport
    failures pending, but has no exact durable `SUBMIT_UNKNOWN` predicate or
    account-wide new-submission freeze;
  - protective submission converts every exception to rejection and automatically
    replaces the client identity before replay;
  - Alpaca-synced paper submission converts every exception, including a polling
    failure after acknowledged POST, to rejection and cannot reconcile by client ID;
  - `/api/trade/execute` can create an additional false rejection record.
- Decision: X0.2 is a directly verified release blocker and begins Cycle 2 as
  `IN_PROGRESS`; all live trading remains `NO-GO`.

## QP-20260723-0021 — X0.2 protective duplicate-exit severity

- Date: 2026-07-23
- Milestone: X0.2
- Type: `ADVERSARIAL_FINDING`
- Result: `FAIL`
- Evidence:
  - `backend/robotrader/reconciliation.js:387-413` writes all protective errors as
    rejected;
  - rejected protection is retryable;
  - every retry generates a new client ID and overwrites the top-level correlation
    identity;
  - the existing test explicitly expects that replacement identity.
- Failure scenario: a broker accepts the first sell stop but its response is lost; a
  later reconciliation submits a second stop. Both can fill and create unintended
  opposite exposure.
- Decision: no automatic protective replay is acceptable in X0.2.

## QP-20260723-0022 — X0.2 paper baseline

- Date: 2026-07-23
- Milestone: X0.2
- Type: `TEST_RESULT`
- Result: `BASELINE_PASS_WITH_MISSING_FAULT_COVERAGE`
- Command:
  `cd backend && node --test tests/alpacaTradingClient.test.js tests/paperBrokerClient.test.js tests/tradeRoutes.test.js`
- Exact result: 27 passed, 0 failed, 0 skipped.
- Missing evidence: timeout/reset/408/429/5xx ambiguity, acknowledged-POST polling
  failure, durable freeze, repeat request, client-ID reconciliation, and duplicate
  suppression for `/api/trade/execute`.
- Decision: the green baseline does not satisfy X0.2.

## QP-20260723-0023 — X0.2 implementation and acceptance contract

- Date: 2026-07-23
- Milestone: X0.2
- Type: `CONTRACT_DECISION`
- Result: `RECORDED`
- Contract:
  - one shared classifier and exact `SUBMIT_UNKNOWN` durable state;
  - original persisted client identity and one attempt only;
  - unresolved account/environment state blocks every new submission;
  - protective and paper unknowns are never false rejection or automatic replay;
  - reconciliation is lookup-only by the original identity and 404 remains unknown;
  - successful POST acknowledgement survives later polling failure;
  - post-broker persistence/audit failure never rewrites broker truth;
  - focused fault tests plus independent re-review are required before `PASS`.
- Scope decision: use unresolved order rows as the durable latch in X0.2; defer a
  separate account-level circuit-breaker model to X0.5.

## QP-20260723-0024 — Shared submission classifier fault matrix

- Date: 2026-07-23
- Milestone: X0.2
- Type: `IMPLEMENTATION_AND_TEST_RESULT`
- Result: `PASS`
- Files:
  - `backend/services/submissionOutcomeService.js`
  - `backend/tests/submissionOutcomeService.test.js`
- Command: `cd backend && node --test tests/submissionOutcomeService.test.js`
- Exact result: 7 passed, 0 failed, 0 skipped.
- Direct evidence:
  - HTTP 408, 425, 429, 500, 502, 503, and 504 classify as `SUBMIT_UNKNOWN`;
  - abort, refusal, reset, DNS, host/network unreachable, broken pipe, generic network,
    and timeout codes classify as `SUBMIT_UNKNOWN`;
  - duplicate client identity remains unknown even with a 409 or 422;
  - only structured affirmative broker 400/401/403/422 evidence classifies as
    confirmed rejection;
  - proven pre-submit failure classifies as `NOT_ATTEMPTED`;
  - a broker acknowledgement requires a status and matching external/client
    correlation identity;
  - error snapshots retain the exact canonical outcome and original client identity.
- Limitation: this is the shared pure classifier only. Path integration, persistence,
  freeze, reconciliation, route, and no-replay evidence remains pending.

## QP-20260723-0025 — X0.2 Cycle 2 independent challenge

- Date: 2026-07-23
- Milestone: X0.2
- Type: `INDEPENDENT_ADVERSARIAL_REVIEW`
- Result: `FAIL`
- Passing evidence reviewed:
  - shared, worker, adapter, and reconciliation focus: 71 passed, 0 failed;
  - shared and paper focus: 48 passed, 0 failed;
  - full backend implementation regression: 472 passed, 0 failed, 1
    sandbox-restricted loopback integration skip.
- Release-blocking findings:
  - an empty or identity-mismatched status-poll response can replace a valid POST
    acknowledgement;
  - paper and RoboTrader unknown latches and locks are isolated, so cross-path
    submissions can race;
  - manual paper requests have no durable idempotency identity across retry and
    reconciliation;
  - preflight, lock, unknown, and post-ack failures can still create false rejected
    execution telemetry;
  - client-ID-only submitted rows can fall out of paper reconciliation;
  - a legacy RoboTrader direct Alpaca POST bypass remains.
- Decision: focused and regression passes do not satisfy the X0.2 contract. No
  promotion; all live trading remains `NO-GO`.

## QP-20260723-0026 — X0.2 Cycle 3 remediation contract

- Date: 2026-07-23
- Milestone: X0.2
- Type: `CONTRACT_DECISION`
- Result: `RECORDED`
- Required remediation:
  - immutable external/client identity validation for every poll;
  - one shared durable Alpaca-paper account lock and bidirectional unresolved query
    across `PaperOrder` and `RoboTradeOrder`;
  - persisted route idempotency key with a unique partial account/broker/key schema
    invariant and same-attempt replay behavior;
  - zero rejected telemetry for `NOT_ATTEMPTED`, coordination, unknown, and post-ack
    local failures;
  - reconciliation coverage for every open row with either correlation identity;
  - fail-closed removal of the legacy direct Alpaca submission bypass.
- Boundaries: local code and tests only. No deployment, broker connection, secret
  access, external database inspection, or production index mutation is authorized.
- Acceptance: focused faults, full relevant regression, static submit-path search,
  and an independent re-challenge must all pass. Any missing evidence remains fail.

## QP-20260723-0027 — X0.2 Cycle 3 source remediation

- Date: 2026-07-23
- Milestone: X0.2
- Type: `IMPLEMENTATION_EVIDENCE`
- Result: `IMPLEMENTED_PENDING_CHALLENGE`
- Production changes:
  - one shared `PaperAccountLock` lease and bidirectional unresolved query cover
    `PaperOrder` and `RoboTradeOrder`;
  - manual Alpaca-paper submission requires a durable idempotency key and fingerprint,
    returns the original attempt on retry, and cannot mint a new identity while any
    account outcome is unresolved;
  - manual entry, modern worker entry, and protective submission persist an identity,
    repeat lease/latch fencing immediately before broker I/O, and record exact
    zero-attempt `NOT_ATTEMPTED` evidence when coordination fails;
  - reconciliation is lookup-only by the original external or client identity;
  - only affirmative structured broker rejection can become
    `REJECTED_CONFIRMED` or rejected execution telemetry;
  - the legacy direct Alpaca execution branch is disabled.
- Broker-contract research, accessed 2026-07-23:
  - `https://docs.alpaca.markets/us/docs/orders-at-alpaca`
  - `https://github.com/alpacahq/alpaca-docs/blob/master/content/api-references/broker-api/trading/orders.md`
- Research use: constrain recognized status values, duplicate-client handling, and the
  48-character client-order-ID limit. No external broker call was made.
- Decision: submit the implementation to independent adversarial review. Do not infer
  a milestone pass from implementation alone.

## QP-20260723-0028 — X0.2 Cycle 3 independent challenge and remediation trail

- Date: 2026-07-23
- Milestone: X0.2
- Type: `INDEPENDENT_ADVERSARIAL_REVIEW`
- Initial result: `FAIL`
- Credible findings included:
  - application username, database ObjectId, and `default` account scopes could
    diverge across manual, modern, and legacy scheduler paths;
  - a lease could be lost or an unresolved cross-collection row could appear after
    durable identity creation but before POST;
  - thrown coordination operations and proven pre-I/O adapter failures could carry
    incorrect attempted evidence;
  - duplicate-client error variants, generic or empty 4xx payloads, malformed
    identities, and invalid status values were not all fail-conservative;
  - live protective submission did not initially share the unresolved-account latch;
  - generated or caller-supplied client IDs could violate the broker length contract;
  - incomplete, coercive, overfilled, underfilled, unbounded, or status-incoherent fill
    evidence could manufacture broker truth;
  - external-ID-only historical rows and notional orders lacked complete recovery
    evidence.
- Remediation:
  - converge current paths on stored username account scope and fail closed when it is
    unavailable;
  - add post-persistence renewal and late bidirectional latch checks;
  - make coordination exceptions durable zero-attempt `NOT_ATTEMPTED`;
  - tighten duplicate/rejection, status, identifier, and 48-character identity
    contracts;
  - apply the unresolved latch to live protective submission as containment;
  - require complete canonical fill pairs and coherent immutable quantity/notional
    bounds;
  - add lookup-only external-ID and notional reconciliation coverage.
- Decision: every challenge remained a failed gate until its remediation and focused
  rerun passed.

## QP-20260723-0029 — Final strict broker-fill schema remediation

- Date: 2026-07-23
- Milestone: X0.2
- Type: `TEST_REMEDIATION`
- Result: `PASS`
- Final independent finding: JSON numeric broker `filled_qty` and
  `filled_avg_price` values were accepted despite the reviewed broker response
  contract requiring decimal strings.
- Change: broker fill evidence now accepts only strict unsigned decimal strings.
  Local immutable expected quantity/notional values may remain validated numbers or
  strings.
- Rejected evidence includes number, boolean, object, blank, whitespace, hexadecimal,
  signed, scientific, non-finite/overflowing, missing-pair, overfill, terminal
  underfill, no-bound, and status-incoherent forms.
- Command:
  `cd backend && node --test --test-concurrency=1 tests/submissionOutcomeService.test.js tests/alpacaTradingClient.test.js tests/robotraderAlpacaBroker.test.js`
- Exact result: 46 passed, 0 failed, 0 skipped.
- Decision: rerun the complete X0.2 consolidated challenge.

## QP-20260723-0030 — Final X0.2 source-focused validation

- Date: 2026-07-23
- Milestone: X0.2
- Type: `TEST_RESULT`
- Result: `PASS`
- Command:
  `cd backend && node --test tests/submissionOutcomeService.test.js tests/alpacaPaperSubmissionGuardService.test.js tests/alpacaTradingClient.test.js tests/paperBrokerClient.test.js tests/tradeRoutes.test.js tests/robotraderAlpacaBroker.test.js tests/robotraderWorker.test.js tests/robotraderReconciliation.test.js tests/roboTraderEngine.test.js tests/roboScheduler.test.js`
- Exact coordinator result: 236 passed, 0 failed, 0 canceled, 0 skipped, 0 todo.
- Independent evidence: the primary reviewer and a second post-remediation auditor
  independently obtained the same 236-pass result.
- Additional independent probes:
  - 1,000 generated client-order IDs were unique, exactly 48 characters, and retained
    timestamp plus entropy-bearing suffixes;
  - canonical decimal-string fills with coherent quantity/notional bounds passed;
  - numeric, boolean, hexadecimal, scientific, overflowing, overfilled, underfilled,
    canceled-partial, and unbounded fill forms were inconclusive;
  - external-ID-only paper recovery retained the original identity;
  - canceled responses carrying partial fills remained unknown through both adapters.
- Limitation: broker HTTP and storage boundaries are mocked or in-memory in this
  focused suite.

## QP-20260723-0031 — Final independent X0.2 source gate

- Date: 2026-07-23
- Milestone: X0.2
- Type: `INDEPENDENT_GATE_DECISION`
- Result: `SOURCE_PASS_WITH_DURABILITY_GAPS`
- Independent conclusion: no reviewed source path still:
  - automatically retries `SUBMIT_UNKNOWN`;
  - mints a replacement identity for an existing attempt;
  - creates rejection telemetry without affirmative broker rejection;
  - manufactures a fill or protective follow-on from malformed acknowledgement data;
  - bypasses the account unresolved latch to add new risk;
  - reaches the disabled legacy direct Alpaca submission path.
- Decision: accept the X0.2 source contract. Do not mark the milestone complete until
  real-storage durability, index/migration, and broker-account binding gaps have direct
  evidence.
- Unresolved direct-evidence gaps:
  - no complete manual/worker race against a real MongoDB primary;
  - no process-kill/restart, multi-process, lease-expiry, or clock-skew fault;
  - no production unique-index build or historical duplicate/scope/identity audit;
  - no verified Alpaca account binding across application users;
  - no real Alpaca paper request or reconciliation;
  - terminal lifecycle responses carrying positive fills are frozen for X0.3 rather
    than fully journaled.

## QP-20260723-0032 — Final backend serial regression

- Date: 2026-07-23
- Milestone: X0.2
- Type: `TEST_RESULT`
- Result: `PASS_WITH_SKIP`
- Command: `cd backend && node --test --test-concurrency=1`
- Exact result: 561 tests, 560 passed, 0 failed, 1 skipped.
- Exact skip: `tests/robotraderFakeBroker.integration.test.js` could not bind its
  local loopback socket in the sandbox.
- Isolated skip command:
  `cd backend && node --test --test-concurrency=1 tests/robotraderFakeBroker.integration.test.js`
- Isolated result: 0 passed, 0 failed, 1 skipped, with the reason
  `Local socket binding is blocked by this sandbox; run this test with local loopback permission.`
- Decision: record the current backend regression as green for every executable test;
  the skipped socket safety test remains an explicit open evidence gap.
- Limitation: this did not run frontend, browser/e2e, container, Fly, CI, real
  database, or external broker checks.

## QP-20260723-0033 — Interrupted default backend runner

- Date: 2026-07-23
- Milestone: X0.2
- Type: `TEST_RESULT`
- Result: `INCOMPLETE / NOT_PASS`
- Command: `cd backend && npm test`
- Observed result: the default parallel run stopped making progress, was terminated,
  and returned shell exit 137.
- Decision: do not count this invocation as passing or failing regression evidence.
  Use the completed deterministic serial result in `QP-20260723-0032`.
- Limitation: the cause of the parallel-run stall was not independently diagnosed in
  X0.2.

## QP-20260723-0034 — Final audit, syntax, patch, and submit-path checks

- Date: 2026-07-23
- Milestone: X0.2
- Type: `VALIDATION_RESULT`
- Result: `PASS_WITH_SCOPE_LIMITS`
- Evidence:
  - `cd backend && npm audit --omit=dev`: 0 vulnerabilities;
  - `node --check` passed for the shared outcome and account-guard services, both
    Alpaca adapters, paper broker, worker, reconciliation, legacy engine, and both
    paper routes;
  - `git diff --check`: exit 0;
  - application source search found two order-creation POST implementations:
    `backend/services/alpacaTradingClient.js` for manual paper and
    `backend/robotrader/alpacaBroker.js` for modern worker/protective submission;
  - reviewed order-creation callers are manual paper, modern worker, and protective
    reconciliation; the legacy direct Alpaca branch is disabled.
- Decision: no alternate application order-creation source path was found in the
  searched backend code.
- Limitation: dependency audit covers backend production packages only; static search
  is not execution proof.

## QP-20260723-0035 — Three-cycle boundary decision

- Date: 2026-07-23
- Milestone: X0.2
- Type: `CYCLE_GATE_DECISION`
- Result: `IN_PROGRESS`
- Completed cycles:
  - Cycle 1: X0.1 live replacement containment — `PASS`;
  - Cycle 2: X0.2 initial implementation — independent challenge `FAIL`;
  - Cycle 3: X0.2 remediation — independent source `PASS`, durability evidence open.
- Decision:
  - preserve overall release `NO-GO`;
  - keep X0.2 `IN_PROGRESS`;
  - do not begin X0.3 after the maximum third cycle;
  - resume with isolated real-Mongo multiprocess/crash/index evidence and the skipped
    loopback fake-broker test in a fresh bounded task.
- Authorization record: no deployment, secret change, live flag, external database,
  broker authentication, account read, order review, order action, connector install,
  push, merge, or other external write occurred.

## QP-20260723-0036 — Final persistent-state consistency challenge

- Date: 2026-07-23
- Milestone: X0.2
- Type: `INDEPENDENT_DOCUMENTATION_REVIEW`
- Initial result: `FAIL`
- Findings:
  - `IMPLEMENTATION_STATE.md` labeled historical Cycle 2 failures as current-code
    findings even though later entries superseded them;
  - `RELEASE_SCORECARD.md` overstated independently verifiable append-only provenance
    while all three state files remain untracked and therefore lack a Git mutation
    baseline.
- Remediation:
  - renamed the section to findings and remediation history and explicitly marked
    X0.2-F001 through X0.2-F004 as historical Cycle 2 records superseded by
    X0.2-F006 through X0.2-F009;
  - described the ledger only as chronologically structured with prior failures and
    skips preserved, and kept Governance `UNKNOWN` until a committed or separately
    sealed append-only baseline exists;
  - documented that the resume checksum hashes the exact UTF-8 summary with no
    trailing newline.
- Independently reverified facts:
  - branch `codex/sprint1-policy-approval`, HEAD `058f962`;
  - 92 modified tracked files and 34 untracked paths;
  - 182/182 workflow-focus tests, 236/236 consolidated tests, and 560 passes plus one
    known skip in the 561-test full serial run;
  - resume checksum
    `4f961cbd8fbdb3b3040906e853777f5b5a7fe7236aaf00dd2c026a012b3e68b1`.
- Decision: documentation consistency remained failed until the independent reviewer
  rechecked the remediation.

## QP-20260723-0037 — Final persistent-state consistency re-review

- Date: 2026-07-23
- Milestone: X0.2
- Type: `INDEPENDENT_DOCUMENTATION_REVIEW`
- Result: `PASS`
- Independent conclusion:
  - historical X0.2 findings are explicitly labeled and no longer contradict the
    final Cycle 3 source state;
  - Governance accurately distinguishes a structurally chronological ledger from
    append-only provenance that cannot yet be proven for untracked files;
  - the resume checksum byte convention is explicit and the checksum re-verifies;
  - X0.2 remains `IN_PROGRESS`, overall release remains `NO-GO`, and X0.3 remains
    unstarted.
- Decision: no unresolved persistent-state consistency finding remains.

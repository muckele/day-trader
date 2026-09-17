# Position-cap-neutral acceptance implementation plan

> **For agentic workers:** Use test-driven development and independent review. Execute the already authorized local work without a push or real provider requests.

**Goal:** Preserve production risk policy while supporting acceptance-owned deltas on held positions and precise acceptance market observations.

**Architecture:** Keep all new behavior in acceptance scripts. Use exact fixed-point observation arithmetic and canonical quantity arithmetic. The existing canonical lifecycle remains the only admission, fill and reduce-only path; acceptance adds immutable baseline and owned-delta checks.

**Tech stack:** Node 24.21.0, node:test, controlled loopback provider, isolated Mongo test replica set, existing deterministic verifier.

**Spec:** Operator's “POSITION-CAP-NEUTRAL ACCEPTANCE FIXTURE + MARKET-DATA PRECISION CORRECTION” request, September 16, 2026.

## Constraints and decisions

- Start at ecfbcabdbb3b333852392ea2ecbc252f1dd8bd9d on the explicitly requested existing branch/checkout; preserve the untracked master brief and ignored operational configuration.
- No real Alpaca/data/live traffic, SMTP, deployment, push or operational settings changes.
- Production currency parser, risk/admission/exposure/dispatch services are immutable.
- Keep five selected bars, selected-bar six-minute maximum age, latest-bar two-minute maximum age, and strict chronological response validation. Original safety code does not require consecutive wall-clock minutes.
- Retrieve a bounded ten-minute window with enough results to inspect its newest valid five. A wider retrieval is not permission to accept stale selected bars.
- Same three-submission/one-cancellation budget. Readiness metadata remains allowed.
- Use controlled synthetic values only in committed evidence; no real account data or identities.

## Task 1: Exact acceptance market observations

- [x] Add failing helper tests for sub-cent observations, exact range/spread, >$250 without downward rounding, conservative cent tick, malformed/excessive precision, four-bar rejection, newest-five selection, stale/future/unordered bars and bounded query.
- [x] Run `node --test backend/tests/acceptanceSafety.test.js backend/tests/externalPaperAcceptance.test.js` with the pinned Node; retain red evidence.
- [x] Implement acceptance-only decimal/helper changes. Keep cents() and money/accounting unmodified. Preserve compatible integer-cent evidence where applicable and expose exact observation evidence.
- [x] Run the same tests green; inspect diff and independent review.

## Task 2: Held fixture and exact delta protection

- [x] Add failing actual-harness Mongo tests for clean preference, five-position admission of a new symbol rejected, held fallback, full/0.5/0.333333333 restoration, baseline floor, ownership mismatch, extra buy/sell/disappearance drift, position size, order conflicts and final dispatch drift.
- [x] Run `node --test backend/integration/externalPaperHarness.mongo.test.js` against the isolated mvp test replica set, never the application DB; retain expected red failures.
- [x] Implement two-phase eligibility and acceptance-only baseline/ownership helper. Bind Fill and BrokerOrder evidence to this run's intent/client/broker identities; compute remaining delta from canonical fills, never from position difference alone.
- [x] Check baseline + owned delta against fresh positions before cleanup and again at final broker authorization. Reject projected quantities below the baseline. Compare fixture quantity/side on restoration; changing weighted cost basis from legitimate buy/sell does not mutate unrelated positions.
- [x] Run actual canonical admission, reconciliation and reduction integration tests green with unchanged production modules.

## Task 3: Release evidence and local candidate

- [x] Register every new named scenario in the verifier while retaining existing mandatory identities; test missing-scenario rejection.
- [x] Run acceptance unit/Mongo, fractional, reduce-only/protection, verifier-contract, RC-002, then complete deterministic verifier with no failures/skips/flakes.
- [x] Compare runtime-assembled source hashes and image evidence; acceptance scripts/tests must remain excluded. Rebuild only if runtime contents changed.
- [x] Update runbook and evidence with actual results; independently review the complete diff and address findings with scoped tests.
- [x] Scan changed files against configured secrets/identifiers without printing values; stage explicit files only, create local commit(s), record new SHA and STOP.

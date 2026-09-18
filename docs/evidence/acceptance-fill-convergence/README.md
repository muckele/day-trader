# Bounded acceptance fill convergence

Starting candidate: `4107528be97c1a33597053c032bb5bfabbc26004` on `codex/owner-paper-mvp`.
This evidence accompanies the single local `fix: allow bounded acceptance fill convergence` commit. The containing commit is the new immutable candidate; its exact SHA is recorded in the post-commit local binding report. Prior hosted CI does not verify this new candidate.

## Problem and RED evidence

The acceptance harness treated a recognized observation race as immediately terminal: ownership and canonical order reads returned zero fill, the same order executed, positions advanced, and exposure correctly required reconciliation because canonical Fill ingestion had not caught up. The immediate `EXPOSURE_RECONCILIATION_REQUIRED` assertion prevented the next same-identity reconciliation cycle.

Both `position ahead of canonical fill converges` and `lagging order discovery converges` were added before implementation and failed against unchanged starting implementation with expected `EXTERNAL_ALPACA_PAPER_VERIFIED`, actual `EXTERNAL_ALPACA_PAPER_FAILED`, reason `EXPOSURE_RECONCILIATION_REQUIRED`. The RED run exited 1: 96 passing entries, two failing regression children and their failing parent, zero skips. See `red-first.json`; the original local TAP and original real-incident/recovery/RCA evidence remain outside the repository and were not changed or copied into this commit.

Additional test-first checks exposed cancellation-fixture convergence, immutable identity validation, duplicate position observations, terminal all-order discovery tampering, and stalled database work before their corrections. They use controlled observations and synthetic identities.

## Acceptance-only correction

`backend/scripts/acceptanceConvergence.js` classifies observations and owns the monotonic wait budget. `external-paper-acceptance.js` retains the existing durable intent, client identity, broker identity, canonical lifecycle, Fill ingestion and capacity accounting. No production reconciliation, scheduler, accounting, exposure certification, RC-001 or RC-002 implementation changes are included.

An observation is retryable only when identity and baseline bounds remain intact and the exposure reason is exactly one of:

- `Portfolio exposure requires reconciliation: broker execution is ahead of canonical fill ingestion`
- `Portfolio exposure requires reconciliation: broker and canonical holdings disagree for <fixture symbol>`

Coherent exposure with a subsequent bounded position/order visibility difference also requires another observation. It is not accepted as convergence. The recognized differences never create ownership, a Fill, an intent, a reservation, admission authority or mutation authority.

Success requires the conjunction of desired canonical status, unchanged persisted intent and broker identity, canonical filled quantity matching known broker execution, fresh coherent exposure, and the fresh fixture position equaling protected baseline plus exact canonical acceptance-owned net quantity. Unknown/hard exposure reasons, malformed or unsupported execution fields, overfill, identity drift, account drift, foreign/conflicting orders, duplicate position rows, unrelated-position drift, protected-baseline decrease and unexplained quantity increase fail closed. Every owned order-discovery row is validated, including terminal rows returned by `status=all`.

The default remains 10 attempts and 1,000 ms between attempts. A fixed **60,000 ms aggregate monotonic deadline per existing intent** also applies, starting at that intent's first poll. It is not restarted by a GET, another phase or a repeated call to the polling helper. Ten polls normally take seconds; 60 seconds allows bounded HTTP/database observation overhead, aligns with the existing acceptance freshness window and stays below the existing 120-second coordinated-close deadline. Neither the attempts nor the delay was increased. Existing restart/preflight guards prohibit restarting unresolved economic work with fresh mutation authority.

Both attempt and elapsed budgets must remain available. Persistent incoherence returns `ACCEPTANCE_CONVERGENCE_ATTEMPTS` or `ACCEPTANCE_CONVERGENCE_DEADLINE`, retaining the last sanitized nested exposure reason. No cleanup is authorized from unresolved ownership. Existing coherent-but-nonterminal timeout handling remains subject to the unchanged global cancellation budget.

The deadline watchdog also returns when a canonical database observation stalls. Expiry permanently fences the run's broker methods and the final synchronous HTTP dispatch boundary. Interceptors and the active-run lock remain until pending work drains; a new run cannot overlap that work. The returned terminal report is detached and later evidence saves are suppressed. The standalone CLI exits after synchronous evidence persistence. This does **not** promise rollback or cancellation of an already-started database transaction: such work may settle, and the report requires reconciliation of the same identities before further mutation.

## Safety and deterministic regression coverage

The controlled provider reproduces the exact ordering after normal zero-fill cancellation: opening POST, three zero-fill order reads, execution, advanced position, transient incoherence, next same-identity reconciliation, exactly one opening Fill, coherent exposure, then the original third submission for cleanup. Both order-discovery variants restore the baseline and unrelated positions. At the gap there is no Fill or confirmed spending; the original reservation remains. After convergence confirmed spending is applied once and reservations are released. Re-reconciliation creates no duplicate Fill, spending, audit or outbox record.

The verifier requires individual named scenarios for position-ahead convergence, lagging discovery, execution-ahead blocking of new risk, explainable holdings disagreement, persistent disagreement, elapsed deadline, identity drift, baseline drift, overfill, zero added mutations, and unchanged global budget. Additional mandatory scenarios cover cancellation-fixture partial/full visibility races, account drift, restart rejection, deadline continuity across cancellation phases, held baseline restoration, duplicate positions, terminal discovery tampering, stalled database containment, fractional execution and delayed position visibility. `mandatory-scenarios.json` records the exact names.

Successful normal race runs use exactly **3 simulated submissions and 1 simulated cancellation**. Convergence adds zero POSTs and zero DELETEs. The risk-blocking test attempts another admission during incoherence and receives `EXPOSURE_UNRESOLVED` without transport. Held-fixture convergence restores the exact protected `5.5`-share synthetic baseline.

Fractional behavior is preserved: unexpected cancellation-fixture partial fill reconciles and cleans up exact `0.5` with two submissions and one cancellation, then stops; unexpected full fill uses two submissions and no needless cancellation. If the later opening order only fills `0.5` after cancellation authority was already consumed, canonical accounting records exact `0.5`, 5,000 spent cents and 5,000 reserved cents, then stops with `CANCELLATION_BUDGET_EXHAUSTED`. It does not issue a second cancellation or authorize unsafe cleanup. Opposite-direction delayed position visibility also converges without weakening exposure certification.

Structured observation evidence retains attempt, monotonic elapsed time, intent/broker references, canonical and broker status/filled quantity, exposure state and sanitized reason, protected baseline, and canonical owned quantity. Arbitrary upstream text is not echoed as an exposure reason. Synthetic regression identities do not include real incident IDs or provider payloads.

## Verification and runtime provenance

See `verification-summary.json`, `verifier-report.json`, `verified-source-hashes.json`, and `independent-review.md` for final source-bound results. Raw local logs are retained under `/private/tmp/day-trader-acceptance-convergence/`. Tests use the pinned Node v24.21.0 runtime, disposable Mongo databases and controlled loopback providers; real operational Mongo was not used. Semantic Alpaca URLs inside test adapters are rewritten to the controlled loopback transport, with real network destinations guarded.

The complete verifier exited **0**, with **25/25 gates passing, 848 passing runner entries, zero failures, zero skips and zero flakes**. Runner entries include TAP parent entries; they are not presented as 848 distinct scenarios. The guarded harness passed 129 entries, including all 103 individually mandatory scenarios (32 newly added). Fractional integration passed 24; RC-001 dispatch and exit passed 25 and 10; RC-002 integration and process passed 25 and 1; process acceptance passed 9; browser lifecycle and core screens passed 14 and 8. Clock-skew, held-fixture fallback and global economic-budget scenarios passed inside their mandatory suites. Final targeted helper/acceptance/verifier tests passed 81 entries and the final targeted harness passed 129, with zero failures/skips.

Two local invocation issues were corrected before the successful full run: the temporary Node installation was missing bundled npm files, and the first process test invocation pointed to an absent default Chromium build. The exact official Node archive was checksum-verified and the unchanged Node binary restored with its npm files; process/browser tests used the already installed Chromium executable. These were tooling failures, not passing results or implementation flakes. The full verifier then passed in one complete run.

`runtime-binding.json` records **PRODUCTION IMAGE CONTENT UNCHANGED**. All 141 authored runtime file hashes and four construction file hashes match the existing backend image evidence. The runtime assembler copies selected runtime directories/top-level JavaScript and only `scripts/bootstrap-owner.js`; both changed acceptance implementation files, their tests and verifier files remain excluded. The immutable backend image is `sha256:6b8b35dede3bc416fbc7a2fcbc3c4d1482b0ab4260268bda33c59beb38df976f`, `linux/arm64`. No rebuild or scan was performed; existing image security dispositions remain historical, with no new scan-freshness claim. Frontend/runtime/package configuration is unchanged.

The changed-file secret scan covers configured sensitive values, known real evidence identifiers, credential/header patterns and raw-evidence exclusions. Operational configuration remains ignored and unchanged. The master brief remains unchanged and untracked, excluded from this commit.

## Remaining gates and stop boundary

This local correction is not real PAPER acceptance and does not establish a deployed MVP. After the local commit, stop. The new exact candidate needs separately authorized push and exact-SHA hosted CI, followed only then by a separately authorized real PAPER acceptance run. Existing SMTP, deployment and broader release/agentic-roadmap gates remain separate. No real Alpaca Trading/data request, real broker submission/cancellation, deployment, external SMTP, activation or push is part of this task.

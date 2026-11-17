# Owner-only PAPER MVP — release plan (Path A)

**Status:** PLAN ONLY. Written 2026-11-14 on `codex/owner-paper-mvp`. Nothing in this document has been run, and nothing in it authorizes anything.

**Owner decision (2026-11-14):** reach the owner-only deployed PAPER MVP by **Path A**. That means finishing the production acceptance controller on `codex/production-acceptance-m1` and using it for deployed acceptance. Path B was considered and not chosen. In Path B the owner would perform login and deployed acceptance personally while an agent guides and records.

**Reconfirmed (2026-11-16):** the 2026-11-14 choice came from a one-letter reply. On 2026-11-16 the owner saw a side-by-side comparison of both paths: Path A at about 3–5+ weeks with little owner time per release, and Path B at about 1–2 weeks with the owner logging in for each release. The owner chose to keep Path A.

Day Trader stays paused behind Built & Kept and UCKELE Group (owner decision, 2026-10-27). This plan is written so work can restart cleanly. It does not restart the work.

## Ground rules

- **Approvals.** Every row marked **Owner approval** below needs a fresh, explicit owner approval in the session where it runs. Approvals recorded in this document, in the controller plan's "Approval Gates" section, or in older prompts are records, not permission.
- **Durable storage.** Ledgers and evidence go under `~/day-trader-evidence/`, not `/private/tmp`.
- **Path override.** The controller plan's example paths (`/private/tmp/acceptance-synthetic/...`) must be overridden to a durable location before any runtime step.
- **No secrets here.** This repository is public. No credential values, account IDs, production user IDs or deployed digests go in this file or in any committed evidence.
- **Estimates.** Durations are rough estimates, not measured figures. They count focused working time, not calendar time.

## Where the controller stands (git history of `codex/production-acceptance-m1` at `31a513e`)

The plan is `docs/superpowers/plans/2026-09-30-production-acceptance-controller.md` on that branch. Its phases and exit gates are in "Dependency phases and execution command rules". The tables below map commit messages to tasks. That mapping comes from reading the messages; it has not been verified against the code.

### Committed tasks

| Phase | Task | Commits (first → last) | Recorded status |
|---|---|---|---|
| M1 | 1 Shared contracts | `996432c` → `f2591f8` | Offline verified (handoff) |
| M1 | 2 Route/timer admission | `4c24992` → `081abb7` | Offline verified (handoff) |
| M1 | 3 Release/restart receipts | `1700f31` | Offline verified (handoff) |
| M1 | 4 Budgets and reservations | `07e51de` → `afa67b4` | Offline verified (handoff) |
| M2 | 5 Host broker | `55c115a` | Accepted, with a narrow historical evidence exception. Do not reopen it. |
| M3 | 6 Networkless VM configuration | `e8209b0` → `67cb78f` | Offline verified at `67cb78f` |
| M3 | 7 Appliance definition | `8d142b3` | Offline verified at `67cb78f` |
| M4 | 8 Guest confinement | `8db30fb` → `04da78d` | Committed. No review record. |
| M4 | 9 Guest CONNECT proxy | `a38a5a5` → `4574fb2` | Committed. No review record. |
| M4 | 10 Topology gate | `0e37c01` → `18ea876` | Committed. No review record. The real-confinement exit gate has **not** been run. |
| (amend.) | Bootstrap composition v1 | `fcfc31e` → `6c3a3fc` | Committed. No review record. |
| M5 | 11 Private console intake | `d635e0a` | Committed. No review record. |
| M5 | 12 Controller state machine | `773bb26` | Committed. No review record. |
| M7 | 18 Private storage and crash metadata | `edfa48e` | Committed. No review record. |
| M6 | 13 Browser lifecycle | `763b329`, `b401be1` | Independent review ACCEPT (offline) covers `763b329` only |
| M6 | 14 UI login and session identity | `cb1c19a` | Committed. No review record. |
| M6 | 15 Readiness v2 and quiescence views | `31a513e` | Committed. No review record. |

### Not started

| Phase | Task |
|---|---|
| M6 | 16 Bounded HOLD and separate restart authority |
| M6 | 17 UI logout and isolated prior-session verifier |
| M7 | 19 Private leakage checks and finite public records |
| M7 | 20 Host sanitized export and durable acknowledgement |
| M7 | 21 Failure-preserving finalization and VM cleanup |
| M7 | 22 Integrated synthetic-only controller entrypoint |
| M8 | 23 Adversarial complete local VM qualification harness |
| M9 | 24 Immutable qualification verifier and independent review gate |

Nothing on this branch has run a real browser, VM, signing, network, credential, production or trading step. Runtime distribution remains `HOLD_PENDING_RUNTIME_QUALIFICATION`.

## Stages

### Stage 0 — Resume check (≈½ day)

Read-only. No owner approval needed beyond resuming Day Trader.

- Re-run `git status` and check branch heads against the `CLAUDE.md` snapshot.
- Confirm the M4 reference bundles under `~/day-trader-references/` still match their `manifest.json` hashes.
- Check the toolchain the plan pins (Xcode/Swift, Node 24.21.0, Python), and record what changed since 2026-10-04.
- **Exit:** a dated resume ledger under `~/day-trader-evidence/production-acceptance-tooling/` listing identities and any drift.

**Done 2026-11-16 — exit met, with drift.** Ledger: `20261117T001708Z-stage0-resume/RESUME_LEDGER.md` (local, outside the repo).
- Branches and M4 reference bundles are intact.
- Since October the host moved from macOS 26 to 27, and Swift 6.4 / SDK 27.0 were replaced by 6.4.2 / 27.2.
- The owner approved re-pinning to the installed Swift toolchain on 2026-11-16.

**Stage 1 progress (2026-11-16).** Ledger: `20261117T002012Z-stage1/STAGE1_LEDGER.md` (local).

| Item | Status |
|---|---|
| Commit-to-task ledger | Done |
| Offline baseline at `31a513e`: Node | 402/402 |
| Offline baseline: Python | 345/353. 8 tests blocked by a lost, never-committed M4 coverage file |
| Offline baseline: Swift | 180/181 |
| Failure investigation | Done. Two test-data defects from `284f946`. A 2-line test-only fix (`54e5b6e`, branch `claude/production-acceptance-stage1`) gives Swift 181/181. Independent review: ACCEPT_WITH_NOTES, follow-ups only. |
| M4 disposition | Not started |
| Independent reviews | Not started. About 28.6k lines of unreviewed code. |

### Stage 1 — Reconcile and review what is committed (≈3–5 days)

| Step | Who | Approval |
|---|---|---|
| Write a task ledger mapping every commit `8db30fb..31a513e` to its plan task, files and tests | Implementer | — |
| Settle the M4 record from local evidence: reference bundle, repair bundle, surviving hashes. Record the lost gate evidence as lost; do not reconstruct it. | Implementer | Owner accepts the written M4 disposition |
| Run the offline suites at `31a513e`: `node --test`, Python `unittest` and `swift test`, as each task lists them | Implementer | — |
| Fresh-context independent review of Tasks 8–12, 14, 15, 18 and the bootstrap amendment, against the plan, the exact diffs and the test output | Separate reviewer | — |
| Fix confirmed in-scope findings; re-run only the affected tests | Implementer | — |

**Exit:** every committed task has a review verdict recorded in `.superpowers/sdd/` at a named commit.

**Risk:** reviews of the three-week-old security code may send tasks back. Budget for at least one remediation round.

### Stage 2 — Real M4 confinement gate (≈2–4 days, may expose Mac-specific defects)

The plan forbids any browser acceptance execution until Task 10 passes **real** confinement. Injected kernel/topology tests do not count.

| Step | Approval |
|---|---|
| Build the immutable appliance and its construction environment | **Owner approval:** appliance/VM construction |
| Run the synthetic kernel-role/topology bootstrap gate inside a real VM with no network | **Owner approval:** VM execution, local confinement testing |
| Record the receipt, then independent review | — |

**Exit:** the M4 gate passes on a real VM, with a reviewed receipt.

**Risk:** this is the first real-runtime contact. Failures here can reopen Tasks 8–10.

### Stage 3 — Finish the remaining tasks offline (≈1–2 weeks)

Tasks 16, 17 and 19–22, in plan order. Each task follows the same loop:

1. Write the failing tests first and confirm they fail for the expected reason.
2. Write the minimum code to make them pass.
3. Run the focused and broader offline suites.
4. Commit the task as one scoped commit.
5. Get a fresh-context review before the next dependent task starts.

Implementer and reviewer are always separate. No owner approval is needed while work stays offline with test doubles.

**Exit:** Tasks 16–22 are committed and reviewed, and all offline suites pass.

### Stage 4 — Full synthetic qualification (Tasks 23–24) (≈1 week+)

Task 23 needs **owned public HTTPS fixtures**: valid public-CA TLS front-end and back-end endpoints on port 443, plus negative TLS fixtures. No provisioned fixture is recorded in the plan or in the evidence reviewed for this document. Its domains, hosting and certificates are a cost and an owner decision.

| Step | Approval |
|---|---|
| Provision the owned fixture hosting, domains and TLS identity | **Owner approval:** external infrastructure, spend |
| Set up the synthetic signing identity and entitlements; sign the final host binary | **Owner approval:** signing/entitlements |
| Rebuild the immutable appliance from final code. Earlier hashes cannot substitute. | **Owner approval:** construction |
| Run `qualify.cjs` with network/storage/credential confinement, synthetic users only | **Owner approval:** VM, network, synthetic credentials, storage |
| Run `review-gate.cjs`, which must output `READY_FOR_INDEPENDENT_REVIEW` | — |
| Fresh whole-system independent review of code, appliance, host, evidence and residuals | Separate reviewer |

**Exit:** `SYNTHETIC_ACCEPTANCE_QUALIFIED` plus a written independent ACCEPT. That is still **not** production approval.

### Stage 5 — Refresh the release candidate (≈2–3 days)

`852fb22` and its local images date from September 2026. Before release:

- Rebase or merge `codex/owner-paper-mvp` with whatever the controller needs.
- Re-run the deterministic verifier: disposable Mongo on loopback 27189, then `node scripts/verify-mvp.mjs`. Re-run exact-SHA hosted CI.
- Rebuild both linux/amd64 images and rescan them.
- Re-disposition `npm audit` (last count: 28 High) and the image CVEs.
- Pushing the branch for hosted CI needs **owner approval** (push).
- **Exit:** a new pair of qualified backend and frontend image IDs at a named commit. A coordinated release only — never backend alone.

### Stage 6 — Production release gate (≈2–4 days, one maintenance window)

This clears the 2026-09-22 and 2026-09-23 blockers. Every step needs its own owner approval, given at the time.

1. Read-only production preflight: Fly release state, the owner account and the "C1" disabled state, scheduler exposure, and no unresolved canonical or broker work. **Owner approval:** production read access.
2. Re-prove the ten staged Fly secret values; the owner re-stages any that are wrong. **Owner approval:** secrets.
3. Approve the written maintenance, backup, restore and deploy command plan. It needs independent review and must return PROCEED, not HOLD.
4. Take a fresh production backup and complete a verified restore rehearsal into a disposable target. **Owner approval:** production DB read/backup.
5. Confirm rollback preconditions: the v38 image is retrievable and the data guard (ROLLBACK_REQUIRES_DATA_GUARD) is satisfied.
6. Publish both images and record registry manifest digests that match the qualified content. **Owner approval:** publication.
7. Deploy backend and frontend by digest in one window, with `ROBO_SCHEDULER_DISABLED=true`. **Owner approval:** deploy/restart. This applies the staged secrets.
8. Run the controller's deployed owner-flow acceptance: login, readiness v2, meaningful views, HOLD/restart continuity, logout. **Owner approval:** real owner session through the controller.
9. **Exit:** deployed acceptance VERIFIED, with the scheduler still suppressed. **Stop.**

### Stage 7 — PAPER soak (days to ≈1 week, after separate authorization)

- **Owner approval:** scheduler activation, in PAPER only.
- Run a bounded soak with daily reconciliation checks and SMTP notification checks. **Owner approval:** external SMTP.
- Live trading stays off. No profitability claims.

## Rough total

About **3–5+ weeks** of focused work from resume to deployed acceptance, plus the soak. The widest uncertainty is in:

- the Stage 1 reviews
- the first real-VM contact (Stage 2)
- standing up the owned public fixtures (Stage 4)

These are estimates. Re-estimate after Stage 2.

## Not in scope

The agentic paper MVP (Phases 0–3), the owner-live canary (Phase 5), the paid product (Phase 7), same-site/custom-domain cookies, and User uniqueness maintenance (`USER_UNIQUENESS_DEFERRED`). See [the Master Brief](Day_Trader_Agentic_MVP_Master_Brief.md).

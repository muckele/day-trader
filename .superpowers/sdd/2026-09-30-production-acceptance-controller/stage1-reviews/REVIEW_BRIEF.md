# Stage 1 independent code review — shared brief

You are one of several independent reviewers. Each reviews one group of commits on the production acceptance controller of an owner-only Alpaca PAPER trading app ("Day Trader").

This code was written in early October 2026 by an AI implementer (Codex). It is security tooling:
- a VM-confined browser that will log into the owner's real deployed app
- the host never sees the owner's credentials

Most of it has never been independently reviewed, or its review records were lost. **Your review is the record.**

## Where things are

- **Code, read-only:** worktree `/Users/Matt/day-trader-worktrees/production-acceptance-stage1-fixes`, branch `claude/production-acceptance-stage1`, HEAD `132b67e`.
  - That branch is `codex/production-acceptance-m1` at `31a513e`, plus Stage 1 test-only and document commits.
  - Use `git -C <worktree> show/diff/log` freely.
  - **Never change** the worktree, the index, HEAD or any branch.
- **Design:** `docs/PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md`. This is the approved architecture and threat model.
- **Controller plan:** `docs/superpowers/plans/2026-09-30-production-acceptance-controller.md`. It has a section per numbered task, the phase gates, and an "Approval Gates" section.
- **Composition amendment:**
  - spec: `docs/BOOTSTRAP_COMPOSITION_V1_AMENDMENT.md`
  - plan: `docs/superpowers/plans/2026-10-03-bootstrap-composition-v1.md`
  - It joins Tasks 7–10 into one trusted bootstrap composition.
  - §1 of the amendment names the October reviews of Tasks 8, 9 and 10. Their reports are **lost**; only names and one-line summaries survive.
  - Task 10's open items at the amendment baseline were **N5-A** (capture-pending ownership) and **N5-B** (ordinary observation-close uncertainty).
- **M4 disposition (owner-accepted 2026-11-17):** `.superpowers/sdd/2026-09-30-production-acceptance-controller/m4-disposition-20261117/disposition.md`
- **Option A record (2026-11-17):** `.superpowers/sdd/2026-09-30-production-acceptance-controller/m4-abi-coverage-v2/report.md`. This covers Linux ABI constants re-derived and bound by tests, plus the known gaps.
- **Earlier Stage 1 fix (F-4):** `.superpowers/sdd/2026-09-30-production-acceptance-controller/stage1-f4-handoff-fix/report.md`. It fixed a test-data defect from `284f946`.

## Test evidence already run

Re-pinned toolchain: Swift 6.4.2, Node 24.21.0, Python 3.12.2, macOS 27.2.1. Logs are in `/Users/Matt/day-trader-evidence/production-acceptance-tooling/20261117T002012Z-stage1/runs/`:

| Commit | Suite | Result | Log |
|---|---|---|---|
| `31a513e` | Node | 402/402 | |
| `31a513e` | Python | 345 pass; 8 blocked by a lost file, since fixed | |
| `31a513e` | Swift | 180/181; the F-4 test defect, since fixed | |
| `0f87065` | Python | 400/400 | `at-0f87065/` |
| `0f87065` | Node | 402/402 | `at-0f87065/` |
| `0f87065` | Swift | 181/181 | `at-0f87065/swift-broad.log` |

- Fixture inputs from `0f87065` are in `…/inputs-0f87065/`.
- **Known flaky test:** `bootstrap_composition_test.test_v1_stop_clamps_to_caller_and_never_widens_shared_budget` failed once on timing.
- **Known noise:** `termios` "Bad file descriptor" tracebacks from background writer threads in `protocol_test` and `intake_test`.

You may run **focused** Python and Node tests from the worktree root. Do not run Swift.

```
TMPDIR=/Users/Matt/day-trader-evidence/production-acceptance-tooling/20261117T002012Z-stage1/tmp/producers/ PYTHONDONTWRITEBYTECODE=1 /Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 -B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p <file> -v
/Users/Matt/day-trader-toolchains/node-v24.21.0-darwin-arm64/bin/node --test tooling/production-acceptance/tests/unit/<file>.test.cjs
```

- **No network, no installs, no VM, browser or signing actions.**
- **Mutations** (strongly encouraged where you doubt that a test binds): copy the tree with `git -C <worktree> archive HEAD | tar -x -C <dir>` into a fresh directory under `/Users/Matt/day-trader-evidence/production-acceptance-tooling/20261117T002012Z-stage1/tmp/reviews/<your-group>/`. Edit and run the copy only.
- Do not dispatch subagents.

## What to review

Review your group's **exact commit range** against:
- the plan task section or sections it implements
- the design or amendment

Then check whether each finding is **still present at HEAD `132b67e`**, because later commits may have changed the code.

Look at:
1. **Spec compliance.** Are the interfaces as specified? Are the required named tests present, and do they assert the specified behaviour? Are the stated restrictions honoured? Look for no generic RPC, no arbitrary path or executable, no secret leakage, and no self-minted authority.
2. **Security correctness.** Check:
   - confinement and authority boundaries
   - fail-closed handling on every error path
   - file-descriptor and process ownership and cleanup
   - races and time-of-check/time-of-use gaps
   - replay and expiry
   - parsing of untrusted input
   - credential and session privacy
   - anything that could let a test double or caller-authored data "qualify" something real
3. **Test quality.** Tests must verify behaviour, not only mocks. Tests that pass vacuously when an input is absent are findings. A test that a plausible wrong implementation would still pass is a finding: show it with a mutation.
4. **Honesty of claims.** Comments, docs or status strings that claim a qualification, acceptance or coverage the code does not deliver are findings.

## Severity

| Level | Meaning |
|---|---|
| Critical | A real confinement, credential-privacy or PAPER-safety break, or a path that could falsely report qualification or acceptance. |
| Important | The task cannot be trusted until fixed: wrong or fail-open behaviour, a missing required behaviour or test, a test that does not bind, or a misleading claim. |
| Minor | Polish, coverage breadth, or a cosmetic issue. |

## Output

Write your full report to the path given in your dispatch. Use these sections in this order:

1. **Verdict:** `ACCEPT`, `ACCEPT_WITH_NOTES` or `REJECT`, with one sentence of reasoning.
2. **Scope reviewed:** the commits, and which plan task sections you used.
3. **Findings table:** id, severity, file:line at HEAD, still present at HEAD (yes/no), evidence (including any mutation), suggested fix.
4. **Plan-required items:** each required test or behaviour, marked present/correct or missing/incorrect.
5. **Checks run:** commands, mutation results, script paths.
6. **Declined to judge:** each item with the reason.
7. **Notes for the whole-M4 review:** cross-task concerns.

Then reply with only: the verdict, the count of findings by severity, the one-line titles of any Critical or Important findings, and the report path. Keep the reply under 15 lines.

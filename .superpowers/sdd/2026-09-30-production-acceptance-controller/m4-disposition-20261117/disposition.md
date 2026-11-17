# M4 disposition — ACCEPTED by the owner, 2026-11-17

**Status: ACCEPTED.**

- **Owner reply in chat:** "Accept with A" (2026-11-17).
- **What it answered:** "Accept the M4 disposition, and with which option for the blocked tests?" The options were A (re-derive and commit) and B (rebind only).
- **Decisions accepted:** D1–D5 below, with **D4 = Option A**.
- **Draft presented to the owner:** SHA-256 `1c84a8dc8cc2bec04d1c9c947caa50171b881c27b17e5e79673a310a2c421650`. It is kept locally as `M4_DISPOSITION_DRAFT.as-presented.md`.
- **Wording changes from that draft:** only this header, and the D4 "chosen" marker.

Stage 1 of `docs/mvp-release-plan.md` requires an owner-accepted M4 disposition. Accepting it fixes how M4 is recorded. It authorizes no operational step (see section 6).

**Rules followed:**
- Every fact below cites a surviving source.
- Lost records are listed as lost. Nothing is reconstructed from memory.
- Where a reason is unknown, this document says "unknown".

## 1. What M4 is

- **Phase M4** consists of controller-plan Tasks 8–10: guest confinement, the guest CONNECT proxy, and the topology gate.
- **Exit gate**, from the plan's phase table: "Actual approved synthetic kernel-role/topology bootstrap gate passes before browser execution."
- **The real gate** is Task 10's separately gated runtime check. A signed `acceptance-host bootstrap-check` must report `BOOTSTRAP_CONFINEMENT_QUALIFIED`. That needs separate approvals for signing, appliance construction, VM execution and owned-fixture network testing.
- **The composition amendment.** On Oct 3 the owner approved an additive offline scope, `docs/BOOTSTRAP_COMPOSITION_V1_AMENDMENT.md` (commit `fcfc31e`), with its own plan.
  - That plan's Task 11 is a fresh whole-M4 offline review. It reports `BOOTSTRAP_COMPOSITION_V1_OFFLINE_VERIFIED` only if everything passes.
  - The amendment states it does "not declare Task10 or M4 accepted". Its plan states "Original M4 real-kernel gate is still unmet".

## 2. Timeline

Times are UTC.

| When | Event | Source |
|---|---|---|
| 2026-10-02 04:55 | M3 offline closeout `VERIFIED` at `67cb78f`. Independent combined review APPROVED. | Codex `progress.md` |
| 2026-10-02 16:36 | **M4 BLOCKED** at `67cb78f`. No pinned authoritative AArch64 Linux ABI header/source set existed, so the Task 8 kernel constants had no authority to be checked against. | Codex `progress.md`. The blocked-closeout file is lost; SHA-256 `2225925e…0dcd`. |
| 2026-10-02 17:37 | Reference bundle acquired: Linux 6.8, glibc 2.39, Arm `abi-aa` at `c51addc`. Manifest `467907ea…3a9e`. | `~/day-trader-references/m4-linux-aarch64-20261002T173700Z` |
| (unknown) | That attempt was recorded as **failed**. The reason is unknown: it was in the lost exception disposition (`7e6be668…`). | Repair manifest `limits`: "Original failed attempt remains failed and unchanged" |
| 2026-10-02 18:15–18:36 | **Owner-authorized offline byte-reuse repair bundle.** Kind `OWNER_AUTHORIZED_OFFLINE_BYTE_REUSE`, 0 network bytes, 0 searches. Manifest `bb5fb8c4…49d5`. The owner's authorization text is lost (`7263b06c…`). | `~/day-trader-references/m4-linux-aarch64-offline-repair-20261002T181543Z/manifest.json` |
| 2026-10-02 19:31 → 10-03 17:00 | Tasks 8–10 committed, `8db30fb`..`18ea876` (13 commits). | git |
| 2026-10-02 21:25 | Task 8 independent review, round 2: **accepted**. | Named and summarized in the amendment (`fcfc31e`); report file lost |
| 2026-10-02 23:15 | Task 9 independent review, round 3: **accepted**. | same |
| 2026-10-03 06:33 | Task 10 independent review, round 4: composition decisions C1–C6, R1/R4/R6. | same |
| 2026-10-03 17:02 | Task 10 local N3/N5 review: N3 addressed. **N5-A and N5-B left open.** | same |
| 2026-10-03 | The amendment names the **repair bundle as "the accepted reference bundle"**: manifest `bb5fb8c4…`, "existing ABI coverage" `7c8714c9…`, Linux archive `c969dea4…`. It notes that "the retained acquisition exception and provenance limitations remain unchanged". | `docs/BOOTSTRAP_COMPOSITION_V1_AMENDMENT.md` §1 |
| 2026-10-03 17:39 → 10-04 08:54 | Composition v1 implemented, `fcfc31e`..`6c3a3fc` (30 commits). The commit subjects `f014d41` and `d17f178` match the N5-A/N5-B fixes in the plan. Whether they close those items has not been verified. | git |
| after 2026-10-04 08:54 | Composition Task 11, the whole-M4 offline review: **no surviving record**. Whether it ran is unknown. The next work, main Task 11 `d635e0a`, started at 13:28. | none |
| never | The real M4 gate (`BOOTSTRAP_CONFINEMENT_QUALIFIED`). | No VM, signing or construction has ever run (Stage 0/1 ledgers) |

## 3. Verified state today (2026-11-16/17, re-pinned toolchain)

- **Reference bundles.** Both bundles match their manifests file for file (112/112). The repair manifest hashes to `bb5fb8c4…`, the value the amendment and `bootstrap_reference_test.py` pin. The kernel archive matches kernel.org's checksum list; that list's PGP signature was **not** verified.
- **Offline suites at `54e5b6e`:**
  - Swift 181/181 and Node 402/402.
  - Python: 345 pass, and **8 cannot run**.
- **Why the 8 cannot run.** They are `bootstrap_reference_test.py`. Its setup requires `abi-coverage.json` (`7c8714c9…`), which was never committed and is lost.
- **How the test uses that file.** It uses it only as a hash binding: the setup checks the file's hash, and the committed `appliance/bootstrap-event-reference.json` declares that hash as its `parentCoverageSHA256`.
- **What the 8 tests actually check:** the committed event constants and layouts, against the bundle's Linux headers, with independent literal oracles.
- **Key gap: Task 8's own kernel constants have no committed header check.**
  - Task 8 has seccomp and syscall constants; for example `guest/confinement.py:237` uses `0xc00000b7`, which is `AUDIT_ARCH_AARCH64`.
  - No committed test compares them with the retained Linux headers. The only bundle-reading test covers the later event constants.
  - The Task 8 comparison evidently lived in the lost `abi-coverage.json` and its lost scripts (`build_coverage.py`, `verify_coverage.py`, `c_integer.py`).
  - Missing ABI authority for exactly these constants is **what blocked M4 on Oct 2**. Today that check survives only as a hash.

## 4. Lost records (do not reconstruct)

All of these were uncommitted files in the deleted `/private/tmp/day-trader-standin-exit` worktree:

- The 10 repair-bundle `externalEvidenceBindings`, kept as hashes in the repair manifest:
  - `owner-authorization.txt`
  - `exception-disposition.json`
  - `abi-coverage.json`
  - `coverage-summary.json`
  - `semantic-coverage-verification.json`
  - `constant-expression-audit.json`
  - `reused-publisher-bytes.json`
  - `build_coverage.py`, `verify_coverage.py`, `c_integer.py`
- The M4 blocked closeout (`2225925e…`), and the M3 closeout and review files.
- The Task 8, 9 and 10 independent review reports. Their names and one-line summaries survive in the amendment.
- Any record of composition Task 11 (the whole-M4 review).
- The Task 5 `swift-command.json`.

The retrieval of the original ChatGPT messages on 2026-11-14 also failed. A file that appears later counts as one of these records only if its SHA-256 matches exactly.

## 5. Proposed disposition (for owner acceptance)

- **D1. M4 stays open; it is NOT accepted.**
  - The offline code for Tasks 8–10 and the composition exists, and passes its offline suites on the re-pinned toolchain, apart from the 8 blocked tests.
  - Its earlier task reviews are known only by name.
  - The whole-M4 offline review has no record, so it must be **re-done fresh in Stage 1**. That is part of the review work already planned.
  - The real confinement gate remains Stage 2.
- **D2. Reference input.** Accept the **repair bundle** (`bb5fb8c4…`) as M4's reference input, as the committed amendment already records.
  - The first bundle stays historical and marked failed, unchanged.
  - Keep both bundles read-only and permanent.
  - Carried limits:
    - No PGP verification is recorded. The manifest says none is inferred for the kernel.org checksum list or the glibc release page, and the bundle has no glibc signature file.
    - The reason the first attempt failed is unknown.
    - The original owner authorization text is lost.
- **D3. Lost records** are recorded as lost (section 4). They are not reconstructed or re-labelled.
- **D4. The 8 blocked tests and the missing Task 8 header check.** **CHOSEN: Option A** (owner, 2026-11-17).

  | Option | What it means | Effort | Effect |
  |---|---|---|---|
  | **A — Re-derive and commit (recommended)** | Write a new, reviewed offline derivation that checks **both** the Task 8 seccomp/syscall constants **and** the event constants against the retained bundle bytes. Commit the derivation and its output to the repo so they cannot be lost again. Update `bootstrap_reference_test.py` and `parentCoverageSHA256` to the new hash. Label it a new derivation, never the lost file. Independent review of every constant. | ≈1–2 days, inside Stage 1 | Restores the evidence M4 was blocked on and unblocks the 8 tests |
  | B — Rebind only | Drop the coverage-file precondition and keep the 8 tests' real checks against the bundle. | Hours | Unblocks the 8 tests. Task 8 constants stay unchecked against headers, and `parentCoverageSHA256` points at a file that doesn't exist. |
  | C — Retire | Record the 8 tests as blocked and leave them. | None | Not recommended. These are the only offline header checks left. |
- **D5. Review findings carried into the Stage 1 M4 review:**
  - F-4b: Python does not enforce pipe direction.
  - Review notes 1–6 on the handoff fixture (`claude/production-acceptance-stage1`, report `6c33545`).
  - Whether N5-A and N5-B were closed by the composition commits.

## 6. What acceptance would and would not mean

- **It would:** fix how M4 is recorded, from now on.
- **It would not authorize:**
  - signing or construction
  - VM execution, downloads or network
  - any production action
- **Option A** would be ordinary offline Stage 1 work. That is local code and tests, with an independent review.

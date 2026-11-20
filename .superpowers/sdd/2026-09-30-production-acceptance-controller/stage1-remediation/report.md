# Stage 1 remediation and whole-M4 offline review — record

## 1. Header

| | |
|---|---|
| **Date** | 2026-11-20 |
| **Branch** | `claude/production-acceptance-stage1` |
| **HEAD recorded** | `6d6c894` (`6d6c89443879aaa02bf2447b0792fff92b284f98`), the last code commit. This record and the contract update are committed on top of it. |
| **Base** | `8f979c8`, the remediation plan commit (ruling P22) |
| **Commits recorded** | 67 (`git log 8f979c8..6d6c894`) |
| **Plan** | `docs/superpowers/plans/2026-11-17-stage1-remediation.md` (18 tasks, rulings R1–R11, traceability appendix) |
| **Decisions** | `docs/STAGE1_REMEDIATION_DECISIONS.md` (E1–E7, option A) |
| **Contract** | `docs/STAGE1_REMEDIATION_CONTRACT.md` (C1–C10; updated in this commit, ruling P84) |
| **Original findings** | `../stage1-reviews/REVIEW_LEDGER.md` and `STAGE1_REVIEW_SUMMARY.md`: 0 Critical, 47 Important, 58 Minor |
| **Execution** | Subagent-driven. A fresh implementer per task, a separate reviewer and re-reviewer per task, an independent oracle transcriber for every new ABI literal, and a controller who ruled on each conflict (P1–P94). |
| **Toolchain** | Python 3.12.2 and Node 24.21.0, both run under `sandbox-exec` with outbound IP denied; Swift 6.4.2 with CLT 27.2, `-j 1`, one build at a time |
| **Evidence** | `$RM_EVIDENCE` = `~/day-trader-evidence/production-acceptance-tooling/20261117T002012Z-stage1/remediation-shhzhEl6`: logs, mutation records, the verification scripts, and `progress.md`, the mirror of the controller ledger. The SDD workspace `.superpowers/sdd/2026-11-17-stage1-remediation/` is git-ignored scratch; this file and the git history are the lasting record. |

offline only; nothing pushed

No VM, browser launch, network, signing, credential, production or trading action was taken. Every result below is an offline result.

## 2. Commits

In execution order. Each range is the ledger's "complete" line for that task.

| Task | Range | Commits | What it did |
|---|---|---|---|
| 1 | `8f979c8..e9560e0` | `8925e16`, `e9560e0` | Wrote the remediation contract C1–C10 and the appendix of pre-flight rulings P1–P31. One fix round corrected citations, added the C10 "fork from a multi-threaded bootstrap" bullet, named Task 6 as a C9 owner and fixed the latch and record-only wording. |
| 2 | `e9560e0..d6bff51` | `d6bff51` | Cleanup budget (E7, C1): the shared 60 s end starts only at the first terminal event in Python, JS and Swift; routine probe stops use a fixed 2000 ms step; a late acquisition racing cleanup is stopped (CB-I5); the flaky composition test is fixed. |
| 3 | `d6bff51..c5e6277` | `6052554`, `4a574d7`, `326c123`, `ba18961`, `c5e6277` | Host freshness challenge (E2, C2) and separate derived keys (E3 part 1, C3). The host measures deadlines on its own monotonic clock only. A repeated challenge value in one run is refused. |
| 4 | `c5e6277..91e70cd` | `f4ea420`, `91e70cd` | Kernel-default IPv6 rows are admitted and the topology predicates are bound (T10-2, T10-3), with named negative vectors. The legacy probes are deleted. The gate requires a native adapter and a supervisor. IPv6 flags and destination are bound. |
| 5 | `91e70cd..d5c1a4b` | `eb18c44`, `d5c1a4b` | The proxy accepts Chromium's CONNECT. Per-tunnel events close one tunnel (P35, P36, P37). The header bound and admission pinning are bound. Bytes read across the idle deadline are examined before a per-tunnel close. |
| 6 | `d5c1a4b..35daf35` | `24295f6`, `650c3a5`, `0fb05ab`, `05488a4`, `61c29bd`, `29c0fe8`, `35daf35` | vsock challenge-response (E3, C4) in the guest proxy and the reopened M2 host broker; per-slot ends (P38); after the owner's decision, 16 reusable relay lanes (P40, P41); a fail-closed relay backstop. The owner accepted the broker diff `d5c1a4b..35daf35` (section 9). |
| 7 | `35daf35..cb0b85f` | `f3aab0f`, `c332c23`, `d022f20`, `022131a`, `cb0b85f` | Cross-process proxy authority (E4, C5): report A, then `/proc`, then report B. The in-process gate is replaced (R11). `/proc/self/fd` is listed through an owned directory fd (P43). C5 gains the report-rows note and C10 the current-check race. |
| 8 | `cb0b85f..fa14b11` | `fa14b11` | The BROWSER outer seccomp filter is aligned with the Chromium namespace sandbox (E1, C6, R1, R2). The other roles' filters are byte-identical. |
| 8b | `fa14b11..69ed46e` | `f4bca4b`, `3596490`, `69ed46e` | Owner-added. Every role enters its view by pivot_root, never chroot (E-1). The E-1b admission rule is decided for Task 11. A strict allowlist test binds the outer helper after the inner fork. |
| 9 | `69ed46e..04a1377` | `b99d395`, `5aaafb6`, `04a1377` | Native attestation checks are bound and the native kernel port is sealed (T8-04, T8-05). Probe-epoch provenance is anchored to the sealed port and to the probe module's own `_confinement()`. |
| 10 | `04a1377..7459511` | `7516f8d`, `7459511` | The probe catalogue attempts and observes what it claims (T8-01..T8-03): real theft attempts, an outcome-based AArch32 probe (P53), parent-side positive controls (P54), and a console probe aimed at the controller-UID fixture (P52 amended). |
| 11 | `7459511..fdb6f3e` | `3cd8631`, `ecd8a46`, `be9f0bd`, `fdb6f3e` | Event literals are bound through ABI-PIPELINE (CB-I3). The Chromium launch family is modelled on initial-namespace pids, with E-1b admission (CB-I4; P58–P65). Unicast audit framing (P62) and a serial window (P63). The CB-I6 launch latch and fence are bound. |
| 12 | `fdb6f3e..5116fa9` | `d293969`, `c5462a6`, `5116fa9` | Credential framing is identical on host and guest (E6, C8). Raw TTY with TCSAFLUSH and TIOCEXCL. No credential is reachable through exceptions. The restore finishes even when a signal handler raises. |
| 13 | `5116fa9..f038470` | `0b71430`, `f038470` | Controller state machine: every failure outcome is bound, safe sign-out state is added, the P19 invariants hold, and an initial-state constructor exists. A tick in DONE is a no-op. |
| 14 | `f038470..4f39a98` | `30c5cd4`, `08c7f6f`, `4f39a98` | Per-role storage inside each view (E5, C7): admission runs in the pre-exec helper; cleanup runs in a confined child and removes what the role created (P66); every cleanup wait is clamped to the shared budget (P67). |
| 15 | `4f39a98..a7d26e4` | `234a6f4`, `45e2353`, `a7d26e4` | Browser routing: the first navigation is `/login`; all headers and every asset go through admission; zero-length request evidence is accepted (P68); the pinned Chromium accept values are admitted exactly (P69); redirects are terminal (P70). |
| 16 | `a7d26e4..9e1996c` | `a92cf8b`, `9e1996c` | Browser sessions and role ports are branded; descriptor checks observe real families; the legacy HMAC frame path is removed (P28); the children of every thread are walked. |
| 16b | `9e1996c..508c2c0` | `508c2c0` | Controller-added (P71): CONFIG_PROC_CHILDREN is required in the v2 kernel-feature lists. The event reference is unchanged. |
| 17 | `508c2c0..bf2a1a0` | `f3ad862`, `bf2a1a0` | Readiness and owner gates are derived from worker observations (T13 I-4, I-5, I-9). Maintenance proofs are bound to the session's own trust context (P72). |
| 8c | `bf2a1a0..7bc192b` | `7bc192b` | Owner-added: BROWSER may open AF_INET/AF_INET6 SOCK_STREAM sockets with IPPROTO_TCP. No IPPROTO_UDP is admitted. |
| 16c | `7bc192b..6d87337` | `6b11e20`, `d242a37`, `6d87337` | Owner-added: the bootstrap inspects the browser family as root at LAUNCH, POST_LOAD and FINAL (P73–P80). Every block device is denied, and a live member is not dropped between scans. |
| 18 fix wave | `6d87337..6d6c894` | `c4c526e`, `4d9e42e`, `d8a6b30`, `94daa84`, `b06fa10`, `e8fff93`, `1f6982f`, `9bdd86c`, `b6896aa`, `6d6c894` | F1–F6 from the final review and the verification (section 8). |

## 3. Commands and counts

### 3.1 Commands

The global-constraints shorthands, run from the worktree root. `$RM_PY`, `$RM_NODE` and `$RM_SWIFT` are the pinned interpreters. Python always runs with `-B` and `PYTHONDONTWRITEBYTECODE=1`. Python and Node always run under `sandbox-exec -f "$RM_SB"` (outbound IP denied, P31). `TMPDIR` is a physical, non-symlinked directory, checked before every batch.

| Label | Command |
|---|---|
| PY-ONE(file) | `"$RM_PY" -B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p <file> -v` |
| PY-ALL | `"$RM_PY" -B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p '*_test.py' -v` |
| NODE-ONE(file) | `"$RM_NODE" --test tooling/production-acceptance/tests/unit/<file>` |
| NODE-ALL | `"$RM_NODE" --test tooling/production-acceptance/tests/unit/*.test.cjs` |
| Producers | `M3_APPLIANCE_OUTPUT=… PY-ONE(appliance_test.py)`; `TASK10_TOPOLOGY_OUTPUT=… "$RM_PY" -B -m unittest tooling/production-acceptance/tests/unit/topology_test.py -v`; `RECEIPT_EXCHANGE=… NODE-ONE(receipts.test.cjs)`; `BOOTSTRAP_V1_EXCHANGE=… PY-ONE(bootstrap_composition_test.py)`. Every output path is absent beforehand. |
| SWIFT-ALL | The composition plan's offline recipe: `"$RM_SWIFT" test --package-path tooling/production-acceptance/host` with a private scratch, cache, config and security path, `--disable-dependency-cache --disable-experimental-prebuilts --disable-prefetching --disable-automatic-resolution --skip-update --disable-netrc --disable-keychain --manifest-cache local -j 1 --disable-xctest --enable-swift-testing` and the testing plugin path. Inputs: `M3_APPLIANCE_INPUT`, `TASK10_TOPOLOGY_INPUT`, `BOOTSTRAP_V1_HANDOFF_INPUT`, `RECEIPT_NODE_INPUT`; outputs `RECEIPT_EXCHANGE` and `CREDENTIAL_FRAME_EXCHANGE`. SWIFT-ONE(suite) adds `--filter <suite>`. |
| Consumers | `BOOTSTRAP_V1_INPUT=…/roles.json NODE-ONE(bootstrap-composition.test.cjs)`; `RECEIPT_SWIFT_INPUT=…/swift.json NODE-ONE(receipts.test.cjs)`; `CREDENTIAL_FRAME_INPUT=…/credential-frames.json PY-ONE(intake_test.py)` |
| BROAD | PY-ALL, NODE-ALL, the producers, SWIFT-ALL, then the consumers, in that order |

### 3.2 Step 1: exact-tree checks, at `6d87337` — PASS

- Index clean; tracked worktree clean before and after Step 2.
- 54 changed paths since `8f979c8` (2 added, 52 modified) across 57 commits, mapped to 171 (path, task) pairs. Every pair is covered by a task's Files list, an added task's brief (8b, 8c, 16b, 16c) or a named ruling or deviation (P2, P13, P14, P51, P68, P69, P71). Uncovered: 0.
- Unchanged since `8f979c8` (SHA-256):
  - design `docs/PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md` `61fb4ab7…73a6`;
  - original plan `docs/superpowers/plans/2026-09-30-production-acceptance-controller.md` `3a194c81…4eaa`;
  - amendment `docs/BOOTSTRAP_COMPOSITION_V1_AMENDMENT.md` `72075bae…92bc`;
  - decisions `docs/STAGE1_REMEDIATION_DECISIONS.md` `fe488d46…9142`;
  - event reference `tooling/production-acceptance/appliance/bootstrap-event-reference.json` `a2e1be57…be7d`, with all five pins (P25) carrying the full digest.
- No package file changed anywhere since `8f979c8`. There is no root `package.json` or `package-lock.json`.
- The fix wave changed neither the event reference nor `EgressBroker.swift` (controller check over `6d87337..6d6c894`).

### 3.3 Step 2: fresh full run, at `6d87337` — PASS

Run 2026-11-20 20:51:39Z–20:55:46Z. 38 runs, all exit 0, 0 failures.

| Group | Runs | Result |
|---|---|---|
| Producers | appliance, topology, receipts, composition | 57 OK, 112 OK, 149 pass, 73 OK; all five outputs present |
| PY-ONE | abi_coverage 56, appliance 57, bootstrap_composition 73, bootstrap_reference 9, confinement 135, intake 15 (1 skip), protocol 11, proxy 106, storage 32, topology 112 | sum 606 = PY-ALL |
| NODE-ONE | bootstrap-composition 41 (39 pass, 2 skip), browser 83, budget 22, contracts 11, m1-admission 41, observation 32, receipts 149, role-ports 30, route-policy 37, session 9, state 37 | sum 492 = NODE-ALL |
| SWIFT-ONE | Contracts 12, Console 11, Broker 71, BootstrapGate 68, ReceiptInput 3, Receipt 18 (the filter also matches ReceiptInput), VMConfiguration 42 | sum 222 = SWIFT-ALL |
| PY-ALL | — | 606 OK, 1 skip |
| NODE-ALL | — | 492 tests: 490 pass, 2 skip, 0 fail |
| SWIFT-ALL | — | 222 tests in 7 suites passed, 2 known issues |
| Consumers | composition, receipts, intake | 41/41 (0 skip), 150/150, 15 OK (0 skip) |

**Skips.** Only input-absent skips, each run bound in its consumer step:

| Ordinary-run item | Reason | Consumer |
|---|---|---|
| `IntakeTests.test_swift_credential_frames_decode_in_python` | `CREDENTIAL_FRAME_INPUT` absent | intake consumer: ok (15 run, 0 skipped) |
| `v1_python_authenticated_cancel_at_each_forwarder_window_is_terminal` | `BOOTSTRAP_V1_INPUT` absent | composition consumer: pass |
| `v1_python_transcript_each_hop_substitution_and_replay_are_denied` | `BOOTSTRAP_V1_INPUT` absent | composition consumer: pass |
| `v1_python_browser_family_result_accepted_and_bound` | not a skip: passes with the diagnostic that the Python pair is not checked | composition consumer: pass, pair checked |
| `actual_swift_generated_all_five_verified_node_and_tamper_domain_signer_denied` | not a skip: registered only when `RECEIPT_SWIFT_INPUT` is set (149 in ordinary runs) | receipts consumer: pass (150) |

**Known issues, not skips:** the two Swift `withKnownIssue` tripwires at `ConsoleTests.swift:291` and `:303`. They mark the Stage 2 serial-input pipe-peer check (Task 12, P26 row 6; C10).

### 3.4 Fix-wave runs

| Commit | Run | Result |
|---|---|---|
| `c4c526e` tree (before `94daa84`, `b06fa10`) | NODE-ALL | 494 pass, 2 skip (`BOOTSTRAP_V1_INPUT`), 0 fail |
| `9bdd86c` | BROAD: PY-ALL | 615 OK, 1 skip (`CREDENTIAL_FRAME_INPUT` absent; bound by the intake consumer) |
| `9bdd86c` | BROAD: NODE-ALL | 494 pass, 2 skip (`BOOTSTRAP_V1_INPUT`; bound by the composition consumer), 0 fail |
| `9bdd86c` | BROAD: producers | appliance 57 OK, topology 120 OK, receipts 149/149, composition 73 OK |
| `9bdd86c` | BROAD: SWIFT-ALL | 222 tests in 7 suites passed, 2 known `ConsoleTests` issues |
| `9bdd86c` | BROAD: consumers | composition 41/41 (0 skip), receipts 150/150, intake 15 OK (0 skip) |
| `b6896aa` | focused topology run | OK (adds one subtest) |
| `6d6c894` | SWIFT-ONE(BrokerTests) | 73/73 (71 plus the two F6 tests) |

**Not run at `6d6c894`:** a full BROAD. `b6896aa` adds one topology subtest and `6d6c894` adds Swift test code in `BrokerTests.swift` only, so each was covered by its focused run and its mutant control. The last full BROAD is at `9bdd86c`.

## 4. Mutation replay

### 4.1 Step 3 replay of every task's kill list (P83), on exports of `6d87337`

Kill list: every `mutations*.jsonl` record from Tasks 2–17, 8b, 8c, 16b and 16c whose final record is KILLED, with its recorded killing tests (696 mutants). Controls, recorded survivors replaced by a strengthened re-run, aborted exports and the documented equivalent mutant RIE-1 were excluded and listed. One export per task, a control per export and kind, Swift mutants each in their own scratch path (P24), and every export checked equal to `git archive 6d87337` afterwards.

| Task | Mutants | Killed | Re-anchored, killed | Superseded | Survived |
|---|---|---|---|---|---|
| 2 | 8 | 8 | 0 | 0 | 0 |
| 3 | 27 | 26 | 1 | 0 | 0 |
| 4 | 15 | 15 | 0 | 0 | 0 |
| 5 | 45 | 38 | 7 | 0 | 0 |
| 6 | 50 | 40 | 2 | 8 | 0 |
| 7 | 22 | 22 | 0 | 0 | 0 |
| 8 | 10 | 9 | 1 | 0 | 0 |
| 8b | 46 | 46 | 0 | 0 | 0 |
| 8c | 8 | 8 | 0 | 0 | 0 |
| 9 | 59 | 56 | 2 | 0 | 1 (F-1) |
| 10 | 29 | 26 | 3 | 0 | 0 |
| 11 | 68 | 55 | 7 | 6 | 0 |
| 12 | 64 | 58 | 6 | 0 | 0 |
| 13 | 35 | 34 | 1 | 0 | 0 |
| 14 | 36 | 36 | 0 | 0 | 0 |
| 15 | 29 | 29 | 0 | 0 | 0 |
| 16 | 51 | 42 | 5 | 4 | 0 |
| 16b | 3 | 3 | 0 | 0 | 0 |
| 16c | 48 | 47 | 1 | 0 | 0 |
| 17 | 43 | 41 | 2 | 0 | 0 |
| **Total** | **696** | **639** | **38** | **18** | **1** |

- Every control on every export passed. Two control rows first read CONTROL_FAIL only because a named test had been removed by a later task; the runner gained a test-existence check and both controls passed on re-run. No mutant row was recorded under a failed control.
- Two partial kills are counted as killed: Task 16 CODEMAP and Task 17 X6. In each, one recorded test still fails and the others now pass, because 16c and P72 replaced the code they exercised.
- No kill came from a load error (logs grepped for SyntaxError, ImportError and ReferenceError).
- **Superseded (18)**, each with its cause:
  - Task 6, 8 mutants: the lane redesign `61c29bd` (owner decision, P40, P41) made the mutated behaviour intended or removed the recorded test. The successors LR-L1a, LR-L2, LR-L3, LR-L4 and LR-L8 are killed. Where an anchor still applies, the full BrokerTests suite fails, except for the two F-2 mutants.
  - Task 11, 6 mutants: E6 and the four P46 mutants by `ecd8a46` (P61 supersedes P46); `p64-serial-comparison-dropped` by `fdb6f3e` (P65 amends P64). Their successors are killed.
  - Task 16, 4 mutants: `6b11e20` (Task 16c, owner decision, P79) removed the worker's family inspection. The 16c successors are killed.
- **F-1, re-mapped kill.** Task 9 `FX-native`, re-anchored to `tests/guest/confinement_probe.py:1258`, was no longer killed by its recorded test (`confinement_test.py::test_native_kernel_port_requires_seal`, subtest "native over offline port"), because Task 9's fix round `04a1377` put the module-anchor clause first. The same mutation is killed at `6d87337` by `bootstrap_composition_test.py::test_native_fixtures_reject_substituted_confinement_module` (subtest `construct='anchored module, offline port'`). The clause is bound; only the recorded kill pair was stale. It is recorded as a re-mapped kill, with no code change.
- **After F-1:** 696 = 639 killed + 38 re-anchored and killed + 1 re-mapped kill + 18 superseded. No survivor remains.
- **F-2, coverage gap in accepted M2 code.** Task 6 `F1-P39-pending-eof-failure-whole-run` and `F1-P39-ended-slot-eof-failure-whole-run` still apply at `6d87337`. They drop the `catch is GuestStreamClosed` clauses at `EgressBroker.swift:261` and `:521`, which P40 uses for "a launcher END that arrives first ends only this slot". Their recorded test was removed by `61c29bd`, and with either mutant the full BrokerTests suite (71) passed. Ruled into the fix wave as F6, test only, with `EgressBroker.swift` unchanged (section 8).

### 4.2 Fix-wave mutants (P1, on `git archive HEAD` exports, each with a passing control)

| Item | Export | Mutants | Result |
|---|---|---|---|
| F1, F2, F5 | `b06fa10` | `F1-drop-controller-r2`, `F1-drop-worker-r2`, `F1-partial-above-ff-r2`, `F1-partial-no-del-r2`, `F1-worker-raw-check-removed-r2`, `RB-2-r2`, `RA-obs-mode-r2`, `RA-obs-dir-r2` | 8/8 killed |
| F3, F4 | `9bdd86c` | `F3-get-mask-31`, `F4-second-2000-accepted`, `F4-1305-after-install-accepted`, `F4-foreign-syscall-pid-accepted`, `F4-send-syscall-check-dropped`, `F4-1305-body-comparison-skipped`, `F4-drain-removed`, `F4-drain-removed-b`, `F4-extra-1305-tolerated`, `F4-1701-nonterminal` | 10 killed; the extra `F4-1305-after-install-clause-deleted` survived |
| F4 follow-up | `b6896aa` | `F4-1305-after-install-clause-deleted-p3r2`, `F4-1305-after-install-accepted-p3r2` | both killed |
| F6 | `6d6c894` | `F6-pump`, `F6-pending` | 2/2 killed |

- F3/F4: 11 distinct mutants, all killed in the end. The ledger counts them as 11/11; the re-review counts 12 kill records, because one mutant was re-run at `b6896aa`.
- The first F1 batch at `d8a6b30` had four runner anchor errors and one hang. They are recorded, and the set was re-run at `b06fa10`.

## 5. Disposition of the 47 Important findings

Dispositions: **fixed offline** (closed at HEAD with a binding test and recorded kills); **fixed offline, Stage 2 confirms** (closed offline; a native fact is in C10); **fixed offline in the module; composition carried to C10**. Review A is the whole-M4 offline review and review B the M5–M7 review; each confirmed its findings at `6d87337` in its §4. The fix wave's re-review confirmed the later commits.

| Finding | Short title | Owning task | Commit(s) | Disposition | Final reviewer |
|---|---|---|---|---|---|
| T8-01 | Theft probes never attempt cross-role theft | 10 | `7516f8d`, `7459511` | fixed offline, Stage 2 confirms (controller-UID fixture per family; `confirm_reachable` from outside) | review A §4 |
| T8-02 | ABI probe accepts any signal; unrealisable cases | 10 | `7516f8d`, `7459511` | fixed offline, Stage 2 confirms (P53; AArch32 behaviour; `SECCOMP_ARCH_KILL` branch) | review A §4 |
| T8-03 | `exact_fd_inventory` probe makes no observation | 10 | `7516f8d`, `7459511` | fixed offline | review A §4 |
| T8-04 | 14 of 19 `/proc` attestation mutants survive | 9 | `b99d395`, `5aaafb6`, `04a1377`; fix wave `d8a6b30` | fixed offline (the last two survivors killed by F5) | review A §4, m-2; re-review F5 |
| T8-05 | Test doubles accepted as a native kernel port | 9 | `b99d395`, `04a1377` | fixed offline, Stage 2 confirms (the native embedding passes `_confinement()`) | review A §4 |
| T8-06 | Outer filter blocks the Chromium sandbox (E1) | 8, 8b, 11, 8c | `fa14b11`; `f4bca4b`, `3596490`, `69ed46e`; `3cd8631`..`fdb6f3e`; `7bc192b` | fixed offline, Stage 2 confirms (a real sandbox start; ASSUMPTIONS A1–A9 and additions) | review A §4 |
| T9-1 | `parse_connect` rejects Chromium's `Proxy-Connection` | 5 | `eb18c44` | fixed offline | review A §4 |
| T9-2 | A per-tunnel event ends the whole run | 5 (proxy), 6 (broker) | `eb18c44`, `d5c1a4b`; `24295f6`..`35daf35` | fixed offline, Stage 2 confirms (launcher obligations P40/P41) | review A §4 |
| T9-3 | vsock "authentication" is a self-comparison (E3) | 6 | `24295f6`..`35daf35` (owner-accepted) | fixed offline | review A §4 |
| T9-4 | Admission-pinning test passes with admission deleted | 5 | `eb18c44` | fixed offline | review A §4 |
| T9-5 | Serving-loop 4096-byte header limit unbound | 5 | `eb18c44`, `d5c1a4b` | fixed offline | review A §4 |
| T10-1 | Cross-clock freshness; no host challenge (E2) | 3 | `6052554`, `4a574d7`, `326c123`, `ba18961`, `c5e6277` | fixed offline, Stage 2 confirms (barrier latency inside 100 ms) | review A §4 |
| T10-2 | Every `ipv6_route` row rejected | 4 | `f4ea420`, `91e70cd` | fixed offline, Stage 2 confirms (`lo` bounce) | review A §4 |
| T10-3 | Plan-named negative tests absent; 7 mutants survive | 4 | `f4ea420`, `91e70cd` | fixed offline | review A §4 |
| T10-4 | Legacy IP probes at documentation addresses | 4 | `f4ea420` | fixed offline (legacy names deleted) | review A §4 |
| T10-5 | N5-A (gate restriction and regression) | 4 | `f4ea420` | fixed offline | review A §4, §6 |
| T10-6 | N5-B (gate-level regression) | 4 | `f4ea420` | fixed offline | review A §4, §6 |
| T10-7 | 1 ms legacy capture bound | 3 | `6052554` | fixed offline, Stage 2 confirms (barrier latency) | review A §4 |
| T10-8 | Guest topology test is all doubles | 4 | `f4ea420` | fixed offline, Stage 2 confirms (the gated native test runs only in a real guest) | review A §4 |
| CA-I1 | Shared 60 s window armed by routine probe cleanup (E7) | 2 | `d6bff51` | fixed offline | review A §4 |
| CB-I1 | Same as CA-I1, plus the activation-deadline coupling (E7) | 2 | `d6bff51` | fixed offline | review A §4 |
| CB-I2 | No cross-process proxy authority (E4) | 7 | `f3aab0f`, `c332c23`, `d022f20`, `022131a`, `cb0b85f` | fixed offline, Stage 2 confirms (current checks under traffic; `listdir` dup; epoll `tfd:`) | review A §4 |
| CB-I3 | Event literals and audit-loss semantics unbound | 11 | `3cd8631`, `ecd8a46`; fix wave `e8fff93` | fixed offline (review A I-1 found the bound literal 31 had the wrong semantics; F3 fixed it) | review A §4; re-review F3 |
| CB-I4 | Transition validator: no pinned exec; stuck CLONE; EXIT unreachable | 11 | `3cd8631`, `ecd8a46`, `be9f0bd`, `fdb6f3e` | fixed offline, Stage 2 confirms (family model natively; review A m-1, m-3) | review A §4 |
| CB-I5 | Late acquisition racing cleanup never stopped | 2 | `d6bff51` | fixed offline | review A §4 |
| CB-I6 | Worker launch latch and fence correlation unbound | 11 | `3cd8631` | fixed offline | review A §4 |
| CB-I7 | Proxy substitution and completeness checks unbound | 7 | `f3aab0f`, `c332c23`, `d022f20` | fixed offline | review A §4 |
| T11-I1 | Credential reachable through exceptions | 12 | `d293969`, `5116fa9` | fixed offline | review B §4 |
| T11-I2 | Privacy and terminal tests cannot fail | 12 | `d293969`, `c5462a6`, `5116fa9` | fixed offline | review B §4 |
| T11-I3 | Host and guest credential formats incompatible (E6) | 12 | `d293969`; fix wave `c4c526e`, `94daa84`, `b06fa10` | fixed offline, Stage 2 confirms (the intake handshake; review B RB-I1 fixed by F1) | review B §4; re-review F1 |
| T12-I1 | Failure-outcome gates unbound | 13 | `0b71430`, `f038470` | fixed offline | review B §4 |
| T12-I2 | P-phase traffic denied | 13 | `0b71430` | fixed offline | review B §4 |
| T12-I3 | `SAFE_SIGN_OUT` cannot be admitted; no outcome | 13 | `0b71430`, `f038470` | fixed offline in the module (reducer); the end-to-end sign-out path is carried to C10 (RB-M4) | review B §4 |
| T12-I4 | `validState` accepts inconsistent states; no initial constructor | 13 | `0b71430` | fixed offline | review B §4 |
| T18-I1 | One caller manages every role's storage (E5) | 14 | `30c5cd4`, `08c7f6f`, `4f39a98` | fixed offline, Stage 2 confirms (no native storage port yet) | review B §4 |
| T18-I2 | Storage model contradicts role layout (E5) | 14 | `30c5cd4` | fixed offline, Stage 2 confirms (appliance init mounts the crash tmpfs) | review B §4 |
| T18-I3 | Deletion-scope test vacuous | 14 | `30c5cd4`, `08c7f6f` | fixed offline | review B §4 |
| T13 I-1 | First navigation `/` denied | 15 | `45e2353`, `234a6f4` | fixed offline | review B §4 |
| T13 I-2 | `Authorization` header dropped, request continued | 15 | `45e2353`, `a7d26e4` | fixed offline, Stage 2 confirms (the full header set, RB-M6; P69 values) | review B §4 |
| T13 I-3 | Document and post-READY asset bytes unvalidated | 15 | `45e2353` | fixed offline, Stage 2 confirms (assets load during `/login`, RB-I2) | review B §4 |
| T13 I-4 | Readiness unbound; proof mintable from a literal | 17 | `f3ad862`, `bf2a1a0` | fixed offline | review B §4 |
| T13 I-5 | Owner/readiness policy gate has no honest input | 17 | `f3ad862`, `bf2a1a0` | fixed offline in the modules; the composition wiring is carried to C10 (Task 17 E-1) | review B §4 |
| T13 I-6 | Descriptor inventory cannot see vsock or `hvc0` | 16, 16c | `a92cf8b`, `9e1996c`; `6b11e20`, `d242a37`, `6d87337` | fixed offline, Stage 2 confirms (the 16c C10 bullets) | review B §4 |
| T13 I-7 | Route denials swallowed | 15 | `45e2353`; fix wave `4d9e42e` | fixed offline (the REPLAY_PRIVATE exemption bound by F2) | review B §4; re-review F2 |
| T13 I-8 | Duck-typed port and session accepted | 16 | `a92cf8b`, `9e1996c` | fixed offline (the RB-M8 native-port rule is in C10) | review B §4 |
| T13 I-9 | `fresh`/`source`/`brokerError`/`noError` hard-coded | 17 | `f3ad862` | fixed offline | review B §4 |
| T13 I-10 | 12 checks with no binding test | 16 | `a92cf8b`, `9e1996c` | fixed offline | review B §4 |

Totals: 47 rows, 27 in review A's scope and 20 in review B's. 28 fixed offline; 17 fixed offline with a Stage 2 confirmation; 2 fixed offline in the module with the composition step carried to C10 (T12-I3, T13 I-5). No Important finding is only carried. Every one fails closed at HEAD.

## 6. Disposition of the Minor findings

### 6.1 The 58 Minor findings of the Stage 1 review

| Minor | What | Disposition |
|---|---|---|
| T8-07 | Named unit tests prove less than their names say | Fixed in Task 9: tests renamed and fixed, every old assertion kept; `validate_channel_message` and `proxy_endpoint` deleted, with replacements named. |
| T8-08 | TSYNC result check masked by the double | Fixed in Task 9: the double reports seccomp 2 regardless of TSYNC, so M12 is bound. |
| T8-09 | Attestation fields echoed, not observed | Fixed in Task 9 (`tty_nr` and `Seccomp_filters` observed; W1–W6 killed). The remaining drift subtests were added by F5 (`d8a6b30`). |
| T8-10 | `Descriptor.peer` names the wrong peer | Fixed in Task 9: peer `BOOTSTRAP` for every role, and the Swift peer rule (P13). |
| T8-11 | role-ports argv/FD test binds only grant identity | Fixed in Task 11: `activateOnce` projection, comment corrected, extra mutant killed. |
| T8-12 | Assorted probe-strength gaps | Fixed in Task 10: console nodes opened for read and write; last mountinfo row per mount point (P51); `KERNEL_ERRNO` basis documented. |
| T8-13 | Library-code probes claimed a kernel boundary | Fixed in Task 10: basis `LIBRARY_RECHECK`; `invalid-filter-einval` rename. |
| T9-6 | STOP or EOF does not stop admission on the legacy path | Fixed in Task 5 (mutant I killed). |
| T9-7 | Control frame phase and event are constants | Fixed in Task 6 as a comment: the route gate, not the phase field, enforces phase (lane review item 8). |
| T9-8 | `firstSequence` ceiling assumes 16 tunnels | Fixed in Task 5: 1024 tunnels per run, ceiling `MAX_SAFE_INTEGER - 1023` (C9, P37(2)). |
| T9-9 | Connect timeout never enforced | Fixed in Task 5 (T9-9 mutants killed). |
| T9-10 | Defensive checks with no test | Cases C and M fixed in Task 5. Mutants D, E, F, G, K and N deferred: cosmetic per the reviewer; review A agrees. |
| T10-9 | Native `::1` label decoded wrongly | Fixed in Task 4. |
| T10-10 | Topology MAC key is the run capability | Fixed in Task 3 (C3 key separation). |
| T10-11 | Post-browser current-check policy | Deferred. It was routed to Tasks 16–17, which did not settle it (review A m-4). Carried to C10. |
| T10-12 | Gate admits `supervisor=None`; owner dropped | Fixed in Task 4 (typed `CleanupFailure`; supervisor required). |
| T10-13 | No freshness in the Python consumer; no one-use claim in Swift v1 | Fixed in Task 3 (`verify_handoff` is offline only; one-use legacy claim per run). |
| T10-14 | Host device attestation is a constant | Deferred: needs the native VZ device-set authority (Stage 2 or later). Review A agrees. |
| T10-15 | Docstring overclaims | Fixed in Task 3. |
| compA M-1 | N5-B `_read` typing not bound | Fixed in Task 4 (regression test; `m1_n5b_revert` killed). |
| compA M-2 | Drift between the final check and the `finally` pop | Fixed in Task 4 (success-path re-latch; `drop_relatch` killed). |
| compA M-3 | Selector rows' identity | Fixed in Task 7 as a comment; selector provenance is bound by the `tfd:` bracket (C5). |
| compA M-4 | `BootstrapExecutableAuthority` memberwise init | Fixed in Task 9 (private init; S-M4 killed). The Task 9 M-5 text-scan residual is deferred. |
| compA M-5 | `pins(manifest:)` never executed | Fixed in Task 9 as a comment: unexercised until a reviewed native adapter exists. The Swift stays untested until Stage 2. |
| compA M-6 | Exec-bit requirement mutant survives | Fixed in Task 9: the reachable exec-bit check in `_archive` is bound (A7-validate killed). The `assemble.py:482` clause is dead for every input and stays (section 12). |
| compA M-7 | README claims "independently approved" | Fixed in Task 11 (the line-149 sentence reworded; its digest record unchanged). Task 11 review M-8: README `:108` and `:141` still presuppose an independent reference review. Deferred; the README is not edited (P25 pin). |
| compA M-8 | Exec-helper positions rest on the sample's self-report | Fixed in Task 10 as a recorded fixture-trust residual (module docstring). |
| compA D-1 | Amendment ambiguity on when the end is allocated | Fixed in Tasks 1 and 2 (the C1 D-1 sentence). |
| compA D-2 | Boot `audit=1` has no owner | Deferred: native blocker in C10. |
| compB M-1 | Flaky test from 7 ms and 3 ms real-time budgets | Fixed in Task 2 (real clock injected; `flaky_repro` 20/20). A different timing-sensitive test is noted in section 12. |
| compB M-2 | Python v2 `roleRuntime` validators lax above fd 4 | Fixed in Task 7 (shared checks in `_runtime_wire_row`). |
| compB M-3 | Consumer-gated Node tests pass vacuously | Fixed in Task 2: they skip when input is absent and run bound in the consumer step. |
| compB M-4 | Defence-in-depth checks unbound | K6 fixed in Task 2 (X3 killed); K1 in Task 11; P5 in Task 7. C2, C3, C5 and C9 deferred as documented redundancy (6.2). |
| compB M-5 | `isinstance` gates | Fixed in Task 7 (`type(x) is`). |
| compB M-6 | Store-disjointness test proves less than its name | Fixed in Task 11 for the Node test (mutant killed). No record shows a change to the Swift `v1_effect_boundary_grant_expiry_cancel_denied` or to the Python capture-failure test that M-6 also named: residual. |
| T11-M1 | TCSANOW, typeahead | Fixed in Task 12. |
| T11-M2 | 4096-byte bound unreachable in canonical mode | Fixed in Task 12 (guest non-canonical). The host 1023-byte cap is now in C8 and C10. |
| T11-M3 | Avoidable plaintext copies | Fixed in Task 12. The `_erase` window is deferred (6.4, Task 12). |
| T11-M4 | Late-signal restore | Fixed in Task 12 and its fix round. |
| T11-M5 | One-use per grant only | Run latch fixed in Task 12. Sealing `AdmissionProof` deferred to original-plan Task 22 (forward obligation). |
| T11-M6 | Console identity, TIOCEXCL, recording input | TIOCEXCL fixed in Task 12; the recording-input residual is documented in `guest/intake.py`. |
| T11-M7 | Length in `ConsumeResult` | Fixed in Task 12. |
| T11-M8 | Swift code, hex child id, partial frame | Fixed in Task 12. |
| T12-M1 | DONE not terminal | Fixed in Task 13. |
| T12-M2 | Cleanup outcome not sticky | Fixed in Task 13 (`cleanupFailed`, now listed in C9). |
| T12-M3 | No tick; clock domain | Fixed in Task 13. |
| T18-M1 | `_fail` raised inside `except` | Fixed in Task 14. |
| T18-M2 | Cleanup stops at the first root | Fixed in Task 14. |
| T18-M3 | gid, re-stat, depth, signatures | Fixed in Task 14. |
| T13 m-1 | `Seccomp > 0` | Fixed in Task 16 (worker) and 16c (family): mode exactly 2, filters at least 1. |
| T13 m-2 | Scope and catalogue deviations | Recorded in C9 by Task 1; the widening was reviewed by review B (RB-M9) and accepted. |
| T13 m-3 | Guest suites are placeholders | Fixed in Task 17. |
| T13 m-4 | Stale continuity | Fixed in Task 17. |
| T13 m-5 | Session tests only propagate errors | Fixed in Task 16. |
| T13 m-6 | No deadline at startup or in `perform` | Fixed in Task 15. |
| T13 m-7 | Family inspected once | Fixed in Task 16, then superseded by 16c (LAUNCH, POST_LOAD, FINAL). |
| T13 m-8 | Free-string worker codes | Fixed in Task 15 (`WORKER_CODE_MAP`). |
| T13 m-9 | Maintenance trust caller-supplied | Fixed in Task 17 (P72). |

Totals: 58 rows. 54 fixed in a remediation task (T9-10, compB M-4 and compB M-6 only in part, with the remainder named in the row); 1 recorded (T13 m-2); 1 deferred (T10-14); 2 deferred and carried to C10 (T10-11, compA D-2). Review B §6 confirmed the T11-M, T12-M, T18-M and T13 m folds. For the Task 8–10 and composition minors the evidence is the per-task reports and reviews; review A §8 and §11 triaged the deferrals in its scope.

### 6.2 compB M-4: checks kept as documented redundancy

compB M-4 named four defence-in-depth checks that survive mutation because an upstream check makes them equivalent. They stay as documented redundancy, as the compB reviewer allowed:
- **C2**, the checkpoint-advance check;
- **C3**, the owner `proxyRuntimeId` check, which is tautological inside `_capture`;
- **C5**, probe-epoch currency;
- **C9**, `lostCount` drift.

### 6.3 Named under P15

- **Task 12 m4.** `guest/intake.py`'s old sink handler `except BaseException → SINK_FAILED` was narrowed by Task 12 to `except KeyboardInterrupt` and `except Exception`, so `SystemExit` and `GeneratorExit` raised inside the read or the sink now propagate raw. No credential leaks: the `finally` zeroes the buffer and restores the terminal first. The Task 12 reviewer found this one unnamed narrowing; it is named here under P15, as review B §7 requires.

### 6.4 Minor findings from the per-task reviews (ledger `minor` lines), by task

"Deferred" means left as is, for the reason given; review A §11 and review B §7 triaged each in their scopes. "C10" means carried to the contract's C10 in this commit.

**Task 1**

| Minor | Disposition |
|---|---|
| OP-prefix for original-plan task numbers | Deferred: documentation only. |
| C9's decision line credits every bullet to "Not owner decisions" | Deferred: documentation only. |
| C1's P2 bullet does not list the consumers inline | Deferred: documentation only. |
| C3's owner omits Task 7 | Deferred: documentation only. |
| C2 should record R4 | Fixed in this commit (C2 bullet). |
| C4 should record R7's owner-acceptance stop | Deferred: the acceptance is recorded in section 9. |
| Appendix P18 "mutant E7" collides with decision E7 | Deferred: documentation only. |
| Header "cited in the clauses they change" overclaims | Deferred: documentation only. |
| C9 record-only widenings not content-reviewed | Reviewed by review B (RB-M9) and accepted, with the residual in section 12. |
| C7 paraphrases design §15 | Deferred: documentation only. |

**Task 2**

| Minor | Disposition |
|---|---|
| M1's killing test was added after RED | Deferred: process gap; the mutation shows it binds. |
| `routine_call` docstrings overstate the step bound | Deferred: cosmetic. |
| WAIT_EXIT starts the shared end without terminalizing | C10 (P56). |
| `stop_owned` status write outside the pass lock | Deferred: fails closed; no reader. |
| The dirty loop may retry within a pass | Deferred: accepted. |
| Two clocks in the routine step | C10. |
| Swift literal-wire half lacks two checks | Deferred: test strength. |
| `termios` and SwiftPM warnings | Known noise, not a defect. |
| Report wording about `_cleanup_remaining` | Deferred: report wording. |
| Carry: `browser-worker.cjs` inner budget allocated lazily | Moved to Task 15 by P56 and fixed there (lazy `remaining()` mutant killed). |

**Task 3**

| Minor | Disposition |
|---|---|
| Legacy `activateBrowser` has no `composition != nil` guard | C10. |
| 120000 ms deadline bound only at issuer level | Deferred. |
| `SystemBootstrapNonceSource` untested | Deferred: native. |
| Python consumer checks challenge format only | Accepted: the host is the sole freshness verifier (E2). |
| Barrier latency inside the 100 ms window | C10. |
| `AdmissionProof.hostChallenge` is `public var` | Deferred: cosmetic. |
| A test asserts docstring text | Deferred. |
| The issuer draws a nonce before the refused check | Deferred: fail-closed paths only. |

**Task 4**

| Minor | Disposition |
|---|---|
| `_routes6` row multiplicity unbounded | Deferred: fails safe. |
| Null-entry citation points at the notifier | Deferred: cosmetic. |
| `lo` bounce and CONFIG_IPV6_MULTIPLE_TABLES | C10. |
| A strict-type test narrowed | Accepted: those inputs cannot reach the gate natively. |

**Task 5**

| Minor | Disposition |
|---|---|
| C9 ceiling line outside "P35/P36 only" | Accepted; the P37 citation is added in this commit. |
| Pre-I/O idle check in `bracket` unbound | Deferred: near-equivalent under injected clocks. |
| A clock fault in `connect_expired` surfaces as TRANSPORT_LOST | Deferred: both whole-run. |
| Header-phase churn bounded only by 16 concurrent and the run lifetime | Deferred after final review: the client is untrusted and can only deny its own run (review A). |
| `termios` tracebacks | Known noise. |
| A late complete CONNECT is not checked for the 1025th-tunnel cap in `examine_late` | Deferred: the normal path latches on the next read. |
| Implementer concern: backlog and reset behaviour (P35) and real Chromium CONNECT bytes and close order | Stage 2 observation, noted here; not a separate C10 item. |

**Task 6**

| Minor | Disposition |
|---|---|
| Cross-lane ordering race | Deferred: Stage 2 observation point; fails closed `replay`. |
| RED for four Python tests was setup-driven | Deferred: compensated by post-GREEN mutants. |
| `_decode_bootstrap` maps every FD3 rule failure to INVALID_CONFIG | Deferred: outcome unchanged. |
| Guest P38(c) property not bound by a mutant | Deferred. |
| `topology_test.py` edit outside Files | Accepted (P14-eligible). |
| Proof binds the stream, not the control payload | Recorded in C4 (P39 note). |
| Untested native nonce source; unbounded `answered`; host does not enforce the 1024 total; IDENTITY_MISMATCH meaning | Accepted. |
| No end-to-end idle test on a real lane | Deferred. |
| After a P39(b) write failure, `release()` retires the lane without a drain | Overtaken by P40, which made a failed lane write whole-run. |
| After a write failure with only the read side broken, a pending read holds the slot | Overtaken by P40 (same). |
| Pending-path cancellation mapping in the real resolver and connector | Deferred: Stage 2 observation; fails closed. |
| Lane review M-1: L6 and the P39(b) write half killed only by the 60 s limit | Deferred. |
| Lane review M-2: non-EOF pipe read error untested | Deferred. |
| Lane review M-3: crossing-ENDs case does not force an interleaving | Deferred. |
| Lane review M-4: `RelayStream` defence in depth | Deferred: unreachable today; fails closed. |
| Lane review M-5: `endSlot` downcasts and starts an untracked task | Deferred. |
| Lane review M-7: C10 wording ("starts no DATA", pending END timing, "inside P40 lane records") | Deferred: wording. |
| Lane review M-9: file growth; two unrelated `finish` functions | Deferred. |
| Re-review: the backstop also fires after a clean run end | Deferred: harmless. |
| Re-review: a pending-phase END opens and then closes an origin connection | Deferred: design limit, disclosed in the owner summary. |

**Task 7**

| Minor | Disposition |
|---|---|
| T10 F-4b: the ownerless consumer does not check `flags & 3` | Deferred. The native observer checks direction, now bound by F5 (`d8a6b30`). |
| File growth | Accepted. |
| M1: `stop_owned` waits at most 1 s for PROXY_TERMINAL | Deferred. |
| M2: `stop_owned` skips `_live()`'s identity check | Deferred. |
| M4: the `a0` parser defect pinned only by a comment | Resolved by Task 11's E-1b `a0` parser and tests. |
| M5: selector `ownerId` keyed by fd and identity | Deferred: unreachable today. |
| M6: epoll `tfd:` format and `anon_inode:[eventpoll]` | C10. |
| M7: `_listing()` docstring | Deferred. |
| M8: file growth | Accepted. |
| Carries to Task 9 (kernel-gate subtest, the six method moves, CONTROLLER bound as SERVICE) | Done in Task 9. |

**Task 8**

| Minor | Disposition |
|---|---|
| M1: behavioural flag vectors are a sample | Deferred. |
| M2: `arg_allowed` docstring | Deferred. |
| M3: "11/11" counts the control | Accepted. |
| M4: a docstring claims a Swift check | Deferred. |
| M5: duplicate symbol tables | Deferred. |
| M6: stale module docstring | Deferred. |
| M7: clone namespace-flag vectors | Deferred. |

**Task 8b**

| Minor | Disposition |
|---|---|
| M1: helper test covered only two fault modes | Fixed in the fix round (`3596490`, `69ed46e`). |
| M2: a test still stubs the unused `chroot` | Deferred. |
| The allowlist checks names, not arguments | Accepted residual. |
| M3: "nothing stacked on /" | C10. |

**Task 9**

| Minor | Disposition |
|---|---|
| M-1: unbound `waiting` means "exactly one filter" | C10. |
| M-2: drift test lacks behavioural subtests | Fixed in the fix wave (F5, `d8a6b30`; review A m-2). |
| M-3: seal clause has no isolating construction | Deferred: redundant with the anchored construction check. |
| M-4: consumer type gates not isolated | Deferred: same reason. |
| M-5: Swift S-M4 kill rests on a text scan | Deferred. |
| M-6: `_role` does not re-validate two fields | Deferred: defence in depth. |
| M-7: RED on a setUp assertion; two tests without mutation records | Accepted (process). |
| M-8: no ancestor filter assumed; nativeness not on the wire | C10. |
| Fix-round residual: code writing module privates can forge | Accepted: same class as the seal's limit. |

**Task 10**

| Minor | Disposition |
|---|---|
| M-1: OBSERVED-basis EPERM/EACCES counted as denial | Deferred: still isolation. |
| M-2: parent observation reads private state | Deferred. |
| M-3: no facts digest required at run time | Deferred: defence in depth. |
| M-4: either AArch32 basis accepted | Superseded by P53. |
| M-5: exit 24 from the pinned sample | Accepted: fixture trust. |
| M-6: `CLONE_NEWUSER` in `ARG_SYMBOLS` widens the shared upper bound | Deferred: no effect today. |
| M-7: blocking `recvmsg` | Accepted: bounded by the 2 s result read. |
| m-1: `SECCOMP_ARCH_KILL` branch unreachable natively | C10. |
| m-2: ENOENT cannot mean "invisible pid" for the console probe | Deferred. |
| m-3: a citation line | Deferred: cosmetic. |

**Task 11**

| Minor | Disposition |
|---|---|
| M-2: launch-phase fragility; M-6: unbounded `family`/`exited` | Fixed by P61 (`ecd8a46`). |
| M-1: `authority.activate` abandoned on timeout | C10. |
| M-3: kill inside an audited syscall | C10. |
| M-4: retained identity semantics | C10. |
| M-5: barrier cadence for P60 | C10. |
| M-7: bare `assert.rejects`; missing mutation record; admission test omits a 200 | Deferred: cosmetic. |
| M-8: README `:108`, `:141` wording | Deferred: the README is not edited (P25 pin). |
| m-1: a malformed sequence-0 record latches with a different code | Accepted. |
| m-2: CLONE and EXEC behave the same | Deferred: comment. |
| m-3: stale `family` numbers | C10. |
| P64 implementer note: a stale member can rejoin via its parent | Accepted: reuse by a non-family process stays terminal. |
| Carry: thread TIDs added by clone3 stay in the family | Superseded by P61 (clone records no longer add pids). |
| Carry: `claimBrowserRequestEvidence` rejects `byteLength` 0 | Fixed in Task 15 (`234a6f4`, P68). |

**Task 12**

| Minor | Disposition |
|---|---|
| m1: the sink loop never checks the cancel latch | Deferred: the result is still CANCELLED. The report's claim is corrected in section 12. |
| m2: unbounded Swift `echoEnabled` waits | Deferred: test helper. |
| m3: PARMRK and IUCLC not cleared | Deferred: Linux's default input flags set neither; the boot raw rule is in C10. |
| m4: narrowed exception handler not named under P15 | Named in 6.3. |
| m5: 1023-byte operator cap only in code | Recorded in C8 and C10 in this commit. The operator prompt still has to state it (forward obligation, section 11). |
| m6: host TCSAFLUSH has no deadline and ignores ^C | Deferred: the operator is present. |
| m7: blocking guest `readv` | Deferred: narrow. |
| m8: published-record check vacuous | Deferred: bind when original-plan Tasks 19–20 publish. |
| `_erase` window: a handler raising inside it leaves the buffer unzeroed | Deferred: design §8 makes no secure-erasure claim. |
| A second raise inside the `except BaseException:` bodies can escape raw | Accepted residual. |

**Task 13**

| Minor | Disposition |
|---|---|
| M1: `readResult` in FAILED ignores the window lapse | Deferred; forward obligation (tick before reading a failure). |
| M3: a deadline failure never requests SAFE_SIGN_OUT | Forward obligation. |
| M4: FAILED-branch invariants loose | Deferred. |
| M5: cleanup-event latch after the window untested | Deferred. |
| M6: `cleanupFailed` not listed in C9 | Fixed in this commit (C9). |
| M7: CONFIRMED rests on one REVOKED result | Forward obligation. |
| No test of a malformed tick in DONE | Deferred: flagged by code. |

**Task 14**

| Minor | Disposition |
|---|---|
| `/dev/shm` inode limit is the kernel default (also M-5) | Accepted, named narrowing. Review B recommends a C7 amendment before Stage 2. |
| M-1: the P17 digest proves view agreement, not admission | Recorded in C7 in this commit. |
| M-2: the cleanup child removes before the bootstrap validates its frame | Deferred: no caller; native. |
| M-3: `crash_summary` can succeed over incomplete cleanups | Forward obligation. |
| M-4: aggregate walk grants u+rwx where u+rx suffices | Deferred. |
| M-6: two reviewer mutants survive; the doubles hide E-4 | Deferred: a gated native content test is needed before Stage 2 relies on cleanup. |
| M-7: probe pre-check misses the crash directory | Deferred. |
| M-8: crash bind identity rests on owner, mode and device | Deferred. |
| M-9: polish | Deferred; its native `list_names` point is in C10. |
| M-10: RED errors from interface moves | Accepted (process). |
| Re-review: cleanup could refuse an unstarted budget; one reap poll; CLEANUP_TIMEOUT consumers; stall code | Deferred; the CLEANUP_TIMEOUT rule is a forward obligation. |

**Task 15**

| Minor | Disposition |
|---|---|
| m1: an in-flight action can return after an integrity failure | Forward obligation (a PASS needs a clean close). |
| m2: a pre-READY failure can surface late with another code | Deferred. |
| m3: admitting continues after an expiry latch until the role stops | Deferred: the policy's own expiry still denies. |
| m4: REPLAY_PRIVATE exemption untested | Fixed in the fix wave (F2, `4d9e42e`). |
| m5: local aborts are silent | Deferred: no false pass. |
| m6: debatable code mappings | Deferred. |
| m7: the test fake hid the real accept value | Fixed by P69 (`a7d26e4`). |
| m8: `stopOwned` computes its allowance early | Deferred. |
| Re-review: asynchronous latch; accept not bound to request kind; `text/html` kept; duplicated redirect check | Deferred. |

**Task 16**

| Minor | Disposition |
|---|---|
| m-1: one brand for ports and pipes | Deferred. |
| m-2: the brand's trust root is any caller | Deferred; forward obligation (seal at Task 22). |
| m-3: P28 leftovers | Fixed in the fix round (`9e1996c`). |
| m-4: unix rows split by a newline in a name | Superseded by P80 (16c). |
| m-5: console detection misses `/dev/vcs*` | Superseded by P74 (16c). |
| m-6: tests register only as `require.main` | Deferred. |
| m-7: an unreachable view-level check | Deferred. |
| m-8: a redundant filter-count check | Deferred: plan-mandated. |
| m-9: family inspected only up to READY | Superseded by 16c. |
| An extra `channelKeyHex` is not rejected | Deferred. |
| Concerns: netns socket tables and race tolerance | Superseded by the 16c design (P73–P80). |

**Task 16b**

| Minor | Disposition |
|---|---|
| v2 schema minimum stays 11 | Deferred: exact-list checks enforce 15. |
| The Python v1 test checks only a constant | Deferred. |
| No separate Swift RED | Deferred: mutants cover it. |

**Task 17**

| Minor | Disposition |
|---|---|
| m-1 to m-5, m-8 | Deferred (test strength, timeouts, code naming). |
| m-6: two RED failures on a shared setup step | Deferred (process). |
| m-7: the worker requires `observation.cjs` | C10 (payload). |
| `advanceSessionTrust` can be called before the BEFORE interval completes | Deferred: an early call only invalidates BEFORE receipts. |

**Task 8c**

| Minor | Disposition |
|---|---|
| m-1: a comment overstates which test enforces exactness | Deferred. |
| m-2: "no IPPROTO_UDP is added" while an IPPROTO_UDP record exists | Fixed in this commit (C6 wording). |
| m-3: "direct UDP stays EPERM" holds only for IPPROTO_UDP | Recorded in the C6 and C10 wording in this commit. |

**Task 16c**

| Minor | Disposition |
|---|---|
| M-3: one attempt has no internal deadline | Already in C10 (Task 16c limits bullet). |
| M-4: a "flipped byte" test changes the version digit | Deferred. |
| M-5: RED on a setUp check | Deferred (process). |
| M-6: worker leftovers (`unexpectedFds` always 0) | Deferred: polish. |
| M-7: FINAL and POST_LOAD-before-credential enforced only in `browser.cjs` | Forward obligation (a PASS needs FINAL ordinal 3). |
| M-8: foreign status reads use the 8 KiB limit | Deferred. |
| Re-review: one extra status read per dropped member; no PermissionError test | Deferred: fails closed by code. |

**Task 18**

| Minor | Disposition |
|---|---|
| A timing-sensitive test failed once under load | Known flake, section 12. |

Totals: 178 rows across the 22 per-task tables in 6.4, in addition to the 58 rows in 6.1.

## 7. Option A known gaps

| Gap | Disposition |
|---|---|
| R13 layouts not parsed by the deriver | Closed beyond plan. `LAYOUT_LITERALS` holds iovec, user_msghdr, cmsghdr, sockaddr_un, sockaddr_vm, sockaddr_in, sockaddr_in6 and the capset header and data, each cited. The `ipv6_route` and `tcp6` formats have kernel-cited fixtures (Task 4). Still deferred, each failing closed: LP64 bounds and kernel-behaviour semantics; `sock_fprog` is an R13 byte-size entry. The plan appendix listed capset, sockaddr_in/in6 and `sock_fprog` as deferred; review A, the newer source, found them bound at HEAD. |
| `filter_digest` computed from the intended program | Deferred to Stage 2 (C10 "`filter_digest` read-back"). |
| I2 / R17 C3, event literals unbound | Fixed in Task 11. Review A I-1 found one bound literal (31) with the wrong semantics; F3 (`e8fff93`) fixed it. |
| `fields[0]` / `operators[0]` | Fixed in Task 11. |
| R17 C4, string ABI values | `'0A'` fixed in Task 4 (`_TCP_LISTEN = 10`, R13, P34); `'c00000b7'` fixed in Task 11. |
| I1, probe catalogue outside every sweep | Fixed in Task 10. |
| m2, records do not cite the definitions they reference | Deferred: no record is affected. |
| m3, `.cjs` `Seccomp > 0` | Fixed in Task 16 (T13 m-1). |
| m4, ptrace `TRACEME` | Fixed in Task 10. |
| Selector limits G01/G02 | Deferred, accepted by review A as a residual of AST-based binding: the ABI-PIPELINE oracles, the coverage SHA pins and the exact per-site rows bound the realistic regressions. |
| Pre-existing composition flake | Fixed in Task 2 (real clock injected; 20/20). |

## 8. Final review and fix wave

### 8.1 Verdicts

| Review | Scope | Verdict | Counts |
|---|---|---|---|
| Review A (`task-18-review-a.md`) | Original Tasks 8–10, the amendment and its plan, remediation Tasks 1–11, 8b, 8c | **REJECT (narrow)** | 0 Critical, 2 Important (I-1, I-2), 6 Minor (m-1..m-6). All 27 in-scope Important findings fixed offline; C1–C6, R1, R4, R6 met; N5-A, N5-B, N3 closed; composition review R1–R3 met, R4 partly; no false pass. |
| Review B (`task-18-review-b.md`) | Remediation Tasks 12–17, 16b, 16c | **ACCEPT_WITH_NOTES** | 0 Critical, 2 Important (RB-I1, RB-I2), 9 Minor (RB-M1..RB-M9). All 20 in-scope Important findings closed at module level; no false pass. |
| Verification (`task-18-verification.md`) | Steps 1–3 | Steps 1–2 PASS; Step 3: 1 survivor (F-1), 1 coverage gap (F-2) | section 4 |

### 8.2 Dispositions of the final-review findings

| Finding | Disposition |
|---|---|
| A I-1: the audit health check requires mask 31; Linux 6.8 sends 0 | Fixed by F3 (P85), `e8fff93`. |
| A I-2: kernel-delivered audit records at install are terminal | Fixed by F4 (P86(a), P86(c), P86(b′), P87, P88), `1f6982f`, `9bdd86c`, `b6896aa`. |
| A m-1: no thread or process creation after install | C10. |
| A m-2: two attestation mutants survive | Fixed by F5, `d8a6b30`. |
| A m-3: Chromium bind/listen and other execs are terminal | C10. |
| A m-4: T10-11 unsettled | C10. |
| A m-5: the 2000 ms role start covers `require('playwright')` | C10. |
| A m-6: two meanings of "C1–C6, R1, R4, R6" | Section 12. |
| B RB-I1: non-ASCII credentials refused or altered | Fixed by F1, `c4c526e`, `94daa84`, `b06fa10`. |
| B RB-I2: an asset first fetched after READY fails every run | C10, and added to the brief of the owner's font work. |
| B RB-M1: REPLAY_PRIVATE exemption unbound | Fixed by F2, `4d9e42e`. |
| B RB-M2: C10 collection checklist | Done in this commit (contract). |
| B RB-M3..RB-M8 | C10. |
| B RB-M9: `browserConfig` widening | Recorded, section 12. |
| Verification F-1 | Re-mapped kill (section 4.1). |
| Verification F-2 | Fixed by F6, `6d6c894`. |

### 8.3 The fix wave (F1–F6), base `6d87337`

| Item | Source | Ruling | Commits | Change |
|---|---|---|---|---|
| F1 | RB-I1 (Important) | — | `c4c526e`, `94daa84`, `b06fa10` | Both `canonical()` encoders escape every UTF-16 unit from 0x7F to 0xFFFF as `\uXXXX`; frames are printable ASCII; readers still refuse raw bytes above 127. Credential handling is unchanged. The worker-side escape also closed a lookalike hole (`špplication/json` used to reach admission as `application/json`). |
| F2 | RB-M1 | — | `4d9e42e` | Test: the market timer's replayed private request aborts as REPLAY_PRIVATE without latching. |
| F3 | A I-1 (Important) | P85 | `e8fff93` | The AUDIT_GET reply mask must be 0 (kernel/audit.c:1236-1251); the test double sends the kernel's reply; the GET-reply and AUDIT_SET sites are bound separately. |
| F4 | A I-2 (Important) | P86(a), P86(c), P86(b′), P87, P88 | `1f6982f`, `9bdd86c`, `b6896aa` | Boot `AUDIT_KERNEL` 2000 accepted once, first, before install completes, with exact text; `AUDIT_ANOM_ABEND` 1701 always terminal `ROLE_ABNORMAL_END`; exactly the owner's two install groups accepted, by derived bodies, the owner's sendto record and PROCTITLE; an install drain bounded at 1000 ms (`EVENT_INSTALL_INCOMPLETE`); any CONFIG_CHANGE after install terminal `AUDIT_CONFIG_CHANGED`. The new ABI ids `AUDIT_KERNEL` and `AUDIT_ANOM_ABEND` went through ABI-PIPELINE; the committed oracles are byte-identical to the transcriber's; coverage `9a26cde7…f768` in both pins. |
| F5 | A m-2 | — | `d8a6b30` | Six literal-`/proc` attestation subtests (Seccomp mode 0 and 1; FD3 and FD4 directions). |
| F6 | Verification F-2 | P91 | `6d6c894` | Two BrokerTests tests bind the launcher-END-first clauses at `EgressBroker.swift:261` and `:521`, through a test stream that reports the launcher's END as `RelayStream` does. `EgressBroker.swift` is unchanged since `35daf35`. |

**A controller error, corrected.** The implementer found that P86(b)'s premise disagreed with the 6.8 kernel: the owner's install CONFIG_CHANGE records carry no `pid=` and are not standalone; each install syscall yields a full group (the 1305 records, a SYSCALL record for the netlink send, PROCTITLE, EOE). P86(b′) replaced P86(b). Both rulings are in the ledger; P86(b′) is the newer and binding one.

**Fix-wave concerns ruled:** P89 (a boot record after the first install group stays terminal), P90 (some install-group fields stay unchecked until Stage 2; in C10), P91 (F6's test stream).

### 8.4 Scoped re-review (`task-18-rereview.md`), over `6d87337..6d6c894`

The re-review's verdict, quoted:

> **Fix wave:** all findings addressed, no new Critical or Important breakage. F1–F6 are closed. Three Minor notes need no code change; record them in C10 or the report: the composed drain (NB-1), the F6 test comment (NB-2), and the standalone-1305 code (NB-3).

It checked the kernel claims against the pinned archive, the oracles (byte-identical), the coverage pins and the event reference (unchanged), the P15 accounting, and the P91 test stream against `RelayStream` on the tested paths.

**Residuals, with the controller's rulings:**

| Residual | Ruling | Status |
|---|---|---|
| NB-1: the composed admission path does not honour the P87 drain. `begin()` captures once right after install, and `EVENT_PENDING` from the still-open drain fails the run. Fails closed. | P92 | **parked; surfaced to the owner at finishing (P92).** A C10 native blocker, owner Stage 2 native event-source binding. It cannot affect any offline result, because no native event source exists. |
| NB-2: the F6 test comment at `BrokerTests.swift:1912` misdescribes `RelayStream` | P93 | Recorded in section 12; no code change. |
| NB-3: a standalone 1305 whose body matches an expected install body stays pending and ends `EVENT_INSTALL_INCOMPLETE` at the drain bound, not `AUDIT_CONFIG_CHANGED` as P86(b′) lists | P94 | Accepted, as a reconciliation of P86(b′): the record cannot be told apart from the start of an install group until EOE. Same fail-closed outcome under a different code. |

The re-review's two out-of-scope observations are in the contract: the boot `audit=1` hold of every pre-registration record (C10) and the 16380-byte usable frame body (C8).

## 9. Owner decisions and acceptances

Decisions that predate this plan are recorded by reference only:
- **Path A** (continue the production acceptance controller path, 2026-11-17): `docs/STAGE1_REMEDIATION_DECISIONS.md`, "Background".
- **E1–E7, option A** (2026-11-17): `docs/STAGE1_REMEDIATION_DECISIONS.md`, status APPROVED.

Decisions during this plan, with the owner's exact words from the ledger:

| Date | Words | In reply to | Effect |
|---|---|---|---|
| 2026-11-18 | "Start, subagent-driven" | "Start the 18-task remediation plan?" | Remediation started, subagent-driven, from `8f979c8`. |
| 2026-11-18 | "Redesign lanes now" | "Redesign the broker to one lane per guest connection before you accept it?" | Lane redesign (P40, P41; `61c29bd`, `29c0fe8`, `35daf35`). Acceptance of the broker diff was asked again after its review. |
| 2026-11-18 | "Accept, start Task 7" | "Do you accept the reviewed M2 broker change (d5c1a4b..35daf35)?" | **Acceptance of the reopened M2 broker code.** Accepted scope: `git diff d5c1a4b 35daf35 -- tooling/production-acceptance/host/Sources/AcceptanceCore/EgressBroker.swift` (+293/-44), as described by the owner summary at the top of the Task 6 report (fix round 3 text). The `55c115a` evidence exception is not reopened. `EgressBroker.swift` has not changed since `35daf35` (review A §10; fix-wave controller check). |
| 2026-11-19 | "Add the task now" | "Add a task now so Chromium's sandbox can actually start?" | Task 8b (E-1 pivot_root views; E-1b admission, built in Task 11). |
| 2026-11-20 | "Self-host the font (Recommended)" | The controller's question on the frontend's Google Fonts (Task 15 review E2) | Separate work on the frontend release line (`codex/owner-paper-mvp`), not this branch; it needs an owner-approved font download and was offered as a separate session. Review B: a passing run depends on that frontend change and on its shape: every asset must load during the `/login` load (RB-I2, C10). |
| 2026-11-20 | "Move check to the bootstrap (Recommended)" | The controller's question on the browser family inventory (Task 16 review E1) | Task 16c. |
| 2026-11-20 | "Allow IPPROTO_TCP (Recommended)" | The controller's question on the BROWSER socket protocol gate (Task 16 review E2) | Task 8c: BROWSER only, AF_INET/AF_INET6 + SOCK_STREAM + IPPROTO_TCP; no IPPROTO_UDP added. The ledger records a correction: protocol-0 SOCK_DGRAM on AF_INET/AF_INET6 was already allowed for every role, so "UDP stays blocked" means no new UDP permission. |

The three 2026-11-20 answers were option labels chosen from a question card. The contract quotes two of them without the "(Recommended)" suffix ("Allow IPPROTO_TCP", "Move check to the bootstrap"); the ledger text above is the exact record.

## 10. Controller rulings

Every `P<n>` and every unnumbered "Ruling" or "Accepted" item in the ledger. "—" means the ledger states no cost. Full text: the ledger, mirrored at `$RM_EVIDENCE/progress.md`.

| Id | What | Cost if wrong |
|---|---|---|
| P1 | Mutation evidence runs after the task's local commit, on a `git archive HEAD` export | Evidence order differs from plan text only |
| P2 | Task 2 also covers `confinement.py` and `proxy.py`; `clamp_end`; no direct deadline writes | Larger Task 2 diff |
| P3 | Long-lived local bindings for the +61 s and long-catalogue tests | None |
| P4 | The no-routine-arming test is state-based | None |
| P5 | `activateOnce` bounded by the activation/run deadline | None |
| P6 | `hostChallenge` MAC'd but excluded from the stable topology digest | A replayed digest could pass; the one-use challenge still blocks replay |
| P7 | `requireBrowserAdmission` rejects `composition == nil` | Small |
| P8 | Named vectors in a new file; Swift gets only expressible vectors | Narrower Swift coverage, labelled |
| P9 | Keep the `TopologyGate` signature; delete or re-home `Task8ProbeSource` | None |
| P10 | The bootstrap passes the `vsock-stream` key to the proxy entry | Interface rename later |
| P11 | Port methods on `_KernelPortCore`; `ProxyChildAuthority` gates on the port type | Port hierarchy rework |
| P12 | Task 7 asserts only surviving functions; Swift runtime-row vectors in their own file | None |
| P13 | Task 9 owns two more test files and the Swift peer rule | None |
| P14 | A task editing a guest module may adjust the per-site ABI tables | A reviewer must check every renumbered row |
| P15 | Narrow no-weakening exception; each deletion named and confirmed | A real loosening could be missed |
| P16 | `/dev/shm` reclaimed by namespace teardown; the unmount item moves | None |
| P17 | Storage proof: a 32-byte digest appended to the ready frame | Frame-length change reviewed in Task 14 |
| P18 | Task 11 mutant E7 renamed | None |
| P19 | `validState` for VERIFY_REVOCATION, FINALIZE and DONE | None |
| P20 | `verifyGate` keeps three arguments; `isBrowserSession` injected | None |
| P21 | Rules for the Task 1 contract check | None |
| P22 | Task 18 base `8f979c8`; `report.md` added with `git add -f` | None |
| P23 | Tasks strictly sequential | Some wall-clock time |
| P24 | Per-mutant Swift scratch paths | Rebuild time |
| P25 | Fifth event-reference pin; no task changes any pin | None |
| P26 | No host-side sink check dropped without a replacement or an accepted reason | Review cost in Task 12 |
| P27 | Task 10 relabels two probes `KERNEL_CREDENTIAL_CHECK` | None |
| P28 | Task 16 removes the legacy branch and the HMAC `rpc` path | None |
| P29 | `OfflineProbeFixtures` over a shared core | None |
| P30 | Task 2 kills the JS lazy-allocation mutant | None |
| P31 | Python and Node always under `sandbox-exec` | None |
| P32 | ABI-PIPELINE in three dispatches for Task 4 | Two extra dispatches |
| P33 | Named vectors carry ids and a `hostVerifiable` flag; Swift fixed id list | None |
| P34 | `TCP_LISTEN` as an R13 literal (implicit enumerator) | Known-uncovered derived surface; a wrong value fails closed in Stage 2 |
| P35 | A 17th concurrent client waits in the listen backlog, never latched | A slow proxy instead of a fast refusal |
| P36 | Client-socket ECONNRESET, EPIPE and ENOTCONN close only that tunnel | A misbehaving client churns tunnels, bounded by 16 and 1024 |
| P37 | Task 5 interpretations: vsock-side errors whole-run; a tunnel is one sequence; the 1025th latches; connect timeout on the run clock | — |
| P38 | Host and guest per-tunnel consistency: sequence gaps, host idle EOF record, guest close per-slot | Gaps weaken nothing; revisit if Stage 2 shows another close order |
| P39 | A lane write failure per-slot; the lane limitation in C10 | None (later reversed by P40) |
| P40 | 16 reusable relay lanes with launcher-authored OPEN/DATA/END records | Broker–launcher internal; Stage 2 can revise locally |
| P41 | Launcher obligation (c) amended; the drain keeps record checks | Launcher side only |
| P42 | Task 7 puts the methods on `NativeKernelPort`; Task 9 moves them | A small method move |
| P43, amended | `/proc/self/fd` listed through an owned fd, excluding that fd and CPython's predicted dup | A native false failure, fail closed |
| P44 | ABI-PIPELINE in three dispatches for Tasks 8, 10 and 11 | Two extra dispatches per task |
| P45 | E-1 in Task 8b; the E-1b rule implemented in Task 11 | Task 11 grows |
| P46 | Provisional family membership by ppid (superseded by P61) | Misattribution limited to the browser PID namespace |
| P47 | Task 9 fixtures use the 8b view; exact mount-point multiset | A native set correction with evidence |
| P48 | Probe: chroot("/") in a BROWSER family returns EPERM | One probe |
| P49 | Probe: unshare(CLONE_NEWUSER) succeeds in a BROWSER family | Probe catalogue digest change |
| P50 | `/dev/shm` tmpfs and crash bind placed inside the pivot sequence | Fail-closed ENOENT |
| P51 | Task 10 Files gain `confinement.py` for the mountinfo fix | None |
| P52, amended | The console probe follows the link and targets the controller-UID fixture, not pid 1 | Errno ids might need ABI-PIPELINE; none was needed |
| P53 | The AArch32 probe is outcome-based (SIGSYS or ENOEXEC) | A corrupted sample's ENOEXEC reads as denial (fixture trust) |
| P54 | Parent-side positive control before donor and trusted-name probes | The fixture authority gains a method |
| P55 | Any new errno id goes through ABI-PIPELINE | — |
| P56 | The lazy inner budget moves to Task 15; WAIT_EXIT caution | None |
| P57 | `RTM_DEL*` as R13 literals | None |
| P58 | A thread `exit` never ends the run; a root `exit_group` does | A root ending by its last thread's `exit` is caught by the supervisor |
| P59 | Chromium re-exec accepted by binary identity, not name | None if PATH parsing is exact |
| P60 | Launch records after STARTED tolerated within 1000 ms | None |
| P61 | The family uses only initial-namespace pids; ppid attribution; reuse terminal | Family-model rework |
| P62 | Unicast audit `nlmsg_len` excludes the header for AUDIT records | Small |
| P63 | Audit serials unique, not ordered; a 1024-serial window | Small |
| P64 | Exited members kept for their earlier child records (amended by P65) | Small |
| P65 | An exited member is a parent in either order within the window; `pid_max` carry | Small |
| P66 | Post-run cleanup removes what the role created, without admission strictness | Moderate |
| P67 | `run_storage_cleanup` takes the shared budget and clamps every wait | Small |
| P68 | Task 15 Files gain `role-ports.cjs` and a fixture option | None |
| P69 | Exact Chromium accept values per request kind | Small; Stage 2 confirms the strings |
| P70 | Any redirect latches ROUTE_DENIED | Small |
| P71 | CONFIG_PROC_CHILDREN required (Task 16b) | Small |
| P72 | Maintenance proofs only under the session's own trust context | Small to moderate |
| P73 | Family = PPid closure of two full `/proc` scans | — |
| P74 | Deny every device other than `/dev/null` by `st_rdev` | — |
| P75 | Retry: 5 attempts, 50 ms apart, 1000 ms total | — (Stage 2 may tighten; widening needs a decision) |
| P76 | Inspection points LAUNCH, POST_LOAD and FINAL | — |
| P77 | EACCES on a live member is terminal FAMILY_UNREADABLE | — |
| P78 | Classify by exception class and stat predicates; no numeric errno | — |
| P79 | Remove the worker's family inspection; keep its self-check | — |
| P80 | Strict 6.8 unix row grammar | — |
| P81 | Task 18 split: verification, two reviewers, one fix wave, a writer | None |
| P82 | Step 1 base and allowed path set | None |
| P83 | Step 3 replay rules (superseded, re-anchored) | Replay bookkeeping |
| P84 | Task 18 may edit the contract for C10 and the named wording fixes | Contract text only |
| P85 | The AUDIT_GET reply mask must be 0 | Small |
| P86 | (a) boot AUDIT_KERNEL once; (b) standalone CONFIG_CHANGE (replaced by (b′)); (c) ANOM_ABEND terminal | Moderate; Stage 2 confirms formats |
| P86(b′) | Accept exactly the owner's two install groups | Moderate; Stage 2 confirms LSM `subj=` and the boot backlog value |
| P87 | Install drain bounded at 1000 ms | Up to 1000 ms at install |
| P88 | Each native audit request is one `sendto(2)` to `nl_pid=0` | The native binding must follow it; another call fails closed |
| P89 | A boot record after the first install group stays terminal | A fail-closed false failure at install in Stage 2 |
| P90 | Some install-group fields stay unchecked until Stage 2 | An owner-pid sendto group with unexpected argument fields passes inside the install window |
| P91 | F6 binds the clauses with a stream that reports END as `RelayStream` does | The test double diverges from `RelayStream` |
| P92 | The composed drain gap is parked as a C10 native blocker | Every real run fails closed at admission until Stage 2 fixes it |
| P93 | The F6 comment inaccuracy is recorded, not changed | A misleading comment |
| P94 | A standalone matching 1305 ends EVENT_INSTALL_INCOMPLETE | A different terminal code for the same outcome |
| Task 1 (I2) | Add the C10 "fork from a multi-threaded bootstrap" bullet | One extra Stage 2 check |
| Task 1 (minor) | The C9 latch bullet states per-tunnel versus capacity exactly | None |
| Task 1 (minor) | The C9 record-only bullet says "content not separately reviewed" | None |
| Task 3 (minor 3) | The host issuer refuses a repeated challenge value | A few test fakes change |
| Task 4 (I-1) | Add the IPv6 flags and destination subtests | None |
| Task 6 (minor 1) | An EOF after a visible out-of-range prefix byte is whole-run | None |
| Task 6 (fix round 2) | Owner summary corrected; pending-path catch narrowed | One more short round |
| Task 6 (M-6) | Restore a fail-closed relay backstop | One line and one test |
| Task 6 (M-8) | The owner summary adds three nuances | Text only |
| Task 7 (concern d) | C5 report-rows note | None |
| Task 7 (concern c) | C10 note on current checks under proxy traffic | None now |
| Task 8b (I-1) | Strict allowlist test for the outer helper | Test-only change |
| Task 9 (compA M-6) | The deviation accepted; the earlier refusal is bound | None if confirmed (it was) |
| Task 12 (I1) | `_restore` finishes every step; any interruption is CANCELLED | Small |
| Task 12 (I2) | Correct P26 row 6; honest `serialInputFact()`; C10 pipe-peer check | Small |
| Task 12 (E1) | The intake handshake is a Stage 2 requirement | Stage 2 design work |
| Task 13 (M2) | `tick` in DONE is a no-op | None |
| Task 16 (I-1) | Walk every thread's children; finish removing the P28 leftovers | Small |
| Task 16c (P14 scope) | A per-site row for an existing id is a P14 edit | None |
| Task 16c (M-1) | A member in scan A but not B is dropped only when proven gone | Small |
| Task 16c (E-2, M-2) | Per-thread descriptor tables recorded as a residual, no code | Defence-in-depth gap only |
| Task 18 (F-2) | Add F6 to the fix wave, test only | Small |
| Accepted (Task 10) | The positive control also runs after each donor family | — |
| Accepted (Task 11) | Four extra event ids; the K1 test in Python; a one-line double change; the retained identity taken at install | — |
| Accepted (Task 11 fix round) | A malformed AUDIT or ROUTE record latches the event source | — |

## 11. C10 native blockers carried to Stage 2

C10 in `docs/STAGE1_REMEDIATION_CONTRACT.md` is the normative list; this is a summary by owner. This commit adds 68 obligation bullets under "Collected at Task 18 (P84)", grouped by area, to the 17 bullets already there.

| Owner | What C10 holds |
|---|---|
| Stage 2 appliance init and boot | Boot `audit=1`; no audit record before the owner registers; auid/ses unset; no LSM `subj=`; no `audit_backlog_limit=`; no earlier AUDIT_SET; `pid_max` at least 32768; nothing stacked on `/`; no ancestor seccomp filter; the 1 MiB crash tmpfs; hvc0 raw at boot; CONFIG_PROC_CHILDREN, CONFIG_IPC_NS and CONFIG_COMPAT; the Task 8b view facts |
| Stage 2 appliance payload | Ship and pin `storage.py`, `protocol.py` and `observation.cjs`; the Chromium binary not on overlayfs |
| Stage 2 native event-source binding | The P88 sendto contract; ack ordering; the P90 fields; the P92 composed drain; barrier cadence of at most 100 ms (P60) and barrier latency inside 100 ms; install time under 1000 ms |
| Stage 2 native kernel and storage ports | The retained Chromium identity tied to the SHA-256 pin; a native storage port; `O_PATH`/`fchmodat2` and `list_names`; `filter_digest` read-back; the `_confinement()` embedding |
| Stage 2 native host constructor and launcher | The legacy `activateBrowser` guard; the VZ relay forwarding bytes only; the P40/P41 lane protocol and launcher obligations (a)–(e) |
| Stage 2 observations on a real guest and Chromium | A real Chromium sandbox start; ASSUMPTIONS A1–A10 plus the review A m-3 additions; the Node FD inventory beyond `{0..4}`; fork after threads; the CPython `listdir` dup; epoll `tfd:`; PROXY READY/TERMINAL latency; the `lo` bounce; probe-catalogue facts (fixtures, AArch32, `SECCOMP_ARCH_KILL`); kill-in-syscall records; SIGKILL and stale family numbers; the 2000 ms role start; the browser profile directories; a real IPPROTO_TCP connect; the 16c limits, residual and RST test; the P69 accept values, the full header set, CORS preflights and the P70 redirect residual |
| Composition (original-plan Tasks 21–22 and Task 22) | `verifyGate` wiring from `currentGates()`; the controller clock and single-shot AFTER readiness; the atomic trust advance (RB-M7(a)); only real admissions as budget events (RB-M7(b)); the SAFE_SIGN_OUT path (RB-M4); the native-port rule for family evidence (RB-M8); no current check after first network use (T10-11); C5 current checks under traffic; the WAIT_EXIT caution; TOPOLOGY_CURRENT during launch lag; `authority.activate` abandoned on timeout; the intake ready record and the host-side pipe-peer check |
| Authors of the controller and verifier roles | No thread or process creation after install (review A m-1) |
| The font work on the frontend release line | Every asset requested during the `/login` load (RB-I2) |
| Stage 2 operator procedure | The 1023-byte operator credential cap |

**Forward obligations for original-plan Tasks 17 and 21–22** (review B §5.4 item 7 and the ledger; not all are C10 items):
- ignore ticks after PUBLISH_RESULT (Task 13);
- send a trusted abort before a deadline when sign-out is wanted (Task 13 M3);
- claim REVOKED only after the design §19 checks (Task 13 M7);
- tick before reading a failure (Task 13 M1);
- build the failure-path sign-out path (RB-M4);
- feed only ELIGIBLE or DENIED admissions as `budget` events (RB-M7(b));
- a PASS result requires a clean `close()` with `failureCode() === null` (Task 15 m1);
- a PASS result requires FINAL ordinal 3 to have been reached (Task 16c M-7);
- publish `crash_summary` only over COMPLETE cleanups, and treat CLEANUP_TIMEOUT and every other non-COMPLETE code as incomplete (Task 14 M-3 and its re-review);
- seal `AdmissionProof` (T11-M5) and `bindRoleBootstrap` (Task 16 m-2) when Task 22 composes them;
- state the 1023-byte cap in the operator prompt (Task 12 review m5).

## 12. Known residuals and notes

- **`appliance/README.md:149` is stale.** It says the browser worker and confinement walk `/proc/<pid>/task/<tid>/children`. Since Task 16c (P73, P79) the worker does not inspect the family; only `guest/confinement.py` still reads a `children` file. The line is not edited because it carries an event-reference digest pin (P25); P84 routes the note here.
- **Timing-sensitive test.** `test_v1_cleanup_clamps_zero_smaller_and_expired_shared_allowance` (from `d6bff51`; a 7 ms real-time allowance) failed once (`'TIMEOUT' != 'STOPPED'`) inside the `F4-second-2000-accepted-p3` mutant export, while BROAD and Swift mutant builds loaded the machine. It is unrelated to that mutation and passed in every other run.
- **Commit `94daa84`.** Its message has one garbled character where it names the `￿` escape; the tool layer converted it before git saw it. The code diff is correct. It was not amended (never amend).
- **Review A m-6.** The composition plan's Task 11 asks for dispositions of "C1–C6, R1, R4, R6". Those are the original Task 10 round-4 review decisions, whose record (`m4-task10-20261002/independent-task10-round4-review-20261003T063351Z.md`) was lost with `/private/tmp`. The original C1–C6, R1 and R4 cannot be dispositioned from evidence. Only the original R6 is traceable: it maps to amendment §5's worker-local effect guard and is bound by the CB-I6 tests. Review A answered for the remediation contract's C1–C6 and the remediation plan's R1, R4 and R6 instead (review A §5). Lost evidence is not reconstructed.
- **P93.** The F6 test comment at `BrokerTests.swift:1912` says the EOF write reports `GuestStreamClosed` "as after the slot already ended". After the broker's own END, `RelayStream.endWrite` returns silently; it reports `GuestStreamClosed` only after the launcher's END. The test double's `write` and `close` also differ from `RelayStream` on paths the tests do not exercise. No code change.
- **Review B RB-M9.** The C9 record-only `browserConfig` widening is acceptable: any non-array object crosses the transport, but the worker then validates it exactly. Residual: `importBrowserAssetBundle` verifies the release receipt with the public key carried in the same bundle, so the worker's asset pins rest on the trusted controller (design §4), not on an independent key pin.
- **compA M-6 decision.** The `ARCHIVE_UNSAFE` mode/exec-bit clause at `appliance/assemble.py:482` is dead for every input (Task 9 review): a 0o644 `bin/node` member is refused earlier with MISSING_RUNTIME. It is kept as fail-closed dead code. Removing it would need P15 naming and a separate decision.
- **compB M-6 remainder.** See 6.1.
- **Task 12 report correction.** The Task 12 implementer report says the sink loop checks the cancel latch. It does not (`guest/intake.py:235-261`); the result is still CANCELLED (`:590-591`) (review B §7).
- **What this record does not prove.** Everything native: real `/proc`, audit, netlink, vsock and VZ behaviour; a Chromium sandbox start; Node's real descriptor inventory; timing (role start, barriers, install); the Stage 2 launcher; the frontend font change. The kernel facts cited by the reviews were read from the pinned Linux 6.8 source, not observed on a kernel.

## 13. Status

**M4 status: still OPEN** (the real gate is Stage 2).

offline only; nothing pushed

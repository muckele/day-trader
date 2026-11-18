# Stage 1 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Fix all 47 Important findings from the Stage 1 independent review of the production acceptance controller, following the owner-approved design decisions E1–E7 (option A in every case). Every fix is test-first and has mutation evidence. The end state is a tree ready for the whole-M4 offline review. Everything is offline; nothing here performs a Stage 2 action.

**Architecture:** Each fix stays in the module that already owns the behaviour: `confinement.py`, `confinement_probe.py`, `proxy.py`, `topology.py`, `role-ports.cjs`, `state.cjs`, `intake.py`, `storage.py`, the browser `.cjs` modules, and the Swift `VMHost`, `EgressBroker` and `SerialConsole`. Task 1 first writes down the new cross-language contracts:
- a cleanup budget that starts only at the first terminal event
- a host-issued freshness challenge
- domain-separated keys with a per-stream vsock proof
- cross-process proxy authority
- per-role storage
- a single credential framing

Later tasks implement those contracts with shared vectors in Python, Node and Swift. Every new or changed Linux ABI literal goes through the Option A derivation pipeline. Native paths stay closed.

**Tech Stack:**
- Python 3.12.2 standard library and `unittest`
- Node 24.21.0 CommonJS and `node:test`
- Swift 6.4.2 (CLT 27.2, SDK 27.2) with Foundation, CryptoKit and Swift Testing
- the retained Linux 6.8 AArch64 archive

No new dependency.

**Spec:**
- `docs/STAGE1_REMEDIATION_DECISIONS.md`: E1–E7 all option A, approved by the owner on 2026-11-17 ("Approve all"), plus its "Not owner decisions" list.
- Review records in `.superpowers/sdd/2026-09-30-production-acceptance-controller/stage1-reviews/`: `STAGE1_REVIEW_SUMMARY.md`, `REVIEW_LEDGER.md`, `task08-report.md`, `task09-report.md`, `task10-report.md`, `compA-report.md`, `compB-report.md`, `tasks11-12-18-report.md`, `tasks13b-14-15-report.md`.
- Option A record: `.superpowers/sdd/2026-09-30-production-acceptance-controller/m4-abi-coverage-v2/report.md`, known-gaps section.
- These stay unchanged and input-only:
  - the approved design `docs/PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md` (SHA-256 `61fb4ab7…73a6`)
  - the original plan `docs/superpowers/plans/2026-09-30-production-acceptance-controller.md` (`3a194c81…4eaa`)
  - `docs/BOOTSTRAP_COMPOSITION_V1_AMENDMENT.md` (`72075bae…92bc`) and its plan `docs/superpowers/plans/2026-10-03-bootstrap-composition-v1.md`

  Changes to their normative text are recorded additively in `docs/STAGE1_REMEDIATION_CONTRACT.md` (Task 1).

**Path rule.** Paths that start with `guest/`, `tests/`, `host/`, `appliance/` or `contracts/` are relative to `tooling/production-acceptance/`. Paths that start with `docs/` or `.superpowers/` are relative to the repository root.

## Global Constraints

- **Work location.** Branch `claude/production-acceptance-stage1`, worktree `/Users/Matt/day-trader-worktrees/production-acceptance-stage1-fixes`. Never commit on `main`. Every commit is local. No push without separate owner approval.
- **Offline only.** No network, package install or download. No VM, browser launch, signing, entitlement, appliance construction, production, credential or trading action. Real native execution, including any Chromium sandbox start and any real `/proc` or kernel observation, stays behind Stage 2 approval.
- **Pinned toolchain.**
  - Python: `/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12`, always with `-B` and `PYTHONDONTWRITEBYTECODE=1`.
  - Node: `/Users/Matt/day-trader-toolchains/node-v24.21.0-darwin-arm64/bin/node`.
  - Swift: `/Library/Developer/CommandLineTools/usr/bin/swift` (CLT 27.2, Swift 6.4.2), using the composition plan's offline flags exactly as in SWIFT-ALL below.
  - `TMPDIR`: a physical, non-symlinked directory. Check `test "$(cd "$RM_TMP" && pwd -P)" = "$RM_TMP"` before every batch.
- **Sandboxing.** Run Python and Node under the same `sandbox-exec` deny-outbound-IP profile the Stage 1 controller runs used (`STAGE1_LEDGER.md`, "Safety"). If that profile cannot be located, stop and ask. Swift keeps SwiftPM's own sandbox. No Swift builds run in parallel.
- **Test-first with mutation evidence.**
  1. Every fixed finding gets its test written first.
  2. RED must fail on the named assertion, not on an import, setup or missing-fixture error.
  3. After GREEN, show each test is not vacuous. Mutate a scratch export outside the repo:
     - make the export with `git -C "$RM_ROOT" archive HEAD | tar -x -C "$RM_EVIDENCE/mutants/task-NN/<id>"`;
     - mutate only that copy and run the named test there;
     - append `{id, change, test, result}` to `$RM_EVIDENCE/task-NN/mutations.jsonl`.
  4. Each task names the mutants that must be killed.
- **ABI changes.** Any new or changed Linux ABI literal goes through ABI-PIPELINE (below). That covers the E1 filter changes, probe-catalogue binding, event-literal binding, and topology route flags and TCP states. The pipeline is:
  - new inventory entries;
  - `abi-coverage-v2.json` regenerated by the CLI with `--archive-sha256`;
  - an independent oracle transcription by a separate agent, appended to `abi_oracles.py`;
  - both `COVERAGE_V2_SHA` literals updated;
  - exact per-site binding tests.

  A derived value that disagrees with a code literal is a product finding. Stop and report it; never edit an oracle or a table to match.
- **M2 broker.** E3 reopens the M2 host broker (`host/Sources/AcceptanceCore/EgressBroker.swift`). It was accepted in October with a narrow evidence exception at `55c115a`.
  - Task 6 needs its own independent review, and that review must state that accepted M2 code is being reopened.
  - The reviewed broker diff goes to the owner for acceptance. The historical M2 evidence exception is neither reopened nor generalized.
- **No weakening.**
  - No fix may remove or loosen an existing binding, seal, exact-key check or fail-closed path, except where E1 or a listed ruling explicitly changes it.
  - `appliance/bootstrap-event-reference.json` must not change. Its digest `a2e1be5762976e07f270c6646ce5e4d94c48efcc2c78dacaf29ed3e32471be7d` is pinned in four places:
    - `appliance/manifest.schema.json:523`
    - `appliance/README.md:149`
    - `tests/unit/appliance_test.py:31`
    - `host/Tests/AcceptanceCoreTests/VMConfigurationTests.swift:54`
  - No task in this plan justifies changing it.
- **Evidence.**
  - Logs go under `$RM_EVIDENCE/task-NN/` (`red.log`, `green.log`, `broad-*.log`, `mutations.jsonl`), outside the repository and outside `/private/tmp`.
  - Never overwrite earlier evidence.
  - Commit only the task's listed Files, after `git diff --check`.
- **Review.** Every task gets a fresh-context independent reviewer who did not implement it, reviewing the exact commit. ABI oracle transcribers are separate again. No material finding is waived at a review cap.
- **Verification commands.** Use exactly the shorthand defined in the next section.

## Commands

Run from `$RM_ROOT`, with this environment:

```sh
RM_ROOT=/Users/Matt/day-trader-worktrees/production-acceptance-stage1-fixes
RM_PY=/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12
RM_NODE=/Users/Matt/day-trader-toolchains/node-v24.21.0-darwin-arm64/bin/node
RM_SWIFT=/Library/Developer/CommandLineTools/usr/bin/swift
RM_STAGE=/Users/Matt/day-trader-evidence/production-acceptance-tooling/20261117T002012Z-stage1
RM_EVIDENCE=$(mktemp -d "$RM_STAGE/remediation-XXXXXXXX")   # once per plan execution
RM_TMP=$(mktemp -d "$RM_EVIDENCE/tmp-XXXXXXXX")
RM_SWIFT_CACHE=$RM_STAGE/swift                               # existing Stage 1 serial cache root; create clang/ modules/ xdg/ if absent and record that
export TMPDIR="$RM_TMP" PYTHONDONTWRITEBYTECODE=1
unset TASK10_TOPOLOGY_INPUT TASK10_TOPOLOGY_OUTPUT M3_APPLIANCE_INPUT M3_APPLIANCE_OUTPUT RECEIPT_EXCHANGE \
      RECEIPT_NODE_INPUT RECEIPT_SWIFT_INPUT CONTRACT_EXCHANGE TASK4_FIXTURE_EVIDENCE BOOTSTRAP_V1_EXCHANGE \
      BOOTSTRAP_V1_INPUT BOOTSTRAP_V1_HANDOFF_INPUT CREDENTIAL_FRAME_EXCHANGE CREDENTIAL_FRAME_INPUT
```

| Label | Exact command |
|---|---|
| PY-ONE(file) | `"$RM_PY" -B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p <file> -v` |
| PY-ALL | `"$RM_PY" -B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p '*_test.py' -v` |
| NODE-ONE(file) | `"$RM_NODE" --test tooling/production-acceptance/tests/unit/<file>` |
| NODE-ALL | `"$RM_NODE" --test tooling/production-acceptance/tests/unit/*.test.cjs` |

**Note on PY-TOPOLOGY.** The composition plan's PY-TOPOLOGY also ran `tests/guest/topology_test.py`. From Task 4 on, that file is a gated native test, so PY-TOPOLOGY means PY-ONE(topology_test.py) only.

**Fixture producers.** Run these before every Swift batch, each in the sanitized environment. Check each result. Every output path must be absent beforehand:

```sh
RM_INPUT=$(mktemp -d "$RM_EVIDENCE/inputs-XXXXXXXX")
M3_APPLIANCE_OUTPUT="$RM_INPUT/appliance" "$RM_PY" -B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p appliance_test.py -v
TASK10_TOPOLOGY_OUTPUT="$RM_INPUT/topology.json" "$RM_PY" -B -m unittest tooling/production-acceptance/tests/unit/topology_test.py -v
RECEIPT_EXCHANGE="$RM_INPUT/node" "$RM_NODE" --test tooling/production-acceptance/tests/unit/receipts.test.cjs
BOOTSTRAP_V1_EXCHANGE="$RM_INPUT/composition" "$RM_PY" -B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p bootstrap_composition_test.py -v
RM_SWIFT_OUTPUT=$(mktemp -d "$RM_EVIDENCE/swift-output-XXXXXXXX")
```

**SWIFT-ALL.** This is the composition plan's recipe. Only the cache root and the evidence paths are re-pointed, matching Stage 1 `runs/swift-broad-2.cmd`. The fifth input, `BOOTSTRAP_V1_HANDOFF_INPUT`, is named explicitly; Stage 1 finding F-3 reports it was missing from the old recipe. `CREDENTIAL_FRAME_EXCHANGE` is added from Task 12 onward.

```sh
env -u CONTRACT_EXCHANGE -u RECEIPT_SWIFT_INPUT -u TASK4_FIXTURE_EVIDENCE \
  -u M3_APPLIANCE_OUTPUT -u TASK10_TOPOLOGY_OUTPUT -u CREDENTIAL_FRAME_INPUT \
  DEVELOPER_DIR=/Library/Developer/CommandLineTools TMPDIR="$RM_TMP" \
  CLANG_MODULE_CACHE_PATH="$RM_SWIFT_CACHE/clang" \
  SWIFTPM_MODULECACHE_OVERRIDE="$RM_SWIFT_CACHE/modules" \
  XDG_CACHE_HOME="$RM_SWIFT_CACHE/xdg" \
  M3_APPLIANCE_INPUT="$RM_INPUT/appliance/bundle.json" \
  TASK10_TOPOLOGY_INPUT="$RM_INPUT/topology.json" \
  BOOTSTRAP_V1_HANDOFF_INPUT="$RM_INPUT/topology.json.bootstrap-v1.json" \
  RECEIPT_NODE_INPUT="$RM_INPUT/node/node.json" \
  RECEIPT_EXCHANGE="$RM_SWIFT_OUTPUT" \
  CREDENTIAL_FRAME_EXCHANGE="$RM_SWIFT_OUTPUT/credential" \
  "$RM_SWIFT" test --package-path tooling/production-acceptance/host \
  --scratch-path "$RM_SWIFT_CACHE/build" --cache-path "$RM_SWIFT_CACHE/cache" \
  --config-path "$RM_SWIFT_CACHE/config" --security-path "$RM_SWIFT_CACHE/security" \
  --disable-dependency-cache --disable-experimental-prebuilts --disable-prefetching \
  --disable-automatic-resolution --skip-update --disable-netrc --disable-keychain \
  --manifest-cache local -j 1 --disable-xctest --enable-swift-testing \
  -Xswiftc -plugin-path \
  -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing
```

SWIFT-ONE(suite) appends `--filter <suite>`.

**Consumers.** Run these after each SWIFT-ALL and after each composition producer:

```sh
BOOTSTRAP_V1_INPUT="$RM_INPUT/composition/roles.json" "$RM_NODE" --test tooling/production-acceptance/tests/unit/bootstrap-composition.test.cjs
RECEIPT_SWIFT_INPUT="$RM_SWIFT_OUTPUT/swift.json" "$RM_NODE" --test tooling/production-acceptance/tests/unit/receipts.test.cjs
CREDENTIAL_FRAME_INPUT="$RM_SWIFT_OUTPUT/credential/credential-frames.json" "$RM_PY" -B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p intake_test.py -v   # from Task 12 on
```

**BROAD** means PY-ALL, then NODE-ALL, then the fixture producers, SWIFT-ALL and the consumers, in that order. Each runs once per task, after focused GREEN. Repeat a run only after a source change or a recorded failure investigation. An unrelated failure stays a failure.

**ABI-PIPELINE(ids)** has six steps:
1. Add one entry per id to `appliance/abi-inventory.json`. Read `memberPath` and `conditions` from the definition's context in the archive.
2. Generate the coverage file to an absent scratch path:
   ```sh
   "$RM_PY" -B tooling/production-acceptance/appliance/derive_abi_coverage.py \
     --archive /Users/Matt/day-trader-references/m4-linux-aarch64-offline-repair-20261002T181543Z/linux-6.8.tar.xz \
     --archive-sha256 c969dea4e8bb6be991bbf7c010ba0e0a5643a3a8d8fb0a2aaa053406f1e965f3 \
     --inventory tooling/production-acceptance/appliance/abi-inventory.json \
     --output "$RM_TMP/abi-coverage-v2.task-NN.json"
   ```
   Then copy those exact bytes over `appliance/abi-coverage-v2.json`. Never hand-edit the file.
3. Independent oracle transcription:
   - **Who:** a separate agent, neither this task's implementer nor its reviewer.
   - **What:** it streams each new header member out of the archive. It uses no deriver code and does not open the coverage file until it has finished.
   - **Output:** it **appends** `'<id>': <int>,  # <memberPath>:<line> <definition>` entries to `tests/unit/abi_oracles.py`. Earlier entries are never edited.
4. Set `COVERAGE_V2_SHA` in both `tests/unit/abi_coverage_test.py:32` and `tests/unit/bootstrap_reference_test.py:21` to the new SHA-256.
5. Add exact per-site binding tests in `tests/unit/abi_coverage_test.py` (`CodeBindingTests`, `SYSCALL_SITES`, `ARG_SYMBOLS` and the per-site tables). Use one assertion per call site or per instruction, with no catch-all.
6. Run PY-ONE(abi_coverage_test.py) and PY-ONE(bootstrap_reference_test.py) to GREEN. `test_event_reference_unchanged` must still pin `a2e1be57…be7d`.

## Rulings on conflicts between the decisions and the code

| # | Conflict found | Ruling |
|---|---|---|
| R1 | E1 says "align BROWSER with design §9.2" and also gives an explicit allow list (`chroot`, `capset`, `set*id`, `unshare`/`clone` flags, `SPEC_ALLOW`). Full §9.2 alignment would also drop the extra denials of `mount`, `umount2`, `pivot_root`, `setns`, `mknodat` and `pidfd_open`. | Allow only the decision's explicit list. The other six stay denied for BROWSER. If Stage 2 shows Chromium needs one of them, that needs a new owner decision. (Task 8) |
| R2 | E1 asks to allow `unshare`/`clone` namespace flags. `build_filter` never filtered `unshare` (97), `clone` (220) or `clone3` (435). | No code change. Tests bind that BROWSER allows them. (Task 8) |
| R3 | E2 adds a host challenge to "each check". But `BootstrapComposition.require_current()` is also called from guest-internal browser-commit paths that have no host challenge. | New host-facing `host_current(challenge)` and `begin(challenge)`. A guest-internal `require_current()` produces a handoff with no `hostChallenge`, which the host rejects. (Task 3) |
| R4 | E2 and the T10-7 bug fix name no deadline values. | Plan-chosen values, which the reviewer must accept: initial challenge 120000 ms, current challenge 2000 ms (host monotonic only), guest observation window 100 ms (guest clock only). Stage 2 may tighten them; it may not widen them without a new decision. (Task 3) |
| R5 | E3 says "the host verifies against its own derived key", but no host vsock listener or relay exists. The broker's `RelayChannel` is the only host endpoint. | Implement the verifier in `RelayChannel`/`EgressBroker`. A future VZ relay must forward bytes only. (Task 6) |
| R6 | E3 says it also fixes T10-10. If the proxy kept the run capability, it could derive the topology key. | The proxy receives only `k_vsock`. The bootstrap and the host keep the capability. (Tasks 3 and 6) |
| R7 | `CLAUDE.md` says M2 must not be reopened. E3-A reopens the M2 broker code. | The owner's 2026-11-17 approval of E3-A is newer explicit owner direction. It authorizes reopening the broker code only. Task 6 stops for owner acceptance of the reviewed diff. The `55c115a` evidence exception is untouched. (Task 6) |
| R8 | E5 says "each role admits … under its own UID". But CONTROLLER, BROWSER and VERIFIER are Node programs, and `storage.py` is Python. | Admission runs in the existing per-role Python pre-exec helper. That helper already runs as the role UID, inside the role view, after seccomp and before `exec_pinned`. Cleanup runs in a fixed, bootstrap-owned, confined per-role cleanup child, the same pattern as a probe family. (Task 14) |
| R9 | E7: Swift's `bootstrapCheck` starts the host budget at check start (`budget.start(at:before.monotonic)`), and `remaining()` allocates lazily. | Treated as a defect under E7-A. The budget starts only at the host's terminal decision. (Task 2) |
| R10 | E6: in canonical mode, the guest `hvc0` line discipline would interpret length-prefix bytes (`0x0a`, `0x03`, `0x04`, `0x15`, `0x7f`). | The guest switches the TTY to raw mode with `TCSAFLUSH` before reading the frame. (Task 12) |
| R11 | E4 replaces the composition's in-process `isinstance(proxy_owner, ProxyRuntimeOwner)` gate (amendment §6). | That gate is replaced, not kept beside the new authority. `ProxyRuntimeOwner` remains only inside the proxy child. (Task 7) |

## Review Focus

These are the five failure modes most likely to bite that no task's tests cover yet. Each is assigned to the task that owns its test.

1. **A routine path still arms the shared cleanup end.** Some non-terminal path (proxy, event owner, current check, browser prepare) calls `remaining()`, `call()` or `clamp()` during normal operation and arms the shared end. Owner: Task 2, `test_v1_no_routine_path_arms_shared_end`.
2. **A challenge reaches the wrong check.** A guest-internal current proof, or an initial-kind challenge, is presented to a host current check. Owner: Task 3:
   - `test_v1_internal_current_handoff_has_no_host_challenge` (Python)
   - `v1_internal_current_handoff_without_challenge_denied` (Swift)
   - `v1_initial_challenge_cannot_satisfy_current_check` (Swift)
3. **Descriptor churn between the proxy report and the `/proc` read.** The proxy's MAC'd report and the bootstrap's `/proc` read straddle a descriptor change. Accepting either side alone would hide a substituted descriptor. Owner: Task 7, `test_v1_proxy_report_and_proc_must_bracket_same_generation`.
4. **Chromium family re-exec.** Chromium descendants re-exec the pinned binary (zygote, renderers) from a family PID that is not the launch root. A grammar that accepts only root-level exec either kills real runs or, if loosened carelessly, accepts any executable. Owner: Task 11, `test_v1_family_reexec_of_pinned_chromium_accepted_other_exec_terminal`.
5. **Typeahead before raw mode.** Credential length-prefix bytes typed ahead before raw mode takes effect are line-discipline control characters. Owner: Task 12, `test_length_prefix_control_bytes_before_raw_mode_flushed_and_fail`.

## Execution shape

Run the tasks sequentially, 1 → 18. Dependencies are listed per task.
- Tasks 12 (intake) and 13 (state machine) depend only on Task 1. The coordinator may run them alongside the M4 chain, but never two Swift builds at once.
- Each task follows the same cycle: tests → RED → minimum implementation → focused GREEN → BROAD → mutation evidence → local commit → independent review of that exact commit.
- A dependent task starts only after its predecessors' reviews accept.

---

### Task 1: Record the Stage 1 remediation contract

**Depends on:** nothing.

**Files:**
- Create: `docs/STAGE1_REMEDIATION_CONTRACT.md`
- Docs only: no code, no tests.

**Interfaces:**
- Consumes: the decisions doc and the review records.
- Produces: normative clauses C1–C10, cited by every later task. Each clause has four parts:
  - **Old requirement:** document and section.
  - **Decision:** E-id or finding id.
  - **Reconciliation:** the exact new rule and values.
  - **Owning task.**

**Findings addressed:** none directly. Folds compA D-1 into C1, records compA D-2 in C10, and records T13 m-2 and the compB part-B note 5 in C9.

**Clauses:**

**C1 Cleanup budget (E7).**
- The shared 60000 ms end starts at the first terminal event: stop, cancel, failure, drift or expiry.
- Routine, non-terminal probe-family stops use a fixed 2000 ms step and never start it.
- JS follows the same rule.
- The Swift host budget starts at the host's own terminal decision.
- D-1 sentence: "Routine probe-family stops use fixed bounded waits and never allocate the shared end."

**C2 Freshness challenge (E2).**
- The host challenge is `hostChallenge`: 16 random bytes as 32 lowercase hex characters, one use.
- Initial deadline 120000 ms; current deadline 2000 ms. Both are measured on host monotonic time only.
- `observedWall` and `observedMonotonic` are guest-local and never compared with host clocks.
- Guest observation window: 100 ms.
- Internal guest currents carry no challenge.

**C3 Key derivation (E3, T10-10).**
- `derive(capability, label) = HMAC-SHA256(key=capability, msg="acceptance:key-derivation:v1\0" ‖ label ‖ "\0")`.
- Labels: `vsock-stream`, `topology-admission`.
- The handoff MAC uses the `topology-admission` key.
- The proxy receives only the `vsock-stream` key.

**C4 vsock stream proof (E3).**
- Per stream, the host first sends a challenge frame: a 2-byte big-endian length (16) followed by 16 random bytes.
- The guest answers with its control frame (2-byte length ≤ 256), then a proof frame (2-byte length 32, then 32 bytes).
- `proof = HMAC-SHA256(k_vsock, "acceptance:vsock-stream:v1\0" ‖ nonce ‖ runId (32 ASCII hex) ‖ sequence (8-byte big-endian))`.
- The broker verifies in constant time before sequence admission. A mismatch latches the whole run as `identity`.

**C5 Proxy authority (E4).**
- The bootstrap observes `/proc/<proxy-pid>/fd/*` and `fdinfo/*`, and cross-checks them against the proxy's MAC'd runtime report on the existing v2 FD3/FD4 channel.
- Order: report A, then `/proc`, then report B. Accept only if all three are equal and B's sequence is A's plus 1.
- The proxy loop never runs in the bootstrap process.

**C6 Per-role seccomp (E1).**
- The BROWSER deny list is the base list minus `chroot`, `capset`, `setuid`, `setgid`, `setreuid`, `setregid`, `setresuid`, `setresgid`, `setfsuid`, `setfsgid` and `setgroups`, leaving 13 entries.
- BROWSER seccomp filter flags are exactly {0, TSYNC, SPEC_ALLOW, TSYNC|SPEC_ALLOW}.
- Other roles are unchanged.
- No `NEW_LISTENER`, TRACE or USER_NOTIF.
- Stage 2 must show the sandbox starts on a real VM.

**C7 Per-role storage (E5).** Role scopes as seen inside each view:
- `/run/acceptance/<role>`, `/tmp`, `/var`
- `/dev/shm`: a per-role tmpfs of 67108864 bytes
- `/run/acceptance/crash`: a per-role subdirectory of the 1048576-byte crash tmpfs

Admission runs in the pre-exec helper under the role UID. Cleanup runs in a fixed confined cleanup child. The bootstrap only sums metadata aggregates.

**C8 Credential framing (E6).**
- Host to guest: a 4-byte big-endian length n (1 ≤ n ≤ 4096), then n bytes.
- The guest reads in raw TTY mode set with `TCSAFLUSH` and `TIOCEXCL`.
- The host serial input carries no guest-role fields.

**C9 Contract changes from the plain bugs and recorded widenings:**
- The proxy accepts one `Proxy-Connection: keep-alive` line.
- Idle, EOF and EPIPE events close only their tunnel; the whole-run latch stays for transport, broker or vsock loss, protocol violation, caps and clock faults.
- Per-run tunnel total: 1024.
- The reducer admits `budget` in PREFLIGHT and AWAIT_CREDENTIAL.
- New state fields `sessionMaybeIssued`, `safeSignOutRouted`, `revocation` and `postTerminalAnomaly`; internal events `safeSignOutRoute`, `safeSignOutResult` and `tick`.
- The first navigation is `FRONTEND + '/login'`.
- Header policy: every non-browser-generated header goes to admission, and `authorization`, `proxy-authorization`, `x-*` and method-override headers abort locally.
- New fixed worker action `SESSION_READINESS`.
- Record the as-built action catalogue `LOGIN_SESSION`/`SESSION_OBSERVATION` (T13 m-2) and the Task 13 `browserConfig`/`APP_WRITE`/`APP_POLL`/`APP_CHUNK` union widening (compB part-B note 5) as reviewed amendments.

**C10 Native blockers carried to Stage 2** (no offline fix):
- boot `audit=1` (compA D-2)
- `CONFIG_PROC_CHILDREN`, `CONFIG_IPC_NS` and `CONFIG_COMPAT` facts
- the real Node FD inventory beyond `{0..4}`
- `filter_digest` read-back
- a real Chromium sandbox start
- the host VZ relay forwarding bytes only

**Steps:**
- [ ] **Step 1: Write `docs/STAGE1_REMEDIATION_CONTRACT.md`.** Write clauses C1–C10 above in the old/decision/reconciliation/owner shape. Header: "Additive to the design, original plan and composition amendment, which stay byte-identical; approval covers design direction only." Include every exact value above. Include no value that a later task does not test.
- [ ] **Step 2: Check the document.**
  - Each of E1–E7 appears in exactly one clause.
  - Every constant in the document also appears in this plan. Check with `grep -c` per constant and record the counts in `$RM_EVIDENCE/task-01/consistency.txt`.
  - Record the SHA-256 of `docs/STAGE1_REMEDIATION_DECISIONS.md` for the Task 18 check.
- [ ] **Step 3: Commit** `docs(acceptance): record Stage 1 remediation contract`. The independent reviewer confirms that no clause widens a decision or contradicts the design's threat model.

### Task 2: One terminal-start cleanup budget across languages (E7) and the late-acquisition race

**Depends on:** Task 1.

**Files:**
- Modify: `guest/topology.py` (`CleanupBudget`, `BootstrapComposition._activation_deadline`, `_retain_cleanup`, `_cleanup_retained`, `_invalidate_terminal`, `stop_owned`)
- Modify: `tests/guest/confinement_probe.py` (`_ProbeFamilyOwner.stop_owned` scope loop, the `NativeProbeFixtures.run_confined` `finally`, the `NativeProbeContext._helper` reap allowance)
- Modify: `guest/role-ports.cjs` (`cleanupBoundary`)
- Modify: `host/Sources/AcceptanceCore/VMHost.swift` (`BootstrapCleanupBudget`, both `bootstrapCheck` variants, terminal paths)
- Test: `tests/unit/bootstrap_composition_test.py`, `tests/unit/bootstrap-composition.test.cjs`, `host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`

**Interfaces:**

Produces (Python):
- `CleanupBudget(clock=None, *, real_clock=None)`. `real_clock` is a zero-argument callable returning integer milliseconds; the default is `time.monotonic_ns() // 1000000`.
- `CleanupBudget.started -> bool`
- `CleanupBudget.start_terminal() -> int`. The first call sets `deadline = sample + 60000` and `real_deadline = real + 60000`. Later calls return the remaining time and never move either end.
- `CleanupBudget.remaining() -> int`. Raises `TopologyError('CLEANUP_NOT_STARTED')` before start. Never allocates.
- `CleanupBudget.call(operation)`. Requires `started`.
- `CleanupBudget.clamp(remaining_ms)`. Calls `start_terminal()` first: a caller's stop is a terminal event.
- `CleanupBudget.routine_call(operation, step_ms=PROBE_FAMILY_STOP_MS)`. Passes `min(step_ms, remaining())` once started, otherwise `step_ms`. Never starts the end.
- `PROBE_FAMILY_STOP_MS = 2000`

Produces (JS):
- `cleanupBoundary(budget, sample)` returns an object with `startTerminal()`.
- `remaining()` throws `CLEANUP_NOT_STARTED` before `startTerminal()`.
- `call()` invokes `startTerminal()` first.

Produces (Swift):
- `BootstrapCleanupBudget.startTerminal(at monotonic:Int)` replaces `start(at:)`.
- `remaining()` never allocates.

Consumes: no new names.

**Findings addressed:** CA-I1, CB-I1, CB-I5. Minors folded: compA D-1 (via C1), compB M-1 (flaky test), compB M-3 (vacuous Node passes), compB M-4 part K6.

**Steps:**

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/bootstrap_composition_test.py`:
  - `test_v1_shared_cleanup_end_unarmed_after_successful_begin`: after `begin()` returns ADMITTED, `h.budget.started is False` and `h.budget.deadline is None`.
  - `test_v1_terminal_cleanup_gets_full_window_after_61s_of_normal_operation`:
    1. After `begin()`, advance the guest clock and the injected `real_clock` by 61000.
    2. `stop_owned(60000) == {'status':'STOPPED','runId':<run>}`.
    3. Every retained owner received an allowance in `[1, 60000]`.
    4. `h.budget.deadline == <mono at stop> + 60000`.
  - `test_v1_probe_catalogue_longer_than_60s_still_qualifies`: inert fixtures advance 1000 ms per family across the whole catalogue. `begin()` admits, and `h.budget.started is False`.
  - `test_v1_activation_deadline_not_capped_by_unstarted_cleanup`: at 61000 ms after `begin()`, the `monotonicDeadlineMs` in the `prepare_browser()` record equals `mono + expiresAtMs - wall`. Mutant C8 must die.
  - `test_v1_no_routine_path_arms_shared_end` (Review Focus 1): spy on `CleanupBudget.start_terminal`. Run `begin()`, `require_current()` three times, `prepare_browser()` and the commit path. Expect 0 calls.
  - `test_v1_late_acquisition_racing_cleanup_is_stopped`: a two-thread port of the reviewer's `compB/scripts/late_acquisition_race.py`. Thread A blocks inside `bind_original_roles`; thread B calls `stop_owned(60000)`; then release A. After both join, with no third stop, the role stop calls equal `['PROXY','VERIFIER','BROWSER','CONTROLLER']` and `_cleanup_status == 'STOPPED'`.
  - `test_v1_bootstrap_clamps_to_worker_first_terminal_end` (K6): a worker failure at `failedAtMonotonicMs=F` leaves the composition end ≤ `F + 60000`.
  - Correct the three tests that encode the wrong behaviour. Locate each with `grep -n`.
    - `test_v1_expired_cleanup_end_forbids_the_next_probe_family` becomes `test_v1_expired_terminal_end_forbids_further_cleanup_calls`: `start_terminal()`, advance 60001, then `call(op)` raises `CLEANUP_UNCERTAIN` and `op` is never invoked.
    - `test_v1_expired_shared_budget_keeps_original_owner_and_no_retry`: call `start_terminal()` explicitly before advancing.
    - `test_v1_stop_clamps_to_caller_and_never_widens_shared_budget`: assert `deadline is None` after `begin()` and set after stop. Drive real time only through `real_clock`. This removes the 7 ms/3 ms real-time flake.

  `tests/unit/bootstrap-composition.test.cjs`:
  - `v1_cleanup_end_starts_at_first_terminal_event_only`:
    - `remaining()` before `startTerminal()` throws `CLEANUP_NOT_STARTED`.
    - Call `startTerminal()` at t. At t + 61000, `remaining() === 0`.
    - A second `startTerminal()` leaves the end unchanged.
  - `v1_python_authenticated_cancel_at_each_forwarder_window_is_terminal` and `v1_python_transcript_each_hop_substitution_and_replay_are_denied` call `t.skip('BOOTSTRAP_V1_INPUT absent')` instead of returning (M-3).

  `host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`:
  - `v1_host_cleanup_budget_starts_at_terminal_decision`:
    - After a successful offline `bootstrapCheck(run:composition:)`, the budget has not started.
    - After `topologyDrifted()` at host monotonic D, the end is D + 60000.
    - A qualification admitted 61000 ms earlier still gives each stop an allowance > 0.

- [ ] **Step 2: Run RED.**
  - PY-ONE(bootstrap_composition_test.py), NODE-ONE(bootstrap-composition.test.cjs), then the producers and SWIFT-ONE(BootstrapGateTests). Save `$RM_EVIDENCE/task-02/red.log`.
  - Expected failures:
    - `deadline` is armed after `begin()`;
    - `TIMEOUT` at +61000;
    - role stop calls are `[]` after the race;
    - the Swift budget started at check start.

- [ ] **Step 3: Implement.**
  - `CleanupBudget` per the interfaces.
  - Probe sites use `routine_call`. The helper reap uses `PROBE_FAMILY_STOP_MS` when the budget has not started.
  - `_activation_deadline` drops the `budget.deadline` cap.
  - `_invalidate_terminal` calls `start_terminal()` before anything else.
  - `_retain_cleanup` sets `self._cleanup_dirty = True` under the lock.
  - `_cleanup_retained` sets `_cleanup_dirty = False` at the top of each pass and loops while it is True or unattempted owners exist. A concurrent caller that finds a pass running sets the flag and returns, and the running pass picks up its owner.
  - JS: `cleanupBoundary` allocates only in `startTerminal()`.
  - Swift: delete `budget.start(at:before.monotonic)` and the lazy allocation in `remaining()`. Call `startTerminal(at:)` from the failure, drift, stop, cancel and expiry paths.

- [ ] **Step 4: Confirm GREEN and run BROAD.** Run the focused suites, then BROAD. Mutations that must be killed:
  - restoring lazy allocation in `remaining()`
  - removing the dirty loop
  - restoring the `_activation_deadline` cap (C8)
  - restoring Swift's `budget.start(at:before.monotonic)`

  Then run `$RM_STAGE/tmp/reviews/compB/scripts/flaky_repro.py <scratch-tree> 2` 20 times. All 20 must pass. Save `$RM_EVIDENCE/task-02/green.log` and `$RM_EVIDENCE/task-02/broad-*.log`.

- [ ] **Step 5: Commit** `fix(acceptance): start the shared cleanup budget at the first terminal event`.

### Task 3: Host-issued freshness challenge and domain-separated keys (E2, E3 part 1, T10-10)

**Depends on:** Task 2.

**Files:**
- Modify: `guest/confinement.py` (add `derive_channel_key`)
- Modify: `guest/topology.py` (`BootstrapComposition.begin`, new `host_current`, `_capture`, `_capture_current`, `_validate_composition_payload`, the legacy `_payload`/`admit_topology` window, the legacy `NativeTopologyBindings._capture` sample point, `verify_handoff` docstring, the docstring at `:1473-1475`)
- Create: `host/Sources/AcceptanceCore/ChannelKeys.swift`
- Modify: `host/Sources/AcceptanceCore/VMHost.swift` (`BootstrapProbePort`, `BootstrapHandoff.verify`, `resample`, both `bootstrapCheck` variants, `BootstrapCompositionV1.capture`, challenge issuer)
- Test: `tests/unit/confinement_test.py`, `tests/unit/topology_test.py`, `tests/unit/bootstrap_composition_test.py`, `host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`

**Interfaces:**

Produces (Python):
- `derive_channel_key(capability: bytes, label: str) -> bytes` in `confinement.py`. Labels are exactly `'vsock-stream'` and `'topology-admission'`.
- `BootstrapComposition.begin(challenge: str) -> AdmissionProof`
- `BootstrapComposition.host_current(challenge: str) -> AdmissionProof`
- `BootstrapComposition.require_current() -> AdmissionProof`. Guest-internal; its `BootstrapHandoffV1.host_eligible is False`.
- The host payload's key set is the existing set plus `hostChallenge`. The internal payload's key set is unchanged.
- `GUEST_OBSERVATION_WINDOW_MS = 100`
- Test constant `TEST_HOST_CHALLENGE = '000102030405060708090a0b0c0d0e0f'`.

Produces (Swift):
- `ChannelKeys.derive(capability: Data, label: String) throws -> Data`
- `protocol BootstrapNonceSource: Sendable { func nonce() throws -> Data }` (16 bytes)
- `BootstrapChallengeIssuer`, with `issue(kind: .initial | .current, at: ClockSample) throws -> BootstrapChallenge` and `consume(_: BootstrapChallenge, handoffChallenge: String, at: ClockSample) throws`
- `BOOTSTRAP_CHALLENGE_INITIAL_MS = 120000`, `BOOTSTRAP_CHALLENGE_CURRENT_MS = 2000`
- `BootstrapProbePort.capture(ids:challenge:) throws -> Data`
- `BootstrapHandoff.verify(..., challenge: BootstrapChallenge?)`

**Findings addressed:** T10-1, T10-7. Minors folded: T10-10, T10-13, T10-15.

**Steps:**

- [ ] **Step 1: Write the failing tests.**

  Vectors were computed by the plan author with Python `hmac` from the C3 string. Reproduce them; never edit them to match.

  `tests/unit/confinement_test.py`:
  - `test_channel_key_derivation_vectors`:
    - With capability `bytes([7])*32`, `vsock-stream` gives `5814c7147c97464dd6833b65cfd337b5d6f8277a080522efe9c3f7f498d54d00`.
    - `topology-admission` gives `49206226671c56e90e00b0198cbeca8b32acb63e5e5c714b12989d3172cf0e49`.
    - An unknown label or a non-32-byte capability raises `ConfinementError`.

  `tests/unit/bootstrap_composition_test.py`:
  - `test_v1_handoff_payload_carries_exact_host_challenge`: `begin(TEST_HOST_CHALLENGE)` puts exactly that value in the payload's `hostChallenge`.
  - `test_v1_host_challenge_format_and_reuse_denied`: uppercase, 31 or 33 characters, or non-hex gives `CHALLENGE_DENIED`. Reusing a value across `begin` and `host_current` gives `CHALLENGE_REPLAY`. Both are terminal.
  - `test_v1_internal_current_handoff_has_no_host_challenge`: the `require_current()` payload has no `hostChallenge` key, and `host_eligible is False`.
  - `test_v1_handoff_mac_uses_topology_admission_key`: the MAC verifies with the derived key and differs from HMAC under the raw capability.
  - `test_v1_guest_observation_window_is_100ms_with_advancing_clock`: the clock advances 1 ms per read. 99 ms from observed to final admits; 101 ms gives `BINDING_DENIED`.

  `tests/unit/topology_test.py`:
  - `test_legacy_capture_admits_with_1ms_per_probe_and_samples_before_bracket_end`: with 1 ms per probe for 12 probes, admission succeeds (the reviewer's `probe_latency.py` case).
  - `test_legacy_verify_handoff_is_offline_only`: `verify_handoff`'s result cannot feed `AdmissionProof` consumers that require composition.

  `host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`:
  - `v1_channel_key_derivation_matches_python_vectors`: the same two hex values.
  - `v1_host_challenge_is_one_use_and_host_deadline_bound`:
    - The nonce source returns bytes `00…0f`. The handoff with that challenge admits once; a second consume throws `admissionUnavailable`.
    - Host clock +120001 ms before verify on an initial check: denied.
    - Host clock +2001 ms on a current check: denied.
    - Guest `observedWall`/`observedMonotonic` of 0 and of 9007199254740991 both still admit, which proves there is no cross-domain comparison.
  - `v1_internal_current_handoff_without_challenge_denied`
  - `v1_initial_challenge_cannot_satisfy_current_check`
  - `v1_handoff_mac_with_raw_capability_denied`
  - `v1_legacy_handoff_one_use_per_run_and_never_operational` (T10-13): the same sequence-1 legacy handoff cannot back two qualifications, and a legacy qualification is rejected by `requireBrowserAdmission`.

- [ ] **Step 2: Run RED.** PY-ONE(confinement_test.py), PY-ONE(bootstrap_composition_test.py), PY-ONE(topology_test.py), then the producers and SWIFT-ONE(BootstrapGateTests). Expected failures: missing `derive_channel_key`, payload without `hostChallenge`, the 1 ms bound, and the Swift cross-domain bracket.

- [ ] **Step 3: Implement.**
  - Add `derive_channel_key` exactly per C3, and Swift `ChannelKeys.derive` the same way.
  - The guest MAC (`_capture`, legacy `:1484`) uses `derive_channel_key(capability, 'topology-admission')`. Swift `BootstrapHandoff.verify` derives the same key.
  - `_capture(token, challenge)` adds `hostChallenge` only when `challenge` is not None. Keep a per-composition used-challenge set.
  - Sample `observed` immediately before the closing barrier. Check `final - observed <= GUEST_OBSERVATION_WINDOW_MS` in both the composition and the legacy capture.
  - Swift:
    - Remove every `before/after` versus `observedWall`/`observedMonotonic` comparison at `VMHost.swift:778-780`, `:1091-1093` and `:1157-1159`.
    - Issue the challenge before `capture`, then `consume` after `verify`.
    - The legacy v1 check drops the bracket and gains a one-use claim per run.
  - Update every existing test call `begin()` to `begin(TEST_HOST_CHALLENGE)`.
  - The topology producer exports its handoff with `TEST_HOST_CHALLENGE`. The Swift tests inject a nonce source returning bytes `00…0f`.

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed:
  - restoring the 1 ms cross-domain bracket in Swift `resample`
  - MAC under the raw capability
  - removing the host one-use set
  - removing the guest used-challenge set
  - a window of 1 ms

- [ ] **Step 5: Commit** `fix(acceptance): bind handoff freshness to a host challenge and separate keys`.

### Task 4: Topology predicates, kernel-format rows and named negative tests

**Depends on:** Task 3.

**Files:**
- Modify: `guest/topology.py`
  - `_routes6` and the address decoders
  - `TopologyGate` constructor
  - success-path drift re-latch
  - delete `Task10NativeAttempts`, `TASK8_PROBE_CASES` and `select_task8_probe_source`
- Modify: `tests/guest/topology_test.py` (becomes a gated native test)
- Modify: `appliance/abi-inventory.json`, `appliance/abi-coverage-v2.json`
- Test: `tests/unit/topology_test.py`, `host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`, `tests/unit/abi_oracles.py`, `tests/unit/abi_coverage_test.py`, `tests/unit/bootstrap_reference_test.py`

**Interfaces:**

Produces:
- `_routes6(raw: bytes) -> tuple`. Accepts only rows equal to one of the two shapes in `_KERNEL_DEFAULT_IPV6_ROWS`, both on device `lo`:
  - the fib6 null entry: destination `::`/0, metric `ffffffff`, `RTF_REJECT` set
  - the `::1/128` local route

  The implementer derives the exact field values from Linux 6.8 source (`net/ipv6/ip6_fib.c`, `net/ipv6/route.c`, `ipv6_route_native_seq_show`). Cite `file:line` next to the constant. The reviewer re-derives them.
- `_ipv6_from_proc(text: str, printer: str) -> bytes`, where `printer` is `'pi6'` (for `ipv6_route`) or `'be32_host_words'` (for `tcp6`/`udp6`).
- `TopologyGate(adapter, *, supervisor)` requires `type(adapter) is NativeTopologyBindings` and a supervisor.
- `tests/guest/topology_test.py` calls `topology.select_native_topology_port(platform_name, machine)`, which raises `RuntimeGateUnavailable('NATIVE_TOPOLOGY_PORT_UNAVAILABLE')`. That is a test error, never a skip.
- The inert driver content moves to class `InertGuestDriverTests` in `tests/unit/topology_test.py`.

Consumes: `GUEST_OBSERVATION_WINDOW_MS` from Task 3.

ABI ids: `RTF_UP`, `RTF_GATEWAY`, `RTF_REJECT`, `RTF_NONEXTHOP`, `RTF_LOCAL`, `TCP_ESTABLISHED`, `TCP_LISTEN`.

**Findings addressed:** T10-2, T10-3, T10-4, T10-5, T10-6, T10-8. Minors folded: T10-9, T10-12, compA M-1, compA M-2, Option A R17 C4 (the `'0A'` TCP-state strings).

**Steps:**

- [ ] **Step 1: Write the failing tests** in `tests/unit/topology_test.py`. Build fixtures in kernel format from the cited printers, never `b''`.
  - `test_kernel_default_ipv6_rows_admit_exactly`: the null-entry row plus the `::1` row admit. A missing `ipv6_route` file fails observation.
  - `test_ipv6_default_gateway_or_non_lo_route_rejects`: each subTest rejects:
    - `::/0` with `RTF_GATEWAY` via `eth0`
    - `::1/128` on `eth0`
    - the null entry with metric 0
    - an extra third row
  - The plan-named tests, each with its reviewer mutant:
    - `test_unexpected_NIC_default_v4_v6_route_DNS_listener_fail_before_prompt`. SubTests: interfaces `('lo','eth0')` (mutant `nic`), v4 default, v6 default, a DNS nameserver, an extra listener.
    - `test_missing_proxy_fail`: `listeners=()` (mutant `missing_proxy_listener`).
    - `test_extra_abstract_UNIX_agent_fail`: `('ABSTRACT:@agent',)` (mutant `abstract_unix`).
    - `test_incorrect_uid_seccomp_fd_fail`: includes `seccomp=0` (mutant `seccomp_mode`).
    - `test_role_probe_failed_or_skipped_fail`: `attempted=False` (mutant `probe_attempted`).
    - `test_host_listener_not_guest_loopback`: `Listener('HOST',…)` (mutant `host_listener`).
    - `test_observation_skew_beyond_window_fails`: 101 ms (mutant `observation_skew`).
  - `test_named_negative_vectors_exported`: the producer writes each vector, with a fixed id, into `topology.json.invalid.json`.
  - `test_tcp6_loopback_decodes_per_host_order_words` (T10-9): `00000000000000000000000001000000` decodes to `::1`.
  - `test_gate_rejects_non_native_adapter_and_missing_supervisor` (T10-5, T10-12)
  - `test_n5a_drift_during_pending_capture_is_typed_cleanup_at_gate`
  - `test_n5b_ordinary_close_failure_is_typed_cleanup_at_gate` (T10-6)
  - `test_n5b_read_raises_cleanup_failure_with_owner_and_primary_cause` (compA M-1): `.cleanup is owner` and `__cause__ is primary`.
  - `test_success_path_drift_relatches_cleanup` (compA M-2, via the reviewer's `sys.settrace` arrangement)
  - `test_legacy_task8_probe_source_removed`: `hasattr` is False for the three deleted names.

  `host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`:
  - `v1_named_topology_negative_vectors_reject`: every vector id in `topology.json.invalid.json` must be present and must be rejected.

  `tests/unit/abi_coverage_test.py`:
  - `test_topology_route_flag_and_tcp_state_literals_match_named_symbols`

- [ ] **Step 2: Run RED.** PY-ONE(topology_test.py), then the producers and SWIFT-ONE(BootstrapGateTests). Expected failures: null-entry rows rejected, the named tests absent, and the guest file passing inertly.

- [ ] **Step 3: Implement.**
  - The exact `_routes6` shapes and the decoders.
  - Restrict `TopologyGate` to native adapters. Move the existing generic-adapter tests onto `NativeTopologyBindings` over the inert kernel.
  - Re-latch after a success-path drift.
  - Delete the three legacy names and update their test references. Remove the deleted call sites from the per-site tables in `abi_coverage_test.py`. Do not remove inventory entries.

- [ ] **Step 3b: Run ABI-PIPELINE**(`RTF_UP`, `RTF_GATEWAY`, `RTF_REJECT`, `RTF_NONEXTHOP`, `RTF_LOCAL`, `TCP_ESTABLISHED`, `TCP_LISTEN`).

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed:
  - the seven reviewer T10-3 mutants: `nic`, `abstract_unix`, `probe_attempted`, `seccomp_mode`, `host_listener`, `missing_proxy_listener`, `observation_skew`
  - "accept any `lo` row"
  - reviewer M1 (revert N5-B `_read` typing)

- [ ] **Step 5: Commit** `fix(acceptance): accept kernel-default IPv6 rows and bind topology predicates`.

### Task 5: Proxy CONNECT parsing and per-tunnel robustness

**Depends on:** Task 2.

**Files:**
- Modify: `guest/proxy.py`
- Test: `tests/unit/proxy_test.py`

**Interfaces:**

Produces:
- `parse_connect(data: bytes, destinations: dict) -> str` accepts at most one header line exactly `Proxy-Connection: keep-alive`. Everything else is unchanged.
- Internal per-tunnel close: idle, client EOF before the header, and a write failure after client close each close only that tunnel. Bytes stay charged.
- The whole-run latch stays for:
  - transport, broker or vsock loss
  - protocol violation
  - aggregate or run caps
  - clock fault
  - vsock connect timeout (as `TRANSPORT_LOST`)
- `_MAX_TUNNELS_PER_RUN = 1024`. The `first_sequence` ceiling is `_MAX_SAFE_INTEGER - (_MAX_TUNNELS_PER_RUN - 1)`.
- A 17th concurrent client is refused: closed without a vsock open, and the run is not latched.

**Findings addressed:** T9-1, T9-2 (proxy side), T9-4, T9-5. Minors folded: T9-6, T9-8, T9-9, T9-10 (cases C and M; the rest are cosmetic and deferred).

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - `test_chromium_connect_with_proxy_connection_keep_alive_accepted`: the bytes `b'CONNECT fe.example.test:443 HTTP/1.1\r\nHost: fe.example.test:443\r\nProxy-Connection: keep-alive\r\nUser-Agent: Mozilla/5.0 (X11; Linux aarch64)\r\n\r\n'` give `'FRONTEND'`.
  - `test_proxy_connection_variants_rejected`: each of these gives `INVALID_CONNECT`: a duplicate line, `close`, a lowercase header name, `Proxy-Authorization`, `Connection: keep-alive`.
  - `test_idle_tunnel_closes_only_itself_and_run_continues` (probe P3): tunnel A idles past the idle limit while B keeps exchanging. A's client and vsock close; B completes; the outcome is not terminal.
  - `test_client_eof_before_header_closes_only_that_client` (P5)
  - `test_write_after_client_close_closes_only_that_tunnel` (the reviewer's `probe2.py` EPIPE case)
  - `test_whole_run_latch_kept_for_transport_protocol_caps_and_clock`: vsock loss gives `TRANSPORT_LOST`, a protocol violation gives `CHANNEL_DENIED`, plus the aggregate cap, run expiry and a clock fault.
  - `test_seventeenth_concurrent_connection_refused_not_latched`
  - `test_total_tunnels_per_run_bounded_at_1024`: the 1025th tunnel latches `CAPACITY`.
  - Rewrite `test_inherited_entry_exact_frame_fixed_fds_and_pinned_admission`:
    - The runner appends to a list, and the test asserts the list is `[]` after each denied case.
    - One denial per binding field: `runId`, the capability (renamed `vsockKey` in Task 6), `expiresAt`, `firstSequence`, `manifestIdentity`, `configIdentity`.
    - Plus the origins, `aggregateBytes`, `idleTimeoutMs` and `runTimeoutMs`.
  - `test_v1_composition_entry_pins_every_frame_field`: the same denial cases on the composition entry.
  - `test_serving_loop_header_without_terminator_denied_at_4096`: `CHANNEL_DENIED`, no vsock open, every endpoint closed.
  - `test_serving_loop_header_split_across_reads_crossing_4096`
  - `test_stop_or_eof_stops_new_admission_in_every_mode` (T9-6)
  - `test_vsock_connect_timeout_enforced` (T9-9)
  - `test_bytes_after_logical_eof_latch` (mutant C)
  - `test_async_vsock_so_error_latches` (mutant M)

- [ ] **Step 2: Run RED.** Run PY-ONE(proxy_test.py).

- [ ] **Step 3: Implement.**
  - Introduce the per-tunnel close path (an internal `_TunnelClosed`). Keep every whole-run raise listed above.
  - Bound the total number of tunnels per run.
  - On STOP or FD3 EOF, close the listener immediately in every mode.
  - Enforce `connect_timeout_ms`.

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed: reviewer A, AA, O, O3, O4, O5, I, C and M, plus "restore the whole-run idle raise".

- [ ] **Step 5: Commit** `fix(acceptance): accept Chromium CONNECT and keep per-tunnel events local`.

### Task 6: vsock stream challenge-response and broker per-slot idle (E3; reopens M2)

**Depends on:** Tasks 3 and 5.

**Files:**
- Modify: `guest/proxy.py`
- Modify: `guest/topology.py` (the proxy initializer's writer passes `vsockKey`)
- Modify: `host/Sources/AcceptanceCore/EgressBroker.swift`
- Test: `tests/unit/proxy_test.py`, `tests/unit/bootstrap_composition_test.py`, `host/Tests/AcceptanceCoreTests/BrokerTests.swift`

**Interfaces:**

Produces (Python, proxy side):
- `RunBinding.vsock_key: bytes` replaces `RunBinding.capability`.
- FD3 config field `vsockKey` (64 hex characters) replaces `capability`. A frame that still carries `capability` gives `INVALID_CONFIG`.
- `VSOCK_PROOF_DOMAIN = b'acceptance:vsock-stream:v1\0'`
- `stream_proof(vsock_key: bytes, nonce: bytes, run_id: str, sequence: int) -> bytes`
- `NativeVsockTransport.authenticate` is deleted.
- Per stream, the proxy:
  1. reads the challenge frame within the idle deadline (length must be 16);
  2. writes the control frame;
  3. writes the proof frame.
- The proxy serializes stream setup: at most one stream is between connect and proof, and streams go in sequence order.

Produces (Swift, broker side):
- `public protocol BrokerNonceSource: Sendable { func nonce() throws -> Data }`, with `SystemBrokerNonceSource`.
- `RelayChannel(physical:nonces:)`
- `RelayRequest { control, nonce, proof, stream }`
- `EgressBroker.accept(request: RelayRequest) async throws -> Tunnel` verifies the proof in constant time with `ChannelKeys.derive(binding.capability, "vsock-stream")` per C4, before sequence admission. A mismatch latches `BrokerFailure.identity`.
- `EgressBroker.init` loses `authenticatedCapability:`.
- A slot that goes idle closes only that slot (`EgressBroker.swift:475-481`).

Consumes: `derive_channel_key` and `ChannelKeys.derive` from Task 3.

**Findings addressed:** T9-3, T9-2 (broker side). Minors folded: T9-7 (document that the proxy and broker are phase-unaware; `CONTROL.phase`/`event` are fixed constants; the route gate is the phase authority). Also folded: the T9 review's broker sequence-ordering note.

**Steps:**

- [ ] **Step 1: Write the failing tests.**

  The vector, computed by the plan author: `k_vsock` from Task 3; nonce bytes `00…0f`; runId `0123456789abcdef0123456789abcdef`; sequence 1. The proof is `564c1588db8960fb3a6748fe644fa0b4ffa9d1ca23ce8ae7d21c97020fe42e72`.

  `tests/unit/proxy_test.py`:
  - `test_stream_proof_vector`
  - `test_proxy_never_holds_capability`: `RunBinding` has no `capability` attribute, and an FD3 frame with `capability` gives `INVALID_CONFIG`.
  - `test_control_and_proof_follow_host_challenge_on_every_stream`
  - `test_short_or_long_challenge_frame_latches`
  - `test_stream_setup_serialized_in_sequence_order`
  - Replace `test_capability_run_and_release_binding_mismatch_stops_before_listener` with `test_forged_or_replayed_stream_proof_rejected_by_real_verifier`. It runs the real Python `stream_proof` against a recorded challenge; no fake `Transport` binding.

  `tests/unit/bootstrap_composition_test.py`:
  - `test_v1_proxy_initializer_carries_derived_vsock_key_only`

  `host/Tests/AcceptanceCoreTests/BrokerTests.swift`:
  - `stream_proof_vector_matches_python`
  - `forged_proof_latches_identity_before_sequence`
  - `replayed_proof_for_other_nonce_denied`
  - `proof_for_wrong_sequence_or_run_denied`
  - `idle_slot_closes_only_itself_and_run_continues`
  - `broker_derives_vsock_key_from_bootstrap_capability`

- [ ] **Step 2: Run RED.** PY-ONE(proxy_test.py), PY-ONE(bootstrap_composition_test.py), then the producers and SWIFT-ONE(BrokerTests).

- [ ] **Step 3: Implement** per the interfaces and C4. Rename `capability` in the Task 5 denial cases to `vsockKey`. Add a code comment and a C9 cross-reference for T9-7.

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed:
  - proof comparison always true
  - nonce omitted from the HMAC input
  - sequence omitted from the HMAC input
  - restoring the whole-run idle rule in the broker
  - the proxy keeping `capability`

- [ ] **Step 5: Commit and hand off for M2 acceptance.**
  - Commit `fix(acceptance): authenticate each vsock stream with a host challenge`.
  - The independent review report must open with: "Reopens accepted M2 Task 5 broker code (accepted 2026-10 with a narrow evidence exception at `55c115a`); the exception itself is not reopened."
  - Stop for the owner to accept the reviewed broker diff. Record that acceptance in the Task 18 report.

### Task 7: Cross-process proxy runtime authority (E4)

**Depends on:** Tasks 3 and 6.

**Files:**
- Modify: `guest/topology.py` (`BootstrapComposition.__init__`, `begin`, `_bind_runtime_owners`, `_capture`; new `ProxyChildAuthority`)
- Modify: `guest/confinement.py` (new `NativeKernelPort.observe_child_descriptors`; remove bootstrap-side `fstat` from the PROXY register/inspect path; `validate_runtime_observation` wire checks)
- Modify: `guest/proxy.py` (MAC'd runtime report rows on the v2 current response; `_RuntimeDescriptors.current()` strict; `type(x) is` gates)
- Modify: `host/Sources/AcceptanceCore/VMHost.swift` (selector-provenance comment; shared divergence vectors)
- Test: `tests/unit/bootstrap_composition_test.py`, `tests/unit/proxy_test.py`, `tests/unit/confinement_test.py`, `host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`

**Interfaces:**

Produces:
- `ProxyChildAuthority(handoff, client, kernel, binding)`. Nominal and sealed. It requires all of:
  - `type(client) is ProxyCompositionClient`
  - `type(kernel) is NativeKernelPort`
  - `handoff.launch.role == 'PROXY'`
  - `handoff.attestation.pid != os.getpid()`
- `ProxyChildAuthority.observe_current() -> dict`, returning `{runtimeId, rows}`. It does report A, then `/proc`, then report B, per C5. Any mismatch gives `PROXY_RUNTIME_DRIFT`, which is terminal.
- `NativeKernelPort.observe_child_descriptors(handoff) -> tuple[dict, ...]`:
  - For each `N` in `/proc/<pid>/fd` (at most 4096): device and inode from `os.stat('/proc/<pid>/fd/N')`, flags from `/proc/<pid>/fdinfo/N`, and for epoll selectors the set of `tfd:` entries.
  - Never `fstat` on the bootstrap's own fd number.
- Report rows are exactly `{fd, kind, device, inode, flags, tfds}`. `tfds` is a sorted list for selector kinds and `[]` otherwise. Rows travel in the existing amendment §6.1 FD3/FD4 current response (≤ 16384 bytes).
- `BootstrapComposition` takes `proxy_authority` instead of `proxy_entry`'s in-process owner. The gate is `type(proxy_authority) is ProxyChildAuthority`. A `ProxyRuntimeOwner` gives `ADAPTER_DENIED`.
- The PROXY path no longer uses `register_runtime_descriptor` or `retire_runtime_descriptor`: each observation carries the full inventory. Delete them if nothing else calls them.

Consumes: the Task 3 composition signatures and the Task 6 `vsockKey` initializer.

**Findings addressed:** CB-I2, CB-I7. Minors folded:
- compB M-2 and the T10 review's Python/Swift runtime-row divergences
- compB M-4 part P5
- compB M-5
- compA M-3 (selector identity bound through `tfds`; the Swift comment corrected)

**Steps:**

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/bootstrap_composition_test.py`:
  - `test_v1_proxy_authority_observes_child_proc_not_bootstrap_fds`: a literal `/proc` table for the child PID, while the bootstrap's own fds 5–7 hold different identities. The observed rows equal the child's.
  - `test_v1_in_process_proxy_runtime_owner_rejected`
  - `test_v1_proxy_report_omitting_or_adding_descriptor_denied`
  - `test_v1_proxy_report_and_proc_must_bracket_same_generation` (Review Focus 3): churn between report A and report B gives a terminal drift.
  - `test_v1_accepted_streams_after_admission_are_observed_not_registered`
  - Rewrite `test_v1_complete_guest_composition_uses_actual_accepted_modules`. The Harness must no longer replace `bind_runtime_owner`, `register_runtime_descriptor`, `inspect_runtime` or `observe_current_roles`; assert each is the module original by identity. The proxy side runs the actual `serve_proxy` over inert sockets in a separate thread, which stands in for the child.

  `tests/unit/proxy_test.py`:
  - `test_v1_equal_objects_cannot_substitute_listener_transport_sockets_timeline` (P1)
  - `test_v1_unknown_extra_fd_fails_runtime_current` (P7)
  - `test_v1_foreign_binding_observe_current_denied` (P6)
  - `test_v1_duplicate_request_id_denied` (P5)

  `tests/unit/confinement_test.py`:
  - `test_runtime_wire_row_rejects_non_proxy_kinds_above_fd4`. SubTests from the reviewer's `validator_laxity.py` and `runtime_row_divergence.py`:
    - COMMAND/NULL/RESULT rows at fd ≥ 5
    - `PROXY_VSOCK_STREAM` count > `PROXY_ACCEPTED_STREAM` count
    - duplicate `device:inode`
    - rows that differ from the originals

    Export the same vectors for Swift.

  `host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`:
  - `v1_runtime_row_divergence_vectors_match_python`

- [ ] **Step 2: Run RED.** PY-ONE(bootstrap_composition_test.py), PY-ONE(proxy_test.py), PY-ONE(confinement_test.py), then the producers and SWIFT-ONE(BootstrapGateTests).

- [ ] **Step 3: Implement** per the interfaces and C5. Add the code statement "the proxy loop must never run in the bootstrap process" next to the `ProxyChildAuthority` PID check.

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed: K7, K8, P1, P5, P6, P7, "restore local `fstat`", and "accept report A alone".

- [ ] **Step 5: Commit** `fix(acceptance): observe proxy runtime authority across the process boundary`.

### Task 8: Per-role outer seccomp for the Chromium sandbox (E1)

**Depends on:** Task 1.

**Files:**
- Modify: `guest/confinement.py` (`build_filter`)
- Modify: `host/Sources/AcceptanceCore/VMHost.swift` (role filter digest table at `:421-424`)
- Modify: `appliance/abi-inventory.json`, `appliance/abi-coverage-v2.json`
- Test: `tests/unit/abi_oracles.py`, `tests/unit/abi_coverage_test.py`, `tests/unit/bootstrap_reference_test.py`, `tests/unit/confinement_test.py`, `host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`

**Interfaces:**

`build_filter(role) -> tuple[tuple[int,int,int,int], ...]` keeps its signature.

Produces module constants:
- `BASE_DENY_SYSCALLS`: the existing 24, in the existing order.
- `BROWSER_SANDBOX_SYSCALLS = (51, 91, 143, 144, 145, 146, 147, 149, 151, 152, 159)`
- `SECCOMP_FLAGS_BY_ROLE`: `'BROWSER'` gets `(0, 1, 4, 5)`; every other role gets `(0, 1)`.

Produces test tables:
- `DENY_SYMBOLS_BY_ROLE`: BROWSER has 13 symbols, the other roles 24.
- `ROLE_FILTER_DIGESTS`:
  - CONTROLLER and VERIFIER stay `294f083482eb1caa13cd40ddb98489acd0712b2bd1a6e1d634622a24ed18d7b3`.
  - PROXY stays `01e3ec748fdbadb0a0ac195855506cc19680fcc5aa3c6289d2c15e15ec981d7d`.
  - BROWSER gets the new digest recorded in Step 3, which is not knowable in advance.

ABI ids: `SECCOMP_FILTER_FLAG_SPEC_ALLOW`, `SECCOMP_FILTER_FLAG_NEW_LISTENER`, `SECCOMP_FILTER_FLAG_LOG`, `SECCOMP_FILTER_FLAG_TSYNC_ESRCH`, `CLONE_NEWUSER`, `CLONE_NEWNET`, `AF_PACKET`, `SOCK_RAW`.

**Findings addressed:** T8-06 (per rulings R1 and R2).

**Steps:**

- [ ] **Step 1: Write the failing tests.** All of these evaluate the produced BPF program on synthetic `seccomp_data`.
  - `test_browser_filter_allows_namespace_sandbox_syscalls`:
    - For BROWSER, each of these gives `SECCOMP_RET_ALLOW`: `chroot`, `capset`, `setuid`, `setgid`, `setreuid`, `setregid`, `setresuid`, `setresgid`, `setfsuid`, `setfsgid`, `setgroups`, `unshare(CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET)`, `clone`, `clone3`.
    - For CONTROLLER, VERIFIER and PROXY, the eleven sandbox syscalls give `ERRNO|EPERM`, and `unshare`/`clone`/`clone3` give ALLOW as today.
  - `test_browser_filter_keeps_design_and_extra_denials`:
    - For BROWSER, each of these gives `ERRNO|EPERM`: `socket(AF_VSOCK)`, `socket(AF_PACKET)`, `socket(AF_INET, SOCK_RAW)`, `io_uring_setup`/`io_uring_register`/`io_uring_enter`, `ptrace`, `process_vm_readv`/`process_vm_writev`, `pidfd_getfd`, `pidfd_open`, `mount`, `umount2`, `pivot_root`, `setns`, `mknodat`.
    - A non-AArch64 arch gives `KILL_PROCESS`.
  - `test_browser_seccomp_flags_exact`:
    - BROWSER: flags 0, 1, 4 and 5 give ALLOW; flags 2, 8, 9, 12, 13 and 16 give EPERM.
    - Other roles: 4 and 5 give EPERM.
  - Update `test_filter_equals_symbolic_expected_program_per_role`: `expected_program(role)` uses `DENY_SYMBOLS_BY_ROLE[role]` and the role's flag set.
  - Update `test_filter_deny_list_matches_named_syscalls`: 24 symbols for non-browser roles, 13 for BROWSER.
  - `test_role_filter_digests_pinned`
  - Swift `v1_role_filter_digests_match_python`: consumes the exported topology fixture's `filterDigest` for each role, and checks the `VMHost.swift` table.

- [ ] **Step 2: Run RED.** PY-ONE(abi_coverage_test.py), PY-ONE(confinement_test.py), then the producers and SWIFT-ONE(BootstrapGateTests).

- [ ] **Step 3: Implement.**
  - `build_filter` emits the BROWSER deny list and flag branch per C6. Other roles' program bytes are unchanged.
  - Compute the new BROWSER digest. Pin it in `ROLE_FILTER_DIGESTS` and in `VMHost.swift:422`.

- [ ] **Step 3b: Run ABI-PIPELINE**(the eight ids above).

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed:
  - dropping `SPEC_ALLOW`
  - allowing flag 8
  - allowing `chroot` for CONTROLLER
  - removing `ptrace` from the BROWSER denials
  - removing `mount` from the BROWSER denials

  Record in the task log that a real Chromium sandbox start remains a Stage 2 item (C10).

- [ ] **Step 5: Commit** `fix(acceptance): align the browser outer filter with the Chromium namespace sandbox`.

### Task 9: Native attestation tests and native-port provenance

**Depends on:** Tasks 7 and 8.

**Files:**
- Modify: `guest/confinement.py` (`NativeKernelPort` sealing, `_KernelPortCore`, `OfflineKernelPort`, `select_native_kernel`, `_check`/`_native_observe` observed fields, `Descriptor.peer`, delete `validate_channel_message` and `proxy_endpoint`)
- Modify: `tests/guest/confinement_probe.py` (`NativeProbeFixtures` accepts only sealed native; new `OfflineProbeFixtures`; `CompletedProbeEpoch.native`)
- Modify: `guest/topology.py` (consumers at `:534`, `:894`, `:2559` and `BootstrapComposition` accept `OfflineProbeFixtures` as offline)
- Modify: `host/Sources/AcceptanceCore/VMHost.swift` (`BootstrapExecutableAuthority` private init; `:958` uses `offlineLiteral`)
- Modify: `host/Sources/AcceptanceCore/VMConfiguration.swift` (a comment only: `pins(manifest:)` stays unexercised until a reviewed native adapter exists)
- Test: `tests/unit/confinement_test.py`, `tests/unit/bootstrap_composition_test.py`, `tests/unit/appliance_test.py`, `host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`

**Interfaces:**

Produces:
- `_KernelPortCore`: the shared observation logic.
- `NativeKernelPort(_KernelPortCore)`, constructed only with `seal=_NATIVE_KERNEL_SEAL`. Only `select_native_kernel(mode, *, runtime_identity, validate_runtime)` passes the seal, and only over its own `LinuxBindings` loader. It takes no injected factory.
- `OfflineKernelPort(_KernelPortCore)`: unsealed, for tests and offline composition.
- `OfflineProbeFixtures(confinement, kernel: OfflineKernelPort, config, authority)`
- `CompletedProbeEpoch.native: bool`
- `BootstrapComposition.native -> bool`. It is False whenever the fixtures are offline.

Consumers check `type(x) is NativeKernelPort`, never `isinstance`.

**Findings addressed:** T8-04, T8-05. Minors folded:
- T8-07, T8-08, T8-09, T8-10
- compA M-4, compA M-5, compA M-6
- the compA part-A note on `CompletedProbeEpoch` provenance

**Steps:**

- [ ] **Step 1: Write the failing tests** in `tests/unit/confinement_test.py`. They use literal `/proc` bytes through `OfflineKernelPort`, never an `inspect` replacement.

  `test_native_observe_rejects_each_attestation_drift`, with one subTest per reviewer mutant:
  - M1: an extra `/dev` entry
  - M2: PID or mount namespace equal to the parent's
  - M3: user namespace differs
  - M4: `/proc/<pid>/root` inode differs
  - M5: fd 0–2 not `/dev/null`
  - M7: cmdline ≠ argv
  - M8: an extra entry in `/run/acceptance`
  - M9: tmpfs directory mode 0755, or wrong uid, gid or `st_dev`
  - M10: an extra fd 5
  - M11: a local initial-namespace fact
  - M14: non-empty groups
  - M15: wrong gids
  - M16: each of CapInh, CapPrm, CapEff, CapBnd and CapAmb nonzero (one subTest each)
  - M17: `RoleHandoff._exit` with a PID other than the attested PID
  - M18: `/etc` bind left `rw` in mountinfo

  Each expects `ConfinementError` with that check's code.

  Further tests:
  - `test_tsync_result_checked_independently_of_seccomp_mode` (T8-08): the double always reports `seccomp=2`. Install results 901, -1 and True must each fail.
  - `test_waiting_attestation_requires_seccomp_filters_1_and_observed_tty` (T8-09):
    - `Seccomp_filters: 1` is required while waiting.
    - `tty_nr` is read from `/proc/<pid>/stat`.
    - `inspect` never forces `waiting=True` for an unbound runtime.
  - `test_native_kernel_port_requires_seal` (T8-05, D5):
    - `NativeKernelPort(SimpleNamespace())` raises.
    - `NativeProbeFixtures` rejects an `OfflineKernelPort`.
    - The topology consumers reject an `OfflineKernelPort` as native.
  - `test_offline_epoch_is_never_native`
  - T8-07 renames and fixes:
    - Rename `test_child_fork_exec_network_gpu_crash_helper_inherits` to `test_filter_identical_for_every_helper_position_offline_proxy`.
    - `no_console_or_bridge_fd` varies only `kind` within an otherwise valid tuple.
    - Fix the inherited-ring part of the io_uring test.
    - Drop the SCM_RIGHTS unit test's assertions on the deleted dead functions.
  - `test_descriptor_peer_is_bootstrap_for_every_role` (T8-10)

  `tests/unit/appliance_test.py`:
  - `test_archive_member_without_exec_bit_denied` (compA M-6): a `0o644` `bin/node` member gives `ARCHIVE_UNSAFE`.

  `host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`:
  - `v1_offline_executable_authority_never_native` (compA M-4)

- [ ] **Step 2: Run RED.** PY-ONE(confinement_test.py), PY-ONE(bootstrap_composition_test.py), PY-ONE(appliance_test.py), then the producers and SWIFT-ONE(BootstrapGateTests).

- [ ] **Step 3: Implement.**
  - Split out `_KernelPortCore` and seal `NativeKernelPort`.
  - Move every composition and confinement test onto `OfflineKernelPort`/`OfflineProbeFixtures`.
  - Observe `Seccomp_filters` and `tty_nr` instead of echoing them.
  - Make the double report `seccomp=2` regardless of the TSYNC result.
  - Make the Swift init private.

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed: reviewer M1–M5, M7–M12 and M14–M18, plus the D5 construction.

- [ ] **Step 5: Commit** `fix(acceptance): bind native attestation checks and seal native kernel provenance`.

### Task 10: Probe-catalogue honesty and probe ABI binding

**Depends on:** Task 9.

**Files:**
- Modify: `tests/guest/confinement_probe.py` (the `PROBES` theft and ABI cases, `HELPER_SAMPLES`, `NativeProbePort._operation`, `_denial`, `NativeProbeContext`, parent-side inventory observation, console and mountinfo checks, `bootstrap_rejection` labels, module docstring residual)
- Modify: `appliance/abi-inventory.json`, `appliance/abi-coverage-v2.json`
- Test: `tests/unit/confinement_test.py`, `tests/guest/confinement_test.py`, `tests/unit/abi_oracles.py`, `tests/unit/abi_coverage_test.py`, `tests/unit/bootstrap_reference_test.py`

**Interfaces:**

The fixture authority gains these methods. They are all required, and absence is unavailability:
- `foreign_uid_process_in_role_ns(role) -> int`: a fixture-owned process of another role UID, inside the same PID namespace.
- `trusted_unix_names() -> tuple[str, ...]`
- `scm_rights_donor(target_role) -> str`: the UNIX name of a fixture donor that really sends one fd.
- `kernel_feature(name) -> bool`
- `correlate_inventory(role, facts_digest) -> authority`, which replaces `audit(port)`.

New theft operations in `SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied`:
- `proc-enumeration-family-only`
- `controller-SCM_RIGHTS`, `proxy-SCM_RIGHTS`: two distinct donor targets
- `trusted-unix-names-unreachable`
- `proc-controller-fd`, `proc-proxy-fd`
- `pidfd_open-getfd`
- `ptrace-attach`, `ptrace-seize`
- `process_vm_readv`, `process_vm_writev`: each with one non-empty iovec

Changes to `alternate_ABI_denied`:
- It drops `x86_64-audit` and `unknown-audit`, and their `HELPER_SAMPLES` entries.
- `AArch32-audit` requires `-code == SIGSYS`. Exception: when `kernel_feature('CONFIG_COMPAT') is False`, it requires an observed `ENOEXEC` exec refusal, with result `basis:'CONFIG_COMPAT_ABSENT'`.

Changes to `exact_fd_inventory`: the parent side runs `_native_observe(..., local=False)` and `_check` on each waiting family, and records `factsDigest`.

Accepted denial errno sets drop `EBADF`.

New test table `LAYOUT_LITERALS`, holding R13 layout literals with a one-line justification each, reviewer-accepted:
- iovec `'<QQ'`
- cmsghdr `'<Qii'`
- sockaddr_un `'<H108s'`
- the existing sockaddr_vm `'<HHIIB3x'`
- sockaddr_in and sockaddr_in6
- the capset header and data

ABI ids: `__NR_recvmsg`, `MSG_CMSG_CLOEXEC`, `SCM_RIGHTS`, `SOL_SOCKET`, `ENOTSOCK`, `EBADF`, `ECONNREFUSED`, `ENOENT`, `ENOEXEC`, `PTRACE_ATTACH`, `PTRACE_SEIZE`, `SIGSYS`.

**Findings addressed:** T8-01, T8-02, T8-03; Option A I1 and m4. Minors folded: T8-12, T8-13, compA M-8.

**Steps:**

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/confinement_test.py`, using inert recorder bindings in the style of the reviewer's `probe_semantics.py`:
  - `test_theft_probes_target_real_foreign_objects`:
    - The ptrace request is `PTRACE_ATTACH` or `PTRACE_SEIZE`, never 0.
    - The target PID comes from `foreign_uid_process_in_role_ns`.
    - `pidfd_getfd` receives the pidfd returned by `pidfd_open`.
    - The iovec length is greater than 0.
    - The two SCM_RIGHTS cases have distinct targets.
    - `EBADF` gives `UNEXPECTED_KERNEL_ERROR`.
  - `test_scm_rights_donor_fd_received_is_failure`: a donor cmsg gives `ProbeFailure('FD_DONOR_REACHED')`.
  - `test_proc_enumeration_reports_non_family_pid`
  - `test_abi_probe_requires_sigsys`: a SIGSEGV death gives `ProbeFailure` (D1); a SIGSYS death gives denied.
  - `test_abi_catalogue_has_no_unrealisable_cases`
  - `test_aarch32_without_compat_requires_observed_exec_refusal`
  - `test_exact_fd_inventory_probe_observes_parent_side`: a rubber-stamp authority with mismatched facts fails (D4).
  - `test_console_probe_opens_read_and_write` (T8-12)
  - `test_check_appliance_uses_last_mountinfo_row` (T8-12)
  - `test_library_recheck_cases_are_labelled` (T8-13): `basis:'LIBRARY_RECHECK'`; the empty-fprog case is renamed `invalid-filter-einval`.

  `tests/unit/abi_coverage_test.py`:
  - `test_probe_syscall_sites_use_covered_numbers`: extends `SYSCALL_SITES` to `tests/guest/confinement_probe.py`.
  - `test_probe_errno_signal_and_flag_literals_match_named_symbols`
  - `test_layout_literals_are_justified`

  `tests/guest/confinement_test.py`: the gated driver uses the new operations and stays `RuntimeGateUnavailable` without native fixtures.

- [ ] **Step 2: Run RED.** PY-ONE(confinement_test.py), PY-ONE(abi_coverage_test.py).

- [ ] **Step 3: Implement** the catalogue and context changes above. Record the compA M-8 fixture-trust residual in the module docstring.

- [ ] **Step 3b: Run ABI-PIPELINE**(the twelve ids above).

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed:
  - Option A D (ptrace 117 → 41)
  - Option A E (recvmsg → sendmsg)
  - ptrace request restored to 0
  - `EBADF` accepted again
  - any signal accepted again
  - the D4 rubber stamp

- [ ] **Step 5: Commit** `fix(acceptance): make guest probes attempt and observe what they claim`.

### Task 11: Event supervision, event-literal binding, browser transition and launch latch

**Depends on:** Tasks 9 and 10.

**Files:**
- Modify: `guest/topology.py` (`_audit_record`, `_accept_browser_transition`, `_check_pending`, `reserve_browser_transition`/`commit_browser_transition`, the family model)
- Modify: `guest/role-ports.cjs` (`activateOnce` deadline; forward a frozen verified projection to `authority.activate`)
- Modify: `appliance/README.md` (wording at the "independently approved" claim only; the line-149 digest text stays byte-identical)
- Modify: `appliance/abi-inventory.json`, `appliance/abi-coverage-v2.json`
- Test: `tests/unit/topology_test.py`, `tests/unit/bootstrap_composition_test.py`, `tests/unit/bootstrap-composition.test.cjs`, `tests/unit/role-ports.test.cjs`, `tests/unit/abi_oracles.py`, `tests/unit/abi_coverage_test.py`, `tests/unit/bootstrap_reference_test.py`

**Interfaces:**
- `_fixed_audit_rule()` output bytes are unchanged: this task binds them, it does not change them.
- `_audit_record` accepts `exit`/`exit_group` SYSCALL records without `success=`/`exit=`, per `kernel/auditsc.c:1838-1849` and `:1697-1701` (member SHA-256 `69a9c142…9794`).

Browser transition grammar: `CLONE → EXEC → ACTIVE`.
- **EXEC** requires same-serial `AUDIT_PATH`/`AUDIT_EXECVE` records naming `confinement.CHROME`, whose `dev`/`inode` equal the retained installed executable identity.
- **ACTIVE:**
  - `clone`/`clone3` by a family PID adds the child to the BROWSER family.
  - `execve`/`execveat` by a family PID must name the pinned Chromium executable; anything else is terminal.
  - A family exit removes the PID.
  - A root browser exit is terminal, `BROWSER_EXITED`.
  - The old EXIT phase is removed.
- After commit, a transition still in CLONE or EXEC raises `EVENT_PENDING` at every barrier, and becomes terminal after the existing 1000 ms pending bound.

ABI ids: `AUDIT_FILTER_EXIT`, `AUDIT_ALWAYS`, `AUDIT_ARCH`, `AUDIT_EQUAL`, `AUDIT_GET`, `AUDIT_LIST_RULES`, `AUDIT_SYSCALL`, `AUDIT_SOCKADDR`, `AUDIT_EOE`, `AUDIT_PATH`, `AUDIT_EXECVE`, `AUDIT_STATUS_ENABLED`, `AUDIT_STATUS_FAILURE`, `AUDIT_STATUS_PID`, `AUDIT_STATUS_RATE_LIMIT`, `AUDIT_STATUS_BACKLOG_LIMIT`, `AUDIT_BITMASK_SIZE`, `AUDIT_MAX_FIELDS`, `RTMGRP_LINK`, `RTMGRP_IPV4_IFADDR`, `RTMGRP_IPV4_ROUTE`, `RTMGRP_IPV6_IFADDR`, `RTMGRP_IPV6_ROUTE`, `RTM_NEWLINK`, `RTM_DELLINK`, `RTM_NEWADDR`, `RTM_DELADDR`, `RTM_NEWROUTE`, `RTM_DELROUTE`, `NLM_F_ACK`, `NLM_F_DUMP_INTR`, `NLMSG_DONE`, `NLMSG_ERROR`, and every `IN_*` bit in `_INOTIFY_MASK` plus `IN_Q_OVERFLOW`, `IN_IGNORED` and `IN_UNMOUNT`.

**Findings addressed:** CB-I3, CB-I4, CB-I6; Option A I2/R17 C3, R17 C4 (`'c00000b7'`), and the fix-wave's unbound `fields[0]`/`operators[0]`. Minors folded: T8-11, compB M-4 part K1, compB M-6, compA M-7.

**Steps:**

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/abi_coverage_test.py`:
  - `test_topology_event_literals_match_named_symbols`. One assertion per literal:
    - the audit rule's flags, action and `field_count`, `fields[0]`, `values[0]`, `operators[0]` and every mask word
    - `_ROUTE_GROUPS` and `_INOTIFY_MASK`
    - the route kinds 16, 17, 20, 21, 24 and 25
    - the audit kinds 1000, 1300, 1302, 1306, 1309 and 1320
    - the status mask 31
    - the overflow bits
    - `int('c00000b7', 16)` equal to `AUDIT_ARCH_AARCH64`
  - `test_coverage_event_values_equal_event_reference_records`: every id present in both the coverage file and the event reference has an equal value. The reference SHA is unchanged.

  `tests/unit/topology_test.py`:
  - `test_v1_enumerated_rule_built_independently_of_production_constant`: the double builds its rule from coverage values. Reviewer mutants E2 and E4 must die.
  - `test_v1_audit_lost_counter_increase_latches_terminal` (E11)
  - `test_v1_async_audit_record_with_ack_flag_terminal` (E12)
  - `test_v1_exec_must_name_pinned_chromium_executable` (E5, E6)
  - `test_v1_reserved_transition_stuck_in_clone_is_pending_then_terminal`
  - `test_v1_kernel_format_exit_record_without_success_field_parses`: record text formatted per `audit_log_exit`.
  - `test_v1_family_reexec_of_pinned_chromium_accepted_other_exec_terminal` (Review Focus 4)
  - `test_v1_clone_only_from_browser_root_or_family` (E13)

  `tests/unit/bootstrap-composition.test.cjs` (CB-I6). Each case must record zero launches:
  - `v1_second_commit_on_one_reservation_launches_nothing`: with and without a second COMMIT frame (J1+J6).
  - `v1_fence_from_foreign_source_launches_nothing` (J3)
  - `v1_fence_with_lower_sequence_or_changed_lost_count_launches_nothing`
  - `v1_current_with_foreign_proof_digest_launches_nothing` (J9)
  - `v1_refresh_correlation_checked_by_bootstrap` (K1)
  - Make `v1_controller_and_worker_nominal_stores_are_disjoint` fail when one shared module store is used (compB M-6).

  `tests/unit/role-ports.test.cjs` (T8-11):
  - `arbitrary_role_program_argv_fd_request_reject` asserts on what reaches `authority.activate`.
  - `used_grant_replay_rejected` (J1).
  - `activate_once_bounded_by_remaining_budget`.

- [ ] **Step 2: Run RED.** PY-ONE(topology_test.py), PY-ONE(abi_coverage_test.py), NODE-ONE(bootstrap-composition.test.cjs), NODE-ONE(role-ports.test.cjs).

- [ ] **Step 3: Implement.**
  - The grammar, the parser relaxation for exit records, and the pending-after-commit rule.
  - The independent double, and the role-ports projection and deadline.
  - README wording: "committed Task 2 reference; original review record lost; semantic records pending re-review" (compA M-7).

- [ ] **Step 3b: Run ABI-PIPELINE**(the event ids above). The event reference stays unchanged.

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed: reviewer E1–E7, E11, E12, E13, E15, J1+J6, J3, J9, K1, and Option A L, F and G.

- [ ] **Step 5: Commit** `fix(acceptance): bind event literals and model the Chromium launch family`.

### Task 12: Credential intake framing and privacy (E6)

**Depends on:** Task 1.

**Files:**
- Modify: `guest/intake.py`
- Modify: `host/Sources/AcceptanceCore/SerialConsole.swift`
- Test: `tests/unit/intake_test.py`, `host/Tests/AcceptanceCoreTests/ConsoleTests.swift`

**Interfaces:**

Produces (guest):
- `CREDENTIAL_LIMIT = 4096`
- `_read_credential(fd: int, grant: IntakeGrant, start_ms: int) -> bytearray`:
  1. Sets raw mode with `TCSAFLUSH` and takes `TIOCEXCL`.
  2. Reads exactly 4 bytes as a big-endian length `n`, requiring 1 ≤ n ≤ 4096; otherwise `CREDENTIAL_INVALID`, without reading a body.
  3. Reads exactly `n` bytes into a preallocated `bytearray(4096)`.
  4. Validates UTF-8 with a bounded validator that creates no exception object.
  5. Keeps the existing NUL rejection.
  6. Zeroes the buffer on every path.
  7. Calls `tcflush(TCIFLUSH)` on exit.
- Raw mode is set with named `termios` constants only. In `lflag`, clear `ECHO`, `ECHONL`, `ICANON`, `ISIG` and `IEXTEN`. In `iflag`, clear `ICRNL`, `INLCR`, `IGNCR`, `IXON` and `ISTRIP`. Set `VMIN=1` and `VTIME=0`. No numeric termios literal.
- `IntakeFailure` is raised outside any `except` block, with `__context__ = None` and `__cause__ = None`.
- `ConsumeResult` has no `byte_length`.
- A run-scoped latch, `_CONSUMED_RUNS`, rejects a second grant for the same run.
- During restore, signals SIGINT, SIGTERM, SIGHUP, SIGQUIT and SIGTSTP are blocked with `pthread_sigmask`.
- `PrivatePipeSink.issue` hex-validates `child_id`. The sink writes the whole frame under its deadline. A partial write gives `SINK_FAILED` and closes the pipe.

Produces (host):
- `ConsoleSerialInput(fd: Int32, runID: String)`, renamed from `ConsolePrivatePipeSink`. No `consumer`, `childID` or `childUID`.
- `CredentialFrame.encode(_ secret: Data) throws -> Data`: a `UInt32` big-endian length, then the bytes, for 1–4096 bytes. Oversize throws the new `ConsoleFailure.credentialInvalid`.
- The host terminal read sets `c_lflag` explicitly: `ICANON` on; `ISIG`, `IEXTEN` and `ECHO` off; applied with `TCSAFLUSH`. The trailing newline is stripped before framing. `O_NONBLOCK` is restored first.
- When `CREDENTIAL_FRAME_EXCHANGE` is set, Swift writes `<dir>/credential-frames.json` exclusively, as `{"vectors":[{"secretHex":…,"frameHex":…}]}`.

**Findings addressed:** T11-I1, T11-I2, T11-I3. Minors folded: T11-M1, T11-M2, T11-M3, T11-M4, T11-M5 (run latch; sealing `AdmissionProof` is deferred, see the appendix), T11-M6 (`TIOCEXCL` plus a recorded residual for recording or unattended input), T11-M7, T11-M8.

**Steps:**

- [ ] **Step 1: Write the failing tests.**

  Each intake test drives a real PTY and is bounded by `signal.alarm(5)`.

  `tests/unit/intake_test.py`:
  - `test_length_prefixed_frame_vectors_decode_exactly`. Vectors:

    | Case | Input | Expected |
    |---|---|---|
    | (a) | `b'synthetic-private-canary'`, header `00000018` | decodes |
    | (b) | `b'0123456789'`, header `0000000a` | decodes |
    | (c) | `b'pa\nss\x03\x04\x15\x7fword'`, header `0000000d` | decodes byte-exact |
    | (d) | 4096 × `b'a'` | accepted |
    | (e) | declared length 4097 | `CREDENTIAL_INVALID`, no body read |
    | (f) | declared length 0 | `CREDENTIAL_INVALID` |
    | (g) | truncated body, then EOF | `TERMINAL_LOST` |
    | (h) | `b'\xff'` | `CREDENTIAL_INVALID` |

  - `test_length_prefix_control_bytes_before_raw_mode_flushed_and_fail` (Review Focus 5): typeahead `b'\x00\x00\x00\x0a'` written before raw mode is flushed, and a following valid frame decodes. Header bytes `0x03` cause no SIGINT delivery.
  - `test_exception_chain_holds_no_credential`: for invalid UTF-8 and for a sink failure, walk `__context__`, `__cause__`, `.object` and the `f_locals` of every frame in `__traceback__`. There must be zero canary occurrences.
  - `test_no_echo_on_pty_master`: after a consume, reading the master gives zero canary bytes.
  - `test_fd_level_output_has_no_canary`: fd 1 and fd 2 are `dup2`'d to a pipe during intake.
  - `test_oversize_terminal_loss_handler_restore_and_late_signal`: oversize; terminal loss after closing the master; original handlers restored; a second SIGINT during restore still leaves echo restored and gives a finite `IntakeFailure`.
  - `test_second_grant_for_same_run_rejected` (T11-M5)
  - `test_consume_result_has_no_length` (T11-M7)
  - `test_swift_credential_frames_decode_in_python`: when `CREDENTIAL_FRAME_INPUT` is absent, `skipTest('CREDENTIAL_FRAME_INPUT absent')`. The Task 18 consumer run must execute it, not skip it.
  - Rename `test_automation_child_no_console_access` to `test_sink_issue_rejects_console_fd_facts_offline`.

  `host/Tests/AcceptanceCoreTests/ConsoleTests.swift`:
  - `credential_frame_vectors_match_python`: the same headers.
  - `credential_frames_exported_for_python`
  - `serial_input_has_no_guest_role_fields`
  - `oversize_credential_is_credential_invalid`
  - `host_output_and_receipts_hold_no_canary`: reads the actual published records and the PTY output.
  - Rename `broker_fd_inventory_no_TTY` and `automation_child_no_console_access` to `broker_fd_inventory_no_TTY_over_supplied_facts` and `automation_child_no_console_access_over_supplied_facts`.

- [ ] **Step 2: Run RED.** PY-ONE(intake_test.py), then the producers and SWIFT-ONE(ConsoleTests).

- [ ] **Step 3: Implement** per the interfaces and C8.

- [ ] **Step 4: Confirm GREEN and run BROAD**, including the new credential consumer. Mutations M11-1 through M11-7 must each be killed in under 10 s. Also killed: "raise inside `except`" and "canonical mode".

- [ ] **Step 5: Commit** `fix(acceptance): frame the credential the same way on host and guest`.

### Task 13: Controller state-machine outcomes and safe sign-out

**Depends on:** Task 1.

**Files:**
- Modify: `guest/state.cjs`
- Test: `tests/unit/state.test.cjs`

**Interfaces:**

Produces:
- `initialState(runId, nowMs) -> ControllerState`, exported next to `PHASES`, `EFFECTS`, `LIMITS` and `reduce`.
- `STATE_KEYS` adds:
  - `sessionMaybeIssued` (boolean): set when `LOGIN` is emitted.
  - `safeSignOutRouted` (boolean)
  - `revocation`: one of `'NOT_REQUIRED' | 'PENDING' | 'CONFIRMED' | 'UNCONFIRMED'`.
  - `postTerminalAnomaly` (boolean)
- Internal events:
  - `safeSignOutRoute {outcome: 'ELIGIBLE'|'DENIED'}`: accepted once in FAILED, after `SAFE_SIGN_OUT`.
  - `safeSignOutResult {outcome: 'REVOKED'|'FAILED'}`
  - `tick {}`: evaluates deadlines.
- `budget` is admitted in PREFLIGHT and AWAIT_CREDENTIAL. HOLD is still denied.
- `SAFE_SIGN_OUT` is emitted only on `abort{boundaryTrusted:true}` with `sessionMaybeIssued && !logoutAttempted`. Every other failure with `sessionMaybeIssued` and no confirmation gives `revocation:'UNCONFIRMED'`.
- The first cleanup `FAIL` is sticky.
- DONE absorbs non-`readResult` events: it sets `postTerminalAnomaly=true` and nothing else.
- `sessionExpiresAtMs` is documented as guest monotonic, converted by Task 22.
- Restart non-resumption is documented as owned by Tasks 21–22.

`validState` per-phase invariants:
- **AUTHENTICATED_PHASES** require `credentialConsumed`, `loginAttempted`, `authenticated`, `sessionMaybeIssued` and a non-null `sessionExpiresAtMs`.
- **VERIFY_REVOCATION, FINALIZE and DONE** additionally require `logoutAttempted` and `restartReceiptConsumed`.
- **FINALIZE and DONE** require `cleanupStartedAtMs !== null`.
- **DONE** requires `cleanupComplete` and `revocation === 'CONFIRMED'`.
- **PREFLIGHT and AWAIT_CREDENTIAL** require every progress flag to be false.

**Findings addressed:** T12-I1, T12-I2, T12-I3, T12-I4. Minors folded: T12-M1, T12-M2, T12-M3.

**Steps:**

- [ ] **Step 1: Write the failing tests** in `tests/unit/state.test.cjs`.

  One negative test per outcome gate. Each asserts `FAILED`, the exact code and no `FORWARD_ROUTE`:

  | Test | Input | Expected code | Mutant |
  |---|---|---|---|
  | `validate_without_verified_admission_fails` | `validate` without VERIFIED admission | `INVALID_FRAME` | M12-6 |
  | `restart_receipt_rejected_fails` | restart receipt `REJECTED` | `SIGNATURE_INVALID` | M12-7 |
  | `finalize_fail_fails` | `finalize FAIL` | `CLEANUP_INCOMPLETE` | M12-8 |
  | `verify_revocation_fail_fails` | `verifyRevocation FAIL` | `SESSION_MISMATCH` | M12-9 |
  | `sign_out_failed_fails` | `signOut FAILED` | `SESSION_MISMATCH` | M12-10 |
  | `observe_before_fail_fails` | `observeBefore FAIL` | `OBSERVATION_FAILED` | M12-11 |
  | `consume_rejected_fails` | `consumeCredential REJECTED` | `CREDENTIAL_INVALID` | M12-12 |
  | `login_failed_fails` | `login FAILED` | `SESSION_MISMATCH` | M12-13 |
  | `budget_denied_fails` | `budget DENIED` | `BUDGET_EXCEEDED` | M12-14 |
  | `observe_after_fail_fails` | `observeAfter FAIL` | `OBSERVATION_FAILED` | M12-15 |

  Further tests:
  - `all_failing_run_never_reaches_done` (the M12-ALL driver)
  - `finalize_cleanup_deadline` (M12-1)
  - `invalid_event_in_failed_keeps_first_code` (M12-2)
  - `hold_and_logout_session_expiry` (M12-3)
  - `outage_in_every_live_phase` (M12-4)
  - `done_absorbs_stray_events_with_anomaly_flag` (M12-5, T12-M1)
  - `p_phase_budget_forwards_in_preflight_and_await_credential`, and `hold_budget_still_denied` (T12-I2)
  - `safe_sign_out_route_admitted_once_in_failed`
  - `safe_sign_out_result_recorded`
  - `revocation_unconfirmed_when_session_maybe_issued_without_confirmation`
  - `trusted_abort_in_authenticating_requests_safe_sign_out` (T12-I3)
  - `initial_state_is_the_only_constructor_and_hand_built_inconsistent_states_rejected` (P12-C cases, T12-I4)
  - `cleanup_fail_is_sticky` (T12-M2)
  - `tick_enforces_deadlines` (T12-M3)

- [ ] **Step 2: Run RED.** Run NODE-ONE(state.test.cjs).

- [ ] **Step 3: Implement** per the interfaces. The reducer stays pure: no new effect kinds besides those listed.

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed: M12-1 through M12-15, and M12-ALL.

- [ ] **Step 5: Commit** `fix(acceptance): bind every controller failure outcome and safe sign-out`.

### Task 14: Per-role private storage (E5)

**Depends on:** Task 9.

**Files:**
- Modify: `guest/storage.py`
- Modify: `guest/confinement.py`:
  - `NativeChildPort.establish_views`: per-role `/dev/shm` tmpfs and crash bind
  - `exec_role`: pre-exec admission hook
  - `NativeKernelPort.run_storage_cleanup`
  - `_check`: the new mounts
  - `_ProbeFamilyOwner` scope cleanup unmounts `dev/shm` before `rmdir`
- Test: `tests/unit/storage_test.py`, `tests/guest/storage_test.py`, `tests/unit/confinement_test.py`, `tests/unit/abi_coverage_test.py` (the new `mount` site's table only; no new inventory ids)

**Interfaces:**

Produces (`storage.py`):
- `ROLE_SCOPES = MappingProxyType({role: ('/run/acceptance/' + role.lower(), '/tmp', '/var', '/dev/shm', '/run/acceptance/crash') for role in UIDS})`. These are paths as seen inside the role view.
- `admit_role_storage(role: str, policy: StoragePolicy, filesystem, kernel_port) -> RoleStorageProof`. Gives `STORAGE_INVALID` unless `kernel_port.uid() == UIDS[role]`.
- `crash_aggregate(root_fd: int, *, proof: RoleStorageProof) -> CrashAggregate`
- `remove_role_state(proof: RoleStorageProof) -> CleanupResult`: best effort across every scope root, with a sticky incomplete result.
- `combine_crash_aggregates(aggregates: tuple[CrashAggregate, ...]) -> CrashAggregate`: exactly four, metadata only.
- An explicit depth cap: `MAX_DEPTH = 64`.
- Removed: `admit_storage`, `remove_owned_state`, `ROOT_ROWS`.

Produces (`confinement.py`):
- `establish_views` mounts a tmpfs at `<root>/dev/shm` with data `size=67108864,mode=0700,uid=<uid>,gid=<uid>` and flags `MS_NOSUID|MS_NODEV|MS_NOEXEC`.
- It creates `/run/acceptance/crash/<role>`, mode 0700 and role-owned, on the bootstrap-mounted 1048576-byte crash tmpfs, and binds it at `<root>/run/acceptance/crash`.
- `exec_role` calls `admit_role_storage` after `install_seccomp` and before `exec_pinned`. The proof digest goes into the role's FD4 attestation.
- `NativeKernelPort.run_storage_cleanup(role, launch) -> CleanupResult`: a fixed operation in a fresh confined child, with the role's views, UID and filter.

**Findings addressed:** T18-I1, T18-I2, T18-I3 (per ruling R8). Minors folded: T18-M1, T18-M2, T18-M3 (the signatures are recorded in contract C7).

**Steps:**

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/storage_test.py`:
  - `test_role_admits_only_its_own_scope_as_its_uid`
  - `test_admission_refuses_wrong_uid`
  - `test_readability_tied_to_owning_uid`: an unreadable empty 0600 file fails, and a privileged (uid 0) port gives `STORAGE_INVALID`.
  - `test_task8_view_layout_admits`: the reviewer's P18-A layout seen inside the view now gives ADMITTED.
  - `test_role_visible_dev_shm_bound_is_64MiB_tmpfs`: a bind on the run device fails, and a size other than 67108864 fails.
  - `test_crash_scope_reachable_per_role_and_aggregated_by_metadata`
  - Rewrite `test_deletion_owned_scope_only`:
    - Setup: a shared `/run/acceptance` parent holding all role roots plus an outside sibling, a device-drifted child, and a symlink and a file planted after admission.
    - Expected: the outside nodes survive, and cleanup reports incomplete.
  - `test_gid_mismatch_fails` (M18-3)
  - `test_removal_time_swap_fails` (M18-4)
  - `test_depth_bound`
  - `test_failure_traceback_has_no_names` (T18-M1)
  - `test_cleanup_continues_across_roots` (T18-M2)

  `tests/unit/confinement_test.py`:
  - `test_establish_views_mounts_role_shm_tmpfs_and_crash_bind`: checks the recorded syscalls.
  - `test_pre_exec_storage_admission_runs_after_seccomp_before_exec`
  - `test_storage_cleanup_child_is_fixed_operation`

  `tests/guest/storage_test.py`: becomes four per-role cases, still `RuntimeGateUnavailable` without a native port.

  `tests/unit/abi_coverage_test.py`: the new `mount` site decomposes into the existing `MS_NOSUID|MS_NODEV|MS_NOEXEC` symbols.

- [ ] **Step 2: Run RED.** PY-ONE(storage_test.py), PY-ONE(confinement_test.py), PY-ONE(abi_coverage_test.py).

- [ ] **Step 3: Implement** per the interfaces and C7. Update the attestation's `/run/acceptance` listing and its tmpfs checks for the new mounts. The reviewer confirms that no check is loosened beyond those two new mounts.

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed: M18-1 through M18-4, and "a single caller admits all roots".

- [ ] **Step 5: Commit** `fix(acceptance): admit and clean storage per role inside its own view`.

### Task 15: Browser routing, headers and asset integrity

**Depends on:** Tasks 1 and 13.

**Files:**
- Modify: `guest/browser-worker.cjs` (navigation, `factsFor`, the response validator, startup deadline)
- Modify: `guest/browser.cjs` (`decideRoute` latch, `BrowserSession.failureCode()`, `WORKER_CODE_MAP`, `perform` deadline)
- Test: `tests/unit/browser.test.cjs`

**Interfaces:**

Produces:
- Navigation: `page.goto(config.runBinding.origins.FRONTEND + '/login', {waitUntil:'domcontentloaded'})`.
- `BROWSER_GENERATED_HEADERS = ['user-agent','accept-language','accept-encoding','referer','cookie','sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform','sec-fetch-site','sec-fetch-mode','sec-fetch-dest','sec-fetch-user','upgrade-insecure-requests']`. Every other request header goes into the ROUTE facts, where the route policy's existing allowlist decides.
- Local abort before any ROUTE frame on `authorization`, `proxy-authorization`, any `x-*`, `x-http-method-override` and `x-method-override`.
- Every frontend document response for an SPA route (`/`, `/login`, and the fixed view paths) is validated against the manifest's `/index.html` entry.
- Every manifest-asset response is validated for the whole run, repeats included. Any failure latches the session as terminal `OBSERVATION_FAILED`, and the next `perform` and `close` reject.
- `decideRoute`: any admission error other than the expected timer or replay aborts latches the session as terminal `ROUTE_DENIED`, rejects pending actions, and exposes the code via `BrowserSession.failureCode()`.
- Startup and `perform` are bounded by the run binding's expiry.
- `WORKER_CODE_MAP` maps worker codes to the closed failure enum. Unknown codes become `'INTERNAL_FAILURE'`.

**Findings addressed:** T13 I-1, I-2, I-3, I-7. Minors folded: T13 m-6, m-8.

**Steps:**

- [ ] **Step 1: Write the failing tests** in `tests/unit/browser.test.cjs`:
  - `initial_navigation_is_login_and_continued_in_phase_P`: the fake `goto` rejects when the route is aborted. Assert `CONTINUE` and pathname `/login`.
  - `authorization_x_header_and_method_override_abort_locally`: the reviewer's D3 headers; zero ROUTE frames.
  - `non_generated_headers_reach_controller_admission`: header `foo` appears in the ROUTE facts, and the policy denies it.
  - `login_document_bytes_validated_against_index_entry`: a tampered `/login` body gives `OBSERVATION_FAILED` before READY.
  - `post_ready_asset_tamper_latches_and_fails_next_action` (D2)
  - `route_denial_latches_session_and_fails_next_perform` (D7): an economic POST is aborted, and the next `OBSERVE_VIEW` rejects with `ROUTE_DENIED`.
  - `startup_and_perform_bounded_by_run_expiry`
  - `worker_codes_map_to_closed_enum`

- [ ] **Step 2: Run RED.** Run NODE-ONE(browser.test.cjs).

- [ ] **Step 3: Implement** per the interfaces and C9.

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed:
  - restoring header stripping
  - `goto('/')`
  - skipping post-READY validation
  - swallowing denials
  - excluding document paths

- [ ] **Step 5: Commit** `fix(acceptance): route the first navigation, all headers and every asset through admission`.

### Task 16: Browser provenance, descriptor inventory and unbound checks

**Depends on:** Task 15.

**Files:**
- Modify: `guest/role-ports.cjs` (export `inspectAdoptedRolePort`)
- Modify: `guest/browser.cjs` (export `isBrowserSession`; remove the legacy audit/HMAC branch at `:44-48`)
- Modify: `guest/session.cjs`, `guest/observation.cjs` (require `isBrowserSession`)
- Modify: `guest/browser-worker.cjs` (`classifyDescriptor`, the native family readers, the seccomp/UID status check, re-inspection)
- Test: `tests/unit/browser.test.cjs`, `tests/unit/session.test.cjs`, `tests/unit/observation.test.cjs`, `tests/guest/browser_test.cjs`

**Interfaces:**

Produces:
- `inspectAdoptedRolePort(value) -> boolean`: a WeakSet brand for adopted `activateOnce` handles and application pipes.
- `isBrowserSession(value) -> boolean`: reads the existing `sessions` brand map. `openBrowser` requires `inspectAdoptedRolePort`.
- `classifyDescriptor(link, socketInodes) -> 'PIPE'|'NULL'|'UNIX'|'TCP'|'UDP'|'CONSOLE'|'UNKNOWN_SOCKET'|'UNREADABLE'|'OTHER'`:
  - Socket inodes are attributed only from `/proc/net/{unix,tcp,tcp6,udp,udp6}`. An unattributed socket (vsock included) is `UNKNOWN_SOCKET`, which is a failure.
  - `CONSOLE` matches `/dev/hvc*`, `/dev/vport*`, `/dev/console`, `/dev/tty*` and `/dev/pts/*`.
  - A `readlink` error is `UNREADABLE`, which is a failure.
- Status check:
  - `Seccomp:` must be exactly `2`.
  - `Seccomp_filters` must be ≥ 1.
  - All four `Uid:` and all four `Gid:` fields must be 10002.
- The family is re-inspected after the first page load and before credentials. Unreadable Chromium children give an explicit `FAMILY_UNREADABLE`.

**Findings addressed:** T13 I-6, I-8, I-10. Minors folded: T13 m-1 (= Option A m3), m-5, m-7.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - `forged_role_port_cannot_open_session` (D4): the canary is never written.
  - `legacy_confinement_boolean_branch_removed`
  - `session_and_observation_require_branded_browser_session`
  - `vsock_socket_unattributable_fails_inventory`
  - `hvc0_vport_console_descriptors_fail`
  - `unreadable_descriptor_fails`
  - `native_readers_parse_fake_proc`: executes `inspectNativeFamily` and `forbiddenDescriptorCounts` against a fake `/proc`.
  - `seccomp_status_requires_mode_2_filters_and_all_uids`
  - `family_reinspected_after_first_load`
  - The twelve I-10 tests, one per reviewer mutant:

    | Test | Mutant |
    |---|---|
    | `controller_asset_proof_validation_bound` | M7 |
    | `controller_discards_password_reference_after_filled` | M18 |
    | `controller_run_binding_checked` | M23 |
    | `duplicate_session_cookie_rejected` | M17 |
    | `owner_username_checked` | M4 |
    | `robo_paper_health_connected_required` | M20 |
    | `alert_role_error_state_fails` | M25 |
    | `native_status_seccomp_checked` | M2 |
    | `popup_route_check_bound_with_policy_allowed_path` (the popup requests `/api/me`, which the policy allows) | M11 |
    | `worker_ready_gate_bound` | M28 |
    | `route_backlog_bound_at_16` | M37 |
    | `observation_layer_continuity_bound` | M21 |

  - `tests/unit/session.test.cjs` (m-5): `wrong_owner_fail_before_deeper_read` and `daytrader_session_Secure_HttpOnly_SameSite_None_path_root_host_only` are driven through the real worker harness.
  - `tests/guest/browser_test.cjs`: replace the `.includes('vsock')` check with `classifyDescriptor` plus the seccomp and console checks. The test stays gated.

- [ ] **Step 2: Run RED.** NODE-ONE(browser.test.cjs), NODE-ONE(session.test.cjs), NODE-ONE(observation.test.cjs).

- [ ] **Step 3: Implement** per the interfaces.

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed: M2, M3, M4, M7, M11, M17, M18, M20, M21, M23, M25, M28, M37, and D4.

- [ ] **Step 5: Commit** `fix(acceptance): brand browser sessions and make descriptor checks observe real families`.

### Task 17: Readiness and owner gates from worker observations

**Depends on:** Task 16.

**Files:**
- Modify: `guest/observation.cjs` (export `readinessPredicate`; remove literal-minted `validateReadiness`; phase-bound results; maintenance trust)
- Modify: `guest/browser-worker.cjs` (`SESSION_READINESS` action; delete the worker-local `validReadiness`; derived result fields)
- Modify: `guest/browser.cjs` (mint `WorkerGateHandle`)
- Modify: `guest/receipts.cjs` (`createReceiptAdapters().verifyGate` accepts only matching `WorkerGateHandle`s)
- Test: `tests/unit/observation.test.cjs`, `tests/unit/browser.test.cjs`, `tests/guest/observation_test.cjs`, `tests/guest/session_test.cjs`

**Interfaces:**

Produces:
- `readinessPredicate(body) -> boolean` in `observation.cjs`, `require`d by `browser-worker.cjs`. It is the single copy of the 12 checks.
- Fixed worker action `SESSION_READINESS`. It does GET `/api/readiness` then GET `/api/me` and returns `{runId, phase, sequence, sessionFingerprint, readinessDigest, ownerDigest, checkedAtMonotonicMs}`. The digests are SHA-256 of the exact response bytes; no body content leaves the worker.
- The controller mints a nominal `WorkerGateHandle` of kind `readiness` or `owner`, bound to the BrowserSession, phase and sequence.
- `verifyGate(kind, handle)` accepts only such a handle for the current session and phase, once per phase.
- The ROBO `OBSERVE_VIEW` runs its 7 deeper routes only after both gates are set.
- The worker's view result drops the constant `fresh`, `source`, `brokerError` and `noError`:
  - `noError` becomes the measured alert/status DOM check.
  - `source` and `brokerError` are derived from the validated PAPER-health body.
  - `fresh` is removed, and the public output stops claiming freshness.
- Observation results carry phase and sequence and are single-use. Post-restart continuity includes the owner digest. The maintenance trust comes from the session's private release trust context.

**Findings addressed:** T13 I-4, I-5, I-9. Minors folded: T13 m-3, m-4, m-9.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - Worker-level readiness negatives. Each gives `READINESS_FAILED` through the worker:
    - each of the 12 checks not `pass`
    - each automation flag wrong
    - `contractVersion: 1`
    - a wrong profile
    - `runtimeReady: false`
    - `maintenanceReady: false`
    - HTTP 503

    Reviewer mutant M1 must die.
  - `readiness_proof_cannot_be_minted_from_literal_or_clone` (D5)
  - `deeper_routes_admitted_only_after_worker_gate_handles`: denied before; admitted after; denied for a foreign session, phase or reused handle.
  - `robo_requires_worker_readiness` (M12)
  - `worker_result_has_no_constant_freshness_claims`: the worker source contains none of `fresh:true`, `source:'alpaca-paper'`, `brokerError:false`, `noError:true`.
  - `observation_results_single_use_and_phase_bound`
  - `post_restart_continuity_checks_owner`
  - `maintenance_trust_bound_to_session_release_trust`
  - `tests/guest/observation_test.cjs` and `tests/guest/session_test.cjs` drive the real modules. Ports supply fixture identity only, and the tests stay gated.

- [ ] **Step 2: Run RED.** NODE-ONE(observation.test.cjs), NODE-ONE(browser.test.cjs).

- [ ] **Step 3: Implement** per the interfaces and C9 (`SESSION_READINESS`).

- [ ] **Step 4: Confirm GREEN and run BROAD.** Mutations that must be killed: M1, M12, D5, and "`verifyGate` returns true".

- [ ] **Step 5: Commit** `fix(acceptance): derive readiness and owner gates from worker observations`.

### Task 18: Whole-M4 offline review, full verification and record

**Depends on:** Tasks 1–17, each reviewed and accepted. Task 6 also needs the owner's acceptance.

**Files:**
- Create: `.superpowers/sdd/2026-09-30-production-acceptance-controller/stage1-remediation/report.md`
- Modify: `.superpowers/sdd/2026-09-30-production-acceptance-controller/stage1-reviews/REVIEW_LEDGER.md`: append a "Remediation dispositions" section only.

**Interfaces:**
- Consumes: every task commit and its evidence.
- Produces: the disposition record.

**Findings addressed:** none new. This task verifies all 47.

**Steps:**

- [ ] **Step 1: Exact-tree checks.**
  - Branch, HEAD and a clean index.
  - The changed paths since `6a82e08` are within the union of the Files lists above.
  - These hashes are unchanged:
    - design `61fb4ab7…73a6`
    - original plan `3a194c81…4eaa`
    - amendment `72075bae…92bc`
    - decisions doc (the value recorded in Task 1)
    - event reference `a2e1be57…be7d`
  - `package.json` and `package-lock.json` are unchanged.

- [ ] **Step 2: Fresh full run.**
  - Fresh producers, then focused suites per module, then PY-ALL, NODE-ALL, SWIFT-ALL and all three consumers.
  - Record argv, environment, exit codes, counts and every skip with its reason.
  - The only allowed skips are input-absent skips in ordinary runs, and each of those tests must also run bound in its consumer step.

- [ ] **Step 3: Replay mutations.** Use one scratch export of the final tree per task and replay every task's kill list. Every mutant must be killed.

- [ ] **Step 4: Independent offline reviews.** Two fresh, read-only reviewers on the most capable model, neither of whom implemented anything:
  - **(a) Whole-M4 offline review**, per composition plan Task 11, with the Stage 1 reports as input. It covers original Tasks 8–10, the amendment, and Tasks 1–11 here. It must give dispositions for:
    - each Important finding
    - C1–C6, R1, R4 and R6
    - N5-A, N5-B and N3
    - the composition plan review's R1–R4
    - the Option A known gaps
  - **(b) M5–M7 review** of Tasks 12–17.

  Each gives `ACCEPT`, `ACCEPT_WITH_NOTES` or `REJECT`, with `file:line` findings.

- [ ] **Step 5: Fix accepted in-scope findings** in their owning task, each with its own regression test, a new commit, and a re-review by the same reviewer.

- [ ] **Step 6: Write `report.md`.** It contains:
  - commits, commands and counts
  - a disposition table for all 47 Important findings and every Minor finding
  - the Option A gaps
  - the owner's acceptance of the reopened M2 broker code
  - the C10 native blockers carried to Stage 2
  - the statement: "offline only; nothing pushed"
  - **M4 status: still OPEN** (the real gate is Stage 2)

  Append the dispositions to `REVIEW_LEDGER.md`.

- [ ] **Step 7: Commit and stop.** Commit `docs(acceptance): record Stage 1 remediation and whole-M4 offline review`. Stop. No push and no Stage 2 action.

---

## Traceability appendix

### All 47 Important findings

| Finding | Short title | Task |
|---|---|---|
| T8-01 | Theft probes never attempt cross-role theft | 10 |
| T8-02 | ABI probe accepts any signal; unrealisable cases | 10 |
| T8-03 | `exact_fd_inventory` probe makes no observation | 10 |
| T8-04 | 14 of 19 `/proc` attestation mutants survive | 9 |
| T8-05 | Test doubles accepted as a native kernel port | 9 |
| T8-06 | Outer filter blocks the Chromium sandbox (E1) | 8 |
| T9-1 | `parse_connect` rejects Chromium's `Proxy-Connection` | 5 |
| T9-2 | A per-tunnel event ends the whole run (proxy and broker) | 5 (proxy), 6 (broker) |
| T9-3 | vsock "authentication" is a self-comparison (E3) | 6 |
| T9-4 | Admission-pinning test passes with admission deleted | 5 |
| T9-5 | Serving-loop 4096-byte header limit unbound | 5 |
| T10-1 | Cross-clock freshness; no host challenge (E2) | 3 |
| T10-2 | Every `ipv6_route` row rejected | 4 |
| T10-3 | Plan-named negative tests absent; 7 mutants survive | 4 |
| T10-4 | Legacy IP probes at documentation addresses | 4 |
| T10-5 | N5-A (closed at HEAD; gate restriction and regression) | 4 |
| T10-6 | N5-B (closed at HEAD; gate-level regression) | 4 |
| T10-7 | 1 ms legacy capture bound | 3 |
| T10-8 | Guest topology test is all doubles | 4 |
| CA-I1 | Shared 60 s window armed by routine probe cleanup (E7) | 2 |
| CB-I1 | Same as CA-I1, plus the activation-deadline coupling (E7) | 2 |
| CB-I2 | No cross-process proxy authority (E4) | 7 |
| CB-I3 | Event literals and audit-loss semantics unbound | 11 |
| CB-I4 | Transition validator: no pinned exec; stuck CLONE; EXIT unreachable | 11 |
| CB-I5 | Late acquisition racing cleanup never stopped | 2 |
| CB-I6 | Worker launch latch and fence correlation unbound | 11 |
| CB-I7 | Proxy substitution and completeness checks unbound | 7 |
| T11-I1 | Credential reachable through exceptions | 12 |
| T11-I2 | Privacy and terminal tests cannot fail | 12 |
| T11-I3 | Host and guest credential formats incompatible (E6) | 12 |
| T12-I1 | Failure-outcome gates unbound | 13 |
| T12-I2 | P-phase traffic denied | 13 |
| T12-I3 | `SAFE_SIGN_OUT` cannot be admitted; no outcome | 13 |
| T12-I4 | `validState` accepts inconsistent states; no initial constructor | 13 |
| T18-I1 | One caller manages every role's storage (E5) | 14 |
| T18-I2 | Storage model contradicts role layout (E5) | 14 |
| T18-I3 | Deletion-scope test vacuous | 14 |
| T13 I-1 | First navigation `/` denied | 15 |
| T13 I-2 | `Authorization` header dropped, request continued | 15 |
| T13 I-3 | Document and post-READY asset bytes unvalidated | 15 |
| T13 I-4 | Readiness unbound; proof mintable from a literal | 17 |
| T13 I-5 | Owner/readiness policy gate has no honest input | 17 |
| T13 I-6 | Descriptor inventory cannot see vsock or `hvc0` | 16 |
| T13 I-7 | Route denials swallowed | 15 |
| T13 I-8 | Duck-typed port and session accepted | 16 |
| T13 I-9 | `fresh`/`source`/`brokerError`/`noError` hard-coded | 17 |
| T13 I-10 | 12 checks with no binding test | 16 |

Count: Task 8 group 6, Task 9 group 5, Task 10 group 8, compA 1, compB 7, Task 11 group 3, Task 12 group 4, Task 18 group 3, Tasks 13–15 group 10. Total **47**.

### Minor findings (58)

**Task 8 review**
- T8-07: folded into Task 9.
- T8-08: folded into Task 9.
- T8-09: folded into Task 9.
- T8-10: folded into Task 9.
- T8-11: folded into Task 11.
- T8-12: folded into Task 10.
- T8-13: folded into Task 10.

**Task 9 review**
- T9-6: folded into Task 5.
- T9-7: folded into Task 6.
- T9-8: folded into Task 5.
- T9-9: folded into Task 5.
- T9-10: cases C and M folded into Task 5. **Deferred:** mutants D, E, F, G, K and N are cosmetic, per the reviewer.

**Task 10 review**
- T10-9: folded into Task 4.
- T10-10: folded into Task 3 (the E3 key separation).
- T10-11: **deferred.** Post-browser current-check policy, including verifier→proxy connections and TIME_WAIT rows. Admission runs while BROWSER and VERIFIER are WAITING. Settle it with the unbuilt Tasks 16–17 (verifier).
- T10-12: folded into Task 4.
- T10-13: folded into Task 3.
- T10-14: **deferred.** Cross-checking host device attestation needs the native VZ device-set authority, which does not exist until the native `VMHost` constructor (Stage 2+).
- T10-15: folded into Task 3.

**Composition part A review**
- compA M-1: folded into Task 4.
- compA M-2: folded into Task 4.
- compA M-3: folded into Task 7 (selector `tfds` binding and comment).
- compA M-4: folded into Task 9.
- compA M-5: folded into Task 9 (comment).
- compA M-6: folded into Task 9.
- compA M-7: folded into Task 11.
- compA M-8: folded into Task 10.
- compA D-1: folded into Tasks 1 and 2.
- compA D-2: **deferred.** Boot `audit=1` belongs to the unbuilt native population and host constructor. It is recorded as a native blocker in C10.

**Composition part B review**
- compB M-1: folded into Task 2.
- compB M-2: folded into Task 7.
- compB M-3: folded into Task 2.
- compB M-4: K6 folded into Task 2, K1 into Task 11, P5 into Task 7. **Deferred:** C2, C3, C5 and C9 are documented as redundant checks in the Task 18 record.
- compB M-5: folded into Task 7.
- compB M-6: folded into Task 11.

**Task 11 review**
- T11-M1: folded into Task 12.
- T11-M2: folded into Task 12.
- T11-M3: folded into Task 12.
- T11-M4: folded into Task 12.
- T11-M5: run latch folded into Task 12. **Deferred:** sealing `AdmissionProof`, because it is consumed across Tasks 10, 11 and 22; seal it when Task 22 composes intake.
- T11-M6: folded into Task 12. **Deferred:** the recording-input residual is documented, not fixable offline.
- T11-M7: folded into Task 12.
- T11-M8: folded into Task 12.

**Task 12 review**
- T12-M1: folded into Task 13.
- T12-M2: folded into Task 13.
- T12-M3: folded into Task 13.

**Task 18 review**
- T18-M1: folded into Task 14.
- T18-M2: folded into Task 14.
- T18-M3: folded into Task 14.

**Tasks 13–15 review**
- T13 m-1: folded into Task 16.
- T13 m-2: folded into Task 1 (C9).
- T13 m-3: folded into Task 17.
- T13 m-4: folded into Task 17.
- T13 m-5: folded into Task 16.
- T13 m-6: folded into Task 15.
- T13 m-7: folded into Task 16.
- T13 m-8: folded into Task 15.
- T13 m-9: folded into Task 17.

### Option A known gaps

- **R13 layouts not parsed by the deriver.**
  - iovec, cmsghdr and sockaddr_un are new in Task 10 and get justified `LAYOUT_LITERALS` entries there.
  - The procfs `ipv6_route`/`tcp6` formats get kernel-source-cited fixtures in Task 4.
  - **Deferred:** capset structs, `sock_fprog`, sockaddr_in/in6, LP64 bounds and kernel-behaviour semantics. Each feeds a syscall that rejects malformed input, so each fails closed.
- **`filter_digest` computed from the intended program:** **deferred** to Stage 2, which needs a real kernel (C10).
- **I2 / R17 C3, event literals unbound:** folded into Task 11.
- **Fix-wave remainder, `fields[0]`/`operators[0]`:** folded into Task 11.
- **R17 C4, string ABI values:** `'0A'` folded into Task 4; `'c00000b7'` folded into Task 11.
- **I1, probe catalogue outside every sweep:** folded into Task 10.
- **m2, records do not cite the definitions they reference:** **deferred.** No record is affected, and no fix needs a deriver change.
- **m3, `.cjs` `Seccomp > 0`:** folded into Task 16.
- **m4, ptrace `TRACEME`:** folded into Task 10.
- **Selector limits G01/G02:** **deferred.** A residual of AST-based binding, noted for the whole-M4 review in Task 18.
- **Pre-existing composition flake:** folded into Task 2.

### Review notes carried as Stage 2 blockers (not findings)

- The Task 8 review's note on the `{0..4}` Node FD inventory.
- `CONFIG_PROC_CHILDREN` and `CONFIG_IPC_NS` missing from `kernelFeatures`.
- Fork after threads.

All three are recorded in C10 and the Task 18 report. None changes code here.

## Estimate (rough)

| Task | Days |
|---|---|
| 1 Contract | 0.5 |
| 2 Cleanup budget | 2 |
| 3 Freshness and keys | 2.5 |
| 4 Topology predicates (ABI) | 2.5 |
| 5 Proxy parsing | 2 |
| 6 vsock and broker (M2) | 3 |
| 7 Proxy authority | 3 |
| 8 Per-role seccomp (ABI) | 1.5 |
| 9 Attestation and provenance | 2.5 |
| 10 Probe catalogue (ABI) | 3 |
| 11 Events and transition (ABI) | 3 |
| 12 Credential intake | 2 |
| 13 State machine | 1.5 |
| 14 Storage | 2.5 |
| 15 Browser routing | 2 |
| 16 Browser provenance | 2 |
| 17 Readiness gates | 2 |
| 18 Review and record | 2.5 |
| **Total** | **≈ 40 working days** |

This includes one review round per task. That is roughly 7–8 weeks sequentially, or about 6–7 weeks if Tasks 12 and 13 run alongside the M4 chain. It is above the review summary's "2–4+ weeks". The difference is mainly the four ABI-pipeline passes, the reopened M2 broker, and the cross-process proxy rework. Every figure here is rough.

## Plan self-review

1. **Coverage.** Every one of the 47 Important findings maps to a task in the table above. T9-2 is split between proxy (Task 5) and broker (Task 6).
2. **Interface names are consistent across tasks:**
   - `CleanupBudget.start_terminal`/`routine_call`/`PROBE_FAMILY_STOP_MS`: Task 2, used by Tasks 3 and 9.
   - `derive_channel_key`/`ChannelKeys.derive`: Task 3, used by Task 6.
   - `begin(challenge)`/`host_current(challenge)`/`require_current()`/`TEST_HOST_CHALLENGE`: Task 3, used by Tasks 4, 7 and 9.
   - `vsockKey`/`RunBinding.vsock_key`: Task 6, used by Task 7.
   - `ProxyChildAuthority`/`observe_child_descriptors`: Task 7.
   - `NativeKernelPort`/`OfflineKernelPort`/`OfflineProbeFixtures`: Task 9, used by Tasks 10 and 14.
   - `ROLE_SCOPES`/`admit_role_storage`: Task 14.
   - `isBrowserSession`/`inspectAdoptedRolePort`: Task 16.
   - `readinessPredicate`/`SESSION_READINESS`/`WorkerGateHandle`: Task 17.
3. **Step quality.** Every step names its tests, values, commands and mutants. No step pastes a whole implementation. Algorithms that the signatures and tests do not fix are stated as rules: the dirty-loop, the A/`proc`/B bracket, the transition grammar, the raw-TTY settings.
4. **Decisions reflected.** E1–E7 option A appear as contract clauses C6, C2, C3+C4, C5, C7, C8 and C1, implemented by Tasks 8, 3, 3+6, 7, 14, 12 and 2. The decision-vs-code conflicts are ruled on in R1–R11.

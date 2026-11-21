# Stage 1 review — group compA: bootstrap composition v1, part A

Reviewer: independent (Claude), 2026-11-17. Worktree `/Users/Matt/day-trader-worktrees/production-acceptance-stage1-fixes`, HEAD `132b67e`, read-only. All execution happened in a copy (`git archive HEAD`) under `tmp/reviews/compA/`.

## 1. Verdict

**REJECT** (Task 5 only). Tasks 1–4 are acceptable with notes. N5-A and N5-B are closed at the gate boundary. No path lets a caller-assembled inventory or an unproved probe qualify. But Task 5's routine probe-family cleanup arms the shared composition cleanup end at the first successful probe, not at the first terminal cleanup. Any terminal cleanup more than 60 s later therefore has zero budget. This is shown at HEAD.

## 2. Scope reviewed

| Commit | Kind | Plan task (2026-10-03-bootstrap-composition-v1.md) |
|---|---|---|
| `fcfc31e`, `90a2fcd`, `7d50824` | docs | Amendment and plan (judged as spec). The amendment and plan are unchanged from `7d50824` to HEAD. |
| `f014d41` | code | Task 1: capture and observation cleanup ownership (N5-A/N5-B) |
| `d17f178` | code | Task 1 follow-up: freeze the budget at the first latch; key settlement by token |
| `a1670ae` | docs, test, JSON | Task 2: event-source reference. Per-record values are skipped (Option A). The README, the semantic records and the test structure are reviewed. |
| `f9178cf`, `53741f0` | code | Task 3: v2 appliance schema, `browserWorker`, executable members, population and inventory types |
| `ab1b6c2`, `9553104` | code | Task 4: Swift v2 manifest, inventory consumer, `qualify(manifest:inventory:)`, `validateRoleRuntimeV1`, the selector-inode fix |
| `d6388b2`, `7559e9c` | code | Task 5: `CompositionBinding`, IPv4/IPv6 descendant probes, `ReceiverAuthority`/`ReceiverBinding`, `qualify_probe_epoch`/`CompletedProbeEpoch` |

Also read: amendment §§1–11, plan Global Constraints and Tasks 1–5, the M4 disposition, the Option A report, and the HEAD consumers in `topology.py` (`BootstrapComposition.begin`/`stop_owned`) and `VMHost.swift`, for the HEAD-presence checks.

The Task 1 gate code (`TopologyGate`, `_NativeCaptureOwner`, `NativeTopologyBindings._read`/`cleanup_unresolved`/`capture`) is unchanged from `d17f178` to HEAD. `confinement_probe.py` is unchanged from `7559e9c` to HEAD. `assemble.py` and `VMConfiguration.swift` are unchanged after `53741f0`/`ab1b6c2`. `validateRoleRuntimeV1` is unchanged after `9553104`. `validateRolesV2` was changed later by `284f946` (see §7).

## 3. Findings

| ID | Sev | File:line at HEAD | At HEAD | Evidence | Suggested fix |
|---|---|---|---|---|---|
| I-1 | **Important** | `tests/guest/confinement_probe.py:776` (`self.cleanup_budget.call(family.stop_owned)` after every successful probe) and `:694` (scope loop `cleanup_budget.remaining()`). Consumer: `guest/topology.py:2680` passes the composition's single `cleanup_budget`. | yes | `CleanupBudget.remaining()`/`call()` allocate `deadline = now+60000` on first use (`topology.py:~66`). Task 5 calls them for routine, non-terminal family stops. The shared end is therefore armed at the first successful probe. Amendment §5 and plan Global Constraints say: "At **first terminal cleanup**, allocate one absolute … end". **Probe 1** (`probes/review_budget_test.py`): after a fully successful epoch, `deadline=60100` is already set. After +60001 ms, `budget.call(...)` raises `CLEANUP_UNCERTAIN` without invoking the operation. **Probe 2** (`probes/review_budget2_test.py`): actual composition `begin()` gives ADMITTED with `deadline=60010` already armed. `stop_owned(60000)` returns `STOPPED` at +0 ms and `TIMEOUT` at +60001 ms of normal admitted operation. **Causality** (`edits/b1_probe_no_shared_arm.diff`): guarding only the two probe sites leaves the budget unarmed through `begin()`, and stop at +60001 ms returns `STOPPED`. Three existing tests encode the non-conforming behaviour and fail under that guard: `test_v1_expired_cleanup_end_forbids_the_next_probe_family`, `test_v1_expired_shared_budget_keeps_original_owner_and_no_retry`, and `test_v1_stop_clamps_to_caller_and_never_widens_shared_budget` (which asserts `deadline` is armed after `begin()`). **Consequences:** (a) every real run longer than 60 s ends with TIMEOUT cleanup, and roles, proxy and event owners are never asked to stop. (b) The 91-family catalogue must finish within 60 s of the first family stop, or `PROBE_CLEANUP_DEADLINE` blocks qualification. This fails closed and is not a false qualification, but the required cleanup behaviour is missing. | Bound routine per-family stops with the existing fixed per-step waits, without arming the shared end. Use the shared end only once a terminal failure has armed it (the `deadline is not None` guard pattern already used in `current()`). Replace the three tests with ones asserting the shared end is still unarmed after a successful `begin()`, and that terminal cleanup gets a full 60 s window from the first terminal event. |
| M-1 | Minor | `guest/topology.py:2131` (`raise CleanupFailure(owner) from primary`) | yes | N5-B's `_read` change is not independently bound. Mutation M1 restores the baseline (`primary = TopologyError('OBSERVATION_DENIED')`) and survives `topology_test` (68/68) and `bootstrap_composition_test` (44/44). The gate still exports the owner, because `_NativeCaptureOwner.stop_owned` re-raises `CleanupFailure(owners[0])` from `_unresolved`. Gate-level N5-B behaviour is correct, by two redundant paths. | Add an adapter-level assertion that `bindings.capture()` / `_read` raises `CleanupFailure` whose `.cleanup is owner` and whose `__cause__` is the primary. |
| M-2 | Minor | `guest/topology.py:1724` (`return proof`) to `:1742` (finally pop) | yes | A drift landing between the final drift check and the `finally` pop finds the capture still pending, so it skips the capture owner. The success path never re-drives that stop. The snapshot cleanup stops the roles, but `cleanup_uncertain` stays `True` (capture owner unretired) until another gate call. Reproduced with `sys.settrace` (`probes/review_race_test.py`): admit gives `TOPOLOGY_DRIFT`, stops=4, `cleanup_uncertain=True`. A later `admit()` clears it. This is conservative and fail-closed, but the report is stale. | After popping on the success path, re-latch or re-run `_cleanup()` if `self._failed`. |
| M-3 | Minor | `host/.../VMHost.swift:399–410` (`9553104`) | yes | Selector rows (`PROXY_STOP_SELECTOR`/`PROXY_CONNECT_SELECTOR`) may share `device:inode`, which is correct for epoll anon inodes. But that makes their identity reduce to the fd number plus a self-assigned `ownerId`, which amendment §4.1 calls insufficient ("not merely a matching fd integer"). A substituted epoll instance at the same fd cannot be detected, and the comment claims more than the code delivers. The semantic was justified by `fs/eventpoll.c` and `fs/anon_inodes.c` (hashes cited in the test; I re-verified them against the retained archive). Those files are outside the Task 2 finite read allowlist and have no reviewed reference record. Not run (Swift). | Record selector provenance as an explicit native limitation, or bind it with fdinfo (`tfd:` set). Add the two members to a reviewed reference derivation, or remove the citation. |
| M-4 | Minor | `host/.../VMHost.swift:110` (struct). Used at `:958`. | yes | `BootstrapExecutableAuthority` keeps the implicit internal memberwise init. So "qualify requires the nominal `InstalledExecutableInventory`" holds only by convention, and HEAD already builds one directly from offline pins at `:958` (`manifestIdentity:nil`). No current consumer accepts a non-nil identity, so there is no qualification today. | Give it a private init. Mint only through `qualify` / `offlineLiteral` (or a named offline factory). |
| M-5 | Minor | `host/.../VMConfiguration.swift:232–258` | yes | Native `InstalledExecutableInventory.pins(manifest:)` has no constructor and is never executed by any test. Its checks (assemblyMode, base, installed `checkSafe`) are untested Swift. The Python analogue is exercised through the private tokens. | When a reviewed adapter lands, require tests that execute `pins`. Until then, state in the code comment that it is unexercised. |
| M-6 | Minor | `appliance/assemble.py:482` | yes | Mutation A7 removes the archive-member exec-bit requirement (`not entry.mode & 0o111`) and survives all 55 `appliance_test` tests (`edits/a7_no_exec_bit.diff`). The `0o7022` part is already enforced earlier by `_archive`. | Add a fixture with a `0o644` `bin/node` member that expects `ARCHIVE_UNSAFE`. |
| M-7 | Minor | `appliance/README.md:149` (`f9178cf`) | yes | States the `referenceDigest` file is "the complete **independently approved** Task2 reference file". No Task 2 review record survives. The disposition lists `semantic-coverage-verification.json` as lost, and Option A excludes kernel-behaviour semantics, so the eight semantic records' approval cannot be verified. | Reword to "committed Task 2 reference; original review record lost; semantic records pending re-review". |
| M-8 | Minor | `tests/guest/confinement_probe.py:265`, `:598` | yes | For exec-helper positions, "attempted" and "denied" rest only on the pinned sample's self-reported FD4 marker and exit code 23. The IP families have no audit correlation, and the closure hardcodes `attempted=True`. A sample that writes `ATTEMPTED\n` and exits 23 without attempting yields DENIED. The receiver after-count proves only non-delivery. This is the accepted Task 8 vsock pattern and is within the trust model (pinned fixture bytes), but it is not "perform and prove the attempt" by independent observation. No path turns a missing or failed probe into success; I checked this with mutations M5–M8. | Record it as a residual fixture-trust assumption, or add seccomp/audit correlation for IP helper attempts before Stage 2 relies on probe evidence. |
| D-1 | Minor (spec) | `docs/BOOTSTRAP_COMPOSITION_V1_AMENDMENT.md:116–118`, plan :20 | yes | The amendment says both "At first terminal cleanup, allocate one absolute … end" and "Every capture, probe, role … cleanup uses that end". It never says what bounds non-terminal per-family probe stops. This ambiguity produced I-1. | Add one sentence: routine (non-terminal) probe-family stops use fixed bounded waits and never allocate the shared end. |
| D-2 | Minor (spec) | Amendment `:152`; `host/.../VMConfiguration.swift:193` | yes | §7 requires boot `audit=1`. No plan task owns the boot command line, and `inspect` enforces `console=hvc0 root=/dev/vda ro` for v2 too. This fails closed today (audit would report disabled), and the README lists it as a separate gate. | Assign it to the host/native population task, or note it as an explicit native blocker in the amendment. |

Counts: Critical 0 · Important 1 · Minor 10.

## 4. Plan-required items

**Task 1 (`f014d41`, `d17f178`)**
- `NativeTopologyBindings.capture_owner` is retained before any read or collect, has `stop_owned`, and is registered in `gate._owners` at construction. **Present/correct.** `test_v1_capture_owner_precedes_first_observation_acquisition`; mutations M2 and M3 are killed.
- N5-A, pending capture visible to concurrent drift/admit/require_current/status, including before capture returns. **Present/correct.** `test_v1_capture_pending_cleanup_is_visible_before_snapshot` (both STOPPED and TIMEOUT; collection in `unresolved_cleanup`; sticky). While capture is still inside `start_roles`, `unresolved_cleanup` is empty and only `cleanup_uncertain` reports it (acceptable).
- N5-B, ordinary close exception gives `CleanupFailure(owner)` and keeps the prior chain; no overlapped cleanup; no integer-FD retry. **Behaviour present/correct.** `test_v1_ordinary_observation_close_failure_exports_original_owner`. **Binding partial** (M-1).
- Shared budget frozen at the first terminal latch, not renewed at settlement. **Present/correct.** `test_v1_first_terminal_latch_freezes_budget_before_capture_settles`.
- Settlement keyed per reservation token. **Present/correct.** `test_v1_prior_current_settlement_cannot_clear_later_capture`.
- PROVEN only after settlement and receipts. **Correct.** Gate `_cleanup_failed` is sticky, and the capture owner refuses to stop while active.

**Task 2 (`a1670ae`)**
- The six named tests are present, and 9/9 pass at the HEAD copy. All 8 semantic IDs are present, with 4 UNAVAILABLE (`AUDIT_RULE_ENUMERATION`, `AUDIT_DELIVERY`, `ROUTE_DELIVERY`, `COMBINED_EFFECT_FENCE`). All evidence paths are within the plan's finite allowlist (checked). The reference file hash `a2e1be57…` is stable from `a1670ae` to HEAD and pinned as an enum in the v2 schema. **Present.** The approval claim is covered in M-7.

**Task 3 (`f9178cf`, `53741f0`)**
- The 7 named tests are present and pass (55/55). **Present.**
- Exact seven-row mapping, payload 9 / artifacts ≤20, strict complement, `browserWorker` direct and non-archive, known-secret screening, version discriminator 1|2 only, legacy v1 preserved, `validate_inputs`/`require_qualified` require v2. **Correct.** Mutations A1 and A3 are killed.
- Member hash comes from the retained member bytes, not the archive digest. Retained `_RetainedSource` handles are rechecked before and after. Population and base binding, `0o7022` rejection, and policy/provenance drift rejection. **Correct.** A2 is killed. A4 and A5 survive only because they are redundant with later rechecks.
- Synthetic → `OfflineInstalledExecutableInventory` (`UNPERFORMED`). Native needs a `NativePopulationOwner`, which has no factory. **Correct.** The exported sidecars I inspected are all `UNPERFORMED`.
- Exec-bit requirement. **Present but unbound** (M-6).

**Task 4 (`ab1b6c2`, `9553104`)**
- The 7 named Swift tests are present (not run by me; the recorded run is 181/181 at `0f87065`, and HEAD differs only in a Python test file and docs).
- Getter-based `BootstrapExecutableInspector` removed. `qualify(manifest:inventory:InstalledExecutableInventory)` is the only qualifying constructor, and the inventory type has no constructor. **Correct.** A structurally equal or caller-assembled inventory cannot qualify. `requireNative(Any)` rejects fakes and offline values.
- `validateRoleRuntimeV1`: exact inherited 0..4, sorted/unique/complete current FDs ≤55, exact row keys and primitives, PROXY-only extra kinds with caps, no `RUNTIME_INTERNAL`, original-row equality. **Present/correct** as a pure comparison. Selector relaxation: M-3. Nominal init gap: M-4.

**Task 5 (`d6388b2`, `7559e9c`)**
- The 5 named tests are present and pass (44/44 composition, 78/78 confinement).
- `CompositionBinding` lives in `confinement.py` and is shared through the topology module instance. Epoch is a positive safe int (fixed in `7559e9c`; the wire matches the Swift `integer(binding["epoch"])`). **Correct.**
- Eight positions × 2 families, exact sample IDs and paths, ports 443/53/UDP 443/vsock 2:4050. **Correct.**
- Receiver before/after, nonce, sequence, health and terminal; child counters ignored; denied=0, positive=1. **Correct.** Echo and boolean mutations are covered by tests.
- Family exit and empty-scope removal precede the next family and the AFTER observation. **Correct.** M8 is killed. M7 survives only because the check is redundant with `run_confined` raising.
- Setup errno cannot count as a denial. Missing samples or receivers make the gate unavailable. **Correct.** M5 and M6 are killed.
- Probe cleanup uses the original budget. **Present, incorrect timing** (I-1).

**Docs as spec.** Amendment and plan are internally consistent apart from D-1 and D-2. They are consistent with the unchanged original design: the design and plan SHA-256 values `61fb4ab7…` and `3a194c81…` were verified at `18ea876`, `7559e9c` and HEAD. No document claims Task 10 or M4 acceptance or native qualification. Status strings in the code (`UNPERFORMED`, `SYNTHETIC_ONLY`, `qualificationUnavailable`, `RECEIVER_FIXTURES_UNAVAILABLE`, `NATIVE_*_UNAVAILABLE`) do not claim native qualification. `populationState:'VERIFIED'` is reachable only through `NativePopulationOwner`, which has no factory; tests use private tokens over inert files, which the README documents. The one over-claim is M-7.

## 5. Checks run

All runs were in `tmp/reviews/compA/base` (`git archive 132b67e`), with the interpreter and `TMPDIR` from the brief. Logs are in `tmp/reviews/compA/logs/`. Scripts are in `tmp/reviews/compA/scripts/` (`mutate.sh`, `runpy.sh`, `edits/*`, `probes/*`). The bulky mutant tree copies were deleted after recording results; every one can be rebuilt from `edits/`.

- **Baseline (HEAD copy):** `topology_test` 68 OK · `bootstrap_composition_test` 44 OK · `appliance_test` 55 OK · `confinement_test` 78 OK · `bootstrap_reference_test` 9 OK. Only `termios` noise appeared.
- **Topology mutations:** M1 (revert N5-B `_read` typing) **survives** (topology 68/68, composition 44/44). M2 (drop pending captures from `cleanup_uncertain`) is killed by 2 tests. M3 (do not skip a pending capture in `_cleanup`) is killed by 3 tests.
- **Probe mutations:** M5 (setup errno re-raised as denial) is killed by 8 subtests. M6 (marker check removed) is killed by 1. M7 (`owner.proven` check removed) survives, as a redundant guard. M8 (AFTER observed before the family runs) is killed by more than 40 subtests.
- **Appliance mutations:** A1, A2 and A3 are killed. A4 and A5 survive (redundant rechecks). A6 and A7 (exec-bit) **survive** (M-6).
- **Behaviour probes:** `review_race_test.py` (M-2). `review_budget_test.py` and `review_budget2_test.py` (I-1, unmodified HEAD). `review_budget3_test.py` locates the first arming stack: `confinement_probe.py:776` → `topology.py:81` at HEAD, and nothing after the causality guard. `b1_probe_no_shared_arm.diff` is the causality check.
- **Kernel source:** extracted `fs/eventpoll.c` and `fs/anon_inodes.c` from the retained `linux-6.8.tar.xz` into the session scratchpad. SHA-256 values match the `9553104` citation (`c8b2fed9…`, `77dda97c…`). Lines 2055–2056 and 96–106 support the shared anon inode.
- **Other checks:** reference evidence paths against the plan allowlist (all inside). Reference file hash at `a1670ae`, `7559e9c` and HEAD (stable). Exported `executable-members.json` sidecars (all `UNPERFORMED`).
- No Swift, network, VM, browser, signing or install action was taken. The worktree, index, HEAD and branches were untouched.

## 6. Declined to judge

- **Swift behaviour and mutations for Task 4.** The brief forbids running Swift. I relied on source reading and the recorded 181/181 result at `0f87065`.
- **Whether the Oct 3 RED/GREEN evidence and per-task reviews happened.** That evidence lived in the deleted `/private/tmp/day-trader-standin-exit`.
- **Whether the tests replay the original N5-A/N5-B witness arrangements exactly.** The N3/N5 review report is lost. I judged against the amendment §5 text instead.
- **Per-record numeric and layout values in `bootstrap-event-reference.json`.** Out of scope; Option A covered them.
- **The correctness of the eight semantic claims against kernel source**, beyond checking that their paths are inside the allowlist. Not re-derived here; this is flagged under M-7.
- **Owner approval of the amendment's "owner-approved additive offline scope" status.** No record is available.

## 7. Notes for the whole-M4 review

1. **I-1 crosses Tasks 5 and 9.** `BootstrapComposition` passes one `CleanupBudget` to probes, roles, event install and terminal stop (`topology.py:2446`, `:2680`, `:2537`). Fixing Task 5 needs Task 9 tests that assert the end is unarmed after a successful `begin()`. Also check whether Task 7's proxy or Task 8's event owners call `remaining()`/`call()` on that budget during normal operation, which would cause the same early arming.
2. **Later reversal of Task 4's v2 role semantics.** `284f946` changed `validateRolesV2` to run the all-waiting legacy predicate on every legacy row ("original launch attestation"). `ab1b6c2` had exempted CONTROLLER/PROXY. Confirm this reading against amendment §4.1 ("does not run the all-waiting legacy predicate on active roles"), and confirm the guest emits matching rows.
3. **Self-referential originals in the offline host composition.** At HEAD, `OfflineVMHost.composeBootstrapV1` calls `validateRoleRuntimeV1(retainedRuntime, originals: retainedRuntime, …)` (`VMHost.swift:1060`), and the stored `originalRoleRuntime` is caller-supplied. That is acceptable only because every operational `bootstrapCheck` throws. The Task 10 review should confirm that no offline `BootstrapQualification` can reach an operational consumer, and should note that `offlineLiteral`, plus a direct memberwise construction, is used in non-test source (`:269`, `:958`).
4. **`CompletedProbeEpoch` provenance.** An epoch minted from injected receivers and an inert `NativeProbeFixtures` is type-identical to a native one. Native denial rests entirely on the other gates: no `ReceiverAuthority` factory, and an unavailable host `bootstrapCheck`. Consider an explicit offline/native provenance marker before any native embedding.
5. **The probe module is a production dependency.** `guest/topology.py` imports `tests/guest/confinement_probe.py` as `_PROBES` (`topology.py:~131`). Its 23+ raw syscall numbers and errno sets are outside every ABI sweep (Option A I1). Task 5 added 198/203/64/206/436 and AF_INET/AF_INET6 sockaddr packing. I checked these by hand and they are correct for AArch64, but they are unbound.
6. **Minor polish in Task 5.**
   - `receiver_shape` gives every non-network operation (io_uring, SCM_RIGHTS and similar) a VSOCK CID2:4050 receiver binding.
   - `sampleDigest` is required but unbound for non-sample rows.
   - `ReceiverAuthority.observe` clears `_active` outside its lock.
   - The child maps every `RuntimeGateUnavailable` to the code `HELPER_SAMPLE_UNAVAILABLE`.
   - `fork.*` treats EACCES as a failure while `parent.*` treats it as a denial. That is strict, but inconsistent.
7. **Pre-existing:** in `_read`, `raise error from primary` (close raising `CleanupFailure`) overwrites any existing `__cause__` of that error. Typed sub-chains survive only through `__context__`.

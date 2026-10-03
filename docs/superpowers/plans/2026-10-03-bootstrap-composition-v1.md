# Bootstrap Composition v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete one offline-testable trusted bootstrap composition joining accepted appliance, role and proxy ownership to Task10, including the remaining typed cleanup defects.

**Architecture:** Python retains original role/probe/event owners; the existing private controller channel binds those owners to nominal JS role ports and one-use launch grants. The actual proxy serving loop supplies runtime authority, and the host independently checks versioned composition and executable provenance. Operational constructors remain closed without separately established native, population, signing and runtime prerequisites.

**Tech Stack:** Existing Python3.12 standard library/unittest, Node24.21.0 CommonJS/node:test, Swift6.4/Foundation/CryptoKit/Virtualization and built-in Swift Testing; retained Linux6.8/AArch64 references. No new dependency, compiler installation, generic RPC or framework.

**Spec:** [Bootstrap Composition v1 amendment](../../BOOTSTRAP_COMPOSITION_V1_AMENDMENT.md), additive to the unchanged [approved design](../../PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md) and [original plan](2026-09-30-production-acceptance-controller.md). Read all three and the controlling reviews before execution. Baseline is `18ea8763739034e9155720c0f7f74265b0c402f2` on `codex/production-acceptance-m1`; documentation commits after that baseline do not alter the implementation starting point.

## Global Constraints

- One `BootstrapComposition` owns the run from first acquisition through terminal cleanup.
- No role UID, untrusted-role syscall allowance or inherited role FD inventory is relaxed.
- Wall and monotonic values in this amendment are integer milliseconds; a monotonic value crosses only processes in the same guest boot, never host/guest clock domains.
- At first terminal cleanup, allocate one absolute monotonic end at `start+60000ms`, additionally capped by an independent real monotonic end.
- No six general frameworks, plugin registration, dynamic adapter discovery, arbitrary RPC, dependency installation, downloads, owned-fixture provisioning, native kernel/socket/listener/receiver execution, VM/image construction, signing/entitlement setup, browser/runtime qualification, production/credentials, M5 behavior, trading, remote Git/deploy, Docker/CodeLift, host settings or network changes.
- Do not create `browser-worker.cjs`, `browser.cjs`, a package manifest/lockfile, browser dependency, UI action or session code in this work package.
- Keep approved design/original plan, baseline evidence, accepted reference bundle and all previous failed logs byte-identical. Append fresh task evidence under a unique new directory; never overwrite historical evidence.
- Untrusted-role sockets remain protocol0 only; no seccomp exception for the new bootstrap event descriptors. No secret/console/vsock descriptor donor, arbitrary PID/FD cleanup or raw private output.
- Synthetic member/receiver/launch/event results cannot mint native qualification. Missing fixtures/population/worker/signing/runtime stay explicit blockers. No product executable is run, including CLI smoke or `swift run`.
- Source tasks proceed only after this plan's review and the existing explicit owner authorization are confirmed by the coordinator. This authoring turn creates and commits the two documents only. Operational execution is separately gated.

## Review Focus

- Capture fails before returning a snapshot while cleanup is still pending: concurrent status/admit must export original typed uncertainty (Task1).
- A correct-looking child/pipe/grant crosses a language boundary after cancellation or expiry: zero launch effects and cleanup of the original owner (Task6).
- Probe helper exits but receiver observation belongs to another endpoint, family or epoch: no completed probe proof and no persistent role start (Task5/9).
- A service appears and disappears between snapshots, or event records overflow/die during the launch barrier: terminal failure, never renewed admission (Task8/9).
- Correct archive hashes mask wrong worker bytes, a wrong install path, or synthetic population presented as native: inventory/admission rejection in both runtimes (Task3/4/10).

---

## Execution shape, files and review gates

Run Tasks1→2→3→4→5→6→7→8→9→10→11 sequentially. Their internal dependency graph is: cleanup ownership(1); fixed reference derivation(2); producer schema/inventory(3←2); host consumer(4←3); probes/receivers(5←1,3); original role→JS activation(6←1,3); proxy loop authority(7←1,3); event owner(8←1,2,3); guest composition(9←5,6,7,8); host composition(10←4,9); final verification/review(11←all). These are slices of one composition, not independently reusable services.

Existing ownership remains: `confinement.py` owns original children, `role-ports.cjs` nominal JS handoffs/grants, `confinement_probe.py` fixed attempts/receiver correlations, `proxy.py` its actual serving runtime, `topology.py` composition/capture/events, `VMConfiguration.swift` manifest/inventory integrity, `VMHost.swift` host admission/lifecycle. Keep new behavior there; do not add six framework modules. New tracked files are limited to the finite reference document/test and two composition test files named below. No test fixture binary is acquired or constructed.

Every task follows behavior RED→minimum source→focused GREEN→relevant broader verification→local commit→independent review of that exact commit. An implementer never self-approves changes to accepted contracts. Reviewers read baseline accepted contract, this amendment, actual diff, tests and retained RED/GREEN; compare exact source hashes. A local commit is a review candidate, not permission to bypass a failing review. Repair in the owning slice with a new behavioral regression and a scoped follow-up commit; re-review before the next dependent task. No material finding may be waived at a review cap. The coordinator owns independent reviewers; this document-writing task spawns none.

All `Files` paths below are repository-relative. `Test:` identifies files also modified/created by that task. Scope is at most five files per task; any additional necessary accepted surface is declared to the coordinator before changing it. Preserve unrelated work. No original evidence file or accepted source is rewritten merely to simplify a test.

## Exact offline commands and evidence discipline

Run from `/private/tmp/day-trader-standin-exit`. Use installed absolute tools:

```sh
BC_NODE=/Users/Matt/day-trader-toolchains/node-v24.21.0-darwin-arm64/bin/node
BC_PY=/Library/Frameworks/Python.framework/Versions/3.12/bin/python3
BC_SWIFT=/Library/Developer/CommandLineTools/usr/bin/swift
BC_ROOT=/private/tmp/day-trader-standin-exit
BC_EVIDENCE=$(mktemp -d "$BC_ROOT/.superpowers/sdd/2026-09-30-production-acceptance-controller/bootstrap-v1-XXXXXXXX")
BC_TMP=$(mktemp -d /private/tmp/bootstrap-v1-tests.XXXXXXXX)
```

Before each task/compile batch record `git status --short`, `git rev-parse HEAD`, source hashes and `df -k "$BC_ROOT" "$BC_TMP"`. Require estimated remaining growth plus2147483648 free bytes. Inspect every command exit/result. Logs use unique task/attempt filenames; preserve failures/setup failures separately. Set `TMPDIR="$BC_TMP"` (physical nonsymlink path) and `PYTHONDONTWRITEBYTECODE=1`. Unset inherited `TASK10_TOPOLOGY_INPUT`, `TASK10_TOPOLOGY_OUTPUT`, `M3_APPLIANCE_INPUT`, `M3_APPLIANCE_OUTPUT`, `RECEIPT_EXCHANGE`, `RECEIPT_NODE_INPUT`, `RECEIPT_SWIFT_INPUT`, `CONTRACT_EXCHANGE`, `TASK4_FIXTURE_EVIDENCE` before ordinary focused commands. Supply named exchanges only for the explicit fresh producer/consumer steps below.

The following shorthand means literal commands with that sanitized environment; it is not a new runner/dependency:

| Label | Exact command |
| --- | --- |
| PY-ONE(file) | `"$BC_PY" -B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p <file> -v` |
| PY-TOPOLOGY | `"$BC_PY" -B -m unittest tooling/production-acceptance/tests/unit/topology_test.py tooling/production-acceptance/tests/guest/topology_test.py -v` |
| PY-ALL | `"$BC_PY" -B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p '*_test.py' -v` |
| NODE-ONE(file) | `"$BC_NODE" --test tooling/production-acceptance/tests/unit/<file>` |
| NODE-ALL | `"$BC_NODE" --test tooling/production-acceptance/tests/unit/*.test.cjs` |

`tests/guest/topology_test.py` above is the existing inert driver test; inspect it before execution and stop if any test selects native effects. Do not discover other guest test files or invoke any native selector. RED must contain the named failing assertion of behavior, not zero discovery, import failure, missing fixture, sandbox setup failure or compiler installation error. Minimal inert export/type scaffold is allowed only to make new behavioral tests runnable; never introduce a permissive security implementation as a scaffold.

Reuse the retained serial Swift cache root `/private/tmp/m4-task10-swift-final.UqQwsS` if present and owned; never delete it. If absent, allocate one new task-owned root with the same subdirectory layout and record why. No parallel Swift builds. A fresh unique producer directory is required for every Swift invocation, while fixture inputs are read-only and separate. The full reviewed invocation is:

```sh
env -u CONTRACT_EXCHANGE -u RECEIPT_SWIFT_INPUT -u TASK4_FIXTURE_EVIDENCE \
  -u M3_APPLIANCE_OUTPUT -u TASK10_TOPOLOGY_OUTPUT \
  DEVELOPER_DIR=/Library/Developer/CommandLineTools TMPDIR="$BC_TMP" \
  CLANG_MODULE_CACHE_PATH=/private/tmp/m4-task10-swift-final.UqQwsS/clang \
  SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/m4-task10-swift-final.UqQwsS/modules \
  XDG_CACHE_HOME=/private/tmp/m4-task10-swift-final.UqQwsS/xdg \
  M3_APPLIANCE_INPUT="$BC_INPUT/appliance/bundle.json" \
  TASK10_TOPOLOGY_INPUT="$BC_INPUT/topology.json" \
  RECEIPT_NODE_INPUT="$BC_INPUT/node/node.json" \
  RECEIPT_EXCHANGE="$BC_SWIFT_OUTPUT" \
  "$BC_SWIFT" test --package-path tooling/production-acceptance/host \
  --scratch-path /private/tmp/m4-task10-swift-final.UqQwsS/build \
  --cache-path /private/tmp/m4-task10-swift-final.UqQwsS/cache \
  --config-path /private/tmp/m4-task10-swift-final.UqQwsS/config \
  --security-path /private/tmp/m4-task10-swift-final.UqQwsS/security \
  --disable-dependency-cache --disable-experimental-prebuilts --disable-prefetching \
  --disable-automatic-resolution --skip-update --disable-netrc --disable-keychain \
  --manifest-cache local -j 1 --disable-xctest --enable-swift-testing \
  -Xswiftc -plugin-path \
  -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing
```

SWIFT-ONE(suite) appends `--filter <suite>`; SWIFT-ALL uses the command unchanged. SwiftPM's sandbox stays enabled, no SDKROOT override or signing. Request only individual command-scoped platform permission if required. Setup denial is not RED. Keep the known skip-update/linker warnings in evidence.

Before each new Swift source verification batch, create `BC_INPUT=$(mktemp -d "$BC_EVIDENCE/inputs-XXXXXXXX")`. In sanitized environments run these producers separately, checking each result; output destinations must not already exist except the root:

```sh
M3_APPLIANCE_OUTPUT="$BC_INPUT/appliance" "$BC_PY" -B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p appliance_test.py -v
TASK10_TOPOLOGY_OUTPUT="$BC_INPUT/topology.json" "$BC_PY" -B -m unittest tooling/production-acceptance/tests/unit/topology_test.py -v
RECEIPT_EXCHANGE="$BC_INPUT/node" "$BC_NODE" --test tooling/production-acceptance/tests/unit/receipts.test.cjs
BC_SWIFT_OUTPUT=$(mktemp -d "$BC_EVIDENCE/swift-output-XXXXXXXX")
```

Task9 adds separate composition-v1 exports next to the legacy topology fixture: `topology.json.bootstrap-v1.json` and its `.invalid.json`; Task3 adds `appliance/executable-members.json`. Swift tests derive these fixed sibling names from the explicit input paths, never from output directories. Record every input hash before/after consumers. After each broad Swift signature-producing run, consume its actual `swift.json` with `RECEIPT_SWIFT_INPUT="$BC_SWIFT_OUTPUT/swift.json" NODE-ONE(receipts.test.cjs)` and no `RECEIPT_EXCHANGE`. This checks fresh bidirectional signatures without changing M1/M3 semantics.

Broad commands run once at the end of each affected slice after final focused GREEN. Repeat only for a source change, failure investigation or unresolved concern, with a distinct log and explanation. The final Task11 set runs against the final tree. An unrelated failure remains a failure; do not rerun until green and discard it.

### Task 1: Publish capture and observation cleanup ownership

**Files:** Modify `tooling/production-acceptance/guest/topology.py`; Test `tooling/production-acceptance/tests/unit/topology_test.py`.

**Interfaces:** Consumes existing `CleanupBudget`, `CleanupFailure`, `TopologyGate`, `NativeTopologyBindings`, `Task8Collection`. Produces `NativeTopologyBindings.capture_owner` (nominal owner retained before any read/collect), with `stop_owned(remaining_ms) -> OwnedStopReceipt`; `CleanupFailure.cleanup` always retains original owner(s), and `gate.cleanup_uncertain` includes unsettled capture ownership.

- [ ] Write `test_v1_capture_pending_cleanup_is_visible_before_snapshot`: use actual gate/native bindings/Task8 collection with inert kernel, fail after collection, block first stop, and assert concurrent drift/admit returns typed cleanup with the original collection and `cleanup_uncertain is True`; release with TIMEOUT and require sticky uncertainty.
- [ ] Write `test_v1_ordinary_observation_close_failure_exports_original_owner`: close raises ordinary `OSError`; first and subsequent gate calls retain that owner through `CleanupFailure`, including a blocked/throwing `cleanup_unresolved`. Assert no integer-FD retry, no overlapped owner stop, and preserve a primary typed cleanup chain.
- [ ] Run PY-TOPOLOGY; retain expected N5-A/N5-B behavioral RED using baseline source. Replay the two review witness arrangements in these tests, not a custom failed-adapter shortcut.
- [ ] Register capture owner and in-flight obligation atomically before `capture`; settle only after all acquisitions/compensation settle. Wrap ordinary uncertain close as typed cleanup. Reuse the one existing budget and preserve accepted N3 atomic preparation/late-settlement logic.
- [ ] Run PY-TOPOLOGY GREEN, then PY-ALL. Require zero failures/skips, truthful pending/proven states and unchanged original N3 regressions.
- [ ] Run `git diff --check`; stage exactly the two Files paths and commit `fix(acceptance): retain capture cleanup authority`. Independent review verifies the actual capture boundary before Task2.

### Task 2: Derive the finite event-source reference extension offline

**Files:** Create `tooling/production-acceptance/appliance/bootstrap-event-reference.json`; Create/Test `tooling/production-acceptance/tests/unit/bootstrap_reference_test.py`; Modify `tooling/production-acceptance/appliance/README.md`.

**Interfaces:** Consumes the exact retained archive/manifest/coverage hashes from amendment section1. Produces one strict reference record `{version:1, sourceArchiveSHA256, parentCoverageSHA256, records}`; each sorted unique record is `{id, memberPath, memberSHA256, firstLine, lastLine, declaration, value, width, signed}`. Structure records use `value` as an exact list of `{name,offset,size,alignment}` rather than a scalar. This finite union is test-validated; record hash becomes version2 policy `referenceDigest`.

- [ ] Write `test_v1_event_reference_matches_retained_archive`, `test_v1_event_constants_have_independent_width_oracles`, `test_v1_event_layouts_match_aarch64_declarations`, `test_v1_event_reference_missing_or_changed_record_denied`. Assert literal fixed source tuple, audit actions/status/lost fields, rule masks, record kinds/EOE, capabilities, rtnetlink groups/messages/attributes, uevent/inotify masks and all consumed syscall/layout dependencies; reject any omission or duplicate.
- [ ] Run PY-ONE(bootstrap_reference_test.py) with a minimal empty record: expected coverage assertions fail. Do not treat an unavailable archive as RED.
- [ ] Derive only required definitions from `include/uapi/linux/{audit,netlink,rtnetlink,if_link,if_addr,inotify,capability}.h`, their referenced UAPI dependencies, native AArch64/generic syscall declarations, and `kernel/audit.c`/`kernel/auditsc.c`. Use bounded local archive reads; no publisher code execution. Record exact member hashes/line declarations and source-based layout/unsigned-expression derivations using existing pinned AAPCS64 rules. No new download or mutation of the frozen bundle.
- [ ] Add README source/privilege/feature/FD explanation and distinguish newly reviewed coverage from the old coverage digest. All record IDs must be precisely the constants/layouts consumed in Task8; unsupported native fork/vfork syscalls are excluded, never invented.
- [ ] Run PY-ONE(bootstrap_reference_test.py) GREEN and PY-ALL. Independent source-value/layout expectations must not import the production constants as their oracle.
- [ ] Diff-check; stage these three paths; commit `docs(acceptance): pin bootstrap event source references`. Obtain independent reference review before any event adapter source consumes these records. Missing source semantics is a stop, not an invitation to research online.

### Task 3: Version2 appliance producer and retained executable members

**Files:** Modify `tooling/production-acceptance/appliance/manifest.schema.json`, `tooling/production-acceptance/appliance/assemble.py`, `tooling/production-acceptance/appliance/README.md`; Test `tooling/production-acceptance/tests/unit/appliance_test.py`.

**Interfaces:** Produces strict version2 manifests and `derive_executable_members(inputs: ApprovedInputs) -> ValidatedExecutableMembers`, plus `verify_installed_members(members, population_owner, base_identity) -> InstalledExecutableInventory`. Synthetic output is `OfflineInstalledExecutableInventory`, a distinct type. Current `validate_inputs`/`assemble` remain offline/synthetic with no native default.

- [ ] Write `test_v1_browser_worker_is_direct_required_payload`, `test_v1_legacy_manifest_inspection_never_admits_composition`, `test_v1_member_hash_is_not_archive_hash`, `test_v1_member_snapshot_substitution_denied`, `test_v1_installed_inventory_requires_population_owner`, `test_v1_worker_probe_archive_alias_denied`, `test_v1_bootstrap_features_and_reference_digest_required`. Assert exact seven-row mapping, payload9/artifacts20 bounds, strict complement, known-secret screening, extra-field/boolean-int/duplicate rejection, and synthetic/native type separation.
- [ ] Run PY-ONE(appliance_test.py) and retain behavioral RED against current payload/provenance behavior.
- [ ] Set trusted descriptor document `schemaVersion:2`; keep its existing six top-level keys plus `legacyInputManifest` and `legacyApplianceManifest`. Preserve frozen v1 rules under those two names and corresponding `legacyIdentity`/`legacyPolicy` definitions; active `inputManifest`/`applianceManifest` require `manifestVersion:2`. Definitions are exactly `identity`, `policy`, `legacyIdentity`, `legacyPolicy`. Strictly decode the bounded version discriminator and select only1 or2; never accept an arbitrary descriptor. `decode_inputs`/`decode_appliance` permit legacy inspection; `validate_inputs`/composition require2. Preserve v1 hashes/canonical bytes in legacy tests.
- [ ] Add direct `browserWorker`, fixed layout, composition policy fields and three kernel features from the amendment. Derive seven member hashes/sizes from retained validated bytes; hold source owners through validation/recheck. `verify_installed_members` validates exact population/base bindings and installed bytes through a trusted original population owner; source must have no bool/JSON shortcut and no native population implementation in this task.
- [ ] Extend fresh test export with `executable-members.json`, containing only synthetic byte-derived inventory and explicit `populationState:UNPERFORMED`. Keep bundle/synthetic file names; update the existing export's exact file-count assertion. No historical fixture rewrite. Missing future worker stays incomplete outside explicitly synthetic fixtures.
- [ ] Run focused GREEN then PY-ALL. Diff-check, stage four paths, commit `feat(acceptance): bind bootstrap worker and executable members`. Independent Task7-contract review covers v1 preservation, v2 strictness and source/population authority distinction.

### Task 4: Strict Swift manifest and executable inventory consumer

**Files:** Modify `tooling/production-acceptance/host/Sources/AcceptanceCore/VMConfiguration.swift`, `tooling/production-acceptance/host/Sources/AcceptanceCore/VMHost.swift`; Test `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/VMConfigurationTests.swift`, `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`.

**Interfaces:** Consumes Task3 v2/legacy descriptors and retained member inventory. Produces `ValidatedExecutableMembers`/`InstalledExecutableInventory`/`OfflineInstalledExecutableInventory` Swift nominal types in VMConfiguration; replaces getter-based qualifier with `BootstrapExecutableAuthority.qualify(manifest:ApplianceManifest, inventory:InstalledExecutableInventory) throws -> BootstrapExecutableAuthority`. Existing `offlineLiteral` remains internal test-only.

- [ ] Write Swift tests `v1_manifest_payload_and_reference_match_python`, `v1_legacy_manifest_cannot_admit_bootstrap`, `v1_worker_direct_mapping_and_member_bytes_required`, `v1_population_and_original_base_owner_required`, `v1_offline_inventory_cannot_mint_native_authority`. Use independently literal paths and separate tiny archive/member bytes; hash equality alone without original population must fail.
- [ ] Generate fresh Task3/legacy topology/Node fixture inputs with commands above; run SWIFT-ONE(VMConfigurationTests) and SWIFT-ONE(BootstrapGateTests). Record expected new behavioral assertion failures, using inert nominal fixture constructors internal to tests where needed.
- [ ] Implement matching strict schema selection/completeness and finite inventory validation, retained artifact/base ownership checks and nominal construction. A structural protocol implementation offering seven hash strings cannot qualify. Preserve M3 read-only shell/no native attachment/signing restrictions. Change any obsolete “no worker identity exists” reason to the actual missing-payload/population prerequisite.
- [ ] Run both focused suites GREEN, then SWIFT-ALL and fresh Swift→Node receipt consumer. Keep failed broad runs visible; broker classification race is outside scope.
- [ ] Diff-check, stage four paths, commit `feat(acceptance): verify bootstrap executable provenance`. Independent host/appliance contract review is required.

### Task 5: Fixed descendant attempts and run-bound receiver proof

**Files:** Modify `tooling/production-acceptance/guest/confinement.py`, `tooling/production-acceptance/tests/guest/confinement_probe.py`; Test `tooling/production-acceptance/tests/unit/confinement_test.py`, `tooling/production-acceptance/tests/guest/confinement_test.py`; Create/Test `tooling/production-acceptance/tests/unit/bootstrap_composition_test.py`.

**Interfaces:** Produces the strict immutable shared `CompositionBinding` in confinement.py; nominal `ReceiverAuthority`, exact `ReceiverBinding`, and `qualify_probe_epoch(binding, fixtures, cleanup_budget) -> CompletedProbeEpoch` in confinement_probe.py. `CompletedProbeEpoch` retains ordered Task8 cases/Task10 projection, fixture digest, original family-exit and empty-scope proofs. It does not own persistent roles. Later Python consumers use this one binding definition through their existing shared confinement module instance.

- [ ] Write `test_v1_ipv4_ipv6_descendant_catalogue_and_pinned_paths`, `test_v1_receiver_endpoint_nonce_epoch_mismatch_denied`, `test_v1_missing_receiver_health_or_terminal_count_denied`, `test_v1_probe_family_exit_and_empty_scope_precede_completion`, `test_v1_probe_cleanup_uses_original_budget`. Assert eight positions/family, exact sample IDs/paths and TCP443; DNS53/UDP443/vsock2:4050 remain finite. Child counters cannot substitute for independently owned before/after observations; denied rows require zero, positive control exactly one.
- [ ] Run PY-ONE(confinement_test.py) and PY-ONE(bootstrap_composition_test.py); retain RED. Guest source is inspected only, not executed.
- [ ] Extend accepted `NativeProbeContext.helper` and finite dispatch for both IP families, independently bound target bytes and attempt marker/exit/audit. Preserve retained-FD exec/empty environment, named kill/WNOHANG, exact roots and helper ownership. No actual helper binary/canary is created; missing supplied pinned samples or receiver authority is explicit runtime unavailable.
- [ ] Run focused GREEN, then PY-ALL. Verify no socket, fork, exec, signal or native receiver operation escaped injected boundaries. Keep original errno/missing-feature-denial tests.
- [ ] Diff-check, stage five paths, commit `feat(acceptance): bind descendant probes to receiver authority`. Independent review covers changed Task8 probe contract and complete family cleanup.

### Task 6: Bind original Task8 owners to nominal JS activation

**Files:** Modify `tooling/production-acceptance/guest/confinement.py`, `tooling/production-acceptance/guest/role-ports.cjs`; Test `tooling/production-acceptance/tests/unit/confinement_test.py`, `tooling/production-acceptance/tests/unit/role-ports.test.cjs`; Create/Test `tooling/production-acceptance/tests/unit/bootstrap-composition.test.cjs`.

**Interfaces:** Produces `bind_original_roles(...) -> OriginalRoleSet`, `bindBootstrapComposition(channel,binding,clock,cleanupBudget) -> BootstrapRoleBinding`, `prepareBrowser(proof) -> BrowserActivationTransaction`, and `commitFixedBrowserLaunch(transaction,launchPinnedBrowser) -> Promise<RoleHandle>` as amendment section3. Existing `bindRoleBootstrap`/`adoptRole`/`activateOnce` remain the actual adoption path; cleanup durations are remaining milliseconds.

- [ ] Write Node cases `v1_original_child_pipe_required_for_nominal_adoption`, `v1_foreign_replayed_copied_grant_denied`, `v1_expiry_cancel_generation_checked_at_fixed_launch`, `v1_late_activation_preserves_original_cleanup`, `v1_shared_cleanup_deadline_never_renews`. Write Python `test_v1_original_role_ids_never_select_foreign_pid_or_fd`, `test_v1_fixed_frames_reject_unknown_and_ancillary_data`, `test_v1_partial_start_retains_all_original_owners`.
- [ ] Run NODE-ONE(role-ports.test.cjs), NODE-ONE(bootstrap-composition.test.cjs), PY-ONE(confinement_test.py). Expected RED includes expired/cancelled launch recorder being called or missing original-owner binding; no real Node process/Chromium launch.
- [ ] Implement fixed MAC/framing/sequence and original child/pipe maps on existing controller FD3/4. Python stays PID parent and physical endpoint owner; JS mints local nominal handoffs only after authenticated original-channel audit and uses existing adoption. Finite forwarding retains logical peer CONTROLLER without donating FDs or weakening `role_fds`.
- [ ] Implement one-use transaction/grant, synchronous final guard plus captured fixed launch callback, post-await revalidation and terminal cancel/EOF handling. The trusted future worker invokes the guarded callback directly; no arbitrary executable/argv/path in protocol. Register preparation ownership atomically as already required by N3. Route `activateOnce` compensation and start-role rollback to the same budget; remove independent120000ms windows only in this composed contract.
- [ ] Run focused GREEN then NODE-ALL and PY-ALL. Assert both reentrant and asynchronous cancellation/expiry/late-owner cases; no timeout claim discards original cleanup. No `browser-worker.cjs` is created.
- [ ] Diff-check, stage five paths, commit `feat(acceptance): bind original roles to one-use launch authority`. Independent Task8/JS review must challenge effect-boundary ordering, not merely post-return checks.

### Task 7: Mint runtime authority in the actual proxy loop

**Files:** Modify `tooling/production-acceptance/guest/proxy.py`; Test `tooling/production-acceptance/tests/unit/proxy_test.py`.

**Interfaces:** `serve_proxy(config,transport,*,runtime_sink=None) -> ProxyOutcome`; actual invocation alone creates `ProxyRuntimeOwner`, whose `observe_current(binding)` returns the exact `ProxyRuntimeObservation` and whose `stop_owned(remaining_ms)` retains original resources. The admitted inherited entry publishes finite observations on the original result pipe without exposing endpoint FDs.

- [ ] Write `test_v1_runtime_owner_minted_only_after_auth_and_listen`, `test_v1_equal_objects_cannot_substitute_serving_owner`, `test_v1_ready_current_failed_frames_bind_original_child`, `test_v1_runtime_terminal_never_revives`, `test_v1_runtime_cleanup_shares_composition_budget`. Exercise the real `serve_proxy` control flow with inert sockets/transport; equal-looking constructor data is rejected.
- [ ] Run PY-ONE(proxy_test.py); retain behavioral RED before implementation.
- [ ] Retain exact config/sockets/transport/listener/selector/endpoint references inside the serving invocation. Publish readiness only after actual authentication and listener verification, then recheck originals for every observation. Preserve fixed CONNECT/vsock/endpoints, limits, deadline checks, current WAITING order and unresolved close retries. Any sink failure/pipe death fails and compensates original resources.
- [ ] Run focused GREEN then PY-ALL; rerun all accepted Task9 R1–R5 regressions. No native serving loop/socket is invoked.
- [ ] Diff-check, stage two paths, commit `feat(acceptance): attest the owned proxy serving loop`. Obtain independent Task9 contract review before composition consumes its owner.

### Task 8: Install the finite owned event source before snapshots

**Files:** Modify `tooling/production-acceptance/guest/topology.py`, `tooling/production-acceptance/guest/confinement.py`; Test `tooling/production-acceptance/tests/unit/topology_test.py`, `tooling/production-acceptance/tests/unit/bootstrap_reference_test.py`.

**Interfaces:** Produces `LinuxBootstrapEventSource.install(binding,native,cleanup_budget) -> BootstrapEventOwner` and `EventCheckpoint={binding,generation,sequence,sourceIdentity,lostCount}`. `sourceIdentity` is a private32-hex ID of the original source owner; checkpoint construction is sealed. `barrier()` drains/verifies the fixed channels and returns a current checkpoint or terminal failure. `stop_owned` uses original descriptor owners and the shared budget.

- [ ] Write `test_v1_event_source_installed_before_first_snapshot`, `test_v1_transient_listener_and_unix_creation_latch`, `test_v1_event_loss_overflow_death_fail_closed`, `test_v1_event_pending_group_cannot_pass_barrier`, `test_v1_event_fd_inventory_never_reaches_roles`, `test_v1_event_setup_failure_keeps_typed_cleanup`.
- [ ] Run PY-ONE(topology_test.py) and PY-ONE(bootstrap_reference_test.py) RED. Feed independent literal native records and command recorders; missing primitive/source support is an unavailable gate, not a passing empty stream.
- [ ] Implement one source with exactly four native descriptors and wakeup pipe pair, fixed audit/rtnetlink/uevent/inotify setup/parser, original role-death observation, limits and exact reference-backed constants/layouts. Audit rules have the fixed native syscall set from the amendment, with unsupported fork/vfork excluded; setup/status authority remains guest-bootstrap-only. No generic event bus, dynamically chosen masks/rules or untrusted-role filter change.
- [ ] Make acquisition ownership visible before any descriptor/configuration effect. Install all sources/rules, verify baseline loss/readiness, then permit snapshot. Strictly correlate complete audit groups/EOE, source identity, uevent sequence and watch identity; heartbeat/status verifies ownership and loss. Unknown records/coverage, pending groups beyond1000ms, >256events/>1MiB, >64pending groups, truncated input, lost counters or source death latch generation. No polling fallback.
- [ ] Run focused GREEN and PY-ALL. Assert the unchanged Task8 filter bytes/role FD arrays, zero host effects, max100ms health cadence and shared cleanup cap. Review pinned source semantics for event completeness/barriers explicitly; tests alone cannot establish actual kernel delivery.
- [ ] Diff-check, stage four paths, commit `feat(acceptance): own finite bootstrap event supervision`. Independent review must either approve the exact mechanism/source boundary or stop; never replace it with a callback wrapper to obtain GREEN.

### Task 9: Compose the guest sequence and cross-language role boundary

**Files:** Modify `tooling/production-acceptance/guest/topology.py`, `tooling/production-acceptance/guest/role-ports.cjs`; Test `tooling/production-acceptance/tests/unit/bootstrap_composition_test.py`, `tooling/production-acceptance/tests/unit/bootstrap-composition.test.cjs`, `tooling/production-acceptance/tests/unit/topology_test.py`.

**Interfaces:** Produces the section3 `compose_bootstrap_v1(...) -> BootstrapComposition` and its `begin`, `require_current`, `prepare_browser`, `stop_owned`. `CompletedProbeEpoch` is retained, not recomputed by `capture`; role/proxy/event sources must be the original owners from Tasks5–8. Adds `BootstrapHandoffV1` alongside legacy Task10 handoff (exact wire below); legacy remains offline inspection only.

- [ ] Write `test_v1_all_probe_families_exit_before_persistent_roles`, `test_v1_resample_reuses_probe_epoch_without_spawn`, `test_v1_binding_mutation_invalidates_every_owner`, `test_v1_capture_failure_at_each_acquisition_keeps_original_cleanup`, `test_v1_complete_guest_composition_uses_actual_accepted_modules`. Node case `v1_python_frames_adopt_original_role_and_guard_launch_once` consumes actual Python-produced finite frames; substituted frames/copies/replays fail.
- [ ] Run PY-ONE(bootstrap_composition_test.py), PY-TOPOLOGY and NODE-ONE(bootstrap-composition.test.cjs) RED. The positive fixture must exercise original `start_roles`, real probe result checks, real serving loop, real event parser and actual JS `adoptRole`; only OS/clock/receiver/launch effects are inert.
- [ ] Implement the state order in amendment section4. Move probes out of `NativeTopologyBindings.capture`; capture consumes the retained epoch plus current roles/proxy/events. Start roles once, activate only the fixed proxy service, install event source before snapshot, bracket snapshot with checkpoints and retain original event ownership before publication. Snapshot/resample cannot install a fresh owner or reopen generation.
- [ ] Enforce explicit waiting-state transitions: at admission BROWSER/VERIFIER waiting, CONTROLLER/PROXY servicing their fixed channels; after committed browser launch BROWSER is active within the same original family. Preserve stable identity/FD/policy facts while validating that one internally reserved lifecycle transition. Do not require an impossible all-four-waiting snapshot or treat arbitrary role changes as acceptable drift.
- [ ] Define the new handoff as exact `{version:2,payload,mac}`; payload is the accepted topology payload plus `composition:{binding,probeEpochDigest,fixtureInventoryDigest,eventCheckpoint,proxyRuntimeId}`. MAC domain is `acceptance:bootstrap-composition:v1\0` and covers canonical payload; `version:2` denotes this envelope extension, composition binding stays version1. Cap131072bytes/depth12 as the current topology handoff, never the16384-byte action frame. Preserve all nested strict primitive/role/device checks. Export fresh new sibling fixtures and malformed independently authored cases; no historic vector edits.
- [ ] Run focused GREEN, NODE-ALL and PY-ALL. Run a finite cross-language exchange by setting `BOOTSTRAP_V1_EXCHANGE` to a new absent directory for PY-ONE(bootstrap_composition_test.py), then `BOOTSTRAP_V1_INPUT=<that-directory>/roles.json` for NODE-ONE(bootstrap-composition.test.cjs). The Python producer must use exclusive files, include generated frame hashes and fixed IDs; Node must exercise the actual adoption/guard. Test unset variables perform no export/import. Record source/input/output hashes.
- [ ] Diff-check, stage five paths, commit `feat(acceptance): compose the owned bootstrap admission chain`. Independent composition review challenges full vertical ownership and N5 regressions before host work.

### Task 10: Consume the same composition at host admission

**Files:** Modify `tooling/production-acceptance/host/Sources/AcceptanceCore/VMHost.swift`, `tooling/production-acceptance/host/Sources/AcceptanceHost/main.swift`; Test `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`.

**Interfaces:** Produces private nominal `BootstrapCompositionV1` retaining original `RunConfiguration` channels, member/population authority, guest binding/event/probe evidence and cleanup; `VMHost.bootstrapCheck(run:RunConfiguration,composition:BootstrapCompositionV1) throws -> BootstrapQualification`. Existing operational `bootstrapCheck(invocation:)` remains denied until signed native construction exists. `OfflineVMHost` consumes explicitly offline composition, never returns native source authority.

- [ ] Write `v1_guest_handoff_matches_original_host_run_and_inventory`, `v1_wrong_epoch_generation_runtime_or_fixture_denied`, `v1_initial_event_owner_precedes_snapshot`, `v1_late_capture_cleanup_remains_typed`, `v1_effect_boundary_grant_expiry_cancel_denied`, `v1_cli_missing_native_prerequisites_has_zero_effects`. Include complete Python-produced new handoff and strict boolean/int/unknown-key/canonical/MAC tamper vectors.
- [ ] Generate fresh all-language fixtures; run SWIFT-ONE(BootstrapGateTests) RED against the actual new host behavior. No product execution is needed for CLI tests: use existing `HostDispatch` parsing/dispatch doubles.
- [ ] Validate version2 topology envelope and composition binding independently, requiring exact v2 manifest/member authority and original host lifecycle/channel ownership. Install/register lifecycle/capture obligations before effectful calls. Carry epoch/generation/cancellation into the same guarded JS boundary; preserve Swift N3 atomic preparation and typed shared-budget cleanup. A host post-return check supplements but does not replace worker effect validation.
- [ ] Replace obsolete comments/reasons about impossible Task7/8/9 source composition with precise remaining operational prerequisites. Do not construct VZ VM, native disk/serial attachment, listener, terminal, signer or entitlement authority. Correct host/guest platform labels: host Darwin/arm64; guest Linux/aarch64. No Linux-only selector may masquerade as a native Mac host constructor.
- [ ] Run focused GREEN, SWIFT-ALL and fresh Swift→Node receipt consumer. Inspect full suite outcomes including the known unchanged broker race; do not edit its implementation/test in this task.
- [ ] Diff-check, stage three paths, commit `feat(acceptance): bind host admission to bootstrap composition`. Independent host/whole-chain review required before final verification.

### Task 11: Final exact-tree verification and whole-M4 offline review

**Files:** No production-source change planned. Evidence/review reports go only to fresh ignored directories under the new evidence root. If a new defect is found, return to its owning task with scoped source/test commit and independent re-review.

**Interfaces:** Consumes the reviewed commits and fresh producer/consumer artifacts. Produces an evidence manifest and independent disposition distinguishing offline source acceptance from all unperformed operational gates.

- [ ] Check exact branch/HEAD, changed-path allowlist, clean index and original design/plan/reference/evidence hashes. Review the complete baseline-to-final diff and source hashes. The implementation must contain no browser-worker/package/lockfile/M5 source, changed role filter authority, dependency or operational default.
- [ ] Produce new final inputs with the exact command recipe. Run focused Python appliance/confinement/proxy/topology/composition/reference tests, Node role-port/composition tests, and Swift VMConfiguration/BootstrapGate suites on the final tree; include fresh Python→Node and Python→Swift exports. Assert nonzero named test counts with no unplanned skip.
- [ ] Run one PY-ALL, one NODE-ALL, one SWIFT-ALL and one fresh Swift→Node signature-consumer run. Preserve exact argv/environment, return codes, complete logs, source/input/output hashes and warnings. If the retained broker race recurs, report `.terminal` versus `.limits` and stop broad acceptance for separately scoped disposition; do not widen this work or rerun to hide failure.
- [ ] Ask a fresh independent whole-M4 offline reviewer to assess the original Tasks8–10 plus this amendment, not merely the last patch. Require explicit dispositions for C1–C6/R1/R4/R6, N5-A/N5-B, original N3 regression protection, event coverage/reference integrity and all changed accepted contracts. The reviewer must use inert witnesses for original-owner substitution, acquisition failures, late launch, transient listener, lost event and archive/member/path mismatch.
- [ ] Accept only a review with no material open finding and truthful exact-tree evidence. Report `BOOTSTRAP_COMPOSITION_V1_OFFLINE_VERIFIED` only if all source/test/review requirements pass; separately list worker payload, native population, signing/entitlement, fixture provisioning and real B1/runtime qualification as unperformed. Original M4 real-kernel gate is still unmet.
- [ ] Confirm Task13 bookkeeping: direct worker payload required, future worker must invoke the same guarded effect path, no live Chromium launch until real B1 passes, and later payload bytes force fresh inventory/composition review. Stop before M5, Task13 implementation or any operational scope. No final “cleanup” deletion, merge, push or deploy follows this review.

## Plan self-review and handoff

Coverage map: amendment§§2–5→Tasks1/6/9/10; §6 probes→Task5 and proxy→Task7; §7→Tasks2/3/8/9; §8→Tasks3/4/10; §9→Tasks3/6/10/11; §10→all task gates and Task11. All five Review Focus conditions have named owner tests. Type/signature names in consuming tasks match their producer blocks; legacy vs new wire/manifest versions and action-frame vs topology-frame bounds are deliberately distinct.

No implementation is performed by writing this plan. The author self-reviews scope, ordering, exact interfaces, test assertions/commands, fixture freshness and type consistency before the documentation commit. The coordinator obtains the independent plan review and applies the owner's already supplied execution authorization; this handoff does not ask the owner to repeat that authorization. A material architecture deviation or new operational scope requires a new decision.

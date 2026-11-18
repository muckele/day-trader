# Stage 1 remediation contract

Additive to the design, original plan and composition amendment, which stay byte-identical; approval covers design direction only.

This contract is normative for tasks 2-18 of `docs/superpowers/plans/2026-11-17-stage1-remediation.md`. It restates owner decisions E1-E7 (`docs/STAGE1_REMEDIATION_DECISIONS.md`, APPROVED 2026-11-17, option A throughout) and the plain bugs listed there as "Not owner decisions". It widens no decision and does not change the design's threat model (`docs/PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md` section 4), the PAPER-only rules, or the rule that real native execution stays behind Stage 2 approval. Each clause has four parts: old requirement, decision, reconciliation, owning task. Rulings P1-P31 from the pre-flight scan are listed in the appendix and cited in the clauses they change.

## C1. Cleanup budget (E7)

- **Old requirement:** Composition amendment section 5 (one cleanup deadline); design section 20 (VM cleanup). The shared 60 s window opened during normal probing, and Python, JS and Swift each started it under a different rule (review findings CA-I1, CB-I1).
- **Decision:** E7, option A. Folds compA D-1.
- **Reconciliation:**
  - The shared 60000 ms end starts at the first terminal event: stop, cancel, failure, drift or expiry.
  - Routine, non-terminal probe-family stops use a fixed 2000 ms step and never start it.
  - JS follows the same rule.
  - The Swift host budget starts at the host's own terminal decision, not at check start.
  - D-1 sentence: "Routine probe-family stops use fixed bounded waits and never allocate the shared end."
  - P2: `CleanupBudget.clamp_end(end_ms)` starts the terminal budget first. No component writes the budget deadline directly. Every budget consumer named in P2 (including `guest/confinement.py`, `guest/proxy.py` and the `V1Budget` test double) follows the terminal-start rule.
  - P5: the browser `activateOnce` is bounded by the activation/run deadline. The cleanup budget is used only on its stop path.
- **Owning task:** Task 2 (Task 11 for the P5 `activateOnce` bound).

## C2. Freshness challenge (E2)

- **Old requirement:** Design section 14 and composition amendment sections 4 and 5: guest observation compared with host time within 1 ms (T10-1, T10-7). The two clocks are separate, so it could never pass.
- **Decision:** E2, option A. T10-7 (the 1 ms legacy capture bound) is a plain bug fixed here.
- **Reconciliation:**
  - The host challenge is `hostChallenge`: 16 random bytes as 32 lowercase hex characters, one use.
  - Initial deadline 120000 ms; current deadline 2000 ms. Both are measured on host monotonic time only.
  - `observedWall` and `observedMonotonic` are guest-local and never compared with host clocks.
  - Guest observation window: 100 ms.
  - Internal guest currents carry no challenge; the host rejects a handoff without `hostChallenge`.
  - P6: `hostChallenge` is covered by the handoff MAC but excluded from the stable topology digest on both host and guest.
- **Owning task:** Task 3.

## C3. Key derivation (E3, T10-10)

- **Old requirement:** Composition amendment section 3: one run capability keyed the handoff MAC and was also used for other purposes (T10-10).
- **Decision:** E3, option A (with T10-10).
- **Reconciliation:**
  - `derive(capability, label) = HMAC-SHA256(key=capability, msg="acceptance:key-derivation:v1\0" ‖ label ‖ "\0")`.
  - Labels: `vsock-stream`, `topology-admission`.
  - The handoff MAC uses the `topology-admission` key.
  - The proxy receives only the `vsock-stream` key.
  - P10: the bootstrap passes `derive(capability, "vsock-stream")` to the proxy entry as an explicit argument. The proxy never receives the capability.
- **Owning task:** Task 3 (derivation and handoff MAC); Task 6 (the proxy-entry producer).

## C4. vsock stream proof (E3)

- **Old requirement:** Design section 9.3. The proxy's vsock "transport authentication" compared the binding with itself, and the M2 host broker used its own capability as the authenticated one (T9-3).
- **Decision:** E3, option A. This reopens accepted M2 broker code (`EgressBroker.swift`) under the owner's 2026-11-17 approval; the `55c115a` historical evidence exception is neither reopened nor generalized.
- **Reconciliation:**
  - Per stream, the host first sends a challenge frame: a 2-byte big-endian length (16) followed by 16 random bytes.
  - The guest answers with its control frame (2-byte length ≤ 256), then a proof frame (2-byte length 32, then 32 bytes).
  - `proof = HMAC-SHA256(k_vsock, "acceptance:vsock-stream:v1\0" ‖ nonce ‖ runId (32 ASCII hex) ‖ sequence (8-byte big-endian))`.
  - The broker verifies in constant time before sequence admission. A mismatch latches the whole run as `identity`.
- **Owning task:** Task 6.

## C5. Proxy authority (E4)

- **Old requirement:** Composition amendment section 6 (in-process `ProxyRuntimeOwner` consumed by the composition). A confined PROXY child cannot hand that object to the bootstrap (CB-I2).
- **Decision:** E4, option A.
- **Reconciliation:**
  - The bootstrap observes `/proc/<proxy-pid>/fd/*` and `fdinfo/*`, and cross-checks them against the proxy's MAC'd runtime report on the existing v2 FD3/FD4 channel.
  - Order: report A, then `/proc`, then report B. Accept only if all three are equal and B's sequence is A's plus 1.
  - The proxy loop never runs in the bootstrap process.
  - The in-process `isinstance(proxy_owner, ProxyRuntimeOwner)` gate is replaced, not kept beside the new authority (R11).
- **Owning task:** Task 7.

## C6. Per-role seccomp (E1)

- **Old requirement:** Design section 9.2 and plan Task 8. The outer filter denied more than section 9.2 requires, so Chromium's namespace sandbox very likely could not start (T8-06).
- **Decision:** E1, option A, narrowed by R1: only the decision's explicit allow list is allowed; the other denials stay.
- **Reconciliation:**
  - The BROWSER deny list is the base list minus `chroot`, `capset`, `setuid`, `setgid`, `setreuid`, `setregid`, `setresuid`, `setresgid`, `setfsuid`, `setfsgid` and `setgroups`, leaving 13 entries.
  - `mount`, `umount2`, `pivot_root`, `setns`, `mknodat` and `pidfd_open` stay denied for BROWSER (R1). `unshare`, `clone` and `clone3` were never filtered; tests bind that BROWSER allows them (R2).
  - BROWSER seccomp filter flags are exactly {0, TSYNC, SPEC_ALLOW, TSYNC|SPEC_ALLOW}.
  - Other roles are unchanged.
  - No `NEW_LISTENER`, TRACE or USER_NOTIF.
  - Stage 2 must show the sandbox starts on a real VM.
- **Owning task:** Task 8 (P27: Task 10 relabels the two affected probes).

## C7. Per-role storage (E5)

- **Old requirement:** Design section 15 and plan Task 18 storage model: one caller admitted and deleted all five role roots across four UIDs, and the root model contradicted the Task 8 role-view layout (T18-I1, T18-I2).
- **Decision:** E5, option A.
- **Reconciliation:** Role scopes as seen inside each view:
  - `/run/acceptance/<role>`, `/tmp`, `/var`
  - `/dev/shm`: a per-role tmpfs of 67108864 bytes
  - `/run/acceptance/crash`: a per-role subdirectory of the 1048576-byte crash tmpfs

  Admission runs in the pre-exec helper under the role UID (R8). Cleanup runs in a fixed confined cleanup child. The bootstrap only sums metadata aggregates.
  - P16: /dev/shm is reclaimed by mount-namespace teardown, not unmounted by a parent. A test binds that.
  - P17: the storage-admission proof is a fixed 32-byte digest appended to the existing ready frame (new fixed length), validated by the bootstrap. The role list stays local to storage.
- **Owning task:** Task 14.

## C8. Credential framing (E6)

- **Old requirement:** Design section 8. The host sent a 4-byte length plus bytes; the guest read a newline-terminated line, so no credential could be delivered (T11-I3).
- **Decision:** E6, option A (also covering T11-I1 and T11-I2).
- **Reconciliation:**
  - Host to guest: a 4-byte big-endian length n (1 ≤ n ≤ 4096), then n bytes.
  - The guest reads in raw TTY mode set with `TCSAFLUSH` and `TIOCEXCL` (R10).
  - The host serial input carries no guest-role fields.
  - P26: no host-side sink check is dropped without a named replacement or a reviewer-accepted reason that the host can never observe it.
- **Owning task:** Task 12.

## C9. Contract changes from the plain bugs and recorded widenings

- **Old requirement:** Design sections 9.3, 10, 13, 17, 19; composition amendment section 9; Task 13 review notes T13 m-2 and compB part-B note 5.
- **Decision:** the "Not owner decisions" list in the decisions doc (T9-1, T9-2, T12-I2, T13 I-1, T13 I-2, categories B and D), plus recorded amendments. These are plain bug fixes, not owner decisions.
- **Reconciliation:**
  - The proxy accepts one `Proxy-Connection: keep-alive` line (T9-1).
  - Idle, EOF and EPIPE events close only their tunnel; the whole-run latch stays for transport, broker or vsock loss, protocol violation, caps and clock faults (T9-2).
  - Per-run tunnel total: 1024.
  - The reducer admits `budget` in PREFLIGHT and AWAIT_CREDENTIAL.
  - New state fields `sessionMaybeIssued`, `safeSignOutRouted`, `revocation` and `postTerminalAnomaly`; internal events `safeSignOutRoute`, `safeSignOutResult` and `tick`.
  - P19: VERIFY_REVOCATION, FINALIZE and DONE `validState` = {`credentialConsumed`, `loginAttempted`, `sessionMaybeIssued`, non-null `sessionExpiresAtMs`, `authenticated===false`, `logoutAttempted`, `restartReceiptConsumed`}; VERIFY_REVOCATION PASS sets `revocation:'CONFIRMED'`.
  - The first navigation is `FRONTEND + '/login'` (T13 I-1).
  - Header policy: every non-browser-generated header goes to admission, and `authorization`, `proxy-authorization`, `x-*` and method-override headers abort locally (T13 I-2).
  - New fixed worker action `SESSION_READINESS`.
  - P20: `verifyGate(kind, handle, binding)` keeps its 3-argument form; readiness and owner handles are added. The brand registry stays in `receipts.cjs`; `isBrowserSession` is injected, not required.
  - Record-only: the as-built action catalogue `LOGIN_SESSION`/`SESSION_OBSERVATION` (T13 m-2) and the Task 13 `browserConfig`/`APP_WRITE`/`APP_POLL`/`APP_CHUNK` union widening (compB part-B note 5) are recorded as reviewed amendments.
- **Owning task:** Tasks 5 (proxy parsing), 13 (reducer), 15 (routing and headers), 16 and 17 (provenance, readiness and owner gates).

## C10. Native blockers carried to Stage 2

- **Old requirement:** Design sections 22 and 23: synthetic and native qualification evidence is required before any real run.
- **Decision:** none. These have no offline fix. Records compA D-2.
- **Reconciliation:** the following stay open and are carried to Stage 2 unchanged:
  - boot `audit=1` (compA D-2)
  - `CONFIG_PROC_CHILDREN`, `CONFIG_IPC_NS` and `CONFIG_COMPAT` facts
  - the real Node FD inventory beyond `{0..4}`
  - `filter_digest` read-back
  - a real Chromium sandbox start
  - the host VZ relay forwarding bytes only
- **Owning task:** Task 18 records them; Stage 2 resolves them.

## Appendix: Pre-flight rulings

Rulings P1-P31 amend the plan text (controller, 2026-11-18). They never widen an E-decision.

- P1: mutation evidence runs after the task's local commit, on a `git archive HEAD` export.
- P2: Task 2 also covers `guest/confinement.py` and `guest/proxy.py`; adds `CleanupBudget.clamp_end`; no direct deadline writes (C1).
- P3: long-lived test bindings for the +61 s and long-catalogue tests, not exported to producers.
- P4: `test_v1_no_routine_path_arms_shared_end` is state-based.
- P5: `activateOnce` bounded by the activation/run deadline (C1).
- P6: `hostChallenge` MAC'd but excluded from the stable topology digest (C2).
- P7: `requireBrowserAdmission` rejects a qualification with `composition == nil`.
- P8: `topology.json.invalid.json` unchanged; named vectors go to `topology.json.named-invalid.json`; Swift gets only expressible vectors.
- P9: keep `TopologyGate(expected, adapter, *, supervisor)`; delete or re-home `Task8ProbeSource`.
- P10: bootstrap passes the `vsock-stream` key to the proxy entry explicitly (C3).
- P11: `observe_child_descriptors` and `run_storage_cleanup` live on `_KernelPortCore`; `ProxyChildAuthority` gates on the port type.
- P12: Task 7 asserts only surviving functions; Swift runtime-row vectors go in `topology.json.bootstrap-v1.invalid.json`.
- P13: Task 9 also owns `abi_coverage_test.py`, `topology_test.py` and the Swift peer rule at `VMHost.swift:471`.
- P14: a task editing a GUEST_MODULES file may adjust the per-site tables in `abi_coverage_test.py` (no inventory, oracle or SHA change), each edit listed for the reviewer.
- P15: the no-weakening exception covers E1-E7, R1-R11, the decisions doc's "Not owner decisions" list and these P-rulings only. Deleting code together with its binding rows is allowed only when the reviewer confirms it is unreachable or replaced by a stricter check, and each deletion is named in the report.
- P16: `_ProbeFamilyOwner` item moves to `tests/guest/confinement_probe.py`; /dev/shm is reclaimed by mount-namespace teardown (C7).
- P17: storage-admission proof is a fixed 32-byte digest appended to the ready frame; `uid()` added to the child port (C7).
- P18: Task 11 mutant E7 becomes "root-browser exit accepted as non-terminal".
- P19: VERIFY_REVOCATION/FINALIZE/DONE `validState` and `revocation:'CONFIRMED'` (C9).
- P20: `verifyGate` keeps its 3-argument form; `isBrowserSession` injected (C9).
- P21: Task 1 check: each E-id appears in exactly its clause set (E3 in C3 and C4, every other E-id in one clause); C9's record-only bullet and C10 are exempt from "no value a later task does not test"; small constants checked in context.
- P22: Task 18 uses `8f979c8` as the changed-paths base and commits `report.md` with `git add -f`.
- P23: tasks run strictly sequentially; 12 and 13 follow 11.
- P24: Swift mutants use a per-mutant `--scratch-path` inside the export.
- P25: the event-reference digest `a2e1be57...be7d` has a fifth pin, `tests/unit/abi_coverage_test.py:34` `EVENT_REFERENCE_SHA`; no task changes any of the five.
- P26: Task 12 drops no host-side sink check without a named replacement or reviewer-accepted reason (C8).
- P27: after Task 8, Task 10 labels `BROWSER.setresuid-root` and `initial-namespace-capability` with basis `KERNEL_CREDENTIAL_CHECK`.
- P28: Task 16 locates the legacy branch by content and removes the HMAC `rpc` path with it.
- P29: `OfflineProbeFixtures` builds over a shared fixture core; no copy of `run_confined`.
- P30: Task 2's kill list adds the JS mutant "restore lazy allocation in `cleanupBoundary.remaining()`".
- P31: PY-*/NODE-* shorthands are always prefixed with `sandbox-exec -f "$RM_SB"`.

No-weakening exception scope (P15): E1-E7, R1-R11, the "Not owner decisions" list, and the P-rulings above; nothing else may remove or loosen an existing binding, seal, exact-key check or fail-closed path. `appliance/bootstrap-event-reference.json` must not change.

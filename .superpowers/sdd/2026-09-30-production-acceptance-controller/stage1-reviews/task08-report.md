# Task 8 independent review: guest confinement (M4)

Reviewer: independent Stage 1 security reviewer, 2026-11-17. Offline only. No VM, browser, network, signing, install or worktree change.

## 1. Verdict

**REJECT.** The offline launch contract, ordering and child-ownership logic are sound. But the parts that Stage 2 will rely on for real evidence are not trustworthy as written:
- several guest probes do not attempt what their names claim;
- the native `/proc` attestation checks are mostly unbound by tests;
- "native" kernel provenance is not enforced.

## 2. Scope reviewed

- **Commits:** `8db30fb`, `c1d7efa`, `04da78d` (`8db30fb^..04da78d`).
- **Files:**
  - `guest/confinement.py`
  - `guest/role-ports.cjs`
  - `tests/guest/confinement_probe.py`
  - `tests/guest/confinement_test.py`
  - `tests/unit/confinement_test.py`
  - `tests/unit/role-ports.test.cjs`
  
  All paths are under `tooling/production-acceptance/`.
- **Specifications used:**
  - plan `docs/superpowers/plans/2026-09-30-production-acceptance-controller.md`: "Task 8" (lines 411–432), Global Constraints, Review Focus RF1, and deferred guest targets (line 794);
  - design `docs/PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md` §4 (threat model), §6.1, §9.1, §9.2 and §9.5;
  - amendment `docs/BOOTSTRAP_COMPOSITION_V1_AMENDMENT.md` §1 (line 14), and lines 88 and 96 where they restate Task 8 obligations;
  - the Option A report `m4-abi-coverage-v2/report.md`, used to avoid duplicating its known gaps.
- **HEAD check:** every finding below was re-checked at HEAD `132b67e`.
  - Ten later commits touch these files: `d6388b2`, `7559e9c`, `3eb4251`, `0e24fef`, `f1b7163`, `06cad0f`, `5b70351`, `a2a2c25`, `e4de39d`, `763b329`.
  - Those commits belong to Tasks 10/13 and the composition amendment. They were read only to decide whether each finding is still present.
  - Line numbers are at HEAD.
- **Not reviewed:** the seccomp filter's numeric literals, as instructed. Option A bound them.

## 3. Findings

Paths are relative to `tooling/production-acceptance/`. "Probe" means `tests/guest/confinement_probe.py`. "Unit" means `tests/unit/confinement_test.py`.

| ID | Severity | File:line at HEAD | Still at HEAD | Evidence | Suggested fix |
|---|---|---|---|---|---|
| T8-01 | Important | Probe `:414-424` (ptrace `:416`, pidfd `:417`, process_vm `:418`, SCM_RIGHTS `:421-424`); denial classifier `:371`; Task 10 projection row `BROWSER_FD_DONOR` `:279` | yes | **The "theft" probe family never attempts cross-role theft.** See detail A. Demonstration D2/D3 (`scripts/probe_semantics.py`) shows: ptrace is sent as `(117, (0, <pid>, 0, 0))`; both SCM_RIGHTS variants issue the identical `recvmsg(3, NULL, MSG_CMSG_CLOEXEC)`; an EBADF result is classified `denied=True`. | Make the attempts real, per design §9.5 ("Try proxy/controller FD theft, cross-role socket access and ancillary transfer"). See detail A. |
| T8-02 | Important | Probe `:596-602`; samples `:61` | yes | **The ABI probe accepts any terminating signal, and two of its cases cannot be realised.** D1: a helper that dies by SIGSEGV is classified `ABI_BOUNDARY_DENIED` once `authority.audit_abi_termination` returns the authority. `KILL_PROCESS` kills with SIGSYS, but `code<0` accepts any signal. On AArch64 the only alternate audit arch is AArch32 compat, and only with `CONFIG_COMPAT`. An `x86_64-audit` or `unknown-audit` attempt cannot be made, so those two cases are permanently unavailable, or are "passed" by a sample that never attempts the claimed ABI. | Require `-code == signal.SIGSYS` in the probe, not only in the authority. Record the kernel-config absence of compat as separate evidence. Remove or redefine the x86_64 and unknown cases as kernel-config assertions. |
| T8-03 | Important | Probe `:440`, `:491` | yes | **The `exact_fd_inventory` probe makes no observation of its own.** `exact-uid-capability-view-fd-inventory` returns whatever `authority.audit(port)` returns. A rubber-stamp authority passes all four roles (D4). The only real check is the child's earlier self-inspection (`:734`, `_native_observe(local=True)`). That is not the parent-side exact check: no ns-vs-parent, `/proc/<pid>/root` or cmdline comparison. | Have the probe itself run the bootstrap-side `_native_observe(local=False)` on each waiting probe family. Record the facts in the probe result. Let the authority only correlate. |
| T8-04 | Important | `guest/confinement.py:1129-1191`, `:1519-1534` | yes | **Most native `/proc` attestation checks are not bound by any test.** Mutants applied to a HEAD export survive the full 401-test Python suite. See §5, mutation table: M1–M5, M7–M11, M14–M16 and M18 survive. Of the `_native_observe` mutants, only M6 (pipe direction) and M19 (seccomp mode) are killed, and both only by Option A's literal-binding tests, not by a behavioural test. Only the fs-type/ro drift and exe-inode checks are tested (`observed_native`, unit `:578`). These checks are what turn kernel facts into the B1 role-isolation claim. | Add one negative fixture per check: pid/mnt ns equal, user ns differ, root inode, extra `/dev` entry, extra FD, stdio not `/dev/null`, cmdline, `/run/acceptance` listing, tmpfs mode/owner/dev, local initial-ns, each capability position, gids/groups. |
| T8-05 | Important | `guest/confinement.py:1263,1271` (public `NativeKernelPort(bindings)`), `:901` (`bindings_factory`); probe `:711`; consumers `guest/topology.py:534,894,2559` | yes | **"Native" provenance is a type check that test doubles satisfy.** See detail B. D5: `NativeKernelPort(SimpleNamespace())` passes `isinstance`, and `NativeProbeFixtures` accepts it. The existing unit test `:1004` does exactly that. | Seal `NativeKernelPort` construction to `select_native_kernel` with a genuine sealed `LinuxBindings`. Give offline doubles a distinct type. Have the whole-M4 review confirm that no route to `CompletedProbeEpoch` or admission accepts injected bindings. |
| T8-06 | Important | `guest/confinement.py:242-244` (deny list), `:258-259` (seccomp flags 0/1 only) | yes | **Design conflict: the outer filter very likely prevents the Chromium sandbox that the plan and design require.** See detail C. Not verified at runtime. | This needs an owner/design decision before Stage 2. Narrow the extra denials, or record a reviewed alternative that keeps `chromiumSandbox: true`. Any change re-opens the Option A literal bindings. |
| T8-07 | Minor | Unit `:614-623`, `:643-649`, `:656-664`, `:682-687`; `guest/confinement.py:290,295` | yes | **Several named unit tests prove less than their names say.** See detail D. | Rename these tests or document them as offline proxies. Wire or delete `validate_channel_message` and `proxy_endpoint` (`guest/proxy.py` has its own constants). Make `no_console` vary only `kind` inside an otherwise-valid tuple. |
| T8-08 | Minor | `guest/confinement.py:354-355`; unit double `Kernel.install_seccomp` | yes | **The TSYNC result check is masked by the test double.** The double sets `seccomp=2` only when `tsync==0`, so the attestation check fails anyway. Mutant M12 (TSYNC check removed) **survives** the full suite. In reality a TSYNC failure installs no filter, so the attestation is a genuine backstop. The named test still does not bind the TSYNC check. | Make the double report `seccomp=2` regardless, so that only the TSYNC check can catch `901`, `-1` or `True`. |
| T8-09 | Minor | `guest/confinement.py:1191`, `:1103`, `:1529`; `RoleViews` `:91-106` | yes, partly addressed for bound runtimes | **Some attestation fields are echoed from the launch, not observed.** See detail E. | Read `tty_nr` from `/proc/<pid>/stat`. Require `Seccomp_filters: 1` while waiting. Either stop comparing echoed fields or label them as launch contract rather than observation. |
| T8-10 | Minor | `guest/confinement.py:202` | yes | **`Descriptor.peer` names the wrong peer.** For BROWSER, VERIFIER and PROXY it is `'CONTROLLER'`. The physical peer of FD3/FD4 is the bootstrap parent, which at HEAD is a bootstrap relay (`OriginalRoleSet.handle_controller`). | Use `'BOOTSTRAP'` for every role, or document the relay. |
| T8-11 | Minor | `tests/unit/role-ports.test.cjs:57`; `guest/role-ports.cjs:25-27`, `:317-318` | yes | **The role-ports argv/FD test binds only grant object identity.** See detail F. | Assert on what reaches `authority.activate`, or pass a frozen, verified projection instead of the caller's object. Bound `activate` by the remaining budget. Fix the comment. |
| T8-12 | Minor | Probe `:473`, `:371`; `guest/confinement.py:989-990` | yes | **Assorted probe-strength gaps.** See detail G. | Open console nodes `O_WRONLY` as well. Use the last mountinfo row per mount point. Record the denial source where it can be distinguished (a control fixture without the filter). |
| T8-13 | Minor | Probe `:625-662` | yes | **The `bootstrap_arbitrary_argv_denied` and `TSYNC_failure_abort` guest probes test library code, not a kernel/FD boundary.** See detail H. Plan line 431 claims "each attempted negative operation" fails "at the kernel/FD boundary"; that overstates these cases. | Either label these as library re-checks, or make them attempt a request over FD4/FD3 and a non-`STOP` frame on the helper stop pipe, and observe the rejection. |

### Finding details

**A. Theft probes (T8-01).** Each probe in this family misses the cross-role attempt it is named for:
- **ptrace** uses request `0` (`PTRACE_TRACEME`). ptrace(2) says pid/addr/data "are ignored" for `PTRACE_TRACEME`, so no foreign process is ever targeted.
- **process_vm_readv/writev** pass zero iovecs. Per `mm/process_vm_access.c`, the kernel returns 0 when the local iovec total is 0, before it resolves the pid. This is from kernel source and was not executed here. The call can therefore only detect a missing seccomp rule; it never tests cross-role access.
- **pidfd_getfd** uses pidfd `-1`. Without seccomp the result is EBADF, which the classifier reports as `UNEXPECTED_KERNEL_ERROR`. No real pidfd is involved.
- **`foreign_pid` comes from the bootstrap's PID namespace.** It is meaningless inside the role's PID namespace, and that also affects the `proc-*-fd` cases.
- **Both SCM_RIGHTS variants** run `recvmsg` on the browser's own command pipe (FD3). They touch neither the controller nor the proxy, and EBADF is accepted as a denial.

None of these exercises the independent PID-namespace, UID or ptrace-access layers, or any AF_UNIX endpoint. The roles share the initial network namespace, so abstract sockets are shared, which design §9.2 warns about. The family feeds Task 10's `BROWSER_FD_DONOR` row (amendment line 88). If a real donor existed, the row would still read DENIED. Option A recorded only the TRACEME part, as minor m4.

Suggested fix:
- From the browser role, enumerate `/proc` and require no non-family process.
- Attempt `PTRACE_ATTACH`/`SEIZE`, `pidfd_open`, and `process_vm_readv` with a non-empty iovec against each visible non-family PID, and against a fixture foreign PID translated into the role's namespace.
- Attempt to connect to every abstract and path UNIX name that trusted roles create, plus a fixture donor that really sends SCM_RIGHTS.
- Drop EBADF from the accepted denials.
- Give the two SCM_RIGHTS cases distinct targets.

**B. Native provenance (T8-05).**
- `NativeKernelPort` accepts arbitrary bindings, and `select_native_kernel` returns `NativeKernelPort(any_factory(...))`.
- `NativeProbeFixtures` and Task 10 (`topology.py:534`, `:894`, `:2559`) treat `isinstance(…, NativeKernelPort)` as nativeness.
- The docstrings claim "fake observations never qualify a guest" (`:6`) and "Injecting a factory is only a unit boundary, never qualification evidence" (`:887`). The code does not enforce either claim.
- At HEAD there is no end-to-end false qualification, because the native event source is hard-wired unavailable (Option A). The gate itself is still bypassable.

**C. Outer filter vs the Chromium sandbox (T8-06).**
- **The design's deny list is narrower.** Design §9.2 asks for AF_VSOCK, packet, raw and unknown domains, io_uring, ptrace, cross-role process_vm and pidfd_getfd to be denied.
- **The filter denies more.** It also denies `capset`, `chroot`, `mount`, `umount2`, `pivot_root`, `setns`, `mknodat`, the `set*id`/`setgroups` family and `pidfd_open`, and it allows seccomp flags 0/1 only.
- **The design and plan expect the Chromium sandbox to stay on.** Design §9.2 says "Chromium may create additional restricted user/PID namespaces for its own sandbox". The plan says "Preserve Chromium inner sandbox". Task 13 sets `chromiumSandbox: true` (`guest/browser-worker.cjs:381`).
- **Why the sandbox would fail (reviewer's knowledge, not verified here):**
  - Chromium's Linux namespace sandbox (`sandbox/linux/services/credentials`) drops filesystem access with `chroot` and drops capabilities with `capset`, both inside its new user namespace.
  - With both syscalls returning EPERM, and the setuid sandbox unusable under no_new_privs, the sandbox is not expected to initialise.
  - Chromium's possible use of `SECCOMP_FILTER_FLAG_SPEC_ALLOW` is denied by the flag rule, which is a second risk.
- **The extra denials add little.** They are redundant in the initial user namespace, where roles hold no capabilities.

**D. Unit tests that prove less than their names (T8-07).**
- **RF1 inheritance test.** `test_child_fork_exec_network_gpu_crash_helper_inherits` evaluates the same filter six times and models no descendant.
- **`no_console_or_bridge_fd`.** It passes a one-element tuple, which differs from `role_fds` whatever the `kind`, so it passes for any `kind`.
- **Inherited-ring test.** The `io_uring` inherited-ring part has the same flaw.
- **`SCM_RIGHTS…theft_denied`.** It asserts on:
  - `validate_channel_message` and `proxy_endpoint`, which no production path calls;
  - `views` values that the double echoes back.

**E. Echoed attestation fields (T8-09).**
- `_native_observe` returns `fds`, `views` and `programs` from the launch. `_check`'s comparisons of those fields are therefore tautological.
- `console`, `controlling_tty`, `no_fd_donor` and `no_external_ip_interface` are never observed per role.
- `filter_digest` is the hash of the intended program, which is Option A's R13 caveat. `Seccomp_filters` in `/proc/<pid>/status` is not checked.
- For an unbound runtime, `NativeKernelPort.inspect` still passes `waiting=True` unconditionally (`:1529`). Amendment line 96 forbids that.

**F. role-ports argv/FD test (T8-11).**
- The test passes because `{...grant, ...extra}` is a new object that `inspectGrant` does not recognise, not because extra fields are refused.
- Variant V1 makes the double's grant lookup structural, so that copied grants are recognised. The test still passes (402/402). The only reason is that the double's own `activate` asserts `value === grant`.
  - So the implementation did forward the caller's copied object, with `program:'/bin/sh'` etc., verbatim to `authority.activate`.
  - Rejection is entirely the double's identity checks.
- Mutant J1 removes the global `usedGrants` replay check; it survives all 402 Node tests. That check is defence in depth, because `inspectGrant` also binds the child.
- The comment says independent observations are "rechecked before/after each await". At HEAD the concrete authority returns a literal `confined:true` and `purpose:'CONFINEMENT_PROVED'`.
- `activateOnce` puts no deadline on `authority.activate`.

**G. Probe-strength gaps (T8-12).**
- The console probes open `O_RDONLY` only. A write-accessible but read-denied node would read as denied.
- `check_appliance` uses `any()` over the `/` and `/run` mountinfo rows. A later rw mount shadowing `/` would pass.
- The errno 1/13 classifier cannot tell seccomp from DAC, sysctl or LSM denials. `setresuid-root`, `initial-namespace-capability`, and io_uring with `io_uring_disabled=2` all read as denied with no filter at all.

**H. Library-level probes (T8-13).**
- `arbitrary-*` call `prepare_role`/`exec_role` in-process.
- `arbitrary-uid` would still read as denied without the recompute check, because any later native error maps to `ConfinementError`. The offline unit test at `:1058` does bind it.
- `TSYNC-error` passes an empty fprog, which gives EINVAL, not a TSYNC failure.
- No probe sends a request over the role's pipes or a non-`STOP` frame to the helper.

## 4. Plan-required items

### Named failing-first tests (plan line 426)

| Required test | Unit (offline) | Guest probe (gated) | Assessment |
|---|---|---|---|
| `vsock_browser_controller_verifier_denied` | present | present | correct; would detect a missing AF_VSOCK rule |
| `child_fork_exec_network_gpu_crash_helper_inherits` [RF1] | present | present (fixture helper samples) | unit test is tautological (T8-07). The guest probe depends on separately approved samples. |
| `proxy_fixed_vsock_positive` | present | present | correct shape. At HEAD the receiver count comes from the independent receiver. |
| `io_uring_setup_register_enter_and_inherited_ring_denied` | present | present | unit inherited-ring part is vacuous (T8-07). The guest probe never attempts a socket through io_uring; the setup denial makes that moot. |
| `alternate_ABI_denied` | present (filter evaluation) | present | **incorrect** in the guest probe (T8-02) |
| `SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied` | present | present | **incorrect**: no cross-role attempt (T8-01). The unit test asserts on dead code (T8-07). |
| `privilege_gain_denied` | present | present | correct as a property test. Cannot isolate the seccomp layer (T8-12). |
| `no_console_or_bridge_fd` | present | present | unit test vacuous in `kind` (T8-07); guest probe opens read-only (T8-12) |
| `bootstrap_arbitrary_argv_denied` | present | present | library-level only (T8-13) |
| `TSYNC_failure_abort` | present | present | unit test masked by the double (T8-08); guest `TSYNC-error` is EINVAL (T8-13) |
| `exact_fd_inventory` | present | present | unit test echoes the double; **the guest probe is authority-delegated** (T8-03) |
| `adopt_unaudited_handle_reject` (Node) | present | n/a | correct |
| `activation_second_consume_reject` (Node) | present | n/a | correct, including the concurrent case |
| `arbitrary_role_program_argv_fd_request_reject` (Node) | present | n/a | binds object identity only (T8-11) |
| `exit_handle_bound_to_run_and_owned_child` (Python and Node) | present | n/a | correct for run_id. The Python PID mismatch is unbound (M17). |

### Required behaviours

| Behaviour | Status |
|---|---|
| Bootstrap starts pinned waiting workers and owns reaping | **present.** A per-role direct-parent helper; the parent reaps only the helper; R5 tests bind it. |
| Only audited command/result and fixed exit/stop handles are returned | **present** (`RoleHandoff`) |
| No later role can request another executable, FD, UID or spawn | **present structurally.** The helper accepts only `STOP`. No spawn API exists. |
| Python stdlib/ctypes only; no libseccomp and no generated filter | **present.** ABI literals are re-derived by Option A. |
| Socket domain/type filtering, io_uring denial, no TRACE/USER_NOTIF | **present** |
| PID/mount/proc/device views, four UIDs, empty capabilities and NNP before exec | **present in code.** The checks are unbound (T8-04). Runtime is unverified. |
| Close every unaudited FD (close_range) | **present** |
| No SCM_RIGHTS donor or generic supervisor | **present at range end** (anonymous pipes only). At HEAD the bootstrap relays fixed HMAC frames, which is Task 10 scope. |
| Browser activation only after confinement proof; verifier grant used once | **nominal only at range end**: no concrete authority. At HEAD the concrete authority asserts a literal `confined:true` (T8-11). Verifier grants are not issued at HEAD. |
| Preserve the Chromium inner sandbox | **likely not met** (T8-06) |
| Separately gated runtime check | **not performed, correctly.** Default discovery raises `RuntimeGateUnavailable`; nothing is skipped. |
| RED-before-GREEN evidence | not available; see §6 |

## 5. Checks run

All commands ran under the brief's toolchain.

**Focused suites at HEAD** (worktree root, read-only):
- Python: `TMPDIR=…/tmp/producers/ PYTHONDONTWRITEBYTECODE=1 python3.12 -B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p confinement_test.py` → **78 tests OK**.
- Node: `node --test tooling/production-acceptance/tests/unit/role-ports.test.cjs` → **26/26 pass**.

**Focused suites at range end `04da78d`:**
- Source: `git archive 04da78d tooling/production-acceptance` into `…/tmp/reviews/task08/range/`.
- Python `confinement_test.py`: **53 OK**. Node `role-ports.test.cjs`: **23/23**.

**Full Python suite on a HEAD export** (`…/tmp/reviews/task08/head-base/`): **401 OK** in 41 s. This is the baseline for the mutants.

**Mutation runner:** `…/tmp/reviews/task08/scripts/mutate.py`.
- Each mutant is a fresh copy of the HEAD export with one textual change.
- Python mutants run the full Python unit suite. JS mutants run every Node unit test.
- Results are appended to `…/tmp/reviews/task08/mutation-results.jsonl`.

Baseline: Python 401 OK; Node 402/402.

| Mutant | Change (HEAD `guest/confinement.py` unless noted) | Result | Killed by |
|---|---|---|---|
| M1 | `/dev` listing check (`:1171`) disabled | **SURVIVED** | — |
| M2 | pid/mnt namespace-differs check (`:1166-1167`) disabled | **SURVIVED** | — |
| M3 | user-namespace-same check (`:1168`) disabled | **SURVIVED** | — |
| M4 | `/proc/<pid>/root` inode check (`:1169`) disabled | **SURVIVED** | — |
| M5 | FD0–2 → `/dev/null` check (`:1156`) disabled | **SURVIVED** | — |
| M6 | FD3/FD4 pipe-direction check disabled | killed | `abi_coverage_test` literal binding only |
| M7 | cmdline-equals-argv check (`:1165`) disabled | **SURVIVED** | — |
| M8 | `/run/acceptance` exact listing (`:1182`) disabled | **SURVIVED** | — |
| M9 | tmpfs dir mode/uid/gid/st_dev check (`:1180-1181`) disabled | **SURVIVED** | — |
| M10 | parent exact FD set (`:1154`) relaxed to "superset of 0..4" | **SURVIVED** | — |
| M11 | local initial-namespace check (`:1185-1186`) disabled | **SURVIVED** | — |
| M12 | TSYNC result check (`:355`) removed | **SURVIVED** | — |
| M13 | `exec_role` launch recompute (`:346`) removed | killed | `test_R1_bootstrap_probe_rejects_real_modified_launch_contract_before_effects` |
| M14 | `_check` groups==() removed | **SURVIVED** | — |
| M15 | `_check` gids removed | **SURVIVED** | — |
| M16 | `_check` capabilities → only ambient position | **SURVIVED** | — |
| M17 | `RoleHandoff._exit` pid==attested pid removed (`:386`) | **SURVIVED** | — |
| M18 | `/etc` bind left writable (no RO remount) in `establish_views` | **SURVIVED** | — |
| M19 | `_check` `seccomp != 2` → `seccomp == 0` | killed | `abi_coverage_test` literal binding only |
| J1 | `guest/role-ports.cjs`: `usedGrants.has(grant)` removed | **SURVIVED** (402/402) | — |
| V1 (test-double variant, not a code mutant) | `role-ports.test.cjs`: `inspectGrant` made structural | test still passes (402/402) | the double's own `activate` identity assert |

**Offline demonstrations:** `…/tmp/reviews/task08/scripts/probe_semantics.py`, run with `python3.12 -I -B`. It loads the HEAD export with inert doubles and makes no native calls. Output:

```
D1 SIGSEGV death classified as: ABI_BOUNDARY_DENIED | errno 1
D2 controller-SCM_RIGHTS -> denied = True call (212, (3, 0, 1073741824))
D2 proxy-SCM_RIGHTS -> denied = True call (212, (3, 0, 1073741824))
D3 ptrace call (nr, (request, pid, addr, data)): (117, (0, 777, 0, 0))
D4 exact-uid-capability-view-fd-inventory returns None -> attempt dict would carry denied=False, the expected value for this case
D5 isinstance(NativeKernelPort) over inert bindings: True | NativeProbeFixtures accepted: NativeProbeFixtures
```

## 6. Declined to judge

- **Seccomp filter numeric literals:** excluded by the dispatch; Option A bound them.
- **Runtime kernel behaviour.** Needs Stage 2. This covers:
  - the `readlink('/proc/<pid>/fd/N')` text seen from a different mount namespace and chroot;
  - Yama scope effects on `PTRACE_TRACEME`;
  - `io_uring_disabled` sysctl behaviour;
  - whether Chromium's sandbox fails exactly as described in T8-06;
  - Node's exact startup FD set (see §7).
  
  These are stated as reviewer knowledge, not observed.
- **RED-before-GREEN:** the plan requires recorded RED failures. No RED record survives in the repository, and the October round-2 review is lost. The test style ("behavior is absent" assertions) is consistent with test-first, but that cannot be verified.
- **Later composition code** (`OriginalRoleSet`, `qualify_probe_epoch`, `ReceiverAuthority`, runtime-owner inventory, the bootstrap relay): Task 10/13 and amendment scope. It was read only to decide "still present at HEAD".
- **Whether a full `CompletedProbeEpoch` or admission can be minted from inert bindings at HEAD:** this depends on Task 10 seals. It is flagged for the whole-M4 review (T8-05) and was not attempted.

## 7. Notes for the whole-M4 review

1. **No Node role can pass the exact inventory, very likely.** `start_roles` requires the parent-observed FD set to be exactly `{0..4}` (`confinement.py:1154`, via `:1529`), and `validate_runtime_observation` requires exactly five current FDs while waiting (`:1243`). A real Node worker opens at least an epoll FD and an eventfd at startup. CONTROLLER, BROWSER and VERIFIER would therefore fail closed with `FD_DENIED`. The HEAD docstring admits that "Unknown Node/Chromium internals remain unavailable". Stage 2 cannot pass role bootstrap until the inventory model is changed and re-reviewed.
2. **Kernel prerequisites missing from the manifest.** Task 8 relies on:
   - `CONFIG_PROC_CHILDREN`, for `/proc/<pid>/task/<tid>/children`;
   - `CONFIG_IPC_NS`, for `CLONE_NEWIPC`;
   - `close_range`.
   
   Neither config option is in the appliance `kernelFeatures` enum (`appliance/manifest.schema.json:459-478`, `:1000-1014`). Each failure is fail-closed, but should be an admission prerequisite.
3. **No network-namespace separation.** All four roles share the initial network namespace, so abstract AF_UNIX names and loopback are shared. This matches the design, because the browser must reach `127.0.0.1:3128`. It rests on no trusted role ever exposing an abstract or path UNIX service. The amendment (line 158) makes that a Task 10 event check. The Task 8 probes do not test it (T8-01).
4. **Shared `/run` tmpfs.** Every role's writable state is a bind of directories on the shared `/run` tmpfs. A hostile browser can exhaust it and starve controller or proxy state. This is Task 18 scope (storage bounds).
5. **Fork after threads.** At HEAD the bootstrap imports `threading`. `ReceiverAuthority.observe` and `budget.call` start threads that can outlive a call, and `spawn_waiting` later forks. A fork from a multi-threaded CPython process can deadlock the child on a lock held elsewhere. That would fail closed by timeout, but it is a plausible source of flaky Stage 2 runs.
6. **`BROWSER_FD_DONOR` rests on weak probes.** This Task 10 projection row is supported only by the SCM_RIGHTS probes in T8-01. If the owner treats the twelve-row projection as standalone B1 evidence, treat T8-01 as Critical.
7. **T8-06 will re-open Option A.** Any filter change made to fix the Chromium-sandbox conflict changes the literal set that Option A bound and reviewed. Plan the decision before Stage 2.

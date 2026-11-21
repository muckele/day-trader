# Stage 1 independent review — Tasks 11, 12 and 18

Reviewer: independent security code reviewer (fresh context). Date: 2026-11-17.
Worktree (read-only): `/Users/Matt/day-trader-worktrees/production-acceptance-stage1-fixes`, branch `claude/production-acceptance-stage1`, HEAD `132b67e` (clean before and after review).

## 1. Verdict

**REJECT.** I found no Critical break: the code writes no credential bytes to output, files or public records. But the three tasks cannot be trusted as written, for three reasons:
- Their tests leave almost every fail-closed and privacy behaviour unbound. One mutant state machine reaches `DONE` while every gate fails, and all 10 named tests still pass.
- The intake keeps the credential reachable from its exceptions.
- The three modules do not compose:
  - the host and guest credential formats differ;
  - the reducer and `routes.json` disagree on the P phase;
  - storage and the Task 8 role-view layout disagree.

## 2. Scope reviewed

- **Range:** `6c3a3fc..edfa48e`.
  - `d635e0a` Task 11. `guest/intake.py`, `host/Sources/AcceptanceCore/SerialConsole.swift`, `tests/unit/intake_test.py`, `host/Tests/AcceptanceCoreTests/ConsoleTests.swift`.
  - `773bb26` Task 12. `guest/state.cjs`, `tests/unit/state.test.cjs`.
  - `edfa48e` Task 18. `guest/storage.py`, `tests/unit/storage_test.py`, `tests/guest/storage_test.py`.
- **Still present at HEAD:** `git log edfa48e..HEAD` shows no commit touching any of these nine files, so HEAD line numbers equal the commit line numbers. At HEAD nothing wires them in:
  - no `SerialConsole(` construction in host Sources;
  - no caller of `consume_credential`;
  - no importer of `state.cjs` or `storage.py` outside their tests;
  - `VMConfiguration.swift:161` says private serial handles come from "a future admitted adapter".
- **Specs used:**
  - Plan `docs/superpowers/plans/2026-09-30-production-acceptance-controller.md`: Global Constraints, Review Focus RF4/RF5, the Contract catalogue (limits, failure enum, Ports), Tasks 11, 12 and 18, "Exact deferred guest test targets", and matrix rows C01–C05, P01–P05 and F01–F06.
  - Design `docs/PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md` §7, §8, §10, §15, §16, §17, §18, §19 and §20.
- **Read for composition:**
  - Task 8 `guest/confinement.py` (`NativeChildPort.establish_views`, lines 1040–1075 and 1168–1182);
  - Task 10 `guest/topology.py` (`AdmissionProof`);
  - Task 2 `guest/route-policy.cjs:8` and `contracts/routes.json`;
  - Task 5 `EgressBroker.swift` (`inventory()`);
  - Task 13 `guest/browser-worker.cjs` (paths and env).

## 3. Findings

All file:line references are at HEAD `132b67e` (identical to the commit). Paths are relative to `tooling/production-acceptance/`. Evidence scripts and logs are under `$R = /Users/Matt/day-trader-evidence/production-acceptance-tooling/20261117T002012Z-stage1/tmp/reviews/tasks11-12-18/`.

### Important

| ID | Sev | File:line at HEAD | At HEAD | Evidence | Suggested fix |
|---|---|---|---|---|---|
| T11-I1 | Important | `guest/intake.py:209-212`, `:162-172`, `:265-266`, `:37-38` | yes | **The credential stays reachable from the raised `IntakeFailure`.** `raise … from None` only suppresses *display*; `__context__` is still set.<br>• Invalid-UTF-8 input: `IntakeFailure('CREDENTIAL_INVALID').__context__` is a `UnicodeDecodeError` whose `.object` holds the full credential bytes. Probe P11-A: "context .object contains canary: True".<br>• Any sink failure: `exc.__context__.__traceback__` frame locals keep `consume_private.frame` (length prefix + plaintext). Probe `probe_sink_failure_frames.py`: "credential reachable via context traceback locals: ['consume_private.frame']".<br>The docstring claims the exception "never includes credential or terminal data". Any handler that walks exception chains or captures locals exposes plaintext. These copies are immutable and never zeroed. | Raise the finite failure outside the `except` block, or set `__context__ = None` and `__traceback__ = None` on the original exception and clear it before raising. Validate UTF-8 without `bytes.decode` holding the buffer (or `del` the error). Make `consume_private` write from the bytearray and zero it in `finally`. Add a test that asserts no canary in `exc.__context__`, its `.object`, or any traceback frame locals. |
| T11-I2 | Important | `tests/unit/intake_test.py:62-83`, `:183-207`; `host/Tests/AcceptanceCoreTests/ConsoleTests.swift:163-198` | yes | **The Task 11 tests do not bind the privacy and terminal behaviours they name.** Mutants on the pristine copy, all 6 tests passing:<br>• **M11-1** echoes the credential back to the TTY.<br>• **M11-2** writes `LEAK:`+credential to fd 2. The log shows `LEAK:synthetic-private-canary` printed during `test_synthetic_canary_absent_from_host_output_and_evidence`, which still passes.<br>• **M11-3** removes the 4096-byte bound.<br>• **M11-4** never restores the signal handlers.<br>• **M11-7** ignores terminal loss (EOF and `OSError` → `continue`).<br>Killed only slowly or indirectly:<br>• **M11-5** (never clears ECHO) is killed only after a 249 s hang, as `EXPIRED != SINK_FAILED`. Helper writers spin on the ECHO bit; no test reads the PTY master.<br>• **M11-6** (claim after read) is killed after 121 s.<br>The RF5 "host output" checks are weak:<br>• The Python test redirects only `sys.stdout`/`sys.stderr`, not fd 1 or 2 and not the PTY master.<br>• The Swift canary test checks a constant `PHASE` record that cannot contain the secret.<br>The child and descriptor tests do not exercise real descriptors or processes:<br>• Python `test_automation_child_no_console_access` spawns no child and inspects no descriptor.<br>• Swift `broker_fd_inventory_no_TTY` and `automation_child_no_console_access` assert only over caller-authored `DescriptorFacts`. | Read the PTY master and assert no canary bytes and an empty echo stream. Capture at fd level with `os.dup2` to a pipe. Add oversize, terminal-loss (close master), handler-restore and late-signal tests with bounded test timeouts. Obtain FD facts from a real inventory of a spawned child, or rename the tests to what they check. |
| T11-I3 | Important | `host/Sources/AcceptanceCore/SerialConsole.swift:27-69`, `:146-182` vs `guest/intake.py:178-215` | yes | **Host and guest credential wire formats are incompatible.**<br>• The host writes `UInt32 big-endian length + bytes`, with no newline, to a `ConsolePrivatePipeSink` that models a guest-style `"BROWSER"` consumer, `childID` and `childUID 10002` on the Mac.<br>• The guest intake reads a newline-terminated line from the TTY and rejects NUL.<br>• Design §8's only path is host terminal → serial attachment → guest TTY → intake, so the host sink must be the serial input.<br>Fed through a PTY to the guest intake (`probe_host_guest_framing.py`), the host frame fails:<br>• a 23-byte secret → `EXPIRED` (no newline ever arrives);<br>• a 10-byte secret → `CREDENTIAL_INVALID` (length byte `0x0a` acts as a newline).<br>Length-prefix bytes can also be guest line-discipline controls (`0x03` VINTR, `0x04` VEOF, `0x15` VKILL, `0x7f` VERASE). Fails closed, but no credential can ever be delivered. | Specify one host→guest consume format. Either the host forwards the operator's edited line plus `\n` and rejects control bytes, or the guest reads a raw frame with ICANON/ISIG off. Bind it with a cross-language vector test. Drop the guest-role fields (`consumer`, `childUID`) from the host sink. |
| T12-I1 | Important | `tests/unit/state.test.cjs` (whole file); gates at `guest/state.cjs:128-140`, `:204-206`, `:216`, `:221`, `:229`, `:234`, `:239`, `:244`, `:249`, `:254` | yes | **None of the reducer's negative-outcome gates is bound by a test.** Each mutant below passes 10/10 alone:<br>• M12-6 any `admission` accepted<br>• M12-7 restart receipt `REJECTED` accepted<br>• M12-8 `finalize FAIL` → DONE<br>• M12-9 `verifyRevocation FAIL` accepted<br>• M12-10 `signOut FAILED` accepted<br>• M12-11 `observeBefore FAIL` accepted<br>• M12-12 `consumeCredential REJECTED` accepted<br>• M12-13 `login FAILED` accepted<br>• M12-14 budget `DENIED` → `FORWARD_ROUTE`<br>• M12-15 `observeAfter FAIL` accepted<br>**M12-ALL** applies all ten at once and still passes 10/10. Driving that mutant with a run in which *every* step fails gives `{"phase":"DONE","failure":null,"cleanupComplete":true}`. The pristine reducer gives `FAILED/INVALID_FRAME` (`probe_all_fail_chain.cjs`).<br>Further survivors:<br>• M12-1 drops the FINALIZE 60 s cleanup deadline<br>• M12-2 lets later invalid events overwrite the sticky failure code<br>• M12-3 drops session expiry in HOLD and LOGOUT<br>• M12-5 makes DONE accept any event | Add one negative test per event outcome, asserting `FAILED`, the exact code and no forward effect. Add FINALIZE cleanup-deadline, HOLD/LOGOUT expiry, invalid-event-in-FAILED and DONE-stray-event tests. The reducer code itself is correct; only the tests are deficient. |
| T12-I2 | Important | `guest/state.cjs:199-207` vs `contracts/routes.json:5-30`, `guest/route-policy.cjs:8`, design §10 and §17 | yes | **The reducer denies all P-phase traffic** that design §10 and `routes.json` permit for PREFLIGHT/AWAIT_CREDENTIAL: `/login` document, assets, `health` P1, `me` P2, `market-status` P1.<br>Probe P12-A: `budget ELIGIBLE` in PREFLIGHT gives `FAILED/ROUTE_DENIED`, and the same in AWAIT_CREDENTIAL. The browser cannot load `/login` before the fill. Route policy maps both phases to `P`. Fails closed, but the integrated run can never complete. | Admit `budget` in PREFLIGHT and AWAIT_CREDENTIAL, still gated by route-policy P ceilings. Add positive and negative tests. |
| T12-I3 | Important | `guest/state.cjs:92-112`, `:170-180`, `:216-222`; design §18 and §19 | yes | **The failure-cleanup logout has no admission path and no outcome.**<br>• `fail()` emits `SAFE_SIGN_OUT`, but in FAILED every `budget` event returns `effects: []`. Probe P12-B: the logout request after a trusted-boundary abort gets no `FORWARD_ROUTE`. The requested sign-out therefore cannot be admitted by this reducer, or the interpreter must bypass it.<br>• The state has no field for the logout result, so it cannot report `revocationUnconfirmed`.<br>• Failures in AUTHENTICATING never request `SAFE_SIGN_OUT`, even when the server may already have issued a session (for example owner or cookie mismatch after a 200 login), because `authenticated` is set only on full success. | Model a single cleanup-logout admission in FAILED (L-route only, once, zero cost) and record its outcome (`revocationConfirmed` / `revocationUnconfirmed`). Add a session-maybe-issued flag set at login submission. |
| T12-I4 | Important | `guest/state.cjs:56-71`, `:263`; `tests/unit/state.test.cjs:166-174` | yes | **"Outage or restart cannot resume" is unbound and not enforceable by the reducer.**<br>• There is no initial-state constructor, and `validState` accepts phase-inconsistent caller-built states. Probe P12-C: a hand-built `LOGOUT` state with `credentialConsumed=false`, `loginAttempted=false`, `authenticated=false` and no session reaches `DONE` with `PUBLISH_RESULT`. An unauthenticated `OBSERVE_AFTER_RESTART` state advances to `LOGOUT`.<br>• `outage_restart_cannot_resume` only shows FAILED is sticky against `validate`. M12-4 (outage ignored in every phase except OBSERVE_BEFORE) survives. | Export `initialState(runId, nowMs)`. Add per-phase invariants to `validState` (for example authenticated phases require consumed, login and session expiry; VERIFY_REVOCATION and later require `logoutAttempted`; FINALIZE requires `cleanupStartedAtMs`). Test outage in every live phase. State plainly that restart non-resumption is enforced by Task 21/22 and the durable reservation, not by this reducer. |
| T18-I1 | Important | `guest/storage.py:424-481`, `:575-616`, `:300-306`; plan Task 18 "Each role scans its own readable scope"; design §16 and §20 | yes | **One caller and one `filesystem` port admit, inventory, readability-check and delete all five roots across four UIDs** (`ROOT_ROWS`, lines 15-21).<br>• A non-root process cannot open four other UIDs' 0700 roots, so the real port must be privileged.<br>• Under privilege `readable()` passes for any mode, which voids the "unreadable empty 0600" protection (the hosted root-owned-0600 lesson).<br>• Readability as the actual owning UID is neither required nor checkable by this API. | Split admission and cleanup per role: one `StorageProof` per role root, created and checked by a port running as that UID, with only aggregates returned. Or document a per-UID helper contract and test it. The guest test must run per role. |
| T18-I2 | Important | `guest/storage.py:15-23`, `:195-202`, `:274-281` vs `guest/confinement.py:1049-1066`, `:1177-1182` (both at HEAD; layout already present at `edfa48e`) | yes | **The storage root model contradicts the Task 8 role-view layout.**<br>• `establish_views` creates the role root and `/run/acceptance/<role>/.root` as root-owned (no chown; `.root` mode 0755), plus root-owned 0755 subdirectories and a root-owned `dev/null` file.<br>• Probe P18-A with the committed test double: `.root` present gives `STORAGE_INVALID`; only `.state` gives ADMITTED. So admission after role launch always fails, and `remove_owned_state` can never complete on real role state.<br>• Role-visible `/tmp`, `/var` and `/dev/shm` are binds on the *run* device (checked at `confinement.py:1180-1181`). Storage's separate 64 MiB `/dev/shm` bound therefore does not apply to the shm roles actually use; `browser-worker.cjs:384` re-enables /dev/shm use.<br>• `/run/acceptance/crash` is not visible inside any role view (`confinement.py:1182`), so no role can write crash data there. `crash_aggregate` is structurally always empty. | Reconcile with Task 8: exclude or separately attest the bootstrap-owned `.root`, and chown the role root. Bind the shm bound to the role-visible shm (or document the shared 256 MiB bound). Define how a role's crash output reaches the crash tmpfs, or remove the crash root and state that crash capture is disabled. |
| T18-I3 | Important | `tests/unit/storage_test.py:347-360`, `:46-66`; `guest/storage.py:524-527` | yes | **The deletion-scope test is vacuous.**<br>• `outside` (line 348) is never placed in the filesystem double, so `outside.size == 99` cannot fail.<br>• Each root has its own private parent node, so "parents empty" holds even if cleanup deletes siblings.<br>• **M18-2**: cleanup deletes every sibling under each root's parent; 14/14 pass.<br>• **M18-1**: drops the device check during removal; 14/14 pass.<br>`deletion_owned_scope_only` therefore binds nothing about scope. | Model a shared `/run/acceptance` parent holding all five roots plus an outside sibling. Add a device-drifted child and a symlink or file planted *after* admission. Assert the outside nodes survive and cleanup reports incomplete. |

### Minor

| ID | Sev | File:line at HEAD | At HEAD | Evidence | Suggested fix |
|---|---|---|---|---|---|
| T11-M1 | Minor | `guest/intake.py:235-236`, `:252`, `:275`; `SerialConsole.swift:153-154`, `:179` | yes | `TCSANOW` with no flush, and only ECHO/ECHONL cleared. Probe P11-D: typed-ahead `typed-ahead-before-prompt` (echoed before mute) is merged into the credential. While muted, ISIG and ICANON stay on. A failed intake leaves pending input in the TTY queue for the next reader. | Use `TCSAFLUSH` to mute and `tcflush(TCIFLUSH)` on exit. Set the expected `c_lflag` explicitly (ICANON on, ISIG and IEXTEN off) on both sides. |
| T11-M2 | Minor | `guest/intake.py:205`; `SerialConsole.swift:171` | yes | In canonical mode the 4096-byte bound is unreachable. Linux n_tty silently truncates a line after 4095 chars (termios(3)); the macOS host limit is MAX_CANON 1024. Over-long input is silently truncated rather than failed, contrary to the plan's "fail rather than truncate". It costs the single login attempt. | Use non-canonical reading on the guest, or detect a full line buffer and fail. Document the host limit. |
| T11-M3 | Minor | `guest/intake.py:181-215`, `:162`, `:166`; `SerialConsole.swift:159`, `:170`, `:174` | yes | The plan accepts that zeroization cannot be guaranteed, but the code adds avoidable plaintext copies:<br>• `value.decode()` makes an immutable `str` copy;<br>• `bytes(value)`, concatenation and `frame[offset:]` copy per write;<br>• `bytearray.extend` growth reallocates;<br>• the partial `value` is never zeroed on any `_read_credential` failure path, because the outer `value` is still `None`;<br>• Swift `String(data:)` copy and `Data.append` growth.<br>The `finally` zeroing loop gives an impression the code does not deliver. | Preallocate a 4097-byte bytearray. Validate UTF-8 incrementally. Write from a memoryview. Zero on every path. Keep the no-guarantee wording next to the zeroing code. |
| T11-M4 | Minor | `guest/intake.py:238-251`, `:270-284`; `SerialConsole.swift:155-156`, `:111-120` | yes | Probe P11-C: a second SIGINT during the `finally` restore leaves echo **off**, leaves `consume_credential.<locals>.cancel` installed process-wide, and escapes as a raw `_SignalCancellation`.<br>Other gaps:<br>• handlers are installed only on the main thread;<br>• SIGHUP, SIGQUIT and SIGTSTP are not handled;<br>• the host sets O_NONBLOCK on the shared TTY description, which stays set if the process is killed. | Block SIGINT/SIGTERM (`pthread_sigmask`) during cleanup and restore termios before handlers. Restore O_NONBLOCK first. Document the residuals for unhandled signals. |
| T11-M5 | Minor | `guest/intake.py:65-110`; `guest/topology.py:1067-1078` | yes | One-use applies per grant object only. Probe P11-B: two `IntakeGrant.issue` calls for the same run and child give two successful consumes. `AdmissionProof` is an unsealed dataclass (sibling topology types use `_seal`). Intake accepts any instance by type and matching run, manifest and config; it never checks `canonical`, `handoff`, digests or sequence. | Record one grant per run binding (a run-scoped latch) and require a sealed proof minted only by `admit_topology`. |
| T11-M6 | Minor | `guest/intake.py:226`; `SerialConsole.swift:132`, `:150` | yes | The checks are `isatty` only:<br>• no approved-console device identity (major/minor or `ttyname`);<br>• no `TIOCEXCL`;<br>• recording or unattended input (for example a PTY-driven automation or `script -k` on the host) is undetectable.<br>Design §8's "reject … unattended/recording input" is therefore a residual that the code does not document. | Check the console device identity and set `TIOCEXCL` during intake. Record the recording-input residual explicitly. |
| T11-M7 | Minor | `guest/intake.py:45-49`; `intake_test.py:189-191`; `SerialConsole.swift:25`, `:181` | yes | `ConsumeResult` carries the credential byte length, and the RF5 test treats `repr(result)` as public output. Design §8 keeps lengths in guest memory only. `schema.json` `PublicRecord` has no such field today, so it is not publishable yet. | Classify `byte_length` as PRIVATE_MEMORY, or drop it from the result. |
| T11-M8 | Minor | `SerialConsole.swift:171`; `guest/intake.py:125-131`, `:159-175` | yes | Three small defects:<br>• Swift reports oversize as `.invalidGrant` (wrong code);<br>• the Python sink does not hex-validate `child_id` (Swift does);<br>• a 4100-byte frame exceeds PIPE_BUF, so a nonblocking partial write can leave a truncated credential prefix in the pipe before `SINK_FAILED`. | Use a credential-specific code. Validate hex. Make the frame atomic (≤ PIPE_BUF) or write it whole. |
| T12-M1 | Minor | `guest/state.cjs:182-185`, `:92-112` | yes | DONE is not terminal. Probe P12-D: any stray event after DONE (and after `PUBLISH_RESULT`) gives `FAILED/INVALID_FRAME`, resets `cleanupComplete=false` and emits `CLEANUP` again. Once the old cleanup window has passed, the state can never return to `cleanupComplete=true`. This is conservative, but the state now contradicts the already-published result. | Make DONE absorb non-`readResult` events with no effect, or record a separate post-terminal anomaly flag. |
| T12-M2 | Minor | `guest/state.cjs:170-180` | yes | Cleanup outcome is not sticky. Probe P12-E: `cleanup FAIL` then `cleanup PASS` gives `cleanupComplete=true`. After `FINALIZE FAIL` → `CLEANUP_INCOMPLETE`, a later cleanup PASS makes `cleanupComplete=true` contradict the failure code. Whether cleanup events are retries is unspecified. | Accept one cleanup outcome, or latch the first FAIL. |
| T12-M3 | Minor | `guest/state.cjs:187-193`, `:130`, `:221` | yes | Deadlines are evaluated only when an event arrives, and no tick event exists. Probe P12-F: every non-phase event fails. The interpreter must therefore abort on its own timers. `sessionExpiresAtMs` (server expiry) is compared to the injected monotonic `nowMs` with no stated conversion. | Add a no-op `tick` event, or document that Task 22 owns timers. Specify the clock domain of `sessionExpiresAtMs`. |
| T18-M1 | Minor | `guest/storage.py:29-34`, `:476-481`, `:510-513` | yes | `_fail()` raised inside `except` keeps the native exception as `__context__`, and `__suppress_context__` is False. Probe `probe_storage_chain.py`: the default traceback text includes a crash filename (`True`). The docstring says the failure "cannot include a private path or filename". | Raise outside the `except` block, or clear the context; test that formatted tracebacks hold no names. |
| T18-M2 | Minor | `guest/storage.py:585-609` | yes | Cleanup stops at the first non-conforming root. Probe P18-B: an unexpected 0644 file in the controller root leaves the browser, verifier, proxy and crash roots unremoved. The result is honestly reported as `CLEANUP_INCOMPLETE`, but cleanup is not best-effort. | Continue across roots and aggregate a sticky incomplete result. |
| T18-M3 | Minor | `guest/storage.py:197`, `:539-541`, `:285-338`; signatures `:424`, `:494` | yes | Three gaps:<br>• **Unbound checks:** gid check (M18-3 survives); the removal re-stat is masked by the double's own identity check (M18-4 survives).<br>• **No depth bound:** recursion relies on `RecursionError` → `STORAGE_INVALID`.<br>• **Signatures:** `admit_storage(manifest, filesystem, kernel_port)` and `crash_aggregate(root_fd, *, proof)` differ from the plan's interfaces. That is acceptable for injected ports, but undocumented. | Add a gid-only test and a removal-time swap test. Add an explicit depth cap. Note the interface amendment. |

**Count:** 0 Critical, 10 Important, 14 Minor.

## 4. Plan-required items

### Task 11 (named tests and behaviours)

| Item | Status |
|---|---|
| `nonTTY_redirect_reject` (Python and Swift) | Present and correct for a pipe. It does not cover redirected or automated PTYs (T11-M6). |
| `argv_env_file_clipboard_not_sources` (Python) | Present and correct. This is a signature and positive check. |
| `wrong_run_consumer_destination_expiry_second_consume_reject` (Python and Swift) | Present and correct for a single grant. A second grant for the same run is accepted (T11-M5). |
| `cancelled_signal_exception_restore_both_echo` (Python and Swift) | Present. Each side tests its own TTY only. Restore of handlers, late signals and terminal loss are unbound (T11-I2, T11-M4). |
| `synthetic_canary_absent_from_host_output_and_evidence` [RF5] | **Present but incorrect.** It does not observe the PTY master or fd-level output; mutants M11-1 and M11-2 survive (T11-I2). |
| `raw_console_ANSI_OSC_reject` (Swift) | Present for ESC/BEL in receipts (static review only; Swift not run). |
| `broker_fd_inventory_no_TTY` (Swift) | **Present but incorrect.** It checks caller-authored facts only (T11-I2). |
| `automation_child_no_console_access` (Python and Swift) | **Present but incorrect.** No child and no real inventory (T11-I2). |
| Consume grant atomically before fill | Present and correct: `claim()` runs before read. M11-6 is killed, slowly. |
| Intake alone owns the TTY; automation gets only the private pipe | Not demonstrated. Unwired, no TIOCEXCL, no device identity (T11-M6). |
| Host attaches anonymous pipes, not raw stdout | **Missing.** The host frame format is incompatible with the guest (T11-I3). |
| No credential to logs, exceptions or files | **Incorrect for exceptions** (T11-I1). Logs and files: no write found. |
| Restore handled signals; stop on terminal loss | Behaviour present (probe: `TERMINAL_LOST` in 0.11 s). Late-signal restore defect (T11-M4). Tests unbound (T11-I2). |
| Bounds (4096) | **Ineffective in canonical mode** (T11-M2). Untested (M11-3). |
| No zeroization claim beyond plan | The code does not claim erasure, but it adds avoidable copies (T11-M3). |

### Task 12

| Item | Status |
|---|---|
| `all_eleven_states` | Present and correct. |
| `invalid_transition_fails` | Present. Only one case (`observeAfter` in PREFLIGHT). |
| `duplicate_consume_second_login_fail` | Present and correct. |
| `hold_route_denied` | Present and correct. |
| `receipt_outside_hold_fail` | Present and correct. A REJECTED receipt *inside* HOLD is untested (M12-7). |
| `failed_only_safe_cleanup_logout` | Present. The effect is emitted but cannot be admitted (T12-I3). |
| `outage_restart_cannot_resume` | **Present but incorrect.** One phase only, and restart is not exercised (T12-I4, M12-4). |
| `20min_run_10min_hold_120s_intake_60s_cleanup_deadlines` | Present for intake, hold, run (PREFLIGHT only) and FAILED cleanup. The FINALIZE cleanup deadline is unbound (M12-1). Limits equal the plan values. |
| `session_expiry_no_reauth` | Present for OBSERVE_BEFORE. HOLD and LOGOUT are unbound (M12-3). No reauth: correct. |
| `cleanup_success_cannot_erase_failure` | Present and correct for the run failure. The cleanup outcome itself is not sticky (T12-M2). |
| Pure reducer, fixed effects, no debug commands | Present and correct: closed event set, frozen outputs. |
| Sticky failure separated from cleanup progress | Present. |
| Closed transitions fail-closed | The code is correct; the tests do not bind it (T12-I1). DONE is not terminal (T12-M1). |

### Task 18

| Item | Status |
|---|---|
| `readonly_base_all_writable_tmpfs_no_swap` | Present and correct over the injected kernel facts. |
| `0700_dirs0600_files_correct_uid` | Present. The gid half is unbound (M18-3). |
| `unreadable_empty0600_wrong_owner_fail` | Present over the double. Readability is not tied to the actual UID (T18-I1). |
| `symlink_hardlink_path_swap_fail` | Present and correct for admission. Removal-time swap is unbound (M18-4). |
| `crash_open_content_raises_if_called` | Present and binding: M18-5 is killed with 8 errors. |
| `1MiB_crash256MiB_run_bounds` | Present and correct. Values equal the design and manifest (256 MiB, 1 MiB, shm 64 MiB, inodes 1024–65536). |
| `host_share_or_disk_backed_path_fail` | Present and correct. |
| `deletion_owned_scope_only` | **Present but vacuous** (T18-I3). |
| `host_residue_not_claimed_erased` | Present and correct: `host_residue_erased` is always False. |
| Descriptor-relative no-follow operations | **Delegated** to an injected port that does not exist. The guest test is a shell that raises `NATIVE_STORAGE_PORT_UNAVAILABLE`. The plan defers runtime proof, so this is not a pass. |
| Each role scans its own scope; no root-owned marker | **Missing** (T18-I1). |
| Crash traversal: metadata only, no published filenames | Content-open is avoided and binding. Filenames can leak via the exception chain (T18-M1). |
| /dev/shm manifest-bound | Bound to the global /dev/shm only, not the role-visible one (T18-I2). |
| No secret written to storage | Correct. The module writes nothing, and the public `CrashAggregate` carries counts, bytes and the policy digest only. |

## 5. Checks run

All checks ran on a pristine copy at `$R/base` (`git -C <worktree> archive HEAD | tar -x`). Each mutant ran in a fresh copy that was then removed.

- **Toolchain:** Python 3.12.2 (`/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12`), Node 24.21.0 (`/Users/Matt/day-trader-toolchains/node-v24.21.0-darwin-arm64/bin/node`). Swift was not run, per the brief.
- **Baseline commands** (from `$R/base`):
  - `TMPDIR=…/tmp/producers/ PYTHONDONTWRITEBYTECODE=1 python3.12 -B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p intake_test.py -v` → 6/6 OK.
  - Same command with `-p storage_test.py` → 14/14 OK.
  - `node --test tooling/production-acceptance/tests/unit/state.test.cjs` → 10/10 pass.
  - Logs: `$R/logs/baseline-*.log`.
- **Mutation tooling:** `$R/scripts/mutate.py` and `$R/scripts/mutate_multi.py` (exact-string replacement; old and new texts in `$R/mutants/<id>.old|.new`), run by `$R/scripts/run_mutant.sh`. Logs: `$R/logs/mutant-<id>.log`.

| Mutant | Change | Result |
|---|---|---|
| M11-1 | Echo credential to the TTY | survives (6/6) |
| M11-2 | Write credential to fd 2 | survives (6/6); leak visible in log |
| M11-3 | Bound set to 10⁹ | survives |
| M11-4 | Signal handlers never restored | survives |
| M11-5 | ECHO never cleared | killed only after a 249 s hang (`EXPIRED != SINK_FAILED`) |
| M11-6 | Grant claimed after read | killed after 121 s (`EXPIRED != ALREADY_CONSUMED`) |
| M11-7 | Terminal loss ignored | survives |
| M12-1 | No FINALIZE cleanup deadline | survives |
| M12-2 | Failure overwritten in FAILED | survives |
| M12-3 | No HOLD/LOGOUT expiry | survives |
| M12-4 | Outage ignored outside OBSERVE_BEFORE | survives |
| M12-5 | DONE accepts any event | survives |
| M12-6 … M12-15 | Each negative gate opened | each survives |
| M12-ALL | All ten gates opened | survives 10/10; drives an all-failing run to DONE |
| M18-1 | No removal device check | survives |
| M18-2 | Delete siblings | survives |
| M18-3 | No gid check | survives |
| M18-4 | No removal re-stat | survives |
| M18-5 | Crash files content-opened | killed (8 errors) |

**Probes** (pristine code, synthetic values only):
- `$R/scripts/probe_intake.py` (P11-A exception context, P11-B two grants, P11-C late signal, P11-D typeahead) → `$R/logs/probe_intake.log`.
- `$R/scripts/probe_sink_failure_frames.py` → `$R/logs/probe_sink_failure_frames.log`.
- `$R/scripts/probe_host_guest_framing.py` → `$R/logs/probe_host_guest_framing.log`.
- `$R/scripts/probe_terminal_loss.py` → `TERMINAL_LOST` after 0.11 s.
- `$R/scripts/probe_state.cjs` (P12-A … P12-F) → `$R/logs/probe_state.log`.
- `$R/scripts/probe_all_fail_chain.cjs` → `$R/logs/probe_all_fail_chain.log`.
- `$R/scripts/probe_storage.py` (P18-A Task 8 layout, P18-B partial cleanup) → `$R/logs/probe_storage.log`.
- `$R/scripts/probe_storage_chain.py` → `$R/logs/probe_storage_chain.log`.

The known `termios` "Bad file descriptor" noise did not appear in my intake baseline. No network, install, VM, browser, signing or Swift action was taken. The worktree was clean at `132b67e` before and after.

## 6. Declined to judge

- **Swift `ConsoleTests` behaviour.** I did not run it (brief forbids Swift); my review was static. The brief records 181/181 at `0f87065`.
- **Real guest console behaviour.** Not executed: whether hvc0 is the intake's controlling terminal, ISIG delivery, n_tty truncation and `console=hvc0` interleaving. T11-M1 and T11-M2 rely on termios(3), not on a guest run.
- **The absent native `GuestStoragePort`/`KernelPort`.** I cannot judge real no-follow and `unlinkat` race semantics, `rmdir` on a tmpfs mount point (likely `EBUSY` for the `/run/acceptance/crash` mount), or readability as the role UID.
- **`Contracts.decode` strictness** for C1 controls (U+0080–U+009F) in receipt and public strings. That belongs to the Task 1 review.
- **The `"BROWSER"` pipe consumer** (Task 13/14 browser worker). I did not judge whether it validates the length prefix, handles a truncated frame or closes the pipe.
- **Clock-domain conversion of `sessionExpiresAtMs`.** That is Task 14/22.
- **"Durable records stay consistent on crash"** for Task 18. Not applicable: `storage.py` writes no durable record, and proof state is in-memory and single-use. Durable accounting belongs to Tasks 4, 20 and 21.

## 7. Notes for the whole-M4 review

1. **Nothing is wired.** None of the Task 11, 12 or 18 modules is reachable from a runtime entry point at `132b67e`. Every GREEN result here is offline unit evidence only; the plan itself says "earlier pure GREEN is not an integration claim".
2. **Composition contradictions.** Each needs an owner before Task 22:
   - host↔guest credential framing (T11-I3);
   - reducer↔`routes.json` P phase (T12-I2);
   - reducer `SAFE_SIGN_OUT`↔admission (T12-I3);
   - storage↔Task 8 view layout, the crash root unreachable from role views, and the role /dev/shm on the run device (T18-I2).
3. **Task 10 `AdmissionProof` is unsealed and caller-constructible**, while sibling topology types use `_seal`. Task 11 trusts it by type (T11-M5). Check every consumer of `AdmissionProof`.
4. **`DescriptorFacts.uid`** from `EgressBroker.swift:921` is the descriptor's *file owner* (`st_uid`), not the holding process. `SerialConsole`'s `uid == childUID` match (`SerialConsole.swift:133`) can never hold for launcher-created pipes.
5. **Exception-context hygiene, repeated pattern:** `raise X from None` still retains `__context__`, and `except Exception: _fail()` retains and *prints* it. Audit `protocol.py`, `proxy.py`, `topology.py` and `confinement.py` for chained private data such as filenames, payloads and credential bytes.
6. **Kernel console shares the operator channel.** `VMConfiguration.bootCommandLine` is `console=hvc0`, the same virtio console used for intake and public frames. Kernel and `/dev/console` output share the operator channel, so the Task 20 receiver must discard non-frame bytes without recording them.
7. **Restart non-resumption** (design §18, matrix N17–N19) cannot be provided by the pure reducer (T12-I4). It must be owned and tested in Tasks 21–23 together with the durable full-run reservation.

# Stage 1 remediation contract

Additive to the design, original plan and composition amendment, which stay byte-identical; approval covers design direction only.

This contract is normative for tasks 2-18 of `docs/superpowers/plans/2026-11-17-stage1-remediation.md`. It restates owner decisions E1-E7 (`docs/STAGE1_REMEDIATION_DECISIONS.md`, APPROVED 2026-11-17, option A throughout) and the plain bugs listed there as "Not owner decisions". It widens no decision and does not change the design's threat model (`docs/PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md` section 4), the PAPER-only rules, or the rule that real native execution stays behind Stage 2 approval. Each clause has four parts: old requirement, decision, reconciliation, owning task. Rulings P1-P31 from the pre-flight scan are listed in the appendix and cited in the clauses they change.

## C1. Cleanup budget (E7)

- **Old requirement:** Composition amendment section 5 (one absolute end allocated at first terminal cleanup, `start+60000ms`; receivers never renew it); design section 20 (finalization and VM cleanup). As built, the shared 60 s window opened during normal probing, and Python, JS and Swift each started it under a different rule, contrary to section 5 (review findings CA-I1, CB-I1).
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

- **Old requirement:** Original plan (2026-09-30) Task 10: the topology proof binds an expiry, and there is no freshness mechanism. Composition amendment section 3 (a monotonic value never crosses host/guest clock domains) and section 5 (never compares guest monotonic timestamps to host time) are the rules the as-built code violates: the host compared guest-reported wall and monotonic times with host time within 1 ms (`VMHost.swift:778-780`, `:1091-1093`, `:1157-1159`; `topology.py:2199`, `:2604-2606`; task10-report T10-1, T10-7). The two clocks are separate, so that check could never pass.
- **Decision:** E2, option A. T10-7 (the 1 ms legacy capture bound) is a plain bug fixed here.
- **Reconciliation:**
  - The host challenge is `hostChallenge`: 16 random bytes as 32 lowercase hex characters, one use.
  - Initial deadline 120000 ms; current deadline 2000 ms. Both are measured on host monotonic time only.
  - `observedWall` and `observedMonotonic` are guest-local and never compared with host clocks.
  - Guest observation window: 100 ms.
  - R4: these three values are plan-chosen and were accepted by the reviewers. Stage 2 may tighten them; it may not widen them without a new decision.
  - Internal guest currents carry no challenge; the host rejects a handoff without `hostChallenge`.
  - P6: `hostChallenge` is covered by the handoff MAC but excluded from the stable topology digest on both host and guest.
- **Owning task:** Task 3.

## C3. Key derivation (E3, T10-10)

- **Old requirement:** Design sections 6.3 and 9.3 (the one-use run capability); composition amendment section 3 (distinct per-channel keys) and section 4.1, last paragraph (the v2 envelope MAC, which names no key). As built, the one run capability keys the handoff MAC and is also used for other purposes (`topology.py:1484`, `:2648`; `proxy.py` `_BOOTSTRAP_RULE.capability`; T10-10).
- **Decision:** E3, option A (with T10-10).
- **Reconciliation:**
  - `derive(capability, label) = HMAC-SHA256(key=capability, msg="acceptance:key-derivation:v1\0" ‖ label ‖ "\0")`.
  - Labels: `vsock-stream`, `topology-admission`.
  - The handoff MAC uses the `topology-admission` key.
  - The proxy receives only the `vsock-stream` key.
  - P10: the bootstrap passes `derive(capability, "vsock-stream")` to the proxy entry as an explicit argument. The proxy never receives the capability.
- **Owning task:** Task 3 (derivation and handoff MAC); Task 6 (the proxy-entry producer).

## C4. vsock stream proof (E3)

- **Old requirement:** Design section 9.3 (private run capability; broker repeats run and sequence validation); original plan Tasks 5 (host broker, M2) and 9 (guest proxy). As built, the proxy's vsock "transport authentication" compared the binding with itself, and the M2 host broker used its own capability as the authenticated one (T9-3).
- **Decision:** E3, option A. This reopens accepted M2 broker code (`EgressBroker.swift`) under the owner's 2026-11-17 approval; the `55c115a` historical evidence exception is neither reopened nor generalized.
- **Reconciliation:**
  - Per stream, the host first sends a challenge frame: a 2-byte big-endian length (16) followed by 16 random bytes.
  - The guest answers with its control frame (2-byte length ≤ 256), then a proof frame (2-byte length 32, then 32 bytes).
  - `proof = HMAC-SHA256(k_vsock, "acceptance:vsock-stream:v1\0" ‖ nonce ‖ runId (32 ASCII hex) ‖ sequence (8-byte big-endian))`.
  - The broker verifies in constant time before sequence admission. A mismatch latches the whole run as `identity`.
  - P39: the proof authenticates the stream (nonce, runId, sequence), not the control payload.
  - P38(a): the broker admits strictly increasing sequences with gaps. A guest stream closed before its control was delivered leaves a gap. A repeated or decreasing sequence latches `replay`. Each sequence is used once, and the proof still binds it.
- **Owning task:** Task 6.

## C5. Proxy authority (E4)

- **Old requirement:** Composition amendment sections 6 and 6.1 (finite inherited proxy protocol; in-process `ProxyRuntimeOwner` consumed by the composition). A confined PROXY child cannot hand that object to the bootstrap (CB-I2).
- **Decision:** E4, option A.
- **Reconciliation:**
  - The bootstrap observes `/proc/<proxy-pid>/fd/*` and `fdinfo/*`, and cross-checks them against the proxy's MAC'd runtime report on the existing v2 FD3/FD4 channel.
  - Order: report A, then `/proc`, then report B. Accept only if all three are equal and B's sequence is A's plus 1.
  - The proxy loop never runs in the bootstrap process.
  - The in-process `isinstance(proxy_owner, ProxyRuntimeOwner)` gate is replaced, not kept beside the new authority (R11).
  - Report rows (reconciles amendment section 6, whose `ProxyRuntimeObservation.currentFDs` used section 4.1's rows): the proxy's report rows are exactly `{fd, kind, device, inode, flags, tfds}`. `ownerId` and `acquiredGeneration` are minted by the bootstrap's ledger, not by the proxy. The `roleRuntime` rows sent to the host keep amendment section 4.1's shape.
- **Owning task:** Task 7.

## C6. Per-role seccomp (E1)

- **Old requirement:** Design section 9.2 and original plan Task 8. As built, the outer filter denied more than section 9.2 requires, so Chromium's namespace sandbox very likely could not start (T8-06).
- **Decision:** E1, option A, narrowed by R1: only the decision's explicit allow list is allowed; the other denials stay.
- **Reconciliation:**
  - The BROWSER deny list is the base list minus `chroot`, `capset`, `setuid`, `setgid`, `setreuid`, `setregid`, `setresuid`, `setresgid`, `setfsuid`, `setfsgid` and `setgroups`, leaving 13 entries.
  - `mount`, `umount2`, `pivot_root`, `setns`, `mknodat` and `pidfd_open` stay denied for BROWSER (R1). `unshare`, `clone` and `clone3` were never filtered; tests bind that BROWSER allows them (R2).
  - BROWSER seccomp filter flags are exactly {0, TSYNC, SPEC_ALLOW, TSYNC|SPEC_ALLOW}.
  - Other roles are unchanged.
  - No `NEW_LISTENER`, TRACE or USER_NOTIF.
  - Stage 2 must show the sandbox starts on a real VM.
  - E-1 (finding 2026-11-19; owner: 'Add the task now'): a chroot-based view blocks E1, because Linux 6.8 refuses a user namespace to a chrooted caller (kernel/user_namespace.c:104-106). Every role now enters its view by pivot_root inside its private mount namespace: self-bind of the view root, `pivot_root(".", ".")`, `umount2(".", MNT_DETACH)`, before seccomp. No role calls chroot. R1 is unchanged. (Task 8b)
  - E-1b: after the browser transition reaches ACTIVE, a successful `unshare` whose a0 is exactly `CLONE_NEWUSER`, or a successful `chroot`, by a BROWSER-family pid other than the transition root, is admitted without an event. Every other successful audited namespace/mount/device call still drifts, and is terminal while a transition exists. This reconciles composition amendment §7 ('namespace … mutation fails') for these two calls only. Decided in Task 8b; implemented in Task 11 (P-new-11a/11b).
  - Owner decision 2026-11-20 ("Allow IPPROTO_TCP"): BROWSER may open AF_INET/AF_INET6 SOCK_STREAM sockets with protocol IPPROTO_TCP, which selects the same protocol as 0. No other protocol value is admitted; no IPPROTO_UDP is admitted (the ABI inventory holds an IPPROTO_UDP record only so tests can show it is denied). Protocol-0 SOCK_DGRAM on AF_INET/AF_INET6 was already allowed for every role and is unchanged. Other roles are unchanged. (Task 8c)
- **Owning task:** Task 8 (P27: Task 10 relabels the two affected probes).

## C7. Per-role storage (E5)

- **Old requirement:** Design section 15 (per-role tmpfs storage scopes), original plan Tasks 8 (role views) and 18 (each role scans its own readable scope). As built, one caller admitted and deleted all five role roots across four UIDs, and the root model contradicted the Task 8 role-view layout (T18-I1, T18-I2).
- **Decision:** E5, option A.
- **Reconciliation:** Role scopes as seen inside each view:
  - `/run/acceptance/<role>`, `/tmp`, `/var`
  - `/dev/shm`: a per-role tmpfs of 67108864 bytes
  - `/run/acceptance/crash`: a per-role subdirectory of the 1048576-byte crash tmpfs

  Admission runs in the pre-exec helper under the role UID (R8). Cleanup runs in a fixed confined cleanup child. The bootstrap only sums metadata aggregates.
  - P16: /dev/shm is reclaimed by mount-namespace teardown, not unmounted by a parent. A test binds that.
  - P17: the storage-admission proof is a fixed 32-byte digest appended to the existing ready frame (new fixed length), validated by the bootstrap. The role list stays local to storage.
  - P17 scope (Task 14 review M-1): the digest binds the child's five scope roots, role and UID as the bootstrap itself sees them. It proves view agreement, not that admission ran: a probe family sends the same bytes, and no policy digest or admission result is bound. That admission ran before exec rests on `exec_role`'s fixed order, which tests bind.
- **Owning task:** Task 14.

## C8. Credential framing (E6)

- **Old requirement:** Design section 8 and original plan Task 11 (one-use no-echo intake). As built, the host sent a 4-byte length plus bytes and the guest read a newline-terminated line, so no credential could be delivered (T11-I3).
- **Decision:** E6, option A (also covering T11-I1 and T11-I2).
- **Reconciliation:**
  - Host to guest: a 4-byte big-endian length n (1 ≤ n ≤ 4096), then n bytes.
  - The guest reads in raw TTY mode set with `TCSAFLUSH` and `TIOCEXCL` (R10).
  - The host serial input carries no guest-role fields.
  - P26: no host-side sink check is dropped without a named replacement or a reviewer-accepted reason that the host can never observe it.
  - Operator cap (Task 12 review m5): the macOS host reads the operator's credential as one canonical terminal line, and Darwin's `MAX_INPUT` of 1024 caps it at 1023 bytes. A longer line never completes, so the consume ends `.expired`; it is never truncated. The wire and the guest still carry up to 4096 bytes.
  - Frame size (Task 18 fix wave F1, review B RB-I1): the controller-to-worker action channel escapes every UTF-16 unit above 0x7E as `\uXXXX`, so a non-ASCII credential reaches the worker byte-exact. The role-ports application pipe caps a frame at 16384 bytes including its 4-byte length prefix, so the usable frame body is 16380 bytes. A worst-case non-ASCII credential together with a non-ASCII username and owner id can exceed that. The controller then refuses the write (`FRAME_DENIED`): the credential is consumed and destroyed, and nothing reaches the worker or the backend. With an ASCII username and owner id, every C8 credential fits (fix-wave report, computed against `maxFrameBytes` 16384).
- **Owning task:** Task 12.

## C9. Contract changes from the plain bugs and recorded widenings

- **Old requirement:** Design sections 9.3 (proxy limits), 10 (route policy) and 17 (controller state machine); original plan Tasks 9, 12, 13 and 14; composition amendment section 3 (closed unions) for compB part-B note 5; Task 13 review note T13 m-2.
- **Decision:** the "Not owner decisions" list in the decisions doc (T9-1, T9-2, T12-I2, T13 I-1, T13 I-2, categories B and D), plus recorded amendments. These are plain bug fixes, not owner decisions.
- **Reconciliation:**
  - The proxy accepts one `Proxy-Connection: keep-alive` line (T9-1).
  - These close only that tunnel (T9-2):
    - idle;
    - client EOF before the header;
    - on the client socket only (P36), a read, write or shutdown failure whose errno is exactly `ECONNRESET`, `EPIPE` or `ENOTCONN`.

    Bytes stay charged. The tunnel's vsock stream needs a proven close; a failed close is whole-run `CLEANUP_UNCERTAIN`. Every other client errno, and every vsock or broker error, stays whole-run.
  - On the host broker (P38), these end only that slot:
    - (b) idle: the host first sends the guest a zero-length logical-EOF record, then ends the stream (on its relay lane, DATA `00 00` then END, P40), so a host-first idle close is an ordinary tunnel end on the guest;
    - (c) a guest stream that ends without a logical-EOF record: the launcher's END on its relay lane (P40) at any point, including before the control, inside the setup or a record, mid-tunnel, or while the slot is pending. A stream that ends before its proof is verified uses no sequence.

    Host whole-run causes remain identity or proof failure, a repeated or decreasing sequence (`replay`, C4), caps, protocol violations and broker errors. On a relay lane, a pipe EOF, a failed pipe write or a malformed lane record is whole-run `transport` (P40, reversing P39(b)); lanes never retire.
  - The whole-run latch stays for transport, broker or vsock loss, protocol violation, aggregate and run caps, and clock faults. The 1025th tunnel latches `CAPACITY`.
  - A 17th concurrent client is deferred, never latched (P35). While 16 tunnels are live, the proxy does not accept; the client waits in the kernel listen backlog and is accepted when a tunnel closes. Design section 9.3's 16-simultaneous cap is unchanged.
  - Per-run tunnel total: 1024. A tunnel is one vsock stream (one sequence), so the `firstSequence` ceiling is `MAX_SAFE_INTEGER - 1023` (P37(2), T9-8).
  - The reducer admits `budget` in PREFLIGHT and AWAIT_CREDENTIAL.
  - New state fields `sessionMaybeIssued`, `safeSignOutRouted`, `revocation`, `postTerminalAnomaly` and `cleanupFailed` (the sticky first cleanup failure; Task 13 review M6); internal events `safeSignOutRoute`, `safeSignOutResult` and `tick`.
  - P19: VERIFY_REVOCATION, FINALIZE and DONE `validState` = {`credentialConsumed`, `loginAttempted`, `sessionMaybeIssued`, non-null `sessionExpiresAtMs`, `authenticated===false`, `logoutAttempted`, `restartReceiptConsumed`}; VERIFY_REVOCATION PASS sets `revocation:'CONFIRMED'`.
  - The first navigation is `FRONTEND + '/login'` (T13 I-1).
  - Header policy: every non-browser-generated header goes to admission, and `authorization`, `proxy-authorization`, `x-*` and method-override headers abort locally (T13 I-2).
  - New fixed worker action `SESSION_READINESS`.
  - P20: `verifyGate(kind, handle, binding)` keeps its 3-argument form; readiness and owner handles are added. The brand registry stays in `receipts.cjs`; `isBrowserSession` is injected, not required.
  - Record-only: the as-built action catalogue `LOGIN_SESSION`/`SESSION_OBSERVATION` (T13 m-2) and the Task 13 `browserConfig`/`APP_WRITE`/`APP_POLL`/`APP_CHUNK` union widening (compB part-B note 5) are recorded as as-built amendments identified by the Stage 1 review (T13 m-2, compB note 5); content not separately reviewed.
  - Owner decision 2026-11-20 ("Move check to the bootstrap"; Task 16 E1): the BROWSER family's descriptor and status inventory is taken by the bootstrap as root, never by the uid-10002 worker. It inspects at LAUNCH (internally, on the worker's STARTED, before COMMIT_BROWSER returns ACTIVE), POST_LOAD (requested by the controller after READY, before any credential) and FINAL (requested by the controller before CLOSE). The controller's request is the fixed action `BROWSER_FAMILY` `{generation:1, point}` on its own composition channel, serialized with APP_WRITE/APP_POLL. The only result is `{point, ordinal, status:"CLEAN", members}`. Any other outcome is terminal at the bootstrap, and no result is sent. Each inspection is a bounded snapshot: the family is the PPid closure of two full `/proc` scans; sockets are attributed from the union of every member's own `/proc/<pid>/net` tables; a character or block device other than `/dev/null` is denied; at most 5 attempts, 50 ms apart, within 1000 ms and the run's deadline (at LAUNCH also the activation proof's). Only a vanished member or descriptor, an unattributed socket, or family churn between the scans is retried. The worker keeps only its own startup self-check. (Task 16c)
- **Owning task:** Tasks 5 and 6 (per-tunnel close, proxy and broker sides; proxy parsing), 13 (reducer), 15 (routing and headers), 16 and 17 (provenance, readiness and owner gates).

## C10. Native blockers carried to Stage 2

- **Old requirement:** Design section 22: synthetic and native qualification evidence is required before any real run.
- **Decision:** none. These have no offline fix. Records compA D-2.
- **Reconciliation:** the following stay open and are carried to Stage 2 unchanged:
  - boot `audit=1` (compA D-2)
  - `CONFIG_PROC_CHILDREN`, `CONFIG_IPC_NS` and `CONFIG_COMPAT` facts
  - the real Node FD inventory beyond `{0..4}`
  - fork from a multi-threaded bootstrap (Task 8 review note 5)
  - `filter_digest` read-back
  - a real Chromium sandbox start
  - Task 8b view: on the real guest the root is not the initramfs rootfs and its parent mount is not shared (fs/namespace.c:4216-4219, 4231-4234); pivot_root and the detach succeed; the outer helper performs no path lookup after its root moves into the view.
  - User namespaces: a BROWSER-family process can create one (no LSM refusal, kernel/user_namespace.c:117; ucount limit > 0, :94-96).
  - Chromium ASSUMPTIONS A1–A9 (task-8b design note) confirmed on the pinned Chromium. Any sandbox call outside the admitted set drifts the run and needs a new owner decision, never a silent widening.
  - the host VZ relay forwarding bytes only
  - C5 current checks under proxy traffic: a PROXY descriptor change between report A and report B is terminal (C5). Stage 2 must show that no current check runs while the proxy serves clients, or each such race ends the run.
  - P40 (owner decision "Redesign lanes now", 2026-11-18; launcher obligation (c) as amended by P41), the relay lane protocol between the Stage 2 launcher and the broker. It replaces P39 (i)-(iii); the offline broker implements the broker side.
    - Format: each of the 16 relay pipe pairs (fds 4..35) is a reusable lane that carries one guest vsock connection at a time. Every byte on a lane, both ways, is inside a lane record: type (1 byte) | length (2 bytes, big-endian) | payload. Launcher to broker: OPEN `0x01` (length 0), DATA `0x02` (1-16384, the connection's bytes verbatim), END `0x03` (length 0). Broker to launcher: DATA, END.
    - State machine:
      - IDLE to LIVE on OPEN. A stream is over on a side once that side has sent END and received END; the two ENDs may cross. The lane is then IDLE again.
      - The broker writes the challenge (as DATA) only after OPEN.
      - After its own END the broker reads that stream up to the launcher's END (P41). Guest records keep their length checks, and a violation is whole-run. Their payloads are discarded, never forwarded or read as the next stream's control or proof. Any byte after the guest's logical EOF is a protocol violation, whole-run.
      - After the launcher's END the broker writes no DATA for that stream, only its own END.
      - Guest records are reassembled from the DATA payloads; guest bytes are never read as lane records. The guest-visible C4 bytes are unchanged.
    - Per-slot (the run continues): the launcher's END at any point; the per-slot idle end (DATA `00 00` unless already written, then END); an END received during a pending resolve or connect. No sequence is used by a stream that ends before its proof is verified.
    - Whole-run `transport`: a pipe EOF or a failed pipe write on any lane (the launcher is gone; this reverses P39(b)); a malformed lane record (unknown type; OPEN or END with length > 0; DATA of length 0 or over 16384; OPEN while a stream is live or draining; DATA or END while IDLE).
    - Launcher obligations, for Stage 2 to implement and qualify:
      - (a) assign each accepted vsock connection to an IDLE lane and send OPEN; hold an accepted connection while no lane is IDLE;
      - (b) forward that connection's bytes only as DATA on its lane; send END on its close, reset, or any read or write error, then forward nothing more from it;
      - (c) (P41) on the broker's END, deliver the DATA received before it, then write nothing more to that connection; keep forwarding its bytes as DATA until it ends (close, reset or error); then send END (unless already sent) and close it;
      - (d) after its own END, discard broker DATA until the broker's END; never deliver one connection's bytes to another;
      - (e) a broker pipe failure fails the run and closes every connection.
  - Task 16c: the bootstrap holds effective CAP_SYS_PTRACE and CAP_DAC_READ_SEARCH (or CAP_DAC_OVERRIDE) in the initial user namespace for the whole run, and no LSM denies PTRACE_MODE_READ (Yama restricts ATTACH only). Otherwise every inspection is FAMILY_UNREADABLE (fail closed).
  - Task 16c Chromium ASSUMPTIONS A1–A10 (task-16c design note) confirmed on the pinned build. In particular, no family member holds a socket the tables cannot attribute (an unhashed TCP_CLOSE socket after a reset, or an unbound UDP socket), and launch and first-load churn settles inside the retry window. Either failure is a fail-closed FAMILY_DENIED or FAMILY_UNREADABLE.
  - Task 16c limits: each inspection is a point-in-time snapshot. A descriptor in flight in an SCM_RIGHTS message is invisible, and a process that starts and ends between inspection points is not inspected. An inspection holds the controller channel for up to 1000 ms; the native event-barrier cadence (C10, P60) must not run on that path (the browser commit already holds it longer). LAUNCH runs on the COMMIT_BROWSER path, after STARTED and before the commit's first event barrier, so the 100 ms health interval and the 1000 ms launch-pending bound apply to it. One attempt has no internal deadline, so a hold can overrun 1000 ms by up to one attempt; that fails closed, because a late result is never accepted. Stage 2 needs the concurrent barrier cadence (P60, Task 11 M-5). (Task 16c review E-1, M-3)
  - Task 16c residual: a thread with its own descriptor table (`unshare(CLONE_FILES)`, admitted for BROWSER), or a zombie thread-group leader whose other threads still run, holds descriptors that `/proc/<tgid>/fd` does not show, because it lists only the group leader's table (kernel/exit.c:741-756, fs/proc/fd.c:264, fs/file.c:1100-1102). This is the same class as SCM_RIGHTS in-flight descriptors. Reading every `/proc/<pid>/task/<tid>/fd` was not adopted because of the 1000 ms window. The view, seccomp and the audit exec identity remain the primary controls. (Task 16c review E-2, M-2)
  - Task 16c Stage 2 test: Linux answers `close()` on a socket with unread receive data with RST. If the proxy closes a client tunnel with unread data, Chromium's pooled socket goes TCP_CLOSE, which is unhashed and in no table (K9), so the next POST_LOAD or FINAL is FAMILY_DENIED. Stage 2 must test whether this happens (idle-tunnel closes against an inspection) and whether Chromium holds such sockets; the remedy may belong in the proxy's close discipline. (Task 16c review E-3)
  - **Collected at Task 18 (P84).** The items below come from the remediation ledger's CARRY items, the Task 18 fix wave and re-review, and the two Task 18 final reviews (review A: whole-M4 offline review; review B: M5–M7 review). Each names its owner and its source. All fail closed today unless stated otherwise.
    - **Audit event source, boot and appliance**
      - P86(c), a deliberate classification: a standalone `AUDIT_ANOM_ABEND` (1701) from any process ends the run as `ROLE_ABNORMAL_END`. Any crash of any process, Chromium helpers included, ends the run. Stage 2 measures whether normal Chromium operation crashes a helper. (Owner: Stage 2. Source: ruling P86(c); review A I-2.)
      - P88: each audit request from the event owner is exactly one `sendto(2)` on the NETLINK_AUDIT socket, addressed to `sockaddr_nl{nl_family=AF_NETLINK, nl_pid=0}`. The install groups' SYSCALL record must name `__NR_sendto` (206). Any other send call fails closed at install. (Owner: Stage 2 native event-source binding. Source: ruling P88.)
      - The exact install bodies (P86(b′)) assume the bootstrap keeps init_task's unset auid and ses: nothing writes its loginuid. (Owner: Stage 2 appliance init. Source: ledger CARRY after P88.)
      - They assume no LSM, so the records carry no ` subj=` field. (Owner: Stage 2 appliance kernel and boot configuration. Source: ledger CARRY after P88.)
      - They assume no `audit_backlog_limit=` boot parameter, so the old backlog value is 64. (Owner: Stage 2 boot configuration. Source: ledger CARRY after P88.)
      - They assume no AUDIT_SET runs before the event owner's. (Owner: Stage 2 appliance init. Source: ledger CARRY after P88.)
      - With boot `audit=1` the kernel holds every audit record logged before the event owner registers, not only the boot `AUDIT_KERNEL` record, and delivers them to the owner first, which ends the run. The appliance must ensure that no audit record other than the boot `AUDIT_KERNEL` record is logged before registration. (Owner: Stage 2 appliance init. Source: Task 18 re-review; ledger writer items from the re-review.)
      - Ack ordering: with NLM_F_ACK the kernel acks the owner's AUDIT_SET before kauditd flushes the held backlog. The native `audit_request` must tolerate the boot record and the install groups arriving interleaved with later replies; the P87 drain covers this. (Owner: Stage 2 native event-source binding. Source: ledger CARRY after P88.)
      - The P87 drain bound counts from the start of `_install`, so an install slower than 1000 ms ends `EVENT_INSTALL_INCOMPLETE`. Stage 2 measures install time. (Owner: Stage 2. Source: fix-wave report, Phase 3 concern 4.)
      - P92, native blocker: the composed admission path does not honour the P87 drain. `begin()` captures once right after install (`guest/topology.py:3583`), and `EVENT_PENDING` from the still-open drain (`:1297`) fails the run. Before the admission capture the composition must wait for the install drain to close within its 1000 ms bound, or `_install` must return only once the drain has closed. Until then every real run fails closed at admission. (Owner: Stage 2 native event-source binding. Source: ruling P92; re-review new breakage 1.)
      - P90: the install groups' SYSCALL a0–a3, items and task fields, the PROCTITLE text and the exact `exit` value are not checked in Stage 1 (`exit` > 0 only). Stage 2 tightens them once the native binding exists. (Owner: Stage 2 native event-source binding. Source: ruling P90.)
      - A task killed inside an audited syscall logs the record without `success=` or `exit=` (kernel/auditsc.c:1841-1849). The parser treats that as malformed, so the run ends in that rare case. (Owner: Stage 2. Source: Task 11 review M-3; review A §12.)
      - P65: the guest's `pid_max` is at least 32768 (the kernel default), so no pid number is reused within the 1024-serial window. (Owner: Stage 2 appliance kernel. Source: ruling P65.)
      - A SIGKILLed family member leaves no exit record, so its pid stays in the family. Reuse of that pid by a non-family process is terminal. Confirm natively. (Owner: Stage 2. Source: ledger Task 11 CARRY; review A §12.)
      - `family` still collects stale numbers (SIGKILLed members, members whose last thread ends with `exit`, late-thread rejoins), bounded by the run's process count. (Owner: Stage 2. Source: Task 11 re-review m-3.)
      - P60's launch-lag tolerance holds only while event barriers run at most 100 ms apart. The native continuous-observation cadence must keep that. (Owner: Stage 2 native event-source binding. Source: Task 11 review M-5; ruling P60.)
      - Native event-barrier latency counts inside the 100 ms guest observation window (C2, R4). (Owner: Stage 2. Source: Task 3 review minor; review A §12.)
      - A controller `TOPOLOGY_CURRENT` frame during launch lag still fails the role set. No JS sends it today. (Owner: Stage 2 composition. Source: ledger Task 11 CARRY.)
      - Tie the retained Chromium dev/inode identity to the kernel port's SHA-256-checked pin of the Chromium binary. (Owner: Stage 2 native kernel port. Source: ledger Task 11 CARRY; review B §5.4.)
      - The retained identity is MAJOR/MINOR of the audited `i_sb->s_dev` with `i_ino` (kernel/auditsc.c:2275-2276). It equals `stat` only with generic_fillattr, so the Chromium binary must not be on overlayfs. (Owner: Stage 2 appliance payload. Source: Task 11 review M-4; review A §12.)
      - After event install, any successful clone, clone3, execve or exit_group by CONTROLLER, VERIFIER or PROXY, or by the BROWSER root before commit, ends the run; thread creation is a clone3 record. Every role creates all its threads before WAITING (at least before install) and creates no process. The Node roles pre-initialize the libuv threadpool before WAITING. (Owner: Stage 2 and the authors of the unbuilt controller and verifier roles. Source: review A m-1.)
      - Chromium ASSUMPTIONS addition: the pinned build with Playwright's switches makes no successful `bind` or `listen` in the family (ProcessSingleton's `SingletonSocket` would) and execs no binary other than the pinned identity (a `chrome_crashpad_handler` launch would). Either is terminal under the event model. (Owner: Stage 2. Source: review A m-3.)
    - **Confinement, views and seccomp**
      - Nothing is stacked on `/` at role launch. `umount2(".", MNT_DETACH)` detaches only the top mount, so a mount stacked on `/` would leave the old root attached and the process chrooted (E-1 blocked). P47's exact mount-point multiset and P49's user-namespace probe catch it natively. (Owner: Stage 2 appliance init. Source: Task 8b review M3.)
      - For an unbound runtime, `waiting` means "exactly one seccomp filter", not an observed lifecycle state. (Owner: Stage 2. Source: Task 9 review M-1.)
      - "Exactly one filter" assumes no ancestor filter: the filter count is copied on fork (kernel/fork.c:1913) and incremented on attach (kernel/seccomp.c:919). `exec_role`'s pre-exec check accepts more than one filter, and nativeness is not carried on the wire. Stage 2 confirms that no ancestor filter exists. (Owner: Stage 2 appliance init. Source: Task 9 review M-8.)
      - The Stage 2 native embedding passes topology's own `_confinement()` module to `select_native_probe`. (Owner: Stage 2 native embedding. Source: ledger Task 9 fix round 1 CARRY.)
      - The bootstrap family inspection accepts a CLEAN result from any kernel object that has `inspect_browser_family`, and the result carries no native or offline label. The composition must require `type(kernel) is NativeKernelPort` before a CLEAN result counts as run evidence. (Owner: original-plan Task 22 and Stage 2. Source: review B RB-M8.)
      - The fixed 2000 ms role start step covers, for BROWSER, Node plus `require('playwright')` before WAITING, with no measured margin on a cold VM page cache. A slow start fails closed (`ROLE_START_FAILED`). Stage 2 measures it. (Owner: Stage 2. Source: review A m-5.)
      - Two clocks in the routine step: the 2000 ms routine step fails closed when used in full, and `_ProbeFamilyOwner.stop_owned` bounds it with `b.monotonic()` while `routine_call` uses the budget clock. (Owner: Stage 2. Source: Task 2 review minor; review A §12.)
      - WAIT_EXIT caution (P56): WAIT_EXIT starts the shared cleanup end without terminalizing. No production caller uses it today. No routine role exit may use WAIT_EXIT; keep it cleanup-only or make it terminal, or CA-I1 returns. (Owner: composition, original-plan Tasks 21–22, and any later task that handles a role exit. Source: Task 2 review minor; ruling P56; review A §12.)
      - Task 16b (P71) now declares CONFIG_PROC_CHILDREN in the v2 kernel-feature lists, so the open CONFIG_PROC_CHILDREN item in this clause is the real kernel's correspondence. `guest/confinement.py` still reads a `children` file. (Owner: Stage 2 appliance kernel. Source: review B RB-M2; ruling P71.)
    - **Probe catalogue**
      - The foreign-process fixture really sits in each probe family's PID namespace. (Owner: Stage 2. Source: ledger Task 10 CARRY.)
      - SOCK_STREAM-only connects fail closed with EPROTOTYPE on other socket types. (Owner: Stage 2. Source: ledger Task 10 CARRY.)
      - A fresh family's `/proc` lists only its own pid. (Owner: Stage 2. Source: ledger Task 10 CARRY.)
      - recvmsg writes back the control-message length. (Owner: Stage 2. Source: ledger Task 10 CARRY.)
      - AArch32 sample behaviour with and without CONFIG_COMPAT (P53). (Owner: Stage 2. Source: ledger Task 10 CARRY; review A §12.)
      - The `SECCOMP_ARCH_KILL` branch is unreachable natively with a pure AArch32 sample, because the filter kills any non-AArch64 syscall before the sample writes its marker. That is fine on the target, which has no AArch32 EL0, and fails closed elsewhere. (Owner: Stage 2. Source: Task 10 re-review m-1.)
      - A controller-UID process exists in every console and theft family's PID namespace (P52 amended). (Owner: Stage 2. Source: ledger Task 10 fix round CARRY.)
      - `confirm_reachable` is answered from outside the family (P54). (Owner: Stage 2. Source: ledger Task 10 fix round CARRY.)
    - **Proxy, broker, topology and descriptors**
      - The epoll fdinfo `tfd:` line format and the `anon_inode:[eventpoll]` link are unreviewed kernel facts. (Owner: Stage 2. Source: Task 7 review M6.)
      - On Linux, CPython 3.12.2 `os.listdir(fd)` lists through its own private dup of the fd; the listing excludes exactly that predicted number (P43 amended). A wrong prediction fails closed. (Owner: Stage 2. Source: ruling P43 amended; Task 7 review.)
      - PROXY READY/TERMINAL latency, and that EXITED means reaped, are native facts to confirm. (Owner: Stage 2. Source: Task 7 review.)
      - The legacy `activateBrowser` in `host/Sources/AcceptanceCore/VMHost.swift` has no `composition != nil` guard. It is unreachable while every public `bootstrapCheck` throws. Guard or delete it when a native constructor arrives. (Owner: Stage 2 native host constructor. Source: Task 3 review minor; review A §12.)
      - A `lo` bounce adds the metric-256 `::1` prefix route, and admission then fails closed. Stage 2 confirms whether the appliance kernel sets CONFIG_IPV6_MULTIPLE_TABLES (both layouts admit). (Owner: Stage 2. Source: Task 4 review minor; review A §12.)
      - T10-11 is unsettled: no topology current check after the browser's first network use. `_network_rows` refuses every TCP state other than LISTEN and ESTABLISHED, so a host current check after the first tunnel closes (TIME_WAIT, FIN_WAIT) is `OBSERVATION_DENIED`. (Owner: composition, original-plan Tasks 21–22, and Stage 2. Source: review A m-4; T10-11.)
      - A real Chromium TCP connect through the proxy, and Chromium's behaviour with no IPPROTO_UDP. Protocol-0 SOCK_DGRAM stays admitted for every role (C6). (Owner: Stage 2. Source: ledger Task 8c CARRY; Task 8c review m-3.)
    - **Storage and payload**
      - The appliance init mounts the bootstrap's 1 MiB crash tmpfs at `/run/acceptance/crash` (size=1024k, a directory per role) before the bootstrap starts. `check_appliance` refuses every spawn without it, probe families included. (Owner: Stage 2 appliance init. Source: Task 14 review E-1.)
      - No native storage port exists, so native `storage_ports()` and `observe()` return `NATIVE_STORAGE_PORT_UNAVAILABLE`, and every native role start and cleanup fails closed until one exists. Probe families are unaffected. (Owner: Stage 2. Source: Task 14 review E-2; ledger Task 14 CARRY.)
      - The appliance payload ships and pins every guest module the bootstrap and the worker import: `storage.py` and `protocol.py` beside the bootstrap, and `observation.cjs` for the worker. (Owner: Stage 2 appliance payload. Source: Task 14 review E-3; Task 17 review m-7; review B §5.4.)
      - Native cleanup of any role-owned directory without owner read permission needs `O_PATH` plus `fchmodat2`/`AT_EMPTY_PATH`, through ABI-PIPELINE when the native port is written. A native `list_names` must exclude `.` and `..`. (Owner: Stage 2 native storage port. Source: Task 14 review E-4 and M-9; review B §5.4.)
      - Nothing creates `/run/acceptance/browser/{profile,support,cache}`, which the worker sets as Chromium's `HOME`, `TMPDIR` and `XDG_CACHE_HOME`. Stage 2 confirms Chromium 145 starts without them, or the worker creates them (0700) before launch. A failure is a fail-closed `LAUNCH_FAILED`. (Owner: Stage 2. Source: review B RB-M5.)
    - **Credential intake (C8)**
      - The operator's credential is at most 1023 bytes on the macOS host (canonical line limit; C8). (Owner: Stage 2 operator procedure. Source: ledger Task 12 CARRY; review B §5.4.)
      - A host-side check that no other host process holds the serial-input read end (`proc_pidfdinfo` `PROC_PIDFDPIPEINFO` `pipe_peerhandle`). Two Swift known-issue tripwires in `ConsoleTests.swift` mark it. (Owner: Stage 2 composition. Source: Task 12 ruling I2; review B §5.4.)
      - The guest sets hvc0 raw, with no echo and no ISIG, at boot, before any role, with cfmakeraw-equivalent input flags, so bytes sent before intake are neither echoed nor turned into signals. (Owner: Stage 2 appliance init. Source: Task 12 ruling E1(a); review B §5.4.)
      - After raw mode, TIOCEXCL and TCSAFLUSH the guest emits a fixed "credential intake ready" console record, and the host writes the frame only after reading it, under a deadline (fail closed otherwise). `guest/intake.py` must emit the record inside `_read_credential` after the TCSAFLUSH, or take a callback there, with a test: a record emitted by the composition alone would race the flush. (Owner: Stage 2 composition and `guest/intake.py`. Source: Task 12 ruling E1(b); review B RB-M3.)
      - Stage 2 checks hvc0 output drain and controlling-terminal status; a background caller would get SIGTTOU. (Owner: Stage 2. Source: Task 12 ruling E1(c).)
    - **Browser routing and assets**
      - Playwright answers CORS preflights itself, so the route policy's preflight entries never fire and the backend CORS policy is never consulted. (Owner: Stage 2. Source: Task 15 review E4.)
      - P69: every accept row (both navigation forms, with and without the signed-exchange suffix; image; stylesheet; script; manifest) is confirmed on the pinned Chromium 145.0.7632.6; a wrong value fails closed `ROUTE_DENIED`. Favicon, logo and manifest requests are admitted only if the signed asset manifest lists those paths, so headless Chrome's fetches are checked against the manifest. (Owner: Stage 2. Source: ruling P69; ledger Task 15 CARRY.)
      - The complete header set that Playwright 1.58.2's `request.headers()` exposes on Chrome 145 is confirmed per request kind, for example newer `sec-*` fetch-metadata headers on cross-site credentialed requests. Any header outside `BROWSER_GENERATED_HEADERS` and the policy allowlist denies the request and latches the run. (Owner: Stage 2. Source: review B RB-M6.)
      - P70 residual: a 307/308 hop with its body, including the login POST, reaches a run origin before the latch. No stricter option exists without changing the network path. (Owner: Stage 2. Source: ruling P70; ledger Task 15 CARRY.)
      - Any frontend asset first requested after READY fails every run: in the manifest, READY fails; outside it, the request is `ROUTE_DENIED`. Every frontend asset must be requested deterministically during the `/login` load, before `load`, for example one variable-weight font file preloaded with no unicode-range split. The owner's font self-hosting work must meet this, or Stage 2 changes the completeness rule through a reviewed amendment. The manifest must list `/index.html`. (Owner: the font work on the frontend release line, and Stage 2. Source: review B RB-I2.)
      - `guest/role-ports.cjs` abandons, rather than cancels, `authority.activate` on timeout, so a late COMMIT_BROWSER can land while the stop path runs. (Owner: Stage 2 composition. Source: Task 11 review M-1.)
    - **Readiness, gates and composition**
      - Blocks a real run until done: the composition builds the route policy's `verifyGate` with `createReceiptAdapters(trust, isBrowserSession)` and sets the snapshot's session, readiness and owner from `session.currentGates()`. Unwired, deeper routes are denied. (Owner: composition, original-plan Tasks 21–22. Source: Task 17 review E-1.)
      - The controller clock is the guest CLOCK_MONOTONIC in ms. The AFTER readiness is single-shot, so the composition waits until the restarted backend is runtime-ready. The app must not fetch a deeper route in a phase before that phase's gates are set; any denial ends the run. (Owner: composition. Source: Task 17 review E-2.)
      - Confirm that the release authority does not bump the DB receipt sequence after a restart. The post-restart DB receipt keeps its sequence and is told apart by interval AFTER and restart time. (Owner: Stage 2 and the release authority. Source: ledger Task 17 fix round 1 concern.)
      - If the session's release trust is also the route-policy adapter trust, `advanceSessionTrust` and the snapshot's switch to the AFTER maintenance receipt must happen in one synchronous step; any admission between them fails `READINESS_FAILED`. (Owner: original-plan Task 22. Source: review B RB-M7(a).)
      - Only ELIGIBLE or DENIED admissions may become reducer `budget` events. A HOLD-phase market-timer `ABORT_EXPECTED` fed as `budget` fails the run `ROUTE_DENIED`. (Owner: original-plan Task 22. Source: review B RB-M7(b).)
      - SAFE_SIGN_OUT cannot be executed yet: the route policy has no FAILED-phase logout row and refuses everything once latched, the BrowserSession refuses every `perform` after a latch, and the worker has no logout action. Needed: one X-phase logout admission that survives the policy latch (once), a worker logout action usable after a latch, and an interpreter that feeds `safeSignOutRoute` and `safeSignOutResult`. Until then the reducer reports UNCONFIRMED. (Owner: original-plan Tasks 17 and 21–22, and the route policy. Source: review B RB-M4.)
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

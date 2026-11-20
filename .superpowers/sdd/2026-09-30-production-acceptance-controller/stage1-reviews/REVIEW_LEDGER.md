# Stage 1 independent review ledger

- **Started:** 2026-11-17. Owner said "Start the reviews".
- **Code:** `claude/production-acceptance-stage1` at `132b67e`. Shared brief: `REVIEW_BRIEF.md`.
- **Reviewers:** opus, read-only, all dispatched in parallel.

| Group | Range | Reviewer agent | Report | Verdict |
|---|---|---|---|---|
| Task 8 (guest confinement) | `8db30fb^..04da78d` | `ac076fa48078b113d` | `task08-report.md` | **REJECT**: 0 Critical, 6 Important, 7 Minor |
| Task 9 (CONNECT proxy) | `04da78d..4574fb2` | `a7fde877c505d6f79` | `task09-report.md` | **REJECT**: 0 Critical, 5 Important, 5 Minor |
| Task 10 (topology gate) | `4574fb2..18ea876` | `a68e2f0c1b49cd343` | `task10-report.md` | **REJECT**: 0 Critical, 8 Important, 7 Minor |
| Composition v1 part A (plan Tasks 1–5) | `18ea876..7559e9c` | `a3b260547147dbd53` | `compA-report.md` | **REJECT (plan Task 5 only)**; Tasks 1–4 accepted with notes: 0 Critical, 1 Important, 10 Minor |
| Composition v1 part B (plan Tasks 6–10) | `7559e9c..6c3a3fc` | `a369a147e4a27b52f` | `compB-report.md` | **REJECT**: 0 Critical, 7 Important, 6 Minor |
| Tasks 11, 12, 18 | `6c3a3fc..edfa48e` | `a1caac8ffae998a7b` | `tasks11-12-18-report.md` | **REJECT**: 0 Critical, 10 Important, 14 Minor |
| Tasks 13b, 14, 15 | `763b329..31a513e` | `a919f20979722fa2f` | `tasks13b-14-15-report.md` | **REJECT**: 0 Critical, 10 Important, 9 Minor |

**Next:**
1. Triage the findings.
2. Run the whole-M4 offline review (Tasks 8–10 plus the amendment, following composition plan Task 11) with the per-task results as input.
3. Fix confirmed in-scope findings: an implementer, then a separate re-review.
4. Commit the review records to `.superpowers/sdd/2026-09-30-production-acceptance-controller/stage1-reviews/`.

## Task 9 (`a7fde877c505d6f79`): REJECT

All findings fail closed, and all are still present at HEAD.

- **T9-1:** `parse_connect` rejects the real Chromium CONNECT (`Proxy-Connection: keep-alive`). This comes from reviewer knowledge of Chromium source, not from execution.
- **T9-2:** a single per-tunnel event ends the whole run: an idle tunnel, an EOF before the header, or a write after the client closed. Expected to fail during HOLD.
- **T9-3:** vsock "transport authentication" compares the binding with itself, and the capability is never sent. The Task 5 broker has the same flaw.
- **T9-4:** the admission-pinning test still passes with `_admit_native_config` deleted, because the runner swallows `self.fail`. FD3 limits are unpinned.
- **T9-5:** the serving-loop CONNECT header limit of 4096 is not bound by any test.

## Tasks 11, 12, 18 (`a1caac8ffae998a7b`): REJECT

No credential is leaked to output or files. None of the three modules is wired in at HEAD.

### Task 11 (credential intake)
- **T11-I1:** after an intake failure, the credential stays reachable through the exception (`UnicodeDecodeError.object`, traceback frame locals).
- **T11-I2:** the tests do not check no-echo, leaks, the 4096-byte bound, handler restore or terminal loss. Mutants that echo the credential, or write it to fd 2, still pass.
- **T11-I3:** the host and guest credential formats are incompatible: the host sends a length prefix with no newline, the guest reads a newline-terminated line. **No credential can be delivered.**

### Task 12 (state machine)
- **T12-I1:** none of the failure-outcome checks is tested. A run where every step fails can reach DONE, and the tests still pass.
- **T12-I2:** the reducer denies all P-phase traffic that the design and `routes.json` allow, so the browser cannot load `/login`.
- **T12-I3:** `SAFE_SIGN_OUT` is requested but cannot be admitted in FAILED, and revocation is never recorded.
- **T12-I4:** `validState` accepts inconsistent hand-built states (DONE with no login). There is no initial-state constructor.

### Task 18 (private storage)
- **T18-I1:** one caller admits and deletes all five role roots across four UIDs, against the plan. Readability is not tied to the owning UID.
- **T18-I2:** the storage model contradicts the Task 8 role layout, so admission always fails once role views exist. The /dev/shm bound does not apply, and no role can reach the crash root.
- **T18-I3:** `deletion_owned_scope_only` cannot fail.

## Composition part A (`a3b260547147dbd53`): REJECT for composition plan Task 5 only

**Tasks 1–4 pass with notes:**
- N5-A and N5-B are closed at the gate.
- A caller-assembled or structurally equal inventory cannot qualify.
- A missing or failed probe cannot become success.

**Important finding (fails closed):**
- **CA-I1.** Routine probe-family cleanup (`confinement_probe.py:776`, `:694`) arms the shared 60 s cleanup end at the first successful probe.
  - Effect: an admitted composition's `stop_owned(60000)` returns TIMEOUT after 60 s of normal operation.
  - The 91-family catalogue must also finish within 60 s.
  - Three tests encode the wrong behaviour.

**Minor findings:**
- N5-B's `_read` typing is not independently bound.
- The README claims "independently approved" for the Task 2 reference, whose record is lost.

## Composition part B (`a369a147e4a27b52f`): REJECT

No confinement break and no false qualification; native paths stay closed.

### Important findings
- **CB-I1:** the 60 s cleanup window opens at the first ordinary probe stop. This independently confirms CA-I1; browser activation is also capped.
- **CB-I2:** `ProxyRuntimeOwner` works in-process only, with no cross-process proxy authority. The bootstrap registry fstat()s its own fds rather than the proxy child's, and the harness fakes all of it.
- **CB-I3:** event literals and audit-loss semantics are unbound. Mutants survive on the audit action, the operator, route groups and kinds, and the lost-counter check.
- **CB-I4:** the transition validator does not check the pinned executable. A stuck CLONE passes, EXIT is unreachable with real Linux 6.8 exit records, and descendants are not modelled.
- **CB-I5:** a late acquisition that races a finishing cleanup is retained but never stopped. A witness left 4 role children unstopped.
- **CB-I6:** no test binds the worker's one-use launch latch, the final-guard fence, or the CURRENT correlation.
- **CB-I7:** no test binds the proxy's owner-substitution or inventory-completeness checks.

### Flaky test
The 7 ms and 3 ms real-time budgets are too tight. It fails every time with 2 ms of injected latency. This is not a product race.

## Task 10 (`a68e2f0c1b49cd343`): REJECT

Nothing fails open. `bootstrapCheck` and the CLI always fail closed (exit 78), and no code emits `BOOTSTRAP_CONFINEMENT_QUALIFIED`.

**Important findings:**
- **T10-1:** the host compares guest wall/monotonic time against host clock samples within 1 ms. The clocks are separate, so a real run can never pass, and the amendment forbids this comparison. It is also the only freshness binding: there is no host challenge. Still at HEAD.
- **T10-2:** the topology check rejects every `/proc/net/ipv6_route` row. Linux 6.8 always lists the IPv6 null route and `::1`, so it can never pass on a real guest. The fixtures use an empty file. Still at HEAD.
- **T10-3:** none of the plan's named negative tests exist. Seven mutants survive the topology suites. Still at HEAD.
- **T10-4:** IP probes target documentation addresses where no receiver exists, and the receiver count is computed in the tested child. Only 5 of 11 runtime cases run. Superseded at HEAD; legacy code remains.
- **T10-5 (N5-A), T10-6 (N5-B):** open at `18ea876`, closed at HEAD for the native adapter.
- **T10-7:** the legacy capture's timestamp precedes the 12 probes, but the code requires the result within 1 ms, giving `BINDING_DENIED` under any latency. Still at HEAD.
- **T10-8:** `tests/guest/topology_test.py` contains only test doubles. In the real guest it passes without attempting any probe. Still at HEAD.

## Tasks 13b, 14, 15 (`a919f20979722fa2f`): REJECT

No Critical finding: the real launch still stops at the missing native fence.

- **I-1.** The first navigation is `/`, which the route table denies before login. The test accepts either decision, and the fake ignores the abort.
- **I-2.** The worker drops non-allowlisted headers, including `Authorization` (which the backend prefers), and then continues the request.
- **I-3.** Document bytes are never validated. Post-READY asset responses are also unvalidated, and their failures are silently dropped.
- **I-4.** The worker's readiness check has no negative test. `ReadinessProof` can be minted from any literal.
- **I-5.** The route-policy owner/readiness gate has no honest input mid-action (a cross-task gap).
- **I-6.** The descriptor inventory cannot detect vsock or `/dev/hvc0` descriptors, and its native readers are untested.
- **I-7.** The controller swallows route denials without latching them.
- **I-8.** Any duck-typed role port or session is accepted. A forged port received the owner-password canary.
- **I-9.** `fresh`, `source`, `brokerError` and `noError` are hard-coded.
- **I-10.** 12 security checks have no binding test.

## Task 8 (`ac076fa48078b113d`): REJECT

The offline launch, ordering and child-ownership logic is sound.

### Important findings
- **T8-01:** the theft probes never attempt cross-role theft. ptrace uses request 0 (`TRACEME`), and the SCM_RIGHTS probes read the browser's own FD3 and count EBADF as "denied". This feeds Task 10's `BROWSER_FD_DONOR`.
- **T8-02:** the ABI probe counts any signal death as an ABI denial. Its x86_64 and unknown-ABI cases cannot occur on AArch64.
- **T8-03:** the `exact_fd_inventory` probe makes no observation; it passes whatever the fixture's `audit()` returns.
- **T8-04:** most native `/proc` attestation checks are untested. 14 of 19 mutants survive the 401-test suite.
- **T8-05:** `NativeKernelPort` can be built over any bindings, and `NativeProbeFixtures` and `topology.py` accept it as native. Test doubles therefore pass as native.
- **T8-06:** the outer filter denies `chroot`, `capset` and others beyond the design's list. This very likely blocks the Chromium namespace sandbox (`chromiumSandbox: true`). **Needs an owner/design decision before Stage 2.**

### Notes for the whole-M4 review
- The exact `{0..4}` FD inventory almost certainly fails for a real Node worker.
- `CONFIG_PROC_CHILDREN` and `CONFIG_IPC_NS` are missing from the manifest's `kernelFeatures`.

# Totals (all 7 groups)
- **Verdicts:** 7 REJECT. Composition part A rejected only its plan Task 5; part A's Tasks 1–4 passed with notes.
- **Findings:** 0 Critical, **47 Important**, about 58 Minor.
- **Fail-closed status:** every reviewer found the real/native paths fail closed. Nothing can emit a qualification today.

## Remediation dispositions

- **Recorded:** 2026-11-20, branch `claude/production-acceptance-stage1` at `6d6c894`, remediation base `8f979c8`. Offline only; nothing pushed.
- **Full record:** `../stage1-remediation/report.md` holds the complete disposition table, every Minor finding (the 58 above plus the per-task review minors), the Option A gaps, the final review and fix wave, the owner decisions, the controller rulings and the C10 summary.
- **Terms:** "fixed offline" means closed at HEAD with a binding test and recorded mutant kills; "Stage 2 confirms" means a native fact is carried to contract C10; "carried to C10" means a composition step is still owed. Every finding fails closed at HEAD.
- **M4 status: still OPEN.** The real gate is Stage 2.

- **T8-01** → Task 10, `04a1377..7459511`: fixed offline, Stage 2 confirms.
- **T8-02** → Task 10, `04a1377..7459511`: fixed offline, Stage 2 confirms.
- **T8-03** → Task 10, `04a1377..7459511`: fixed offline.
- **T8-04** → Task 9, `69ed46e..04a1377`; fix wave `d8a6b30`: fixed offline.
- **T8-05** → Task 9, `69ed46e..04a1377`: fixed offline, Stage 2 confirms.
- **T8-06** → Tasks 8 (`cb0b85f..fa14b11`), 8b (`fa14b11..69ed46e`), 11 (`7459511..fdb6f3e`), 8c (`bf2a1a0..7bc192b`): fixed offline, Stage 2 confirms.
- **T9-1** → Task 5, `91e70cd..d5c1a4b`: fixed offline.
- **T9-2** → Task 5, `91e70cd..d5c1a4b` (proxy); Task 6, `d5c1a4b..35daf35` (broker): fixed offline, Stage 2 confirms.
- **T9-3** → Task 6, `d5c1a4b..35daf35` (owner-accepted broker diff): fixed offline.
- **T9-4** → Task 5, `91e70cd..d5c1a4b`: fixed offline.
- **T9-5** → Task 5, `91e70cd..d5c1a4b`: fixed offline.
- **T10-1** → Task 3, `d6bff51..c5e6277`: fixed offline, Stage 2 confirms.
- **T10-2** → Task 4, `c5e6277..91e70cd`: fixed offline, Stage 2 confirms.
- **T10-3** → Task 4, `c5e6277..91e70cd`: fixed offline.
- **T10-4** → Task 4, `c5e6277..91e70cd`: fixed offline.
- **T10-5** → Task 4, `c5e6277..91e70cd`: fixed offline.
- **T10-6** → Task 4, `c5e6277..91e70cd`: fixed offline.
- **T10-7** → Task 3, `d6bff51..c5e6277`: fixed offline, Stage 2 confirms.
- **T10-8** → Task 4, `c5e6277..91e70cd`: fixed offline, Stage 2 confirms.
- **CA-I1** → Task 2, `e9560e0..d6bff51`: fixed offline.
- **CB-I1** → Task 2, `e9560e0..d6bff51`: fixed offline.
- **CB-I2** → Task 7, `35daf35..cb0b85f`: fixed offline, Stage 2 confirms.
- **CB-I3** → Task 11, `7459511..fdb6f3e`; fix wave `e8fff93`: fixed offline.
- **CB-I4** → Task 11, `7459511..fdb6f3e`: fixed offline, Stage 2 confirms.
- **CB-I5** → Task 2, `e9560e0..d6bff51`: fixed offline.
- **CB-I6** → Task 11, `7459511..fdb6f3e`: fixed offline.
- **CB-I7** → Task 7, `35daf35..cb0b85f`: fixed offline.
- **T11-I1** → Task 12, `fdb6f3e..5116fa9`: fixed offline.
- **T11-I2** → Task 12, `fdb6f3e..5116fa9`: fixed offline.
- **T11-I3** → Task 12, `fdb6f3e..5116fa9`; fix wave `c4c526e`, `94daa84`, `b06fa10`: fixed offline, Stage 2 confirms.
- **T12-I1** → Task 13, `5116fa9..f038470`: fixed offline.
- **T12-I2** → Task 13, `5116fa9..f038470`: fixed offline.
- **T12-I3** → Task 13, `5116fa9..f038470`: fixed offline in the reducer; the sign-out path is carried to C10.
- **T12-I4** → Task 13, `5116fa9..f038470`: fixed offline.
- **T18-I1** → Task 14, `f038470..4f39a98`: fixed offline, Stage 2 confirms.
- **T18-I2** → Task 14, `f038470..4f39a98`: fixed offline, Stage 2 confirms.
- **T18-I3** → Task 14, `f038470..4f39a98`: fixed offline.
- **T13 I-1** → Task 15, `4f39a98..a7d26e4`: fixed offline.
- **T13 I-2** → Task 15, `4f39a98..a7d26e4`: fixed offline, Stage 2 confirms.
- **T13 I-3** → Task 15, `4f39a98..a7d26e4`: fixed offline, Stage 2 confirms.
- **T13 I-4** → Task 17, `508c2c0..bf2a1a0`: fixed offline.
- **T13 I-5** → Task 17, `508c2c0..bf2a1a0`: fixed offline in the modules; the composition wiring is carried to C10.
- **T13 I-6** → Task 16, `a7d26e4..9e1996c`; Task 16c, `7bc192b..6d87337`: fixed offline, Stage 2 confirms.
- **T13 I-7** → Task 15, `4f39a98..a7d26e4`; fix wave `4d9e42e`: fixed offline.
- **T13 I-8** → Task 16, `a7d26e4..9e1996c`: fixed offline.
- **T13 I-9** → Task 17, `508c2c0..bf2a1a0`: fixed offline.
- **T13 I-10** → Task 16, `a7d26e4..9e1996c`: fixed offline.

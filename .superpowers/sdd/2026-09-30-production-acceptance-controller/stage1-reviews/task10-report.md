# Task 10 independent review: topology admission and pre-browser B1 gate (M4)

Reviewer: independent security code reviewer (Stage 1). Date: 2026-11-17. Offline only; no Swift, VM, browser, network, signing or install action. Worktree, index, HEAD and branches were not modified.

## 1. Verdict

**REJECT.** No fail-open path or false qualification exists (every native entry fails closed, and no code emits `BOOTSTRAP_CONFINEMENT_QUALIFIED`). But four problems remain at HEAD `132b67e`:

- The host's freshness check compares guest timestamps with host clocks.
- The IPv6 route predicate can never pass on a real Linux 6.8 guest.
- The plan's named negative tests are absent, and seven predicates are bound by no test.
- `tests/guest/topology_test.py` passes vacuously.

N5-A and N5-B were open at `18ea876`; they are closed for the legacy native adapter at HEAD.

## 2. Scope reviewed

- **Range:** `4574fb2..18ea876`, six commits: `0e37c01`, `66dd75d`, `63768ef`, `4cc31fc`, `09c1734`, `18ea876`. That is 4,100 insertions across `guest/topology.py`, `tests/unit/topology_test.py`, `tests/guest/topology_test.py`, `host/Sources/AcceptanceCore/VMHost.swift`, `host/Sources/AcceptanceHost/main.swift` and `host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift`. Each finding was then re-checked at HEAD `132b67e`.
- **Plan:** `docs/superpowers/plans/2026-09-30-production-acceptance-controller.md`:
  - Task 10 (lines 456–477)
  - Task 8 runtime gate (line 431, "Task10 invokes this through the bounded bootstrap-check mode")
  - Phase table and the M4 exit gate (lines 232–244)
- **Design:** `docs/PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md` §§9.1–9.5 (B1 chain, the topology predicates, and the receiver-count rule "a missing fixture … is not a pass").
- **Amendment:** `docs/BOOTSTRAP_COMPOSITION_V1_AMENDMENT.md` §§1, 3, 4, 4.1 and 5. Used for N5-A/N5-B, the clock-domain rule and the twelve-ID projection rule.
- **Test evidence:** `runs/at-0f87065/swift-broad.log` (BootstrapGateTests, all passed; 181/181 overall).
- **Not reviewed in depth:** the later composition commits (`06cad0f`..`6c3a3fc`). They are touched only where they bear on whether a finding is still present at HEAD.

## 3. Findings

All file paths are under `tooling/production-acceptance/`.

| ID | Sev | file:line at HEAD | Still at HEAD | Evidence (short) | Suggested fix |
|---|---|---|---|---|---|
| T10-1 | Important | `host/Sources/AcceptanceCore/VMHost.swift:778-780`, `:1091-1093`, `:1157-1159` | yes | The host checks guest `observedWall`/`observedMonotonic` against host `before`/`after` samples with ≤1 ms tolerance. Tests pass only because both sides use the constant `(100,10)`. | Drop the cross-domain comparison. Bind freshness to a host-issued per-capture nonce inside the MACed payload, and keep the host's own deadline. |
| T10-2 | Important | `guest/topology.py:1292`, `:1375`, `:1892-1906`; fixtures at `tests/unit/topology_test.py:186,1093,1386,2039` and `tests/unit/bootstrap_composition_test.py:627` | yes | Every `/proc/net/ipv6_route` row counts as a forbidden route. Linux 6.8 always lists the fib6 null entry and the `::1` route. Without IPv6, the tcp6, udp6 and ipv6_route files are absent. All fixtures use `b''`. Witness: `native_proc.py`. | Admit only fully enumerated loopback and null-entry rows; reject default and gateway routes and any non-`lo` device. Use kernel-format fixtures. |
| T10-3 | Important | `guest/topology.py:1242-1300`, `:1354-1400`; `tests/unit/topology_test.py`; `BootstrapGateTests.swift` | yes | None of the seven plan-named tests exists. Seven mutants survive the full Task 10 Python suite (43/43 at `18ea876`; at HEAD, 68 + 44 + 47 + 9 tests). | Add the named tests in Python and Swift, with shared invalid vectors for each predicate. |
| T10-4 | Important | `guest/topology.py:155-162`, `:2946-3012`; `tests/guest/confinement_probe.py:720` | partly (legacy code kept; the composition uses the epoch) | At `18ea876` the IP probes target 192.0.2.1 and 2001:db8::1, so no receiver can exist. The receiver count is computed inside the attempted child. Only 5 of the 11 Task 8 runtime cases are projected. | Delete `Task10NativeAttempts`, `TASK8_PROBE_CASES` and `select_task8_probe_source`, or make them raise. Keep the epoch path as the only probe source. |
| T10-5 | Important | `guest/topology.py:866-908` at `18ea876` | no (native adapter: `capture_owner`, HEAD 1691-1741) | N5-A: drift during an in-flight capture returned normally with `cleanup_uncertain=False` while capture was still acquiring roles. Witness: `n5_probe.py`. | Fixed at HEAD for `NativeTopologyBindings`. Generic adapters still have no capture owner; restrict `TopologyGate` to native adapters. |
| T10-6 | Important | `guest/topology.py:1211-1253` at `18ea876` | no (HEAD 2095 onward) | N5-B: an ordinary `close()` exception gave `OBSERVATION_DENIED` with `cleanup_uncertain=False` and no unresolved owners, while `adapter._unresolved` still held the owner. Witness: `n5_probe.py`. | Fixed at HEAD (`CleanupFailure`, `cleanup_uncertain=True`). Keep a regression test at the gate level. |
| T10-7 | Important | `guest/topology.py:2199` (legacy capture), `:1276-1277`, `:2604-2606` | yes (legacy); narrower in the composition | The legacy capture samples the observation time before device observation, all 12 probes and proxy observation, then requires ≤1 ms to `after`. With 1 ms per probe it gives `BINDING_DENIED`. The `observation_skew` mutant survives every suite. | Sample immediately before the bracket end. Set an explicit, reviewed window. Test with advancing clocks. |
| T10-8 | Important | `tests/guest/topology_test.py:1-152` (unchanged at HEAD) | yes | The plan's guest test contains only inline doubles. Run in the real guest (`/opt/acceptance/tests/guest`), it passes without attempting a single probe. | Make it fail with `RuntimeGateUnavailable` unless a native port is supplied, or move it to `tests/unit`. |
| T10-9 | Minor | `guest/topology.py:1929-1936` | yes | A native `::1` reads as `00000000000000000000000001000000` (`%08X` of `__be32` words on LE aarch64). The code matches `'0'*31+'1'`. Fails closed, but the label is wrong. | Decode per 32-bit word in little-endian byte order. |
| T10-10 | Minor | `guest/topology.py:1484` (v1), `:2648` (v2); `guest/proxy.py` `_BOOTSTRAP_RULE.capability` | yes (key reuse) | The topology MAC key is the run capability, which the guest proxy (UID 10004, parses untrusted CONNECT) and the host egress broker also hold. v1 has no domain tag. | Derive a separate topology-admission key (HKDF with a label) that the proxy and broker never receive. |
| T10-11 | Minor | `guest/topology.py:1939-2030` (`_network_rows`, `_abstract`) | yes | Rejects any AF_UNIX socket, any TIME_WAIT row (12 fields) and any non-LISTEN/ESTABLISHED state, and allows only browser→proxy connections (no verifier). Fails closed. | Settle the post-browser current-check policy before Task 13. |
| T10-12 | Minor | `guest/topology.py:1744-1760`, `:3242-3288` | yes (legacy) | `TopologyGate` admits and activates with `supervisor=None`. A subscription acquired inside `begin()` without `stop_owned` is dropped, giving `OBSERVATION_DENIED` with `cleanup_uncertain=False`. Witness: `supervisor_owner.py`. | Require a supervisor; register the owner before `begin`; raise a typed `CleanupFailure`. |
| T10-13 | Minor | `guest/topology.py:1497` (`verify_handoff`); `VMHost.swift:1140` (v1 `OfflineVMHost.bootstrapCheck`) | yes (v1/test paths) | The Python consumer has no sequence or freshness check. Swift v1 has no one-use claim per run: test `local_n5_typed_capture_failure_remains_sticky…` admits the same sequence-1 handoff into two qualifications. | Mark both test-only or remove them; v2 `claimOffline()` is the model. |
| T10-14 | Minor | `guest/topology.py:139`; `VMHost.swift:419,447` | yes | "Host device attestation" is a guest-reported constant checked against a constant. It is not cross-checked against the host's own `VMConfigurationPlan`. | Have the host compare against its own validated VZ device set. |
| T10-15 | Minor | `guest/topology.py:1473-1475` docstring | yes | "Revalidate complete Task8/9 evidence" overclaims: at `18ea876` only 5 of 11 Task 8 cases were projected, and the attestations are caller-constructible dataclasses. | Reword. |

### Finding details

**T10-1 (cross-clock-domain freshness).**
- **The check.** `resample()` and both `bootstrapCheck` variants require `before.wall <= observedWall <= after.wall`, `before.monotonic <= observedMonotonic <= after.monotonic` and `after - observed <= 1`. `before` and `after` come from the host `BrokerClock`.
- **The guest values.** `observedWall`/`observedMonotonic` come from the guest `TopologyAuthority.clock` (`guest/topology.py:2604`, legacy `:2199`).
- **Why it never passes.**
  - Guest CLOCK_MONOTONIC counts from guest boot, so it is unrelated to the host monotonic clock.
  - Guest wall time has no NTP, since the guest has no network.
  - Even with one shared clock, `after` is sampled after transport and verification, so the 1 ms bound cannot hold.
- **The amendment forbids it.** §3 says "a monotonic value crosses only processes in the same guest boot, never host/guest clock domains". §5 says the host "never compares guest monotonic timestamps to host time".
- **Why the tests pass.** `BootstrapTestClock` defaults to `(100,10)` and the Python fixture carries `observedWall:100` and `observedMonotonic:10`.
- **Replay consequence.** This bracket is the only freshness binding. There is no host-issued challenge, so removing the bracket as the amendment requires would leave a sequence-1 handoff replayable within its run (see T10-13). The fix must add a host nonce.
- **Severity.** Fails closed (unavailable), not open.

**T10-2 (IPv6 route predicate).**
- **Source.** From the pinned Linux 6.8 archive (`~/day-trader-references/m4-linux-aarch64-offline-repair-20261002T181543Z/linux-6.8.tar.xz`, files extracted to `tmp/reviews/task10/linux-extract/`):
  - `net/ipv6/ip6_fib.c:247,2383,2395` set each table root to `RTN_ROOT|RTN_TL_ROOT|RTN_RTINFO` with leaf `fib6_null_entry`.
  - `fib6_walk_continue` (`:2100`) yields any `RTN_RTINFO` node with a leaf.
  - `ipv6_route_native_seq_show` (`:2481`) prints every yielded row.
- **Effect.** `/proc/net/ipv6_route` is never empty while IPv6 is enabled. The VM boot command line is `console=hvc0 root=/dev/vda ro`, with no `ipv6.disable` (`host/Sources/AcceptanceCore/VMConfiguration.swift:193` at HEAD).
- **Witness.** `native_proc.py` feeds a null-entry row and a `::1` row to `_routes6`. Admission fails with `TOPOLOGY_DENIED` at both `18ea876` and HEAD.
- **Spec.** The design forbids "IPv4/IPv6 default route", not all routes.

**T10-3 (unbound predicates).**
- **Method.** Each mutant is applied to both `_payload` and `_validate_payload` (`scripts/mutate.py`). `scripts/mutant_effect.py` confirms each mutant admits its bad snapshot and that the original rejects it.

| Mutant | Bad input it admits |
|---|---|
| `nic` | `interfaces=('lo','eth0')` |
| `abstract_unix` | `('ABSTRACT:@agent',)` |
| `probe_attempted` | `attempted=False` |
| `seccomp_mode` | `seccomp=0` |
| `host_listener` | `Listener('HOST',…)` |
| `missing_proxy_listener` | `listeners=()` |
| `observation_skew` | an observation 50 ms stale |

- **At `18ea876`.** All seven pass `topology_test.py` (43 OK). The control mutant `routes_control` fails (1 failure), so the harness detects real breaks.
- **At HEAD.** All seven pass `topology_test.py` (68), `bootstrap_composition_test.py` (44) and `bootstrap_reference_test.py` (9). They also pass `abi_coverage_test.py` (47), except `seccomp_mode`, which is caught only by the source-scan literal count in `test_seccomp_mode_attestation_literals_match_named_symbol`, not by behaviour.
- **Swift.** By inspection, `valid_mac_inventory_filter_fd_route_dns_listener_substitutions_reject` covers routes, DNS, a duplicate listener, the filter digest, FD purpose, program pins and `waiting`. It has no NIC, `abstractUnix`, `HOST` listener, empty listener, `attempted:false` or `seccomp` vector.

**T10-4 (legacy probe evidence at `18ea876`).**
- **Fixed targets.** `Task10NativeAttempts.execute_native` uses the fixed documentation addresses 192.0.2.1 and 2001:db8::1, which no owned receiver can occupy.
- **Child-reported count.** It returns `context.receiver_count()`, which `NativeProbeFixtures.run_confined` evaluates inside the confined child (`attempt(NativeProbeContext(...))` in `child(port)`).
- **Omitted Task 8 cases.** `TASK8_PROBE_CASES` maps 5 of 11 Task 8 `PROBES`. `alternate_ABI_denied`, `privilege_gain_denied`, `no_console_or_bridge_fd`, `bootstrap_arbitrary_argv_denied`, `TSYNC_failure_abort` and `exact_fd_inventory` never run, although plan line 431 requires Task 10 to invoke the Task 8 runtime gate.
- **Why not fail-open.** The helpers raise `NATIVE_HELPER_UNAVAILABLE` and composition is `COMPOSITION_UNAVAILABLE`.
- **HEAD.** `qualify_probe_epoch` covers every Task 8 operation, with `ReceiverAuthority` BEFORE/AFTER observation in the parent and no documentation-address fallback. The legacy classes are still exported.

**T10-5 and T10-6 (N5-A and N5-B).** `scripts/n5_probe.py` output:

| Tree | N5-A: drift while capture pending | N5-B: `close()` raises `OSError` |
|---|---|---|
| `18ea876` | drift raised nothing; `cleanup_uncertain=False` | `TopologyError(OBSERVATION_DENIED)`; `cleanup_uncertain=False`; `gate.unresolved=0`; `adapter._unresolved=1` |
| HEAD | drift raised `CleanupFailure`; `cleanup_uncertain=True` | `CleanupFailure`; `cleanup_uncertain=True`; `gate.unresolved=2` |

- **Existing tests at `18ea876`.** `test_local_n5_owned_observation_close_preserves_typed_cleanup` covers only a typed `CleanupFailure` from `close()`. `test_uncertain_owned_close_is_retained_and_cleaned_by_owner_not_fd` checks only the adapter level.
- **Swift analogue.** In v1 `OfflineVMHost.bootstrapCheck`, `lifecycle.begin` runs with no pre-registered owner. It is fixed for v2 at HEAD (`beginLifecycleAcquisition`); v1 is internal and test-only.

**T10-7 (observation window).**
- **Witness.** `scripts/probe_latency.py`: legacy native capture admits at 0 ms per probe and gives `BINDING_DENIED` at 1 ms per probe, at both `18ea876` and HEAD.
- **HEAD composition.** It moves probes into the epoch, but still requires `final - observed <= 1 ms` across `event_owner.barrier()` (`:2604-2606`). No test advances the clock.

**T10-8 (vacuous guest test).**
- **Packaging.** The appliance installs the guest probes archive at `/opt/acceptance/tests/guest` (`appliance/manifest.schema.json:85`).
- **Content.** The file defines its own `GuestProbePort` double. Its docstring says honestly that it is inert.
- **Risk.** Plan line 431 states "a mocked unit PASS never substitutes for this gate". This file would produce exactly such a PASS if run in the VM.

## 4. Plan-required items

| Item | Status |
|---|---|
| Create `guest/topology.py`, `tests/guest/topology_test.py`; modify `VMHost.swift`, `main.swift`; create `BootstrapGateTests.swift` | Present. The guest test is inert (T10-8). |
| `admit_topology(snapshot, expected) -> AdmissionProof` binding run, manifest, role and device inventories, and expiry | Present. It takes extra `before`/`after` args. Expiry is the run expiry only, with no per-proof TTL (T10-1). |
| `VMHost.bootstrapCheck(run:) -> BootstrapQualification` | Present; always throws `admissionUnavailable`. Correct for M4 (no native constructor). |
| `bootstrap-check --manifest --release` CLI using only fixed probe IDs | Present (`HostDispatch.bootstrapInvocation`, `BootstrapProbeID` with 12 IDs). Exits 78 before opening paths. Correct. |
| `BOOTSTRAP_CONFINEMENT_QUALIFIED` only after real negatives, zero forbidden receiver counts and the proxy positive | No such string exists anywhere (`grep` over both trees). No false-qualification path. |
| "Proof … later assembly checks it again before prompt" | Present (`require_current`, `requireBrowserAdmission`); resample requires `sequence+1` and identical digests. |
| Snapshot plus runtime service-creation supervision | Partial. Python supervision is optional (T10-12) and has no native event source at `18ea876`. Swift requires a lifecycle port. |
| Real kernel-role and no-NIC topology checks must pass before Task 13 | Structurally gated; natively unavailable. Native predicates are unsatisfiable (T10-1, T10-2, T10-7). |
| Real probes: IPv4/IPv6/UDP/DNS/io_uring/vsock/FD/helper, with owned receiver counts | Incorrect at `18ea876` (T10-4); helpers unavailable. Superseded at HEAD by the epoch path. |
| Test `unexpected_NIC_default_v4_v6_route_DNS_listener_fail_before_prompt` | Missing by name. v4 route, DNS and listener-uid are covered. NIC and v6 route are not (mutant `nic` survives). |
| Test `missing_proxy_fail` | Missing (mutant `missing_proxy_listener` survives). Proxy-runtime substitution is covered. |
| Test `extra_abstract_UNIX_agent_fail` | Missing at admission level (mutant survives). The parser row test exists. |
| Test `incorrect_uid_seccomp_fd_fail` | Partial. UID, GID, capabilities, filter digest and FDs are covered. Seccomp mode is not (mutant survives behaviourally). |
| Test `role_probe_failed_or_skipped_fail` | Partial. Missing probe, `ALLOWED` substitution and a raising probe are covered. `attempted=False`/skipped is not (mutant survives). |
| Test `host_listener_not_guest_loopback` | Missing (mutant survives). |
| Test `topology_drift_latches_failure` | Present (Python drift-during-capture and supervised drift; Swift `rollback_expiry_malformed_and_lifecycle_drift_latch_terminal`). |
| Swift `BootstrapGateTests` filter | Present; all passed at `0f87065` (`swift-broad.log`). The Python-fixture tests use `#require` on `TASK10_TOPOLOGY_INPUT`, so they are not vacuous if it is absent. |

## 5. Checks run

All runs used Python 3.12.2 (`/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 -B [-I]`) with `TMPDIR=…/tmp/producers/`. Scripts are in `/Users/Matt/day-trader-evidence/production-acceptance-tooling/20261117T002012Z-stage1/tmp/reviews/task10/scripts/`, with inputs extracted under `/Users/Matt/day-trader-evidence/production-acceptance-tooling/20261117T002012Z-stage1/tmp/reviews/task10/`:

- **Trees:** `git archive 18ea876` → `at-18ea876/`; `git archive HEAD` → `at-head/`.
- **Mutation testing:**
  - `mutate.py <copy>/guest/topology.py <name>`, then `unittest discover -p topology_test.py`. At HEAD it also ran `bootstrap_composition_test.py`, `abi_coverage_test.py` and `bootstrap_reference_test.py`.
  - Mutant trees: `mutants/` (`18ea876`) and `mutants-head/` (HEAD).
  - Logs: `mutants/run.log` and `mutants-head/run.log`.
  - `mutant_effect.py` confirms each mutant admits its bad input and that the original rejects it.
- **Witness scripts:** `n5_probe.py` (N5-A/N5-B), `native_proc.py` (kernel-format ipv6_route and tcp6), `probe_latency.py` (observation window), `supervisor_owner.py` (supervision owner loss), `runtime_row_divergence.py` (HEAD v2 Python/Swift divergences). Outputs are in `witnesses.log`.
- **Filter digest:** a one-off computation of Python seccomp filter digests per role. It matches the Swift constants `294f0834…` (CONTROLLER, BROWSER, VERIFIER) and `01e3ec74…` (PROXY).
- **Linux source:** `tar -xJf` of 8 files from the pinned Linux 6.8 archive into `linux-extract/` (read-only, offline).
- **Swift:** not run. Relied on `runs/at-0f87065/swift-broad.log`.

## 6. Declined to judge

- **The lost October reviews.** Whether the code matches the round-4 review's C1–C6 and R1/R4/R6 decisions, or the local N3/N5 review: both reports are lost. Judged only against the plan, design and amendment text.
- **Swift runtime behaviour beyond the log.** No Swift was run; Swift findings are by reading.
- **Appliance kernel `CONFIG_IPV6`.** T10-2 holds either way: built in, ipv6_route is non-empty; absent, the files are missing and observation fails. The real appliance kernel config was not inspected.
- **Native event-barrier latency** (T10-7, HEAD composition) and the real `/proc/net/unix` population at admission.
- **The composition commits after `18ea876`.** They are assigned to another reviewer. They are touched here only to decide whether a finding is still present at HEAD.

## 7. Notes for the whole-M4 review

1. **N5-A and N5-B.** Open at `18ea876` (witnessed). At HEAD both are closed for `TopologyGate` with `NativeTopologyBindings` (`capture_owner`, typed close failure). `TopologyGate` still accepts arbitrary adapters with no capture owner, and Swift v1 `lifecycle.begin` keeps the gap; both are legacy or test-only. Confirm that the composition's `_pending_acquisitions` covers every acquisition.
2. **Clock domains (T10-1).** This is the one amendment rule the HEAD composition still violates on the Swift side. Any fix needs a host challenge; otherwise the initial handoff has no freshness.
3. **Python and Swift agreement.**
   - **v1 (this range).** No input was found that Swift accepts and Python rejects, apart from the clock-domain semantics. Python accepts any program pins carried by the caller's `BootstrapConfig`, where Swift requires executable-authority pins. That direction fails closed.
   - **v2 at HEAD.** Besides F-4b (pipe direction), Python's ownerless `_runtime_wire_row` accepts four things Swift `validateRoleRuntimeV1` rejects (`runtime_row_divergence.py`):
     - a `COMMAND`/`NULL`/`RESULT` kind at fd≥5 in PROXY
     - `PROXY_VSOCK_STREAM` or `PROXY_CONNECT_SELECTOR` counts above `PROXY_ACCEPTED_STREAM`
     - duplicate device:inode among PROXY runtime rows
     - rows that differ from the retained originals (Swift requires canonical equality)
   - **Lifecycle.** Python v2 also accepts `BROWSER_ACTIVE`, which Swift rejects.
   - **Direction.** All of these divergences are Python accepting what Swift rejects, so they fail closed. They should still be one shared vector set.
4. **Native operability.** T10-2, T10-7 and T10-11 together mean the current /proc predicates would deny a real guest before or after browser start. Fix them before claiming any native qualification evidence.
5. **Key separation (T10-10).** The topology and composition MAC key is the run capability, which the guest proxy and the host egress broker also hold.
6. **M4 exit gate.** At HEAD, the Task 13–15 guest tests (`tests/guest/browser_test.cjs:17`, `session_test.cjs:16`, `observation_test.cjs:18`) gate on `process.env.ACCEPTANCE_TASK1x_GUEST === 'B1_QUALIFIED'` plus uid, platform and fixture checks. They do not consume a Task 10 `AdmissionProof`. The plan's "no browser acceptance execution starts before Task10 passes real confinement" therefore rests on an environment string. This is for the Task 13 and whole-M4 reviewers.
7. **No false qualification found.**
   - `VMHost.bootstrapCheck(run:)`, `bootstrapCheck(run:composition:)` and `bootstrapCheck(invocation:)` all throw.
   - `main.swift` exits 78.
   - `BootstrapExecutableAuthority.qualify` throws.
   - No `*QUALIFIED` status is emitted by host or guest code.
   - Swift's internal v1 consumer does accept any MAC-valid, self-consistent payload, including one built from Python test doubles (`test_export_composition_fixture_for_swift_consumer`). A future native constructor must bind provenance, not just the MAC.

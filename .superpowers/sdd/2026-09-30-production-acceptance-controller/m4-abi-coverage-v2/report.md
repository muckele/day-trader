# M4 ABI coverage v2 (Option A) — reviewed offline checkpoint

| | |
|---|---|
| **Date** | 2026-11-17 |
| **Branch** | `claude/production-acceptance-stage1` |
| **Plan** | `docs/superpowers/plans/2026-11-17-m4-abi-coverage-v2.md` (`36898e9`) |
| **Spec** | owner-accepted M4 disposition (`m4-disposition-20261117/disposition.md`), D4 = Option A |
| **Execution** | subagent-driven, as the owner chose. Fresh implementer per task and a fresh task reviewer. An independent oracle transcriber. A final whole-change reviewer on the most capable model. |
| **Toolchain** | owner-approved re-pin: CLT 27.2, Swift 6.4.2, SDK 27.2, Node 24.21.0, Python 3.12.2, host macOS 27.2.1 arm64 |

**This is a new derivation.** The lost `abi-coverage.json` (`7c8714c95a67d8a2e6c1b4c8b8481525a61976c81dfe2037c251add071ac9898`) is not recovered. The new coverage records that hash as `supersedesLostCoverageSHA256` and never claims to be that file.

**M4 status: still OPEN.** Two things remain:
- the whole-M4 offline review in Stage 1
- the real confinement gate in Stage 2

## Commits

| Commit | Task | Content |
|---|---|---|
| `ecd55be`, `5481ccc` | 1 | Offline deriver `appliance/derive_abi_coverage.py`. One fix round: `_UL`/`_BITUL` macros, packed/aligned structs, fail-closed arithmetic, archive hash checked before parsing, required `--archive-sha256`. |
| `e73e326` | 2 | Inventory (99 entries), the derived `abi-coverage-v2.json`, and independent oracles `tests/unit/abi_oracles.py` |
| `7f0ad06`, `de93251` | 3 | Code-binding tests. One fix round: exact checks per call site and per filter instruction, with no catch-all policy values. |
| `ab91c1c` | 4 | `bootstrap_reference_test.py` unblocked against v2. The lost parent is recorded as lost. |
| `0f87065` | 4b | Added by controller rulings R14/R15. Audit syscall numbers, the `_ip` socket table and 22 more values; inventory now 121. Negative and mixed argument literals are now caught. |
| `9530da3` | final fix wave | Audit arch value and TSYNC literals bound; coverage docstrings corrected |

Final pins:

| File | SHA-256 |
|---|---|
| coverage | `e4015945d140086d2fc55a54ca1f6c7a402f924a78c0b0ab4fdb37250b727791` |
| oracles | `c54a4006dc5c64ace799717e6a6b25b44bd16ecd93c9bcfe5aeba174c670069b` (history only appended: `b26a3f15…` then `c54a4006…`) |
| event reference (unchanged) | `a2e1be5762976e07f270c6646ce5e4d94c48efcc2c78dacaf29ed3e32471be7d` |

## Verification

### Controller run at `0f87065`
Sandbox: outbound IP denied for Node and Python. The tree was clean before and after.

| Suite | Result |
|---|---|
| Python | **400/400** |
| Node | 402/402 |
| Swift | **181/181** |
| fixture producers | OK |
| Node composition consumer | 35/35 |
| Swift → Node receipts | 150/150 |

### Fix-wave head
See the fix-wave section below.

### Final reviewer
- **All 121 coverage records** checked against the archive with the reviewer's own checker: declaration, line span, condition stack, value and member SHA. Its parser and evaluator are separate from the deriver's. The checker caught 7 of 7 seeded corruptions.
- **121/121 independent oracle values** equal the derived values.
- **Refusal paths:** 57 synthetic refusal probes run against the deriver. All fail closed, except deferred minors that affect no record.

### Mutation testing across the tasks
Mutants were applied to scratch copies of the guest code, outside the repo. Every value mutant at a bound site is killed by the binding tests. The survivors are listed under known gaps.

## Linux 6.8 arm64 preconditions behind the pinned conditions
The final reviewer verified these from the archive.

- `arch/arm64/include/uapi/asm/unistd.h:22` defines `__ARCH_WANT_SYS_CLONE3` before it includes the asm-generic table. So `__NR_clone3` (435) is native.
- `__BITS_PER_LONG` is 64. `__SYSCALL_COMPAT` is defined in no header. Together these select `__NR_fcntl` → `__NR3264_fcntl` (25).
- `ARCH_HAS_SOCKET_TYPES` is defined only by MIPS. So `SOCK_*` comes from `include/linux/net.h`.
- `__UAPI_DEF_IF_IFNAMSIZ` is 1 in `libc-compat.h:183`. Under glibc it is 0, and glibc then supplies the same value, 16.
- The arm64 `asm/fcntl.h` overrides only `O_DIRECTORY`, `O_NOFOLLOW` (`0100000` = 32768), `O_DIRECT` and `O_LARGEFILE`.
- The only other definition sites for the 121 symbols are the AArch32 compat table `arch/arm64/include/asm/unistd32.h`, correctly excluded, and the generic `O_NOFOLLOW`, which arm64 overrides.

## Reconciliation with the accepted spec (D4)

- **Old requirement (D4, Option A):** "Update `bootstrap_reference_test.py` and `parentCoverageSHA256` to the new hash."
- **Decision:** `appliance/bootstrap-event-reference.json` is **not** modified. Its `parentCoverageSHA256` keeps the lost value. `bootstrap_reference_test.py` now hash-checks the committed v2 file, which records `supersedesLostCoverageSHA256`. A new test asserts that the lost parent is recorded and superseded.
- **Why:**
  - The event reference's own digest is pinned in `appliance/manifest.schema.json:523`, `appliance/README.md:149`, `tests/unit/appliance_test.py:31` and Swift `VMConfigurationTests.swift:54`. Changing it would ripple into reviewed Task 7 and composition artifacts.
  - The reference was in fact derived from the lost parent. Rewriting it would rewrite history.
- **Effect:** the 8 previously blocked reference tests run and pass. Event constants are still checked against the headers.

## Known uncovered ABI surface and known gaps
These carry forward to the Stage 1 whole-M4 review.

### R13: layouts the deriver does not parse
Each feeds a syscall that rejects malformed input, so each fails closed:
- the capset header and data structs, including the element size 12 in `bytearray(24)`
- `sock_fprog`
- `sockaddr_in` and `sockaddr_in6`
- procfs text formats
- LP64 data-model bounds
- kernel-behaviour semantics

**Caveat for Stage 2:** the attestation `filter_digest` (`confinement.py:1103`) is computed from the intended program, not read back from the kernel.

### R17 C3 and final-review I2: event-constant literals in `topology.py` are not bound to the event reference
- **Bound here:** the audit rule's arch value, in the fix wave.
- **Still unbound:** the audit action `AUDIT_ALWAYS` (`:189`), the route kind (`:723`) and `_ROUTE_GROUPS` (`:173`). Mutants L, F and G survive the full suite.
- **Exposure:** none today, because `select_native_bootstrap_event_source` is hard-wired unavailable (`topology.py:306-313`).
- **Required before** the native event source is enabled.

### R17 C4
ABI values written as strings (`'c00000b7'`, `'0A'`) are not swept. Mutant B is killed by `topology_test` through test doubles, not through header authority.

### Final-review I1: the probe catalogue is outside every sweep
- `tests/guest/confinement_probe.py` has 23 native `syscall(...)` sites and denial errno sets that are not bound.
- Mutants D (ptrace 117 → 41) and E (recvmsg → sendmsg) survive the full suite.
- Today's values were verified correct.
- **Required before** Stage 2 relies on probe evidence. That needs inventory entries for:
  - `__NR_recvmsg`
  - `MSG_CMSG_CLOEXEC`
  - `ENOTSOCK`
  - `EBADF`
  - the ptrace request

### Other minors
- **m2:** records do not cite the definitions their values come from (for example `__NR3264_fcntl`). The deriver does not check a referenced definition's condition stack. No current record is affected.
- **m3:** the guest `.cjs` modules were not swept. `browser-worker.cjs:427-429` accepts `Seccomp > 0`, which is weaker than the Python check `!= SECCOMP_MODE_FILTER`.
- **m4:** the ptrace probe uses request 0 (`PTRACE_TRACEME`) rather than targeting the controller. Seccomp denies nr 117 anyway.
- **Selector limits:** literal-first comparisons and IFNAMSIZ-shaped checks outside the named functions are not detected (mutants G01 and G02).

### Deferred minors
All deferred minors were triaged by the final reviewer as "defer" or already resolved. The full list is in the plan ledger, mirrored at `~/day-trader-evidence/production-acceptance-tooling/20261117T002012Z-stage1/sdd-ledger-mirror.md`.

### Pre-existing test flake
`bootstrap_composition_test.test_v1_stop_clamps_to_caller_and_never_widens_shared_budget` failed once on timing and passed on rerun. It goes to the composition review.

## Fix wave

### What the final reviewer asked for
**Verdict: "ready to use as M4 Option A evidence with fixes"**, with 0 Critical and 3 Important findings. All three Important findings concern how honestly the record describes what it covers.

### What the fix wave (`9530da3`, test file only) changed
1. **Docstring (event constants).** It now states that the event-constant literals in `topology.py` are not bound to the reference, and names examples.
2. **Audit arch binding.** The audit rule's arch value (`topology.py:188`) is bound exactly to `AUDIT_ARCH_AARCH64`.
3. **Docstring (oracles).** It now states that the oracles independently check values only. The choice of header and branch was checked by the reviewers.
4. **TSYNC binding.** The `install_seccomp(…, 1)` flags literal (`confinement.py:354`) is bound exactly to `SECCOMP_FILTER_FLAG_TSYNC`.

**Results at `9530da3`:**
- Focused `abi_coverage_test`: 47/47.
- Broad Python: 401 run, 0 failures, 0 errors.
- Swift and Node inputs are unchanged since the controller run at `0f87065`.

### Scoped re-review of the fix wave: ACCEPT
All four fixes are addressed. On a scratch export, these mutants are killed by the new assertions:
- A: arch value changed to x86-64. It had survived all 400 tests at `0f87065`.
- C, K and K2: TSYNC flag changed to 0 or 2.

**Remaining observations, joining the known gaps above:**
- In the same audit-rule statement, `fields[0]` (`AUDIT_ARCH`) and `operators[0]` (`AUDIT_EQUAL`) are still unbound. They belong to the deferred event-literal work.
- The arch check looks only at the tuple assignment. This is the same kind of selector limit as G01/G02.

**Review record.** The final reviewer, the fix-wave implementer and every task reviewer were separate agents. Their reports, review packages, the transcribed oracle copies and the plan ledger are preserved in `~/day-trader-evidence/production-acceptance-tooling/20261117T002012Z-stage1/sdd-workspace-m4-abi-coverage-v2/`.

## Not performed
- push, merge, package install or download
- signing, VM or browser
- any credential, production or trading action

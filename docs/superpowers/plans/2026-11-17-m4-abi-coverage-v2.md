# M4 ABI Coverage v2 (Option A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the check M4 was blocked on. Re-derive, from the retained Linux 6.8 archive, every Linux ABI value the guest code uses, and commit the derivation and its output. Bind the code's literals to that output with tests, and unblock the 8 `bootstrap_reference_test.py` tests.

**Architecture:**
- A stdlib-only deriver streams named header members out of the pinned archive, never extracting it. It resolves each inventoried symbol's `#define`/enum/struct declaration under a pinned preprocessor-condition context, and writes a canonical, committed coverage file.
- Tests check four things:
  - the committed file is reproducible from the archive
  - its values match an independently transcribed oracle table
  - every ABI literal in `guest/confinement.py` and `guest/topology.py` decomposes exactly into covered values
  - the existing event reference stays unchanged
- No product code changes.

**Tech Stack:**
- Python 3.12.2 standard library only (`tarfile`, `hashlib`, `json`, `re`, `ast`, `unittest`).
- Offline only.

**Spec:**
- `.superpowers/sdd/2026-09-30-production-acceptance-controller/m4-disposition-20261117/disposition.md` (D2, D3, D4 = Option A)
- `docs/BOOTSTRAP_COMPOSITION_V1_AMENDMENT.md` §1, reference bundle paragraph
- `tooling/production-acceptance/tests/unit/bootstrap_reference_test.py`: the existing double-entry pattern to follow

## Global Constraints

- **Branch.** Work on branch `claude/production-acceptance-stage1`, worktree `~/day-trader-worktrees/production-acceptance-stage1-fixes`. Never on `main`. No push without separate owner approval.
- **No network or execution from the archive.** No package installs. No network. No extraction to disk (`extractall` is forbidden). Read only the tar members named in the inventory. Never execute anything from the archive.
- **Pinned inputs.**
  - Archive: `/Users/Matt/day-trader-references/m4-linux-aarch64-offline-repair-20261002T181543Z/linux-6.8.tar.xz`, SHA-256 `c969dea4e8bb6be991bbf7c010ba0e0a5643a3a8d8fb0a2aaa053406f1e965f3`.
  - Bundle manifest: SHA-256 `bb5fb8c47a329b8792f85a957d5674690b8aac59580a604fa405855e745e49d5`.
  - Any mismatch, or a missing archive, is a test **error**, never a skip. This matches `bootstrap_reference_test.py`.
- **Target ABI.** Linux 6.8, native AArch64, LP64, little-endian. No compat or x32 ABI.
- **Honest labelling.**
  - The new coverage is a **new derivation**. It records `supersedesLostCoverageSHA256: "7c8714c95a67d8a2e6c1b4c8b8481525a61976c81dfe2037c251add071ac9898"` and never claims to *be* that lost file.
  - **Do not modify `appliance/bootstrap-event-reference.json`.** Its digest `a2e1be5762976e07f270c6646ce5e4d94c48efcc2c78dacaf29ed3e32471be7d` is pinned in `appliance/manifest.schema.json:523`, `appliance/README.md:149`, `tests/unit/appliance_test.py:31` and `host/Tests/AcceptanceCoreTests/VMConfigurationTests.swift:54`. Its `parentCoverageSHA256` stays the historical, lost value.
- **No product code changes.** `guest/*.py`, `guest/*.cjs` and `host/Sources/**` must not change. If a derived value disagrees with a code literal, **stop and report it**. That is a product defect needing its own owner-visible fix and review.
- **Test environment.**
  - Physical, non-symlinked `TMPDIR`.
  - `PYTHONDONTWRITEBYTECODE=1`.
  - Pinned Python `/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12`, run with `-B`.
- **Canonical output.** `json.dumps(obj, sort_keys=True, indent=2, ensure_ascii=True) + "\n"`, the same layout as `appliance/bootstrap-event-reference.json`.
- **Independence.**
  - The oracle table (Task 2) is transcribed by a different agent from the deriver's implementer, reading header text directly.
  - Every task gets a fresh-context reviewer who is not its implementer.

## Review Focus

1. **Conditional definitions.** A symbol is defined under `#if` branches; for example, `__NR_fcntl` is an alias of `__NR3264_fcntl` under `__BITS_PER_LONG == 64`. The deriver must bind only the inventory-pinned condition stack. It must error on zero or several matches, never pick the first. Owner: Task 1 test `test_conditional_definitions_require_pinned_condition`.
2. **Suffixes, casts and helper macros.** Values like `0x80000000U`, `(1UL << 3)`, `_BITUL(31)` and `(F_LINUX_SPECIFIC_BASE + 6)` must evaluate correctly. A cast or unknown token must be rejected, never guessed. Owner: Task 1 test `test_expression_evaluator_suffixes_and_rejections`.
3. **Compound flag literals.** For example `262144|16384` passed to `mount`. These must decompose exactly into covered symbols allowed for that syscall argument. One unexplained bit fails. Owner: Task 3 test `test_syscall_flag_arguments_decompose_into_covered_symbols`.
4. **Archive problems.** A missing member, duplicate member names, or a member hash differing from a previous run must be errors. Owner: Task 1 test `test_archive_member_missing_duplicate_or_changed_denied`.
5. **Wrong header.** A symbol inventoried in the wrong header is not found there. That must be an error naming the member. No search of other members. Owner: Task 1 test `test_symbol_absent_from_named_member_denied`.

---

### Task 1: Deriver engine

**Files:**
- Create: `tooling/production-acceptance/appliance/derive_abi_coverage.py`
- Test: `tooling/production-acceptance/tests/unit/abi_coverage_test.py` (class `DeriverTests`; synthetic in-memory `.tar.xz` fixtures only)

**Interfaces:**

- Produces `derive(archive: pathlib.Path, inventory: dict, *, archive_sha256: str) -> dict`.
  - **Inventory.** `inventory` has exactly `{version: 1, entries: [...]}`. Each entry has exactly:
    - `id`: str
    - `memberPath`: str
    - `kind`: `"define" | "enum" | "layout"`
    - `conditions`: list[str], the exact stripped `#if`/`#ifdef`/`#ifndef`/`#else` lines enclosing the definition, outermost first; `[]` means none
    - `width`: 16, 32 or 64
    - `signed`: bool
    - For `layout` entries, also: `struct` (the C struct name) and `field` (str), or `field: null` to mean `sizeof`.
  - **Return value.** `{version: 1, sourceArchiveSHA256, supersedesLostCoverageSHA256, derivedBy: "tooling/production-acceptance/appliance/derive_abi_coverage.py", records: [...]}`.
  - **Records** are sorted by `id`. Each has exactly: `id`, `memberPath`, `memberSHA256`, `firstLine`, `lastLine`, `declaration` (exact source text), `conditions`, `value` (int), `width`, `signed`. Layout records have `declaration` set to the full struct text span.
- Produces CLI `python3.12 -B derive_abi_coverage.py --archive <path> --inventory <path> --output <path>`.
  - The output path must not already exist: open with `'x'`.
  - Exit code 0 on success. Exit code 2 on any `AbiCoverageError`, printing only its code.
- Produces `class AbiCoverageError(Exception)` with `.code` taking one of these values:
  - `ARCHIVE_MISMATCH`
  - `MEMBER_MISSING`
  - `MEMBER_DUPLICATE`
  - `SYMBOL_MISSING`
  - `SYMBOL_AMBIGUOUS`
  - `EXPRESSION_UNSUPPORTED`
  - `LAYOUT_UNSUPPORTED`
  - `INVENTORY_INVALID`
- **Evaluator** supports:
  - decimal, hex and octal integers with `U`/`L`/`UL`/`ULL` suffixes
  - unary `- ~`
  - binary `| & ^ << >> + -`
  - parentheses
  - references to other symbols defined in the same member, resolved recursively with a depth limit of 16
  - `_BITUL(n)` and `_UL(n)`
  - **Anything else raises `EXPRESSION_UNSUPPORTED`.**
- **Layouts:** natural alignment for `__u8 __u16 __u32 __u64 __s32 int`, fixed-size arrays of those, AAPCS64. Anything else raises `LAYOUT_UNSUPPORTED`.

**Steps:**

- [ ] **Step 1: Write the failing tests** in `DeriverTests`. Build each fixture tar in memory:
  - `test_define_and_enum_values_with_line_spans`: `#define A 3`, `#define B (A << 2)`, and `enum { C = 7 };` give values 3, 12 and 7, with exact `firstLine`/`lastLine`/`declaration`.
  - `test_expression_evaluator_suffixes_and_rejections`: `0x80000000U` → 2147483648; `(1UL << 3)` → 8; `_BITUL(31)` → 2147483648; `(X + 6)` with `X 1024` → 1030. `((int)1)` and `sizeof(int)` each raise `EXPRESSION_UNSUPPORTED`.
  - `test_conditional_definitions_require_pinned_condition`: two definitions of `F` under `#if W == 64` / `#else`. The inventory condition `["#if W == 64"]` selects the first, `["#else"]` the second, and `[]` raises `SYMBOL_AMBIGUOUS`.
  - `test_layout_offsets_and_size`: `struct s { int nr; __u32 arch; __u64 ip; __u64 args[6]; };` gives offsets 0/4/8/16 and size 64. A `char *p;` field raises `LAYOUT_UNSUPPORTED`.
  - `test_archive_member_missing_duplicate_or_changed_denied`:
    - wrong `archive_sha256` → `ARCHIVE_MISMATCH`
    - absent member → `MEMBER_MISSING`
    - two members with the same name → `MEMBER_DUPLICATE`
  - `test_symbol_absent_from_named_member_denied`: a symbol present only in a different member raises `SYMBOL_MISSING`.
  - `test_output_is_canonical_and_cli_refuses_existing_output`: the CLI output bytes equal `json.dumps(derive(...), sort_keys=True, indent=2, ensure_ascii=True) + "\n"`. A second run to the same path exits 2.
- [ ] **Step 2: Run `-B -m unittest discover -s tooling/production-acceptance/tests/unit/ -p abi_coverage_test.py -v`.** Expect every named test to fail on its assertion, not on an import or setup error. Keep the RED log.
- [ ] **Step 3: Implement `derive_abi_coverage.py` to the interfaces above.**
  - Stream with `tarfile.open(archive, 'r|xz')`. Read only inventoried members, at most 1 MiB each, with no NUL bytes.
  - Hash the archive before streaming.
  - Track the preprocessor condition stack by line. Do not evaluate `#if`.
- [ ] **Step 4: Run the same command.** Expect all `DeriverTests` to pass. Then run the broad Python suite. The only allowed non-pass is the pre-existing `bootstrap_reference_test` setUpClass error.
- [ ] **Step 5: Commit** these two files: `feat(acceptance): add offline Linux ABI coverage deriver`.

### Task 2: Inventory, committed coverage v2 and independent oracles

**Files:**
- Create: `tooling/production-acceptance/appliance/abi-inventory.json`
- Create: `tooling/production-acceptance/appliance/abi-coverage-v2.json`, generated by the CLI and committed
- Modify: `tooling/production-acceptance/tests/unit/abi_coverage_test.py` (add class `CoverageTests`)

**Interfaces:**
- Consumes: `derive`, the CLI and `AbiCoverageError` from Task 1.
- Produces:
  - `appliance/abi-coverage-v2.json`, in the Task 1 output schema
  - Test-module constants: `COVERAGE_V2_SHA` (SHA-256 of the committed file) and `ORACLES: dict[str, int]`

**Inventory scope.** Every ABI value used by `guest/confinement.py` (`build_filter`, the native bootstrap `syscall(...)` sites) and `guest/topology.py:2987-2997`:

| Group | Values | Header |
|---|---|---|
| Syscall numbers | The union of the syscalls called directly — `socket`, `socketpair`, `connect`, `sendto`, `write`, `prctl`, `seccomp`, `fcntl`, `mount`, `close_range`, `setgroups`, `setresgid`, `setresuid`, `capset`, `unshare` — and the 24 deny-listed numbers in `build_filter`. One inventory entry per distinct number, named by its `__NR_` symbol; some appear in both lists. | `include/uapi/asm-generic/unistd.h`, with `conditions` pinned where aliased |
| Seccomp | `SECCOMP_RET_KILL_PROCESS`, `SECCOMP_RET_ALLOW`, `SECCOMP_RET_ERRNO`, `SECCOMP_MODE_FILTER`, `SECCOMP_SET_MODE_FILTER`, `SECCOMP_FILTER_FLAG_TSYNC`; `seccomp_data` field offsets `nr`, `arch`, `args` and the size | `include/uapi/linux/seccomp.h` |
| Errno | `EPERM` | `include/uapi/asm-generic/errno-base.h` |
| Audit / ELF | `AUDIT_ARCH_AARCH64` | `include/uapi/linux/audit.h`, plus `EM_AARCH64` from `include/uapi/linux/elf-em.h` as its own entry |
| BPF | the instruction classes, sizes, modes, ops and sources composing opcodes `0x20`, `0x06`, `0x15`, `0x54`; `sock_filter` size | `include/uapi/linux/bpf_common.h`, `include/uapi/linux/filter.h` |
| prctl | the `PR_*` options and arguments used | `include/uapi/linux/prctl.h` |
| Capabilities | `CAP_LAST_CAP`, `_LINUX_CAPABILITY_VERSION_3` | `include/uapi/linux/capability.h` |
| Mount flags | the `MS_*` flags used | `include/uapi/linux/mount.h` |
| Namespaces | the `CLONE_NEW*` flags used | `include/uapi/linux/sched.h` |
| fcntl | `F_DUPFD_CLOEXEC`, `F_LINUX_SPECIFIC_BASE` | `include/uapi/linux/fcntl.h` |
| Socket | `AF_UNIX`/`AF_INET`/`AF_INET6`/`AF_VSOCK`; `SOCK_STREAM`/`SOCK_DGRAM`/`SOCK_SEQPACKET`; `O_CLOEXEC`/`O_NONBLOCK` (as `SOCK_CLOEXEC`/`SOCK_NONBLOCK`) | wherever Linux 6.8 actually defines them; non-uapi `include/linux/*.h` is allowed when that is the definition site |

**Policy literals are not ABI values.** Literals such as the `0xc0000000` syscall-number high-bit mask go in a separate test constant, `POLICY_LITERALS`, each with a one-line justification. The reviewer accepts each one.

**Steps:**

- [ ] **Step 1: Write the failing `CoverageTests`:**
  - `test_committed_coverage_reproduces_from_retained_archive`: run `derive()` on the pinned archive and committed inventory. The canonical bytes equal `abi-coverage-v2.json`, and its SHA-256 equals `COVERAGE_V2_SHA`.
  - `test_coverage_values_match_independent_oracles`: `{r['id']: r['value'] for r in records} == ORACLES`, exactly the same keys.
  - `test_coverage_supersedes_lost_coverage_without_claiming_it`: `supersedesLostCoverageSHA256` equals the lost hash, and `COVERAGE_V2_SHA` differs from it.
  - `test_event_reference_unchanged`: the SHA-256 of `appliance/bootstrap-event-reference.json` equals `a2e1be5762976e07f270c6646ce5e4d94c48efcc2c78dacaf29ed3e32471be7d`.
- [ ] **Step 2: Run the module.** Expect RED because the inventory and coverage files are absent. Keep the log.
- [ ] **Step 3: Author `abi-inventory.json`** with the scope above, one entry per value. Pin `conditions` by reading each definition's context.
- [ ] **Step 4: Generate the coverage file** with the CLI into the absent path `appliance/abi-coverage-v2.json`. Set `COVERAGE_V2_SHA` from it.
- [ ] **Step 5: Independent oracle transcription.** A separate agent, not the Task 1/2 implementer, reads each header's text from the archive by streaming the member (no deriver code). It writes `ORACLES` as literal ints with a `# <memberPath>:<line>` comment per entry. It must not open `abi-coverage-v2.json` until it is finished.
- [ ] **Step 6: Run the module.** Expect `CoverageTests` and `DeriverTests` to pass. If any oracle disagrees with the derivation, stop and resolve it with the reviewer. Never edit an oracle to match.
- [ ] **Step 7: Commit** the three files: `feat(acceptance): derive and commit Linux ABI coverage v2`.

### Task 3: Bind code literals to coverage

**Files:**
- Modify: `tooling/production-acceptance/tests/unit/abi_coverage_test.py` (add class `CodeBindingTests`)

**Interfaces:**
- Consumes:
  - the committed `abi-coverage-v2.json` and `POLICY_LITERALS` from Task 2
  - `guest.confinement.build_filter(role) -> tuple[tuple[int, int, int, int], ...]`
  - `confinement.UIDS`
- Produces: test-only tables `SYSCALL_SITES: dict[str, str]` (nr symbol → expected owning file) and `ARG_SYMBOLS: dict[str, dict[int, frozenset[str]]]` (syscall symbol → argument index → allowed flag/option symbols).

**Steps:**

- [ ] **Step 1: Write the failing tests:**
  - `test_filter_opcodes_and_returns_are_covered`: for every role in `confinement.UIDS`, every instruction's `code` is an OR of covered BPF symbols, and every `RET` `k` is in `{KILL_PROCESS, ALLOW, ERRNO|EPERM}` from coverage.
  - `test_filter_comparisons_are_covered_per_loaded_field`: walk the program tracking the last `BPF_LD|BPF_W|BPF_ABS` offset. Every offset is a covered `seccomp_data` offset (`args[i]` low and high words included). Every `JEQ` constant compared while `nr` is loaded is a covered `__NR_*` value. Every constant compared while `arch` is loaded equals `AUDIT_ARCH_AARCH64`. Every `ALU AND` constant is in coverage-derived masks or `POLICY_LITERALS`.
  - `test_filter_deny_list_matches_named_syscalls`: the set of nr constants whose `JEQ` jumps to the deny label equals the coverage values of the 24 inventoried deny symbols. There is no extra or missing number.
  - `test_syscall_sites_use_covered_numbers`: `ast`-parse `guest/confinement.py` and `guest/topology.py`. Every `Call` whose function name is `syscall` with an int-literal first argument uses a covered `__NR_*` value. The set of symbols used per file equals `SYSCALL_SITES`.
  - `test_syscall_flag_arguments_decompose_into_covered_symbols`: for each site, the int literals and `|`-of-int-literal arguments at the indices named in `ARG_SYMBOLS` decompose exactly into the allowed symbols' values. Any leftover bit fails. Also cover the `range(41)` capability loop, which must equal `CAP_LAST_CAP + 1`, and the `capset` header version `_LINUX_CAPABILITY_VERSION_3`.
- [ ] **Step 2: Run the module.** Expect RED on the absent tables, not on import errors. Keep the log.
- [ ] **Step 3: Fill in `SYSCALL_SITES` and `ARG_SYMBOLS`** from reading the code sites. No guest source edits.
- [ ] **Step 4: Run the module and the broad Python suite.** Expect everything to pass except the pre-existing `bootstrap_reference_test` error. If a literal is not covered, stop: that is a product finding, not a table edit.
- [ ] **Step 5: Commit** the test file: `test(acceptance): bind guest ABI literals to coverage v2`.

### Task 4: Unblock `bootstrap_reference_test.py`

**Files:**
- Modify: `tooling/production-acceptance/tests/unit/bootstrap_reference_test.py:18`, `:20`, `:192-193`, `:229`

**Interfaces:**
- Consumes: `COVERAGE_V2_SHA` and the path from Task 2.
- Produces: no new names.

**Steps:**

- [ ] **Step 1: Write the failing test** `test_v1_lost_parent_coverage_is_recorded_and_superseded`. It asserts:
  - the reference's `parentCoverageSHA256` equals the lost hash
  - `abi-coverage-v2.json` exists with SHA-256 `COVERAGE_V2_SHA`
  - its `supersedesLostCoverageSHA256` equals that same lost hash
- [ ] **Step 2: Run** `-p bootstrap_reference_test.py -v`. Expect RED: the setUpClass still fails on the lost file. Keep the log.
- [ ] **Step 3: Change the setup.** Replace the setUpClass `COVERAGE.read_bytes()` hash check with a check that the committed v2 file has hash `COVERAGE_V2_SHA`. Rename the old constant to `LOST_PARENT_COVERAGE_SHA` (unchanged value). Line 229 compares `parentCoverageSHA256` against it. Do not touch any other assertion.
- [ ] **Step 4: Run** the focused suite, the broad Python suite and the Node suite. Expect all Python tests to pass with no errors: the earlier 353, including the 8 reference tests, plus the new `abi_coverage_test` tests. Expect Node 402/402. Then run the full Swift suite with the composition-v1 fixture recipe. Expect 181/181: no Swift input changed, so this is confirmation only.
- [ ] **Step 5: Commit**: `test(acceptance): unblock bootstrap reference tests with coverage v2`.

### Task 5: Independent review and record

**Files:**
- Create: `.superpowers/sdd/2026-09-30-production-acceptance-controller/m4-abi-coverage-v2/report.md`

**Steps:**

- [ ] **Step 1: Fresh, read-only, whole-change review** of Tasks 1–4. The reviewer independently streams each inventoried header member and checks **every** coverage record's declaration, condition stack and value against the source text. The reviewer also checks the deriver's refusal paths and the `CodeBindingTests` tables against the guest code. Verdict: ACCEPT, ACCEPT_WITH_NOTES or REJECT, with file:line findings.
- [ ] **Step 2: Fix accepted in-scope findings.** Each fix is its own commit, re-reviewed by the same reviewer.
- [ ] **Step 3: Write `report.md`** in the format of `stage1-f4-handoff-fix/report.md`. Include:
  - commits
  - exact commands and counts
  - the verdict and findings with dispositions
  - the statement "new derivation; the lost 7c8714c9… is not recovered"
  - the M4 status: still **open**; the whole-M4 review and the real gate (Stage 2) remain
- [ ] **Step 4: Commit**: `docs(acceptance): record reviewed ABI coverage v2`. Stop. No push.

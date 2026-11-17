# Stage 1 F-4 — bootstrap v1 handoff test fix: reviewed offline checkpoint

| | |
|---|---|
| Date | 2026-11-16 |
| Baseline | `31a513e5b8dc84ed71be3adb5611ca549a176bf3` (`codex/production-acceptance-m1`) |
| Fix commit | `54e5b6e55d29b6973263d0aae4d53630af93522d` on `claude/production-acceptance-stage1` |
| Change | Test-only, 2 lines: `host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift:650` and `tests/unit/topology_test.py:2149`. No product code changes. |
| Toolchain | Owner-approved re-pin (2026-11-16): CLT 27.2 / Swift 6.4.2 / SDK 27.2. Node 24.21.0 and Python 3.12.2 unchanged. Host macOS 27.2.1 arm64. |

## Defect

`BootstrapGateTests.v1_guest_handoff_matches_original_host_run_and_inventory` failed with `VMFailure.admissionUnavailable` when it was given the topology exporter's bootstrap-v1 handoff. That exporter is the only committed producer of a v2 handoff file. There were two test-data causes, both present since `284f946`.

1. **Key bytes.**
   - The test built the capability from `UInt8(ascii:"7")`, which is `0x37`.
   - The exporter MACs with `CAPABILITY = bytes([7]) * 32`, which is `0x07` (`topology_test.py:37`, `:2167`).
   - Swift recomputed the fixture MAC: it matches with `0x07` and not with `0x37`.
2. **Pipe direction.**
   - The exporter's synthetic `roleRuntime` gave fd 4 (RESULT) `flags=0`.
   - Children receive the command read end at fd 3 and the result write end at fd 4 (`guest/confinement.py:1389`, `:1427-1429`).
   - Both the Swift validator (`VMHost.swift:393`) and the guest fdinfo check (`confinement.py:1160-1163`) require fd 3 = read-only and fd 4 = write-only. The fixture was wrong; the validator is right.

How it was found: byte-for-byte JSON re-serialization in Swift (equal), then MAC recomputation, then temporary line-number instrumentation of `BootstrapHandoff.verify` in a throwaway worktree. The instrumentation was never committed.

## Verification at the exact commit `54e5b6e` (clean tree)

Sanitized environment, physical non-symlinked `TMPDIR`, outbound IP denied for the Node and Python runs. Swift ran offline with SwiftPM's flags and `-j 1`. Fixture producers and consumers followed `docs/superpowers/plans/2026-10-03-bootstrap-composition-v1.md`.

| Suite | Result |
|---|---|
| Broad Node unit | 402/402 pass |
| Broad Python unit | 345 run, 345 pass, 1 setUpClass error, so the run exits FAILED |
| Fixture producers (appliance, topology, Node receipts, composition exchange) | all pass |
| Node composition consumer | 35/35 pass |
| Broad Swift | **181/181 pass** |
| Swift → Node receipt consumer | 150/150 pass |
| Fixture inputs | unchanged by consumers (hashes compared) |

- **The Python setUpClass error** is pre-existing and unrelated: `bootstrap_reference_test.py` requires an uncommitted, lost M4 `abi-coverage.json`, so its 8 tests do not run.
- **Python noise.** As in earlier records, `protocol_test.py` background writer threads printed `termios` bad-file-descriptor tracebacks after their descriptors closed. These are not failures.

`BOOTSTRAP_V1_HANDOFF_INPUT` was bound to `<TASK10_TOPOLOGY_OUTPUT>.bootstrap-v1.json`. **This binding was inferred.** No plan or commit records it.

Before this fix, the same Swift command gave 180/181. With the fix applied but uncommitted, results were identical.

## Independent review

A separate fresh-context reviewer, read-only, returned **ACCEPT_WITH_NOTES**: "minimal and complete for its stated aim". It also said: "no validator weakened". None of the notes blocks this commit. All findings are follow-ups.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | Medium | The original `0x37` key matches the composition Harness (`bootstrap_composition_test.py:610`, `:1132`). Its fake fdinfo already gives fd 4 = `01` (`confinement_test.py:135`). The test may originally have targeted an uncommitted export of that owner-composed handoff, which fits the plan's "actual Python-produced v2 handoff". The exporter's hand-built `roleRuntime` is weaker provenance. | Follow-up for the Stage 1 composition review. Either keep the exporter binding (this commit) or add a committed Harness handoff export and bind the test to it. Record the choice either way. |
| 2 | Medium | Neither Python validator checks pipe direction (`guest/topology.py:2281-2304`, `confinement.py:1205-1240`); Swift does. Real rows are direction-checked at the source (`confinement.py:1159-1163`, via `inspect_runtime`). A defense-in-depth gap. Python also cannot export a direction-flip invalid vector. | Follow-up: decide whether Python should enforce the same rule. |
| 3 | Low | `topology_test.py:419` also builds fd 4 with `flags=0`. It is never exported, and nothing depends on it. | Follow-up, for consistency. |
| 4 | Low | The fixture's NULL rows and PROXY_LISTENER row (`topology_test.py:2154`) use `flags=0`. Real `/dev/null` and listener sockets are read-write. No validator checks them. | Follow-up. |
| 5 | Low | No Swift test reads `.bootstrap-v1.invalid.json`, despite composition plan line 115. `BOOTSTRAP_V1_HANDOFF_INPUT` is undocumented, and there is no committed runner script. | Follow-up. |
| 6 | Low | In this test `originalRoleRuntime` is the fixture's own `roleRuntime`, so the original-vs-current comparison (`VMHost.swift:375`) is tautological. Side benefit of this commit: the re-signed negative vectors (`BootstrapGateTests.swift:655-668`) previously failed on the fd 4 defect whatever the mutation was. They are now meaningful. | Follow-up. |
| 7 | Low | Commit message accuracy. "Every other … test" holds only for the Swift tests (`bootstrap_composition_test.py` and `intake_test.py` use `b'7'*32`). The Python broad run exits FAILED (the pre-existing error above). The reviewer could not confirm the after-fix runs used the committed tree. | Corrected here; the commit is not amended, so the reviewed identity stays stable. The suites were re-run at exactly `54e5b6e` (above). |

## Not performed

No push, merge, package install, download, signing, VM, browser, credential, production or trading action.

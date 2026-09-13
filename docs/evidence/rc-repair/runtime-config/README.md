# Runtime configuration verification

Baseline: `d620aab5e56fdf41a986734bdf516ec028889f15` (safety repair). These are targeted runtime/config checks, not the subsequent full verifier or production-container result.

Commands ran from the repository root with `PATH=/private/tmp/day-trader-rc-node24/node-v24.21.0-darwin-arm64/bin:/usr/local/bin:/usr/bin:/bin`:

```sh
node --test --test-reporter=tap scripts/tests/verify-mvp.test.mjs
node docs/evidence/rc-repair/runtime-config/config-check.mjs
```

- `verifier-red.log`: exit 1 before runtime implementation; the exact supported-runtime acceptance test rejected the old Node 20 gate.
- `verifier-green.log`: exit 0 after runtime implementation; 15 tests passed, no failures or skips. The npm PATH substitution test rejects a different executable even if it reports the expected version string.
- `config-proof.json`: exit 0; exact runtime provenance, source hashes, coherent pins, package/lockfile changes restricted to root engine metadata, all 23 gate IDs and mandatory scenario arrays preserved, required Docker exclusions present.
- `config-check.mjs`: exact local proof program, preserved for rerun. It reads the safety baseline with `git show`; it does not install packages or change repository files.

Both Dockerfiles now use `--ignore-scripts --no-audit --no-fund` during lockfile installation, matching the verifier's install policy; the backend additionally uses `--omit=dev`. No dependency version or resolved package/integrity record changed. Both contexts exclude `.env*`, `.npmrc`, host `node_modules`, and host `build` output. Production compatibility and image vulnerability assessment are separate required checks.

This evidence contains public package metadata, source file paths/hashes, command names, and local runtime paths. No environment dump, source credentials, npm/Docker configuration, or binary artifacts were copied. Official release/checksum/manifest provenance is in the adjacent `runtime-preparation` directory.

## Node 24 TAP protocol follow-up

The first full Node 24 run emitted the default spec reporter for Node test gates. Although their tests passed, the verifier correctly rejected output without the mandatory TAP summary. The original full-run result remains preserved separately under `runtime-verifier/`.

The bounded correction adds `--test-reporter=tap` to every gate with `summary: 'tap'`, including generated Mongo gates. It does not change the summary parser, required scenario identities, minimum counts, or the 23 mandatory gate IDs.

`tap-protocol-red.log` records the actual Node 24 protocol regression before the correction (exit 1). `tap-protocol-green.log` records the same targeted test command afterward (16 passed, zero failures/skips, exit 0). The regression executes each gate's Node test options against an assertion fixture and passes its actual output through the production acceptance parser. Missing, failed and skipped required-scenario records remain rejected.

The commands are the same as above. The configuration proof was rerun after the correction with output preserved as `config-proof-tap.json` (exit 0), retaining the earlier proof file unchanged. Its source hashes identify the corrected verifier and regression test files. Full combined acceptance remains a separate parent-run check.

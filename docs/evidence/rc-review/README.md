# Preserved independent review evidence

These are unchanged historical inputs for the RC-001, RC-002 and RUNTIME-001 repair, reviewed against `1972254bfcfd0b6ff724876cd0d2a2b15006ac26`. `preservation-manifest.json` maps each original temporary path to its durable copy and records SHA-256 hashes, inspection scope, provenance and limitations. No files were unavailable.

The original report, probes and logs remain verbatim. Their absolute paths refer to the historical environment; preservation does not make probes safe to run against arbitrary current state. Original probes printed violations and are not asserting regression tests. Their interpreter provenance was incomplete and is not attributed to the separate historical Node 20.20.2 full-verifier run.

The historical 19-gate report is preserved unchanged and is not a pass for the newly required RC scenarios or a supported-runtime pass. Later repair evidence belongs under `../rc-repair/`. Historical npm audit errors are failures to contact the registry, not successful zero-finding audits.

## Secret inspection and redactions

Pre-copy inspection checked private-key markers, common provider/GitHub/AWS credential patterns, JWT values, credential-bearing URLs, and contextual credential references. No secret values were identified. No redactions were applied. Disposable fixture identities, public endpoints, local paths and immutable hashes remain to preserve reproduction provenance. The bounded inspection does not claim an exhaustive secret audit.

The operator-added master brief remains at `docs/Day_Trader_Agentic_MVP_Master_Brief.md`, untracked and excluded from committed copies. Its inspected hash/provenance is recorded separately in the manifest.

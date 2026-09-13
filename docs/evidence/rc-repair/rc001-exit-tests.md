# RC001 remaining exit dispatch assertions

The bounded executable suite `scripts/acceptance/rcExitDispatch.test.cjs` adds ten named scenarios. The final run passed 10/10, failed 0, skipped 0, canceled 0, todo 0, with process exit 0. These tests extend the previously repaired implementation; this run is not presented as a new historical red reproduction or a complete safety verifier run.

Exact executed command, from `/Users/Matt/Projects/day-trader`:

```sh
node --test scripts/acceptance/rcExitDispatch.test.cjs > docs/evidence/rc-repair/rc001-exit-green.log 2>&1
```

Runtime was Node `v24.19.0`, executable `/Users/Matt/.nvm/versions/node/v24.19.0/bin/node`. Each scenario stamps both in its diagnostic output. The reviewed working tree was based on HEAD `1972254bfcfd0b6ff724876cd0d2a2b15006ac26`; it includes uncommitted repairs. `rc001-exit-evidence.json` records source/test/helper hashes after the final run, and `rc001-exit-green.log` preserves the asserting run's exact provider request trace. Hashes describe the shared working tree at capture time, not an immutable committed release.

The suite uses separate disposable `mvp_test_browser_*` Mongo replica-set databases on port 27189, the actual backend process, authenticated owner HTTP routes, actual reconciliation/worker child processes, and a loopback provider transported by the existing acceptance preload. It does not contact Alpaca, SMTP, inference, or deployment services. Cleanup releases held responses, stops fixture children, and drops only the fixture database. Production source and shared fixture helpers were not edited for this suite.

| Stable scenario ID | Controlled final account occurrence after fixture setup | Persisted boundary and resulting assertions |
| --- | --- | --- |
| `RC001-protection-cancel-final-account-takeover` | 4 | Partial entry already has a two-share stop; later full fill requires resize. Actual protection is `cancel_pending`, original stop identity retained, no cancellation claim. Replace the exit lease owner before releasing account response: no DELETE, no extra POST, original stop remains active, full fill remains accounted, final denial is specifically dispatch lease loss. |
| `RC001-protection-cancel-final-account-expiry` | 4 | Same scenario with actual lease expiry before release. |
| `RC001-close-post-final-account-takeover` | 4 | Actual close is active/submitting and its canonical sell is submitting with no claim. Takeover before release yields a durable rejected sell with dispatch-lease-loss reason, zero closing POST, unchanged holdings and stable close identity. |
| `RC001-close-post-final-account-expiry` | 4 | Same scenario with lease expiry. |
| `RC001-close-protection-cancel-final-account-takeover` | 2 | Close persists `cancel_pending` and the exact owned protective stop cancellation step before adapter preflight. Takeover prevents DELETE or close POST; close remains active/cancel_uncertain, original stop remains new, persisted reason is dispatch lease loss. |
| `RC001-close-protection-cancel-final-account-expiry` | 2 | Same scenario with lease expiry. |
| `RC001-close-exit-cancel-final-account-takeover` | 4 | A healthy close POST succeeds while entries disabled. Its persisted deadline is then expired; retry persists `exitCancelRequested` and canonical `cancel_pending`. Takeover prevents DELETE, retains active close ownership and full outstanding sell quantity, preserves original order/client identity, and records dispatch lease loss. |
| `RC001-close-exit-cancel-final-account-expiry` | 4 | Same scenario with lease expiry. |
| `RC001-reducing-replacement-final-account-disable` | 2 | Owner requests lower quantity and lower limit price. After replacement intent is durably pending, ordinary disable completes before release. Exactly one PATCH succeeds with the expected successor client identity and both reductions; only one logical intent and one original POST exist. |
| `RC001-reducing-replacement-final-account-emergency-stop` | 2 | Same replacement preflight; actual emergency-stop child persists `stopCancelRequested` before release. Zero PATCH, no replacement claim, original reservation and stable pending replacement identity retained; explicit emergency-supersedes-replacement reason is persisted. |

Every lease case first verifies a real, unexpired lease owned by the operation. It then mutates only that fixture lease and releases the provider response. Takeover cases verify that stale-executor cleanup preserves the replacement owner. Every child used by the suite must exit successfully (`h.run` rejects nonzero status); every owner request must return HTTP 200, and expected persisted outcomes/reasons are asserted. An unrelated exception producing no provider write cannot satisfy the refusal assertions.

These barriers model lease loss before durable dispatch authorization D. They do not claim that losing a lease or stopping after an already committed D can prevent subsequent transport T. Process death, response loss, claim retries and unknown-commit handling belong to the separate RC001 primary/process suites. No new exit-loss production defect was reproduced by this bounded suite.

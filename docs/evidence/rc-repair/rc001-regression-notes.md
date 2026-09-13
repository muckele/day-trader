# RC001 process regressions and mandatory verifier coverage

This work extends the existing local acceptance harness, production backend, actual worker processes, Mongo replica set and controlled HTTP provider. It does not replace the worker's lock implementation or permit external brokerage/SMTP/model requests.

## Original fail-before evidence

`rc001-original-red.json` and `rc001-original-red.log` record the exact reviewed SHA `1972254bfcfd0b6ff724876cd0d2a2b15006ac26`, an empty tracked backend diff before execution, Node `v20.20.2`, executable `/private/tmp/day-trader-mvp-runtime/node_modules/node-bin-darwin-arm64/bin/node`, exact command and exit status. All four initial regression tests failed on the demonstrated safety invariant: one forbidden order POST after a final-account barrier, expected zero. The variants were emergency stop, ordinary authenticated disable, lease takeover and lease expiry. Result: 0 pass / 4 fail / 0 skipped, exit 1.

The first sandbox attempt failed with `EPERM` opening a loopback listener. It is preserved separately as `rc001-original-listen-blocked.*`; it is not presented as behavioral red evidence. The later authorized loopback run supplied the asserting reproduction.

## Additional boundary findings during repair

- `rc001-later-boundaries-first.log`: the initial repair still permitted a POST after a production heartbeat callback encountered a controlled database renewal failure while the final account GET was held. Its final claim had not consulted the executor's lost-heartbeat state. The same run passed both awaited-renewal ordering tests. `rc001-heartbeat-green.log` shows the targeted heartbeat correction passing.
- `rc001-legacy-writer-red.log`: authenticated `PUT /api/robo/settings` disabled both flags but left control generation 0→0. This is evidence of a control-ordering defect, not a separate observed forbidden POST. `rc001-legacy-writer-green.log` shows generation 0→1; re-enable does not restore the stale worker's authority.
- `rc001-full-first.log`: 17 pass / 2 fail / 0 skipped. These two failures were test errors: the assertion counted a legitimate cancellation claim as a second submission claim. It was corrected to require exactly one `submit` claim and preserve its original token. The preceding exact-client-identity, one-POST and healthy stop-drain assertions already passed. No production repair was inferred from this test mistake.
- `rc001-full-green.log`: the subsequent complete 19-scenario run passed 19 / failed 0 / skipped 0, exit 0. This preceded addition of the legacy writer case.
- `rc001-final-targeted.log`: complete twenty-scenario run after the legacy correction and explicit healthy stop-before-claim assertions: 20 pass / 0 fail / 0 skipped, exit 0, 47.3 seconds. Command: `/private/tmp/day-trader-mvp-runtime/node_modules/node-bin-darwin-arm64/bin/node --test scripts/acceptance/rcDispatch.test.cjs`; Node v20.20.2. This is safety-repair evidence on the current working tree, not the separately required supported-Node24 combined verification.

Filtered development runs intentionally skipped nonselected cases. They are recorded as targeted checks, never substituted for the mandatory complete suite. The final complete safety verifier and later supported-runtime verifier are the combined-candidate authorities; historical 19/19 reports remain unchanged.

## Required assertions

`scripts/acceptance/rcDispatch.test.cjs` contains twenty-five stable scenario identities:

- Four final-account barriers: emergency stop, ordinary disable, worker lease takeover and lease expiry. Each asserts one preserved intent/client identity, zero POST, rejected pre-claim status and released reservation. Disable/emergency cases additionally prove the API reaches stopped after rejection.
- Heartbeat loss at that final provider boundary.
- Stop while the final callback awaits lease renewal; disable followed by re-enable at the same boundary.
- Durable claim before stop before transport, with resume, killed process/restart, and lease takeover. The tests inspect the real committed payload hash/account/environment/generation/executor and exact client identity. Repeated 404s never authorize a fresh POST. A stopped but potentially live claimant remains draining; confirmed terminal cancellation completes healthy drains.
- Already-transmitted acknowledged and accepted-but-response-lost entries. Only owned opening risk is canceled; foreign orders are preserved; reservations release after terminal confirmation.
- Real dispatch transaction commits but its acknowledgment is lost. Restart/retry/reconcile preserves the claim/client identity and reservation without posting.
- Entry disable preserves necessary protection, authorized coordinated reduction and deliberate owner manual-entry policy.
- Protection and reduction each lose their own lease by expiry/takeover at final account preflight and produce no stale sell POST.
- Actual authenticated Run Once endpoint held at final preflight, with independent emergency stop.
- Legacy control endpoint participates in generation transition; re-enable cannot revive a request from before that transition.
- Process death before final claim retains the original unresolved identity and reservation across stop/re-enable/retry; no new POST.
- Process death after provider acceptance but before local broker-order persistence reconciles the actual accepted broker identity with one POST.
- An actually sent POST has both response and query visibility held; stop runs before a two-share partial fill is revealed. Reconciliation cancels only the opening remainder, retains exactly two filled shares and $200 spending, releases pending reservation and establishes a two-share protective stop.
- A real Mongo dispatch transaction callback retries after a controlled write conflict without performing a broker write in the callback or duplicating the eventual POST.
- A controlled database error aborts the dispatch transaction before commit, creates no dispatch claim/POST and retains conservative identity/reservation state across retry.

Test-only controls live in `scripts/acceptance/transport.cjs` and the harness, not production services. The transport barrier pauses the real Axios adapter immediately before loopback HTTP. Heartbeat tests invoke the registered production callback under controlled scheduling; renewal failures are injected at the Mongoose boundary. Ambiguous-commit tests execute the real transaction and throw only after committed completion. These controls do not stub away canonical persistence or lease ownership.

## Verifier contract

`scripts/verify-mvp.mjs` requires `rc-dispatch`, `rc-exit-dispatch`, `mongo-rc002Exposure.mongo`, and `rc-exposure-process` alongside the old required gates. RC001 twenty-five primary names and ten exit-boundary names, RC002 twenty-four Mongo child names and the real-worker exposure scenario are checked as actual TAP result records. Omission, skip, todo, failed result, duplicate result and inflated aggregate totals cannot substitute for a required scenario. `scripts/tests/verify-mvp.test.mjs` exercises these rejection paths; 13 verifier tests pass.

The optional `--report-dir <directory>` changes only the output destination. Default behavior remains `docs/evidence/verification`. For repair verification use `--report-dir docs/evidence/rc-repair/safety-verifier` to preserve the historical report directory. Missing/duplicate directory arguments fail explicitly. No flag weakens the acceptance requirements.

## Independent assertion-review follow-up

After the complete safety verifier passed 22 gates, independent review found two gaps in the test assertions. The historical safety-verifier report remains unchanged and predates these follow-up test edits.

1. Three retry-child paths previously awaited process completion and checked zero POST without requiring successful completion. They now require exit 0, parse `ACCEPTANCE_RESULT`, and assert the exact original intent ID, client ID, expected unresolved status, Alpaca-paper source and absence of an invented broker order. A broken retry driver can no longer satisfy the test by crashing before dispatch.
2. The resume/takeover drain tests previously issued a second emergency stop after the held transport resumed. They now assert the first stop's durable `stopCancelRequested` flag, release transport, run reconciliation only, and require the original broker order/local intent to become canceled and stop status to become stopped. This proves completion from one stop request. The resumed worker must also exit successfully and return the original intent identity.

These changes strengthen test observations; they do not change the production stop/dispatch contract. Complete follow-up command: `/private/tmp/day-trader-mvp-runtime/node_modules/node-bin-darwin-arm64/bin/node --test scripts/acceptance/rcDispatch.test.cjs`. Output is preserved in `rc001-assertion-followup.log`; supported-runtime combined verification remains separately required.

Follow-up result: Node v20.20.2, 20 pass / 0 fail / 0 skipped, exit 0, 53.3 seconds. Both strengthened retry and one-stop drain assertions passed. No production changes were needed for these assertion corrections.

## Remaining mandatory ordering-matrix coverage

The invariant review's full matrix required additional cases beyond the original twenty. Five primary process/database/response scenarios were added and passed on first execution against the repaired implementation: `rc001-extra-matrix-first.log` records 5 pass / 0 fail / 20 intentionally filtered skips, exit 0, Node v20.20.2. These are newly added coverage on corrected code, not newly reproduced production defects or claimed original-candidate red evidence.

The exit-boundary workstream separately owns `scripts/acceptance/rcExitDispatch.test.cjs`: protective cancellation; coordinated close submission, protection cancellation and exit cancellation under final-preflight lease expiry/takeover; and reducing replacement under ordinary disable/emergency stop. Its ten explicit identities are mandatory in the verifier's `rc-exit-dispatch` gate. The complete verifier now requires 23 gates. The prior 22-gate safety report remains historical evidence from before this matrix expansion.

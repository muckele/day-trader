# Independent review: Tasks 13 (b401be1), 14 (cb1c19a), 15 (31a513e). Phase M6

Reviewer: independent Stage 1 reviewer, 2026-11-17. Offline only. No network, installs, VM, browser or signing. The worktree was read-only; edits and runs used scratch copies only.

## 1. Verdict

**REJECT.** No Critical break was found. The real launch path still stops at the missing native effect fence, so nothing can reach production. But Task 13–15 cannot be trusted until these are fixed:
- **Startup navigation is denied.** The worker opens `/`, which the route table denies before login.
- **Headers bypass admission.** The worker drops any non-allowlisted header, including `Authorization`, before admission and then continues the request.
- **Frontend integrity checks are partial.** Document bytes are never checked. Asset responses after READY are not checked, and their failures are silently dropped.
- **Readiness is not bound.** The only real readiness check, inside the worker, has no negative test. The controller-side `ReadinessProof` can be minted from any object literal.
- **Descriptor inventory cannot fire.** It cannot detect vsock or `hvc0` console descriptors.
- **Route denials are swallowed.** The controller does not latch or report them.
- **Several security checks are unbound.** Mutations removing them survive every test.

## 2. Scope reviewed

- **Range:** `763b329..31a513e`, three commits.
  - `b401be1`: Task 13, "add confined browser lifecycle".
  - `cb1c19a`: Task 14, "bind owner UI login to one session".
  - `31a513e`: Task 15, "verify readiness and private UI observations".
- **Reviewed base, not re-reviewed:** `763b329`, the Task 13 compatibility amendment. I read its record, `.superpowers/sdd/2026-09-30-production-acceptance-controller/task13-compatibility-amendment/report.md`, `execution.json` and `source-hashes.json`.
- **Plan sections:** `docs/superpowers/plans/2026-09-30-production-acceptance-controller.md`:
  - Task 13: lines 523–544.
  - Task 14: lines 546–566.
  - Task 15: lines 568–588.
  - Also: the contract catalogue (lines 118–129), the global constraints and the phase table.
- **Design:** `docs/PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md` §§7, 8, 9.2–9.4, 10, 12, 13, 15, 16, 17 and 18.
- **Other inputs:** the Option A record, `m4-abi-coverage-v2/report.md` (item m3 on the seccomp check), and the M4 disposition.
- **Files in scope:** `guest/browser.cjs`, `guest/browser-worker.cjs`, `guest/session.cjs`, `guest/observation.cjs`, `package.json`, `package-lock.json`, and their unit and guest tests.
  - I read these related files only to judge integration: `role-ports.cjs`, `budget.cjs`, `receipts.cjs`, `route-policy.cjs`, `contracts/routes.json`, the frontend `Login.js`, `AuthContext.js` and `Portfolio.js`, the backend `runtimeReadiness.js` and `sessionCookie.js`, and the host `VMConfiguration.swift`.
- **State at HEAD `132b67e`:** every in-scope file is byte-identical to `31a513e`. `git diff --stat 31a513e..132b67e` touches none of them. All findings below are therefore still present at HEAD, with the same line numbers.

## 3. Findings

All file paths are relative to `tooling/production-acceptance/` unless stated.

| ID | Sev | File:line at HEAD | At HEAD | Evidence | Suggested fix |
|---|---|---|---|---|---|
| I-1 | Important | `guest/browser-worker.cjs:627`; `tests/unit/browser.test.cjs:513-520`; `contracts/routes.json:5-6`; `guest/route-policy.cjs:302` | yes | See I-1 below | See I-1 below |
| I-2 | Important | `guest/browser-worker.cjs:371-377,615`; `guest/route-policy.cjs:188-192`; backend `utils/sessionCookie.js:29-35` | yes | See I-2 below | See I-2 below |
| I-3 | Important | `guest/browser-worker.cjs:621-631`; `guest/receipts.cjs:94` | yes | See I-3 below | See I-3 below |
| I-4 | Important | `guest/browser-worker.cjs:101-108,229-237`; `guest/observation.cjs:53-70,122-123,147`; `tests/guest/observation_test.cjs:31-36` | yes | See I-4 below | See I-4 below |
| I-5 | Important | `guest/route-policy.cjs:178,303-304,348-349`; `guest/receipts.cjs:190`; `guest/browser-worker.cjs:229-243` | yes | See I-5 below | See I-5 below |
| I-6 | Important | `guest/browser-worker.cjs:431-439,450-458`; `tests/guest/browser_test.cjs:82-84`; `host/Sources/AcceptanceCore/VMConfiguration.swift:193` | yes | See I-6 below | See I-6 below |
| I-7 | Important | `guest/browser.cjs:163-172`; `guest/budget.cjs:221-237` | yes | See I-7 below | See I-7 below |
| I-8 | Important | `guest/browser.cjs:15,40-50,138-143,269`; `guest/session.cjs:36-37`; `guest/observation.cjs:144-146`; `tests/unit/browser.test.cjs:442-450` | yes | See I-8 below | See I-8 below |
| I-9 | Important | `guest/browser-worker.cjs:269-271`; `guest/observation.cjs:114-116`; `tests/unit/observation.test.cjs:190-195,223-228` | yes | See I-9 below | See I-9 below |
| I-10 | Important | various (see I-10 below) | yes | See I-10 below | See I-10 below |
| m-1 | Minor | `guest/browser-worker.cjs:425-430` | yes | See m-1 below | See m-1 below |
| m-2 | Minor | commits `cb1c19a`, `31a513e`, `b401be1` | yes | See m-2 below | See m-2 below |
| m-3 | Minor | `tests/guest/session_test.cjs:1-38`; `tests/guest/observation_test.cjs:9-38` | yes | See m-3 below | See m-3 below |
| m-4 | Minor | `guest/session.cjs:70-77`; `guest/browser-worker.cjs:575-576` | yes | See m-4 below | See m-4 below |
| m-5 | Minor | `tests/unit/session.test.cjs:66-76` | yes | See m-5 below | See m-5 below |
| m-6 | Minor | `guest/browser.cjs:174-181,245-253` | yes | See m-6 below | See m-6 below |
| m-7 | Minor | `guest/browser-worker.cjs:550,433` | yes | See m-7 below | See m-7 below |
| m-8 | Minor | `guest/browser.cjs:177,226-227`; `guest/browser-worker.cjs:581,638` | yes | See m-8 below | See m-8 below |
| m-9 | Minor | `guest/observation.cjs:72-79,151` | yes | See m-9 below | See m-9 below |

### I-1. Startup navigation targets `/`, which the route table can never admit before login

**Evidence**
- The worker calls `page.goto(config.runBinding.origins.FRONTEND)`. The origin is validated to have no path, so the request is GET `/`.
- `routes.json` allows `/` only in phase A. `route-policy.cjs:302` also requires `sessionIssued` and an armed `homeTransition`.
- Phase P allows only `/login`. The frontend reaches `/login` by redirecting on the client.
- The real Playwright would reject `goto` and the worker would fail before READY. The flow can never start.
- The plan test `initial_navigation_route_is_decided_before_assets_and_ready` accepts either `CONTINUE` or `ABORT`. The fake `goto` ignores an abort and still emits the asset response.
- Demo D1 (phase PREFLIGHT): the initial `/` was decided `ABORT`, and READY was still reached.

**Fix**
- Navigate to `FRONTEND + '/login'`.
- Make the fake `goto` reject when the route is aborted.
- Make the test assert `CONTINUE` in phase P.

### I-2. Header bypass: unknown headers are dropped, not denied

**Evidence**
- `factsFor` keeps only `origin`, `content-type`, `accept` and the two `access-control-request-*` headers before the ROUTE frame. The `route.continue()` call then forwards the original headers.
- The route policy's own rule, which denies any header outside the allowlist (`route-policy.cjs:191`), therefore never fires.
- Design §10 requires rejecting "unexpected body/headers, method overrides".
- The backend `readSessionToken` prefers `Authorization: Bearer` over the session cookie. A hostile or tampered frontend could therefore send allowed GETs under a different identity.
- Demo D3: a login POST carrying `authorization: Bearer other-identity-jwt`, `x-http-method-override: DELETE` and `x-arbitrary` was continued. The controller saw only `[["content-type","application/json"]]`.

**Fix**
- Forward every header except an explicit, reviewed list of browser-generated headers (user-agent, sec-ch-*, sec-fetch-*, referer, accept-language, accept-encoding, and similar).
- Abort locally on `authorization`, `cookie` set by script, `x-*` and method-override headers.
- Add a test for each.

### I-3. Frontend integrity is checked only for startup subresources

**Evidence**
- `verifyAssets` excludes document paths. The worker matches responses by exact asset path, so the `/login` document, which is the index.html bytes, is never validated.
- After READY, a repeated response for a manifest asset hits `validatedAssets.has(...)`. It raises `OBSERVATION_FAILED` into `assetFailure`, which is read only once, before READY (line 630). The failure is silently dropped and the body is never validated.
- Demo D2: a tampered `main.js` response after READY caused 0 `validateAssetResponse` calls. A login and a ROBO view still succeeded afterwards.
- The plan requires validation "for each required document/asset", and that a "digest mismatch fails".

**Fix**
- Bind document bytes: add document entries to the signed manifest under a separate document class, or verify them by a document digest.
- Validate every manifest-asset response for the whole run, not only up to READY.
- Latch any asset failure into the BrowserSession and fail the next action and `close`.

### I-4. Readiness gating is unbound

**Evidence**

The real check:
- The real readiness check is `validReadiness` inside the worker.
- Mutation M1 made it `return true`. All 44 browser tests still pass. No negative readiness test exists at the worker level.

The controller's use of it:
- The controller relies on the worker's boolean `readinessValidation` for ROBO.
- Mutation M12 removed that ROBO requirement from `observation.cjs`. All 19 observation tests still pass.

The controller-side proof:
- `validateReadiness(body)` mints a `ReadinessProof` from any caller-authored object. The worker never sends the readiness body to the controller.
- The replay check is by object identity: a `structuredClone` of the same object mints a second proof (demo D5).
- The proof is not bound to any response, run, phase or session.
- `observeViews` requires this proof, and the guest observation suite takes its `readinessBody` from an injected port.
- Result: the public `readiness:true` rests on an untested worker check plus a proof that the controller minted itself.

**Fix**
- Have the worker return a bounded, run-, phase- and session-bound readiness proof derived from the actual response.
- Delete or redefine `validateReadiness(body)` as a pure helper that is shared with the worker, so there are no two divergent copies.
- Add worker-level negative tests for all 12 checks, the automation flags, the contract version and profile, `runtimeReady` and `maintenanceReady`, and a 503 response.

### I-5. The route policy's owner and readiness gate has no honest input

This is a cross-task composition gap.

**Evidence**
- `deeper()` requires `owner` and `readiness` gate handles, described as "actual worker observations", before any B or C route other than `health`, `me` and `readiness`.
- The real `createReceiptAdapters().verifyGate` returns `false` for those kinds. Only the test fixture stands in for them.
- The worker runs readiness, then `/api/me`, then the Robo link click and 7 deeper routes, all inside one `OBSERVE_VIEW` action. It reports nothing to the controller until the end.
- The controller therefore cannot honestly set those gates before the deeper routes are admitted. Either the deeper routes are always denied, or the gates are set from unverified data.

**Fix**
- Split the action: the worker reports a readiness and owner proof, the controller sets the policy gates, then authorises the navigation.
- Or define an explicit, reviewed in-worker gate handle that the policy context can verify.
- Record the chosen approach as an amendment.

### I-6. The descriptor inventory cannot detect what it counts

**Evidence**
- `vsockFds` matches `/vsock/` against `readlink` output. Every socket reads `socket:[inode]`, so the count is always 0.
- The console regex matches `console|tty\d*|pts/`. It misses `/dev/hvc0`, which is the virtio console the VM boots with (`console=hvc0`).
- `readlink` errors are swallowed per descriptor.
- `inspectNativeFamily` and `forbiddenDescriptorCounts` for child processes are never executed by any test. The tests feed a synthetic `family()` object.
- Mutation M3 removed vsock counting. All 44 tests still pass.
- The guest test has the same no-op `.includes('vsock')` check, and no console or `Seccomp` check.
- The plan test `browser_pid_uid_proc_console_inventory` therefore claims coverage the code does not deliver.

**Fix**
- Classify sockets by family, using `sock_diag` or `/proc/net/*` inode tables, or `getsockopt(SO_DOMAIN)` through the bootstrap.
- Match `/dev/hvc*` and `/dev/vport*`, and count unreadable descriptors as failure.
- Unit-test the native readers against a fake `/proc`.

### I-7. Route denials are swallowed

**Evidence**
- `decideRoute` turns any claim or admission exception into `ABORT` and carries on. It does not set `terminal`, record `ROUTE_DENIED` or reject the in-flight action.
- The admission port latches itself (`budget.cjs` `state.failed`), but the BrowserSession and the controller never learn of it.
- Demo D7: an economic `POST /api/trade` was aborted. The next `OBSERVE_VIEW` still returned `VIEW_OBSERVED`, and only the next routed request was aborted.
- Design §18 requires that unexpected traffic "stops deeper acceptance immediately", and the failure must be classified.

**Fix**
- On any admission error other than expected timer or replay aborts, latch the BrowserSession as terminal with `ROUTE_DENIED`.
- Reject pending actions and fail later `perform` calls with that code.
- Expose the latched code for Task 12 and Task 22.

### I-8. Provenance by duck typing

**Evidence**
- `openBrowser` accepts any `rolePort` with `activateOnce`, any truthy `grant`, and any pipe whose `audit()` returns the TASK13 kind.
- A legacy branch at lines 44–48 also accepts self-reported confinement booleans (uid, noNewPrivs, filterInherited). Real role ports never reach that branch.
- The `sessions` brand map is written but never read.
- `loginOnce` and `observeViews` likewise accept any object with `perform` and `inspectResult`.
- Demo D4: a role port not created by role-ports opened a BrowserSession, and `LOGIN_SESSION` wrote the owner password canary to its pipe.
- The plan test `no_bootstrap_proof_no_launch` checks only `grant:null`.
- This is not reachable from the browser. It does mean a mis-wired or synthetic double can produce real-looking sessions and observations.

**Fix**
- Brand-check the role handle: export an inspector from role-ports for adopted `activateOnce` handles and application pipes.
- Remove the legacy audit and HMAC branch.
- Export `isBrowserSession` from `browser.cjs` and require it in `session.cjs` and `observation.cjs`.
- Strengthen the test with a forged port that otherwise looks valid.

### I-9. `fresh`, `source`, `brokerError` and `noError` are constants

**Evidence**
- The worker always returns `fresh:true, source:'alpaca-paper', brokerError:false, noError:true`.
- No market response is observed and no `asOf` or `receivedAt` freshness is measured.
- The `observation.cjs` checks and the plan tests `wrong_adapter_brokerError_source_fail` and `loading_error_disconnect_not_empty` exercise values the real worker never emits. They pass only against doubles.
- Design §10 and §16 require view evidence to be collected while the real market response is fresh.

**Fix**
- Derive `fresh` from a bound market-response fact, or remove the field and stop claiming freshness.
- Derive `source` and `brokerError` from validated bodies.
- Test these through the worker.

### I-10. Security checks with no binding test

Every mutation below passes the full relevant suite. The 44 browser, 19 observation and 9 session tests all still pass after each.

| Mutation | What it removes | Location |
|---|---|---|
| M7 | Controller asset-proof validation made a no-op | `browser.cjs:107-118` |
| M18 | Controller keeps the password reference after FILLED | `browser.cjs:197` |
| M23 | Controller run-binding check | `browser.cjs:155` |
| M17 | Duplicate `daytrader_session` cookies allowed | `browser-worker.cjs:54` |
| M4 | Owner username check | `browser-worker.cjs:49` |
| M20 | ROBO PAPER-health `connected` check | `browser-worker.cjs:147` |
| M25 | `role=alert` error-state check | `browser-worker.cjs:247` |
| M2 | Seccomp ignored in native status | `browser-worker.cjs:429` |
| M11 | Popup route check; the popup test still passes because the policy happens to deny `/popup` | `browser-worker.cjs:613` |
| M28 | Worker READY gate | `browser-worker.cjs:594` |
| M37 | Route backlog bound | `browser-worker.cjs:616` |
| M21 | Per-view continuity at the observation layer; the worker keeps a duplicate check | `observation.cjs:168` |

**Fix:** add a focused negative test for each, through the real module.

### m-1. `Seccomp > 0` check (Option A item m3)

**Evidence**
- The check is not practically weaker. The kernel refuses a switch from filter mode to strict mode, and filter mode is inherited across fork and exec. Every descendant of a filtered worker therefore reads `Seccomp: 2`.
- Strict mode (1) cannot be observed by the worker itself, because it could not open `/proc` in that mode.
- Neither form proves that the Task 8 filter is the one installed.
- Only the real UID is checked; the effective, saved and filesystem UIDs are not.

**Fix**
- Use `=== 2`.
- Also require `Seccomp_filters` to be at least the expected depth. The Linux 6.8 target provides that field.
- Check all four UID fields.

### m-2. Scope and contract deviations

**Evidence**
- Tasks 14 and 15 modified `browser.cjs`, `browser-worker.cjs` and `browser.test.cjs`. The plan says "Modify: None" for both.
- The action catalogue changed from the plan's `LOGIN_FIELDS`, `LOGIN_CLICK` and `READ_OWNER_COOKIE` to `LOGIN_SESSION` and `SESSION_OBSERVATION`. No amendment records this.
- Task 13's commit message differs from the plan's.
- Task 13's commit also carries the `763b329` review record.

**Fix:** record an amendment for the action catalogue and the cross-task file ownership.

### m-3. Guest suites for Tasks 14 and 15 are placeholders

**Evidence**
- `session_test.cjs` does not import `session.cjs`. Each pass or fail is whatever an injected port returns.
- `observation_test` takes `readinessBody` and `browserSession` from the port.
- Both fail closed when run as they are.

**Fix:** before any guest run, drive the real modules and the real worker; the port should supply only fixture identity.

### m-4. `assertContinuity` accepts stale observations

**Evidence**
- It accepts any earlier `SESSION_OBSERVED` or `VIEW_OBSERVED` result of the same browser. Results carry no phase, sequence or time.
- `SESSION_OBSERVATION` re-reads only the cookie, not the `/api/me` owner.

**Fix:** bind results to a phase and sequence and make each one single-use. Make post-restart continuity include an owner check. This matters for Task 16.

### m-5. Session-layer named tests only check error propagation

**Evidence**
- `wrong_owner_fail_before_deeper_read` and `daytrader_session_Secure_HttpOnly…` only check that an error code from a double is propagated.
- The real behaviour is covered in `browser.test.cjs` `task14_*`. Mutation M5 is caught there.

**Fix:** point the plan-named tests at the real worker harness.

### m-6. No deadline in the startup loop or `perform`

**Evidence:** both rely entirely on an external state-machine deadline.

**Fix:** bound both by the run binding's expiry.

### m-7. Family inspection runs only once

**Evidence**
- It runs once, right after launch, before renderer and utility processes exist.
- `readdirSync('/proc/<pid>/fd')` on Chromium children that cannot be dumped will likely throw. That is fail-closed, but it may block the real launch.

**Fix:** re-inspect after the first page load and before credentials. Treat unreadable children as an explicit, reviewed case.

### m-8. Worker error codes are free strings

**Evidence**
- Worker error codes are free strings of up to 128 characters.
- `browser.cjs` and `session.cjs` raise them as error codes, outside the closed failure enum. Only `observation.cjs` maps them.

**Fix:** map them to the closed failure enum at the `browser.cjs` boundary.

### m-9. Maintenance trust is caller-supplied

**Evidence**
- `validateMaintenance` takes `trust` from the caller's evidence. It is not bound to the BrowserSession's release trust.
- The maintenance receipt itself has no interval binding.

**Fix:** bind it to the run's trust context, held privately.

## 4. Plan-required items

### Task 13 (`browser.test.cjs` plus `tests/guest/browser_test.cjs`)

| Item | Status |
|---|---|
| no_bootstrap_proof_no_launch | Present, weak. It tests only `grant:null`, and a duck-typed port opens a session (I-8). The worker-side launch gate is real: the native fence is unavailable and launch is denied (test `valid_inherited_protocol…`). |
| sandbox_enabled_no_no_sandbox | Present and correct. `chromiumSandbox:true`, no `--no-sandbox`. Mutation M24 is caught. |
| one_nonpersistent_context | Present and correct. |
| SW_registration_and_fetch_blocked_extensions_downloads_capture_disabled | Present and correct for the options and the startup asset `body()`. Post-READY assets are not covered (I-3). |
| popup_new_page_and_WebSocket_WebTransport_rejected_before_forward | Present, does not bind (M11). WebTransport is removed only in the main world. |
| QUIC_WebRTC_nonproxy_disabled | Present. Checks launch arguments only. |
| ignoreHTTPSErrors_false_no_customCA | Present and correct. |
| guest_proxy_no_DIRECT | Present and correct for the arguments. |
| profile_support_shm_tmpfs | Present and correct for the options and the topology audit. |
| inherited_filter_all_children | Present, synthetic family only. The native reader is untested (I-6, m-1). |
| browser_pid_uid_proc_console_inventory | Present, synthetic only. Native vsock and console detection cannot fire (I-6). |

Required behaviours:

| Behaviour | Status |
|---|---|
| Fixed action IDs only | Correct, though the catalogue differs from the plan (m-2). |
| No arbitrary JS, URL, selector, shell or executable from operator input | Correct. The only `page.evaluate` is a fixed GET to fixed backend paths. |
| Every route permit-gated, with a body byte check | Present. Header facts are incomplete (I-2), and denials are swallowed (I-7). |
| Asset proofs from the actual `response.body()`, with no second fetch | Correct at startup. There is no `route.fetch` or APIRequestContext. Post-READY and document gaps remain (I-3). |
| No TCP CDP or Playwright server | Correct. No `launchServer`, `connectOverCDP` or `remote-debugging-port`. |
| Chromium's inner sandbox preserved | Correct. |
| The browser starts only after the confinement proof | Worker side: correct (`commitFixedBrowserLaunch` plus the fence). Controller side: duck-typed (I-8). |
| The plan's guest runtime check | Not executed, by design. The vsock probe cannot fire (I-6). |

### Task 14 (`session.test.cjs` plus `tests/guest/session_test.cjs`)

| Item | Status |
|---|---|
| Username_Password_Log_In_actual_UI | Present. Uses a double in `session.test`. The real selectors and the click are covered in `browser.test.cjs` `task14_login_click…`. |
| wrong_owner_fail_before_deeper_read | Present in name only at the session layer (m-5). Real coverage exists (M5 is caught). |
| daytrader_session_Secure_HttpOnly_SameSite_None_path_root_host_only | Real coverage in `browser.test.cjs`. Duplicate cookies are not covered (M17). |
| one_context_no_storageState | Present. |
| changed_cookie_owner_after_restart_fail | Cookie change is covered. An owner change after restart is not (m-4). |
| second_login_API_login_substitute_denied | Present and correct. M8 is caught. |
| password_refs_discard_after_fill_ack | Present at the session layer. The controller-side discard is unbound (M18). |
| private_value_absent_public_output | Present and correct. |
| Credential never in logs or observations | Correct. Errors carry only fixed codes, and the fingerprint is an HMAC under a worker-local random key. The credential crosses the root bootstrap relay, which the design accepts. |
| Exactly one session, identity bound, no re-authentication | Correct in the worker. The provenance caveat in I-8 applies. |
| Failure modes | Credential released in `finally`. The authenticated cookie is left behind on wrong-owner cleanup; that belongs to Task 17 and Task 21. |
| Guest `session_test` | Placeholder (m-3). |

### Task 15 (`observation.test.cjs` plus `tests/guest/observation_test.cjs`)

| Item | Status |
|---|---|
| exact12_checks_pass_only | Present, but only for the controller-side validator. The worker copy is untested (I-4, M1). |
| contract2_profile_owner_paper_maintenance_runtime_and_maintenance_true | Same caveat as above. |
| automation_flags_exact | Same caveat as above. |
| missing_unknown_check_fail | Same caveat as above. |
| readiness_not_lease | Present, weak. |
| absent_duplicate_settings_abort_before_GET | Present. Tests only forged handles. The settings predicate itself is enforced by `receipts.cjs`. |
| wrong_adapter_brokerError_source_fail | Present against doubles only (I-9). |
| DB_difference_or_incomplete_scope_fail | Present against forged and cross-trust handles only. |
| Robo7_Portfolio2_Activity3_valid_render | Present. Real worker render checks exist in `browser.test.cjs` `task15_*`. |
| empty_arrays_only_with_valid_schema_and_empty_UI | Present. |
| loading_error_disconnect_not_empty | Doubles only. The worker's alert and status check is unbound (M25). |
| balances_symbols_never_public | Present and correct. The public output has fixed keys and no fingerprint, symbols or values. |
| Readiness predicates fail-closed | Yes in code, but unbound and duplicated (I-4); the policy gate is unsatisfiable (I-5). |
| No synthetic or partial success claim | No acceptance status is emitted. `readiness:true` and `fresh` are weakly founded (I-4, I-9). |

## 5. Checks run

**Environment:** Node 24.21.0 at `/Users/Matt/day-trader-toolchains/node-v24.21.0-darwin-arm64/bin/node`. Scratch root: `/Users/Matt/day-trader-evidence/production-acceptance-tooling/20261117T002012Z-stage1/tmp/reviews/tasks13b-14-15/`.

**Preparation**
- Base copy: `git -C <worktree> archive HEAD | tar -x -C …/base`.
- The worktree is still clean at `132b67e`.
- I compared hashes of the in-scope files at `763b329`, `b401be1`, `cb1c19a`, `31a513e` and `132b67e`.

**Baseline**, run in `base` as `node --test tooling/production-acceptance/tests/unit/<f>`:

| Suite | Result |
|---|---|
| browser | 44/44 |
| session | 9/9 |
| observation | 19/19 |
| budget | 22/22 |
| role-ports | 26/26 |
| receipts | 149/149 |
| route-policy | 36/36 |

**Mutations**
- Runner: `scripts/mutate.sh`. It applies an exact single-anchor replacement in a fresh copy (`mut-<id>/`) and runs the named suite.
- Surviving, meaning the tests did not catch the mutation: M1, M2, M3, M4, M7, M11, M12, M17, M18, M20, M21, M23, M25, M28 and M37.
- Caught (controls): M5 (owner id), M8 (`loginSpent`), M9 (`inspectFamily`), M10 (body digest re-check) and M24 (sandbox off).

**Demonstrations**
- Each runs the unmodified modules with the harness helpers copied from `browser.test.cjs` lines 1–441, in `scripts/demo-header.cjs`.
- Scripts: `scripts/demo-tests.cjs` (D1–D5), `scripts/demo-popup.cjs` (D6) and `scripts/demo-denial.cjs` (D7).
- Assembled into `base/tooling/production-acceptance/tests/unit/review-*.test.cjs`, scratch copy only.

| Demo | Observed output |
|---|---|
| D1 | `initial "/" disposition in PREFLIGHT: ABORT`. READY was still reached. The later `/login` probe was also `ABORT`, because the admission port had already latched after the first denial; see I-7. |
| D2 | `validateAssetResponse calls after READY: 0`. Login gave `SESSION_BOUND` and the view gave `VIEW_OBSERVED`. |
| D3 | `disposition: CONTINUE`. Headers seen by the controller: `[["content-type","application/json"]]`. |
| D4 | `openBrowser resolved with duck-typed port; password written to that pipe: true`. |
| D5 | Two readiness proofs from one literal and its clone. |
| D6 | Base: popup `GET /api/me` aborted before the controller, with 0 ROUTE frames. Under M11: 1 ROUTE frame was forwarded, and the plan test still passed. |
| D7 | `economic POST disposition: ABORT`; next action result `VIEW_OBSERVED`; next routed request `ABORT`. |

**Static checks**
- grep for CDP, server, `route.fetch`, `APIRequestContext` and `evaluate`.
- Frontend `Login.js`, `AuthContext.js` and `Portfolio.js` versus the worker's selectors and money format: these match.
- Backend `runtimeReadiness.js` shape versus the validators: these match.
- Backend `sessionCookie.js`: Bearer is preferred over the cookie.
- `VMConfiguration.swift:193`: `console=hvc0`.

No Python, Swift, VM, browser, network or install action was performed.

## 6. Declined to judge

- **Playwright 1.58.2 CORS preflights.** Under `context.route`, Playwright may fulfil CORS preflights locally. Its source was not available offline. If it does, the `preflight-*` routes never reach admission, and non-simple requests such as those carrying `Authorization` skip the server's CORS policy. That would compound I-2. Verify in the Task 23 fixture.
- **Requests from dedicated workers.** It is not settled whether `context.route` and `routeWebSocket` intercept fetch and WebSocket from dedicated workers. WebTransport is removed only by an init script in the main world.
- **Opaque request bodies.** `postDataBuffer()` may be null for blob or stream bodies, which would be classified as `ABSENT`. This needs a runtime check.
- **Sandbox and seccomp compatibility.** It is not settled whether Chromium's namespace sandbox works with the Task 8 filter, or whether the `/proc/<pid>/fd` of Chromium processes that cannot be dumped is readable as UID 10002.
- **Public `renderedCount`.** It is not settled whether publishing `renderedCount` (row counts of positions and orders) is an "approved count" under design §16.
- **Real binary hashes.** The real Node, Playwright and Chromium binary hashes were not checked; that would need an artifact action. The worker compares config pins to `package.json` pins, which are the same constants. It never hashes the executable at launch.

## 7. Notes for the whole-M4 review

- **The `763b329` review record also covers `b401be1`.** Its `source-hashes.json` lists hashes for `guest/browser.cjs` (86e14b…), `guest/browser-worker.cjs` (ac0199…), `tests/unit/browser.test.cjs`, `tests/guest/browser_test.cjs` and `package*.json`. Those equal the `b401be1` bytes. The files do not exist at `763b329`.
  - The recorded "independent current-byte review ACCEPT" therefore covered `b401be1`'s Task 13 code, although the record names only `763b329`.
  - Tasks 14 and 15 then changed `browser.cjs`, `browser-worker.cjs` and `browser.test.cjs`. No review record exists for those changes.
- **Readiness and owner gate composition** (I-5). Tasks 2/4, 15 and 22 need an agreed in-flight evidence channel. This is the key design gap before any guest run.
- **Market and preauth replay is not implementable.** The route policy's `REPLAY_PRIVATE` and `PREAUTH_REPLAY` have no implementation path: the worker can only continue or abort, and `budget.cjs` maps a replay to `ABORT`.
  - Whether the frontend's 30-second market timer then shows an error state, which would affect `noError`, is untested.
  - Task 16 also needs the readiness `persistence` token, which the worker discards.
- **The admission port latch is the only enforcement after a denial** (I-7). Task 12 and Task 22 must surface it as the failure classification.
- **The credential crosses the root bootstrap relay.** It travels hex-chunked (`confinement.py:804-818`). Task 18 and Task 19 leakage scope should include that relay's memory.
- **Wrong-owner and failed-login paths leave an authenticated cookie in the context.** Tasks 17 and 21 must define cleanup and sign-out.
- **Trust contexts are not bound across modules** (m-9, I-8). Release trust, maintenance and DB trust, and browser asset-bundle trust are each supplied by the caller.
- **Task 23 inventory probes** must not reuse the readlink vsock and console heuristics from I-6.

# Paper MVP Stabilization and Release-Evidence Ledger

- Evaluated: 2026-08-14
- Repository: `day-trader-sprint1`
- Branch: `codex/sprint1-policy-approval`
- Starting baseline: `058f962cc0bdd48a084be33fe379763f81a59f27`
- Scoped local decision: **READY TO PUSH FOR REMOTE CI**
- Deployed-staging decision: **NOT YET EVALUATED**
- Live-trading and production decision: **NO-GO**

The six local commits are authorized. Commits 1–5 are recorded below; the final
candidate SHA is the hash of the commit containing this ledger and must be captured
from `git rev-parse HEAD` after commit 6. A Git commit cannot embed its own hash.

This ledger does not authorize a push, remote CI mutation, Fly application or secret
change, deployment, remote database creation, operator creation, Alpaca connection,
paper order, cancellation, live credential, live order, public launch, or production
release. Those remain separate approval and evidence boundaries.

## Frozen product boundary

- Private, authenticated, single operator.
- AAPL only.
- Paper mode only.
- Existing canonical strategy `ROBO_TREND_FOLLOWING_V1` and one persisted active
  parameter version. When configured, `PAPER_MVP_PARAMETER_VERSION_ID` must match
  exactly.
- Exact Alpaca paper endpoint only, with explicit paper credentials and expected
  paper-account binding.
- One frozen preview followed by one explicit, idempotent submit command.
- Maximum order notional `$100`, maximum AAPL position `$250`, maximum daily loss
  `$50`, one open position, and one trade per day. Existing stricter checks still
  apply.
- Short selling, extended-hours entry, crypto, options, Robinhood, live trading,
  live order replacement, live reconciliation, capital scaling, and public
  registration are outside the release.

Paper execution is not evidence of profitability and does not reproduce every live
execution, liquidity, queue, latency, fee, tax, outage, or market-impact effect.

## Reviewable local commit sequence

| # | Commit | Subject | Scope |
| ---: | --- | --- | --- |
| 1 | `d1392130e649029d604b5e652b4cab345eee5661` | Harden repository safety and runtime readiness | Ignore/CI baseline, lifecycle, session/origin/rate/input controls, readiness/indexes, smoke, backend packaging, Fly manifests, release metadata |
| 2 | `129c6e82a9f3b29aaa19e49a89f9545f1023a586` | Bind paper broker and enforce immutable policy | One-operator boundary, frozen Paper MVP policy, exact endpoint/credential/account binding, adapters and binding tests |
| 3 | `ec6e60063753bd10e126c37ded2144293c4324fc` | Propagate trusted data through frozen paper intents | Provenance, decision/intent/order evidence, preview/freeze, explicit exact-intent submit and regressions |
| 4 | `b6791b8b203d73a2ac7e146ce565568e559a31e2` | Make paper submission durable across paths | Shared lease/latch, canonical outcomes, manual/Robo paths, cancellation/reconciliation, request IDs, indexes, real-Mongo and fake-broker proof |
| 5 | `627c1a2f8c67b04a0a3712b072807a85999b3659` | Build the private paper operator UI | Router/private registration, simulated-data labels, preview/submit/reconcile workflow, cancellation/Emergency Stop, tests and frontend packaging |
| 6 | This ledger's commit | Document Paper MVP evidence and release runbooks | Backend README plus implementation state, scorecard, release ladder, rollback and residual-risk record |

Every commit used explicit paths or hunk-level staging. `git add .` was not used.
Before each commit, the cached whitespace check, complete cached diff, and full
short/untracked status were inspected. No commit was pushed.

## Operator path proved locally

1. Production registration is hidden and default-deny; the operator signs in through
   the private login.
2. RoboTrader displays Paper, AAPL, the canonical strategy and parameter version,
   immutable policy caps, a three-step primary workflow, and Emergency Stop.
3. **Preview & Freeze** requires the single operator and an `Idempotency-Key`,
   obtains trusted AAPL inputs, applies the market/data/sizing/portfolio/frequency
   gates, and persists an exact decision and immutable intent without broker POST I/O.
4. The preview exposes provider, symbol, provider time, age, environment, simulated
   flag, trust decision, immutable order fields, and policy/execution checks.
5. **Submit Exact Intent** reloads the intent, verifies strategy, parameter version,
   fingerprint, current account risk, exact paper endpoint, explicit credentials, and
   expected account before reaching the adapter POST boundary.
6. Same-command retries preserve the original identity. Conflicting idempotency-key
   reuse is rejected. Unknown outcomes remain uncertain and are never automatically
   replayed.
7. **Reconcile** uses only the original external order ID or client order ID and does
   not invent a fallback status.
8. Cancellation is limited to a locally owned working order and verifies exact
   broker identity. Live replacement is disabled.
9. Emergency Stop remains visible on desktop and mobile and retains the conservative
   cancellation boundary.

## Local acceptance evidence

The source snapshots were reconstructed from the staged index or exact commits so
unrelated dirty-worktree changes were not counted. Local sockets used only loopback.
No command in this phase contacted Alpaca, Fly services, GitHub, or a remote MongoDB.

| Gate | Exact result | Status and limits |
| --- | --- | --- |
| Commit 1 cached review | `git diff --cached --check`, full cached diff, and full short/untracked status inspected | **PASS** |
| Commit 2 exact backend snapshot | 401 tests passed, 0 failed, 0 skipped | **PASS**; includes exact-host and lookalike endpoint binding tests |
| Commit 3 exact backend snapshot | 412 tests passed, 0 failed, 0 skipped | **PASS**; includes trusted-data and frozen-intent regressions |
| Commit 4 exact backend aggregate | 563 tests passed, 0 failed, 0 skipped | **PASS**; this is the committed backend code/test scope, excluding unrelated controlled-live work |
| Real Mongo durability | Writable temporary replica-set primary; one POST admitted across manual/Robo paths; restart retained original client ID; orphan claimed intent froze after restart; lease renewed then expired/took over; compatible legacy indexes created | **PASS**; temporary database removed; external database untouched |
| Loopback fake broker | 2 tests passed, 0 failed, 0 skipped | **PASS**; submit, ID/client-ID lookup, list, partial/fill, cancel, timeout, 404, retryable HTTP faults, malformed ACK, duplicate identity, and disconnect-after-acceptance |
| Isolated API smoke | 8/8 checks passed: health, readiness, provenance and auth enforcement for settings, preview, submit, reconciliation, and Emergency Stop | **PASS**; temporary processes/database removed |
| Backend dependency audit | `npm audit --omit=dev`: 0 vulnerabilities | **PASS**; upstream `node-domexception` deprecation remains |
| Commit 5 frontend unit snapshot | 3 files, 6 tests passed, 0 failed, 0 skipped | **PASS**; auth, routing/app, and stale-stock-response coverage |
| Commit 5 production build | Vite 6.4.3; 743 modules transformed | **PASS** |
| Commit 5 browser suite | 5 tests passed, 0 failed, 0 skipped | **PASS**; freeze/one-submit/reconcile, fail-closed canary panel, mobile Emergency Stop, stock flows, no unhandled mocked requests |
| Frontend dependency audit | `npm audit --omit=dev`: 0 vulnerabilities | **PASS**; upstream `whatwg-encoding` and `glob@10.5.0` deprecation notices remain |
| Frontend container snapshot | Isolated Docker config built `day-trader-frontend:commit5-final`, image ID prefix `700ce2b3d6cf` | **PASS** as local packaging proof; it was not pushed or deployed |
| Fly manifest syntax | Backend production/staging and frontend production/staging manifests validated | **PASS** as configuration syntax only; no app was contacted or provisioned |
| Remote GitHub Actions for final SHA | Not run; branch not pushed | **PENDING / REQUIRED** |
| Exact final-SHA release images | Not built or deployed | **PENDING**; build only after remote CI passes |
| Isolated deployed health/readiness | No staging app or database exists | **PENDING** |
| Alpaca paper contract | No Alpaca API was contacted | **PENDING / SEPARATE APPROVAL** |

### Diagnostic failures retained

- Initial normal Docker invocations could not use the workstation's root-owned
  buildx metadata. Ownership was not changed. Passing local builds used an isolated
  temporary Docker configuration.
- The first strict browser pass found two unhandled `/api/market/status` requests.
  The mock was added and the complete five-test suite then passed; no assertion was
  disabled.
- The first fresh-database smoke found that index bootstrap treated Mongo
  `NamespaceNotFound` while dropping a nonexistent legacy index as fatal. Only that
  exact fresh-collection condition is now an expected no-op; focused index tests and
  the isolated smoke passed afterward.

## Security, provenance, and separation evidence

- `LIVE_TRADING_ENABLED=false` is explicit in both backend Fly manifests and
  defaults false in the example environment. Staging also disables the worker,
  scheduler, live reconciliation, and destructive cleanup.
- The binding service parses a URL and accepts only HTTPS, the exact host
  `paper-api.alpaca.markets`, the default port, no credentials/query/fragment, and
  only the root or `/v2` path. Both paper adapters reuse it.
- Release paper submissions reject generic credential fallback, a missing expected
  account, a blocked account, or an account mismatch before POST.
- The immutable policy forces Paper, AAPL, canonical strategy/version and fixed caps
  regardless of wider stored settings.
- Production registration is default-deny. Deliberate private registration requires
  a timing-safe token and the exact single configured operator username.
- Tests cover secure session-cookie behavior, unsafe-method origin enforcement,
  private-route auth, account scope, rate limiting, input size/shape failures, generic
  errors, CSV escaping, and spreadsheet-formula neutralization.
- Provenance records provider, symbol, provider time, observed time, age,
  environment, and simulated/trusted flags through research, decision, intent, and
  order evidence. Synthetic UI data cannot create an execution-eligible intent.
- `SUBMIT_UNKNOWN`, `NOT_ATTEMPTED`, and confirmed rejection remain distinct.
  Broker request IDs are retained when supplied. Unknown order and pre-order intent
  states survive restart and block both paper submission paths under one Mongo lease.
- `/health` is liveness with sanitized release metadata. `/ready` is fail-closed
  for Mongo/indexes and enabled scheduler/reconciliation expectations.

## Preserved worktree separation

The repository started with extensive modified and untracked user work. The six
Paper MVP commits intentionally exclude the separate controlled-live operational
evidence/dashboard/alert implementation and unrelated research documents. Those
paths remain in the worktree for later review; their presence is not evidence for
this release and their hunks are not attributed to these commits.

Do not use blanket staging in this worktree. Future changes must continue to use
explicit paths or hunk-level staging and inspect every cached diff.

## Remaining blockers and residual risks

- The final six-commit SHA has not been pushed and remote GitHub Actions have not run.
- The configured staging app names are not provisioned/resolvable.
- No staging-only MongoDB, Fly network path, secret manifest, operator record, or
  frozen parameter record has been provisioned.
- No exact-final-SHA artifact has been built or deployed.
- No Alpaca API has been contacted. Real paper account binding, entitlement,
  request-header, acknowledgement, status, reconciliation, and cancellation behavior
  remain unverified.
- Docker's normal buildx metadata remains root-owned. The successful local test used
  an isolated temporary configuration; ownership repair is separate maintenance.
- `node-domexception`, `whatwg-encoding`, and `glob@10.5.0` upstream deprecation
  notices remain, while the current production audits report zero vulnerabilities.
- Container base tags are mutable upstream references; digest pinning remains
  supply-chain maintenance.
- Paper execution does not model all live fills, queue position, latency, liquidity,
  fees, tax, outages, or market impact.

These facts do not authorize or imply live trading, production deployment,
profitability, regulatory compliance, public advisory use, or autonomous capital
operation.

## Next authorized sequence

The next action is a separately approved push of the complete six-commit sequence.
After that, follow the exact ladder in
[`../robotrader-prelive-test-plan.md`](../robotrader-prelive-test-plan.md):

1. require remote GitHub Actions to pass for the final SHA;
2. decide and provision the isolated MongoDB/Fly network path;
3. stage the complete secret manifest;
4. deploy the exact committed artifact;
5. provision the private operator and frozen parameter version;
6. approve Alpaca read-only account/data checks;
7. approve one zero-write preview; and
8. separately approve exactly one bounded AAPL paper order.

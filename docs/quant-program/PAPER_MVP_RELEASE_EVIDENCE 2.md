# Paper MVP Stabilization and Release Proof

- Evaluated: 2026-08-14
- Repository: `day-trader-sprint1`
- Branch: `codex/sprint1-policy-approval`
- Baseline HEAD: `058f962cc0bdd48a084be33fe379763f81a59f27`
- Scoped local decision: **READY_FOR_ISOLATED_STAGING**
- Live-trading and production decision: **NO-GO**

This decision means that every locally achievable Paper MVP acceptance gate listed
below passed. It does not authorize a commit, push, Fly application or secret change,
deployment, Alpaca connection, Alpaca paper order, cancellation, live credential,
live order, public launch, or production release.

## Frozen product boundary

- Private, authenticated, single operator.
- AAPL only.
- Existing canonical strategy `ROBO_TREND_FOLLOWING_V1` and one persisted active
  parameter version. `PAPER_MVP_PARAMETER_VERSION_ID`, when configured, must equal
  that active version.
- Alpaca paper endpoint only, with explicit paper credentials and exact expected
  paper account binding.
- One frozen preview followed by one explicit, idempotent submit command.
- Maximum order notional `$100`, maximum AAPL position `$250`, maximum daily loss
  `$50`, maximum one open position, and maximum one trade per day. Existing stricter
  checks remain effective.
- Short selling, extended-hours entry, crypto, options, Robinhood, live trading,
  live replacement, live reconciliation, capital scaling, and public registration
  are outside this MVP path.

Paper execution is not evidence of profitability and does not reproduce every live
execution, liquidity, queue, latency, fee, tax, or operational effect.

## Operator path proved locally

1. Sign in through the private login. Production registration is hidden and the
   backend returns `404` unless token-protected private registration is explicitly
   enabled.
2. Open RoboTrader and see `Paper`, AAPL, the exact canonical strategy and parameter
   version, policy caps, Emergency Stop, and a three-step primary workflow.
3. Select **Preview & Freeze**. The backend requires the single operator and an
   `Idempotency-Key`, obtains trusted AAPL inputs, applies market-session, data,
   sizing, portfolio, frequency, and canonical risk checks, and persists the exact
   decision plus immutable intent fingerprint without broker POST I/O.
4. Inspect provider, symbol, provider timestamp, age, environment, simulated flag,
   trust decision, immutable order fields, and every policy/execution check. Missing,
   mock, stale, malformed, future-dated, missing-timestamp, or wrong-symbol data
   disables submission with a typed reason.
5. Select **Submit Exact Intent**. The backend reloads the frozen intent, verifies the
   same strategy/parameter/fingerprint, atomically claims the submission key,
   re-reads account/positions/orders/clock/quote, reruns every gate, binds the paper
   endpoint/explicit credentials/expected account, creates one durable client-order
   identity, and only then reaches the adapter POST boundary.
6. A same-key retry returns the original order. A different key conflicts. An unknown
   outcome remains `SUBMISSION_UNCERTAIN`, keeps the original identity, blocks new
   account risk, and never POSTs automatically.
7. Select **Reconcile** to look up the original external ID or client-order ID and
   display pending, accepted, partial, filled, rejected-confirmed, canceled, or
   submit-unknown without inventing a fallback status.
8. Cancel only a locally owned working order. If its external ID is not yet local,
   cancellation resolves the original client ID and verifies exact identity first.
9. Emergency Stop remains visible on desktop and mobile, pauses the worker, revokes
   applicable state, and attempts cancellation only for locally owned orders.
10. Portfolio, Activity, RoboTrader decisions/orders/audit, reconciliation, and
    Trading System evidence remain available through the authenticated application.

## Acceptance evidence

Durations below are wall-clock `real` values printed by `/usr/bin/time -p`. Commands
that require a local socket or browser were run with local host permission. No command
contacted Alpaca or deployed an application.

| Gate | Exact command | Exact result | Duration | Status / warnings |
| --- | --- | --- | ---: | --- |
| Patch integrity | `git diff --check` | Exit 0; no output | `0.13s` | **PASS** |
| Environment-file safety | tracked `.env` query plus `git check-ignore backend/.env frontend/.env` | 0 tracked local `.env` files; `backend/.env` and `frontend/.env` are ignored; only `backend/.env.example` is tracked | `<0.01s` | **PASS**; no local env value was read or printed |
| Source secret scan | high-confidence private-key, cloud-key, token/password assignment, and credentialed-URI filename scans over `git ls-files -co --exclude-standard` | No private key or cloud-key candidate; one explicit fake `generic-secret` unit-test fixture; credentialed URI matches are only `user:pass` on `.example` test hosts | `0.20s` | **PASS**; candidates manually classified, no value from ignored `.env` inspected |
| Backend clean install | `cd backend && npm ci` | 131 packages installed; exit 0 | `0.99s` | **PASS**; one upstream `node-domexception` deprecation warning |
| Backend aggregate | `cd backend && npm test` | 578 passed, 0 failed, 0 skipped | `2.01s` | **PASS**; completed without interruption |
| Backend production audit | `cd backend && npm audit --omit=dev` | 0 vulnerabilities | `0.35s` | **PASS** |
| Backend all-dependency audit | `cd backend && npm audit` | 0 vulnerabilities | `0.37s` | **PASS** |
| Local API smoke | `cd backend && npm run smoke:isolated` (starts isolated Mongo/backend and invokes `npm run smoke:api -- --base-url <loopback>`) | 8/8: health, readiness, provenance, settings auth, preview auth, submit auth, reconciliation auth, Emergency Stop auth | `9.01s` | **PASS**; temporary processes and database removed |
| Real Mongo durability | `cd backend && npm run test:integration:mongo` | writable primary; one POST admitted across two paths; restart preserved original client ID; orphan claimed intent froze after restart; lease renewed then expired/taken over; compatible legacy indexes created | `12.21s` | **PASS**; isolated temporary replica set, external DB untouched |
| Fake broker matrix | `cd backend && npm run test:integration:fake-broker` | 2 passed, 0 failed, 0 skipped | `0.84s` | **PASS**; submit, ID/client-ID lookup, list, partial/fill, cancel, timeout, 404, 408/425/429/500/503, malformed ACK, duplicate ID, disconnect-after-acceptance |
| Frontend clean install | `cd frontend && npm ci` | 362 packages installed; exit 0 | `2.53s` | **PASS**; upstream `whatwg-encoding` and `glob@10.5.0` deprecation warnings; audit is clean |
| Frontend unit/routing/auth | `cd frontend && npm test` | 4 files, 8 tests passed; 0 failed, 0 skipped | `2.18s` | **PASS** |
| Frontend production build | `cd frontend && npm run build` | Vite 6.4.3, 743 modules transformed, build complete | `3.44s` | **PASS** |
| Browser happy path | `cd frontend && npm run test:e2e` | 5 passed, 0 failed, 0 skipped | `6.55s` | **PASS**; exact freeze/one-submit/reconcile path, mobile Emergency Stop, no unhandled mocked API requests; harmless Playwright color-env warning |
| Frontend production audit | `cd frontend && npm audit --omit=dev` | 0 vulnerabilities | `0.63s` | **PASS** |
| Frontend all-dependency audit | `cd frontend && npm audit` | 0 vulnerabilities | `0.52s` | **PASS**; compatible lockfile updates resolved the earlier three dev-tool highs |
| Backend image | `docker build --build-arg RELEASE_COMMIT=058f962cc0bdd48a084be33fe379763f81a59f27 --build-arg BUILD_ID=uncommitted-paper-mvp-20260814 -t day-trader-backend:paper-mvp-local backend` through a temporary Docker config | Image `day-trader-backend:paper-mvp-local` built; 131 production packages; audit 0; runtime user `node`; release metadata present | `8.18s` | **PASS**; legacy-builder deprecation because user buildx state is root-owned |
| Frontend image | `docker build --build-arg VITE_API_URL=http://127.0.0.1:4000 --build-arg VITE_REGISTRATION_ENABLED=false -t day-trader-frontend:paper-mvp-local frontend` through a temporary Docker config | Image `day-trader-frontend:paper-mvp-local` built; 743 modules; audit 0 | `11.19s` | **PASS**; same local legacy-builder warning and npm deprecations |
| Fly backend production | `fly config validate -c backend/fly.toml` | Configuration is valid | `0.62s` | **PASS** |
| Fly backend staging | `fly config validate -c backend/fly.staging.toml` | Configuration is valid | `0.86s` | **PASS** |
| Fly frontend production | `fly config validate -c frontend/fly.toml` | Configuration is valid | `0.63s` | **PASS** |
| Fly frontend staging | `fly config validate -c frontend/fly.staging.toml` | Configuration is valid | `0.52s` | **PASS** |
| Orphan check | `pgrep -fl 'paper-mvp-mongo\|run-isolated-smoke\|day-trader-sprint1/backend/server.js'` and temp-directory query | No matching process or temporary test directory | `<0.01s` | **PASS** |

### Failed diagnostic attempts retained

- The first post-change aggregate backend run finished in `61.14s` with 572 passed,
  6 failed, and 0 skipped. Root cause: six manual-paper fixtures mocked the two order
  collections but not the new orphan-intent latch, so Mongoose buffered the unstubbed
  read for 10 seconds and the workflow correctly failed closed as a coordination
  error. The fixture now mocks that collection; the focused file passed 44/44 in
  `0.40s`, and the final aggregate passed 578/578 in `2.01s`.
- The first normal backend/frontend Docker invocations failed before Dockerfile
  evaluation in `0.56s` and `0.23s`: the pre-existing
  `~/.docker/buildx/refs` directory is root-owned. No permission was changed. A
  temporary Docker config plus the explicit Docker Desktop socket produced the two
  passing builds above.
- The first browser pass found two unhandled `/api/market/status` requests. The
  strict request gate failed two tests, the mock was added, and both subsequent
  five-test browser runs passed. No assertion was disabled.
- The first isolated fresh-database smoke found that index bootstrap treated Mongo
  `NamespaceNotFound` while dropping a nonexistent legacy index as fatal. The index
  service now treats only that exact fresh-collection condition as an expected no-op;
  the focused index suite passed 8/8 and isolated smoke then passed 8/8.

## Security, provenance, and separation evidence

- `LIVE_TRADING_ENABLED=false` is explicit in both backend Fly manifests and defaults
  false in the example environment. Staging also disables the worker, scheduler,
  live reconciliation, and cleanup.
- Release paper submissions reject a live URL, any live flag, generic credential
  fallback, missing explicit paper keys, missing expected account ID, blocked account,
  or account mismatch before POST. Both manual and RoboTrader adapters call the same
  binding service.
- Live order replacement remains disabled. Paper MVP settings force paper mode,
  AAPL, the canonical strategy/version, the fixed caps, and disabled live/short/
  extended/options/crypto behavior regardless of wider stored settings.
- Production registration is default-deny. If deliberately enabled, a timing-safe
  registration token and exact single configured operator username are required.
- Session tests preserve HttpOnly/Secure/SameSite cookie behavior. Aggregate route
  tests cover private-route auth, unsafe-method origin enforcement, account scope,
  rate limiting, invalid and oversized inputs, generic error behavior, CSV escaping,
  and spreadsheet-formula neutralization.
- Market-data provenance records provider, symbol, provider time, observed time,
  staleness, environment, and simulated/trusted flags in research, decision, intent,
  and order evidence. Synthetic data remains available only for visibly labeled UI
  development and cannot generate an execution-eligible recommendation or reach POST.
- `SUBMIT_UNKNOWN`, `NOT_ATTEMPTED`, and confirmed rejection remain distinct. Broker
  request IDs are retained when present. Uncertain order and pre-order intent states
  survive restart and block both manual and RoboTrader risk under one account-scoped
  Mongo lease/latch while reads, reconcile, cancel, and Emergency Stop stay available.
- `/health` is liveness and contains sanitized release metadata. `/ready` is
  fail-closed for Mongo/indexes and scheduler/reconciliation expectations; staging's
  disabled services are explicitly reported as disabled.

## Source-control accounting

At final accounting the shared worktree has 103 modified tracked files and 45
untracked files, with a tracked diff of 11,664 insertions and 1,578 deletions. The
starting snapshot was already heavily dirty. Those counts include extensive
pre-existing user work; they are not authorship claims. Nothing is staged or
committed.

Paper-MVP-required paths fall into these review groups:

- Boundary and release surface: root ignore files and CI; backend/frontend
  Dockerfiles, ignore files, Fly production/staging manifests, nginx, example env,
  package manifests/locks, server lifecycle, release metadata, readiness, index
  bootstrap, isolated smoke, and README/docs.
- Frozen paper policy and trust: `paperMvpPolicyService`, broker operator and binding
  services, market-data provenance, research/strategy/execution-quality propagation,
  the RoboTrader route/worker, and the relevant decision/intent/order models.
- Durable execution: shared submission guard/outcome services, both Alpaca adapters,
  manual paper broker, reconciliation, correlation/request-ID fields, unique indexes,
  real-Mongo harness, fake broker, and strict fault tests.
- Operator experience: registration/session routing, Home simulated-data label,
  RoboTrader primary preview/submit/reconcile/cancel/Emergency Stop path, activity/
  portfolio readback, routing/auth tests, and desktop/mobile browser proof.

The other dirty files remain user-owned and must be reviewed hunk-by-hunk. Never use
blanket `git add .` in this worktree.

## Proposed reviewable commit sequence

Each commit requires separate user authorization and a clean staged-diff review.

1. **Repository safety and runtime readiness** — ignore/CI files; server lifecycle;
   session/origin/rate-limit/input controls; runtime readiness/index services and
   tests; smoke harness; Docker/Fly manifests; release metadata.
2. **Paper broker binding and immutable policy** — paper MVP policy, single-operator
   boundary, exact paper endpoint/credential/account binding, environment example,
   adapters, and focused binding tests.
3. **Trusted data and frozen intent** — provenance service, research/strategy/
   execution-quality propagation, decision/intent/order schema fields, preview/
   explicit-submit routes and tests.
4. **Cross-path durability and reconciliation** — shared lease/latch, outcome
   semantics, manual/Robo submission and reconciliation, request IDs and indexes,
   real-Mongo/fake-broker/fault tests.
5. **Private operator UI** — exact router update, private registration display,
   simulated-data labels, RoboTrader primary path, cancellation/Emergency Stop,
   unit and browser tests, frontend Docker/Fly configuration.
6. **Evidence and runbooks** — README, pre-live plan, implementation state, scorecard,
   and this append-only release proof.

Because some paths contain pre-existing user changes that span more than one group,
use interactive hunk staging and inspect `git diff --cached` before every commit.

## Remaining external blockers and residual risks

- The configured staging app names were not provisioned/resolvable at the start of
  this phase. Manifests are valid, but app creation and DNS/release evidence require
  explicit external-write approval.
- No staging-only Mongo, Fly secrets, operator record, or Alpaca paper account was
  configured. These are intentionally absent, not hidden local failures.
- No Alpaca API was contacted. Real Alpaca paper account binding, current market-data
  entitlement, ACK/header/status behavior, and the one-order user journey remain the
  purpose of the separately approved isolated-staging validation.
- The current source is uncommitted, so the local image uses the baseline commit plus
  an explicit `uncommitted-paper-mvp-20260814` build ID. A staging artifact must be
  built only after an approved commit and must expose that exact commit/build ID.
- Remote GitHub Actions did not run because commit/push/PR were not authorized. The
  equivalent local commands passed.
- Docker's normal buildx metadata ownership should be repaired separately by the
  workstation owner. This is not an application defect; the temporary local proof
  intentionally did not mutate it.
- Mutable upstream container tags and npm deprecation notices are supply-chain
  maintenance risks. Both current dependency graphs audit at zero vulnerabilities.
- This phase does not prove live readiness, production readiness, profitability,
  complete live execution modeling, regulatory compliance, or autonomous operation.

## Later isolated-staging checklist and approval boundaries

### Approval 1: source commits and push

Review each proposed commit with `git diff --cached --check` and `git diff --cached`.
Do not combine unrelated user work. Only after the user approves the exact commits:

```bash
git status --short --untracked-files=all
git diff --check
git log -1 --format='%H %s'
git push origin codex/sprint1-policy-approval
```

### Approval 2: create isolated Fly apps, database, and staged secrets

Provision separate staging apps and a staging-only Mongo database. Prepare a
mode-`0600` file outside the repository containing only staging values for
`MONGO_URI`, `JWT_SECRET`, `FRONTEND_ORIGIN`, `APCA_PAPER_API_KEY_ID`,
`APCA_PAPER_API_SECRET_KEY`, `APCA_PAPER_ACCOUNT_ID`, `APCA_DATA_URL`,
`APCA_DATA_FEED`, `ROBOTRADER_OPERATOR_USERNAMES`, and
`PAPER_MVP_PARAMETER_VERSION_ID`. Never add that file to Git or paste its contents
into logs. With explicit app/secret-write approval:

```bash
fly apps create day-trader-backend-staging
fly apps create day-trader-frontend-staging
fly secrets import --stage -a day-trader-backend-staging < /secure/path/day-trader-backend-staging.env
fly secrets list -a day-trader-backend-staging
```

If the isolated database has no operator, separately approve one token-protected
registration window. Temporarily stage `PRIVATE_REGISTRATION_ENABLED=true` and a
random `PRIVATE_REGISTRATION_TOKEN`, register only the exact configured username from
mode-`0600` request/header files, then immediately remove both secrets so the manifest
default `false` applies. Do not put the password or token on a command line.

### Approval 3: deploy staging artifacts

From the approved, clean committed tree:

```bash
test -z "$(git status --porcelain)"
release_commit="$(git rev-parse HEAD)"
build_id="paper-mvp-staging-$(date -u +%Y%m%dT%H%M%SZ)"
fly deploy backend -c backend/fly.staging.toml --build-arg "RELEASE_COMMIT=$release_commit" --build-arg "BUILD_ID=$build_id"
fly deploy frontend -c frontend/fly.staging.toml
curl --fail --silent --show-error https://day-trader-backend-staging.fly.dev/health
curl --fail --silent --show-error https://day-trader-backend-staging.fly.dev/ready
fly status -a day-trader-backend-staging
fly status -a day-trader-frontend-staging
```

Verify `/health.release.sourceCommit` equals `release_commit`, the build ID equals
`build_id`, `/ready` reports Mongo/indexes ready, scheduler/reconciliation explicitly
disabled, `LIVE_TRADING_ENABLED=false`, and frontend network traffic targets only the
staging backend. At this stage, exercise login and auth-denial smoke only. Do not
preview or submit until paper account/data read access is separately approved.

### Approval 4: non-order paper reads and frozen preview

Approve access only to the isolated Alpaca paper account and market-data services.
Sign in as the one operator, confirm Paper/AAPL/frozen strategy/version/caps, and use
**Preview & Freeze** once. Confirm trusted non-simulated provenance, every check,
intent/decision IDs, and immutable fingerprint. Confirm the Alpaca account contains
no new order. This phase permits account/position/order/clock/market-data reads but no
order POST, cancellation, live host, or live credential.

### Approval 5: exactly one AAPL Alpaca paper order

This must be a new explicit approval naming the staging app, exact paper account,
AAPL intent ID/fingerprint, side, quantity/notional (at most `$100`), order type,
time-in-force, and whether cancellation/Emergency Stop of that same working order is
authorized. Then:

1. Select **Submit Exact Intent** once; retry only with the same displayed key.
2. Record client order ID, broker order ID, broker request ID if supplied, intent,
   decision, account binding, status, and audit event.
3. Reconcile using the original correlation identity. Never submit a replacement if
   state is unknown.
4. If the approved order is working, exercise its approved cancel path, reconcile,
   then use Emergency Stop and verify the paused/revoked state.
5. Inspect Portfolio, Activity, orders, decisions, reconciliation, and audit evidence.
6. Export/redact the evidence without credentials, cookies, secrets, or raw broker
   request headers.

### Rollback

Capture the current and previous image references before deployment:

```bash
fly releases -a day-trader-backend-staging --image
fly releases -a day-trader-frontend-staging --image
```

For an application failure, Emergency Stop first if the app is reachable; then, with
rollback approval, redeploy the previously recorded immutable image reference:

```bash
fly deploy -c backend/fly.staging.toml --image <previous-backend-image-reference>
fly deploy -c frontend/fly.staging.toml --image <previous-frontend-image-reference>
curl --fail --silent --show-error https://day-trader-backend-staging.fly.dev/health
curl --fail --silent --show-error https://day-trader-backend-staging.fly.dev/ready
```

If broker state is ambiguous, do not roll forward or submit again to make readiness
green. Keep the database and audit evidence, reconcile the original identity, rotate
only staging credentials if compromise is suspected, and keep live trading false.

# Owner-only paper MVP operator runbook

## Release gate

Current hardened local RC decision is recorded in `docs/evidence/rc-repair/image-hardening/README.md`: fresh complete verifier23/23 plus container/image acceptance and the image-security policy are required together. The historical Phase3 report does not alone grant current acceptance. External paper acceptance, external SMTP receipt and deployed operation remain NOT RUN and require separate authorization. Live execution is blocked independently of flags.

## Local setup and configuration

Use the repository `.nvmrc` pin: Node 24.21.0 with its bundled npm 11.19.0, matching the reviewed image and CI runtime. Read `docs/runtime-setup.md`, run `nvm install` and `nvm use` if using nvm, then check `node --version`, `npm --version`, `command -v node` and `command -v npm`; both tools must resolve from the same selected distribution. Node20 reports are historical and are not a supported-runtime pass. From the repository root:

```sh
npm ci --prefix backend --ignore-scripts --no-audit --no-fund
npm ci --prefix frontend --ignore-scripts --no-audit --no-fund
```

Set configuration through your local protected environment or deployment secret manager. Never commit values. Required owner access: `MONGO_URI`, `JWT_SECRET` (strong random secret), `OWNER_USER_ID` (explicit existing ObjectId). Required broker writes: paper API credentials (`APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`), `APCA_BASE_URL=https://paper-api.alpaca.markets`, and `ALPACA_EXPECTED_PAPER_ACCOUNT_ID` (broker account UUID). Host configuration also accepts existing aliases documented in the adapters.

Set `FRONTEND_ORIGIN` to the exact frontend origin; production requires HTTPS and cookie-compatible frontend/backend origins. Keep `ROBO_SCHEDULER_DISABLED=true` while deployment acceptance is incomplete. Set `ROBO_NOTIFICATION_RECIPIENT` explicitly to the owner's verified address, plus `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASS`; port 465 uses implicit TLS, other ports require STARTTLS. SMTP provider acceptance is not proof of inbox receipt. Console notification logging is development-only evidence.

## Owner bootstrap

Public signup is disabled. Existing users do not become owner by signing up first.

```sh
node backend/scripts/bootstrap-owner.js --existing EXISTING_USER_OBJECT_ID
```

This reads the explicit database and verifies the selected identity; configure the printed `OWNER_USER_ID` in the application runtime. To create a new owner, supply a protected JSON file containing `username`, `email`, and `password` (12+ characters with letters and numbers, at most 72 UTF-8 bytes):

```sh
node backend/scripts/bootstrap-owner.js --create < /absolute/path/to/protected-owner-credentials.json
```

Creation never changes the runtime binding automatically. Store/remove the protected credential file through your password-management process. Existing credentials are never overwritten. Restart with the chosen binding and log in; older tokens require fresh login. Logout invalidates all prior owner sessions across devices.

## Deterministic verification

Use a disposable replica set, never an existing production database. The integration suite ignores inherited Mongo credentials and creates/removes only its own randomly named `mvp_test_*` database on loopback port 27189.

```sh
docker run -d --rm --name day-trader-mvp-local -p 127.0.0.1:27189:27017 mongo:7 --replSet mvp --bind_ip_all
docker exec day-trader-mvp-local mongosh --quiet --eval 'rs.initiate({_id:"mvp",members:[{_id:0,host:"localhost:27017"}]})'
node scripts/verify-mvp.mjs
```

Wait for MongoDB to start before initiating and for `db.hello().isWritablePrimary` before verification. Install matching Chromium first with `node frontend/node_modules/@playwright/test/cli.js install --with-deps chromium` (omit `--with-deps` on macOS). OpenSSL is required for the ephemeral local SMTP certificate. Reports are written to `docs/evidence/verification/`. The verifier installs committed lockfiles and runs all backend, Mongo, frontend, production-build, local SMTP, process and full-stack browser checks with a scrubbed environment. Every required gate must execute and pass without skipped/flaky acceptance tests. `--checks-only` no longer bypasses release requirements. External acceptance remains separately NOT RUN. An existing Chromium binary may be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE`; record its path/version with the run.

```sh
docker stop day-trader-mvp-local
```

Only stop the named test-owned container. Never drop application databases or reset paper accounts.

## Browser verification

The Phase 3 release suite uses the production frontend, actual login form, real backend and isolated Mongo, and only replaces external provider HTTP/SMTP boundaries:

```sh
node frontend/node_modules/@playwright/test/cli.js test --config=scripts/acceptance/playwright.config.cjs
node --test scripts/acceptance/process.test.cjs
```

Run after `npm run build --prefix frontend` with the test replica set running. The older `npm run test:e2e --prefix frontend` API-fixture suite remains UI regression evidence only; it is not the release acceptance gate. Browser credentials are issued by real login, never fabricated or injected. The historical non-owner negative HTTP test uses a fixture credential in a Node client only.

## External paper acceptance

`backend/scripts/external-paper-acceptance.js` is an operator-invoked acceptance tool. It imports no `.env` automatically, starts no server/worker/scheduler, and sends no notifications. Load the existing ignored local environment explicitly when invoking it. `ALPACA_EXPECTED_PAPER_ACCOUNT_ID` must already bind the intended paper account; never put that ID or keys in command arguments, reports, or Git. The CLI checks the supplied full candidate SHA against local HEAD.

A dry run validates the bounded plan without credentials, database access or network requests. From the repository root:

```sh
node backend/scripts/external-paper-acceptance.js --dry-run \
  --candidate "$(git rev-parse HEAD)" \
  --paper-origin https://paper-api.alpaca.markets \
  --symbol-allowlist AAPL,MSFT,NVDA \
  --quantity 1 --max-notional 100.00 --fill-limit-price 100.00
```

These prices illustrate option validation, not an executable market-price recommendation. For a future separately authorized external run, use an explicitly reviewed one-share limit price and maximum notional (hard ceiling $1,000), exact candidate, fresh evidence directory, and `--authorize-external-paper-test`. The script requires existing owner settings, automation disabled, and the existing local application Mongo database with readiness/index checks. It does not create substitute spending settings or a separate exposure ledger. It preserves all normal risk limits, including available position slots and day spending. The real broker calls must be separately authorized after hosted CI verifies the exact candidate.

The preflight requires an explicitly configured exact paper endpoint, matching account binding, eligible account, fresh clock, complete baseline positions/open orders, and a clean active/tradable US-equity fixture. The deterministic configured list is constrained to AAPL, MSFT, NVDA, AMZN, GOOG and META. Occupied symbols are skipped; existing unrelated positions are allowed. No clean fixture blocks the run. Unattributed active orders are never hidden or canceled: the canonical RC-002 exposure guard determines admission.

Closed market returns `EXTERNAL_ALPACA_PAPER_PARTIAL` with `WRITE LIFECYCLE REQUIRES OPEN REGULAR MARKET` after read-only preflight; it sends zero broker writes. Open market invokes the actual `getOrderLifecycle().submit`, reloads that service, looks up the stable canonical client ID and reconciles through the existing production lifecycle. One filled buy is followed by one exact-quantity canonical reducing sell, with Fill, spending, exposure and baseline-restoration assertions. Canonical `mvp-...` client IDs remain unchanged; the unique `dtacc-...` acceptance idempotency keys identify the run. A supplied run ID cannot silently repeat an existing run; use recorded canonical identities for separately authorized recovery.

A fill timeout triggers at most one cancellation of the positively owned canonical order, bounded reconciliation, and a failed acceptance result. An uncertain write is never reposted. Other unknown failures stop additional writes and record best-effort read-only residual state; inspect the saved intent/client/broker IDs before any manual recovery. The tool cannot guarantee no fill during cancellation or cleanup after a network outage. Do not rerun a failed invocation with a new run ID to conceal unresolved state.

Evidence continuously records semantic order payloads, durable intent/client/broker identities, transitions, request IDs where returned (null if absent), a masked account ID, baseline comparison and residual state. It excludes request headers and credentials. Use a new protected `--evidence-dir` for each external attempt; existing `report.json` is not overwritten by a new invocation. External evidence stays outside Git. `EXTERNAL_ALPACA_PAPER_VERIFIED` requires observed opening/closing fills and clean restoration; a controlled-provider result is not real external acceptance. Exit 0 means dry-run or verified; other outcomes exit 2 (argument/setup errors exit 1).

The mandatory `mongo-externalPaperHarness.mongo` verifier gate exercises the real canonical services and Mongo transactions against the existing loopback provider. Its test adapter permits only the paper-origin contract, rewrites it to loopback before transport, rejects external DNS/fetch, and uses dummy credentials. No production market-hours, exposure, dispatch or paper-account policy is changed for testing.

## Startup, deployment checks and rollback

### Acceptance fixture selection and protected held baselines

Acceptance keeps the configured deterministic symbol list and the one-share executable ask ceiling of $250. It first considers symbols without a baseline holding or conflicting order. If no clean fixture can be admitted because the existing position count is exactly the owner's cap, it may consider an existing long symbol from the same configured list. The held fixture must be active, tradable, fractionable US equity, pass the original unsupported-asset guards, have no conflicting baseline order, and satisfy owner symbol/risk constraints. It does not change the cap or bypass canonical admission. Increasing an existing holding consumes position-size headroom and spending, but does not create another distinct position.

The run captures an immutable exact baseline quantity. Acceptance ownership comes from this run's canonical Intent/client/BrokerOrder/Fill identity chain. A position difference alone never grants cleanup authority. Before reduction and at final broker authorization, fresh quantity must equal baseline plus the remaining canonical acceptance delta. Sell quantity cannot exceed that delta or leave less than the baseline. Unexplained extra buys, sells, disappearance, or mismatched canonical fills fail closed with baseline-drift/ownership-ambiguity evidence; no guessed cleanup follows. Whole and fractional quantities retain canonical nine-decimal precision.

Successful held cleanup restores the exact original quantity and side. Unrelated positions and baseline orders remain structurally unchanged. The fixture's weighted average entry/cost basis can change through legitimate add/reduce fills; quantity restoration does not promise to restore those broker cost-basis fields. Recorded baseline details remain available for review. The initial cancellation scenario and unexpected-fill early-stop branches retain the global maximum of three submissions and one cancellation request, including uncertain responses.

Acceptance observations use a separate fixed-point domain with up to nine decimal places. The production money parser and integer-cent spending remain unchanged. The executable ask is compared to $250 before rounding: `250.004` is ineligible. High-low ranges and spreads are calculated exactly. The final non-marketable BUY target is rounded downward to a cent, never toward the ask, and is revalidated against fresh market data before dispatch.

IEX bars are requested over ten bounded minutes, with a maximum eleven results to cover interval endpoints. The latest five valid observations must remain strictly ordered, nonfuture, and individually no older than six minutes; the newest must remain within two minutes. Four bars remain insufficient. Gaps between returned minutes are allowed; no missing bar is manufactured or interpolated. Widening retrieval does not guarantee eligibility and does not relax selected-bar freshness.

The existing canonical readiness check may refresh `operationalreadiness` / `external-acceptance` metadata. This bookkeeping effect must be authorized and reported separately from canonical trading records and economic state. A local controlled-provider pass is not real PAPER acceptance. Any new source candidate requires separate exact-SHA hosted verification and then separately authorized real acceptance; this task authorizes neither a push nor real broker requests.

Local processes: `npm start --prefix backend`, `npm start --prefix frontend`. `/health` is minimal process liveness. Authenticated `/api/readiness` uses the [versioned startup/readiness contract](startup-readiness.md): HTTP200 requires runtimeReady; pre-activation maintenance additionally requires contractVersion2 and maintenanceReady. Deprecated releaseReady is not the runtime gate; external/deployed acceptance remains separate and unknown to this endpoint. A process responding does not mean it is ready to trade. Detailed broker/worker status remains owner-only under `/api/robotrader`.

Fly's existing `auto_stop_machines=false` and `min_machines_running=1` preserve always-on backend capability. No Fly deployment was performed. Before a future authorized deployment, verify secrets, exact origins and cookie behavior, majority database writes, usable unique indexes, capacity, expected account, notification transport and independent reconciliation health. Configure GitHub branch protection to require `MVP local release acceptance / checks`, disallow force push, and require review; configured workflow is not evidence of a passing GitHub run.

Production deployment command, only after separate approval and a passing release gate: `cd backend && fly deploy`. Run owner login, readiness, broker identity, scheduler/logout, reconciliation, notification and emergency-stop acceptance on that exact artifact before enabling persistent automation. A local release candidate alone does not authorize deployment or persistent activation.

Rollback: disable automation first and retain audit/order history, preserve unresolved client IDs, restore the previous verified image using Fly's release tooling and known immutable image reference, then reconcile outstanding orders before resuming. Do not restore a database snapshot blindly over accepted broker orders. Reconnect reruns index/write readiness; index failures keep broker writes blocked.

## Emergency stop and recovery

Use the owner RoboTrader Emergency Stop control or authenticated `POST /api/robotrader/emergency-stop` with `{"cancelOpenOrders":true,"environment":"paper"}`. Review its reported preserved orders and pending cancellations. The stop blocks new automated exposure; it does not flatten positions. Protective sells and known partial linked groups are preserved. Broker acceptance may already be in flight; verify broker state and reconciliation before considering cancellation final.

Explicit owner Enable is required to resume and clears only the emergency/user-disable pause. Separate failure pauses remain until resolved. Keep reconciliation working while entries are disabled. Flattening, broad cancellation and destructive history retention changes require separate deliberate operator action and are not implicit in emergency stop.


## Phase 2 financial controls

Set positive daily/weekly/monthly entry spending limits in RoboTrader settings before any Alpaca paper entry. These apply to manual/research/trade-plan and automated entries together. Zero/missing values block entries. Boundaries are UTC day, Monday week and calendar month. Pending/uncertain orders retain reservations, and sells do not replenish period spending.

Use a stable Idempotency-Key for every entry/close and replacement. Never create another key merely to recover a timeout. Reconciliation looks up the persisted client ID and never reposts; unresolved submissions move to reconciliation_required after five minutes while capacity remains held. Do not delete intents, fills, locks or spending documents to clear an operational block.

Managed protective stops resize by confirmed cancellation then a new durable generation. Unresolved protection blocks new automated risk and creates audit/outbox alerts. Use Portfolio → Review close SYMBOL → Confirm coordinated close. The close holds an account exit lease, discovers only app-owned protections, requests cancellation and verifies terminal broker state before sizing a reducing order from the actual remaining whole-share position. Unrelated exits block the close. Uncertain cancellation remains visible and retains the close request identity; use Refresh/Retry coordinated close rather than a new key. Emergency stop disables automation and discovers app-owned entry groups from durable intents, preserving protective sells.

This phase deliberately supports only one non-increasing replacement with unchanged protective terms. Cash capacity increases only through authenticated `POST /api/robotrader/cash/synchronize` with the normal owner session and same-origin request. This operation verifies fresh broker cash, requires no unresolved local buy/reservation or open broker buy, and serializes with reservations in Mongo. It replaces the cash ceiling using absolute confirmed cash plus previously consumed cash accounting; it never adds locally assumed sale proceeds or resets day/week/month spending. Repeating synchronization does not double-credit. Invalid/stale cash blocks new entries.

Coordinated closes have a two-minute deadline, processed by an independent 30-second recovery tick. Expired unfilled closes are canceled and terminal status confirmed before remaining protection is restored. Protection restoration remains durably scheduled until broker coverage is confirmed, including accepted-stop timeout recovery. Entry disable and ordinary reconciliation disable do not stop close recovery; disabling the entire scheduler does. Broker/database outages can extend recovery, so unresolved close/protection states require operator attention and must not be treated as flat/protected.

After a paper request reaches a terminal state, “Prepare another identical order” records a new deliberate intent without submitting. “Submit prepared order” then uses its new request/client identity. Retries, reloads and double-clicks reuse the original identity; do not clear browser request state to escape uncertainty.

Activity shows notification states separately: queued, sending, retry scheduled, provider accepted and failed. Provider acceptance does not prove inbox receipt. Robo audit includes canonical lifecycle, protection and coordinated-close events.

No unattended external activation or deployment was performed.

## RC repair control and exposure semantics (2026-09-13)

The reviewed `1972254b` candidate is NO-GO following RC-001/RC-002. The original 19-gate verifier evidence is historical. See `docs/evidence/rc-review/` for preserved reproductions and `docs/evidence/rc-repair/` for repair results; do not infer current readiness from the old report.

Stop has three distinct events: S is the committed control generation change; D is the committed, one-use dispatch claim after provider account preflight; T is actual HTTP dispatch. S and D share account coordination. S-before-D rejects stale automated entries, including entries from a generation that was disabled and subsequently re-enabled. D-before-S remains potentially in flight even when T is unobserved. A claim does not prove transmission; a lease is not broker-enforced fencing. An expired lease, process death, empty broker list, timer, or 404 does not establish that an earlier claimant cannot send.

The Robo settings/control API and screen distinguish disabled new automated admissions, draining original identities, and fully stopped after terminal resolution. Refresh stop status to observe drain completion. Emergency cancellation is scoped to owned entries and persists its request so reconciliation can cancel an order that becomes visible later. Keep reconciliation running with admissions disabled. Do not delete intents, release reservations manually, rotate request identities, or declare quiescence to escape unresolved claims. Broker acknowledgement/terminal evidence must resolve the original identity. Deliberate owner manual entries, protection, and permitted reducing operations retain their policy; protective and close dispatches also require the account exit lease.

Position admission uses a versioned portfolio observation checked against existing canonical fills and a trusted baseline. Pending reservations cannot disappear into terminal filled status while positions lag. Unknown coverage blocks new exposure, while reconciliation/protection/reductions remain available within known quantities. When coherent broker observations catch up with canonical holdings, normal headroom returns; observed holdings and already-covered fills are not added twice. Admission limits do not guarantee market values remain below the cap after price appreciation.

A preexisting account with historical fills and no trusted exposure baseline requires explicit reconciliation; the repair does not guess a baseline from a possibly lagging position response. Unattributed external activity, incomplete order discovery, or contradictory fill/position observations also block new entries. Preserve records and investigate the discrepancy. Do not bypass this gate by deleting the baseline or fills. Native clean-account baseline establishment, delayed-fill recovery, and positive trading headroom are covered by the mandatory RC-002 scenarios.


## Current runtime/security checkpoint

RC-001 and RC-002 are repaired locally. Use `node scripts/verify-mvp.mjs --report-dir docs/evidence/rc-repair/runtime-final-verifier` under Node 24.21.0 and bundled npm 11.19.0 for the recorded combined deterministic command; choose another new evidence directory for any later rerun. Required Node test gates explicitly emit TAP on Node24. Exact existing output is in the verification record; do not overwrite historical evidence.

The two local Linux candidate images passed build, isolated production startup and static navigation, but local RC remains NO-GO because image CVE analysis is approval-blocked. Automatic approval rejected Docker Scout's package-URL/layer-digest transfer to Docker's CVE service before execution. No scan metadata/source/image upload occurred. Obtain explicit authorization for that narrow metadata transfer and disposition the resulting reports before updating the decision. Do not substitute a registry/proxy/alternate scanner to bypass the rejection. Image inventory and pinned official versions are not a completed vulnerability scan. Candidate image IDs and fixture cleanup are recorded in `docs/evidence/rc-repair/runtime-containers/report.json`.

Fresh npm audits are separate authorized operations and have completed: backend0 findings, frontend57 findings. Retain the current disposition; no forced toolchain migration is part of this repair. Hosted CI, external paper/SMTP acceptance, deployment and persistent activation still require separate authorization. Backup/restore, credential-revocation/recovery, deployment provenance, monitoring, strategy evaluation and commercial evidence remain separate master-brief gates.

## Final-runtime operational boundary

The hardened backend has no shell/package manager and runs as UID1000. Health/readiness tooling must invoke Node directly; authorized owner bootstrap can invoke `/usr/local/bin/node /app/scripts/bootstrap-owner.js` with protected external input. Never install repair packages into a running container. Rebuild through the reviewed Dockerfile and repeat the image/security gates. The current static frontend expects external same-origin API routing unless intentionally rebuilt with a public API origin; nginx alone does not proxy API requests.

Before deployment, enforce the exact startup/configuration assumptions in the [zlib backend](evidence/rc-repair/image-hardening/node-zlib/README.md) and [frontend](evidence/rc-repair/image-hardening/node-zlib/frontend-disposition.md) dispositions. Added native libraries, preloads, FFI or nginx modules reopen the security gate. Local GO does not authorize activation or certify backup/restore, revocation, monitoring/soak, external account or inbox acceptance.

## One-message SMTP acceptance support

SMTP host/sender/authentication remain external runtime configuration. The sole
recipient authority for targeted delivery is `ROBO_NOTIFICATION_RECIPIENT`, a
single plain mailbox. Owner-profile email is diagnostic only and is never a
fallback. No recipient, sender, provider, SMTP host, cc/bcc or envelope can be
supplied through the new service inputs. These are internal services, not HTTP
mail-relay endpoints.

For a separately authorized acceptance run, call
`enqueueNotification({ eventKey, accountId, environment: 'paper', subject, text })`
from `services/roboNotificationService`, then call `deliverById(String(record._id))`
exactly once. Use a unique `smtp-acceptance:<run-id>` event key and unmistakable
PAPER MVP test content. Enqueue returns the existing record on duplicate keys,
without overwriting content or dispatching. Content limits are 512 characters for
eventKey, 256 for accountId, 200 for subject, and 20,000 for plain text; subject
newlines and unsupported fields are rejected. No acceptance worker is installed.

Targeted delivery never falls back to `deliverNext`. It atomically claims only
the requested eligible record with the existing 120-second lease and attempt
limit. Missing host/sender/recipient leaves the record unchanged and returns
`unconfigured` before transport. Unavailable targets return `not_found`,
`not_eligible`, `leased`, or `terminal`. Existing batch/scheduled operations remain
separate; **do not start them for acceptance** or replay historical notifications.

Before SMTP, targeted delivery durably fences the record as `delivery_uncertain`.
This is not proof that transmission occurred. It prevents blind application-level
resend after process death, uncertain transport, or failed acceptance persistence.
Explicit provider acceptance of exactly one configured recipient changes it to
`provider_accepted` and persists the message ID/timestamp. Definitive DNS or
pre-DATA command failure, or an explicit negative DATA response, follows existing
bounded retry timing. Generic CONN/socket/timeouts can occur after DATA and remain
uncertain. No raw upstream error/credentials are persisted.

Both normal dispatchers exclude `delivery_uncertain`, even after lease expiry.
Ordinary completion releases the lease. Process death or database failure can
leave the fence with its expiring lease; neither authorizes resend. Operator
inspection/provider or mailbox evidence is required; no automatic uncertain-state
reset is provided. Existing general-batch retry policy for ordinary records has
not been redesigned. This is not SMTP-level exactly-once delivery.

An external acceptance run must be separately authorized after exact-SHA hosted
CI, configure real SMTP separately, send at most one targeted message, and verify
actual recipient receipt. Provider acceptance alone is not inbox receipt. An
uncertain response is a reason to inspect, never to blindly resend. No real SMTP
configuration or external-send evidence is supplied by the controlled tests.

# Owner-only paper MVP operator runbook

## Release gate

Phase 3 local release status is recorded in `docs/evidence/verification/report.json`; only an exit-zero complete verifier earns VERIFIED RELEASE CANDIDATE. External paper acceptance, external SMTP receipt and deployed operation remain NOT RUN and require separate authorization. Live execution is blocked independently of flags.

## Local setup and configuration

Use Node 20 (matching existing Dockerfiles) and npm. From the repository root:

```sh
npm ci --prefix backend --ignore-scripts
npm ci --prefix frontend --ignore-scripts
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

`backend/scripts/external-paper-acceptance.js` is implemented and tested locally. Its dry-run makes zero network requests:

```sh
node backend/scripts/external-paper-acceptance.js --dry-run \
  --expected-account-id dedicated-paper-account \
  --paper-origin https://paper-api.alpaca.markets \
  --symbol-allowlist AAPL --symbol AAPL \
  --max-notional 10.00 --limit-price 1.00 --quantity 1 --test-prefix phase3
```

Only after separate explicit authorization, replace `--dry-run` with `--authorize-external-paper-test`, replace the placeholder account ID with the verified dedicated paper account ID, and provide APCA credentials through a protected environment. Reserve that account exclusively for the test; it must have no positions or open orders. The command prints a unique test client ID, checks account/market/asset readiness, makes at most one bounded buy-limit POST, looks up that same identity, and cancels only that exact test-owned order. It never resets an account, cancels all orders or liquidates positions. A $1 limit is deliberately unlikely to fill; this checks acknowledgement/status, not a guaranteed fill.

Exit 0 means dry-run or confirmed terminal cleanup with zero fills; exit 2 means filled shares remain or cancellation is unconfirmed; exit 1 means a guard/provider/transport failure. Reconcile the printed client ID before another run after any uncertainty. Retained filled shares require an explicit operator decision. External Alpaca orders and external SMTP have not been run in Phase 3.

## Startup, deployment checks and rollback

Local processes: `npm start --prefix backend`, `npm start --prefix frontend`. `/health` is minimal process liveness. Authenticated `/api/readiness` reports index/write bootstrap state, configuration presence, and outstanding release blockers; a process responding does not mean it is ready to trade. Detailed broker/worker status remains owner-only under `/api/robotrader`.

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

# Owner-only paper MVP operator runbook

## Release gate

Current status: IMPLEMENTATION INCOMPLETE; NO-GO for unattended trading or deployment. The following commands cover implemented setup and checks. They do not authorize external orders or claim full MVP acceptance. Live execution is blocked independently of flags.

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

Wait for MongoDB to start before initiating. Reports are written to `docs/evidence/verification/`. The default command exits nonzero while complete lifecycle/concurrency/full-stack E2E acceptance is unimplemented, even when the implemented checks pass. `node scripts/verify-mvp.mjs --checks-only` explicitly evaluates only implemented deterministic checks; it never marks a release candidate. It installs committed lockfiles and runs backend, frontend, build and real MongoDB/HTTP integration tests with a scrubbed environment.

```sh
docker stop day-trader-mvp-local
```

Only stop the named test-owned container. Never drop application databases or reset paper accounts.

## Browser verification

The existing Playwright suite plus release-scope cases uses API fixtures. It is useful for UI regression but does not establish real broker/auth/database lifecycle E2E:

```sh
npm run test:e2e --prefix frontend
```

Install the matching Playwright Chromium when needed. In constrained environments a separate local test configuration may be needed; record it with the evidence. Do not inject authentication tokens and call that a real login acceptance test.

## External paper acceptance

Full external acceptance tooling remains unimplemented. Do not treat the existing `alpaca:check` connectivity script as order/fill acceptance. Required next work: explicit opt-in, allowlisted dedicated paper account, capped exposure, stable test-owned IDs, uncertainty recovery and cleanup restricted to test-created orders. Only after that code is reviewed and authorization is granted should any external order be sent. No external orders or emails were sent by this implementation session.

## Startup, deployment checks and rollback

Local processes: `npm start --prefix backend`, `npm start --prefix frontend`. `/health` is minimal process liveness. Authenticated `/api/readiness` reports index/write bootstrap state, configuration presence, and outstanding release blockers; a process responding does not mean it is ready to trade. Detailed broker/worker status remains owner-only under `/api/robotrader`.

Fly's existing `auto_stop_machines=false` and `min_machines_running=1` preserve always-on backend capability. No Fly deployment was performed. Before a future authorized deployment, verify secrets, exact origins and cookie behavior, majority database writes, usable unique indexes, capacity, expected account, notification transport and independent reconciliation health. Configure GitHub branch protection to require `MVP deterministic checks / checks`, disallow force push, and require review; configured workflow is not evidence of a passing GitHub run.

Production deployment command, only after separate approval and a passing release gate: `cd backend && fly deploy`. Run owner login, readiness, broker identity, scheduler/logout, reconciliation, notification and emergency-stop acceptance on that exact artifact before enabling persistent automation. Do not deploy current incomplete work.

Rollback: disable automation first and retain audit/order history, preserve unresolved client IDs, restore the previous verified image using Fly's release tooling and known immutable image reference, then reconcile outstanding orders before resuming. Do not restore a database snapshot blindly over accepted broker orders. Reconnect reruns index/write readiness; index failures keep broker writes blocked.

## Emergency stop and recovery

Use the owner RoboTrader Emergency Stop control or authenticated `POST /api/robotrader/emergency-stop` with `{"cancelOpenOrders":true,"environment":"paper"}`. Review its reported preserved orders and pending cancellations. The stop blocks new automated exposure; it does not flatten positions. Protective sells and known partial linked groups are preserved. Broker acceptance may already be in flight; verify broker state and reconciliation before considering cancellation final.

Explicit owner Enable is required to resume and clears only the emergency/user-disable pause. Separate failure pauses remain until resolved. Keep reconciliation working while entries are disabled. Flattening, broad cancellation and destructive history retention changes require separate deliberate operator action and are not implicit in emergency stop.


## Phase 2 financial controls

Set positive daily/weekly/monthly entry spending limits in RoboTrader settings before any Alpaca paper entry. These apply to manual/research/trade-plan and automated entries together. Zero/missing values block entries. Boundaries are UTC day, Monday week and calendar month. Pending/uncertain orders retain reservations, and sells do not replenish period spending.

Use a stable Idempotency-Key for every entry/close and replacement. Never create another key merely to recover a timeout. Reconciliation looks up the persisted client ID and never reposts; unresolved submissions move to reconciliation_required after five minutes while capacity remains held. Do not delete intents, fills, locks or spending documents to clear an operational block.

Managed protective stops resize by confirmed cancellation then a new durable generation. Unresolved protection blocks new automated risk and creates audit/outbox alerts. A conflicting manual exit is blocked while a protective reservation exists; a coordinated stop-cancel/close workflow remains a release acceptance item. Emergency stop disables automation and discovers app-owned entry groups from durable intents, preserving protective sells.

This phase deliberately supports only one non-increasing replacement with unchanged protective terms. Cash capacity does not automatically rise after sales/deposits. Full-stack and external acceptance remain required before operation; no unattended activation or deployment was performed.

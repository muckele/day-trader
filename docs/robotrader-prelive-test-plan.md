# RoboTrader Paper MVP Pre-Live Test and Release Plan

Last updated: 2026-08-14

## Release boundary

This plan advances only the private AAPL Paper MVP into isolated staging. It does
not authorize live credentials, a live broker connection, funded trading, public
registration, production deployment, or autonomous capital operation.

`LIVE_TRADING_ENABLED` remains `false` throughout this plan. Paper results do not
establish profitability and do not reproduce every live fill, queue, latency,
liquidity, fee, tax, outage, or market-impact effect.

## Controls present in the release candidate

- `/health` is liveness and reports sanitized release/build metadata. `/ready` is
  fail-closed for MongoDB/index readiness and for scheduler/reconciliation freshness
  when those services are enabled.
- The Paper MVP requires exactly one configured broker operator.
- Production registration is disabled by default. A deliberately opened private
  registration window requires both a token and the exact configured operator name.
- The server freezes the Paper MVP to AAPL, paper mode,
  `ROBO_TREND_FOLLOWING_V1`, one persisted parameter version, and the immutable risk
  caps documented in the release ledger.
- Both paper adapters require the exact HTTPS host
  `paper-api.alpaca.markets`, explicit paper-only credentials, and an exact expected
  paper-account match before an order POST.
- Simulated, missing, stale, malformed, future-dated, or wrong-symbol market data
  cannot create an execution-eligible paper intent.
- Preview and submit are separate commands. Submit reloads the frozen intent and
  verifies its fingerprint, policy, account, and current risk state.
- Manual and RoboTrader paths share an account-scoped MongoDB lease/latch. Ambiguous
  submissions retain their original correlation identity and block new account risk
  until reconciliation.
- Order cancellation verifies local ownership and exact broker identity. Live order
  replacement is disabled. Emergency Stop remains available.

The separate operational-evidence dashboard, external alert-delivery service, and
future pre-funds live-canary evidence gates are not part of this six-commit Paper MVP
release. Their uncommitted work remains outside this plan. Nothing here treats those
future controls as implemented or accepted.

## Completed local test ladder

Run from the repository root against an exact source snapshot:

```bash
cd backend
npm ci
npm test
npm run test:integration:mongo
npm run test:integration:fake-broker
npm audit --omit=dev

cd ../frontend
npm ci
npm test
npm run build
npm run test:e2e
npm audit --omit=dev
```

The real-Mongo test starts and removes a temporary replica set. The fake broker
binds to loopback with synthetic credentials. The browser suite intercepts all API
traffic. None of these tests contacts Alpaca, Fly, GitHub, or a remote database.

Current local results are recorded in
[`quant-program/PAPER_MVP_RELEASE_EVIDENCE.md`](./quant-program/PAPER_MVP_RELEASE_EVIDENCE.md).

## Approval-gated release ladder

Each numbered phase is a separate authorization boundary. A later phase may start
only when the earlier phase has direct evidence for the exact same source SHA.

### 1. Push the six-commit sequence

Confirm the local commit list, cached index, and preserved unrelated work. Push only
after a separate explicit approval. Record the resulting final SHA; do not rebuild
the candidate from a different tree.

### 2. Require remote GitHub Actions for the exact SHA

The backend, frontend, browser, audit, and container jobs must all pass for the final
SHA. A rerun is acceptable only if it still evaluates that SHA. A newer branch-head
run does not prove the candidate.

### 3. Provision the isolated MongoDB/Fly network path

Only after remote CI passes, decide the staging topology and provision:

- separate backend and frontend staging applications;
- a staging-only MongoDB database and least-privilege database user;
- an allowlisted network path between the backend and that database; and
- no connectivity to a live broker endpoint or production database.

Validate app names, DNS, TLS, and database reachability without writing broker
credentials or creating an operator yet.

### 4. Stage the complete secret manifest

Prepare a mode-`0600` manifest outside the repository. It must contain all required
staging values, including:

```text
MONGO_URI
JWT_SECRET
FRONTEND_ORIGIN
APCA_PAPER_BASE_URL
APCA_PAPER_API_KEY_ID
APCA_PAPER_API_SECRET_KEY
APCA_PAPER_ACCOUNT_ID
APCA_DATA_URL
APCA_DATA_FEED
ROBOTRADER_OPERATOR_USERNAMES or ROBOTRADER_OPERATOR_USER_IDS
PAPER_MVP_PARAMETER_VERSION_ID
```

The paper base URL must be exactly `https://paper-api.alpaca.markets`. Do not put
secret values in Git, chat, shell history, process arguments, screenshots, or logs.
Stage the full manifest in one reviewed operation, then verify secret names only.

### 5. Deploy the exact committed artifact

Build and deploy from a clean checkout of the final SHA. Pass that SHA as
`RELEASE_COMMIT` and assign a unique `BUILD_ID`. Verify:

1. `/health.release.sourceCommit` equals the final SHA.
2. `/health.release.buildId` equals the recorded build ID.
3. `/ready` reports MongoDB and indexes ready.
4. Scheduler and reconciliation are explicitly disabled by the staging manifest.
5. `LIVE_TRADING_ENABLED=false`.
6. The frontend bundle targets only the staging backend.

Capture immutable backend/frontend image references and the immediately previous
release references before any application exercise.

### 6. Provision the private operator and frozen parameter version

If no operator exists, open one token-protected registration window, register only
the exact allowlisted operator, and immediately remove the registration token and
enable flag. Persist and verify the approved AAPL parameter version. Confirm that
another user cannot access operator-only broker data or commands.

### 7. Alpaca read-only validation

Under a new approval limited to reads, allow only paper account, positions, orders,
clock, and market-data requests. Verify:

- the resolved trading endpoint is the exact paper host;
- the returned account ID equals `APCA_PAPER_ACCOUNT_ID`;
- account status and trading permissions are suitable for paper use;
- expected authentication and request headers are accepted;
- AAPL data entitlement returns non-simulated, timely, correctly attributed data;
- the order list is captured before preview; and
- no order POST, PATCH, DELETE, cancellation, or live-host request occurs.

### 8. Zero-write preview and freeze

Under a separate approval, run **Preview & Freeze** once. Record the decision ID,
intent ID, idempotency key, fingerprint, strategy, parameter version, immutable order
fields, provenance, and every gate result. Re-read the broker order list and prove it
is unchanged. A failed or uncertain proof stops the ladder.

### 9. Exactly one Alpaca paper order

This phase requires an approval naming the staging app, paper account, intent ID,
fingerprint, AAPL side, quantity/notional (no more than `$100`), order type,
time-in-force, and whether cancellation of that same order is permitted.

1. Select **Submit Exact Intent** once.
2. If the response is uncertain, do not submit again; reconcile the original client
   order ID.
3. Record the local order ID, client order ID, broker order ID, broker request ID
   when supplied, acknowledgement, status, account binding, and audit event.
4. Reconcile using the original external or client identity.
5. Cancel only if the same approval authorizes cancellation of that working order.
6. Exercise Emergency Stop, then verify paused state and reconcile again.

Zero unresolved discrepancies, no live-host traffic, and one broker POST at most are
required for a pass.

## Rollback and evidence retention

For an application failure, use Emergency Stop first if reachable, then redeploy the
previously recorded immutable staging images under separate rollback approval. If
broker state is ambiguous, do not submit a replacement to make a status green.
Preserve the database, intent, order, reconciliation, and audit records; resolve the
original correlation identity first.

Never archive, delete, or rewrite a discrepancy merely to satisfy a release gate.

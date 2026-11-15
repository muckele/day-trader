# RoboTrader Pre-Live Test and Release Plan

## Current release boundary

The application supports paper execution, shadow-live evaluation, a supervised first live canary, and evidence-governed repeat canaries. It does **not** support unattended capital scaling or an unrestricted “full RoboTrader” tier. The live boundary remains capped in code at one order and $100 total notional per UTC day, $100 per order, one broker attempt per activation, a 24-hour maximum activation, and a five-minute operator heartbeat.

`LIVE_TRADING_ENABLED` must remain `false` until every gate in this document passes and a human go/no-go review is complete. No test below requires live funds before the controlled-canary phase.

## What is enforced in code

- A separate `/health` liveness endpoint and fail-closed `/ready` endpoint. Readiness requires MongoDB/index readiness, a fresh scheduler tick, and fresh successful reconciliation unless those services are intentionally disabled for staging.
- Exactly one deployment broker-operator identifier. Configure one username **or** one user ID, not multiple entries.
- An HTTPS critical-alert webhook authenticated with a bearer token in production-mode deployments. Critical alert creation still pauses automation and revokes controlled-live state; failed deliveries are retained and retried by the scheduler.
- Current pre-funds evidence for every intended symbol:
  - a policy-approved shadow candidate from the last 30 days;
  - one consistent strategy and the current canonical policy version;
  - qualifying walk-forward evidence for the exact strategy/parameter version;
  - at least 20 comparable paper fills per symbol;
  - no more than 5% paper-order rejection per symbol;
  - at least 99% fill completion; and
  - no live fills during the pre-funds assessment.
- Fingerprint binding at approval, activation, and broker submission. Any evidence change forces a new approval.
- Broker-operator checks on approval, activation, heartbeat, dossier sealing, repeat-canary approval, and post-canary review. Emergency stop and revocation remain available as safety actions.
- The original canary hard limits and single-attempt lifecycle remain unchanged.

## Test ladder

### 1. Deterministic local tests

Run from the repository root:

```bash
cd backend
npm ci
npm test

cd ../frontend
npm ci
npm test
npm run build
npm run test:e2e
```

The fake-broker integration test binds only to `127.0.0.1`, uses synthetic credentials, and exercises submit, lookup/fill, list, and cancel. The browser safety test intercepts every API request and proves that incomplete pre-funds evidence disables canary approval while paper run-once remains usable.

Pass criteria: no failed tests, successful frontend production build, and no unhandled mocked API calls.

### 2. Container and configuration tests

```bash
fly config validate -c backend/fly.toml
fly config validate -c backend/fly.staging.toml
fly config validate -c frontend/fly.toml
fly config validate -c frontend/fly.staging.toml

docker build -t day-trader-backend-test backend
docker build --build-arg VITE_API_URL=http://127.0.0.1:4000 -t day-trader-frontend-test frontend
```

The same unit, browser, build, audit, and container checks run in `.github/workflows/ci.yml` for pull requests and pushes to `main` or `codex/**`.

### 3. Isolated staging paper test

Deploy with the staging Fly configurations only after creating separate staging apps and staging-only secrets. Staging is configured with:

- live trading disabled;
- no live reconciliation;
- background worker and scheduler disabled so only explicit test actions run;
- Alpaca paper endpoint only; and
- destructive cleanup disabled.

Use staging-specific MongoDB and Alpaca paper credentials. Never copy live broker credentials into staging.

Run these checks:

1. `/health` returns HTTP 200.
2. `/ready` returns HTTP 200 once MongoDB and indexes are ready. The scheduler and reconciliation checks must report intentionally disabled.
3. Sign in as the single configured operator.
4. Save the Paper Test preset with one symbol initially.
5. Use **Preview & Freeze** for the exact AAPL canonical strategy and parameter
   version; verify trusted provenance, all checks, the immutable intent fingerprint,
   and no broker POST.
6. Only under a separate explicit paper-order approval, use **Submit Exact Intent**
   with the persisted idempotency key; confirm client-order ID, local intent,
   decision, broker order, broker request ID when supplied, account binding, and
   audit record.
7. Reconcile using the original external/client identity; confirm local/broker status
   match and never replay an unknown submission.
8. Exercise cancel only on the locally owned working paper order covered by that
   approval. Live replacement remains disabled and is not a Paper MVP validation
   step.
9. Exercise Emergency Stop and verify automation is disabled and locally owned open paper orders are canceled when requested.
10. Trigger a synthetic/test critical operational event in staging and verify webhook receipt without exposing the stored alert payload.

Pass criteria: zero unresolved reconciliation discrepancies, expected audit events, webhook receipt, and no request to a live Alpaca host.

### 4. Paper evidence collection

Freeze one strategy, one parameter version, and a small symbol cohort. Do not change parameters during the evidence window. Collect at least 20 comparable paper fills for every symbol. A “comparable” fill must include trusted reference price, average fill price, complete quantity/notional evidence, submission time, and fill time.

The approved first pre-funds cohort is currently **AAPL only**. Expanding or changing that allowlist creates a new cohort and requires fresh per-symbol walk-forward, paper-execution, and shadow evidence.

Review the Trading System operational-evidence dashboard and RoboTrader pre-funds panel. Investigate rejected orders; a rejection is evidence, not something to delete. Archive reconciliation history only after the underlying discrepancy is understood and resolved.

Pass criteria per symbol: at least 20 comparable fills, rejection rate no greater than 5%, mean fill ratio at least 99%, no unresolved discrepancy, and complete/untruncated dashboard evidence.

### 5. Shadow-live observation

Run the frozen strategy in shadow mode for at least seven distinct UTC days and at least 20 persisted exposure observations. Shadow mode may evaluate live-market constraints but must not submit broker orders.

Pass criteria: every intended symbol has a current policy-approved candidate; zero shadow risk breaches; zero unresolved critical alerts; qualifying current walk-forward validation for the exact strategy and parameter version; all readiness drills/evidence current; exactly one operator; alert delivery configured; and `/ready` healthy.

Elapsed-time evidence cannot be backfilled or manufactured. A settings, strategy, policy, symbol, market-data provenance, or execution-model change restarts the relevant evidence review.

### 6. Controlled live canary — only after go/no-go

This is the first step that may use funds. Before it:

1. Create separate least-privilege live Alpaca credentials.
2. Verify the live base URL is not the paper URL and the paper credentials are not used as fallback.
3. Set exactly one operator identifier and test the external critical-alert path.
4. Confirm the production database has no unresolved reconciliation issue or critical alert.
5. Record the operator runbook, secret review, index verification, emergency-stop drill, paper-broker acceptance, and disaster-recovery evidence through the application.
6. Review the pre-live evidence fingerprint and intended single-symbol allowlist.
7. Enable `LIVE_TRADING_ENABLED=true` only for the scheduled, supervised canary window.

The operator must maintain the five-minute heartbeat. One order attempt consumes the activation whether the broker accepts or rejects it. Afterward, reconcile, review, seal the dossier, revoke/disable the activation, and set the deployment live flag back to `false` if no further supervised canary is scheduled.

### 7. Repeat canaries and capital scaling

Repeat canaries require the existing sealed-dossier cohort, distinct-day, cooling-period, strategy, discrepancy, protection, exposure, alert, and fingerprint gates. Promotion does not increase capital limits.

Unattended capital scaling remains intentionally blocked. Before implementing a higher tier, define and approve separate limits for order notional, daily loss, gross/net exposure, position concentration, strategy allocation, correlated exposure, order rate, drawdown rollback, and credential authority. Each tier should be a new immutable server-side envelope with its own minimum dossier count, cooling period, manual approval, and automatic demotion—not a configurable bypass of the canary constants.

The complete mandatory design is in [Future Autonomous Capital Risk Envelope](./autonomous-capital-risk-envelope.md). That document is a future requirement, not a statement that autonomous capital operation exists today.

## Required production configuration

```env
ROBOTRADER_OPERATOR_USERNAMES=<exactly-one-username>
# OR ROBOTRADER_OPERATOR_USER_IDS=<exactly-one-user-id>

ROBOTRADER_ALERT_WEBHOOK_URL=https://<alert-receiver>
ROBOTRADER_ALERT_WEBHOOK_BEARER_TOKEN=<secret>
ROBOTRADER_SCHEDULER_STALE_MS=180000
ROBOTRADER_RECONCILIATION_STALE_MS=720000
RUNTIME_READINESS_STARTUP_GRACE_MS=20000

LIVE_TRADING_ENABLED=false
```

Do not configure both an operator username and ID unless the single-operator parser is later extended to bind both identifiers to one verified account; the current fail-closed rule treats them as two identifiers.

## Immediate rollback

1. Use Emergency Stop in the application.
2. Revoke the controlled-live activation or promotion.
3. Cancel only locally owned broker orders through the application and reconcile again.
4. Set `LIVE_TRADING_ENABLED=false` and, if necessary, `ROBO_KILL_SWITCH=true`.
5. Rotate live broker credentials if credential exposure or ambiguous account ownership is suspected.
6. Keep the audit, alert, activation, order, intent, authorization, exposure, dossier, and reconciliation records intact for investigation.

Never resolve or archive a discrepancy merely to make a readiness gate turn green.

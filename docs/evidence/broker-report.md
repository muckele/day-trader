# Broker boundary verification

Date: 2026-09-12 (local). All execution verification used injected HTTP transports with explicit fake credentials. No external broker requests, real credentials, account resets, deployments, or persistent scheduling were used.

## Implemented

- `backend/services/alpacaSafety.js` centralizes the immutable paper-only transport invariant. URL parsing requires exact HTTPS origin `https://paper-api.alpaca.markets`, no user information, query, fragment, foreign port, lookalike host, or unrelated base path. The root and `/v2` API base forms remain supported. No environment/user flag can authorize live requests.
- `ALPACA_EXPECTED_PAPER_ACCOUNT_ID` must be explicitly configured. Both production write adapters read `/v2/account` immediately before **each** broker write with the same captured credentials and destination, and require exact account ID equality. Missing binding, missing/mismatched account ID, and account lookup errors block writes. No cached identity authorization is reused.
- Canonical `alpacaBroker` covers submit, cancellation, cancel-all, replacement, and position close. Dynamic order IDs are path encoded. All requests disable redirects. A broker is no longer reported configured for execution without an expected account binding and valid destination.
- Manual/local-simulator-to-Alpaca synchronization uses the same safety helper. The independent legacy `roboTraderEngine.placeAlpacaOrder` direct Axios write was replaced with the guarded shared submit client. The read-only Alpaca diagnostic script also disables redirects.
- Immutable configuration disables live, shorts, margin, options, crypto, leveraged and inverse ETFs for this release. Stored feature flags cannot override those disabled defaults. Trade policy uses the same exact origin validator and rejects unsafe destinations even when passed a live-enabled flag.

## Evidence

The initial nine newly added boundary regressions all failed before implementation (lookalike origin accepted, all five write operations missing account checks, live/advanced flags enabled, missing binding accepted, manual transport redirects enabled). After implementation these passed. Two later regression tests for persisted feature-flag and explicit policy flag overrides also failed before their fixes.

Final targeted command:

```sh
node --test backend/tests/alpacaTradingClient.test.js backend/tests/brokerBoundarySafety.test.js backend/tests/tradingConfig.test.js backend/tests/robotraderAlpacaBroker.test.js backend/tests/roboTraderEngine.test.js
```

Result: **50 tests passed, 0 failed, 0 skipped**. Output is saved as `docs/evidence/broker-green-tests.log`.

Existing tests were preserved: the legacy scheduler fixture now exercises a permitted long entry; the legacy short-alias case verifies rejection despite an enabled legacy flag; successful Alpaca adapter fixtures explicitly configure account identity and stub account reads. Test transports are injected/mocked at their existing seams; no production destination exception was added.

## Traced paths and remaining limits

- Manual paper sync and trade-plan/research users of `paperBrokerClient` flow through `submitAlpacaPaperOrder`.
- Canonical worker, reconciliation protective submissions, and broker route cancellation/replacement/closing flow through `createAlpacaBroker`.
- Legacy engine's independent direct order POST now flows through shared `submitAlpacaPaperOrder`.
- `scripts/check-alpaca-paper.js` only reads account/orders, and has no write action.

This bounded task proves transport origin/mode and designated account binding. It does not establish owner authorization, durable lifecycle/reservations, all route instrument policy combinations, protective order correctness, or real broker connectivity. Legacy engine still has fill-assumption and lifecycle gaps; its independent execution entry points must remain disabled by release routing/scheduling. No live Alpaca verification was run. An operator must supply the expected paper account ID and perform separately authorized controlled paper smoke verification before release.

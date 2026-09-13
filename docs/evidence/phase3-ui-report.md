# Phase 3 UI and reporting work

This report covers the frontend and bounded backtest disclosure work. It is not full-stack release evidence: the component/unit tests listed here use Axios test doubles. The root acceptance harness separately owns real browser → authentication → backend → Mongo → controlled-provider evidence.

## Request identity and deliberate identical orders

`frontend/src/utils/paperOrderRequest.js` persists a stable request key before network I/O, including the original economic payload and its observed status. Concurrent duplicate actions share one in-flight HTTP operation. The original key survives response loss and browser reload. Retry sends the stored payload, avoiding an accidental new intent if a refreshed recommendation changes an input.

Stock, Research and Trade Plan have a shared request panel. It displays request status and confirmed filled quantity separately from requested quantity. Refresh obtains `/api/paper-trades/orders` and matches the actual persisted `idempotencyKey` or previously bound intent ID. Only filled/canceled/rejected/expired requests permit “Prepare another identical order”. Preparation creates a fresh key without sending an order. A separate “Submit prepared order” action sends the original payload with that new key. Double preparation of the old request fails closed. While a request for the same symbol/screen is unresolved, changing its economic payload cannot silently create another order.

Selectors for real browser acceptance:

- `data-testid="paper-intent-panel"` and `data-testid="paper-intent-status"`.
- “Refresh order status”, “Retry same order”, “Prepare another identical order”, “Submit prepared order”.
- Stock initial flow remains “Review Paper Trade” → “Confirm”.
- Research uses “Submit Paper Trade”. Trade Plan keeps the follow-up panel visible after its execution modal closes.

A response lacking a persisted terminal order is treated as unresolved, including an HTTP error without proof that no broker submission occurred. A pre-intent validation failure may therefore require backend-specific recovery evidence; HTTP 400 alone does not authorize discarding identity. No browser token, broker credential, or authentication state is stored by this helper.

## Coordinated position close UI

Portfolio exposes “Review close SYMBOL” only for Alpaca-paper positions. Its dialog explains cancellation and fill races, then requires “Confirm coordinated close”. The request uses the financial service’s existing POST `/api/robotrader/positions/:symbol/close`, a persisted idempotency key, and no requested quantity so the service derives actual remaining shares. “Refresh close status” reads `/api/robotrader/position-closes`; retries retain the same key and unresolved requests cannot acquire a new one. A terminal close requires a distinct preparation action before another close. Dismissing the dialog refreshes broker portfolio data. `data-testid="position-close-status"` exposes visible lifecycle state for acceptance.

## Confirmed display/contract defects fixed

- Portfolio crashed when broker positions omitted `unrealizedPnlPct`; it now shows “percentage unavailable” instead of inventing a percentage or dereferencing undefined.
- Activity crashed on null/missing realized P&L and could format a missing fill price as zero. Missing P&L is explicitly unavailable; missing prices remain unavailable.
- Activity distinguishes requested quantity from confirmed filled quantity and labels every row’s execution source. Alpaca fills no longer open simulator-only journal endpoints.
- Research previously defaulted to extended hours and always forwarded the informational target as a take-profit field unsupported by the common lifecycle. Its default is a regular-hours limit order, the target is explicitly informational, and a pure ticket adapter preserves the managed stop while validating whole shares and the price ceiling.
- Trade Plan previously defaulted to market entry without a ceiling, extended hours, and an unsupported take-profit child. Its default is a limit at the idea’s displayed entry, regular hours, and an explicitly informational target. Advanced execution requests remain subject to backend rejection.

## Backtest and provenance audit

Reviewed `backend/backtest/backtestEngine.js`, its route, and Research/Trading System rendering. The indicator functions use slices ending at the current index; no future-index slice was found in that bounded inspection. However, signals incorporate the current close and execute at that same close, an optimistic fill assumption. Accounting uses one share per trade on a fixed $100,000 equity baseline, zero fees/commissions/slippage, and 2% entry-price risk for R multiples. This is not a realistic execution model.

The backtest result now includes `executionSource: historical-simulation` plus structured assumptions and a plain-language warning. The route already returns and persists the complete engine result, so the disclosure accompanies new API results and strategy-run records. Trading System visibly discloses these same assumptions, including for legacy runs lacking recorded metadata. No strategy or price-timing model was rewritten.

Research already exposes generated/cache timestamps, source and published timestamps on citations, captured research snapshots, and stale-data warnings/counts. This read-only inspection does not establish that every upstream timestamp is truthful or that all stale/error paths have passed real browser acceptance.

## Validation

- New request helper regressions: duplicate in-flight submission; explicit new request after terminal status; uncertainty blocks new identity; persisted status matching. Existing stable retry, changed economics, and status-message tests remain passing.
- New request panel tests: terminal refresh → prepare → separate submit; uncertain reload → same-key retry.
- New display tests: actual broker-shaped position lacking percentage; partial order/fill rows with unavailable realized P&L and explicit source.
- New research ticket tests: regular-hours capped order with informational target; invalid ceiling/fractional quantity rejection.
- New coordinated-close helper tests: ambiguous retry identity and explicit new-key preparation after terminal close.
- New backend backtest assertion: structured source/timing/sizing/cost disclosure.

Latest local results: **24 frontend tests passed across 8 suites**, **2 backend backtest tests passed**, using Node 20. The frontend production build compiled successfully with CI warnings treated as errors. An initial build caught a duplicate disabled prop; this was fixed before the successful build. Root owns broader backend, browser, multi-process and complete verifier results.

No package versions changed. No real brokerage order, external SMTP delivery, deployment, or live trading activation was performed.

## Browser-discovered market source follow-up

The real browser acceptance runner found that the header used a local calendar while the controlled broker clock reported open and execution was permitted. `/api/market/status` now uses the actual paper broker clock when Alpaca mode is configured, validates a Boolean open flag and a timestamp within 60 seconds, and returns an explicit source. A missing, stale or failed broker lookup returns HTTP 503 with `status: UNAVAILABLE`; it does not fall back to a local closed-market claim. Simulator mode retains its explicitly labeled local calendar.

The market-status hook now starts in LOADING, reports UNAVAILABLE on failure, carries the source to the header, refreshes periodically, and cancels updates after unmount. TopBar, Stock and Trade Plan distinguish unknown status from closed. Portfolio displays the simulator risk-settings panel only for simulator accounts, avoiding blank percentages presented as Alpaca controls.

Follow-up validation: two backend market-source tests failed before the fix and now pass (provider open overrides local calendar; outage/stale clock fails explicitly). Two hook tests failed before the fix and now pass (failure does not claim CLOSED; provider source reaches consumers). Latest full frontend run: **26 tests passed across 9 suites**. The two existing backtest tests also passed. Final production build is recorded by the root verification run.

## Real-server screen matrix follow-up

`scripts/acceptance/screens.spec.cjs` uses the production React build, real authentication cookies/JWT expiration, actual Express routes and services, isolated Mongo replica-set databases, and a local controlled provider transport. It does not intercept or replace application API responses. Each of the nine required screens is checked in eight scenarios: persisted empty data, valid broker/simulator data, loading, expired authentication, stopped backend, provider outage, empty market responses, and stale market observations. Loading evidence records visible skeleton DOM transitions while CDP adds transport latency; subsequent assertions require each screen's actual content.

The valid-data scenario creates a broker order through the actual API, fills it at the controlled broker, runs reconciliation in a separate backend process, checks the actual fill endpoint, generates a persisted plan through the actual API, and runs a persisted backtest. A simulator-only trade and explicitly sourced equity snapshots are inserted into the disposable database to prove that the actual analytics endpoint and rendered simulator P&L exclude broker records, while Portfolio/Activity exclude simulator balances and fills. The seeded simulator P&L is $777; broker cash after the two-share purchase is $9,800. Mongo-backed screens continue showing their explicitly scoped persisted data during upstream market outages.

Browser-driven regressions fixed during this work:

- Home now explains that no eligible recommendation is available. Its market status uses the broker clock hook rather than a separate local calendar.
- Backend unavailability now displays a recoverable session-service failure instead of a false logout. HTTP 401/403 still require login. A focused auth test verifies this distinction; the original App login test now supplies an actual 401 contract instead of an undefined mock response.
- Research exposes the complete freshness-warning list in an expandable section. Previously the first dashboard warning hid stale or missing stock-history warnings.
- Home distinguishes unavailable quotes from zero prices, preserves provider observation timestamps, and labels observations older than 15 minutes. Null price changes display unavailable rather than zero. Stock labels chart observations with timestamps and warns when historical data is missing or older than 15 minutes; chart closes are explicitly described as historical observations, not executable quotes.
- The Alpaca fill reader previously queried `environment: paper`, which the strict Fill schema does not store. The reader now uses the existing persisted `executionSource: alpaca-paper` together with account and broker. This restores actual reconciled fills to Activity without a migration. A focused strict-schema regression verifies inclusion and source/account exclusion.

Latest unit verification: all **34 frontend tests across 12 suites** passed, and all **4 Alpaca portfolio tests** passed. Production build `main.04188f52.js` compiled successfully without warnings. Root's final verifier records the authoritative browser and complete backend results. Prior failed browser iterations are not acceptance evidence.

The final local matrix run completed with **8 tests passed in 52.7 seconds**, covering all nine screens per scenario. Its JSON report is `docs/evidence/phase3-screens-report.json`. One additional direct broker-equity source assertion was added after this run began; the root full verifier must execute the final file before treating that assertion as verified.

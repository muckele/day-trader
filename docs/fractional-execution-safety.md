# Fractional broker execution safety contract

Application opening orders remain positive whole-share requests. Manual/API and Robo risk admission reject fractional openings; frontend inputs, strategy configuration and package dependencies are unchanged. Broker executions and owned positions may carry fractions, and canonical coordinated reduction can sell the exact owned fraction. This does not authorize general fractional opening or short trading.

## Quantity and persistence

`backend/services/shareQuantity.js` uses BigInt nanoshare units: 1 share equals 1,000,000,000 units. Parsing accepts nonnegative quantities with at most nine fractional digits; negative, malformed, exponent and excess-precision representations fail closed. Arithmetic, comparison and canonical identity operate on exact units. Broker wire quantities are normalized strings. Persistence retains safe whole-share Numbers for legacy compatibility and stores fractions as normalized decimal Strings. The constrained Mixed quantity schema uses the same setter/validator. Existing whole records need no rewrite or backfill.

`1`, `1.0` and `1.000000000` persist as numeric 1. `0.5` and `0.500000000` persist as string `0.5`. Existing Fill uniqueness on account, broker order and cumulative quantity is unchanged. All canonical writes normalize before indexing; arbitrary raw database writes are outside this contract. No index drop, additive index or operational migration is required.

Broker positions such as `17.582774` retain exact comparison precision. External inventory forms the trusted portfolio baseline; it is not fabricated into application Fill rows. Fractional API observations are strings, while existing whole quantities remain numbers.

## Execution economics and exposure

Broker cumulative filled quantity and decimal average price determine cumulative execution cents. Multiply exact quantity units by exact decimal price and 100; divide by the corresponding share/price scales, rounding half up to cents. Incremental Fill cents are the new rounded cumulative total minus the prior recorded total. This preserves final spending independently of intermediate observation count and avoids repeated per-fragment rounding. Monetary values remain safe integer cents. Existing numeric Fill price/notional fields remain display projections of those recorded deltas; exact cumulative quantity and integer cents are authoritative.

Duplicate, equivalent or stale lower cumulative observations create no extra economic Fill. Cumulative execution beyond the acknowledged order bound, malformed quantities and regressing cumulative notional fail closed. Partial execution followed by cancellation retains exact filled ownership and confirmed spend and releases the remaining reservation.

RC-002 compares broker quantities with trusted baseline plus canonical net fills using exact arithmetic. A delayed or conflicting position cannot erase the fill: coverage becomes unresolved and new exposure is blocked. Matching broker/canonical fractions cover once. Unattributed active-order blocking and transaction-version checks remain intact.

## Restricted reduction and protection

Only the private callback used by canonical `closePosition` invokes the distinct reducing-order normalizer. A public origin string or reduceOnly field cannot grant this authority. Fractional reduction is a positive market DAY sell of no more than exact owned and reducible long exposure. It requires an active/tradable/fractionable US equity, paper/account/owner checks, fresh open regular-session clock, stable intent identity and the existing coordinated exit lease. It cannot cross zero or round an unsupported position. Non-fractionable holdings produce an explicit blocker.

Ordinary opening replacement remains whole-only. Reducing exit replacement remains prohibited: cancel/reconcile semantics are required. Existing GTC managed protection does not gain fractional-stop support; it records fractional exposure as explicitly unprotected and blocks automated entries until protected, reduced or otherwise resolved under existing controls.

RC-001 retains S (durable stop/control transition), D (durable final dispatch authorization) and T (transport dispatch). This change introduces no broker writes inside retryable database callbacks and no new absolute stop-versus-transport guarantee. Accepted-response uncertainty recovers the durable client identity without a second economic POST.

## Guarded external PAPER harness

The standalone acceptance harness remains an explicitly authorized operator tool. Deterministic verification uses only controlled local providers and synthetic databases; it never runs a real acceptance attempt.

Before broker access the harness validates owner, explicit paper binding, disabled automation, inactive worker/exit leases, unresolved intents, reservations and persistence readiness. A regular session must have at least 30 minutes remaining, including equality. Clock and uncached executable bid/ask timestamps must be valid and at most 60 seconds old. The selected one-share fixture must have a fresh ask at or below $250 and fit canonical risk limits; occupied symbols are skipped.

The standalone cancellation limit is below the bid by the larger of five times the latest five-bar mean minute range or twenty spreads, within sanity bounds. Quote, clock and margin are revalidated immediately before the existing final canonical dispatch authorization. A subsequent synchronous transport guard checks freshness, terms, ownership and mutation budget. Moving into marketability or losing the required margin prevents POST.

Stable intent/client/broker identity is checked before cancellation. An unexpected partial/full cancellation-fixture fill is reduced by its exact acceptance-owned quantity, restored to baseline, and the run stops with PARTIAL rather than continuing to another opening test. No unrelated position/order may change. Uncertain cancellation or incomplete cleanup is reported for reconciliation without speculative retries. At most three submissions and one cancellation per order are allowed. A reducing timeout preserves and reports residual exposure.

## Broker contract and release gates

The implementation uses the documented common subset of [Alpaca fractional trading](https://docs.alpaca.markets/us/docs/fractional-trading): up to nine quantity decimals, fractionable assets and no fractional short opening. Market/DAY regular-session long reduction avoids broader order-type/extended-hours scope. [Trading updates](https://docs.alpaca.markets/us/docs/websocket-streaming) distinguish event fill quantities from cumulative order quantities. [Order documentation](https://docs.alpaca.markets/us/docs/orders-at-alpaca) supplies price-increment constraints. These documents were reviewed during the original implementation; no new brokerage/documentation requests were needed for test finalization.

The release verifier explicitly requires the fractional Mongo gate and exact executable scenario names for quantity/opening policy, fractional accounting/coverage/reduction/recovery and guarded acceptance. Missing, duplicate, skipped or malformed scenario output fails verification even with inflated aggregate totals. Existing RC-001/RC-002 required names remain mandatory.

See [verification and image evidence](evidence/fractional-execution/README.md). A local passing candidate requires separate push authorization and exact-SHA hosted CI. Real PAPER acceptance, external SMTP receipt, deployment/routing, backup/recovery, monitoring/soak and persistent activation remain separate operational gates. No broader agentic feature is enabled by this change.

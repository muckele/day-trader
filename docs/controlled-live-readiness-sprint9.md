# Controlled Live Readiness — Sprint 9

## Outcome

Sprint 9 completes the next two integrations identified after Sprint 8:

1. persisted rolling walk-forward validation for the exact canonical Robo strategy; and
2. a paper-versus-live execution discrepancy report that blocks promotion when real execution materially diverges from recent paper behavior.

Neither integration authorizes a trade, changes credentials, deploys the application, expands the symbol universe, increases order size or frequency, relaxes exact-order authorization, or bypasses the Sprint 1–8 broker boundary.

## Rolling walk-forward validation

### Why single-period backtests were insufficient

A single historical interval can reward parameter choices that happen to fit one regime. It also mixes model development and evaluation into one sample. Sprint 9 requires sequential out-of-sample windows instead.

The default walk-forward layout is:

```text
252 daily bars training
 63 daily bars out-of-sample test
 63 daily bars forward step
```

The window moves forward without using future test bars in its training interval:

```text
[ train 1 ][ test 1 ]
          [ train 2 ][ test 2 ]
                    [ train 3 ][ test 3 ]
```

Each window records:

- training start and end;
- test start and end;
- in-sample trade count, win rate, average R, and drawdown;
- out-of-sample trades;
- out-of-sample trade count, win rate, average R, and drawdown; and
- the exact fixed train/test/step parameters.

Training bars are retained as indicator warm-up data, but an explicit trade-start boundary prevents them from opening a position that carries into the test interval. Out-of-sample trades, P&L, and drawdown therefore begin inside the test window.

Aggregate evidence records:

- total out-of-sample trades;
- out-of-sample win rate;
- out-of-sample average R;
- maximum test-window drawdown;
- window count; and
- percentage of windows with positive out-of-sample average R.

### Walk-forward promotion gates

Every cohort symbol must have a completed walk-forward StrategyRun from the last 90 days. Each selected run must satisfy:

- at least three rolling windows;
- at least 30 total out-of-sample trades;
- positive aggregate out-of-sample average R;
- at least 60% of windows with positive out-of-sample average R;
- no more than 10% maximum test-window drawdown; and
- the same valid parameter-version record across all cohort symbols.

The existing StrategyRun and StrategyParameterVersion records retain account, strategy, symbol, parameters, hashes, metrics, completion time, and full window results. Only runs with `summary.validationType = walk_forward` qualify for promotion.

### API

```http
POST /api/backtest/walk-forward
```

Example request:

```json
{
  "symbol": "AAPL",
  "strategyId": "ROBO_TREND_FOLLOWING_V1",
  "start": "2021-01-01",
  "end": "2026-01-01",
  "trainBars": 252,
  "testBars": 63,
  "stepBars": 63
}
```

The endpoint requires authentication and MongoDB because promotion evidence must be durable. It accepts only canonical `ROBO_` strategy identifiers. Insufficient data produces a failed StrategyRun with the partial validation result rather than silently recording a qualifying run.

## Paper-versus-live execution discrepancy

### Comparison cohort

For the same account, strategy, and cohort symbols, Sprint 9 loads up to 2,000 paper RoboTradeOrder records from the last 90 days. Each symbol must have at least 20 comparable filled paper orders.

A comparable fill must contain:

- expected quantity;
- filled quantity;
- trusted execution-quality reference quote;
- average fill price;
- submitted time; and
- filled time.

Missing comparison evidence does not receive a neutral default; it blocks the gate.

### Metrics

The discrepancy assessment calculates:

- comparable paper fills per symbol;
- paper terminal-order rejection rate;
- paper and live quantity-completion ratios;
- paper mean adverse slippage;
- live canary mean adverse slippage;
- live slippage degradation relative to paper;
- paper 95th-percentile fill latency; and
- live mean fill latency.

### Discrepancy gates

Promotion requires:

- at least 20 comparable paper fills for every cohort symbol;
- paper rejection rate no greater than 5%;
- at least 99% quantity completion for every compared paper and live fill;
- live mean adverse slippage no more than 15 basis points worse than paper mean;
- live mean fill latency no more than 5 seconds above paper’s 95th percentile; and
- complete comparable evidence for all three live canary orders.

The direct authenticated API is:

```http
GET /api/robotrader/execution-discrepancy
```

The response includes all metrics, per-symbol coverage, individual comparable fills, every gate, the immutable discrepancy fingerprint, and the server-side thresholds.

## Promotion integration

The Sprint 7–8 promotion assessment now has two additional requirements:

```text
strategy_evidence
  └─ newest per-symbol runs must be qualifying walk-forward validation

paper_live_discrepancy
  └─ paper/live coverage, rejects, fill ratio, slippage, and latency must pass
```

The promotion fingerprint includes both the strategy-evidence fingerprint and discrepancy fingerprint. Consequently, changing any selected walk-forward run, parameter version, paper comparison order, live canary fill, latency, rejection rate, or drift metric changes the promotion decision boundary.

The full discrepancy evidence is also stored on `RoboLivePromotion`, preserving the exact comparison used by the operator.

For a consumed promotion, the scheduler and final broker-submission guard rebuild the complete promotion assessment. If the current fingerprint differs or any gate no longer passes, the activation is revoked or the request returns `PROMOTED_EVIDENCE_CHANGED` before a broker call. This covers new paper rejects, changed comparison fills, parameter changes, newer selected walk-forward runs, evidence expiry, and newly failed discrepancy thresholds during the interval between promotion and submission.

## Dashboard

The promotion panel now shows:

- walk-forward window count and stability through the Sprint 8 strategy-evidence gates;
- parameter-version provenance;
- paper mean slippage;
- live mean slippage;
- live-versus-paper degradation;
- paper rejection rate;
- per-symbol paper fill coverage;
- quantity-completion status;
- fill-latency comparison; and
- pass/blocked state for every discrepancy gate.

## Operator workflow

1. Complete at least 20 comparable paper fills per intended cohort symbol using the same account and exact strategy.
2. Run authenticated walk-forward validation for every cohort symbol with one shared parameter configuration and date window.
3. Verify at least three rolling windows and 30 out-of-sample trades per symbol.
4. Review positive-window stability, out-of-sample average R, drawdown, and the parameter hash.
5. Complete, reconcile, review, and seal the three promotion-grade live canaries.
6. Review paper rejection rate, quantity completion, fill latency, and direction-aware slippage degradation.
7. Treat missing data or a discrepancy breach as a reason to investigate, not as a threshold to override.
8. Approve one repeat canary only when every prior readiness, dossier, strategy, walk-forward, and discrepancy gate passes.
9. Re-run walk-forward and paper comparison evidence whenever strategy parameters, symbols, market-data provenance, broker behavior, or market structure changes.

## Limitations

Walk-forward validation reduces one form of overfitting but does not eliminate it. Reusing the same windows for repeated design decisions can turn out-of-sample data into another training set. Twenty paper fills and three live fills are still small samples, and paper fills do not reproduce queue position, market impact, halts, venue routing, or real broker constraints.

Sprint 9 enforces reproducibility and discrepancy visibility. It does not prove profitability, statistical significance, future execution quality, or acceptable financial risk.

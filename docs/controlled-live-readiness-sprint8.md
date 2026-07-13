# Controlled Live Readiness — Sprint 8

## Outcome

Sprint 8 binds Sprint 7 repeat-canary promotion to reproducible strategy-validation evidence and observed live execution drift. It does not increase order size or frequency, establish profitability, authorize a promotion by itself, activate live trading, configure credentials, deploy the application, or place a trade.

The existing day-trader code already persisted `StrategyRun` and `StrategyParameterVersion` records, but two gaps prevented those records from being trustworthy controlled-live evidence:

1. the canonical RoboTrader strategy identifiers were not accepted by the backtest registry; and
2. promotion did not bind to a specific parameter version, recent per-symbol validation runs, or realized canary slippage.

Sprint 8 closes both gaps without adding another execution path.

## Exact Robo strategy backtests

The existing deterministic backtest endpoint now accepts the same identifiers emitted by the canonical RoboTrader worker:

```text
ROBO_MOMENTUM_BREAKOUT_V1
ROBO_MEAN_REVERSION_V1
ROBO_TREND_FOLLOWING_V1
ROBO_RISK_OFF_PROTECTION_V1
```

Each profile uses deterministic daily-bar entry and exit rules aligned with the corresponding strategy family. Risk-off validation supports direction-aware short P&L. The backtest route continues to persist:

- account scope;
- exact strategy identifier;
- symbol;
- simulation mode;
- completed status;
- immutable parameter-version reference;
- trade count;
- win rate;
- average R multiple;
- maximum drawdown; and
- completion time.

Backtest results are evidence, not authorization. They remain subject to data quality, sample selection, survivorship, overfitting, regime, and implementation limitations.

## Strategy-validation gates

For every symbol in the three-canary promotion cohort, Sprint 8 selects the newest completed simulation backtest that:

- belongs to the same account scope as the canary orders;
- uses the exact cohort strategy identifier;
- completed during the last 90 days; and
- is for that cohort symbol.

Sprint 9 strengthens this requirement so only persisted rolling walk-forward runs count as promotion evidence; single-period backtests remain useful research but no longer satisfy controlled-live promotion.

The selected runs pass only when:

1. every cohort symbol has a recent completed run;
2. every selected run points to the same non-null parameter-version identifier;
3. every run contains at least 30 completed trades;
4. every run has positive average R;
5. every run has maximum drawdown no greater than 10%;
6. every canary dossier contains enough quote/fill evidence to calculate realized adverse slippage;
7. no individual canary has more than 50 basis points of adverse slippage; and
8. the cohort mean adverse slippage is no more than 25 basis points.

Missing values fail closed. A strong backtest for one symbol cannot stand in for another cohort symbol, and separate parameter versions cannot be combined into one promotion.

## Direction-aware execution drift

Sprint 8 compares the broker average fill price to the trusted execution-quality quote stored in the sealed dossier:

```text
buy adverse slippage  = (fill - reference) / reference
sell adverse slippage = (reference - fill) / reference
```

The result is expressed in basis points. Favorable execution can be negative; adverse execution is positive.

This is an execution-drift measurement, not a strategy-return comparison. It checks whether real fills materially departed from the prices used at policy evaluation. It does not claim that a fill, strategy, or portfolio was profitable.

## Evidence fingerprint

The strategy-evidence fingerprint commits to:

- Sprint 8 evidence-policy version;
- account scope;
- exact strategy identifier;
- cohort symbols;
- selected StrategyRun identifiers;
- parameter-version identifiers;
- run completion times;
- captured validation metrics; and
- realized slippage for all three canaries.

The Sprint 7 promotion fingerprint now includes this strategy-evidence fingerprint. Changing a selected run, parameter version, metric, symbol, or canary fill changes the promotion fingerprint and invalidates any unmatched promotion decision.

The `RoboLivePromotion` record stores the full evidence snapshot used at approval, including its expiry time and parameter version.

## Staleness and automatic demotion

Strategy evidence expires 90 days after the oldest selected backtest completion time. A promotion is still limited to seven days, but evidence can expire sooner when an older run is near its 90-day boundary.

The scheduler expires an unconsumed promotion when either:

- its normal seven-day promotion lifetime ends; or
- its bound strategy evidence expires.

At controlled-live approval time, the complete promotion assessment is rebuilt. A newer backtest, changed parameter version, changed cohort, missing run, stale run, or failed drift gate produces a different or ineligible assessment, so the old promotion cannot be consumed.

If evidence expires after promotion was consumed, the scheduler revokes the linked approved or active activation, marks its lifecycle failed, expires the consumed promotion, disables automation, advances `controlGeneration`, records an audit event, and raises a critical operational alert. The final broker-submission guard independently requires the consumed promotion’s evidence expiry to remain in the future, so a delayed scheduler cannot make stale evidence usable.

Automatic demotion revokes permission to create or submit through the promoted controlled-live activation. It does not alter historical dossiers, parameter versions, or backtest records.

## API and dashboard

Sprint 8 evidence is embedded in:

```http
GET /api/robotrader/live-promotion
```

It is also available directly from:

```http
GET /api/robotrader/strategy-evidence
```

The direct response includes the complete evidence assessment and these server-side thresholds:

- maximum backtest age;
- minimum trades per symbol;
- maximum backtest drawdown;
- maximum individual canary slippage; and
- maximum mean canary slippage.

The RoboTrader promotion panel displays parameter version, evidence expiry, mean realized slippage, and every nested strategy-evidence gate. Promotion remains disabled when any nested gate is blocked.

## Operator sequence

1. Identify the exact strategy ID and symbols in the current three-canary cohort.
2. Run the deterministic backtest endpoint for each cohort symbol using the same validation parameters and date window.
3. Confirm every run completed and points to the same parameter-version ID.
4. Review sample count, average R, maximum drawdown, test period, market regimes, and data limitations.
5. Inspect each sealed canary’s trusted quote, average fill, and direction-aware slippage calculation.
6. Wait for the Sprint 7 cooling period and require every Sprint 7–8 gate to pass.
7. Approve at most one repeat canary using the unchanged Sprint 7 confirmation and limits.
8. Re-run validation when evidence expires, parameters change, a new symbol enters the cohort, or execution drift worsens.
9. Revoke instead of promoting whenever the backtest or real-fill evidence is not representative.

## Remaining human responsibility

Thirty historical trades and three canary fills are not statistically sufficient to prove profitability or safety. Average R can be unstable, drawdown can be understated, and past regimes can differ from current markets. Sprint 8 ensures that promotion references recent, internally consistent evidence and conservative execution drift; it does not decide that the strategy deserves real capital.

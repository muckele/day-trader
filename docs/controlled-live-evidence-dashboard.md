# Controlled-Live Evidence Dashboard

## Outcome

The Trading System page now closes the Phase 3 observability gap identified in the upgrade plan. It presents existing controlled-live records as four read-only operator views:

1. strategy scorecards;
2. comparable paper-fill coverage;
3. account exposure and drawdown history; and
4. an intent-to-reconciliation control blotter.

The dashboard does not authorize, submit, cancel, promote, or modify an order. It does not change live credentials, feature flags, risk limits, strategy parameters, canary controls, or broker state.

## API

```http
GET /api/trading-system/operational-evidence?days=90&limit=200
```

The route requires authentication and derives the account scope from the authenticated request. Callers cannot provide a different account identifier. The lookback is clamped to 1–365 days and the per-collection record limit is clamped to 1–500.

The response includes `completeness` metadata for every queried collection: matched count, returned count, record limit, and a truncation/complete flag. Exposure-breach and reconciliation-discrepancy counts are calculated over the complete requested window even when the display series is truncated. The interface never presents a green exception-free state when evidence is missing, unavailable, or truncated.

When MongoDB is unavailable, the endpoint returns the stable empty schema plus the existing `DATA_UNAVAILABLE` warning. It never substitutes another account or fabricates neutral evidence.

## Strategy scorecards

StrategyRun records are grouped by exact `strategyId`. Each scorecard reports:

- most recent run and status;
- total, completed, and failed runs;
- walk-forward and qualifying walk-forward run counts;
- symbols represented;
- durable parameter versions represented;
- mean completed-run trade count, win rate, average R, and positive-window rate; and
- worst completed-run maximum drawdown.

A strategy is labeled `validated` when the lookback contains at least one completed walk-forward run whose persisted summary passed. That label is evidence visibility, not live eligibility: cohort-wide parameter consistency, recency, per-symbol selection, canary, discrepancy, readiness, and promotion gates remain enforced by the canonical promotion services.

## Paper evidence coverage

Paper RoboTradeOrder records are grouped by exact strategy and symbol. The view distinguishes:

- all orders;
- filled orders;
- comparable fills;
- rejected orders; and
- progress toward the existing 20-comparable-fill target.

A filled order counts as comparable only when the existing discrepancy helpers can derive all three required values:

- direction-aware realized slippage from a trusted reference quote and average fill price;
- quantity or notional completion ratio; and
- submitted-to-filled latency.

The progress bar therefore does not count incomplete paper fills as qualifying evidence.

## Exposure history

RoboExposureSnapshot records produce chronological gross exposure, net exposure, and total drawdown series. The view also reports the latest equity and position count, peak gross exposure, peak total and daily drawdown, and the number of breached snapshots.

Snapshots are historical observations. A later clear snapshot does not erase or neutralize an earlier breach.

## Control blotter

The blotter joins each OrderIntent to its locally owned RoboTradeOrder through `intentId`. Each row shows:

- request and submission time;
- symbol, side, quantity, environment, origin, and strategy;
- intent, authorization, broker, and reconciliation status;
- realized slippage and fill latency when present;
- policy reason codes and failed risk checks;
- reconciliation discrepancies; and
- locally open broker orders older than 15 minutes.

The stale-order label is a diagnostic signal only. The dashboard deliberately performs no cancellation because stale-order resolution must remain in the canonical reconciliation and emergency-stop workflows.

## Operator use

1. Freeze one intended strategy, parameter version, and symbol cohort.
2. Use the scorecards to verify recent qualifying walk-forward evidence for every symbol.
3. Use paper coverage to collect at least 20 comparable fills per symbol.
4. Review every exposure breach, policy block, failed risk check, stale order, and discrepancy before considering a canary.
5. Continue with the Sprint 4–9 canary, dossier, cooling-period, promotion, and repeat-canary procedures only when the canonical server-side assessments pass.
6. Refresh or rerun evidence whenever parameters, symbols, broker behavior, market-data provenance, or market structure changes.

## Limitations

The endpoint limits each queried collection independently. When any limit is reached, the dashboard marks the evidence incomplete; a very active account may need a narrower time window to inspect the complete dense period. Scorecard averages summarize stored runs and do not replace inspection of individual walk-forward windows. Paper-fill coverage does not prove profitability or realistic market impact. The dashboard is an operator diagnostic surface; canonical readiness, validation, discrepancy, authorization, activation, and promotion services remain the decision boundary.

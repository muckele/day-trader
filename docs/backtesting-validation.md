# Backtesting and Validation

## Current state
The repo already includes backtest endpoints and strategy replay functionality. Phase 1 does not replace that subsystem; it standardizes how strategy metadata and recommendation outputs can feed future validation workflows.

## Required validation workflow
- unit tests for factor calculations and policy checks
- regression tests for recommendation routes
- paper-trade observation before any live rollout
- strategy versioning and run IDs for future expansion

## Next implementation targets
- persist backtest runs and parameter versions
- compare-run summaries
- regime-segmented scorecards
- paper vs live discrepancy analytics

# Strategy Modules

## Registry Intent
Strategies are modeled as metadata-first modules so signal generation, portfolio construction, execution, and reporting can reference the same identifiers.

## Current Registry
- `TREND_FOLLOWING_EQUITIES`
- `SWING_BREAKOUT_EQUITIES`
- `MEAN_REVERSION_EQUITIES`
- `ETF_ROTATION`
- `LONG_SHORT_LITE`
- `OPTIONS_OVERLAY`
- `DEFENSIVE_HEDGE`
- `CRYPTO_MOMENTUM`

## Required metadata
Each strategy definition includes:
- strategy id and name
- asset classes
- allowed sides
- compatible regimes
- paper/live eligibility
- risk profile key
- default capital allocation cap
- holding period intent
- tags and operator notes

## Current implementation notes
- Recommendation engine uses the registry for bucket-to-strategy mapping.
- Robo execution can validate a signal against registry-level eligibility.
- `OPTIONS_OVERLAY` and certain live-capable strategies remain disabled by default until explicitly enabled.

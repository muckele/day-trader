# Risk Framework

## Design Principles
- Paper trading is the default operating mode.
- Live trading is disabled unless explicitly enabled.
- Deterministic policy checks run before any automated trade is submitted.
- No martingale, no averaging down by default, no hidden leverage assumptions.

## Risk Layers

### Account-level controls
- Max daily realized loss
- Max daily total loss
- Max weekly and monthly drawdown thresholds
- Max gross and net exposure
- Max long and short exposure
- Max concurrent positions
- Max strategy allocation
- Global kill switch

### Strategy-level controls
- Strategy enable/disable flag
- Allowed regimes
- Max executions per day
- Max capital allocation
- Loss-streak and circuit-breaker throttles

### Position-level controls
- Risk-per-trade sizing
- ATR-informed stop framework
- Liquidity and range filters
- Spread proxy guardrails
- Gap-risk and volatility penalties
- Special restrictions for shorts and leveraged products

## Trade Approval Pipeline
1. Feature flag enabled?
2. Environment valid (paper vs live)?
3. Instrument allowed?
4. Strategy allowed in current regime?
5. Liquidity/range quality gate passed?
6. Spending / allocation limits OK?
7. Execution cooldowns and duplicate-signal checks OK?
8. Stop / target framework present?
9. Audit record written?

## Current Implementation Status
Implemented in this phase:
- Centralized feature-flag policy
- Instrument classification and policy checks
- Existing paper risk engine remains active
- Robo kill-switch and execution throttles remain active
- Recommendation engine emits disqualifying risks and live-eligibility flags
- Risk events can be persisted for blocked or degraded states

Planned next:
- Unified exposure snapshots
- Realized/unrealized drawdown monitor
- Order reject analytics and kill-switch escalation
- Per-strategy allocation ledger

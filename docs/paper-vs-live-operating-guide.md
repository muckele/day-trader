# Paper vs Live Operating Guide

## Default operating mode
- Paper trading enabled
- Live trading disabled
- Robo defaults to paper-safe behavior

## Paper mode
Use paper mode for:
- strategy iteration
- scheduler verification
- recommendation validation
- execution quality checks
- new feature rollout

## Live mode prerequisites
Before live mode is enabled:
- feature flag must explicitly allow it
- Alpaca live endpoint and credentials must be configured
- operator must review risk limits
- kill-switch and alerting must be verified
- manual QA must pass in paper first

## Safe rollout sequence
1. Run in paper only.
2. Verify recommendations and strategy registry output.
3. Verify robo audit logs and notifications.
4. Verify trade throttles and risk-event logging.
5. Enable live trading only in a controlled environment.

## Current implementation status
- Live auto-trading remains disabled by default.
- Recommendation engine marks ideas as paper-eligible vs live-eligible.
- Robo policy checks block unsupported live behavior.

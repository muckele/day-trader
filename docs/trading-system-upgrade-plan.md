# Trading System Upgrade Plan

## Current Architecture Summary

### Backend
- Node.js + Express API in `backend/server.js`
- Alpaca market data access in `backend/tradeLogic.js` and `backend/services/marketData.js`
- Deterministic analysis in `backend/analysisEngine.js`
- Recommendation route in `backend/routes/recommend.js`
- Robo trading engine in `backend/services/roboTraderEngine.js`
- Paper broker and portfolio simulation in `backend/paper/paperBrokerClient.js`
- Trade-plan generation in `backend/tradePlanEngine.js`
- Execution gating in `backend/executionGate.js` and `backend/paper/riskEngine.js`
- Mongo/Mongoose persistence for users, trade plans, paper trades, robo settings, logs, and regime snapshots

### Frontend
- React SPA under `frontend/src`
- Core trading surfaces: `Home`, `Stock`, `TradePlan`, `Portfolio`, `Activity`, `Analytics`, `Discover`, `RoboTrader`
- Current UX already supports watchlist, stock detail, paper order controls, analytics, and robo settings/audit

## Audit Findings

### Strengths already present
- Deterministic analysis engine already exists and avoids hard dependency on external LLM availability
- Paper-trading broker has meaningful controls: market-hours checks, slippage, short-borrow simulation, guardrails, and risk evaluation
- Robo trader already supports limits, scheduler, cooldowns, circuit breaker, audit logs, and email notifications
- Trade-plan flow already has an execution gate and audit trail

### Main technical debt / gaps
- Recommendation logic is duplicated across `tradeLogic`, `analysisEngine`, `signal/*`, and `utils/recommendationSchema`
- Environment and trading-feature configuration are not centralized or validated in one place
- No unified feature-flag / kill-switch / instrument-policy layer shared across recommendations, robo, and execution
- No first-class persistence for recommendation snapshots, richer risk events, or strategy configuration
- Strategy metadata exists but is too narrow for portfolio/risk orchestration
- Admin/control-plane APIs are minimal and not exposed as a dedicated trading-system surface
- Options, leveraged/inverse ETF, margin-aware live routing, and broader Alpaca capability usage are not yet structured as guarded modules

## Upgrade Phases

### Phase 1: Foundation and control plane
- Centralize trading configuration and feature flags
- Add strategy registry with richer metadata
- Add unified instrument-policy and pre-trade policy checks
- Replace simplistic recommendation ranking with a multi-factor engine
- Persist recommendation snapshots and risk events when Mongo is available
- Add read-only trading-system status API for admin/control surfaces

### Phase 2: Portfolio construction and execution hardening
- Add portfolio allocation service across strategies
- Add exposure snapshots and richer account-level limits
- Add order-intent / broker-order / fill persistence
- Add smarter order-type selection, stale-order management, and reject analytics

### Phase 3: Strategy orchestration and research validation
- Add strategy-run persistence, versioned parameters, and walk-forward backtest records
- Add paper-vs-live discrepancy reporting
- Expand analytics to strategy scorecards, exposure views, and blotter diagnostics

### Phase 4: Controlled asset-class expansion
- Options modules behind explicit flags
- Leveraged / inverse ETF modules behind explicit flags
- Conservative margin-aware live routing behind explicit live-trading approval
- Crypto expansion only where current data/execution stack is already enabled

## What Phase 1 implements in code
- `backend/config/tradingConfig.js`
- Feature flags and risk config models/services
- Strategy registry service
- Multi-factor recommendation engine with categorized lists
- Recommendation snapshot persistence
- Trading-system status route
- Robo pre-trade policy checks using centralized config

## Non-goals for this phase
- No live-trading auto-enable
- No undefined-risk options strategies
- No silent rewrite of current UI flows
- No removal of existing paper-trading or trade-plan features

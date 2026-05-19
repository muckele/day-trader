# Alpaca Capabilities Used

## Currently used directly
- Stock daily bars via `/v2/stocks/:symbol/bars`
- Stock intraday bars via `/v2/stocks/:symbol/bars`
- Latest stock quotes via `/v2/stocks/quotes/latest`
- Latest crypto quotes / trades via Alpaca crypto market-data endpoints
- Order submission via `/v2/orders`
- Paper trading endpoint as the default routing environment

## Used indirectly in app behavior
- Market-hours awareness for order eligibility
- Paper/live separation through endpoint choice and feature flags
- Short-selling simulation in paper broker using local borrow heuristics

## Not auto-enabled in this phase
- Options routing
- Margin-heavy live automation
- Undefined-risk option spreads
- Leveraged/inverse ETF automation without explicit enablement

## Operational stance
- Treat Alpaca as broker/data adapter, not as the sole source of risk control.
- App-level controls remain authoritative for eligibility, throttles, and auditability.

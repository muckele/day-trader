# Alpaca Trading API contract review

Reviewed 2026-09-12 (America/Los_Angeles), for Trading API paper accounts, not partner Broker API.

- [Placing orders](https://docs.alpaca.markets/us/docs/orders-at-alpaca): bracket exits activate after complete entry fill; cancellation affects the linked group. Brackets require DAY/GTC and no extended hours. Stops do not guarantee price. Limit and stop prices permit two decimals at or above $1, four below $1.
- [Fractional trading](https://docs.alpaca.markets/us/docs/fractional-trading): DAY market/limit/stop/stop-limit supported with either quantity or notional, subject to fractionable asset metadata. This does not establish verified fractional attached-protection handling in this application.
- [Working with orders](https://docs.alpaca.markets/us/docs/working-with-orders): use broker/client identity to query and manage orders; acknowledgement must be distinguished from execution.

MVP automated contract remains conservative: whole-share, long-only supported stocks/ordinary ETFs in regular hours; attached protection must be reconciled, including partial exposure. Fractional automation and overnight/extended-hours automation are not accepted for release. A documentation review is not an integration test. No paper-account reset was performed or authorized.

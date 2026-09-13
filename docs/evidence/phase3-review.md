# Phase 3 review and acceptance scope

Starting branch `codex/owner-paper-mvp`, clean HEAD `0dcc4d0dad7f47768a5613573b0a828bda0667ff`. The complete Phase 2 verifier was run before changes: every implemented check passed; its exit 1 was the documented incomplete full-stack release gate. This was preserved rather than treated as a code regression.

## Concrete findings corrected

- Empty-database startup tried dropping a legacy index on a nonexistent collection and never reached write readiness. NamespaceNotFound is now handled like IndexNotFound; actual new-database browser startup and focused regression prove index bootstrap completes.
- Known execution-readiness refusal was reached after creating an intent, giving a misleading uncertain submission. Production readiness is checked before admission and remains checked again at the broker boundary. Real Mongo verifies zero intent/close records and zero broker writes when unready.
- Close recovery depended on the slow general reconciliation interval and could wait behind research. A separate 30-second timer handles active closes and persisted protection-restoration work; disabled entries and ordinary reconciliation do not disable it. A blocked-worker regression and real Mongo uncertain-stop recovery verify this path.
- A deterministic risk refusal could permanently trap the browser ticket as uncertain without a persisted identity. Known normalized admission refusals now create a rejected identity in the account transaction. The frontend resolves only an explicit matching admission result or actual order state; it does not infer safety from HTTP status alone. Concurrent same-key attempts, later relaxed settings and a corrected new request are tested through real HTTP/Mongo.
- Broker P&L fields that are unavailable caused a portfolio formatting failure or appeared as zero realized P&L. The UI displays unavailable values explicitly and separates requested from confirmed filled quantities.
- Fill history queried a nonexistent environment field on Fill documents, hiding real confirmed executions. The API now selects the persisted account/broker/executionSource fields; the browser matrix confirms fills are visible and simulator history stays separate.
- Latest quote responses lost source timestamps, missing quotes became zero prices, and missing credentials generated synthetic quote/sparkline data. Timestamps are preserved, missing data is explicit, and unconfigured providers fail. Bid/ask spread is no longer mislabeled as daily price change.
- Browser and trade-plan market status used a local calendar while execution used the broker clock. Alpaca mode now uses the actual broker clock, displays its source and treats unavailable/stale clock as unavailable.
- Authentication-service failures were treated as an anonymous session. The UI now separates backend unavailable/retry from expired/revoked authentication (the latter returns to login).
- Canonical lifecycle/protection/close events were omitted from the Robo audit query. They are included alongside Robo events. Activity exposes account-scoped outbox metadata with queued/sending/retry/provider-accepted/failed labels and explicitly disclaims inbox receipt.

## Independent review

The security/tooling worker independently inspected coordinated close, cash transactions, protection recovery, timer shutdown, frontend request identity and the acceptance harness. It established the admission-refusal defect above and, after the bounded correction, reported no further concrete must-fix defect in those reviewed areas. The financial worker separately inspected admission transaction behavior and verifier integration. These are bounded code reviews, not an exhaustive security audit or observed external broker contract.

The root reviewed the guarded external command: exact paper origin, expected dedicated account, allowlisted symbol, integer capped notional, unique printed identity, one POST without retry, exact ownership/economics checks before cleanup, no broad cancel/reset/liquidation, and retained fills requiring operator action. External mode was not executed.

## Evidence boundaries

The release browser harness serves a production frontend and forwards every application API request to the real backend. Login uses the real form and server-issued cookies. Mongo is a loopback replica set with random test-owned databases. A test-only Axios transport preload preserves the original trusted HTTPS destination validation and forwards only explicit provider origins to a local Alpaca-compatible HTTP server. Application services, indexes, majority write readiness and account guards remain active. There is no Playwright application-API response interception or fake browser token. An independent negative HTTP test uses a historical non-owner fixture credential in a Node client, not in the browser.

Provider controls program account/clock/assets/orders/positions/partial and final fills/cancel/replace/timeout/delay/staleness. Process tests launch separate Node worker/reconciliation processes and control provider-boundary barriers. SMTP tests use real Nodemailer STARTTLS and a loopback capture server with a temporary certificate trusted only by child test workers. They prove provider acceptance and durable retry/restart state, not an external inbox.

Final complete-verifier results, command outputs, exact runner counts and remaining external gates are recorded in `docs/mvp-verification.md` and `docs/evidence/verification/report.json`. Do not infer final pass from targeted red/green runs or this review alone.

## Complete-run regression correction

The first clean Phase 3 verifier run rejected the lifecycle gate because an older production-risk test reused the same request key across independent validation cases. A durable rejected identity now correctly remains rejected even after the settings improve. The test was corrected to use distinct keys for the invalid-limit, incomplete-account and fresh-valid cases, retaining both original refusal assertions. It additionally retries both old rejected keys after correction and verifies rejected status, zero reserved cash and zero POSTs before a new valid key submits once. No production behavior or acceptance gate was weakened. The failed complete-run report and failing command output are preserved separately from the final complete rerun.

A further independent read-only review found no concrete defect in the final notification account scope/projection, removal of synthetic market-data fallbacks, persisted Fill source filter or shared broker-clock service. Final test execution remains the release authority.

Committed text transcripts normalize trailing whitespace only; pass/fail content is preserved. The final staged diff and bounded secret-pattern scan passed before commit.

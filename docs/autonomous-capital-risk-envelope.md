# Future Autonomous Capital Risk Envelope

## Status and boundary

This document is a design requirement for a future capital tier. It is **not implemented, approved, or enabled**. The current application supports supervised first and repeat canaries under unchanged $100-per-order and $100-per-UTC-day limits. Repeat-canary approval must never be described or treated as “full RoboTrader,” autonomous capital scaling, or permission to relax those limits.

A future tier may be built only as an immutable, versioned, server-side envelope. The client may display the envelope but may not widen it. Each approved envelope must be identified by a durable ID and content hash and bound into the strategy version, order fingerprint, authorization, activation, order, audit record, alert, exposure snapshot, and sealed dossier. Editing a limit creates a new version and invalidates prior approval; it must never mutate an approved version in place.

## Required envelope fields

Every field below is mandatory. Missing, invalid, internally inconsistent, or stale values fail closed.

| Control | Immutable limits and evidence required |
| --- | --- |
| Per-order notional | Maximum submitted notional, maximum quantity, price-collar basis, behavior for partial fills/replacements, and whether risk-reducing closes receive a separately bounded allowance. |
| Daily notional | Maximum gross submitted and filled notional per UTC day, including rejected, canceled, replaced, and partially filled attempts so replacement chains cannot bypass the limit. |
| Strategy allocation | Explicit strategy IDs and parameter-version IDs, maximum dollars and percentage allocation per strategy, and prohibition on unlisted or dynamically substituted strategies. |
| Gross/net exposure | Pre-trade and continuous maximum gross and absolute net exposure in dollars and as a percentage of verified equity, including positions and conservative working-order exposure. |
| Correlated concentration | Maximum aggregate exposure for securities exceeding an approved correlation threshold, the data source/window used to calculate correlation, stale-data behavior, and an unclassified bucket that fails closed. |
| Sector concentration | Maximum dollars and equity percentage per sector/industry, authoritative classification source, freshness requirement, and conservative handling of missing classifications. |
| Drawdown | Daily and total peak-to-trough loss thresholds, realized plus conservative unrealized P&L basis, reset rules, high-water-mark persistence, and a lower warning threshold before hard demotion. |
| Position limits | Maximum open positions, symbol notional, portfolio percentage per symbol, share quantity, short quantity, and overnight exposure; explicit allowlists and blocklists remain mandatory. |
| Order rate | Maximum attempts per minute/hour/day, maximum open orders, replacement/cancel rate, per-symbol cooldown, duplicate suppression, and counting rules that include rejected and ambiguous submissions. |
| Automatic demotion | Deterministic triggers and destination tier for any limit breach, stale heartbeat, reconciliation discrepancy, missing protection, alert-delivery failure, data-quality failure, credential anomaly, drawdown, excessive rejection/slippage/latency, or evidence expiry. Demotion must disable new risk before any asynchronous notification. |
| Credential authority | Exact operator identity, broker account, permitted API actions, environment, credential identifier/fingerprint, rotation/expiry rules, least-privilege proof, and an explicit prohibition on withdrawal/transfer authority. Staging credentials must never match production or access a live account. |
| Dossier and cooling period | Minimum successful sealed dossiers, minimum distinct UTC days, minimum observation time, maximum evidence age, minimum cooling period, manual approver/change-control reference, and rules requiring the cohort to restart after a material strategy, parameter, symbol, policy, data, execution, or envelope change. |

## Enforcement model

The envelope must be checked at all of these boundaries:

1. Configuration: validate schema, ownership, account scope, credential authority, and internal limit ordering before the version can be proposed.
2. Approval: require an authorized human to approve the exact envelope hash and change-control reference after the dossier and cooling-period gates pass.
3. Activation: re-read the immutable version and all current evidence; refuse activation if any fingerprint, operator, credential, strategy, parameter, symbol, or readiness state changed.
4. Pre-intent: calculate portfolio, correlation, sector, drawdown, position, and rate projections before creating an executable intent.
5. Pre-submit: atomically re-check the same envelope after authorization and immediately before broker I/O; claim notional and attempt capacity so concurrent workers cannot race through a limit.
6. Post-submit and reconciliation: count the attempt regardless of broker outcome, reconcile fills and replacements, verify protection, update high-water marks, and automatically demote on ambiguous or adverse state.
7. Continuous supervision: maintain a fresh operator heartbeat, reconciliation, market-data provenance, alert delivery, and exposure snapshots. Staleness fails closed.

All monetary and rate counters must use durable, account-scoped, atomic storage. Process memory, browser state, and eventually consistent dashboard aggregates are not authorization sources.

## Automatic demotion precedence

Demotion must be monotonic for the active incident: first block new submissions, then revoke active authorizations/activations, cancel only locally owned working orders when policy requires it, preserve or establish protective exits, emit a critical alert, and require reconciliation plus human review before re-arming. An alert-delivery outage never delays the local safety action.

No automatic promotion is permitted. Recovery from a demotion requires a new evidence assessment and explicit approval of the exact current envelope fingerprint.

## Minimum acceptance evidence before implementation can be enabled

- Unit and concurrency tests for every hard limit, including boundary equality, partial fills, replacements, retries, midnight rollover, worker races, stale data, and process restarts.
- Fake-broker and isolated Alpaca paper tests proving no bypass through rejected, canceled, ambiguous, or replacement orders.
- At least the envelope-defined number of successful dossiers and distinct UTC observation days under the exact strategy, parameter versions, symbol cohort, data provenance, execution policy, and envelope hash.
- Recorded emergency-stop, automatic-demotion, broker-outage, alert-outage/retry, database-failover, credential-rotation, and disaster-recovery drills.
- Independent operator-runbook, least-privilege, database-index, alert-delivery, and recovery review recorded through the application.
- A final human go/no-go decision. Enabling a deployment flag alone is never approval.

Until all of these controls exist and pass, the only live boundary is the supervised, unchanged-limit canary system.

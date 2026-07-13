# Controlled Live Readiness — Sprint 7

## Outcome

Sprint 7 adds evidence-based promotion governance for repeat controlled-live canaries. It does not raise the per-order maximum, permit more than one broker attempt per activation, remove exact-order authorization, automate promotion, configure live credentials, enable deployment flags, activate a canary, or place a trade.

The first three promotion-grade schema-v2 sealed canaries form the bootstrap cohort. Once three schema-v2 dossiers exist, every subsequent controlled-live approval requires a promotion decision bound to the current three-dossier cohort. Each consumed promotion can authorize exactly one new activation and can never be reused or re-approved for the same cohort. An unconsumed decision that expires or is voluntarily revoked may be reviewed and armed again without creating a duplicate cohort record. Older schema-v1 Sprint 6 archives remain valid historical evidence but do not count toward promotion because they lack machine-verifiable protective child orders.

## Promotion gates

The three most recent sealed dossiers must satisfy every gate:

1. Three sealed dossiers exist.
2. They span at least three distinct UTC days.
3. They use schema v2, which includes protective-order evidence.
4. Every stored SHA-256 dossier hash recomputes correctly.
5. Every canary reached post-canary review after a filled order was matched in reconciliation with no discrepancy.
6. Every long-entry canary has broker-verifiable protection through a bracket/OTO stop or a matched protective child order.
7. Every linked exposure snapshot is present and has no breach.
8. No dossier contains an unresolved critical alert.
9. All three orders use the same strategy identifier.
10. All three orders use the same canonical execution-policy version.
11. At least 24 hours have elapsed since the newest dossier was sealed.
12. The current Sprint 3 readiness assessment still passes.

Promotion remains blocked if any dossier is missing, altered, unsuccessful, unreconciled, unprotected, inconsistent, or too recent.

## Fingerprint-bound decision

The assessment fingerprint commits to:

- the promotion policy version;
- the `repeat_canary` stage;
- the ordered three-dossier hash cohort;
- the one strategy identifier;
- the one canonical execution-policy version; and
- the symbols observed in the cohort.

The exact approval phrase is:

```text
I approve one repeat canary under unchanged hard limits.
```

An approval is valid for seven days, limited to symbols already present in the verified cohort, and atomically changes from `approved` to `consumed` when the subsequent controlled-live approval is created. A concurrent or later request cannot consume it again. If the activation write fails after consumption, the promotion remains consumed and fails closed. The unique cohort fingerprint is retained permanently: an expired or revoked record can be re-armed only while `consumedAt` remains empty, while a consumed cohort is permanently ineligible for another approval.

A newly sealed dossier changes the cohort and therefore changes the assessment fingerprint. Another repeat canary requires another review and one new promotion record.

## Unchanged execution envelope

Promotion does not modify any Sprint 4–6 safeguard:

- maximum order notional remains $100;
- maximum daily cumulative notional remains $100;
- maximum daily orders remains one;
- each activation retains exactly one broker-attempt slot;
- activation and approval expiries remain enforced;
- the five-minute explicit supervisor heartbeat remains required;
- the symbol allowlist remains explicit and is further restricted to cohort-observed symbols;
- exact short-lived order authorization remains required where policy requires it;
- fresh execution-quality, portfolio, drawdown, market-session, and readiness checks still run at the final boundary; and
- critical alerts and supervision loss still revoke the activation.

This is controlled repetition, not notional scale-up and not autonomous trading.

## Revocation and rollback

The exact promotion revocation phrase is:

```text
Revoke repeat canary promotion now.
```

Revocation changes every current unconsumed approval to `revoked`. If a consumed promotion is linked to the current approved or active activation, that specific promotion and activation are also revoked; completed historical promotions are not rewritten. The authenticated route can then run Emergency Stop and cancel locally owned open live orders.

Any new critical operational alert automatically revokes every unconsumed promotion in addition to the existing activation rollback. The scheduler independently expires unused seven-day promotion approvals.

## API

```http
GET  /api/robotrader/live-promotion
GET  /api/robotrader/live-promotions
POST /api/robotrader/live-promotion/approve
POST /api/robotrader/live-promotion/revoke
```

The status endpoint returns the current cohort assessment, every gate, cooldown deadline, eligible symbols, current matching promotion decision, requirements, and exact confirmation phrases. The plural endpoint returns the authenticated user’s durable promotion history.

After three archived dossiers exist, this existing endpoint automatically enforces and consumes the matching promotion before it writes another activation:

```http
POST /api/robotrader/live-activation/approve
```

## Day-trader application reuse review

Sprint 7 included a direct source comparison against `/Users/Matt/Projects/day-trader`.

The separate application is the baseline from which this controlled-live workspace was created:

- backend files outside the Sprint 1–7 control changes are the same;
- its paper broker, Alpaca adapter, strategy engine, backtests, analytics, risk engine, scheduler, reconciliation, research, and trading-system services already exist in this project;
- the only material frontend difference is the expanded controlled-live RoboTrader page; and
- the separate app has none of the canonical authorization, controlled-live activation, heartbeat, dossier, or promotion modules added here.

No source file was copied from the separate app. Copying its broker, worker, risk, or scheduler implementations would replace newer fail-closed controls with the baseline versions or create parallel execution paths. Sprint 7 instead reuses the copies already present inside this project and adds promotion governance around the one canonical broker boundary.

Sprint 8 now consumes the existing strategy-run and parameter-version records as additional read-only promotion evidence. Those records do not bypass the live canary cohort and cannot authorize execution by themselves.

## Operator sequence

1. Complete, reconcile, review, and seal three schema-v2 Sprint 4–7 canaries on separate UTC days.
2. Wait at least 24 hours after sealing the newest dossier.
3. Review every Sprint 7 gate and independently verify the three displayed dossier hashes.
4. Confirm the cohort represents one intended strategy and canonical policy version.
5. Approve one repeat canary with the exact phrase and a change-control reference.
6. Create the next controlled-live approval using only cohort-observed symbols. This consumes the promotion.
7. Continue using the existing activation, heartbeat, exact-order authorization, reconciliation, review, dossier, revocation, and Emergency Stop procedures.
8. Revoke immediately if the operator’s assumptions, market conditions, strategy version, readiness evidence, or broker state change.
9. Require a new sealed dossier and a new promotion decision before another repeat canary.

## Remaining human responsibility

Three successful canaries do not establish profitability, statistical significance, or acceptable financial risk. Sprint 7 provides evidence integrity and change-control enforcement only. A human remains responsible for deciding whether the cohort is representative, whether the strategy should continue, whether real-money risk is acceptable, and whether to revoke before or during the next attempt.

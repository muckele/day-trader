# Owner-only startup and readiness contract v2

Production User index ownership is explicit. `User` retains its unique username and sparse unique email declarations, but its production schema sets `autoIndex:false` and `autoCreate:false` before compilation. Web startup/reconnect does not create User collections or uniqueness indexes. No other model is suppressed: trading/research index bootstrap and the majority-write readiness probe remain awaited and failure-sensitive. Existing User documents and indexes are preserved.

Legacy duplicate identity data is **not repaired or attested unique**. The authenticated response exposes `USER_UNIQUENESS_DEFERRED` and `identityIntegrity.uniqueness=not_attested`. This limited profile is justified only by closed public registration and the existing immutable `OWNER_USER_ID` login/session checks. It is not suitable for multi-user registration, owner election, recovery, or commercial readiness. A separate migration must inventory and resolve legacy identity integrity; never run `User.syncIndexes()` or a uniqueness migration as part of deployment startup.

## Authenticated observational contract

`GET /api/readiness` returns `contractVersion:2`, profile `owner-paper-maintenance`. `/health` remains minimal liveness. Authentication failures retain their existing HTTP responses. Once authenticated, readiness returns **200 iff runtimeReady**, otherwise503. HTTP200 alone is never a maintenance or deployed-release approval.

- `runtimeReady`: connected database; current successful awaited required-index/majority-write startup proof; valid configured owner ID and authentication secret; an existing exact owner with usable username, bcrypt hash shape and valid session generation; exactly one existing owner settings record with the canonical ObjectId relationship. Unknown/pending/failed checks are not passing. Missing owner/settings is not provisioned.
- `maintenanceReady`: runtimeReady plus explicitly PAPER settings, enabled=false, isEnabled=false, liveTradingExplicitlyEnabled=false, effective `ROBO_SCHEDULER_DISABLED=true`, canonical PAPER destination and present bounded account/credential configuration. No default is injected into absent settings fields. The account identifier is syntactically checked for1–128 ASCII letters/digits/underscore/hyphen; only a separately authorized broker check can validate the actual account binding.
- `checks`: named pass/fail/unknown states with structured reason codes and runtime/maintenance stage. `blockers` enumerates every nonpassing check. Responses omit IDs, hashes, URLs and credentials.
- `automation`: observed control values and scheduler suppression, separate from readiness; `activationAuthorized` is alwaysfalse. Positive readiness grants no trading authority.
- `acceptance`: `paperBroker`, `smtpReceipt`, and `deployed` each remain `not_evaluated`. This endpoint has no evidence-import or force-ready authority.
- `releaseReady:false` and `releaseBlockers` remain **deprecated compatibility fields** with conservative external-approval semantics. They are no longer the operative runtime/maintenance gate. No caller may reinterpret them as persistence status or completed acceptance.

The endpoint uses bounded native projections, not models or get-or-create helpers. It performs no initialization, normalization, index/collection creation, majority-write probe, reconciliation, market-clock request, snapshot update, worker start, or external broker/data/SMTP request. Startup's existing writes remain distinct. Every request refreshes identity/settings and checks current connection/startup state again after the reads. The result is an observation, not a lease or atomic authorization for later mutation. Existing dispatch guards remain authoritative.

| Observed condition | runtimeReady / HTTP | maintenanceReady | External acceptance |
| --- | --- | --- | --- |
| Initialized exact owner, PAPER, explicitly disabled, scheduler suppressed, valid config | true /200 | true | not_evaluated |
| Enabled owner, live mode/enablement, unsuppressed scheduler, invalid PAPER config | true /200 if runtime prerequisites hold | false | not_evaluated |
| Missing/ambiguous settings, invalid owner/session/auth configuration | false /503 after auth; existing auth may reject earlier | false | not_evaluated |
| Bootstrap pending/failed, failed required index/write, disconnect | false /503 after auth; existing auth may reject earlier | false | not_evaluated |
| Correct controls, but external/deployed evidence absent | true /200 if runtime prerequisites hold | true | not_evaluated; final release remains unverified |

## Consumer transition and staged release criteria

The executable local process/browser harness now requires v2 plus both named readiness booleans. Frontend source has no readiness/releaseReady consumer. Historical evidence scripts/documents under `docs/evidence` are immutable historical observations, not reusable v2 acceptance gates. The old release prompt's all-purpose false-field gate is superseded only after the operator adopts an updated candidate identity and stage criteria.

1. Before activation: require contractVersion2, the owner-paper-maintenance profile, runtimeReady and maintenanceReady, plus all separate actual-data/startup checks and review.
2. After coordinated deployment: require actual normal-owner login, frontend/backend and persistence/restart acceptance, authorized external evidence and protected-state comparisons, bound to exact source, image manifests/config identities and environment. An endpoint response alone cannot produce a VERIFIED release.
3. PAPER scheduler activation/soak remains a separately authorized later milestone. Disabled automation does not constitute runtime failure.

No deployment authorization transfers from the previous source SHA/backend image to this changed candidate.

## Future read-only preflight template

`backend/scripts/read-only-release-preflight.js` exports `readProtectiveWork(db, now)`; it neither connects nor runs itself and imports no models. Use only after fresh operator authorization with the exact independently verified database. Protection lease expiry is **expiresAt**, and PositionClose lifecycle is **state**, with active work additionally counted by `active:true`. Synthetic nonempty fixtures deliberately contain misleading `lockedUntil`/`status` fields to guard against the earlier empty-collection mistake.

This is a building block, not a complete production gate. A future operator must still verify exact C1/C4 identity/settings/pauses, immutable owner binding, PAPER configuration/account, all legacy/canonical unresolved work and reservations, notification leases, all imported schema indexes/duplicates/options, zero forbidden backfills/drops, unchanged TTL policies, consistent backup including TTL effects, isolated restore/startup rehearsal, secure owner login availability, and an independently reviewed maintenance/rollback plan. No production access is performed by this development milestone. v38 rollback remains maintenance-only with actual-data guards; it must not assume unresolved newer canonical work.

## Regression evidence

The mandatory `mongo-startupReadiness.mongo` gate starts the actual production server with native-seeded duplicate users, records Mongo commands, preserves identities/indexes and a settled canonical intent, exercises normal owner login and negative cases, verifies read-only/current readiness and reconnect, tests required-index/write failures, and checks nonempty preflight predicates. The backend unit gate contains mandatory readiness truth-table/invalidation scenarios. Verifier contract tests reject omitted/skipped/duplicated/failed named evidence regardless of aggregate totals.

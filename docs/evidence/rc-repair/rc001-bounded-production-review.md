# Bounded RC-001 production review

Reviewed the in-progress safety repair on 2026-09-13, including dispatchAuthorization, the Alpaca adapter, settings and worker controls, canonical submit/cancel/replace, protective stops, and coordinated closes. This is source review, not a substitute for the required combined-candidate tests.

## Concrete additional finding passed to the parent

The reachable legacy `PUT /api/robo/settings` calls `roboTraderEngine.updateSettingsForUser`, which directly saves the shared RoboSettings document without the canonical account gate or generation increment. This leaves a control write outside the S/D serialization contract. The model pre-save hook synchronizes enabled/isEnabled, so a claim that disabling leaves isEnabled true was withdrawn after examining that hook; that literal bypass was not reproduced. The concrete concern is transaction read/write ordering and obsolete-generation revival across legacy control changes. The parent independently found the same path and is adding the asserting generation regression and canonical-writer correction.

## Other reviewed paths

The production broker adapter performs its awaited final account verification before authorize(), then checks synchronous heartbeat loss before invoking transport. The canonical D transaction writes account capacity, validates the intent/model identity and allowed state, checks current generation for automated entries, conditionally renews the authorized worker/exit lease, and records payload hash plus account, environment, record/client identity and executor. Repeated operation claims are not issued again.

Pre-claim denial carries beforeTransport and can release an unsubmitted admission. A heartbeat error after a completed D is a plain error; canonical submit retains submission uncertainty instead of declaring rejection. An ambiguous claim commit similarly leaves the original intent for reconciliation. Existing identity lookups and late transport outcomes do not automatically retry POST. This review found no second confirmed false-unsent path, but the transaction/process tests remain the decisive evidence.

Direct owner buys preserve the manual policy. Direct reducing sells obtain the account exit lock; their beforeBrokerWrite callback carries the exit lease/executor through final authorization. Coordinated close supplies the same lease to its reducing submit and cancellation. Protective create/cancel operations supply their own exit lease to the final adapter callback and retain original identities through uncertain outcomes. Owner-requested quantity/price-decreasing replacement is intentionally not conditioned on Robo enablement; emergency cancellation blocks its new claim through stopCancelRequested.

Stop status reports draining for nonterminal canonical automated buy intents and stopped only with an empty result. It does not treat a claim, an empty broker list, lease expiry, or a 404 as transmission or cancellation proof. Fully stopped describes the automated-entry dispatch drain; it does not mean positions were liquidated or protective/reconciliation operations ended.

No additional confirmed must-fix defect beyond the legacy control writer was established in this bounded review. This statement is not a release pass and does not waive incomplete infrastructure or mandatory scenarios.

## Runtime handoff notes

After safety verification, coherently pin the then-current patched Node24 release in both Dockerfiles, Actions, the verifier, local runtime pin and package engines/root lock metadata. Current official-source preparation is in runtime-research.md. The frontend has no .dockerignore: add explicit node_modules, build, test-results, .env and local-artifact exclusions before container builds so host dependencies or credentials cannot enter the build context. Keep the runtime commit separate; the parent owns the current acceptance/checkpoint/runbook updates.

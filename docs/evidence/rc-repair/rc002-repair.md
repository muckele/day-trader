# RC-002 bounded repair and evidence

Starting source: `1972254bfcfd0b6ff724876cd0d2a2b15006ac26`, branch `codex/owner-paper-mvp`. Changes are local and uncommitted at this checkpoint; RC-001 was developed concurrently in separate portions of shared lifecycle/protection files. This is targeted repair evidence, not the combined-candidate release decision. The parent verifier/runtime work remains the release authority.

The original exploratory script was converted to an asserting real-Mongo regression before changing production exposure code. On the reviewed source it failed on `brokerPosts: 2 !== 1`, with two fills, 12 shares/$120 holdings, and correctly recorded 12000 cents spending despite a $100 position cap. After the correction the same barrier produces one POST, six shares/$60, one canonical fill, a durable rejected second intent, 6000 cents spending and zero outstanding cash reservation. Both reports include actual Node executable/version, source HEAD, lifecycle source hash and persisted/provider state.

## Exposure rule

`AccountCapacity.portfolioBaseline` is reconciliation metadata: a broker quantity observation taken before the first canonical fill, together with its canonical-net reference and foreign-order observation. It is not an independently mutable holdings ledger. Current quantity is derived from that baseline plus signed deltas in the existing canonical `Fill` collection. The service checks canonical intent cumulative quantities against those fills.

Before admitting an opening, the service collects the account version, broker order history, positions, then order history again. It rejects incomplete discovery or activity during collection. The admission transaction acquires the same account write lock used by reservation, fill, and dispatch transitions and requires the collected version still to match. Mongo conflicts cause the outer caller to collect new observations rather than reuse an invalidated snapshot.

An observed quantity must equal the baseline plus canonical changes. A full or partial fill absent from positions remains represented by canonical fills and blocks new risk. Filled/canceled/expired status does not erase holdings. Known broker cumulative execution ahead of canonical ingestion also blocks, including late fill evidence on an apparently canceled order. New or changed unattributed broker orders block even when their quantity could mask a lagging app fill. Existing open foreign activity prevents initial certification. Positive current position valuation is required for positive quantities.

No overlap is added twice: after positions catch up, six $10 shares count as $60, and a four-share $10 request can use the remaining $40 headroom. `reconcile` refreshes this coverage and returns its explicit state. Position-size and symbol-count checks then use the coherent broker observation plus existing pending commitments. These are admission checks at observed prices, not a guarantee against later market appreciation.

Reducing exits do not require a coherent opening-risk observation. With an existing baseline, their available quantity is bounded by both broker availability and canonical remaining holdings, so lagging positions following a confirmed close cannot authorize an additional sale into a short. Period spending is never credited by a sale.

Protective stop executions now create idempotent cumulative sell deltas in the existing `Fill` model under the account lock. The hook records an old stop's confirmed fills before moving to a new generation, clears the obsolete snapshot, and recognizes earlier app-owned stop generations during broker-history discovery. It does not credit cash/spending and does not create another ledger.

## Conservative boundaries

- A missing baseline plus existing canonical fills is not automatically recoverable from aggregate position equality: preexisting holdings could mask unobserved historical fills. Such an imported/migrated state explicitly blocks new openings pending operator reconciliation; the repair does not guess a migration baseline or delete history. A newly established pre-fill baseline has tested automatic recovery and legitimate subsequent trading headroom.
- Two matching broker reads are not an atomic broker watermark. The code also checks canonical quantities and observed external activity, but does not claim control over a truly simultaneous unobserved external action. The dedicated account operating scope remains important. New/changed foreign activity and a 500-order discovery ceiling fail closed; an operator must resolve incomplete or unexplained state rather than rotate keys or remove history.
- Tests use controlled fixed prices and isolated providers. No external Alpaca, Robinhood, SMTP, inference, credentials, transfers, or deployment operations occurred.

## Test evidence

Actual test runtime throughout these targeted runs: Node `v24.19.0`, `/Users/Matt/.nvm/versions/node/v24.19.0/bin/node`. This is newly stamped evidence, distinct from the older unstamped exploratory probes and the historical Node20 verifier. The parent must still establish and verify the final pinned patched runtime.

| Command | Evidence | Exit / result |
|---|---|---|
| `node --test backend/integration/rc002Exposure.mongo.test.js` on unchanged exposure source | `rc002-red.log` | 1; original invariant assertion fails, two POSTs versus required one |
| Same command after first correction | `rc002-first-green.log` | 0; original invariant passes |
| Same command with full initial matrix | `rc002-matrix-first.log` | 0; 17 test nodes pass |
| Same command with protective-generation regression | `rc002-protection-red.log` | 1; obsolete protection snapshot identity failure reproduced before its correction |
| Same command with bootstrap, late-fill and stale-reduction regressions | `rc002-review-edge-red.log` | 1; all three reject assertions fail before corrections |
| `node --test backend/integration/rc002Exposure.mongo.test.js backend/integration/orderLifecycle.mongo.test.js backend/integration/orderLifecycle.faults.test.js backend/integration/phase3Financial.mongo.test.js` | `rc002-financial-matrix.log` | 0; 62/62, before three review-edge additions |
| Same four-suite command after review-edge corrections | `rc002-financial-green.log` | 0; 65/65, zero skips |
| `node --test backend/integration/rc002Exposure.mongo.test.js scripts/acceptance/rc002.process.test.cjs` | `rc002-process-matrix.log` | 0; 26/26, zero skips; current targeted suite |

The current Mongo suite has 24 named child scenarios plus its parent test node. It includes the original interleaving; four manual/Robo origin pairings; repeated full/partial visibility lag; partial cancellation/expiry; exact nonduplicated headroom; maxOpenPositions; injected transient Mongo transaction conflict plus account-version change; replacements and older observations; fill during cancellation; unattributed activity; coordinated close recovery; protective generations; malformed/incomplete observations; missing historical baseline; broker evidence ahead of ingestion; stale reducing availability; allowed owner quantity/price reduction while Robo is disabled; and emergency cancellation superseding replacement.

The separate `RC002-real-worker-lock-and-coverage` scenario uses real backend/worker processes, actual Mongo leases and the controlled provider transport. It holds the first worker at transport with IPC, establishes that a second worker is `ROBOTRADER_LOCKED`, then releases the first. It ingests the confirmed fill while positions remain empty and asserts unresolved exposure. A subsequent real worker produces no extra opening. When positions become coherent, reconciliation restores protection/coverage and an owner manual order legitimately uses remaining headroom. Worker locking is never disabled.

Every new scenario is intended for the verifier's named required-scenario gate, not a minimum aggregate count. Stable names were sent to the verifier owner. Source syntax and scoped `git diff --check` passed. Final combined verification, image/runtime/audit checks, durable commits and release status are pending the parent task.

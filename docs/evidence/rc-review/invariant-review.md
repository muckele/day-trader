# Independent RC invariant review — correction refinement

Review target: existing source at /Users/Matt/Projects/day-trader, reviewed RC HEAD 1972254. Read-only review; no production changes or new test runs during this refinement. The now-present docs/Day_Trader_Agentic_MVP_Master_Brief.md was read in full before resumed inspection. Both RC-001 and RC-002 remain release blockers. The earlier proposed one-line direction for each was necessary but not a sufficient correction specification.

## Evidence classification and executed probes

Previously executed commands (ordinary default-shell `node`, not the parent's pinned Node20 verifier):

```
node /private/tmp/rc-invariant-account-race.cjs > /private/tmp/rc-invariant-baseline.log 2>&1
node /private/tmp/rc-invariant-account-race.cjs 7 > /private/tmp/rc-invariant-stop-race.log 2>&1
node /private/tmp/rc-invariant-position-race.cjs > /private/tmp/rc-invariant-position-race.log 2>&1
```

All successful executions used approved loopback-only escalation, unique test-owned Mongo databases, dummy account credentials or an in-memory broker, and no configured notification recipient. They exited 0 and ran their finally cleanup paths. No external broker or email operation occurred. Existing scripts and logs are preserved at the paths above; do not rerun them as acceptance tests without adding executable assertions and choosing the supported runtime.

These are barrier-controlled exploratory probes, not regression passes: they print the decisive outcomes rather than assert the expected safety invariant. Exit 0 means execution/cleanup completed, not that safety passed. The first sandbox-denied baseline attempt's tool output explicitly recorded Node.js v24.19.0; its redirected log was overwritten by the successful run. The successful scripts did not stamp process.version. A subsequent read-only resolution check returned /Users/Matt/.nvm/versions/node/v24.19.0/bin/node and v24.19.0. This supports identifying these as default-Node24 exploratory probes, with no per-success-run runtime stamp; they are not Node20.20.2 regression evidence.

The account probe held the seventh /v2/account GET. Its saved baseline trace establishes this was the adapter's final account verification. Saved outcome: zero POSTs before releasing the hold; a separate emergency-stop process returned disabled settings, no canceled orders, no cancel error; releasing the hold then produced one new AAPL buy, with settings still disabled. The lease-loss mode exists in the script but was not run.

The position probe used strictRisk:true and maxPositionSize:$100. B captured an empty position snapshot and waited; A filled six shares at $10 and persisted that fill; B then consumed the old snapshot and also filled six. Output shows brokerPosts:2, heldShares:12, heldMarketValue:120, both intents filled, and correct aggregate spend of 12000 cents. Thus this is a position-risk race, not evidence that the cash ledger lost spend.

## RC-001: exact control flow and failure

1. backend/robotrader/worker.js:584-590 passes its beforeSubmit callback into canonical lifecycle.submit, preserving a decision-bound idempotency key. Compatibility RoboTradeOrder projection is written only after lifecycle returns (595-608).
2. The worker callback at 792-817 performs account/position/order/clock reads, asset read, settings read, current risk evaluation, and checks/renews the owner-scoped worker lease. Controls are read at 798, tested at 803, and another awaited lease renewal occurs at 816. There is already a smaller cross-process change window between those DB operations.
3. backend/services/orderLifecycleService.js:93 runs the callback and additional account/settings/clock/protection preparation. Line 94 commits reserved -> submitting; line 96 runs final caller callbacks; line 98 invokes broker.submitOrder.
4. backend/robotrader/alpacaBroker.js:120 subsequently awaits verifyPaperAccount, which GETs /v2/account. Line 121 checks readiness, then line 122 invokes transport. submitOrder forwards no authorization context/callback at 152-156. A stop can commit while this GET is pending, as the probe demonstrated.
5. emergencyStop at worker.js:1045-1050 persists disabled settings through settingsService.updateRoboTraderSettings. That helper (settingsService.js:207-212) reads/mutates/saves a settings document; it does not serialize with the lifecycle claim, advance a dispatch generation, or drain pending dispatches.
6. Emergency stop does load canonical robo buy intents (1078-1087), but only acts when an order appears in its one open-broker-order enumeration at 1099-1127. A canonical submitting identity absent from that broker response is not retained as stop work. The probe's stop result therefore looked clean before the later POST.
7. Both /disable (routes/robotrader.js:380-394), generic settings updates (342-353), and /emergency-stop (400-409) must participate in any new control ordering; protecting one route is insufficient. Re-enable must advance a generation too so an old proposal cannot become eligible merely because controls return to the same values.

### Why moving the callback is insufficient

Moving authorization after the account GET closes the demonstrated delay window and should be done. It does not make a Mongo check atomic with a broker network operation. Another process can disable after the check resolves, or the process can stall between a successful authorization claim and the actual HTTP send. A lease token checked only by the application cannot fence a broker that does not enforce that token. A process-local mutex, checking Date.now(), repeating the read, or a TTL lease alone does not provide that guarantee.

The correction needs an explicit ordering contract:

- **Prepared, dispatch not committed:** expensive provider reads are finished but there is no durable right to send. If stop wins here, no opening POST may be sent, the rejected identity remains durable, and its unfilled cash reservation can be released exactly once.
- **Dispatch committed, delivery unknown:** a durable one-use dispatch right committed before stop. It may already be on the wire, may reach the provider later, or the process may die before sending. Stop must list it as unresolved earlier-authorized work; it cannot describe it as definitely absent or definitely transmitted. This state must not be silently redefined as an already observed broker request.
- **Broker acknowledged/filled/cancel pending:** reconcile by stable identity; cancel only the owned opening remainder when requested; preserve fills and protection. Cancellation request/DELETE acknowledgement is not cancellation confirmation.

No implementation can honestly guarantee instantaneous revocation of an HTTP write already committed/in flight using only an ordinary Mongo transaction and an external broker API. If the product requires a response meaning no outstanding dispatch remains, that response can be emitted only after earlier dispatches are resolved, or it must return a bounded pending/reconciliation-required result. New admission can be halted promptly while this drain remains pending.

### Bounded correction design

Reuse the existing canonical lifecycle and account/control records. Do not add another order ledger or a new service platform.

A. Put the final dispatch authorization in a short **database-only** transaction after all awaited adapter preparation. It conditionally claims the canonical intent/replacement/protection operation, binds account/environment/exact terms/identity, and records policy generation plus caller authorization/lease generation. Both this claim and all relevant control changes must write the same scoped gate document so they have an actual serialization conflict; a read of settings in a snapshot transaction is insufficient by itself. Existing AccountCapacity may hold the gate/version metadata, with settings changed atomically through the same helper. Keep worker telemetry independent of controls.

B. Worker ownership must be conditionally validated/renewed in that claim with the owner and unexpired lease predicates. A lease lost before the claim grants zero authority. A prior committed dispatch does not become safe to duplicate merely because the lease expires. A replacement worker reconciles that identity and never acquires a second send permission for it.

C. Stop first closes the applicable opening gate and advances its generation atomically. It invalidates unclaimed old-generation work and durably marks earlier committed affected intents for the requested cancellation/reconciliation behavior, even when absent from the broker list. Later re-enable cannot revive stale-generation work. Ordinary Robo disable applies to automated openings; do not silently change its policy to forbid explicitly authorized manual reducing exits. If a separate all-entry account halt is desired, name and implement that scope explicitly.

D. Dispatch the external write once, outside transaction callbacks and after commit. A transaction retry/unknown commit outcome must never rerun a POST/PATCH/DELETE. If commit authority is uncertain, reconcile canonical state rather than send. Adapter-reported definitive pre-dispatch denial may safely reject/release; generic timeout, process death, network failure, or ambiguous dispatch state must preserve uncertainty and reservation. Do not classify them using HTTP status alone.

E. Surface stop as separate facts: new automated admission blocked; prior committed dispatch identities; cancellation requested/confirmed; unresolved identities; retained filled exposure/protection. The existing open-order query is discovery evidence, not proof that a pending client identity never existed. A 404 or one empty list cannot discharge a committed ambiguous dispatch.

### Callers and protection/close implications

- Manual/research/trade-plan submitAlpacaEntry (services/alpacaExecutionService.js:2-5) calls the same lifecycle without a Robo beforeSubmit callback. The final gate must be mandatory in the canonical boundary, with an explicit operation type, not an optional worker convention. Preserve their intended authorization scope; disabled Robo does not automatically revoke manual activity.
- Entry replacement at lifecycle:149-160 performs a separate settings/clock check and calls broker.replaceOrder without the worker callback. It needs the same operation identity and ordering decision, including how reduction-only replacement competes with a stop's cancellation. Do not let a replacement escape merely because it is a PATCH.
- Protective stop reconciliation persists a generation at orderProtectionService.js:111-115, asserts an account exit lease at 116, then calls submitOrder at 118. Its assertLease itself reads account then DB (65-68), and the adapter again awaits /account after it. This is a source-confirmed analogous lease-check placement gap, not a separately executed reproduction.
- Coordinated close holds the exit lease (positionCloseService.js:23), cancels only linked stops after lease checks (60), requires terminal broker evidence (61-64), and passes lease callbacks for its canonical sell (71). Ordinary sells also pass the account-exit lock via lifecycle.submit. Their pre-write lease check must bind the actual operation and final dispatch claim, rather than treating a stale lease as lifetime authority.
- Do not make Robo isEnabled a universal broker-write gate: cancel/reconcile/protect/authorized reducing close must continue while openings are halted. Keep required DB readiness, designated account, exact paper endpoint and reducing-quantity checks for those operations.
- An unresolved previously claimed protective sell or close retains its quantity reservation across lease turnover. A new owner cannot submit overlapping protection/close merely because the old process's TTL elapsed. Use the existing protection/close record and stable identity to recover it.

## RC-002: exact failure and correction limits

lifecycle:83 reads positions outside admission. Line 88 combines that snapshot with nonterminal pending intents and reservedCents; filled/canceled/expired/rejected states are excluded. Fill ingestion under the account lock at 105-126 moves cash reservation to spend and sets terminal state. Therefore a fill that commits after the position snapshot but before admission can disappear from both risk inputs. A partially filled terminal cancel has the same exposure-transfer concern. maxOpenPositions uses the same stale snapshot and terminal exclusion, so the underlying defect applies there too (the separate symbol-count variant was not executed).

Fetching positions only after acquiring the account write lock within each transaction attempt closes the demonstrated local snapshot race when the provider reflects fills promptly. It is not enough for provider visibility lag: getOrder can report a fill before /positions reports the holding. HTTP response freshness, a recent local request time, two matching position responses, or terminal order status does not prove cross-endpoint snapshot coherence. A late broker response can also outlive a transaction conflict/retry.

### Conservative correction without a second ledger

Use two stages so safe blocking does not depend on inventing a broker guarantee.

1. Serialize admission and exposure transitions using the existing account gate/version. A risk snapshot must carry its account/environment, collection interval, and the canonical exposure version it covers. A stale version cannot be reused after a transaction conflict or fill transition. One implementation may collect provider reads under the account write lock per attempt; another may collect outside and conditionally claim the observed version, retrying the *outer snapshot collection* when invalid. The latter avoids long network waits in Mongo transactions. In either case there are no external writes in retryable database callbacks.
2. Never retire filled position exposure simply because the cash reservation was spent or the order became terminal. Derive outstanding exposure from canonical OrderIntent/BrokerOrder/Fill data, including filled portions of terminal intents, until an explicit coherent portfolio snapshot covers those fills or verified reducing fills offset them. Store only reconciliation coverage/version/provenance metadata in existing records; cash/spend and fill accounting remain authoritative in their existing models.
3. **Smallest fail-closed release correction:** a new fill/ambiguous coverage transition marks the relevant portfolio risk context unresolved in the same database transaction. Block new openings requiring that context until reconciliation establishes coverage. Keep reconciliation, protection, cancellation, and authorized reducing exits running. Unknown per-symbol coverage must also prevent an incorrect free maxOpenPositions slot. Do not clear the barrier merely after a delay or a single subsequent /positions GET.
4. A sustainable nonblocking calculation uses a certified portfolio snapshot plus uniquely identified canonical signed fill deltas not covered by it, and remaining opening commitments. For a symbol: snapshot quantity + uncovered confirmed buys - uncovered verified reducing sells; separately include unfilled order quantity/ceiling. Revalue held quantity with fresh validated market risk prices; historical fill cost or a low new limit is not a replacement for current position value. Replacement chains represent one logical cumulative fill stream, not two unrelated holdings.
5. Advancing a snapshot's coverage must atomically transfer each covered fill from delta contribution into the snapshot contribution, under the same account version guard. Each unit contributes once. Never add the full observed position and all historical buys; never simply take max(observed qty, local buy qty) without a coherent baseline and complete external-activity knowledge. Both can mishandle overlaps or untracked activity.
6. Snapshot coverage is an evidence requirement, not a timestamp guess. Reconciliation must relate the account's positions and complete relevant execution/order history to its prior certified baseline and canonical deltas, including external manual broker activity, corporate actions or other adjustments. If the current broker capabilities cannot establish that relation, retain the opening block and require operator reconciliation. The read-only review did not verify any broker-provided atomic snapshot watermark; do not claim one exists.
7. Stop-order sells currently live in OrderProtection broker snapshots rather than ordinary lifecycle Fill ingestion. A correction must not subtract a planned stop, a submitted close, or a projected fill. For automatic exposure release, reconcile these actual reducing executions into the existing canonical execution representation (or keep coverage unresolved until their broker evidence is coherently incorporated). That is extending current accounting coverage, not authorizing a parallel holdings ledger.
8. Cash reservation release on confirmed terminal cancellation still releases only the unfilled remainder. Confirmed holdings remain risk exposure. Admission-rejected identities, uncertain submissions and old-period cash holds keep their existing semantics.

The bounded first implementation can choose the conservative coverage barrier and defer clever overlap merging. A read-under-lock patch with no delayed-position test is not enough to close RC-002.

## Mandatory regression assertions (future implementation; not executed here)

Future correction tests target a pinned patched Node24 runtime and an actual isolated Mongo replica set. Node20 is only for preserving/reproducing the historical verifier baseline; it is not the supported target. Assert outcomes explicitly. Record actual provider calls and canonical state, not only route status or a green worker return.

### RC-001 ordering matrix

- Preserve the exact held final /account reproduction: finish disable and separately emergency-stop before release. Assert zero opening POSTs when no dispatch claim committed, a durable no-submit outcome, and one release of its reservation.
- Repeat at every awaited preparation boundary and with lease ownership change, expiry, heartbeat failure, and database loss before final claim. Do not call an asset barrier a final transport barrier.
- Add a barrier after final claim but before transport invocation. Stop must report that canonical identity as dispatch-committed/delivery-unknown; never assert an impossible guaranteed zero POST in this ordering. Resolve or leave it explicitly pending before claiming drain completion. If the still-live worker proves it aborted before transport, assert the conditional no-send transition and single release.
- Hold an actually sent POST's response, run stop, then reveal acceptance/fill. Assert one POST, original stable identity, retained uncertainty until recovered, owned remainder cancellation if requested, and protective management for fills.
- Test process death before claim, after claim/before send, after provider acceptance/before persistence, and transaction callback retry/unknown commit response. Assert no callback-triggered broker write, no restart resend, no stale-generation revival after disable/re-enable.
- Verify all control writers: generic settings update, disable, emergency-stop, enable; simultaneous stop/claim commits serialize in both orders. Include two real worker processes and stale lease owners.
- Exercise manual/manual, manual/Robo (both timing orders), and Robo/Robo at the shared gate. Robo disable stops applicable automated openings while preserving explicitly authorized manual and reducing-operation policy; an all-entry halt, if offered, must block both. Assert no unrelated account/symbol/broker order cancellation.
- Repeat final account/lease boundary tests for reduction-only replacement, protective stop POST/cancel, and coordinated-close POST/cancel. While new openings are disabled, reducing recovery remains available. Lease takeover must not create overlapping stop/close orders or release unresolved reserved quantity.

### RC-002 exposure matrix

- Convert the saved $100/$60+$60 probe into assertions. Test manual/manual, manual/Robo in both snapshot/fill roles, and Robo/Robo canonical admissions. Real Robo/Robo workers may be rejected earlier by worker lease; independently test canonical admission so that early serialization does not mask the risk invariant.
- For each origin pairing, test a different-symbol limit of maxOpenPositions=1: the first filled symbol must still occupy a slot while the position endpoint lags.
- Test old snapshot captured before the other admission, snapshot captured after broker fill but before local ingestion, after local terminal fill but with broker positions still stale, and release of a delayed position response after a transaction retry. Assert the second request is refused or waits with no POST; never a transient exposure gap.
- Test partial fill followed by cancellation/expiry/rejection of the remainder, duplicate/out-of-order updates, accepted replacement with cumulative fills, old/successor responses in both orders, and fill during cancellation. Assert filled holding coverage persists exactly once, unfilled exposure remains conservatively bounded, and only genuinely unfilled cash is released.
- Positive anti-double-count case: once snapshot coverage is established, six shares at $10 count as $60, not $120. A further four at $10 can meet a $100 bound; five cannot. Repeat after coverage advancement, restart and concurrent reconciliation/admission. Dollar checks need valid market context; use controlled fixed prices in the fixture.
- Sell/close/protective execution cases: planned/submitted/uncertain exits do not free held exposure; only verified reducing fills plus coherent coverage do. Confirmed flat frees the symbol once. Unrelated manual broker activity or incomplete history creates a reconciliation block rather than apparent free capacity.
- Transaction retries, DB disconnects, stale/missing/malformed snapshots and quote data must preserve exposure or block. Assert no external writes occur within a retried callback and no duplicate Fill/spend/reservation event is created.

No full-suite rerun, new infrastructure, production code edits, activation, deployment, live route, or external acceptance was performed in this refinement. Implementation and regression closure remain outstanding.

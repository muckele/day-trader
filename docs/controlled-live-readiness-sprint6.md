# Controlled Live Readiness — Sprint 6

## Outcome

Sprint 6 adds continuous human-supervision enforcement and a durable, tamper-evident evidence package around the Sprint 5 single-use canary. It does not configure live credentials, enable the deployment flag, activate a canary, authorize an order, deploy code, or place a trade.

## Explicit supervisor heartbeat

Activation starts a five-minute supervision window. A present operator must refresh it with the exact confirmation:

```text
I am actively supervising this canary.
```

Each accepted heartbeat records its time, a browser-session identifier, and a new five-minute deadline. A heartbeat cannot revive an activation after either its supervision deadline or activation expiry. The final broker-boundary claim also requires the supervision deadline to remain current, closing the race between the initial guard lookup and the atomic single-attempt claim.

```http
POST /api/robotrader/live-activation/heartbeat
Content-Type: application/json

{
  "confirmation": "I am actively supervising this canary.",
  "sessionId": "operator-session-id"
}
```

The heartbeat is deliberately explicit rather than an invisible page timer. An unattended open browser tab is not evidence of active supervision.

## Independent watchdog

The backend scheduler evaluates the watchdog on every database-ready tick, independently of candidate generation and order eligibility. Reading controlled-live status and entering the final live-submission guard also run the same enforcement.

When the activation expires or the heartbeat deadline is absent or elapsed, the watchdog atomically:

- revokes the controlled-live activation;
- moves its lifecycle to `failed` with `supervision_lost` or `activation_expired` outcome evidence;
- disables both RoboTrader enabled flags;
- increments `controlGeneration`, invalidating any in-flight submission that has not reached the broker boundary;
- records an audit event; and
- raises a critical `controlled_live` operational alert.

The watchdog does not claim that it can reverse a fill already accepted by the broker. The operator must reconcile broker state and use Emergency Stop with locally owned order cancellation when appropriate.

## Canary evidence dossier

After a terminal canary is reconciled and its post-canary review is recorded, an operator may seal the evidence with:

```text
Seal this canary evidence dossier.
```

The canonical dossier contains bounded, chronologically linked evidence for:

- approval, readiness fingerprint, limits, allowlist, supervision, lifecycle, outcome, and review;
- the exact order and its reconciliation state;
- broker-linked protective child orders for newly sealed schema-v2 dossiers;
- the canonical order intent and fingerprint;
- the originating decision;
- the linked portfolio exposure snapshot;
- operational alerts from the canary window; and
- activation-linked audit events from the canary window.

Dates, Mongo object identifiers, object keys, and binary values are normalized before hashing. Volatile seal fields are excluded so writing the seal cannot change its own digest. The server computes SHA-256 over the canonical JSON, stores the exact sealed snapshot on the current activation, and writes an append-only `RoboCanaryDossier` archive keyed by a new per-canary identifier. A later approval can reset the current activation without erasing an earlier dossier. Sprint 7 emits schema-v2 dossiers with protective-order evidence; already-sealed schema-v1 dossiers retain their original reconstruction contract and hash.

Sealing is single-use. The API will not overwrite an existing seal.

```http
GET  /api/robotrader/live-activation/dossier
POST /api/robotrader/live-activation/dossier/seal
GET  /api/robotrader/live-activation/dossiers
GET  /api/robotrader/live-activation/dossiers/:canaryId
```

The current-dossier response exposes the rebuilt hash, sealed hash, sealed snapshot, and `matchesSealedHash`. The append-only endpoints retain prior sealed canaries even after a later approval starts a new lifecycle.

## Operator sequence

1. Complete the Sprint 3 readiness gates and resolve all critical alerts.
2. Approve and activate the Sprint 4–5 canary while actively present.
3. Refresh the heartbeat before its displayed five-minute deadline throughout the active period.
4. If supervision may be interrupted, revoke immediately and run Emergency Stop; do not rely on the remaining heartbeat time.
5. Treat any supervision-loss alert as an incident. Inspect the broker directly, reconcile all locally owned orders and positions, and verify protective orders.
6. Record the Sprint 5 post-canary review only after broker, position, exposure, and protection evidence agree.
7. Seal the evidence dossier and retain its hash with the operational change record.
8. Retrieve the sealed archive and independently recompute SHA-256 over its canonical snapshot when external verification is required.
9. Keep live automation disabled until a separate go/no-go decision explicitly authorizes another readiness-bound canary.

## Remaining human responsibility

Sprint 6 proves that software gates, supervision state, and recorded evidence agree. It does not determine that a strategy is profitable, that financial risk is acceptable, that a broker fill is correct, or that another real-money attempt should be approved. Those decisions remain human-controlled.

Quantity-domain decision before implementation (candidate a25d0b48):

| Operation/field | Persisted/runtime today | Fractional observation reaches it | Whole input retained | Planned change |
|---|---|---|---|---|
| manual/Robo buy normalization | Number / Number | requests only | yes | distinct whole-request parser; preserve public submit policy |
| OrderIntent qty, filledQty | Number / Number | fill and reducing request | opening qty only | schema quantity union: legacy safe whole Number, normalized fractional decimal string |
| BrokerOrder qty, filledQty | Number / Number | yes | no | same exact schema quantity |
| Fill qty, cumulativeQty | Number / Number | yes | no | same canonical quantity; retain existing unique index, whole identity remains Number, fractional identity normalized String |
| PositionClose qty/requestedQty | Number / Number | owned/reducing | no | exact quantity plus explicit close authority, asset and ownership checks |
| cumulative execution money | integer cents / BigInt price times integer qty | yes | no | BigInt nanoshare times decimal price; cumulative half-up cents, delta of rounded totals |
| exposure net/baseline/coverage | Mixed object of Numbers | yes | no | BigInt arithmetic, canonical signed net serialization; exact comparisons |
| broker positions/available qty | raw decimal String converted Number | yes | no | exact parse; preserve original observations, no ledger fabrication |
| account capacity/spending buckets | integer cents | indirect | unchanged | keep integer-cent locks/reservations and conservative coverage barrier |
| cancel/reconcile | integer-assuming canonical ingest | yes | no | ingest exact cumulative data before release; no extra broker operation |
| replacement | whole-request normalized values | partial fills | yes | exact comparison with observed fill; fractional reducing replacement prohibited |
| managed protection | Number min/subtraction, GTC stops | yes | no new fractional stops | exact observed math; fail closed for fractional stop quantity under existing GTC policy; preserve observed protective fills |
| RC-001 final claims | identity/payload hash/control generation | serialized qty | unchanged | same S/D/T and callbacks; no broker write in transactions |
| adapter builder | Number.toString qty | reducing | general capability separate | exact quantity serialization for equity; keep other asset behavior |
| API/browser | observed numeric qty | yes | yes for opening | legacy whole outputs remain Number; exact fractional quantities String; frontend input unchanged |
| Fill index cumulativeQty | unique account+brokerID+Number | yes | n/a | no index replacement/addition: integer normalizations stay numeric, all fractions have canonical string key; transaction lock remains authoritative |

Representation: BigInt units of 1e-9 shares for arithmetic; normalized decimal strings for fractional persistence/wire values, legacy safe integer Numbers for whole-share persistence/API compatibility. Centralized schema setter rejects malformed/negative/overprecision values. Existing whole records read without backfill; no historical data mutation. Mixed schema fields are constrained by canonical setter/validator. No dependency.

Official Alpaca documentation verified 2026-09-14:
- https://docs.alpaca.markets/us/docs/fractional-trading : up to 9 decimals, fractionable asset requirement, no fractional short sells, pending cancellation. Page has broad order-type wording plus narrower legacy notes; implementation selects their common supported subset: market/DAY, long reducing, regular hours only.
- https://docs.alpaca.markets/us/reference/postorder : order request/response contract.
- https://docs.alpaca.markets/us/docs/websocket-streaming : partial_fill and fill event semantics, event qty differs from cumulative order filled qty.
- https://docs.alpaca.markets/us/docs/orders-at-alpaca : limit increments (2 decimals >=$1, 4 below); acceptance remains in existing cent-only supported domain.

Ordered execution: failing domain and canonical Mongo specifications -> exact utility/accounting -> exact exposure -> restricted close/serialization/protection -> targeted whole/fractional regressions -> guarded harness -> mandatory verifier names and full verifier -> image rebuild/container/scout -> secret scan/local candidate commit. No real broker or operational DB writes.

# Bounded owner and broker safety review

Reviewed the uncommitted patch on `codex/owner-paper-mvp`, HEAD `4b3425153b7f3dc3816246cf5d5da7e41d42670e`, in `/Users/Matt/Projects/day-trader`. This is a code review of the owner/broker work and its immediate integration boundaries, not approval of the complete MVP. Read `owner-report.md`, `broker-report.md`, and `docs/mvp-request.txt`. No external requests, database writes, broker calls, or test reruns were performed.

## Findings

1. **[P1] Recheck readiness after the awaited account lookup.** `backend/robotrader/alpacaBroker.js:119` and `backend/services/alpacaTradingClient.js:223` assert readiness before `verifyPaperAccount`, which awaits a broker GET. If MongoDB disconnects or shutdown invalidates readiness during that request, the subsequent broker write still proceeds. Assert readiness again immediately after account verification and before the write transport call.

2. **[P2] Automatic MongoDB recovery does not restore readiness.** `backend/server.js:190` invalidates readiness on disconnect, but `connectMongo` returns early at line 110 when the driver has already reconnected. No connected/reconnected callback reruns the index/write bootstrap. A temporary network outage can therefore block all writes until process restart. Re-bootstrap safely after reconnection; retain the generation guard against stale completion.

3. **[P2] Notification recovery never advances beyond the newest 200 orders.** `backend/services/roboNotificationService.js:68` repeatedly sweeps only the newest 200 records. Reconciliation has no event enqueue hook. If more than 200 records changed while notifications were unavailable, older events are never reconsidered and their fill/rejection emails can be permanently lost. Add durable pagination/cursor recovery or an equivalent complete traversal, alongside lifecycle enqueue hooks.

The initial legacy run-once finding is **resolved in the follow-up code snapshot**: all three aliases now return 410, and the legacy settings endpoint rejects enabling the old engine. No implementation was changed by the reviewer.

No additional concrete defect was found in the bounded owner authentication or broker transport changes inspected.

## Reviewed properties

- Central `/api` authentication precedes all API route mounts apart from login and universally disabled registration. Existing non-owner IDs cannot pass owner middleware. Authentication fails closed on missing binding/secret, disconnected MongoDB, missing user, query failure, or session generation mismatch.
- Owner login queries the explicit configured ID and username, checks the stored password hash, and signs expiring HS256 sessions. Logout persists a generation increment before reporting revocation; persistence failure returns an explicit failure.
- Bootstrap creates only an explicitly requested identity or verifies an explicit existing ID. It accepts credentials through stdin, requires the operator's Mongo URI, initializes user indexes, and does not elect an owner through public signup or silently overwrite runtime binding.
- Both broker write implementations validate the parsed HTTPS paper origin, disable redirects, capture their configuration, and read the account with the same credentials immediately before each write. Account identity must exactly match the explicit expected paper ID. Canonical submit, cancel, cancel-all, replacement, and position-close paths share this check. The legacy direct Axios submission was replaced with the guarded submission helper.
- Configuration hard-disables live and excluded advanced product flags. Persisted feature flags cannot override those release restrictions. The trade policy rejects foreign/live Alpaca origins even with a supplied live-enabled flag.

## Limits

The follow-up review inspected `executionReadiness.js`, its server and broker wiring, `NotificationOutbox`, `roboNotificationService`, SMTP changes, and the legacy route disable. The root is continuing integration work; findings above describe that reviewed snapshot and may subsequently be resolved. No test results are claimed by this review.

The readiness service uses a generation check to prevent a stale bootstrap from restoring readiness after invalidation. The outbox uses an atomic claim, unique event identity, lease ownership, bounded retry count, explicit SMTP acceptance, and redacted delivery failures. SMTP acceptance is correctly distinguished from receipt. There is still no separate notification event for a protection discrepancy or an unresolved-submission change when the order status remains unchanged; the event key includes only lifecycle phase. This remains part of the broader notification contract gap, alongside the concrete recovery finding above.

Existing evidence reports mocked boundary tests; this review did not establish real Mongo atomicity, full HTTP/browser integration, broker connectivity, or operator configuration. Instrument-policy completeness, all order lifecycle/risk controls, notifications, and the full MVP acceptance checklist remain outside this bounded review. No live execution was enabled or attempted.

## Scoped re-review disposition

All three follow-up findings were reviewed again after fixes and marked ADDRESSED by the reviewer: both adapters recheck readiness immediately after account lookup; automatic MongoDB reconnection reruns the readiness bootstrap; the notification sweep persists a cursor and reconciliation directly enqueues updates. Unresolved-submission reconciliation states now produce separate notification identities. Saved regressions: readiness-race-green.log and review-fixes-green.log. No new blocker was found in those fixes. Complete protection-failure event production remains unverified.

Subsequent real Mongo integration evidence (mongo-integration.log) covers owner HTTP auth/revocation, unique outbox concurrency, retry recovery across reconnect, and competing-worker/lease renewal. These tests do not establish full order reservation or broker lifecycle acceptance.

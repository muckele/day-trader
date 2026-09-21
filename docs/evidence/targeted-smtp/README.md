# Targeted SMTP acceptance support

Starting SHA: `15a85b1409db1509ddd068a30944015c2468a2cc`.
This bounded change adds only notification capability, controlled tests, verifier
registration and runbook documentation. Real SMTP configuration and receipt
acceptance remain separate. No operational Mongo access, real SMTP send, real
Alpaca request, push or deployment is part of this implementation.

## Test-first evidence

Before production edits, the corrected RED run had 44 entries: 25 pass, 19 fail,
zero skips. Seventeen new service scenarios failed because enqueueNotification or
deliverById did not exist; their parent and the missing verifier registration
also failed. The existing deliverNext and notification tick regressions passed.
An earlier RED invocation also exposed an invalid synthetic owner ID; the fixture
was corrected before the recorded production RED baseline.

Inspection of the installed Nodemailer SMTP connection implementation showed
that CONN labels socket close/error/timeout after DATA too. A second RED scenario
proved the initial classifier incorrectly returned retryable for a simulated
post-DATA CONN timeout. The correction keeps generic CONN errors uncertain and
only treats proven DNS/pre-DATA failures or explicit negative DATA responses as
retryable. No raw upstream error text is stored.

Raw logs, image/container evidence, and scan status are retained under
`/private/tmp/day-trader-targeted-smtp/`. See verification-summary.json for the
completed local checks and image-scan results. A previous hosted
CI run cannot verify these changes or any new commit containing them.

## Implementation and boundaries

`enqueueNotification` validates only eventKey, accountId, paper environment,
subject and plain text. A unique eventKey plus setOnInsert returns one existing
record without dispatch or content overwrite. No new recipient/sender/host
parameter or public route exists. Legacy order notification formatting and
identity generation remain unchanged.

`deliverById` requires the configured single plain mailbox, host and sender. It
atomically claims the exact requested ID only, with fewer than five attempts,
eligible state/retry time, and no active lease. The lease remains 120 seconds.
Only the successful claim increments attempts. Missing configuration does not
claim or transmit. Absent, terminal, leased and ineligible targets never fall
back to the queue. Controlled simultaneous calls invoke the sender once.

The additive `delivery_uncertain` enum is the only schema change; existing
pending documents remain valid and no indexes or migrations are added. Before
possible SMTP transmission, the claimed record enters this non-auto-retry
state. Normal completion clears the lease. A crash or persistence failure can
leave its expiring lease, but lease expiry never makes this state sendable.
Both unchanged batch predicates exclude it. This prevents blind application
resend after uncertainty, not SMTP-level exactly-once delivery or guaranteed
recipient receipt. The existing ordinary batch retry policy remains unchanged.

Explicit success requires exactly one accepted configured recipient and persists
provider_accepted, providerMessageId and providerAcceptedAt. Proven failure uses
the existing backoff and maximum-attempt policy. No retry is performed within a
targeted invocation. Operator investigation is required for uncertain outcomes;
no automatic reset or acceptance worker was added.

## Safety review

The internal service accepts bounded plain content and safe metadata only.
Caller-supplied recipient/to/cc/bcc/email/from/host/html/envelope fields are
rejected. Recipient authority is ROBO_NOTIFICATION_RECIPIENT; owner profile is
never consulted. The configured production Nodemailer transport is reused.
The API does not open an HTTP endpoint or general mail relay. Test injection
uses the repository's existing internal dependency pattern and synthetic data.

Mandatory named scenarios include event-key concurrency/idempotency, historical
queue isolation, missing configuration, target absence/terminal/lease handling,
concurrent claim, provider identity persistence, DATA/CONN ambiguity, expired
lease fencing, accepted-response database failure, production transport routing,
and unchanged general dispatcher/tick behavior. Normal full backend tests and
the complete release verifier use disposable Mongo and controlled providers.

The notification model/service enter the backend runtime assembly. The previous
backend image is therefore stale. The new precommit image and every authored
runtime hash are recorded outside Git. A commit is conditional on all required
checks, including the image security scan. After commit, the image must be rebuilt
from the committed snapshot and rebound to that exact SHA before READY. No push
is authorized; hosted CI and real one-message SMTP/receipt acceptance follow only
under separate authorization.

## Completed image security gate and commit boundary

The single explicitly authorized Scout analysis completed successfully with
0 Critical, 0 High, 0 Medium, 8 Low and 0 Unknown. All eight Low matches remain
reported; no remediation or waiver was inferred. See backend-findings.md, the
complete SARIF, scan-execution.json and runtime-continuity.json. No second scan
was run. All functional source hashes still match the passing tests, so the
unchanged full suite was not rerun for this evidence update.

All precommit verification has passed. The containing focused implementation
commit is the new candidate. Its exact SHA and the post-commit reconstruction
from git archive are recorded outside Git in
`/private/tmp/day-trader-targeted-smtp/committed-candidate.json`, avoiding a
self-referential commit hash. READY additionally requires that reconstruction
and binding to finish. The previous candidate's hosted CI is not transferable.

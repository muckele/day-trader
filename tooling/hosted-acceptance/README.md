# Bounded hosted synthetic tooling pilot

This is a continuation of the pending acceptance controller, adapted for one
bounded GitHub-hosted pilot. It grants no production release clearance.
The only executable launch path is the push workflow on
`codex/hosted-acceptance-tooling`, standard `ubuntu-24.04`, 45 minutes maximum.
The operator's budget is two reviewed normal pushes and two sequential runs.
Do not use reruns, open a pull request during the pilot, or trigger other workflows.

The workflow measures actual CPU, memory, disk and Docker before builds. Its
incremental peak estimate is 12 GiB: tooling/build layers 4, application images
and layers 3, browser download/extraction 1, Mongo 1, output 0.5, reserve 2.5.
Builds are sequential. Ten-second disk samples are observations, not a guarantee
that every transient peak was captured. No persistent caches, image publication,
artifact uploads, production secrets or environments are configured.

Application reconstruction is TEST ONLY from the exact Git archive at
`852fb22d9facf4bfe0bca7f419e22ee4bfbba17f`, its existing Dockerfiles and lockfiles,
and `REACT_APP_API_URL=https://day-trader-backend.fly.dev`.
That URL is required compiled application content; runtime names map exclusively
to internal stand-ins. The runtime has no external route. Application files and
the existing release workflow are unchanged. Base digests are pinned; signed
Debian indexes remain enforced. This means package signature verification, not
an assertion that the resulting tooling image has a separately signed attestation.

`tests/qualified-content.json` contains only selected sanitized hashes and
package versions from retained qualification manifests. The pilot compares
backend authored files, Node binary, selected Debian package versions and
frontend static bytes. It prints resulting image identities. These comparisons
do not prove whole-image byte identity, full dependency equivalence, or transfer
exact-image security evidence. Material mismatch blocks qualification.

The inherited controller retains exact method/path/query policies, one-shot
private intake, fixed HTTPS destinations, CA and hostname verification, request
reservations, and phase transitions. The hosted `load()` path rejects production
profiles. Synthetic tests include the actual browser, UI login, nonempty observed
records, readiness before and after an exact backend restart, session continuity,
logout/revocation, TLS negatives, network denial and gateway failure. A failed or
unexecuted check is not a passing integration result.

Synthetic credentials, certificates, session profiles and disposable database
state exist only in runner temporary storage. Private operator input travels via
a no-echo PTY to Docker exec stdin, never command arguments or environment.
Containers use the `none` log driver. Sanitized booleans/counts/identities are the
only runtime output retained in job logs/summaries. Cleanup checks exact resource
labels and removes only recorded pilot resources and ephemeral private state.
A VM timeout also destroys the disposable hosted runner.

## Eventual controller environment (planning estimate, not launched)

After builds, a dedicated Linux amd64 Docker-compatible environment with
user-namespace Chromium sandbox support is required. The controller needs the
tooling runtime for two containers: a network-none non-root browser/TLS shim
with Xvfb, and a separate fixed-destination HTTPS gateway. It does not need the
application build stages, disposable Mongo or stand-ins for production operation.
Plan for 2 vCPU, 4 GiB RAM, and 6 GiB free disk including the conservative current
tooling image, temporary browser profile and 2 GiB reserve. Runtime image size
and peak process memory must be measured after successful qualification before
calling this a measured minimum. A smaller purpose-built runtime could reduce
storage but is outside this pilot.

The browser has only a restricted Unix socket to the gateway; no network or
Docker socket. Gateway egress is default-deny, allowing only reviewed fixed
application IPv4 destinations on TCP 443 with normal CA/hostname validation,
no DNS, no IPv6, no generic proxy and no broker/data/SMTP route. The orchestrator
alone controls the approved backend restart boundary. An operator-owned private
interactive TTY and run/container/source-bound one-use manifest are required for
real credential entry. No real credential or production controller is authorized
by this pilot. The hosted-only launcher is not a production activation handoff.

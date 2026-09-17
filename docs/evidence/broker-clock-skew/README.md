# Bounded broker clock skew — local candidate evidence

Starting SHA: `dc930cd1e63c500129f4de8c8ad930eecdd031ef`; repository `muckele/day-trader`; branch `codex/owner-paper-mvp`. This bounded correction is ready for a new local commit and separately authorized exact-SHA hosted CI. The candidate is the commit containing these verified source hashes; post-commit binding is retained at `/private/tmp/day-trader-clock-skew/postcommit-binding.json` to avoid a self-referential commit hash.

## Rule and scope

Previously acceptance rejected any broker timestamp ahead of the caller's local clock, while canonical lifecycle/execution status used an absolute 60-second difference and thus accepted much larger future skew. They now share `backend/services/brokerClock.js`: `MAX_BROKER_CLOCK_FUTURE_SKEW_MS = 1000`, `MAX_BROKER_CLOCK_AGE_MS = 60000`.

The Alpaca adapter captures request start immediately before HTTP and receipt immediately after response; existing acceptance interceptor receipt evidence is reused when within the measured request interval. A private WeakMap attaches timing without trusting payload fields. Raw age is receipt minus broker timestamp. Raw age below −1000 ms fails `FRESH_CLOCK_REQUIRED`; otherwise effective age starts at max(0, raw age), then includes time elapsed since receipt. Effective age above 60000 ms fails. Delayed validation cannot rehabilitate excessive future skew or leave a cached clock permanently fresh. Synthetic injected clocks without transport timing use the explicitly provided evaluation time.

ISO calendar validation rejects malformed/impossible timestamps. Integer nanosecond arithmetic retains the fractional remainder beyond JavaScript milliseconds: exactly 1000 ms future passes; 1000 ms plus one nanosecond fails. Equal, 1, 31, 250 and 999 ms future pass; 1001 ms and 5 seconds future fail. Past age 59999 and 60000 ms pass; 60001 ms fails.

The observed broker `2026-09-17T17:36:30.593806133Z` and receipt `2026-09-17T17:36:30.562Z` produce raw age **−31.806133 ms**, effective age **0 ms**. With OPEN and next close `2026-09-17T20:00:00Z`, freshness, openness and session time pass. No real provider was contacted to reproduce it.

Acceptance session checks, canonical admission, buy/reduction pre-submit rechecks, replacement checks, and broker execution status use the shared evaluator. Acceptance diagnostics record request start/receipt, parsed timestamp, raw/effective age and limit at initial and mutation refreshes. The final acceptance dispatch refresh and synchronous transport interceptor use the same rule. Controlled final-boundary tests permit the expected three scenario submissions at 31 ms skew; 5000 ms skew rejects with **zero POST** and released reservation. This does not change the RC-001 stop/dispatch ordering contract or claim a stronger cross-process guarantee.

Closed clocks remain closed; insufficient remaining regular session (<30 minutes) remains PARTIAL; malformed next close fails. No quote/bar rules, cancellation pricing, $250 cap, held-position fallback, risk caps, mutation budgets, fractional accounting, reduce-only cleanup, account binding, extended-hours policy, RC-001 or RC-002 admission/dispatch algorithms changed.

## Verification

[Complete verifier report](verifier-report.json): **25/25 gates, 782 passing test entries, zero failures/skips/flakes, exit 0**, Node **v24.21.0**. TAP counts include parent test entries. The result is derived from this fresh run, not a presumed count. Backend unit445, verifier22, guarded harness97, fractional24, RC-001 dispatch25, RC-001 exit10, RC-002 Mongo25, RC-002 independent process1, frontend40, browser14+8; other required gates also pass. Full logs are preserved at `/private/tmp/day-trader-clock-skew/verifier`.

Required names are individually enforced and omission-tested:

- `31ms broker future skew accepted`
- `maximum allowed future skew boundary`
- `excessive future skew rejected before transport`
- `stale clock still rejected`
- `closed market remains blocked`
- `insufficient session time remains blocked`
- `final-dispatch skew tolerance`
- `final-dispatch excessive future skew zero POST`

Red-first evidence is preserved outside the checkout: acceptance21pass/4fail, final-dispatch harness95pass/2fail (failed child plus parent), verifier21pass/1fail, and core/lifecycle red logs. Green targeted groups: core33; direct consumers85; acceptance/verifier57; harness97; independent review90. These overlap and are not added to the full total. Zero required skips or failures in final green runs. The reviewer initially omitted the pinned Node directory from PATH, and runtime provenance correctly failed two environment contracts; correcting PATH passed without source changes. This was an invocation correction, not a test flake.

[Independent review](independent-review.md) found no actionable correctness/scope issue. [Source hashes](verified-source-hashes.json) bind changed code to the tested bytes. No code was changed after the complete verifier.

## Rebuilt runtime and security

Production helper/import changes invalidate the old backend image. New immutable Linux arm64 backend:

`sha256:6b8b35dede3bc416fbc7a2fcbc3c4d1482b0ab4260268bda33c59beb38df976f`

[Build command/timestamps](build-execution.json), [inputs](build-source.json), and [exact source/image binding](source-image-binding.json) record **141 matching authored runtime files**, no mismatch, including the helper. Build used the existing digest-pinned Dockerfile and local Docker driver, without source/image upload or remote builder. Package install layers were cached; the fresh scan below assesses the resulting exact image. No package manifest, lockfile, dependency, runtime pin, Dockerfile or assembler changed.

[Runtime closure](runtime-image.tap): 1pass/0fail/0skip. [Internal-container acceptance](container-report.json): ok and cleanupComplete true. Synthetic disposable replica-set Mongo, readiness/authentication, paper environment, disabled workers, local TLS/CA, production imports, frontend routes/login and orderly shutdown passed. Startup probes initially waited for readiness, as designed; final assertions passed. Operational Mongo was not contacted. Existing frontend image `sha256:a7aa7e54a5c65283c7851987f64cfa83352d40c9f11ea4fbac502e27ba1b5c2e` was reused only after all77 frontend source hashes matched its previous manifest. Its historical scan is not represented as fresh.

Fresh Docker Scout **v1.23.1** unfiltered `local://` scan completed: **0 Critical / 0 High / 1 Medium / 8 Low / 0 Unknown**. Exit2 denotes successful analysis with findings. [Exact command, immutable target and times](scan-execution.json), [full SARIF](backend.sarif.json), [all readable findings](backend-findings.md). No severity/fix/base filters, image upload, source upload, enrollment or persistent monitoring. Only previously authorized package URL/layer digest analysis was used. The unresolved Critical/High gate passes; lower findings remain tracked. A completed scan is not evidence of absence of all vulnerabilities.

The prior supplemental **CVE-2026-85091** remains **NOT REACHABLE, VERIFIED for this exact composition**, subject to [original positive source/binary evidence](../rc-repair/image-hardening/node-zlib/) and [existing policy](../rc-repair/image-hardening/README.md). [Continuity checks](runtime-continuity.json) verify unchanged Node binary hash/components, vendor packages, native-addons list (empty), non-application exported files and dependency paths (ASLR addresses ignored). The only added copied path is the JavaScript clock helper, which introduces no native/FFI/preload bridge or gzip-file consumer. Locked dependencies/startup are unchanged. This is not a claim that embedded zlib was patched; new native/plugin/startup injection reopens the disposition. Frontend browser/build-chain audit dispositions remain separate and unchanged. No new residual-risk waiver is assumed.

## Preservation and next gate

Bounded sensitive-value/header/token scanning must pass before staging; the sanitized result is [secret-scan.json](secret-scan.json). No raw real external acceptance report is committed. Timestamp regression values are safe. Master brief remains unchanged/untracked, operational environment unchanged/ignored, and no operational owner/Mongo/configuration/credential or acceptance policy changes were performed. All test writes used synthetic disposable state, which was removed.

Zero real Alpaca Trading or market-data requests; zero external SMTP sends, paid inference, pushes, deployments or persistent activation. Registry/package reads and authorized Scout analysis are distinct from application-provider requests. The local Chromium override used the already installed headless shell; no browser download was needed.

The new candidate still requires separate operator authorization for hosted exact-SHA CI, then a separately authorized real PAPER acceptance attempt. Existing hosted evidence for the starting SHA does not verify this change. External email, deployment/routing, operational recovery/monitoring and broader roadmap gates are untouched. Stop after the local commit.

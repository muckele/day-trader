> **2026-09-13 authenticated Scout result: scans COMPLETE WITH FINDINGS; combined local RC NO-GO.** Backend65 CVEs (2Critical,14High,14Medium,31Low,4Unspecified); frontend8 (0Critical,4High,0Medium,3Low,1Unspecified). Both exact local Linuxarm64 targets exited2 with valid SARIF. Authentication is resolved; remaining blocker is findings/applicability/residual-risk disposition, not missing analysis. See `docs/evidence/rc-repair/image-scan/README.md` and `authenticated-retry/critical-high-dispositions.md`. No source/package/runtime change or rebuild; unchanged23/23 verification retained. Earlier approval/sign-in checkpoint text below is historical.

> **2026-09-13 authorized scan continuation: NO-GO — image analysis remains incomplete because Docker Scout requires sign-in.** Both verified immutable local Linuxarm64 targets were attempted with explicit user authorization and normal approval; each exited1 without SARIF. Severity counts are unknown. The earlier metadata-authorization blocker is superseded; no credentials/sign-in, upgrades or broader transfers were performed. See `docs/evidence/rc-repair/image-scan/README.md` for exact commands, identities, timestamps and results. The unchanged 23/23 source-bound verification is retained; no full suite rerun.

# Verification record — RC repairs and supported runtime

**Deterministic combined verifier: 23/23 passed, exit 0. Overall local RC: NO-GO pending authenticated image CVE analysis.** RC-001/RC-002 are repaired; the former reviewed candidate remains NO-GO. This record supersedes earlier Phase 3 GO prose without overwriting historical 19/19 reports.

Starting SHA: `1972254bfcfd0b6ff724876cd0d2a2b15006ac26`. Safety commit: `d620aab5e56fdf41a986734bdf516ec028889f15`. Branch `codex/owner-paper-mvp`, repository `muckele/day-trader`; Phase 2 ancestor `0dcc4d0dad7f47768a5613573b0a828bda0667ff` preserved. Runtime source is a separate subsequent commit; final source hashes are in `docs/evidence/rc-repair/runtime-final-source-manifest.json`.

## Final complete command

```sh
env PATH=/private/tmp/day-trader-rc-node24/node-v24.21.0-darwin-arm64/bin:/usr/local/bin:/usr/bin:/bin \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE=/Users/Matt/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell \
  /private/tmp/day-trader-rc-node24/node-v24.21.0-darwin-arm64/bin/node scripts/verify-mvp.mjs \
  --report-dir docs/evidence/rc-repair/runtime-final-verifier \
  > docs/evidence/rc-repair/runtime-final-verifier-execution.log 2>&1
```

Actual process exit **0**. Report generated **2026-09-13T16:48:50.187Z**; summed gate duration **197038 ms**. `docs/evidence/rc-repair/runtime-final-verifier/report.json` records every actual child command, process exit, summary and required scenario identity. The directory contains all logs and browser JSON. No executable source changed during this run.

Node **24.21.0**, bundled npm **11.19.0**. Host Node `/private/tmp/day-trader-rc-node24/node-v24.21.0-darwin-arm64/bin/node`; npm resolves to that distribution's `lib/node_modules/npm/bin/npm-cli.js`; the runtime gate verifies both realpaths. Host architecture darwin/arm64; Chrome **151.0.7922.34**, CLI OpenSSL **3.6.4**, Node built-in OpenSSL **3.5.8**. Test-owned Mongo **7** replica set `mvp`, loopback `27189`; only randomized test databases are created/dropped. Provider, SMTP and browser services are controlled local fixtures. Credentials/activation are scrubbed by the runner.

## Exact gate counts

| Gate | Passed test entries / result | Failed | Skipped | Flaky | Exit |
|---|---:|---:|---:|---:|---:|
| runtime | Passed | 0 | 0 | 0 | 0 |
| backend-install | Passed | 0 | 0 | 0 | 0 |
| frontend-install | Passed | 0 | 0 | 0 | 0 |
| verification-tests | 16 | 0 | 0 | 0 | 0 |
| backend-tests | 388 | 0 | 0 | 0 | 0 |
| mongo-integration | 4 | 0 | 0 | 0 | 0 |
| mongo-orderLifecycle.faults | 9 | 0 | 0 | 0 | 0 |
| mongo-orderLifecycle.mongo | 16 | 0 | 0 | 0 | 0 |
| mongo-orderProtection | 8 | 0 | 0 | 0 | 0 |
| mongo-phase3Financial.mongo | 17 | 0 | 0 | 0 | 0 |
| mongo-phase3Smtp.mongo | 4 | 0 | 0 | 0 | 0 |
| mongo-rc002Exposure.mongo | 25 | 0 | 0 | 0 | 0 |
| frontend-tests | 40 | 0 | 0 | 0 | 0 |
| frontend-build | Passed | 0 | 0 | 0 | 0 |
| mongo-nonOwnerAuthorization.fullstack | 1 | 0 | 0 | 0 | 0 |
| mongo-phase3Admission.mongo | 1 | 0 | 0 | 0 | 0 |
| provider-contract | 1 | 0 | 0 | 0 | 0 |
| process-acceptance | 9 | 0 | 0 | 0 | 0 |
| rc-dispatch | 25 | 0 | 0 | 0 | 0 |
| rc-exit-dispatch | 10 | 0 | 0 | 0 | 0 |
| rc-exposure-process | 1 | 0 | 0 | 0 | 0 |
| browser-lifecycle | 14 | 0 | 0 | 0 | 0 |
| browser-core-screens | 8 | 0 | 0 | 0 | 0 |

Mongo gates total 85 Node entries, including parent suite entries; RC-002 contributes 24 required child scenarios plus its parent (25 entries). Primary RC-001 has 25 required scenarios, exit/cancel RC-001 has 10, and the real worker exposure suite has one. Browser total is 22. Mandatory exact scenario identities are required once with successful assertions; missing, duplicate, skipped, TODO or failed identities fail even when aggregate totals remain high. Protocol tests use actual Node24 output. Positive stop-completion and exposure-headroom cases remain required, alongside previous financial assertions.

## Fail-before/pass-after and intermediate failures

`docs/evidence/rc-repair/rc001-original-red.json` and `.log` stamp unchanged candidate1972254, Node20.20.2 executable and command, exit1: all four final-account emergency/disable/takeover/expiry barriers allowed a forbidden POST. Corrected primary/exit final logs pass. `rc001-regression-notes.md` and `rc001-exit-tests.md` map the precise assertions and process ordering.

`rc002-red.log` stamps candidate lifecycle hash and Node24.19.0 executable, exit1: two six-share orders filled, 12 shares/$120 against $100, spend12000c/reserved0. `rc002-first-green.log` and final RC-002 logs show one order, six shares/$60, spend6000c and durable second rejection. The historic exploratory probes did not fully stamp their interpreter; their environment is not conflated with the separate original Node20 full verifier. `rc002-repair.md` records coverage, retry, partial/cancel/expiry, replacement, protective generations, both manual/Robo roles and real worker assertions.

Final pre-runtime safety verifier: 23/23, exit0 on Node20.20.2 (`safety-final-verifier/`), preserved historical parity only. The first full Node24 run (`runtime-verifier/`, exit1) failed closed because Node24 emitted spec output while the verifier required TAP. Underlying test successes were not counted as an acceptance pass. All TAP gates now explicitly select TAP; actual subprocess red/green protocol evidence and independent review are in `runtime-config/`. The final full run above verifies the correction without relaxing the parser.

Container fixture's initial internal-network port failure and a subsequent bridge-variable failure are retained in `runtime-containers/*-first.*`; both are fixture issues, not app defects. Final fixture exits0 and removes its containers/network. A sandbox-only Docker launch failed before creating resources, then the authorized Docker run proceeded. No failed mandatory final check was waived.

## Runtime images, audits and required blocker

Both Linux/arm64 builds exited0, using pinned Node24.21.0 and nginx1.30.4. `runtime-containers/README.md` contains exact build commands and the isolated check command. Backend image ID `sha256:125fd6abf409da48f5e8ed8b5301899dd8ded1708001300a993511293fda1186`; frontend `sha256:2caf28ef5c5a8bcd558703034a8df1cb44b4fdd519b627ad3b6be7a36938fc19`. Production backend confirms DB/index/write readiness and protected paper binding, unauthenticated401, `releaseReady:false`; nginx configuration and nine deep links pass and real browser renders Login. No Linuxamd64 execution claim. Local no-network inventory/image config checks found no .env/.env.local/.npmrc in app/static roots; these are not CVE scans.

Official Node release/checksum and nginx/image manifest evidence are in `runtime-preparation/`; exact patch claims were freshly checked. Archive hash matched official HTTPS checksums; detached GPG signature verification was not performed because GPG was unavailable. Package graphs are unchanged except root engine metadata.

Fresh authorized npm audits under Node24.21.0/npm11.19.0 completed with empty stderr: backend exit0, **0 findings**; frontend exit1, **57 findings (28high15moderate14low, zero critical)**. Exit1 is advisory output, not a network failure. Commands, interpreter paths and raw response hashes: `audit/runtime-execution.json`; reachability and remaining tooling/browser risk: `audit/disposition.md`. No forced fix or framework migration.

**Image CVE gate BLOCKED:** automatic approval review rejected Docker Scout's transfer of package URLs and layer digests to Docker's CVE service before execution. No scan ran; frontend scan withheld; no metadata/source/image uploaded and no alternate transport/scanner used. The exact record is `runtime-containers/scout-approval-block.json`. Successful build/static/readiness/version checks do not waive this required combined security gate.

## Separate acceptance states

The original candidate is NO-GO. The repaired deterministic foundation is verified locally; combined local RC remains NO-GO solely for the outstanding required image-analysis gate at this checkpoint. This is not deployed acceptance. Hosted CI, external Alpaca paper acceptance, external SMTP receipt, deployment, persistent activation and unattended operation are NOT RUN. Backup/restore, credential-revocation/recovery drills, deployment provenance, monitoring, strategy evaluation, costs/mandate and commercial evidence remain separate master-brief gates.

Original 19/19 reports `docs/evidence/verification/report.json` and `.md` remain unchanged with hashes in `historical-verifier-hashes.json`. No push, PR, deployment, external broker request, external SMTP send, paid inference, credential change or live activation occurred. See acceptance ledger, checkpoint and `docs/evidence/rc-repair/repair-decision.md` for the bounded resume point.

Runtime commit: `0aa56d7fce9c028c3216589238f5ecd3395f0705` (`chore: pin supported runtime and verify candidate images`). Final documentation/evidence follows without changing the verified executable source.

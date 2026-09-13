# Verification record — hardened runtime candidate

**Combined local RC: GO within the exact-image and configuration scope. Fresh deterministic verifier: 23/23, exit 0. Image-security gate: PASS with two verified C dispositions for retained zlib. No deployment or external acceptance is implied.**

Candidate source: `6083c66184695ee4c31b2d617414ecd24d2b1035`, branch `codex/owner-paper-mvp`. Runtime-only changes follow start `b3a6163fe3b469b69b09c8e414e6c6a28629596a`; safety commit `d620aab5e56fdf41a986734bdf516ec028889f15` and phase ancestor `0dcc4d0dad7f47768a5613573b0a828bda0667ff` remain intact. Application logic and all dependency graphs are unchanged.

## Fresh complete command

```sh
env PATH=/private/tmp/day-trader-rc-node24/node-v24.21.0-darwin-arm64/bin:/usr/local/bin:/usr/bin:/bin \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE=/Users/Matt/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell \
  /private/tmp/day-trader-rc-node24/node-v24.21.0-darwin-arm64/bin/node scripts/verify-mvp.mjs \
  --report-dir docs/evidence/rc-repair/image-hardening/verifier \
  > docs/evidence/rc-repair/image-hardening/verifier-execution.log 2>&1
```

Actual exit **0**, generated **2026-09-13T19:10:58.161Z**, summed gate time **197297ms**. Host Node24.21.0/bundled npm11.19.0 darwin/arm64; Chromium151.0.7922.34; isolated loopback Mongo7 replica set `mvp` on27189. Local provider/SMTP/browser fixtures only; test credentials and worker activation scrubbed by the verifier. Test-owned Mongo and container fixtures were removed.

| Gate | Passed entries/result | Failed | Skipped | Flaky | Exit |
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

RC-001 required primary25 and exit/cancel10 identities all passed. RC-002 has24 substantive children plus a parent Node entry, and the independent real-worker process case. Missing/duplicate/failed/skipped required scenarios remain verifier failures; the parser was not weakened.

[Full verifier](evidence/rc-repair/image-hardening/verifier/report.json), [execution](evidence/rc-repair/image-hardening/verifier-execution.json), [source manifest](evidence/rc-repair/image-hardening/source-manifest.json) and [image/source binding](evidence/rc-repair/image-hardening/source-image-binding.json) provide the commands, source hashes and scenario evidence. All individual logs/browser JSON are retained.

## Image and security checks

Both immutable Linuxarm64 builds succeeded; final backend runtime test1/1 and isolated container acceptance passed production startup, Mongo/DNS/index/write readiness, exact paper guard, unauthenticated401, local TLS, nginx config, all nine routes, actual Chromium Login and graceful shutdown. `releaseReady=false` remains truthful because external broker/deployment evidence is absent. The original backend image failed the new removal assertion as expected; assembly failures/intermediate results remain labeled historical construction evidence.

Scout1.23.1 completed unfiltered scans: backend0C/0H/1M/8L/0U (exit2, findings), frontend0/0/0/0/0 (exit0, none detected). All20 old Critical/High occurrences are removed. Supplemental CVE-2026-85091 remains in Node and frontend zlib with exact-image **C — NOT REACHABLE — VERIFIED** dispositions; not patched, not absent, and not ignored because Scout omitted it. No unresolved D/E or owner waiver is used. See the [complete image decision](evidence/rc-repair/image-hardening/README.md) and [supplemental backend](evidence/rc-repair/image-hardening/node-zlib/README.md)/[frontend](evidence/rc-repair/image-hardening/node-zlib/frontend-disposition.md) evidence.

Frontend npm57 (28High/15Moderate/14Low) and backend npm0 retain their separate [audit dispositions](evidence/rc-repair/audit/disposition.md). Image scan coverage does not clear browser/build-chain findings. No npm dependency changes occurred.

## Historical and external boundaries

The original candidate1972254 remains NO-GO; its19/19 report missed RC-001/RC-002. Prior [runtime23/23 report](evidence/rc-repair/runtime-final-verifier/report.json), [old image findings](evidence/rc-repair/image-scan/README.md), [repair analysis](evidence/rc-repair/repair-decision.md), and original phase reports remain unchanged. Their obsolete runtime/image decisions are historical, not the current status.

Hosted CI, external Alpaca PAPER, external SMTP receipt, deployed HTTPS/API routing, architecture/provenance, backup/restore, credential revocation/recovery, monitoring/soak and activation remain NOT RUN. Strategy/agentic/commercial roadmap gates remain separate. No push, deployment or persistent activation occurred.

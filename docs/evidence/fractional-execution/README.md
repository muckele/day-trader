# Fractional execution — local candidate verification

The fractional execution and guarded PAPER acceptance implementation passed local deterministic verification. This evidence supports a new local candidate for separately authorized exact-SHA hosted CI. No push, real Alpaca/market-data request, external SMTP send, deployment, workflow dispatch, credential change or activation was performed.

Starting HEAD: `a25d0b48dd18df886212ce48f95afb0695773550`, repository `muckele/day-trader`, branch `codex/owner-paper-mvp`. The approved working implementation was preserved. Finalization changed only the verifier and tests, plus this documentation. Production runtime source remained byte-for-byte unchanged from the already built image. Final immutable candidate/commit binding is recorded after the local commits in `/private/tmp/day-trader-fractional-finalization/postcommit-source-image-binding.json` and the final operator report, avoiding a self-referential commit hash in its own content.

## Verification

Complete verifier: **25/25 required and executed gates passed; 685 passing test entries; zero failures, skips or flakes; exit 0; Node v24.21.0**. TAP totals include parent entries. The fresh [report](verifier/report.json), individual logs, browser JSON, [execution timestamps/command](verifier-execution.json) and [summary](verification-summary.json) are retained. All 23 fractional Mongo identities, 7 quantity/policy unit identities, 37 guarded harness identities, 25 RC-001 dispatch identities, 10 RC-001 exit identities, and 24 RC-002 Mongo identities passed. The independent RC-002 process gate also passed. [Exact mandatory names and gate list](mandatory-scenarios.json).

| Suite | Passed test entries | Fail / skip / flake |
|---|---:|---|
| Verifier contract | 19 | 0 / 0 / 0 |
| Backend unit | 398 | 0 / 0 / 0 |
| Fractional Mongo | 24 | 0 / 0 / 0 |
| Guarded harness Mongo | 50 | 0 / 0 / 0 |
| RC-001 dispatch | 25 | 0 / 0 / 0 |
| RC-001 exit/cancel | 10 | 0 / 0 / 0 |
| RC-002 Mongo | 25 | 0 / 0 / 0 |
| RC-002 independent process | 1 | 0 / 0 / 0 |
| Process acceptance | 9 | 0 / 0 / 0 |
| Browser lifecycle/core screens | 14 + 8 | 0 / 0 / 0 |

Affected targeted groups passed before the full run: 95 entries for fractional/harness/quantity/helpers; 77 for verifier/lifecycle/protection/RC-002; then 66 for the additional real manual API route, fractional suite, verifier contract and Robo guards. These groups overlap; they are not added to the complete-verifier total. The earlier red/blocked full run remains preserved outside the checkout at `/private/tmp/day-trader-fractional-execution/full-verification`.

The previously failing registration test now passes because `mongo-fractionalExecution.mongo` is explicitly required, with real emitted scenario names enforced. New contract coverage rejects absent/failed gates, individually omitted/skipped scenarios, duplicate names and incomplete output despite inflated totals. No old RC identity or failure assertion was removed.

## Additional specifications and protections

New tests prove cumulative cents independent of intermediate observations; manual/Robo origin and reduceOnly spoof rejection; actual manual API route fractional rejection; owned 1.5 reduced exactly by 0.5; external 17.582774 baseline without fabricated Fill; concurrent equivalent cumulative fill idempotency; conflicting fractional portfolio coverage blocking new risk; and invalid/zero-crossing reduction rejection. Harness specifications add the exact $250 boundary, marketability change at final dispatch with zero POST and released reservation, and explicit loopback-only transport with a live-host rejection trap. No implementation defect was exposed by these specifications and no production patch was made during finalization.

Whole-share opening remains mandatory. Exact broker cumulative execution, partial-fill cancellation, unknown coverage blocking and acceptance-owned fractional cleanup passed. Unsupported fractional GTC protection remains explicitly unprotected; reducing replacement remains unsupported. [Safety contract](../../fractional-execution-safety.md) and [original quantity audit](quantity-audit.md).

## Image and security binding

**BACKEND IMAGE REMAINS SOURCE-VALID.** Image `sha256:f663986b263b6d2dcb4453d2c912971178639c7a65890f2b54e29c5f12d759a7`, Linux arm64, remains locally present. All 140 authored runtime files and the package/runtime construction inputs match the recorded build. New backend edits since that build are confined to two integration test files excluded from runtime assembly; verifier/docs are outside the backend runtime. No rebuild or rescan was performed during finalization. [Validity comparison](image-validity.json), [original build/source binding](source-image-binding.json), [build command](build-execution.json), [verified executable/test source hashes](verified-source-hashes.json).

The existing runtime-image and internal-container acceptance passed and are reused for this exact unchanged image: [runtime TAP](runtime-image.tap), [container report](container-report.json). Source/image binding after the commits checks the committed blobs against these exact manifests. Node binary, vendor package versions, exported non-application files and absence of native addons match the prior hardened closure. ldd load addresses are the only textual dependency-report difference.

Docker Scout **v1.23.1**, existing scan 2026-09-14T19:29:28.904466+00:00 to 19:29:40.289104+00:00: **0 Critical / 0 High / 1 Medium / 8 Low / 0 Unknown**. Exit 2 means successful unfiltered analysis with findings, not scan failure. [Full SARIF](backend.sarif.json), [readable findings](backend-findings.md), [scan command/timestamp](scan-execution.json). No Critical/High remains unresolved in that scan. The supplemental zlib reachability disposition remains conditional on the identical locked runtime/startup/native closure and absence of an FFI/native consumer; see the prior [supplemental evidence](../rc-repair/image-hardening/node-zlib/). Lower findings remain tracked under the existing unresolved Critical/High policy, with no new waiver.

Frontend image `sha256:a7aa7e54a5c65283c7851987f64cfa83352d40c9f11ea4fbac502e27ba1b5c2e` is unchanged. All 77 tracked frontend files match the prior image manifest. Its prior zero-result image scan is reused, not represented as a fresh scan. The frontend browser/build-chain dependency-audit dispositions remain separate. No package manifest, lockfile, dependency, runtime pin, Dockerfile or runtime assembler changed.

## Scope and operational preservation

The accumulated source diff is classified in [changed-source-inventory.json](changed-source-inventory.json); all additional files in this directory and the safety contract are documentation/evidence. Two coherent commits group production fractional execution with its tests, then guarded acceptance with verifier enforcement and documentation; no synthetic red-only history was fabricated. The bounded sensitive-value/token scan is recorded outside the checkout before staging, with post-commit hash comparison.

[Read-only operational comparison](operational-preservation.json): all 40 real local collections, 1,336 documents and 226 indexes unchanged; ignored environment unchanged; original master brief unchanged and untracked. No persistent normalization, backfill or readiness write was performed. Disposable synthetic test infrastructure is removed after verification, and default browser artifacts are retained outside the checkout.

Exact-SHA hosted CI remains required after separate push authorization. Real PAPER acceptance must wait for that hosted result and separate explicit broker authorization. External email receipt, deployed HTTPS/API routing, recovery/backup, monitoring/soak, rollout/rollback, activation and broader agentic-roadmap gates remain outstanding. A verified local candidate is not a deployed MVP.

Committed readable Scout output and the frontend-build log have trailing whitespace/extra EOF blank lines normalized to satisfy `git diff --check`. Original raw captures remain unchanged in the external implementation/finalization evidence directories. SARIF and reported results are unchanged.

# Hardened runtime candidate — 2026-09-13

**Decision: GO for the combined local owner-only paper release candidate, within the exact-image scope below. Image-security gate: PASS. This is not deployed MVP acceptance.**

Starting SHA: `b3a6163fe3b469b69b09c8e414e6c6a28629596a`. Candidate executable/configuration SHA: `6083c66184695ee4c31b2d617414ecd24d2b1035`. Backend commit: `8b1a7fa` (`chore: harden backend production runtime image`); frontend commit: `6083c66` (`chore: refresh frontend production runtime image`). The following documentation-only commit records the final evidence; resolve its SHA with git rather than a self-referential hash. Repository and branch remain `muckele/day-trader`, `codex/owner-paper-mvp`.

Only Dockerfiles, the backend runtime assembly helper and image acceptance test changed executable/configuration content. Application logic, dependency graphs, RC-001/RC-002, identity/lifecycle/ledger and master brief are unchanged. The brief remains untracked with SHA-256 `6a757eee886ad3281ad003488ccea6d5e69498633160b4ce971216f9c6f14c83`. Historical raw scans, container acceptance and deterministic reports remain unchanged.

## Exact images and provenance

Both images are Linux arm64. No registry image was substituted and neither image was pushed.

- backend: `sha256:7f640e73b61a18bb2ef2914dbef374ed89528aebe3a81e9fe9567f161a9a6019`; created `2026-09-13T19:05:03.991864055Z`; 182,486,583 bytes.
- frontend: `sha256:a7aa7e54a5c65283c7851987f64cfa83352d40c9f11ea4fbac502e27ba1b5c2e`; created `2026-09-13T18:54:32.195344221Z`; 23,964,980 bytes.

Official Node installation/build base: `node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`; resolved arm64 manifest `sha256:8d1405ad7696efa6941cb7745c2aa51d02549b900e4a40fdf212a1b5115dd1b9`. Backend final `scratch` is an application-maintained Debian-derived filesystem, not a vendor-certified complete distribution image. It retains the official Node binary (SHA-256 `0f8949d1028f6d61506b2d5bc57e7e6fe893d7b1997509b7847294fc9c616584`) and vendor-built shared runtime libraries.

Frontend final base: `nginx:1.30.4-alpine3.24-slim@sha256:77da26c31397bf6694b4bf93275f5b40b0b120ba1b8f114264b603e592c561d6`; arm64 manifest `sha256:65378e880e8603fcd86ff252bff7012b58bd572f5ef86622c3b643b43d013d7c`. nginx reports 1.30.4; binary package 1.30.4-r1.

[Provenance](provenance.json) records exact build commands, successful exit codes, source/hash binding, digests, creation timestamps, layers and sizes. Builds occurred before the two implementation commits using their exact bytes; [source manifest](source-manifest.json) and [source/image binding](source-image-binding.json) verify the committed inputs and 139 backend/40 frontend authored source files. Host/Docker asset chunk names are not claimed byte-identical across build environments. Immutable image layer hashes bind the actual assets.

## Composition and maintenance

Backend: production dependencies and authored runtime modules, Node24.21.0, glibc2.36-9+deb12u14, libgcc/libstdc++12.2.0-14+deb12u1, CA20250419~deb12u1, tzdata2026b-0+deb12u1, DNS/NSS/gconv, timezone/identity configuration, licenses and truthful per-file package provenance. Node embeds OpenSSL3.5.8 and ICU timezone2026c. Runs as UID/GID1000 with direct Node PID1. No native addons or ELF files under the exported application; future additions fail assembly pending closure review.

Removed from backend final layers: npm/npx/corepack/yarn and their bundled brace-expansion/tar/ip-address; Perl; util-linux; OS PCRE2 and libz; apt/dpkg executables; shells/compilers; application test/integration/build/deployment files. Production npm dependency distributions remain intact, including vendor documentation and source. No package-graph editing, copied CPAN patches, custom compilation or musl migration occurred.

Official Debian security updates run before assembly. PCRE2 upgraded 10.42-1 → 10.42-1+deb12u1 in the install stage, verified against DLA-4772-1, then omitted from final runtime. CA packages were added to supply the retained trust store. Perl/OS zlib/util-linux have no claimed Bookworm correction; removal closes their final-image findings. Actual apt log is in backend-build-first.log; later builds reuse that same freshly prepared stage. For future security refreshes invalidate the install-stage cache (for example build with --no-cache), review current vendor data, record resulting packages, rerun image/container/full acceptance and rescan. Pinned base + floating signed security repository is a repeatable construction recipe, not a claim of future byte-for-byte reproducibility.

Frontend: official stable slim nginx core, required vendor libraries/CA/tz/envsubst and static assets/configuration. Omits optional module chains, libuuid/util-linux, libxml2 and nghttp2 from the previous final image; Node/npm never enter the final stage. Vendor BusyBox/apk/scanelf/nginx-debug remain inherited; no extra debugger/package manager was installed. Existing source maps are shipped by the unchanged CRA build, contain public authored/vendor source and passed the bounded layer secret inspection; hiding source is not a security boundary.

[Vendor records](debian-vendor/README.md), [frontend preparation](frontend-preparation/README.md), [backend per-file provenance](backend-runtime-provenance.json), both layer-files inventories, inspect/history records and [layer inspection](layer-inspection.json) preserve the evidence. No .env, registry credentials, SSH files or application keys found. Four marker hits are dotenv placeholder examples and MongoDB PEM-formatting code, not keys. This is a bounded inspection, not an exhaustive encoded-secret audit.

## Scanner result and release policy

Docker Scout **v1.23.1**, go1.26.3 darwin/arm64; newer v1.24.0 was advertised but no unrequested scanner upgrade was performed. Exact commands use `docker scout cves local://sha256:<verified-id> --platform linux/arm64 --exit-code --locations --format sarif --output <file>`. No severity, package-type, base-layer or fix-availability filters. Only authorized PURLs/layer digests were submitted; no image/source/full-SBOM upload, enrollment or monitoring. Backend scan 19:05:56–19:06:09 UTC; frontend 19:06:09–19:06:12 UTC.

| Image | Before C/H/M/L/U | After C/H/M/L/U | Indexed packages | Vulnerable source packages | Exit / interpretation |
|---|---|---|---:|---:|---|
| Backend | 2 / 14 / 14 / 31 / 4 | 0 / 0 / 1 / 8 / 0 | 145 | 2 | 2; successful analysis with findings |
| Frontend | 0 / 4 / 0 / 3 / 1 | 0 / 0 / 0 / 0 / 0 | 26 | 0 | 0; successful analysis, none detected |

Complete [backend SARIF](backend.sarif.json), [frontend SARIF](frontend.sarif.json), readable [backend findings](backend-findings.md)/[frontend findings](frontend-findings.md), stderr/stdout, scan-execution records and scanner version are preserved. Counts use unfiltered SARIF results, not process exit alone. Package recognition/advisory coverage is finite; zero results is not absence of all vulnerabilities.

All 20 prior Critical/High image/CVE occurrences are **A. FIXED by component removal**, itemized with old package/version/layer/prerequisites in [correction register](critical-high-dispositions.md) and its JSON. Old Debian version/applicability conflicts remain preserved; they are not waived or declared vendor-fixed.

**Supplemental CVE-2026-85091 — C. NOT REACHABLE, VERIFIED in each exact candidate.** Node embeds zlib1.3.2.1-motley-8002e91; frontend contains Alpine zlib1.3.2-r0. Vulnerable gzip-file functions remain present, with no verified supported fix, and are not reported by these new scans. The positive source/binary analysis in [supplemental evidence](node-zlib/) establishes Node Buffer-based deflate/inflate bindings without gzFile/printf exposure and no native/FFI application bridge; frontend ELF consumers have no gzip-file imports and the fixed nginx configuration loads no additional modules. Nonblocking gzwrite followed by gzprintf/gzvprintf is the required path. This is component-specific reachability evidence, not a generic JavaScript/nginx exemption or a claim the library is patched.

The C dispositions require the exact locked application/start command, no injected native addons/FFI/preloads or nginx modules, and the reviewed configuration. Any new native dependency, dynamic plugin/module, startup injection or consumer of gzip-file APIs invalidates them and reopens the gate. If reachability becomes possible before a vendor fix, removal/replacement or a specific owner residual-risk decision is required. D/E findings are not accepted silently; none remains unresolved for this candidate scope. No owner residual-risk waiver is requested or inferred.

Nine Medium/Low backend matches remain fully reported, all with no fixed version reported by Scout. The Medium nscd advisory requires the nscd service, which is absent from the exact layer inventory; its raw severity/count is retained. Eight Low glibc/gcc source-package matches are tracked without blanket false-positive claims. The task policy blocks unresolved Critical/High; it does not require zero lower-severity findings. Recheck upon vendor updates and before any promotion to a changed environment.

The existing frontend npm audit remains **57 (28 High, 15 Moderate, 14 Low)**, backend npm0. Dependency graphs and existing [browser/build-chain dispositions](../audit/disposition.md) are unchanged. Static image scanning cannot assess the browser bundle or builder tooling comprehensively; no finding was erased or automatically waived.

## Fresh verification

Complete verifier on committed source `6083c66184695ee4c31b2d617414ecd24d2b1035`: **23/23 gates, actual exit0**, generated `2026-09-13T19:10:58.161Z`; 197297ms summed gate duration. Node24.21.0/bundled npm11.19.0 on darwin/arm64. [Full report](verifier/report.json), individual logs/browser JSON, [execution record](verifier-execution.json) and command output are retained.

| Required safety check | Passed | Failed/skipped/flaky |
|---|---:|---|
| RC-001 dispatch primary scenarios | 25 | 0 / 0 / 0 |
| RC-001 exit/cancel scenarios | 10 | 0 / 0 / 0 |
| RC-002 Mongo exposure | 24 child + 1 parent entries | 0 / 0 / 0 |
| RC-002 independent real worker | 1 | 0 / 0 / 0 |

Backend388, frontend40, verifier16; other Mongo, provider, process9 and browser14+8 gates also passed. Existing trading architecture/regressions were exercised without modifications.

Image-specific check: original image fails the added removal requirement (red), final backend passes1/1 (green). Intermediate construction failures and earlier successful probes are labeled/preserved; no failed build is represented as accepted. [Container acceptance](report.json) exits0: production startup, Mongo hostname DNS/index/write readiness, exact paper/account guard, unauthenticated401, truthful releaseReady=false, scheduler/worker test-disable flags, local TLS with CA store loaded, nginx config, nine direct routes, actual Chromium Login, shutdown exit0. Read-only no-network image probe covers all production imports, bcrypt, nonroot UID, CA/tz/NSS and native closure. Disposable fixtures were removed.

The candidate frontend uses empty REACT_APP_API_URL, so browser requests use the same origin. nginx.conf serves static SPA output and has **no API proxy**. Promotion therefore requires an external same-origin gateway that routes /api to the backend, or an explicitly configured public API origin at build time with matching HTTPS/CORS/session acceptance. Container navigation alone does not verify that external routing. No credentials may be supplied as frontend build arguments.

## Remaining gates

Hosted CI; external Alpaca PAPER account/order/reconcile acceptance; external SMTP receipt; deployed HTTPS/API origin/identity/provenance; target architecture acceptance if not arm64; backup/restore; credential revocation/recovery; monitoring/alerts and unattended soak; rollout/rollback and persistent activation. These are NOT RUN and require separate authorization.

The existing owner/paper execution, durable lifecycle, research/browser/notification/cash foundation remains intact. The master brief operational foundation is not completed by local tests. Mandate/economic/cost limits, strategy evaluation and agentic features, market-data economics, commercial discovery and public onboarding remain separate gates. No new agent feature or profitability/commercial claim is made.

No push, PR, deployment, external broker/SMTP, inference, credential change, live trading, repository enrollment or persistent activation occurred.

# Frontend runtime preparation — 2026-09-13

The frontend Dockerfile now selects the official nginx stable Alpine slim variant. Preparation is complete; image build, exact-image package inspection, container acceptance and unfiltered Scout results are recorded separately by the coordinated candidate verification. This preparation record alone does not pass the image-security or combined RC gate.

Starting source: `b3a6163fe3b469b69b09c8e414e6c6a28629596a`, `codex/owner-paper-mvp`, origin `https://github.com/muckele/day-trader.git`. Initial working tree had only the expected untracked master brief; it was not modified. Only `frontend/Dockerfile` and this new evidence directory were changed by this preparation. `preparation.json` records hashes and verifies the frontend package manifest, lockfile and nginx configuration remain byte-identical to the starting source.

## Selected production composition

Previous final base: `nginx:1.30.4-alpine@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c`.

New final base: `nginx:1.30.4-alpine3.24-slim@sha256:77da26c31397bf6694b4bf93275f5b40b0b120ba1b8f114264b603e592c561d6`. Resolved Linux arm64 manifest: `sha256:65378e880e8603fcd86ff252bff7012b58bd572f5ef86622c3b643b43d013d7c`. See `base-manifest-inspect.txt`; upstream source revision is `c5b3ce398e37067d93ab1edf803e9b96a1116092`, `stable/alpine-slim`.

nginx 1.30.4 remains the current stable release in the [nginx download listing](https://nginx.org/en/download.html) and [Docker official image inventory](https://raw.githubusercontent.com/docker-library/official-images/master/library/nginx). The explicit distribution tag prevents an implicit Alpine branch change when resolving the named tag; the digest pins the chosen artifact.

The [upstream slim Dockerfile](https://raw.githubusercontent.com/nginx/docker-nginx/c5b3ce398e37067d93ab1edf803e9b96a1116092/stable/alpine-slim/Dockerfile) installs nginx core plus vendor runtime prerequisites, environment substitution support and timezone data. It omits the optional dynamic modules present in the prior full image. The application configuration uses static HTTP serving and SPA `try_files` fallback; it has no `load_module`, image transformation, XSLT, GeoIP, ACME or njs requirement. It retains exactly the existing build output copy, port 8080, nginx configuration and command. Node 24.21.0 and npm remain confined to the unchanged build stage. No package manager, debugging tool, compiler or application dependency was added.

## Prior findings and vendor reconciliation

Historical frontend SARIF identifies four High util-linux source-package findings through installed `libuuid` 2.42.1-r0. The exact reported library was `/usr/lib/libuuid.so.1.3.0`, with layer diff ID `sha256:b7596e109f91f945955bdcc910f626eb94de28200fff0a05266f3a10431328cc`. Prior read-only inspection identifies `mount` and `nsenter` as BusyBox symlinks. These are distinct implementations; command names alone do not prove or disprove a source-package advisory. Historical evidence remains unchanged.

The current [Alpine v3.24 util-linux packaging source](https://raw.githubusercontent.com/alpinelinux/aports/3.24-stable/main/util-linux/APKBUILD) and [official security database](https://secdb.alpinelinux.org/v3.24/main.json) agree:

| Finding | Vendor security-fixed release |
|---|---|
| CVE-2026-78409 | 2.42.3-r0 |
| CVE-2026-78410 | 2.42.3-r0 |
| CVE-2026-76642 | 2.42.3-r0 |
| CVE-2026-78408 | 2.42.3-r1 |

Alpine publishes [libuuid 2.42.3-r1 for aarch64](https://pkgs.alpinelinux.org/package/v3.24/main/aarch64/libuuid). This resolves the previous SARIF inconsistency for CVE-2026-78408: its advertised fix was r0 but its affected range extended through versions below r1. The vendor explicitly adds a dedicated patch and r1 secfix. No manual advisory suppression or inferred blanket non-applicability is used.

The chosen approach omits optional module dependency chains altogether. The rebuilt final image must be inspected to establish whether libuuid/util-linux, libxml2 and nghttp2 are absent; this preparation does not claim their removal solely from upstream build instructions. If any affected package remains, assess its exact installed version against vendor data and the fresh scan before release. The archived Alpine secfixes excerpt has no matching fix entry for the three prior libxml2 Low findings or nghttp2 CVE-2026-58055; absence of an entry is not proof of safety.

## Evidence and validation boundary

`official-image-library.txt`, `official-slim-Dockerfile.txt`, `alpine-util-linux-APKBUILD.txt` and `alpine-secfixes-selected.json` preserve the official sources fetched with certificate-verified system curl. `vendor-fetch-curl.json` contains URLs, timestamps and successful exit codes. Earlier sandbox DNS and Python local trust-store failures are retained in the two prior fetch records; TLS verification was never disabled.

Manifest inspection used the existing isolated `BUILDX_CONFIG=/private/tmp/day-trader-rc-buildx`, as documented by previous runtime acceptance. A direct invocation encountered a local Buildx configuration permission error; the isolated configuration resolved it without an approval denial or account change. No image was pushed, scanned or deployed by this preparation. `git diff --check` passed. Parent-coordinated build and runtime tests remain necessary; the separate 57-finding frontend npm audit and existing build-chain dispositions are unchanged.

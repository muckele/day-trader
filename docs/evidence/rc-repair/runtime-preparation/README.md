# Runtime preparation evidence

Preserved 2026-09-13 before the separate runtime implementation. These records prove public release/image availability and download integrity, not application compatibility, a completed container build, or release readiness. No runtime binaries, Docker configuration, credentials, or environment files are included. The preservation manifest maps original paths and verifies SHA-256 values.

## Node

Official [release lifecycle](https://nodejs.org/en/about/previous-releases), [Node 24 archive](https://nodejs.org/en/download/archive/v24), and [24.21.0 release notes](https://nodejs.org/en/blog/release/v24.21.0) were read during preparation. Node 20 is EOL; the current Node 24 LTS release is 24.21.0.

The macOS ARM64 runtime was downloaded from `https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz`. Its SHA-256 matches the official HTTPS `SHASUMS256.txt`: `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`. The extracted executable reports Node 24.21.0, npm 11.19.0 and OpenSSL 3.5.8. GPG is unavailable, so detached-signature verification was not performed. `download-provenance.json` preserves the exact paths and verification scope.

The official `docker.io/library/node:24.21.0-bookworm-slim` image exists with index digest `sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`. Bookworm is explicit to avoid an implicit Debian distribution change. The complete public architecture manifest is preserved.

## nginx

The official [download page](https://nginx.org/en/download.html) lists 1.30.4 stable and 1.31.5 mainline. The [security advisory page](https://nginx.org/en/security_advisories.html) includes affected ranges containing the existing 1.27 branch and fixes on later branches. Many listed advisories require configuration features absent from the app's simple static HTTP server; this is not a claim of a demonstrated exploit.

The official `docker.io/library/nginx:1.30.4-alpine` image exists with index digest `sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c`. Its public manifest identifies the official stable/alpine source. This is the proposed stable runtime update, subject to actual image builds, static navigation and available security checks.

## Metadata reads and later checks

Public image manifests were read using `BUILDX_CONFIG=/private/tmp/day-trader-rc-buildx docker buildx imagetools inspect <official-tag>`, exit 0 for both. The first nginx inspection failed because the default local buildx configuration was unreadable; isolated temporary buildx configuration resolved this configuration problem. No image was built, uploaded or deployed during preparation.

Docker 29.6.1, buildx 0.35.0 and Scout 1.23.1 are available. Trivy, Grype and GPG were not found. Docker's [data-handling documentation](https://docs.docker.com/scout/deep-dive/data-handling/) says local Scout analysis sends PURLs and layer digests only; no scan or upload has occurred in this preparation. Image metadata must be checked for secrets before a later authorized local analysis. Source, environment values and Docker configuration are not authorized audit payloads.

# Supported runtime and local verification

Use Node **24.21.0** with its bundled npm **11.19.0**. `.nvmrc`, both package manifests, lockfile root metadata, CI, and the Docker build/runtime images declare this release. The verification runtime gate requires the exact Node/npm pair and records their executable paths; put the selected distribution's `bin` directory first on `PATH` when invoking the verifier. Installing a different npm globally does not satisfy that gate.

With nvm, run `nvm install` and `nvm use` from the repository root. Alternatively, download the archive for the host OS/architecture from the [official Node 24.21.0 archive](https://nodejs.org/download/release/v24.21.0/), verify its SHA-256 against the [official checksum list](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt), extract it, and prepend its `bin` directory to `PATH`. Then run:

```sh
node scripts/verify-runtime.mjs
node --test scripts/tests/verify-mvp.test.mjs
```

Node 24 is an LTS line; Node 20 is EOL. The selected patch was checked against the [Node release schedule](https://nodejs.org/en/about/previous-releases), [EOL list](https://nodejs.org/en/about/eol), and [24.21.0 release notes](https://nodejs.org/en/blog/release/v24.21.0). The patch is deliberately exact so local verification and CI use the same runtime. Future security patch updates must update these declarations together and repeat verification.

Both Node images use `node:24.21.0-bookworm-slim` pinned to multi-platform index digest `sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`. The frontend's final image uses `nginx:1.30.4-alpine`, pinned to index digest `sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c`. Version 1.30.4 was listed as stable on the [official nginx download page](https://nginx.org/en/download.html); [nginx security advisories](https://nginx.org/en/security_advisories.html) document affected version ranges and module prerequisites. The application serves static files from nginx; frontend Node/npm are build and test tools. Backend Node is a deployed runtime.

The pin update does not change the dependency graph or resolve frontend dependency advisories. Review the separate [audit disposition](evidence/rc-repair/audit/disposition.md) alongside fresh audits. Docker build contexts exclude environment files, npm configuration, host `node_modules`, and host build output. Provide intentional public frontend configuration through `REACT_APP_API_URL`; credentials must never be frontend build arguments.

For complete local acceptance, follow the isolated MongoDB and browser prerequisites in the [MVP runbook](mvp-runbook.md), then use a new evidence directory so historical reports remain intact:

```sh
node scripts/verify-mvp.mjs --report-dir docs/evidence/rc-repair/runtime-verifier
```

This runs clean lockfile installs and the complete mandatory acceptance matrix. A targeted runtime/config test is insufficient to claim full runtime compatibility. Production image validation also requires building both images, recording their actual Node/npm/nginx and OS package versions, checking health/static serving with isolated fixtures, and assessing image vulnerabilities separately from npm audit. A successful build or pinned digest is not a vulnerability scan. These local checks do not authorize deployment or external-service acceptance.

Docker installs match the verifier's `--ignore-scripts --no-audit --no-fund` options; the backend additionally omits development dependencies. Dependency install hooks do not run during these builds. Explicit audits are performed separately with isolated npm configuration and preserved output.

Official download/checksum and image-manifest evidence is preserved under [runtime preparation](evidence/rc-repair/runtime-preparation/README.md). The host archive SHA-256 matched the official HTTPS list; detached-signature verification was not performed because GPG was unavailable. Runtime config tests and source-identity proof are preserved under `docs/evidence/rc-repair/runtime-config/`.

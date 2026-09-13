> **2026-09-13 authenticated Scout result: scans COMPLETE WITH FINDINGS; combined local RC NO-GO.** Backend65 CVEs (2Critical,14High,14Medium,31Low,4Unspecified); frontend8 (0Critical,4High,0Medium,3Low,1Unspecified). Both exact local Linuxarm64 targets exited2 with valid SARIF. Authentication is resolved; remaining blocker is findings/applicability/residual-risk disposition, not missing analysis. See `docs/evidence/rc-repair/image-scan/README.md` and `authenticated-retry/critical-high-dispositions.md`. No source/package/runtime change or rebuild; unchanged23/23 verification retained. Earlier approval/sign-in checkpoint text below is historical.

> **2026-09-13 authorized scan continuation: NO-GO — image analysis remains incomplete because Docker Scout requires sign-in.** Both verified immutable local Linuxarm64 targets were attempted with explicit user authorization and normal approval; each exited1 without SARIF. Severity counts are unknown. The earlier metadata-authorization blocker is superseded; no credentials/sign-in, upgrades or broader transfers were performed. See `docs/evidence/rc-repair/image-scan/README.md` for exact commands, identities, timestamps and results. The unchanged 23/23 source-bound verification is retained; no full suite rerun.

# Linux candidate image verification

Both builds completed with exit 0 on Docker Engine 29.6.1 / Buildx 0.35, platform `linux/arm64`. Exact commands (repository root):

```sh
env BUILDX_CONFIG=/private/tmp/day-trader-rc-buildx docker build --pull --platform linux/arm64 --progress plain -t day-trader-rc-backend:node24 backend
env BUILDX_CONFIG=/private/tmp/day-trader-rc-buildx docker build --pull --platform linux/arm64 --progress plain -t day-trader-rc-frontend:node24 frontend
python3 docs/evidence/rc-repair/runtime-containers/container-check.py
```

Isolated Buildx configuration avoided a host configuration-file permission error; it did not bypass an approval denial. Build outputs are `backend-build.log` and `frontend-build.log`. Runtime/source pins are in `../runtime-final-source-manifest.json`; the later TAP reporter change is outside both image contexts. No application code changed after the safety commit.

`report.json` and `container-check.log`: corrected fixture exit 0, all checks passed, cleanup complete. Backend production startup proves Mongo primary, indexes and write readiness; exact paper binding remains enabled; authenticated readiness succeeds and unauthenticated readiness returns 401. `releaseReady` remains false because no external acceptance is asserted. Linux Node is 24.21.0, npm 11.19.0, built-in OpenSSL 3.5.8. Frontend nginx 1.30.4 passes configuration validation; nine deep links return the SPA index and Chromium renders the actual login page. This is a static container-navigation check; the separate full verifier supplies authenticated application acceptance.

Every container runs on a disposable internal network with synthetic owner/provider settings and disabled schedulers. The frontend fixture uses a loopback-only HTTP bridge: each request executes wget against the actual nginx HTTP endpoint inside the isolated container; the browser can access only that loopback origin. It does not serve a copied build or permit external egress. All fixture containers/network were removed; candidate images are retained for the pending CVE check.

The first fixture run (`report-first.json`, `container-check-first.py`, `container-check-first.log`) reached backend readiness but failed host access to a Docker Desktop internal-network published port. The bridge's first iteration (`*-bridge-first.*`) hit a Python variable-name collision; cleanup succeeded. Both were verification-fixture failures, not application defects. A sandbox-only launch also failed to access the Docker socket before creating resources; the authorized escalated run succeeded. The final fixture replaces these failures without concealing them.

`local-package-inventory.json` records offline package versions for both final images and confirms no .env/.env.local/.npmrc file in the application/static roots. `image-config-inspection.jsonl` records nonsecret final image environment configuration. These are bounded local checks, not vulnerability analysis.

**CVE analysis remains BLOCKED.** Automatic approval review rejected Docker Scout before execution because its CVE service would receive package URLs and layer digests from private local images. `scout-approval-block.json` records the exact command/reason. No scan metadata or image/source was transferred. No alternate scanner, registry, proxy or transport was used. Frontend analysis was withheld for the same reason. Successful builds, local inventory and official version/advisory checks do not waive this required security gate; the combined local RC remains NO-GO pending narrow approval and scan disposition.

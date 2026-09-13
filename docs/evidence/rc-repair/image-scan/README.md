# Authenticated immutable-image CVE analysis — 2026-09-13

**Both scans completed with findings. Combined local RC remains NO-GO; image security gate has not passed.** Authentication and permission blockers are resolved. No application/package/runtime change, rebuild, registry substitution or full verifier rerun occurred. Starting HEAD282da56c14bacc9de0dbd7b49540106e089cb032; verified runtime source hashes still match. All changes in this continuation are documentation/evidence.

Scout v1.23.1 (Go1.26.3 darwin/arm64) scanned only the two explicit immutable local IDs below. Backend indexed404 packages/19 vulnerable packages; frontend87/3. Both SARIF runs contain a result and rule for each counted unique CVE. Counts use Scout cvssV3_severity (not SARIF level or numeric-score reclassification); unspecified remains separate. No severity/fix/base/suppression filters were used. Base and application packages present in the final images were included. Frontend builder-only packages/browser bundles are not assumed fully covered; the separate57-finding frontend npm audit remains unchanged.

| Image | Critical | High | Medium | Low | Unspecified | Total unique CVEs | Exit |
|---|---:|---:|---:|---:|---:|---:|---:|
| Backend | 2 | 14 | 14 | 31 | 4 | 65 | 2 |
| Frontend | 0 | 4 | 0 | 3 | 1 | 8 | 2 |

Exit2 means vulnerabilities detected, as documented by installed help. This is no longer failed/incomplete analysis. No clean-image claim follows.

### backend

```sh
docker scout cves local://sha256:125fd6abf409da48f5e8ed8b5301899dd8ded1708001300a993511293fda1186 --platform linux/arm64 --exit-code --locations --format sarif --output docs/evidence/rc-repair/image-scan/authenticated-retry/backend.sarif.json
```

Image: `sha256:125fd6abf409da48f5e8ed8b5301899dd8ded1708001300a993511293fda1186`, linux/arm64. Started 2026-09-13T18:37:08.433925+00:00, finished 2026-09-13T18:37:27.461762+00:00. Actual exit2; complete SARIF and scanner completion message confirmed.

### frontend

```sh
docker scout cves local://sha256:2caf28ef5c5a8bcd558703034a8df1cb44b4fdd519b627ad3b6be7a36938fc19 --platform linux/arm64 --exit-code --locations --format sarif --output docs/evidence/rc-repair/image-scan/authenticated-retry/frontend.sarif.json
```

Image: `sha256:2caf28ef5c5a8bcd558703034a8df1cb44b4fdd519b627ad3b6be7a36938fc19`, linux/arm64. Started 2026-09-13T18:37:27.497058+00:00, finished 2026-09-13T18:37:33.553440+00:00. Actual exit2; complete SARIF and scanner completion message confirmed.

## Complete results and assessment

Raw complete machine-readable reports: authenticated-retry/backend.sarif.json and frontend.sarif.json. All findings are also in backend-findings.md, frontend-findings.md and normalized-findings.json. Every Critical/High image occurrence has package/version, exact reported layer diff IDs, fix, prerequisites, bounded application exposure, release disposition and smallest correction in critical-high-dispositions.md/.json. Exact command/timestamp/exit files, stdout/stderr and scanner version are retained. Layer attribution uses local archive-member inspection only; archives were unnamed temporary files deleted on close, never uploaded. Read-only, no-network disposable container checks were removed automatically.

Frontend four Highs are util-linux source-package matches carried through libuuid; actual mount/nsenter are BusyBox, with no relevant util-linux implementation/configured hooks. Two backend Perl compression findings likewise implicate modules absent from the exact image. These are component-specific not-affected candidates, not blanket exemptions based on nginx/owner-only scope. Backend npm findings are in bundled npm tooling, not /app/node_modules; runtime entrypoint directly runs Node, but build/tool risk remains. PCRE2 has a small vendor security update available. Other backend Perl/util-linux risks have no confirmed paper HTTP exploit but lack an accepted residual-risk basis. Perl trie and zlib descriptions contain version-range contradictions requiring vendor/code confirmation; neither was declared a false positive.

## Decision and bounded remediation proposal

There is no documented general policy accepting new image residual risks. Keep NO-GO until the reviewed findings are corrected or the owner explicitly accepts specific bounded residual dispositions. Scan execution is complete; the security acceptance gate is not passed. No newly reproduced trading exploit is asserted by these package matches.

Smallest follow-on task, requiring separate change authorization: (1) resolve the component/version applicability discrepancies and approve only evidence-supported exceptions; (2) apply the available Bookworm PCRE2 security update; (3) remove unused npm from the deployed backend runtime or use a verified corrected distribution, while preserving the tested build toolchain; (4) obtain vendor-corrected packages or validate a minimal runtime for remaining Perl/util-linux issues. Do not blindly remove essential Debian packages or migrate distributions wholesale. If keeping residuals, request explicit owner acceptance with fixed scope, prerequisites and revisit conditions. For frontend, component-not-present evidence may suffice after review; if patching libuuid instead, resolve Scout's2.42.3-r0 versus affected<2.42.3-r1 inconsistency first.

A future changed image requires build, immutable provenance, complete unfiltered rescans and Linux production/static acceptance; package/runtime changes require the appropriate combined verifier. No such changes were made now; reuse the unchanged23/23 evidence. These proposals do not select an unverified new Node/npm patch or automatically accept remaining lower severities, which remain in full reports.

Hosted CI, external Alpaca paper acceptance, external SMTP receipt, deployment, backup/restore, credential revocation, deployment provenance, monitoring/soak, mandate/cost, strategy and commercial gates remain separate and unperformed. No push, repository enrollment, persistent monitoring, source/credential/.env/full-SBOM/provenance/image upload, automatic remediation, deployment, external brokerage/SMTP, paid inference or activation was performed. Only the authorized PURL/layer-digest vulnerability analysis was requested; scanner telemetry internals were not packet-captured, and local indexing messages are not evidence of image upload.

Prior failed sign-in attempt files and summary-authentication-failed.json remain historical. The latest result is summary.json and authenticated-retry/summary.json.

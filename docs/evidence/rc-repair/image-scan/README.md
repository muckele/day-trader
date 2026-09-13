# Authorized immutable-image Scout attempts — 2026-09-13

**NO-GO. Image-analysis gate incomplete: Docker authentication required.** The user authorized only one-off package-URL/layer-digest transfer from the two recorded local candidate images. The normal approval mechanism permitted both commands to execute. The earlier metadata-authorization rejection is historical; the current blocker is the installed scanner's sign-in requirement.

Starting HEAD `bebdcd1c6eec78230ec01dab18563f048d01d002`, branch `codex/owner-paper-mvp`; only the unchanged operator master brief was untracked. All final runtime source-manifest hashes matched and application/configuration diff was empty. Existing 23/23 deterministic verification is reused; no trading tests were rerun. Recorded Linuxarm64 builds, image IDs, creation times and local layers were checked against `../runtime-containers/report.json`; full target identities are in `verified-targets.json`. Neither image was rebuilt or replaced. Empty RepoDigests lists are normal for these local builds; immutable local image IDs were used, with no registry fallback.

Installed Scout: **v1.23.1**, Go1.26.3, darwin/arm64, commit1f5f7a51d7dbbd427feccfa2e133aa51ec702c22. Version/help outputs are preserved. A new-version notice mentioned1.24.0; no upgrade was performed or needed to explain the authentication failure.

## Exact attempts

```sh
docker scout cves local://sha256:125fd6abf409da48f5e8ed8b5301899dd8ded1708001300a993511293fda1186 --platform linux/arm64 --exit-code --locations --format sarif --output docs/evidence/rc-repair/image-scan/backend.sarif.json
```

Actual exit: **1**; started 2026-09-13T18:31:29.584935+00:00; finished 2026-09-13T18:31:29.849005+00:00.

```sh
docker scout cves local://sha256:2caf28ef5c5a8bcd558703034a8df1cb44b4fdd519b627ad3b6be7a36938fc19 --platform linux/arm64 --exit-code --locations --format sarif --output docs/evidence/rc-repair/image-scan/frontend.sarif.json
```

Actual exit: **1**; started 2026-09-13T18:31:29.849406+00:00; finished 2026-09-13T18:31:30.084142+00:00.

Both stdout files are empty. Both stderr files say: `Log in with your Docker ID or email address to use docker scout.` Each process exited1 before producing SARIF. This is a failed/incomplete analysis, not completed analysis with findings or a clean result. Counts for critical/high/medium/low/unspecified are **unknown for each image**. No advisory list exists to assess package versions, layers, fixes or exploit prerequisites. No suppression, severity, fixed-only, base-only or application-only filter was supplied; intended scope includes the base and application packages present in each final image. Builder-only packages are not asserted covered by the frontend final-image attempt; existing frontend npm build/browser risk dispositions remain separate.

No sign-in, credential inspection/change, paid upgrade, repository enrollment, persistent monitoring, or image/source/full-SBOM/provenance upload was performed. The scanner failed at authentication; successful vulnerability analysis or successful CVE metadata transfer is not established by these attempts. No retry through another account, tool, proxy or destination was attempted.

## Decision and bounded next step

The documented policy requires all combined candidate gates; an incomplete scan cannot pass. The owner must first make an authenticated Docker session available through normal Docker sign-in; the agent has not been authorized to establish it. Retry only the two same verified immutable `local://sha256:...` targets afterward. Assess complete results before promotion. No application/package/runtime correction is currently justified by nonexistent scan findings. Any future critical/high requires package/layer/fix/exposure assessment. The prior specific frontend dependency dispositions do not constitute a general waiver policy for newly found image risks; any residual risk without a documented acceptance basis needs owner approval.

RC-001 and RC-002 remain repaired with unchanged source-bound evidence. The original candidate remains NO-GO; combined repaired local RC remains NO-GO for incomplete image analysis. Hosted CI, external broker/email acceptance, deployment and broader operational/agentic roadmap gates remain unperformed. No push, PR, deployment, external brokerage request, external SMTP, paid inference, live trading or persistent activation occurred.

# Runtime image hardening implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent frontend work and scoped review; continue the authorized implementation without a handoff question.

**Goal:** Remove unnecessary vulnerable runtime components, inherit supported vendor fixes, and establish a fresh combined candidate decision.

**Architecture:** Preserve the Node24.21.0 binary and application dependency graphs. Use an official Debian/Node installation stage and construct an explicit final runtime filesystem containing only its runtime libraries, CA certificates, timezone/DNS facilities, package provenance, Node and production application tree. Refresh the independent nginx runtime using current official stable/vendor fixes. Final images are immutable and scanned without suppression.

**Tech Stack:** Node24.21.0/npm11.19.0 build toolchain, Debian Bookworm glibc, nginx stable, Docker/Scout, Mongo7/Chromium local fixtures.

**Spec:** /Users/Matt/.codex/attachments/c27d788a-4ca1-4a08-8f80-0690d34a8278/pasted-text.txt

## Constraints and ruling

Application JS, dependency graphs, RC001/RC002 and master brief remain unchanged. No external brokerage, SMTP, inference, push, deployment, enrollment or persistent activation. Official package/image pulls and narrowly scoped Scout PURL/layer transfers are authorized. Preserve old evidence. Work directly on the existing authorized codex branch with only the operator brief initially untracked.

Ruling: a reproducible Debian-derived final filesystem avoids forcibly uninstalling essential Debian Perl/package-manager dependencies. It uses vendor-built binaries and security-updated shared libraries, not ad-hoc compilation or Alpine/musl. Preserve real package version and file provenance; do not hide package metadata to affect scan counts. Review the explicit closure and exercise DNS/TLS/timezones/native imports and actual server startup before accepting it.

## Ordered work

- [x] Verify repository, ancestor, baseline inputs, images and actual runtime contents. Record baseline hashes under docs/evidence/rc-repair/image-hardening/.
- [x] Backend: create backend/docker/assemble-runtime.cjs and multi-stage backend/Dockerfile. Copy production imports only; record selected package metadata and Node versions; no npm/Perl/util-linux/apt/shell/compiler. Vendor-update builder OS packages before assembly. Preserve CA/tz/NSS and loader closure. Fail assembly if new native addons have unavailable shared dependencies.
- [x] Image checks: create scripts/acceptance/runtime-image.test.cjs. First run against original image must reject its extra tooling/tests. New image must pass package imports, no native-load failures, CA/zone/DNS config, filesystem/provenance and removed-component assertions.
- [x] Frontend agent: verify nginx stable/Alpine vendor state, update only Dockerfile, build and inspect exact final package contents. Keep frontend package manifests/locks unchanged.
- [x] Build both images and record source SHA plus exact dirty Dockerfile/helper hashes, bases/digests, immutable IDs, platform/time, history/config/layer inventories. Commit backend and frontend separately after meaningful image checks.
- [x] Adapt existing container acceptance into new evidence directory and bind it to immutable IDs. Replace obsolete npm-in-runtime check with Node-only absence/provenance assertions. Retain all paper/account/readiness/auth/scheduler and nine-route/browser checks.
- [x] Run complete verifier on supported host Node with test-owned Mongo; retain mandatory RC primary25, exit10, exposure24child+realprocess. Do not weaken parser or tests. Record fresh23-gate result.
- [x] Scout both new local immutable IDs, all findings, raw SARIF and readable output. Map each remaining Critical/High exactly to A/B/C/D/E with evidence; D/E block absent explicit acceptance. Review embedded Node components separately from removed OS package matches.
- [x] Inspect final diff/secrets/master-brief hash, update current acceptance/verification/checkpoint/runbook and decision, commit evidence only after results. Clean only task-owned local fixtures; retain images. Report exact commits/images/counts and separate external/roadmap gates.

Final result: fresh23/23, exact-image/container acceptance and both unfiltered scans completed. Local GO with supplemental C zlib dispositions; see docs/evidence/rc-repair/image-hardening/README.md. Historical evidence/master brief preserved; external gates remain unperformed.

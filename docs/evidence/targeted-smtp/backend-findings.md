# Backend Docker Scout findings

Exactly one authorized unfiltered analysis of `local://sha256:45b9a917717d1bf6cc113c589fa069b70591aab6502bda91d4eed3bf45844d7d`, linux/arm64, using Docker Scout v1.23.1.

Started 2026-09-21T15:55:14.573244+00:00; ended 2026-09-21T15:55:27.202721+00:00. Actual exit code 0. Exit 0 does not mean clean: the SARIF contains eight Low findings across two source packages; Scout indexed 145 packages.

Counts: **0 Critical / 0 High / 0 Medium / 8 Low / 0 Unknown**. No severity, fix-availability, package-type or base-image filters. Readable findings were derived locally from this one SARIF; no second analysis was run.

| Advisory | Severity | Package URL | Fixed version |
|---|---|---|---|
| CVE-2010-4756 | LOW | pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12 | not fixed |
| CVE-2018-20796 | LOW | pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12 | not fixed |
| CVE-2019-1010022 | LOW | pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12 | not fixed |
| CVE-2019-1010023 | LOW | pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12 | not fixed |
| CVE-2019-1010024 | LOW | pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12 | not fixed |
| CVE-2019-1010025 | LOW | pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12 | not fixed |
| CVE-2019-9192 | LOW | pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12 | not fixed |
| CVE-2022-27943 | LOW | pkg:deb/debian/gcc-12@12.2.0-14%2Bdeb12u1?os_distro=bookworm&os_name=debian&os_version=12 | not fixed |

The documented unresolved Critical/High image gate passes. Lower findings remain recorded without blanket exploitability waivers. No package or runtime changes were made in response to this scan. No Critical/High correction is required by these results.

All package locations/descriptions remain in backend.sarif.json. Scan coverage is finite; this is not proof of absence of all vulnerabilities. The earlier Medium advisory was not reported in this new analysis; no claim of a source/runtime fix is inferred from its absence.

Prior supplemental CVE-2026-85091 reachability evidence remains separate from scanner findings. runtime-continuity.json verifies unchanged Node binary/components, vendor package set, non-application exported files, no native addons, and unchanged dependency/startup configuration. New notification JavaScript adds no native/FFI/gzip-file path. Existing frontend browser/build-chain findings and their dispositions remain separate and are not erased by this backend scan.

Only the approved package URL/layer-digest analysis was requested. No image/source/credential/full SBOM/provenance upload, repository enrollment, monitoring, or paid access was requested.

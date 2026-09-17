# Fresh backend Docker Scout findings

Unfiltered local-image scan: 0 Critical, 0 High, 1 Medium, 8 Low, 0 Unknown. Exit 2 means successful analysis with findings. Full SARIF preserves descriptions and physical package locations. No fixed version is reported for these nine matches.

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
| CVE-2026-89092 | MEDIUM | pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12 | not fixed |

All belong to the backend runtime filesystem layer `sha256:71d4ca4989d80f45a586036b2dec51f48f3ae3fc8ffa4a4d6a1ee875fdb59a19`. The second image layer is empty. No severity, base-image, package-type, fix-availability or exception filters were supplied.

The existing unresolved Critical/High blocking policy passes; lower findings remain tracked. The Medium nscd finding requires a service absent from this closed runtime. Low source-package findings are retained without a blanket exploitability waiver. Scanner coverage is finite. Supplemental CVE-2026-85091 remains subject to the previously verified exact-runtime reachability disposition; see README. Browser/build-chain dependency audit dispositions remain separate.

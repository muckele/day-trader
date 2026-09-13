# Prior Critical/High findings — correction register

All 20 prior image/CVE occurrences are **A. FIXED**, specifically by removal of their affected OS/tooling components from final runtime images. This does not assert that upstream packages were universally fixed. Raw old paths, installed versions, fixed-version reports, prerequisites and layer diff IDs remain in [removed-critical-high.json](removed-critical-high.json) and the unchanged [prior disposition](../image-scan/authenticated-retry/critical-high-dispositions.md).

| Image | Prior finding | Prior installed package | Classification | Exact correction |
|---|---|---|---|---|
| backend | CVE-2026-78409 | pkg:deb/debian/util-linux@2.38.1-5%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12 | A. FIXED | Omit affected OS component from explicitly assembled Node/glibc runtime |
| backend | CVE-2026-48962 | pkg:deb/debian/perl@5.36.0-7%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12 | A. FIXED | Omit affected OS component from explicitly assembled Node/glibc runtime |
| backend | CVE-2026-89161 | pkg:deb/debian/pcre2@10.42-1?os_distro=bookworm&os_name=debian&os_version=12 | A. FIXED | Omit affected OS component from explicitly assembled Node/glibc runtime |
| backend | CVE-2026-14257 | pkg:npm/brace-expansion@5.0.7 | A. FIXED | Omit global npm and bundled dependency tree |
| backend | CVE-2026-48959 | pkg:deb/debian/perl@5.36.0-7%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12 | A. FIXED | Omit affected OS component from explicitly assembled Node/glibc runtime |
| backend | CVE-2026-69152 | pkg:npm/brace-expansion@5.0.7 | A. FIXED | Omit global npm and bundled dependency tree |
| backend | CVE-2026-73566 | pkg:npm/tar@7.5.19 | A. FIXED | Omit global npm and bundled dependency tree |
| backend | CVE-2026-69192 | pkg:npm/ip-address@10.2.0 | A. FIXED | Omit global npm and bundled dependency tree |
| backend | CVE-2026-78410 | pkg:deb/debian/util-linux@2.38.1-5%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12 | A. FIXED | Omit affected OS component from explicitly assembled Node/glibc runtime |
| backend | CVE-2026-78408 | pkg:deb/debian/util-linux@2.38.1-5%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12 | A. FIXED | Omit affected OS component from explicitly assembled Node/glibc runtime |
| backend | CVE-2026-86145 | pkg:deb/debian/pcre2@10.42-1?os_distro=bookworm&os_name=debian&os_version=12 | A. FIXED | Omit affected OS component from explicitly assembled Node/glibc runtime |
| backend | CVE-2026-85091 | pkg:deb/debian/zlib@1%3A1.2.13.dfsg-1?os_distro=bookworm&os_name=debian&os_version=12 | A. FIXED | Omit affected OS component from explicitly assembled Node/glibc runtime |
| backend | CVE-2026-57432 | pkg:deb/debian/perl@5.36.0-7%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12 | A. FIXED | Omit affected OS component from explicitly assembled Node/glibc runtime |
| backend | CVE-2026-76642 | pkg:deb/debian/util-linux@2.38.1-5%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12 | A. FIXED | Omit affected OS component from explicitly assembled Node/glibc runtime |
| backend | CVE-2026-12087 | pkg:deb/debian/perl@5.36.0-7%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12 | A. FIXED | Omit affected OS component from explicitly assembled Node/glibc runtime |
| backend | CVE-2026-13221 | pkg:deb/debian/perl@5.36.0-7%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12 | A. FIXED | Omit affected OS component from explicitly assembled Node/glibc runtime |
| frontend | CVE-2026-78409 | pkg:apk/alpine/util-linux@2.42.1-r0?os_name=alpine&os_version=3.24 | A. FIXED | Omit libuuid and optional nginx module dependency chain |
| frontend | CVE-2026-78410 | pkg:apk/alpine/util-linux@2.42.1-r0?os_name=alpine&os_version=3.24 | A. FIXED | Omit libuuid and optional nginx module dependency chain |
| frontend | CVE-2026-78408 | pkg:apk/alpine/util-linux@2.42.1-r0?os_name=alpine&os_version=3.24 | A. FIXED | Omit libuuid and optional nginx module dependency chain |
| frontend | CVE-2026-76642 | pkg:apk/alpine/util-linux@2.42.1-r0?os_name=alpine&os_version=3.24 | A. FIXED | Omit libuuid and optional nginx module dependency chain |

Debian PCRE2 was upgraded in the install stage from 10.42-1 to supported 10.42-1+deb12u1, then excluded from the final runtime because Node does not link it. Both CVEs are vendor-confirmed fixed in that update (DLA-4772-1); the final-image correction is component removal. No Perl, OS zlib or util-linux vendor fix is invented. Alpine util-linux CVE-78408 requires 2.42.3-r1, while its other three findings were fixed in r0; the final slim image contains neither libuuid nor util-linux.

**Supplemental zlib analysis is separate:** Node embeds a different zlib and the frontend retains Alpine zlib. Neither is claimed absent or patched. Their exact-runtime C dispositions and evidence are in [node-zlib](node-zlib/); zero Critical/High Scout output does not erase that analysis.

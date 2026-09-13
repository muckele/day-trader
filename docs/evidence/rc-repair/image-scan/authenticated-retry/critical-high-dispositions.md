# All Critical/High dispositions

20 image/CVE occurrences:16 backend,4 frontend. Raw severities are retained; no exploitability score is invented. A proposed component-not-affected assessment differs from accepting known vulnerable reachable code. No general image residual-risk policy was found; earlier frontend npm dispositions are narrow and do not authorize new exceptions. Overall NO-GO until backend findings/applicability and residual decisions are resolved.

Source evidence: Dockerfiles/start command, production source search, exact-image read-only module/utility/link checks, and local archive layer mapping. See local-exposure-checks.json, perl-component-checks.json, layer-locations.json. No exploitation was performed; negative source search is bounded, not exhaustive.

## backend — CVE-2026-78409 (HIGH)

Package: `pkg:deb/debian/util-linux@2.38.1-5%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12`.

Reported fixed version: **not fixed**; affected range: `>0`.

Exact location layer diff IDs: `sha256:13a56b6535801be2adde694dabaf1c2df1d862a390661907dac821c42cd565cc`, `sha256:333672ac957fc91eaa777994fc6710227f60ab7d875689f73f16f3bc9b4c510c`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: A local user needs an fstab-authorized X-mount.subdir entry and the detached-tree path on Linux6.15+, with attacker-controlled intermediate symlink/procfs resolution.

Application exposure: Backend contains util-linux mount/nsenter. Its fstab is unconfigured and bounded application search found no mount/nsenter/subprocess caller. Required privileged/local/configuration path is not established for the paper HTTP workload. Deployment privilege configuration is not certified by this scan.

Release disposition: Residual base-utility risk; no reproduced application exploit. No documented general acceptance policy covers it, so retain promotion hold pending mitigation or owner acceptance.

Smallest correction/evidence: Use a vendor-corrected base/backport or an intentionally minimal runtime without unused affected tools, then verify dependencies and scan. Upstream advisories identify2.41.6/2.42.3; Scout reports no Bookworm fix. Do not transplant another distribution package blindly.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-78409?s=debian&n=util-linux&ns=debian&t=deb&osn=debian&osv=12&vr=%3E0)

## backend — CVE-2026-48962 (HIGH)

Package: `pkg:deb/debian/perl@5.36.0-7%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12`.

Reported fixed version: **not fixed**; affected range: `>0`.

Exact location layer diff IDs: `sha256:13a56b6535801be2adde694dabaf1c2df1d862a390661907dac821c42cd565cc`, `sha256:333672ac957fc91eaa777994fc6710227f60ab7d875689f73f16f3bc9b4c510c`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: Untrusted output glob reaches Perl File::GlobMapper string evaluation; IO::Compress before2.220 is implicated.

Application exposure: Scanner attributes Perl source-package CVE to installed perl-base. Direct module loads show File::GlobMapper and IO::Uncompress::Unzip absent from default @INC (each exit2); IO::Compress is also absent. No application Perl caller found. This is evidence of affected component absence, not an exploit run.

Release disposition: Candidate component-not-present disposition; no application correction indicated by this finding. Preserve raw CVE and review the scoped disposition rather than suppressing it globally.

Smallest correction/evidence: Document absence in the exact image and avoid adding these modules; if later needed, use IO::Compress2.220+ or the vendor-fixed package. Scout lists no Bookworm fix; other-release versions do not directly patch this image.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-48962?s=debian&n=perl&ns=debian&t=deb&osn=debian&osv=12&vr=%3E0)

## backend — CVE-2026-89161 (HIGH)

Package: `pkg:deb/debian/pcre2@10.42-1?os_distro=bookworm&os_name=debian&os_version=12`.

Reported fixed version: **10.42-1+deb12u1**; affected range: `<10.42-1+deb12u1`.

Exact location layer diff IDs: `sha256:13a56b6535801be2adde694dabaf1c2df1d862a390661907dac821c42cd565cc`, `sha256:333672ac957fc91eaa777994fc6710227f60ab7d875689f73f16f3bc9b4c510c`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: A PCRE2 consumer uses pcre2_jit_match with the affected previously copied subject/context reuse, causing an invalid free.

Application exposure: libpcre2-8 is present in the OS. Node ldd output does not link it and bounded server search found no PCRE2/subprocess use. JavaScript regex does not establish use of these C APIs. Other OS consumers/configurations remain possible; no HTTP exploit reproduced.

Release disposition: Fixable base-library finding with no confirmed application path. Retain security hold pending patch or explicit residual acceptance; prefer the small available vendor update.

Smallest correction/evidence: Update libpcre2-8-0 through the Bookworm security package10.42-1+deb12u1 (Scout reports this for both; Debian independently confirms CVE-86145), retain approved Node pin where possible, rebuild/re-scan and verify Linux startup plus applicable combined checks.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-89161?s=debian&n=pcre2&ns=debian&t=deb&osn=debian&osv=12&vr=%3C10.42-1%2Bdeb12u1)

## backend — CVE-2026-14257 (HIGH)

Package: `pkg:npm/brace-expansion@5.0.7`.

Reported fixed version: **5.0.8**; affected range: `>=4.0.0,<5.0.8`.

Exact location layer diff IDs: `sha256:0dde8ff85f5f8ef28637238bf773b77a5702c09f2a5c5bf7717810ad03e30e60`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: Untrusted brace patterns reach brace-expansion.expand; bounded result count does not bound output length, causing fatal memory exhaustion.

Application exposure: Only reported copy is under /usr/local/lib/node_modules/npm/node_modules, introduced by the Node distribution layer. Server starts directly as node server.js. Bounded application search found no use of this bundled component; package-install/build tooling remains an exposure boundary, and owner-only auth does not make it harmless.

Release disposition: Residual tooling risk: no confirmed HTTP trading path, but not covered by the prior application-lock audit or a blanket image exception. Blocks promotion until removed/patched or explicitly accepted with bounded conditions.

Smallest correction/evidence: Smallest runtime-only approach: omit unused npm from the final backend runtime after validating startup; retain a separate build toolchain. Alternatively select a supported npm distribution containing brace-expansion>=5.0.9 to cover both reports and resolve all bundled advisories. These are Scout-reported minima, not an approved new runtime pin; do not edit global vendored files ad hoc.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-14257?s=github&n=brace-expansion&t=npm&vr=%3E%3D4.0.0%2C%3C5.0.8)

## backend — CVE-2026-48959 (HIGH)

Package: `pkg:deb/debian/perl@5.36.0-7%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12`.

Reported fixed version: **not fixed**; affected range: `>0`.

Exact location layer diff IDs: `sha256:13a56b6535801be2adde694dabaf1c2df1d862a390661907dac821c42cd565cc`, `sha256:333672ac957fc91eaa777994fc6710227f60ab7d875689f73f16f3bc9b4c510c`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: Untrusted ZIP plus named-member extraction reaches Perl IO::Uncompress::Unzip fastForward; CPU exhaustion requires this consumer path.

Application exposure: Scanner attributes Perl source-package CVE to installed perl-base. Direct module loads show File::GlobMapper and IO::Uncompress::Unzip absent from default @INC (each exit2); IO::Compress is also absent. No application Perl caller found. This is evidence of affected component absence, not an exploit run.

Release disposition: Candidate component-not-present disposition; no application correction indicated by this finding. Preserve raw CVE and review the scoped disposition rather than suppressing it globally.

Smallest correction/evidence: Document absence in the exact image and avoid adding these modules; if later needed, use IO::Compress2.220+ or the vendor-fixed package. Scout lists no Bookworm fix; other-release versions do not directly patch this image.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-48959?s=debian&n=perl&ns=debian&t=deb&osn=debian&osv=12&vr=%3E0)

## backend — CVE-2026-69152 (HIGH)

Package: `pkg:npm/brace-expansion@5.0.7`.

Reported fixed version: **5.0.9**; affected range: `>=4.0.0,<5.0.9`.

Exact location layer diff IDs: `sha256:0dde8ff85f5f8ef28637238bf773b77a5702c09f2a5c5bf7717810ad03e30e60`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: Untrusted brace patterns reach intermediate arrays/padded sequences; the5.0.8 fix is incomplete, permitting memory/CPU exhaustion.

Application exposure: Only reported copy is under /usr/local/lib/node_modules/npm/node_modules, introduced by the Node distribution layer. Server starts directly as node server.js. Bounded application search found no use of this bundled component; package-install/build tooling remains an exposure boundary, and owner-only auth does not make it harmless.

Release disposition: Residual tooling risk: no confirmed HTTP trading path, but not covered by the prior application-lock audit or a blanket image exception. Blocks promotion until removed/patched or explicitly accepted with bounded conditions.

Smallest correction/evidence: Smallest runtime-only approach: omit unused npm from the final backend runtime after validating startup; retain a separate build toolchain. Alternatively select a supported npm distribution containing brace-expansion>=5.0.9 and resolve all bundled advisories. These are Scout-reported minima, not an approved new runtime pin; do not edit global vendored files ad hoc.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-69152?s=github&n=brace-expansion&t=npm&vr=%3E%3D4.0.0%2C%3C5.0.9)

## backend — CVE-2026-73566 (HIGH)

Package: `pkg:npm/tar@7.5.19`.

Reported fixed version: **7.5.21**; affected range: `<=7.5.20`.

Exact location layer diff IDs: `sha256:0dde8ff85f5f8ef28637238bf773b77a5702c09f2a5c5bf7717810ad03e30e60`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: A consumer lists/extracts selected members of an untrusted tar with a very deep path; recursive filesFilter processing exhausts the stack.

Application exposure: Only reported copy is under /usr/local/lib/node_modules/npm/node_modules, introduced by the Node distribution layer. Server starts directly as node server.js. Bounded application search found no use of this bundled component; package-install/build tooling remains an exposure boundary, and owner-only auth does not make it harmless.

Release disposition: Residual tooling risk: no confirmed HTTP trading path, but not covered by the prior application-lock audit or a blanket image exception. Blocks promotion until removed/patched or explicitly accepted with bounded conditions.

Smallest correction/evidence: Smallest runtime-only approach: omit unused npm from the final backend runtime after validating startup; retain a separate build toolchain. Alternatively select a supported npm distribution containing tar>=7.5.21 and resolve all bundled advisories. These are Scout-reported minima, not an approved new runtime pin; do not edit global vendored files ad hoc.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-73566?s=github&n=tar&t=npm&vr=%3C%3D7.5.20)

## backend — CVE-2026-69192 (HIGH)

Package: `pkg:npm/ip-address@10.2.0`.

Reported fixed version: **10.3.1**; affected range: `<=10.3.0`.

Exact location layer diff IDs: `sha256:0dde8ff85f5f8ef28637238bf773b77a5702c09f2a5c5bf7717810ad03e30e60`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: A consumer uses ip-address classification as an SSRF trust boundary; leading-zero IPv4 octets are interpreted differently by the eventual network parser.

Application exposure: Only reported copy is under /usr/local/lib/node_modules/npm/node_modules, introduced by the Node distribution layer. Server starts directly as node server.js. Bounded application search found no use of this bundled component; package-install/build tooling remains an exposure boundary, and owner-only auth does not make it harmless.

Release disposition: Residual tooling risk: no confirmed HTTP trading path, but not covered by the prior application-lock audit or a blanket image exception. Blocks promotion until removed/patched or explicitly accepted with bounded conditions.

Smallest correction/evidence: Smallest runtime-only approach: omit unused npm from the final backend runtime after validating startup; retain a separate build toolchain. Alternatively select a supported npm distribution containing ip-address>=10.3.1 and resolve all bundled advisories. These are Scout-reported minima, not an approved new runtime pin; do not edit global vendored files ad hoc.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-69192?s=github&n=ip-address&t=npm&vr=%3C%3D10.3.0)

## backend — CVE-2026-78410 (HIGH)

Package: `pkg:deb/debian/util-linux@2.38.1-5%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12`.

Reported fixed version: **not fixed**; affected range: `>0`.

Exact location layer diff IDs: `sha256:13a56b6535801be2adde694dabaf1c2df1d862a390661907dac821c42cd565cc`, `sha256:333672ac957fc91eaa777994fc6710227f60ab7d875689f73f16f3bc9b4c510c`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: A local user must race an authorized bind-mount source or writable ancestor; SUID mount and X-mount.owner/group/mode hooks provide the privileged effect.

Application exposure: Backend contains util-linux mount/nsenter. Its fstab is unconfigured and bounded application search found no mount/nsenter/subprocess caller. Required privileged/local/configuration path is not established for the paper HTTP workload. Deployment privilege configuration is not certified by this scan.

Release disposition: Residual base-utility risk; no reproduced application exploit. No documented general acceptance policy covers it, so retain promotion hold pending mitigation or owner acceptance.

Smallest correction/evidence: Use a vendor-corrected base/backport or an intentionally minimal runtime without unused affected tools, then verify dependencies and scan. Upstream advisories identify2.41.6/2.42.3; Scout reports no Bookworm fix. Do not transplant another distribution package blindly.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-78410?s=debian&n=util-linux&ns=debian&t=deb&osn=debian&osv=12&vr=%3E0)

## backend — CVE-2026-78408 (HIGH)

Package: `pkg:deb/debian/util-linux@2.38.1-5%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12`.

Reported fixed version: **not fixed**; affected range: `>0`.

Exact location layer diff IDs: `sha256:13a56b6535801be2adde694dabaf1c2df1d862a390661907dac821c42cd565cc`, `sha256:333672ac957fc91eaa777994fc6710227f60ab7d875689f73f16f3bc9b4c510c`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: A privileged operator must invoke util-linux nsenter --join-cgroup against an attacker-controlled target; an inherited cgroup descriptor retains root migration authority.

Application exposure: Backend contains util-linux mount/nsenter. Its fstab is unconfigured and bounded application search found no mount/nsenter/subprocess caller. Required privileged/local/configuration path is not established for the paper HTTP workload. Deployment privilege configuration is not certified by this scan.

Release disposition: Residual base-utility risk; no reproduced application exploit. No documented general acceptance policy covers it, so retain promotion hold pending mitigation or owner acceptance.

Smallest correction/evidence: Use a vendor-corrected base/backport or an intentionally minimal runtime without unused affected tools, then verify dependencies and scan. Upstream advisories identify2.41.6/2.42.3; Scout reports no Bookworm fix. Do not transplant another distribution package blindly.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-78408?s=debian&n=util-linux&ns=debian&t=deb&osn=debian&osv=12&vr=%3E0)

## backend — CVE-2026-86145 (HIGH)

Package: `pkg:deb/debian/pcre2@10.42-1?os_distro=bookworm&os_name=debian&os_version=12`.

Reported fixed version: **10.42-1+deb12u1**; affected range: `<10.42-1+deb12u1`.

Exact location layer diff IDs: `sha256:13a56b6535801be2adde694dabaf1c2df1d862a390661907dac821c42cd565cc`, `sha256:333672ac957fc91eaa777994fc6710227f60ab7d875689f73f16f3bc9b4c510c`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: A PCRE2 DFA consumer processes attacker-controlled regex, or a recursive pattern with a small heap limit, reusing an undersized cached workspace.

Application exposure: libpcre2-8 is present in the OS. Node ldd output does not link it and bounded server search found no PCRE2/subprocess use. JavaScript regex does not establish use of these C APIs. Other OS consumers/configurations remain possible; no HTTP exploit reproduced.

Release disposition: Fixable base-library finding with no confirmed application path. Retain security hold pending patch or explicit residual acceptance; prefer the small available vendor update.

Smallest correction/evidence: Update libpcre2-8-0 through the Bookworm security package10.42-1+deb12u1 (Scout reports this for both; Debian independently confirms CVE-86145), retain approved Node pin where possible, rebuild/re-scan and verify Linux startup plus applicable combined checks.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-86145?s=debian&n=pcre2&ns=debian&t=deb&osn=debian&osv=12&vr=%3C10.42-1%2Bdeb12u1)

## backend — CVE-2026-85091 (HIGH)

Package: `pkg:deb/debian/zlib@1%3A1.2.13.dfsg-1?os_distro=bookworm&os_name=debian&os_version=12`.

Reported fixed version: **not fixed**; affected range: `>0`.

Exact location layer diff IDs: `sha256:13a56b6535801be2adde694dabaf1c2df1d862a390661907dac821c42cd565cc`, `sha256:333672ac957fc91eaa777994fc6710227f60ab7d875689f73f16f3bc9b4c510c`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: Nonblocking gzwrite stalls followed by gzprintf/gzvprintf with stale buffers reach gz_vacate. Advisory description names1.3.1.2–1.3.2 but Debian marks installed1.2.13 vulnerable: applicability requires vendor/backport confirmation.

Application exposure: OS zlib1.2.13 is present. Node ldd does not link this libz; app search found no gzprintf consumer. Source-version description and vendor affected table disagree; no vulnerable-code backport proof was established.

Release disposition: Applicability unresolved; do not label clean or waive. Blocks security acceptance until vendor/code evidence resolves it or a corrected base is verified.

Smallest correction/evidence: Resolve the1.2.13 versus1.3.1.2+ applicability discrepancy with vendor/backport evidence first. No fixed Bookworm version reported; do not propose a speculative version upgrade as a proven fix.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-85091?s=debian&n=zlib&ns=debian&t=deb&osn=debian&osv=12&vr=%3E0)

## backend — CVE-2026-57432 (HIGH)

Package: `pkg:deb/debian/perl@5.36.0-7%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12`.

Reported fixed version: **not fixed**; affected range: `>0`.

Exact location layer diff IDs: `sha256:13a56b6535801be2adde694dabaf1c2df1d862a390661907dac821c42cd565cc`, `sha256:333672ac957fc91eaa777994fc6710227f60ab7d875689f73f16f3bc9b4c510c`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: An attacker-controlled Perl pack/unpack template with a large repeat count overflows a length accumulator and can disclose heap bytes.

Application exposure: Perl-base5.36.0-7+deb12u3 is installed; Socket2.033 confirmed. Bounded production source search found no Perl invocation. No exploit through the owner-paper service was reproduced; component presence and application reachability are distinct.

Release disposition: Residual/unresolved Perl risk; no blanket owner-only exemption. Blocks promotion until vendor applicability/mitigation is established or owner explicitly accepts the documented bounded risk.

Smallest correction/evidence: Prefer a supported vendor-corrected/minimal runtime with unneeded Perl omitted only after dependency validation. Scout has no Bookworm fix; vendor lists fixed other-release Perl5.40.1-6+deb13u1, not a drop-in Bookworm update. For CVE-13221 resolve contradictory introduction-version evidence before proposing a patch; for Socket the standalone upstream fixed version is2.041.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-57432?s=debian&n=perl&ns=debian&t=deb&osn=debian&osv=12&vr=%3E0)

## backend — CVE-2026-76642 (HIGH)

Package: `pkg:deb/debian/util-linux@2.38.1-5%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12`.

Reported fixed version: **not fixed**; affected range: `>0`.

Exact location layer diff IDs: `sha256:13a56b6535801be2adde694dabaf1c2df1d862a390661907dac821c42cd565cc`, `sha256:333672ac957fc91eaa777994fc6710227f60ab7d875689f73f16f3bc9b4c510c`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: A privileged external mount helper fails, but X-mount post-hooks still run against an existing filesystem; restricted-user authorization and configured hooks are prerequisites.

Application exposure: Backend contains util-linux mount/nsenter. Its fstab is unconfigured and bounded application search found no mount/nsenter/subprocess caller. Required privileged/local/configuration path is not established for the paper HTTP workload. Deployment privilege configuration is not certified by this scan.

Release disposition: Residual base-utility risk; no reproduced application exploit. No documented general acceptance policy covers it, so retain promotion hold pending mitigation or owner acceptance.

Smallest correction/evidence: Use a vendor-corrected base/backport or an intentionally minimal runtime without unused affected tools, then verify dependencies and scan. Upstream advisories identify2.41.6/2.42.3; Scout reports no Bookworm fix. Do not transplant another distribution package blindly.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-76642?s=debian&n=util-linux&ns=debian&t=deb&osn=debian&osv=12&vr=%3E0)

## backend — CVE-2026-12087 (CRITICAL)

Package: `pkg:deb/debian/perl@5.36.0-7%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12`.

Reported fixed version: **not fixed**; affected range: `>0`.

Exact location layer diff IDs: `sha256:13a56b6535801be2adde694dabaf1c2df1d862a390661907dac821c42cd565cc`, `sha256:333672ac957fc91eaa777994fc6710227f60ab7d875689f73f16f3bc9b4c510c`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: Perl Socket pack_ip_mreq_source receives a source shorter than four bytes and returns adjacent heap bytes. Socket2.033 is installed; no application caller was found.

Application exposure: Perl-base5.36.0-7+deb12u3 is installed; Socket2.033 confirmed. Bounded production source search found no Perl invocation. No exploit through the owner-paper service was reproduced; component presence and application reachability are distinct.

Release disposition: Residual/unresolved Perl risk; no blanket owner-only exemption. Blocks promotion until vendor applicability/mitigation is established or owner explicitly accepts the documented bounded risk.

Smallest correction/evidence: Prefer a supported vendor-corrected/minimal runtime with unneeded Perl omitted only after dependency validation. Scout has no Bookworm fix; vendor lists fixed other-release Perl5.40.1-6+deb13u1, not a drop-in Bookworm update. For CVE-13221 resolve contradictory introduction-version evidence before proposing a patch; for Socket the standalone upstream fixed version is2.041.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-12087?s=debian&n=perl&ns=debian&t=deb&osn=debian&osv=12&vr=%3E0)

## backend — CVE-2026-13221 (CRITICAL)

Package: `pkg:deb/debian/perl@5.36.0-7%2Bdeb12u3?os_distro=bookworm&os_name=debian&os_version=12`.

Reported fixed version: **not fixed**; affected range: `>0`.

Exact location layer diff IDs: `sha256:13a56b6535801be2adde694dabaf1c2df1d862a390661907dac821c42cd565cc`, `sha256:333672ac957fc91eaa777994fc6710227f60ab7d875689f73f16f3bc9b4c510c`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: Perl compiles over65535 fixed alternatives into a trie used for a security/filter decision. The tracker says vulnerable but notes introduction in5.37.10, newer than installed5.36: applicability is unresolved, not declared false positive.

Application exposure: Perl-base5.36.0-7+deb12u3 is installed; Socket2.033 confirmed. Bounded production source search found no Perl invocation. No exploit through the owner-paper service was reproduced; component presence and application reachability are distinct.

Release disposition: Residual/unresolved Perl risk; no blanket owner-only exemption. Blocks promotion until vendor applicability/mitigation is established or owner explicitly accepts the documented bounded risk.

Smallest correction/evidence: Prefer a supported vendor-corrected/minimal runtime with unneeded Perl omitted only after dependency validation. Scout has no Bookworm fix; vendor lists fixed other-release Perl5.40.1-6+deb13u1, not a drop-in Bookworm update. For CVE-13221 resolve contradictory introduction-version evidence before proposing a patch; for Socket the standalone upstream fixed version is2.041.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-13221?s=debian&n=perl&ns=debian&t=deb&osn=debian&osv=12&vr=%3E0)

## frontend — CVE-2026-78409 (HIGH)

Package: `pkg:apk/alpine/util-linux@2.42.1-r0?os_name=alpine&os_version=3.24`.

Reported fixed version: **2.42.3-r0**; affected range: `<2.42.3-r0`.

Exact location layer diff IDs: `sha256:b7596e109f91f945955bdcc910f626eb94de28200fff0a05266f3a10431328cc`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: A local user needs an fstab-authorized X-mount.subdir entry and the detached-tree path on Linux6.15+, with attacker-controlled intermediate symlink/procfs resolution.

Application exposure: Installed binary package is libuuid2.42.1-r0; reported library /usr/lib/libuuid.so.1.3.0. mount/nsenter are BusyBox links, not util-linux implementations. fstab contains ordinary removable-media entries, no X-mount hooks. Static nginx does not invoke these privileged tools. This component-specific evidence supports affected functionality absent in this exact final image; it is not a generic nginx exemption.

Release disposition: Candidate not-affected disposition for this exact component set; no demonstrated paper-application exploit. Preserve raw source-package finding. No general residual-risk waiver inferred.

Smallest correction/evidence: No application change indicated. Record/review component-specific not-affected evidence; alternatively refresh the final base libuuid package to a vendor-corrected release. Scout says2.42.3-r0; CVE-78408 affected range instead says<2.42.3-r1, so verify vendor correction and use a release outside that range before claiming patched.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-78409?s=alpine&n=util-linux&ns=alpine&t=apk&osn=alpine&osv=3.24&vr=%3C2.42.3-r0)

## frontend — CVE-2026-78410 (HIGH)

Package: `pkg:apk/alpine/util-linux@2.42.1-r0?os_name=alpine&os_version=3.24`.

Reported fixed version: **2.42.3-r0**; affected range: `<2.42.3-r0`.

Exact location layer diff IDs: `sha256:b7596e109f91f945955bdcc910f626eb94de28200fff0a05266f3a10431328cc`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: A local user must race an authorized bind-mount source or writable ancestor; SUID mount and X-mount.owner/group/mode hooks provide the privileged effect.

Application exposure: Installed binary package is libuuid2.42.1-r0; reported library /usr/lib/libuuid.so.1.3.0. mount/nsenter are BusyBox links, not util-linux implementations. fstab contains ordinary removable-media entries, no X-mount hooks. Static nginx does not invoke these privileged tools. This component-specific evidence supports affected functionality absent in this exact final image; it is not a generic nginx exemption.

Release disposition: Candidate not-affected disposition for this exact component set; no demonstrated paper-application exploit. Preserve raw source-package finding. No general residual-risk waiver inferred.

Smallest correction/evidence: No application change indicated. Record/review component-specific not-affected evidence; alternatively refresh the final base libuuid package to a vendor-corrected release. Scout says2.42.3-r0; CVE-78408 affected range instead says<2.42.3-r1, so verify vendor correction and use a release outside that range before claiming patched.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-78410?s=alpine&n=util-linux&ns=alpine&t=apk&osn=alpine&osv=3.24&vr=%3C2.42.3-r0)

## frontend — CVE-2026-78408 (HIGH)

Package: `pkg:apk/alpine/util-linux@2.42.1-r0?os_name=alpine&os_version=3.24`.

Reported fixed version: **2.42.3-r0**; affected range: `<2.42.3-r1`.

Exact location layer diff IDs: `sha256:b7596e109f91f945955bdcc910f626eb94de28200fff0a05266f3a10431328cc`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: A privileged operator must invoke util-linux nsenter --join-cgroup against an attacker-controlled target; an inherited cgroup descriptor retains root migration authority.

Application exposure: Installed binary package is libuuid2.42.1-r0; reported library /usr/lib/libuuid.so.1.3.0. mount/nsenter are BusyBox links, not util-linux implementations. fstab contains ordinary removable-media entries, no X-mount hooks. Static nginx does not invoke these privileged tools. This component-specific evidence supports affected functionality absent in this exact final image; it is not a generic nginx exemption.

Release disposition: Candidate not-affected disposition for this exact component set; no demonstrated paper-application exploit. Preserve raw source-package finding. No general residual-risk waiver inferred.

Smallest correction/evidence: No application change indicated. Record/review component-specific not-affected evidence; alternatively refresh the final base libuuid package to a vendor-corrected release. Scout says2.42.3-r0; CVE-78408 affected range instead says<2.42.3-r1, so verify vendor correction and use a release outside that range before claiming patched.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-78408?s=alpine&n=util-linux&ns=alpine&t=apk&osn=alpine&osv=3.24&vr=%3C2.42.3-r1)

## frontend — CVE-2026-76642 (HIGH)

Package: `pkg:apk/alpine/util-linux@2.42.1-r0?os_name=alpine&os_version=3.24`.

Reported fixed version: **2.42.3-r0**; affected range: `<2.42.3-r0`.

Exact location layer diff IDs: `sha256:b7596e109f91f945955bdcc910f626eb94de28200fff0a05266f3a10431328cc`. Package locations are preserved in the JSON; shared dpkg status metadata may span more than one OS layer.

Prerequisites: A privileged external mount helper fails, but X-mount post-hooks still run against an existing filesystem; restricted-user authorization and configured hooks are prerequisites.

Application exposure: Installed binary package is libuuid2.42.1-r0; reported library /usr/lib/libuuid.so.1.3.0. mount/nsenter are BusyBox links, not util-linux implementations. fstab contains ordinary removable-media entries, no X-mount hooks. Static nginx does not invoke these privileged tools. This component-specific evidence supports affected functionality absent in this exact final image; it is not a generic nginx exemption.

Release disposition: Candidate not-affected disposition for this exact component set; no demonstrated paper-application exploit. Preserve raw source-package finding. No general residual-risk waiver inferred.

Smallest correction/evidence: No application change indicated. Record/review component-specific not-affected evidence; alternatively refresh the final base libuuid package to a vendor-corrected release. Scout says2.42.3-r0; CVE-78408 affected range instead says<2.42.3-r1, so verify vendor correction and use a release outside that range before claiming patched.

[Scanner advisory](https://scout.docker.com/v/CVE-2026-76642?s=alpine&n=util-linux&ns=alpine&t=apk&osn=alpine&osv=3.24&vr=%3C2.42.3-r0)

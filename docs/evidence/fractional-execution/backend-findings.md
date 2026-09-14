# Fractional backend image scan

Successful unfiltered analysis with findings; exit 2. Docker Scout v1.23.1. Exact image `sha256:f663986b263b6d2dcb4453d2c912971178639c7a65890f2b54e29c5f12d759a7`, Linux arm64.

{'CRITICAL': 0, 'HIGH': 0, 'MEDIUM': 1, 'LOW': 8, 'UNKNOWN': 0}

No Critical/High finding was reported. All findings and scanner-provided locations are retained below. Absence of a match is not proof of absence. Existing browser/build-chain findings remain separate.

## CVE-2010-4756 — LOW

pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12

Fixed version: not fixed

Locations: /usr/share/doc/libc6/copyright, /var/lib/dpkg/status

The glob implementation in the GNU C Library (aka glibc or libc6) allows remote authenticated users to cause a denial of service (CPU and memory consumption) via crafted glob expressions that do not match any pathnames, as demonstrated by glob expressions in STAT commands to an FTP daemon, a different vulnerability than CVE-2010-2632.

---
- glibc <removed> (unimportant)
- eglibc <unfixed> (unimportant)
That's standard POSIX behaviour implemented by (e)glibc. Applications using
glob need to impose limits for themselves


## CVE-2018-20796 — LOW

pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12

Fixed version: not fixed

Locations: /usr/share/doc/libc6/copyright, /var/lib/dpkg/status

In the GNU C Library (aka glibc or libc6) through 2.29, check_dst_limits_calc_pos_1 in posix/regexec.c has Uncontrolled Recursion, as demonstrated by '(\227|)(\\1\\1|t1|\\\2537)+' in grep.

---
- glibc <unfixed> (unimportant)
- eglibc <removed> (unimportant)
https://debbugs.gnu.org/cgi/bugreport.cgi?bug=34141
https://lists.gnu.org/archive/html/bug-gnulib/2019-01/msg00108.html
No treated as vulnerability: https://sourceware.org/glibc/wiki/Security%20Exceptions


## CVE-2019-1010022 — LOW

pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12

Fixed version: not fixed

Locations: /usr/share/doc/libc6/copyright, /var/lib/dpkg/status

GNU Libc current is affected by: Mitigation bypass. The impact is: Attacker may bypass stack guard protection. The component is: nptl. The attack vector is: Exploit stack buffer overflow vulnerability and use this bypass vulnerability to bypass stack guard. NOTE: Upstream comments indicate "this is being treated as a non-security bug and no real threat.

---
- glibc <unfixed> (unimportant)
Not treated as a security issue by upstream
https://sourceware.org/bugzilla/show_bug.cgi?id=22850


## CVE-2019-1010023 — LOW

pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12

Fixed version: not fixed

Locations: /usr/share/doc/libc6/copyright, /var/lib/dpkg/status

GNU Libc current is affected by: Re-mapping current loaded library with malicious ELF file. The impact is: In worst case attacker may evaluate privileges. The component is: libld. The attack vector is: Attacker sends 2 ELF files to victim and asks to run ldd on it. ldd execute code. NOTE: Upstream comments indicate "this is being treated as a non-security bug and no real threat.

---
- glibc <unfixed> (unimportant)
Not treated as a security issue by upstream
https://sourceware.org/bugzilla/show_bug.cgi?id=22851


## CVE-2019-1010024 — LOW

pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12

Fixed version: not fixed

Locations: /usr/share/doc/libc6/copyright, /var/lib/dpkg/status

GNU Libc current is affected by: Mitigation bypass. The impact is: Attacker may bypass ASLR using cache of thread stack and heap. The component is: glibc. NOTE: Upstream comments indicate "this is being treated as a non-security bug and no real threat.

---
- glibc <unfixed> (unimportant)
Not treated as a security issue by upstream
https://sourceware.org/bugzilla/show_bug.cgi?id=22852


## CVE-2019-1010025 — LOW

pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12

Fixed version: not fixed

Locations: /usr/share/doc/libc6/copyright, /var/lib/dpkg/status

GNU Libc current is affected by: Mitigation bypass. The impact is: Attacker may guess the heap addresses of pthread_created thread. The component is: glibc. NOTE: the vendor's position is "ASLR bypass itself is not a vulnerability.

---
- glibc <unfixed> (unimportant)
Not treated as a security issue by upstream
https://sourceware.org/bugzilla/show_bug.cgi?id=22853


## CVE-2019-9192 — LOW

pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12

Fixed version: not fixed

Locations: /usr/share/doc/libc6/copyright, /var/lib/dpkg/status

In the GNU C Library (aka glibc or libc6) through 2.29, check_dst_limits_calc_pos_1 in posix/regexec.c has Uncontrolled Recursion, as demonstrated by '(|)(\\1\\1)*' in grep, a different issue than CVE-2018-20796. NOTE: the software maintainer disputes that this is a vulnerability because the behavior occurs only with a crafted pattern

---
- glibc <unfixed> (unimportant)
- eglibc <removed> (unimportant)
https://sourceware.org/bugzilla/show_bug.cgi?id=24269


## CVE-2022-27943 — LOW

pkg:deb/debian/gcc-12@12.2.0-14%2Bdeb12u1?os_distro=bookworm&os_name=debian&os_version=12

Fixed version: not fixed

Locations: /usr/share/doc/libgcc-s1/copyright, /usr/share/doc/libstdc++6/copyright, /var/lib/dpkg/status

libiberty/rust-demangle.c in GNU GCC 11.2 allows stack consumption in demangle_const, as demonstrated by nm-new.

---
- gcc-12 <unfixed> (unimportant)
Negligible security impact
https://gcc.gnu.org/bugzilla/show_bug.cgi?id=105039


## CVE-2026-89092 — MEDIUM

pkg:deb/debian/glibc@2.36-9%2Bdeb12u14?os_distro=bookworm&os_name=debian&os_version=12

Fixed version: not fixed

Locations: /usr/share/doc/libc6/copyright, /var/lib/dpkg/status

The nscd service in the GNU C Library 2.3.4 onwards may crash due to a  stack overflow when a malicious DNS server returns too large a response  for a DNS query, resulting in degraded DNS resolution for the system.    Exploitation of this bug needs a system that has nscd enabled and using  an untrusted DNS server for name resolution, with the compromised DNS  server being capable of processing records large enough to result in a  stack overflow in an nscd thread stack.  During experimentation, bind 9  was unable to handle large records, but that could change in future or  with a different name server.  In typical installations, nscd is  executed in an isolated context as its own user without a shell, due to  which any compromise of that service is isolated.    There is a remote possibility of nscd cache corruption if an attacker  manages to get the stack pointer into a desired point in the heap,  potentially resulting in other caches in nscd being overwritten with  corrupt data through the stack overflow, until the buggy code path  eventually results in a crash.    Finally, a crash in nscd may result in performance degradation when  resolving names, but it does not result in a denial of service.

---
- glibc <unfixed> (bug https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=1147395)
[trixie] - glibc <no-dsa> (Minor issue)
https://sourceware.org/bugzilla/show_bug.cgi?id=34624
https://sourceware.org/git/?p=glibc.git;a=blob;f=advisories/GLIBC-SA-2026-0016

# Supplemental frontend zlib disposition: CVE-2026-85091

**C — NOT REACHABLE — VERIFIED** for frontend image `sha256:a7aa7e54a5c65283c7851987f64cfa83352d40c9f11ea4fbac502e27ba1b5c2e`, with the inspected static nginx configuration and shipped binaries. This is supplemental component analysis of retained Alpine `zlib 1.3.2-r0`, separate from the zero-CVE Scout result. Scanner silence is not the justification.

## Applicability and vendor record

The [official Alpine 3.24 APKBUILD](https://github.com/alpinelinux/aports/blob/3.24-stable/main/zlib/APKBUILD) selects upstream zlib 1.3.2 without a patch list. The current [Alpine 3.24 security database](https://secdb.alpinelinux.org/v3.24/main.json) has no entry for CVE-2026-85091 in the zlib record. Saved `alpine-zlib-APKBUILD`, `alpine-zlib-secdb-selected.json`, and `frontend-retrieval.json` preserve that fact. Absence from secfixes establishes neither fixed nor not-affected status.

The official upstream archive at `https://zlib.net/fossils/zlib-1.3.2.tar.gz` was downloaded using verified HTTPS. Its SHA-512 exactly matches the checksum in Alpine's APKBUILD. `alpine-upstream-source-proof.json` records that verification. The extracted `alpine-zlib-upstream-gzwrite.c` has SHA-256 `2ce783294c688330c716bfe106f43167d3dae5be84994176bc304d205d4f5b04`, byte-for-byte identical to the affected-looking Node-bundled source examined in `README.md`. It retains the unchecked `gz_vacate` copy at line 393. Thus this review does not use the old Debian 1.2.13 version contradiction to dispute applicability of the newer, present frontend source.

No supported fix is established in this vendor record. The affected gzip-file implementation is present, so neither A — FIXED nor B — NOT AFFECTED through code absence is claimed. Alpine's omission and Scout's zero result are a coverage gap rather than a positive vendor claim contradicting the source evidence. The disposition instead resolves the deployed call-path question independently.

## Exact image and positive runtime evidence

`frontend-elf-review.json` comes from a read-only layer-overlay analysis of the parent's exact local archive. It records all 23 final regular ELF binaries/shared libraries, their hashes, defining layers, dynamic dependencies, relevant dynamic symbols, symlinks, and shipped nginx configuration. The manifest config hash independently reproduces the image ID above. `inspect-elf.py frontend /private/tmp/day-trader-hardened-frontend.tar` reproduces this analysis without running image code.

The installed `/usr/lib/libz.so.1.3.2` defines `gzwrite`, `gzprintf`, and `gzvprintf`, along with the gzip-file API family. **None of the 23 ELF files imports any `gz*` function.** The inspected consumers include nginx, nginx-debug, apk, libapk, and all shipped OpenSSL engine/provider shared objects. The nginx executables link libz but import its deflate/inflate stream API, not its gzip-file API.

The [official nginx 1.30.4 gzip filter](https://github.com/nginx/nginx/blob/release-1.30.4/src/http/modules/ngx_http_gzip_filter_module.c) operates on z_stream buffers and calls `deflate` at line 761; the [gunzip filter](https://github.com/nginx/nginx/blob/release-1.30.4/src/http/modules/ngx_http_gunzip_filter_module.c) calls `inflate` at line 438. Saved `nginx-gzip-filter.c` and `nginx-gunzip-filter.c` corroborate the binary imports. Network nonblocking writes in nginx do not transform these stream API calls into `gzwrite` or `gzprintf` calls.

The shipped main nginx configuration has no `load_module` directive and leaves `gzip on` commented out. Its only included site serves static files on port 8080 with the SPA fallback. Absence of gzip activation is additional evidence, not the primary argument: even nginx's standard gzip/gunzip filters use the unaffected API path for this specific flaw. The image has no application Node runtime or arbitrary-code module such as an nginx Lua/njs module. Dynamic loading support exists in nginx/OpenSSL, so arbitrary injected modules are expressly outside this disposition; shipped provider files were included in the ELF review.

## Scope, impact, and invalidation

Exploit prerequisites require an actual gzip-file writer holding a nonblocking descriptor, a stalled write retaining external-buffer state, and a subsequent formatted gzip write reaching `gz_vacate`. The inspected static nginx workload and every shipped ELF consumer lack imports for that file API. This concrete missing caller, supported by nginx source, establishes C for the exact image; lack of an application keyword alone would not suffice. No owner risk acceptance is required for this verified C disposition under the task's classification policy.

If a native caller is introduced, the relevant expected impact is heap corruption/process crash and potentially other memory-corruption consequences. Reopen the disposition on changes to the nginx version/build/modules or image base; addition or activation of load_module, native plugins, application server scripting, executables, shared objects, injected library mounts, or preload settings; altered startup/configuration that invokes a new gzip-file consumer; package/source updates; or upstream advisory changes to prerequisites. An operator's ability to replace configuration or inject arbitrary code is not silently covered.

This assessment does not assert that every use of zlib 1.3.2 is safe. If the stated absence of a caller cannot be preserved in deployment, downgrade to D pending renewed applicability/reachability evidence, or E if affected callable code remains and explicit residual acceptance is needed. No deployment, external request, package mutation, suppression, or image rebuild was performed by this reviewer.

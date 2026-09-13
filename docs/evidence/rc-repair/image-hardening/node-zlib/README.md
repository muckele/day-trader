# Node 24.21.0 embedded zlib: CVE-2026-85091 investigation

Reviewed 2026-09-13. This record distinguishes the removed Debian `libz` package from Node's remaining embedded `1.3.2.1-motley-8002e91` component. Version comparison alone is not a remediation argument. The sibling source files are the official `nodejs/node` `v24.21.0` sources; `retrieval.json` records verified-HTTPS retrievals and SHA-256 hashes. No code was patched, compiled, or exploited for this investigation.

## Exact source findings

The official bundled [`gzwrite.c`](https://github.com/nodejs/node/blob/v24.21.0/deps/zlib/gzwrite.c) retains the relevant vulnerable-looking implementation:

- `gz_init` allocates an input buffer with twice the configured size (line 16).
- `gz_comp` writes to a file descriptor and sets `state->again` on EAGAIN/EWOULDBLOCK (lines 71–88 and 110–123).
- The large-write branch of `gz_write` sets `strm.next_in` to the caller's buffer and can return on a nonblocking stall with unconsumed bytes (lines 233–246).
- `gz_vacate` calls `gz_comp`, then copies the remaining `avail_in` bytes to `state->in` before checking whether that length exceeds `state->size` (lines 382–395). There is no destination-capacity bound before the memmove.
- `gzvprintf` calls `gz_vacate` (lines 438 and 480); `gzprintf` delegates to `gzvprintf` in the normal stdarg implementation (lines 487–494).

This source does not establish a patch for the reported issue. It supports retaining the vulnerability concern whenever the gzip-file API implementation is present and callable. The bundled README.chromium identifies upstream zlib 1.3.2 and source revision `09a1572aa624e5ddb6c075dc013880de70b1b9b9`; the Node component suffix does not supersede code inspection.

## Compilation, linkage, and JavaScript API are separate questions

[`deps/zlib/BUILD.gn`](https://github.com/nodejs/node/blob/v24.21.0/deps/zlib/BUILD.gn) includes `gzwrite.c` in the zlib source set at line 311. [`deps/zlib/zlib.gyp`](https://github.com/nodejs/node/blob/v24.21.0/deps/zlib/zlib.gyp) builds a static-library target from that source list at lines 179–183. This proves inclusion in the compilation inputs; it does not prove every object or function survives linking into the official Node executable. `node.gyp` lines 635–658 explicitly whole-archive node_base and v8_base_without_compiler, not the zlib archive. Final executable evidence is required before calling gzip-file code absent or present.

The Node JavaScript binding has a materially different interface. The complete downloaded [`src/node_zlib.cc`](https://github.com/nodejs/node/blob/v24.21.0/src/node_zlib.cc) contains no calls to `gzwrite`, `gzprintf`, `gzvprintf`, `gzopen`, or `gzdopen`:

- `CompressionStream::Write` receives flush and input/output Buffer slices, checks bounds, then sets in-memory buffers (lines 491–575).
- `ZlibContext::DoThreadPoolWork` calls `deflate` for DEFLATE/GZIP/DEFLATERAW and `inflate` for decompression modes (lines 1062–1165). GZIP mode denotes the compression format; it does not switch to the gzip-file API.
- The registered stream methods are write, writeSync, close, init, params, and reset (lines 1822–1837). Module initialization registers the compression classes and crc32 (lines 1892–1907).
- `lib/zlib.js` obtains this internal binding at line 60 and constructs `binding.Zlib` at line 691. Piping a JavaScript gzip stream into a Node file stream still uses this Buffer/deflate path; it does not supply a native `gzFile` handle or invoke formatted gzip-file writes.

These are positive interface and call-path observations, not merely a negative application keyword search. They support a bounded not-reachable assessment for this CVE through the standard JavaScript zlib binding. They do not imply the entire zlib library is vulnerability-free or that arbitrary native extensions cannot call its C APIs.

## Exact backend executable findings

The parent extracted `/usr/local/bin/node` from backend image `sha256:7f640e73b61a18bb2ef2914dbef374ed89528aebe3a81e9fe9567f161a9a6019`, layer `sha256:2b391457ac2b2d3de128a4fc7541f081d4b50f27c2ec2a5d063e0a9c17b9bde6`. This reviewer independently verified its SHA-256 as `0f8949d1028f6d61506b2d5bc57e7e6fe893d7b1997509b7847294fc9c616584` and parsed its ELF64 little-endian AArch64 section/symbol records. The executable contains a dynamic symbol table with 38,892 entries and a full symbol table with 239,295 entries.

`backend-node-elf-symbols.json` records defined, default-visible global functions including `gzwrite` (`0x18b59f0`), `gzvprintf` (`0x18b5d00`), and `gzprintf` (`0x18b5fa0`). They are present in both symbol tables. `gz_vacate` is not a separately named function; its absence as a symbol does not establish code absence because optimization can inline it. The exact source plus existing formatted gzip-write functions precludes an A/B absence argument.

`backend-node-gzip-direct-calls.json` records direct AArch64 B/BL instruction analysis over executable PROGBITS sections, matching targets against all 47 named gzip-file function symbols. All 101 direct branches into those functions originate in other gzip-file functions. No non-gzip function directly calls this API family in the inspected binary. This is corroborating machine-code evidence; it does not resolve indirect calls or prove arbitrary native code could not call exported functions.

## Locked application check and limitations

`local-app-static-checks.json` records the current lockfile SHA-256, no local `.node` addons, no lockfile installation/platform indicators, and no JavaScript/JSON reference to the gzip-file APIs, process.dlopen, or the examined FFI package names in the local backend dependency tree. This is corroborating evidence only. The candidate's exported app tree must independently pass the assembler's native/ELF rejection and absence assertions, since local macOS dependencies cannot prove final Linux contents.

The parent-provided final `../backend-runtime-provenance.json` has the same Node binary hash verified above and `nativeAddons: []`. The reviewed assembler inspects the exported `/runtime-root/app` tree and rejects both `.node` extensions and ELF magic, closing the earlier symlink-copy omission. `../backend-inspect.json` binds the candidate to the ordinary `/usr/local/bin/node server.js` command. The locked dependency inspection found no FFI package or process.dlopen/gzip-file call path. These checks establish the concrete image/startup prerequisites for the C disposition; owner-only access is not its justification.

## Vendor status and conservative decision

The [Debian tracker](https://security-tracker.debian.org/tracker/CVE-2026-85091) still has the previously documented Bookworm source-version contradiction. That contradiction concerns the removed Debian package and cannot establish safety for Node's newer embedded source. The [upstream issue](https://github.com/madler/zlib/issues/1310) was open at retrieval. Its two comments are from nonmembers; one offers an explicitly unreviewed AI-suggested patch. No maintainer confirmation or vendor-approved fix appears in the saved issue/comments. That patch is not remediation evidence and was not applied.

Final bounded backend decision:

- **A — FIXED:** not established for the embedded component; relevant unchecked-copy code remains in exact source.
- **B — NOT AFFECTED — VERIFIED:** ruled out as a code-absence argument for this backend executable; the affected API functions are defined and exported.
- **C — NOT REACHABLE — VERIFIED: selected disposition for backend image `sha256:7f640e73b61a18bb2ef2914dbef374ed89528aebe3a81e9fe9567f161a9a6019`.** The affected implementation is present and exported, but the shipped JavaScript binding uses Buffer-based deflate/inflate, and the inspected locked application has no native addon/FFI path into gzip-file functions. The exact binary's absence of non-gzip direct callers corroborates that boundary.
- **D — VENDOR/APPLICABILITY DISPUTE:** retain as a release blocker if exact-image absence or the bounded C prerequisite evidence is not established. Do not silently pass based on the version suffix, removal of OS libz, or an empty scanner result.
- **E — RESIDUAL RISK — OWNER ACCEPTANCE REQUIRED:** appropriate if affected gzip-file code remains callable through a shipped or enabled native path and no supported fix/removal is available; that situation would require an explicit bounded acceptance, not a blanket waiver.

This C disposition applies only to the exact image and inspected locked startup. It does not require accepting a demonstrated reachable vulnerability, does not claim zlib is patched, and does not override unrelated release gates. Native code with access to the exported gzip-file API could create the required nonblocking gzip handle and invoke the vulnerable sequence; the present runtime does not provide that caller. Expected impact if that boundary changes is heap corruption, including process crash and potentially other memory-corruption consequences.

Invalidate and repeat this assessment on a Node binary/pin or zlib change; backend lockfile/application change introducing native/FFI/subprocess execution; any native addon, shared object, alternate executable, or injected library mount; loader/preload or startup option changes that introduce native code; or an upstream advisory changing the exploit prerequisites. Do not extend it to custom Node embeddings, arbitrary admin-supplied native code, or other images. The old Debian 1.2.13 source-version conflict remains preserved as historical evidence; it is not used to justify the remaining Node component.

`inspect-elf.py` reproduces the read-only backend symbol/direct-call analysis and the frontend final-overlay ELF inventory. Its direct-call limitation is explicit. See `frontend-disposition.md` for the separately assessed retained Alpine zlib library.

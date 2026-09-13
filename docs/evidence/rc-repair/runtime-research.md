# Supported runtime preparation

Official pages were re-read on 2026-09-13 during repair preparation. [Node release lifecycle](https://nodejs.org/en/about/previous-releases) classifies Node 20 as EOL and Node 24 as LTS. [Node 24 archive](https://nodejs.org/en/download/archive/v24) lists 24.21.0 as its latest release; [24.21.0 release notes](https://nodejs.org/en/blog/release/v24.21.0) are dated September 8, 2026 and include OpenSSL 3.5.8 / Undici 7.29.1 updates. Recheck after the safety repair before applying the separate runtime change.

Current default local executables observed during audit preparation: `/Users/Matt/.nvm/versions/node/v24.19.0/bin/node` (v24.19.0), `/Users/Matt/.nvm/versions/node/v24.19.0/bin/npm` (11.17.0). These are preparation provenance and do not constitute supported-candidate test evidence. No runtime code/configuration was changed at this stage.

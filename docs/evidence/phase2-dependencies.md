# Phase 2 dependency reachability review

This bounded review uses the saved backend-audit-final.json and frontend-audit-final.json from the verified checkpoint, plus current lockfiles and source. It is not a fresh registry audit or an exploit reproduction. No dependency versions were changed during Phase 2. Severity below is the saved npm aggregate severity, including transitive effects.

The saved backend report lists one moderate package. The frontend report lists 58 packages (29 high, 15 moderate, 14 low). Package installation classification is misleading here: react-scripts and testing libraries are in dependencies, but the frontend Dockerfile copies only static build output to nginx; it does not ship the Node development server or its dependency tree. Static-serving production exposure differs from developer/build exposure. These findings still require maintenance.

Backend body-parser is installed through Express. server.js uses express.json() with the library default limit, and no express.urlencoded or custom invalid size limit was found in backend application source. The saved URL-encoded parsing DoS and invalid-limit bypass paths are not established as reachable in this configuration. Recommended follow-up: nonbreaking lockfile refresh to patched body-parser, full backend tests, then fresh audit.

Frontend runtime exceptions: react-router-dom → react-router is used in the client BrowserRouter application. Navigation targets in source are fixed internal paths or paths prefixed with /stock/ or /research/; no attacker-controlled absolute Link/useNavigate target or SSR hydration flow was found. Recharts imports lodash helpers, so lodash is potentially bundled; review of chart helpers did not establish user-controlled template imports or unsafe omit/unset paths. These are bounded source findings, not proof of universal non-exploitability. Runtime patches deserve priority before any router major migration.

For each frontend row below, “Build/test” means no runtime entry from the application source was identified, and its dependency consumers are build, CSS/SVG processing, linting, or tests. Crafted repository inputs could still attack developer/CI execution. “Dev server” means reachable when react-scripts start is exposed or a developer visits a malicious site; the configured nginx image does not run that service. Keep development servers local and refresh compatible transitive dependencies. Do not accept npm's react-scripts 0.0.0 major remediation proposal; plan a separately reviewed build-tool migration where compatible patches cannot resolve the chain.

| Package | Saved severity | Installed path(s) | Reachability in this app | Deferred remediation |
| --- | --- | --- | --- | --- |
| backend/body-parser | moderate | `backend/node_modules/body-parser` | Backend JSON parser; vulnerable URL-encoded/custom-limit configuration not found | Patch transitive lockfile and rerun backend suite |
| frontend/@babel/core | low | `frontend/node_modules/@babel/core` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/@babel/plugin-transform-modules-systemjs | high | `frontend/node_modules/@babel/plugin-transform-modules-systemjs` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/@jest/core | low | `frontend/node_modules/@jest/core` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/@svgr/plugin-svgo | high | `frontend/node_modules/@svgr/plugin-svgo` | Build/test; trusted-source input boundary | Review parent build-tool migration after MVP; no forced fix |
| frontend/@svgr/webpack | high | `frontend/node_modules/@svgr/webpack` | Build/test; trusted-source input boundary | Review parent build-tool migration after MVP; no forced fix |
| frontend/@tootallnate/once | low | `frontend/node_modules/@tootallnate/once` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/ajv | moderate | `frontend/node_modules/ajv`<br>`frontend/node_modules/ajv-formats/node_modules/ajv`<br>`frontend/node_modules/schema-utils/node_modules/ajv`<br>`frontend/node_modules/workbox-build/node_modules/ajv` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/body-parser | moderate | `frontend/node_modules/body-parser` | Dev server; absent from nginx runtime | Compatible transitive update after MVP, then audit/tests/build |
| frontend/brace-expansion | high | `frontend/node_modules/brace-expansion`<br>`frontend/node_modules/filelist/node_modules/brace-expansion`<br>`frontend/node_modules/sucrase/node_modules/brace-expansion` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/browserslist | high | `frontend/node_modules/browserslist` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/colord | moderate | `frontend/node_modules/colord` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/compression | low | `frontend/node_modules/compression` | Dev server; absent from nginx runtime | Compatible transitive update after MVP, then audit/tests/build |
| frontend/css-minimizer-webpack-plugin | moderate | `frontend/node_modules/css-minimizer-webpack-plugin` | Build/test; trusted-source input boundary | Review parent build-tool migration after MVP; no forced fix |
| frontend/css-select | high | `frontend/node_modules/svgo/node_modules/css-select` | Build/test; trusted-source input boundary | Review parent build-tool migration after MVP; no forced fix |
| frontend/express | high | `frontend/node_modules/express` | Dev server; absent from nginx runtime | Compatible transitive update after MVP, then audit/tests/build |
| frontend/fast-uri | high | `frontend/node_modules/fast-uri` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/flatted | high | `frontend/node_modules/flatted` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/glob | high | `frontend/node_modules/sucrase/node_modules/glob` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/http-proxy-agent | low | `frontend/node_modules/http-proxy-agent` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/http-proxy-middleware | moderate | `frontend/node_modules/http-proxy-middleware` | Dev server; absent from nginx runtime | Compatible transitive update after MVP, then audit/tests/build |
| frontend/jest | low | `frontend/node_modules/jest` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/jest-cli | low | `frontend/node_modules/jest-cli` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/jest-config | low | `frontend/node_modules/jest-config` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/jest-environment-jsdom | low | `frontend/node_modules/jest-environment-jsdom` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/jest-runner | low | `frontend/node_modules/jest-runner` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/js-yaml | high | `frontend/node_modules/@eslint/eslintrc/node_modules/js-yaml`<br>`frontend/node_modules/eslint/node_modules/js-yaml`<br>`frontend/node_modules/js-yaml` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/jsdom | low | `frontend/node_modules/jsdom` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/jsonpath | high | `frontend/node_modules/jsonpath` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/launch-editor | moderate | `frontend/node_modules/launch-editor` | Dev server; absent from nginx runtime | Compatible transitive update after MVP, then audit/tests/build |
| frontend/lodash | high | `frontend/node_modules/lodash` | Potential client runtime via Recharts; vulnerable template/path control not found | Compatible transitive update after MVP, then audit/tests/build |
| frontend/minimatch | high | `frontend/node_modules/filelist/node_modules/minimatch`<br>`frontend/node_modules/minimatch`<br>`frontend/node_modules/sucrase/node_modules/minimatch` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/nanoid | high | `frontend/node_modules/nanoid` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/node-forge | high | `frontend/node_modules/node-forge` | Dev server; absent from nginx runtime | Compatible transitive update after MVP, then audit/tests/build |
| frontend/nth-check | high | `frontend/node_modules/svgo/node_modules/nth-check` | Build/test; trusted-source input boundary | Review parent build-tool migration after MVP; no forced fix |
| frontend/on-headers | low | `frontend/node_modules/on-headers` | Dev server; absent from nginx runtime | Compatible transitive update after MVP, then audit/tests/build |
| frontend/path-to-regexp | high | `frontend/node_modules/path-to-regexp` | Dev server; absent from nginx runtime | Compatible transitive update after MVP, then audit/tests/build |
| frontend/picomatch | high | `frontend/node_modules/picomatch` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/postcss | high | `frontend/node_modules/postcss`<br>`frontend/node_modules/resolve-url-loader/node_modules/postcss` | Build/test; trusted-source input boundary | Review parent build-tool migration after MVP; no forced fix |
| frontend/postcss-selector-parser | low | `frontend/node_modules/postcss-modules-local-by-default/node_modules/postcss-selector-parser`<br>`frontend/node_modules/postcss-modules-scope/node_modules/postcss-selector-parser`<br>`frontend/node_modules/postcss-selector-parser` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/qs | moderate | `frontend/node_modules/qs` | Dev server; absent from nginx runtime | Compatible transitive update after MVP, then audit/tests/build |
| frontend/react-router | moderate | `frontend/node_modules/react-router` | Client runtime; no SSR or untrusted absolute navigation target found | Evaluate supported patch/backport; isolate any major router migration |
| frontend/react-router-dom | moderate | `frontend/node_modules/react-router-dom` | Client runtime; no SSR or untrusted absolute navigation target found | Evaluate supported patch/backport; isolate any major router migration |
| frontend/react-scripts | high | `frontend/node_modules/react-scripts` | Build/test; trusted-source input boundary | Review parent build-tool migration after MVP; no forced fix |
| frontend/resolve-url-loader | moderate | `frontend/node_modules/resolve-url-loader` | Build/test; trusted-source input boundary | Review parent build-tool migration after MVP; no forced fix |
| frontend/rollup | high | `frontend/node_modules/rollup` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/rollup-plugin-terser | high | `frontend/node_modules/rollup-plugin-terser` | Build/test; trusted-source input boundary | Review parent build-tool migration after MVP; no forced fix |
| frontend/serialize-javascript | high | `frontend/node_modules/rollup-plugin-terser/node_modules/serialize-javascript`<br>`frontend/node_modules/serialize-javascript` | Build/test; trusted-source input boundary | Review parent build-tool migration after MVP; no forced fix |
| frontend/sockjs | moderate | `frontend/node_modules/sockjs` | Dev server; absent from nginx runtime | Review parent build-tool migration after MVP; no forced fix |
| frontend/svgo | high | `frontend/node_modules/postcss-svgo/node_modules/svgo`<br>`frontend/node_modules/svgo` | Build/test; trusted-source input boundary | Review parent build-tool migration after MVP; no forced fix |
| frontend/terser-webpack-plugin | moderate | `frontend/node_modules/terser-webpack-plugin` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/underscore | high | `frontend/node_modules/underscore` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/uuid | moderate | `frontend/node_modules/uuid` | Dev server; absent from nginx runtime | Review parent build-tool migration after MVP; no forced fix |
| frontend/webpack | low | `frontend/node_modules/webpack` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |
| frontend/webpack-dev-server | moderate | `frontend/node_modules/webpack-dev-server` | Dev server; absent from nginx runtime | Review parent build-tool migration after MVP; no forced fix |
| frontend/workbox-build | high | `frontend/node_modules/workbox-build` | Build/test; trusted-source input boundary | Review parent build-tool migration after MVP; no forced fix |
| frontend/workbox-webpack-plugin | high | `frontend/node_modules/workbox-webpack-plugin` | Build/test; trusted-source input boundary | Review parent build-tool migration after MVP; no forced fix |
| frontend/ws | high | `frontend/node_modules/webpack-dev-server/node_modules/ws`<br>`frontend/node_modules/ws` | Dev server; absent from nginx runtime | Compatible transitive update after MVP, then audit/tests/build |
| frontend/yaml | moderate | `frontend/node_modules/postcss-load-config/node_modules/yaml`<br>`frontend/node_modules/yaml` | Build/test; trusted-source input boundary | Compatible transitive update after MVP, then audit/tests/build |

Evidence files retain each advisory URL, affected range, and dependency effect. This review does not cover OS/nginx advisories, malicious packages, deployment settings, or future source changes. No confirmed exploitable production path was identified for the saved advisory set; remaining runtime and toolchain findings are deferred rather than declared fixed.

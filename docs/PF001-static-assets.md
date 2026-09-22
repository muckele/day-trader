# Static asset release gate

The `/static/` nginx prefix serves existing build assets and returns 404 for missing resources. The general `/` location retains SPA fallback, including dotted application routes. No regex location overrides either prefix. Ordinary nginx HTML error bodies are permitted: missing JavaScript must fail resource loading rather than execute the SPA shell.

`node scripts/verify-mvp.mjs` runs the mandatory `frontend-nginx` gate after building the frontend. Docker and installed Playwright Chromium are prerequisites. The gate launches the pinned nginx base with committed configuration and current built assets, binds only loopback, and blocks browser requests outside that local origin. It removes only its own container/network. Eleven named scenarios cannot be omitted, duplicated or skipped.

For an immutable production artifact, run:

```
PF001_IMAGE=sha256:<verified-local-image-ID> node --test --test-reporter=tap scripts/acceptance/pf001.test.mjs
```

This mode mounts no replacement assets or configuration. Valid hashed asset paths come from the served index. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` only when using an explicitly installed test browser. No operator browser profile is used.

# Owner access implementation evidence

Implemented on branch `codex/owner-paper-mvp`, starting HEAD `4b3425153b7f3dc3816246cf5d5da7e41d42670e`. No applicable repository AGENTS.md was found. Existing untracked MVP documents preserved. No database, broker or SMTP service was contacted; no deployment or external bootstrap was executed.

## Behavior

- `OWNER_USER_ID` must explicitly identify an existing MongoDB User by its 24-character ObjectId. No first-signup election, production bypass, or fallback signing secret exists. `JWT_SECRET` is required in every environment to authenticate.
- Public registration returns 403, universally. Login only issues a token for the explicitly configured owner's matching database record and password.
- A central `/api` owner gate protects all API routes after the explicit login/disabled registration endpoints. Existing route-level gates remain. `/` and minimal `/health` liveness remain public.
- Every authenticated request verifies HS256, token expiry, owner identity and persistent session version against the current database record. Missing owner configuration, disconnected MongoDB, or query failure fails closed. Pre-existing non-owner tokens fail 403; legacy owner tokens lacking a session version require a fresh login.
- Logout increments the owner's persistent session version before reporting success, invalidating every prior owner cookie/bearer session across devices. A failed write returns 503 with `revoked: false`; it does not claim successful revocation. Requests already authorized before logout can still finish.
- Production session cookie security, origin guard and auth rate limiting remain in place. Test mode no longer loads local `.env` through server startup.

## Operator bootstrap

For an existing identity, set `MONGO_URI` securely in the shell and run from backend:

```sh
node scripts/bootstrap-owner.js --existing USER_OBJECT_ID
```

For a new identity, use a protected JSON credential source with `username`, `email`, `password` (12+ characters including letters and numbers, at most 72 UTF-8 bytes):

```sh
node scripts/bootstrap-owner.js --create < /secure/path/owner-credentials.json
```

The command verifies database access/index initialization and creates only a new explicitly requested user (or reads the explicit existing ID). It never rewrites an existing user's credentials, chooses the first user, or changes runtime configuration. It outputs an `OWNER_USER_ID` value for the operator to configure in the application runtime together with `JWT_SECRET`. Do not commit credential files. An already configured owner prevents `--create`; use `--existing` to verify it. Secrets are never passed in argv or logged.

## Actual test evidence

Before middleware fixes, `node --test backend/tests/ownerAccess.test.js` produced **1 pass / 5 failures**: disconnected DB, non-owner token, missing binding, revoked generation, legacy session were incorrectly accepted.

The extracted original register/login/logout handlers produced **0 pass / 4 failures** against `ownerAuthRoutes.test.js`: registration remained available, non-owner login issued a token, tokens had no revocation version, and logout reported success without persisting revocation. Bootstrap tests were written before its module existed; their initial failure was missing-module, not behavioral red evidence.

Final covering command:

```sh
node --test backend/tests/ownerAccess.test.js backend/tests/ownerAuthRoutes.test.js backend/tests/ownerBootstrap.test.js backend/tests/sessionCookie.test.js backend/tests/unsafeMethodOriginGuard.test.js backend/tests/privateRoutesAuth.test.js
```

Result: **24 passed / 0 failed**, Node v24.19.0. Full output: `docs/evidence/owner-tests.txt`. `node --check backend/server.js` and `node --check backend/scripts/bootstrap-owner.js` passed.

## Limits and remaining evidence

These are deterministic tests of real middleware, route handlers, JWT signing/verification, password hashing, and bootstrap validation with mocked Mongo model boundaries. They are not evidence of actual MongoDB persistence, deployment configuration, HTTP integration across every route, browser logout flow, or operator bootstrap against a real database. Full-process E2E with isolated MongoDB remains necessary. Root owns readiness/index status and global integration checks. Frontend public-registration UI removal and owner setup guidance still require checking. This task does not establish complete MVP readiness or change the larger remaining lifecycle/risk/outbox scope.

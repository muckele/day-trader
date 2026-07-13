# DayTrader frontend

The frontend is a React 19 application built with Vite and tested with Vitest and Playwright.

## Local development

Install dependencies and start the Vite development server:

```bash
npm install
npm start
```

The default development URL is `http://localhost:5173`. API requests under `/api` are proxied to `http://localhost:4000`.

To use a deployed backend, set `VITE_API_URL` before starting or building the app.

## Verification

```bash
npm test
npm run test:e2e
npm run build
npm audit
```

- `npm test` runs the Vitest component suite once.
- `npm run test:e2e` starts the Vite server and runs Playwright.
- `npm run build` writes the production bundle to `dist/`.

Playwright browsers can be installed with `npx playwright install` when needed.

## Deployment

The Docker build accepts `VITE_API_URL` as a build argument and copies the Vite `dist/` output into nginx. Fly.io provides the production backend URL through the build arguments in `fly.toml`.

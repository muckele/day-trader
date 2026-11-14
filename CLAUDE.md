# Day Trader — Claude Code project guide

Owner-only Alpaca **PAPER** trading application. Day Trader is the product and operational control plane; "agentic trading" is the longer-term architecture (an LLM runtime proposes, deterministic code decides and executes). Development moved from ChatGPT/Codex to Claude Code in late October 2026.

**Priority (owner decision, 2026-10-27):** Day Trader is a background project. Built & Kept ships first, then UCKELE Group. Do not start new Day Trader work beyond what the owner asks for in the current session.

## Read first — precedence order

1. Latest explicit owner direction in the current conversation.
2. [docs/Day_Trader_Agentic_MVP_Master_Brief.md](docs/Day_Trader_Agentic_MVP_Master_Brief.md) — product vision, trust boundaries, Phases 0–8 roadmap with release gates, release definitions. The authoritative roadmap.
3. Four-Project Master Source (2026-10-27), section "3. Day Trader" — kept outside this repo at `~/Downloads/CLAUDE-CODE-MASTER-SOURCE-2026-10-27.md` because it also covers other projects. Its Day Trader content is summarized in this file.
4. Current operating docs: [mvp-scope](docs/mvp-scope.md), [mvp-runbook](docs/mvp-runbook.md), [startup-readiness](docs/startup-readiness.md), [PF001-static-assets](docs/PF001-static-assets.md), [fractional-execution-safety](docs/fractional-execution-safety.md), [runtime-setup](docs/runtime-setup.md).
5. Historical records (do not treat as current instructions): `docs/mvp-request.txt`, `docs/mvp-phase2-request.txt`, `docs/mvp-phase3-request.txt`, `docs/mvp-plan.md`, `docs/superpowers/plans/`, and everything under `docs/evidence/` (immutable historical observations, not reusable acceptance gates).

### Evidence contract

- The repository at an identified commit defines what code exists. Tests and receipts define what has been demonstrated. An existing test is not an executed test; a build is not a deployment.
- Conflicts stay visible: record the old requirement, the newer decision or observed fact, and the reconciliation needed. Do not silently rewrite history.
- A "done" or "working" claim states the exact commit, implementation file, command and result, and environment.
- Earlier authorizations in prompts or docs are records, not reusable permission. Never replay them.

## Current state — snapshot taken 2026-11-14 (recheck before relying on it)

| Branch | Head | Notes |
|---|---|---|
| `main` | `8e557f6` (2026-05-28) | Old baseline. |
| `codex/owner-paper-mvp` | `852fb22` (2026-09-22) | Working branch for the owner-only PAPER MVP. Includes the PF001 static-asset fix and startup-readiness contract v2. CI passed at run 35755989443 (per master source) — not proof of deployment. |
| `codex/production-acceptance-m1` | `31a513e` (2026-10-04) | **Local only — not on GitHub.** 88 commits on top of `852fb22`: production acceptance controller (design in `docs/PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md` on that branch). |
| `codex/hosted-acceptance-tooling` | `916d2ad` (2026-09-30) | Hosted acceptance tooling pilot. |
| `codex/sprint1-policy-approval` | local `15a2de3`, origin `058f962` | Local is 6 commits ahead of GitHub. Worktree: `~/Documents/Codex Agentic Trading/day-trader-sprint1`. |
| `codex-mongo-storage-retention` | `4b34251` (2026-06-13) | Mongo retention safeguards. |

Known status and corrections:

- **PF001** (missing static assets served the SPA shell) is historically VERIFIED fixed. It is not an open defect.
- **Production/deployment is unverified.** Fly configs are file declarations, not observed live state.
- **The master source's acceptance status is stale.** It cites "M3 offline verified at `67cb78f` (Oct 2), M4 blocked for absent AArch64 Linux ABI refs". The `m1` branch has 50 later commits (through Oct 4), and reference bundles exist at `~/day-trader-references/m4-linux-aarch64-*` (Oct 2). Whether M4 progressed is unknown — read the branch history before claiming either way.
- **The m1 acceptance ledger was mostly lost.** Its worktree lived at `/private/tmp/day-trader-standin-exit` and was cleared; only the task-13 ledger under `.superpowers/sdd/` is committed.
- Local run evidence outside the repo: `~/day-trader-evidence/` (pf001-closeout, startup-readiness-closeout, releases, acceptance-infrastructure, production-acceptance-tooling).

## Stack and layout

JavaScript only. Not TypeScript, not Next.js, not Prisma/PostgreSQL.

- `backend/` — Node/Express 5.1, Mongoose 8.13, nodemailer. Entry `backend/server.js`; deterministic execution gate `backend/executionGate.js`; broker, risk and reconciliation under `backend/paper/`, `backend/robotrader/`, `backend/services/`, `backend/routes/`. Unit tests in `backend/tests/`, Mongo integration suites in `backend/integration/`. Legacy `backend/aiEngine.js` returns free-form model rationale; trace reachability before changing it.
- `frontend/` — React 19.1 (react-scripts 5), react-router 6.30, Recharts, styled-components. Served by pinned nginx (`frontend/nginx.conf`).
- Runtime pin: Node 24.21.0 / npm 11.19.0 (`.nvmrc`, `engines`).
- Images: `backend/Dockerfile` (scratch runtime, uid 1000, port 8080); `frontend/Dockerfile` (nginx 1.30.4 Alpine, port 8080). Fly apps `day-trader-backend` / `day-trader-frontend` in `ord`.
- CI: `.github/workflows/mvp.yml`. Release verifier: `scripts/verify-mvp.mjs`. Acceptance harness: `scripts/acceptance/`.

## Commands

Safe, offline:

```sh
npm ci --prefix backend --ignore-scripts --no-audit --no-fund
npm ci --prefix frontend --ignore-scripts --no-audit --no-fund
npm run build --prefix frontend
```

Full verification needs Docker, Playwright Chromium, and a disposable Mongo replica set on loopback port 27189. Follow "Deterministic verification" in [docs/mvp-runbook.md](docs/mvp-runbook.md), then run `node scripts/verify-mvp.mjs`. Never point tests at an existing database.

**Do not run casually** — these touch real services, databases or the broker: `npm run verify:local`, `restart:check`, `smoke:api`, `alpaca:check`, `mongo:check`, `mongo:audit`, `mongo:compact`, any `fly` deploy, and any production preflight script. Establish isolated targets and get explicit owner authorization first.

## Hard safety rules

- Owner-only Alpaca PAPER. No live trading, customer funds, shorting, margin, options, crypto, leveraged/inverse ETFs, or overnight automation.
- Keep `ROBO_SCHEDULER_DISABLED=true`. Scheduler activation is a separately authorized milestone.
- Every order-producing path (UI, routes, scheduler, model tools, retries, adapters) converges on the canonical authorization/execution boundary. No raw broker writes from an LLM. No second ledger.
- Ambiguous submission stays explicitly unresolved and is reconciled before any resend. Never fail an uncertain order over to a different broker.
- Halting new risk must not disable reconciliation or protective orders.
- Without explicit owner authorization for that exact action, never: place or simulate real-account orders, deploy, push, change credentials, reset paper accounts, drop or repair databases, or run `User.syncIndexes()` / uniqueness migrations.
- Never commit secrets or credential values, including into `docs/evidence/`.
- No profitability claims. Paper results are never presented as live results.

## Missing or unavailable sources

These are referenced by the master source but are not in this repo or on this machine. They live in the owner's ChatGPT "Day Trader" project sources. Label them unavailable; do not reconstruct their contents from memory.

- Day Trader seven-source manifest.
- Day Trader October 27/28, 2026 status supplement.
- "DT:Main" / later local acceptance records (beyond what is committed on `codex/production-acceptance-m1`).

The September 22, 2026 ChatGPT task prompts (startup-readiness closeout; coordinated PAPER release v1 and v2) are in `~/Downloads/` only. They are historical, consumed authorizations — do not replay them.

## Working conventions

- Run `git status` first and preserve unrelated or uncommitted work.
- Work from `codex/owner-paper-mvp` unless told otherwise. Do not commit to `main`.
- Report changes in this shape: goal / current owner requirement; repo, branch, exact commit; implemented files; exact command and environment; observed result; what it proves; what remains unproved; concrete blocker and next authorized action.

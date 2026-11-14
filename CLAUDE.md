# Day Trader — Claude Code project guide

Owner-only Alpaca **PAPER** trading application. Day Trader is the product and operational control plane; "agentic trading" is the longer-term architecture (an LLM runtime proposes, deterministic code decides and executes). Development moved from ChatGPT/Codex to Claude Code in late October 2026.

**Priority (owner decision, 2026-10-27):** Day Trader is paused behind Built & Kept and UCKELE Group. Lower priority does not mean abandoned — preserve all work and evidence. Do not start new Day Trader work beyond what the owner asks for in the current session.

## Read first — precedence order

1. Latest explicit owner direction in the current conversation.
2. [docs/Day_Trader_Agentic_MVP_Master_Brief.md](docs/Day_Trader_Agentic_MVP_Master_Brief.md) — product vision, trust boundaries, Phases 0–8 roadmap with release gates, release definitions. The authoritative roadmap.
3. Day Trader status handoff, reconciled 2026-10-28 UTC — `~/Downloads/Day-Trader-—-Current-Status,-MVP-and-Implementation-Handoff-—-2026-10-27.txt`. Kept outside this public repo because it contains private ChatGPT links. Summarized below.
4. Four-Project Master Source (2026-10-27), section "3. Day Trader" — `~/Downloads/CLAUDE-CODE-MASTER-SOURCE-2026-10-27.md` (identical `.txt` copy alongside). Covers other projects too, so it stays outside the repo.
5. Current operating docs: [mvp-scope](docs/mvp-scope.md), [mvp-runbook](docs/mvp-runbook.md), [startup-readiness](docs/startup-readiness.md), [PF001-static-assets](docs/PF001-static-assets.md), [fractional-execution-safety](docs/fractional-execution-safety.md), [runtime-setup](docs/runtime-setup.md).
6. Historical records (do not treat as current instructions): `docs/mvp-request.txt`, `docs/mvp-phase2-request.txt`, `docs/mvp-phase3-request.txt`, `docs/mvp-plan.md`, `docs/superpowers/plans/`, and everything under `docs/evidence/` (immutable historical observations, not reusable acceptance gates).

### Evidence contract

- The repository at an identified commit defines what code exists. Tests and receipts define what has been demonstrated. An existing test is not an executed test; a build is not a deployment; offline success is labeled offline.
- Conflicts stay visible: record the old requirement, the newer decision or observed fact, and the reconciliation needed. Do not silently rewrite history. Newer VERIFIED results outrank earlier intermediate BLOCKED reports for the same milestone.
- A "done" or "working" claim states the exact commit, implementation file, command and result, and environment.
- Earlier authorizations in prompts or docs are records, not reusable permission. Never replay them. Do not rerun unchanged clean suites just for reassurance.

## MVP finish line

The immediate goal is the **owner-only deployed PAPER MVP**, then a short PAPER operational soak. Scope: owner authentication/isolation, PAPER routing, deterministic risk/execution controls, canonical order lifecycle and reconciliation, exposure/reservation/fill accounting, durable notification outbox and targeted SMTP, deployed frontend/backend owner workflow, and recovery/rollback evidence. The scheduler stays suppressed at deployment until separately authorized.

Do not confuse this with the broader **agentic paper MVP** (roadmap Phases 0–3), the owner-live canary (Phase 5), or the paid product (Phase 7).

## Current state — snapshot taken 2026-11-14 (recheck before relying on it)

| Branch | Head | Notes |
|---|---|---|
| `main` | `8e557f6` (2026-05-28) | Old baseline. Not the release-candidate line. |
| `codex/owner-paper-mvp` | `852fb22` (2026-09-22) | Owner-paper MVP line: PF-001 fix (`44bc06f`) plus startup-readiness contract v2. CI passed at run 35755989443 (per master source) — not proof of deployment. |
| `codex/production-acceptance-m1` | `31a513e` (2026-10-04) | **Local only — not on GitHub.** 88 commits on top of `852fb22`: production acceptance controller (design in `docs/PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md`, plan in `docs/superpowers/plans/2026-09-30-production-acceptance-controller.md`, both on that branch). |
| `codex/hosted-acceptance-tooling` | `916d2ad` (2026-09-30) | Hosted acceptance tooling pilot. |
| `codex/sprint1-policy-approval` | local `15a2de3`, origin `058f962` | Local is 6 commits ahead of GitHub. Worktree: `~/Documents/Codex Agentic Trading/day-trader-sprint1`. |
| `codex-mongo-storage-retention` | `4b34251` (2026-06-13) | Mongo retention safeguards. |

### Owner-paper release candidate (records dated 2026-09-22; not freshly confirmed)

- **PF-001** (missing static assets served the SPA shell) is VERIFIED CLOSED at `44bc06f`. Not an open defect.
- Qualified local images: backend `sha256:c01dbbd2842c40457462f3f5621b6857049daf5796542bc681c10d2f13daa61f`, frontend `sha256:1ba97a5ea82b474ffd2f7c1cc61b95ae0714b8cf0fdee013a52af143843a3a5b`. Neither was published or deployed during PF-001 closeout.
- Historical Fly baseline: backend v38 / frontend v17. Frontend v17 is incompatible with the new backend, so a **coordinated backend + frontend release** is required, not backend-only promotion.
- Known debt: `npm audit` showed 0 Critical / 28 High / 15 Moderate / 14 Low in that snapshot. Scout image scans do not waive it.
- Production/deployment is unverified. Fly configs are file declarations, not observed live state.

### Production acceptance controller (`codex/production-acceptance-m1`)

From the status handoff, plus local evidence checked on 2026-11-14:

- **M1** offline verified. **M2** accepted with a narrow historical evidence exception at `55c115a` — do not reopen or generalize it. **M3** offline verified at `67cb78f` (2026-10-02); compiled host/broker never executed.
- **M4:** the handoff records it as BLOCKED on a pinned AArch64 Linux ABI-reference bundle and says the proposed acquisition was not established. **Local evidence shows more happened:** a pinned bundle (Linux 6.8, glibc 2.39, Arm `abi-aa` commit) was acquired 2026-10-02 at `~/day-trader-references/m4-linux-aarch64-20261002T173700Z`; that first attempt is recorded as failed, followed by an owner-authorized offline byte-reuse repair at `~/day-trader-references/m4-linux-aarch64-offline-repair-20261002T181543Z`. Commits whose messages match plan Tasks 8–10 (guest confinement, CONNECT proxy, topology gate) follow the same day.
- Commits on 2026-10-03/04 match plan Tasks 11–15 and 18, plus a "bootstrap composition v1" amendment. The only committed review record is Task 13 (`.superpowers/sdd/.../task13-compatibility-amendment/report.md`): independent review ACCEPT, offline only, at `763b329`. Review status of the later commits (`b401be1`..`31a513e`) is unrecorded.
- The M4 gate evidence (owner authorization, ABI coverage, exception disposition) lived in the deleted `/private/tmp/day-trader-standin-exit` worktree and is lost; only its SHA-256 hashes survive in the repair bundle's `manifest.json`.
- Runtime distribution remains `HOLD_PENDING_RUNTIME_QUALIFICATION`. No browser, VM, signing, network, credential, production or trading action has been performed by this work.
- Local run evidence outside the repo: `~/day-trader-evidence/` (pf001-closeout, startup-readiness-closeout, releases, acceptance-infrastructure, production-acceptance-tooling).

### Next sequence when Day Trader resumes (from the handoff)

1. Reconcile the local `m1` branch, ledger and evidence against the dated identities above. Do not reset to `main` or repeat completed M1–M3 work.
2. Settle the M4 record using the local evidence above. If more reference work is needed, the blocker is the pinned ABI bundle and its narrow authority — not a new compiler install and not PF-001.
3. Finish only approved offline work; reuse committed M2/M3 interfaces; separate implementers from reviewers. Injected kernel/topology tests are never real confinement receipts.
4. Production release is a separate consequential gate: fresh quiescence, verified backup/restore, owner/account/scheduler safety, data-guarded rollback, exact qualified-image publication with registry digest match, coordinated backend/frontend deploy, deployed owner-flow acceptance with the scheduler still suppressed.
5. Only after separate scheduler authorization: bounded PAPER soak. Live trading stays off.

## Stack and layout

JavaScript only. Not TypeScript, not Next.js, not Prisma/PostgreSQL.

- `backend/` — Node/Express 5.1, Mongoose 8.13, nodemailer. Entry `backend/server.js`; deterministic execution gate `backend/executionGate.js`; broker, risk and reconciliation under `backend/paper/`, `backend/robotrader/`, `backend/services/`, `backend/routes/`. Unit tests in `backend/tests/`, Mongo integration suites in `backend/integration/`. Legacy `backend/aiEngine.js` returns free-form model rationale; trace reachability before changing it.
- `frontend/` — React 19.1 (react-scripts 5), react-router 6.30, Recharts, styled-components. Served by pinned nginx (`frontend/nginx.conf`).
- Runtime pin: Node 24.21.0 / npm 11.19.0 (`.nvmrc`, `engines`).
- Images: `backend/Dockerfile` (scratch runtime, uid 1000, port 8080); `frontend/Dockerfile` (nginx 1.30.4 Alpine, port 8080). Fly apps `day-trader-backend` / `day-trader-frontend` in `ord`.
- CI: `.github/workflows/mvp.yml`. Release verifier: `scripts/verify-mvp.mjs`. Acceptance harness: `scripts/acceptance/`.
- Supported owner browser: standard HTTPS browser that allows the required `SameSite=None; Secure` cross-site session cookie. Same-site/custom-domain architecture is future work.

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

- Owner-only Alpaca PAPER. No live trading, customer funds, shorting, margin, options, futures, crypto, leveraged/inverse ETFs, autonomous funding, or overnight automation.
- Keep `ROBO_SCHEDULER_DISABLED=true`. Scheduler activation is a separately authorized milestone.
- Every order-producing path (UI, routes, scheduler, model tools, retries, adapters) converges on the canonical authorization/execution boundary and one ledger. No raw broker writes from an LLM.
- Ambiguous submission stays explicitly unresolved and is reconciled before any resend. Never fail an uncertain order over to a different broker.
- Model failure halts new model-dependent risk, not reconciliation or protective management.
- Separate explicit owner authorization is required for each of: deploys/restarts, applying production secrets, DB writes, broker writes or cancellations, external SMTP, scheduler/RoboTrader activation, destructive actions, pushing, and material scope/security changes. Never run `User.syncIndexes()` or uniqueness migrations at startup.
- Never commit secrets or credential values, including into `docs/evidence/`. This repository is **public**.
- No profitability claims. Paper results are never presented as live results.

## Sources still unavailable locally

The handoff names seven canonical ChatGPT project sources. Only the first is in this repo:

1. `00_Day_Trader_Agentic_MVP_Master_Brief.md` — in repo as `docs/Day_Trader_Agentic_MVP_Master_Brief.md`.
2. `01_Day_Trader_Current_State_and_Codex_Working_Model_2026-09-22.md`
3. `02_Fly_Deployment_Preparation_READY_2026-09-22.md`
4. `03_Frontend_Backend_Compatibility_READY_2026-09-22.md`
5. `04_C1_Race_Safe_Disable_VERIFIED_2026-09-21.md`
6. `05_PF001_Frontend_Closeout_VERIFIED_2026-09-22.md`
7. Historical Decisions & Project Source Manifest.

Items 2–7 live only in the owner's ChatGPT "Day Trader" project. Label them unavailable; do not reconstruct their contents from memory. The September 22, 2026 ChatGPT task prompts (startup-readiness closeout; coordinated PAPER release v1 and v2) are in `~/Downloads/` only — historical, consumed authorizations; do not replay them.

## Working conventions

- Run `git status` first and preserve unrelated or uncommitted work.
- Work from `codex/owner-paper-mvp` unless told otherwise. Do not commit to `main`.
- Use outcome-sized isolated milestones, focused tests, and independent review of exact candidates.
- Report changes in this shape: goal / current owner requirement; repo, branch, exact commit; implemented files; exact command and environment; observed result; what it proves; what remains unproved; concrete blocker and next authorized action.

# Day Trader — Claude Code project guide

Owner-only Alpaca **PAPER** trading application. Day Trader is the product and operational control plane; "agentic trading" is the longer-term architecture (an LLM runtime proposes, deterministic code decides and executes). Development moved from ChatGPT/Codex to Claude Code in late October 2026.

**Priority (owner decision, 2026-10-27):** Day Trader is paused behind Built & Kept and UCKELE Group. Lower priority does not mean abandoned — preserve all work and evidence. Do not start new Day Trader work beyond what the owner asks for in the current session.

## Read first — precedence order

1. Latest explicit owner direction in the current conversation.
2. [docs/Day_Trader_Agentic_MVP_Master_Brief.md](docs/Day_Trader_Agentic_MVP_Master_Brief.md) — product vision, trust boundaries, Phases 0–8 roadmap with release gates, release definitions. The authoritative roadmap (ChatGPT source `00`).
3. Day Trader status handoff, reconciled 2026-10-28 UTC — `~/Downloads/Day-Trader-—-Current-Status,-MVP-and-Implementation-Handoff-—-2026-10-27.txt`. Summarized below.
4. Four-Project Master Source (2026-10-27), section "3. Day Trader" — `~/Downloads/CLAUDE-CODE-MASTER-SOURCE-2026-10-27.md`.
5. ChatGPT project sources `01`–`06` (2026-09-21/22), verified copies in `~/day-trader-evidence/project-sources/2026-09-22/` with a SHA-256 `MANIFEST.txt`. `01` = current state and working model; `02` = Fly deployment prep; `03` = frontend/backend compatibility; `04` = C1 race-safe disable; `05` = PF-001 closeout; `06` = historical decisions and source manifest. They describe state as of Sept 22; later evidence below supersedes them where it conflicts.
6. Current operating docs: [mvp-scope](docs/mvp-scope.md), [mvp-runbook](docs/mvp-runbook.md), [startup-readiness](docs/startup-readiness.md), [PF001-static-assets](docs/PF001-static-assets.md), [fractional-execution-safety](docs/fractional-execution-safety.md), [runtime-setup](docs/runtime-setup.md).
7. Historical records (do not treat as current instructions): `docs/mvp-request.txt`, `docs/mvp-phase2-request.txt`, `docs/mvp-phase3-request.txt`, `docs/mvp-plan.md`, `docs/superpowers/plans/`, and everything under `docs/evidence/` (immutable historical observations, not reusable acceptance gates).

Items 3–5 stay outside this **public** repository because they contain private ChatGPT links, production identifiers or other projects' details.

### Evidence contract

- The repository at an identified commit defines what code exists. Tests and receipts define what has been demonstrated. An existing test is not an executed test; a build is not a deployment; offline success is labeled offline.
- Conflicts stay visible: record the old requirement, the newer decision or observed fact, and the reconciliation needed. Do not silently rewrite history. Newer VERIFIED results outrank earlier intermediate BLOCKED reports for the same milestone.
- A "done" or "working" claim states the exact commit, implementation file, command and result, and environment.
- Earlier authorizations in prompts or docs are records, not reusable permission. Never replay them. Do not rerun unchanged clean suites just for reassurance.

## MVP finish line

The immediate goal is the **owner-only deployed PAPER MVP**, then a short PAPER operational soak. Scope: owner authentication/isolation, PAPER routing, deterministic risk/execution controls, canonical order lifecycle and reconciliation, exposure/reservation/fill accounting, durable notification outbox and targeted SMTP, deployed frontend/backend owner workflow, and recovery/rollback evidence. The scheduler stays suppressed at deployment until separately authorized.

Do not confuse this with the broader **agentic paper MVP** (roadmap Phases 0–3), the owner-live canary (Phase 5), or the paid product (Phase 7).

**Release path (owner decision, 2026-11-14): Path A.** Finish the production acceptance controller on `codex/production-acceptance-m1` and use it for deployed acceptance. Owner-performed acceptance (Path B) was considered and not chosen. Reconfirmed 2026-11-16 after a side-by-side comparison of both paths. Staged plan, task status and approval points: [docs/mvp-release-plan.md](docs/mvp-release-plan.md). The plan is not an authorization.

## Current state — snapshot taken 2026-11-14 (recheck before relying on it)

| Branch | Head | Notes |
|---|---|---|
| `main` | `8e557f6` (2026-05-28) | Old baseline. Not the release-candidate line. |
| `codex/owner-paper-mvp` | `852fb22` + docs commits | Release-candidate line: PF-001 fix (`44bc06f`) plus startup-readiness contract v2 (`852fb22`, STARTUP_READINESS_CLOSEOUT_VERIFIED; hosted run 35755989443). |
| `codex/production-acceptance-m1` | `31a513e` (2026-10-04) | Production acceptance controller, 84 commits on top of `852fb22` (17 of them are the hosted-tooling pilot, `916d2ad` being an ancestor; corrected 2026-11-16 from "88"). Pushed to GitHub 2026-11-14. Design and plan: `docs/PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md`, `docs/superpowers/plans/2026-09-30-production-acceptance-controller.md` on that branch. |
| `claude/production-acceptance-stage1` | `132b67e` (2026-11-17) | Stage 1 work on top of `31a513e`. Pushed to GitHub up to `6c33545` (2026-11-16); everything after that is local: the M4 disposition record `ee687f9`, the Option A plan `36898e9`, and Option A work through `132b67e`. Worktree: `~/day-trader-worktrees/production-acceptance-stage1-fixes`. `54e5b6e` is the 2-line test-only fix for the bootstrap v1 handoff test (Swift 181/181 at that commit). `6c33545` records its independent review (ACCEPT_WITH_NOTES, follow-ups only). |
| `codex/hosted-acceptance-tooling` | `916d2ad` (2026-09-30) | Hosted acceptance tooling pilot. |
| `codex/sprint1-policy-approval` | `15a2de3` (2026-08-14) | Pushed to GitHub 2026-11-14 (was 6 commits ahead). Worktree: `~/Documents/Codex Agentic Trading/day-trader-sprint1`. That folder is iCloud-synced and macOS can evict its files; its uncommitted changes are preserved on `codex/sprint1-uncommitted-2026-07`. |
| `codex/sprint1-uncommitted-2026-07` | `ba322b9` (2026-11-15) | Snapshot of 35 files of uncommitted Jul 19–Aug 14 work (controlled-live readiness services, tests, design docs) recovered from the sprint1 worktree, where 31 existed only in iCloud. Saved exactly as found, built on `15a2de3`. Unreviewed, untested, not a release candidate. Pushed 2026-11-15. |
| `codex-mongo-storage-retention` | `4b34251` (2026-06-13) | Mongo retention safeguards. |

### Release candidate for `852fb22` (not published, not deployed)

- Backend local config ID `sha256:193d59b401d2683d4cd6bcc3095ab07c953d74cff485c6271e8f54f5c05b213e`; frontend local config ID `sha256:1ba97a5ea82b474ffd2f7c1cc61b95ae0714b8cf0fdee013a52af143843a3a5b`. Both linux/amd64. These are local image IDs, not registry manifest digests.
- The older backend `sha256:c01dbbd2…` (built from `8f81a74`, cited in sources `01`/`02`/`05` and the handoff) is **historical only** — `852fb22` changed backend files.
- The test-URL frontend image `sha256:850fee48…` from source `03` must never be promoted.
- **PF-001** (missing static assets served the SPA shell) is VERIFIED CLOSED at `44bc06f`. Not an open defect.
- Frontend v17 is incompatible with the candidate backend (manual orders lack the stable idempotency key; Portfolio and fill history crash on missing/null P&L; no coordinated close). A **coordinated backend + frontend release** is required, never backend-only.
- Known debt and limits: `npm audit` 0 Critical / 28 High / 15 Moderate / 14 Low; backend image 8 Low CVEs (glibc/gcc); frontend image 1 Medium / 2 Low (pcre2); disallowed-origin requests return HTTP 500; browsers blocking the `SameSite=None; Secure` cross-site cookie are unsupported; duplicate production users / User uniqueness remain deferred maintenance (`USER_UNIQUENESS_DEFERRED`).

### Production (last observed read-only 2026-11-15; recheck before relying on it)

- **2026-11-15 read-only Fly check** (record: `~/day-trader-evidence/production-observations/20261116T031825Z-readonly-fly/`):
  - **Unchanged since September:** backend release v38 and its image, frontend v17 (both machines stopped), and the ten Sept 22 secrets still listed as "Staged".
  - **Changed:** the running backend machine was relaunched on 2026-11-09 at 19:49 UTC with an identical v38 config. Fly logged it as a user-initiated `launch` (`source=user`), not a release. Who triggered it is unknown. Nothing on the owner's Mac touched the app that day: no shell history, no Claude Code or Codex session, no local Fly agent connector, and no CI run.
  - **Not a documented Fly migration either.** Those log `source=flyd` with `migrated=true`. Fly's status page shows no incident that day, the account has no org or Day Trader deploy tokens, and no Fly email mentions the app. The launch is still unexplained. The remaining checks are the owner's Fly dashboard logins and agent grants, and any claude.ai or ChatGPT connectors.
  - **Likely consequence:** Fly docs and source `02` say staged secrets reach any machine started or updated after staging. Fly rebooted its whole fleet on 2026-10-16 (Fly Nov '26 newsletter), so v38 has probably run with the staged values since then, and certainly since Nov 9 if not before. Pre-v38 code honors `ROBO_SCHEDULER_DISABLED` and selects SMTP when `SMTP_HOST` is set. This is unverified; the bullets below describe the Sept 23 state.
- Backend Fly v38 (one machine running), frontend Fly v17 (machines stopped). Unchanged by every release attempt so far.
- **Running v38 does not have effective scheduler suppression.** `ROBO_SCHEDULER_DISABLED=true` is staged, not applied. Safety currently rests on account settings: the legacy/test account "C1" was race-safely disabled on 2026-09-21 (source `04`), and the owner account's settings are PAPER with all enablement flags false.
- Ten Fly secrets are staged (`OWNER_USER_ID`, `ALPACA_EXPECTED_PAPER_ACCOUNT_ID`, `ROBO_SCHEDULER_DISABLED`, `ROBO_EMAIL_PROVIDER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `ROBO_NOTIFICATION_RECIPIENT`). Their current values have not been re-proven. **Any Fly machine start or update applies staged secrets** — never start, update or restart Fly machines without explicit authorization.
- Rollback: the exact v38 image is retrievable, but rollback is classified ROLLBACK_REQUIRES_DATA_GUARD — maintenance-only, quiescent, scheduler suppressed, never with unresolved canonical/broker work.

### Release attempts (evidence in `~/day-trader-evidence/releases/`)

- **2026-09-22 coordinated release — COORDINATED_RELEASE_BLOCKED** before maintenance. Nothing published, deployed or mutated. Blockers: secure normal-owner login not confirmed; staged secret values not re-proven; maintenance/backup/restore/deploy command plan unapproved (independent reviewer returned HOLD). A read-only snapshot transaction proved backup *capability*, not a backup.
- **2026-09-23 automated resume — still BLOCKED.** Blockers: no qualified production HTTPS forwarding mode; no reviewed private real-credential intake; no production session hold and post-restart readiness phase; required operational routes and genuine static-error probes absent. The production acceptance controller on `codex/production-acceptance-m1` is the follow-on work for these blockers.

### Production acceptance controller (`codex/production-acceptance-m1`)

From the status handoff, plus local evidence checked on 2026-11-14:

- **M1** offline verified. **M2** accepted with a narrow historical evidence exception at `55c115a` — do not reopen or generalize it. **M3** offline verified at `67cb78f` (2026-10-02); compiled host/broker never executed.
- **M4:** the handoff records it as BLOCKED on a pinned AArch64 Linux ABI-reference bundle and says the proposed acquisition was not established. **Local evidence shows more happened:** a pinned bundle (Linux 6.8, glibc 2.39, Arm `abi-aa` commit) was acquired 2026-10-02 at `~/day-trader-references/m4-linux-aarch64-20261002T173700Z`; that first attempt is recorded as failed, followed by an owner-authorized offline byte-reuse repair at `~/day-trader-references/m4-linux-aarch64-offline-repair-20261002T181543Z`. Commits whose messages match plan Tasks 8–10 (guest confinement, CONNECT proxy, topology gate) follow the same day.
- Commits on 2026-10-03/04 match plan Tasks 11–15 and 18, plus a "bootstrap composition v1" amendment. The only committed review record is Task 13 (`.superpowers/sdd/.../task13-compatibility-amendment/report.md`): independent review ACCEPT, offline only, at `763b329`. Review status of the later commits (`b401be1`..`31a513e`) is unrecorded.
- The M4 gate evidence (owner authorization, ABI coverage, exception disposition) lived in the deleted `/private/tmp/day-trader-standin-exit` worktree and is lost; only its SHA-256 hashes survive in the repair bundle's `manifest.json`. A ChatGPT retrieval on 2026-11-14 could not recover the original Oct 2 M3 closeout, M4 blocked report or remedy messages either (`Day_Trader_M3_M4_Original_Message_Retrieval.md` in the project-sources folder). The local bundles, the commits and Codex's own progress ledger (found 2026-11-16, see below) are the remaining record.
- Runtime distribution remains `HOLD_PENDING_RUNTIME_QUALIFICATION`. No browser, VM, signing, network, credential, production or trading action has been performed by this work.
- Other local run evidence: `~/day-trader-evidence/` (pf001-closeout, startup-readiness-closeout, acceptance-infrastructure, production-acceptance-tooling).
- **Stage 0 resume check, 2026-11-16 (read-only)** — ledger: `~/day-trader-evidence/production-acceptance-tooling/20261117T001708Z-stage0-resume/RESUME_LEDGER.md`.
  - **Intact:** all branch heads match GitHub, and the release-candidate code is still exactly `852fb22`. Both M4 reference bundles match their manifests file for file, 112/112.
  - **Codex progress ledger survives** at `~/.codex/visualizations/2026/09/23/<run>/production-acceptance-m1/progress.md`. It records the M1–M3 closeouts and the Oct 2 M4 BLOCKED disposition. It does not cover the later reference repair or Tasks 8–18.
  - **Toolchain drift:** the host went from macOS 26.6.2 to 27.2.1. Command Line Tools went from 27.0 to 27.2, Swift from 6.4 to 6.4.2, and the SDK from 27.0 to 27.2; the old SDK is gone. Node 24.21.0 and Python 3.12.2 are unchanged.
  - **Re-pinned (owner decision, 2026-11-16):** offline Stage 1 work uses the installed CLT 27.2 / Swift 6.4.2 / SDK 27.2. That decision approves nothing else: no Xcode/XCTest, signing, downloads or VM.
- **Stage 1 (in progress, started 2026-11-16).**
  - **Ledger:** `~/day-trader-evidence/production-acceptance-tooling/20261117T002012Z-stage1/STAGE1_LEDGER.md`.
  - **Worktree:** detached at `31a513e`, `~/day-trader-worktrees/production-acceptance-m1-stage1`.
  - **Offline baseline:**
    - Node: 402/402.
    - Python: 345/353. The other 8 cannot run: `bootstrap_reference_test.py` needs an uncommitted `abi-coverage.json` that was lost with the `/private/tmp` worktree.
    - Swift: 180/181. The one failing `BootstrapGateTests` handoff test was traced on 2026-11-16 to two test-data defects that came in with `284f946`:
      - The Swift test signs with ASCII `"7"`, while the fixture's key is byte `7`.
      - The Python fixture marks the RESULT pipe read-only, while the Swift validator and the real guest check require write-only.
      - The fix is committed as `54e5b6e` on `claude/production-acceptance-stage1` and gives 181/181. Independent review: ACCEPT_WITH_NOTES, follow-ups only.
  - **Test-run requirements:** a physical, non-symlinked `TMPDIR`, and fixture inputs produced as the composition-v1 plan describes.
  - **M4 disposition, accepted by the owner 2026-11-17** ("Accept with A"; record `.superpowers/sdd/…/m4-disposition-20261117/disposition.md` on `claude/production-acceptance-stage1`).
    - M4 stays **open**. The whole-M4 offline review has no surviving record and is redone fresh in Stage 1. The real confinement gate is Stage 2.
    - The offline repair bundle (manifest `bb5fb8c4…`) is M4's reference input.
    - Lost October evidence stays lost and is not reconstructed.
    - **Option A:** build a new, reviewed, committed ABI coverage derivation that checks both the Task 8 seccomp/syscall constants and the event constants against the retained Linux bytes. It replaces the lost `abi-coverage.json` and unblocks the 8 `bootstrap_reference_test.py` tests.
  - **Option A: done 2026-11-17** (`36898e9..132b67e`, subagent-driven; record `.superpowers/sdd/…/m4-abi-coverage-v2/report.md`).
    - **Built:**
      - offline deriver `appliance/derive_abi_coverage.py`;
      - 121-entry inventory and committed `abi-coverage-v2.json`, checked against hand-transcribed `abi_oracles.py`;
      - `abi_coverage_test.py`, which binds every bound guest ABI literal exactly, per call site and per seccomp instruction.
    - **Results:**
      - the 8 `bootstrap_reference_test` tests run again;
      - Python 400/400, Node 402/402, Swift 181/181 at `0f87065`; 401/401 Python after the fix wave;
      - the final reviewer checked all 121 records against the archive.
    - **Known gaps** for the whole-M4 review:
      - the probe catalogue `tests/guest/confinement_probe.py` (bind before Stage 2 relies on probe evidence);
      - event literals in `topology.py` (bind before the native event source is enabled);
      - the R13 layouts, the `.cjs` modules.
    - **Reconciliation:** D4's "update `parentCoverageSHA256`" was not done. The event reference keeps the lost parent hash, because its digest is pinned in four places.
  - **Independent review, done 2026-11-17** (`e6ad547`, records under `.superpowers/sdd/…/stage1-reviews/`). Seven opus reviewers covered Tasks 8–15, 18 and the composition amendment.
    - Result: **7 REJECT** (composition part A rejected only its plan Task 5). **0 Critical, 47 Important**, about 58 Minor.
    - Everything fails closed, so nothing can falsely qualify today.
    - But much of it **cannot work in a real run** as written:
      - host/guest clock comparison
      - IPv6 route rejection
      - credential wire format
      - `/login` denied before the credential fill
      - storage model versus the role layout
      - a 60 s cleanup window that opens too early
      - Chromium's CONNECT request rejected
      - the seccomp filter likely blocks the Chromium sandbox
    - Several probes and attestations would not detect a real failure. The vsock "authentication" compares the binding with itself; the M2 broker does the same.
    - Design decisions are needed (summary §E).
    - Re-estimate: 2–4+ weeks of remediation before Stage 2, for a Path A total of roughly 6–10+ weeks.
  - **On hold pending owner decision:** the whole-M4 offline review and all fix work.

### Next sequence when Day Trader resumes

Expanded into Stages 0–7 in [docs/mvp-release-plan.md](docs/mvp-release-plan.md).

1. Reconcile `codex/production-acceptance-m1` (ledger, commits, evidence) against the identities above. Do not reset to `main` or repeat completed M1–M3 work.
2. Settle the M4 record using the local evidence above. If more reference work is needed, the blocker is the pinned ABI bundle and its narrow authority — not a new compiler install and not PF-001.
3. Finish only approved offline work; reuse committed M2/M3 interfaces; separate implementers from reviewers. Injected kernel/topology tests are never real confinement receipts.
4. Clear the Sept 22/23 release blockers, then the production release gate: fresh quiescence, verified backup/restore, re-proven staged values, owner/account/scheduler safety, data-guarded rollback, exact image publication with registry digest match, coordinated backend/frontend deploy by digest, deployed owner-flow acceptance with the scheduler still suppressed.
5. Only after separate scheduler authorization: bounded PAPER soak. Live trading stays off.

## Stack and layout

JavaScript only. Not TypeScript, not Next.js, not Prisma/PostgreSQL.

- `backend/` — Node/Express 5.1, Mongoose 8.13, nodemailer. Entry `backend/server.js`; deterministic execution gate `backend/executionGate.js`; broker, risk and reconciliation under `backend/paper/`, `backend/robotrader/`, `backend/services/`, `backend/routes/`. Unit tests in `backend/tests/`, Mongo integration suites in `backend/integration/`. Legacy `backend/aiEngine.js` returns free-form model rationale; trace reachability before changing it.
- `frontend/` — React 19.1 (react-scripts 5), react-router 6.30, Recharts, styled-components. Served by pinned nginx (`frontend/nginx.conf`).
- Runtime pin: Node 24.21.0 / npm 11.19.0 (`.nvmrc`, `engines`).
- Images: `backend/Dockerfile` (scratch runtime, uid 1000, port 8080); `frontend/Dockerfile` (nginx 1.30.4 Alpine, port 8080). Fly apps `day-trader-backend` / `day-trader-frontend` in `ord`; production images are linux/amd64.
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

**Do not run casually** — these touch real services, databases or the broker: `npm run verify:local`, `restart:check`, `smoke:api`, `alpaca:check`, `mongo:check`, `mongo:audit`, `mongo:compact`, any `fly` deploy, machine start/update/restart or secrets command, and any production preflight script. Establish isolated targets and get explicit owner authorization first.

## Hard safety rules

- Owner-only Alpaca PAPER. No live trading, customer funds, shorting, margin, options, futures, crypto, leveraged/inverse ETFs, autonomous funding, or overnight automation.
- Keep `ROBO_SCHEDULER_DISABLED=true` in every candidate. Scheduler activation is a separately authorized milestone.
- Every order-producing path (UI, routes, scheduler, model tools, retries, adapters) converges on the canonical authorization/execution boundary and one ledger. No raw broker writes from an LLM.
- Ambiguous submission stays explicitly unresolved and is reconciled before any resend. Never fail an uncertain order over to a different broker.
- Model failure halts new model-dependent risk, not reconciliation or protective management.
- Separate explicit owner authorization is required for each of: deploys/restarts, applying production secrets, DB writes, broker writes or cancellations, external SMTP, scheduler/RoboTrader activation, destructive actions, pushing, and material scope/security changes. Never run `User.syncIndexes()` or uniqueness migrations at startup.
- Never commit secrets, credential values or production identifiers, including into `docs/evidence/`. This repository is **public**.
- No profitability claims. Paper results are never presented as live results.

## Source availability

All seven canonical ChatGPT sources are now available: `00` in this repo, `01`–`06` in `~/day-trader-evidence/project-sources/2026-09-22/`. Per the export manifest, `01`, `04` and `05` are exact copies; `02`, `03` and `06` match except for one appended trailing newline. Source `04` links to evidence under `/private/tmp/day-trader-c1-disable/`, which no longer exists.

Still unavailable: the original Oct 2 ChatGPT messages for the M3 closeout, M4 blocked report and proposed remedy (retrieval attempted 2026-11-14). Do not reconstruct them from memory.

The September 22, 2026 ChatGPT task prompts (startup-readiness closeout; coordinated PAPER release v1 and v2) are in `~/Downloads/` only — historical, consumed authorizations; do not replay them.

## Working conventions

- Run `git status` first and preserve unrelated or uncommitted work.
- Work from `codex/owner-paper-mvp` unless told otherwise. Do not commit to `main`.
- Use outcome-sized isolated milestones, focused tests, and independent review of exact candidates. Use isolated worktrees for long-running work, and keep ledgers somewhere durable (not `/private/tmp`, which macOS clears).
- Report changes in this shape: goal / current owner requirement; repo, branch, exact commit; implemented files; exact command and environment; observed result; what it proves; what remains unproved; concrete blocker and next authorized action.

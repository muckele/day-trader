# Stage 1 independent review — summary (2026-11-17)

## Scope
- **Code reviewed:** `codex/production-acceptance-m1` at `31a513e`, plus the Stage 1 commits up to `132b67e` on `claude/production-acceptance-stage1`. That covers Tasks 8, 9, 10, 11, 12, 13 (the part not reviewed before), 14, 15 and 18, and the bootstrap composition v1 amendment.
- **How:** seven independent reviewers, all on the most capable model, read-only, working from a shared brief (`REVIEW_BRIEF.md`). Full reports are in this folder. The per-finding ledger is `REVIEW_LEDGER.md`.

## Result
- **7 REJECT.** For composition part A only its plan Task 5 is rejected; its plan Tasks 1–4 pass with notes.
- **0 Critical. 47 Important. About 58 Minor.**
- **Every reviewer found the real/native paths fail closed.** No code path can report `BOOTSTRAP_CONFINEMENT_QUALIFIED` or deployed acceptance today. That is because the native constructors and effect fences are deliberately unavailable, not because the checks behind them are sound.

## What the Important findings mean, by kind

### A. It cannot work in a real run
These would block Stage 2/4 even if confinement itself is correct.
- **T10-1:** the host checks guest clock readings against host clock samples within 1 ms. The two clocks are separate, so the check can never pass, and the amendment forbids that comparison. It is also the only freshness binding; there is no host-issued challenge.
- **T10-2:** the topology check rejects every `/proc/net/ipv6_route` row. Linux 6.8 always lists the IPv6 null route and the `::1` route, so the check can never pass.
- **T10-7:** the legacy capture requires the probe results within 1 ms of a timestamp taken before 12 probes run.
- **T8 note:** the exact `{0..4}` waiting-stage file-descriptor inventory almost certainly fails for any real Node worker.
- **T8-06:** the outer seccomp filter very likely blocks Chromium's required namespace sandbox. This needs a design decision.
- **T9-1:** the proxy rejects the CONNECT request Chromium actually sends, which carries `Proxy-Connection: keep-alive`.
- **T9-2:** one ordinary per-tunnel event, such as an idle tunnel or an early EOF, ends the whole run.
- **T11-I3:** the host sends the credential with a length prefix; the guest expects a newline-terminated line. No credential can be delivered.
- **T12-I2:** the state reducer denies the pre-fill traffic the design allows, so the browser cannot load `/login`.
- **T13 I-1:** the browser's first navigation is to `/`, which the route table denies before login.
- **T18-I2:** the storage model contradicts the Task 8 role layout, so admission always fails once role views exist.
- **CA-I1 / CB-I1:** the shared 60 s cleanup window opens during normal operation. Cleanup after one minute has no budget left.
- **CB-I2:** the proxy runtime authority works only inside one process. There is no cross-process proxy authority.

### B. Evidence that would not detect a real failure
- **T8-01:** the "theft" probes never attempt cross-role theft. The ptrace probe uses `PTRACE_TRACEME`; the `SCM_RIGHTS` probes read the browser's own descriptor.
- **T8-02:** the ABI probe treats any signal death as an ABI denial.
- **T8-03:** the FD-inventory probe makes no observation of its own.
- **T8-05:** test doubles are accepted as a native kernel port.
- **T10-4:** IP probes target documentation addresses where no receiver exists. This is legacy code, superseded at HEAD.
- **T10-8:** the in-guest topology test is all doubles. In a real guest it passes without attempting a single probe.
- **CB-I4:** the browser-transition validator does not check the pinned executable, and a transition stuck in its first step passes.
- **T13 I-3:** document bytes are never validated, and failures on later assets are dropped.
- **T13 I-4 / I-9:** a readiness proof can be minted from a literal value. Several status fields are hard-coded.
- **T13 I-6:** the descriptor inventory cannot see vsock or console descriptors.

### C. Security-design flaws that fail closed today
- **T9-3:** the vsock "transport authentication" compares the binding with itself, and the run capability is never sent. The **Task 5 host broker**, accepted in October with a narrow evidence exception, has the same flaw.
- **T11-I1:** after an intake failure, the credential stays reachable through the raised exception.
- **T13 I-2:** the browser worker drops the `Authorization` header but still lets the request through.
- **T13 I-8:** any duck-typed port or session is accepted. A forged port received the owner-password canary in a test.
- **T13 I-7:** route denials are swallowed and not recorded.
- **CB-I5:** a cleanup race can leave role processes running.
- **T18-I1:** one caller manages every role's storage, against the plan.

### D. Security checks that no test binds (they survive mutation)
- **T8-04:** 14 of 19 `/proc` attestation mutants survive.
- **T9-4, T9-5:** admission pinning, and the CONNECT header limit.
- **T10-3:** none of the plan's named negative tests exist.
- **T11-I2:** no-echo, leak, bound and terminal-loss behaviour.
- **T12-I1, T12-I4:** failure outcomes, and state validity.
- **T18-I3:** the out-of-scope deletion guard.
- **CB-I3:** event literals and audit-loss handling.
- **CB-I6, CB-I7:** the launch latch, and proxy substitution and completeness.
- **T13 I-10:** 12 further checks.

### E. Owner or design decisions needed
- **Seccomp deny list versus the Chromium sandbox (T8-06).**
- **Host-issued freshness challenge (T10-1).** This replaces the forbidden clock comparison.
- **Cross-process proxy authority (CB-I2), and real vsock authentication (T9-3).** The latter also touches the M2 broker.
- **Storage model versus role layout (T18-I1, T18-I2).**
- **Credential wire format (T11-I3).**

## Effect on the release plan
- **Stage 1's estimate no longer holds.** It assumed 3–5 days and "at least one remediation round". The findings span every module from M4 to M7 and include design-level rework (category E).
- **Rough remediation estimate:** 2–4+ weeks before Stage 2 can even start. On top of that come the unbuilt Tasks 16, 17 and 19–24 and the Stage 4 owned fixtures.
- **Revised Path A total:** something like 6–10+ weeks to deployed acceptance, not 3–5+. Every estimate here is rough.
- **Path B does not use the controller and is unaffected:** about 1–2 weeks.
- **On hold until the owner decides:**
  - the whole-M4 offline review (composition plan Task 11);
  - all fix work.

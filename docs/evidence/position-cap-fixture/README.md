# Position-cap-neutral acceptance candidate

Starting source: `ecfbcabdbb3b333852392ea2ecbc252f1dd8bd9d`, branch `codex/owner-paper-mvp`.
This is local acceptance-harness verification with controlled providers. It is not real PAPER acceptance or hosted CI for the new candidate.

## Scope and safety contract

Clean fixtures retain priority. A held long fallback is considered only when the fresh distinct-position count equals the unchanged owner cap. Owner symbol filters, asset eligibility, no conflicting orders, fractionability, executable ask <= $250, maxTradeAmount, total maxPositionSize, spending, loss, trade-count and canonical admission remain enforced. The actual lifecycle rejects a sixth distinct symbol at cap five and accepts an eligible add to an existing holding. No production policy file, package, runtime, owner setting or operational database was changed.

Baseline quantity is immutable and exact (synthetic example `17.582774`). Cleanup authority is derived from this run's canonical Intent/client/BrokerOrder/Fill identity chain, not from position subtraction. Full `1`, partial `0.5`, and partial `0.333333333` fills restore the exact original baseline through exact reduce-only orders. Before dispatch, fresh quantity must equal baseline plus the canonical remaining delta, and a cleanup cannot cross the baseline floor. Unexplained buys, sells, disappearance or fill-identity drift block transport. Quantity/side restoration does not promise to undo legitimate changes to the fixture's weighted cost basis; unrelated positions/orders remain protected.

Review added final-account regressions for changes to position value, maxPositionSize and maxTradeAmount; owner allowed/blocked-symbol selection; and final SELL baseline/fill drift. Missing/malformed held values fail closed, with exact upward cent conversion for valid fractional-cent exposure. Review findings were fixed and independently re-reviewed without changing production risk semantics.

Market observations use acceptance-only fixed-point integers at scale 1e9. Exact bid/ask and high-low arithmetic precede conservative cent normalization; the production cents parser remains unchanged. `250.004` is rejected. Margin remains max(sum of five exact ranges, 20 * max($0.01, exact spread)). The non-marketable BUY target is rounded downward to a cent. A ten-minute bounded query returns at most eleven bars; the latest five must be strictly ordered/nonfuture, each <= six minutes old, newest <= two minutes old. Four bars remain insufficient; no missing minute is fabricated.

Final account authorization repeats clock, quote/marketability, baseline and applicable exposure checks before the original canonical dispatch authorization. These are fail-closed boundary checks, not a promise of atomic isolation from an independent external broker actor after the last observation. Unexplained observed drift stops cleanup rather than granting broader authority.

Global budgets remain three economic submissions and one cancellation request across the whole run, including uncertain responses. Stable identity recovery and unexpected-fill early-stop behavior are unchanged. Readiness timestamp bookkeeping remains allowed by policy; no operational readiness or economic database state was accessed or changed in this task. Test mutations occur only in disposable databases and controlled loopback providers.

## Verification evidence

See `verification.json` for actual final gate counts, runner totals, mandatory named scenario outcomes, commands, and source hashes. The full raw logs remain in the local evidence directory recorded there. Intentional TDD red runs and the interrupted pre-fix verifier attempt are development evidence; they are not passing release evidence. The completed final run must have no failed, skipped or flaky tests.

Independent source reviews approved the final corrections. Targeted acceptance units, actual canonical Mongo harness, fractional/reduce-only suites, verifier contract and RC-002 tests were run under Node 24.21.0. New required identities are registered in the verifier; a large aggregate count cannot substitute for a missing scenario.

## Image evidence and remaining gates

`PRODUCTION IMAGE CONTENT UNCHANGED`: all 140 recorded backend runtime file hashes match. Runtime assembly excludes the changed acceptance scripts/tests/verifier. Backend image remains `sha256:f663986b263b6d2dcb4453d2c912971178639c7a65890f2b54e29c5f12d759a7`, linux/arm64. The existing Docker Scout v1.23.1 result is reused: 0 Critical, 0 High, 1 Medium, 8 Low, 0 Unknown. This is existing source-bound evidence, not a new scan or a claim of no vulnerabilities. Existing residual-risk and frontend dependency dispositions remain unchanged.

The new commit requires separate authorization for push and exact-SHA hosted CI, followed by separately authorized fresh real PAPER acceptance. SMTP and deployment remain later gates. No push, real Alpaca/market-data request, external SMTP, deployment, credential change or activation occurred. The untracked master brief and ignored operational configuration are preserved.

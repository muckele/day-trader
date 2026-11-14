# Day Trader — Agentic Trading Product and Revenue Roadmap

Prepared for Mathew • Research checked September 12, 2026

## Copy-ready instruction to the development agent

Act as the lead engineer and technical product partner for the existing `muckele/day-trader` application. Evolve the existing product; do not replace it with a separate Codex/Robinhood demo. This is a potential revenue-generating business, not merely a portfolio project.

Preserve this hierarchy:

- Day Trader = product and operational control plane.
- Agentic Trading = architecture.
- Codex = one replaceable reasoning/agent runtime, not the broker, scheduler, risk authority, or sole source of truth.
- Alpaca + Robinhood MCP = execution providers, each enabled only for verified capabilities and authorized use.

Product objective: research opportunities, propose and evaluate strategies, construct portfolios, execute permitted decisions, reconcile brokerage state, measure performance after costs, and improve through governed experiments. Autonomy is bounded by an owner-approved mandate. The system may decide not to trade. It must not promise profits or confuse working software with a validated trading edge.

Maintain three separate acceptance tracks: engineering reliability, strategy evidence, and commercial viability. A passing test suite does not establish profitability; a profitable backtest does not establish live safety; a successful owner-account integration does not establish permission to operate for customers.

### Evidence and current-state limitations

A read-only remote review observed `main` at `8e557f685c3112eedc2e44787fe7ee2b3adeb025`. Repository documentation describes an Express/Node backend, React frontend, Mongo persistence, deterministic analysis, paper simulation, Alpaca integration, RoboTrader settings/workers, risk checks, order reconciliation, audit records, and emergency stop. The remote tree includes several overlapping intent/order/fill models. Treat documentation as a map to verify, not proof of tested execution behavior.

GitHub Actions returned no workflow runs in this review. No local worktree, unpushed changes, current deployment, broker account, or test suite was examined or executed. Do not repeat the prior “85–90% complete” estimate. Establish readiness from current, reproducible evidence.

A legacy `backend/aiEngine.js` returns free-form model rationale. Trace whether it remains reachable before changing or retiring it; do not assume it is the live decision authority. Earlier planning documents can describe already-resolved gaps, so compare them with current code.

## 1. Scope and economic assumptions

Begin with one owner, a dedicated account, liquid US equities and unleveraged ETFs, long-only positions, regular trading hours, one strategy family, and modest decision frequency. No options, leverage, short selling, futures, crypto, autonomous funding, customer funds, copy trading, or production self-modification in the initial release. These are proposed scope limits, not claims about broker availability.

Keep the existing application stack unless a demonstrated acceptance blocker requires a change. Prefer a modular application plus durable worker boundaries over a new microservice platform. Do not rewrite the UI, switch databases, or add an agent framework simply for novelty.

Separate owner trading P&L from software revenue. Both are hypotheses. Small capital is an operational testing budget, not an income forecast. Track engineering time, recurring operating expense, and capital at risk separately. Measure excess return against an appropriate passive alternative as well as absolute net trading performance.

## 2. Target architecture

User mandate / operating policy
→ controlled data ingestion and point-in-time snapshots
→ deterministic opportunity screening
→ AgentRuntimeAdapter (Codex first; alternatives replaceable)
→ typed proposal with evidence and expiry
→ deterministic portfolio allocation and risk gateway
→ exact approval or bounded pre-authorized mandate
→ existing canonical durable order lifecycle
→ BrokerAdapter (Alpaca; separately validated Robinhood MCP)
→ broker reconciliation, portfolio accounting, monitoring, journal
→ governed strategy evaluation and promotion.

The application owns scheduling, durable workflow state, risk, broker credentials, authorization, and accounting. The LLM supplies bounded analysis and proposals. A separate risk-review model may critique proposals, but numerical and authorization limits remain executable code.

### Mandatory trust boundaries

1. The reasoning runtime cannot access raw broker credentials, arbitrary broker write tools, unrestricted broker network endpoints, production secrets, or deployment credentials. A prompt saying “obey risk limits” is not enforcement.
2. Every order-producing path—legacy routes, UI, scheduler, model tools, retry/recovery code, and broker adapters—must converge on the verified canonical authorization/execution boundary. Reuse existing models and lifecycle services where possible; do not introduce a second ledger.
3. Bind account, environment, strategy version, proposal ID, exact approved order fields, policy version, portfolio snapshot, expiry, and execution identity. Revalidate mutable facts before submission. Record durable reservations for pending exposure.
4. Reject malformed or stale proposals. Treat retrieved news, filings, tool outputs, and websites as untrusted data, not authority to change tools, policies, credentials, or destinations.
5. On ambiguous submission, retain an explicit unresolved state and reconcile before any resend. Do not pretend to provide universal exactly-once brokerage execution.
6. Never fail over an uncertain order to a different broker. A second broker is a separate account and exposure source, not an interchangeable retry destination.
7. Halting new risk must not silently disable reconciliation or remove necessary protective orders. Distinguish pause, cancel opening orders, protect existing positions, and an explicitly authorized liquidation procedure.
8. Model failure stops new model-dependent decisions, not deterministic monitoring and protective management. Revocation, database loss, broker disconnects, and restart must have tested safe behaviors.

### Proposal and journal contract

Require typed fields for account/environment, symbol, action including HOLD/NO_TRADE, proposed quantity or target exposure, strategy/version, evidence/source IDs, source and ingestion timestamps, data quality, concise thesis, invalidation conditions, proposed exit constraints, expiry, model/runtime/prompt versions, and measured inference cost. Deterministic code calculates final approved sizing and validates capability, prices, tick sizes, and current risk.

Persist input snapshots, concise rationale, permitted tool actions, decisions, rejections, approvals, order intents, fills, reconciliations, and costs. Do not request or depend on hidden chain-of-thought. Keep skipped and rejected decisions so evaluation does not selectively retain winners.

## 3. Roadmap with release gates

### Phase 0 — Repository audit, operating mandate, and commercial discovery

Verify repository/worktree/branch/HEAD/dirty state and deployment identity. Inventory existing data, auth, research, strategy, risk, execution, reconciliation, analytics, and tests. Trace one full paper order and every possible live-order path. Map overlapping `OrderIntent`, `BrokerOrder`, `Fill`, `RoboTradeDecision`, and `RoboTradeOrder` responsibilities before proposing schema changes.

Create an evidence matrix with IMPLEMENTED_AND_VERIFIED, IMPLEMENTED_NOT_VERIFIED, MISSING, BLOCKED_EXTERNAL, and NOT_IN_SCOPE. Separate historical documentation and current execution evidence. Run repository-approved checks only in isolated, non-live environments and label broker/DB-dependent skips.

Define universe, horizon, benchmark, approved loss/exposure limits, infrastructure/research spending cap, and escalation rules. Start roughly ten discovery conversations with prospective self-directed users or trading-tool builders. Test the need for governed AI research, strategy validation, and explainable execution; do not market guaranteed returns.

Gate: agreed narrow MVP, current-state evidence, ranked blockers, cost ledger, and commercial/legal assumptions recorded. No live trading or external writes authorized by this brief.

### Phase 1 — Finish and verify the existing paper-trading foundation

Prioritize authentication and account/environment isolation, validated configuration, database readiness, canonical order ownership, durable reservations, idempotency, partial fills, protection, cancellation/replacement, restart recovery, and reconciliation. Separate internal simulation from actual Alpaca paper orders in the UI and accounting.

Add reproducible CI, integration and browser acceptance tests, broker adapter fixtures, secret scanning, monitoring receipts, backup restoration, and deployment provenance. Test duplicate worker execution, accepted order with lost response, stale quote, partial fill during cancellation, protection failure, credential revocation, database interruption, and conflicting manual broker activity.

Gate: authenticated full paper journey passes; negative paths fail safely; order/fill/position accounting reconciles; restore and emergency procedures are demonstrated; no live route is accidentally reachable. A suggested multi-session operational soak is additional evidence, not a statistical proof of profitability.

### Phase 2 — Introduce a constrained agent layer

Add a replaceable runtime interface using a currently supported Codex integration. Start with one orchestrator and clear research/proposal/critique responsibilities, not a large agent swarm. Use deterministic screening to reduce expensive calls. Add structured outputs, time/tool/token limits, cost meters, provenance, freshness checks, and adversarial prompt-injection tests.

Launch read-only proposal generation first, then integrate approved proposals with the existing paper execution gateway. Keep operational safety services independent of model availability. Expose only Day Trader-controlled tools to the runtime.

Gate: valid proposals and useful abstentions on an evaluation set; malformed/untrusted content cannot gain execution authority; controlled replay and complete records; no raw broker-write bypass; verified inference spending limits.

### Phase 3 — Strategy validation and algorithm/agent/hybrid comparison

Evaluate A: deterministic baseline; B: agent-generated decisions under the same deterministic risk layer; C: hybrid screening/research/filtering/allocation. Include an appropriate passive total-return comparator and cash/exposure-aware analysis. Do not assume the hybrid wins. Use separate accounts where supported or explicitly isolated virtual sleeves with correctly attributed cash and orders.

Use point-in-time inputs, delisted names when applicable, corporate-action adjustments, realistic spreads/slippage/fill constraints, model/market-data fees, and matching evaluation assumptions. Record every parameter and strategy trial. Pre-register primary hypotheses, promotion criteria, and risk limits; use chronological training/validation/untouched tests and walk-forward evaluation. Account for dependence between trades, multiple testing, and regime concentration.

For historical LLM decisions, explicitly identify training-data contamination risk. Freezing retrieved news does not erase future events encoded in model weights. Prefer forward shadow decisions with fixed runtime versions for prospective performance evidence.

Report cash-flow-adjusted return, benchmark-relative return, drawdown, risk-adjusted metrics with uncertainty, exposure, turnover, fill quality, operating cost, and incremental value of the agent. Thirty to sixty days is an initial operational observation window, not a universal proof of edge. Do not force trading to reach a sample count.

Gate: reproducible evaluation and a defensible decision to continue, revise, or reject the candidate. Lack of economic advantage blocks scaling even if the software works.

### Phase 4 — Add a capability-verified Robinhood MCP adapter

Perform a small read-only feasibility check early, but build the production adapter after the canonical boundary is stable. Verify supported authentication and deployment model, account scoping, token lifecycle, entitlements, tool schemas, supported orders, order IDs, partial-fill visibility, reconciliation, cancellation/replacement semantics, rate limits, and authorized commercial use.

Use broker pre-trade review where available, without confusing an order preview with a paper-fill environment. Confirm whether each required capability exists rather than assuming parity with Alpaca. Reject unsupported features; do not silently downgrade them.

Filter broker responses before sending data into an LLM. Robinhood's documented read access includes other Robinhood accounts even though trade placement is limited to the Agentic account. Avoid loading unrelated account numbers and balances into prompts.

Gate: tested read-only integration and contract conformance, with a documented authorization path. Missing critical lifecycle or commercial guarantees leave the adapter in restricted owner-experimental mode. Alpaca remains sufficient for an owner-live MVP; Robinhood must not become a blocker for the core product.

### Phase 5 — Controlled owner-live canary

Only after explicit owner authorization and engineering/risk gates, move one frozen strategy to one dedicated account with a small fixed capital budget. The previously discussed $500 is an illustrative test allocation, not a return forecast or authorization to trade. Begin with per-order approval; bounded autonomy is a separate promotion.

Require account allowlists, long-only/unleveraged scope, order/exposure/loss/drawdown limits, tested protection, alerts, and no automated replenishment. Maintain a matched shadow portfolio to compare actual fills and costs. Stops and loss thresholds are controls, not guarantees against gaps or outages.

Gate: complete broker/local reconciliation, known actual execution costs, no unresolved safety defects, exercised incident procedures, and an explicit continue/stop decision. A successful small canary is not proof that larger capital will perform similarly.

### Phase 6 — Governed ongoing autonomy and economic optimization

Add portfolio-level allocation across approved strategies, concentration/correlation constraints, drift and abnormal-cost detection, independent health monitoring, and scheduled performance review. Promote candidate strategies through versioned offline tests, forward shadow, owner approval, and canary stages. Preserve immediate rollback and known-good versions.

An agent may propose changes, but cannot deploy its own code, rewrite limits, alter its mandate, expand its capital, or automatically promote a recent winner. Cache authorized data, gate costly research by material changes, and compare model providers on measured incremental utility per dollar.

Gate: documented operating envelope, tested downgrade/rollback paths, continued economic justification, and no uncontrolled learning in the live account.

### Phase 7 — Paid product beta

Run commercial discovery alongside earlier phases. Select the smallest paid product supported by actual demand: a research/validation/oversight workspace is the initial hypothesis, with governed execution added only after broker and legal approval.

Add tenant-scoped data and job isolation, per-customer consent and tokens, encrypted credential storage, revocation, usage limits, metered costs, billing, onboarding, support procedures, disclosures, and customer-specific audit export. Check data redistribution and derived-data rights, model-provider terms, privacy, open-source licenses, and the permitted use of both broker integrations. Do not reuse owner credentials across customers.

Alpaca's documented OAuth path and application approval process should be evaluated for customer integrations. Robinhood owner MCP support is not sufficient proof of a multi-tenant commercial distribution agreement.

Pricing is an experiment. For example, a $49 or $99 monthly pilot tests willingness to pay; it is not a validated market price. Seek a handful of genuinely paying, repeatedly active users before building a public self-serve platform. Track activation, retention, support time, refunds, contribution margin, acquisition cost, and payback. Low usage is not solved by adding more agents.

Gate: legal/broker/data permissions resolved for the offered service, tested tenant isolation, retained paying users, and positive contribution after variable costs. Paper performance must never be advertised as live customer results.

### Phase 8 — Selective expansion and regulated distribution

Only add further asset classes, brokers, advanced execution, B2B interfaces, or adviser partnerships when an experiment or customer case justifies the additional cost and risk. Each asset class needs its own data, risk, execution, evaluation, and authorization gates.

Personalized securities advice, automated discretionary management, copy trading, and certain fee models need specialist legal assessment. A subscription price, non-custodial broker connection, or “not financial advice” label does not resolve that question. Assess an appropriately structured registered-adviser partnership before building a broad retail robo-adviser business.

Gate: positive unit economics, demonstrated demand, explicit permissions, and independent operational review for the expansion.

## 4. Release definitions

- Agentic paper MVP: Phases 0–3. One agent-informed strategy completes a governed paper lifecycle with evidence and cost accounting.
- Owner-live MVP: Phases 0–3 plus Phase 5 on a verified provider. Phase 4 is required only when Robinhood is that provider.
- Paid-product MVP: Phase 7's narrowly approved customer service and commercial gates, reusing the relevant earlier components.
- Full governed robo trader: operating and improvement controls from Phase 6, with selective Phase 8 expansion. Full autonomy means independent operation inside a mandate, not unlimited authority.

## 5. Highest-return priorities and exclusions

Prioritize reliable accounting and reconciliation, evidence of incremental strategy value, data correctness, governed proposals, modest inference cost, simple onboarding, and customer willingness to pay.

Defer many-agent debate, expensive always-on analysis, broad asset-class support, mobile apps, social features, strategy marketplaces, autonomous retraining/deployment, multiple live brokers per strategy, and infrastructure rewrites until an identified requirement pays for them.

Maintain a scoreboard for operational incidents, unresolved orders, policy violations, net strategy performance, benchmark-relative performance, drawdown, actual model/data expense, owner time, paying customers, retention, support burden, and contribution margin.

## 6. The next development session

Start with a read-only Phase 0 audit. Do not implement the whole roadmap at once. Return:

1. Exact repository/worktree/branch/HEAD/dirty/deployment state and scope inspected.
2. Evidence matrix with code paths, tests, runtime evidence, and uncertainty.
3. A traced paper journey and inventory of every live execution entry point.
4. Existing lifecycle/model ownership and the smallest safe integration boundary.
5. A ranked Phase 1 backlog tied to acceptance evidence and economic value.
6. Actual verification commands/results, skipped tests, and external blockers.
7. A proposed bounded first implementation increment, plus explicit non-goals.

Preserve unrelated changes. Do not create broker connections, modify credentials, place or simulate real-account orders, transfer money, deploy, push, or enable live trading under this instruction. Design and audit authorization are not trading authorization.

## 7. Source register and verification notes

Primary sources checked for this roadmap are listed below. Recheck mutable API and legal details before implementation. The papers inform evaluation design; they do not establish that Day Trader is profitable.

- Repository baseline, backend README, existing upgrade plan, backtesting-validation notes, AI module, and Actions endpoint. Code inspection was limited and no tests were run.
- Robinhood Agentic Trading overview: supported agent connections and broader read scope versus restricted trading scope.
- Robinhood Trading with your agent: order review/place/cancel tools, supported assets, and account rules.
- OpenAI current Codex SDK documentation: SDK/App Server integration; current documentation says the old `codex mcp-server` command has been removed. This supersedes older integration examples.
- Alpaca paper-trading and order documentation: simulation limitations, client order identifiers, and order-state tracking.
- Alpaca OAuth documentation and support: delegated customer access and third-party live application approval.
- FINRA Regulatory Notice 26-10: new intraday margin framework effective June 4, 2026, with broker phase-in through October 20, 2027. Do not assume identical rules across accounts during transition.
- California DFPI investment-adviser guidance and SEC materials: commercialization requires service-specific legal assessment.
- Research on backtest overfitting, LLM historical knowledge leakage, and strategy-search selection bias.

```text
https://github.com/muckele/day-trader/tree/8e557f685c3112eedc2e44787fe7ee2b3adeb025
https://robinhood.com/us/en/support/articles/agentic-trading-overview/
https://robinhood.com/us/en/support/articles/trading-with-your-agent/
https://learn.chatgpt.com/docs/codex-sdk
https://docs.alpaca.markets/us/v1.4.2/docs/paper-trading
https://docs.alpaca.markets/us/docs/orders-at-alpaca
https://docs.alpaca.markets/us/docs/using-oauth2-and-trading-api
https://alpaca.markets/support/oauth-applications
https://www.finra.org/rules-guidance/notices/26-10
https://dfpi.ca.gov/regulated-industries/broker-dealers-and-investment-advisers/state-licensed-investment-adviser/
https://www.sec.gov/newsroom/press-releases/2024-42
https://www.sec.gov/enforcement-litigation/administrative-proceedings/ia-5745-s
https://escholarship.org/uc/item/4w1110bb
https://arxiv.org/abs/2605.24564v2
https://arxiv.org/abs/2608.27734v1
```

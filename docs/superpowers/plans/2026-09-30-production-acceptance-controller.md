# Production Acceptance Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a qualified local acceptance system that observes the exact approved PAPER application through one owner UI session, survives a separately authorized backend restart, revokes the session, accounts conservatively for reads and removes private runtime state.

**Architecture:** A signed Swift Apple Virtualization.framework launcher runs an ARM64 Linux guest with no network device or host filesystem share. Guest controller/browser traffic can leave only through the finite loopback CONNECT proxy, proxy-only virtio-vsock and separate two-destination host broker, while the state machine independently enforces application routes and lifecycle. A separate release/evidence authority supplies signed release, maintenance, accounting and restart facts and receives no owner credential.

**Tech Stack:** Swift, Apple Virtualization.framework, Foundation/Darwin/CryptoKit and XCTest; immutable Ubuntu 24.04 ARM64 Linux; Node.js CommonJS plus node:test and pinned official Playwright/native ARM64 Chromium; Linux seccomp/no_new_privs/namespaces; Python standard library for guest bootstrap/TTY/socket/filesystem helpers and unittest; virtio-vsock, anonymous pipes and narrowly authenticated guest-local Unix IPC. No Rosetta, third-party Swift package, libseccomp package or general RPC framework is selected. Offline appliance construction requires separately approved pinned Ubuntu filesystem utilities; these are build prerequisites, not added application dependencies.

**Spec:** [docs/PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md](../../PRODUCTION_ACCEPTANCE_CONTROLLER_DESIGN.md), approved explicitly by Mathew for planning only. Spec SHA-256: `61fb4ab7e4df51e8251f3e5302ff819e319036ce91a1eaa9d0eabaf4870173a6`. B1 architecture verdict: `B1_ARCHITECTURALLY_CLOSED`; no runtime qualification is inherited.


## Authorized M1 implementation amendment — 2026-09-30

This explicit user-authorized amendment supersedes the planning-only restriction for Tasks1–4 and their offline integration/reviews/local commits only. Stop before Task5/M2. The approved design remains byte-identical; original design and plan are preserved in local commit db59283. No dependencies, network, listeners, browser/VM, Docker/CodeLift, production clients/credentials, remote Git or operational execution. Existing owner/hosted branches remain unchanged.

### Installed tools and Swift Testing substitution

M1 uses /Users/Matt/day-trader-toolchains/node-v24.21.0-darwin-arm64/bin/node, /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 (3.12.2), and /Library/Developer/CommandLineTools/usr/bin/swift (6.4, swiftlang-6.4.0.34.1), command-scoped DEVELOPER_DIR=/Library/Developer/CommandLineTools, SDK27.0. Built-in Swift Testing2084 is approved for M1 only. XCTest remains unresolved: installed full Xcode requires unapproved setup. Separate dependency-free smoke executed3named Foundation/CryptoKit tests successfully (JSON round trip, known SHA256, Ed25519 signature and altered-message rejection),0failures/0skips. This is toolchain evidence, not feature RED/GREEN evidence. Evidence: /Users/Matt/.codex/visualizations/2026/09/23/01a0d016-20be-7791-a972-ef380f45a070/production-acceptance-m1/toolchain-smoke-swift-testing/.

Task1 ContractsTests.swift retains suite ContractsTests and every specified assertion, expressed using import Testing, @Suite/@Test, #expect/#require (including throws assertions). Task3 ReceiptTests.swift retains ReceiptTests and every adversarial and bidirectional interoperability assertion in Swift Testing. Tasks2/4 Node tests are unchanged; their applicable broad Swift runs discover both suites. No conditional imports, skip annotations, empty-run success or assertion loss. Reviewers verify executed named tests and full assertion coverage. Future XCTest references in Tasks5–24 are deferred plan-maintenance items, not migrated now.

Package.swift initially contains ONLY AcceptanceCore library and test target; no later executable targets. Choose .macOS(.v14) for this offline M1 host test package, compatible with installed Testing framework and current host; this does not qualify future production/appliance compatibility. Keep Foundation/CryptoKit APIs and canonical/receipt rules unchanged.

All M1 Swift commands use `swift test --package-path tooling/production-acceptance/host --scratch-path <M1-evidence>/m1-swift/diagnostic-task1-fresh/build --cache-path <M1-evidence>/m1-swift/diagnostic-task1-fresh/cache --config-path <M1-evidence>/m1-swift/diagnostic-task1-fresh/config --security-path <M1-evidence>/m1-swift/diagnostic-task1-fresh/security --disable-dependency-cache --disable-experimental-prebuilts --disable-prefetching --disable-automatic-resolution --skip-update --disable-netrc --disable-keychain --manifest-cache local -j 2 --disable-xctest --enable-swift-testing`, with absolute Swift above. Add `--filter ContractsTests` or `--filter ReceiptTests` for focused runs; unfiltered final runs must execute both suites. CLANG_MODULE_CACHE_PATH, SWIFTPM_MODULECACHE_OVERRIDE and XDG_CACHE_HOME point respectively to clang, modules and xdg under <M1-evidence>/m1-swift/diagnostic-task1-fresh; no SDKROOT override. Review manifest/tests before each command-scoped approved invocation; SwiftPM own sandbox stays enabled. No parallel Swift builds or duplicate caches. Keep warnings in evidence; no manual signing. Git branch/add/commit operations may request the user-authorized normal command-scoped approval with exact paths and no persistent broad rule.

### Reviewed M1 Swift invocation correction — 2026-10-01

The previously generated M1 build metadata omitted the Testing macro discovery paths present in the retained successful smoke. Actual installed CLT Testing2084, matching ARM64 TestingMacros library and plugin servers were present; no missing-library claim. A fresh macOS14 macro fixture executed2tests without an added plugin option, so that proposed option was rejected as unnecessary. Actual Task1 with fresh task-owned output/cache state and original argument/environment pattern resolved the macros. Two nested #require expressions were split without assertion loss; actual Task1 then executed12behaviorally failing tests (110issues), not a compiler failure. Independent configuration reviewer /root/m1_swift_configuration_review approved reuse of the proven root above, original flags/macOS14 and no manual plugin option. Historical inherited environment was incompletely captured, so cache state alone is not established as the root cause. All original caches/logs remain preserved; reuse one active root serially, no purge. Exact reproducible command/environment and comparisons reside in the task-owned Task1 evidence directory; diagnostics do not establish feature completion. Full Task1 review must independently assess finite schema choices and source-tree schema loading, including its explicit future packaging limitation.

### Eligibility, reservation and one-use permit interfaces

Task2 `admitRequest(request, policy)` returns `ELIGIBLE(routeId,cost)`, ABORT_EXPECTED, REPLAY_PRIVATE or FAIL. ELIGIBLE is an opaque internally bound decision, never permission to transmit. `createPolicy(release, assets, context)` accepts an injected trusted context with synchronous `snapshot()`/clock/body validation capabilities; no network/state-machine implementation. Task2 owns private atomic route counters, request/body binding, phase/session/policy epoch and timer/Home state. Context is established by trusted caller; no browser-authored boolean can establish trust. A module-local body-proof constructor validates supplied synthetic/intercepted bytes against exact LOGIN_JSON/ABSENT rules and returns a nonserializable request-bound proof; it is not a browser worker or transport. Actual worker integration remains Task13.

Task2 exposes `claimEligibility(decision, request, policy)` and `revalidateEligibility(claim, request, policy)`: identity-branded opaque decision/claim, exact request and private body handle, run/requestId/sequence/phase/route binding, one claim only, all relevant facts captured and compared. Initial eligibility consumes route ceiling atomically; failures never restore it. A copied object is not a valid decision or claim. Revalidation performs no new counter consumption, and rechecks expiry, current phase, gate/session/policy epochs and complete request facts against the trusted context. Providers require phase-appropriate verified readiness plus maintenance; preauth/login require their preauth gates without authenticated readiness. Zero-cost routes still require their exact gates/body/phase/ceilings. Verified receipt branding is supplied by Task3; Task2 unit tests may use injected trusted boundary doubles, but final composition must use actual verified receipts.

Task4 `createBudget(verifiedLedgerReceipt, ports)` retains reserve/settle/finalize accounting interfaces and adds `authorize(request, policy): Promise<Permit>` plus `consumePermit(permit, request, policy): Admission`. authorize obtains/claims eligibility, serializes route-cost reservation, waits for JournalPort acknowledgement, revalidates current gates/request, and only then issues an opaque identity-branded permit. consumePermit atomically consumes once, revalidates again and returns the fixed bound admission record; it never transmits. Plain objects/copies/replays or a route decision alone fail consumption. Policy/request/body/phase/expiry/session/epoch mutation invalidates pending or issued authority. Reservation or journal failure yields no permit; committed allocations and uncertain outcomes remain conservatively charged. Failed consumption does not refund. A failed consumption attempt consumes/latches the permit rather than allowing retries. Exact field representations are documented in the task report and reviewed; no dynamic privilege expansion.

All asynchronous provider reservations are serialized and bounded by both per-route ceilings and the independent PAPER/stock envelope, including concurrent requests. Full-run external reservation is not double-counted with allocations and survives modeled local loss. M1 only uses injected fake journal/ledger/trusted-context boundaries; it makes no real durability, process-isolation, live-readiness or global-backend-egress claim.

Task4 also creates tooling/production-acceptance/tests/unit/m1-admission.integration.test.cjs, composing real receipt/policy/budget modules. Prove all user-required paths: valid receipt→eligible→acknowledged reserve→one consume; no permit from eligibility alone or failed journal; invalidation during await or before consume; request/body/phase changes and reuse denied; concurrency ceilings; uncertainty retained; local loss cannot free external envelope; untrusted receipt initialization denied; economic routes denied; Home denials consume no provider allowance/permit; zero-cost auth remains bound. Three-language canonical agreement and Node↔Swift signatures remain mandatory. Minimal earlier-M1-file changes needed by later tasks are allowed and included in review.

### Private maintenance/DB comparison binding

The finite M1 maintenance and DB schemas require private identityComparisonId: an opaque run-specific256-bit lowercase hexadecimal identifier, not a hash of owner/account values. Task3 TrustContext supplies the independently expected identifier associated by the approved evidence authority with the exact private owner/account comparison. Require exact equality in addition to run/config binding and signed exact-match booleans; a receipt cannot authorize its own expected value. Never include this identifier in public records. This correlates the trusted authority's claim, not proof beyond the signer-honesty assumption. Full Task1/Task3 reviews must assess this representation; no raw owner/account rows or operational access is added.

### Scope and resource gates

Fresh implementer and separate reviewer per task, sequential Tasks1→2→3→4, behavior RED/GREEN, then independent whole-M1 review and fresh final tests. No load-bearing defect may be waived at a review cap. Source file scope remains original Tasks1–4 plus the named composition test and this focused plan amendment. Preserve worktree/branch/runtime/ledger/reviews; no merge/push/deletion. Before significant compilation batches and task boundaries, measure filesystem available bytes and require estimated remaining growth plus a2GiB working reserve. Initial conservative remaining growth estimate is1GiB for one reused serial Swift build/cache and bounded test/evidence output, not a proven machine minimum. No cleanup required at resume: available51041550336bytes on shared device16777233. Deferred M3 ARM64 construction venue/artifact delivery, owned public HTTPS fixtures/receiver evidence and later concrete VM/build budget remain unresolved and unprovisioned.

## Global Constraints

- This milestone creates only this plan. No implementation, installation, browser download, construction, VM/browser/network/synthetic execution, commit or operational activity now. Production remains paused.
- Zero Docker use on the Mac; no Docker Desktop or CodeLift inspection, change, shared VM, network or volume. No task delegates such work to a helper.
- No guest NIC/NAT/bridge/VPN/packet relay, host filesystem share/VirtioFS/home/project mount/clipboard or personal Chrome profile. No privileged persistent Mac network changes or trust-store edits.
- Read-only immutable acceptance base; all run-specific writable state in guest tmpfs; no guest swap, zram swap, hibernation, saved-state restore or arbitrary writable disk containing run secrets. Host encrypted swap, memory remnants and diagnostics remain explicit residuals.
- Browser/controller/verifier AF_VSOCK denied across descendants; only trusted proxy uses AF_VSOCK to CID2 port4050. No inherited/stolen/donated bridge, ring or console descriptors. Only the dedicated trusted intake/export component holds the approved operator console; automation worker/browser/verifier cannot access it directly.
- Proxy127.0.0.1 only, CONNECT only, exactly two release-bound hosts, host broker TCP443 only, no generic SOCKS/UDP/arbitrary DNS or browser direct DNS. Production TLS is normal public-CA hostname-verified end to end; no MITM/custom CA/ignoreHTTPSErrors.
- Broker has no plaintext owner/password/session/DOM channel; controller has no Fly/provider/SMTP/Mongo credential; release operator has no owner credential. No project .env import or ambient secret inheritance.
- One browser family/context/session. No re-login after restart, API-login replacement, cookie injection/export/storageState or personal profile. No screenshots/video/trace/HAR/downloads, service workers or extensions.
- Exact source-derived default-deny route/origin/method/query/phase ceilings; no arbitrary same-origin access, redirects or economic mutation. Readiness and separately proved maintenance/quiescence precede deeper observation. No email/queue action.
- Source-derived maximum14 new PAPER reads (clock2/account8/positions3/history1), stock0; fresh approved historical ledger/ceilings required later. Durable full-run reservation outside VM, reserve before forwarding, uncertain sends stay charged; no retries or budget reset after loss. These are scoped controller guarantees, not global backend egress control.
- Actual UI logout and current/prior-session401 required; all-owner-session revocation is a side effect requiring later explicit approval. Local cookie deletion or VM destruction is not server revocation.
- Public evidence excludes balances/symbols/order contents/account IDs/password/cookie/JWT/DOM/body/nonce/raw errors/crash names or contents. Fixed records <=4KiB, total<=256KiB; tmpfs run256MiB/crash1MiB initial bounds, /dev/shm manifest-sized; no false erasure claim.
- Run<=20min, HOLD<=10min, credential grant<=120s, cleanup<=60s; all fit source one-hour session expiry. Failure never resumes, reauthenticates, deploys, rolls back or activates automatically.

## Review Focus

1. **Network-capable FD or helper escape:** a hostile browser/helper/verifier must not acquire vsock, io_uring, console, proc/pidfd or Unix-donated bridge authority; Task8 `child_fork_exec_network_gpu_crash_helper_inherits` and descriptor-theft tests, then Task23 actual descendant probes and N20/N21 network-surface probes (RF1).
2. **Runtime topology drift:** unexpected NIC/route/resolver/loopback or Unix relay must block before prompt and latch failure after admission; Task10 `unexpected_NIC_default_v4_v6_route_DNS_listener_fail_before_prompt` and drift test, Task23 live injected listener (RF2).
3. **Same-host economic request:** valid broker confinement must not permit a forbidden trade/configuration action; Task2 `same_host_economic_post_denied`, Task15 source-contract binding and Task23 hostile frontend/HTTP2-origin fixture (RF3).
4. **Abrupt loss at a side-effect boundary:** uncertainty remains charged, logout may be unconfirmed, and failure cannot become success; Task4 `crash_after_reserve_keeps_external_envelope`, Task21 interruption matrix and Task23 VM kill (RF4).
5. **Private data crossing guest/host boundary:** password/session/profile/DOM may not enter console logs, public schema or host files; Task11 synthetic output-canary, Task19 `password_cookie_JWT_owner_balance_symbol_order_DOM_fields_reject`, Task20 malicious serial frames, Task23 storage/export checks (RF5).

---

## Baseline, repository decisions and planning scope

Authoring worktree `/private/tmp/day-trader-standin-exit`, branch `codex/hosted-acceptance-tooling`, starting HEAD `916d2ade0ca83e6d7c21fb9d81caa52c88e16fbe`; application candidate `852fb22d9facf4bfe0bca7f419e22ee4bfbba17f`; historical hosted run36805206998 qualifies synthetic tooling only. The approved design was already untracked at planning start and must remain byte-identical. Exactly one new file is added by this task; that preexisting design is not a second change attributable to planning. Original checkout/master brief remains untouched.

Read-only inspection found hosted tooling uses focused CommonJS `.cjs` modules with `node:test` and Python stdlib `unittest`; existing Superpowers plans live in this directory. Follow those test conventions in a new isolated tooling subtree. Read-only references are hosted policy/entry-policy/browser code, frontend Login/AuthContext/index/market timer and three views, backend runtimeReadiness/sessionCookie/auth and provider cost sources listed in the spec. Do not import hosted execution launchers or run root/backend/frontend broad scripts: some contact operational services. No backend/frontend/hosted-tooling/workflow edits are planned.

Node on the authoring PATH is24.19.0 while application manifests require24.21.0; do not mistake availability for an approved runtime. Pin Node24.21.0 for new tooling and matching guest bytes after explicit dependency approval; exact Playwright/Chromium and Python/kernel/Ubuntu patch versions and hashes require a reviewed appliance input manifest. Official Playwright1.58.2 ARM64 distribution establishes viability, not an automatic new download approval. Swift/XCTest/Foundation/CryptoKit use the approved installed SDK; no third-party package resolution. Python helpers are justified by termios/socket/proc/filesystem and native syscall bootstrap needs, not a new web stack.

**Console wording resolution:** the request's prohibition on controller console access applies to the automation worker and every untrusted descendant. The approved design expressly requires a trusted intake/export component within controller authority to own the serial operator channel. Task8/11 isolate that component and provide a bounded private pipe to the worker; browser/verifier/worker receive no raw TTY FD or device view. There is no new generic controller-to-host relay.

The one-document instruction supersedes the skill's suggestion to split independent subsystems into separate plans. Tasks below are independently reviewable deliverables inside this single plan. No implementation bodies are supplied.

## Contract and policy catalogue

- **Wire identity/types:** RunId is a random128-bit lowercase hexadecimal identifier; Digest is lowercase SHA256 hex; Seq is a positive safe integer; Destination wire enum is FRONTEND|BACKEND (maps to exactly two verified hostnames); Phase is the eleven names in Task12/spec§17. Frame includes version1, runId, sequence, kind, fixed payload; no arbitrary URL, path, command or unknown field. Max control256B, receipt16KiB, CONNECT header4KiB, public record4KiB/total256KiB; intake max4096UTF-8 bytes proposed parser ceiling, fail rather than truncate. Nested inputs max8 schema levels. Manifest must set aggregate tunnel bytes, idle deadline, VM resources and /dev/shm bound before execution; absence fails, no runtime widening.
- **Failure enum:** INVALID_FRAME, IDENTITY_MISMATCH, SIGNATURE_INVALID, EXPIRED, REPLAY, TOPOLOGY_INVALID, ROLE_INVALID, TRANSPORT_LOST, TLS_INVALID, ROUTE_DENIED, BUDGET_EXCEEDED, ACCOUNTING_UNCERTAIN, CREDENTIAL_INVALID, SESSION_MISMATCH, READINESS_FAILED, OBSERVATION_FAILED, STORAGE_INVALID, PRIVACY_FAILED, CLEANUP_INCOMPLETE, DEADLINE, INTERNAL_FAILURE. Raw exception text never enters a public record. Classification is PUBLIC_FIXED, PRIVATE_MEMORY, PRIVATE_TMPFS or FORBIDDEN_INPUT; private values cannot be serialized as public fields.
- **Receipt schemas:** all use version/kind/runId/sequence/issuedAt/expiresAt/keyId/signature with strict field sets and domain-separated Ed25519 canonical bytes. Release adds intendedApp, environment, appSHA, frontend/backend registry and platform digests, origins, assetManifestDigest, configIdentity, operationId and expectedInstances. Restart adds approvedOperationId, nonce, action=`backend-restart-only`, app/environment, backend digest, every pre/post instance ID/start time, sameConfig, completedAt and success. Asset entries are exact path/hash/size/MIME. Ledger adds authority, separate PAPER/stock historicalCharged/unresolved/ceiling/fullRunReserved/remaining values, canonicalAdapter and configuration identity. Maintenance and DB receipts bind exact private owner/account comparison, unique preexisting settings, lease/work/worker/exclusive-window predicates, comparison scope/completeness and exact allowed auth/startup deltas; no raw rows are public. Signers are supplied out-of-band, never trusted from receipt itself.
- **Data interfaces:** RequestFacts={requestId,rawTarget,origin,method,path,queryPairs,headers,phase,bodyProof}; PolicySnapshot binds run/origins/asset entries/counters/sessionIssued/documentPath/private response handle/freshness. PublicRecord has fixed record-kind-specific fields, run/sequence, approved digests, enum outcomes, booleans and nonnegative count/timing aggregates only. BrowserWorkerPipe carries only fixed action IDs (LOGIN_FIELDS, LOGIN_CLICK, READ_OWNER_COOKIE, OBSERVE_VIEW, SIGN_OUT, CLOSE), correlated ROUTE_REQUEST/ROUTE_DECISION and bounded private results. Schema-bound private IPC records are <=16KiB, and larger bodies remain in worker memory behind opaque handles; no body truncation accepted as proof. RuntimeIdentity binds base/kernel/initramfs/config/role policy/controller/proxy/Node/Python/Playwright/Chromium/host binaries and SDK compatibility hashes. Interface types named in tasks are records/unions defined by these schemas plus local nonserializable handles; they are not dynamically extensible maps.
- **Appliance layout:** install authored guest modules at `/opt/acceptance/guest`, shared contracts at `/opt/acceptance/contracts`, approved Node dependency bytes at `/opt/acceptance/node_modules`, and probes at `/opt/acceptance/tests/guest`; all are in the immutable base. The matching verified kernel/initramfs mounts that base read-only and enters the fixed trusted bootstrap `confinement.py`, which prepares tmpfs and starts only manifest-pinned roles/executable IDs. Acceptance role UIDs are controller10001, browser10002, verifier10003 and proxy10004; private roots are `/run/acceptance/{controller,browser,verifier,proxy}`. Bootstrap privileges are confined to guest initialization and do not become a general post-start root RPC. Kernel manifest requires seccomp/filter, namespaces, virtio console/block and CONFIG_VSOCKETS/CONFIG_VIRTIO/CONFIG_VIRTIO_VSOCKETS; missing support blocks construction/admission. Matching interpreter paths/hashes are mandatory in the manifest, never resolved from a mutable download.
- **Private body admission:** BodyProof={runId,requestId,byteLength,schema:ABSENT|LOGIN_JSON|INVALID,validated:true|false,privateDigestHandle}. Trusted browser worker obtains the intercepted request bytes itself, rejects duplicate/unknown JSON fields and nonstring username/password, and validates login body<=16KiB with exactly those two keys before emitting a proof; it never forwards body/password bytes into logs or public frames. Logout matches current AuthContext `axios.post('/api/logout')`: zero body bytes, not `{}` or arbitrary JSON. GET/OPTIONS also require absent body. The controller's atomic route/cost gate accepts only the correct body schema for that exact correlated request ID and phase. Worker binds an unforgeable internal proof/permit to its immutable intercepted request object and raw byte digest handle, checks it again before continuation and permits no request-body override; no browser/DOM-authored boolean is trusted as BodyProof. Proofs cannot be reused for another request, and private digest handles are never published. Future source-contract drift requires review, not a looser body rule.
- **Ports:** Clock is injected monotonic time plus qualified wall clock for signed expiries. ByteStream is bounded opaque read/write/close. RunBinding binds run/manifest/destinations/deadline/capability; capabilities stay private. AdmissionProof combines role/topology/storage and verified external receipts and cannot be constructed from a browser-supplied boolean. KernelPort and filesystem/stream doubles enable offline tests; their real adapters are exercised in the VM, not assumed from mocks.
- **Route table:** transcribe every design§10 row into routes.json with exact methods/queries/phases/costs. P/A/B/H/C/L/V semantics unchanged: login once; logout once; me ceilings2/2/1/1/2 for P/A/B/C/V; readiness B2/C2; market P1(0cost), B1/C1(1clock each); Robo settings/decisions/orders/performance/audit/health/reconciliation B1/C1 with exact design queries; performance2 and health1 per phase; Portfolio account/equity B1 each(cost2 each); Activity orders/trades B1 each(cost1 each), notifications B1(cost0); health P1/C1. Frontend exact login/home/robo/portfolio/activity paths and manifest assets max5each; exact CORS login/logout OPTIONS only as emitted. All other methods/routes denied, including same-host trade/configuration endpoints.
- **Timer/Home exceptions:** Home transition10s, exactly one denied recommendations and one denied watchlist/default, zero forwarding; quotes/sparkline denied. Preauth401 replay only no issued session AND/login document,32total P/A. Authenticated B/C fresh actual clock response max60s old,32replays per phase; no invented200. Expected timer abort ceilings A2, B/C4each, H24, L/V2each. Invalidate on HOLD/restart/session/failure. No view proof inH/L/V; stale data/error fallback cannot prove UI success.
- **Readiness:** contractVersion2; profile owner-paper-maintenance; runtimeReady and maintenanceReady true; checks ownerConfiguration, authenticationConfiguration, databaseConnected, ownerIdentity, ownerSettings, persistence, paperMode, automationDisabled, schedulerSuppressed, paperDestination, paperBindingConfiguration, paperCredentialConfiguration all pass. enabled/isEnabled/liveEnabled=false, schedulerSuppressed=true, activationAuthorized=false; releaseReady irrelevant. External quiescence/DB authority stays separate; settings GET can mutate if missing and must never be used to create it.

## Planned File Structure

Every path below is a future path, not a file created in this planning milestone. Each has one responsibility; tests are also explicitly mapped. No application or existing tooling file is modified. Later tasks may modify only files introduced by earlier tasks as listed.

| Future file | One responsibility / owner task |
| --- | --- |
| `tooling/production-acceptance/contracts/schema.json` | Single finite wire schema, enums, limits and data classifications. Task1. |
| `tooling/production-acceptance/contracts/vectors.json` | Language-neutral valid/invalid canonical protocol vectors; synthetic values only. Task1. |
| `tooling/production-acceptance/guest/contracts.cjs` | Node strict decoder, typed validation and canonical bytes. Task1. |
| `tooling/production-acceptance/guest/protocol.py` | Python standard-library decoder for bootstrap, proxy and intake subsets. Task1. |
| `tooling/production-acceptance/host/Package.swift` | Swift package with AcceptanceCore library, acceptance-host and acceptance-broker executables, and XCTest target; no third-party packages. Task1. |
| `tooling/production-acceptance/host/Sources/AcceptanceCore/Contracts.swift` | Swift strict decoder/encoder for the same shared contract. Task1. |
| `tooling/production-acceptance/tests/unit/contracts.test.cjs` | Node contract vectors. Task1. |
| `tooling/production-acceptance/tests/unit/protocol_test.py` | Python contract vectors. Task1. |
| `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/ContractsTests.swift` | Swift contract vectors. Task1. |
| `tooling/production-acceptance/guest/route-policy.cjs` | Pure source-derived request admission and phase counters. Task2. |
| `tooling/production-acceptance/contracts/routes.json` | Finite routes/costs/ceilings transcribed exactly from design §10. Task2. |
| `tooling/production-acceptance/tests/unit/route-policy.test.cjs` | All exact route rows, parser adversaries and timer boundaries. Task2. |
| `tooling/production-acceptance/guest/receipts.cjs` | Verification-only guest release/restart/ledger/quiescence/DB receipt handling. Task3. |
| `tooling/production-acceptance/host/Sources/AcceptanceCore/ReceiptVerifier.swift` | Host signature, release/appliance binding and bounded operator receipt verification. Task3. |
| `tooling/production-acceptance/tests/unit/receipts.test.cjs` | Guest signatures, canonical parsing, manifest and replay cases. Task3. |
| `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/ReceiptTests.swift` | Cross-language signature verification and host field binding. Task3. |
| `tooling/production-acceptance/guest/budget.cjs` | Atomic run-envelope and per-route reservation state with injected journal/authority ports. Task4. |
| `tooling/production-acceptance/tests/unit/budget.test.cjs` | Charge ordering, crash windows and reconciliation invariants. Task4. |
| `tooling/production-acceptance/host/Sources/AcceptanceCore/EgressBroker.swift` | Finite destination mapping, numeric connection and bounded opaque tunnel lifetime. Task5. |
| `tooling/production-acceptance/host/Sources/AcceptanceBroker/main.swift` | Separate normal-user broker executable reading only inherited dedicated pipes. Task5. |
| `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/BrokerTests.swift` | Resolver/connector doubles, malformed controls and tunnel outage. Task5. |
| `tooling/production-acceptance/host/Sources/AcceptanceCore/VMConfiguration.swift` | Allowlisted VZ configuration and appliance identity verification without starting a VM. Task6. |
| `tooling/production-acceptance/host/Sources/AcceptanceCore/VMHost.swift` | VZ lifecycle, sole vsock listener and per-run descriptor ownership. Task6. |
| `tooling/production-acceptance/host/Sources/AcceptanceHost/main.swift` | Bounded launcher CLI and lifecycle wiring; never a shell or general remote service. Task6. |
| `tooling/production-acceptance/host/virtualization.entitlements` | Only required virtualization entitlement, subject to separate signing approval. Task6. |
| `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/VMConfigurationTests.swift` | Device configuration factory and lifecycle fake assertions. Task6. |
| `tooling/production-acceptance/appliance/manifest.schema.json` | Exact appliance/input identity, kernel, paths, devices, versions and resource bounds. Task7. |
| `tooling/production-acceptance/appliance/assemble.py` | Offline ARM64 Linux image assembler from pre-approved verified inputs; no downloader. Task7. |
| `tooling/production-acceptance/appliance/README.md` | Reproducible construction prerequisites, immutable artifact transfer and acceptance/build separation. Task7. |
| `tooling/production-acceptance/tests/unit/appliance_test.py` | Manifest validation, archive safety and offline image-tool invocation with fakes. Task7. |
| `tooling/production-acceptance/guest/confinement.py` | Four-role trusted bootstrap, namespaces/UID/capabilities/FD allowlists and inherited seccomp. Task8. |
| `tooling/production-acceptance/guest/role-ports.cjs` | Node adapter adopts only bootstrap-established fixed role pipes and exit/stop handles. Task8. |
| `tooling/production-acceptance/tests/unit/role-ports.test.cjs` | One-use role activation and audited handle ownership tests. Task8. |
| `tooling/production-acceptance/tests/guest/confinement_probe.py` | Unprivileged adversarial socket/FD/child probes, with structured results only. Task8. |
| `tooling/production-acceptance/tests/unit/confinement_test.py` | Policy construction and syscall/FD adapter assertions. Task8. |
| `tooling/production-acceptance/tests/guest/confinement_test.py` | Real ARM64 kernel role-boundary checks inside approved synthetic VM. Task8. |
| `tooling/production-acceptance/guest/proxy.py` | Stdlib loopback CONNECT parser and sole guest vsock tunnel role. Task9. |
| `tooling/production-acceptance/tests/unit/proxy_test.py` | CONNECT parser, stream/loss handling and no-retry behavior. Task9. |
| `tooling/production-acceptance/guest/topology.py` | Guest interface/route/resolver/listener/process policy admission. Task10. |
| `tooling/production-acceptance/tests/guest/topology_test.py` | Runtime topology and forbidden-path probes before browser execution. Task10. |
| `tooling/production-acceptance/tests/unit/topology_test.py` | Parsed inventories including adversarial drift. Task10. |
| `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift` | No prompt/browser after failed topology or role attestation. Task10. |
| `tooling/production-acceptance/host/Sources/AcceptanceCore/SerialConsole.swift` | Host TTY/no-echo phase framing and nonlogging serial pipes. Task11. |
| `tooling/production-acceptance/guest/intake.py` | Guest TTY single-use consume and bounded private handoff. Task11. |
| `tooling/production-acceptance/tests/unit/intake_test.py` | PTY/no-echo/cancellation/one-use tests using synthetic secrets. Task11. |
| `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/ConsoleTests.swift` | Host PTY, serial framing, escape and restoration tests. Task11. |
| `tooling/production-acceptance/guest/state.cjs` | Pure transition reducer and bounded phase deadlines. Task12. |
| `tooling/production-acceptance/tests/unit/state.test.cjs` | Every valid transition and forbidden action/failure latch. Task12. |
| `tooling/production-acceptance/package.json` | Only pinned Playwright runtime dependency and local unit scripts. Task13. |
| `tooling/production-acceptance/package-lock.json` | Exact approved dependency resolution, no browser binaries. Task13. |
| `tooling/production-acceptance/guest/browser.cjs` | Controller-side finite browser-worker RPC over audited inherited pipes. Task13. |
| `tooling/production-acceptance/guest/browser-worker.cjs` | Trusted browser-role worker owns Playwright and launches Chromium normally inside its inherited confinement. Task13. |
| `tooling/production-acceptance/tests/unit/browser.test.cjs` | Launch/context configuration and transport invariant spies. Task13. |
| `tooling/production-acceptance/tests/guest/browser_test.cjs` | Actual pinned ARM64 Chromium sandbox, child FD and proxy checks. Task13. |
| `tooling/production-acceptance/guest/session.cjs` | UI login, exact owner/cookie checks and private continuity handle. Task14. |
| `tooling/production-acceptance/tests/unit/session.test.cjs` | Page/context doubles, one-use login and cookie invariants. Task14. |
| `tooling/production-acceptance/tests/guest/session_test.cjs` | Actual frontend fixture login and restart continuity. Task14. |
| `tooling/production-acceptance/guest/observation.cjs` | Readiness/schema validation, private DOM comparison and legitimate-empty-state proof. Task15. |
| `tooling/production-acceptance/tests/unit/observation.test.cjs` | Every readiness bit, external evidence freshness and data/empty/error cases. Task15. |
| `tooling/production-acceptance/tests/guest/observation_test.cjs` | Actual frontend Robo/Portfolio/Activity fixture rendering. Task15. |
| `tooling/production-acceptance/guest/restart.cjs` | Drain/HOLD/nonce/receipt and same-session fresh-restart checks. Task16. |
| `tooling/production-acceptance/tests/unit/restart.test.cjs` | Receipt/state/deadline and release continuity cases. Task16. |
| `tooling/production-acceptance/tests/guest/restart_test.cjs` | Synthetic backend generation restart without second login. Task16. |
| `tooling/production-acceptance/guest/revocation.cjs` | One actual UI Sign Out and current/prior session revocation orchestration. Task17. |
| `tooling/production-acceptance/guest/verifier.cjs` | Fixed one-use backend /api/me client in separate confined verifier role. Task17. |
| `tooling/production-acceptance/tests/unit/revocation.test.cjs` | Logout outcomes, no retries and exact verifier transport. Task17. |
| `tooling/production-acceptance/tests/guest/revocation_test.cjs` | Actual fixture all-session revocation and denied verifier bypass. Task17. |
| `tooling/production-acceptance/guest/storage.py` | Mount/ownership/readability admission and bounded metadata-only crash collector. Task18. |
| `tooling/production-acceptance/tests/unit/storage_test.py` | Unsafe paths, unreadable markers and no-content crash checks. Task18. |
| `tooling/production-acceptance/tests/guest/storage_test.py` | Actual tmpfs/swap/UID/capacity/readonly base checks. Task18. |
| `tooling/production-acceptance/guest/evidence.cjs` | Allowlisted public projections and bounded one-way secret detectors. Task19. |
| `tooling/production-acceptance/guest/scan.py` | Per-owner private tree scan excluding crash content. Task19. |
| `tooling/production-acceptance/tests/unit/evidence.test.cjs` | Schema/overflow/privacy tests. Task19. |
| `tooling/production-acceptance/tests/unit/scan_test.py` | Readable scopes, secret variants and crash exclusions. Task19. |
| `tooling/production-acceptance/host/Sources/AcceptanceCore/EvidenceReceiver.swift` | Finite serial public-output receiver and durable sanitized accounting acknowledgement. Task20. |
| `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/EvidenceTests.swift` | Malicious frames, persistence ordering and no raw capture. Task20. |
| `tooling/production-acceptance/guest/finalize.cjs` | Ordered bounded shutdown with sticky failure and durable-charge fallback. Task21. |
| `tooling/production-acceptance/host/Sources/AcceptanceCore/RunCleanup.swift` | Only-owned host pipes/broker/VM cleanup and final safe outcome. Task21. |
| `tooling/production-acceptance/tests/unit/finalize.test.cjs` | Every interruption boundary and conservative outcomes. Task21. |
| `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/CleanupTests.swift` | Host exit/kill/ack/resource absence distinctions. Task21. |
| `tooling/production-acceptance/guest/main.cjs` | Fixed effect interpreter wiring controller gates/lifecycle, no operational credentials. Task22. |
| `tooling/production-acceptance/README.md` | Execution boundary, approvals, exact local commands and qualified artifact interpretation. Task22. |
| `tooling/production-acceptance/tests/unit/main.test.cjs` | Whole controller dependency wiring and forbidden execution capabilities. Task22. |
| `tooling/production-acceptance/tests/qualify.cjs` | Owned-fixture orchestration, adversarial scenario registry and public aggregate result. Task23. |
| `tooling/production-acceptance/tests/fixture-server.cjs` | Node standard-library HTTPS stand-in with in-memory owner/session/provider/DB semantics; no Mongo or external provider. Task23. |
| `tooling/production-acceptance/tests/prepare-fixture.cjs` | Build exact isolated frontend source for synthetic origins using separately approved dependencies; never modify application checkout. Task23. |
| `tooling/production-acceptance/tests/scenarios.json` | Finite required scenario IDs and evidence predicates, no skip-to-pass. Task23. |
| `tooling/production-acceptance/tests/guest/network_probe.py` | Direct transport/helper/FD adversaries in real confined roles. Task23. |
| `tooling/production-acceptance/tests/unit/qualification.test.cjs` | Harness rejects incomplete/fake/missing/production scenarios. Task23. |
| `tooling/production-acceptance/tests/unit/fixture.test.cjs` | Synthetic state, uncertainty/drop/restart and source-contract checks. Task23. |
| `tooling/production-acceptance/tests/review-gate.cjs` | Finite complete-evidence and immutable-identity verifier; never grants production authority. Task24. |
| `tooling/production-acceptance/tests/unit/review-gate.test.cjs` | Reject missing/tampered/incomplete qualification or dishonest success. Task24. |

## Dependency phases and execution command rules

| Phase | Tasks | Exit gate |
| --- | --- | --- |
| M1 — Pure contracts/parsers/policies | 1–4 | Cross-language schemas/signatures, exact routes and budget loss model pass offline. |
| M2 — Host broker | 5 | Finite resolver/connector and outage tests pass without network. |
| M3 — VM configuration/appliance skeleton | 6–7 | Device factory and input provenance pass; construction requires its own approval. |
| M4 — Guest confinement/proxy/topology | 8–10 | Actual approved synthetic kernel-role/topology bootstrap gate passes before browser execution. |
| M5 — Private intake/state machine | 11–12 | Synthetic PTY privacy and closed transitions pass. |
| M6 — Browser/session/readiness/restart/logout | 13–17 | Confined guest browser tests use synthetic fixtures only; candidate never reaches production. |
| M7 — Storage/evidence/finalization/assembly | 18–22 | All gates wired, durable loss/cleanup cases pass. |
| M8 — Full local qualification | 23 | Final immutable artifacts pass complete adversarial owned-fixture matrix. |
| M9 — Independent complete review | 24 | Artifact/evidence checker and fresh whole-system reviewer approve; stop. |

Task dependencies are explicit; numeric order is the default. Code may be authored/tested with pure doubles before hardware execution, but no browser acceptance execution starts before Task10 passes real confinement. Task13–17 guest integration is completed with final storage/assembly and Task23 harness; their earlier focused tests use doubles. Each task is one reviewable deliverable with its own future commit. No commit occurs now.

**Every command below is FUTURE, never a planning action.** Shell working directory is repository root unless explicitly `/opt/acceptance` inside guest or `/run/acceptance-build` in the construction environment. Semicolon-separated command lists mean separate verification steps: inspect each result, stop on first failure, never mask it with a later success. Unit tests must never implicitly spawn VM/browser/network; guest/integration commands are separately labeled.

**FUTURE AFTER EXPLICIT DEPENDENCY APPROVAL:** all Node commands require approved Node24.21.0 on PATH; all Python commands require the pinned approved Python; Swift commands require approved SDK/build/signing scope; Playwright/browser tests additionally require separately approved exact paired artifacts. Native tools present on the authoring Mac are not treated as approval. The Linux assembler requires approved pinned mke2fs/build-seed tools. No package installation or download command is issued by this plan.

For each task: write named failing tests first; run focused command and verify the expected missing export/type/behavior assertion, not syntax/setup failure; implement minimum code; rerun focused GREEN; run the stated broader suites. The first Task1 skeleton may create only manifest/test plumbing needed for a runnable RED; no behavior implementation before RED. An unmet runtime/dependency/platform gate means STOP, not a skipped test reported as pass. Broader offline suites run only files created so far and exercise no live transport.

Future host build/signing, only after explicit signing/entitlement approval: `swift build --package-path tooling/production-acceptance/host -c release`; then `codesign --force --sign "$ACCEPTANCE_SIGNING_IDENTITY" --entitlements tooling/production-acceptance/host/virtualization.entitlements tooling/production-acceptance/host/.build/release/acceptance-host`; then `codesign --verify --strict tooling/production-acceptance/host/.build/release/acceptance-host`. The identity is separately approved configuration, never an owner secret. Expect signature verification success and required entitlement validated before any VM call; no root/helper/networking entitlement. Do not run an unsigned `swift run` as the real VM gate. Broker is a separate normal-user executable; manifest binds its bytes and verified code identity too.

Appliance construction is separately approved, offline and nonsecret. It consumes preapproved official inputs in an already approved ARM64 Linux construction environment; obtaining/provisioning that environment is an explicit prerequisite, not a task that silently uses Docker or a remote administrator. Required acceptance artifacts are copied as immutable files through normal approved artifact delivery before boot, never through a host filesystem mount into the acceptance guest. Missing construction infrastructure blocks execution of M3, not the planning document; no credentials may exist in construction inputs.

### Task 1: Bounded shared contracts and runtime identity

**Phase:** M1. **Depends on:** none.

**Files**

- Create: `tooling/production-acceptance/contracts/schema.json`, `tooling/production-acceptance/contracts/vectors.json`, `tooling/production-acceptance/guest/contracts.cjs`, `tooling/production-acceptance/guest/protocol.py`, `tooling/production-acceptance/host/Package.swift`, `tooling/production-acceptance/host/Sources/AcceptanceCore/Contracts.swift`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/contracts.test.cjs`, `tooling/production-acceptance/tests/unit/protocol_test.py`, `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/ContractsTests.swift` (create).

**Interfaces**

- Consumes: Approved design §§6–17 and the contract catalogue below; no runtime or network.
- Produces: Node decodeFrame(bytes: Buffer, kind: FrameKind): ValidatedFrame and canonicalBytes(frame: ValidatedFrame): Buffer; Python decode_frame(data: bytes, kind: str) -> dict; Swift Contracts.decode(_ data: Data, kind: FrameKind) throws -> ValidatedFrame and canonicalBytes(_ frame: ValidatedFrame) throws -> Data. All languages consume the same vectors.

- [ ] **Write the failing test first:** unknown_field_rejected; duplicate_key_rejected before JSON object construction; oversized_frame_rejected; arbitrary_url_host_rejected; invalid_phase_event_rejected; canonical_receipt_bytes_equal across three languages; private_fields_not_public; runtime_identity_requires_exact_hashes. Assert control <=256 bytes, receipt <=16384, public record <=4096 and public run total <=262144.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/contracts.test.cjs`. Then `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p protocol_test.py -v`. Then `swift test --package-path tooling/production-acceptance/host/ --filter ContractsTests`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Implement only fixed schemas and codecs, with import-safe guest adapters so pure host tests never invoke Linux syscalls at import time. Initially declare only the Swift AcceptanceCore library and test target; Tasks5/6 add their executable targets when the entry files exist. Use restricted canonical JSON: exact schema fields, lexically sorted keys, UTF-8, integer counters, no floating point, duplicate keys rejected before decoding, bounded nesting; sign domain-separated canonical bytes. No browser import or socket open. Types below are normative; unknown enum additions require review. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/contracts.test.cjs`. Then `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p protocol_test.py -v`. Then `swift test --package-path tooling/production-acceptance/host/ --filter ContractsTests`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Then `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p "*_test.py" -v`. Then `swift test --package-path tooling/production-acceptance/host/`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/contracts/schema.json tooling/production-acceptance/contracts/vectors.json tooling/production-acceptance/guest/contracts.cjs tooling/production-acceptance/guest/protocol.py tooling/production-acceptance/host/Package.swift tooling/production-acceptance/host/Sources/AcceptanceCore/Contracts.swift tooling/production-acceptance/tests/unit/contracts.test.cjs tooling/production-acceptance/tests/unit/protocol_test.py tooling/production-acceptance/host/Tests/AcceptanceCoreTests/ContractsTests.swift` and `git commit -m "feat(acceptance): add bounded shared acceptance contracts"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 2: Exact route and timer admission policy

**Phase:** M1. **Depends on:** 1.

**Files**

- Create: `tooling/production-acceptance/guest/route-policy.cjs`, `tooling/production-acceptance/contracts/routes.json`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/route-policy.test.cjs` (create).

**Interfaces**

- Consumes: Validated release origins, immutable asset manifest, Phase, RequestFacts, counters and monotonic clock from Task 1.
- Produces: admitRequest(request: RequestFacts, policy: PolicySnapshot): Decision; Decision is FORWARD(routeId,cost), ABORT_EXPECTED(code), REPLAY_PRIVATE(responseHandle), or FAIL(code); no I/O. createPolicy(release: VerifiedRelease, assets: AssetManifest): PolicySnapshot.

- [ ] **Write the failing test first:** every_spec_route_row; encoded_path_duplicate_query_method_override_denied; same_host_economic_post_denied [RF3]; login_extra_key_duplicate_key_nonstring_oversize_rejected; logout_nonempty_body_rejected; GET_OPTIONS_body_rejected; body_proof_wrong_request_or_mutated_bytes_rejected; alternate_origin_and_redirect_denied; arbitrary_asset_denied; home_window_exactly_two_zero_forward_denials; quote_sparkline_denied; preauth_401_requires_login_document_and_no_session; authenticated_timer_never_replays_401; freshness_and_phase_invalidation; atomic_ceiling_no_double_admission. Use all numeric schedule values in the route catalogue below.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/route-policy.test.cjs`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Require the private worker-generated BodyProof catalogue contract in the same atomic admission that reserves route/cost; login is exact bounded username/password JSON and logout/GET/OPTIONS carry zero body bytes. Preserve raw target plus parsed origin/method/query consistency; reject ambiguous normalization. This gate cannot prove wire framing or make a hostile browser cookie read-only. No source changes in backend/frontend and no copying the hosted wildcard/diagnostic routes. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/route-policy.test.cjs`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/route-policy.cjs tooling/production-acceptance/contracts/routes.json tooling/production-acceptance/tests/unit/route-policy.test.cjs` and `git commit -m "feat(acceptance): add fixed production route contracts"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 3: Signed release, asset and restart verification

**Phase:** M1. **Depends on:** 1.

**Files**

- Create: `tooling/production-acceptance/guest/receipts.cjs`, `tooling/production-acceptance/host/Sources/AcceptanceCore/ReceiptVerifier.swift`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/receipts.test.cjs`, `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/ReceiptTests.swift` (create).

**Interfaces**

- Consumes: canonicalBytes and strict schemas from Task 1; independently pinned public key; injected now, consumed nonce set and expected instance set.
- Produces: verifyReceipt(bytes: Buffer, kind: ReceiptKind, trust: TrustContext): VerifiedReceipt; verifyAssets(bytes: Buffer, release: VerifiedRelease): AssetManifest; validateAssetResponse(entry: AssetEntry, body: Buffer, contentType: string): AssetProof privately checks exact byte length/SHA256/MIME and returns only entry ID/hash/match booleans; Swift ReceiptVerifier.verify(_ data: Data, kind: ReceiptKind, trust: TrustContext) throws -> VerifiedReceipt. Verification returns immutable tagged records, never arbitrary signed JSON.

- [ ] **Write the failing test first:** bad_signature_wrong_signer_expired_future_issuance_denied; duplicate_unknown_fields_denied; wrong_nonce_digest_action_app_environment_operationId_denied; missing_instance_denied; replay_denied; frontend_backend_platform_digest_required; asset_bytes_size_mime_hash_mismatch_denied; missing_asset_or_response_body_unavailable_denied; key_in_receipt_cannot_replace_pinned_key; same_config_false_denied. Node-produced synthetic Ed25519 vectors must verify in CryptoKit and vice versa.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/receipts.test.cjs`. Then `swift test --package-path tooling/production-acceptance/host/ --filter ReceiptTests`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Use Node crypto and Apple CryptoKit Ed25519 without a package. Signed schemas include every field listed below. Private keys exist only in synthetic test fixtures or the separately authorized release authority, never controller deployment. Do not implement Fly observation/signing operations here. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/receipts.test.cjs`. Then `swift test --package-path tooling/production-acceptance/host/ --filter ReceiptTests`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Then `swift test --package-path tooling/production-acceptance/host/`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/receipts.cjs tooling/production-acceptance/host/Sources/AcceptanceCore/ReceiptVerifier.swift tooling/production-acceptance/tests/unit/receipts.test.cjs tooling/production-acceptance/host/Tests/AcceptanceCoreTests/ReceiptTests.swift` and `git commit -m "feat(acceptance): verify release and restart receipts"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 4: Conservative budgets and durable external charge contract

**Phase:** M1. **Depends on:** 1, 2, 3.

**Files**

- Create: `tooling/production-acceptance/guest/budget.cjs`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/budget.test.cjs` (create).

**Interfaces**

- Consumes: Verified LedgerReceipt, route costs, JournalPort.append(intent): Promise<void>, LedgerPort.confirmEnvelope(runId): Promise<EnvelopeAck>; both ports are local bounded IPC, never provider/DB clients.
- Produces: createBudget(receipt: VerifiedLedgerReceipt, ports: BudgetPorts): Budget; Budget.reserve(routeId, sequence): Promise<Reservation>; Budget.settle(reservationId, outcome): void; Budget.finalize(ack: AccountingAck | EnvelopeAck): AccountingSummary. A forward permit exists only after successful journal ordering.

- [ ] **Write the failing test first:** reservation_before_forward; concurrent_reservation_serialized; timeout_unknown_send_keep_full_charge; crash_after_reserve_keeps_external_envelope [RF4]; journal_loss_cannot_reset_budget; over_ceiling_stale_receipt_wrong_adapter_denied; sanitized_ack_or_durable_full_charge_before_delete; no_refund_without_evidence; no_double_count_envelope_and_routes; separate_paper_stock_totals. Assert 14 PAPER reads split clock2/account8/positions3/history1 and stock0; never import synthetic historical6/total19.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/budget.test.cjs`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Implement pure accounting plus injected durable-boundary acknowledgement. Guest tmpfs fsync is ordering only. The externally pre-reserved envelope remains unavailable after local loss. No production ledger writer, provider instrumentation or global-backend-spend promise. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/budget.test.cjs`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/budget.cjs tooling/production-acceptance/tests/unit/budget.test.cjs` and `git commit -m "feat(acceptance): retain conservative read reservations"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 5: Finite host broker and DNS-safe transport

**Phase:** M2. **Depends on:** 1, 3.

**Files**

- Create: `tooling/production-acceptance/host/Sources/AcceptanceCore/EgressBroker.swift`, `tooling/production-acceptance/host/Sources/AcceptanceBroker/main.swift`.
- Modify: `tooling/production-acceptance/host/Package.swift` (add only the acceptance-broker target/product now that its entry file exists).
- Test: `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/BrokerTests.swift` (create).

**Interfaces**

- Consumes: VerifiedRelease with FRONTEND/BACKEND maps, RunBinding, Resolver.resolve(host): [NumericAddress], Connector.connect(address, port): ByteStream, Clock; descriptor inventory excludes terminal/console/private-evidence handles.
- Produces: EgressBroker.accept(control: Data, stream: ByteStream) async throws -> Tunnel; EgressBroker.fail(_ code: FailureCode) closes all streams irreversibly. Resolver and Connector are protocol dependencies with real macOS implementations and in-memory test doubles.

- [ ] **Write the failing test first:** exact_two_enums_only; arbitrary_host_suffix_trailing_dot_ip_literal_port_rejected; loopback_private_linklocal_unspecified_multicast_reserved_documentation_mapped_addresses_rejected; rebinding_no_second_resolution; no_udp_socks_dns_request; header256_connection17_rejected; byte_idle_deadline_limit; broker_loss_closes_existing_tunnels_no_resume; no_console_inheritance_no_decrypted_logging.
- [ ] **Run focused tests and verify RED:** `swift test --package-path tooling/production-acceptance/host/ --filter BrokerTests`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Resolve only mapped exact ASCII hostnames, classify all selected IPv4/IPv6 addresses, connect numerically on443. Permit at most16 live tunnels and require manifest byte/idle/run bounds. No SNI/HTTP inspection; broker receives opaque TLS only. IPC has no caller-controlled file or hostname. Unit tests inject streams and perform no network. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `swift test --package-path tooling/production-acceptance/host/ --filter BrokerTests`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `swift test --package-path tooling/production-acceptance/host/`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/host/Sources/AcceptanceCore/EgressBroker.swift tooling/production-acceptance/host/Sources/AcceptanceBroker/main.swift tooling/production-acceptance/host/Tests/AcceptanceCoreTests/BrokerTests.swift tooling/production-acceptance/host/Package.swift` and `git commit -m "feat(acceptance): add bounded host egress broker"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 6: Networkless VM configuration and signed launcher boundary

**Phase:** M3. **Depends on:** 1, 3, 5.

**Files**

- Create: `tooling/production-acceptance/host/Sources/AcceptanceCore/VMConfiguration.swift`, `tooling/production-acceptance/host/Sources/AcceptanceCore/VMHost.swift`, `tooling/production-acceptance/host/Sources/AcceptanceHost/main.swift`, `tooling/production-acceptance/host/virtualization.entitlements`.
- Modify: `tooling/production-acceptance/host/Package.swift` (add only the acceptance-host target/product now that its entry file exists).
- Test: `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/VMConfigurationTests.swift` (create).

**Interfaces**

- Consumes: Verified ApplianceManifest, VerifiedRelease, RunBinding and broker pipe endpoints; injectable VZ factory/lifecycle adapter.
- Produces: buildConfiguration(manifest: ApplianceManifest) throws -> VZVirtualMachineConfiguration; VMHost.start(run: RunConfiguration) async throws -> VMHandle; VMHandle.stop(deadline) -> StopOutcome; CLI acceptance-host supports bootstrap-check, qualify and run-synthetic modes only through M9, plus validate-appliance without VM start. No real-session mode enabled by this plan.

- [ ] **Write the failing test first:** zero_network_devices_and_attachments; no_shares_usb_audio_graphics_balloon; one_serial_one_vsock_readonly_base; tampered_appliance_denied; writable_run_volume_denied; no_save_restore; entitlement_missing_admission_failure; terminal_loss_stops_owned_vm; no_host_tcp_admin_listener; implicit_extra_device_denied.
- [ ] **Run focused tests and verify RED:** `swift test --package-path tooling/production-acceptance/host/ --filter VMConfigurationTests`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Confirm installed SDK API signatures before implementation. Use VZ file-handle serial attachment, one virtio socket listener at4050 and retained owned connections. Do not attach raw stdout; Task11 supplies phase-aware console. Unit tests inspect configuration objects/fakes without VM execution. Bootstrap-check remains unavailable until Task10 supplies its qualification implementation. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `swift test --package-path tooling/production-acceptance/host/ --filter VMConfigurationTests`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `swift test --package-path tooling/production-acceptance/host/`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/host/Sources/AcceptanceCore/VMConfiguration.swift tooling/production-acceptance/host/Sources/AcceptanceCore/VMHost.swift tooling/production-acceptance/host/Sources/AcceptanceHost/main.swift tooling/production-acceptance/host/virtualization.entitlements tooling/production-acceptance/host/Tests/AcceptanceCoreTests/VMConfigurationTests.swift tooling/production-acceptance/host/Package.swift` and `git commit -m "feat(acceptance): configure networkless virtualization guest"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 7: Pinned appliance definition and offline assembly contract

**Phase:** M3. **Depends on:** 1, 6.

**Files**

- Create: `tooling/production-acceptance/appliance/manifest.schema.json`, `tooling/production-acceptance/appliance/assemble.py`, `tooling/production-acceptance/appliance/README.md`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/appliance_test.py` (create).

**Interfaces**

- Consumes: Approved official Ubuntu24.04 ARM64 rootfs/kernel/initramfs/build inputs, pinned Node/Python/Playwright Chromium distribution and authored payload hashes; separately supplied Linux image-tool paths/hashes.
- Produces: validate_inputs(manifest: dict) -> ApprovedInputs; assemble(inputs: ApprovedInputs, output: Path) -> ApplianceManifest; CLI assemble.py --inputs /run/acceptance-build/approved-inputs.json --output /run/acceptance-build/output. Output readonly-base.raw, matching kernel/initramfs, manifest and source/tool provenance; no acceptance secret.

- [ ] **Write the failing test first:** wrong_arch_hash_missing_kernel_config_denied; archive_traversal_symlink_escape_denied; no_fetch_no_docker; no_unpinned_browser; no_runtime_secret_files; fixed_role_policy_in_manifest; readonly_base_enforced; exact_rebuild_inputs_recorded; incomplete_payload_cannot_be_final_qualified_image.
- [ ] **Run focused tests and verify RED:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p appliance_test.py -v`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Use offline Python stdlib archive/hash orchestration and pinned Ubuntu filesystem utilities (mke2fs with directory population) in a separately approved ARM64 Linux construction environment. Do not build on Mac by installing Linux tools or mount host private directories. Construction inputs/output are nonsecret and may use a dedicated build disk; this never authorizes a writable acceptance-run disk. A reviewed official build seed/environment must be supplied before construction; the plan does not provision a remote host or extend the acceptance VM with networking. Early skeleton contains only bootstrap probes; later tasks rebuild the final image from all payload hashes. This is a provenance/assembly task, not an instruction to silently acquire a seed. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p appliance_test.py -v`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p "*_test.py" -v`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Complete the separately gated runtime/review check:** Actual construction is FUTURE AFTER EXPLICIT DEPENDENCY APPROVAL and separate appliance/environment approval. Exact future Linux command is the assemble.py CLI above; expect verified inputs, zero network calls and reproducible manifest. If no approved native ARM64 Linux build environment/seed is available, stop this execution phase; do not use Docker, introduce a host share or improvise privileged Mac tooling.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/appliance/manifest.schema.json tooling/production-acceptance/appliance/assemble.py tooling/production-acceptance/appliance/README.md tooling/production-acceptance/tests/unit/appliance_test.py` and `git commit -m "feat(acceptance): define immutable ARM64 appliance inputs"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 8: Inherited seccomp, role bootstrap and descriptor isolation

**Phase:** M4. **Depends on:** 1, 7.

**Files**

- Create: `tooling/production-acceptance/guest/confinement.py`, `tooling/production-acceptance/guest/role-ports.cjs`, `tooling/production-acceptance/tests/guest/confinement_probe.py`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/role-ports.test.cjs` (create), `tooling/production-acceptance/tests/unit/confinement_test.py`, `tooling/production-acceptance/tests/guest/confinement_test.py` (create).

**Interfaces**

- Consumes: Appliance role policy; fixed executable/path/hash allowlist; KernelPort for native AArch64 syscalls, audited inherited pipes and no_new_privs.
- Produces: prepare_role(role: Role, config: RoleConfig) -> RoleLaunch; exec_role(launch: RoleLaunch) -> NoReturn; inspect_role(pid: int) -> RoleAttestation; start_roles(config: BootstrapConfig) -> RoleHandoffs creates the four pinned roles before owner input. Node adoptRole(kind: BROWSER|VERIFIER, handoff: AuditedRoleHandoff): RolePort in role-ports.cjs wraps existing inherited pipes, never setuid/spawn. RolePort.activateOnce(grant: RoleGrant): Promise<RoleHandle>; RoleHandle={privatePipe,waitExit(deadline): Promise<ExitOutcome>,stopOwned(deadline): Promise<ExitOutcome>}. BrowserRolePort and VerifierRolePort are discriminated RolePort instances, not separate undeclared factories. Roles CONTROLLER, BROWSER, VERIFIER, PROXY have distinct UIDs. Trusted intake is a narrowly isolated component of controller authority, not a fifth egress role.

- [ ] **Write the failing test first:** vsock_browser_controller_verifier_denied; child_fork_exec_network_gpu_crash_helper_inherits [RF1]; proxy_fixed_vsock_positive; io_uring_setup_register_enter_and_inherited_ring_denied; alternate_ABI_denied; SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied; privilege_gain_denied; no_console_or_bridge_fd; bootstrap_arbitrary_argv_denied; TSYNC_failure_abort; exact_fd_inventory; adopt_unaudited_handle_reject; activation_second_consume_reject; arbitrary_role_program_argv_fd_request_reject; exit_handle_bound_to_run_and_owned_child.
- [ ] **Run focused tests and verify RED:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p confinement_test.py -v`. Then `node --test tooling/production-acceptance/tests/unit/role-ports.test.cjs`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Bootstrap starts pinned waiting workers and owns child PID reaping; it returns only audited private command/result and fixed exit/stop handles to the controller. BROWSER activation starts Chromium only after confinement proof; VERIFIER activation consumes the prior-session grant once. No later role can request another executable, arbitrary FD, UID or new privileged spawn. Use Python stdlib os/resource/ctypes only for Linux bootstrap and seccomp/prctl syscall binding; verify ABI layouts/constants against pinned Linux headers. No added libseccomp package and no generated unreviewed filter. Filter socket/domain/type and deny io_uring; allow only justified local families, no TRACE/USER_NOTIF escape. Establish PID/mount/proc/device views, four UIDs, empty initial-namespace capabilities and no_new_privs before untrusted exec. Close all unaudited FDs; no SCM_RIGHTS donor or generic supervisor. Preserve Chromium inner sandbox. Browser/verifier and automation worker cannot open/write console; only dedicated trusted intake/export component owns the approved serial channel. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p confinement_test.py -v`. Then `node --test tooling/production-acceptance/tests/unit/role-ports.test.cjs`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p "*_test.py" -v`. Then `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Complete the separately gated runtime/review check:** Real guest kernel command, only after VM execution approval: python3 -m unittest discover -s /opt/acceptance/tests/guest -p confinement_test.py -v. Expect each attempted negative operation to fail at the kernel/FD boundary and proxy positive to succeed. Task10 invokes this through the bounded bootstrap-check mode; a mocked unit PASS never substitutes for this gate.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/confinement.py tooling/production-acceptance/guest/role-ports.cjs tooling/production-acceptance/tests/unit/role-ports.test.cjs tooling/production-acceptance/tests/guest/confinement_probe.py tooling/production-acceptance/tests/unit/confinement_test.py tooling/production-acceptance/tests/guest/confinement_test.py` and `git commit -m "feat(acceptance): confine guest roles and descendants"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 9: Guest CONNECT-to-vsock proxy

**Phase:** M4. **Depends on:** 1, 5, 8.

**Files**

- Create: `tooling/production-acceptance/guest/proxy.py`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/proxy_test.py` (create).

**Interfaces**

- Consumes: Verified two-host map and RunBinding via trusted bootstrap pipe; fixed CID2/service4050; bounded StreamPort.
- Produces: parse_connect(data: bytes, destinations: dict) -> Destination; serve_proxy(config: ProxyConfig, transport: VsockTransport) -> ProxyOutcome; each stream emits Task1 control then opaque bytes.

- [ ] **Write the failing test first:** FE_BE_443_accept; alternate_host_suffix_dot_IP_port_reject; duplicate_malformed_oversized_headers_reject; ordinary_HTTP_SOCKS_CONNECT_UDP_reject; no_DNS_api; listens_127001_only; broker_loss_closes_all_tunnels_latches_failed; no_retry_or_restart_resume; ancillary_fd_reject.
- [ ] **Run focused tests and verify RED:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p proxy_test.py -v`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Use Python socket/selectors with a bounded 4096-byte CONNECT header,256-byte vsock control,16 live tunnel ceiling and shared byte/lifetime limits. Never bind0.0.0.0 or::1, never resolve guest targets, log owner traffic or return vsock descriptors. A capability/run mismatch stops the run. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p proxy_test.py -v`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p "*_test.py" -v`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/proxy.py tooling/production-acceptance/tests/unit/proxy_test.py` and `git commit -m "feat(acceptance): add finite guest CONNECT proxy"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 10: Topology admission and pre-browser B1 gate

**Phase:** M4. **Depends on:** 5, 6, 7, 8, 9.

**Files**

- Create: `tooling/production-acceptance/guest/topology.py`, `tooling/production-acceptance/tests/guest/topology_test.py`.
- Modify: `tooling/production-acceptance/host/Sources/AcceptanceCore/VMHost.swift` (introduced earlier), `tooling/production-acceptance/host/Sources/AcceptanceHost/main.swift` (introduced earlier).
- Test: `tooling/production-acceptance/tests/unit/topology_test.py`, `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift` (create).

**Interfaces**

- Consumes: Host device attestation, guest proc/sys/net inventories, RoleAttestation and known proxy port/UID; no shell-parsed free-form log trust.
- Produces: admit_topology(snapshot: TopologySnapshot, expected: TopologyPolicy) -> AdmissionProof; VMHost.bootstrapCheck(run: RunConfiguration) -> BootstrapQualification. Proof binds run, manifest hash, role/device inventories and expiry; later assembly checks it again before prompt.

- [ ] **Write the failing test first:** unexpected_NIC_default_v4_v6_route_DNS_listener_fail_before_prompt [RF2]; missing_proxy_fail; extra_abstract_UNIX_agent_fail; incorrect_uid_seccomp_fd_fail; role_probe_failed_or_skipped_fail; host_listener_not_guest_loopback; topology_drift_latches_failure. Real probes cover IPv4/IPv6/UDP/DNS/io_uring/vsock/FD/helper attempts and owned receiver counters.
- [ ] **Run focused tests and verify RED:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p topology_test.py -v`. Then `swift test --package-path tooling/production-acceptance/host/ --filter BootstrapGateTests`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Add bootstrap-check CLI implementation to existing VMHost/launcher, using only fixed probe executable IDs. Require passing actual kernel-role and no-NIC topology checks before Task13 can execute any browser test. Snapshot plus runtime service creation supervision/drift checking is required, not a one-time canary. The hostile-kernel/host assumption remains unchanged. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p topology_test.py -v`. Then `swift test --package-path tooling/production-acceptance/host/ --filter BootstrapGateTests`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p "*_test.py" -v`. Then `swift test --package-path tooling/production-acceptance/host/`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Complete the separately gated runtime/review check:** Future signed-host command: tooling/production-acceptance/host/.build/release/acceptance-host bootstrap-check --manifest /private/tmp/acceptance-synthetic/appliance.json --release /private/tmp/acceptance-synthetic/release.json. Requires separately approved signing, construction, VM and owned-fixture network testing. Expect BOOTSTRAP_CONFINEMENT_QUALIFIED only when every real negative attempt occurred, receiver forbidden counts are0 and allowed proxy/vsock control succeeds. No production names, credential prompt or browser launch in this gate.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/topology.py tooling/production-acceptance/tests/guest/topology_test.py tooling/production-acceptance/tests/unit/topology_test.py tooling/production-acceptance/host/Tests/AcceptanceCoreTests/BootstrapGateTests.swift tooling/production-acceptance/host/Sources/AcceptanceCore/VMHost.swift tooling/production-acceptance/host/Sources/AcceptanceHost/main.swift` and `git commit -m "test(acceptance): gate browser work on guest confinement"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 11: Private dual-TTY intake and bounded operator console

**Phase:** M5. **Depends on:** 1, 6, 8, 10.

**Files**

- Create: `tooling/production-acceptance/host/Sources/AcceptanceCore/SerialConsole.swift`, `tooling/production-acceptance/guest/intake.py`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/intake_test.py`, `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/ConsoleTests.swift` (create).

**Interfaces**

- Consumes: AdmissionProof, RunBinding, IntakeGrant with consumer/destinations/120s expiry, private inherited pipe; approved nonsecret receipt input channel separate from secret consume.
- Produces: consume_credential(grant: IntakeGrant, tty_fd: int, sink: PrivateSink) -> ConsumeResult; SerialConsole.consume(grant: IntakeGrant) async throws -> ConsumeResult; SerialConsole.receiveReceipt(kind) -> Data and publish(record: PublicRecord) only in authorized phases. No API returning credential to host broker.

- [ ] **Write the failing test first:** nonTTY_redirect_reject; argv_env_file_clipboard_not_sources; wrong_run_consumer_destination_expiry_second_consume_reject; cancelled_signal_exception_restore_both_echo; synthetic_canary_absent_from_host_output_and_evidence [RF5]; raw_console_ANSI_OSC_reject; broker_fd_inventory_no_TTY; automation_child_no_console_access.
- [ ] **Run focused tests and verify RED:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p intake_test.py -v`. Then `swift test --package-path tooling/production-acceptance/host/ --filter ConsoleTests`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Atomically consume grant before fill. Dedicated trusted intake component alone owns guest TTY; automation controller receives only the bounded private credential pipe, with no inherited TTY/proc reopening access. Host attaches anonymous pipes rather than raw stdout. Use Python termios/tty and Swift Darwin terminal APIs, no password package. Restore handled signals and stop on terminal loss. Acknowledge SIGKILL/host loss and high-level memory copies cannot guarantee restoration/zeroization. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p intake_test.py -v`. Then `swift test --package-path tooling/production-acceptance/host/ --filter ConsoleTests`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p "*_test.py" -v`. Then `swift test --package-path tooling/production-acceptance/host/`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/host/Sources/AcceptanceCore/SerialConsole.swift tooling/production-acceptance/guest/intake.py tooling/production-acceptance/tests/unit/intake_test.py tooling/production-acceptance/host/Tests/AcceptanceCoreTests/ConsoleTests.swift` and `git commit -m "feat(acceptance): add one-use private console intake"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 12: Closed controller state machine

**Phase:** M5. **Depends on:** 1, 2, 3, 4, 10, 11.

**Files**

- Create: `tooling/production-acceptance/guest/state.cjs`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/state.test.cjs` (create).

**Interfaces**

- Consumes: Phase/Event enums, AdmissionProof, credential consume outcome, verified receipt status, budget and cleanup events; injected monotonic clock.
- Produces: reduce(state: ControllerState, event: Event, nowMs: number): Transition; Transition contains next state, fixed Effect[] and FailureCode|null; effects are interpreted only by Task22.

- [ ] **Write the failing test first:** all_eleven_states; invalid_transition_fails; duplicate_consume_second_login_fail; hold_route_denied; receipt_outside_hold_fail; failed_only_safe_cleanup_logout; outage_restart_cannot_resume;20min_run_10min_hold_120s_intake_60s_cleanup_deadlines; session_expiry_no_reauth; cleanup_success_cannot_erase_failure.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/state.test.cjs`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** No side effects inside reducer. Explicitly separate sticky failure outcome from cleanup progress so FAILED can perform bounded internal cleanup without becoming DONE. No ad hoc debug commands or arbitrary actions. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/state.test.cjs`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/state.cjs tooling/production-acceptance/tests/unit/state.test.cjs` and `git commit -m "feat(acceptance): add fail-closed session state machine"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 13: Sandboxed browser lifecycle and mandatory transport

**Phase:** M6. **Depends on:** 2, 8, 9, 10, 12.

**Files**

- Create: `tooling/production-acceptance/package.json`, `tooling/production-acceptance/package-lock.json`, `tooling/production-acceptance/guest/browser.cjs`, `tooling/production-acceptance/guest/browser-worker.cjs`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/browser.test.cjs`, `tooling/production-acceptance/tests/guest/browser_test.cjs` (create).

**Interfaces**

- Consumes: BootstrapQualification, RunBinding, approved runtime hashes, tmpfs paths and BrowserRolePort.activateOnce(grant): Promise<RoleHandle> from Task8; its privatePipe is BrowserWorkerPipe; no arbitrary executable or argv.
- Produces: openBrowser(config: BrowserConfig, ports: BrowserPorts): Promise<BrowserSession>; BrowserSession is a controller-side opaque handle to one worker-owned browser/context/page, close(): Promise<BrowserExit>, private pipe only. Browser worker runBrowserWorker(pipe: BrowserWorkerPipe, config: BrowserConfig): Promise<BrowserExit> owns the actual Playwright objects. No APIRequestContext or host browser launch path.

- [ ] **Write the failing test first:** no_bootstrap_proof_no_launch; sandbox_enabled_no_no_sandbox; one_nonpersistent_context; SW_registration_and_fetch_blocked_extensions_downloads_capture_disabled; popup_new_page_and_WebSocket_WebTransport_rejected_before_forward; QUIC_WebRTC_nonproxy_disabled; ignoreHTTPSErrors_false_no_customCA; guest_proxy_no_DIRECT; profile_support_shm_tmpfs; inherited_filter_all_children; browser_pid_uid_proc_console_inventory.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/browser.test.cjs`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Follow approved native Playwright ARM64 distribution and pair exact browser/runtime hashes. Task8 starts the fixed Node browser-worker executable under BROWSER UID/filter and hands audited anonymous pipes to the controller. The controller adopts Task8 RoleHandle and owns only its privatePipe/stop/exit capabilities; trusted bootstrap remains PID parent and reports bounded exit status. The worker calls the normal public Playwright chromium.launch/newContext APIs; it launches Chromium within that same confined role, so no unsupported cross-UID Playwright pipe attachment is assumed. browser.cjs exposes only fixed UI-action IDs, private observation handles and correlated request-decision messages over bounded authenticated RPC. No arbitrary JS/evaluate, URL, selector, shell or executable is accepted from operator input. Worker maps pinned action IDs to the source-derived selectors; route events carry immutable request IDs and validated private BodyProof; worker inspects actual intercepted body bytes, keeps the raw bytes private, and cannot continue or override them until controller returns the Task2/4 permit for that exact ID/body handle. No TCP CDP/Playwright server or extra loopback listener. Worker calls Task3 validateAssetResponse on actual browser response.body() bytes for each required document/asset with the signed manifest size bound; no route.fetch/APIRequestContext, second fetch or caller-supplied proof. Missing body, unexpected MIME, size or digest mismatch fails. Send only bounded AssetProof to controller on authenticated run-bound pipe, and require all current phase-required asset proofs before credentials/deeper observation; this detects a mismatch and aborts, not a claim of verifying script bytes before browser execution. Incompatibility is a stop, not permission to relax roles or sandbox. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/browser.test.cjs`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Complete the separately gated runtime/review check:** FUTURE AFTER EXPLICIT DEPENDENCY APPROVAL: exact Playwright version/hash approval precedes writing manifest/lockfile or acquiring artifacts; do not reuse frontend ^1.52.0 as a production pin. Guest runtime command after bootstrap gate: node --test /opt/acceptance/tests/guest/browser_test.cjs. Expect sandbox/version/FD evidence and live positive proxy/negative direct tests, never mocked results. No browser tests run on the host.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/package.json tooling/production-acceptance/package-lock.json tooling/production-acceptance/guest/browser.cjs tooling/production-acceptance/guest/browser-worker.cjs tooling/production-acceptance/tests/unit/browser.test.cjs tooling/production-acceptance/tests/guest/browser_test.cjs` and `git commit -m "feat(acceptance): enforce confined browser lifecycle"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 14: Actual UI login and private session identity

**Phase:** M6. **Depends on:** 3, 11, 12, 13.

**Files**

- Create: `tooling/production-acceptance/guest/session.cjs`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/session.test.cjs`, `tooling/production-acceptance/tests/guest/session_test.cjs` (create).

**Interfaces**

- Consumes: BrowserSession, one-use credential sink, expected private owner binding and route permits; source Login/AuthContext/sessionCookie contract.
- Produces: loginOnce(session: BrowserSession, credential: PrivateCredential, owner: ExpectedOwner): Promise<PrivateSession>; assertContinuity(before: PrivateSession, after: SessionObservation): ContinuityResult; destroySessionReference(handle): void. PrivateSession cannot be JSON serialized.

- [ ] **Write the failing test first:** Username_Password_Log_In_actual_UI; wrong_owner_fail_before_deeper_read; daytrader_session_Secure_HttpOnly_SameSite_None_path_root_host_only; one_context_no_storageState; changed_cookie_owner_after_restart_fail; second_login_API_login_substitute_denied; password_refs_discard_after_fill_ack; private_value_absent_public_output.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/session.test.cjs`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Send fixed worker actions whose worker-local implementation uses actual placeholder Username/Password and Log In button from read-only frontend source, normal UI form submission and private /api/me.user.id comparison. Reject cookie-domain widening. Keep minimum same-cookie reference in guest memory; no cookie export or injection. Synthetic integration uses the exact compiled frontend against the in-memory contract fixture, not Mongo. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/session.test.cjs`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/session.cjs tooling/production-acceptance/tests/unit/session.test.cjs tooling/production-acceptance/tests/guest/session_test.cjs` and `git commit -m "feat(acceptance): bind owner UI login to one session"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 15: Readiness v2, DB/quiescence evidence and meaningful views

**Phase:** M6. **Depends on:** 2, 3, 4, 12, 14.

**Files**

- Create: `tooling/production-acceptance/guest/observation.cjs`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/observation.test.cjs`, `tooling/production-acceptance/tests/guest/observation_test.cjs` (create).

**Interfaces**

- Consumes: PrivateSession, route/budget permits, VerifiedQuiescenceReceipt/VerifiedDBReceipt, response/body handles private only; source runtimeReadiness and design §§12–16.
- Produces: validateReadiness(body: unknown): ReadinessProof; observeViews(session: BrowserSession, phase: Phase, evidence: ObservationInputs): Promise<PublicObservation>; validateMaintenance(evidence: MaintenanceEvidence): MaintenanceProof.

- [ ] **Write the failing test first:** exact12_checks_pass_only; contract2_profile_owner_paper_maintenance_runtime_and_maintenance_true; automation_flags_exact; missing_unknown_check_fail; readiness_not_lease; absent_duplicate_settings_abort_before_GET; wrong_adapter_brokerError_source_fail; DB_difference_or_incomplete_scope_fail; Robo7_Portfolio2_Activity3_valid_render; empty_arrays_only_with_valid_schema_and_empty_UI; loading_error_disconnect_not_empty; balances_symbols_never_public.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/observation.test.cjs`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Use all12 names and flags in the readiness catalogue above; fixed worker actions retain raw body/DOM data inside the guest and return bounded private proof handles. Compare response fields to correct DOM sections privately, allow genuine empty collections, require freshness and no error. Signed external maintenance/DB authority establishes exact owner/account binding, unique preexisting settings, worker suppression, no conflicting leases/work and complete comparisons. Implement validators/consumers only: no Mongo/Fly/provider client and no GET-get-or-create repair. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/observation.test.cjs`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/observation.cjs tooling/production-acceptance/tests/unit/observation.test.cjs tooling/production-acceptance/tests/guest/observation_test.cjs` and `git commit -m "feat(acceptance): verify readiness and private UI observations"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 16: Bounded HOLD and separate restart authority

**Phase:** M6. **Depends on:** 3, 4, 12, 14, 15.

**Files**

- Create: `tooling/production-acceptance/guest/restart.cjs`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/restart.test.cjs`, `tooling/production-acceptance/tests/guest/restart_test.cjs` (create).

**Interfaces**

- Consumes: ControllerState, Budget, PrivateSession, ReceiptVerifier, private operator channel and fresh external maintenance/DB receipts.
- Produces: enterHold(inputs: HoldInputs): Promise<HoldGrant>; acceptRestart(grant: HoldGrant, bytes: Buffer): VerifiedRestart; verifyRestartContinuity(before: RestartBaseline, after: RestartObservation): RestartProof.

- [ ] **Write the failing test first:** drain_before_hold; zero_forward_in_hold_timer_denials_bounded; cryptographic256bit_nonce_one_use;10min_expiry; wrong_action_approvedOperationId_app_environment_nonce_instance_digest_config_fail; same_cookie_owner_fresh_startup_required; fresh_readiness_and_clock_not_old_cache; incomplete_restart_all_instances_fail; no_Fly_command_or_token.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/restart.test.cjs`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Use injected Node crypto randomBytes and monotonic clock. Private nonce displayed only in nonrecorded operator phase. Separate synthetic fixture operator changes backend generation and signs receipt; controller only verifies. Health/owner/readiness precede reserved fresh market/Robo observation. Real backend restart remains outside plan execution. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/restart.test.cjs`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/restart.cjs tooling/production-acceptance/tests/unit/restart.test.cjs tooling/production-acceptance/tests/guest/restart_test.cjs` and `git commit -m "feat(acceptance): bind restart handoff to existing session"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 17: UI logout and isolated prior-session verifier

**Phase:** M6. **Depends on:** 2, 8, 9, 12, 14, 16.

**Files**

- Create: `tooling/production-acceptance/guest/revocation.cjs`, `tooling/production-acceptance/guest/verifier.cjs`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/revocation.test.cjs`, `tooling/production-acceptance/tests/guest/revocation_test.cjs` (create).

**Interfaces**

- Consumes: BrowserSession, PrivateSession, VerifierRolePort.activateOnce(grant): Promise<RoleHandle> from Task8, explicit all-session authorization flag and zero-cost route reservation.
- Produces: signOutOnce(session, prior: PrivateSession): Promise<RevocationResult>; verifyPriorOnce(input: PriorSessionGrant, transport: ConfinedConnectTransport): Promise<401>; destroyVerifier(): Promise<ExitOutcome>. Transport opens TLS over the same loopback CONNECT proxy with normal hostname/CA verification.

- [ ] **Write the failing test first:** actual_Sign_Out_200_revoked_true_cookie_absent; current_and_prior_me401;503_revoked_false_not_success; one_attempt_only; verify_no_redirect_or_query; prior_token_never_serialized_or_second_context; verifier_socket_vsock_direct_negative; all_owner_sessionVersion_revocation_flag_required; child_exit_reference_destroyed.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/revocation.test.cjs`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Capture prior reference privately immediately before logout. Task8 prestarts the fixed verifier worker; Task17 activates its one-use RoleHandle with the fixed backend/run/cookie grant on private pipe, then closes the pipe and awaits the bootstrap-owned exit receipt through waitExit; stopOwned applies only to that child. Verifier receives no console/ring/bridge FD or arbitrary URL API. Use Node built-in net/tls/https over explicit CONNECT socket with rejectUnauthorized=true and servername bound; never default direct-agent fallback. If boundary suspect, stop traffic and mark revocationUnconfirmed. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/revocation.test.cjs`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/revocation.cjs tooling/production-acceptance/guest/verifier.cjs tooling/production-acceptance/tests/unit/revocation.test.cjs tooling/production-acceptance/tests/guest/revocation_test.cjs` and `git commit -m "feat(acceptance): verify all-session logout through confined transport"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 18: Private tmpfs, ownership and crash metadata

**Phase:** M7. **Depends on:** 7, 8, 10.

**Files**

- Create: `tooling/production-acceptance/guest/storage.py`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/storage_test.py`, `tooling/production-acceptance/tests/guest/storage_test.py` (create).

**Interfaces**

- Consumes: Appliance storage manifest, separate role roots, injected filesystem metadata/open adapter and KernelPort.
- Produces: admit_storage(manifest: StoragePolicy) -> StorageProof; crash_aggregate(root_fd: int) -> CrashAggregate; remove_owned_state(proof: StorageProof) -> CleanupResult.

- [ ] **Write the failing test first:** readonly_base_all_writable_tmpfs_no_swap;0700_dirs0600_files_correct_uid; unreadable_empty0600_wrong_owner_fail; symlink_hardlink_path_swap_fail; crash_open_content_raises_if_called;1MiB_crash256MiB_run_bounds; host_share_or_disk_backed_path_fail; deletion_owned_scope_only; host_residue_not_claimed_erased.
- [ ] **Run focused tests and verify RED:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p storage_test.py -v`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Use descriptor-relative no-follow operations and inode/device/owner/link checks to resist substitution. Each role scans its own readable scope; no chmod workaround or root-owned marker. Crash traversal only stat/enumeration aggregates, no contents or published filenames. Keep /dev/shm sizing manifest-bound; no guest swap/hibernation/save-state. Host swap/diagnostics stay explicit residuals. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p storage_test.py -v`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p "*_test.py" -v`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/storage.py tooling/production-acceptance/tests/unit/storage_test.py tooling/production-acceptance/tests/guest/storage_test.py` and `git commit -m "feat(acceptance): constrain private storage and crash metadata"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 19: Private leakage checks and finite public records

**Phase:** M7. **Depends on:** 1, 14, 15, 18.

**Files**

- Create: `tooling/production-acceptance/guest/evidence.cjs`, `tooling/production-acceptance/guest/scan.py`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/evidence.test.cjs`, `tooling/production-acceptance/tests/unit/scan_test.py` (create).

**Interfaces**

- Consumes: Private observation/session data, run-keyed detector handles, StorageProof and exact PublicRecord schema; private raw inputs never passed to serializers.
- Produces: projectPublic(input: PrivateResult): PublicRecord; checkPublic(records: PublicRecord[], detectors: DetectorSet): ScanResult; scan_owned(root_fd: int, scope: ScanScope, detectors: DetectorInput) -> ScanAggregate; detector handles are nonserializable.

- [ ] **Write the failing test first:** password_cookie_JWT_owner_balance_symbol_order_DOM_fields_reject [RF5]; encoded_canary_found_without_retaining_plaintext;unknown_field4097byte262145total_fail; unreadable_scope_fail; raw_exception_not_public; crash_contents_never_read; count_timings_only; no_hash_of_financial_values; recheck_after_cleanup_records.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/evidence.test.cjs`. Then `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p scan_test.py -v`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Construct records by allowlist rather than redacting arbitrary objects. One-way run-keyed bounded representation detectors formed during intake cannot claim universal encoding coverage or physical erasure. Never include private journal, body, raw stack/path, nonce or session fingerprint in public output. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/evidence.test.cjs`. Then `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p scan_test.py -v`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Then `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p "*_test.py" -v`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/evidence.cjs tooling/production-acceptance/guest/scan.py tooling/production-acceptance/tests/unit/evidence.test.cjs tooling/production-acceptance/tests/unit/scan_test.py` and `git commit -m "feat(acceptance): bound evidence and private leakage checks"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 20: Host sanitized export and durable acknowledgement

**Phase:** M7. **Depends on:** 1, 3, 4, 11, 19.

**Files**

- Create: `tooling/production-acceptance/host/Sources/AcceptanceCore/EvidenceReceiver.swift`.
- Modify: None.
- Test: `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/EvidenceTests.swift` (create).

**Interfaces**

- Consumes: Validated console phase, PublicRecord schema, preapproved host output file descriptor, StoragePort.writeSync and run-bound external EnvelopeAck; no arbitrary guest paths.
- Produces: EvidenceReceiver.accept(frame: Data) throws -> PublicRecord; EvidenceReceiver.commit(records: [PublicRecord]) throws -> AccountingAck; failure returns no durability acknowledgement.

- [ ] **Write the failing test first:** rawJSON_privateJournal_DOM_crash_password_session_fields_reject;4097byte_frame_overflow_ANSI_OSC_reject; no_raw_boot_browser_stderr_transcript; fsync_failure_no_ack; ack_run_mismatch_rejected; duplicate_sequence_rejected;0600_owned_output; file_target_fixed_not_guest_selected; final_privacy_scan_before_publish.
- [ ] **Run focused tests and verify RED:** `swift test --package-path tooling/production-acceptance/host/ --filter EvidenceTests`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Persist only checked sanitized records, synchronize file and required directory creation metadata, then emit bounded acknowledgement. A write/ack loss leaves full run charge in external ledger. Host never copies guest files or observes private contents. No broad host filesystem scan; record bounded non-content host diagnostic observations as residual-policy evidence. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `swift test --package-path tooling/production-acceptance/host/ --filter EvidenceTests`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `swift test --package-path tooling/production-acceptance/host/`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/host/Sources/AcceptanceCore/EvidenceReceiver.swift tooling/production-acceptance/host/Tests/AcceptanceCoreTests/EvidenceTests.swift` and `git commit -m "feat(acceptance): persist sanitized evidence acknowledgements"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 21: Failure-preserving finalization and VM cleanup

**Phase:** M7. **Depends on:** 4, 6, 12, 17, 18, 19, 20.

**Files**

- Create: `tooling/production-acceptance/guest/finalize.cjs`, `tooling/production-acceptance/host/Sources/AcceptanceCore/RunCleanup.swift`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/finalize.test.cjs`, `tooling/production-acceptance/host/Tests/AcceptanceCoreTests/CleanupTests.swift` (create).

**Interfaces**

- Consumes: Budget, RevocationResult, BrowserSession, StorageProof, ScanResult, AccountingAck|EnvelopeAck and VMHandle; injected shutdown/removal/status ports.
- Produces: finalizeRun(state: ControllerState, ports: FinalizePorts): Promise<FinalResult>; RunCleanup.finish(run: OwnedRun, deadline) async -> HostCleanupResult; FinalResult exposes only required booleans/counts/digests and sticky outcome.

- [ ] **Write the failing test first:** failure_at_each_shutdown_boundary_preserves_FAILED [RF4]; safe_logout_once_else_unconfirmed; journal_delete_after_ack_or_durable_charge; SIGKILL_VM_loss_full_charge_and_unknown_revocation; context_closed_not_browser_normal_exit; forced_VM_stop_not_success; capabilities_detectors_sessions_destroyed; no_resume_relogin; only_owned_processes_and_paths; cleanup60s_expiry_reports_unknown.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/finalize.test.cjs`. Then `swift test --package-path tooling/production-acceptance/host/ --filter CleanupTests`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Order exactly design §20: close admission, safe logout/revocation, private scans, normal browser close/exit, crash metadata, scan/export accounting and durable ack or full-charge fallback, remove guest state, stop proxy/vsock/broker, VM stopped, owned host resource checks and final public scan. Do not claim unobservable cleanup after host loss or clear server session by deleting cookies. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/finalize.test.cjs`. Then `swift test --package-path tooling/production-acceptance/host/ --filter CleanupTests`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Then `swift test --package-path tooling/production-acceptance/host/`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/finalize.cjs tooling/production-acceptance/host/Sources/AcceptanceCore/RunCleanup.swift tooling/production-acceptance/tests/unit/finalize.test.cjs tooling/production-acceptance/host/Tests/AcceptanceCoreTests/CleanupTests.swift` and `git commit -m "feat(acceptance): finalize with durable failure accounting"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 22: Integrated synthetic-only controller entrypoint

**Phase:** M7. **Depends on:** 1–21.

**Files**

- Create: `tooling/production-acceptance/guest/main.cjs`, `tooling/production-acceptance/README.md`.
- Modify: `tooling/production-acceptance/host/Sources/AcceptanceHost/main.swift` (introduced earlier), `tooling/production-acceptance/host/Sources/AcceptanceCore/VMHost.swift` (introduced earlier).
- Test: `tooling/production-acceptance/tests/unit/main.test.cjs` (create).

**Interfaces**

- Consumes: All earlier interfaces; controller run input via private pipe, signed synthetic release and appliance manifest; no URL/secret CLI flags.
- Produces: runAcceptance(input: RunInput, ports: ControllerPorts): Promise<FinalResult>; CLI Node entrypoint consumes only inherited framed inputs, requires SYNTHETIC mode through M9 and prohibits production endpoints. VMHost.qualify uses the same production candidate modules with fixture-only runtime authorization.

- [ ] **Write the failing test first:** no_prompt_without_all_admission_receipts; no_browser_without_bootstrap; no_forward_without_route_and_reservation; response_error_fails_before_deeper_effect; forbidden_Fly_DB_provider_SMTP_module_or_token_not_accepted; FAILED_no_resume; all_components_same_run_manifest; missing_independent_quiescence_blocks; budget_and_cleanup_gate_completion.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/main.test.cjs`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Wire explicit dependency injection, not ambient env/project .env reads. Narrow controller worker has no raw serial device; trusted intake/export component mediates fixed operator messages. Add only fixed synthetic qualification modes to host CLI, not a production-run switch. Validate guest proofs over the already authenticated run-bound private channel, with sequence/manifest/lifetime binding, and fresh pre-prompt topology/storage checks. No separate guest signing key or unstated signer provisioning is introduced. Do not import/execute hosted Docker launchers. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/main.test.cjs`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Then `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p "*_test.py" -v`. Then `swift test --package-path tooling/production-acceptance/host/`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/guest/main.cjs tooling/production-acceptance/README.md tooling/production-acceptance/tests/unit/main.test.cjs tooling/production-acceptance/host/Sources/AcceptanceHost/main.swift tooling/production-acceptance/host/Sources/AcceptanceCore/VMHost.swift` and `git commit -m "feat(acceptance): assemble gated synthetic controller"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 23: Adversarial complete local VM qualification harness

**Phase:** M8. **Depends on:** 1–22.

**Files**

- Create: `tooling/production-acceptance/tests/qualify.cjs`, `tooling/production-acceptance/tests/fixture-server.cjs`, `tooling/production-acceptance/tests/prepare-fixture.cjs`, `tooling/production-acceptance/tests/scenarios.json`, `tooling/production-acceptance/tests/guest/network_probe.py`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/qualification.test.cjs`, `tooling/production-acceptance/tests/unit/fixture.test.cjs` (create).

**Interfaces**

- Consumes: Final rebuilt/signed appliance and host binaries, BootstrapQualification, owned public fixture manifest/TLS inputs, synthetic signing identity and one-use interactive synthetic owner input. No real endpoints/credentials.
- Produces: qualify(manifestPath: string): Promise<QualificationRecord>; CLI node tooling/production-acceptance/tests/qualify.cjs --manifest /private/tmp/acceptance-synthetic/qualification.json; fixture-server CLI requires signed owned-fixture manifest and externally provisioned fixture TLS identity.

- [ ] **Write the failing test first:** missing_receiver_or_probe_or_fixture_fails; skipped_test_never_pass; production_hostname_or_real_identity_manifest_rejected; independent_forbidden_receiver_counts; transport_and_all_session_storage_budget_cases_in_matrix; drop_response_charge_and_final_readability_marker_regression; abrupt_VM_loss_not_normal_exit; frontend_source_hash_and_real_render_bound; runtime_missing_tampered_wrong_MIME_document_asset_fails_before_prompt_or_deeper_observation; total_failure_retained.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/qualification.test.cjs`. Then `node --test tooling/production-acceptance/tests/unit/fixture.test.cjs`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Use nativeMac launcher and owned HTTPS fixtures with synthetic users/provider behavior. Fixture server serves an isolated build of exact frontend source plus strict API stand-in; binding tests track backend contracts without running backend/Mongo. Run actual browser inside guest only. Positive transport uses public-CA valid owned FE/BE endpoints on443 and real broker address policy; negative wrong-host/expired/untrusted TLS fixtures. Do not relax broker private-address rejection for full qualification or call mocked loopback tests equivalent. Fixture hosting/certificates must be separately approved and supplied; no deployment or certificate acquisition command is authorized by this plan. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/qualification.test.cjs`. Then `node --test tooling/production-acceptance/tests/unit/fixture.test.cjs`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Then `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p "*_test.py" -v`. Then `swift test --package-path tooling/production-acceptance/host/`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Complete the separately gated runtime/review check:** After all separately approved VM/network/credential/storage scopes: node tooling/production-acceptance/tests/qualify.cjs --manifest /private/tmp/acceptance-synthetic/qualification.json. Expected SYNTHETIC_ACCEPTANCE_QUALIFIED only with every matrix scenario attempted and passed, zero forbidden deliveries, valid TLS, normal success cleanup and honestly failed injected-loss cases. Before this integration run, rebuild the immutable appliance and sign the final host binary; earlier skeleton/probe hashes cannot substitute.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/tests/qualify.cjs tooling/production-acceptance/tests/fixture-server.cjs tooling/production-acceptance/tests/prepare-fixture.cjs tooling/production-acceptance/tests/scenarios.json tooling/production-acceptance/tests/guest/network_probe.py tooling/production-acceptance/tests/unit/qualification.test.cjs tooling/production-acceptance/tests/unit/fixture.test.cjs` and `git commit -m "test(acceptance): qualify guest network and session confinement"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

### Task 24: Immutable qualification verifier and independent review gate

**Phase:** M9. **Depends on:** 23.

**Files**

- Create: `tooling/production-acceptance/tests/review-gate.cjs`.
- Modify: None.
- Test: `tooling/production-acceptance/tests/unit/review-gate.test.cjs` (create).

**Interfaces**

- Consumes: QualificationRecord, final artifact manifests/hashes, scenario registry, sanitized evidence and separately supplied independent review verdict.
- Produces: verifyQualification(bundle: QualificationBundle): ReviewReadiness; CLI node tooling/production-acceptance/tests/review-gate.cjs --manifest /private/tmp/acceptance-synthetic/qualification.json --evidence /private/tmp/acceptance-synthetic/public/result.json. Output READY_FOR_INDEPENDENT_REVIEW or BLOCKED; human reviewer alone supplies final qualification verdict.

- [ ] **Write the failing test first:** missing_scenario_or_hash_mismatch_fail; skipped_or_mocked_runtime_as_real_fail; uncertain_cleanup_revocation_not_pass; scope_privacy_violation_fail; reviewer_reject_blocks; synthetic_result_never_production_approval.
- [ ] **Run focused tests and verify RED:** `node --test tooling/production-acceptance/tests/unit/review-gate.test.cjs`. Expected each new named assertion fails because its contract is absent/incorrect; record the exact expected failure, not an import/tool installation problem.
- [ ] **Implement minimum code:** Implement minimal evidence verifier then obtain fresh-context whole-system independent review of immutable code/appliance/host/filter/runtime hashes, all adversarial evidence, credential/route/accounting/cleanup claims and residuals. Review may reject any task. Remediation repeats only affected tests plus justified integration coverage. No production step follows review. Implement only the interfaces/files above.
- [ ] **Run focused tests and verify GREEN:** `node --test tooling/production-acceptance/tests/unit/review-gate.test.cjs`. Expected all named cases PASS, zero failed or unexpectedly skipped tests.
- [ ] **Run broader relevant verification:** `node --test tooling/production-acceptance/tests/unit/*.test.cjs`. Then `python3 -m unittest discover -s tooling/production-acceptance/tests/unit/ -p "*_test.py" -v`. Then `swift test --package-path tooling/production-acceptance/host/`. Expected every applicable offline test PASS with no live network/browser/VM side effect.
- [ ] **Complete the separately gated runtime/review check:** Future verification command: node tooling/production-acceptance/tests/review-gate.cjs --manifest /private/tmp/acceptance-synthetic/qualification.json --evidence /private/tmp/acceptance-synthetic/public/result.json. Expected READY_FOR_INDEPENDENT_REVIEW, then an independent written verdict with concrete evidence and no unaddressed blockers. This is not approval for production. Include reviewer finding resolution in the task commit only after review; do not manufacture a reviewer verdict in code.
- [ ] **Review and commit this deliverable:** `git diff --check` must exit0; review only these paths, then `git add tooling/production-acceptance/tests/review-gate.cjs tooling/production-acceptance/tests/unit/review-gate.test.cjs` and `git commit -m "test(acceptance): gate complete qualification on independent review"`. Expected one scoped commit, no unrelated file. Commit does not authorize the next execution gate.

## Exact deferred guest test targets

The following commands run **inside the final approved guest**, invoked by Task23 through fixed executable IDs and inherited framed pipes, never a generic remote shell. They are FUTURE AFTER EXPLICIT DEPENDENCY APPROVAL plus VM/network/storage/synthetic-credential approval; none runs now. Tasks13–18 author these tests in their owning commits; their runtime PASS evidence is collected after Task22 wiring and final appliance rebuild. Earlier pure GREEN is not an integration claim.

- Task8: `python3 -m unittest discover -s /opt/acceptance/tests/guest -p confinement_test.py -v` — all kernel role/FD/child denials and proxy positive pass.
- Task10: `python3 -m unittest discover -s /opt/acceptance/tests/guest -p topology_test.py -v` — topology violations fail admission before prompt; valid inventory passes.
- Task13: `node --test /opt/acceptance/tests/guest/browser_test.cjs` — exact pinned sandbox/worker/child/proxy configuration passes.
- Task14: `node --test /opt/acceptance/tests/guest/session_test.cjs` — actual synthetic UI login and exact private owner/cookie binding pass.
- Task15: `node --test /opt/acceptance/tests/guest/observation_test.cjs` — valid data/empty UI cases pass; readiness/error/privacy negatives fail as expected.
- Task16: `node --test /opt/acceptance/tests/guest/restart_test.cjs` — same-session fresh restart succeeds and wrong receipt/startup cases fail.
- Task17: `node --test /opt/acceptance/tests/guest/revocation_test.cjs` — actual UI logout, both401 checks, all-session side effect and verifier destruction pass.
- Task18: `python3 -m unittest discover -s /opt/acceptance/tests/guest -p storage_test.py -v` — real mount/swap/UID/readonly/capacity tests pass.
- Task23: `python3 /opt/acceptance/tests/guest/network_probe.py --scenario-set full-v1` — every attempted scenario produces a fixed-schema result corroborated by owned receiver counters; no absent/unsupported test is a pass.

## Full synthetic qualification matrix — Task23 owns integration

All cases use synthetic owner/session/provider/DB state and an isolated source-bound frontend fixture, never live application HTTP or Mongo. Public positive fixture TLS uses owned public DNS/443 and an operator-supplied valid public-CA chain; expired/wrong-host/self-signed cases are negative only. Fixture setup is a separately approved prerequisite. Neither a custom production CA nor a private-address exception in the candidate broker is acceptable. If owned public fixtures are unavailable, full qualification remains unperformed; a mocked resolver is unit evidence only.

| IDs | Required real attempt / expected evidence |
| --- | --- |
| N01–N07 | Public IPv4, IPv6, UDP, DNS TCP/UDP, direct DoH, QUIC and WebRTC/STUN/TURN direct attempts from guest fail; independently observed forbidden receiver delivery0. No attempted packet is silently replaced with a cache result. |
| N08–N12 | Browser/controller/verifier AF_VSOCK creation denied; proxy CID2:4050 positive; arbitrary fork/exec plus Chromium network/GPU/crash representatives inherit; io_uring/foreignABI/SCM_RIGHTS/proc/pidfd/ring FD attempts cannot acquire bridge. |
| N13–N16 | Unexpected loopback/DNS/Unix relay blocks admission, allowed127.0.0.1 proxy works, runtime inventory drift latches failure; console/device/hostshare access attempts fail. Receiver tests include rejected host command/ANSI/OSC injection. |
| N17–N19 | Kill broker, proxy or vsock independently; listener and existing tunnels close; restarted components never resume acceptance, retry auth or reopen failed budget. |
| N20 | Multicast/mDNS, IPv4/IPv6 link-local and metadata-address probes attempted from each relevant role; no delivery outside guest. Task8 domain/capability restrictions and Task10 topology own enforcement; Task23 network_probe.py owns real attempts/receiver evidence. |
| N21 | Native raw sockets/AF_PACKET, netlink interface/route changes and tunnel creation attempted with inherited policy, including child user namespaces; denied or remain guest-local with no external packet path. Task8 owns filter/capability tests; Task23 real probes record exact operation/error and receiver0. Read-only netlink query, if required, never implies initial-namespace NET_ADMIN. |
| N22 | Hostile page creates popups/new windows/context-like navigation and fetch paths; Task13 worker denies unapproved pages before requests can continue, Task2 denies target routes and Task23 browser fixture corroborates0forbidden handler deliveries. |
| N23 | WebSocket and WebTransport direct and proxied attempts, including same-host forbidden endpoint: Task13 installs pinned public browser interception/deny hooks before page creation, Task2 method/origin policy applies, UDP/QUIC has no path; Task23 fixture sees0forbidden upgrades/handshakes. An unsupported required hook is a qualification failure, not a silent exemption. |
| N24 | Proxied DoH to an alternate resolver host is rejected by Task9/5; same-approved-origin DoH path is rejected by Task2 independently of CONNECT. Task23 browser/network probes demonstrate both, with no DNS relay or forbidden handler delivery. |
| N25 | Actual hostile service-worker registration/fetch and extension-loading attempt are rejected under Task13 worker configuration; Task23 real browser tests verify no installed worker/extension or escaped child traffic, not merely the launch-option values. |
| D01–D06 | Exact fixture FE/BE443 succeed; alternate hostname/suffix/trailing-dot/IP-literal/port/UDP rejected; forbidden IPv4/IPv6/mapped DNS results rejected; no second unchecked resolution. |
| T01–T06 | Public trusted exact-host TLS positive; wrong-host/expired/untrusted fail before authenticated handler; intended-origin gate defeats HTTP2 coalescing/sharedSAN route escape. Missing/tampered/wrong-MIME document/asset fixture fails the private AssetProof gate. Approved opaque tunnel misuse remains an explicit hostile-browser limit. |
| C01–C05 | Both TTYs no-echo; one-use run/consumer grant; expiry/replay/nonTTY/cancel; handled signal restoration; synthetic secret representations absent from public/host capture. No raw transcript or host password file. |
| S01–S07 | Actual compiled frontend UI login, exact synthetic owner/cookie, preauth timer contract, readiness+Robo/Portfolio/Activity real and valid-empty cases, HOLD with0forward, signed same-session restart, actual logout and current/prior401. Wrong owner/freshness/startup or503logout fails. |
| P01–P05 | Readonly base; all mutable paths tmpfs; swap absent; scanner as actualUID reads owned0600 empty marker; symlink/hardlink/substitution/unreadable failure; crash collector content-open count0; host only fixed-schema sanitized export. |
| A01–A05 | Every forward preceded by reservation; response drop/timeout stays charged; kill after reserve/after send/before ack; tmpfs journal loss keeps external full-envelope charge; missing/stale/overceiling/wrongadapter receipts block. |
| F01–F06 | Normal browser family/proxy/broker/VM exit; forced-stop distinct failure; actual process absence and owned guest state cleanup; journal deletion only after durable ack/fallback; all references/capabilities discarded; final privacy scan includes cleanup records. Host loss leaves unknowns explicitly, never fabricated cleanup success. |

Scenarios with fail outcomes pass their test only when the harness observes the expected denial/charge/failure classification. Any missing probe, receiver, process role, address family, certificate case or cleanup observation is a qualification failure. Runtime attestation binds final hashes, never only the old hosted run or early skeleton. Retain only sanitized fixed schema; no crash contents, account values, artifacts with credentials or unnecessary logs.

## Spec coverage and self-review

The author self-review checks the five writing-plans dimensions: coverage (below), one-action RED/GREEN step granularity, named interface/type consistency, all five Review Focus owners, and proportion (interfaces/test assertions rather than implementation bodies). No separate review file is created. The plan has24 reviewable implementation deliverables in9 milestone phases; Task24 includes the independent complete qualification review gate. Nonsecret offline assembly and public owned-fixture availability are explicit future prerequisites; they do not grant new host or operational authority.

| Approved design sections | Plan owners |
| --- | --- |
| 1–5 purpose/baseline/authority/threat/alternatives | Global Constraints, baseline, Tasks1/5–10/24; architecture unchanged. |
| 6–7 roles/devices/runtime/trust | Tasks1/5–10/13/22/23. |
| 8 credential/owner | Tasks8/11/14/19/20. |
| 9 topology/vsock/TLS | Tasks5/6/8–10/13/17/23. |
| 10 routes/timers/assets | Tasks2/3/13–16/23. |
| 11 immutable release | Tasks3/6/7/22/24. |
| 12 budget/DB invariance | Tasks3/4/15/21/23. |
| 13 session/readiness | Tasks14/15/23. |
| 14 restart | Tasks3/16/23. |
| 15–16 storage/crash/privacy/render | Tasks7/11/15/18–20/23. |
| 17–18 state/failure | Tasks12/21/22/23. |
| 19 logout | Task17 and Task23. |
| 20 finalization/accounting/VM | Tasks4/18–21/23. |
| 21 behavioral acceptance | Task22 composition, Task23 fixture execution only. |
| 22 qualification/evidence | Tasks10/23/24; operational facts remain unknown. |
| 23 approvals | Approval Gates below. |
| 24 milestones | M1–M9 refine implementation deliverables; no production task. |
| 25 residuals/review | Global Constraints, Tasks18/21/24 and review record below. |

**Planning self-review:** completed against all25 spec sections and requested groupsA–U. No test/VM/browser/dependency/production execution was performed. Exact runtime tests are deferred and labeled; pure tests cannot substitute for confinement. Known prerequisites cannot be silently filled with Docker, a host share, a weaker sandbox, unapproved tools, private-address broker exception or operational access.

**Fresh independent plan review:** APPROVED on2026-09-30 by fresh-context reviewer `/root/implementation_plan_review`, with no outstanding planning blocker. The reviewer read the user request, approved spec, skill and plan independently; created/edited no artifact and performed no implementation, test, dependency, VM/browser/network/Docker or operational execution. Reviewed content SHA-256 before adding this completion record: `3bbf58f52ceba6b214b9c39a6c97663a1961b3ffe986b36ba8706d148a6a1c83`.

Review corrections are incorporated: named missing adversarial surfaces N20–N25; exact private request-body proof and atomic admission; explicit bootstrap-owned browser/verifier role ports with Python/Node RED/GREEN; release app/environment and restart operation-ID bindings; private observed asset-response validation and runtime negative fixtures; authenticated guest channel proofs without an invented signing authority. The reviewer confirmed groupsA–U,24 tasks/9 phases, B1 before browser execution, privacy, conservative accounting, cleanup and later independent qualification. Approved runtime pins, construction environment, signing and owned public TLS fixtures remain execution prerequisites, not already supplied capabilities.

**Planning disposition: PRODUCTION_ACCEPTANCE_CONTROLLER_IMPLEMENTATION_PLAN_READY_FOR_REVIEW.** Static checks confirm the exact skill header,24 Files/Interfaces/checkbox/RED/GREEN/commit task structures, exactly5 Review Focus items with owning tests, all92 future file paths mapped, valid spec link and Approval Gates. The approved design retains SHA-256 `61fb4ab7e4df51e8251f3e5302ff819e319036ce91a1eaa9d0eabaf4870173a6`; all1059 tracked files remain byte-identical to planning start. Only this plan was created/changed by the planning task; no implementation subtree exists, and the preexisting untracked design remains untouched. No commit, implementation, installation/download, VM construction/execution, browser/synthetic/network test, Docker/CodeLift or production/credential/Fly/provider/SMTP action occurred. Production remains paused.

## Approval Gates

Mathew has approved the written architecture and creation of this plan only. This plan does **not** authorize implementation start; dependencies; Xcode/Swift package additions; signing/entitlement setup; browser/runtime downloads; VM/appliance construction or construction-environment provisioning; VM execution; local network-confinement/storage testing; synthetic credential tests; production preflight/access; real owner credential/session use; all-session logout; read budgets; Fly restart; deployment; rollback; PAPER soak; or activation. Each applicable scope requires a separate explicit approval before its commands run. A task commit or synthetic PASS is not such approval.

Recommended later execution approach is **subagent-driven**, because the24 tasks cross security-sensitive language, descriptor, signing and lifecycle interfaces and benefit from an independent gate per deliverable. Native execution remains an option if Mathew chooses it, with the required final independent review. Neither is selected or started by this planning milestone. Stop for Mathew to review the plan and choose/approve the next phase and approach.

Future separately approved operational milestone:
coordinated production preflight and observational acceptance.

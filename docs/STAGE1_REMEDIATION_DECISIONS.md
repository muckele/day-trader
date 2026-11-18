# Stage 1 remediation — design decisions

**Status: PROPOSED, 2026-11-17. Not yet approved.** These are the owner/design decisions that the Stage 1 independent review needs before remediation can be planned. The review records are in `.superpowers/sdd/2026-09-30-production-acceptance-controller/stage1-reviews/`.

**Background.** On 2026-11-17 the owner chose to continue Path A after seeing the review outcome: 7 REJECT, 0 Critical, 47 Important. Each decision below lists the options and a recommendation. Approval covers **design direction only**. Implementation still follows the usual cycle: a written plan, tests first, independent review, and separate approvals for any VM, signing, network or production step.

**Unchanged by these decisions:**
- the approved design's threat model
- the PAPER-only and no-live-trading rules
- the rule that real native execution stays behind Stage 2 approval

## E1. Outer seccomp filter vs the Chromium sandbox (T8-06)

**Problem.** The outer filter denies more than design §9.2 requires: `chroot`, `capset`, `mount`, `umount2`, `pivot_root`, `setns`, `mknodat`, the `set*id`/`setgroups` family and `pidfd_open`. It also allows only seccomp filter flags 0 and TSYNC. Chromium's Linux namespace sandbox uses `chroot` and `capset` inside its own new user namespace, so it very likely cannot start. The design and plan both require keeping Chromium's inner sandbox, and Task 13 sets `chromiumSandbox: true`. The extra denials add little, because roles hold no capabilities in the initial user namespace.

**Options:**

| Option | What it means | Assessment |
|---|---|---|
| **A (recommended)** | Align the BROWSER role's filter with design §9.2. Allow what Chromium's namespace sandbox needs inside its own user namespace: `chroot`, `capset`, the `set*id` family, `unshare`/`clone` namespace flags, and seccomp flag `SPEC_ALLOW`. Keep the design's denials: AF_VSOCK, packet/raw/unknown socket domains, io_uring, ptrace, cross-role process_vm, pidfd_getfd. Keep the ban on `NEW_LISTENER`/`USER_NOTIF`. Other roles keep the stricter filter. | Option A's bindings for the changed literals are re-derived. Stage 2 must show on a real VM that the sandbox actually starts. |
| B | Run Chromium with `--no-sandbox` and rely on outer confinement only. | Contradicts the approved design. Not recommended. |
| C | Change nothing until Stage 2 shows the failure. | Defers a near-certain blocker. Not recommended. |

## E2. Freshness of the guest's topology handoff (T10-1)

**Problem.** The host compares guest-reported wall and monotonic times against its own clock to within 1 ms. The two clocks are separate, so this can never pass. The amendment forbids comparing guest monotonic time with host time. It is also the only freshness check: the host issues no challenge.

**Options:**

| Option | What it means |
|---|---|
| **A (recommended)** | The host issues a fresh, one-use random challenge for each check over the trusted bootstrap channel. The guest includes it in the MAC'd handoff. The host accepts a handoff only if the challenge matches, is used once, and arrives within a host-clock deadline measured only on the host. Guest timestamps stay as guest-local information and are never compared with host clocks. |
| B | Drop freshness entirely and rely on sequence numbers. | Weaker. Not recommended. |

## E3. VM↔host channel authentication (T9-3; also the M2 host broker)

**Problem.** The guest proxy's vsock "transport authentication" compares the binding with itself, and the run capability never leaves the guest. The host broker (Task 5, M2, accepted in October with a narrow evidence exception) uses its own capability as the "authenticated" one. Confinement still holds under the design's trusted-kernel assumption: only the proxy UID may create AF_VSOCK, and there is a single host listener. But the claimed authentication does not exist.

**Options:**

| Option | What it means | Assessment |
|---|---|---|
| **A (recommended)** | A real challenge-response on each vsock stream. The host sends a nonce. The guest proxy answers with HMAC(k_vsock, nonce ‖ runId ‖ sequence), where k_vsock is derived from the run capability with a distinct domain tag. The host verifies against its own derived key. | Also fixes the related minor T10-10, where one MAC key is reused across purposes. Re-opens accepted M2 code, which needs owner acceptance and an independent review of the broker change. |
| B | Remove the false authentication claim and rely on the kernel/hypervisor boundary alone. | Honest, but loses defence in depth. |

## E4. Cross-process proxy runtime authority (CB-I2)

**Problem.** The composition consumes an in-process `ProxyRuntimeOwner`. A confined PROXY child cannot hand that object to the bootstrap, and the bootstrap-side registry inspects its own descriptors rather than the proxy child's. The test harness fakes all of this.

**Options:**

| Option | What it means | Assessment |
|---|---|---|
| **A (recommended)** | The trusted bootstrap, which is the PROXY child's parent, observes the child's runtime descriptors directly through `/proc/<pid>/fd` and `fdinfo`. It cross-checks them against a MAC'd runtime report the proxy sends over its fixed private channel. Proxy authority lives in the bootstrap's observation, not in a transferred object. | |
| B | Move the serving loop into the bootstrap. | Collapses role separation. Not recommended. |

## E5. Private storage model vs the role layout (T18-I1, T18-I2)

**Problem.** A single caller admits and deletes all five role roots across four UIDs, against the plan's "each role scans its own readable scope". Separately, the storage root model contradicts the Task 8 role-view layout, so admission always fails once role views exist.

**Options:**

| Option | What it means | Assessment |
|---|---|---|
| **A (recommended)** | Do what the plan says. Storage roots live inside the per-role views Task 8 creates. Each role admits, inventories and cleans only its own readable scope, under its own UID. The /dev/shm bound applies to each role's visible tmpfs. The crash root is reachable per role. | |
| B | Keep central admission in the bootstrap before role views exist. | Contradicts the plan. Not recommended. |

## E6. Credential wire format, host→guest (T11-I3)

**Problem.** The host sends a 4-byte big-endian length followed by the bytes, with no newline. The guest intake reads a newline-terminated line. No credential can be delivered.

**Options:**

| Option | What it means | Assessment |
|---|---|---|
| **A (recommended)** | Use the host's length-prefixed framing on both ends. It is binary-safe and bounded, with no newline ambiguity. The guest reads exactly the declared length, at most 4096 bytes. Remediation also covers T11-I1 (the credential reachable through exceptions) and T11-I2 (privacy tests that cannot fail). | |
| B | Newline-terminated text on both ends. | Breaks passwords that contain a newline, and is ambiguous. Not recommended. |

## E7. One shared cleanup-budget rule across languages (CA-I1, CB-I1)

**Problem.** The 60 s shared cleanup window opens during normal probing, so cleanup after one minute has no budget left. Python, JS and Swift also each start the budget under a different rule.

**Options:**

| Option | What it means |
|---|---|
| **A (recommended)** | One rule, owned by the bootstrap composition: the shared 60 s cleanup budget starts at the first **terminal** event (stop, cancel, failure or expiry), never during routine probe cleanup. JS and Python follow that rule. Swift's host-side budget starts at the host's own terminal decision. The three tests that encode the wrong behaviour are corrected. |
| B | Give each component its own budget. | Loses the one-end guarantee the amendment requires. Not recommended. |

## Not owner decisions

These are plain bugs. Remediation fixes them without a separate decision:
- **T10-2:** accept exactly the Linux 6.8 kernel-default IPv6 rows (the null route and `::1`).
- **T10-7:** the 1 ms legacy capture bound.
- **T9-1:** accept Chromium's `Proxy-Connection` header.
- **T9-2:** a per-tunnel failure must not end the run.
- **T12-I2:** allow the P-phase routes the design permits.
- **T13 I-1:** the first navigation.
- **T13 I-2:** the `Authorization` header.
- **The untested-check findings (category D):** each gets a binding test, written first.
- **Category B (evidence that cannot detect a real failure):** each probe or attestation must actually attempt or observe what its name says.

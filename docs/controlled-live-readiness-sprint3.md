# Controlled Live Readiness — Sprint 3

## Outcome

Sprint 3 adds the operational evidence and incident-management layer required before a controlled-live go/no-go review. It does not configure live credentials, enable the deployment live flag, approve real-money trading, or submit a live order.

The readiness status remains fail-closed until real evidence satisfies every gate. Shipping the Sprint 3 code therefore does not make the application live-ready on its own.

## Operational alerts

Safety-relevant RoboTrader audit events create durable, user-scoped operational alerts. Covered events include portfolio-risk pauses, invalidated submissions, broker context failures, uncertain submission outcomes, unowned broker orders found during an emergency stop, missing protective stops, broker rejections, and authorization revalidation failures.

Alerts are deduplicated while active, count repeat occurrences, and support separate acknowledgement and resolution actions. Acknowledged critical alerts still block readiness until resolved. Resolution requires the exact phrase:

```text
I resolved this operational issue.
```

## Readiness assessment

`GET /api/robotrader/readiness` evaluates:

- at least 20 shadow snapshots across at least 7 distinct UTC days
- no breached shadow snapshot in the 30-day observation window
- no open or acknowledged critical operational alert
- no unresolved broker-reconciliation discrepancy
- current operator-runbook review evidence
- current secrets/least-privilege review evidence
- current production-index verification evidence
- an actual emergency-stop drill
- tiny paper-order broker acceptance evidence
- disaster-recovery exercise evidence

Thresholds can be raised with `ROBOTRADER_READINESS_MIN_SHADOW_RUNS`, `ROBOTRADER_READINESS_MIN_SHADOW_DAYS`, and `ROBOTRADER_READINESS_WINDOW_DAYS`.

Passing every gate yields `ready_for_go_no_go`, not permission to trade. `goLiveReady` deliberately remains false in Sprint 3.

## Evidence

Evidence is user-scoped, timestamped, expiring, and recorded with:

```http
POST /api/robotrader/readiness/evidence
```

The exact confirmation text is:

```text
I completed this readiness check.
```

Emergency-stop evidence cannot be self-attested through the general evidence endpoint. It is created only when the operator runs the real stop path with `drill: true`. The drill disables RoboTrader and advances the control generation exactly like a real stop.

## Operator workflow

1. Run RoboTrader in shadow mode long enough to satisfy the observation gate.
2. Investigate every operational alert; acknowledge ownership, correct the cause, reconcile broker state, and resolve only with evidence.
3. Run the emergency-stop and disaster-recovery exercises using the runbook.
4. Verify target-environment indexes and secrets without placing secret values in evidence notes.
5. Execute deliberately tiny paper broker acceptance orders and reconcile them.
6. Review the readiness dashboard. A green result permits a human go/no-go meeting only.
7. Keep `LIVE_TRADING_ENABLED=false` and explicit live credentials absent until a later, separately reviewed activation phase.

## Incident runbook

- **Portfolio pause:** keep automation disabled, inspect the latest exposure snapshot and working orders, cancel unintended working orders, reconcile positions, and resolve the alert only after exposure is independently verified.
- **Submission uncertain:** do not resubmit. Reconcile by client order ID, determine whether Alpaca accepted the order, and update local state before resolving.
- **Protective-stop failure:** disable new entries, inspect the live/paper position, establish protection manually through the approved broker workflow, and document the result.
- **Unowned RoboTrader-like order:** preserve the audit payload, identify the creating system and account, cancel only after ownership is established, and investigate credential or duplicate-deployment exposure.
- **Stale data or execution veto:** do not bypass the gate. Verify the provider timestamp, feed/source, exchange clock, spread, and session close.
- **Emergency stop:** verify `isEnabled=false`, inspect active worker state, reconcile all locally owned broker orders, verify control generation advanced, and record any cancellation error as an unresolved incident.

## Still deferred

- formal human go/no-go approval
- controlled activation of explicit live credentials and `LIVE_TRADING_ENABLED`
- an independently reviewed deployment change
- deliberately tiny controlled-live acceptance with a pre-agreed maximum loss
- ongoing monitoring, incident response ownership, and rollback authority

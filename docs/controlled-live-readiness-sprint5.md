# Controlled Live Readiness — Sprint 5

## Outcome

Sprint 5 adds supervised canary lifecycle enforcement, atomic single-attempt claiming, automatic failure rollback, reconciliation outcome tracking, expiry handling, and post-canary review. It does not activate live trading or place an order.

## Atomic single-use activation

Sprint 4 limited daily attempts, but an activation spanning a UTC boundary could theoretically obtain another daily slot. Sprint 5 closes that path with an activation-scoped atomic claim. Immediately before any broker call, MongoDB increments `attemptsUsed` only when it is still below one and the activation is current. Concurrent requests cannot both claim the slot.

The slot is consumed before authorization consumption and broker submission. It is not restored after rejection, cancellation, timeout, or operator error. A new attempt requires a new readiness-bound approval and activation.

## Lifecycle

The activation records:

```text
armed
  -> attempt_claimed
  -> broker_pending
  -> filled
  -> reconciled
  -> reviewed
```

Failure paths move to `failed` and revoke the activation. Tracked outcomes include broker acceptance, immediate fill, broker rejection, submission uncertainty, protective-stop failure, reconciliation mismatch, and successful fill reconciliation.

Each `RoboTradeOrder` links to the exact `RoboLiveActivation` that claimed the attempt.

## Automatic rollback

The activation is automatically revoked when any of these occur:

- broker submission is uncertain
- broker rejects the order
- required protective-stop creation fails
- reconciliation cannot confirm the broker order
- a critical operational alert is created
- the activation expires

Revocation blocks every later broker submission. Operator-triggered revocation additionally runs Emergency Stop and can cancel locally owned live orders.

## Post-canary review

A terminal or reconciled canary must be reviewed with:

```text
I reviewed and reconciled this canary.
```

The review records conclusions, broker/reconciliation references, protection verification, and review time. Review revokes any still-active activation and changes the lifecycle to `reviewed`.

```http
POST /api/robotrader/live-activation/review
```

## Expiry watchdog

Reading activation status runs the expiry transition for active records whose `activationExpiresAt` has passed. The submission guard independently requires an unexpired activation, so a delayed watchdog can never make an expired activation usable. Sprint 6 extends this into a scheduler-driven supervision watchdog.

## Supervision runbook

1. Activate only while an operator is present and able to revoke.
2. Confirm the activation shows `armed` and `0/1` attempt used.
3. Submit the one authorized canary and confirm the lifecycle changes to `attempt_claimed` or `broker_pending`.
4. Do not retry any rejected or uncertain attempt.
5. Reconcile the broker order by broker ID and client order ID.
6. Verify fill quantity, average price, current position, portfolio exposure, and attached protection.
7. Resolve every operational alert with evidence.
8. Record the post-canary review.
9. Revoke, run Emergency Stop, and remove live deployment configuration.

## Still human-controlled

Sprint 5 automates enforcement and rollback state. It does not decide that financial risk is acceptable, supervise the market, interpret an unexpected fill, or authorize another canary.

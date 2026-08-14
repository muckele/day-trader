const RoboTradeOrder = require('../models/RoboTradeOrder');
const PaperOrder = require('../models/PaperOrder');
const RoboAuditLog = require('../models/RoboAuditLog');
const RoboTradeDecision = require('../models/RoboTradeDecision');
const OrderIntent = require('../models/OrderIntent');
const { createAlpacaBroker } = require('./alpacaBroker');
const { buildClientOrderId } = require('../services/alpacaTradingClient');
const {
  SUBMISSION_STATES,
  SUBMIT_UNKNOWN,
  buildSubmissionErrorSnapshot,
  classifySubmissionError,
  createSubmitUnknownError,
  getBrokerErrorMessage,
  hasConclusiveBrokerOrder
} = require('../services/submissionOutcomeService');
const { normalizeSymbol } = require('./settingsService');
const { recordControlledLiveOutcome } = require('../services/controlledLiveActivationService');
const { createOperationalAlertFromAudit } = require('../services/roboReadinessService');
const {
  acquireAlpacaPaperSubmissionLock,
  findUnresolvedAlpacaPaperSubmission,
  releaseAlpacaPaperSubmissionLock,
  renewAlpacaPaperSubmissionLock
} = require('../services/alpacaPaperSubmissionGuardService');

const OPEN_STATUSES = ['pending_submit', 'accepted', 'new', 'pending_new', 'partially_filled', 'submitted'];

function toFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function mapAlpacaOrder(order = {}) {
  const status = order.status || null;
  return {
    externalOrderId: order.id || null,
    clientOrderId: order.client_order_id || null,
    status,
    submissionState: String(status || '').toLowerCase() === 'rejected'
      ? SUBMISSION_STATES.REJECTED
      : SUBMISSION_STATES.SUBMITTED,
    filledQty: toFiniteNumber(order.filled_qty, null),
    filledAvgPrice: toFiniteNumber(order.filled_avg_price, null),
    filledAt: order.filled_at || null,
    canceledAt: order.canceled_at || order.cancelled_at || null,
    rejectedAt: order.rejected_at || null,
    submittedAt: order.submitted_at || null,
    alpacaResponse: order
  };
}

function isPositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function isProtectiveStopCandidate(order = {}) {
  return String(order.assetClass || '').toLowerCase() === 'stocks'
    && String(order.side || '').toLowerCase() === 'buy'
    && String(order.orderClass || 'simple').toLowerCase() === 'simple'
    && String(order.status || '').toLowerCase() === 'filled'
    && !order.exitReason
    && isPositiveNumber(order.riskStopPrice)
    && isPositiveNumber(order.filledQty ?? order.qty);
}

function getPositionQty(symbol, positions = []) {
  const normalized = normalizeSymbol(symbol);
  const position = (positions || []).find(item => normalizeSymbol(item.symbol) === normalized);
  return toFiniteNumber(position?.qty, 0) || 0;
}

function getPositionCurrentPrice(symbol, positions = []) {
  const normalized = normalizeSymbol(symbol);
  const position = (positions || []).find(item => normalizeSymbol(item.symbol) === normalized);
  const direct = toFiniteNumber(position?.current_price ?? position?.currentPrice, null);
  if (isPositiveNumber(direct)) return direct;
  const qty = Math.abs(toFiniteNumber(position?.qty, 0) || 0);
  const marketValue = Math.abs(toFiniteNumber(position?.market_value ?? position?.marketValue, 0) || 0);
  return qty > 0 && marketValue > 0 ? marketValue / qty : null;
}

function buildPositionAvailabilityBySymbol(positions = [], existingStops = []) {
  const availability = new Map();
  for (const position of positions || []) {
    const symbol = normalizeSymbol(position.symbol);
    if (!symbol) continue;
    availability.set(symbol, Math.max(0, toFiniteNumber(position.qty, 0) || 0));
  }
  for (const stop of existingStops || []) {
    if (String(stop.exitReason || '') !== 'stop_loss') continue;
    if (String(stop.side || '').toLowerCase() !== 'sell') continue;
    const symbol = normalizeSymbol(stop.symbol);
    if (!symbol) continue;
    const remaining = Math.max(0, (availability.get(symbol) || 0) - (toFiniteNumber(stop.qty, 0) || 0));
    availability.set(symbol, remaining);
  }
  return availability;
}

async function readMaybeLean(queryOrValue) {
  if (queryOrValue && typeof queryOrValue.lean === 'function') {
    return queryOrValue.lean();
  }
  return queryOrValue;
}

function isUnresolvedRoboSubmission(order = {}) {
  if (!order) return false;
  return [
    SUBMISSION_STATES.PENDING,
    SUBMISSION_STATES.UNKNOWN
  ].includes(order.submissionState)
    || (
      (order.submissionState === null || order.submissionState === undefined)
      && String(order.status || '').toLowerCase() === 'pending_submit'
    );
}

async function findUnresolvedRoboSubmission({
  accountId,
  environment,
  excludeOrderId = null
}, deps) {
  if (
    environment === 'paper'
    && typeof deps.findUnresolvedAlpacaPaperSubmission === 'function'
  ) {
    const match = await deps.findUnresolvedAlpacaPaperSubmission({
      accountId,
      excludeRoboOrderId: excludeOrderId
    }, {
      PaperOrderModel: deps.PaperOrder,
      RoboTradeOrderModel: deps.RoboTradeOrder,
      OrderIntentModel: deps.OrderIntent
    });
    return match?.order || null;
  }
  if (typeof deps.RoboTradeOrder?.findOne !== 'function') return null;
  const filter = {
    accountId,
    environment,
    ...(excludeOrderId ? { _id: { $ne: excludeOrderId } } : {}),
    $or: [
      { submissionState: SUBMISSION_STATES.PENDING },
      { submissionState: SUBMISSION_STATES.UNKNOWN },
      { submissionState: { $exists: false }, status: 'pending_submit' },
      { submissionState: null, status: 'pending_submit' }
    ]
  };
  const candidate = await readMaybeLean(deps.RoboTradeOrder.findOne(filter));
  if (
    excludeOrderId
    && candidate?._id
    && String(candidate._id) === String(excludeOrderId)
  ) {
    return null;
  }
  return isUnresolvedRoboSubmission(candidate) ? candidate : null;
}

async function writeAudit(userId, eventType, payload, deps) {
  if (!userId) return null;
  const normalizedPayload = payload || {};
  const audit = await deps.RoboAuditLog.create({ userId, eventType, payload: normalizedPayload });
  if (typeof deps.createOperationalAlertFromAudit === 'function') {
    try {
      await deps.createOperationalAlertFromAudit({ userId, eventType, payload: normalizedPayload }, deps);
    } catch (_err) {
      // The audit record is authoritative even when alert delivery fails.
    }
  }
  return audit;
}

async function recordCanaryOutcome(localOrder, status, details, deps) {
  if (!localOrder?.liveActivationId || typeof deps.recordControlledLiveOutcome !== 'function') return null;
  try {
    return await deps.recordControlledLiveOutcome({
      activationId: localOrder.liveActivationId,
      liveOrderId: localOrder._id,
      status,
      details,
      now: new Date()
    }, deps);
  } catch (_err) {
    return null;
  }
}

function mapBrokerLifecycle(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'filled') return { intentStatus: 'filled', decisionStatus: 'filled' };
  if (['canceled', 'cancelled', 'expired'].includes(normalized)) {
    return { intentStatus: 'cancelled', decisionStatus: 'cancelled' };
  }
  if (normalized === 'rejected') return { intentStatus: 'rejected', decisionStatus: 'rejected' };
  return { intentStatus: 'submitted', decisionStatus: 'submitted' };
}

async function applyAlpacaOrder(localOrder, alpacaOrder, deps) {
  const persistedClientOrderId = String(localOrder.clientOrderId || '').trim();
  const persistedExternalOrderId = String(localOrder.externalOrderId || '').trim();
  if (!hasConclusiveBrokerOrder(
    alpacaOrder,
    persistedClientOrderId || null,
    localOrder.qty,
    localOrder.notional
  )) {
    const err = new Error(
      'Broker order response did not contain a recognized status and complete correlation identity.'
    );
    err.code = 'BROKER_ORDER_INCONCLUSIVE';
    throw err;
  }
  const mapped = mapAlpacaOrder(alpacaOrder);
  const returnedClientOrderId = String(mapped.clientOrderId || '').trim();
  const returnedExternalOrderId = String(mapped.externalOrderId || '').trim();
  if (
    persistedClientOrderId
    && returnedClientOrderId !== persistedClientOrderId
  ) {
    const err = new Error('Broker order identity did not match the persisted client order id.');
    err.code = 'BROKER_ORDER_IDENTITY_MISMATCH';
    throw err;
  }
  if (
    persistedExternalOrderId
    && returnedExternalOrderId !== persistedExternalOrderId
  ) {
    const err = new Error('Broker order identity did not match the persisted external order id.');
    err.code = 'BROKER_ORDER_IDENTITY_MISMATCH';
    throw err;
  }
  if (
    !persistedExternalOrderId
    && returnedExternalOrderId
    && (
      !persistedClientOrderId
      || returnedClientOrderId !== persistedClientOrderId
    )
  ) {
    const err = new Error(
      'Broker external order identity cannot be learned without an exact persisted client order id.'
    );
    err.code = 'BROKER_ORDER_IDENTITY_MISMATCH';
    throw err;
  }
  mapped.externalOrderId = localOrder.externalOrderId || mapped.externalOrderId || null;
  mapped.clientOrderId = localOrder.clientOrderId || mapped.clientOrderId || null;
  if (mapped.submissionState === SUBMISSION_STATES.REJECTED && !mapped.rejectedAt) {
    mapped.rejectedAt = localOrder.rejectedAt || new Date();
  }
  Object.assign(localOrder, mapped, {
    reconciliationStatus: 'matched',
    discrepancy: null,
    submissionLastError: null,
    lastReconciledAt: new Date()
  });
  await localOrder.save();
  const brokerStatus = String(localOrder.status || '').toLowerCase();
  const canaryOutcomeStatus = brokerStatus === 'filled'
    ? 'reconciled'
    : (brokerStatus === 'rejected'
        ? 'rejected'
        : (['canceled', 'cancelled', 'expired'].includes(brokerStatus) ? 'reconciled' : 'broker_pending'));
  await recordCanaryOutcome(
    localOrder,
    canaryOutcomeStatus,
    { brokerStatus: localOrder.status, reconciliationStatus: localOrder.reconciliationStatus },
    deps
  );
  if (localOrder.intentId) {
    const lifecycle = mapBrokerLifecycle(localOrder.status);
    const lifecycleUpdates = [];
    if (deps.OrderIntent?.updateOne) {
      lifecycleUpdates.push(deps.OrderIntent.updateOne(
        { _id: localOrder.intentId, userId: localOrder.userId },
        {
          $set: {
            status: lifecycle.intentStatus,
            roboTradeOrderId: localOrder._id,
            rejectionReason: lifecycle.intentStatus === 'rejected'
              ? (localOrder.discrepancy || 'Broker rejected the order.')
              : null
          }
        }
      ));
    }
    if (localOrder.decisionId && deps.RoboTradeDecision?.updateOne) {
      lifecycleUpdates.push(deps.RoboTradeDecision.updateOne(
        { _id: localOrder.decisionId, userId: localOrder.userId },
        {
          $set: {
            status: lifecycle.decisionStatus,
            alpacaResponse: alpacaOrder,
            error: lifecycle.decisionStatus === 'rejected'
              ? (localOrder.discrepancy || 'Broker rejected the order.')
              : null
          }
        }
      ));
    }
    await Promise.all(lifecycleUpdates);
  }
  await writeAudit(localOrder.userId, 'robotrader_order_status_changed', {
    orderId: localOrder.externalOrderId,
    clientOrderId: localOrder.clientOrderId,
    status: localOrder.status
  }, deps);
}

function buildProtectiveStopParentQuery(parentOrder) {
  const parentMatches = [];
  if (parentOrder._id) parentMatches.push({ parentOrderId: parentOrder._id });
  if (parentOrder.clientOrderId) parentMatches.push({ parentClientOrderId: parentOrder.clientOrderId });
  if (!parentMatches.length) return null;
  return {
    environment: parentOrder.environment,
    exitReason: 'stop_loss',
    $or: parentMatches
  };
}

async function findAnyProtectiveStop(parentOrder, deps) {
  const query = buildProtectiveStopParentQuery(parentOrder);
  if (!query) return null;
  const result = deps.RoboTradeOrder.findOne(query);
  if (typeof result?.exec === 'function') return result.exec();
  return readMaybeLean(result);
}

async function submitProtectiveStopForEntryUnlocked(parentOrder, {
  broker,
  positions = [],
  availableQty = null,
  now = new Date(),
  submissionLockOwner = null
}, deps) {
  if (!isProtectiveStopCandidate(parentOrder)) return null;
  const existingStop = await findAnyProtectiveStop(parentOrder, deps);
  if (existingStop) return null;

  const explicitAvailableQty = Number(availableQty);
  const currentPositionQty = availableQty !== null
    && availableQty !== undefined
    && Number.isFinite(explicitAvailableQty)
    && explicitAvailableQty >= 0
    ? explicitAvailableQty
    : getPositionQty(parentOrder.symbol, positions);
  const filledQty = toFiniteNumber(parentOrder.filledQty ?? parentOrder.qty, 0) || 0;
  const closeQty = Math.min(Math.max(0, currentPositionQty), filledQty);
  if (!isPositiveNumber(closeQty)) {
    await writeAudit(parentOrder.userId, 'robotrader_protective_stop_skipped', {
      parentOrderId: String(parentOrder._id),
      clientOrderId: parentOrder.clientOrderId,
      symbol: parentOrder.symbol,
      reason: 'No positive long position was available for a protective stop order.'
    }, deps);
    return null;
  }

  const currentPrice = getPositionCurrentPrice(parentOrder.symbol, positions);
  if (isPositiveNumber(currentPrice) && Number(parentOrder.riskStopPrice) >= currentPrice) {
    const reason = 'The intended protective stop is at or above the current long-position price and requires immediate operator review.';
    await writeAudit(parentOrder.userId, 'robotrader_protective_stop_error', {
      parentOrderId: String(parentOrder._id),
      parentClientOrderId: parentOrder.clientOrderId || null,
      symbol: normalizeSymbol(parentOrder.symbol),
      stopPrice: parentOrder.riskStopPrice,
      currentPrice,
      reason,
      environment: parentOrder.environment
    }, deps);
    await recordCanaryOutcome(parentOrder, 'protection_failed', {
      reason,
      stopPrice: parentOrder.riskStopPrice,
      currentPrice
    }, deps);
    return null;
  }

  const clientOrderId = deps.buildClientOrderId({
    origin: 'robotrader-stop',
    symbol: parentOrder.symbol,
    now
  });
  const stopInput = {
    symbol: parentOrder.symbol,
    assetClass: 'stocks',
    side: 'sell',
    orderType: 'stop',
    orderClass: 'simple',
    timeInForce: 'day',
    qty: closeQty,
    stopPrice: parentOrder.riskStopPrice,
    clientOrderId
  };
  let stopOrder = null;
  try {
    const stopPayload = {
      userId: parentOrder.userId,
      accountId: parentOrder.accountId || 'default',
      decisionId: parentOrder.decisionId || null,
      environment: parentOrder.environment,
      broker: 'alpaca',
      parentOrderId: parentOrder._id,
      parentClientOrderId: parentOrder.clientOrderId || null,
      exitReason: 'stop_loss',
      symbol: normalizeSymbol(parentOrder.symbol),
      assetClass: 'stocks',
      side: 'sell',
      orderType: 'stop',
      orderClass: 'simple',
      timeInForce: 'day',
      qty: closeQty,
      stopPrice: parentOrder.riskStopPrice,
      clientOrderId,
      status: 'pending_submit',
      reasoningSummary: 'Protective stop generated for a filled RoboTrader simple/fractional stock entry.',
      strategyId: parentOrder.strategyId || null,
      parameterVersionId: parentOrder.parameterVersionId || null,
      riskChecks: parentOrder.riskChecks || [],
      liveActivationId: parentOrder.liveActivationId || null,
      externalOrderId: null,
      filledQty: null,
      filledAvgPrice: null,
      filledAt: null,
      canceledAt: null,
      rejectedAt: null,
      submissionState: SUBMISSION_STATES.PENDING,
      submissionAttemptCount: 1,
      submissionLastAttemptAt: now,
      submissionLastError: null,
      reconciliationStatus: 'pending',
      discrepancy: null,
      rawPayload: { client_order_id: clientOrderId }
    };
    stopOrder = await deps.RoboTradeOrder.create(stopPayload);
  } catch (err) {
    if (err?.code === 11000) {
      return findAnyProtectiveStop(parentOrder, deps);
    }
    const reason = `The durable protective-stop identity could not be created before broker dispatch: ${err?.message || 'persistence failed'}`;
    await recordCanaryOutcome(parentOrder, 'protection_failed', {
      reason,
      submissionState: SUBMISSION_STATES.NOT_ATTEMPTED
    }, deps);
    await writeAudit(parentOrder.userId, 'robotrader_protective_stop_blocked', {
      parentOrderId: String(parentOrder._id),
      parentClientOrderId: parentOrder.clientOrderId || null,
      clientOrderId,
      accountId: parentOrder.accountId || 'default',
      reason,
      code: 'ALPACA_PAPER_ATTEMPT_PERSIST_FAILED',
      submissionState: SUBMISSION_STATES.NOT_ATTEMPTED,
      submissionAttempted: false,
      environment: parentOrder.environment
    }, deps);
    return null;
  }

  const blockProtectiveBeforeBrokerSubmission = async ({
    reason,
    code
  }) => {
    stopOrder.status = 'canceled';
    stopOrder.submissionState = SUBMISSION_STATES.NOT_ATTEMPTED;
    stopOrder.submissionAttemptCount = 0;
    stopOrder.submissionLastAttemptAt = null;
    stopOrder.submissionLastError = {
      submissionOutcome: SUBMISSION_STATES.NOT_ATTEMPTED,
      submissionAttempted: false,
      submissionPhase: 'account_lock',
      code,
      message: reason
    };
    stopOrder.reconciliationStatus = 'submit_not_attempted';
    stopOrder.submittedAt = null;
    stopOrder.filledAt = null;
    stopOrder.canceledAt = now;
    stopOrder.rejectedAt = null;
    stopOrder.discrepancy = reason;
    await stopOrder.save();
    await recordCanaryOutcome(parentOrder, 'protection_failed', {
      reason,
      submissionState: SUBMISSION_STATES.NOT_ATTEMPTED
    }, deps);
    await writeAudit(parentOrder.userId, 'robotrader_protective_stop_blocked', {
      parentOrderId: String(parentOrder._id),
      clientOrderId: stopOrder.clientOrderId,
      accountId: parentOrder.accountId || 'default',
      reason,
      code,
      submissionState: SUBMISSION_STATES.NOT_ATTEMPTED,
      submissionAttempted: false,
      environment: parentOrder.environment
    }, deps);
    return stopOrder;
  };

  if (parentOrder.environment === 'paper') {
    let renewed = false;
    try {
      renewed = submissionLockOwner
        && typeof deps.renewAlpacaPaperSubmissionLock === 'function'
        && await deps.renewAlpacaPaperSubmissionLock(
          parentOrder.accountId || 'default',
          submissionLockOwner,
          new Date()
        );
    } catch (err) {
      return blockProtectiveBeforeBrokerSubmission({
        reason: `Protective-stop dispatch was blocked because the shared Alpaca-paper lease could not be verified: ${err?.message || 'coordination failed'}`,
        code: 'ALPACA_PAPER_SUBMISSION_COORDINATION_FAILED'
      });
    }
    if (!renewed) {
      return blockProtectiveBeforeBrokerSubmission({
        reason: 'Protective-stop dispatch was blocked because the shared Alpaca-paper submission lease was lost.',
        code: 'ALPACA_PAPER_SUBMISSION_LEASE_LOST'
      });
    }

  }

  let lateUnresolved = null;
  try {
    lateUnresolved = await findUnresolvedRoboSubmission({
      accountId: parentOrder.accountId || 'default',
      environment: parentOrder.environment,
      excludeOrderId: stopOrder._id
    }, deps);
  } catch (err) {
    return blockProtectiveBeforeBrokerSubmission({
      reason: `Protective-stop dispatch was blocked because the unresolved-submission latch could not be read: ${err?.message || 'coordination failed'}`,
      code: parentOrder.environment === 'paper'
        ? 'ALPACA_PAPER_SUBMISSION_COORDINATION_FAILED'
        : 'ALPACA_SUBMISSION_COORDINATION_FAILED'
    });
  }
  if (lateUnresolved) {
    return blockProtectiveBeforeBrokerSubmission({
      reason: 'Protective-stop dispatch was blocked because another Alpaca submission is unresolved for this account and environment.',
      code: parentOrder.environment === 'paper'
        ? 'UNRESOLVED_ALPACA_PAPER_SUBMISSION'
        : 'UNRESOLVED_ALPACA_SUBMISSION'
    });
  }

  let result = null;
  let submitError = null;
  try {
    result = await broker.submitOrder(stopInput);
    const acknowledgement = result?.order || {};
    if (!hasConclusiveBrokerOrder(
      acknowledgement,
      stopOrder.clientOrderId,
      stopOrder.qty,
      stopOrder.notional
    )) {
      throw createSubmitUnknownError(
        'Alpaca returned an inconclusive protective-stop acknowledgement.',
        {
          clientOrderId: stopOrder.clientOrderId,
          payload: result?.payload || {},
          brokerOrder: acknowledgement
        }
      );
    }
  } catch (err) {
    if (!err.clientOrderId) err.clientOrderId = stopOrder.clientOrderId;
    submitError = err;
  }

  if (submitError) {
    const classifiedState = classifySubmissionError(submitError);
    const submissionState = [
      SUBMISSION_STATES.REJECTED,
      SUBMISSION_STATES.NOT_ATTEMPTED
    ].includes(classifiedState)
      ? classifiedState
      : SUBMIT_UNKNOWN;
    const brokerError = buildSubmissionErrorSnapshot(submitError);
    const reason = brokerError.message || getBrokerErrorMessage(submitError);
    const ambiguousSubmit = submissionState === SUBMIT_UNKNOWN;
    const rejectedSubmit = submissionState === SUBMISSION_STATES.REJECTED;
    const notAttempted = submissionState === SUBMISSION_STATES.NOT_ATTEMPTED;
    stopOrder.submissionState = submissionState;
    stopOrder.status = ambiguousSubmit
      ? 'pending_submit'
      : (rejectedSubmit ? 'rejected' : 'canceled');
    stopOrder.reconciliationStatus = ambiguousSubmit
      ? 'submit_unknown'
      : (rejectedSubmit ? 'submit_rejected' : 'submit_not_attempted');
    if (notAttempted) {
      stopOrder.submissionAttemptCount = 0;
      stopOrder.submissionLastAttemptAt = null;
      stopOrder.submittedAt = null;
      stopOrder.filledAt = null;
    }
    stopOrder.rejectedAt = rejectedSubmit ? now : null;
    stopOrder.canceledAt = notAttempted ? now : null;
    stopOrder.discrepancy = reason;
    stopOrder.rawPayload = submitError.alpacaPayload || stopOrder.rawPayload || {};
    stopOrder.alpacaResponse = {
      ...brokerError,
      brokerOrder: submitError.brokerOrder || null
    };
    stopOrder.submissionLastError = brokerError;
    await stopOrder.save();

    if (ambiguousSubmit) {
      await recordCanaryOutcome(parentOrder, 'submission_uncertain', brokerError, deps);
    } else if (rejectedSubmit) {
      await recordCanaryOutcome(parentOrder, 'protection_failed', brokerError, deps);
    }
    await writeAudit(
      parentOrder.userId,
      'robotrader_protective_stop_error',
      {
        parentOrderId: String(parentOrder._id),
        parentClientOrderId: parentOrder.clientOrderId || null,
        clientOrderId: stopOrder.clientOrderId,
        symbol: stopOrder.symbol,
        reason,
        submissionState,
        brokerError,
        environment: stopOrder.environment
      },
      deps
    );
    return stopOrder;
  }

  const alpacaOrder = result.order || {};
  const brokerRejected = String(alpacaOrder.status || '').toLowerCase() === 'rejected';
  stopOrder.externalOrderId = alpacaOrder.id || null;
  stopOrder.status = alpacaOrder.status || 'submitted';
  stopOrder.submissionState = brokerRejected
    ? SUBMISSION_STATES.REJECTED
    : SUBMISSION_STATES.SUBMITTED;
  stopOrder.submissionLastError = null;
  stopOrder.rawPayload = result.payload || {};
  stopOrder.alpacaResponse = alpacaOrder;
  stopOrder.submittedAt = alpacaOrder.submitted_at || now;
  stopOrder.rejectedAt = brokerRejected ? (alpacaOrder.rejected_at || now) : null;
  stopOrder.reconciliationStatus = brokerRejected ? 'submit_rejected' : 'matched';
  stopOrder.discrepancy = brokerRejected ? 'Broker rejected the protective stop order.' : null;
  stopOrder.lastReconciledAt = now;
  await stopOrder.save();

  if (brokerRejected) {
    await recordCanaryOutcome(parentOrder, 'protection_failed', {
      brokerOrderId: stopOrder.externalOrderId,
      brokerStatus: stopOrder.status
    }, deps);
  }
  await writeAudit(parentOrder.userId, brokerRejected
    ? 'robotrader_protective_stop_error'
    : 'robotrader_protective_stop_submitted', {
    parentOrderId: String(parentOrder._id),
    parentClientOrderId: parentOrder.clientOrderId || null,
    orderId: stopOrder.externalOrderId,
    clientOrderId: stopOrder.clientOrderId,
    symbol: stopOrder.symbol,
    qty: stopOrder.qty,
    stopPrice: stopOrder.stopPrice,
    environment: stopOrder.environment
  }, deps);
  return stopOrder;
}

async function submitProtectiveStopForEntry(parentOrder, options = {}, deps) {
  if (!isProtectiveStopCandidate(parentOrder)) {
    return submitProtectiveStopForEntryUnlocked(parentOrder, options, deps);
  }

  const accountId = parentOrder.accountId || 'default';
  const paperEnvironment = parentOrder.environment === 'paper';
  const borrowedOwner = paperEnvironment
    ? (options.submissionLockOwner || null)
    : null;
  const owner = borrowedOwner || [
    'robotrader-protective',
    parentOrder.environment || 'unknown',
    accountId,
    String(parentOrder._id || 'parent'),
    Date.now(),
    Math.random().toString(36).slice(2)
  ].join(':');

  const blockProtectiveBeforeIdentity = async ({
    reason,
    code,
    unresolved = null
  }) => {
    await recordCanaryOutcome(parentOrder, 'protection_failed', {
      reason,
      submissionState: SUBMISSION_STATES.NOT_ATTEMPTED
    }, deps);
    await writeAudit(parentOrder.userId, 'robotrader_protective_stop_blocked', {
      parentOrderId: String(parentOrder._id),
      parentClientOrderId: parentOrder.clientOrderId || null,
      accountId,
      reason,
      code,
      unresolvedOrderId: unresolved?._id ? String(unresolved._id) : null,
      submissionState: SUBMISSION_STATES.NOT_ATTEMPTED,
      submissionAttempted: false,
      environment: parentOrder.environment
    }, deps);
    return null;
  };

  let lockReady = !paperEnvironment;
  if (paperEnvironment) {
    try {
      lockReady = borrowedOwner
        ? (
            typeof deps.renewAlpacaPaperSubmissionLock === 'function'
            && await deps.renewAlpacaPaperSubmissionLock(accountId, owner, new Date())
          )
        : (
            typeof deps.acquireAlpacaPaperSubmissionLock === 'function'
            && await deps.acquireAlpacaPaperSubmissionLock(accountId, owner, new Date())
          );
    } catch (err) {
      return blockProtectiveBeforeIdentity({
        reason: `Protective-stop submission was blocked because the shared Alpaca-paper lease could not be verified: ${err?.message || 'coordination failed'}`,
        code: 'ALPACA_PAPER_SUBMISSION_COORDINATION_FAILED'
      });
    }
  }

  if (!lockReady) {
    return blockProtectiveBeforeIdentity({
      reason: 'Protective-stop submission was blocked because the shared Alpaca-paper account lease is unavailable.',
      code: 'ALPACA_PAPER_SUBMISSION_LOCKED'
    });
  }

  try {
    let unresolved = null;
    try {
      unresolved = await findUnresolvedRoboSubmission({
        accountId,
        environment: parentOrder.environment
      }, deps);
    } catch (err) {
      return blockProtectiveBeforeIdentity({
        reason: `Protective-stop submission was blocked because the unresolved-submission latch could not be read: ${err?.message || 'coordination failed'}`,
        code: 'ALPACA_SUBMISSION_COORDINATION_FAILED'
      });
    }
    if (unresolved) {
      return blockProtectiveBeforeIdentity({
        reason: 'Protective-stop submission was blocked because an earlier Alpaca submission remains unresolved for this account and environment.',
        code: 'UNRESOLVED_ALPACA_SUBMISSION',
        unresolved
      });
    }
    return await submitProtectiveStopForEntryUnlocked(parentOrder, {
      ...options,
      submissionLockOwner: paperEnvironment ? owner : null
    }, deps);
  } finally {
    if (
      paperEnvironment
      &&
      !borrowedOwner
      && typeof deps.releaseAlpacaPaperSubmissionLock === 'function'
    ) {
      await deps.releaseAlpacaPaperSubmissionLock(accountId, owner).catch(() => {});
    }
  }
}

async function submitMissingProtectiveStops({
  mode,
  userId,
  accountId,
  limit,
  broker,
  now = new Date()
}, deps) {
  const query = {
    environment: mode,
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    riskStopPrice: { $gt: 0 },
    $or: [
      { exitReason: null },
      { exitReason: { $exists: false } }
    ]
  };
  if (userId) query.userId = userId;
  if (accountId) query.accountId = accountId;

  const candidates = await deps.RoboTradeOrder.find(query)
    .sort({ filledAt: -1, updatedAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const eligible = (candidates || []).filter(isProtectiveStopCandidate);
  if (!eligible.length) return [];

  const positions = typeof broker.getPositions === 'function'
    ? await broker.getPositions()
    : [];
  const existingStopQuery = {
    environment: mode,
    assetClass: 'stocks',
    side: 'sell',
    exitReason: 'stop_loss',
    status: { $in: OPEN_STATUSES }
  };
  if (userId) existingStopQuery.userId = userId;
  if (accountId) existingStopQuery.accountId = accountId;
  const existingStops = await deps.RoboTradeOrder.find(existingStopQuery)
    .sort({ submittedAt: -1, createdAt: -1 })
    .limit(500);
  const availableQtyBySymbol = buildPositionAvailabilityBySymbol(positions, existingStops);
  const submitted = [];
  for (const order of eligible) {
    const symbol = normalizeSymbol(order.symbol);
    const availableQty = availableQtyBySymbol.get(symbol) || 0;
    const protectiveStop = await submitProtectiveStopForEntry(order, {
      broker,
      positions,
      availableQty,
      now
    }, deps);
    if (protectiveStop) {
      submitted.push(protectiveStop);
      if (String(protectiveStop.status || '').toLowerCase() !== 'rejected') {
        availableQtyBySymbol.set(symbol, Math.max(0, availableQty - (toFiniteNumber(protectiveStop.qty, 0) || 0)));
      }
    }
  }
  return submitted;
}

async function loadAlpacaOrderForLocal(localOrder, broker) {
  if (localOrder.externalOrderId) {
    return broker.getOrder(localOrder.externalOrderId);
  }
  if (localOrder.clientOrderId && typeof broker.getOrderByClientOrderId === 'function') {
    return broker.getOrderByClientOrderId(localOrder.clientOrderId);
  }
  return null;
}

function hasUnresolvedSubmissionOutcome(order = {}) {
  if ([SUBMISSION_STATES.PENDING, SUBMIT_UNKNOWN].includes(order.submissionState)) return true;
  return !order.submissionState && String(order.status || '').toLowerCase() === 'pending_submit';
}

async function retainSubmissionUnknown(localOrder, {
  type,
  reason
}, deps) {
  localOrder.status = 'pending_submit';
  localOrder.submissionState = SUBMIT_UNKNOWN;
  localOrder.reconciliationStatus = 'submit_unknown';
  localOrder.rejectedAt = null;
  localOrder.discrepancy = reason;
  localOrder.lastReconciledAt = new Date();
  await localOrder.save();
  await recordCanaryOutcome(localOrder, 'submission_uncertain', {
    type,
    reason,
    clientOrderId: localOrder.clientOrderId || null,
    externalOrderId: localOrder.externalOrderId || null
  }, deps);
  await writeAudit(localOrder.userId, 'robotrader_reconciliation_discrepancy', {
    type,
    localOrderId: String(localOrder._id),
    clientOrderId: localOrder.clientOrderId || null,
    externalOrderId: localOrder.externalOrderId || null,
    submissionState: SUBMIT_UNKNOWN,
    reason
  }, deps);
}

function isBrokerNotFoundError(err = {}) {
  return Number(err.status ?? err.response?.status ?? err.response?.statusCode) === 404;
}

async function reconcileRejectedSubmissions({
  mode = 'paper',
  limit = 100,
  userId = null,
  accountId = null,
  broker
} = {}, deps = defaultDeps) {
  const query = {
    environment: mode,
    status: 'rejected',
    submissionState: SUBMISSION_STATES.REJECTED,
    externalOrderId: null,
    clientOrderId: { $nin: [null, ''] },
    discrepancy: { $nin: [null, ''] },
    reconciliationArchivedAt: null
  };
  if (userId) query.userId = userId;
  if (accountId) query.accountId = accountId;

  const candidates = await deps.RoboTradeOrder.find(query)
    .sort({ rejectedAt: -1, updatedAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const resolved = [];
  const discrepancies = [];

  for (const order of candidates || []) {
    // Tests and alternate model adapters may not enforce the query themselves.
    if (
      String(order.status || '').toLowerCase() !== 'rejected'
      || order.submissionState !== SUBMISSION_STATES.REJECTED
      || order.externalOrderId
    ) continue;
    try {
      const remote = await broker.getOrderByClientOrderId(order.clientOrderId);
      if (remote) {
        if (!hasConclusiveBrokerOrder(
          remote,
          order.clientOrderId || null,
          order.qty,
          order.notional
        )) {
          discrepancies.push({
            type: 'rejected_submission_lookup_inconclusive',
            localOrderId: String(order._id),
            clientOrderId: order.clientOrderId
          });
          continue;
        }
        await applyAlpacaOrder(order, remote, deps);
        discrepancies.push({
          type: 'rejected_submission_exists_at_broker',
          localOrderId: String(order._id),
          externalOrderId: remote.id || null
        });
      }
    } catch (err) {
      if (!isBrokerNotFoundError(err)) {
        discrepancies.push({
          type: 'rejected_submission_lookup_failed',
          localOrderId: String(order._id),
          reason: err?.message || 'Broker lookup failed.'
        });
        continue;
      }

      const resolvedAt = new Date();
      const previousDiscrepancy = order.discrepancy;
      order.reconciliationStatus = 'resolved_rejected';
      order.discrepancy = null;
      order.lastReconciledAt = resolvedAt;
      order.reconciliationResolvedAt = resolvedAt;
      order.reconciliationResolvedBy = 'system:broker-confirmed';
      order.reconciliationResolution = 'Broker confirmed that the rejected submission never created an order.';
      order.reconciliationResolutionEvidence = {
        broker: order.broker || 'alpaca',
        environment: mode,
        clientOrderId: order.clientOrderId,
        lookupStatus: 404,
        previousDiscrepancy
      };
      await order.save();
      resolved.push(String(order._id));
      await writeAudit(order.userId, 'robotrader_reconciliation_resolved', {
        localOrderId: String(order._id),
        resolution: 'broker_confirmed_rejected_not_submitted',
        clientOrderId: order.clientOrderId,
        brokerLookupStatus: 404,
        previousDiscrepancy
      }, deps);
    }
  }

  return { resolved, discrepancies };
}

async function reconcileRoboOrders({
  mode = 'paper',
  limit = 100,
  userId = null,
  accountId = null
} = {}, deps = defaultDeps) {
  const broker = deps.createAlpacaBroker({ mode });
  const localOrderQuery = {
    environment: mode,
    status: { $in: OPEN_STATUSES }
  };
  if (userId) localOrderQuery.userId = userId;
  if (accountId) localOrderQuery.accountId = accountId;

  const localOrders = await deps.RoboTradeOrder.find(localOrderQuery)
    .sort({ submittedAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const updated = [];
  const discrepancies = [];

  for (const localOrder of localOrders) {
    if (!localOrder.externalOrderId && !localOrder.clientOrderId) {
      if (hasUnresolvedSubmissionOutcome(localOrder)) {
        const reason = 'Submission outcome remains unknown because the original broker identity is missing.';
        await retainSubmissionUnknown(localOrder, {
          type: 'submission_identity_missing',
          reason
        }, deps);
        discrepancies.push({
          type: 'submission_identity_missing',
          localOrderId: String(localOrder._id),
          reason
        });
        continue;
      }
      localOrder.reconciliationStatus = 'missing_alpaca_confirmation';
      localOrder.discrepancy = 'Local RoboTradeOrder does not have an Alpaca order id.';
      localOrder.lastReconciledAt = new Date();
      await localOrder.save();
      await recordCanaryOutcome(localOrder, 'reconciliation_failed', { type: 'missing_alpaca_confirmation' }, deps);
      discrepancies.push({ type: 'missing_alpaca_confirmation', localOrderId: String(localOrder._id) });
      await writeAudit(localOrder.userId, 'robotrader_reconciliation_discrepancy', {
        type: 'missing_alpaca_confirmation',
        localOrderId: String(localOrder._id)
      }, deps);
      continue;
    }

    try {
      const alpacaOrder = await loadAlpacaOrderForLocal(localOrder, broker);
      if (!alpacaOrder) {
        if (hasUnresolvedSubmissionOutcome(localOrder)) {
          const reason = 'Original broker identity was not found; submission outcome remains unknown.';
          await retainSubmissionUnknown(localOrder, {
            type: 'submission_lookup_not_found',
            reason
          }, deps);
          discrepancies.push({
            type: 'submission_lookup_not_found',
            localOrderId: String(localOrder._id),
            reason
          });
          continue;
        }
        localOrder.reconciliationStatus = 'missing_alpaca_confirmation';
        localOrder.discrepancy = localOrder.clientOrderId
          ? 'Local RoboTradeOrder has a client_order_id but could not be looked up by client_order_id.'
          : 'Local RoboTradeOrder does not have an Alpaca order id.';
        localOrder.lastReconciledAt = new Date();
        await localOrder.save();
        await recordCanaryOutcome(localOrder, 'reconciliation_failed', { type: 'missing_alpaca_confirmation' }, deps);
        discrepancies.push({ type: 'missing_alpaca_confirmation', localOrderId: String(localOrder._id) });
        await writeAudit(localOrder.userId, 'robotrader_reconciliation_discrepancy', {
          type: 'missing_alpaca_confirmation',
          localOrderId: String(localOrder._id),
          clientOrderId: localOrder.clientOrderId || null
        }, deps);
        continue;
      }
      if (
        hasUnresolvedSubmissionOutcome(localOrder)
        && !hasConclusiveBrokerOrder(
          alpacaOrder,
          localOrder.clientOrderId || null,
          localOrder.qty,
          localOrder.notional
        )
      ) {
        const reason = 'Broker lookup returned an inconclusive order; submission outcome remains unknown.';
        await retainSubmissionUnknown(localOrder, {
          type: 'submission_lookup_inconclusive',
          reason
        }, deps);
        discrepancies.push({
          type: 'submission_lookup_inconclusive',
          localOrderId: String(localOrder._id),
          reason
        });
        continue;
      }
      await applyAlpacaOrder(localOrder, alpacaOrder, deps);
      updated.push(String(localOrder._id));
    } catch (err) {
      if (hasUnresolvedSubmissionOutcome(localOrder)) {
        const lookupNotFound = isBrokerNotFoundError(err);
        const reason = lookupNotFound
          ? 'Original broker identity was not found; submission outcome remains unknown.'
          : (err?.message || 'Original broker identity lookup failed; submission outcome remains unknown.');
        const type = lookupNotFound ? 'submission_lookup_not_found' : 'submission_lookup_failed';
        await retainSubmissionUnknown(localOrder, { type, reason }, deps);
        discrepancies.push({
          type,
          localOrderId: String(localOrder._id),
          reason
        });
        continue;
      }
      localOrder.reconciliationStatus = 'alpaca_lookup_failed';
      localOrder.discrepancy = err?.message || 'Alpaca order lookup failed.';
      localOrder.lastReconciledAt = new Date();
      await localOrder.save();
      await recordCanaryOutcome(localOrder, 'reconciliation_failed', { type: 'alpaca_lookup_failed', reason: localOrder.discrepancy }, deps);
      discrepancies.push({
        type: 'alpaca_lookup_failed',
        localOrderId: String(localOrder._id),
        reason: localOrder.discrepancy
      });
    }
  }

  const rejectedSubmissionResult = await reconcileRejectedSubmissions({
    mode,
    limit,
    userId,
    accountId,
    broker
  }, deps);
  updated.push(...rejectedSubmissionResult.resolved);
  discrepancies.push(...rejectedSubmissionResult.discrepancies);

  const protectiveStops = await submitMissingProtectiveStops({
    mode,
    userId,
    accountId,
    limit,
    broker,
    now: new Date()
  }, deps);

  const recentAlpacaOrders = await broker.listOrders({
    status: 'all',
    limit: Math.min(Math.max(Number(limit) || 100, 1), 500),
    nested: true
  });
  for (const order of recentAlpacaOrders || []) {
    const clientOrderId = order.client_order_id || null;
    if (!clientOrderId || (!clientOrderId.includes('robotrader') && !clientOrderId.includes('robo'))) continue;
    const exists = await deps.RoboTradeOrder.findOne({
      $or: [
        { externalOrderId: order.id },
        { clientOrderId }
      ]
    }).lean();
    if (!exists) {
      if (userId) {
        discrepancies.push({
          type: 'unattributed_alpaca_order',
          reason: 'A RoboTrader Alpaca order exists without a local record, but it cannot be safely attributed to the requesting user.'
        });
        continue;
      }
      discrepancies.push({
        type: 'alpaca_order_missing_local_record',
        externalOrderId: order.id,
        clientOrderId
      });
      await deps.RoboTradeOrder.create({
        userId: null,
        environment: mode,
        externalOrderId: order.id || null,
        clientOrderId,
        symbol: order.symbol,
        assetClass: order.asset_class === 'crypto' ? 'crypto' : 'stocks',
        side: order.side,
        orderType: order.type,
        orderClass: order.order_class || 'simple',
        timeInForce: order.time_in_force,
        qty: toFiniteNumber(order.qty, null),
        notional: toFiniteNumber(order.notional, null),
        status: order.status || 'unknown',
        submissionState: String(order.status || '').toLowerCase() === 'rejected'
          ? SUBMISSION_STATES.REJECTED
          : SUBMISSION_STATES.SUBMITTED,
        alpacaResponse: order,
        reconciliationStatus: 'orphan_alpaca_order',
        discrepancy: 'Alpaca order was not found in local RoboTradeOrder records.',
        submittedAt: order.submitted_at || null,
        lastReconciledAt: new Date()
      });
    }
  }

  return {
    ok: true,
    environment: mode,
    updatedCount: updated.length,
    discrepancyCount: discrepancies.length,
    protectiveStopsSubmitted: protectiveStops.length,
    updated,
    discrepancies
  };
}

const defaultDeps = {
  OrderIntent,
  PaperOrder,
  RoboTradeOrder,
  acquireAlpacaPaperSubmissionLock,
  recordControlledLiveOutcome,
  RoboTradeDecision,
  RoboAuditLog,
  createOperationalAlertFromAudit,
  createAlpacaBroker,
  buildClientOrderId,
  findUnresolvedAlpacaPaperSubmission,
  releaseAlpacaPaperSubmissionLock,
  renewAlpacaPaperSubmissionLock
};

module.exports = {
  reconcileRoboOrders,
  reconcileRejectedSubmissions,
  submitProtectiveStopForEntry,
  submitMissingProtectiveStops
};

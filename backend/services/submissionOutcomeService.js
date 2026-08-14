const SUBMISSION_STATES = Object.freeze({
  PENDING: 'PENDING_SUBMIT',
  UNKNOWN: 'SUBMIT_UNKNOWN',
  SUBMITTED: 'SUBMITTED',
  REJECTED: 'REJECTED_CONFIRMED',
  NOT_ATTEMPTED: 'NOT_ATTEMPTED'
});

const SUBMIT_UNKNOWN = SUBMISSION_STATES.UNKNOWN;

const AMBIGUOUS_HTTP_STATUSES = new Set([408, 425, 429]);
const AMBIGUOUS_TRANSPORT_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_NETWORK',
  'ETIMEDOUT'
]);
const RECOGNIZED_BROKER_ORDER_STATUSES = Object.freeze([
  'accepted',
  'accepted_for_bidding',
  'calculated',
  'canceled',
  'done_for_day',
  'expired',
  'filled',
  'new',
  'partially_filled',
  'pending_cancel',
  'pending_new',
  'pending_replace',
  'rejected',
  'replaced',
  'stopped',
  'suspended'
]);
const RECOGNIZED_BROKER_ORDER_STATUS_SET = new Set(
  RECOGNIZED_BROKER_ORDER_STATUSES
);

function getSubmitErrorStatus(err = {}) {
  const status = Number(err.status ?? err.response?.status ?? err.response?.statusCode);
  return Number.isFinite(status) ? status : null;
}

function getBrokerErrorPayload(err = {}) {
  const data = err.response?.data;
  if (data && typeof data === 'object') return data;
  if (typeof data === 'string' && data.trim()) return { message: data.trim() };
  return null;
}

function getBrokerErrorMessage(err = {}, fallback = 'Broker order submission failed.') {
  const payload = getBrokerErrorPayload(err);
  const message = payload?.message
    || payload?.error
    || payload?.error_message
    || payload?.detail
    || err.message
    || fallback;
  const status = getSubmitErrorStatus(err);
  return status && !String(message).includes(String(status))
    ? `Broker ${status}: ${message}`
    : String(message);
}

function isDuplicateClientOrderIdError(err = {}) {
  const brokerCode = String(
    err.response?.data?.code
    || err.code
    || ''
  ).trim();
  const payload = getBrokerErrorPayload(err) || {};
  const message = [
    payload.message,
    payload.error,
    payload.error_message,
    payload.detail,
    err.message
  ]
    .filter(value => typeof value === 'string' && value.trim())
    .join(' ')
    .toLowerCase();
  const namesClientOrderId = /client[_\s-]?order[_\s-]?id/.test(message);
  const describesUniquenessConflict = /(?:already|duplicate|exists|in use|unique|uniqueness|used|taken)/.test(
    message
  );
  return brokerCode === '40010001'
    || (namesClientOrderId && describesUniquenessConflict);
}

function hasMeaningfulBrokerRejectionPayload(err = {}) {
  const payload = getBrokerErrorPayload(err);
  if (!payload || Array.isArray(payload)) return false;
  return [
    payload.message,
    payload.error,
    payload.error_message,
    payload.detail
  ].some(value => typeof value === 'string' && value.trim());
}

function isAffirmativeBrokerRejection(err = {}) {
  const status = getSubmitErrorStatus(err);
  if (status === null || status < 400 || status >= 500) return false;
  if (AMBIGUOUS_HTTP_STATUSES.has(status) || isDuplicateClientOrderIdError(err)) return false;
  return hasMeaningfulBrokerRejectionPayload(err);
}

function classifySubmissionError(err = {}) {
  if (Object.values(SUBMISSION_STATES).includes(err.submissionOutcome)) {
    return err.submissionOutcome;
  }
  if (err.submissionAttempted === false) return SUBMISSION_STATES.NOT_ATTEMPTED;
  if (isDuplicateClientOrderIdError(err)) return SUBMISSION_STATES.UNKNOWN;

  const status = getSubmitErrorStatus(err);
  if (status !== null) {
    if (AMBIGUOUS_HTTP_STATUSES.has(status) || status >= 500) {
      return SUBMISSION_STATES.UNKNOWN;
    }
    if (isAffirmativeBrokerRejection(err)) return SUBMISSION_STATES.REJECTED;
    return SUBMISSION_STATES.UNKNOWN;
  }

  const code = String(err.code || '').trim().toUpperCase();
  if (AMBIGUOUS_TRANSPORT_CODES.has(code)) return SUBMISSION_STATES.UNKNOWN;

  // Once broker I/O may have begun, lack of affirmative rejection evidence must fail
  // conservatively. Unknown/custom errors are also unknown unless the caller marked
  // the failure as pre-submit.
  return SUBMISSION_STATES.UNKNOWN;
}

function isAmbiguousSubmitError(err = {}) {
  return classifySubmissionError(err) === SUBMISSION_STATES.UNKNOWN;
}

function buildSubmissionErrorSnapshot(err = {}) {
  return {
    submissionOutcome: classifySubmissionError(err),
    submissionAttempted: err.submissionAttempted !== false,
    status: getSubmitErrorStatus(err),
    code: err.code || err.response?.data?.code || null,
    message: getBrokerErrorMessage(err),
    data: getBrokerErrorPayload(err),
    clientOrderId: err.clientOrderId || err.client_order_id || null,
    brokerRequestId: err.brokerRequestId || null
  };
}

function isCanonicalBrokerIdentifier(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim();
}

function isNonnegativeBrokerNumber(value) {
  if (
    typeof value !== 'string'
    || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  ) {
    return false;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0;
}

function isPositiveBrokerNumber(value) {
  return isNonnegativeBrokerNumber(value) && Number(value) > 0;
}

function hasConclusiveBrokerOrder(
  order = {},
  expectedClientOrderId = null,
  expectedQty = null,
  expectedNotional = null
) {
  const rawStatus = order.status;
  if (
    typeof rawStatus !== 'string'
    || rawStatus !== rawStatus.trim()
    || rawStatus !== rawStatus.toLowerCase()
  ) {
    return false;
  }
  if (!RECOGNIZED_BROKER_ORDER_STATUS_SET.has(rawStatus)) return false;

  if (!isCanonicalBrokerIdentifier(order.id)) return false;

  const returnedClientOrderId = order.client_order_id ?? order.clientOrderId;
  if (expectedClientOrderId !== null && expectedClientOrderId !== undefined) {
    if (
      !isCanonicalBrokerIdentifier(expectedClientOrderId)
      || !isCanonicalBrokerIdentifier(returnedClientOrderId)
      || returnedClientOrderId !== expectedClientOrderId
    ) {
      return false;
    }
  } else if (
    returnedClientOrderId !== null
    && returnedClientOrderId !== undefined
    && !isCanonicalBrokerIdentifier(returnedClientOrderId)
  ) {
    return false;
  }

  const filledQtyProvided = ![null, undefined].includes(order.filled_qty);
  const filledPriceProvided = ![null, undefined].includes(order.filled_avg_price);
  if (
    (filledQtyProvided && !isNonnegativeBrokerNumber(order.filled_qty))
    || (filledPriceProvided && !isNonnegativeBrokerNumber(order.filled_avg_price))
  ) {
    return false;
  }
  const filledQty = filledQtyProvided ? Number(order.filled_qty) : 0;
  if (filledQty === 0) {
    if (
      filledPriceProvided
      || ['filled', 'partially_filled'].includes(rawStatus)
    ) {
      return false;
    }
  } else {
    if (
      !filledPriceProvided
      || !isPositiveBrokerNumber(order.filled_avg_price)
      || rawStatus === 'rejected'
      || !['filled', 'partially_filled'].includes(rawStatus)
    ) {
      return false;
    }
    if (expectedQty !== null && expectedQty !== undefined) {
      if (
        !['number', 'string'].includes(typeof expectedQty)
        || !Number.isFinite(Number(expectedQty))
        || Number(expectedQty) <= 0
      ) {
        return false;
      }
      const requestedQty = Number(expectedQty);
      if (
        (rawStatus === 'filled' && filledQty !== requestedQty)
        || (rawStatus !== 'filled' && filledQty >= requestedQty)
      ) {
        return false;
      }
    } else if (expectedNotional !== null && expectedNotional !== undefined) {
      if (
        !['number', 'string'].includes(typeof expectedNotional)
        || !Number.isFinite(Number(expectedNotional))
        || Number(expectedNotional) <= 0
      ) {
        return false;
      }
      const fillNotional = filledQty * Number(order.filled_avg_price);
      const requestedNotional = Number(expectedNotional);
      const upperBound = requestedNotional * 1.01 + 0.01;
      const lowerBound = Math.max(0, requestedNotional * 0.99 - 0.01);
      if (
        !Number.isFinite(fillNotional)
        || fillNotional > upperBound
        || (rawStatus === 'filled' && fillNotional < lowerBound)
      ) {
        return false;
      }
    } else {
      return false;
    }
  }

  return true;
}

function createSubmitUnknownError(message = 'Broker submission outcome is unknown.', {
  clientOrderId = null,
  payload = null,
  brokerOrder = null,
  cause = null
} = {}) {
  const err = new Error(message);
  err.code = SUBMIT_UNKNOWN;
  err.statusCode = 409;
  err.submissionAttempted = true;
  err.submissionOutcome = SUBMIT_UNKNOWN;
  err.clientOrderId = clientOrderId;
  err.alpacaPayload = payload || {};
  err.brokerOrder = brokerOrder || null;
  if (cause) err.cause = cause;
  return err;
}

module.exports = {
  AMBIGUOUS_HTTP_STATUSES,
  AMBIGUOUS_TRANSPORT_CODES,
  RECOGNIZED_BROKER_ORDER_STATUSES,
  SUBMISSION_STATES,
  SUBMIT_UNKNOWN,
  buildSubmissionErrorSnapshot,
  classifySubmissionError,
  createSubmitUnknownError,
  getBrokerErrorMessage,
  getBrokerErrorPayload,
  getSubmitErrorStatus,
  hasConclusiveBrokerOrder,
  hasMeaningfulBrokerRejectionPayload,
  isCanonicalBrokerIdentifier,
  isPositiveBrokerNumber,
  isAffirmativeBrokerRejection,
  isAmbiguousSubmitError,
  isDuplicateClientOrderIdError
};

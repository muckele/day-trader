const crypto = require('crypto');
const axios = require('axios');
const {
  SUBMISSION_STATES,
  buildSubmissionErrorSnapshot,
  classifySubmissionError,
  createSubmitUnknownError,
  getBrokerErrorMessage,
  getSubmitErrorStatus,
  hasConclusiveBrokerOrder
} = require('./submissionOutcomeService');
const {
  assertAlpacaPaperSubmissionBinding,
  isPaperTradingEndpoint,
  isReleaseEnvironment
} = require('./alpacaPaperBindingService');

const DEFAULT_ALPACA_PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
const EQUITY_ORDER_TYPES = ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'];
const EQUITY_TIME_IN_FORCE = ['day', 'gtc', 'opg', 'cls', 'ioc', 'fok'];
const CRYPTO_ORDER_TYPES = ['market', 'limit', 'stop_limit'];
const CRYPTO_TIME_IN_FORCE = ['gtc', 'ioc'];
const MAX_ALPACA_CLIENT_ORDER_ID_LENGTH = 48;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function getAlpacaTradingConfig(env = process.env) {
  const explicitApiKey = env.APCA_PAPER_API_KEY_ID || env.ALPACA_PAPER_API_KEY || '';
  const explicitApiSecret = env.APCA_PAPER_API_SECRET_KEY || env.ALPACA_PAPER_API_SECRET || '';
  const allowGenericLocalCredentials = !isReleaseEnvironment(env);
  const rawBaseUrl = String(
    env.APCA_PAPER_BASE_URL
    || env.ALPACA_PAPER_BASE_URL
    || (allowGenericLocalCredentials && (env.ALPACA_BASE_URL || env.APCA_BASE_URL))
    || DEFAULT_ALPACA_PAPER_BASE_URL
  ).replace(/\/$/, '');
  return {
    mode: 'paper',
    baseUrl: rawBaseUrl.replace(/\/v2\/?$/, ''),
    apiKey: explicitApiKey || (allowGenericLocalCredentials
      ? env.BROKER_API_KEY || env.APCA_API_KEY_ID || env.ALPACA_API_KEY || ''
      : ''),
    apiSecret: explicitApiSecret || (allowGenericLocalCredentials
      ? env.BROKER_API_SECRET || env.APCA_API_SECRET_KEY || env.ALPACA_API_SECRET || ''
      : ''),
    credentialSource: explicitApiKey && explicitApiSecret ? 'paper_explicit' : 'generic_local',
    expectedAccountId: env.APCA_PAPER_ACCOUNT_ID || env.ALPACA_PAPER_ACCOUNT_ID || null
  };
}

function shouldSyncPaperTradesToAlpaca(env = process.env) {
  return parseBoolean(env.APP_PAPER_TRADES_SYNC_TO_ALPACA, false);
}

function normalizeAlpacaSymbol(symbol, assetClass = 'equity') {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (assetClass !== 'crypto') return normalized.replace(/[^A-Z0-9.]/g, '');
  const compact = normalized.replace(/[^A-Z0-9]/g, '');
  if (!compact) return compact;
  if (compact.endsWith('USDT')) return `${compact.slice(0, -4)}/USDT`;
  if (compact.endsWith('USDC')) return `${compact.slice(0, -4)}/USDC`;
  if (compact.endsWith('USD')) return `${compact.slice(0, -3)}/USD`;
  return `${compact}/USD`;
}

function toOrderString(value) {
  return Number(value).toString();
}

function hasPositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function assertAlpacaClientOrderId(value) {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > MAX_ALPACA_CLIENT_ORDER_ID_LENGTH
  ) {
    throw new Error(
      `client_order_id must be an exact nonblank string of at most ${MAX_ALPACA_CLIENT_ORDER_ID_LENGTH} characters.`
    );
  }
  return value;
}

function buildClientOrderId({ origin = 'manual', symbol = 'ORDER', now = new Date() } = {}) {
  const safeOrigin = String(origin || 'manual').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'manual';
  const safeSymbol = String(symbol || 'ORDER').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 16) || 'ORDER';
  const timestamp = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const suffix = crypto.randomBytes(4).toString('hex');
  const tail = `-${timestamp}-${suffix}`;
  const headBudget = MAX_ALPACA_CLIENT_ORDER_ID_LENGTH - tail.length;
  const head = `dt-${safeOrigin}-${safeSymbol}`
    .slice(0, headBudget)
    .replace(/[-_]+$/, '');
  return `${head}${tail}`;
}

function buildAlpacaOrderPayload({
  symbol,
  assetClass = 'equity',
  side,
  qty,
  orderType = 'market',
  timeInForce = 'day',
  limitPrice,
  stopPrice,
  takeProfitPrice,
  stopLossPrice,
  trailingStopPct,
  allowExtendedHours = false,
  clientOrderId
}) {
  const normalizedAssetClass = assetClass === 'crypto' ? 'crypto' : 'equity';
  const normalizedOrderType = String(orderType || 'market').toLowerCase();
  const normalizedTimeInForce = String(timeInForce || 'day').toLowerCase();
  const payload = {
    symbol: normalizeAlpacaSymbol(symbol, normalizedAssetClass),
    qty: toOrderString(qty),
    side,
    type: normalizedOrderType,
    time_in_force: normalizedTimeInForce,
    client_order_id: assertAlpacaClientOrderId(clientOrderId)
  };

  if (!payload.symbol) {
    throw new Error('Symbol is required for Alpaca order submission.');
  }
  if (!['buy', 'sell'].includes(payload.side)) {
    throw new Error('Alpaca order side must be buy or sell.');
  }
  if (!Number.isFinite(Number(qty)) || Number(qty) <= 0) {
    throw new Error('Alpaca order quantity must be a positive number.');
  }

  if (normalizedAssetClass === 'crypto') {
    if (!CRYPTO_ORDER_TYPES.includes(normalizedOrderType)) {
      throw new Error('Alpaca crypto orders support market, limit, or stop_limit order types.');
    }
    if (!CRYPTO_TIME_IN_FORCE.includes(normalizedTimeInForce)) {
      throw new Error('Alpaca crypto orders require gtc or ioc time-in-force.');
    }
  } else {
    if (!EQUITY_ORDER_TYPES.includes(normalizedOrderType)) {
      throw new Error('Alpaca equity orders support market, limit, stop, stop_limit, or trailing_stop order types.');
    }
    if (!EQUITY_TIME_IN_FORCE.includes(normalizedTimeInForce)) {
      throw new Error('Alpaca equity orders require day, gtc, opg, cls, ioc, or fok time-in-force.');
    }
  }

  if ((normalizedOrderType === 'limit' || normalizedOrderType === 'stop_limit') && !hasPositiveNumber(limitPrice)) {
    throw new Error(`${normalizedOrderType} orders require a positive limitPrice.`);
  }
  if ((normalizedOrderType === 'stop' || normalizedOrderType === 'stop_limit') && !hasPositiveNumber(stopPrice)) {
    throw new Error(`${normalizedOrderType} orders require a positive stopPrice.`);
  }
  if (normalizedOrderType === 'trailing_stop' && !hasPositiveNumber(trailingStopPct)) {
    throw new Error('trailing_stop orders require a positive trailingStopPct.');
  }

  if (normalizedOrderType === 'limit' || normalizedOrderType === 'stop_limit') {
    payload.limit_price = toOrderString(limitPrice);
  }
  if (normalizedOrderType === 'stop' || normalizedOrderType === 'stop_limit') {
    payload.stop_price = toOrderString(stopPrice);
  }
  if (normalizedOrderType === 'trailing_stop') {
    payload.trail_percent = toOrderString(trailingStopPct);
  }

  if (
    normalizedAssetClass === 'equity'
    && allowExtendedHours === true
    && normalizedOrderType === 'limit'
    && ['day', 'gtc'].includes(normalizedTimeInForce)
  ) {
    payload.extended_hours = true;
  }

  const hasTakeProfit = Number.isFinite(Number(takeProfitPrice)) && Number(takeProfitPrice) > 0;
  const hasStopLoss = Number.isFinite(Number(stopLossPrice)) && Number(stopLossPrice) > 0;
  if (normalizedAssetClass === 'equity' && (hasTakeProfit || hasStopLoss)) {
    payload.order_class = hasTakeProfit && hasStopLoss ? 'bracket' : 'oto';
    if (hasTakeProfit) {
      payload.take_profit = { limit_price: toOrderString(takeProfitPrice) };
    }
    if (hasStopLoss) {
      payload.stop_loss = { stop_price: toOrderString(stopLossPrice) };
    }
  }

  return payload;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertAlpacaPaperConfig(config) {
  if (!config.apiKey || !config.apiSecret) {
    throw new Error('Alpaca API credentials are not configured.');
  }
  if (!isPaperTradingEndpoint(config.baseUrl)) {
    const err = new Error(
      'Alpaca paper sync requires the exact https://paper-api.alpaca.markets endpoint.'
    );
    err.code = 'ALPACA_PAPER_ENDPOINT_REQUIRED';
    err.submissionAttempted = false;
    throw err;
  }
}

function getAlpacaRequestConfig(config) {
  return {
    headers: {
      'APCA-API-KEY-ID': config.apiKey,
      'APCA-API-SECRET-KEY': config.apiSecret
    },
    timeout: 20000
  };
}

function extractBrokerRequestId(headers = {}) {
  return headers['x-request-id']
    || headers['apca-request-id']
    || headers['request-id']
    || null;
}

function markPreSubmitError(err, clientOrderId = null) {
  err.submissionAttempted = false;
  err.submissionOutcome = SUBMISSION_STATES.NOT_ATTEMPTED;
  err.submissionPhase = 'pre_submit';
  err.statusCode = err.statusCode || 400;
  err.clientOrderId = clientOrderId;
  return err;
}

async function readAlpacaPaperOrder(orderId, { httpClient = axios, env = process.env } = {}) {
  const config = getAlpacaTradingConfig(env);
  assertAlpacaPaperConfig(config);

  const response = await httpClient.get(
    `${config.baseUrl}/v2/orders/${orderId}`,
    getAlpacaRequestConfig(config)
  );
  return response?.data || {};
}

async function readAlpacaPaperOrderByClientOrderId(
  clientOrderId,
  { httpClient = axios, env = process.env } = {}
) {
  const normalizedClientOrderId = String(clientOrderId || '').trim();
  if (!normalizedClientOrderId) {
    throw markPreSubmitError(new Error('Alpaca client order ID is required for reconciliation.'));
  }

  const config = getAlpacaTradingConfig(env);
  assertAlpacaPaperConfig(config);

  try {
    const response = await httpClient.get(
      `${config.baseUrl}/v2/orders:by_client_order_id`,
      {
        ...getAlpacaRequestConfig(config),
        params: {
          client_order_id: normalizedClientOrderId
        }
      }
    );
    return response?.data || {};
  } catch (err) {
    err.clientOrderId = normalizedClientOrderId;
    throw err;
  }
}

async function refreshSubmittedOrderStatus({
  order,
  httpClient,
  env,
  attempts,
  delayMs,
  expectedQty = null,
  expectedNotional = null
}) {
  const orderId = String(order?.id || '').trim();
  const clientOrderId = String(order?.client_order_id || order?.clientOrderId || '').trim();
  if (!orderId || attempts <= 0) return order || {};

  let latest = order;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(delayMs);
    const candidate = await readAlpacaPaperOrder(orderId, { httpClient, env });
    const candidateOrderId = String(candidate?.id || '').trim();
    const candidateClientOrderId = String(
      candidate?.client_order_id || candidate?.clientOrderId || ''
    ).trim();
    if (
      !hasConclusiveBrokerOrder(
        candidate,
        clientOrderId,
        expectedQty,
        expectedNotional
      )
      || candidateOrderId !== orderId
      || (clientOrderId && candidateClientOrderId !== clientOrderId)
    ) {
      const err = createSubmitUnknownError(
        'Alpaca paper status polling returned an inconclusive or identity-mismatched order.',
        {
          clientOrderId,
          brokerOrder: candidate
        }
      );
      err.code = 'ALPACA_STATUS_POLL_IDENTITY_MISMATCH';
      err.submissionOutcome = SUBMISSION_STATES.UNKNOWN;
      err.submissionPhase = 'status_poll';
      throw err;
    }
    latest = candidate;
    if (!['pending_new', 'accepted', 'new'].includes(latest?.status)) {
      return latest;
    }
  }
  return latest || order || {};
}

async function submitAlpacaPaperOrder(
  orderInput,
  {
    httpClient = axios,
    env = process.env,
    pollStatusAttempts = 0,
    pollStatusDelayMs = 300
  } = {}
) {
  const clientOrderId = orderInput?.clientOrderId || null;
  let config;
  let payload;
  try {
    config = getAlpacaTradingConfig(env);
    assertAlpacaPaperConfig(config);
    const initialBinding = assertAlpacaPaperSubmissionBinding({ config, env });
    if (initialBinding.requiresAccountLookup) {
      const accountResponse = await httpClient.get(
        `${config.baseUrl}/v2/account`,
        getAlpacaRequestConfig(config)
      );
      assertAlpacaPaperSubmissionBinding({ config, env, account: accountResponse?.data || {} });
    }
    payload = buildAlpacaOrderPayload(orderInput);
  } catch (err) {
    throw markPreSubmitError(err, clientOrderId);
  }

  let submittedOrder;
  let brokerRequestId = null;
  try {
    const response = await httpClient.post(
      `${config.baseUrl}/v2/orders`,
      payload,
      getAlpacaRequestConfig(config)
    );
    submittedOrder = response?.data || {};
    brokerRequestId = extractBrokerRequestId(response?.headers || {});
  } catch (err) {
    err.brokerRequestId = extractBrokerRequestId(err.response?.headers || {});
    err.submissionAttempted = true;
    err.submissionPhase = 'submit';
    err.clientOrderId = payload.client_order_id;
    err.alpacaPayload = payload;
    const submissionOutcome = classifySubmissionError(err);
    const message = getBrokerErrorMessage(err, 'Unknown Alpaca order error');

    if (submissionOutcome === SUBMISSION_STATES.UNKNOWN) {
      const unknown = createSubmitUnknownError(
        `Alpaca paper order submission outcome is unknown: ${message}`,
        {
          clientOrderId: payload.client_order_id,
          payload,
          cause: err
        }
      );
      unknown.status = getSubmitErrorStatus(err);
      unknown.brokerRequestId = err.brokerRequestId || null;
      unknown.submissionPhase = 'submit';
      unknown.submissionError = {
        ...buildSubmissionErrorSnapshot(err),
        submissionPhase: 'submit'
      };
      throw unknown;
    }

    const wrapped = new Error(`Alpaca paper order rejected: ${message}`);
    wrapped.code = 'ALPACA_PAPER_ORDER_REJECTED';
    wrapped.status = getSubmitErrorStatus(err);
    wrapped.statusCode = 400;
    wrapped.submissionAttempted = true;
    wrapped.submissionOutcome = SUBMISSION_STATES.REJECTED;
    wrapped.submissionPhase = 'submit';
    wrapped.clientOrderId = payload.client_order_id;
    wrapped.alpacaPayload = payload;
    wrapped.submissionError = {
      ...buildSubmissionErrorSnapshot(err),
      submissionPhase: 'submit'
    };
    wrapped.cause = err;
    throw wrapped;
  }

  if (
    !hasConclusiveBrokerOrder(
      submittedOrder,
      payload.client_order_id,
      payload.qty,
      payload.notional
    )
    || !String(submittedOrder?.id || '').trim()
    || String(
      submittedOrder?.client_order_id || submittedOrder?.clientOrderId || ''
    ).trim() !== payload.client_order_id
  ) {
    const unknown = createSubmitUnknownError(
      'Alpaca paper order returned an inconclusive acknowledgement.',
      {
        clientOrderId: payload.client_order_id,
        payload,
        brokerOrder: submittedOrder
      }
    );
    unknown.submissionPhase = 'submit';
    unknown.brokerRequestId = brokerRequestId;
    unknown.submissionError = {
      submissionOutcome: SUBMISSION_STATES.UNKNOWN,
      submissionAttempted: true,
      submissionPhase: 'submit',
      status: null,
      code: 'INCONCLUSIVE_BROKER_ACKNOWLEDGEMENT',
      message: unknown.message,
      data: submittedOrder,
      clientOrderId: payload.client_order_id
    };
    throw unknown;
  }

  let order = submittedOrder;
  let pollError = null;
  try {
    order = await refreshSubmittedOrderStatus({
      order: submittedOrder,
      httpClient,
      env,
      attempts: pollStatusAttempts,
      delayMs: pollStatusDelayMs,
      expectedQty: payload.qty,
      expectedNotional: payload.notional
    });
  } catch (err) {
    err.submissionAttempted = true;
    err.submissionPhase = 'status_poll';
    err.clientOrderId = payload.client_order_id;
    pollError = {
      ...buildSubmissionErrorSnapshot(err),
      submissionPhase: 'status_poll',
      brokerAcknowledged: true
    };
    order = submittedOrder;
  }

  return {
    broker: 'alpaca',
    order,
    submittedOrder,
    payload,
    submissionOutcome: String(order?.status || '').toLowerCase() === 'rejected'
      ? SUBMISSION_STATES.REJECTED
      : SUBMISSION_STATES.SUBMITTED,
    statusRefreshPending: Boolean(pollError),
    pollError,
    brokerRequestId
  };
}

module.exports = {
  DEFAULT_ALPACA_PAPER_BASE_URL,
  MAX_ALPACA_CLIENT_ORDER_ID_LENGTH,
  assertAlpacaClientOrderId,
  buildAlpacaOrderPayload,
  buildClientOrderId,
  extractBrokerRequestId,
  getAlpacaTradingConfig,
  isPaperTradingEndpoint,
  normalizeAlpacaSymbol,
  readAlpacaPaperOrder,
  readAlpacaPaperOrderByClientOrderId,
  shouldSyncPaperTradesToAlpaca,
  submitAlpacaPaperOrder
};

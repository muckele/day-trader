const axios = require('axios');
const {
  DEFAULT_ALPACA_PAPER_BASE_URL,
  MAX_ALPACA_CLIENT_ORDER_ID_LENGTH,
  isPaperTradingEndpoint
} = require('../services/alpacaTradingClient');
const {
  SUBMISSION_STATES,
  createSubmitUnknownError,
  hasConclusiveBrokerOrder
} = require('../services/submissionOutcomeService');
const { buildRoboAlpacaOrderPayload } = require('./alpacaOrderBuilder');
const {
  assertAlpacaPaperSubmissionBinding,
  isReleaseEnvironment
} = require('../services/alpacaPaperBindingService');

const DEFAULT_ALPACA_LIVE_BASE_URL = 'https://api.alpaca.markets';
const LIVE_ORDER_REPLACEMENT_DISABLED = 'LIVE_ORDER_REPLACEMENT_DISABLED';

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function getAlpacaConfigForMode(mode = 'paper', env = process.env) {
  const normalizedMode = mode === 'live' ? 'live' : 'paper';
  if (normalizedMode === 'live') {
    return {
      mode: 'live',
      baseUrl: String(firstValue(
        env.APCA_LIVE_BASE_URL,
        env.ALPACA_LIVE_BASE_URL,
        DEFAULT_ALPACA_LIVE_BASE_URL
      )).replace(/\/v2\/?$/, '').replace(/\/$/, ''),
      apiKey: firstValue(env.APCA_LIVE_API_KEY_ID, env.ALPACA_LIVE_API_KEY) || '',
      apiSecret: firstValue(env.APCA_LIVE_API_SECRET_KEY, env.ALPACA_LIVE_API_SECRET) || ''
    };
  }

  const explicitApiKey = firstValue(env.APCA_PAPER_API_KEY_ID, env.ALPACA_PAPER_API_KEY) || '';
  const explicitApiSecret = firstValue(env.APCA_PAPER_API_SECRET_KEY, env.ALPACA_PAPER_API_SECRET) || '';
  const allowGenericLocalCredentials = !isReleaseEnvironment(env);
  return {
    mode: 'paper',
    baseUrl: String(firstValue(
      env.APCA_PAPER_BASE_URL,
      env.ALPACA_PAPER_BASE_URL,
      env.APCA_BASE_URL,
      env.ALPACA_BASE_URL,
      DEFAULT_ALPACA_PAPER_BASE_URL
    )).replace(/\/v2\/?$/, '').replace(/\/$/, ''),
    apiKey: explicitApiKey || (allowGenericLocalCredentials
      ? firstValue(env.BROKER_API_KEY, env.APCA_API_KEY_ID, env.ALPACA_API_KEY) || ''
      : ''),
    apiSecret: explicitApiSecret || (allowGenericLocalCredentials
      ? firstValue(env.BROKER_API_SECRET, env.APCA_API_SECRET_KEY, env.ALPACA_API_SECRET) || ''
      : ''),
    credentialSource: explicitApiKey && explicitApiSecret ? 'paper_explicit' : 'generic_local',
    expectedAccountId: firstValue(env.APCA_PAPER_ACCOUNT_ID, env.ALPACA_PAPER_ACCOUNT_ID) || null
  };
}

function isLocalTestEndpoint(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function assertConfig(config, { allowLocalPaperTestEndpoint = false } = {}) {
  if (!config.apiKey || !config.apiSecret) {
    const err = new Error(`Alpaca ${config.mode} credentials are not configured.`);
    err.code = 'ALPACA_NOT_CONFIGURED';
    throw err;
  }
  if (
    config.mode === 'paper'
    && !isPaperTradingEndpoint(config.baseUrl)
    && !(allowLocalPaperTestEndpoint && isLocalTestEndpoint(config.baseUrl))
  ) {
    const err = new Error('Paper mode must use the Alpaca paper endpoint.');
    err.code = 'ALPACA_PAPER_ENDPOINT_REQUIRED';
    throw err;
  }
  if (config.mode === 'live' && isPaperTradingEndpoint(config.baseUrl)) {
    const err = new Error('Live mode cannot use the Alpaca paper endpoint.');
    err.code = 'ALPACA_LIVE_ENDPOINT_REQUIRED';
    throw err;
  }
}

function buildHeaders(config) {
  return {
    'APCA-API-KEY-ID': config.apiKey,
    'APCA-API-SECRET-KEY': config.apiSecret
  };
}

function extractBrokerRequestId(headers = {}) {
  return headers['x-request-id']
    || headers['apca-request-id']
    || headers['request-id']
    || null;
}

function toPositiveOrderString(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    const err = new Error(`${fieldName} must be a positive number.`);
    err.status = 400;
    throw err;
  }
  return numeric.toString();
}

function assertOrderReplacementAllowed(mode = 'paper') {
  if (mode !== 'live') return;
  const err = new Error(
    'Live order replacement is disabled until amendments use a new immutable, re-authorized intent.'
  );
  err.status = 409;
  err.code = LIVE_ORDER_REPLACEMENT_DISABLED;
  throw err;
}

function sanitizeReplacementPayload(payload = {}) {
  const allowedTimeInForce = ['day', 'gtc', 'opg', 'cls', 'ioc', 'fok'];
  const replacement = {};
  const qty = toPositiveOrderString(payload.qty, 'qty');
  const limitPrice = toPositiveOrderString(payload.limit_price ?? payload.limitPrice, 'limit_price');
  const stopPrice = toPositiveOrderString(payload.stop_price ?? payload.stopPrice, 'stop_price');
  const trailPrice = toPositiveOrderString(payload.trail_price ?? payload.trailPrice, 'trail_price');
  const trailPercent = toPositiveOrderString(payload.trail_percent ?? payload.trailPercent, 'trail_percent');
  const timeInForce = payload.time_in_force ?? payload.timeInForce;
  const clientOrderId = payload.client_order_id ?? payload.clientOrderId;

  if (qty) replacement.qty = qty;
  if (limitPrice) replacement.limit_price = limitPrice;
  if (stopPrice) replacement.stop_price = stopPrice;
  if (trailPrice) replacement.trail_price = trailPrice;
  if (trailPercent) replacement.trail_percent = trailPercent;
  if (trailPrice && trailPercent) {
    const err = new Error('Use either trail_price or trail_percent, not both.');
    err.status = 400;
    throw err;
  }
  if (timeInForce !== undefined && timeInForce !== null && timeInForce !== '') {
    const normalizedTimeInForce = String(timeInForce).trim().toLowerCase();
    if (!allowedTimeInForce.includes(normalizedTimeInForce)) {
      const err = new Error('time_in_force must be day, gtc, opg, cls, ioc, or fok.');
      err.status = 400;
      throw err;
    }
    replacement.time_in_force = normalizedTimeInForce;
  }
  if (clientOrderId !== undefined && clientOrderId !== null && clientOrderId !== '') {
    const normalizedClientOrderId = String(clientOrderId).trim();
    if (
      typeof clientOrderId !== 'string'
      || normalizedClientOrderId !== clientOrderId
      || normalizedClientOrderId.length > MAX_ALPACA_CLIENT_ORDER_ID_LENGTH
    ) {
      const err = new Error(
        `client_order_id must be an exact string of 1 to ${MAX_ALPACA_CLIENT_ORDER_ID_LENGTH} characters.`
      );
      err.status = 400;
      throw err;
    }
    replacement.client_order_id = normalizedClientOrderId;
  }

  if (!Object.keys(replacement).length) {
    const err = new Error('Replacement requires at least one supported field.');
    err.status = 400;
    throw err;
  }

  return replacement;
}

function sanitizePositionClosePayload(payload = {}) {
  const close = {};
  const qty = toPositiveOrderString(payload.qty, 'qty');
  const percentage = toPositiveOrderString(payload.percentage, 'percentage');
  if (qty && percentage) {
    const err = new Error('Use either qty or percentage when closing a position, not both.');
    err.status = 400;
    throw err;
  }
  if (percentage && Number(percentage) > 100) {
    const err = new Error('percentage must be no greater than 100.');
    err.status = 400;
    throw err;
  }
  if (qty) close.qty = qty;
  if (percentage) close.percentage = percentage;
  return close;
}

function createAlpacaBroker({
  mode = 'paper',
  httpClient = axios,
  env = process.env,
  allowLocalPaperTestEndpoint = false,
  requestTimeoutMs = 20000
} = {}) {
  const config = getAlpacaConfigForMode(mode, env);
  let lastBrokerRequestId = null;
  const request = async (method, path, data, options = {}) => {
    assertConfig(config, { allowLocalPaperTestEndpoint });
    if (typeof options.onRequestAttempt === 'function') options.onRequestAttempt();
    let response;
    try {
      response = await httpClient({
        method,
        url: `${config.baseUrl}${path}`,
        data,
        params: options.params,
        headers: buildHeaders(config),
        timeout: options.timeout || requestTimeoutMs
      });
    } catch (err) {
      err.brokerRequestId = extractBrokerRequestId(err.response?.headers || {});
      throw err;
    }
    lastBrokerRequestId = extractBrokerRequestId(response?.headers || {});
    return response?.data || {};
  };

  return {
    mode: config.mode,
    baseUrl: config.baseUrl,
    isConfigured: Boolean(config.apiKey && config.apiSecret),
    getAccount: () => request('get', '/v2/account'),
    getClock: () => request('get', '/v2/clock'),
    getAsset: symbol => request('get', `/v2/assets/${encodeURIComponent(symbol)}`),
    getPositions: () => request('get', '/v2/positions'),
    listOrders: (params = {}) => request('get', '/v2/orders', null, { params }),
    getOrder: orderId => request('get', `/v2/orders/${orderId}`),
    getOrderByClientOrderId: clientOrderId => request('get', '/v2/orders:by_client_order_id', null, {
      params: { client_order_id: clientOrderId }
    }),
    cancelOrder: orderId => request('delete', `/v2/orders/${orderId}`),
    cancelAllOrders: () => request('delete', '/v2/orders'),
    replaceOrder: async (orderId, payload) => {
      assertOrderReplacementAllowed(config.mode);
      return request('patch', `/v2/orders/${orderId}`, sanitizeReplacementPayload(payload));
    },
    closePosition: (symbol, payload = {}) => request(
      'delete',
      `/v2/positions/${encodeURIComponent(symbol)}`,
      null,
      { params: sanitizePositionClosePayload(payload) }
    ),
    submitOrder: async input => {
      let built;
      try {
        built = buildRoboAlpacaOrderPayload(input);
      } catch (err) {
        err.submissionAttempted = false;
        err.submissionOutcome = SUBMISSION_STATES.NOT_ATTEMPTED;
        throw err;
      }
      let order = null;
      let submissionAttempted = false;
      try {
        const initialBinding = assertAlpacaPaperSubmissionBinding({
          config,
          env,
          allowLocalPaperTestEndpoint,
          isLocalTestEndpoint
        });
        let binding = initialBinding;
        if (initialBinding.requiresAccountLookup) {
          const account = await request('get', '/v2/account');
          binding = assertAlpacaPaperSubmissionBinding({
            config,
            env,
            account,
            allowLocalPaperTestEndpoint,
            isLocalTestEndpoint
          });
        }
        order = await request('post', '/v2/orders', built.payload, {
          onRequestAttempt: () => {
            submissionAttempted = true;
          }
        });
      } catch (err) {
        err.alpacaPayload = built.payload;
        err.clientOrderId = built.payload.client_order_id;
        err.submissionAttempted = submissionAttempted;
        if (!submissionAttempted) {
          err.submissionOutcome = SUBMISSION_STATES.NOT_ATTEMPTED;
        }
        throw err;
      }
      if (!hasConclusiveBrokerOrder(
        order,
        built.payload.client_order_id,
        built.payload.qty,
        built.payload.notional
      )) {
        const unknown = createSubmitUnknownError(
          'Alpaca returned an inconclusive order acknowledgement.',
          {
            clientOrderId: built.payload.client_order_id,
            payload: built.payload,
            brokerOrder: order
          }
        );
        unknown.brokerRequestId = lastBrokerRequestId;
        throw unknown;
      }
      return {
        order,
        payload: built.payload,
        normalized: built.normalized,
        brokerRequestId: lastBrokerRequestId,
        paperBinding: {
          environment: 'paper',
          endpoint: config.baseUrl,
          brokerAccountId: config.expectedAccountId || null
        }
      };
    }
  };
}

module.exports = {
  DEFAULT_ALPACA_LIVE_BASE_URL,
  LIVE_ORDER_REPLACEMENT_DISABLED,
  assertConfig,
  assertOrderReplacementAllowed,
  createAlpacaBroker,
  extractBrokerRequestId,
  getAlpacaConfigForMode,
  isLocalTestEndpoint,
  sanitizePositionClosePayload,
  sanitizeReplacementPayload
};

const axios = require('axios');
const {
  DEFAULT_ALPACA_PAPER_BASE_URL,
  isPaperTradingEndpoint
} = require('../services/alpacaTradingClient');
const { buildRoboAlpacaOrderPayload } = require('./alpacaOrderBuilder');

const DEFAULT_ALPACA_LIVE_BASE_URL = 'https://api.alpaca.markets';

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
        env.ALPACA_BASE_URL,
        env.APCA_BASE_URL,
        DEFAULT_ALPACA_LIVE_BASE_URL
      )).replace(/\/v2\/?$/, '').replace(/\/$/, ''),
      apiKey: firstValue(env.APCA_LIVE_API_KEY_ID, env.ALPACA_LIVE_API_KEY, env.ALPACA_API_KEY) || '',
      apiSecret: firstValue(env.APCA_LIVE_API_SECRET_KEY, env.ALPACA_LIVE_API_SECRET, env.ALPACA_API_SECRET) || ''
    };
  }

  return {
    mode: 'paper',
    baseUrl: String(firstValue(
      env.APCA_PAPER_BASE_URL,
      env.ALPACA_PAPER_BASE_URL,
      env.APCA_BASE_URL,
      env.ALPACA_BASE_URL,
      DEFAULT_ALPACA_PAPER_BASE_URL
    )).replace(/\/v2\/?$/, '').replace(/\/$/, ''),
    apiKey: firstValue(
      env.APCA_PAPER_API_KEY_ID,
      env.ALPACA_PAPER_API_KEY,
      env.BROKER_API_KEY,
      env.APCA_API_KEY_ID,
      env.ALPACA_API_KEY
    ) || '',
    apiSecret: firstValue(
      env.APCA_PAPER_API_SECRET_KEY,
      env.ALPACA_PAPER_API_SECRET,
      env.BROKER_API_SECRET,
      env.APCA_API_SECRET_KEY,
      env.ALPACA_API_SECRET
    ) || ''
  };
}

function assertConfig(config) {
  if (!config.apiKey || !config.apiSecret) {
    const err = new Error(`Alpaca ${config.mode} credentials are not configured.`);
    err.code = 'ALPACA_NOT_CONFIGURED';
    throw err;
  }
  if (config.mode === 'paper' && !isPaperTradingEndpoint(config.baseUrl)) {
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
    if (!normalizedClientOrderId || normalizedClientOrderId.length > 128) {
      const err = new Error('client_order_id must be 1 to 128 characters.');
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

function createAlpacaBroker({ mode = 'paper', httpClient = axios, env = process.env } = {}) {
  const config = getAlpacaConfigForMode(mode, env);
  const request = async (method, path, data, options = {}) => {
    assertConfig(config);
    const response = await httpClient({
      method,
      url: `${config.baseUrl}${path}`,
      data,
      params: options.params,
      headers: buildHeaders(config),
      timeout: options.timeout || 20000
    });
    return response?.data || {};
  };

  return {
    mode: config.mode,
    baseUrl: config.baseUrl,
    isConfigured: Boolean(config.apiKey && config.apiSecret),
    getAccount: () => request('get', '/v2/account'),
    getClock: () => request('get', '/v2/clock'),
    getPositions: () => request('get', '/v2/positions'),
    listOrders: (params = {}) => request('get', '/v2/orders', null, { params }),
    getOrder: orderId => request('get', `/v2/orders/${orderId}`),
    cancelOrder: orderId => request('delete', `/v2/orders/${orderId}`),
    cancelAllOrders: () => request('delete', '/v2/orders'),
    replaceOrder: (orderId, payload) => request('patch', `/v2/orders/${orderId}`, sanitizeReplacementPayload(payload)),
    closePosition: (symbol, payload = {}) => request('delete', `/v2/positions/${encodeURIComponent(symbol)}`, payload),
    submitOrder: async input => {
      const built = buildRoboAlpacaOrderPayload(input);
      const order = await request('post', '/v2/orders', built.payload);
      return {
        order,
        payload: built.payload,
        normalized: built.normalized
      };
    }
  };
}

module.exports = {
  DEFAULT_ALPACA_LIVE_BASE_URL,
  createAlpacaBroker,
  getAlpacaConfigForMode,
  sanitizeReplacementPayload
};

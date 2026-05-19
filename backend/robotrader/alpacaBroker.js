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
    replaceOrder: (orderId, payload) => request('patch', `/v2/orders/${orderId}`, payload),
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
  getAlpacaConfigForMode
};

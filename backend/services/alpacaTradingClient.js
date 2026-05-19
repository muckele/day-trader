const axios = require('axios');

const DEFAULT_ALPACA_PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
const EQUITY_ORDER_TYPES = ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'];
const EQUITY_TIME_IN_FORCE = ['day', 'gtc', 'opg', 'cls', 'ioc', 'fok'];
const CRYPTO_ORDER_TYPES = ['market', 'limit', 'stop_limit'];
const CRYPTO_TIME_IN_FORCE = ['gtc', 'ioc'];

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function getAlpacaTradingConfig(env = process.env) {
  const rawBaseUrl = String(
    env.ALPACA_BASE_URL
    || env.APCA_BASE_URL
    || DEFAULT_ALPACA_PAPER_BASE_URL
  ).replace(/\/$/, '');
  return {
    baseUrl: rawBaseUrl.replace(/\/v2\/?$/, ''),
    apiKey: env.BROKER_API_KEY || env.APCA_API_KEY_ID || env.ALPACA_API_KEY || '',
    apiSecret:
      env.BROKER_API_SECRET
      || env.APCA_API_SECRET_KEY
      || env.ALPACA_API_SECRET
      || ''
  };
}

function isPaperTradingEndpoint(baseUrl) {
  return String(baseUrl || '').toLowerCase().includes('paper-api.alpaca.markets');
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

function buildClientOrderId({ origin = 'manual', symbol = 'ORDER', now = new Date() } = {}) {
  const safeOrigin = String(origin || 'manual').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'manual';
  const safeSymbol = String(symbol || 'ORDER').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 16) || 'ORDER';
  const timestamp = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 10);
  return `daytrader-${safeOrigin}-${safeSymbol}-${timestamp}-${suffix}`.slice(0, 128);
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
    client_order_id: clientOrderId
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
    throw new Error('Alpaca paper sync requires APCA_BASE_URL/ALPACA_BASE_URL to use https://paper-api.alpaca.markets.');
  }
}

async function readAlpacaPaperOrder(orderId, { httpClient = axios, env = process.env } = {}) {
  const config = getAlpacaTradingConfig(env);
  assertAlpacaPaperConfig(config);

  const response = await httpClient.get(
    `${config.baseUrl}/v2/orders/${orderId}`,
    {
      headers: {
        'APCA-API-KEY-ID': config.apiKey,
        'APCA-API-SECRET-KEY': config.apiSecret
      },
      timeout: 20000
    }
  );
  return response?.data || {};
}

async function refreshSubmittedOrderStatus({
  order,
  httpClient,
  env,
  attempts,
  delayMs
}) {
  const orderId = order?.id;
  if (!orderId || attempts <= 0) return order || {};

  let latest = order;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(delayMs);
    latest = await readAlpacaPaperOrder(orderId, { httpClient, env });
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
  const config = getAlpacaTradingConfig(env);
  assertAlpacaPaperConfig(config);

  const payload = buildAlpacaOrderPayload(orderInput);
  try {
    const response = await httpClient.post(
      `${config.baseUrl}/v2/orders`,
      payload,
      {
        headers: {
          'APCA-API-KEY-ID': config.apiKey,
          'APCA-API-SECRET-KEY': config.apiSecret
        },
        timeout: 20000
      }
    );
    const submittedOrder = response?.data || {};
    const order = await refreshSubmittedOrderStatus({
      order: submittedOrder,
      httpClient,
      env,
      attempts: pollStatusAttempts,
      delayMs: pollStatusDelayMs
    });

    return {
      broker: 'alpaca',
      order,
      payload
    };
  } catch (err) {
    const message = err?.response?.data?.message || err?.message || 'Unknown Alpaca order error';
    const wrapped = new Error(`Alpaca paper order failed: ${message}`);
    wrapped.code = err?.code || 'ALPACA_PAPER_ORDER_FAILED';
    wrapped.status = err?.response?.status || null;
    throw wrapped;
  }
}

module.exports = {
  DEFAULT_ALPACA_PAPER_BASE_URL,
  buildAlpacaOrderPayload,
  buildClientOrderId,
  getAlpacaTradingConfig,
  isPaperTradingEndpoint,
  normalizeAlpacaSymbol,
  readAlpacaPaperOrder,
  shouldSyncPaperTradesToAlpaca,
  submitAlpacaPaperOrder
};

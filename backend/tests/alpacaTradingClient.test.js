const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAlpacaOrderPayload,
  getAlpacaTradingConfig,
  isPaperTradingEndpoint,
  normalizeAlpacaSymbol,
  shouldSyncPaperTradesToAlpaca,
  submitAlpacaPaperOrder
} = require('../services/alpacaTradingClient');

test('buildAlpacaOrderPayload creates an equity market order without invalid extended-hours flag', () => {
  const payload = buildAlpacaOrderPayload({
    symbol: 'aapl',
    assetClass: 'equity',
    side: 'buy',
    qty: 1,
    orderType: 'market',
    timeInForce: 'day',
    allowExtendedHours: true,
    clientOrderId: 'client-1'
  });

  assert.deepEqual(payload, {
    symbol: 'AAPL',
    qty: '1',
    side: 'buy',
    type: 'market',
    time_in_force: 'day',
    client_order_id: 'client-1'
  });
});

test('buildAlpacaOrderPayload allows extended-hours only for equity limit day/gtc orders', () => {
  const payload = buildAlpacaOrderPayload({
    symbol: 'MSFT',
    assetClass: 'equity',
    side: 'buy',
    qty: 2,
    orderType: 'limit',
    timeInForce: 'gtc',
    limitPrice: 400,
    allowExtendedHours: true,
    clientOrderId: 'client-2'
  });

  assert.equal(payload.extended_hours, true);
  assert.equal(payload.limit_price, '400');
});

test('buildAlpacaOrderPayload formats crypto symbols and requires crypto-compatible TIF', () => {
  assert.equal(normalizeAlpacaSymbol('btcusd', 'crypto'), 'BTC/USD');

  const payload = buildAlpacaOrderPayload({
    symbol: 'BTCUSD',
    assetClass: 'crypto',
    side: 'buy',
    qty: 0.001,
    orderType: 'market',
    timeInForce: 'gtc',
    clientOrderId: 'client-3'
  });

  assert.equal(payload.symbol, 'BTC/USD');
  assert.equal(payload.time_in_force, 'gtc');
  assert.throws(
    () => buildAlpacaOrderPayload({
      symbol: 'BTCUSD',
      assetClass: 'crypto',
      side: 'buy',
      qty: 0.001,
      orderType: 'market',
      timeInForce: 'day',
      clientOrderId: 'client-4'
    }),
    /gtc or ioc/
  );
});

test('submitAlpacaPaperOrder posts to the paper endpoint and rejects live endpoints', async () => {
  const calls = [];
  const httpClient = {
    post: async (...args) => {
      calls.push(args);
      return {
        data: {
          id: 'alpaca-order-1',
          status: 'accepted',
          client_order_id: 'client-5'
        }
      };
    }
  };

  const result = await submitAlpacaPaperOrder(
    {
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'buy',
      qty: 1,
      orderType: 'market',
      timeInForce: 'day',
      clientOrderId: 'client-5'
    },
    {
      httpClient,
      env: {
        APCA_BASE_URL: 'https://paper-api.alpaca.markets',
        APCA_API_KEY_ID: 'key',
        APCA_API_SECRET_KEY: 'secret'
      }
    }
  );

  assert.equal(result.order.id, 'alpaca-order-1');
  assert.equal(calls[0][0], 'https://paper-api.alpaca.markets/v2/orders');
  assert.equal(calls[0][1].client_order_id, 'client-5');

  await assert.rejects(
    () => submitAlpacaPaperOrder(
      {
        symbol: 'AAPL',
        assetClass: 'equity',
        side: 'buy',
        qty: 1,
        orderType: 'market',
        timeInForce: 'day',
        clientOrderId: 'client-6'
      },
      {
        httpClient,
        env: {
          APCA_BASE_URL: 'https://api.alpaca.markets',
          APCA_API_KEY_ID: 'key',
          APCA_API_SECRET_KEY: 'secret'
        }
      }
    ),
    /paper sync requires/
  );
});

test('submitAlpacaPaperOrder can refresh broker status after submit', async () => {
  const calls = [];
  const httpClient = {
    post: async (...args) => {
      calls.push({ method: 'post', args });
      return {
        data: {
          id: 'alpaca-order-2',
          status: 'pending_new',
          client_order_id: 'client-7'
        }
      };
    },
    get: async (...args) => {
      calls.push({ method: 'get', args });
      return {
        data: {
          id: 'alpaca-order-2',
          status: 'filled',
          filled_qty: '1',
          client_order_id: 'client-7'
        }
      };
    }
  };

  const result = await submitAlpacaPaperOrder(
    {
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'buy',
      qty: 1,
      orderType: 'market',
      timeInForce: 'day',
      clientOrderId: 'client-7'
    },
    {
      httpClient,
      env: {
        APCA_BASE_URL: 'https://paper-api.alpaca.markets',
        APCA_API_KEY_ID: 'key',
        APCA_API_SECRET_KEY: 'secret'
      },
      pollStatusAttempts: 1,
      pollStatusDelayMs: 0
    }
  );

  assert.equal(result.order.status, 'filled');
  assert.equal(calls.filter(call => call.method === 'get').length, 1);
});

test('shouldSyncPaperTradesToAlpaca parses explicit enable flag', () => {
  assert.equal(shouldSyncPaperTradesToAlpaca({ APP_PAPER_TRADES_SYNC_TO_ALPACA: 'true' }), true);
  assert.equal(shouldSyncPaperTradesToAlpaca({ APP_PAPER_TRADES_SYNC_TO_ALPACA: 'false' }), false);
  assert.equal(isPaperTradingEndpoint('https://paper-api.alpaca.markets'), true);
});

test('getAlpacaTradingConfig normalizes APCA_BASE_URL with or without /v2', () => {
  assert.equal(
    getAlpacaTradingConfig({ APCA_BASE_URL: 'https://paper-api.alpaca.markets/v2' }).baseUrl,
    'https://paper-api.alpaca.markets'
  );
});

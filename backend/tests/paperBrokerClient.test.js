const test = require('node:test');
const assert = require('node:assert/strict');
const PaperTrade = require('../models/PaperTrade');
const PaperAccountLock = require('../models/PaperAccountLock');
const {
  acquirePaperAccountLock,
  normalizeOrderInput,
  enforceMarketHours,
  enforcePriceControls,
  getAlpacaFillPrice,
  getAlpacaFilledQty,
  mapAlpacaPaperOrderStatus,
  reconcileAlpacaPaperOrder,
  shouldSubmitAlpacaAttachedExits
} = require('../paper/paperBrokerClient');

test('normalizeOrderInput accepts fractional quantity and limit settings', () => {
  const normalized = normalizeOrderInput({
    symbol: 'aapl',
    side: 'buy',
    qty: '0.25',
    orderType: 'limit',
    limitPrice: '190.5',
    maxPricePerShare: '191.2',
    allowExtendedHours: true
  });

  assert.equal(normalized.normalizedSymbol, 'AAPL');
  assert.equal(normalized.normalizedSide, 'buy');
  assert.equal(normalized.numericQty, 0.25);
  assert.equal(normalized.normalizedOrderType, 'limit');
  assert.equal(normalized.parsedLimitPrice, 190.5);
  assert.equal(normalized.parsedMaxPricePerShare, 191.2);
  assert.equal(normalized.allowExtendedHours, true);
});

test('normalizeOrderInput accepts crypto settings with higher precision', () => {
  const normalized = normalizeOrderInput({
    symbol: 'btc/usd',
    side: 'buy',
    qty: '0.12345678',
    assetClass: 'crypto',
    orderType: 'trailing_stop',
    trailingStopPct: '1.5',
    timeInForce: 'gtc'
  });

  assert.equal(normalized.normalizedSymbol, 'BTCUSD');
  assert.equal(normalized.normalizedAssetClass, 'crypto');
  assert.equal(normalized.numericQty, 0.12345678);
  assert.equal(normalized.normalizedOrderType, 'trailing_stop');
  assert.equal(normalized.parsedTrailingStopPct, 1.5);
  assert.equal(normalized.normalizedTimeInForce, 'gtc');
});

test('normalizeOrderInput maps default crypto day TIF to Alpaca-compatible gtc', () => {
  const normalized = normalizeOrderInput({
    symbol: 'ETHUSD',
    side: 'buy',
    qty: '0.05',
    assetClass: 'crypto'
  });

  assert.equal(normalized.normalizedAssetClass, 'crypto');
  assert.equal(normalized.normalizedTimeInForce, 'gtc');
});

test('normalizeOrderInput rejects crypto GTD orders', () => {
  assert.throws(
    () => normalizeOrderInput({
      symbol: 'BTCUSD',
      side: 'buy',
      qty: '0.01',
      assetClass: 'crypto',
      timeInForce: 'gtd',
      goodTilDate: '2099-01-01T00:00:00.000Z'
    }),
    /Crypto timeInForce must be gtc or ioc/
  );
});

test('normalizeOrderInput rejects quantities with too many decimals', () => {
  assert.throws(
    () => normalizeOrderInput({ symbol: 'AAPL', side: 'buy', qty: 0.1234567 }),
    /supports up to 6 decimal places/
  );
});

test('normalizeOrderInput validates stop-limit requirements', () => {
  assert.throws(
    () => normalizeOrderInput({
      symbol: 'AAPL',
      side: 'buy',
      qty: 1,
      orderType: 'stop_limit',
      limitPrice: 100
    }),
    /stopPrice must be a positive number for stop-limit orders/
  );
});

test('enforceMarketHours blocks orders when market closed and extended disabled', () => {
  assert.throws(
    () => enforceMarketHours({
      allowExtendedHours: false,
      marketStatusProvider: () => ({ status: 'CLOSED' })
    }),
    /Market is closed/
  );
});

test('enforceMarketHours allows extended session when market closed', () => {
  const result = enforceMarketHours({
    allowExtendedHours: true,
    marketStatusProvider: () => ({ status: 'CLOSED' })
  });

  assert.equal(result.extendedHours, true);
  assert.equal(result.marketSession, 'extended');
});

test('enforceMarketHours treats crypto as always open', () => {
  const result = enforceMarketHours({
    allowExtendedHours: false,
    assetClass: 'crypto',
    marketStatusProvider: () => ({ status: 'CLOSED' })
  });

  assert.equal(result.marketStatus, 'OPEN');
  assert.equal(result.marketSession, 'crypto');
});

test('enforcePriceControls applies limit and max price constraints for buys', () => {
  assert.throws(
    () => enforcePriceControls({
      side: 'buy',
      fillPrice: 101,
      orderType: 'limit',
      limitPrice: 100
    }),
    /Limit price too low/
  );

  assert.throws(
    () => enforcePriceControls({
      side: 'buy',
      fillPrice: 101,
      orderType: 'market',
      maxPricePerShare: 100
    }),
    /exceeds max price per share/
  );
});

test('Alpaca paper order status helpers preserve open broker states', () => {
  assert.equal(mapAlpacaPaperOrderStatus({ status: 'accepted' }), 'open');
  assert.equal(mapAlpacaPaperOrderStatus({ status: 'new' }), 'open');
  assert.equal(mapAlpacaPaperOrderStatus({ status: 'filled' }), 'filled');
  assert.equal(mapAlpacaPaperOrderStatus({ status: 'canceled' }), 'cancelled');
  assert.equal(mapAlpacaPaperOrderStatus({ status: 'rejected' }), 'rejected');
  assert.equal(getAlpacaFilledQty({ filled_qty: '0.5' }, 1), 0.5);
  assert.equal(getAlpacaFillPrice({ filled_avg_price: '123.45' }, 100), 123.45);
});

test('fractional equity entries do not submit unsupported Alpaca attached exits', () => {
  assert.equal(shouldSubmitAlpacaAttachedExits({
    assetClass: 'equity',
    qty: 0.5,
    takeProfitPrice: 110,
    stopLossPrice: 95
  }), false);

  assert.equal(shouldSubmitAlpacaAttachedExits({
    assetClass: 'equity',
    qty: 2,
    takeProfitPrice: 110,
    stopLossPrice: 95
  }), true);

  assert.equal(shouldSubmitAlpacaAttachedExits({
    assetClass: 'equity',
    qty: 0.5,
    takeProfitPrice: null,
    stopLossPrice: null
  }), true);
});

test('reconcileAlpacaPaperOrder keeps accepted broker orders open locally', async () => {
  const saved = [];
  const order = {
    _id: 'paper-order-1',
    externalOrderId: 'alpaca-order-1',
    clientOrderId: 'client-1',
    status: 'open',
    save: async function save() {
      saved.push({ status: this.status, brokerOrderStatus: this.brokerOrderStatus });
      return this;
    }
  };

  const result = await reconcileAlpacaPaperOrder(order, {
    readOrder: async () => ({
      id: 'alpaca-order-1',
      client_order_id: 'client-1',
      status: 'accepted',
      filled_qty: '0'
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'open');
  assert.equal(result.trade, null);
  assert.equal(order.status, 'open');
  assert.equal(order.brokerOrderStatus, 'accepted');
  assert.equal(saved.length, 1);
});

test('PaperTrade enforces one persisted trade per paper order', () => {
  const hasUniqueOrderIndex = PaperTrade.schema.indexes().some(([fields, options]) => (
    fields.orderId === 1
    && options.unique === true
    && options.partialFilterExpression?.orderId?.$type === 'objectId'
  ));

  assert.equal(hasUniqueOrderIndex, true);
});

test('paper account lock fails closed on a concurrent account order', async t => {
  const duplicate = new Error('duplicate account lock');
  duplicate.code = 11000;
  t.mock.method(PaperAccountLock, 'findOneAndUpdate', async () => {
    throw duplicate;
  });
  const lock = await acquirePaperAccountLock('user:alice', 'owner-2');
  assert.equal(lock, null);
});

test('reconcileAlpacaPaperOrder creates a local trade for partial fills', async () => {
  const saved = [];
  const createdTrades = [];
  const order = {
    _id: 'paper-order-partial',
    externalOrderId: 'alpaca-order-partial',
    clientOrderId: 'client-partial',
    status: 'open',
    save: async function save() {
      saved.push({
        status: this.status,
        brokerOrderStatus: this.brokerOrderStatus,
        fillPrice: this.fillPrice,
        notional: this.notional
      });
      return this;
    }
  };

  const result = await reconcileAlpacaPaperOrder(order, {
    readOrder: async () => ({
      id: 'alpaca-order-partial',
      client_order_id: 'client-partial',
      status: 'partially_filled',
      filled_qty: '0.5',
      filled_avg_price: '123.45'
    }),
    createTradeFromOrder: async (syncedOrder, brokerOrder) => {
      createdTrades.push({ syncedOrder, brokerOrder });
      return { _id: 'paper-trade-partial', qty: 0.5 };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'open');
  assert.equal(result.trade._id, 'paper-trade-partial');
  assert.equal(createdTrades.length, 1);
  assert.equal(order.status, 'open');
  assert.equal(order.brokerOrderStatus, 'partially_filled');
  assert.equal(order.fillPrice, 123.45);
  assert.equal(order.notional, 61.73);
  assert.equal(saved.length, 1);
});

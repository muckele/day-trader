const test = require('node:test');
const assert = require('node:assert/strict');
const PaperOrder = require('../models/PaperOrder');
const PaperTrade = require('../models/PaperTrade');
const PaperAccountLock = require('../models/PaperAccountLock');
const RoboTradeOrder = require('../models/RoboTradeOrder');
const OrderIntent = require('../models/OrderIntent');
const {
  acquirePaperAccountLock,
  buildPaperOrderIdempotencyFingerprint,
  normalizeOrderInput,
  enforceMarketHours,
  enforcePriceControls,
  getAlpacaFillPrice,
  getAlpacaFilledQty,
  isUnresolvedAlpacaPaperOrder,
  markPaperOrderReconciliationRequired,
  mapAlpacaPaperOrderStatus,
  placeOrder,
  preserveCorrelatedPaperBrokerExternalOrderId,
  recordRejectedOrder,
  reconcileAlpacaPaperOrder,
  reconcileOpenAlpacaPaperOrders,
  shouldSubmitAlpacaAttachedExits
} = require('../paper/paperBrokerClient');
const {
  SUBMISSION_STATES,
  SUBMIT_UNKNOWN,
  createSubmitUnknownError
} = require('../services/submissionOutcomeService');

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
  assert.equal(getAlpacaFilledQty({ filledQty: '999' }, 0), 0);
  assert.equal(getAlpacaFillPrice({ filledAvgPrice: '999' }, null), null);
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
    qty: 1,
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

test('PaperOrder stores additive submission state and attempt evidence', () => {
  const submissionState = PaperOrder.schema.path('submissionState');
  assert.deepEqual(
    [...submissionState.enumValues].sort(),
    Object.values(SUBMISSION_STATES).sort()
  );
  assert.equal(submissionState.defaultValue, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.ok(PaperOrder.schema.path('submissionAttemptCount'));
  assert.ok(PaperOrder.schema.path('submissionLastAttemptAt'));
  assert.ok(PaperOrder.schema.path('submissionLastError'));
  assert.ok(PaperOrder.schema.path('submissionLastReconciledAt'));
  assert.ok(PaperOrder.schema.path('idempotencyKey'));
  assert.ok(PaperOrder.schema.path('idempotencyFingerprint'));
  assert.equal(
    PaperOrder.schema.indexes().some(([fields, options]) => (
      fields.accountId === 1
      && fields.broker === 1
      && fields.idempotencyKey === 1
      && options.unique === true
      && options.partialFilterExpression?.idempotencyKey?.$type === 'string'
    )),
    true
  );
  assert.equal(
    PaperOrder.schema.indexes().some(([fields, options]) => (
      fields.broker === 1
      && fields.clientOrderId === 1
      && options.unique === true
      && options.partialFilterExpression?.broker === 'alpaca'
    )),
    true
  );
});

test('pending and unknown Alpaca paper orders are unresolved account latches', () => {
  assert.equal(isUnresolvedAlpacaPaperOrder({
    broker: 'alpaca',
    status: 'open',
    submissionState: SUBMISSION_STATES.PENDING
  }), true);
  assert.equal(isUnresolvedAlpacaPaperOrder({
    broker: 'alpaca',
    status: 'open',
    submissionState: SUBMISSION_STATES.UNKNOWN
  }), true);
  assert.equal(isUnresolvedAlpacaPaperOrder({
    broker: 'alpaca',
    status: 'open',
    brokerOrderStatus: 'pending_submit'
  }), true);
  assert.equal(isUnresolvedAlpacaPaperOrder({
    broker: 'alpaca',
    status: 'open',
    submissionState: SUBMISSION_STATES.SUBMITTED,
    brokerOrderStatus: 'accepted'
  }), false);
});

test('a durable unresolved order freezes a later synced submission before order creation', async t => {
  const previousSync = process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
  process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = 'true';
  t.after(() => {
    if (previousSync === undefined) {
      delete process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
    } else {
      process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = previousSync;
    }
  });

  const blockingOrder = {
    _id: 'paper-order-unknown',
    accountId: 'user:freeze',
    broker: 'alpaca',
    status: 'open',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    brokerOrderStatus: 'submit_unknown',
    clientOrderId: 'client-original'
  };
  let creates = 0;
  let lockReleased = 0;
  t.mock.method(PaperAccountLock, 'findOneAndUpdate', async () => ({ owner: 'owner' }));
  t.mock.method(PaperAccountLock, 'updateOne', async query => {
    if (!query.lockedUntil) lockReleased += 1;
    return { matchedCount: 1 };
  });
  t.mock.method(PaperOrder, 'findOne', query => ({
    sort: async () => (query.idempotencyKey ? null : blockingOrder)
  }));
  t.mock.method(PaperOrder, 'create', async () => {
    creates += 1;
  });

  await assert.rejects(
    () => placeOrder({
      accountId: 'user:freeze',
      idempotencyKey: 'freeze-request-1',
      symbol: 'MSFT',
      side: 'buy',
      qty: 1
    }),
    err => {
      assert.equal(err.code, SUBMIT_UNKNOWN);
      assert.equal(err.statusCode, 409);
      assert.equal(err.submissionAttempted, false);
      assert.equal(err.clientOrderId, 'client-original');
      assert.equal(err.paperOrder, blockingOrder);
      return true;
    }
  );
  assert.equal(creates, 0);
  assert.equal(lockReleased, 1);
});

test('a RoboTrader unknown freezes a manual Alpaca-paper submission under the shared account lock', async t => {
  const previousSync = process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
  process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = 'true';
  t.after(() => {
    if (previousSync === undefined) delete process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
    else process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = previousSync;
  });

  const blockingOrder = {
    _id: 'robo-order-unknown',
    accountId: 'user:shared-freeze',
    broker: 'alpaca',
    environment: 'paper',
    status: 'pending_submit',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    clientOrderId: 'robo-client-original'
  };
  let creates = 0;
  t.mock.method(PaperAccountLock, 'findOneAndUpdate', async () => ({ owner: 'paper-owner' }));
  t.mock.method(PaperAccountLock, 'updateOne', async () => ({ matchedCount: 1 }));
  t.mock.method(PaperOrder, 'findOne', () => ({
    sort: async () => null
  }));
  t.mock.method(RoboTradeOrder, 'findOne', async () => blockingOrder);
  t.mock.method(PaperOrder, 'create', async () => {
    creates += 1;
  });

  await assert.rejects(
    () => placeOrder({
      accountId: 'user:shared-freeze',
      idempotencyKey: 'shared-freeze-request',
      symbol: 'AAPL',
      side: 'buy',
      qty: 1
    }),
    err => {
      assert.equal(err.code, SUBMIT_UNKNOWN);
      assert.equal(err.submissionAttempted, false);
      assert.equal(err.paperOrder, blockingOrder);
      return true;
    }
  );
  assert.equal(creates, 0);
});

test('Alpaca-paper requires a request idempotency key before any durable attempt or broker work', async t => {
  const previousSync = process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
  process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = 'true';
  t.after(() => {
    if (previousSync === undefined) delete process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
    else process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = previousSync;
  });

  let locks = 0;
  let creates = 0;
  t.mock.method(PaperAccountLock, 'findOneAndUpdate', async () => {
    locks += 1;
    return { owner: 'unexpected' };
  });
  t.mock.method(PaperOrder, 'create', async () => {
    creates += 1;
  });

  await assert.rejects(
    () => placeOrder({
      accountId: 'user:idempotency-required',
      symbol: 'AAPL',
      side: 'buy',
      qty: 1
    }),
    err => {
      assert.equal(err.code, 'IDEMPOTENCY_KEY_REQUIRED');
      assert.equal(err.submissionOutcome, SUBMISSION_STATES.NOT_ATTEMPTED);
      assert.equal(err.submissionAttempted, false);
      return true;
    }
  );
  assert.equal(locks, 0);
  assert.equal(creates, 0);
});

test('same idempotency key returns the original terminal attempt without another submission identity', async t => {
  const previousSync = process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
  process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = 'true';
  t.after(() => {
    if (previousSync === undefined) delete process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
    else process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = previousSync;
  });

  const input = {
    accountId: 'user:idempotent-replay',
    idempotencyKey: 'request-accepted-1',
    symbol: 'AAPL',
    side: 'buy',
    qty: 1
  };
  const existingOrder = {
    _id: 'paper-order-existing',
    broker: 'alpaca',
    status: 'open',
    submissionState: SUBMISSION_STATES.SUBMITTED,
    clientOrderId: 'client-existing',
    idempotencyKey: input.idempotencyKey,
    idempotencyFingerprint: buildPaperOrderIdempotencyFingerprint(input)
  };
  let creates = 0;
  t.mock.method(PaperAccountLock, 'findOneAndUpdate', async () => ({ owner: 'paper-owner' }));
  t.mock.method(PaperAccountLock, 'updateOne', async () => ({ matchedCount: 1 }));
  t.mock.method(PaperOrder, 'findOne', () => ({
    sort: async () => existingOrder
  }));
  t.mock.method(PaperOrder, 'create', async () => {
    creates += 1;
  });

  const result = await placeOrder(input);
  assert.equal(result.idempotentReplay, true);
  assert.equal(result.order, existingOrder);
  assert.equal(creates, 0);
});

test('same idempotency key while unknown returns the original unknown attempt', async t => {
  const previousSync = process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
  process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = 'true';
  t.after(() => {
    if (previousSync === undefined) delete process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
    else process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = previousSync;
  });

  const input = {
    accountId: 'user:idempotent-unknown',
    idempotencyKey: 'request-unknown-1',
    symbol: 'MSFT',
    side: 'buy',
    qty: 2
  };
  const existingOrder = {
    _id: 'paper-order-existing-unknown',
    broker: 'alpaca',
    status: 'open',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    clientOrderId: 'client-existing-unknown',
    idempotencyKey: input.idempotencyKey,
    idempotencyFingerprint: buildPaperOrderIdempotencyFingerprint(input)
  };
  t.mock.method(PaperAccountLock, 'findOneAndUpdate', async () => ({ owner: 'paper-owner' }));
  t.mock.method(PaperAccountLock, 'updateOne', async () => ({ matchedCount: 1 }));
  t.mock.method(PaperOrder, 'findOne', () => ({
    sort: async () => existingOrder
  }));

  await assert.rejects(
    () => placeOrder(input),
    err => {
      assert.equal(err.code, SUBMIT_UNKNOWN);
      assert.equal(err.idempotentReplay, true);
      assert.equal(err.paperOrder, existingOrder);
      return true;
    }
  );
});

test('reusing an idempotency key for a different order is a not-attempted conflict', async t => {
  const previousSync = process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
  process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = 'true';
  t.after(() => {
    if (previousSync === undefined) delete process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
    else process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = previousSync;
  });

  const existingOrder = {
    _id: 'paper-order-key-conflict',
    broker: 'alpaca',
    status: 'filled',
    submissionState: SUBMISSION_STATES.SUBMITTED,
    clientOrderId: 'client-key-conflict',
    idempotencyKey: 'reused-key',
    idempotencyFingerprint: 'different-request-fingerprint'
  };
  let creates = 0;
  t.mock.method(PaperAccountLock, 'findOneAndUpdate', async () => ({ owner: 'paper-owner' }));
  t.mock.method(PaperAccountLock, 'updateOne', async () => ({ matchedCount: 1 }));
  t.mock.method(PaperOrder, 'findOne', () => ({
    sort: async () => existingOrder
  }));
  t.mock.method(PaperOrder, 'create', async () => {
    creates += 1;
  });

  await assert.rejects(
    () => placeOrder({
      accountId: 'user:key-conflict',
      idempotencyKey: 'reused-key',
      symbol: 'NVDA',
      side: 'sell',
      qty: 1
    }),
    err => {
      assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
      assert.equal(err.statusCode, 409);
      assert.equal(err.submissionOutcome, SUBMISSION_STATES.NOT_ATTEMPTED);
      assert.equal(err.submissionAttempted, false);
      assert.equal(err.paperOrder, existingOrder);
      return true;
    }
  );
  assert.equal(creates, 0);
});

test('not-attempted failures cannot create broker-rejected telemetry records', async t => {
  let creates = 0;
  t.mock.method(PaperOrder, 'create', async () => {
    creates += 1;
  });

  const result = await recordRejectedOrder({
    accountId: 'user:no-false-rejection',
    symbol: 'AAPL',
    side: 'buy',
    qty: 1,
    submissionOutcome: SUBMISSION_STATES.NOT_ATTEMPTED,
    submissionAttempted: false
  }, 'local preflight failed');

  assert.equal(result, null);
  assert.equal(creates, 0);
});

test('unknown submission reconciles by original client ID without submitting again', async () => {
  const calls = [];
  const saved = [];
  const order = {
    _id: 'paper-order-client-lookup',
    accountId: 'user:lookup',
    broker: 'alpaca',
    externalOrderId: null,
    clientOrderId: 'client-original',
    brokerOrderStatus: 'submit_unknown',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    status: 'open',
    save: async function save() {
      saved.push({
        externalOrderId: this.externalOrderId,
        clientOrderId: this.clientOrderId,
        submissionState: this.submissionState
      });
      return this;
    }
  };

  const result = await reconcileAlpacaPaperOrder(order, {
    readOrder: async () => {
      throw new Error('external-ID lookup must not run');
    },
    readOrderByClientOrderId: async clientOrderId => {
      calls.push(clientOrderId);
      return {
        id: 'alpaca-recovered',
        client_order_id: clientOrderId,
        status: 'accepted',
        filled_qty: '0'
      };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['client-original']);
  assert.equal(order.externalOrderId, 'alpaca-recovered');
  assert.equal(order.clientOrderId, 'client-original');
  assert.equal(order.submissionState, SUBMISSION_STATES.SUBMITTED);
  assert.equal(order.status, 'open');
  assert.equal(saved.length, 1);
});

test('unknown paper submission can reconcile by its original external ID alone', async () => {
  const calls = [];
  const order = {
    _id: 'paper-order-external-lookup',
    accountId: 'user:external-lookup',
    broker: 'alpaca',
    externalOrderId: 'alpaca-external-original',
    clientOrderId: null,
    qty: 1,
    brokerOrderStatus: 'submit_unknown',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    status: 'open',
    save: async function save() { return this; }
  };

  const result = await reconcileAlpacaPaperOrder(order, {
    readOrder: async externalOrderId => {
      calls.push(externalOrderId);
      return {
        id: externalOrderId,
        status: 'accepted',
        filled_qty: '0'
      };
    },
    readOrderByClientOrderId: async () => {
      throw new Error('client-ID lookup must not run');
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['alpaca-external-original']);
  assert.equal(order.externalOrderId, 'alpaca-external-original');
  assert.equal(order.clientOrderId, null);
  assert.equal(order.submissionState, SUBMISSION_STATES.SUBMITTED);
  assert.equal(order.status, 'open');
});

test('paper reconciliation cannot manufacture canceled or expired fills from malformed broker evidence', async t => {
  for (const scenario of [
    {
      name: 'canceled overfill',
      brokerOrder: {
        status: 'canceled',
        filled_qty: '999',
        filled_avg_price: '100'
      }
    },
    {
      name: 'expired coercive quantity',
      brokerOrder: {
        status: 'expired',
        filled_qty: '0x10',
        filled_avg_price: '100'
      }
    }
  ]) {
    await t.test(scenario.name, async () => {
      let tradeCreates = 0;
      const order = {
        _id: `paper-${scenario.name}`,
        accountId: 'user:malformed-terminal-fill',
        broker: 'alpaca',
        externalOrderId: 'alpaca-terminal-original',
        clientOrderId: 'client-terminal-original',
        qty: 1,
        brokerOrderStatus: 'submit_unknown',
        submissionState: SUBMISSION_STATES.UNKNOWN,
        status: 'open',
        save: async function save() { return this; }
      };

      const result = await reconcileAlpacaPaperOrder(order, {
        readOrder: async () => ({
          id: 'alpaca-terminal-original',
          client_order_id: 'client-terminal-original',
          ...scenario.brokerOrder
        }),
        createTradeFromOrder: async () => {
          tradeCreates += 1;
          return {};
        }
      });

      assert.equal(result.ok, false);
      assert.equal(result.reason, SUBMIT_UNKNOWN);
      assert.equal(tradeCreates, 0);
      assert.equal(order.externalOrderId, 'alpaca-terminal-original');
      assert.equal(order.clientOrderId, 'client-terminal-original');
      assert.equal(order.submissionState, SUBMISSION_STATES.UNKNOWN);
      assert.equal(order.status, 'open');
      assert.equal(order.fillPrice ?? null, null);
    });
  }
});

test('paper reconciliation freezes a canceled partial fill for X0.3 lifecycle handling', async () => {
  let tradeCreates = 0;
  const order = {
    _id: 'paper-valid-canceled-partial',
    accountId: 'user:valid-canceled-partial',
    broker: 'alpaca',
    externalOrderId: 'alpaca-valid-canceled-partial',
    clientOrderId: 'client-valid-canceled-partial',
    qty: 1,
    brokerOrderStatus: 'submit_unknown',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    status: 'open',
    save: async function save() { return this; }
  };
  const brokerOrder = {
    id: 'alpaca-valid-canceled-partial',
    client_order_id: 'client-valid-canceled-partial',
    status: 'canceled',
    filled_qty: '0.5',
    filled_avg_price: '100'
  };

  const result = await reconcileAlpacaPaperOrder(order, {
    readOrder: async () => brokerOrder,
    createTradeFromOrder: async (localOrder, remoteOrder) => {
      tradeCreates += 1;
      assert.equal(localOrder, order);
      assert.equal(remoteOrder, brokerOrder);
      return { _id: 'paper-trade-valid-canceled-partial' };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, SUBMIT_UNKNOWN);
  assert.equal(tradeCreates, 0);
  assert.equal(order.externalOrderId, 'alpaca-valid-canceled-partial');
  assert.equal(order.clientOrderId, 'client-valid-canceled-partial');
  assert.equal(order.submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(order.status, 'open');
  assert.equal(order.fillPrice ?? null, null);
});

test('paper reconciliation ignores camel-case-only fill aliases', async () => {
  let tradeCreates = 0;
  const order = {
    _id: 'paper-camel-fill-alias',
    accountId: 'user:camel-fill-alias',
    broker: 'alpaca',
    externalOrderId: 'alpaca-camel-fill-alias',
    clientOrderId: 'client-camel-fill-alias',
    qty: 1,
    brokerOrderStatus: 'submit_unknown',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    status: 'open',
    save: async function save() { return this; }
  };

  const result = await reconcileAlpacaPaperOrder(order, {
    readOrder: async () => ({
      id: 'alpaca-camel-fill-alias',
      client_order_id: 'client-camel-fill-alias',
      status: 'canceled',
      filledQty: '999',
      filledAvgPrice: '100'
    }),
    createTradeFromOrder: async () => {
      tradeCreates += 1;
      return {};
    }
  });

  assert.equal(result.ok, true);
  assert.equal(tradeCreates, 0);
  assert.equal(order.status, 'cancelled');
  assert.equal(order.fillPrice ?? null, null);
  assert.equal(order.notional ?? null, null);
});

test('missing or wrong-client acknowledgements cannot poison paper broker correlation', () => {
  for (const brokerOrder of [
    {
      id: 'alpaca-missing-client',
      status: 'accepted'
    },
    {
      id: 'alpaca-wrong-client',
      client_order_id: 'different-client',
      status: 'accepted'
    }
  ]) {
    const order = {
      externalOrderId: null,
      clientOrderId: 'client-original'
    };
    const selected = preserveCorrelatedPaperBrokerExternalOrderId(
      order,
      brokerOrder,
      order.clientOrderId
    );

    assert.equal(selected, null);
    assert.equal(order.externalOrderId, null);
    assert.equal(order.clientOrderId, 'client-original');
  }

  const correlatedOrder = {
    externalOrderId: null,
    clientOrderId: 'client-original'
  };
  assert.equal(
    preserveCorrelatedPaperBrokerExternalOrderId(
      correlatedOrder,
      {
        id: 'alpaca-correlated',
        client_order_id: 'client-original',
        status: 'accepted'
      },
      correlatedOrder.clientOrderId
    ),
    'alpaca-correlated'
  );
  assert.equal(correlatedOrder.externalOrderId, 'alpaca-correlated');

  const alreadyCorrelatedOrder = {
    externalOrderId: 'alpaca-persisted',
    clientOrderId: 'client-original'
  };
  preserveCorrelatedPaperBrokerExternalOrderId(
    alreadyCorrelatedOrder,
    {
      id: 'alpaca-conflicting',
      client_order_id: 'client-original',
      status: 'accepted'
    },
    alreadyCorrelatedOrder.clientOrderId
  );
  assert.equal(alreadyCorrelatedOrder.externalOrderId, 'alpaca-persisted');
});

test('malformed broker identifiers cannot poison paper broker correlation', () => {
  for (const malformedExternalId of [{ proxy: 'bad' }, 123, true, ' alpaca-bad ']) {
    const order = {
      clientOrderId: 'client-persisted',
      externalOrderId: null
    };
    const selected = preserveCorrelatedPaperBrokerExternalOrderId(
      order,
      {
        id: malformedExternalId,
        client_order_id: 'client-persisted',
        status: 'accepted'
      },
      'client-persisted'
    );
    assert.equal(selected, null);
    assert.equal(order.externalOrderId, null);
  }

  const malformedClientOrder = {
    clientOrderId: 'client-persisted',
    externalOrderId: null
  };
  preserveCorrelatedPaperBrokerExternalOrderId(
    malformedClientOrder,
    {
      id: 'alpaca-valid',
      client_order_id: { proxy: 'bad' },
      status: 'accepted'
    },
    'client-persisted'
  );
  assert.equal(malformedClientOrder.externalOrderId, null);
});

test('404 or lookup failure retains unknown and the original client ID', async () => {
  const saved = [];
  const order = {
    _id: 'paper-order-client-404',
    accountId: 'user:lookup',
    broker: 'alpaca',
    externalOrderId: null,
    clientOrderId: 'client-original',
    brokerOrderStatus: 'submit_unknown',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    status: 'open',
    save: async function save() {
      saved.push({
        status: this.status,
        submissionState: this.submissionState,
        clientOrderId: this.clientOrderId
      });
      return this;
    }
  };

  const result = await reconcileAlpacaPaperOrder(order, {
    readOrderByClientOrderId: async clientOrderId => {
      assert.equal(clientOrderId, 'client-original');
      const err = new Error('order not found');
      err.response = {
        status: 404,
        data: { message: 'order not found' }
      };
      throw err;
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, SUBMIT_UNKNOWN);
  assert.equal(order.status, 'open');
  assert.equal(order.submissionState, SUBMIT_UNKNOWN);
  assert.equal(order.clientOrderId, 'client-original');
  assert.equal(order.submissionLastError.submissionOutcome, SUBMIT_UNKNOWN);
  assert.equal(order.submissionLastError.reconciliationLookup, true);
  assert.equal(saved.length, 1);
});

test('identity-mismatched reconciliation data cannot replace the original broker correlation', async () => {
  const order = {
    _id: 'paper-order-identity-mismatch',
    accountId: 'user:lookup',
    broker: 'alpaca',
    externalOrderId: 'alpaca-original',
    clientOrderId: 'client-original',
    brokerOrderStatus: 'submit_unknown',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    status: 'open',
    save: async function save() {
      return this;
    }
  };

  const result = await reconcileAlpacaPaperOrder(order, {
    readOrder: async () => ({
      id: 'alpaca-different',
      client_order_id: 'client-different',
      status: 'filled',
      filled_qty: '1',
      filled_avg_price: '200'
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, SUBMIT_UNKNOWN);
  assert.equal(order.externalOrderId, 'alpaca-original');
  assert.equal(order.clientOrderId, 'client-original');
  assert.equal(order.submissionState, SUBMIT_UNKNOWN);
  assert.equal(order.status, 'open');
});

test('open paper reconciliation continues monitoring every client-ID-only submitted row', async t => {
  let capturedQuery = null;
  t.mock.method(PaperOrder, 'find', query => {
    capturedQuery = query;
    return {
      sort: () => ({
        limit: async () => []
      })
    };
  });

  const result = await reconcileOpenAlpacaPaperOrders({
    accountId: 'user:client-only-monitor'
  });

  assert.equal(result.checked, 0);
  const clientIdentityBranch = capturedQuery.$or.find(
    clause => clause.clientOrderId
  );
  assert.ok(clientIdentityBranch);
  assert.equal(Object.hasOwn(clientIdentityBranch, '$or'), false);
});

test('post-ack local errors preserve broker identity and suppress rejection recording', () => {
  const order = {
    _id: 'paper-order-pending',
    status: 'open',
    submissionState: SUBMISSION_STATES.SUBMITTED,
    clientOrderId: 'client-acknowledged'
  };
  const alpacaPaperOrder = {
    payload: {
      client_order_id: 'client-acknowledged'
    },
    order: {
      id: 'alpaca-acknowledged',
      status: 'accepted',
      client_order_id: 'client-acknowledged'
    }
  };
  const err = markPaperOrderReconciliationRequired(
    Object.assign(new Error('local save failed'), { code: 'ECONNRESET' }),
    {
      order,
      alpacaPaperOrder,
      brokerOrderPersisted: false
    }
  );

  assert.equal(err.code, 'PAPER_ORDER_RECONCILIATION_REQUIRED');
  assert.equal(err.localProcessingCode, 'ECONNRESET');
  assert.equal(err.statusCode, 409);
  assert.equal(err.submissionOutcome, SUBMISSION_STATES.SUBMITTED);
  assert.equal(err.submissionAttempted, true);
  assert.equal(err.submissionPhase, 'post_ack');
  assert.equal(err.reconciliationRequired, true);
  assert.equal(err.brokerOrderPersisted, false);
  assert.equal(err.paperOrderRecorded, true);
  assert.equal(err.paperOrder, order);
  assert.equal(err.brokerOrder.id, 'alpaca-acknowledged');
  assert.equal(err.clientOrderId, 'client-acknowledged');
});

async function runSyncedDispatchWindowWorkflow(t, {
  accountId,
  idempotencyKey,
  renewalMatches,
  lateRoboOrder = null,
  lateRoboError = null,
  renewalErrors = [],
  submissionError = null
}) {
  const previousSync = process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
  process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = 'true';
  t.after(() => {
    if (previousSync === undefined) delete process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
    else process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = previousSync;
  });

  const PaperSettings = require('../models/PaperSettings');
  const RegimeSnapshot = require('../models/RegimeSnapshot');
  const marketData = require('../services/marketData');
  const marketStatus = require('../utils/marketStatus');
  const alpacaTradingClient = require('../services/alpacaTradingClient');
  const executionTelemetry = require('../services/executionTelemetryService');
  const paperBrokerPath = require.resolve('../paper/paperBrokerClient');
  const savedStates = [];
  const unresolvedRoboQueries = [];
  const unresolvedPaperQueries = [];
  let renewalCalls = 0;
  let submitCalls = 0;
  let rejectionTelemetryCalls = 0;
  let filledTelemetryCalls = 0;
  let createdOrder = null;

  t.mock.method(marketData, 'fetchQuotes', async symbols => (
    symbols.map(symbol => ({ symbol, price: 100 }))
  ));
  t.mock.method(marketStatus, 'getMarketStatus', () => ({ status: 'OPEN' }));
  t.mock.method(alpacaTradingClient, 'submitAlpacaPaperOrder', async input => {
    submitCalls += 1;
    if (submissionError) {
      submissionError.clientOrderId = input.clientOrderId;
      if (submissionError.brokerOrder) {
        submissionError.brokerOrder.client_order_id = input.clientOrderId;
      }
      submissionError.alpacaPayload = {
        symbol: input.symbol,
        client_order_id: input.clientOrderId,
        qty: String(input.qty)
      };
      submissionError.submissionAttempted = true;
      throw submissionError;
    }
    return {
      order: {
        id: 'alpaca-unexpected',
        client_order_id: createdOrder?.clientOrderId,
        status: 'accepted',
        filled_qty: '0'
      }
    };
  });
  t.mock.method(executionTelemetry, 'recordRejectedExecution', async () => {
    rejectionTelemetryCalls += 1;
  });
  t.mock.method(executionTelemetry, 'recordFilledExecution', async () => {
    filledTelemetryCalls += 1;
  });
  t.mock.method(PaperSettings, 'findOne', async () => ({
    accountId,
    startingCash: 100000,
    slippageBps: 0,
    commission: 0,
    maxPositionPct: 100,
    maxDailyLossPct: 2,
    maxSymbolExposurePct: 100,
    maxSectorExposurePct: 100,
    maxCorrelationClusterPct: 100,
    maxVarPct: 100,
    varVolatilityPct: 1,
    cooldownUntil: null
  }));
  t.mock.method(PaperTrade, 'find', () => ({
    sort: () => ({
      lean: async () => []
    })
  }));
  t.mock.method(PaperOrder, 'find', () => ({
    sort: () => ({
      limit: async () => []
    })
  }));
  t.mock.method(RegimeSnapshot, 'findOne', () => ({
    sort: () => ({
      lean: async () => ({
        date: '2026-07-23',
        trendChop: 'trend',
        vol: 'normal',
        risk: 'risk_on',
        notes: []
      })
    })
  }));
  t.mock.method(PaperOrder, 'findOne', query => {
    if (!query.idempotencyKey) unresolvedPaperQueries.push(query);
    return {
      sort: async () => null
    };
  });
  t.mock.method(RoboTradeOrder, 'findOne', async query => {
    unresolvedRoboQueries.push(query);
    if (lateRoboError && unresolvedRoboQueries.length === 3) {
      throw lateRoboError;
    }
    return lateRoboOrder && unresolvedRoboQueries.length === 3
      ? lateRoboOrder
      : null;
  });
  t.mock.method(OrderIntent, 'findOne', async () => null);
  t.mock.method(PaperAccountLock, 'findOneAndUpdate', async () => ({
    owner: 'manual-paper-owner'
  }));
  t.mock.method(PaperAccountLock, 'updateOne', async query => {
    if (!query.lockedUntil) return { matchedCount: 1 };
    const renewalError = renewalErrors[renewalCalls] || null;
    if (renewalError) {
      renewalCalls += 1;
      throw renewalError;
    }
    const matchedCount = renewalMatches[renewalCalls] ?? 0;
    renewalCalls += 1;
    return { matchedCount };
  });
  t.mock.method(PaperOrder, 'create', async payload => {
    createdOrder = {
      _id: 'manual-paper-attempt',
      ...payload,
      async save() {
        savedStates.push({
          submissionState: this.submissionState,
          submissionAttemptCount: this.submissionAttemptCount,
          submissionLastAttemptAt: this.submissionLastAttemptAt,
          submissionLastReconciledAt: this.submissionLastReconciledAt,
          externalOrderId: this.externalOrderId,
          fillPrice: this.fillPrice,
          filledAt: this.filledAt,
          rejectedReason: this.rejectedReason,
          status: this.status,
          brokerOrderStatus: this.brokerOrderStatus
        });
        return this;
      }
    };
    return createdOrder;
  });

  delete require.cache[paperBrokerPath];
  t.after(() => {
    delete require.cache[paperBrokerPath];
  });
  const freshPaperBroker = require(paperBrokerPath);

  let error = null;
  try {
    await freshPaperBroker.placeOrder({
      accountId,
      idempotencyKey,
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'buy',
      qty: 1
    });
  } catch (err) {
    error = err;
  }

  return {
    createdOrder,
    error,
    filledTelemetryCalls,
    renewalCalls,
    rejectionTelemetryCalls,
    savedStates,
    submitCalls,
    unresolvedPaperQueries,
    unresolvedRoboQueries
  };
}

function assertExactDurableNotAttempted(result) {
  assert.ok(result.createdOrder);
  assert.equal(result.createdOrder.submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(result.createdOrder.submissionAttemptCount, 0);
  assert.equal(result.createdOrder.submissionLastAttemptAt, null);
  assert.equal(result.createdOrder.submissionLastReconciledAt, null);
  assert.equal(result.createdOrder.externalOrderId, null);
  assert.equal(result.createdOrder.fillPrice, null);
  assert.equal(result.createdOrder.filledAt, null);
  assert.equal(result.createdOrder.rejectedReason, null);
  assert.equal(result.createdOrder.status, 'cancelled');
  assert.equal(result.createdOrder.brokerOrderStatus, 'not_attempted');
  assert.equal(result.savedStates.length, 1);
  assert.deepEqual(result.savedStates[0], {
    submissionState: SUBMISSION_STATES.NOT_ATTEMPTED,
    submissionAttemptCount: 0,
    submissionLastAttemptAt: null,
    submissionLastReconciledAt: null,
    externalOrderId: null,
    fillPrice: null,
    filledAt: null,
    rejectedReason: null,
    status: 'cancelled',
    brokerOrderStatus: 'not_attempted'
  });
  assert.equal(result.submitCalls, 0);
  assert.equal(result.rejectionTelemetryCalls, 0);
}

test('manual Alpaca-paper workflow loses its lease after durable creation and never dispatches', async t => {
  const result = await runSyncedDispatchWindowWorkflow(t, {
    accountId: 'user:dispatch-lease-loss',
    idempotencyKey: 'dispatch-lease-loss',
    renewalMatches: [1, 0]
  });

  assert.ok(result.error);
  assert.equal(result.error.code, 'ALPACA_PAPER_SUBMISSION_LOCK_LOST');
  assert.equal(result.error.statusCode, 409);
  assert.equal(result.error.submissionAttempted, false);
  assert.equal(result.error.submissionOutcome, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(result.error.paperOrder, result.createdOrder);
  assert.equal(result.renewalCalls, 2);
  assertExactDurableNotAttempted(result);
});

test('manual Alpaca-paper workflow catches a late RoboTrader unknown after durable creation', async t => {
  const blockingOrder = {
    _id: 'robo-late-unknown',
    accountId: 'user:dispatch-late-robo',
    broker: 'alpaca',
    environment: 'paper',
    status: 'pending_submit',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    clientOrderId: 'robo-client-late'
  };
  const result = await runSyncedDispatchWindowWorkflow(t, {
    accountId: blockingOrder.accountId,
    idempotencyKey: 'dispatch-late-robo',
    renewalMatches: [1, 1],
    lateRoboOrder: blockingOrder
  });

  assert.ok(result.error);
  assert.equal(result.error.code, 'ALPACA_PAPER_SUBMISSION_LATE_UNRESOLVED');
  assert.equal(result.error.statusCode, 409);
  assert.equal(result.error.submissionAttempted, false);
  assert.equal(result.error.submissionOutcome, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(result.error.blockingPaperOrder, blockingOrder);
  assert.equal(result.error.paperOrder, result.createdOrder);
  assert.equal(result.renewalCalls, 2);
  assert.equal(result.unresolvedRoboQueries.length, 3);
  assert.equal(
    result.unresolvedPaperQueries.at(-1)._id.$ne,
    result.createdOrder._id
  );
  assertExactDurableNotAttempted(result);
});

test('manual Alpaca-paper workflow classifies a thrown final lease renewal as not attempted', async t => {
  const result = await runSyncedDispatchWindowWorkflow(t, {
    accountId: 'user:dispatch-renew-error',
    idempotencyKey: 'dispatch-renew-error',
    renewalMatches: [1, 1],
    renewalErrors: [null, new Error('lock database unavailable')]
  });

  assert.ok(result.error);
  assert.equal(result.error.code, 'ALPACA_PAPER_COORDINATION_FAILED');
  assert.equal(result.error.submissionAttempted, false);
  assert.equal(result.error.submissionOutcome, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(result.renewalCalls, 2);
  assertExactDurableNotAttempted(result);
});

test('manual Alpaca-paper workflow classifies a thrown final latch query as not attempted', async t => {
  const result = await runSyncedDispatchWindowWorkflow(t, {
    accountId: 'user:dispatch-latch-error',
    idempotencyKey: 'dispatch-latch-error',
    renewalMatches: [1, 1],
    lateRoboError: new Error('order database unavailable')
  });

  assert.ok(result.error);
  assert.equal(result.error.code, 'ALPACA_PAPER_COORDINATION_FAILED');
  assert.equal(result.error.submissionAttempted, false);
  assert.equal(result.error.submissionOutcome, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(result.unresolvedRoboQueries.length, 3);
  assertExactDurableNotAttempted(result);
});

test('manual Alpaca-paper workflow keeps the exact Alpaca duplicate-client error unknown', async t => {
  const duplicate = new Error('Request failed with status code 422');
  duplicate.response = {
    status: 422,
    data: {
      code: 40010001,
      message: 'client_order_id must be unique'
    }
  };
  const result = await runSyncedDispatchWindowWorkflow(t, {
    accountId: 'user:duplicate-client-unknown',
    idempotencyKey: 'duplicate-client-unknown',
    renewalMatches: [1, 1],
    submissionError: duplicate
  });

  assert.ok(result.error);
  assert.equal(result.error.code, SUBMIT_UNKNOWN);
  assert.equal(result.error.statusCode, 409);
  assert.equal(result.error.submissionOutcome, SUBMISSION_STATES.UNKNOWN);
  assert.equal(result.error.paperOrder, result.createdOrder);
  assert.equal(result.submitCalls, 1);
  assert.equal(result.rejectionTelemetryCalls, 0);
  assert.equal(result.createdOrder.status, 'open');
  assert.equal(result.createdOrder.submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(result.createdOrder.submissionAttemptCount, 1);
  assert.ok(result.createdOrder.submissionLastAttemptAt);
  assert.equal(result.createdOrder.externalOrderId ?? null, null);
  assert.equal(result.createdOrder.rejectedReason, null);
  assert.equal(result.savedStates.length, 1);
});

test('manual Alpaca-paper workflow cannot manufacture a fill from an incomplete broker acknowledgement', async t => {
  const incompleteFill = createSubmitUnknownError(
    'Alpaca paper order returned an inconclusive acknowledgement.',
    {
      clientOrderId: 'filled-client-original',
      brokerOrder: {
        id: 'alpaca-filled-incomplete',
        client_order_id: 'filled-client-original',
        status: 'filled'
      }
    }
  );
  incompleteFill.submissionPhase = 'submit';

  const result = await runSyncedDispatchWindowWorkflow(t, {
    accountId: 'user:incomplete-filled-ack',
    idempotencyKey: 'incomplete-filled-ack',
    renewalMatches: [1, 1],
    submissionError: incompleteFill
  });

  assert.ok(result.error);
  assert.equal(result.error.code, SUBMIT_UNKNOWN);
  assert.equal(result.error.submissionOutcome, SUBMISSION_STATES.UNKNOWN);
  assert.equal(result.submitCalls, 1);
  assert.equal(result.filledTelemetryCalls, 0);
  assert.equal(result.rejectionTelemetryCalls, 0);
  assert.equal(result.createdOrder.status, 'open');
  assert.equal(result.createdOrder.submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(result.createdOrder.fillPrice, null);
  assert.equal(result.createdOrder.filledAt, null);
  assert.equal(result.createdOrder.rejectedReason, null);
  assert.equal(result.createdOrder.externalOrderId, 'alpaca-filled-incomplete');
});

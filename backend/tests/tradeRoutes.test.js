const test = require('node:test');
const assert = require('node:assert/strict');
const paperTradesRouter = require('../routes/paperTrades');
const tradeRouter = require('../routes/trade');
const paperBroker = require('../paper/paperBrokerClient');
const {
  SUBMISSION_STATES,
  SUBMIT_UNKNOWN
} = require('../services/submissionOutcomeService');

function getRouteHandler(router, path, method) {
  const layer = router.stack.find(
    item => item.route && item.route.path === path && item.route.methods[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route to exist`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('paper trade routes require auth middleware', () => {
  const middlewareNames = paperTradesRouter.stack
    .filter(layer => !layer.route)
    .map(layer => layer.handle?.name);

  assert.ok(middlewareNames.includes('auth'));
});

test('trade execute route uses paper broker persistence pipeline', async t => {
  const calls = [];
  t.mock.method(paperBroker, 'placeOrder', async payload => {
    calls.push(payload);
    return {
      order: { _id: 'paper-order-1', symbol: payload.symbol },
      trade: { _id: 'paper-trade-1', symbol: payload.symbol },
      brokerOrder: { id: 'alpaca-order-1' }
    };
  });

  const handler = getRouteHandler(tradeRouter, '/execute', 'post');
  const req = {
    headers: {
      'idempotency-key': 'trade-execute-request-1'
    },
    body: {
      symbol: 'AAPL',
      side: 'buy',
      qty: 1,
      allowExtendedHours: true
    }
  };
  const res = createMockRes();
  let nextErr = null;

  await handler(req, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].idempotencyKey, 'trade-execute-request-1');
  assert.equal(calls[0].origin, 'manual');
  assert.equal(calls[0].metadata.source, 'api_trade_execute');
  assert.equal(res.body.order._id, 'paper-order-1');
});

test('paper order route forwards the Idempotency-Key header unchanged', async t => {
  const calls = [];
  t.mock.method(paperBroker, 'placeOrder', async payload => {
    calls.push(payload);
    return {
      order: { _id: 'paper-order-idempotent' },
      idempotentReplay: false
    };
  });

  const handler = getRouteHandler(paperTradesRouter, '/order', 'post');
  const res = createMockRes();
  await handler({
    headers: {
      'idempotency-key': 'Case-Sensitive-Key-42'
    },
    body: {
      symbol: 'MSFT',
      side: 'buy',
      qty: 1
    }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].idempotencyKey, 'Case-Sensitive-Key-42');
});

test('paper order route does not duplicate already recorded rejected broker orders', async t => {
  let rejectionRecords = 0;
  t.mock.method(paperBroker, 'placeOrder', async () => {
    const err = new Error('Alpaca rejected the paper order.');
    err.paperOrderRecorded = true;
    err.paperOrder = { _id: 'paper-order-rejected', status: 'rejected' };
    throw err;
  });
  t.mock.method(paperBroker, 'recordRejectedOrder', async () => {
    rejectionRecords += 1;
  });

  const handler = getRouteHandler(paperTradesRouter, '/order', 'post');
  const req = {
    body: {
      symbol: 'AAPL',
      side: 'buy',
      qty: 1
    }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Alpaca rejected the paper order.');
  assert.equal(res.body.order._id, 'paper-order-rejected');
  assert.equal(rejectionRecords, 0);
});

test('paper order route returns stable typed unknown data without duplicate rejection', async t => {
  let rejectionRecords = 0;
  t.mock.method(paperBroker, 'placeOrder', async () => {
    const err = new Error('Alpaca paper order submission outcome is unknown.');
    err.code = SUBMIT_UNKNOWN;
    err.statusCode = 409;
    err.submissionOutcome = SUBMIT_UNKNOWN;
    err.submissionAttempted = true;
    err.clientOrderId = 'client-original';
    err.paperOrderRecorded = true;
    err.paperOrder = {
      _id: 'paper-order-unknown',
      status: 'open',
      submissionState: SUBMIT_UNKNOWN,
      clientOrderId: 'client-original'
    };
    throw err;
  });
  t.mock.method(paperBroker, 'recordRejectedOrder', async () => {
    rejectionRecords += 1;
  });

  const handler = getRouteHandler(paperTradesRouter, '/order', 'post');
  const res = createMockRes();
  await handler({
    body: {
      symbol: 'AAPL',
      side: 'buy',
      qty: 1
    }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, SUBMIT_UNKNOWN);
  assert.equal(res.body.submissionState, SUBMIT_UNKNOWN);
  assert.equal(res.body.submissionAttempted, true);
  assert.equal(res.body.clientOrderId, 'client-original');
  assert.equal(res.body.order.status, 'open');
  assert.equal(rejectionRecords, 0);
});

test('trade execute route returns the same typed unknown contract without duplicate rejection', async t => {
  let rejectionRecords = 0;
  t.mock.method(paperBroker, 'placeOrder', async () => {
    const err = new Error('Earlier Alpaca paper submission remains unresolved.');
    err.code = SUBMIT_UNKNOWN;
    err.statusCode = 409;
    err.submissionOutcome = SUBMIT_UNKNOWN;
    err.submissionAttempted = false;
    err.clientOrderId = 'client-blocking';
    err.paperOrderRecorded = true;
    err.paperOrder = {
      _id: 'paper-order-blocking',
      status: 'open',
      submissionState: SUBMIT_UNKNOWN,
      clientOrderId: 'client-blocking'
    };
    throw err;
  });
  t.mock.method(paperBroker, 'recordRejectedOrder', async () => {
    rejectionRecords += 1;
  });

  const handler = getRouteHandler(tradeRouter, '/execute', 'post');
  const res = createMockRes();
  await handler({
    body: {
      symbol: 'MSFT',
      side: 'buy',
      qty: 1
    }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, SUBMIT_UNKNOWN);
  assert.equal(res.body.submissionState, SUBMIT_UNKNOWN);
  assert.equal(res.body.submissionAttempted, false);
  assert.equal(res.body.clientOrderId, 'client-blocking');
  assert.equal(res.body.order._id, 'paper-order-blocking');
  assert.equal(rejectionRecords, 0);
});

test('post-ack local failure requires reconciliation and never records rejection', async t => {
  let rejectionRecords = 0;
  t.mock.method(paperBroker, 'placeOrder', async () => {
    const err = new Error('PaperOrder save failed after broker acknowledgement.');
    err.code = 'PAPER_ORDER_RECONCILIATION_REQUIRED';
    err.statusCode = 409;
    err.submissionOutcome = SUBMISSION_STATES.SUBMITTED;
    err.submissionAttempted = true;
    err.submissionPhase = 'post_ack';
    err.reconciliationRequired = true;
    err.brokerOrderPersisted = false;
    err.clientOrderId = 'client-acknowledged';
    err.paperOrderRecorded = true;
    err.paperOrder = {
      _id: 'paper-order-pending',
      status: 'open',
      submissionState: SUBMISSION_STATES.PENDING,
      clientOrderId: 'client-acknowledged'
    };
    err.brokerOrder = {
      id: 'alpaca-acknowledged',
      status: 'accepted',
      client_order_id: 'client-acknowledged'
    };
    throw err;
  });
  t.mock.method(paperBroker, 'recordRejectedOrder', async () => {
    rejectionRecords += 1;
  });

  const handler = getRouteHandler(paperTradesRouter, '/order', 'post');
  const res = createMockRes();
  await handler({
    body: {
      symbol: 'AAPL',
      side: 'buy',
      qty: 1
    }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'PAPER_ORDER_RECONCILIATION_REQUIRED');
  assert.equal(res.body.submissionState, SUBMISSION_STATES.SUBMITTED);
  assert.equal(res.body.submissionPhase, 'post_ack');
  assert.equal(res.body.reconciliationRequired, true);
  assert.equal(res.body.brokerOrderPersisted, false);
  assert.equal(res.body.clientOrderId, 'client-acknowledged');
  assert.equal(res.body.brokerOrder.id, 'alpaca-acknowledged');
  assert.equal(rejectionRecords, 0);
});

test('unrecorded lock or preflight failures never create synthetic rejected telemetry', async t => {
  let rejectionRecords = 0;
  t.mock.method(paperBroker, 'placeOrder', async () => {
    const err = new Error('Another paper submission owns the account lease.');
    err.code = 'ALPACA_PAPER_SUBMISSION_LOCKED';
    err.statusCode = 409;
    err.submissionOutcome = SUBMISSION_STATES.NOT_ATTEMPTED;
    err.submissionAttempted = false;
    err.submissionPhase = 'coordination';
    throw err;
  });
  t.mock.method(paperBroker, 'recordRejectedOrder', async () => {
    rejectionRecords += 1;
  });

  const handler = getRouteHandler(tradeRouter, '/execute', 'post');
  const res = createMockRes();
  await handler({
    headers: {
      'idempotency-key': 'lock-contention-request'
    },
    body: {
      symbol: 'AAPL',
      side: 'buy',
      qty: 1
    }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'ALPACA_PAPER_SUBMISSION_LOCKED');
  assert.equal(res.body.submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(res.body.submissionAttempted, false);
  assert.equal(rejectionRecords, 0);
});

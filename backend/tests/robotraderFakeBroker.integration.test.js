const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createAlpacaBroker } = require('../robotrader/alpacaBroker');
const {
  SUBMISSION_STATES,
  classifySubmissionError
} = require('../services/submissionOutcomeService');

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
}

test('fake paper broker exercises submit, lookup, list, and cancel over HTTP without funds', async t => {
  const requests = [];
  const storedOrder = {
    id: 'fake-order-1',
    status: 'new',
    symbol: 'AAPL',
    side: 'buy',
    qty: '1'
  };
  let orderReads = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readJson(req);
    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      key: req.headers['apca-api-key-id'],
      secret: req.headers['apca-api-secret-key']
    });
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-request-id', `fake-request-${requests.length}`);
    if (req.method === 'POST' && url.pathname === '/v2/orders') {
      Object.assign(storedOrder, body);
      res.statusCode = 201;
      return res.end(JSON.stringify(storedOrder));
    }
    if (req.method === 'GET' && url.pathname === '/v2/orders/fake-order-1') {
      orderReads += 1;
      storedOrder.status = orderReads === 1 ? 'partially_filled' : 'filled';
      storedOrder.filled_qty = orderReads === 1 ? '0.5' : storedOrder.qty;
      storedOrder.filled_avg_price = '100.25';
      return res.end(JSON.stringify(storedOrder));
    }
    if (req.method === 'GET' && url.pathname === '/v2/orders:by_client_order_id') {
      return res.end(JSON.stringify(storedOrder));
    }
    if (req.method === 'GET' && url.pathname === '/v2/orders') {
      return res.end(JSON.stringify([storedOrder]));
    }
    if (req.method === 'DELETE' && url.pathname === '/v2/orders/fake-order-1') {
      storedOrder.status = 'canceled';
      res.statusCode = 204;
      return res.end();
    }
    res.statusCode = 404;
    return res.end(JSON.stringify({ message: 'not found' }));
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('Local socket binding is blocked by this sandbox; run this test with local loopback permission.');
      return;
    }
    throw err;
  }
  t.after(() => server.close());
  const address = server.address();
  const broker = createAlpacaBroker({
    mode: 'paper',
    allowLocalPaperTestEndpoint: true,
    env: {
      APCA_PAPER_BASE_URL: `http://127.0.0.1:${address.port}`,
      APCA_PAPER_API_KEY_ID: 'fake-key',
      APCA_PAPER_API_SECRET_KEY: 'fake-secret'
    }
  });

  const submitted = await broker.submitOrder({
    symbol: 'AAPL',
    assetClass: 'equity',
    side: 'buy',
    qty: 1,
    orderType: 'limit',
    timeInForce: 'day',
    limitPrice: 100.25,
    clientOrderId: 'fake-test-aapl-1'
  });
  const partial = await broker.getOrder(submitted.order.id);
  const filled = await broker.getOrder(submitted.order.id);
  const byClientId = await broker.getOrderByClientOrderId(submitted.order.client_order_id);
  const listed = await broker.listOrders({ status: 'all' });
  await broker.cancelOrder(submitted.order.id);

  assert.equal(submitted.order.id, 'fake-order-1');
  assert.equal(submitted.payload.limit_price, '100.25');
  assert.equal(submitted.brokerRequestId, 'fake-request-1');
  assert.equal(partial.status, 'partially_filled');
  assert.equal(filled.status, 'filled');
  assert.equal(byClientId.client_order_id, 'fake-test-aapl-1');
  assert.equal(listed.length, 1);
  assert.equal(storedOrder.status, 'canceled');
  assert.equal(requests.every(item => item.key === 'fake-key' && item.secret === 'fake-secret'), true);
  assert.deepEqual(requests.map(item => `${item.method} ${item.path}`), [
    'POST /v2/orders',
    'GET /v2/orders/fake-order-1',
    'GET /v2/orders/fake-order-1',
    'GET /v2/orders:by_client_order_id',
    'GET /v2/orders',
    'DELETE /v2/orders/fake-order-1'
  ]);
});

test('fake paper broker preserves submission semantics across HTTP and transport failures', async t => {
  const acceptedAfterDisconnect = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-request-id', `request-${url.searchParams.get('client_order_id') || 'submit'}`);
    if (req.method === 'GET' && url.pathname === '/v2/orders:by_client_order_id') {
      const clientOrderId = url.searchParams.get('client_order_id');
      const order = acceptedAfterDisconnect.get(clientOrderId);
      if (order) return res.end(JSON.stringify(order));
      res.statusCode = 404;
      return res.end(JSON.stringify({ code: 40410000, message: 'order not found' }));
    }
    if (req.method !== 'POST' || url.pathname !== '/v2/orders') {
      res.statusCode = 404;
      return res.end(JSON.stringify({ message: 'not found' }));
    }
    const body = await readJson(req);
    const scenario = body.client_order_id;
    if (scenario.startsWith('http-')) {
      res.statusCode = Number(scenario.split('-')[1]);
      return res.end(JSON.stringify({ code: 42210000, message: `broker ${res.statusCode}` }));
    }
    if (scenario === 'malformed-ack') {
      res.statusCode = 201;
      return res.end(JSON.stringify({ message: 'accepted without identity' }));
    }
    if (scenario === 'duplicate-client') {
      res.statusCode = 422;
      return res.end(JSON.stringify({ code: 42210000, message: 'client_order_id must be unique' }));
    }
    if (scenario === 'disconnect-after-acceptance') {
      acceptedAfterDisconnect.set(scenario, {
        id: 'accepted-before-disconnect',
        client_order_id: scenario,
        status: 'accepted',
        symbol: 'AAPL',
        side: 'buy',
        qty: '1'
      });
      return req.socket.destroy();
    }
    if (scenario === 'request-timeout') {
      return setTimeout(() => {
        if (!res.destroyed) res.end(JSON.stringify({ message: 'late response' }));
      }, 250);
    }
    res.statusCode = 500;
    return res.end(JSON.stringify({ message: 'unknown scenario' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  const broker = createAlpacaBroker({
    mode: 'paper',
    allowLocalPaperTestEndpoint: true,
    requestTimeoutMs: 50,
    env: {
      APCA_PAPER_BASE_URL: `http://127.0.0.1:${address.port}`,
      APCA_PAPER_API_KEY_ID: 'fake-key',
      APCA_PAPER_API_SECRET_KEY: 'fake-secret'
    }
  });
  const submit = clientOrderId => broker.submitOrder({
    symbol: 'AAPL',
    assetClass: 'equity',
    side: 'buy',
    qty: 1,
    orderType: 'market',
    timeInForce: 'day',
    clientOrderId
  });

  await assert.rejects(() => submit('http-404'), err => {
    assert.equal(classifySubmissionError(err), SUBMISSION_STATES.REJECTED);
    assert.equal(err.brokerRequestId, 'request-submit');
    return true;
  });
  for (const status of [408, 425, 429, 500, 503]) {
    await assert.rejects(() => submit(`http-${status}`), err => {
      assert.equal(classifySubmissionError(err), SUBMISSION_STATES.UNKNOWN);
      return true;
    });
  }
  for (const scenario of ['request-timeout', 'malformed-ack', 'duplicate-client', 'disconnect-after-acceptance']) {
    await assert.rejects(() => submit(scenario), err => {
      assert.equal(classifySubmissionError(err), SUBMISSION_STATES.UNKNOWN);
      assert.equal(err.clientOrderId, scenario);
      return true;
    });
  }
  const recovered = await broker.getOrderByClientOrderId('disconnect-after-acceptance');
  assert.equal(recovered.id, 'accepted-before-disconnect');
  assert.equal(recovered.client_order_id, 'disconnect-after-acceptance');
});

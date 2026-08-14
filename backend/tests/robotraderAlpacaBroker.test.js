const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LIVE_ORDER_REPLACEMENT_DISABLED,
  createAlpacaBroker,
  getAlpacaConfigForMode,
  sanitizePositionClosePayload,
  sanitizeReplacementPayload
} = require('../robotrader/alpacaBroker');
const {
  SUBMISSION_STATES,
  classifySubmissionError
} = require('../services/submissionOutcomeService');

function validOrderInput(overrides = {}) {
  return {
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderType: 'market',
    orderClass: 'simple',
    timeInForce: 'day',
    qty: 1,
    clientOrderId: 'daytrader-robotrader-AAPL-attempt-contract',
    ...overrides
  };
}

test('live Alpaca configuration never falls back to generic or paper credentials', () => {
  const config = getAlpacaConfigForMode('live', {
    ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
    APCA_BASE_URL: 'https://paper-api.alpaca.markets',
    ALPACA_API_KEY: 'generic-key',
    ALPACA_API_SECRET: 'generic-secret',
    APCA_PAPER_API_KEY_ID: 'paper-key',
    APCA_PAPER_API_SECRET_KEY: 'paper-secret'
  });

  assert.equal(config.baseUrl, 'https://api.alpaca.markets');
  assert.equal(config.apiKey, '');
  assert.equal(config.apiSecret, '');
});

test('live Alpaca configuration accepts only explicit live credentials', () => {
  const config = getAlpacaConfigForMode('live', {
    APCA_LIVE_BASE_URL: 'https://live-broker.example/v2',
    APCA_LIVE_API_KEY_ID: 'live-key',
    APCA_LIVE_API_SECRET_KEY: 'live-secret'
  });

  assert.equal(config.baseUrl, 'https://live-broker.example');
  assert.equal(config.apiKey, 'live-key');
  assert.equal(config.apiSecret, 'live-secret');
});

test('paper Alpaca broker rejects paper-host lookalikes before HTTP', async () => {
  for (const baseUrl of [
    'https://paper-api.alpaca.markets.evil.example',
    'https://evil.example/?next=paper-api.alpaca.markets'
  ]) {
    const httpCalls = [];
    const broker = createAlpacaBroker({
      mode: 'paper',
      env: {
        NODE_ENV: 'production',
        LIVE_TRADING_ENABLED: 'false',
        APCA_PAPER_BASE_URL: baseUrl,
        APCA_PAPER_API_KEY_ID: 'paper-key',
        APCA_PAPER_API_SECRET_KEY: 'paper-secret',
        APCA_PAPER_ACCOUNT_ID: 'paper-account-1'
      },
      httpClient: async request => {
        httpCalls.push(request);
        return { data: {} };
      }
    });

    await assert.rejects(
      () => broker.submitOrder(validOrderInput()),
      err => err.code === 'ALPACA_PAPER_ENDPOINT_REQUIRED'
        && err.submissionAttempted === false
    );
    assert.equal(httpCalls.length, 0);
  }
});

test('robotrader alpaca broker sanitizes order replacement payloads', () => {
  assert.deepEqual(
    sanitizeReplacementPayload({
      qty: 2,
      limitPrice: 201.25,
      timeInForce: 'GTC',
      symbol: 'MSFT',
      side: 'sell'
    }),
    {
      qty: '2',
      limit_price: '201.25',
      time_in_force: 'gtc'
    }
  );
});

test('robotrader alpaca broker rejects unsafe replacement payloads', () => {
  assert.throws(
    () => sanitizeReplacementPayload({ symbol: 'MSFT', side: 'sell' }),
    /at least one supported field/
  );
  assert.throws(
    () => sanitizeReplacementPayload({ qty: -1 }),
    /qty must be a positive number/
  );
  assert.throws(
    () => sanitizeReplacementPayload({ trailPrice: 1, trailPercent: 2 }),
    /either trail_price or trail_percent/
  );
});

test('live Alpaca broker rejects replacement before payload validation or HTTP', async () => {
  const httpCalls = [];
  const broker = createAlpacaBroker({
    mode: 'live',
    env: {
      APCA_LIVE_BASE_URL: 'https://live-broker.example',
      APCA_LIVE_API_KEY_ID: 'live-key',
      APCA_LIVE_API_SECRET_KEY: 'live-secret'
    },
    httpClient: async request => {
      httpCalls.push(request);
      return { data: { id: 'should-not-exist' } };
    }
  });

  await assert.rejects(
    () => broker.replaceOrder('live-order-1', { qty: -1, trailPrice: 1, trailPercent: 2 }),
    err => {
      assert.equal(err.status, 409);
      assert.equal(err.code, LIVE_ORDER_REPLACEMENT_DISABLED);
      assert.match(err.message, /new immutable, re-authorized intent/i);
      return true;
    }
  );
  assert.equal(httpCalls.length, 0);
});

test('paper Alpaca broker sends exactly one sanitized replacement PATCH', async () => {
  const httpCalls = [];
  const broker = createAlpacaBroker({
    mode: 'paper',
    env: {
      APCA_PAPER_BASE_URL: 'https://paper-api.alpaca.markets',
      APCA_PAPER_API_KEY_ID: 'paper-key',
      APCA_PAPER_API_SECRET_KEY: 'paper-secret'
    },
    httpClient: async request => {
      httpCalls.push(request);
      return { data: { id: 'paper-order-1', status: 'replaced' } };
    }
  });

  const result = await broker.replaceOrder('paper-order-1', {
    qty: 2,
    limitPrice: 201.25,
    timeInForce: 'GTC',
    symbol: 'MSFT',
    side: 'sell'
  });

  assert.deepEqual(result, { id: 'paper-order-1', status: 'replaced' });
  assert.equal(httpCalls.length, 1);
  assert.deepEqual(httpCalls[0], {
    method: 'patch',
    url: 'https://paper-api.alpaca.markets/v2/orders/paper-order-1',
    data: {
      qty: '2',
      limit_price: '201.25',
      time_in_force: 'gtc'
    },
    params: undefined,
    headers: {
      'APCA-API-KEY-ID': 'paper-key',
      'APCA-API-SECRET-KEY': 'paper-secret'
    },
    timeout: 20000
  });
});

test('robotrader alpaca broker sanitizes position close payloads', () => {
  assert.deepEqual(sanitizePositionClosePayload({}), {});
  assert.deepEqual(sanitizePositionClosePayload({ qty: 2, ignored: true }), { qty: '2' });
  assert.deepEqual(sanitizePositionClosePayload({ percentage: 25 }), { percentage: '25' });
});

test('robotrader alpaca broker rejects unsafe position close payloads', () => {
  assert.throws(
    () => sanitizePositionClosePayload({ qty: 1, percentage: 50 }),
    /either qty or percentage/
  );
  assert.throws(() => sanitizePositionClosePayload({ qty: -1 }), /qty must be a positive number/);
  assert.throws(() => sanitizePositionClosePayload({ percentage: 101 }), /no greater than 100/);
});

test('robotrader alpaca broker marks configuration and validation failures as not attempted', async () => {
  let httpCalls = 0;
  const broker = createAlpacaBroker({
    mode: 'paper',
    env: {
      APCA_PAPER_BASE_URL: 'https://paper-api.alpaca.markets'
    },
    httpClient: async () => {
      httpCalls += 1;
      return { data: {} };
    }
  });

  await assert.rejects(
    () => broker.submitOrder(validOrderInput()),
    err => {
      assert.equal(err.code, 'ALPACA_NOT_CONFIGURED');
      assert.equal(err.submissionAttempted, false);
      assert.equal(err.submissionOutcome, SUBMISSION_STATES.NOT_ATTEMPTED);
      assert.equal(err.clientOrderId, 'daytrader-robotrader-AAPL-attempt-contract');
      return true;
    }
  );
  await assert.rejects(
    () => broker.submitOrder(validOrderInput({ qty: -1 })),
    err => {
      assert.equal(err.code, 'INVALID_ALPACA_ORDER_COMBINATION');
      assert.equal(err.submissionAttempted, false);
      assert.equal(err.submissionOutcome, SUBMISSION_STATES.NOT_ATTEMPTED);
      return true;
    }
  );
  assert.equal(httpCalls, 0);
});

test('robotrader alpaca broker rejects oversized client identity before broker I/O', async () => {
  let httpCalls = 0;
  const broker = createAlpacaBroker({
    mode: 'paper',
    env: {
      APCA_PAPER_BASE_URL: 'https://paper-api.alpaca.markets',
      APCA_PAPER_API_KEY_ID: 'paper-key',
      APCA_PAPER_API_SECRET_KEY: 'paper-secret'
    },
    httpClient: async () => {
      httpCalls += 1;
      return { data: {} };
    }
  });

  await assert.rejects(
    () => broker.submitOrder(validOrderInput({
      clientOrderId: 'x'.repeat(49)
    })),
    err => {
      assert.equal(err.submissionAttempted, false);
      assert.equal(classifySubmissionError(err), SUBMISSION_STATES.NOT_ATTEMPTED);
      return true;
    }
  );
  assert.equal(httpCalls, 0);
});

test('robotrader alpaca broker tags post-dispatch failures and preserves the exact identity and payload', async () => {
  const attemptedError = new Error('upstream unavailable');
  attemptedError.response = {
    status: 503,
    data: { message: 'temporarily unavailable' }
  };
  let httpCalls = 0;
  const broker = createAlpacaBroker({
    mode: 'paper',
    env: {
      APCA_PAPER_BASE_URL: 'https://paper-api.alpaca.markets',
      APCA_PAPER_API_KEY_ID: 'paper-key',
      APCA_PAPER_API_SECRET_KEY: 'paper-secret'
    },
    httpClient: async () => {
      httpCalls += 1;
      throw attemptedError;
    }
  });

  await assert.rejects(
    () => broker.submitOrder(validOrderInput()),
    err => {
      assert.equal(err.submissionAttempted, true);
      assert.equal(classifySubmissionError(err), SUBMISSION_STATES.UNKNOWN);
      assert.equal(err.clientOrderId, 'daytrader-robotrader-AAPL-attempt-contract');
      assert.deepEqual(err.alpacaPayload, {
        symbol: 'AAPL',
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
        client_order_id: 'daytrader-robotrader-AAPL-attempt-contract',
        qty: '1'
      });
      return true;
    }
  );
  assert.equal(httpCalls, 1);
});

test('robotrader alpaca broker treats Alpaca duplicate client identity wording as unknown', async () => {
  const broker = createAlpacaBroker({
    mode: 'paper',
    env: {
      APCA_PAPER_BASE_URL: 'https://paper-api.alpaca.markets',
      APCA_PAPER_API_KEY_ID: 'paper-key',
      APCA_PAPER_API_SECRET_KEY: 'paper-secret'
    },
    httpClient: async () => {
      const err = new Error('Request failed with status code 422');
      err.response = {
        status: 422,
        data: {
          code: 40010001,
          message: 'client_order_id must be unique'
        }
      };
      throw err;
    }
  });

  await assert.rejects(
    () => broker.submitOrder(validOrderInput()),
    err => {
      assert.equal(err.submissionAttempted, true);
      assert.equal(classifySubmissionError(err), SUBMISSION_STATES.UNKNOWN);
      assert.equal(err.clientOrderId, 'daytrader-robotrader-AAPL-attempt-contract');
      assert.equal(err.alpacaPayload.client_order_id, err.clientOrderId);
      return true;
    }
  );
});

test('robotrader alpaca broker classifies malformed acknowledgements as submit unknown', async () => {
  const broker = createAlpacaBroker({
    mode: 'paper',
    env: {
      APCA_PAPER_BASE_URL: 'https://paper-api.alpaca.markets',
      APCA_PAPER_API_KEY_ID: 'paper-key',
      APCA_PAPER_API_SECRET_KEY: 'paper-secret'
    },
    httpClient: async () => ({
      data: {
        id: 'alpaca-order-without-status',
        client_order_id: 'daytrader-robotrader-AAPL-attempt-contract'
      }
    })
  });

  await assert.rejects(
    () => broker.submitOrder(validOrderInput()),
    err => {
      assert.equal(err.code, SUBMISSION_STATES.UNKNOWN);
      assert.equal(err.submissionAttempted, true);
      assert.equal(err.submissionOutcome, SUBMISSION_STATES.UNKNOWN);
      assert.equal(err.clientOrderId, 'daytrader-robotrader-AAPL-attempt-contract');
      assert.equal(err.brokerOrder.id, 'alpaca-order-without-status');
      assert.equal(err.alpacaPayload.client_order_id, err.clientOrderId);
      return true;
    }
  );
});

test('robotrader alpaca broker rejects non-canonical broker correlation identifiers', async () => {
  for (const malformedId of [{ proxy: 'bad' }, 123, true, ' alpaca-padded ']) {
    const broker = createAlpacaBroker({
      mode: 'paper',
      env: {
        APCA_PAPER_BASE_URL: 'https://paper-api.alpaca.markets',
        APCA_PAPER_API_KEY_ID: 'paper-key',
        APCA_PAPER_API_SECRET_KEY: 'paper-secret'
      },
      httpClient: async () => ({
        data: {
          id: malformedId,
          client_order_id: 'daytrader-robotrader-AAPL-attempt-contract',
          status: 'accepted'
        }
      })
    });

    await assert.rejects(
      () => broker.submitOrder(validOrderInput()),
      err => {
        assert.equal(err.code, SUBMISSION_STATES.UNKNOWN);
        assert.equal(err.submissionAttempted, true);
        assert.deepEqual(err.brokerOrder.id, malformedId);
        return true;
      }
    );
  }
});

test('robotrader alpaca broker treats schema-inconsistent numeric fill fields as submit unknown', async () => {
  for (const malformedFill of [
    { filled_qty: 1, filled_avg_price: '100' },
    { filled_qty: '1', filled_avg_price: 100 }
  ]) {
    const broker = createAlpacaBroker({
      mode: 'paper',
      env: {
        APCA_PAPER_BASE_URL: 'https://paper-api.alpaca.markets',
        APCA_PAPER_API_KEY_ID: 'paper-key',
        APCA_PAPER_API_SECRET_KEY: 'paper-secret'
      },
      httpClient: async () => ({
        data: {
          id: 'alpaca-schema-inconsistent-fill',
          client_order_id: 'daytrader-robotrader-AAPL-attempt-contract',
          status: 'filled',
          ...malformedFill
        }
      })
    });

    await assert.rejects(
      () => broker.submitOrder(validOrderInput()),
      err => {
        assert.equal(err.code, SUBMISSION_STATES.UNKNOWN);
        assert.equal(err.submissionAttempted, true);
        assert.deepEqual(err.brokerOrder, {
          id: 'alpaca-schema-inconsistent-fill',
          client_order_id: 'daytrader-robotrader-AAPL-attempt-contract',
          status: 'filled',
          ...malformedFill
        });
        return true;
      }
    );
  }
});

test('robotrader alpaca broker accepts a coherent immediate notional fill', async () => {
  const broker = createAlpacaBroker({
    mode: 'paper',
    env: {
      APCA_PAPER_BASE_URL: 'https://paper-api.alpaca.markets',
      APCA_PAPER_API_KEY_ID: 'paper-key',
      APCA_PAPER_API_SECRET_KEY: 'paper-secret'
    },
    httpClient: async request => ({
      data: {
        id: 'alpaca-notional-fill',
        client_order_id: request.data.client_order_id,
        status: 'filled',
        filled_qty: '0.5',
        filled_avg_price: '200'
      }
    })
  });

  const result = await broker.submitOrder(validOrderInput({
    qty: null,
    notional: 100
  }));

  assert.equal(result.order.id, 'alpaca-notional-fill');
  assert.equal(result.order.status, 'filled');
  assert.equal(result.payload.qty, undefined);
  assert.equal(result.payload.notional, '100');
});

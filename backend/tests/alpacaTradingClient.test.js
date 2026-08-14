const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_ALPACA_CLIENT_ORDER_ID_LENGTH,
  buildAlpacaOrderPayload,
  buildClientOrderId,
  getAlpacaTradingConfig,
  isPaperTradingEndpoint,
  normalizeAlpacaSymbol,
  readAlpacaPaperOrderByClientOrderId,
  shouldSyncPaperTradesToAlpaca,
  submitAlpacaPaperOrder
} = require('../services/alpacaTradingClient');
const {
  SUBMISSION_STATES,
  SUBMIT_UNKNOWN
} = require('../services/submissionOutcomeService');

function paperEnv() {
  return {
    APCA_BASE_URL: 'https://paper-api.alpaca.markets',
    APCA_API_KEY_ID: 'key',
    APCA_API_SECRET_KEY: 'secret'
  };
}

test('generated broker client identities stay unique and within Alpaca canonical limits', () => {
  const now = new Date('2026-07-23T12:34:56.000Z');
  for (const origin of [
    'manual',
    'robotrader',
    'robotrader-stop',
    'an-origin-that-is-deliberately-much-too-long'
  ]) {
    const first = buildClientOrderId({
      origin,
      symbol: 'VERYLONGSYMBOL123456789',
      now
    });
    const second = buildClientOrderId({
      origin,
      symbol: 'VERYLONGSYMBOL123456789',
      now
    });
    assert.ok(first.length <= MAX_ALPACA_CLIENT_ORDER_ID_LENGTH);
    assert.match(first, /^[A-Za-z0-9_-]+$/);
    assert.match(first, /-20260723123456-[a-f0-9]{8}$/);
    assert.notEqual(first, second);
  }
});

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

test('buildAlpacaOrderPayload rejects invalid Alpaca order combinations before submit', () => {
  assert.throws(
    () => buildAlpacaOrderPayload({
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'buy',
      qty: 1,
      orderType: 'bad_type',
      timeInForce: 'day',
      clientOrderId: 'client-invalid-1'
    }),
    /equity orders support/
  );
  assert.throws(
    () => buildAlpacaOrderPayload({
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'buy',
      qty: 1,
      orderType: 'limit',
      timeInForce: 'day',
      clientOrderId: 'client-invalid-2'
    }),
    /positive limitPrice/
  );
  assert.throws(
    () => buildAlpacaOrderPayload({
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'sell',
      qty: 1,
      orderType: 'stop',
      timeInForce: 'day',
      clientOrderId: 'client-invalid-3'
    }),
    /positive stopPrice/
  );
  assert.throws(
    () => buildAlpacaOrderPayload({
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'sell',
      qty: 1,
      orderType: 'trailing_stop',
      timeInForce: 'day',
      clientOrderId: 'client-invalid-4'
    }),
    /positive trailingStopPct/
  );
  assert.throws(
    () => buildAlpacaOrderPayload({
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'buy',
      qty: 1,
      orderType: 'market',
      timeInForce: 'day',
      clientOrderId: 'x'.repeat(MAX_ALPACA_CLIENT_ORDER_ID_LENGTH + 1)
    }),
    /at most 48 characters/
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
          filled_avg_price: '100.25',
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

test('submitAlpacaPaperOrder marks local payload failure as not attempted', async () => {
  let postCalls = 0;
  const httpClient = {
    post: async () => {
      postCalls += 1;
    }
  };

  await assert.rejects(
    () => submitAlpacaPaperOrder({
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'buy',
      qty: 1,
      orderType: 'limit',
      timeInForce: 'day',
      clientOrderId: 'client-preflight'
    }, {
      httpClient,
      env: paperEnv()
    }),
    err => {
      assert.equal(err.submissionOutcome, SUBMISSION_STATES.NOT_ATTEMPTED);
      assert.equal(err.submissionAttempted, false);
      assert.equal(err.submissionPhase, 'pre_submit');
      assert.equal(err.clientOrderId, 'client-preflight');
      return true;
    }
  );
  assert.equal(postCalls, 0);
});

test('submitAlpacaPaperOrder distinguishes confirmed broker rejection from ambiguous failure', async () => {
  const rejectedClient = {
    post: async () => {
      const err = new Error('request failed');
      err.response = {
        status: 422,
        data: {
          code: 42210000,
          message: 'qty is invalid'
        }
      };
      throw err;
    }
  };

  await assert.rejects(
    () => submitAlpacaPaperOrder({
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'buy',
      qty: 1,
      orderType: 'market',
      timeInForce: 'day',
      clientOrderId: 'client-rejected'
    }, {
      httpClient: rejectedClient,
      env: paperEnv()
    }),
    err => {
      assert.equal(err.submissionOutcome, SUBMISSION_STATES.REJECTED);
      assert.equal(err.submissionAttempted, true);
      assert.equal(err.statusCode, 400);
      assert.equal(err.clientOrderId, 'client-rejected');
      return true;
    }
  );

  for (const failure of [
    { code: 'ECONNRESET' },
    { code: 'ETIMEDOUT' },
    { response: { status: 503, data: { message: 'unavailable' } } },
    {
      response: {
        status: 422,
        data: {
          code: 40010001,
          message: 'client_order_id must be unique'
        }
      }
    }
  ]) {
    const ambiguousClient = {
      post: async () => {
        throw Object.assign(new Error('ambiguous broker outcome'), failure);
      }
    };
    await assert.rejects(
      () => submitAlpacaPaperOrder({
        symbol: 'AAPL',
        assetClass: 'equity',
        side: 'buy',
        qty: 1,
        orderType: 'market',
        timeInForce: 'day',
        clientOrderId: 'client-unknown'
      }, {
        httpClient: ambiguousClient,
        env: paperEnv()
      }),
      err => {
        assert.equal(err.code, SUBMIT_UNKNOWN);
        assert.equal(err.submissionOutcome, SUBMIT_UNKNOWN);
        assert.equal(err.statusCode, 409);
        assert.equal(err.clientOrderId, 'client-unknown');
        return true;
      }
    );
  }
});

test('submitAlpacaPaperOrder preserves POST acknowledgement when status polling fails', async () => {
  const httpClient = {
    post: async () => ({
      data: {
        id: 'alpaca-acknowledged',
        status: 'accepted',
        client_order_id: 'client-acknowledged'
      }
    }),
    get: async () => {
      const err = new Error('socket reset while polling');
      err.code = 'ECONNRESET';
      throw err;
    }
  };

  const result = await submitAlpacaPaperOrder({
    symbol: 'AAPL',
    assetClass: 'equity',
    side: 'buy',
    qty: 1,
    orderType: 'market',
    timeInForce: 'day',
    clientOrderId: 'client-acknowledged'
  }, {
    httpClient,
    env: paperEnv(),
    pollStatusAttempts: 1,
    pollStatusDelayMs: 0
  });

  assert.equal(result.order.id, 'alpaca-acknowledged');
  assert.equal(result.order.status, 'accepted');
  assert.equal(result.submissionOutcome, SUBMISSION_STATES.SUBMITTED);
  assert.equal(result.statusRefreshPending, true);
  assert.equal(result.pollError.submissionOutcome, SUBMIT_UNKNOWN);
  assert.equal(result.pollError.submissionPhase, 'status_poll');
  assert.equal(result.pollError.brokerAcknowledged, true);
  assert.equal(result.pollError.clientOrderId, 'client-acknowledged');
});

test('submitAlpacaPaperOrder preserves POST identity on empty, malformed, or mismatched polls', async () => {
  const anomalousPolls = [
    {},
    {
      id: 'alpaca-acknowledged',
      client_order_id: 'client-acknowledged'
    },
    {
      id: 'different-order',
      status: 'filled',
      client_order_id: 'client-acknowledged'
    },
    {
      id: 'alpaca-acknowledged',
      status: 'filled',
      client_order_id: 'different-client'
    }
  ];

  for (const pollBody of anomalousPolls) {
    const result = await submitAlpacaPaperOrder({
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'buy',
      qty: 1,
      orderType: 'market',
      timeInForce: 'day',
      clientOrderId: 'client-acknowledged'
    }, {
      httpClient: {
        post: async () => ({
          data: {
            id: 'alpaca-acknowledged',
            status: 'accepted',
            client_order_id: 'client-acknowledged'
          }
        }),
        get: async () => ({ data: pollBody })
      },
      env: paperEnv(),
      pollStatusAttempts: 1,
      pollStatusDelayMs: 0
    });

    assert.equal(result.order.id, 'alpaca-acknowledged');
    assert.equal(result.order.status, 'accepted');
    assert.equal(result.order.client_order_id, 'client-acknowledged');
    assert.equal(result.submissionOutcome, SUBMISSION_STATES.SUBMITTED);
    assert.equal(result.statusRefreshPending, true);
    assert.equal(result.pollError.code, 'ALPACA_STATUS_POLL_IDENTITY_MISMATCH');
    assert.equal(result.pollError.submissionOutcome, SUBMIT_UNKNOWN);
  }
});

test('submitAlpacaPaperOrder treats malformed acknowledgement as unknown', async () => {
  const httpClient = {
    post: async () => ({
      data: {
        client_order_id: 'client-malformed'
      }
    })
  };

  await assert.rejects(
    () => submitAlpacaPaperOrder({
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'buy',
      qty: 1,
      orderType: 'market',
      timeInForce: 'day',
      clientOrderId: 'client-malformed'
    }, {
      httpClient,
      env: paperEnv()
    }),
    err => {
      assert.equal(err.code, SUBMIT_UNKNOWN);
      assert.equal(err.brokerOrder.client_order_id, 'client-malformed');
      return true;
    }
  );
});

test('submitAlpacaPaperOrder rejects non-canonical broker correlation identifiers', async () => {
  for (const malformedId of [{ proxy: 'bad' }, 123, true, ' alpaca-padded ']) {
    await assert.rejects(
      () => submitAlpacaPaperOrder({
        symbol: 'AAPL',
        assetClass: 'equity',
        side: 'buy',
        qty: 1,
        orderType: 'market',
        timeInForce: 'day',
        clientOrderId: 'client-malformed-id'
      }, {
        httpClient: {
          post: async () => ({
            data: {
              id: malformedId,
              client_order_id: 'client-malformed-id',
              status: 'accepted'
            }
          })
        },
        env: paperEnv()
      }),
      err => {
        assert.equal(err.code, SUBMIT_UNKNOWN);
        assert.deepEqual(err.brokerOrder.id, malformedId);
        return true;
      }
    );
  }
});

test('submitAlpacaPaperOrder rejects filled acknowledgements without complete broker fill evidence', async () => {
  for (const malformedFill of [
    {},
    { filled_qty: '1' },
    { filled_avg_price: '100' },
    { filled_qty: '0', filled_avg_price: '100' },
    { filled_qty: { proxy: 'bad' }, filled_avg_price: '100' },
    { filled_qty: '1', filled_avg_price: { proxy: 'bad' } },
    { filled_qty: 1, filled_avg_price: '100' },
    { filled_qty: '1', filled_avg_price: 100 },
    { filled_qty: true, filled_avg_price: '100' },
    { filled_qty: '1', filled_avg_price: false },
    { filled_qty: '0x10', filled_avg_price: '100' },
    { filled_qty: '+1', filled_avg_price: '100' },
    { filled_qty: '999', filled_avg_price: '100' }
  ]) {
    await assert.rejects(
      () => submitAlpacaPaperOrder({
        symbol: 'AAPL',
        assetClass: 'equity',
        side: 'buy',
        qty: 1,
        orderType: 'market',
        timeInForce: 'day',
        clientOrderId: 'client-malformed-fill'
      }, {
        httpClient: {
          post: async () => ({
            data: {
              id: 'alpaca-malformed-fill',
              client_order_id: 'client-malformed-fill',
              status: 'filled',
              ...malformedFill
            }
          })
        },
        env: paperEnv()
      }),
      err => {
        assert.equal(err.code, SUBMIT_UNKNOWN);
        assert.equal(err.submissionOutcome, SUBMIT_UNKNOWN);
        assert.equal(err.brokerOrder.id, 'alpaca-malformed-fill');
        return true;
      }
    );
  }
});

test('submitAlpacaPaperOrder treats an unrecognized acknowledgement status as unknown', async () => {
  await assert.rejects(
    () => submitAlpacaPaperOrder({
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'buy',
      qty: 1,
      orderType: 'market',
      timeInForce: 'day',
      clientOrderId: 'client-invalid-status'
    }, {
      httpClient: {
        post: async () => ({
          data: {
            id: 'alpaca-invalid-status',
            client_order_id: 'client-invalid-status',
            status: 'not-a-real-alpaca-status'
          }
        })
      },
      env: paperEnv()
    }),
    err => {
      assert.equal(err.code, SUBMIT_UNKNOWN);
      assert.equal(err.submissionOutcome, SUBMIT_UNKNOWN);
      assert.equal(err.clientOrderId, 'client-invalid-status');
      assert.equal(err.brokerOrder.status, 'not-a-real-alpaca-status');
      return true;
    }
  );
});

test('submitAlpacaPaperOrder requires an external ID in the initial acknowledgement', async () => {
  await assert.rejects(
    () => submitAlpacaPaperOrder({
      symbol: 'AAPL',
      assetClass: 'equity',
      side: 'buy',
      qty: 1,
      orderType: 'market',
      timeInForce: 'day',
      clientOrderId: 'client-without-external-id'
    }, {
      httpClient: {
        post: async () => ({
          data: {
            status: 'accepted',
            client_order_id: 'client-without-external-id'
          }
        })
      },
      env: paperEnv()
    }),
    err => {
      assert.equal(err.code, SUBMIT_UNKNOWN);
      assert.equal(err.submissionOutcome, SUBMIT_UNKNOWN);
      assert.equal(err.clientOrderId, 'client-without-external-id');
      return true;
    }
  );
});

test('submitAlpacaPaperOrder rejects missing or mismatched acknowledgement client identities', async t => {
  const cases = [
    {
      name: 'missing client identity',
      response: {
        id: 'alpaca-missing-client',
        status: 'accepted'
      }
    },
    {
      name: 'mismatched client identity',
      response: {
        id: 'alpaca-wrong-client',
        status: 'accepted',
        client_order_id: 'different-client'
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await assert.rejects(
        () => submitAlpacaPaperOrder({
          symbol: 'AAPL',
          assetClass: 'equity',
          side: 'buy',
          qty: 1,
          orderType: 'market',
          timeInForce: 'day',
          clientOrderId: 'client-original'
        }, {
          httpClient: {
            post: async () => ({ data: scenario.response })
          },
          env: paperEnv()
        }),
        err => {
          assert.equal(err.code, SUBMIT_UNKNOWN);
          assert.equal(err.submissionOutcome, SUBMIT_UNKNOWN);
          assert.equal(err.clientOrderId, 'client-original');
          assert.equal(err.brokerOrder.id, scenario.response.id);
          return true;
        }
      );
    });
  }
});

test('readAlpacaPaperOrderByClientOrderId uses the original client identity', async () => {
  const calls = [];
  const result = await readAlpacaPaperOrderByClientOrderId('client-original', {
    env: paperEnv(),
    httpClient: {
      get: async (...args) => {
        calls.push(args);
        return {
          data: {
            id: 'alpaca-original',
            status: 'accepted',
            client_order_id: 'client-original'
          }
        };
      }
    }
  });

  assert.equal(result.id, 'alpaca-original');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://paper-api.alpaca.markets/v2/orders:by_client_order_id');
  assert.equal(calls[0][1].params.client_order_id, 'client-original');
});

test('shouldSyncPaperTradesToAlpaca parses explicit enable flag', () => {
  assert.equal(shouldSyncPaperTradesToAlpaca({ APP_PAPER_TRADES_SYNC_TO_ALPACA: 'true' }), true);
  assert.equal(shouldSyncPaperTradesToAlpaca({ APP_PAPER_TRADES_SYNC_TO_ALPACA: 'false' }), false);
  assert.equal(isPaperTradingEndpoint('https://paper-api.alpaca.markets'), true);
  assert.equal(isPaperTradingEndpoint('https://paper-api.alpaca.markets/v2/'), true);
  assert.equal(isPaperTradingEndpoint('https://paper-api.alpaca.markets.evil.example'), false);
  assert.equal(isPaperTradingEndpoint('https://evil.example/?next=paper-api.alpaca.markets'), false);
});

test('getAlpacaTradingConfig normalizes APCA_BASE_URL with or without /v2', () => {
  assert.equal(
    getAlpacaTradingConfig({ APCA_BASE_URL: 'https://paper-api.alpaca.markets/v2' }).baseUrl,
    'https://paper-api.alpaca.markets'
  );
});

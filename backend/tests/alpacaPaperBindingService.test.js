const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertAlpacaPaperSubmissionBinding,
  isPaperTradingEndpoint,
  normalizeAlpacaPaperEndpoint
} = require('../services/alpacaPaperBindingService');
const {
  createAlpacaBroker,
  getAlpacaConfigForMode
} = require('../robotrader/alpacaBroker');
const {
  getAlpacaTradingConfig,
  submitAlpacaPaperOrder
} = require('../services/alpacaTradingClient');

function releaseEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    LIVE_TRADING_ENABLED: 'false',
    APCA_PAPER_BASE_URL: 'https://paper-api.alpaca.markets',
    APCA_PAPER_API_KEY_ID: 'paper-key',
    APCA_PAPER_API_SECRET_KEY: 'paper-secret',
    APCA_PAPER_ACCOUNT_ID: 'paper-account-1',
    ...overrides
  };
}

test('release paper binding verifies explicit credentials, endpoint, live flag, and account', () => {
  const env = releaseEnv();
  const config = getAlpacaConfigForMode('paper', env);
  const result = assertAlpacaPaperSubmissionBinding({ config, env, account: { id: 'paper-account-1' } });
  assert.equal(result.verified, true);
  assert.equal(result.brokerAccountId, 'paper-account-1');
});

test('release paper configuration cannot fall back to generic credentials', () => {
  const env = releaseEnv({
    APCA_PAPER_API_KEY_ID: '',
    APCA_PAPER_API_SECRET_KEY: '',
    APCA_API_KEY_ID: 'generic-key',
    APCA_API_SECRET_KEY: 'generic-secret'
  });
  const config = getAlpacaConfigForMode('paper', env);
  assert.equal(config.apiKey, '');
  assert.equal(config.apiSecret, '');
  assert.throws(() => assertAlpacaPaperSubmissionBinding({ config, env }), /explicit Alpaca paper credentials/i);
});

test('release paper binding fails closed on live flag or account mismatch', () => {
  const liveEnv = releaseEnv({ LIVE_TRADING_ENABLED: 'true' });
  assert.throws(
    () => assertAlpacaPaperSubmissionBinding({ config: getAlpacaConfigForMode('paper', liveEnv), env: liveEnv }),
    err => err.code === 'PAPER_MVP_LIVE_FLAG_ENABLED'
  );

  const env = releaseEnv();
  assert.throws(
    () => assertAlpacaPaperSubmissionBinding({
      config: getAlpacaConfigForMode('paper', env),
      env,
      account: { id: 'different-account' }
    }),
    err => err.code === 'ALPACA_PAPER_ACCOUNT_MISMATCH'
  );
});

test('paper endpoint binding accepts only the exact normalized Alpaca paper origin', () => {
  for (const endpoint of [
    'https://paper-api.alpaca.markets',
    'https://paper-api.alpaca.markets/',
    'https://paper-api.alpaca.markets/v2',
    'https://paper-api.alpaca.markets/v2/'
  ]) {
    assert.equal(isPaperTradingEndpoint(endpoint), true, endpoint);
    assert.equal(normalizeAlpacaPaperEndpoint(endpoint), 'https://paper-api.alpaca.markets');
  }

  for (const endpoint of [
    'http://paper-api.alpaca.markets',
    'https://paper-api.alpaca.markets.evil.example',
    'https://evil.example/?next=paper-api.alpaca.markets',
    'https://paper-api.alpaca.markets@evil.example',
    'https://user:secret@paper-api.alpaca.markets',
    'https://paper-api.alpaca.markets:444',
    'https://paper-api.alpaca.markets/v2/orders',
    'https://paper-api.alpaca.markets?mode=paper',
    'not-a-url'
  ]) {
    assert.equal(isPaperTradingEndpoint(endpoint), false, endpoint);
    assert.equal(normalizeAlpacaPaperEndpoint(endpoint), null);
  }
});

test('release paper binding rejects paper-host lookalikes before account or broker I/O', () => {
  for (const baseUrl of [
    'https://paper-api.alpaca.markets.evil.example',
    'https://evil.example/?next=paper-api.alpaca.markets'
  ]) {
    const env = releaseEnv({ APCA_PAPER_BASE_URL: baseUrl });
    assert.throws(
      () => assertAlpacaPaperSubmissionBinding({
        config: getAlpacaConfigForMode('paper', env),
        env
      }),
      err => err.code === 'ALPACA_PAPER_ENDPOINT_REQUIRED'
        && err.submissionAttempted === false
    );
  }
});

test('both Alpaca paper adapters reject lookalike endpoints before HTTP', async () => {
  for (const baseUrl of [
    'https://paper-api.alpaca.markets.evil.example',
    'https://evil.example/?next=paper-api.alpaca.markets'
  ]) {
    const env = releaseEnv({ APCA_PAPER_BASE_URL: baseUrl });
    assert.equal(getAlpacaTradingConfig(env).baseUrl, baseUrl);
    assert.equal(getAlpacaConfigForMode('paper', env).baseUrl, baseUrl);

    let manualCalls = 0;
    await assert.rejects(
      () => submitAlpacaPaperOrder({
        symbol: 'AAPL',
        assetClass: 'equity',
        side: 'buy',
        qty: 1,
        orderType: 'market',
        timeInForce: 'day',
        clientOrderId: 'paper-binding-manual'
      }, {
        env,
        httpClient: {
          get: async () => { manualCalls += 1; return { data: {} }; },
          post: async () => { manualCalls += 1; return { data: {} }; }
        }
      }),
      err => err.code === 'ALPACA_PAPER_ENDPOINT_REQUIRED'
    );
    assert.equal(manualCalls, 0);

    const roboCalls = [];
    const broker = createAlpacaBroker({
      mode: 'paper',
      env,
      httpClient: async request => {
        roboCalls.push(request);
        return { data: {} };
      }
    });
    await assert.rejects(
      () => broker.submitOrder({
        symbol: 'AAPL',
        assetClass: 'stocks',
        side: 'buy',
        orderType: 'market',
        orderClass: 'simple',
        timeInForce: 'day',
        qty: 1,
        clientOrderId: 'paper-binding-robo'
      }),
      err => err.code === 'ALPACA_PAPER_ENDPOINT_REQUIRED'
    );
    assert.equal(roboCalls.length, 0);
  }
});

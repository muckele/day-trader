const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlpacaBroker } = require('../robotrader/alpacaBroker');
const { isPaperTradingEndpoint, submitAlpacaPaperOrder } = require('../services/alpacaTradingClient');
const { buildTradingConfig } = require('../config/tradingConfig');
const env = { APCA_API_KEY_ID: 'test-key', APCA_API_SECRET_KEY: 'test-secret', ALPACA_EXPECTED_PAPER_ACCOUNT_ID: 'expected-account' };
const input = { symbol: 'AAPL', side: 'buy', qty: 1, orderType: 'market', timeInForce: 'day' };

test('trusted paper origin excludes lookalikes, credentials, paths and URL decorations', () => {
  for (const url of ['https://paper-api.alpaca.markets.evil.test', 'https://evil.test/paper-api.alpaca.markets', 'https://user:pass@paper-api.alpaca.markets', 'http://paper-api.alpaca.markets', 'https://paper-api.alpaca.markets:444', 'https://paper-api.alpaca.markets?x=1', 'https://paper-api.alpaca.markets#x', 'https://paper-api.alpaca.markets/evil']) assert.equal(isPaperTradingEndpoint(url), false, url);
  assert.equal(isPaperTradingEndpoint('https://paper-api.alpaca.markets/v2/'), true);
});

test('release flags cannot enable live or advanced instruments', () => {
  const config = buildTradingConfig(Object.fromEntries(['LIVE_TRADING_ENABLED', 'SHORT_SELLING_ENABLED', 'MARGIN_TRADING_ENABLED', 'OPTIONS_TRADING_ENABLED', 'CRYPTO_TRADING_ENABLED', 'LEVERAGED_ETF_ENABLED', 'INVERSE_ETF_ENABLED'].map(key => [key, 'true'])));
  for (const key of ['liveTradingEnabled', 'shortSellingEnabled', 'marginEnabled', 'optionsEnabled', 'cryptoEnabled', 'leveragedEtfEnabled', 'inverseEtfEnabled']) assert.equal(config.features[key], false, key);
});

for (const action of ['submitOrder', 'cancelOrder', 'cancelAllOrders', 'replaceOrder', 'closePosition']) {
  const args = { submitOrder: [input], cancelOrder: ['order-1'], cancelAllOrders: [], replaceOrder: ['order-1', { qty: 2 }], closePosition: ['AAPL'] }[action];
  test(`${action} checks designated account before write and disables redirects`, async () => {
    const calls = [];
    let account = 'wrong-account';
    const broker = createAlpacaBroker({ env, httpClient: async request => { calls.push(request); return { data: request.url.endsWith('/account') ? { id: account } : { id: 'order-1' } }; } });
    await assert.rejects(() => broker[action](...args), /account/i);
    assert.equal(calls.filter(c => c.method !== 'get').length, 0);
    account = env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID;
    await broker[action](...args);
    assert.equal(calls.at(-2).url, 'https://paper-api.alpaca.markets/v2/account');
    assert.equal(calls.at(-1).maxRedirects, 0);
    assert.ok(calls.every(c => c.maxRedirects === 0));
  });
}

test('missing account binding and live mode fail before any HTTP call', async () => {
  let calls = 0;
  const httpClient = async () => { calls++; return { data: {} }; };
  await assert.rejects(async () => createAlpacaBroker({ mode: 'live', env, httpClient }).cancelAllOrders(), /paper/i);
  await assert.rejects(() => createAlpacaBroker({ env: { ...env, ALPACA_EXPECTED_PAPER_ACCOUNT_ID: '' }, httpClient }).cancelAllOrders(), /account/i);
  assert.equal(calls, 0);
});

test('manual client verifies account identity and never sends redirected writes', async () => {
  let writes = 0;
  let account = 'unexpected';
  const httpClient = { get: async (url, options) => { assert.equal(options.maxRedirects, 0); return { data: { id: account } }; }, post: async (url, body, options) => { assert.equal(options.maxRedirects, 0); writes++; return { data: { id: 'order-1' } }; } };
  await assert.rejects(() => submitAlpacaPaperOrder(input, { env, httpClient }), /account/i);
  assert.equal(writes, 0);
  account = env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID;
  await submitAlpacaPaperOrder(input, { env, httpClient });
  assert.equal(writes, 1);
});

test('failed identity lookup blocks writes; changing broker identity is rechecked on each call', async () => {
  let reads = 0;
  let writes = 0;
  const broker = createAlpacaBroker({ env, httpClient: async request => {
    if (request.method === 'get') {
      reads++;
      if (reads === 1) throw new Error('account unavailable');
      return { data: { id: reads === 2 ? env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID : 'changed-account' } };
    }
    writes++;
    return { data: {} };
  } });
  await assert.rejects(() => broker.cancelOrder('one'), /unavailable/);
  await broker.cancelOrder('one');
  await assert.rejects(() => broker.cancelOrder('two'), /identity/);
  assert.equal(reads, 3);
  assert.equal(writes, 1);
});

test('configured malicious endpoints never receive credentials even with injected test transport', async () => {
  for (const baseUrl of ['https://paper-api.alpaca.markets.attacker.test', 'https://paper-api.alpaca.markets?redirect=1', 'https://secret@paper-api.alpaca.markets']) {
    let calls = 0;
    const broker = createAlpacaBroker({ env: { ...env, APCA_BASE_URL: baseUrl }, httpClient: async () => { calls++; } });
    assert.equal(broker.isConfigured, false);
    await assert.rejects(() => broker.cancelAllOrders(), /paper endpoint/);
    await assert.rejects(() => submitAlpacaPaperOrder(input, { env: { ...env, APCA_BASE_URL: baseUrl }, httpClient: { post: async () => { calls++; }, get: async () => { calls++; } } }), /paper endpoint/);
    assert.equal(calls, 0);
  }
});

test('stored feature flags cannot override paper-only release restrictions', async t => {
  const FeatureFlag = require('../models/FeatureFlag');
  const mongoState = require('../utils/mongoState');
  t.mock.method(mongoState, 'isMongoReady', () => true);
  t.mock.method(FeatureFlag, 'find', () => ({ lean: async () => [{ key: 'liveTradingEnabled', enabled: true }, { key: 'shortSellingEnabled', enabled: true }] }));
  const { getFeatureFlagsSnapshot } = require('../services/featureFlagService');
  const flags = await getFeatureFlagsSnapshot();
  assert.equal(flags.liveTradingEnabled, false);
  assert.equal(flags.shortSellingEnabled, false);
});

test('trade policy rejects lookalike and live endpoints despite explicitly supplied live flags', async () => {
  const { evaluateTradePolicy } = require('../services/tradePolicyService');
  for (const alpacaBaseUrl of ['https://api.alpaca.markets', 'https://paper-api.alpaca.markets.attacker.test']) {
    const result = await evaluateTradePolicy({ symbol: 'AAPL', side: 'buy', executionBackend: 'alpaca', alpacaBaseUrl, featureFlags: { liveTradingEnabled: true }, riskLimits: {}, config: buildTradingConfig({}) });
    assert.equal(result.ok, false);
  }
});

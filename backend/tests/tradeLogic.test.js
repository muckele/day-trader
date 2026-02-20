const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

test('fetchDaily retries without feed when first response has bars:null', async t => {
  const previousDataUrl = process.env.APCA_DATA_URL;
  const previousKey = process.env.APCA_API_KEY_ID;
  const previousSecret = process.env.APCA_API_SECRET_KEY;
  const previousFeed = process.env.APCA_DATA_FEED;

  process.env.APCA_DATA_URL = 'https://data.alpaca.markets';
  process.env.APCA_API_KEY_ID = 'test-key';
  process.env.APCA_API_SECRET_KEY = 'test-secret';
  process.env.APCA_DATA_FEED = 'iex';

  const tradeLogicPath = require.resolve('../tradeLogic');
  delete require.cache[tradeLogicPath];
  const { fetchDaily } = require('../tradeLogic');

  let callCount = 0;
  const calls = [];
  t.mock.method(axios, 'get', async (url, config) => {
    callCount += 1;
    calls.push({ url, config });
    if (callCount === 1) {
      return {
        data: {
          bars: null,
          next_page_token: null,
          symbol: 'AAPL'
        }
      };
    }
    return {
      data: {
        bars: [
          { t: '2025-01-02T00:00:00Z', o: 100, h: 102, l: 99, c: 101, v: 1200000 }
        ]
      }
    };
  });

  try {
    const bars = await fetchDaily('AAPL');
    assert.equal(Array.isArray(bars), true);
    assert.equal(bars.length, 1);
    assert.equal(bars[0].c, 101);
    assert.equal(callCount, 2);
    assert.equal(calls[0].config.params.feed, 'iex');
    assert.equal('feed' in calls[1].config.params, false);
    assert.ok(calls[0].config.params.start);
    assert.ok(calls[0].config.params.end);
    assert.equal(calls[0].url.endsWith('/v2/stocks/AAPL/bars'), true);
  } finally {
    if (previousDataUrl === undefined) delete process.env.APCA_DATA_URL;
    else process.env.APCA_DATA_URL = previousDataUrl;
    if (previousKey === undefined) delete process.env.APCA_API_KEY_ID;
    else process.env.APCA_API_KEY_ID = previousKey;
    if (previousSecret === undefined) delete process.env.APCA_API_SECRET_KEY;
    else process.env.APCA_API_SECRET_KEY = previousSecret;
    if (previousFeed === undefined) delete process.env.APCA_DATA_FEED;
    else process.env.APCA_DATA_FEED = previousFeed;
  }
});

test('fetchIntraday retries without feed when first response has bars:null', async t => {
  const previousDataUrl = process.env.APCA_DATA_URL;
  const previousKey = process.env.APCA_API_KEY_ID;
  const previousSecret = process.env.APCA_API_SECRET_KEY;
  const previousFeed = process.env.APCA_DATA_FEED;

  process.env.APCA_DATA_URL = 'https://data.alpaca.markets';
  process.env.APCA_API_KEY_ID = 'test-key';
  process.env.APCA_API_SECRET_KEY = 'test-secret';
  process.env.APCA_DATA_FEED = 'iex';

  const tradeLogicPath = require.resolve('../tradeLogic');
  delete require.cache[tradeLogicPath];
  const { fetchIntraday } = require('../tradeLogic');

  let callCount = 0;
  const calls = [];
  t.mock.method(axios, 'get', async (url, config) => {
    callCount += 1;
    calls.push({ url, config });
    if (callCount === 1) {
      return {
        data: {
          bars: null,
          next_page_token: null,
          symbol: 'AAPL'
        }
      };
    }
    return {
      data: {
        bars: [
          { t: '2025-01-02T14:30:00Z', o: 100, h: 101, l: 99.5, c: 100.5, v: 10000 }
        ]
      }
    };
  });

  try {
    const bars = await fetchIntraday('AAPL');
    assert.equal(Array.isArray(bars), true);
    assert.equal(bars.length, 1);
    assert.equal(bars[0].close, 100.5);
    assert.equal(callCount, 2);
    assert.equal(calls[0].config.params.feed, 'iex');
    assert.equal('feed' in calls[1].config.params, false);
    assert.ok(calls[0].config.params.start);
    assert.ok(calls[0].config.params.end);
    assert.equal(calls[0].url.endsWith('/v2/stocks/AAPL/bars'), true);
  } finally {
    if (previousDataUrl === undefined) delete process.env.APCA_DATA_URL;
    else process.env.APCA_DATA_URL = previousDataUrl;
    if (previousKey === undefined) delete process.env.APCA_API_KEY_ID;
    else process.env.APCA_API_KEY_ID = previousKey;
    if (previousSecret === undefined) delete process.env.APCA_API_SECRET_KEY;
    else process.env.APCA_API_SECRET_KEY = previousSecret;
    if (previousFeed === undefined) delete process.env.APCA_DATA_FEED;
    else process.env.APCA_DATA_FEED = previousFeed;
  }
});

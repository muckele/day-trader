const test = require('node:test');
const assert = require('node:assert/strict');
const tradeLogic = require('../tradeLogic');
const mongoState = require('../utils/mongoState');
const RecommendationSnapshot = require('../models/RecommendationSnapshot');
const recommendationEngine = require('../services/recommendationEngine');

function buildBars(closes, { baseVolume = 1000000, range = 1 } = {}) {
  const start = new Date('2025-01-01T00:00:00.000Z');
  return closes.map((close, index) => {
    const previous = index > 0 ? closes[index - 1] : close;
    const open = previous;
    const high = Math.max(open, close) + range;
    const low = Math.min(open, close) - range;
    return {
      t: new Date(start.getTime() + index * 24 * 60 * 60 * 1000).toISOString(),
      o: Number(open.toFixed(2)),
      h: Number(high.toFixed(2)),
      l: Number(low.toFixed(2)),
      c: Number(close.toFixed(2)),
      v: baseVolume
    };
  });
}

function buildTrendingCloses(start = 100, count = 240) {
  const closes = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    price += (i % 7 === 0 ? -0.2 : 0.9);
    closes.push(Number(price.toFixed(2)));
  }
  return closes;
}

function buildLowQualityCloses(start = 20, count = 120) {
  const closes = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    price += i % 2 === 0 ? 0.3 : -0.1;
    closes.push(Number(price.toFixed(2)));
  }
  return closes;
}

test('generateRecommendationLists returns categorized multifactor ideas', async t => {
  const spyBars = buildBars(buildTrendingCloses(400, 240), { baseVolume: 5000000, range: 2 });
  const aaplBars = buildBars(buildTrendingCloses(100, 240), { baseVolume: 1200000, range: 1.1 });
  const xlkBars = buildBars(buildTrendingCloses(150, 240), { baseVolume: 900000, range: 1.3 });

  t.mock.method(tradeLogic, 'fetchDaily', async symbol => {
    if (symbol === 'SPY') return spyBars;
    if (symbol === 'AAPL') return aaplBars;
    if (symbol === 'XLK') return xlkBars;
    throw new Error(`Unexpected symbol ${symbol}`);
  });

  const result = await recommendationEngine.generateRecommendationLists({
    universe: ['AAPL', 'XLK'],
    regime: { trendChop: 'TREND', vol: 'CONTRACTION', risk: 'RISK_ON', notes: [] },
    persist: false
  });

  assert.ok(result.topIdeas.length >= 1);
  assert.ok(Array.isArray(result.lists.momentumLongs));
  assert.ok(result.lists.momentumLongs.some(idea => idea.symbol === 'AAPL'));
  assert.ok(result.lists.etfRotationIdeas.some(idea => idea.symbol === 'XLK'));
  assert.equal(result.topIdeas[0].paperEligible, true);
});

test('persistSnapshot upserts one retained recommendation snapshot per daily key', async t => {
  let upsert = null;

  t.mock.method(mongoState, 'isMongoReady', () => true);
  t.mock.method(RecommendationSnapshot, 'findOneAndUpdate', async (...args) => {
    upsert = args;
    return {};
  });

  const result = await recommendationEngine.persistSnapshot({
    asOf: new Date('2026-01-01T12:00:00.000Z'),
    engineVersion: 'test-v1',
    benchmarkSymbol: 'SPY',
    universe: ['AAPL'],
    regimeKey: 'TREND:CONTRACTION:RISK_ON',
    regime: { trendChop: 'TREND', vol: 'CONTRACTION', risk: 'RISK_ON', notes: [] },
    warnings: [],
    topIdeas: [],
    lists: {}
  });

  assert.equal(result, true);
  assert.match(upsert[0].snapshotKey, /^recommendations:/);
  assert.equal(upsert[1].$set.snapshotKey, upsert[0].snapshotKey);
  assert.ok(upsert[1].$set.expiresAt instanceof Date);
  assert.deepEqual(upsert[2], { upsert: true, new: true, setDefaultsOnInsert: true });
});

test('generateRecommendationLists sends low-quality symbols to do-not-trade list', async t => {
  const spyBars = buildBars(buildTrendingCloses(400, 240), { baseVolume: 5000000, range: 2 });
  const lowQualityBars = buildBars(buildLowQualityCloses(20, 120), { baseVolume: 2000, range: 1.8 });

  t.mock.method(tradeLogic, 'fetchDaily', async symbol => {
    if (symbol === 'SPY') return spyBars;
    if (symbol === 'PENNY') return lowQualityBars;
    throw new Error(`Unexpected symbol ${symbol}`);
  });

  const result = await recommendationEngine.generateRecommendationLists({
    universe: ['PENNY'],
    regime: { trendChop: 'CHOP', vol: 'EXPANSION', risk: 'RISK_OFF', notes: [] },
    persist: false
  });

  assert.equal(result.topIdeas.length, 0);
  assert.equal(result.lists.doNotTrade.length, 1);
  assert.equal(result.lists.doNotTrade[0].symbol, 'PENNY');
  assert.equal(result.lists.doNotTrade[0].paperEligible, false);
  assert.ok(result.lists.doNotTrade[0].disqualifyingRisks.length >= 1);
});

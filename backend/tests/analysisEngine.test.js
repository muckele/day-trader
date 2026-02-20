const test = require('node:test');
const assert = require('node:assert/strict');
const tradeLogic = require('../tradeLogic');
const regimeDetector = require('../signal/regimeDetector');
const { analyzeDeterministic, SETUP_TYPES } = require('../analysisEngine');

function buildBarsFromCloses(closes, { baseVolume = 400000, range = 0.6 } = {}) {
  const start = new Date('2025-01-01T00:00:00.000Z');
  return closes.map((close, index) => {
    const prev = index > 0 ? closes[index - 1] : close;
    const open = prev;
    const high = Math.max(open, close) + range;
    const low = Math.min(open, close) - range;
    const t = new Date(start.getTime() + index * 24 * 60 * 60 * 1000).toISOString();
    return {
      t,
      o: Number(open.toFixed(2)),
      h: Number(high.toFixed(2)),
      l: Number(low.toFixed(2)),
      c: Number(close.toFixed(2)),
      v: baseVolume
    };
  });
}

function buildTrendPullbackCloses() {
  const closes = [];
  let price = 100;
  const mixedDeltas = [
    0.6, -0.4, 0.5, -0.3, 0.7, -0.5, 0.6, -0.4, 0.5, -0.3,
    0.6, -0.5, 0.7, -0.4, 0.5, -0.3, 0.4, -0.2, 0.5, -0.3
  ];
  for (const delta of mixedDeltas) {
    price += delta;
    closes.push(Number(price.toFixed(2)));
  }
  for (let i = 0; i < 45; i += 1) {
    price += 0.9;
    closes.push(Number(price.toFixed(2)));
  }
  for (let i = 0; i < 15; i += 1) {
    price -= 0.6;
    closes.push(price);
  }
  return closes;
}

function buildMeanReversionCloses() {
  const closes = [];
  for (let i = 0; i < 60; i += 1) {
    closes.push(100 + (i % 2 === 0 ? 0.8 : -0.8));
  }
  let price = 100;
  for (let i = 0; i < 10; i += 1) {
    price -= 1;
    closes.push(Number(price.toFixed(2)));
  }
  return closes;
}

test('analyzeDeterministic returns required payload fields', async t => {
  const bars = buildBarsFromCloses(buildTrendPullbackCloses(), { baseVolume: 1200000 });
  t.mock.method(tradeLogic, 'fetchDaily', async () => bars);
  t.mock.method(regimeDetector, 'detectRegime', async () => ({
    trendChop: 'TREND',
    vol: 'CONTRACTION',
    risk: 'RISK_ON',
    notes: []
  }));

  const analysis = await analyzeDeterministic({ symbol: 'AAPL' });

  assert.equal(analysis.symbol, 'AAPL');
  assert.equal(typeof analysis.asOf, 'string');
  assert.equal(typeof analysis.indicators.sma20, 'number');
  assert.equal(typeof analysis.indicators.sma50, 'number');
  assert.equal(typeof analysis.indicators.rsi14, 'number');
  assert.equal(typeof analysis.qualityGate.passed, 'boolean');
  assert.ok(Array.isArray(analysis.qualityGate.reasons));
  assert.ok(Array.isArray(analysis.rationale));
  assert.ok(Array.isArray(analysis.invalidation));
  assert.ok(Object.values(SETUP_TYPES).includes(analysis.setup.setupType));
});

test('analyzeDeterministic classifies TREND_PULLBACK for synthetic uptrend pullback', async t => {
  const bars = buildBarsFromCloses(buildTrendPullbackCloses(), { baseVolume: 1200000 });
  t.mock.method(tradeLogic, 'fetchDaily', async () => bars);
  t.mock.method(regimeDetector, 'detectRegime', async () => ({
    trendChop: 'TREND',
    vol: 'CONTRACTION',
    risk: 'RISK_ON',
    notes: []
  }));

  const analysis = await analyzeDeterministic({ symbol: 'AAPL' });

  assert.equal(analysis.setup.setupType, SETUP_TYPES.TREND_PULLBACK);
  assert.equal(analysis.setup.bias, 'LONG');
});

test('analyzeDeterministic classifies MEAN_REVERSION for choppy oversold series', async t => {
  const bars = buildBarsFromCloses(buildMeanReversionCloses(), { baseVolume: 1200000, range: 0.45 });
  t.mock.method(tradeLogic, 'fetchDaily', async () => bars);
  t.mock.method(regimeDetector, 'detectRegime', async () => ({
    trendChop: 'CHOP',
    vol: 'CONTRACTION',
    risk: 'RISK_OFF',
    notes: []
  }));

  const analysis = await analyzeDeterministic({ symbol: 'AAPL' });

  assert.equal(analysis.setup.setupType, SETUP_TYPES.MEAN_REVERSION);
  assert.equal(analysis.setup.bias, 'LONG');
});

test('confidenceScore stays in range and drops when quality gate fails', async t => {
  const closes = buildTrendPullbackCloses();
  const highLiquidityBars = buildBarsFromCloses(closes, { baseVolume: 1200000, range: 0.5 });
  const lowLiquidityBars = buildBarsFromCloses(closes, { baseVolume: 100, range: 0.5 });

  t.mock.method(regimeDetector, 'detectRegime', async () => ({
    trendChop: 'TREND',
    vol: 'CONTRACTION',
    risk: 'RISK_ON',
    notes: []
  }));

  t.mock.method(tradeLogic, 'fetchDaily', async symbol => {
    if (symbol === 'LOWQ') return lowLiquidityBars;
    return highLiquidityBars;
  });

  const highQuality = await analyzeDeterministic({ symbol: 'HIGHQ' });
  const lowQuality = await analyzeDeterministic({ symbol: 'LOWQ' });

  assert.equal(highQuality.qualityGate.passed, true);
  assert.equal(lowQuality.qualityGate.passed, false);
  assert.ok(highQuality.setup.confidenceScore > lowQuality.setup.confidenceScore);
  assert.ok(highQuality.setup.confidenceScore >= 0 && highQuality.setup.confidenceScore <= 100);
  assert.ok(lowQuality.setup.confidenceScore >= 0 && lowQuality.setup.confidenceScore <= 100);
});

const { evaluateQualityGate } = require('../signal/qualityGate');
const { getStrategy } = require('../signal/strategies');
const { computeScore } = require('../signal/score');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolveStrategy(rec, trendScore) {
  if (rec.recommendation === 'LONG' && rec.indicators?.rsi && rec.indicators.rsi < 35) {
    return 'MEAN_REVERSION_RSI';
  }
  if (rec.recommendation === 'LONG' && trendScore > 0.01) {
    return 'PULLBACK_TREND';
  }
  return 'SMA_CROSS';
}

function buildRecommendation(rec, options = {}) {
  const bias = rec.recommendation === 'LONG' ? 'LONG' : 'SHORT';
  const entryPrice = rec.latestClose;
  const stop = bias === 'LONG'
    ? entryPrice * 0.95
    : entryPrice * 1.05;
  const takeProfit = bias === 'LONG'
    ? entryPrice * 1.1
    : entryPrice * 0.9;

  const trend = Number(rec.sma20) - Number(rec.sma50);
  const trendScore = clamp(trend / Number(rec.sma50 || 1), -1, 1);
  const momentumScore = clamp((entryPrice - Number(rec.sma20)) / Number(rec.sma20 || 1), -1, 1);
  const qualityGate = evaluateQualityGate({
    latestClose: rec.latestClose,
    avgDollarVolume: rec.indicators?.avgDollarVolume,
    atrPct: rec.indicators?.atrPct,
    avgRangePct: rec.indicators?.avgRangePct,
    barsCount: rec.barsCount
  });

  const strategyId = resolveStrategy(rec, trendScore);
  const strategy = getStrategy(strategyId) || {
    strategyId,
    tags: [],
    expectedHold: 'SWING'
  };
  const regime = options.regime || null;
  const score = computeScore({ trendScore, qualityGate, regime, bias });

  return {
    ticker: rec.symbol,
    bias,
    setupType: trendScore >= 0 ? 'Pullback' : 'MeanReversion',
    entry: {
      type: 'ZONE',
      price: Number(entryPrice.toFixed(2)),
      note: 'Based on the latest daily close.'
    },
    risk: {
      stop: Number(stop.toFixed(2)),
      takeProfit: [Number(takeProfit.toFixed(2))],
      timeHorizon: 'SWING',
      positionSizePct: 5
    },
    signals: {
      trend: Number(trendScore.toFixed(2)),
      momentum: Number(momentumScore.toFixed(2)),
      volatility: 0,
      volume: 0,
      sentiment: 0
    },
    score,
    qualityGate,
    regime,
    strategy: {
      strategyId: strategy.strategyId,
      tags: strategy.tags,
      expectedHold: strategy.expectedHold
    },
    rationale: [
      `20-day SMA (${rec.sma20}) vs 50-day SMA (${rec.sma50}) indicates ${bias === 'LONG' ? 'uptrend' : 'downtrend'}.`,
      'Risk plan uses a 5% stop and 10% take-profit from the entry zone.',
      'Recommendation is probabilistic and should be sized cautiously.'
    ],
    invalidation: [
      bias === 'LONG'
        ? 'Close below the 20-day SMA with rising volume.'
        : 'Close above the 20-day SMA with rising volume.'
    ],
    disclaimer: 'Educational purposes only. Not financial advice.'
  };
}

function validateRecommendation(rec) {
  const errors = [];
  if (!rec || typeof rec !== 'object') {
    return { valid: false, errors: ['Recommendation is missing.'] };
  }
  if (!rec.ticker) errors.push('ticker is required');
  if (!rec.bias) errors.push('bias is required');
  if (!rec.entry || typeof rec.entry.price !== 'number') errors.push('entry.price is required');
  if (!rec.risk || typeof rec.risk.stop !== 'number') errors.push('risk.stop is required');
  if (!rec.risk || !Array.isArray(rec.risk.takeProfit)) errors.push('risk.takeProfit is required');
  if (!rec.score || typeof rec.score.value !== 'number') errors.push('score.value is required');
  if (!Array.isArray(rec.rationale)) errors.push('rationale is required');
  if (!Array.isArray(rec.invalidation)) errors.push('invalidation is required');
  if (!rec.qualityGate || typeof rec.qualityGate.passed !== 'boolean') errors.push('qualityGate is required');
  if (!rec.strategy || !rec.strategy.strategyId) errors.push('strategy.strategyId is required');
  if (!rec.regime) errors.push('regime is required');
  return { valid: errors.length === 0, errors };
}

module.exports = { buildRecommendation, validateRecommendation };

const tradeLogic = require('./tradeLogic');
const indicators = require('./signal/indicators');
const { evaluateQualityGate } = require('./signal/qualityGate');
const { config } = require('./signal/signalConfig');
const regimeDetector = require('./signal/regimeDetector');

const SETUP_TYPES = {
  TREND_PULLBACK: 'TREND_PULLBACK',
  BREAKOUT: 'BREAKOUT',
  MEAN_REVERSION: 'MEAN_REVERSION',
  NO_TRADE: 'NO_TRADE'
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function trailingSmaAt(closes, period, endIndex) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  const slice = closes.slice(start, endIndex + 1);
  if (slice.length < period) return null;
  const sum = slice.reduce((acc, value) => acc + value, 0);
  return sum / slice.length;
}

function classifyAtrBucket(atrPct) {
  if (!Number.isFinite(atrPct)) return 'unknown';
  if (atrPct <= config.maxAtrPct * 0.5) return 'low';
  if (atrPct <= config.maxAtrPct) return 'medium';
  return 'high';
}

function classifyRsiBucket(rsi14) {
  if (!Number.isFinite(rsi14)) return 'unknown';
  if (rsi14 < 30) return 'oversold';
  if (rsi14 > 70) return 'overbought';
  return 'neutral';
}

function classifyTrend({ smaSpreadPct, sma20SlopePct }) {
  if (!Number.isFinite(smaSpreadPct) || !Number.isFinite(sma20SlopePct)) return 'CHOP';
  if (Math.abs(smaSpreadPct) >= 2 && Math.abs(sma20SlopePct) >= 0.2) return 'TREND';
  return 'CHOP';
}

function classifySetup({
  trend,
  smaSpreadPct,
  latestClose,
  sma20,
  sma50,
  rsi14,
  atrBucket,
  closes,
  volumes
}) {
  const highest20 = Math.max(...closes.slice(-20));
  const avgVolume20 = volumes.slice(-20).reduce((acc, value) => acc + value, 0) / Math.max(1, Math.min(20, volumes.length));
  const latestVolume = volumes[volumes.length - 1] || 0;
  const closeNear20dHigh = latestClose >= highest20 * 0.995;
  const elevatedVolume = avgVolume20 > 0 && latestVolume >= avgVolume20 * 1.2;
  const recentPullback = Number.isFinite(sma20) && Number.isFinite(sma50) && latestClose < sma20 && latestClose > sma50;

  if (
    trend === 'TREND' &&
    smaSpreadPct > 0 &&
    Number.isFinite(sma50) &&
    latestClose > sma50 &&
    rsi14 >= 35 &&
    rsi14 <= 55 &&
    recentPullback
  ) {
    return { setupType: SETUP_TYPES.TREND_PULLBACK, bias: 'LONG' };
  }

  if (
    trend === 'TREND' &&
    smaSpreadPct > 0 &&
    closeNear20dHigh &&
    elevatedVolume
  ) {
    return { setupType: SETUP_TYPES.BREAKOUT, bias: 'LONG' };
  }

  if (trend === 'CHOP' && atrBucket !== 'high') {
    if (rsi14 < 30) return { setupType: SETUP_TYPES.MEAN_REVERSION, bias: 'LONG' };
    if (rsi14 > 70) return { setupType: SETUP_TYPES.MEAN_REVERSION, bias: 'SHORT' };
  }

  return { setupType: SETUP_TYPES.NO_TRADE, bias: 'NEUTRAL' };
}

function buildLevels({ bias, latestClose, atrValue }) {
  if (!Number.isFinite(latestClose) || !Number.isFinite(atrValue) || atrValue <= 0 || bias === 'NEUTRAL') {
    return {
      entry: round(latestClose),
      stop: null,
      target: null,
      atr: round(atrValue),
      rMultipleAtTarget: null
    };
  }

  if (bias === 'LONG') {
    const entry = latestClose;
    const stop = entry - atrValue;
    const target = entry + (2 * atrValue);
    return {
      entry: round(entry),
      stop: round(stop),
      target: round(target),
      atr: round(atrValue),
      rMultipleAtTarget: round((target - entry) / (entry - stop), 2)
    };
  }

  const entry = latestClose;
  const stop = entry + atrValue;
  const target = entry - (2 * atrValue);
  return {
    entry: round(entry),
    stop: round(stop),
    target: round(target),
    atr: round(atrValue),
    rMultipleAtTarget: round((entry - target) / (stop - entry), 2)
  };
}

function isRsiAligned({ setupType, bias, rsi14 }) {
  if (!Number.isFinite(rsi14)) return false;
  if (setupType === SETUP_TYPES.TREND_PULLBACK) return rsi14 >= 35 && rsi14 <= 55;
  if (setupType === SETUP_TYPES.BREAKOUT && bias === 'LONG') return rsi14 >= 50 && rsi14 <= 75;
  if (setupType === SETUP_TYPES.MEAN_REVERSION && bias === 'LONG') return rsi14 < 30;
  if (setupType === SETUP_TYPES.MEAN_REVERSION && bias === 'SHORT') return rsi14 > 70;
  return false;
}

function computeConfidenceScore({ qualityGatePassed, trend, setupType, rsiAligned, atrBucket, regimeRisk, bias }) {
  let score = 50;
  if (qualityGatePassed) score += 20;
  if (trend === 'TREND' && (setupType === SETUP_TYPES.TREND_PULLBACK || setupType === SETUP_TYPES.BREAKOUT)) score += 10;
  if (rsiAligned) score += 10;
  if (atrBucket === 'high') score -= 15;
  if (regimeRisk === 'RISK_OFF' && bias === 'LONG') score -= 10;
  return clamp(Math.round(score), 0, 100);
}

function buildRationale({
  symbol,
  trend,
  setupType,
  sma20,
  sma50,
  rsi14,
  atrPct,
  qualityGate,
  regime
}) {
  const items = [
    `${symbol} regime is ${trend} with SMA20 ${round(sma20)} vs SMA50 ${round(sma50)}.`,
    `RSI14 is ${round(rsi14)} and ATR% is ${round((atrPct || 0) * 100, 2)}%.`
  ];

  if (setupType === SETUP_TYPES.TREND_PULLBACK) {
    items.push('Trend pullback detected: uptrend intact while price is pulling back into trend support.');
  } else if (setupType === SETUP_TYPES.BREAKOUT) {
    items.push('Breakout conditions detected: close near 20-day high with elevated volume proxy.');
  } else if (setupType === SETUP_TYPES.MEAN_REVERSION) {
    items.push('Mean reversion setup detected in a choppy regime with extreme RSI.');
  } else {
    items.push('No deterministic setup currently meets risk-adjusted criteria.');
  }

  if (!qualityGate.passed && qualityGate.reasons.length) {
    items.push(`Quality gate blocked: ${qualityGate.reasons[0]}`);
  }

  if (regime?.risk) {
    items.push(`Market risk regime is ${regime.risk}.`);
  }

  return items;
}

function buildInvalidation({ setupType, bias }) {
  if (setupType === SETUP_TYPES.NO_TRADE) {
    return ['No trade plan active. Wait for setup alignment before entering.'];
  }
  if (bias === 'LONG') {
    return [
      'Daily close below SMA50 invalidates the long thesis.',
      'RSI14 dropping below 35 weakens momentum alignment.'
    ];
  }
  if (bias === 'SHORT') {
    return [
      'Daily close back above SMA50 invalidates the short thesis.',
      'RSI14 recovering above 65 weakens mean-reversion edge.'
    ];
  }
  return ['Setup invalidated by structural trend change.'];
}

async function analyzeDeterministic({ symbol, strategyId = null, timeframe = '1D' } = {}) {
  const normalizedSymbol = String(symbol || '').toUpperCase().trim();
  if (!normalizedSymbol) {
    const err = new Error('Symbol is required for deterministic analysis.');
    err.code = 'NO_DATA';
    throw err;
  }

  const bars = await tradeLogic.fetchDaily(normalizedSymbol);
  if (!Array.isArray(bars) || bars.length === 0) {
    const err = new Error(`No bars found for ${normalizedSymbol}.`);
    err.code = 'NO_DATA';
    throw err;
  }

  const closes = bars.map(bar => Number(bar.c));
  const volumes = bars.map(bar => Number(bar.v || 0));
  const latestBar = bars[bars.length - 1];
  const latestClose = Number(latestBar.c);
  const latestTimestamp = latestBar.t || null;

  const sma20 = indicators.sma(closes, 20);
  const sma50 = indicators.sma(closes, 50);
  const sma20FiveDaysAgo = trailingSmaAt(closes, 20, closes.length - 6);
  const sma20Slope = Number.isFinite(sma20) && Number.isFinite(sma20FiveDaysAgo)
    ? sma20 - sma20FiveDaysAgo
    : null;
  const smaSpreadPct = Number.isFinite(sma20) && Number.isFinite(sma50) && sma50 !== 0
    ? ((sma20 - sma50) / sma50) * 100
    : null;
  const sma20SlopePct = Number.isFinite(sma20Slope) && Number.isFinite(sma20) && sma20 !== 0
    ? (sma20Slope / sma20) * 100
    : null;

  const atrRaw = indicators.atr(bars, 14);
  const avgRangePct = indicators.averageRangePct(bars, 20);
  const atrValue = Number.isFinite(atrRaw) ? atrRaw : (Number.isFinite(avgRangePct) ? latestClose * avgRangePct : null);
  const atrPct = Number.isFinite(atrValue) && latestClose
    ? atrValue / latestClose
    : null;

  const avgDollarVolume = indicators.averageDollarVolume(bars, 20);
  const rsi14 = indicators.rsi(closes, 14);
  const momentum = closes.length > 20 && closes[closes.length - 21]
    ? ((latestClose - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
    : null;

  const qualityGateRaw = evaluateQualityGate({
    latestClose,
    avgDollarVolume,
    atrPct,
    avgRangePct,
    barsCount: bars.length
  });

  const qualityGate = {
    passed: qualityGateRaw.passed,
    reasons: qualityGateRaw.blockedReasons || [],
    blockedReasons: qualityGateRaw.blockedReasons || [],
    liquidityScore: qualityGateRaw.liquidityScore,
    volatilityScore: qualityGateRaw.volatilityScore
  };

  const rsiBucket = classifyRsiBucket(rsi14);
  const atrBucket = classifyAtrBucket(atrPct);
  const trend = classifyTrend({ smaSpreadPct, sma20SlopePct });

  const { setupType, bias } = classifySetup({
    trend,
    smaSpreadPct,
    latestClose,
    sma20,
    sma50,
    rsi14,
    atrBucket,
    closes,
    volumes
  });

  let regime = null;
  try {
    regime = await regimeDetector.detectRegime();
  } catch (_err) {
    regime = null;
  }

  const rsiAligned = isRsiAligned({ setupType, bias, rsi14 });
  const confidenceScore = computeConfidenceScore({
    qualityGatePassed: qualityGate.passed,
    trend,
    setupType,
    rsiAligned,
    atrBucket,
    regimeRisk: regime?.risk,
    bias
  });

  return {
    asOf: latestTimestamp || new Date().toISOString(),
    symbol: normalizedSymbol,
    strategyId,
    timeframe,
    regime,
    trendFeatures: {
      trend,
      smaSpreadPct: round(smaSpreadPct, 2),
      sma20Slope: Number.isFinite(sma20Slope) ? round(sma20Slope, 2) : null,
      rsiBucket,
      atrPctBucket: atrBucket
    },
    indicators: {
      sma20: round(sma20, 2),
      sma50: round(sma50, 2),
      rsi14: round(rsi14, 2),
      atr: round(atrValue, 2),
      atrPct: Number.isFinite(atrPct) ? round(atrPct * 100, 2) : null,
      momentum: round(momentum, 2)
    },
    qualityGate,
    setup: {
      setupType,
      bias,
      confidenceScore
    },
    levels: buildLevels({
      bias,
      latestClose,
      atrValue
    }),
    rationale: buildRationale({
      symbol: normalizedSymbol,
      trend,
      setupType,
      sma20,
      sma50,
      rsi14,
      atrPct,
      qualityGate,
      regime
    }),
    invalidation: buildInvalidation({ setupType, bias })
  };
}

module.exports = {
  analyzeDeterministic,
  SETUP_TYPES
};

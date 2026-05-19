const tradeLogic = require('../tradeLogic');
const {
  sma,
  atr,
  rsi,
  averageDollarVolume,
  averageRangePct,
  rollingVolatility,
  slope
} = require('../signal/indicators');
const { evaluateQualityGate } = require('../signal/qualityGate');
const { detectRegime } = require('../signal/regimeDetector');
const mongoState = require('../utils/mongoState');
const RecommendationSnapshot = require('../models/RecommendationSnapshot');
const { classifyInstrumentPolicy, getRecommendationUniverse, getTradingConfig } = require('../config/tradingConfig');
const { getFeatureFlagsSnapshot } = require('./featureFlagService');
const { getRiskLimitsSnapshot } = require('./riskConfigService');
const { evaluateTradePolicy, buildRegimeKey } = require('./tradePolicyService');

const STRATEGY_BY_BUCKET = {
  momentumLongs: 'TREND_FOLLOWING_EQUITIES',
  meanReversionSetups: 'MEAN_REVERSION_EQUITIES',
  shortCandidates: 'LONG_SHORT_LITE',
  swingTradeCandidates: 'SWING_BREAKOUT_EQUITIES',
  intradayCandidates: 'TREND_FOLLOWING_EQUITIES',
  etfRotationIdeas: 'ETF_ROTATION',
  optionsCandidates: 'OPTIONS_OVERLAY',
  defensiveHedges: 'DEFENSIVE_HEDGE'
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toPct(value) {
  if (!Number.isFinite(value)) return null;
  return value * 100;
}

function percentChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return (to - from) / from;
}

function signedPctScore(value, positiveBias = true, cap = 0.2) {
  if (!Number.isFinite(value)) return 50;
  const direction = positiveBias ? value : -value;
  return round(clamp((direction / cap) * 50 + 50, 0, 100), 2);
}

function average(values) {
  const items = values.filter(value => Number.isFinite(value));
  if (!items.length) return null;
  return items.reduce((sum, value) => sum + value, 0) / items.length;
}

function maxDrawdownPct(closes, lookback = 60) {
  const slice = closes.slice(-lookback);
  if (!slice.length) return null;
  let peak = slice[0];
  let maxDrawdown = 0;
  for (const close of slice) {
    if (close > peak) peak = close;
    const drawdown = peak > 0 ? (close - peak) / peak : 0;
    if (drawdown < maxDrawdown) maxDrawdown = drawdown;
  }
  return Math.abs(maxDrawdown);
}

function positiveReturnRatio(closes, lookback = 20) {
  const startIndex = Math.max(1, closes.length - lookback + 1);
  let positive = 0;
  let total = 0;
  for (let i = startIndex; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev === 0) continue;
    total += 1;
    if (curr > prev) positive += 1;
  }
  if (!total) return null;
  return positive / total;
}

function trendAlignmentScore({ latestClose, sma20, sma50, sma100, sma200, bullish = true }) {
  const comparisons = bullish
    ? [
        [latestClose, sma20, (left, right) => left > right],
        [sma20, sma50, (left, right) => left > right],
        [sma50, sma100, (left, right) => left > right],
        [sma100, sma200, (left, right) => left > right]
      ]
    : [
        [latestClose, sma20, (left, right) => left < right],
        [sma20, sma50, (left, right) => left < right],
        [sma50, sma100, (left, right) => left < right],
        [sma100, sma200, (left, right) => left < right]
      ];
  const validChecks = comparisons
    .filter(([left, right]) => Number.isFinite(left) && Number.isFinite(right))
    .map(([left, right, comparator]) => comparator(left, right));
  if (!validChecks.length) return 0;
  const passed = validChecks.filter(Boolean).length;
  return round((passed / validChecks.length) * 100, 2);
}

function buildFactorSnapshot({ bars, benchmarkBars, regime, symbol }) {
  const closes = bars.map(bar => Number(bar.c));
  const volumes = bars.map(bar => Number(bar.v || 0));
  const latestBar = bars[bars.length - 1] || {};
  const latestClose = Number(latestBar.c);
  const latestTime = latestBar.t || null;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma100 = sma(closes, 100);
  const sma200 = sma(closes, 200);
  const atr14 = atr(bars, 14);
  const atrPct = Number.isFinite(atr14) && latestClose > 0 ? atr14 / latestClose : null;
  const avgDollarVolume20 = averageDollarVolume(bars, 20);
  const avgRangePct20 = averageRangePct(bars, 20);
  const rsi14 = rsi(closes, 14);
  const rollingVol20 = rollingVolatility(closes, 20);
  const slope20 = slope(closes, 20);
  const momentum20 = percentChange(closes[closes.length - 21], latestClose);
  const momentum60 = percentChange(closes[closes.length - 61], latestClose);
  const benchmarkCloses = Array.isArray(benchmarkBars) ? benchmarkBars.map(bar => Number(bar.c)) : [];
  const benchmarkReturn20 = benchmarkCloses.length >= 21
    ? percentChange(benchmarkCloses[benchmarkCloses.length - 21], benchmarkCloses[benchmarkCloses.length - 1])
    : null;
  const relativeStrength20 = Number.isFinite(momentum20) && Number.isFinite(benchmarkReturn20)
    ? momentum20 - benchmarkReturn20
    : momentum20;
  const drawdown60 = maxDrawdownPct(closes, 60);
  const positiveRatio20 = positiveReturnRatio(closes, 20);
  const closeNear20High = latestClose >= Math.max(...closes.slice(-20)) * 0.99;
  const closeNear20Low = latestClose <= Math.min(...closes.slice(-20)) * 1.01;
  const compressionRatio = average([
    Number.isFinite(avgRangePct20) && Number.isFinite(rollingVol20) && rollingVol20 > 0
      ? avgRangePct20 / rollingVol20
      : null,
    Number.isFinite(atrPct) && Number.isFinite(rollingVol20) && rollingVol20 > 0
      ? atrPct / rollingVol20
      : null
  ]);
  const qualityGate = evaluateQualityGate({
    latestClose,
    avgDollarVolume: avgDollarVolume20,
    atrPct,
    avgRangePct: avgRangePct20,
    barsCount: bars.length
  });

  const longTrendScore = trendAlignmentScore({ latestClose, sma20, sma50, sma100, sma200, bullish: true });
  const shortTrendScore = trendAlignmentScore({ latestClose, sma20, sma50, sma100, sma200, bullish: false });
  const momentumLongScore = average([
    signedPctScore(momentum20, true, 0.18),
    signedPctScore(momentum60, true, 0.3),
    signedPctScore(relativeStrength20, true, 0.12),
    round((positiveRatio20 || 0) * 100, 2)
  ]);
  const momentumShortScore = average([
    signedPctScore(momentum20, false, 0.18),
    signedPctScore(momentum60, false, 0.3),
    signedPctScore(relativeStrength20, false, 0.12),
    round((1 - (positiveRatio20 || 0.5)) * 100, 2)
  ]);
  const liquidityScore = round(clamp((avgDollarVolume20 || 0) / 50000000 * 100, 0, 100), 2);
  const volatilityScore = round(clamp(100 - ((atrPct || 0.08) / 0.08) * 100, 0, 100), 2);
  const riskDisciplineScore = round(clamp(100 - ((drawdown60 || 0.25) / 0.25) * 100, 0, 100), 2);

  const weights = getTradingConfig().recommendation.weights;
  const longComposite = round(
    (longTrendScore * weights.trend)
      + ((momentumLongScore || 50) * weights.momentum)
      + ((signedPctScore(relativeStrength20, true, 0.12)) * weights.relativeStrength)
      + (liquidityScore * weights.liquidity)
      + (volatilityScore * weights.volatility)
      + (riskDisciplineScore * weights.riskDiscipline),
    2
  );
  const shortComposite = round(
    (shortTrendScore * weights.trend)
      + ((momentumShortScore || 50) * weights.momentum)
      + ((signedPctScore(relativeStrength20, false, 0.12)) * weights.relativeStrength)
      + (liquidityScore * weights.liquidity)
      + (volatilityScore * weights.volatility)
      + (riskDisciplineScore * weights.riskDiscipline),
    2
  );
  const choppyRegime = regime?.trendChop !== 'TREND';
  const meanReversionLongScore = round(average([
    signedPctScore((30 - (rsi14 || 50)) / 100, true, 0.3),
    liquidityScore,
    volatilityScore,
    choppyRegime ? 80 : 35
  ]), 2);
  const meanReversionShortScore = round(average([
    signedPctScore(((rsi14 || 50) - 70) / 100, true, 0.3),
    liquidityScore,
    volatilityScore,
    choppyRegime ? 80 : 35
  ]), 2);

  return {
    symbol,
    latestClose,
    latestTime,
    barsCount: bars.length,
    sma20: round(sma20),
    sma50: round(sma50),
    sma100: round(sma100),
    sma200: round(sma200),
    atr14: round(atr14),
    atrPct: round(toPct(atrPct), 2),
    avgDollarVolume20: round(avgDollarVolume20),
    avgRangePct20: round(toPct(avgRangePct20), 2),
    rsi14: round(rsi14),
    rollingVol20: round(toPct(rollingVol20), 2),
    slope20: round(slope20, 4),
    momentum20: round(toPct(momentum20), 2),
    momentum60: round(toPct(momentum60), 2),
    relativeStrength20: round(toPct(relativeStrength20), 2),
    drawdown60: round(toPct(drawdown60), 2),
    positiveRatio20: round((positiveRatio20 || 0) * 100, 2),
    closeNear20High,
    closeNear20Low,
    compressionRatio: round(compressionRatio, 2),
    qualityGate,
    scores: {
      longTrendScore,
      shortTrendScore,
      momentumLongScore: round(momentumLongScore, 2),
      momentumShortScore: round(momentumShortScore, 2),
      liquidityScore,
      volatilityScore,
      riskDisciplineScore,
      longComposite,
      shortComposite,
      meanReversionLongScore,
      meanReversionShortScore
    }
  };
}

function buildStopFramework(bias, latestClose, atrPct) {
  const atrDollars = Number.isFinite(latestClose) && Number.isFinite(atrPct)
    ? latestClose * (atrPct / 100)
    : null;
  if (!Number.isFinite(atrDollars)) return 'Use ATR-informed stop once volatility is available.';
  if (bias === 'SHORT') return `Initial stop about 1.5 ATR above entry (${round(latestClose + (1.5 * atrDollars))}).`;
  return `Initial stop about 1.5 ATR below entry (${round(latestClose - (1.5 * atrDollars))}).`;
}

function buildTakeProfitFramework(bias, latestClose, atrPct) {
  const atrDollars = Number.isFinite(latestClose) && Number.isFinite(atrPct)
    ? latestClose * (atrPct / 100)
    : null;
  if (!Number.isFinite(atrDollars)) return 'Target at least 2R once stop distance is defined.';
  if (bias === 'SHORT') return `Scale out near 2 ATR below entry (${round(latestClose - (2 * atrDollars))}) and trail the remainder.`;
  return `Scale out near 2 ATR above entry (${round(latestClose + (2 * atrDollars))}) and trail the remainder.`;
}

function holdingPeriodForBucket(bucket) {
  if (bucket === 'intradayCandidates') return 'INTRADAY';
  if (bucket === 'meanReversionSetups') return 'SHORT_SWING';
  if (bucket === 'optionsCandidates') return 'TACTICAL';
  return 'SWING';
}

function preferredEntryTypeForBucket(bucket, factors) {
  if (bucket === 'breakout' || factors?.closeNear20High) return 'STOP_LIMIT_BREAKOUT';
  if (bucket === 'shortCandidates') return 'LIMIT_ON_FAILED_BOUNCE';
  if (bucket === 'meanReversionSetups') return 'LIMIT_NEAR_EXTREME';
  return 'LIMIT_ON_PULLBACK';
}

async function applyEligibility(idea, { regime, flags, riskLimits, config }) {
  const paperPolicy = await evaluateTradePolicy({
    symbol: idea.symbol,
    side: idea.bias === 'SHORT' ? 'sell' : 'buy',
    assetClass: idea.assetClass,
    strategyId: idea.strategyId,
    executionBackend: 'paper',
    alpacaBaseUrl: 'https://paper-api.alpaca.markets',
    orderNotional: idea.latestClose,
    regime,
    riskLimits,
    featureFlags: flags,
    config
  });
  const liveBaseUrl = process.env.ALPACA_BASE_URL || process.env.APCA_BASE_URL || 'https://paper-api.alpaca.markets';
  const livePolicy = await evaluateTradePolicy({
    symbol: idea.symbol,
    side: idea.bias === 'SHORT' ? 'sell' : 'buy',
    assetClass: idea.assetClass,
    strategyId: idea.strategyId,
    executionBackend: 'alpaca',
    alpacaBaseUrl: liveBaseUrl,
    orderNotional: idea.latestClose,
    regime,
    riskLimits,
    featureFlags: flags,
    config
  });

  return {
    ...idea,
    paperEligible: paperPolicy.ok,
    liveEligible: livePolicy.ok && flags.liveTradingEnabled,
    disqualifyingRisks: [...idea.disqualifyingRisks, ...paperPolicy.reasons].filter(Boolean)
  };
}

async function buildIdea({ symbol, bucket, bias, factors, regime, flags, riskLimits, config }) {
  const instrument = classifyInstrumentPolicy(symbol, 'equity', config);
  const strategyId = STRATEGY_BY_BUCKET[bucket] || 'TREND_FOLLOWING_EQUITIES';
  const confidenceBase = bucket === 'shortCandidates'
    ? factors.scores.shortComposite
    : bucket === 'meanReversionSetups'
      ? (bias === 'SHORT' ? factors.scores.meanReversionShortScore : factors.scores.meanReversionLongScore)
      : factors.scores.longComposite;
  const regimePenalty = regime?.risk === 'RISK_OFF' && bias === 'LONG' ? 10 : 0;
  const confidenceScore = round(clamp(confidenceBase - regimePenalty, 0, 100));
  const why = [];
  const risks = [];

  if (factors.sma20 && factors.sma50) {
    why.push(`SMA20 ${factors.sma20} vs SMA50 ${factors.sma50} supports ${bias.toLowerCase()} bias.`);
  }
  if (Number.isFinite(factors.relativeStrength20)) {
    why.push(`Relative strength vs benchmark is ${factors.relativeStrength20}%.`);
  }
  if (Number.isFinite(factors.avgDollarVolume20)) {
    why.push(`Average daily dollar volume is about $${factors.avgDollarVolume20.toLocaleString()}.`);
  }
  if (!factors.qualityGate.passed) {
    risks.push(...factors.qualityGate.blockedReasons);
  }
  if ((factors.atrPct || 0) > 6) {
    risks.push('Volatility is elevated relative to conservative execution standards.');
  }
  if ((factors.drawdown60 || 0) > 15) {
    risks.push('Recent drawdown profile is unstable.');
  }
  if (bucket === 'optionsCandidates') {
    why.push('Underlying is liquid enough for options research, but execution remains feature-flagged.');
  }
  if (instrument.isEtf) {
    why.push('ETF instrument profile reduces single-name event concentration.');
  }

  const idea = {
    symbol,
    assetClass: instrument.isEtf ? 'etf' : instrument.assetClass,
    bias,
    confidenceScore,
    thesisTags: [
      bucket === 'momentumLongs' ? 'trend' : null,
      bucket === 'meanReversionSetups' ? 'mean-reversion' : null,
      bucket === 'shortCandidates' ? 'short' : null,
      factors.closeNear20High ? 'near-breakout' : null,
      factors.closeNear20Low ? 'near-breakdown' : null,
      instrument.isEtf ? 'etf' : 'equity'
    ].filter(Boolean),
    whyItRankedHighly: why,
    disqualifyingRisks: risks,
    preferredEntryType: preferredEntryTypeForBucket(bucket, factors),
    suggestedStopFramework: buildStopFramework(bias, factors.latestClose, factors.atrPct),
    suggestedTakeProfitFramework: buildTakeProfitFramework(bias, factors.latestClose, factors.atrPct),
    suggestedHoldingPeriod: holdingPeriodForBucket(bucket),
    strategyBucket: bucket,
    strategyId,
    latestClose: factors.latestClose,
    qualityGate: factors.qualityGate,
    factors: {
      latestClose: factors.latestClose,
      latestTime: factors.latestTime,
      sma20: factors.sma20,
      sma50: factors.sma50,
      sma100: factors.sma100,
      sma200: factors.sma200,
      atr14: factors.atr14,
      atrPct: factors.atrPct,
      avgDollarVolume20: factors.avgDollarVolume20,
      avgRangePct20: factors.avgRangePct20,
      rsi14: factors.rsi14,
      momentum20: factors.momentum20,
      momentum60: factors.momentum60,
      relativeStrength20: factors.relativeStrength20,
      drawdown60: factors.drawdown60,
      positiveRatio20: factors.positiveRatio20,
      compressionRatio: factors.compressionRatio,
      scores: factors.scores
    }
  };

  return applyEligibility(idea, { regime, flags, riskLimits, config });
}

function isIdeaCandidate({ bucket, bias, factors, flags, regime, instrument }) {
  if (!factors.qualityGate.passed) return false;
  if (bucket === 'momentumLongs') {
    return (factors.scores.longComposite || 0) >= 60 && regime?.risk !== 'RISK_OFF';
  }
  if (bucket === 'shortCandidates') {
    return flags.shortSellingEnabled && (factors.scores.shortComposite || 0) >= 60;
  }
  if (bucket === 'meanReversionSetups') {
    if (bias === 'LONG') return (factors.rsi14 || 50) <= 35 && regime?.trendChop !== 'TREND';
    return flags.shortSellingEnabled && (factors.rsi14 || 50) >= 65 && regime?.trendChop !== 'TREND';
  }
  if (bucket === 'swingTradeCandidates') {
    return Math.max(factors.scores.longComposite || 0, factors.scores.shortComposite || 0) >= 58;
  }
  if (bucket === 'intradayCandidates') {
    return (factors.avgDollarVolume20 || 0) >= 100000000 && (factors.atrPct || 0) >= 1.2 && (factors.atrPct || 0) <= 6;
  }
  if (bucket === 'etfRotationIdeas') {
    return instrument.isEtf && (factors.scores.longComposite || 0) >= 55;
  }
  if (bucket === 'optionsCandidates') {
    return (factors.avgDollarVolume20 || 0) >= 150000000 && Math.max(factors.scores.longComposite || 0, factors.scores.shortComposite || 0) >= 65;
  }
  if (bucket === 'defensiveHedges') {
    return instrument.isEtf && regime?.risk === 'RISK_OFF' && (factors.scores.longComposite || 0) >= 50;
  }
  return false;
}

async function persistSnapshot(snapshot) {
  if (!mongoState.isMongoReady()) return false;
  try {
    await RecommendationSnapshot.create(snapshot);
    return true;
  } catch (_err) {
    return false;
  }
}

async function analyzeSymbol(symbol, context) {
  const bars = await tradeLogic.fetchDaily(symbol);
  if (!Array.isArray(bars) || bars.length === 0) {
    const err = new Error(`Could not fetch daily bars for ${symbol}: no bars returned`);
    err.code = 'DATA_UNAVAILABLE';
    throw err;
  }

  const factors = buildFactorSnapshot({
    symbol,
    bars,
    benchmarkBars: context.benchmarkBars,
    regime: context.regime
  });
  const instrument = classifyInstrumentPolicy(symbol, 'equity', context.config);

  const lists = {
    momentumLongs: [],
    meanReversionSetups: [],
    shortCandidates: [],
    swingTradeCandidates: [],
    intradayCandidates: [],
    etfRotationIdeas: [],
    optionsCandidates: [],
    defensiveHedges: [],
    doNotTrade: []
  };

  const candidates = [];
  const candidateDefinitions = [
    { bucket: 'momentumLongs', bias: 'LONG' },
    { bucket: 'meanReversionSetups', bias: 'LONG' },
    { bucket: 'meanReversionSetups', bias: 'SHORT' },
    { bucket: 'shortCandidates', bias: 'SHORT' },
    { bucket: 'swingTradeCandidates', bias: factors.scores.longComposite >= factors.scores.shortComposite ? 'LONG' : 'SHORT' },
    { bucket: 'intradayCandidates', bias: factors.scores.longComposite >= factors.scores.shortComposite ? 'LONG' : 'SHORT' },
    { bucket: 'etfRotationIdeas', bias: 'LONG' },
    { bucket: 'optionsCandidates', bias: factors.scores.longComposite >= factors.scores.shortComposite ? 'LONG' : 'SHORT' },
    { bucket: 'defensiveHedges', bias: 'LONG' }
  ];

  for (const definition of candidateDefinitions) {
    if (!isIdeaCandidate({
      bucket: definition.bucket,
      bias: definition.bias,
      factors,
      flags: context.flags,
      regime: context.regime,
      instrument
    })) {
      continue;
    }

    const idea = await buildIdea({
      symbol,
      bucket: definition.bucket,
      bias: definition.bias,
      factors,
      regime: context.regime,
      flags: context.flags,
      riskLimits: context.riskLimits,
      config: context.config
    });
    lists[definition.bucket].push(idea);
    candidates.push(idea);
  }

  if (!candidates.length) {
    lists.doNotTrade.push({
      symbol,
      assetClass: instrument.isEtf ? 'etf' : instrument.assetClass,
      bias: 'NEUTRAL',
      confidenceScore: round(clamp(Math.max(factors.scores.longComposite || 0, factors.scores.shortComposite || 0), 0, 49)),
      thesisTags: ['filtered'],
      whyItRankedHighly: factors.qualityGate.passed
        ? ['Setup did not reach the minimum confidence threshold for active deployment.']
        : ['Symbol failed the quality gate for safe execution.'],
      disqualifyingRisks: factors.qualityGate.passed
        ? ['Insufficient edge after regime and risk adjustments.']
        : factors.qualityGate.blockedReasons,
      preferredEntryType: 'NONE',
      suggestedStopFramework: 'No active trade plan.',
      suggestedTakeProfitFramework: 'No active trade plan.',
      suggestedHoldingPeriod: 'NONE',
      strategyBucket: 'doNotTrade',
      strategyId: null,
      paperEligible: false,
      liveEligible: false,
      qualityGate: factors.qualityGate,
      factors: {
        latestClose: factors.latestClose,
        rsi14: factors.rsi14,
        atrPct: factors.atrPct,
        avgDollarVolume20: factors.avgDollarVolume20,
        scores: factors.scores
      }
    });
  }

  return { symbol, factors, lists };
}

function sortIdeas(ideas) {
  return [...ideas].sort((a, b) => Number(b.confidenceScore || 0) - Number(a.confidenceScore || 0));
}

function uniqueIdeasBySymbolAndBias(ideas) {
  const seen = new Set();
  return ideas.filter(idea => {
    const key = `${idea.symbol}:${idea.bias}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function generateRecommendationLists(options = {}) {
  const config = getTradingConfig();
  const universe = Array.from(new Set((options.universe || getRecommendationUniverse()).map(symbol => String(symbol || '').toUpperCase()).filter(Boolean)));
  const flags = await getFeatureFlagsSnapshot();
  const riskLimits = await getRiskLimitsSnapshot();
  const regime = options.regime || await detectRegime();
  const benchmarkSymbol = config.recommendation.benchmarkSymbol;
  const warnings = [];

  let benchmarkBars = [];
  try {
    benchmarkBars = await tradeLogic.fetchDaily(benchmarkSymbol);
  } catch (err) {
    warnings.push(`Benchmark ${benchmarkSymbol} unavailable: ${err.message}`);
  }

  const context = { config, flags, riskLimits, regime, benchmarkBars };
  const settled = await Promise.allSettled(universe.map(symbol => analyzeSymbol(symbol, context)));
  const lists = {
    momentumLongs: [],
    meanReversionSetups: [],
    shortCandidates: [],
    swingTradeCandidates: [],
    intradayCandidates: [],
    etfRotationIdeas: [],
    optionsCandidates: [],
    defensiveHedges: [],
    doNotTrade: []
  };
  const failures = [];

  settled.forEach((result, index) => {
    const symbol = universe[index];
    if (result.status !== 'fulfilled') {
      failures.push({ symbol, error: result.reason });
      return;
    }
    Object.keys(lists).forEach(bucket => {
      lists[bucket].push(...result.value.lists[bucket]);
    });
  });

  Object.keys(lists).forEach(bucket => {
    lists[bucket] = sortIdeas(lists[bucket]).slice(0, config.recommendation.maxIdeasPerList);
  });

  const topIdeas = uniqueIdeasBySymbolAndBias(sortIdeas([
    ...lists.momentumLongs,
    ...lists.shortCandidates,
    ...lists.meanReversionSetups,
    ...lists.swingTradeCandidates,
    ...lists.etfRotationIdeas,
    ...lists.defensiveHedges
  ])).slice(0, config.recommendation.topRecommendationCount);

  if (!topIdeas.length && failures.length === universe.length) {
    const firstError = failures[0]?.error;
    const err = new Error(firstError?.message || 'Could not fetch daily bars');
    err.code = firstError?.code || 'DATA_UNAVAILABLE';
    throw err;
  }

  if (failures.length) {
    warnings.push(`Partial data unavailable for ${failures.length} symbol(s).`);
  }

  const payload = {
    asOf: new Date(),
    engineVersion: config.recommendation.engineVersion,
    benchmarkSymbol,
    universe,
    regime,
    warnings,
    featureFlags: flags,
    riskLimits,
    regimeKey: buildRegimeKey(regime),
    topIdeas,
    lists
  };

  const persisted = options.persist === false ? false : await persistSnapshot(payload);
  return {
    ...payload,
    persisted
  };
}

module.exports = {
  STRATEGY_BY_BUCKET,
  analyzeSymbol,
  buildFactorSnapshot,
  generateRecommendationLists
};

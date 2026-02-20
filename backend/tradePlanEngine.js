const { DEFAULT_WATCHLIST } = require('./data/defaultWatchlist');
const TradePlan = require('./models/TradePlan');
const PaperTrade = require('./models/PaperTrade');
const PaperSettings = require('./models/PaperSettings');
const RegimeSnapshot = require('./models/RegimeSnapshot');
const { detectRegime } = require('./signal/regimeDetector');
const { buildRecommendation } = require('./utils/recommendationSchema');
const { getRecommendations, fetchDaily } = require('./tradeLogic');
const { computeRMultiple, parseRange } = require('./analytics/analyticsUtils');
const { STRATEGIES } = require('./signal/strategies');

const DEFAULT_MAX_IDEAS = 5;
const DEFAULT_MAX_EXPOSURE_PCT = 20;
const MIN_STRATEGY_TRADES = 15;
const MIN_ALIGN_NEUTRAL_TRADES = 3;
const ALIGNMENT_PENALTY_TRADES = 5;
const MIN_SHARPE = 0.2;

function canGeneratePlan(marketStatus) {
  return marketStatus === 'OPEN';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sum(values) {
  return values.reduce((acc, value) => acc + value, 0);
}

function stdDev(values) {
  if (values.length <= 1) return 0;
  const mean = sum(values) / values.length;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function normalizeExpectancy(expectancy) {
  return clamp((expectancy + 1) / 3, 0, 1) * 100;
}

function normalizeSharpe(sharpeLike) {
  const capped = Math.min(sharpeLike, 5);
  return clamp(capped / 2, 0, 1) * 100;
}

function getPlanDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function getTodayRegime() {
  const today = getPlanDate();
  let snapshot = await RegimeSnapshot.findOne({ date: today }).lean();
  if (!snapshot) {
    const detected = await detectRegime();
    snapshot = await RegimeSnapshot.create({
      date: today,
      trendChop: detected.trendChop,
      vol: detected.vol,
      risk: detected.risk,
      notes: detected.notes
    });
  }
  return snapshot;
}

function matchScore(tradeRegime, currentRegime) {
  if (!tradeRegime || !currentRegime) return 0;
  let score = 0;
  if (tradeRegime.trendChop && tradeRegime.trendChop === currentRegime.trendChop) score += 1;
  if (tradeRegime.vol && tradeRegime.vol === currentRegime.vol) score += 1;
  if (tradeRegime.risk && tradeRegime.risk === currentRegime.risk) score += 1;
  return score;
}

function rankStrategies(trades, regime, strategies = STRATEGIES) {
  const map = {};
  strategies.forEach(strategy => {
    map[strategy.strategyId] = {
      strategyId: strategy.strategyId,
      tradeCount: 0,
      wins: 0,
      rValues: [],
      alignedTrades: 0,
      alignedWins: 0,
      cumulativePnl: 0,
      peakPnl: 0,
      maxDrawdown: 0
    };
  });

  const orderedTrades = [...trades].sort((a, b) => {
    const aTime = a.filledAt ? new Date(a.filledAt).getTime() : 0;
    const bTime = b.filledAt ? new Date(b.filledAt).getTime() : 0;
    return aTime - bTime;
  });

  orderedTrades.forEach(trade => {
    if (!trade.strategyId || !map[trade.strategyId]) return;
    const entry = map[trade.strategyId];
    entry.tradeCount += 1;
    if (trade.realizedPnl > 0) entry.wins += 1;
    const r = computeRMultiple(trade);
    if (r !== null && Number.isFinite(r)) {
      entry.rValues.push(r);
    }

    const aligned = matchScore(trade.regimeAtTrade, regime);
    if (aligned >= 2) {
      entry.alignedTrades += 1;
      if (trade.realizedPnl > 0) entry.alignedWins += 1;
    }

    const realizedPnl = Number.isFinite(trade.realizedPnl) ? trade.realizedPnl : 0;
    entry.cumulativePnl += realizedPnl;
    if (entry.cumulativePnl > entry.peakPnl) entry.peakPnl = entry.cumulativePnl;
    const drawdown = entry.peakPnl - entry.cumulativePnl;
    if (drawdown > entry.maxDrawdown) entry.maxDrawdown = drawdown;
  });

  return Object.values(map)
    .map(entry => {
      const winRate = entry.tradeCount ? (entry.wins / entry.tradeCount) * 100 : 0;
      const expectancy = entry.rValues.length ? sum(entry.rValues) / entry.rValues.length : null;
      const stdDevR = entry.rValues.length > 1 ? stdDev(entry.rValues) : 0;
      const sharpeLikeRaw = stdDevR === 0
        ? (expectancy || 0)
        : expectancy / stdDevR;
      const sharpeLike = Math.min(sharpeLikeRaw, 5);
      const hasRecentWindow = entry.rValues.length >= 5;
      const recentValues = hasRecentWindow ? entry.rValues.slice(-5) : [];
      const recentAvgR = hasRecentWindow ? sum(recentValues) / recentValues.length : null;
      const maxDrawdownPct = entry.peakPnl > 0 ? (entry.maxDrawdown / entry.peakPnl) * 100 : 0;

      if (entry.tradeCount < MIN_STRATEGY_TRADES) {
        return null;
      }
      if (!Number.isFinite(expectancy) || expectancy <= 0) {
        return null;
      }
      if (!Number.isFinite(stdDevR) || stdDevR >= 2 * Math.abs(expectancy)) {
        return null;
      }
      if (!Number.isFinite(sharpeLike) || sharpeLike <= MIN_SHARPE) {
        return null;
      }

      const alignmentScore = entry.alignedTrades < MIN_ALIGN_NEUTRAL_TRADES
        ? 50
        : (entry.alignedWins / entry.alignedTrades) * 100;
      const normalizedExpectancy = normalizeExpectancy(expectancy);
      const sharpeNormalized = normalizeSharpe(sharpeLike);
      let score = normalizedExpectancy * 0.5 + alignmentScore * 0.2 + winRate * 0.1 + sharpeNormalized * 0.2;

      if (entry.alignedTrades >= ALIGNMENT_PENALTY_TRADES && alignmentScore < 50) {
        score *= 0.7;
      }

      if (hasRecentWindow && recentAvgR !== null) {
        if (recentAvgR < 0) {
          score *= 0.6;
        } else if (recentAvgR > expectancy) {
          score *= 1.1;
        }
      }

      return {
        strategyId: entry.strategyId,
        score: Number(score.toFixed(2)),
        expectancy: expectancy !== null ? Number(expectancy.toFixed(2)) : null,
        avgR: expectancy !== null ? Number(expectancy.toFixed(2)) : null,
        stdDevR: Number(stdDevR.toFixed(2)),
        sharpeLike: Number(sharpeLike.toFixed(2)),
        sharpeNormalized: Number(sharpeNormalized.toFixed(2)),
        maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
        recentAvgR: recentAvgR !== null ? Number(recentAvgR.toFixed(2)) : null,
        winRate: Number(winRate.toFixed(2)),
        alignmentScore: Number(alignmentScore.toFixed(2)),
        tradeCount: entry.tradeCount,
        sampleAdjusted: false
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

async function getSettings(accountId) {
  let settings = await PaperSettings.findOne({ accountId });
  if (!settings) {
    settings = await PaperSettings.create({ accountId });
  }
  return settings;
}

function applyExposureCap(ideas, maxExposurePct) {
  const capped = [];
  let total = 0;
  ideas.forEach(idea => {
    const remaining = maxExposurePct - total;
    if (remaining <= 0) return;
    const size = Math.min(idea.positionSizePct, remaining);
    if (size <= 0) return;
    capped.push({ ...idea, positionSizePct: Number(size.toFixed(2)) });
    total += size;
  });
  return {
    tradeIdeas: capped,
    totalSuggestedExposurePct: Number(total.toFixed(2))
  };
}

function buildPlanOutcome({ rankedStrategies, tradeIdeas, totalSuggestedExposurePct }) {
  if (!rankedStrategies.length) {
    return {
      tradeIdeas: [],
      totalSuggestedExposurePct: 0,
      notes: 'No statistically stable strategies today.'
    };
  }

  return {
    tradeIdeas,
    totalSuggestedExposurePct,
    notes: tradeIdeas.length ? '' : 'No eligible ideas passed the quality gate.'
  };
}

function buildTradeIdea(rec, strategyStats, settings, regime) {
  const baseSize = Math.min(rec.risk.positionSizePct || 5, settings.maxPositionPct || 5);
  const regimePenalty = regime?.trendChop === 'CHOP' && regime?.vol === 'EXPANSION' ? 0.75 : 1;
  const positionSizePct = Number((baseSize * regimePenalty).toFixed(2));
  const alignmentScore = strategyStats?.alignmentScore ?? 50;
  const weightFactor = strategyStats?.score ? strategyStats.score / 100 : 0.5;
  const baseScore = Number(rec.score?.value || 0);
  const confidenceScore = clamp(((baseScore + alignmentScore) / 2) * weightFactor, 0, 100);

  return {
    symbol: rec.ticker,
    strategyId: rec.strategy.strategyId,
    bias: rec.bias,
    entry: rec.entry.price,
    stop: rec.risk.stop,
    target: rec.risk.takeProfit?.[0] ?? rec.entry.price,
    positionSizePct,
    signalScore: baseScore,
    confidenceScore: Number(confidenceScore.toFixed(0)),
    alignmentScore: Number(alignmentScore.toFixed(0)),
    reason: rec.rationale?.[0] || 'Signal aligns with top-ranked strategy.'
  };
}

async function buildTradeIdeas({
  watchlistSymbols,
  regime,
  rankedStrategies,
  settings,
  maxIdeas = DEFAULT_MAX_IDEAS,
  maxExposurePct = DEFAULT_MAX_EXPOSURE_PCT
}) {
  const topStrategies = rankedStrategies.slice(0, 3);
  const strategyMap = topStrategies.reduce((acc, item) => {
    acc[item.strategyId] = item;
    return acc;
  }, {});

  const recResults = await Promise.allSettled(
    watchlistSymbols.map(symbol => getRecommendations(symbol))
  );

  const candidates = [];

  for (let i = 0; i < recResults.length; i += 1) {
    if (candidates.length >= maxIdeas) break;
    const result = recResults[i];
    if (result.status !== 'fulfilled') continue;
    const rawRec = result.value;
    if (rawRec.recommendation === 'HOLD') continue;
    const rec = buildRecommendation(rawRec, { regime });
    if (!rec.qualityGate?.passed) continue;
    const strategyId = rec.strategy?.strategyId;
    if (!strategyId || !strategyMap[strategyId]) continue;

    const idea = buildTradeIdea(rec, strategyMap[strategyId], settings, regime);
    if (idea.positionSizePct <= 0) continue;
    candidates.push(idea);
  }

  return applyExposureCap(candidates, maxExposurePct);
}

async function generateTradePlan({
  accountId = 'default',
  watchlist = DEFAULT_WATCHLIST,
  maxIdeas = DEFAULT_MAX_IDEAS,
  maxExposurePct = DEFAULT_MAX_EXPOSURE_PCT
}) {
  const regime = await getTodayRegime();
  const settings = await getSettings(accountId);
  const startDate = parseRange('30d');
  const trades = await PaperTrade.find({
    accountId,
    ...(startDate ? { filledAt: { $gte: startDate } } : {})
  }).lean();

  const rankedStrategies = rankStrategies(trades, regime);
  const watchlistSymbols = watchlist.map(item => item.symbol.toUpperCase());
  let tradeIdeas = [];
  let totalSuggestedExposurePct = 0;
  if (rankedStrategies.length) {
    const ideasResult = await buildTradeIdeas({
      watchlistSymbols,
      regime,
      rankedStrategies,
      settings,
      maxIdeas,
      maxExposurePct
    });
    tradeIdeas = ideasResult.tradeIdeas;
    totalSuggestedExposurePct = ideasResult.totalSuggestedExposurePct;
  }
  const planOutcome = buildPlanOutcome({ rankedStrategies, tradeIdeas, totalSuggestedExposurePct });

  const plan = await TradePlan.create({
    accountId,
    date: getPlanDate(),
    marketStatus: 'OPEN',
    regime: {
      date: regime?.date || null,
      trendChop: regime?.trendChop || null,
      vol: regime?.vol || null,
      risk: regime?.risk || null,
      notes: regime?.notes || []
    },
    rankedStrategies,
    tradeIdeas: planOutcome.tradeIdeas,
    totalSuggestedExposurePct: planOutcome.totalSuggestedExposurePct,
    notes: planOutcome.notes
  });

  return plan;
}

async function rescoreTradePlan(plan, accountId = 'default') {
  if (!plan) return null;
  const regime = await getTodayRegime();
  const startDate = parseRange('30d');
  const trades = await PaperTrade.find({
    accountId,
    ...(startDate ? { filledAt: { $gte: startDate } } : {})
  }).lean();
  const rankedStrategies = rankStrategies(trades, regime);
  const strategyMap = rankedStrategies.reduce((acc, item) => {
    acc[item.strategyId] = item;
    return acc;
  }, {});

  const tradeIdeas = plan.tradeIdeas.map(idea => {
    const stats = strategyMap[idea.strategyId];
    if (!stats) return idea;
    const alignmentScore = stats.alignmentScore;
    const weightFactor = stats.score ? stats.score / 100 : 0.5;
    const baseScore = idea.signalScore || 0;
    const confidenceScore = clamp(((baseScore + alignmentScore) / 2) * weightFactor, 0, 100);
    return {
      ...idea,
      alignmentScore: Number(alignmentScore.toFixed(0)),
      confidenceScore: Number(confidenceScore.toFixed(0))
    };
  });

  const updated = await TradePlan.findByIdAndUpdate(
    plan._id,
    {
      $set: {
        rankedStrategies,
        tradeIdeas,
        regime: {
          date: regime?.date || null,
          trendChop: regime?.trendChop || null,
          vol: regime?.vol || null,
          risk: regime?.risk || null,
          notes: regime?.notes || []
        }
      }
    },
    { new: true }
  ).lean();

  return updated;
}

async function linkTradeToPlan(trade, accountId = 'default') {
  if (!trade?.strategyId) return null;
  const date = getPlanDate(trade.filledAt ? new Date(trade.filledAt) : new Date());
  const plan = await TradePlan.findOne({ accountId, date });
  if (!plan) return null;
  const matched = applyTradeToPlan(plan, trade);
  if (!matched) return null;
  await plan.save();

  await PaperTrade.findByIdAndUpdate(trade._id, { $set: { tradePlanId: plan._id } });
  return plan._id;
}

function applyTradeToPlan(plan, trade) {
  if (!plan || !trade?.strategyId) return null;
  const idea = plan.tradeIdeas.find(
    item =>
      item.symbol === trade.symbol
      && item.strategyId === trade.strategyId
      && item.status === 'PENDING'
  );
  if (!idea) return null;
  idea.status = 'EXECUTED';
  idea.executedTradeId = trade._id;
  idea.executedAt = trade.filledAt || new Date();
  return idea;
}

function computePlanStats(plan, trades) {
  const plannedCount = plan.tradeIdeas.length;
  const executedTrades = trades || [];
  const executedCount = executedTrades.length;
  const wins = executedTrades.filter(trade => trade.realizedPnl > 0).length;
  const winRatePlanned = executedCount ? Number(((wins / executedCount) * 100).toFixed(2)) : 0;
  const rValues = executedTrades
    .map(trade => computeRMultiple(trade))
    .filter(value => value !== null && Number.isFinite(value));
  const planExpectancy = rValues.length
    ? Number((rValues.reduce((sum, value) => sum + value, 0) / rValues.length).toFixed(2))
    : null;

  return {
    plannedCount,
    executedCount,
    winRatePlanned,
    planExpectancy
  };
}

function findBarForDate(bars, date) {
  if (!bars || !bars.length) return null;
  return bars.find(bar => {
    const barDate = new Date(bar.t || bar.date).toISOString().slice(0, 10);
    return barDate === date;
  });
}

async function detectMissedWinners(plan, barsBySymbol = {}, options = {}) {
  if (!plan?.tradeIdeas?.length) return 0;
  const skipFetch = options.skipFetch || false;
  let missed = 0;
  for (const idea of plan.tradeIdeas) {
    if (idea.status === 'EXECUTED') continue;
    let bars = barsBySymbol[idea.symbol];
    if (!bars && !skipFetch) {
      try {
        bars = await fetchDaily(idea.symbol);
      } catch (err) {
        continue;
      }
    }
    const bar = findBarForDate(bars, plan.date);
    if (!bar) continue;
    if (idea.bias === 'LONG' && bar.h >= idea.target) missed += 1;
    if (idea.bias === 'SHORT' && bar.l <= idea.target) missed += 1;
  }
  return missed;
}

module.exports = {
  canGeneratePlan,
  getPlanDate,
  getTodayRegime,
  rankStrategies,
  buildTradeIdeas,
  applyExposureCap,
  applyTradeToPlan,
  buildPlanOutcome,
  generateTradePlan,
  rescoreTradePlan,
  linkTradeToPlan,
  computePlanStats,
  detectMissedWinners
};

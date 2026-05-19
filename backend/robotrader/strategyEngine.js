function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function riskLevelMultiplier(riskLevel) {
  if (riskLevel === 'conservative') return 0.5;
  if (riskLevel === 'aggressive') return 1;
  return 0.75;
}

function buildOrder({ research, settings, side, confidenceScore, rewardRiskRatio, strategyId, reason }) {
  const price = Number(research.price || research.quote?.price || 0);
  const atrPct = Number(research.indicators?.atrPct || 2);
  const stopDistancePct = clamp(atrPct * 1.2, 1.2, 6);
  const targetDistancePct = stopDistancePct * Math.max(rewardRiskRatio || 1.5, 1.5);
  const multiplier = riskLevelMultiplier(settings.riskLevel);
  const targetNotional = Math.min(
    Number(settings.maxTradeAmount || 0),
    Math.max(0, Number(settings.maxTradeAmount || 0) * multiplier)
  );
  const isStockOrder = research.assetClass === 'stocks';
  const computedQty = price > 0 && targetNotional > 0
    ? (settings.allowFractionalShares === false || !isStockOrder
      ? Math.floor(targetNotional / price)
      : Number((targetNotional / price).toFixed(6)))
    : null;
  const order = {
    symbol: research.symbol,
    assetClass: research.assetClass,
    side,
    orderType: 'market',
    orderClass: research.assetClass === 'stocks' ? 'bracket' : 'simple',
    timeInForce: research.assetClass === 'crypto' ? 'gtc' : 'day',
    notional: isStockOrder ? null : (targetNotional > 0 ? round(targetNotional, 2) : null),
    qty: isStockOrder && computedQty > 0 ? computedQty : null,
    estimatedNotional: targetNotional > 0 ? round(targetNotional, 2) : null,
    stopLoss: null,
    takeProfit: null,
    extendedHours: false,
    strategyId,
    confidenceScore,
    rewardRiskRatio,
    reason
  };

  if (price > 0 && research.assetClass === 'stocks') {
    if (side === 'buy') {
      order.stopLoss = { stop_price: round(price * (1 - stopDistancePct / 100), 2) };
      order.takeProfit = { limit_price: round(price * (1 + targetDistancePct / 100), 2) };
    } else {
      order.stopLoss = { stop_price: round(price * (1 + stopDistancePct / 100), 2) };
      order.takeProfit = { limit_price: round(price * (1 - targetDistancePct / 100), 2) };
    }
  }

  return order;
}

function scoreMomentumBreakout(research) {
  const indicators = research.indicators || {};
  const twentyDay = Number(indicators.twentyDayChangePct || 0);
  const volumeRatio = Number(indicators.volumeRatio || 1);
  const trendAligned = indicators.sma20 && indicators.sma50 && indicators.sma20 > indicators.sma50;
  const confidence = clamp(45 + twentyDay * 2 + (volumeRatio - 1) * 12 + (trendAligned ? 12 : 0), 0, 100);
  return {
    strategyId: 'ROBO_MOMENTUM_BREAKOUT_V1',
    strategyName: 'Momentum breakout',
    direction: confidence >= 60 ? 'buy' : 'hold',
    confidenceScore: round(confidence, 0),
    rewardRiskRatio: round(1.6 + Math.max(0, twentyDay) / 20, 2),
    reason: 'Momentum, volume expansion, and moving-average alignment were evaluated.'
  };
}

function scoreMeanReversion(research) {
  const indicators = research.indicators || {};
  const rsi = Number(indicators.rsi14 || 50);
  const fiveDay = Number(indicators.fiveDayChangePct || 0);
  const oversold = rsi < 35 && fiveDay < -2;
  const confidence = oversold ? clamp(62 + (35 - rsi) + Math.abs(fiveDay), 0, 100) : 35;
  return {
    strategyId: 'ROBO_MEAN_REVERSION_V1',
    strategyName: 'Mean reversion',
    direction: confidence >= 60 ? 'buy' : 'hold',
    confidenceScore: round(confidence, 0),
    rewardRiskRatio: round(1.4 + Math.max(0, 35 - rsi) / 20, 2),
    reason: 'RSI and short-term pullback depth were evaluated for mean reversion.'
  };
}

function scoreTrendFollowing(research) {
  const indicators = research.indicators || {};
  const trendAligned = indicators.sma20 && indicators.sma50 && indicators.sma200
    && indicators.sma20 > indicators.sma50
    && indicators.sma50 > indicators.sma200;
  const twentyDay = Number(indicators.twentyDayChangePct || 0);
  const confidence = clamp(48 + (trendAligned ? 25 : 0) + Math.max(0, twentyDay), 0, 100);
  return {
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    strategyName: 'Trend following',
    direction: confidence >= 62 ? 'buy' : 'hold',
    confidenceScore: round(confidence, 0),
    rewardRiskRatio: round(1.7 + Math.max(0, twentyDay) / 25, 2),
    reason: 'Longer-term moving-average trend and recent momentum were evaluated.'
  };
}

function scoreRiskOffProtection(research) {
  const indicators = research.indicators || {};
  const twentyDay = Number(indicators.twentyDayChangePct || 0);
  const belowTrend = indicators.sma20 && indicators.sma50 && indicators.sma20 < indicators.sma50;
  const confidence = clamp(40 + (belowTrend ? 20 : 0) + Math.max(0, -twentyDay), 0, 100);
  return {
    strategyId: 'ROBO_RISK_OFF_PROTECTION_V1',
    strategyName: 'Risk-off protection',
    direction: confidence >= 70 ? 'sell' : 'hold',
    confidenceScore: round(confidence, 0),
    rewardRiskRatio: round(1.3 + Math.max(0, -twentyDay) / 30, 2),
    reason: 'Downside momentum and trend deterioration were evaluated.'
  };
}

const STRATEGY_MODULES = [
  scoreMomentumBreakout,
  scoreMeanReversion,
  scoreTrendFollowing,
  scoreRiskOffProtection
];

function evaluateResearch(research, settings = {}) {
  if (!research || !research.symbol || !Number(research.price)) {
    return {
      symbol: research?.symbol || null,
      action: 'hold',
      confidenceScore: 0,
      rewardRiskRatio: null,
      strategyId: 'ROBO_NO_DATA',
      strategyName: 'No data',
      reasoningSummary: 'Research data was insufficient to create a trade candidate.',
      recommendedOrder: null
    };
  }

  const candidates = STRATEGY_MODULES.map(strategy => strategy(research));
  const best = candidates.sort((a, b) => b.confidenceScore - a.confidenceScore)[0];
  const action = best.direction || 'hold';
  const side = action === 'sell' ? 'sell' : 'buy';
  const recommendedOrder = action === 'hold'
    ? null
    : buildOrder({
        research,
        settings,
        side,
        confidenceScore: best.confidenceScore,
        rewardRiskRatio: best.rewardRiskRatio,
        strategyId: best.strategyId,
        reason: best.reason
      });

  return {
    symbol: research.symbol,
    assetClass: research.assetClass,
    action,
    confidenceScore: best.confidenceScore,
    rewardRiskRatio: best.rewardRiskRatio,
    strategyId: best.strategyId,
    strategyName: best.strategyName,
    reasoningSummary: best.reason,
    recommendedOrder,
    candidates
  };
}

function evaluateResearchBatch(researchItems = [], settings = {}) {
  return researchItems
    .map(item => evaluateResearch(item, settings))
    .sort((a, b) => Number(b.confidenceScore || 0) - Number(a.confidenceScore || 0));
}

module.exports = {
  STRATEGY_MODULES,
  evaluateResearch,
  evaluateResearchBatch
};

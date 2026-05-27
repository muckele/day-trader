const { evaluateUnifiedRisk } = require('../paper/riskEngine');
const { getPlanDate } = require('../tradePlanEngine');
const { getMarketStatus } = require('../utils/marketStatus');

const RESEARCH_STRATEGY_ID = 'research_thesis';
const RESEARCH_SETUP_TYPE = 'stock_research_thesis';
const MIN_REWARD_RISK = 1.2;
const MIN_CONFIDENCE = 50;

function toFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9./-]/g, '');
}

function normalizeSide(value, fallback = 'buy') {
  const side = String(value || '').trim().toLowerCase();
  return side === 'sell' ? 'sell' : fallback;
}

function inferSide(research = {}, body = {}) {
  if (body.side) return normalizeSide(body.side);
  const recommendation = String(
    research.analysis?.recommendation ||
    research.analysis?.bias ||
    research.intelligence?.tradeDirection ||
    ''
  ).toUpperCase();
  if (/SHORT|SELL|BEAR/.test(recommendation)) return 'sell';
  return 'buy';
}

function sideToBias(side) {
  return side === 'sell' ? 'SHORT' : 'LONG';
}

function getConfidenceScore(research = {}) {
  return toFiniteNumber(
    research.intelligence?.confidence?.score ??
    research.thesis?.confidence?.score ??
    research.analysis?.confidenceScore ??
    research.analysis?.confidence,
    60
  );
}

function getLatestPrice(research = {}, body = {}) {
  return toFiniteNumber(
    body.entryPrice ??
    body.limitPrice ??
    research.technicals?.latestPrice ??
    research.quote?.price,
    null
  );
}

function deriveStopPrice({ side, entry, research = {}, body = {} }) {
  const explicit = toFiniteNumber(body.stopLossPrice ?? body.stopPrice, null);
  if (explicit && explicit > 0) return explicit;
  const support = toFiniteNumber(research.technicals?.support20, null);
  const resistance = toFiniteNumber(research.technicals?.resistance20, null);
  if (side === 'sell') {
    return resistance && resistance > entry ? resistance : entry * 1.03;
  }
  return support && support < entry ? support : entry * 0.97;
}

function deriveTargetPrice({ side, entry, stop, research = {}, body = {} }) {
  const explicit = toFiniteNumber(body.takeProfitPrice ?? body.targetPrice, null);
  if (explicit && explicit > 0) return explicit;
  const support = toFiniteNumber(research.technicals?.support20, null);
  const resistance = toFiniteNumber(research.technicals?.resistance20, null);
  const risk = Math.abs(entry - stop) || entry * 0.03;
  if (side === 'sell') {
    return support && support < entry ? support : entry - risk * 2;
  }
  return resistance && resistance > entry ? resistance : entry + risk * 2;
}

function calculateRewardRisk({ side, entry, stop, target }) {
  const risk = side === 'sell' ? stop - entry : entry - stop;
  const reward = side === 'sell' ? entry - target : target - entry;
  if (!Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0) return null;
  return reward / risk;
}

function buildResearchSnapshot(research = {}) {
  const symbol = normalizeSymbol(research.symbol);
  return {
    source: 'research',
    symbol,
    capturedAt: new Date().toISOString(),
    researchUpdatedAt: research.updatedAt || research.dataQuality?.generatedAt || null,
    company: {
      name: research.company?.name || symbol,
      exchange: research.company?.exchange || null,
      fractionable: research.company?.fractionable ?? null,
      shortable: research.company?.shortable ?? null
    },
    technicals: {
      latestPrice: research.technicals?.latestPrice ?? null,
      changePercent: research.technicals?.changePercent ?? null,
      trend: research.technicals?.trend || null,
      rsi14: research.technicals?.rsi14 ?? null,
      atrPercent: research.technicals?.atrPercent ?? null,
      volumeRatio: research.technicals?.volumeRatio ?? null,
      support20: research.technicals?.support20 ?? null,
      resistance20: research.technicals?.resistance20 ?? null
    },
    intelligence: {
      summary: research.intelligence?.summary || research.thesis?.summary || '',
      bullCase: (research.intelligence?.bullCase || research.thesis?.bullCase || []).slice(0, 5),
      bearCase: (research.intelligence?.bearCase || research.thesis?.bearCase || []).slice(0, 5),
      keyRisks: (research.intelligence?.keyRisks || research.thesis?.keyRisks || []).slice(0, 5),
      whatChangedToday: (research.intelligence?.whatChangedToday || research.thesis?.whatChangedToday || []).slice(0, 5),
      confidence: research.intelligence?.confidence || research.thesis?.confidence || null,
      aiGenerated: Boolean(research.intelligence?.aiGenerated || research.thesis?.aiGenerated)
    },
    newsClusters: (research.newsClusters || []).slice(0, 5).map(cluster => ({
      primaryHeadline: cluster.primaryHeadline,
      sentiment: cluster.sentiment,
      category: cluster.category,
      count: cluster.count,
      latestPublishedAt: cluster.latestPublishedAt
    })),
    events: (research.events || []).slice(0, 8).map(event => ({
      type: event.type,
      title: event.title,
      sentiment: event.sentiment,
      eventDate: event.eventDate
    })),
    dataQuality: {
      staleWarnings: research.dataQuality?.staleWarnings || [],
      cache: research.dataQuality?.cache || null
    }
  };
}

function buildTradeTicket({ research = {}, account = {}, body = {} }) {
  const symbol = normalizeSymbol(research.symbol || body.symbol);
  const side = inferSide(research, body);
  const entry = getLatestPrice(research, body);
  const stop = entry ? deriveStopPrice({ side, entry, research, body }) : null;
  const target = entry && stop ? deriveTargetPrice({ side, entry, stop, research, body }) : null;
  const requestedPositionSizePct = toFiniteNumber(body.positionSizePct, null);
  const autoPositionSizePct = Math.min(
    Math.max(requestedPositionSizePct ?? (getConfidenceScore(research) >= 75 ? 5 : 3), 0.5),
    10
  );
  const equity = toFiniteNumber(account.equity, 0) || 0;
  const autoPlannedNotional = entry && equity ? (equity * autoPositionSizePct) / 100 : 0;
  const requestedQty = toFiniteNumber(body.qty, null);
  const qty = requestedQty && requestedQty > 0
    ? requestedQty
    : (entry ? Math.max(0.000001, Number((autoPlannedNotional / entry).toFixed(6))) : 0);
  const plannedNotional = (qty || 0) * (entry || 0);
  const effectivePositionSizePct = equity && plannedNotional
    ? (plannedNotional / equity) * 100
    : autoPositionSizePct;
  const orderType = ['market', 'limit'].includes(String(body.orderType || '').toLowerCase())
    ? String(body.orderType).toLowerCase()
    : 'market';
  const limitPrice = orderType === 'limit'
    ? toFiniteNumber(body.limitPrice, entry)
    : null;
  const rewardRiskRatio = entry && stop && target ? calculateRewardRisk({ side, entry, stop, target }) : null;
  return {
    symbol,
    assetClass: 'equity',
    side,
    bias: sideToBias(side),
    qty: round(qty, 6),
    orderType,
    timeInForce: 'day',
    limitPrice: orderType === 'limit' ? round(limitPrice, 2) : null,
    entryPrice: round(entry, 2),
    stopLossPrice: round(stop, 2),
    takeProfitPrice: round(target, 2),
    maxPricePerShare: side === 'buy' ? round(entry * 1.01, 2) : null,
    allowExtendedHours: body.allowExtendedHours === true,
    positionSizePct: round(effectivePositionSizePct, 2),
    plannedNotional: round(plannedNotional, 2),
    rewardRiskRatio: round(rewardRiskRatio, 2),
    strategyId: RESEARCH_STRATEGY_ID,
    setupType: RESEARCH_SETUP_TYPE,
    strategyTags: ['research', 'thesis']
  };
}

function findCurrentPosition(account = {}, symbol) {
  const normalized = normalizeSymbol(symbol).replace(/[^A-Z0-9]/g, '');
  return (account.positions || []).find(position => (
    normalizeSymbol(position.symbol).replace(/[^A-Z0-9]/g, '') === normalized
  )) || null;
}

function evaluateResearchTradeRisk({ research = {}, account = {}, settings = {}, ticket = {} }) {
  const reasonsBlocked = [];
  const warnings = [];
  const confidenceScore = getConfidenceScore(research);

  if (!ticket.symbol) reasonsBlocked.push('Symbol is required.');
  if (!ticket.entryPrice || ticket.entryPrice <= 0) reasonsBlocked.push('Latest research price is unavailable.');
  if (!ticket.qty || ticket.qty <= 0) reasonsBlocked.push('Ticket quantity must be greater than zero.');
  if (confidenceScore < MIN_CONFIDENCE) reasonsBlocked.push(`Research confidence is below ${MIN_CONFIDENCE}.`);
  if (!ticket.stopLossPrice || ticket.stopLossPrice <= 0) reasonsBlocked.push('A stop loss is required before creating a research trade.');
  if (!ticket.takeProfitPrice || ticket.takeProfitPrice <= 0) reasonsBlocked.push('A take profit is required before creating a research trade.');
  if (ticket.rewardRiskRatio === null || ticket.rewardRiskRatio < MIN_REWARD_RISK) {
    reasonsBlocked.push(`Reward/risk ratio must be at least ${MIN_REWARD_RISK}.`);
  }

  if ((research.dataQuality?.staleWarnings || []).length) {
    warnings.push(...research.dataQuality.staleWarnings.slice(0, 3));
  }
  if ((research.newsClusters || []).some(cluster => cluster.sentiment === 'negative')) {
    warnings.push('Recent negative news is present; review the bear case before sizing the trade.');
  }

  const currentPosition = findCurrentPosition(account, ticket.symbol);
  const unifiedRisk = evaluateUnifiedRisk({
    symbol: ticket.symbol,
    side: ticket.side,
    assetClass: ticket.assetClass || 'equity',
    orderNotional: ticket.plannedNotional,
    account,
    settings,
    currentPositionQty: toFiniteNumber(currentPosition?.qty, 0)
  });
  if (!unifiedRisk.ok) {
    reasonsBlocked.push(...(unifiedRisk.reasonsBlocked || [unifiedRisk.reason]).filter(Boolean));
  }
  if (ticket.side === 'buy' && toFiniteNumber(account.cash, 0) < ticket.plannedNotional) {
    reasonsBlocked.push('Insufficient paper cash for the previewed ticket.');
  }

  return {
    eligible: reasonsBlocked.length === 0,
    reasonsBlocked: [...new Set(reasonsBlocked)],
    warnings: [...new Set(warnings)],
    confidenceScore: round(confidenceScore, 1),
    rewardRiskRatio: ticket.rewardRiskRatio,
    accountSnapshot: {
      cash: round(account.cash, 2),
      equity: round(account.equity, 2),
      positionsValue: round(account.positionsValue, 2),
      dailyPnl: round(account.dailyPnl, 2)
    },
    metrics: {
      ...(unifiedRisk.metrics || {}),
      plannedNotional: ticket.plannedNotional,
      positionSizePct: ticket.positionSizePct
    }
  };
}

function buildResearchTradePreview({ research, account, settings, body = {} }) {
  const researchSnapshot = buildResearchSnapshot(research);
  const ticket = buildTradeTicket({ research, account, body });
  const risk = evaluateResearchTradeRisk({ research, account, settings, ticket });
  return {
    symbol: ticket.symbol,
    ticket,
    risk,
    researchSnapshot
  };
}

function buildTradeIdeaFromPreview(preview = {}, body = {}) {
  const ticket = preview.ticket || {};
  const risk = preview.risk || {};
  const entry = toFiniteNumber(ticket.entryPrice, 0);
  const stop = toFiniteNumber(ticket.stopLossPrice, 0);
  const target = toFiniteNumber(ticket.takeProfitPrice, 0);
  return {
    symbol: ticket.symbol,
    strategyId: RESEARCH_STRATEGY_ID,
    bias: ticket.bias || sideToBias(ticket.side),
    entry,
    stop,
    target,
    positionSizePct: toFiniteNumber(body.positionSizePct, ticket.positionSizePct || 3),
    signalScore: risk.confidenceScore,
    confidenceScore: Math.max(0, Math.min(100, toFiniteNumber(risk.confidenceScore, 60))),
    alignmentScore: Math.max(0, Math.min(100, Math.round((toFiniteNumber(ticket.rewardRiskRatio, 1) / 3) * 100))),
    reason: (preview.researchSnapshot?.intelligence?.summary || 'Research thesis trade idea.').slice(0, 600),
    source: 'research_thesis',
    researchSnapshot: preview.researchSnapshot,
    status: 'PENDING'
  };
}

async function createTradePlanFromResearch({ accountId, preview, TradePlan }) {
  const date = getPlanDate();
  const marketStatus = getMarketStatus();
  const ideaPayload = buildTradeIdeaFromPreview(preview);
  let plan = await TradePlan.findOne({ accountId, date });
  if (!plan) {
    try {
      plan = await TradePlan.create({
        accountId,
        date,
        marketStatus: marketStatus.status,
        regime: {
          date,
          trendChop: null,
          vol: null,
          risk: null,
          notes: ['Created from Research thesis workflow.']
        },
        rankedStrategies: [{
          strategyId: RESEARCH_STRATEGY_ID,
          score: ideaPayload.confidenceScore,
          expectancy: preview.ticket.rewardRiskRatio,
          winRate: 0,
          alignmentScore: ideaPayload.alignmentScore,
          tradeCount: 0,
          sampleAdjusted: true
        }],
        tradeIdeas: [ideaPayload],
        totalSuggestedExposurePct: ideaPayload.positionSizePct,
        notes: 'Research-generated trade plan. Review risk checks before paper execution.'
      });
      return { plan, idea: plan.tradeIdeas[0], created: true, updatedExistingIdea: false };
    } catch (err) {
      if (err?.code !== 11000) throw err;
      plan = await TradePlan.findOne({ accountId, date });
    }
  }

  const existingIdea = plan.tradeIdeas.find(item => (
    item.symbol === ideaPayload.symbol &&
    item.strategyId === RESEARCH_STRATEGY_ID &&
    item.status === 'PENDING'
  ));
  let updatedExistingIdea = false;
  if (existingIdea) {
    Object.assign(existingIdea, ideaPayload);
    updatedExistingIdea = true;
  } else {
    plan.tradeIdeas.push(ideaPayload);
  }
  const existingRank = plan.rankedStrategies.find(item => item.strategyId === RESEARCH_STRATEGY_ID);
  if (!existingRank) {
    plan.rankedStrategies.push({
      strategyId: RESEARCH_STRATEGY_ID,
      score: ideaPayload.confidenceScore,
      expectancy: preview.ticket.rewardRiskRatio,
      winRate: 0,
      alignmentScore: ideaPayload.alignmentScore,
      tradeCount: 0,
      sampleAdjusted: true
    });
  } else {
    existingRank.score = ideaPayload.confidenceScore;
    existingRank.expectancy = preview.ticket.rewardRiskRatio;
    existingRank.alignmentScore = ideaPayload.alignmentScore;
    existingRank.sampleAdjusted = true;
  }
  plan.totalSuggestedExposurePct = Number(plan.tradeIdeas
    .filter(item => item.status === 'PENDING')
    .reduce((sum, item) => sum + Number(item.positionSizePct || 0), 0)
    .toFixed(2));
  await plan.save();
  const idea = existingIdea || plan.tradeIdeas[plan.tradeIdeas.length - 1];
  return { plan, idea, created: false, updatedExistingIdea };
}

module.exports = {
  RESEARCH_STRATEGY_ID,
  RESEARCH_SETUP_TYPE,
  buildResearchSnapshot,
  buildResearchTradePreview,
  buildTradeIdeaFromPreview,
  createTradePlanFromResearch
};

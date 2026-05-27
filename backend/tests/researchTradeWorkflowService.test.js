const test = require('node:test');
const assert = require('node:assert/strict');
const PaperOrder = require('../models/PaperOrder');
const PaperTrade = require('../models/PaperTrade');
const TradePlan = require('../models/TradePlan');
const {
  RESEARCH_STRATEGY_ID,
  buildResearchTradePreview,
  buildTradeIdeaFromPreview,
  createTradePlanFromResearch
} = require('../services/researchTradeWorkflowService');

function makeResearch(overrides = {}) {
  return {
    symbol: 'AAPL',
    company: {
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      fractionable: true,
      shortable: true
    },
    technicals: {
      latestPrice: 100,
      changePercent: 1.2,
      trend: 'uptrend',
      rsi14: 58,
      atrPercent: 2.1,
      volumeRatio: 1.4,
      support20: 97,
      resistance20: 108
    },
    intelligence: {
      summary: 'AAPL has a constructive research thesis with positive momentum.',
      bullCase: ['Momentum remains positive.'],
      bearCase: ['Valuation risk remains.'],
      keyRisks: ['Macro weakness.'],
      whatChangedToday: ['Positive price action.'],
      confidence: { score: 72, label: 'Medium' },
      aiGenerated: true
    },
    newsClusters: [
      { primaryHeadline: 'AAPL shares rise', sentiment: 'positive', category: 'momentum', count: 2 }
    ],
    events: [],
    dataQuality: { staleWarnings: [], cache: { status: 'hit' } },
    ...overrides
  };
}

function makeAccount(overrides = {}) {
  return {
    equity: 100000,
    cash: 50000,
    positionsValue: 0,
    dailyPnl: 0,
    positions: [],
    ...overrides
  };
}

function makeSettings(overrides = {}) {
  return {
    maxDailyLossPct: 2,
    maxSymbolExposurePct: 10,
    maxSectorExposurePct: 60,
    maxCorrelationClusterPct: 70,
    maxVarPct: 20,
    varVolatilityPct: 2.5,
    ...overrides
  };
}

test('research trade preview builds an eligible paper ticket with a captured snapshot', () => {
  const preview = buildResearchTradePreview({
    research: makeResearch(),
    account: makeAccount(),
    settings: makeSettings()
  });

  assert.equal(preview.symbol, 'AAPL');
  assert.equal(preview.ticket.strategyId, RESEARCH_STRATEGY_ID);
  assert.equal(preview.ticket.side, 'buy');
  assert.equal(preview.ticket.qty, 30);
  assert.equal(preview.ticket.plannedNotional, 3000);
  assert.equal(preview.risk.eligible, true);
  assert.equal(preview.researchSnapshot.symbol, 'AAPL');
  assert.equal(preview.researchSnapshot.intelligence.aiGenerated, true);
});

test('research trade preview blocks weak reward-risk tickets', () => {
  const preview = buildResearchTradePreview({
    research: makeResearch(),
    account: makeAccount(),
    settings: makeSettings(),
    body: { targetPrice: 101 }
  });

  assert.equal(preview.risk.eligible, false);
  assert.ok(preview.risk.reasonsBlocked.some(reason => /Reward\/risk ratio/i.test(reason)));
});

test('research trade preview derives position percent from explicit quantity', () => {
  const preview = buildResearchTradePreview({
    research: makeResearch(),
    account: makeAccount(),
    settings: makeSettings(),
    body: { qty: 10 }
  });

  assert.equal(preview.ticket.qty, 10);
  assert.equal(preview.ticket.plannedNotional, 1000);
  assert.equal(preview.ticket.positionSizePct, 1);
});

test('research trade idea carries thesis source and snapshot into the trade plan payload', () => {
  const preview = buildResearchTradePreview({
    research: makeResearch(),
    account: makeAccount(),
    settings: makeSettings()
  });
  const idea = buildTradeIdeaFromPreview(preview);

  assert.equal(idea.source, 'research_thesis');
  assert.equal(idea.strategyId, RESEARCH_STRATEGY_ID);
  assert.equal(idea.researchSnapshot.symbol, 'AAPL');
  assert.equal(idea.status, 'PENDING');
});

test('createTradePlanFromResearch creates a plan with a research thesis idea', async () => {
  const preview = buildResearchTradePreview({
    research: makeResearch(),
    account: makeAccount(),
    settings: makeSettings()
  });
  let savedPlan = null;
  const FakeTradePlan = {
    async findOne() {
      return savedPlan;
    },
    async create(payload) {
      savedPlan = {
        ...payload,
        save: async function save() {
          return this;
        }
      };
      return savedPlan;
    }
  };

  const result = await createTradePlanFromResearch({
    accountId: 'test-account',
    preview,
    TradePlan: FakeTradePlan
  });

  assert.equal(result.created, true);
  assert.equal(result.idea.source, 'research_thesis');
  assert.equal(result.plan.tradeIdeas.length, 1);
  assert.equal(result.plan.tradeIdeas[0].researchSnapshot.symbol, 'AAPL');
});

test('createTradePlanFromResearch refreshes an existing research thesis idea and rank', async () => {
  const preview = buildResearchTradePreview({
    research: makeResearch({
      intelligence: {
        summary: 'Updated AAPL thesis.',
        confidence: { score: 80, label: 'High' }
      }
    }),
    account: makeAccount(),
    settings: makeSettings(),
    body: { positionSizePct: 4 }
  });
  const savedPlan = {
    tradeIdeas: [{
      symbol: 'AAPL',
      strategyId: RESEARCH_STRATEGY_ID,
      status: 'PENDING',
      positionSizePct: 1,
      reason: 'Old thesis.'
    }],
    rankedStrategies: [{
      strategyId: RESEARCH_STRATEGY_ID,
      score: 10,
      expectancy: 0.5,
      alignmentScore: 10,
      sampleAdjusted: false
    }],
    saveCount: 0,
    async save() {
      this.saveCount += 1;
      return this;
    }
  };
  const FakeTradePlan = {
    async findOne() {
      return savedPlan;
    }
  };

  const result = await createTradePlanFromResearch({
    accountId: 'test-account',
    preview,
    TradePlan: FakeTradePlan
  });

  assert.equal(result.updatedExistingIdea, true);
  assert.equal(savedPlan.tradeIdeas.length, 1);
  assert.equal(savedPlan.tradeIdeas[0].positionSizePct, 4);
  assert.equal(savedPlan.rankedStrategies[0].score, 80);
  assert.equal(savedPlan.rankedStrategies[0].sampleAdjusted, true);
  assert.equal(savedPlan.saveCount, 1);
});

test('trade and paper order schemas persist research workflow metadata', () => {
  assert.ok(PaperOrder.schema.path('metadata'));
  assert.ok(PaperOrder.schema.path('researchSnapshot'));
  assert.ok(PaperTrade.schema.path('metadata'));
  assert.ok(PaperTrade.schema.path('researchSnapshot'));
  assert.ok(TradePlan.schema.path('tradeIdeas').schema.path('researchSnapshot'));
});

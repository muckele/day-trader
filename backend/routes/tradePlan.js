const router = require('express').Router();
const TradePlan = require('../models/TradePlan');
const TradePlanLog = require('../models/TradePlanLog');
const PaperTrade = require('../models/PaperTrade');
const { getMarketStatus } = require('../utils/marketStatus');
const { fetchDaily } = require('../tradeLogic');
const {
  getPlanDate,
  generateTradePlan,
  rescoreTradePlan,
  computePlanStats,
  detectMissedWinners
} = require('../tradePlanEngine');

const ACCOUNT_ID = 'default';

router.get('/today', async (req, res, next) => {
  try {
    const status = getMarketStatus();
    const date = getPlanDate();
    const plan = await TradePlan.findOne({ accountId: ACCOUNT_ID, date }).lean();
    if (!plan) {
      return res.json({
        plan: null,
        marketStatus: status.status,
        nextOpen: status.nextOpen,
        nextClose: status.nextClose
      });
    }

    if (req.query.rescore === '1') {
      const updated = await rescoreTradePlan(plan, ACCOUNT_ID);
      return res.json({
        plan: updated,
        marketStatus: status.status,
        nextOpen: status.nextOpen,
        nextClose: status.nextClose
      });
    }

    return res.json({
      plan,
      marketStatus: status.status,
      nextOpen: status.nextOpen,
      nextClose: status.nextClose
    });
  } catch (err) {
    next(err);
  }
});

router.post('/generate', async (req, res, next) => {
  try {
    const status = getMarketStatus();
    const date = getPlanDate();

    if (status.status !== 'OPEN') {
      await TradePlanLog.create({
        accountId: ACCOUNT_ID,
        date,
        marketStatus: status.status,
        status: 'BLOCKED',
        reason: 'Market is closed.'
      });
      return res.status(400).json({ error: 'Market is closed. Plan generation is disabled.' });
    }

    const existing = await TradePlan.findOne({ accountId: ACCOUNT_ID, date }).lean();
    if (existing) {
      await TradePlanLog.create({
        accountId: ACCOUNT_ID,
        date,
        marketStatus: status.status,
        status: 'DUPLICATE',
        reason: 'Plan already exists.',
        planId: existing._id
      });
      return res.json({ plan: existing, alreadyExists: true });
    }

    const plan = await generateTradePlan({ accountId: ACCOUNT_ID });
    await TradePlanLog.create({
      accountId: ACCOUNT_ID,
      date,
      marketStatus: status.status,
      status: 'CREATED',
      planId: plan._id
    });
    res.json({ plan });
  } catch (err) {
    await TradePlanLog.create({
      accountId: ACCOUNT_ID,
      date: getPlanDate(),
      marketStatus: getMarketStatus().status,
      status: 'FAILED',
      reason: err.message
    });
    next(err);
  }
});

router.get('/history', async (req, res, next) => {
  try {
    const daysParam = Number(req.query.days || 14);
    const days = Number.isFinite(daysParam) ? daysParam : 14;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const plans = await TradePlan.find({
      accountId: ACCOUNT_ID,
      date: { $gte: startDate }
    }).sort({ date: -1 }).lean();

    const planIds = plans.map(plan => plan._id);
    const trades = planIds.length
      ? await PaperTrade.find({ tradePlanId: { $in: planIds } }).lean()
      : [];
    const tradesByPlan = trades.reduce((acc, trade) => {
      const key = trade.tradePlanId?.toString();
      if (!key) return acc;
      if (!acc[key]) acc[key] = [];
      acc[key].push(trade);
      return acc;
    }, {});

    const symbols = new Set();
    plans.forEach(plan => {
      plan.tradeIdeas.forEach(idea => {
        if (idea.status !== 'EXECUTED') {
          symbols.add(idea.symbol);
        }
      });
    });

    const barsBySymbol = {};
    const symbolList = Array.from(symbols);
    if (symbolList.length) {
      const results = await Promise.allSettled(
        symbolList.map(symbol => fetchDaily(symbol))
      );
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          barsBySymbol[symbolList[index]] = result.value;
        }
      });
    }

    const history = await Promise.all(
      plans.map(async plan => {
        const stats = computePlanStats(plan, tradesByPlan[plan._id.toString()] || []);
        const missedWinners = await detectMissedWinners(plan, barsBySymbol, { skipFetch: true });
        return {
          ...plan,
          metrics: {
            ...stats,
            missedWinners
          }
        };
      })
    );

    res.json({ history });
  } catch (err) {
    next(err);
  }
});

router.put('/:planId/ideas/:ideaId', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (status !== 'SKIPPED') {
      return res.status(400).json({ error: 'Only SKIPPED status is supported.' });
    }

    const plan = await TradePlan.findOne({ _id: req.params.planId, accountId: ACCOUNT_ID });
    if (!plan) {
      return res.status(404).json({ error: 'Trade plan not found.' });
    }

    const idea = plan.tradeIdeas.id(req.params.ideaId);
    if (!idea) {
      return res.status(404).json({ error: 'Trade idea not found.' });
    }
    if (idea.status === 'EXECUTED') {
      return res.status(400).json({ error: 'Executed ideas cannot be skipped.' });
    }

    idea.status = 'SKIPPED';
    idea.skippedAt = new Date();
    await plan.save();
    res.json({ plan });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

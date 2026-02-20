const router = require('express').Router();
const TradePlan = require('../models/TradePlan');
const PaperTrade = require('../models/PaperTrade');
const ExecutionAuditLog = require('../models/ExecutionAuditLog');
const paperBroker = require('../paper/paperBrokerClient');
const { evaluateExecutionGate } = require('../executionGate');

const ACCOUNT_ID = 'default';

router.post('/check', async (req, res, next) => {
  try {
    const { planId, ideaId } = req.body || {};
    if (!planId || !ideaId) {
      return res.status(400).json({ error: 'planId and ideaId are required.' });
    }

    const plan = await TradePlan.findOne({ _id: planId, accountId: ACCOUNT_ID });
    if (!plan) {
      return res.status(404).json({ error: 'Trade plan not found.' });
    }

    const idea = plan.tradeIdeas.id(ideaId);
    if (!idea) {
      return res.status(404).json({ error: 'Trade idea not found.' });
    }

    const trades = await PaperTrade.find({
      accountId: ACCOUNT_ID,
      strategyId: idea.strategyId
    }).sort({ filledAt: 1 }).lean();

    const account = await paperBroker.getAccount();
    const settings = await paperBroker.getSettings();

    const result = evaluateExecutionGate({
      idea,
      trades,
      account,
      settings
    });

    await ExecutionAuditLog.create({
      accountId: ACCOUNT_ID,
      planId: plan._id,
      ideaId: idea._id,
      strategyId: idea.strategyId,
      eligible: result.eligible,
      reasonsBlocked: result.reasonsBlocked,
      accountSnapshot: {
        equity: account.equity,
        positionsValue: account.positionsValue,
        dailyPnl: account.dailyPnl,
        dailyDrawdown: result.accountStats.dailyDrawdown,
        exposurePct: result.accountStats.exposurePct,
        consecutiveLosses: result.accountStats.consecutiveLosses
      }
    });

    return res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

const router = require('express').Router();
const auth = require('../middleware/auth');
const requireMongo = require('../middleware/requireMongo');
const TradePlan = require('../models/TradePlan');
const PaperTrade = require('../models/PaperTrade');
const ExecutionAuditLog = require('../models/ExecutionAuditLog');
const paperBroker = require('../paper/paperBrokerClient');
const { evaluateExecutionGate } = require('../executionGate');
const { getRequestAccountId } = require('../utils/accountScope');

router.use(requireMongo);
router.use(auth);

router.post('/check', async (req, res, next) => {
  try {
    const accountId = getRequestAccountId(req);
    const { planId, ideaId } = req.body || {};
    if (!planId || !ideaId) {
      return res.status(400).json({ error: 'planId and ideaId are required.' });
    }

    const plan = await TradePlan.findOne({ _id: planId, accountId });
    if (!plan) {
      return res.status(404).json({ error: 'Trade plan not found.' });
    }

    const idea = plan.tradeIdeas.id(ideaId);
    if (!idea) {
      return res.status(404).json({ error: 'Trade idea not found.' });
    }

    const trades = await PaperTrade.find({
      accountId,
      strategyId: idea.strategyId
    }).sort({ filledAt: 1 }).lean();

    const account = await paperBroker.getAccount({ accountId });
    const settings = await paperBroker.getSettings({ accountId });

    const result = evaluateExecutionGate({
      idea,
      trades,
      account,
      settings
    });

    await ExecutionAuditLog.create({
      accountId,
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

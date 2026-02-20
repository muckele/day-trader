const router = require('express').Router();
const auth = require('../middleware/auth');
const User = require('../models/User');
const roboEngine = require('../services/roboTraderEngine');

function mapSettingsPayload(settings) {
  return {
    enabled: Boolean(settings?.enabled),
    dailyLimit: Number(settings?.dailyLimit || 0),
    weeklyLimit: Number(settings?.weeklyLimit || 0),
    monthlyLimit: Number(settings?.monthlyLimit || 0),
    updatedAt: settings?.updatedAt || null
  };
}

async function getCurrentUser(req) {
  const username = req.user?.username;
  if (!username) return null;
  return User.findOne({ username });
}

router.get('/settings', auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });

    const settings = await roboEngine.getOrCreateSettings(user._id);
    const usage = await roboEngine.getUsageSnapshotForUser(user._id);
    res.json({
      settings: mapSettingsPayload(settings),
      usage
    });
  } catch (err) {
    next(err);
  }
});

router.put('/settings', auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });

    const updates = {
      enabled: req.body?.enabled,
      dailyLimit: req.body?.dailyLimit,
      weeklyLimit: req.body?.weeklyLimit,
      monthlyLimit: req.body?.monthlyLimit
    };
    const settings = await roboEngine.updateSettingsForUser(user._id, updates);
    const usage = await roboEngine.getUsageSnapshotForUser(user._id);
    res.json({
      settings: mapSettingsPayload(settings),
      usage
    });
  } catch (err) {
    next(err);
  }
});

router.get('/audit', auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });

    const limit = Number(req.query.limit || 100);
    const logs = await roboEngine.getAuditLogsForUser(user._id, {
      from: req.query.from,
      to: req.query.to,
      limit
    });
    res.json({ events: logs });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

const User = require('../models/User');
const RoboSettings = require('../models/RoboSettings');
const RoboUsage = require('../models/RoboUsage');
const RoboAuditLog = require('../models/RoboAuditLog');
const RoboLock = require('../models/RoboLock');
const paperBroker = require('../paper/paperBrokerClient');
const { fetchQuotes } = require('./marketData');
const emailService = require('./roboEmail');

const LOCK_TTL_MS = 30 * 1000;

const defaultDeps = {
  User,
  RoboSettings,
  RoboUsage,
  RoboAuditLog,
  RoboLock,
  paperBroker,
  fetchQuotes,
  emailService
};

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeLimit(limit) {
  if (limit === null || limit === undefined || limit === '') return Infinity;
  const numeric = Number(limit);
  if (!Number.isFinite(numeric)) return Infinity;
  if (numeric < 0) return 0;
  return numeric;
}

function getBucketStart(now, bucketType) {
  const date = new Date(now);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();

  if (bucketType === 'day') {
    return new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
  }

  if (bucketType === 'week') {
    const current = new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
    const weekday = current.getUTCDay(); // Sunday=0
    const diffToMonday = (weekday + 6) % 7;
    current.setUTCDate(current.getUTCDate() - diffToMonday);
    return current;
  }

  if (bucketType === 'month') {
    return new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  }

  throw new Error(`Unsupported bucket type "${bucketType}"`);
}

function buildBucketStarts(now) {
  return {
    day: getBucketStart(now, 'day'),
    week: getBucketStart(now, 'week'),
    month: getBucketStart(now, 'month')
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDateInput(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sanitizeSettingsUpdate(input = {}) {
  const update = {};
  if (typeof input.enabled === 'boolean') update.enabled = input.enabled;
  if (input.dailyLimit !== undefined) update.dailyLimit = Math.max(0, toFiniteNumber(input.dailyLimit, 0));
  if (input.weeklyLimit !== undefined) update.weeklyLimit = Math.max(0, toFiniteNumber(input.weeklyLimit, 0));
  if (input.monthlyLimit !== undefined) update.monthlyLimit = Math.max(0, toFiniteNumber(input.monthlyLimit, 0));
  return update;
}

function toSettingsPayload(settingsDoc) {
  return {
    enabled: Boolean(settingsDoc?.enabled),
    dailyLimit: toFiniteNumber(settingsDoc?.dailyLimit, 0),
    weeklyLimit: toFiniteNumber(settingsDoc?.weeklyLimit, 0),
    monthlyLimit: toFiniteNumber(settingsDoc?.monthlyLimit, 0),
    updatedAt: settingsDoc?.updatedAt || null
  };
}

async function writeAuditLog(userId, eventType, payload, deps = defaultDeps) {
  return deps.RoboAuditLog.create({
    userId,
    eventType,
    payload: payload || {}
  });
}

async function getOrCreateSettings(userId, deps = defaultDeps) {
  let settings = await deps.RoboSettings.findOne({ userId });
  if (settings) return settings;
  settings = await deps.RoboSettings.create({
    userId,
    enabled: false,
    dailyLimit: 0,
    weeklyLimit: 0,
    monthlyLimit: 0
  });
  return settings;
}

async function getUsageSnapshotForUser(userId, now = new Date(), deps = defaultDeps) {
  const starts = buildBucketStarts(now);
  const query = {
    userId,
    $or: [
      { bucketType: 'day', bucketStart: starts.day },
      { bucketType: 'week', bucketStart: starts.week },
      { bucketType: 'month', bucketStart: starts.month }
    ]
  };
  const usageDocs = await deps.RoboUsage.find(query).lean();
  const usageByType = {};
  usageDocs.forEach(doc => {
    usageByType[doc.bucketType] = doc;
  });

  const settings = await getOrCreateSettings(userId, deps);
  const limits = toSettingsPayload(settings);

  const buildUsage = (bucketType, limitValue, bucketStart) => {
    const spent = toFiniteNumber(usageByType[bucketType]?.spentNotional, 0);
    const normalizedLimit = normalizeLimit(limitValue);
    return {
      bucketType,
      bucketStart,
      spentNotional: spent,
      limit: Number.isFinite(normalizedLimit) ? normalizedLimit : null,
      remaining: Number.isFinite(normalizedLimit)
        ? Math.max(0, Number((normalizedLimit - spent).toFixed(2)))
        : null
    };
  };

  return {
    day: buildUsage('day', limits.dailyLimit, starts.day),
    week: buildUsage('week', limits.weeklyLimit, starts.week),
    month: buildUsage('month', limits.monthlyLimit, starts.month)
  };
}

function evaluateNotionalAgainstLimits({ settings, usageSnapshot, attemptNotional }) {
  const safeAttemptNotional = Math.max(0, toFiniteNumber(attemptNotional, 0));
  const violations = [];
  const dailyLimit = normalizeLimit(settings.dailyLimit);
  const weeklyLimit = normalizeLimit(settings.weeklyLimit);
  const monthlyLimit = normalizeLimit(settings.monthlyLimit);

  if (usageSnapshot.day.spentNotional + safeAttemptNotional > dailyLimit) {
    violations.push('daily');
  }
  if (usageSnapshot.week.spentNotional + safeAttemptNotional > weeklyLimit) {
    violations.push('weekly');
  }
  if (usageSnapshot.month.spentNotional + safeAttemptNotional > monthlyLimit) {
    violations.push('monthly');
  }

  return {
    allowed: violations.length === 0,
    violations
  };
}

async function acquireUserLock(userId, owner, now = new Date(), deps = defaultDeps) {
  const lockedUntil = new Date(now.getTime() + LOCK_TTL_MS);
  try {
    const lock = await deps.RoboLock.findOneAndUpdate(
      {
        userId,
        $or: [
          { lockedUntil: { $lte: now } },
          { lockedUntil: { $exists: false } }
        ]
      },
      {
        $set: {
          owner,
          lockedUntil
        }
      },
      {
        upsert: true,
        new: true
      }
    );
    return Boolean(lock);
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

async function releaseUserLock(userId, owner, deps = defaultDeps) {
  await deps.RoboLock.updateOne(
    { userId, owner },
    { $set: { lockedUntil: new Date(0) } }
  );
}

async function incrementUsageBuckets(userId, now, notional, deps = defaultDeps) {
  const starts = buildBucketStarts(now);
  await Promise.all(
    ['day', 'week', 'month'].map(bucketType => deps.RoboUsage.updateOne(
      { userId, bucketType, bucketStart: starts[bucketType] },
      {
        $inc: { spentNotional: notional },
        $set: { updatedAt: now }
      },
      { upsert: true }
    ))
  );
}

async function sendEmailWithRetry({ to, details }, deps = defaultDeps, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await deps.emailService.sendTradeEmail({ to, details });
      return { ok: true, attempt, result };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await wait(250 * attempt);
      }
    }
  }
  return { ok: false, error: lastError };
}

function buildDefaultSignal(now = new Date()) {
  const symbol = String(process.env.ROBO_SIGNAL_SYMBOL || 'AAPL').toUpperCase();
  const qty = Math.max(1, Math.floor(toFiniteNumber(process.env.ROBO_SIGNAL_QTY, 1)));
  const side = process.env.ROBO_SIGNAL_SIDE === 'sell' ? 'sell' : 'buy';
  return {
    symbol,
    side,
    qty,
    strategyId: null,
    strategyName: 'ROBO_PLACEHOLDER',
    generatedAt: now.toISOString()
  };
}

async function runRoboTradeForUser({ userId, signal = null, now = new Date() }, deps = defaultDeps) {
  const settings = await getOrCreateSettings(userId, deps);
  const settingsPayload = toSettingsPayload(settings);

  if (!settingsPayload.enabled) {
    await writeAuditLog(userId, 'robo_disabled', {
      reason: 'Robo Trader is disabled.',
      at: now.toISOString()
    }, deps);
    return { ok: false, executed: false, skipped: true, reason: 'ROBO_DISABLED' };
  }

  const owner = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const acquired = await acquireUserLock(userId, owner, now, deps);
  if (!acquired) {
    await writeAuditLog(userId, 'trade_skipped_locked', {
      reason: 'Another Robo Trader job is currently running.',
      at: now.toISOString()
    }, deps);
    return { ok: false, executed: false, skipped: true, reason: 'LOCKED' };
  }

  try {
    const freshSettings = await getOrCreateSettings(userId, deps);
    const freshPayload = toSettingsPayload(freshSettings);
    if (!freshPayload.enabled) {
      await writeAuditLog(userId, 'robo_disabled', {
        reason: 'Robo Trader disabled during execution.',
        at: now.toISOString()
      }, deps);
      return { ok: false, executed: false, skipped: true, reason: 'ROBO_DISABLED' };
    }

    const candidateSignal = signal || buildDefaultSignal(now);
    const symbol = String(candidateSignal.symbol || '').toUpperCase();
    const side = candidateSignal.side === 'sell' ? 'sell' : 'buy';
    const qty = Math.max(1, Math.floor(toFiniteNumber(candidateSignal.qty, 1)));

    if (!symbol) {
      await writeAuditLog(userId, 'trade_skipped_invalid_signal', {
        reason: 'Signal missing symbol.',
        signal: candidateSignal
      }, deps);
      return { ok: false, executed: false, skipped: true, reason: 'INVALID_SIGNAL' };
    }

    const quotes = await deps.fetchQuotes([symbol]);
    const quote = Array.isArray(quotes) ? quotes[0] : null;
    const estimatedPrice = toFiniteNumber(quote?.price, NaN);
    if (!Number.isFinite(estimatedPrice) || estimatedPrice <= 0) {
      await writeAuditLog(userId, 'trade_skipped_no_quote', {
        symbol,
        reason: 'Quote unavailable for signal symbol.'
      }, deps);
      return { ok: false, executed: false, skipped: true, reason: 'NO_QUOTE' };
    }

    const estimatedNotional = Number((estimatedPrice * qty).toFixed(2));
    const spendingNotional = side === 'buy' ? estimatedNotional : 0;
    const usageSnapshot = await getUsageSnapshotForUser(userId, now, deps);
    const limitDecision = evaluateNotionalAgainstLimits({
      settings: freshPayload,
      usageSnapshot,
      attemptNotional: spendingNotional
    });

    if (!limitDecision.allowed) {
      await writeAuditLog(userId, 'trade_skipped_limit', {
        symbol,
        side,
        qty,
        estimatedPrice,
        attemptNotional: spendingNotional,
        violations: limitDecision.violations,
        usage: usageSnapshot
      }, deps);
      return { ok: false, executed: false, skipped: true, reason: 'LIMIT_EXCEEDED' };
    }

    const execution = await deps.paperBroker.placeOrder({
      symbol,
      side,
      qty,
      orderType: 'market',
      strategyId: candidateSignal.strategyId || null,
      setupType: 'ROBO',
      strategyTags: ['robo'],
      stopPrice: candidateSignal.stopPrice || null
    });

    const order = execution?.order || {};
    const trade = execution?.trade || {};
    const executedNotional = Number(toFiniteNumber(order.notional, trade.notional || estimatedNotional).toFixed(2));
    const usageNotional = side === 'buy' ? executedNotional : 0;

    await incrementUsageBuckets(userId, now, usageNotional, deps);

    const eventPayload = {
      symbol,
      side,
      qty,
      estimatedPrice,
      notional: executedNotional,
      usageNotional,
      orderId: order._id || order.id || null,
      strategyName: candidateSignal.strategyName || null,
      timestamp: now.toISOString()
    };
    await writeAuditLog(userId, 'trade_executed', eventPayload, deps);

    const user = await deps.User.findById(userId).lean();
    const recipient = user?.email || process.env.ROBO_FALLBACK_EMAIL || null;
    const emailResult = await sendEmailWithRetry({
      to: recipient,
      details: {
        symbol,
        side,
        qty,
        notional: executedNotional,
        estimatedPrice,
        timestamp: now.toISOString(),
        strategyName: candidateSignal.strategyName || null,
        orderId: eventPayload.orderId
      }
    }, deps);

    if (emailResult.ok) {
      await writeAuditLog(userId, 'email_sent', {
        to: recipient,
        orderId: eventPayload.orderId,
        provider: emailResult.result?.provider || null,
        messageId: emailResult.result?.messageId || null,
        attempts: emailResult.attempt
      }, deps);
    } else {
      await writeAuditLog(userId, 'email_failed', {
        to: recipient,
        orderId: eventPayload.orderId,
        error: emailResult.error?.message || 'Unknown email error'
      }, deps);
    }

    return {
      ok: true,
      executed: true,
      skipped: false,
      orderId: eventPayload.orderId,
      notional: executedNotional,
      usageNotional
    };
  } finally {
    await releaseUserLock(userId, owner, deps);
  }
}

async function updateSettingsForUser(userId, updates, deps = defaultDeps) {
  const settings = await getOrCreateSettings(userId, deps);
  const currentEnabled = Boolean(settings.enabled);
  const sanitized = sanitizeSettingsUpdate(updates);
  Object.assign(settings, sanitized);
  await settings.save();

  await writeAuditLog(userId, 'robo_settings_updated', {
    enabled: Boolean(settings.enabled),
    dailyLimit: toFiniteNumber(settings.dailyLimit, 0),
    weeklyLimit: toFiniteNumber(settings.weeklyLimit, 0),
    monthlyLimit: toFiniteNumber(settings.monthlyLimit, 0)
  }, deps);

  if (currentEnabled && settings.enabled === false) {
    await writeAuditLog(userId, 'robo_disabled', {
      reason: 'Disabled from settings update.'
    }, deps);
  }

  return settings;
}

async function getAuditLogsForUser(userId, { from, to, limit } = {}, deps = defaultDeps) {
  const query = { userId };
  const fromDate = parseDateInput(from);
  const toDate = parseDateInput(to);
  if (fromDate || toDate) {
    query.createdAt = {};
    if (fromDate) query.createdAt.$gte = fromDate;
    if (toDate) query.createdAt.$lte = toDate;
  }
  const cap = Math.min(Math.max(toFiniteNumber(limit, 100), 1), 500);
  return deps.RoboAuditLog.find(query).sort({ createdAt: -1 }).limit(cap).lean();
}

async function runSchedulerTick(deps = defaultDeps) {
  const enabled = await deps.RoboSettings.find({ enabled: true }).lean();
  for (const setting of enabled) {
    try {
      await runRoboTradeForUser({ userId: setting.userId }, deps);
    } catch (err) {
      await writeAuditLog(setting.userId, 'trade_skipped_scheduler_error', {
        reason: err?.message || 'Unknown scheduler error'
      }, deps);
    }
  }
}

module.exports = {
  getBucketStart,
  buildBucketStarts,
  evaluateNotionalAgainstLimits,
  getOrCreateSettings,
  updateSettingsForUser,
  getUsageSnapshotForUser,
  getAuditLogsForUser,
  runRoboTradeForUser,
  runSchedulerTick
};

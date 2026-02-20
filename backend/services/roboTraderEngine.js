const User = require('../models/User');
const RoboSettings = require('../models/RoboSettings');
const RoboUsage = require('../models/RoboUsage');
const RoboAuditLog = require('../models/RoboAuditLog');
const RoboLock = require('../models/RoboLock');
const RoboSignalExecution = require('../models/RoboSignalExecution');
const paperBroker = require('../paper/paperBrokerClient');
const { fetchQuotes } = require('./marketData');
const emailService = require('./roboEmail');

const LOCK_TTL_MS = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MINUTES = 60;

const defaultDeps = {
  User,
  RoboSettings,
  RoboUsage,
  RoboAuditLog,
  RoboLock,
  RoboSignalExecution,
  paperBroker,
  fetchQuotes,
  emailService
};

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toFinitePositiveInt(value, fallback) {
  const parsed = Math.floor(toFiniteNumber(value, fallback));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
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

function toIsoOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeRetentionDays(value, fallback = 90) {
  const parsed = Math.floor(toFiniteNumber(value, fallback));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function getCircuitConfig() {
  return {
    failureThreshold: toFinitePositiveInt(
      process.env.ROBO_CIRCUIT_FAILURE_THRESHOLD,
      DEFAULT_CIRCUIT_FAILURE_THRESHOLD
    ),
    cooldownMinutes: toFinitePositiveInt(
      process.env.ROBO_CIRCUIT_COOLDOWN_MINUTES,
      DEFAULT_CIRCUIT_COOLDOWN_MINUTES
    )
  };
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
    failureStreak: Math.max(0, Math.floor(toFiniteNumber(settingsDoc?.failureStreak, 0))),
    pausedUntil: settingsDoc?.pausedUntil || null,
    updatedAt: settingsDoc?.updatedAt || null
  };
}

function isCircuitBreakerActive(settingsPayload, now = new Date()) {
  if (!settingsPayload?.pausedUntil) return false;
  const pausedUntil = new Date(settingsPayload.pausedUntil);
  if (Number.isNaN(pausedUntil.getTime())) return false;
  return pausedUntil > now;
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
    monthlyLimit: 0,
    failureStreak: 0,
    pausedUntil: null
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

async function updateCircuitFields(userId, patch, deps = defaultDeps) {
  if (!deps.RoboSettings?.updateOne) return;
  await deps.RoboSettings.updateOne(
    { userId },
    { $set: patch }
  );
}

async function resetCircuitStateIfNeeded(userId, settingsPayload, now = new Date(), deps = defaultDeps) {
  const failureStreak = Math.max(0, Math.floor(toFiniteNumber(settingsPayload?.failureStreak, 0)));
  const hasPause = Boolean(settingsPayload?.pausedUntil);
  if (failureStreak === 0 && !hasPause) return;

  await updateCircuitFields(userId, {
    failureStreak: 0,
    pausedUntil: null,
    updatedAt: now
  }, deps);
  await writeAuditLog(userId, 'circuit_breaker_reset', {
    previousFailureStreak: failureStreak,
    previousPausedUntil: toIsoOrNull(settingsPayload?.pausedUntil),
    at: now.toISOString()
  }, deps);
}

async function markCircuitFailure(userId, settingsPayload, err, now = new Date(), deps = defaultDeps) {
  const circuit = getCircuitConfig();
  const nextFailureStreak = Math.max(0, Math.floor(toFiniteNumber(settingsPayload?.failureStreak, 0))) + 1;
  const shouldPause = nextFailureStreak >= circuit.failureThreshold;
  const pausedUntil = shouldPause
    ? new Date(now.getTime() + (circuit.cooldownMinutes * 60 * 1000))
    : null;

  const patch = {
    failureStreak: nextFailureStreak,
    updatedAt: now
  };
  if (shouldPause) patch.pausedUntil = pausedUntil;

  await updateCircuitFields(userId, patch, deps);
  await writeAuditLog(userId, 'trade_failed', {
    reason: err?.message || 'Unknown execution error',
    failureStreak: nextFailureStreak,
    failureThreshold: circuit.failureThreshold,
    at: now.toISOString()
  }, deps);

  if (shouldPause) {
    await writeAuditLog(userId, 'circuit_breaker_armed', {
      reason: err?.message || 'Unknown execution error',
      failureStreak: nextFailureStreak,
      failureThreshold: circuit.failureThreshold,
      cooldownMinutes: circuit.cooldownMinutes,
      pausedUntil: pausedUntil.toISOString()
    }, deps);
  }
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

function deriveSignalId(candidateSignal, symbol, side, qty, now = new Date()) {
  const explicit = String(candidateSignal?.signalId || candidateSignal?.attemptId || '').trim();
  if (explicit) return explicit;
  const generatedAt = String(candidateSignal?.generatedAt || now.toISOString());
  return `auto:${symbol}:${side}:${qty}:${generatedAt}`;
}

async function claimSignalExecution({ userId, signalId, signalMeta, now = new Date() }, deps = defaultDeps) {
  try {
    await deps.RoboSignalExecution.create({
      userId,
      signalId,
      status: 'processing',
      startedAt: now,
      ...signalMeta
    });
    return { claimed: true, existing: null };
  } catch (err) {
    if (err?.code === 11000) {
      const existing = await deps.RoboSignalExecution.findOne({ userId, signalId }).lean();
      return { claimed: false, existing };
    }
    throw err;
  }
}

async function updateSignalExecution(userId, signalId, patch, now = new Date(), deps = defaultDeps) {
  await deps.RoboSignalExecution.updateOne(
    { userId, signalId },
    { $set: { ...patch, updatedAt: now } }
  );
}

async function runRoboTradeForUser({ userId, signal = null, now = new Date() }, deps = defaultDeps) {
  const settings = await getOrCreateSettings(userId, deps);
  const settingsPayload = toSettingsPayload(settings);
  let activeSettingsPayload = settingsPayload;

  if (!settingsPayload.enabled) {
    await writeAuditLog(userId, 'robo_disabled', {
      reason: 'Robo Trader is disabled.',
      at: now.toISOString()
    }, deps);
    return { ok: false, executed: false, skipped: true, reason: 'ROBO_DISABLED' };
  }

  if (isCircuitBreakerActive(settingsPayload, now)) {
    await writeAuditLog(userId, 'trade_skipped_circuit_breaker', {
      reason: 'Circuit breaker active due to recent execution failures.',
      failureStreak: settingsPayload.failureStreak,
      pausedUntil: toIsoOrNull(settingsPayload.pausedUntil),
      at: now.toISOString()
    }, deps);
    return { ok: false, executed: false, skipped: true, reason: 'CIRCUIT_BREAKER' };
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

  let claimedSignalId = null;
  try {
    const freshSettings = await getOrCreateSettings(userId, deps);
    const freshPayload = toSettingsPayload(freshSettings);
    activeSettingsPayload = freshPayload;
    if (!freshPayload.enabled) {
      await writeAuditLog(userId, 'robo_disabled', {
        reason: 'Robo Trader disabled during execution.',
        at: now.toISOString()
      }, deps);
      return { ok: false, executed: false, skipped: true, reason: 'ROBO_DISABLED' };
    }

    if (isCircuitBreakerActive(freshPayload, now)) {
      await writeAuditLog(userId, 'trade_skipped_circuit_breaker', {
        reason: 'Circuit breaker active due to recent execution failures.',
        failureStreak: freshPayload.failureStreak,
        pausedUntil: toIsoOrNull(freshPayload.pausedUntil),
        at: now.toISOString()
      }, deps);
      return { ok: false, executed: false, skipped: true, reason: 'CIRCUIT_BREAKER' };
    }

    const candidateSignal = signal || buildDefaultSignal(now);
    const symbol = String(candidateSignal.symbol || '').toUpperCase();
    const side = candidateSignal.side === 'sell' ? 'sell' : 'buy';
    const qty = Math.max(1, Math.floor(toFiniteNumber(candidateSignal.qty, 1)));
    const signalId = deriveSignalId(candidateSignal, symbol, side, qty, now);

    if (!symbol) {
      await writeAuditLog(userId, 'trade_skipped_invalid_signal', {
        reason: 'Signal missing symbol.',
        signal: candidateSignal,
        signalId
      }, deps);
      return { ok: false, executed: false, skipped: true, reason: 'INVALID_SIGNAL' };
    }

    const claim = await claimSignalExecution({
      userId,
      signalId,
      now,
      signalMeta: {
        symbol,
        side,
        qty,
        strategyId: candidateSignal.strategyId || null,
        strategyName: candidateSignal.strategyName || null
      }
    }, deps);
    if (!claim.claimed) {
      await writeAuditLog(userId, 'trade_skipped_duplicate_signal', {
        signalId,
        symbol,
        side,
        qty,
        existingStatus: claim.existing?.status || null,
        existingOrderId: claim.existing?.orderId || null
      }, deps);
      return { ok: false, executed: false, skipped: true, reason: 'DUPLICATE_SIGNAL', signalId };
    }
    claimedSignalId = signalId;

    const quotes = await deps.fetchQuotes([symbol]);
    const quote = Array.isArray(quotes) ? quotes[0] : null;
    const estimatedPrice = toFiniteNumber(quote?.price, NaN);
    if (!Number.isFinite(estimatedPrice) || estimatedPrice <= 0) {
      await updateSignalExecution(userId, signalId, {
        status: 'skipped',
        reason: 'NO_QUOTE'
      }, now, deps);
      await writeAuditLog(userId, 'trade_skipped_no_quote', {
        symbol,
        signalId,
        reason: 'Quote unavailable for signal symbol.'
      }, deps);
      return { ok: false, executed: false, skipped: true, reason: 'NO_QUOTE', signalId };
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
      await updateSignalExecution(userId, signalId, {
        status: 'skipped',
        reason: 'LIMIT_EXCEEDED'
      }, now, deps);
      await writeAuditLog(userId, 'trade_skipped_limit', {
        symbol,
        signalId,
        side,
        qty,
        estimatedPrice,
        attemptNotional: spendingNotional,
        violations: limitDecision.violations,
        usage: usageSnapshot
      }, deps);
      return { ok: false, executed: false, skipped: true, reason: 'LIMIT_EXCEEDED', signalId };
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
      signalId,
      orderId: order._id || order.id || null,
      strategyName: candidateSignal.strategyName || null,
      timestamp: now.toISOString()
    };
    await writeAuditLog(userId, 'trade_executed', eventPayload, deps);
    await resetCircuitStateIfNeeded(userId, freshPayload, now, deps);
    await updateSignalExecution(userId, signalId, {
      status: 'executed',
      orderId: eventPayload.orderId || null,
      executedAt: now,
      notional: executedNotional
    }, now, deps);

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
      usageNotional,
      signalId
    };
  } catch (err) {
    try {
      await markCircuitFailure(userId, activeSettingsPayload, err, now, deps);
    } catch (_circuitErr) {
      // ignore circuit marker failures; original error should still propagate
    }

    if (claimedSignalId) {
      try {
        await updateSignalExecution(userId, claimedSignalId, {
          status: 'failed',
          reason: err?.message || 'Unknown execution error'
        }, now, deps);
      } catch (_signalErr) {
        // ignore marker update errors; primary error should still propagate
      }
    }
    throw err;
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

async function cleanupSignalExecutions({ olderThanDays, now = new Date() } = {}, deps = defaultDeps) {
  const retentionDays = normalizeRetentionDays(
    olderThanDays ?? process.env.ROBO_SIGNAL_RETENTION_DAYS,
    90
  );
  const cutoff = new Date(now.getTime() - (retentionDays * DAY_MS));
  const result = await deps.RoboSignalExecution.deleteMany({
    updatedAt: { $lt: cutoff }
  });

  return {
    retentionDays,
    cutoff,
    deletedCount: Number(result?.deletedCount || 0)
  };
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
  cleanupSignalExecutions,
  runRoboTradeForUser,
  runSchedulerTick
};

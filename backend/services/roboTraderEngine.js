const axios = require('axios');
const User = require('../models/User');
const RoboSettings = require('../models/RoboSettings');
const RoboUsage = require('../models/RoboUsage');
const RoboAuditLog = require('../models/RoboAuditLog');
const RoboLock = require('../models/RoboLock');
const RoboSignalExecution = require('../models/RoboSignalExecution');
const paperBroker = require('../paper/paperBrokerClient');
const { fetchQuotes, isCryptoSymbol } = require('./marketData');
const emailService = require('./roboEmail');
const { getMarketStatus } = require('../utils/marketStatus');
const { evaluateTradePolicy } = require('./tradePolicyService');
const { writeRiskEvent } = require('./riskEventService');
const { createStrategyRun, finalizeStrategyRun } = require('./strategyRunService');
const { recordFilledExecution, recordRejectedExecution } = require('./executionTelemetryService');
const {
  buildAlpacaOrderPayload,
  buildClientOrderId,
  getAlpacaTradingConfig
} = require('./alpacaTradingClient');

const LOCK_TTL_MS = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MINUTES = 60;
const DEFAULT_SIGNAL_UNIVERSE = [
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOG',
  'META',
  'TSLA',
  'SPY',
  'QQQ',
  'IWM',
  'DIA',
  'TLT',
  'AGG',
  'BND',
  'HYG',
  'LQD',
  'GLD',
  'SLV'
];
const AUTO_STRATEGY_ID = 'ROBO_MULTI_SYMBOL_V1';
const AUTO_STRATEGY_NAME = 'ROBO_MULTI_SYMBOL';

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

function parseCsvValues(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizeTradeSide(value, fallback = 'buy') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'buy' || normalized === 'long' || normalized === 'cover') return 'buy';
  if (normalized === 'sell' || normalized === 'short') return 'sell';
  return fallback;
}

function getExecutionBackend() {
  const raw = String(process.env.ROBO_EXECUTION_BACKEND || 'paper').trim().toLowerCase();
  return raw === 'alpaca' ? 'alpaca' : 'paper';
}

async function placeAlpacaOrder({
  symbol,
  side,
  qty,
  assetClass = 'equity',
  allowExtendedHours,
  estimatedPrice
}) {
  const config = getAlpacaTradingConfig();
  if (!config.apiKey || !config.apiSecret) {
    const err = new Error('Alpaca API credentials are not configured for Robo execution.');
    err.code = 'ALPACA_NOT_CONFIGURED';
    throw err;
  }

  try {
    const payload = buildAlpacaOrderPayload({
      symbol,
      assetClass,
      side,
      qty,
      orderType: 'market',
      timeInForce: assetClass === 'crypto' ? 'gtc' : 'day',
      allowExtendedHours,
      clientOrderId: buildClientOrderId({ origin: 'robo', symbol })
    });
    const response = await axios.post(
      `${config.baseUrl}/v2/orders`,
      payload,
      {
        headers: {
          'APCA-API-KEY-ID': config.apiKey,
          'APCA-API-SECRET-KEY': config.apiSecret
        },
        timeout: 20000
      }
    );

    const orderData = response?.data || {};
    const orderId = orderData.id || orderData.client_order_id || null;
    const fillPrice = Number(
      toFiniteNumber(orderData.filled_avg_price, estimatedPrice).toFixed(4)
    );
    const filledQty = toFiniteNumber(orderData.filled_qty, qty);
    const responseNotional = toFiniteNumber(orderData.notional, NaN);
    const notional = Number.isFinite(responseNotional) && responseNotional > 0
      ? Number(responseNotional.toFixed(2))
      : Number((filledQty * fillPrice).toFixed(2));

    return {
      order: {
        id: orderId,
        _id: orderId,
        notional,
        fillPrice
      },
      trade: {
        notional,
        price: fillPrice
      }
    };
  } catch (err) {
    const upstreamMessage = err?.response?.data?.message || err?.message || 'Unknown Alpaca order error';
    const wrapped = new Error(`Alpaca order failed: ${upstreamMessage}`);
    wrapped.code = err?.code || 'ALPACA_ORDER_FAILED';
    wrapped.status = err?.response?.status || null;
    throw wrapped;
  }
}

function normalizeAllowedSide(value) {
  const normalized = normalizeTradeSide(value, '');
  if (normalized === 'buy' || normalized === 'sell') return normalized;
  return null;
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

function toMinuteIsoString(value = new Date()) {
  const date = new Date(value);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
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

function getExecutionControls() {
  const anomalyThreshold = toFiniteNumber(process.env.ROBO_SLIPPAGE_ANOMALY_BPS_THRESHOLD, 0);
  return {
    minMinutesBetweenExecutions: Math.max(
      0,
      toFinitePositiveInt(process.env.ROBO_MIN_MINUTES_BETWEEN_EXECUTIONS, 0)
    ),
    minMinutesBetweenSymbolExecutions: Math.max(
      0,
      toFinitePositiveInt(process.env.ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS, 0)
    ),
    maxExecutionsPerDay: Math.max(
      0,
      toFinitePositiveInt(process.env.ROBO_MAX_EXECUTIONS_PER_DAY, 0)
    ),
    maxExecutionsPerStrategyPerDay: Math.max(
      0,
      toFinitePositiveInt(process.env.ROBO_MAX_EXECUTIONS_PER_STRATEGY_PER_DAY, 0)
    ),
    slippageAnomalyLookback: Math.max(
      1,
      toFinitePositiveInt(process.env.ROBO_SLIPPAGE_ANOMALY_LOOKBACK, 5)
    ),
    slippageAnomalyBpsThreshold: Number.isFinite(anomalyThreshold) ? Math.max(0, anomalyThreshold) : 0,
    allowExtendedHours: process.env.ROBO_ALLOW_EXTENDED_HOURS !== 'false',
    killSwitchEnabled: process.env.ROBO_KILL_SWITCH === 'true'
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
  const configuredUniverse = getSignalUniverse();
  const hasExplicitUniverse = parseCsvValues(process.env.ROBO_SIGNAL_UNIVERSE).length > 0;
  const minuteBucket = Math.max(0, Math.floor(now.getTime() / (60 * 1000)));
  const defaultSymbol = configuredUniverse[minuteBucket % configuredUniverse.length];
  const symbol = String(
    hasExplicitUniverse
      ? (defaultSymbol || 'AAPL')
      : (process.env.ROBO_SIGNAL_SYMBOL || defaultSymbol || 'AAPL')
  ).toUpperCase();
  const qty = Math.max(1, Math.floor(toFiniteNumber(process.env.ROBO_SIGNAL_QTY, 1)));
  const side = normalizeTradeSide(process.env.ROBO_SIGNAL_SIDE, 'buy');
  return {
    symbol,
    side,
    qty,
    strategyId: null,
    strategyName: 'ROBO_PLACEHOLDER',
    // Minute-level bucketing keeps auto signal IDs stable across concurrent scheduler instances.
    generatedAt: toMinuteIsoString(now)
  };
}

function getSignalUniverse() {
  const configured = parseCsvValues(process.env.ROBO_SIGNAL_UNIVERSE)
    .map(item => String(item || '').toUpperCase())
    .filter(Boolean);
  if (configured.length) {
    return Array.from(new Set(configured));
  }

  const single = String(process.env.ROBO_SIGNAL_SYMBOL || '').trim().toUpperCase();
  if (single) return [single];
  return DEFAULT_SIGNAL_UNIVERSE;
}

function getAllowedSignalSides() {
  const configured = parseCsvValues(process.env.ROBO_ALLOWED_SIDES || process.env.ROBO_SIGNAL_SIDE || 'buy,sell')
    .map(normalizeAllowedSide)
    .filter(Boolean);
  if (configured.length) {
    return Array.from(new Set(configured));
  }
  return ['buy', 'sell'];
}

function getSignalSelectionConfig() {
  const threshold = toFiniteNumber(process.env.ROBO_SIGNAL_CHANGE_THRESHOLD_PCT, 0.25);
  return {
    allowedSides: getAllowedSignalSides(),
    changeThresholdPct: Number.isFinite(threshold) ? Math.max(0, threshold) : 0.25,
    recentLookbackMinutes: Math.max(
      0,
      toFinitePositiveInt(process.env.ROBO_SIGNAL_RECENT_LOOKBACK_MINUTES, 180)
    ),
    recentWindowLimit: Math.max(
      1,
      toFinitePositiveInt(process.env.ROBO_SIGNAL_RECENT_WINDOW_LIMIT, 20)
    ),
    targetNotional: Math.max(
      0,
      toFiniteNumber(process.env.ROBO_TARGET_NOTIONAL, 0)
    ),
    fallbackQty: Math.max(
      1,
      toFinitePositiveInt(process.env.ROBO_SIGNAL_QTY, 1)
    )
  };
}

function deriveSignalSide(changePct, allowedSides, thresholdPct) {
  const safeChangePct = Number.isFinite(changePct) ? changePct : 0;
  if (safeChangePct >= thresholdPct && allowedSides.includes('buy')) {
    return 'buy';
  }
  if (safeChangePct <= -thresholdPct && allowedSides.includes('sell')) {
    return 'sell';
  }
  if (safeChangePct >= 0 && allowedSides.includes('buy')) {
    return 'buy';
  }
  if (safeChangePct < 0 && allowedSides.includes('sell')) {
    return 'sell';
  }
  return allowedSides[0] || 'buy';
}

function resolveSignalQty({
  price,
  targetNotional,
  fallbackQty
}) {
  if (targetNotional > 0 && Number.isFinite(price) && price > 0) {
    return Math.max(1, Math.floor(targetNotional / price) || 1);
  }
  return Math.max(1, Math.floor(fallbackQty || 1));
}

function normalizeQuoteSymbol(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function buildSignalCandidates(quotes, selectionConfig) {
  const allowed = new Set(selectionConfig.allowedSides);
  const threshold = selectionConfig.changeThresholdPct;
  const bySymbol = new Map();

  (quotes || []).forEach(quote => {
    const symbol = normalizeQuoteSymbol(quote?.symbol);
    const price = toFiniteNumber(quote?.price, NaN);
    const changePercent = toFiniteNumber(quote?.changePercent, 0);
    if (!symbol || !Number.isFinite(price) || price <= 0) return;
    const side = deriveSignalSide(changePercent, selectionConfig.allowedSides, threshold);
    if (!allowed.has(side)) return;
    bySymbol.set(symbol, {
      symbol,
      price,
      changePercent: Number(changePercent.toFixed(4)),
      side,
      score: Math.abs(changePercent),
      assetClass: isCryptoSymbol(symbol) ? 'crypto' : 'equity'
    });
  });

  return Array.from(bySymbol.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.symbol.localeCompare(b.symbol);
    });
}

async function getRecentlyExecutedSymbols(userId, now, selectionConfig, deps = defaultDeps) {
  if (!deps.RoboSignalExecution?.find || selectionConfig.recentLookbackMinutes <= 0) {
    return new Set();
  }

  const cutoff = new Date(now.getTime() - (selectionConfig.recentLookbackMinutes * 60 * 1000));
  let query = deps.RoboSignalExecution.find({
    userId,
    status: 'executed',
    executedAt: { $gte: cutoff }
  });
  if (!query) return new Set();
  if (typeof query.sort === 'function') {
    query = query.sort({ executedAt: -1 });
  }
  if (typeof query.limit === 'function') {
    query = query.limit(selectionConfig.recentWindowLimit);
  }
  if (typeof query.lean === 'function') {
    query = query.lean();
  }

  const recent = await query;
  if (!Array.isArray(recent)) return new Set();
  return new Set(
    recent
      .map(entry => normalizeQuoteSymbol(entry?.symbol))
      .filter(Boolean)
  );
}

async function buildAutoSignalForUser({ userId, now = new Date() }, deps = defaultDeps) {
  const universe = getSignalUniverse();
  if (!universe.length) return null;

  const selectionConfig = getSignalSelectionConfig();
  const quotes = await deps.fetchQuotes(universe);
  const candidates = buildSignalCandidates(quotes, selectionConfig);
  if (!candidates.length) return null;

  const recentSymbols = await getRecentlyExecutedSymbols(userId, now, selectionConfig, deps);
  const selected = candidates.find(candidate => !recentSymbols.has(candidate.symbol))
    || candidates[0];
  if (!selected) return null;

  const qty = resolveSignalQty({
    price: selected.price,
    targetNotional: selectionConfig.targetNotional,
    fallbackQty: selectionConfig.fallbackQty
  });

  return {
    symbol: selected.symbol,
    side: selected.side,
    qty,
    assetClass: selected.assetClass,
    strategyId: AUTO_STRATEGY_ID,
    strategyName: AUTO_STRATEGY_NAME,
    generatedAt: toMinuteIsoString(now)
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

async function findRecentExecutedSignal(userId, cutoff, deps = defaultDeps) {
  if (!deps.RoboSignalExecution?.findOne) return null;
  const query = deps.RoboSignalExecution.findOne({
    userId,
    status: 'executed',
    executedAt: { $gte: cutoff }
  });
  if (!query) return null;

  if (typeof query.sort === 'function') {
    const sorted = query.sort({ executedAt: -1 });
    if (sorted && typeof sorted.lean === 'function') return sorted.lean();
    return sorted;
  }

  if (typeof query.lean === 'function') return query.lean();
  return query;
}

async function countExecutedSignalsSince(userId, since, deps = defaultDeps) {
  if (!deps.RoboSignalExecution?.countDocuments) return 0;
  const count = await deps.RoboSignalExecution.countDocuments({
    userId,
    status: 'executed',
    executedAt: { $gte: since }
  });
  return Number.isFinite(Number(count)) ? Number(count) : 0;
}

async function countExecutedSignalsForStrategySince(userId, strategyId, since, deps = defaultDeps) {
  if (!strategyId || !deps.RoboSignalExecution?.countDocuments) return 0;
  const count = await deps.RoboSignalExecution.countDocuments({
    userId,
    strategyId,
    status: 'executed',
    executedAt: { $gte: since }
  });
  return Number.isFinite(Number(count)) ? Number(count) : 0;
}

async function findRecentExecutedSignalForSymbol(userId, symbol, cutoff, deps = defaultDeps) {
  if (!symbol || !deps.RoboSignalExecution?.findOne) return null;
  const query = deps.RoboSignalExecution.findOne({
    userId,
    symbol,
    status: 'executed',
    executedAt: { $gte: cutoff }
  });
  if (!query) return null;
  if (typeof query.sort === 'function') {
    const sorted = query.sort({ executedAt: -1 });
    if (sorted && typeof sorted.lean === 'function') return sorted.lean();
    return sorted;
  }
  if (typeof query.lean === 'function') return query.lean();
  return query;
}

function deriveSlippageBpsFromEvent(event) {
  const payload = event?.payload || {};
  const fromPayload = toFiniteNumber(payload.slippageBps, NaN);
  if (Number.isFinite(fromPayload)) return Math.abs(fromPayload);

  const estimatedPrice = toFiniteNumber(payload.estimatedPrice, NaN);
  const fillPrice = toFiniteNumber(payload.fillPrice, NaN);
  const side = normalizeTradeSide(payload.side, 'buy');
  if (!Number.isFinite(estimatedPrice) || estimatedPrice <= 0 || !Number.isFinite(fillPrice)) {
    return NaN;
  }
  const adverse = side === 'buy'
    ? (fillPrice - estimatedPrice)
    : (estimatedPrice - fillPrice);
  return Math.abs((adverse / estimatedPrice) * 10000);
}

function detectExecutionAnomaly(events, thresholdBps) {
  if (!Array.isArray(events) || events.length === 0 || !(thresholdBps > 0)) {
    return { anomalous: false, maxBps: 0, avgBps: 0, samples: 0 };
  }
  const samples = events
    .map(deriveSlippageBpsFromEvent)
    .filter(value => Number.isFinite(value));
  if (!samples.length) {
    return { anomalous: false, maxBps: 0, avgBps: 0, samples: 0 };
  }
  const maxBps = Math.max(...samples);
  const avgBps = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    anomalous: maxBps >= thresholdBps,
    maxBps: Number(maxBps.toFixed(2)),
    avgBps: Number(avgBps.toFixed(2)),
    samples: samples.length
  };
}

async function runRoboTradeForUser({ userId, signal = null, now = new Date() }, deps = defaultDeps) {
  const settings = await getOrCreateSettings(userId, deps);
  const settingsPayload = toSettingsPayload(settings);
  let activeSettingsPayload = settingsPayload;
  const executionControls = getExecutionControls();

  if (executionControls.killSwitchEnabled) {
    await writeAuditLog(userId, 'trade_skipped_kill_switch', {
      reason: 'Global Robo kill switch is enabled.',
      at: now.toISOString()
    }, deps);
    return { ok: false, executed: false, skipped: true, reason: 'KILL_SWITCH' };
  }

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
  let strategyRun = null;
  let candidateSignal = null;
  let symbol = null;
  let side = 'buy';
  let qty = 0;
  let signalId = null;
  let executionBackend = null;
  const finalizeRun = async (status, payload = {}) => {
    if (!strategyRun) return null;
    return finalizeStrategyRun(strategyRun, {
      status,
      ...payload
    });
  };
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

    if (executionControls.killSwitchEnabled) {
      await writeAuditLog(userId, 'trade_skipped_kill_switch', {
        reason: 'Global Robo kill switch is enabled.',
        at: now.toISOString()
      }, deps);
      return { ok: false, executed: false, skipped: true, reason: 'KILL_SWITCH' };
    }

    if (!executionControls.allowExtendedHours) {
      const market = getMarketStatus(now);
      if (market.status !== 'OPEN') {
        await writeAuditLog(userId, 'trade_skipped_market_closed', {
          reason: 'Robo execution is limited to regular market hours.',
          marketStatus: market.status,
          nextOpen: market.nextOpen || null,
          at: now.toISOString()
        }, deps);
        return { ok: false, executed: false, skipped: true, reason: 'MARKET_CLOSED' };
      }
    }

    if (executionControls.maxExecutionsPerDay > 0) {
      const dayStart = getBucketStart(now, 'day');
      const executedToday = await countExecutedSignalsSince(userId, dayStart, deps);
      if (executedToday >= executionControls.maxExecutionsPerDay) {
        await writeAuditLog(userId, 'trade_skipped_max_trades', {
          reason: 'Reached max Robo executions for the current day.',
          executedToday,
          maxExecutionsPerDay: executionControls.maxExecutionsPerDay,
          dayStart: dayStart.toISOString(),
          at: now.toISOString()
        }, deps);
        return { ok: false, executed: false, skipped: true, reason: 'MAX_TRADES_REACHED' };
      }
    }

    if (executionControls.minMinutesBetweenExecutions > 0) {
      const cutoff = new Date(now.getTime() - (executionControls.minMinutesBetweenExecutions * 60 * 1000));
      const recentExecuted = await findRecentExecutedSignal(userId, cutoff, deps);
      if (recentExecuted) {
        await writeAuditLog(userId, 'trade_skipped_cooldown', {
          reason: 'Robo execution cooldown is active.',
          minMinutesBetweenExecutions: executionControls.minMinutesBetweenExecutions,
          lastExecutedAt: recentExecuted.executedAt || recentExecuted.updatedAt || null,
          at: now.toISOString()
        }, deps);
        return { ok: false, executed: false, skipped: true, reason: 'COOLDOWN_ACTIVE' };
      }
    }

    candidateSignal = signal || buildDefaultSignal(now);
    symbol = String(candidateSignal.symbol || '').toUpperCase();
    side = normalizeTradeSide(candidateSignal.side, 'buy');
    qty = Math.max(1, Math.floor(toFiniteNumber(candidateSignal.qty, 1)));
    signalId = deriveSignalId(candidateSignal, symbol, side, qty, now);
    executionBackend = getExecutionBackend();

    if (!symbol) {
      await writeAuditLog(userId, 'trade_skipped_invalid_signal', {
        reason: 'Signal missing symbol.',
        signal: candidateSignal,
        signalId
      }, deps);
      return { ok: false, executed: false, skipped: true, reason: 'INVALID_SIGNAL' };
    }

    strategyRun = await createStrategyRun({
      strategyId: candidateSignal.strategyId || AUTO_STRATEGY_ID,
      strategyName: candidateSignal.strategyName || AUTO_STRATEGY_NAME,
      runType: 'robo',
      mode: executionBackend === 'alpaca' ? 'live' : 'paper',
      symbol,
      universe: [symbol],
      parameters: {
        signalSide: side,
        qty,
        assetClass: candidateSignal.assetClass || 'equity',
        executionBackend
      },
      source: 'robo',
      summary: {
        signalId
      },
      context: {
        userId: String(userId),
        strategyName: candidateSignal.strategyName || AUTO_STRATEGY_NAME
      }
    });

    const policyDecision = await evaluateTradePolicy({
      symbol,
      side,
      assetClass: candidateSignal.assetClass || 'equity',
      strategyId: candidateSignal.strategyId || null,
      executionBackend,
      alpacaBaseUrl: getAlpacaTradingConfig().baseUrl,
      orderNotional: 0
    });
    if (!policyDecision.ok) {
      const reason = policyDecision.reasons[0] || 'Automated trade blocked by policy.';
      await writeAuditLog(userId, 'trade_skipped_policy', {
        symbol,
        signalId,
        side,
        qty,
        reasons: policyDecision.reasons,
        instrument: policyDecision.instrument,
        mode: policyDecision.mode,
        at: now.toISOString()
      }, deps);
      await writeRiskEvent({
        source: 'robo_trader',
        severity: 'warning',
        eventType: 'policy_blocked',
        symbol,
        strategyId: candidateSignal.strategyId || null,
        assetClass: candidateSignal.assetClass || 'equity',
        message: reason,
        payload: {
          signalId,
          reasons: policyDecision.reasons,
          instrument: policyDecision.instrument,
          mode: policyDecision.mode
        }
      });
      await finalizeRun('skipped', {
        summary: {
          signalId,
          reason: 'POLICY_BLOCKED'
        },
        result: {
          reasons: policyDecision.reasons
        }
      });
      return { ok: false, executed: false, skipped: true, reason: 'POLICY_BLOCKED', signalId };
    }

    if (executionControls.maxExecutionsPerStrategyPerDay > 0 && candidateSignal.strategyId) {
      const dayStart = getBucketStart(now, 'day');
      const executedForStrategy = await countExecutedSignalsForStrategySince(
        userId,
        candidateSignal.strategyId,
        dayStart,
        deps
      );
      if (executedForStrategy >= executionControls.maxExecutionsPerStrategyPerDay) {
        await writeAuditLog(userId, 'trade_skipped_strategy_limit', {
          reason: 'Reached max Robo executions for strategy today.',
          strategyId: candidateSignal.strategyId,
          executedForStrategy,
          maxExecutionsPerStrategyPerDay: executionControls.maxExecutionsPerStrategyPerDay,
          dayStart: dayStart.toISOString(),
          at: now.toISOString()
        }, deps);
        await finalizeRun('skipped', {
          summary: { signalId, reason: 'STRATEGY_LIMIT' }
        });
        return { ok: false, executed: false, skipped: true, reason: 'STRATEGY_LIMIT' };
      }
    }

    if (executionControls.minMinutesBetweenSymbolExecutions > 0) {
      const symbolCutoff = new Date(
        now.getTime() - (executionControls.minMinutesBetweenSymbolExecutions * 60 * 1000)
      );
      const recentBySymbol = await findRecentExecutedSignalForSymbol(userId, symbol, symbolCutoff, deps);
      if (recentBySymbol) {
        await writeAuditLog(userId, 'trade_skipped_symbol_cooldown', {
          reason: 'Symbol-level Robo cooldown is active.',
          symbol,
          minMinutesBetweenSymbolExecutions: executionControls.minMinutesBetweenSymbolExecutions,
          lastExecutedAt: recentBySymbol.executedAt || recentBySymbol.updatedAt || null,
          at: now.toISOString()
        }, deps);
        await finalizeRun('skipped', {
          summary: { signalId, reason: 'SYMBOL_COOLDOWN' }
        });
        return { ok: false, executed: false, skipped: true, reason: 'SYMBOL_COOLDOWN' };
      }
    }

    if (executionControls.slippageAnomalyBpsThreshold > 0 && deps.RoboAuditLog?.find) {
      const recentEvents = await deps.RoboAuditLog.find({
        userId,
        eventType: 'trade_executed'
      })
        .sort({ createdAt: -1 })
        .limit(executionControls.slippageAnomalyLookback)
        .lean();
      const anomaly = detectExecutionAnomaly(
        recentEvents,
        executionControls.slippageAnomalyBpsThreshold
      );
      if (anomaly.anomalous) {
        await writeAuditLog(userId, 'trade_skipped_anomaly', {
          reason: 'Execution anomaly guardrail triggered due to slippage spike.',
          thresholdBps: executionControls.slippageAnomalyBpsThreshold,
          maxRecentSlippageBps: anomaly.maxBps,
          avgRecentSlippageBps: anomaly.avgBps,
          samples: anomaly.samples,
          at: now.toISOString()
        }, deps);
        return { ok: false, executed: false, skipped: true, reason: 'ANOMALY_GUARDRAIL' };
      }
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

    const quotes = await deps.fetchQuotes(
      [symbol],
      candidateSignal.assetClass ? { assetClass: candidateSignal.assetClass } : undefined
    );
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
      await finalizeRun('skipped', {
        summary: { signalId, reason: 'NO_QUOTE' }
      });
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
      const limitLabelMap = {
        daily: 'daily',
        weekly: 'weekly',
        monthly: 'monthly'
      };
      const violatedLabels = limitDecision.violations
        .map(item => limitLabelMap[item] || item)
        .join(', ');
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
        reason: `Would exceed ${violatedLabels} spending limit${limitDecision.violations.length > 1 ? 's' : ''}.`,
        violations: limitDecision.violations,
        usage: usageSnapshot
      }, deps);
      await finalizeRun('skipped', {
        summary: { signalId, reason: 'LIMIT_EXCEEDED' },
        result: {
          usage: usageSnapshot,
          violations: limitDecision.violations
        }
      });
      return { ok: false, executed: false, skipped: true, reason: 'LIMIT_EXCEEDED', signalId };
    }

    const execution = executionBackend === 'alpaca'
      ? await placeAlpacaOrder({
          symbol,
          side,
          qty,
          assetClass: candidateSignal.assetClass || 'equity',
          allowExtendedHours: executionControls.allowExtendedHours,
          estimatedPrice
        })
      : await deps.paperBroker.placeOrder({
          symbol,
          side,
          qty,
          assetClass: candidateSignal.assetClass || undefined,
          orderType: 'market',
          allowExtendedHours: executionControls.allowExtendedHours,
          strategyId: candidateSignal.strategyId || null,
          setupType: 'ROBO',
          strategyTags: ['robo'],
          stopPrice: candidateSignal.stopPrice || null,
          origin: 'robo',
          metadata: {
            userId: String(userId),
            signalId,
            strategyName: candidateSignal.strategyName || AUTO_STRATEGY_NAME
          }
        });

    const order = execution?.order || {};
    const trade = execution?.trade || {};
    const executedNotional = Number(toFiniteNumber(order.notional, trade.notional || estimatedNotional).toFixed(2));
    const fillPrice = Number(toFiniteNumber(order.fillPrice, trade.price || estimatedPrice).toFixed(4));
    const slippageBps = estimatedPrice > 0
      ? Number((((side === 'buy'
        ? (fillPrice - estimatedPrice)
        : (estimatedPrice - fillPrice)) / estimatedPrice) * 10000).toFixed(2))
      : 0;
    const usageNotional = side === 'buy' ? executedNotional : 0;

    await incrementUsageBuckets(userId, now, usageNotional, deps);

    const eventPayload = {
      symbol,
      side,
      qty,
      estimatedPrice,
      fillPrice,
      slippageBps,
      notional: executedNotional,
      usageNotional,
      executionBackend,
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

    if (executionBackend === 'alpaca') {
      await recordFilledExecution({
        broker: 'alpaca',
        origin: 'robo',
        request: {
          accountId: String(userId),
          origin: 'robo',
          broker: 'alpaca',
          symbol,
          assetClass: candidateSignal.assetClass || 'equity',
          side,
          qty,
          orderType: 'market',
          timeInForce: 'day',
          allowExtendedHours: executionControls.allowExtendedHours,
          strategyId: candidateSignal.strategyId || AUTO_STRATEGY_ID,
          setupType: 'ROBO',
          metadata: {
            signalId,
            strategyName: candidateSignal.strategyName || AUTO_STRATEGY_NAME
          }
        },
        order: {
          id: eventPayload.orderId,
          fillPrice,
          notional: executedNotional,
          estimatedPrice,
          fillLatencyMs: null,
          effectiveSlippageBps: slippageBps,
          filledAt: now
        },
        trade: {
          symbol,
          assetClass: candidateSignal.assetClass || 'equity',
          side,
          qty,
          price: fillPrice,
          notional: executedNotional,
          strategyId: candidateSignal.strategyId || AUTO_STRATEGY_ID,
          setupType: 'ROBO',
          realizedPnl: null,
          filledAt: now
        }
      });
    }

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

    await finalizeRun('completed', {
      metrics: {
        slippageBps,
        notional: executedNotional
      },
      summary: {
        signalId,
        orderId: eventPayload.orderId,
        reason: 'EXECUTED'
      },
      result: {
        executionBackend,
        orderId: eventPayload.orderId
      }
    });

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
    if (executionBackend === 'alpaca' && symbol && qty > 0) {
      await recordRejectedExecution({
        broker: 'alpaca',
        origin: 'robo',
        rejectedReason: err?.message || 'Execution failed',
        request: {
          accountId: String(userId),
          origin: 'robo',
          broker: 'alpaca',
          symbol,
          assetClass: candidateSignal?.assetClass || 'equity',
          side,
          qty,
          orderType: 'market',
          timeInForce: 'day',
          allowExtendedHours: executionControls.allowExtendedHours,
          strategyId: candidateSignal?.strategyId || AUTO_STRATEGY_ID,
          setupType: 'ROBO',
          metadata: {
            signalId,
            strategyName: candidateSignal?.strategyName || AUTO_STRATEGY_NAME
          }
        }
      });
    } else if (symbol && qty > 0 && typeof deps.paperBroker?.recordRejectedOrder === 'function') {
      await deps.paperBroker.recordRejectedOrder({
        symbol,
        side,
        qty,
        assetClass: candidateSignal?.assetClass || 'equity',
        orderType: 'market',
        allowExtendedHours: executionControls.allowExtendedHours,
        strategyId: candidateSignal?.strategyId || AUTO_STRATEGY_ID,
        setupType: 'ROBO',
        origin: 'robo',
        metadata: {
          userId: String(userId),
          signalId,
          strategyName: candidateSignal?.strategyName || AUTO_STRATEGY_NAME
        }
      }, err?.message || 'Execution failed');
    }

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
    await finalizeRun('failed', {
      summary: {
        signalId,
        reason: err?.message || 'Execution failed'
      },
      error: err?.message || 'Execution failed'
    });
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

async function getStatusForUser(userId, now = new Date(), deps = defaultDeps) {
  const settingsDoc = await getOrCreateSettings(userId, deps);
  const usage = await getUsageSnapshotForUser(userId, now, deps);
  const settings = toSettingsPayload(settingsDoc);
  const lastEvent = await deps.RoboAuditLog.findOne({ userId }).sort({ createdAt: -1 }).lean();
  const lastTrade = await deps.RoboAuditLog.findOne({ userId, eventType: 'trade_executed' })
    .sort({ createdAt: -1 })
    .lean();
  const since = new Date(now.getTime() - (24 * 60 * 60 * 1000));
  const recentEvents = await deps.RoboAuditLog.find({
    userId,
    createdAt: { $gte: since }
  }).lean();

  const counters24h = recentEvents.reduce((acc, event) => {
    acc[event.eventType] = (acc[event.eventType] || 0) + 1;
    return acc;
  }, {});

  const executedToday = await countExecutedSignalsSince(userId, getBucketStart(now, 'day'), deps);
  const executionControls = getExecutionControls();
  const signalSelection = getSignalSelectionConfig();

  return {
    settings,
    usage,
    executionControls,
    lastEvent: lastEvent
      ? {
          eventType: lastEvent.eventType,
          createdAt: lastEvent.createdAt,
          payload: lastEvent.payload || {}
        }
      : null,
    lastTrade: lastTrade
      ? {
          createdAt: lastTrade.createdAt,
          payload: lastTrade.payload || {}
        }
      : null,
    counters24h,
    executedToday,
    signalSelection: {
      universe: getSignalUniverse(),
      allowedSides: signalSelection.allowedSides,
      changeThresholdPct: signalSelection.changeThresholdPct,
      targetNotional: signalSelection.targetNotional
    }
  };
}

async function runSchedulerTick(deps = defaultDeps) {
  const enabled = await deps.RoboSettings.find({ enabled: true }).lean();
  for (const setting of enabled) {
    try {
      const now = new Date();
      const signal = await buildAutoSignalForUser({
        userId: setting.userId,
        now
      }, deps);
      if (!signal) {
        await writeAuditLog(setting.userId, 'trade_skipped_no_signal', {
          reason: 'No eligible symbols from configured Robo signal universe.',
          universe: getSignalUniverse(),
          at: now.toISOString()
        }, deps);
        continue;
      }
      await runRoboTradeForUser({ userId: setting.userId, signal, now }, deps);
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
  getStatusForUser,
  cleanupSignalExecutions,
  buildAutoSignalForUser,
  runRoboTradeForUser,
  runSchedulerTick
};

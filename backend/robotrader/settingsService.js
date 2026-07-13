const RoboSettings = require('../models/RoboSettings');
const {
  APPROVAL_MODES,
  normalizeApprovalPolicy
} = require('../services/canonicalTradingPolicyService');

const LIVE_CONFIRMATION_TEXT = 'I understand live trading risk';
const AUTONOMOUS_CONFIRMATION_TEXT = 'I understand autonomous live trading risk';

const DEFAULT_ROBOTRADER_SETTINGS = Object.freeze({
  enabled: false,
  isEnabled: false,
  controlGeneration: 0,
  mode: 'paper',
  liveTradingExplicitlyEnabled: false,
  allowedAssetClasses: ['stocks'],
  allowedSymbols: [],
  blockedSymbols: [],
  maxTradeAmount: 1000,
  maxPositionSize: 5000,
  maxDailyLoss: 500,
  maxOpenPositions: 5,
  maxTradesPerDay: 3,
  allowShortSelling: false,
  allowFractionalShares: true,
  allowExtendedHours: false,
  allowOptionsTrading: false,
  allowCryptoTrading: false,
  riskLevel: 'balanced',
  approvalPolicy: {
    mode: APPROVAL_MODES.EVERY_TRADE,
    thresholdUsd: 0,
    authorizationTtlSeconds: 300,
    requireExactOrderMatch: true
  },
  executionPolicy: {
    maxQuoteAgeSeconds: 15,
    maxSpreadBps: 35,
    minAverageDailyDollarVolume: 20000000,
    maxEstimatedSlippageBps: 25,
    cutoffMinutesBeforeClose: 15,
    regularSessionCutoffEt: '15:45'
  },
  portfolioPolicy: {
    maxGrossExposurePct: 100,
    maxNetExposurePct: 100,
    maxDailyDrawdownPct: 2,
    maxTotalDrawdownPct: 5,
    pauseOnBreach: true
  },
  requireManualApprovalAboveDollarAmount: 0,
  pausedReason: null
});

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toNonNegativeNumber(value, fallback = 0) {
  return Math.max(0, toFiniteNumber(value, fallback));
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9./-]/g, '');
}

function normalizeSymbolList(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return [...new Set(raw.map(normalizeSymbol).filter(Boolean))];
}

function normalizeAssetClass(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['stock', 'stocks', 'equity', 'equities'].includes(normalized)) return 'stocks';
  if (normalized === 'crypto') return 'crypto';
  if (['option', 'options'].includes(normalized)) return 'options';
  return null;
}

function normalizeAssetClasses(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const classes = [...new Set(raw.map(normalizeAssetClass).filter(Boolean))];
  return classes.length ? classes : ['stocks'];
}

function normalizeRiskLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['conservative', 'balanced', 'aggressive'].includes(normalized)) return normalized;
  return 'balanced';
}

function normalizeMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'live') return 'live';
  if (['shadow', 'shadow-live', 'shadow_live'].includes(normalized)) return 'shadow';
  return 'paper';
}

function clampNumber(value, fallback, min, max) {
  return Math.min(max, Math.max(min, toFiniteNumber(value, fallback)));
}

function normalizeExecutionPolicy(policy = {}) {
  const defaults = DEFAULT_ROBOTRADER_SETTINGS.executionPolicy;
  return {
    maxQuoteAgeSeconds: clampNumber(policy.maxQuoteAgeSeconds, defaults.maxQuoteAgeSeconds, 1, 300),
    maxSpreadBps: clampNumber(policy.maxSpreadBps, defaults.maxSpreadBps, 1, 500),
    minAverageDailyDollarVolume: clampNumber(
      policy.minAverageDailyDollarVolume,
      defaults.minAverageDailyDollarVolume,
      0,
      Number.MAX_SAFE_INTEGER
    ),
    maxEstimatedSlippageBps: clampNumber(
      policy.maxEstimatedSlippageBps,
      defaults.maxEstimatedSlippageBps,
      1,
      500
    ),
    cutoffMinutesBeforeClose: clampNumber(
      policy.cutoffMinutesBeforeClose,
      defaults.cutoffMinutesBeforeClose,
      0,
      120
    ),
    // Sprint 2 deliberately fixes the regular-session cutoff at 3:45 PM ET.
    regularSessionCutoffEt: '15:45'
  };
}

function normalizePortfolioPolicy(policy = {}) {
  const defaults = DEFAULT_ROBOTRADER_SETTINGS.portfolioPolicy;
  return {
    maxGrossExposurePct: clampNumber(policy.maxGrossExposurePct, defaults.maxGrossExposurePct, 0, 1000),
    maxNetExposurePct: clampNumber(policy.maxNetExposurePct, defaults.maxNetExposurePct, 0, 1000),
    maxDailyDrawdownPct: clampNumber(policy.maxDailyDrawdownPct, defaults.maxDailyDrawdownPct, 0, 100),
    maxTotalDrawdownPct: clampNumber(policy.maxTotalDrawdownPct, defaults.maxTotalDrawdownPct, 0, 100),
    pauseOnBreach: sanitizeBoolean(policy.pauseOnBreach, defaults.pauseOnBreach)
  };
}

function sanitizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function mapSettings(settingsDoc) {
  const doc = settingsDoc?.toObject ? settingsDoc.toObject() : (settingsDoc || {});
  const isEnabled = Boolean(doc.isEnabled || doc.enabled);
  return {
    _id: doc._id,
    userId: doc.userId,
    enabled: isEnabled,
    isEnabled,
    controlGeneration: Math.max(0, Math.floor(toFiniteNumber(doc.controlGeneration, 0))),
    mode: normalizeMode(doc.mode),
    liveTradingExplicitlyEnabled: Boolean(doc.liveTradingExplicitlyEnabled),
    allowedAssetClasses: normalizeAssetClasses(doc.allowedAssetClasses),
    allowedSymbols: normalizeSymbolList(doc.allowedSymbols),
    blockedSymbols: normalizeSymbolList(doc.blockedSymbols),
    maxTradeAmount: toNonNegativeNumber(doc.maxTradeAmount, DEFAULT_ROBOTRADER_SETTINGS.maxTradeAmount),
    maxPositionSize: toNonNegativeNumber(doc.maxPositionSize, DEFAULT_ROBOTRADER_SETTINGS.maxPositionSize),
    maxDailyLoss: toNonNegativeNumber(doc.maxDailyLoss, DEFAULT_ROBOTRADER_SETTINGS.maxDailyLoss),
    maxOpenPositions: Math.max(0, Math.floor(toFiniteNumber(doc.maxOpenPositions, DEFAULT_ROBOTRADER_SETTINGS.maxOpenPositions))),
    maxTradesPerDay: Math.max(0, Math.floor(toFiniteNumber(doc.maxTradesPerDay, DEFAULT_ROBOTRADER_SETTINGS.maxTradesPerDay))),
    allowShortSelling: Boolean(doc.allowShortSelling),
    allowFractionalShares: doc.allowFractionalShares !== false,
    allowExtendedHours: Boolean(doc.allowExtendedHours),
    allowOptionsTrading: Boolean(doc.allowOptionsTrading),
    allowCryptoTrading: Boolean(doc.allowCryptoTrading),
    riskLevel: normalizeRiskLevel(doc.riskLevel),
    approvalPolicy: normalizeApprovalPolicy(
      doc.approvalPolicy,
      doc.requireManualApprovalAboveDollarAmount
    ),
    executionPolicy: normalizeExecutionPolicy(doc.executionPolicy),
    portfolioPolicy: normalizePortfolioPolicy(doc.portfolioPolicy),
    requireManualApprovalAboveDollarAmount: toNonNegativeNumber(
      doc.requireManualApprovalAboveDollarAmount,
      DEFAULT_ROBOTRADER_SETTINGS.requireManualApprovalAboveDollarAmount
    ),
    dailyLimit: toNonNegativeNumber(doc.dailyLimit, 0),
    weeklyLimit: toNonNegativeNumber(doc.weeklyLimit, 0),
    monthlyLimit: toNonNegativeNumber(doc.monthlyLimit, 0),
    failureStreak: Math.max(0, Math.floor(toFiniteNumber(doc.failureStreak, 0))),
    pausedUntil: doc.pausedUntil || null,
    pausedReason: doc.pausedReason || null,
    lastRunAt: doc.lastRunAt || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null
  };
}

function sanitizeSettingsUpdate(input = {}, current = {}) {
  const update = {};

  if (input.isEnabled !== undefined || input.enabled !== undefined) {
    const enabled = sanitizeBoolean(input.isEnabled ?? input.enabled, Boolean(current.isEnabled || current.enabled));
    update.isEnabled = enabled;
    update.enabled = enabled;
    if (!enabled && input.pausedReason === undefined) update.pausedReason = 'Disabled by user.';
  }

  if (input.mode !== undefined) {
    const mode = normalizeMode(input.mode);
    if (mode === 'live') {
      const liveOptIn = sanitizeBoolean(
        input.liveTradingExplicitlyEnabled,
        Boolean(current.liveTradingExplicitlyEnabled)
      );
      if (!liveOptIn || input.confirmLiveTrading !== LIVE_CONFIRMATION_TEXT) {
        const err = new Error('Live trading requires explicit confirmation before it can be enabled.');
        err.status = 400;
        throw err;
      }
      update.liveTradingExplicitlyEnabled = true;
    } else {
      // A live opt-in is a property of the current live-mode session. Clearing
      // it when paper mode is selected prevents a stale flag from authorizing
      // a later live-only action.
      update.liveTradingExplicitlyEnabled = false;
    }
    update.mode = mode;
  }

  if (input.liveTradingExplicitlyEnabled !== undefined && input.mode === undefined) {
    const requested = sanitizeBoolean(input.liveTradingExplicitlyEnabled, false);
    if (requested && normalizeMode(current.mode) !== 'live') {
      const err = new Error('Live trading opt-in can only be enabled while live mode is active.');
      err.status = 400;
      throw err;
    }
    if (requested && input.confirmLiveTrading !== LIVE_CONFIRMATION_TEXT) {
      const err = new Error('Live trading requires explicit confirmation before it can be enabled.');
      err.status = 400;
      throw err;
    }
    update.liveTradingExplicitlyEnabled = requested;
  }

  if (input.allowedAssetClasses !== undefined) update.allowedAssetClasses = normalizeAssetClasses(input.allowedAssetClasses);
  if (input.allowedSymbols !== undefined) update.allowedSymbols = normalizeSymbolList(input.allowedSymbols);
  if (input.blockedSymbols !== undefined) update.blockedSymbols = normalizeSymbolList(input.blockedSymbols);
  if (input.maxTradeAmount !== undefined) update.maxTradeAmount = toNonNegativeNumber(input.maxTradeAmount);
  if (input.maxPositionSize !== undefined) update.maxPositionSize = toNonNegativeNumber(input.maxPositionSize);
  if (input.maxDailyLoss !== undefined) update.maxDailyLoss = toNonNegativeNumber(input.maxDailyLoss);
  if (input.maxOpenPositions !== undefined) update.maxOpenPositions = Math.max(0, Math.floor(toFiniteNumber(input.maxOpenPositions)));
  if (input.maxTradesPerDay !== undefined) update.maxTradesPerDay = Math.max(0, Math.floor(toFiniteNumber(input.maxTradesPerDay)));
  if (input.allowShortSelling !== undefined) update.allowShortSelling = sanitizeBoolean(input.allowShortSelling);
  if (input.allowFractionalShares !== undefined) update.allowFractionalShares = sanitizeBoolean(input.allowFractionalShares, true);
  if (input.allowExtendedHours !== undefined) update.allowExtendedHours = sanitizeBoolean(input.allowExtendedHours);
  if (input.allowOptionsTrading !== undefined) update.allowOptionsTrading = sanitizeBoolean(input.allowOptionsTrading);
  if (input.allowCryptoTrading !== undefined) update.allowCryptoTrading = sanitizeBoolean(input.allowCryptoTrading);
  if (input.riskLevel !== undefined) update.riskLevel = normalizeRiskLevel(input.riskLevel);
  if (input.approvalPolicy !== undefined) {
    const approvalPolicy = normalizeApprovalPolicy(
      input.approvalPolicy,
      current.requireManualApprovalAboveDollarAmount
    );
    const currentApprovalPolicy = normalizeApprovalPolicy(
      current.approvalPolicy,
      current.requireManualApprovalAboveDollarAmount
    );
    if (
      approvalPolicy.mode === APPROVAL_MODES.AUTONOMOUS
      && currentApprovalPolicy.mode !== APPROVAL_MODES.AUTONOMOUS
      && input.confirmAutonomousTrading !== AUTONOMOUS_CONFIRMATION_TEXT
    ) {
      const err = new Error('Autonomous trading requires a separate explicit confirmation.');
      err.status = 400;
      throw err;
    }
    update.approvalPolicy = approvalPolicy;
    update.requireManualApprovalAboveDollarAmount = approvalPolicy.mode === APPROVAL_MODES.ABOVE_THRESHOLD
      ? approvalPolicy.thresholdUsd
      : 0;
  }
  if (input.executionPolicy !== undefined) {
    update.executionPolicy = normalizeExecutionPolicy(input.executionPolicy);
  }
  if (input.portfolioPolicy !== undefined) {
    update.portfolioPolicy = normalizePortfolioPolicy(input.portfolioPolicy);
  }
  if (input.requireManualApprovalAboveDollarAmount !== undefined) {
    const legacyThreshold = toNonNegativeNumber(input.requireManualApprovalAboveDollarAmount);
    update.requireManualApprovalAboveDollarAmount = legacyThreshold;
    if (input.approvalPolicy === undefined) {
      update.approvalPolicy = normalizeApprovalPolicy({}, legacyThreshold);
    }
  }
  if (input.pausedReason !== undefined) update.pausedReason = input.pausedReason ? String(input.pausedReason).slice(0, 500) : null;

  return update;
}

async function getOrCreateRoboTraderSettings(userId) {
  const findLatest = async () => {
    const query = RoboSettings.findOne({ userId });
    return typeof query?.sort === 'function'
      ? query.sort({
        isEnabled: -1,
        enabled: -1,
        updatedAt: -1,
        createdAt: -1
      })
      : query;
  };

  let settings = await findLatest();
  if (settings) return settings;
  try {
    settings = await RoboSettings.create({
      userId,
      ...DEFAULT_ROBOTRADER_SETTINGS,
      dailyLimit: 0,
      weeklyLimit: 0,
      monthlyLimit: 0
    });
    return settings;
  } catch (err) {
    if (err?.code !== 11000) throw err;
    settings = await findLatest();
    if (settings) return settings;
    throw err;
  }
}

async function updateRoboTraderSettings(userId, input = {}) {
  const settings = await getOrCreateRoboTraderSettings(userId);
  const sanitized = sanitizeSettingsUpdate(input, settings);
  return RoboSettings.findOneAndUpdate(
    { userId },
    {
      $set: sanitized,
      $inc: { controlGeneration: 1 }
    },
    {
      new: true,
      runValidators: true
    }
  );
}

module.exports = {
  AUTONOMOUS_CONFIRMATION_TEXT,
  DEFAULT_ROBOTRADER_SETTINGS,
  LIVE_CONFIRMATION_TEXT,
  getOrCreateRoboTraderSettings,
  mapSettings,
  normalizeExecutionPolicy,
  normalizePortfolioPolicy,
  normalizeAssetClass,
  normalizeAssetClasses,
  normalizeMode,
  normalizeSymbol,
  normalizeSymbolList,
  sanitizeSettingsUpdate,
  updateRoboTraderSettings
};

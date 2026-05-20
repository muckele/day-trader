const RoboSettings = require('../models/RoboSettings');

const LIVE_CONFIRMATION_TEXT = 'I understand live trading risk';

const DEFAULT_ROBOTRADER_SETTINGS = Object.freeze({
  enabled: false,
  isEnabled: false,
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
  return String(value || '').trim().toLowerCase() === 'live' ? 'live' : 'paper';
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
    }
    update.mode = mode;
  }

  if (input.liveTradingExplicitlyEnabled !== undefined && input.mode === undefined) {
    const requested = sanitizeBoolean(input.liveTradingExplicitlyEnabled, false);
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
  if (input.requireManualApprovalAboveDollarAmount !== undefined) {
    update.requireManualApprovalAboveDollarAmount = toNonNegativeNumber(input.requireManualApprovalAboveDollarAmount);
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
  Object.assign(settings, sanitized);
  await settings.save();
  return settings;
}

module.exports = {
  DEFAULT_ROBOTRADER_SETTINGS,
  LIVE_CONFIRMATION_TEXT,
  getOrCreateRoboTraderSettings,
  mapSettings,
  normalizeAssetClass,
  normalizeAssetClasses,
  normalizeMode,
  normalizeSymbol,
  normalizeSymbolList,
  sanitizeSettingsUpdate,
  updateRoboTraderSettings
};

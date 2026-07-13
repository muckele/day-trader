const crypto = require('node:crypto');

const POLICY_VERSION = 'controlled-live-readiness-v2';

const APPROVAL_MODES = Object.freeze({
  EVERY_TRADE: 'every_trade',
  ABOVE_THRESHOLD: 'above_threshold',
  AUTONOMOUS: 'autonomous'
});

const REASON_CODES = Object.freeze({
  ROBOTRADER_DISABLED: 'ROBOTRADER_DISABLED',
  LIVE_TRADING_NOT_ENABLED: 'LIVE_TRADING_NOT_ENABLED',
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
  SYMBOL_REQUIRED: 'SYMBOL_REQUIRED',
  ASSET_LOOKUP_FAILED: 'ASSET_LOOKUP_FAILED',
  ASSET_NOT_TRADABLE: 'ASSET_NOT_TRADABLE',
  ASSET_NOT_FRACTIONABLE: 'ASSET_NOT_FRACTIONABLE',
  ASSET_NOT_SHORTABLE: 'ASSET_NOT_SHORTABLE',
  SYMBOL_BLOCKED: 'SYMBOL_BLOCKED',
  SYMBOL_NOT_ALLOWED: 'SYMBOL_NOT_ALLOWED',
  ASSET_CLASS_NOT_ALLOWED: 'ASSET_CLASS_NOT_ALLOWED',
  MARKET_CLOSED: 'MARKET_CLOSED',
  EXTENDED_HOURS_NOT_ALLOWED: 'EXTENDED_HOURS_NOT_ALLOWED',
  EXTENDED_HOURS_PROTECTION_UNAVAILABLE: 'EXTENDED_HOURS_PROTECTION_UNAVAILABLE',
  CRYPTO_NOT_ALLOWED: 'CRYPTO_NOT_ALLOWED',
  OPTIONS_NOT_ALLOWED: 'OPTIONS_NOT_ALLOWED',
  SHORT_SELLING_NOT_ALLOWED: 'SHORT_SELLING_NOT_ALLOWED',
  FRACTIONAL_SHORT_NOT_ALLOWED: 'FRACTIONAL_SHORT_NOT_ALLOWED',
  ORDER_CAPABILITY_INVALID: 'ORDER_CAPABILITY_INVALID',
  DAILY_LOSS_LIMIT_EXCEEDED: 'DAILY_LOSS_LIMIT_EXCEEDED',
  DAILY_TRADE_LIMIT_EXCEEDED: 'DAILY_TRADE_LIMIT_EXCEEDED',
  OPEN_POSITION_LIMIT_EXCEEDED: 'OPEN_POSITION_LIMIT_EXCEEDED',
  TRADE_AMOUNT_LIMIT_EXCEEDED: 'TRADE_AMOUNT_LIMIT_EXCEEDED',
  POSITION_SIZE_LIMIT_EXCEEDED: 'POSITION_SIZE_LIMIT_EXCEEDED',
  BUYING_POWER_INSUFFICIENT: 'BUYING_POWER_INSUFFICIENT',
  DUPLICATE_OPEN_ORDER: 'DUPLICATE_OPEN_ORDER',
  SYMBOL_COOLDOWN_ACTIVE: 'SYMBOL_COOLDOWN_ACTIVE',
  CONFIDENCE_BELOW_MINIMUM: 'CONFIDENCE_BELOW_MINIMUM',
  REWARD_RISK_BELOW_MINIMUM: 'REWARD_RISK_BELOW_MINIMUM',
  STOP_LOSS_REQUIRED: 'STOP_LOSS_REQUIRED',
  FRACTIONAL_SHARES_NOT_ALLOWED: 'FRACTIONAL_SHARES_NOT_ALLOWED',
  AUTHORIZATION_REQUIRED: 'AUTHORIZATION_REQUIRED',
  AUTHORIZATION_EXPIRED: 'AUTHORIZATION_EXPIRED',
  AUTHORIZATION_REVOKED: 'AUTHORIZATION_REVOKED',
  AUTHORIZATION_ORDER_MISMATCH: 'AUTHORIZATION_ORDER_MISMATCH',
  AUTHORIZATION_POLICY_VERSION_MISMATCH: 'AUTHORIZATION_POLICY_VERSION_MISMATCH',
  ORDER_NOTIONAL_UNVERIFIED: 'ORDER_NOTIONAL_UNVERIFIED',
  SCORE_BELOW_MINIMUM: 'SCORE_BELOW_MINIMUM',
  SCORE_REVIEW_ONLY: 'SCORE_REVIEW_ONLY',
  EXECUTION_VETO: 'EXECUTION_VETO',
  MARKET_DATA_NOT_LIVE: 'MARKET_DATA_NOT_LIVE',
  QUOTE_STALE: 'QUOTE_STALE',
  SPREAD_TOO_WIDE: 'SPREAD_TOO_WIDE',
  LIQUIDITY_TOO_LOW: 'LIQUIDITY_TOO_LOW',
  SLIPPAGE_TOO_HIGH: 'SLIPPAGE_TOO_HIGH',
  NEW_ORDER_CUTOFF_REACHED: 'NEW_ORDER_CUTOFF_REACHED',
  GROSS_EXPOSURE_LIMIT_EXCEEDED: 'GROSS_EXPOSURE_LIMIT_EXCEEDED',
  NET_EXPOSURE_LIMIT_EXCEEDED: 'NET_EXPOSURE_LIMIT_EXCEEDED',
  DAILY_DRAWDOWN_LIMIT_EXCEEDED: 'DAILY_DRAWDOWN_LIMIT_EXCEEDED',
  TOTAL_DRAWDOWN_LIMIT_EXCEEDED: 'TOTAL_DRAWDOWN_LIMIT_EXCEEDED',
  WORKING_ORDER_EXPOSURE_UNVERIFIED: 'WORKING_ORDER_EXPOSURE_UNVERIFIED',
  RISK_CHECK_FAILED: 'RISK_CHECK_FAILED'
});

const RISK_CHECK_REASON_CODES = Object.freeze({
  robotrader_enabled: REASON_CODES.ROBOTRADER_DISABLED,
  mode_allowed: REASON_CODES.LIVE_TRADING_NOT_ENABLED,
  mode_match: REASON_CODES.LIVE_TRADING_NOT_ENABLED,
  account_allowed: REASON_CODES.ACCOUNT_RESTRICTED,
  symbol_present: REASON_CODES.SYMBOL_REQUIRED,
  asset_lookup: REASON_CODES.ASSET_LOOKUP_FAILED,
  asset_tradable: REASON_CODES.ASSET_NOT_TRADABLE,
  asset_fractionable: REASON_CODES.ASSET_NOT_FRACTIONABLE,
  asset_shortable: REASON_CODES.ASSET_NOT_SHORTABLE,
  symbol_not_blocked: REASON_CODES.SYMBOL_BLOCKED,
  symbol_allowed: REASON_CODES.SYMBOL_NOT_ALLOWED,
  asset_class_allowed: REASON_CODES.ASSET_CLASS_NOT_ALLOWED,
  market_hours: REASON_CODES.MARKET_CLOSED,
  extended_hours_allowed: REASON_CODES.EXTENDED_HOURS_NOT_ALLOWED,
  extended_hours_protection: REASON_CODES.EXTENDED_HOURS_PROTECTION_UNAVAILABLE,
  crypto_enabled: REASON_CODES.CRYPTO_NOT_ALLOWED,
  options_enabled: REASON_CODES.OPTIONS_NOT_ALLOWED,
  short_allowed: REASON_CODES.SHORT_SELLING_NOT_ALLOWED,
  fractional_short_allowed: REASON_CODES.FRACTIONAL_SHORT_NOT_ALLOWED,
  order_capability: REASON_CODES.ORDER_CAPABILITY_INVALID,
  daily_loss_limit: REASON_CODES.DAILY_LOSS_LIMIT_EXCEEDED,
  trades_per_day: REASON_CODES.DAILY_TRADE_LIMIT_EXCEEDED,
  open_positions: REASON_CODES.OPEN_POSITION_LIMIT_EXCEEDED,
  trade_amount: REASON_CODES.TRADE_AMOUNT_LIMIT_EXCEEDED,
  position_size: REASON_CODES.POSITION_SIZE_LIMIT_EXCEEDED,
  buying_power: REASON_CODES.BUYING_POWER_INSUFFICIENT,
  duplicate_order: REASON_CODES.DUPLICATE_OPEN_ORDER,
  symbol_cooldown: REASON_CODES.SYMBOL_COOLDOWN_ACTIVE,
  confidence: REASON_CODES.CONFIDENCE_BELOW_MINIMUM,
  reward_risk: REASON_CODES.REWARD_RISK_BELOW_MINIMUM,
  stop_loss_required: REASON_CODES.STOP_LOSS_REQUIRED,
  fractional_allowed: REASON_CODES.FRACTIONAL_SHARES_NOT_ALLOWED,
  order_notional_verified: REASON_CODES.ORDER_NOTIONAL_UNVERIFIED,
  market_session_open: REASON_CODES.MARKET_CLOSED,
  new_order_cutoff: REASON_CODES.NEW_ORDER_CUTOFF_REACHED,
  market_data_live: REASON_CODES.MARKET_DATA_NOT_LIVE,
  quote_fresh: REASON_CODES.QUOTE_STALE,
  spread_allowed: REASON_CODES.SPREAD_TOO_WIDE,
  liquidity_allowed: REASON_CODES.LIQUIDITY_TOO_LOW,
  slippage_allowed: REASON_CODES.SLIPPAGE_TOO_HIGH,
  gross_exposure_limit: REASON_CODES.GROSS_EXPOSURE_LIMIT_EXCEEDED,
  net_exposure_limit: REASON_CODES.NET_EXPOSURE_LIMIT_EXCEEDED,
  daily_drawdown_limit: REASON_CODES.DAILY_DRAWDOWN_LIMIT_EXCEEDED,
  total_drawdown_limit: REASON_CODES.TOTAL_DRAWDOWN_LIMIT_EXCEEDED,
  working_order_exposure_verified: REASON_CODES.WORKING_ORDER_EXPOSURE_UNVERIFIED,
  projected_gross_exposure_limit: REASON_CODES.GROSS_EXPOSURE_LIMIT_EXCEEDED,
  projected_net_exposure_limit: REASON_CODES.NET_EXPOSURE_LIMIT_EXCEEDED
});

function toFiniteNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInteger(value, fallback) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeApprovalPolicy(policy = {}, legacyThreshold = 0) {
  const requestedMode = String(policy?.mode || '').trim().toLowerCase();
  const legacy = Math.max(0, toFiniteNumber(legacyThreshold, 0));
  const mode = Object.values(APPROVAL_MODES).includes(requestedMode)
    ? requestedMode
    : (legacy > 0 ? APPROVAL_MODES.ABOVE_THRESHOLD : APPROVAL_MODES.EVERY_TRADE);
  const thresholdUsd = Math.max(
    0,
    toFiniteNumber(policy?.thresholdUsd ?? policy?.threshold_usd, legacy)
  );
  const authorizationTtlSeconds = Math.min(
    3600,
    Math.max(30, toPositiveInteger(
      policy?.authorizationTtlSeconds ?? policy?.authorization_ttl_seconds,
      300
    ))
  );

  return {
    mode,
    thresholdUsd,
    authorizationTtlSeconds,
    requireExactOrderMatch: policy?.requireExactOrderMatch !== false
  };
}

function normalizeScalar(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return String(value).trim();
}

function normalizeObject(value) {
  if (Array.isArray(value)) return value.map(normalizeObject);
  if (!value || typeof value !== 'object') return normalizeScalar(value);
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      const normalized = normalizeObject(value[key]);
      if (normalized !== null) acc[key] = normalized;
      return acc;
    }, {});
}

function stableStringify(value) {
  return JSON.stringify(normalizeObject(value));
}

function deriveEffectiveNotional(orderInput = {}) {
  const qty = Math.abs(toFiniteNumber(orderInput.qty, 0));
  const explicitNotional = Math.abs(toFiniteNumber(orderInput.notional, 0));
  const estimatedNotional = Math.abs(toFiniteNumber(
    orderInput.estimatedNotional ?? orderInput.estimated_notional,
    0
  ));
  const orderType = String(orderInput.orderType || orderInput.type || 'market').trim().toLowerCase();
  const limitPrice = Math.abs(toFiniteNumber(orderInput.limitPrice ?? orderInput.limit_price, 0));
  const stopPrice = Math.abs(toFiniteNumber(orderInput.stopPrice ?? orderInput.stop_price, 0));
  const referencePrice = Math.abs(toFiniteNumber(
    orderInput.referencePrice ?? orderInput.reference_price,
    0
  ));
  let executablePrice = 0;

  if (orderType === 'limit') executablePrice = limitPrice;
  else if (orderType === 'stop_limit') executablePrice = Math.max(limitPrice, stopPrice);
  else if (orderType === 'stop') executablePrice = stopPrice;
  else executablePrice = referencePrice;

  const computedNotional = qty > 0 && executablePrice > 0
    ? qty * executablePrice
    : 0;
  const value = Math.max(explicitNotional, estimatedNotional, computedNotional);
  const authoritative = explicitNotional > 0 || computedNotional > 0;

  return {
    value,
    authoritative,
    explicitNotional,
    estimatedNotional,
    computedNotional,
    executablePrice,
    qty,
    source: explicitNotional >= computedNotional && explicitNotional >= estimatedNotional
      ? 'explicit_notional'
      : (computedNotional >= estimatedNotional ? 'computed_order_fields' : 'estimate')
  };
}

function classifyScoreBand(score) {
  const normalized = toFiniteNumber(score, 0);
  if (normalized < 70) return 'below_70';
  if (normalized < 80) return '70_79';
  if (normalized < 90) return '80_89';
  return '90_plus';
}

function buildCanonicalOrderSnapshot({
  accountId = 'default',
  broker = 'alpaca',
  environment = 'paper',
  orderInput = {}
} = {}) {
  const assetClass = String(orderInput.assetClass || 'stocks').trim().toLowerCase();
  const rawTakeProfit = orderInput.takeProfit ?? orderInput.take_profit ?? {};
  const rawStopLoss = orderInput.stopLoss ?? orderInput.stop_loss ?? {};
  const takeProfitPrice = toFiniteNumber(
    rawTakeProfit.limitPrice ?? rawTakeProfit.limit_price ?? rawTakeProfit.price
  );
  const stopLossStopPrice = toFiniteNumber(
    rawStopLoss.stopPrice ?? rawStopLoss.stop_price ?? rawStopLoss.price
  );
  const stopLossLimitPrice = toFiniteNumber(
    rawStopLoss.limitPrice ?? rawStopLoss.limit_price
  );
  const notional = deriveEffectiveNotional(orderInput);
  return normalizeObject({
    schemaVersion: 1,
    accountId: String(accountId || 'default').trim(),
    broker: String(broker || 'alpaca').trim().toLowerCase(),
    environment: ['live', 'shadow'].includes(environment) ? environment : 'paper',
    symbol: String(orderInput.symbol || '').trim().toUpperCase(),
    assetClass,
    side: String(orderInput.side || '').trim().toLowerCase(),
    orderType: String(orderInput.orderType || orderInput.type || 'market').trim().toLowerCase(),
    orderClass: String(orderInput.orderClass || orderInput.order_class || 'simple').trim().toLowerCase(),
    timeInForce: String(orderInput.timeInForce || orderInput.time_in_force || 'day').trim().toLowerCase(),
    qty: toFiniteNumber(orderInput.qty),
    notional: toFiniteNumber(orderInput.notional),
    estimatedNotional: toFiniteNumber(orderInput.estimatedNotional ?? orderInput.estimated_notional),
    effectiveNotional: notional.value,
    referencePrice: toFiniteNumber(orderInput.referencePrice ?? orderInput.reference_price),
    quoteTimestamp: normalizeScalar(orderInput.quoteTimestamp ?? orderInput.quote_timestamp),
    limitPrice: toFiniteNumber(orderInput.limitPrice ?? orderInput.limit_price),
    stopPrice: toFiniteNumber(orderInput.stopPrice ?? orderInput.stop_price),
    trailPrice: toFiniteNumber(orderInput.trailPrice ?? orderInput.trail_price),
    trailPercent: toFiniteNumber(orderInput.trailPercent ?? orderInput.trail_percent),
    takeProfit: takeProfitPrice === null ? null : { limitPrice: takeProfitPrice },
    stopLoss: stopLossStopPrice === null && stopLossLimitPrice === null
      ? null
      : { stopPrice: stopLossStopPrice, limitPrice: stopLossLimitPrice },
    riskStopPrice: toFiniteNumber(orderInput.riskStopPrice ?? orderInput.risk_stop_price),
    riskTakeProfitPrice: toFiniteNumber(
      orderInput.riskTakeProfitPrice ?? orderInput.risk_take_profit_price
    ),
    extendedHours: Boolean(orderInput.extendedHours ?? orderInput.extended_hours),
    strategyId: normalizeScalar(orderInput.strategyId ?? orderInput.strategy_id)
  });
}

function buildOrderFingerprint(input = {}) {
  const orderSnapshot = input.orderSnapshot || buildCanonicalOrderSnapshot(input);
  const orderFingerprint = crypto
    .createHash('sha256')
    .update(stableStringify(orderSnapshot))
    .digest('hex');
  return { orderSnapshot, orderFingerprint };
}

function mapRiskReasonCodes(riskResult = {}) {
  return [...new Set((riskResult.checks || [])
    .filter(check => check && check.passed === false)
    .map(check => RISK_CHECK_REASON_CODES[check.name] || REASON_CODES.RISK_CHECK_FAILED))];
}

function shouldRequireAuthorization({ environment, approvalPolicy, estimatedNotional }) {
  if (environment !== 'live') return false;
  if (approvalPolicy.mode === APPROVAL_MODES.AUTONOMOUS) return false;
  if (approvalPolicy.mode === APPROVAL_MODES.ABOVE_THRESHOLD) {
    if (toFiniteNumber(estimatedNotional, 0) <= 0) return true;
    return toFiniteNumber(estimatedNotional, 0) > approvalPolicy.thresholdUsd;
  }
  return true;
}

function evaluateAuthorization({
  authorization,
  orderFingerprint,
  approvalPolicy,
  expectedPolicyVersion = POLICY_VERSION,
  now
}) {
  if (!authorization) {
    return {
      valid: false,
      status: 'missing',
      reasonCode: REASON_CODES.AUTHORIZATION_REQUIRED,
      message: 'This live trade requires explicit authorization.'
    };
  }
  const status = String(authorization.status || 'active').trim().toLowerCase();
  if (status !== 'active') {
    return {
      valid: false,
      status,
      reasonCode: REASON_CODES.AUTHORIZATION_REVOKED,
      message: 'The trade authorization is not active.'
    };
  }
  const expiresAt = new Date(authorization.expiresAt || 0);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    return {
      valid: false,
      status: 'expired',
      reasonCode: REASON_CODES.AUTHORIZATION_EXPIRED,
      message: 'The trade authorization has expired.'
    };
  }
  if (String(authorization.policyVersion || '') !== expectedPolicyVersion) {
    return {
      valid: false,
      status: 'policy_version_mismatch',
      reasonCode: REASON_CODES.AUTHORIZATION_POLICY_VERSION_MISMATCH,
      message: 'The trade authorization was created under a different policy version.'
    };
  }
  if (
    approvalPolicy.requireExactOrderMatch
    && String(authorization.orderFingerprint || '') !== orderFingerprint
  ) {
    return {
      valid: false,
      status: 'mismatch',
      reasonCode: REASON_CODES.AUTHORIZATION_ORDER_MISMATCH,
      message: 'The authorization does not match the exact reviewed order.'
    };
  }
  return {
    valid: true,
    status: 'valid',
    reasonCode: null,
    message: 'The live trade authorization is active and matches this order.',
    authorizationId: authorization._id || authorization.id || null,
    expiresAt
  };
}

function evaluateCanonicalTradingPolicy({
  accountId = 'default',
  broker = 'alpaca',
  environment = 'paper',
  settings = {},
  decision = {},
  orderInput = {},
  riskResult = {},
  authorization = null,
  now = new Date()
} = {}) {
  const { orderSnapshot, orderFingerprint } = buildOrderFingerprint({
    accountId,
    broker,
    environment,
    orderInput
  });
  const approvalPolicy = normalizeApprovalPolicy(
    settings.approvalPolicy,
    settings.requireManualApprovalAboveDollarAmount
  );
  const effectiveNotional = deriveEffectiveNotional(orderInput);
  const liveLike = environment === 'live' || environment === 'shadow';
  const authorizationRequired = shouldRequireAuthorization({
    environment,
    approvalPolicy,
    estimatedNotional: effectiveNotional.value
  });
  const reasonCodes = mapRiskReasonCodes(riskResult);
  const rejectionReasons = [...(riskResult.rejectionReasons || [])];
  const checks = [...(riskResult.checks || [])];
  const score = toFiniteNumber(decision.confidenceScore, 0);
  const scoreBand = classifyScoreBand(score);
  const executionVeto = Boolean(
    decision.executionVeto
    || decision.executionQuality?.veto
    || decision.executionQuality?.executionVeto
  );

  const addCanonicalFailure = (name, reasonCode, message, metadata = {}) => {
    checks.push({ name, passed: false, message, severity: 'critical', metadata });
    reasonCodes.push(reasonCode);
    rejectionReasons.push(message);
  };

  if (liveLike && !effectiveNotional.authoritative) {
    addCanonicalFailure(
      'canonical_notional_verified',
      REASON_CODES.ORDER_NOTIONAL_UNVERIFIED,
      'Live order notional could not be verified from explicit notional or executable order fields.',
      effectiveNotional
    );
  } else {
    checks.push({
      name: 'canonical_notional_verified',
      passed: true,
      message: 'Order notional was derived conservatively.',
      severity: 'info',
      metadata: effectiveNotional
    });
  }

  if (score < 70) {
    addCanonicalFailure(
      'canonical_score_band',
      REASON_CODES.SCORE_BELOW_MINIMUM,
      'Weighted score is below 70; final status is NO TRADE.',
      { score, scoreBand }
    );
  } else if (liveLike && score < 80) {
    addCanonicalFailure(
      'canonical_score_band',
      REASON_CODES.SCORE_REVIEW_ONLY,
      'Scores from 70 through 79 are review-only and are not eligible for live submission.',
      { score, scoreBand }
    );
  } else {
    checks.push({
      name: 'canonical_score_band',
      passed: true,
      message: `Weighted score is in the ${scoreBand} band.`,
      severity: 'info',
      metadata: { score, scoreBand }
    });
  }

  if (executionVeto) {
    addCanonicalFailure(
      'canonical_execution_veto',
      REASON_CODES.EXECUTION_VETO,
      decision.executionVetoReason || decision.executionQuality?.vetoReason || 'Execution quality issued a hard veto.',
      { executionQuality: decision.executionQuality || null }
    );
  }
  let authorizationResult = {
    valid: true,
    status: 'not_required',
    reasonCode: null,
    message: environment === 'live'
      ? 'The configured live approval policy does not require per-order authorization.'
      : 'Per-order authorization is not required in paper mode.'
  };

  if (authorizationRequired) {
    authorizationResult = evaluateAuthorization({
      authorization,
      orderFingerprint,
      approvalPolicy,
      expectedPolicyVersion: POLICY_VERSION,
      now
    });
    checks.push({
      name: 'canonical_authorization',
      passed: authorizationResult.valid,
      message: authorizationResult.message,
      severity: authorizationResult.valid ? 'info' : 'critical',
      metadata: {
        policyMode: approvalPolicy.mode,
        orderFingerprint,
        status: authorizationResult.status
      }
    });
    if (!authorizationResult.valid) {
      reasonCodes.push(authorizationResult.reasonCode);
      rejectionReasons.push(authorizationResult.message);
    }
  } else {
    checks.push({
      name: 'canonical_authorization',
      passed: true,
      message: authorizationResult.message,
      severity: 'info',
      metadata: { policyMode: approvalPolicy.mode, orderFingerprint }
    });
  }

  const canonicalEligibilityApproved = !reasonCodes.some(code => [
    REASON_CODES.ORDER_NOTIONAL_UNVERIFIED,
    REASON_CODES.SCORE_BELOW_MINIMUM,
    REASON_CODES.SCORE_REVIEW_ONLY,
    REASON_CODES.EXECUTION_VETO
  ].includes(code));
  const riskApproved = riskResult.approved !== false
    && mapRiskReasonCodes(riskResult).length === 0
    && canonicalEligibilityApproved;
  const approved = riskApproved && authorizationResult.valid;
  const pendingManualApproval = riskApproved && authorizationRequired && !authorizationResult.valid;

  return {
    approved,
    decisionStatus: approved ? 'approved' : (pendingManualApproval ? 'pending_manual_approval' : 'rejected'),
    policyVersion: POLICY_VERSION,
    reasonCodes: [...new Set(reasonCodes.filter(Boolean))],
    rejectionReasons: [...new Set(rejectionReasons.filter(Boolean))],
    checks,
    orderSnapshot,
    orderFingerprint,
    effectiveNotional,
    scoreBand,
    executionVeto,
    approval: {
      policy: approvalPolicy,
      required: authorizationRequired,
      ...authorizationResult
    },
    decisionContext: {
      confidenceScore: toFiniteNumber(decision.confidenceScore, 0),
      rewardRiskRatio: toFiniteNumber(decision.rewardRiskRatio),
      strategyId: decision.strategyId || null
    }
  };
}

module.exports = {
  APPROVAL_MODES,
  POLICY_VERSION,
  REASON_CODES,
  RISK_CHECK_REASON_CODES,
  buildCanonicalOrderSnapshot,
  buildOrderFingerprint,
  classifyScoreBand,
  deriveEffectiveNotional,
  evaluateAuthorization,
  evaluateCanonicalTradingPolicy,
  mapRiskReasonCodes,
  normalizeApprovalPolicy,
  stableStringify
};

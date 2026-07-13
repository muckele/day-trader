const { deriveEffectiveNotional } = require('./canonicalTradingPolicyService');
const { normalizeAssetClass } = require('../robotrader/settingsService');

const LIVE_LIKE_ENVIRONMENTS = new Set(['live', 'shadow']);
const TRUSTED_LIVE_QUOTE_SOURCES = new Set(['alpaca', 'alpaca_trade_fallback']);

function toFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 2) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(digits)) : null;
}

function getEasternTimeParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    weekday: parts.weekday,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    minutesSinceMidnight: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function normalizeExecutionQuote(quote = {}) {
  const bidPrice = toFiniteNumber(quote.bidPrice ?? quote.bp ?? quote.bid_price);
  const askPrice = toFiniteNumber(quote.askPrice ?? quote.ap ?? quote.ask_price);
  const bidSize = toFiniteNumber(quote.bidSize ?? quote.bs ?? quote.bid_size);
  const askSize = toFiniteNumber(quote.askSize ?? quote.as ?? quote.ask_size);
  const timestamp = quote.timestamp ?? quote.t ?? quote.time ?? null;
  const midpoint = bidPrice > 0 && askPrice > 0
    ? (bidPrice + askPrice) / 2
    : toFiniteNumber(quote.price);
  const spreadBps = bidPrice > 0 && askPrice >= bidPrice && midpoint > 0
    ? ((askPrice - bidPrice) / midpoint) * 10000
    : null;
  const source = String(quote.source || quote.provider || '').trim().toLowerCase() || null;
  const explicitlyNonMock = quote.isMock === false;
  const isMock = quote.isMock === true || source === 'mock';
  return {
    bidPrice,
    askPrice,
    bidSize,
    askSize,
    midpoint,
    spreadBps: round(spreadBps, 2),
    timestamp,
    source,
    isMock,
    explicitlyNonMock,
    trustedLiveSource: source !== null && TRUSTED_LIVE_QUOTE_SOURCES.has(source)
  };
}

function evaluateExecutionQuality({
  environment = 'paper',
  assetClass = 'stocks',
  orderInput = {},
  research = {},
  positions = [],
  marketClock = null,
  executionPolicy = {},
  now = new Date()
} = {}) {
  const liveLike = LIVE_LIKE_ENVIRONMENTS.has(environment);
  const normalizedAssetClass = normalizeAssetClass(assetClass || orderInput.assetClass) || 'stocks';
  const isStock = normalizedAssetClass === 'stocks';
  const quote = normalizeExecutionQuote(research.quote || {});
  const symbol = String(orderInput.symbol || '').toUpperCase();
  const currentPositionQty = toFiniteNumber(
    (positions || []).find(position => String(position.symbol || '').toUpperCase() === symbol)?.qty,
    0
  );
  const requestedQty = Math.abs(toFiniteNumber(orderInput.qty, 0));
  const orderSide = String(orderInput.side || '').toLowerCase();
  const riskReducingOnly = requestedQty > 0 && (
    (orderSide === 'sell' && currentPositionQty > 0 && requestedQty <= currentPositionQty)
    || (orderSide === 'buy' && currentPositionQty < 0 && requestedQty <= Math.abs(currentPositionQty))
  );
  const eastern = getEasternTimeParts(now);
  const cutoffEt = 15 * 60 + 45;
  const cutoffMinutesBeforeClose = Math.max(0, toFiniteNumber(executionPolicy.cutoffMinutesBeforeClose, 15));
  const nextCloseValue = marketClock?.next_close ?? marketClock?.nextClose;
  const nextClose = nextCloseValue ? new Date(nextCloseValue) : null;
  const nextCloseValid = Boolean(nextClose && Number.isFinite(nextClose.getTime()));
  const nextCloseEastern = nextCloseValid ? getEasternTimeParts(nextClose) : null;
  const nextCloseMatchesSession = Boolean(
    nextCloseValid
    && nextClose.getTime() > now.getTime()
    && nextCloseEastern.date === eastern.date
  );
  const brokerCutoff = nextCloseMatchesSession
    ? new Date(nextClose.getTime() - cutoffMinutesBeforeClose * 60 * 1000)
    : null;
  const clockOpen = Boolean(marketClock?.is_open ?? marketClock?.isOpen);
  const weekday = !['Sat', 'Sun'].includes(eastern.weekday);
  const absoluteCutoffPassed = eastern.minutesSinceMidnight >= cutoffEt;
  const brokerCutoffPassed = brokerCutoff ? now.getTime() >= brokerCutoff.getTime() : false;
  const marketDataLive = quote.explicitlyNonMock && !quote.isMock && quote.trustedLiveSource;
  const quoteTime = quote.timestamp ? new Date(quote.timestamp) : null;
  const rawQuoteAgeSeconds = quoteTime && Number.isFinite(quoteTime.getTime())
    ? (now.getTime() - quoteTime.getTime()) / 1000
    : null;
  const quoteAgeSeconds = rawQuoteAgeSeconds === null ? null : Math.max(0, rawQuoteAgeSeconds);
  const quoteTimestampValid = rawQuoteAgeSeconds !== null && rawQuoteAgeSeconds >= -5;
  const averageVolume20 = toFiniteNumber(
    research.indicators?.avgVolume20 ?? research.averageVolume20
  );
  const price = quote.midpoint
    || toFiniteNumber(research.price)
    || toFiniteNumber(orderInput.referencePrice ?? orderInput.reference_price);
  const averageDailyDollarVolume = averageVolume20 > 0 && price > 0
    ? averageVolume20 * price
    : null;
  const effectiveNotional = deriveEffectiveNotional({
    ...orderInput,
    referencePrice: price || orderInput.referencePrice
  });
  const participationBps = averageDailyDollarVolume > 0
    ? (effectiveNotional.value / averageDailyDollarVolume) * 10000
    : null;
  const reviewedReferencePrice = toFiniteNumber(orderInput.referencePrice ?? orderInput.reference_price);
  const side = String(orderInput.side || '').toLowerCase();
  const adverseReferenceMoveBps = reviewedReferencePrice > 0 && quote.midpoint > 0
    ? Math.max(
        0,
        side === 'sell'
          ? ((reviewedReferencePrice - quote.midpoint) / reviewedReferencePrice) * 10000
          : ((quote.midpoint - reviewedReferencePrice) / reviewedReferencePrice) * 10000
      )
    : 0;
  const estimatedSlippageBps = quote.spreadBps !== null && participationBps !== null
    ? (quote.spreadBps / 2) + participationBps + adverseReferenceMoveBps
    : null;
  const checks = [];
  const rejectionReasons = [];
  const addCheck = (name, passed, message, metadata = {}) => {
    checks.push({
      name,
      passed: Boolean(passed),
      message,
      severity: passed ? 'info' : 'critical',
      metadata
    });
    if (!passed) rejectionReasons.push(message);
  };

  if (!liveLike) {
    for (const name of [
      'market_session_open',
      'new_order_cutoff',
      'market_data_live',
      'quote_fresh',
      'spread_allowed',
      'liquidity_allowed',
      'slippage_allowed'
    ]) {
      addCheck(name, true, 'Execution-quality veto is enforced in shadow and live environments.');
    }
  } else if (!isStock) {
    addCheck('market_session_open', true, 'Non-equity instruments are not subject to the US equity session clock.');
    addCheck('new_order_cutoff', true, 'Non-equity instruments are not subject to the 3:45 PM ET equity cutoff.');
    addCheck('market_data_live', marketDataLive, 'Shadow/live execution requires explicitly non-mock data from a trusted provider.', {
      source: quote.source,
      explicitlyNonMock: quote.explicitlyNonMock,
      trustedLiveSource: quote.trustedLiveSource
    });
    addCheck(
      'quote_fresh',
      quoteTimestampValid && quoteAgeSeconds <= toFiniteNumber(executionPolicy.maxQuoteAgeSeconds, 15),
      'The execution quote is missing or stale.',
      { quoteAgeSeconds, maxQuoteAgeSeconds: executionPolicy.maxQuoteAgeSeconds }
    );
    addCheck(
      'spread_allowed',
      quote.spreadBps !== null && quote.spreadBps <= toFiniteNumber(executionPolicy.maxSpreadBps, 35),
      'The quoted spread exceeds the execution limit.',
      { spreadBps: quote.spreadBps, maxSpreadBps: executionPolicy.maxSpreadBps }
    );
    addCheck('liquidity_allowed', true, 'Equity average-daily-dollar-volume gate is not applied to this asset class.');
    addCheck(
      'slippage_allowed',
      estimatedSlippageBps !== null
        && estimatedSlippageBps <= toFiniteNumber(executionPolicy.maxEstimatedSlippageBps, 25),
      'Estimated slippage exceeds the execution limit.',
      { estimatedSlippageBps: round(estimatedSlippageBps, 2), maxEstimatedSlippageBps: executionPolicy.maxEstimatedSlippageBps }
    );
  } else {
    addCheck(
      'market_session_open',
      Boolean(marketClock) && clockOpen && weekday,
      'The primary US equity session is not open.',
      { clockOpen, weekday: eastern.weekday, easternTime: eastern }
    );
    addCheck(
      'new_order_cutoff',
      riskReducingOnly || (nextCloseMatchesSession && !absoluteCutoffPassed && !brokerCutoffPassed),
      'New equity entries are blocked at the earlier of 3:45 PM ET or 15 minutes before the exchange close.',
      {
        easternTime: eastern,
        absoluteCutoffEt: '15:45',
        brokerCutoff,
        nextClose,
        nextCloseValid,
        nextCloseMatchesSession,
        riskReducingOnly
      }
    );
    addCheck('market_data_live', marketDataLive, 'Shadow/live execution requires explicitly non-mock data from a trusted provider.', {
      source: quote.source,
      explicitlyNonMock: quote.explicitlyNonMock,
      trustedLiveSource: quote.trustedLiveSource
    });
    addCheck(
      'quote_fresh',
      quoteTimestampValid && quoteAgeSeconds <= toFiniteNumber(executionPolicy.maxQuoteAgeSeconds, 15),
      'The execution quote is missing or stale.',
      {
        quoteAgeSeconds: round(quoteAgeSeconds, 3),
        rawQuoteAgeSeconds: round(rawQuoteAgeSeconds, 3),
        maxQuoteAgeSeconds: executionPolicy.maxQuoteAgeSeconds,
        timestamp: quote.timestamp
      }
    );
    addCheck(
      'spread_allowed',
      quote.spreadBps !== null && quote.spreadBps <= toFiniteNumber(executionPolicy.maxSpreadBps, 35),
      'The quoted spread exceeds the execution limit.',
      { spreadBps: quote.spreadBps, maxSpreadBps: executionPolicy.maxSpreadBps, bidPrice: quote.bidPrice, askPrice: quote.askPrice }
    );
    addCheck(
      'liquidity_allowed',
      averageDailyDollarVolume !== null
        && averageDailyDollarVolume >= toFiniteNumber(executionPolicy.minAverageDailyDollarVolume, 20000000),
      'Average daily dollar volume is below the execution minimum.',
      { averageDailyDollarVolume: round(averageDailyDollarVolume, 2), minimum: executionPolicy.minAverageDailyDollarVolume }
    );
    addCheck(
      'slippage_allowed',
      estimatedSlippageBps !== null
        && estimatedSlippageBps <= toFiniteNumber(executionPolicy.maxEstimatedSlippageBps, 25),
      'Estimated slippage exceeds the execution limit.',
      {
        estimatedSlippageBps: round(estimatedSlippageBps, 2),
        participationBps: round(participationBps, 2),
        adverseReferenceMoveBps: round(adverseReferenceMoveBps, 2),
        maxEstimatedSlippageBps: executionPolicy.maxEstimatedSlippageBps
      }
    );
  }

  return {
    approved: checks.every(check => check.passed),
    veto: checks.some(check => !check.passed),
    checks,
    rejectionReasons,
    metrics: {
      environment,
      assetClass: normalizedAssetClass,
      easternTime: eastern,
      quote,
      quoteAgeSeconds: round(quoteAgeSeconds, 3),
      rawQuoteAgeSeconds: round(rawQuoteAgeSeconds, 3),
      averageDailyDollarVolume: round(averageDailyDollarVolume, 2),
      effectiveNotional: effectiveNotional.value,
      participationBps: round(participationBps, 2),
      adverseReferenceMoveBps: round(adverseReferenceMoveBps, 2),
      estimatedSlippageBps: round(estimatedSlippageBps, 2),
      brokerCutoff,
      nextClose,
      riskReducingOnly
    },
    evaluatedAt: now
  };
}

module.exports = {
  LIVE_LIKE_ENVIRONMENTS,
  TRUSTED_LIVE_QUOTE_SOURCES,
  evaluateExecutionQuality,
  getEasternTimeParts,
  normalizeExecutionQuote
};

const TRUSTED_EXECUTION_PROVIDERS = new Set(['alpaca']);
const DEFAULT_MAX_QUOTE_AGE_SECONDS = 15;

function finitePositive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function buildMarketDataProvenance({
  symbol,
  quote = null,
  bars = [],
  historicalProvider = null,
  historicalTimestamp = null,
  environment = 'paper',
  maxQuoteAgeSeconds = DEFAULT_MAX_QUOTE_AGE_SECONDS,
  now = new Date(),
  dataError = null
} = {}) {
  const expectedSymbol = normalizeSymbol(symbol);
  const quoteSymbol = normalizeSymbol(quote?.symbol);
  const provider = normalizeProvider(quote?.source || quote?.provider);
  const timestamp = quote?.timestamp || quote?.t || quote?.time || null;
  const timestampMs = timestamp ? new Date(timestamp).getTime() : NaN;
  const rawAgeSeconds = Number.isFinite(timestampMs)
    ? (now.getTime() - timestampMs) / 1000
    : null;
  const ageSeconds = rawAgeSeconds === null ? null : Math.max(0, rawAgeSeconds);
  const bidPrice = finitePositive(quote?.bidPrice ?? quote?.bp ?? quote?.bid_price);
  const askPrice = finitePositive(quote?.askPrice ?? quote?.ap ?? quote?.ask_price);
  const price = finitePositive(quote?.price) || (
    bidPrice && askPrice ? (bidPrice + askPrice) / 2 : null
  );
  const normalizedHistoricalProvider = normalizeProvider(historicalProvider);
  const normalizedBars = Array.isArray(bars) ? bars : [];
  const checks = [
    {
      key: 'provider_trusted',
      passed: quote?.isMock === false && TRUSTED_EXECUTION_PROVIDERS.has(provider),
      detail: 'Execution requires an explicitly non-simulated quote from Alpaca.'
    },
    {
      key: 'symbol_matches',
      passed: Boolean(expectedSymbol && quoteSymbol && quoteSymbol === expectedSymbol),
      detail: 'Quote symbol must exactly match the frozen intent symbol.'
    },
    {
      key: 'quote_timestamp_present',
      passed: Number.isFinite(timestampMs),
      detail: 'Execution quotes require a valid provider timestamp.'
    },
    {
      key: 'quote_fresh',
      passed: rawAgeSeconds !== null
        && rawAgeSeconds >= -5
        && ageSeconds <= Number(maxQuoteAgeSeconds || DEFAULT_MAX_QUOTE_AGE_SECONDS),
      detail: 'Execution quotes must be current and cannot be future-dated.'
    },
    {
      key: 'quote_shape_valid',
      passed: Boolean(price && bidPrice && askPrice && askPrice >= bidPrice),
      detail: 'Execution quotes require coherent positive bid, ask, and price evidence.'
    },
    {
      key: 'historical_provider_trusted',
      passed: TRUSTED_EXECUTION_PROVIDERS.has(normalizedHistoricalProvider),
      detail: 'Strategy history must come from the trusted market-data provider.'
    },
    {
      key: 'historical_timestamp_present',
      passed: Boolean(historicalTimestamp && Number.isFinite(new Date(historicalTimestamp).getTime())),
      detail: 'Strategy history requires a provider timestamp.'
    },
    {
      key: 'history_available',
      passed: normalizedBars.length > 0 && !dataError,
      detail: 'Strategy history must be available without an upstream data error.'
    }
  ];

  return {
    schemaVersion: 1,
    environment: environment === 'live' || environment === 'shadow' ? environment : 'paper',
    symbol: expectedSymbol,
    provider,
    timestamp: timestamp || null,
    ageSeconds: ageSeconds === null ? null : Number(ageSeconds.toFixed(3)),
    stale: !checks.find(check => check.key === 'quote_fresh').passed,
    simulated: quote?.isMock === true || provider === 'mock',
    historical: {
      provider: normalizedHistoricalProvider,
      timestamp: historicalTimestamp || null,
      barsAvailable: normalizedBars.length
    },
    trustedForExecution: checks.every(check => check.passed),
    checks
  };
}

function createMarketDataUnavailableResult(provenance, message = null) {
  return {
    available: false,
    code: 'TRUSTED_MARKET_DATA_UNAVAILABLE',
    message: message || 'Trusted, current market data is unavailable for paper execution.',
    provenance
  };
}

module.exports = {
  DEFAULT_MAX_QUOTE_AGE_SECONDS,
  TRUSTED_EXECUTION_PROVIDERS,
  buildMarketDataProvenance,
  createMarketDataUnavailableResult
};

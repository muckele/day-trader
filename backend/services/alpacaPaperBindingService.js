const ALPACA_PAPER_BASE_URL = 'https://paper-api.alpaca.markets';

function normalizeAlpacaPaperEndpoint(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;

  try {
    const parsed = new URL(baseUrl.trim());
    const normalizedPath = parsed.pathname.replace(/\/+$/, '');
    if (
      parsed.protocol !== 'https:'
      || parsed.hostname !== 'paper-api.alpaca.markets'
      || parsed.port
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || !['', '/v2'].includes(normalizedPath)
    ) {
      return null;
    }
    return ALPACA_PAPER_BASE_URL;
  } catch {
    return null;
  }
}

function isPaperTradingEndpoint(baseUrl) {
  return normalizeAlpacaPaperEndpoint(baseUrl) === ALPACA_PAPER_BASE_URL;
}

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isReleaseEnvironment(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  const deployment = String(
    env.ROBOTRADER_DEPLOYMENT_ENV || env.DEPLOYMENT_ENV || env.APP_ENV || ''
  ).trim().toLowerCase();
  return nodeEnv === 'production' || ['production', 'staging'].includes(deployment);
}

function normalizeAccountId(value) {
  return String(value || '').trim() || null;
}

function createBindingError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = 409;
  err.submissionAttempted = false;
  return err;
}

function assertAlpacaPaperSubmissionBinding({
  config,
  env = process.env,
  account = null,
  allowLocalPaperTestEndpoint = false,
  isLocalTestEndpoint = () => false
} = {}) {
  if (!config || config.mode && config.mode !== 'paper') {
    throw createBindingError('ALPACA_PAPER_MODE_REQUIRED', 'Paper submission requires the canonical paper broker configuration.');
  }
  if (parseBoolean(env.LIVE_TRADING_ENABLED)) {
    throw createBindingError('PAPER_MVP_LIVE_FLAG_ENABLED', 'Paper submission is blocked while LIVE_TRADING_ENABLED is true.');
  }
  const endpointAllowed = isPaperTradingEndpoint(config.baseUrl)
    || (allowLocalPaperTestEndpoint && isLocalTestEndpoint(config.baseUrl));
  if (!endpointAllowed) {
    throw createBindingError('ALPACA_PAPER_ENDPOINT_REQUIRED', 'Paper submission requires the Alpaca paper endpoint.');
  }
  if (!config.apiKey || !config.apiSecret) {
    throw createBindingError('ALPACA_NOT_CONFIGURED', 'Explicit Alpaca paper credentials are not configured.');
  }
  if (isReleaseEnvironment(env) && config.credentialSource !== 'paper_explicit') {
    throw createBindingError(
      'ALPACA_EXPLICIT_PAPER_CREDENTIALS_REQUIRED',
      'Staging and production paper submissions require APCA_PAPER_API_KEY_ID and APCA_PAPER_API_SECRET_KEY.'
    );
  }

  const expectedAccountId = normalizeAccountId(
    config.expectedAccountId || env.APCA_PAPER_ACCOUNT_ID || env.ALPACA_PAPER_ACCOUNT_ID
  );
  if (isReleaseEnvironment(env) && !expectedAccountId) {
    throw createBindingError(
      'ALPACA_PAPER_ACCOUNT_BINDING_REQUIRED',
      'Staging and production paper submissions require APCA_PAPER_ACCOUNT_ID.'
    );
  }
  if (expectedAccountId && !account) {
    return { verified: false, requiresAccountLookup: true, expectedAccountId };
  }

  if (expectedAccountId) {
    const actualAccountId = normalizeAccountId(account?.id || account?.account_id || account?.accountId);
    if (!actualAccountId || actualAccountId !== expectedAccountId) {
      throw createBindingError(
        'ALPACA_PAPER_ACCOUNT_MISMATCH',
        'The authenticated Alpaca paper account does not match APCA_PAPER_ACCOUNT_ID.'
      );
    }
  }
  if (account && (account.trading_blocked === true || account.account_blocked === true)) {
    throw createBindingError('ALPACA_PAPER_ACCOUNT_BLOCKED', 'The bound Alpaca paper account is blocked from trading.');
  }

  return {
    verified: true,
    requiresAccountLookup: false,
    expectedAccountId,
    brokerAccountId: normalizeAccountId(account?.id || account?.account_id || account?.accountId)
  };
}

module.exports = {
  ALPACA_PAPER_BASE_URL,
  assertAlpacaPaperSubmissionBinding,
  isPaperTradingEndpoint,
  normalizeAlpacaPaperEndpoint,
  isReleaseEnvironment
};

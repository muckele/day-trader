// Release invariant: no environment flag or user setting can authorize live writes.
const PAPER_ORIGIN = 'https://paper-api.alpaca.markets';
function safetyError(message, code) {
  return Object.assign(new Error(message), { code, status: 503 });
}
function isPaperTradingEndpoint(value) {
  try {
    const raw = String(value || '');
    const url = new URL(raw);
    return raw === raw.trim() && !raw.includes('\\') && !raw.includes('?') && !raw.includes('#')
      && url.origin === PAPER_ORIGIN && !url.username && !url.password
      && ['', '/', '/v2', '/v2/'].includes(url.pathname);
  } catch { return false; }
}
function assertPaperConfig(config) {
  if ((config.mode && config.mode !== 'paper') || !isPaperTradingEndpoint(config.baseUrl)) {
    throw safetyError('This release requires the exact Alpaca paper endpoint; live trading is disabled.', 'ALPACA_PAPER_ENDPOINT_REQUIRED');
  }
  if (!config.apiKey || !config.apiSecret) throw safetyError('Alpaca paper credentials are not configured.', 'ALPACA_NOT_CONFIGURED');
}
async function verifyPaperAccount(config, readAccount) {
  assertPaperConfig(config);
  if (!config.expectedAccountId || typeof config.expectedAccountId !== 'string' || !config.expectedAccountId.trim()) {
    throw safetyError('ALPACA_EXPECTED_PAPER_ACCOUNT_ID must explicitly bind the designated paper account before broker writes.', 'ALPACA_ACCOUNT_BINDING_REQUIRED');
  }
  const account = await readAccount();
  if (!account || typeof account.id !== 'string' || account.id !== config.expectedAccountId) {
    throw safetyError('Alpaca paper account identity does not match the designated account.', 'ALPACA_ACCOUNT_MISMATCH');
  }
  return account;
}
module.exports = { PAPER_ORIGIN, isPaperTradingEndpoint, assertPaperConfig, verifyPaperAccount };

const BROKER_POSITION_CLOSE_CONFIRMATION = 'Close this broker position.';

function parseAllowlist(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(item => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

function getBrokerOperatorAllowlist(env = process.env) {
  return {
    usernames: parseAllowlist(env.ROBOTRADER_OPERATOR_USERNAMES),
    userIds: parseAllowlist(env.ROBOTRADER_OPERATOR_USER_IDS)
  };
}

function getBrokerOperatorConfiguration(env = process.env) {
  const { usernames, userIds } = getBrokerOperatorAllowlist(env);
  const identifiers = [...usernames, ...userIds];
  return {
    configured: identifiers.length === 1,
    identifierCount: identifiers.length,
    usernames: [...usernames].sort(),
    userIds: [...userIds].sort(),
    detail: identifiers.length === 1
      ? 'Exactly one broker-operator identifier is configured.'
      : `Expected exactly one broker-operator identifier; found ${identifiers.length}.`
  };
}

function isBrokerOperator(user = {}, env = process.env) {
  const { usernames, userIds } = getBrokerOperatorAllowlist(env);
  const username = String(user.username || '').trim().toLowerCase();
  const userId = String(user._id || user.userId || user.sub || user.id || '').trim().toLowerCase();
  return Boolean(
    (username && usernames.has(username))
    || (userId && userIds.has(userId))
  );
}

function requireBrokerOperator(user = {}, env = process.env) {
  if (isBrokerOperator(user, env)) return true;
  const err = new Error('This operation requires deployment broker-operator access.');
  err.status = 403;
  err.code = 'BROKER_OPERATOR_REQUIRED';
  throw err;
}

module.exports = {
  BROKER_POSITION_CLOSE_CONFIRMATION,
  getBrokerOperatorAllowlist,
  getBrokerOperatorConfiguration,
  isBrokerOperator,
  parseAllowlist,
  requireBrokerOperator
};

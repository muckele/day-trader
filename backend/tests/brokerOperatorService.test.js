const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getBrokerOperatorConfiguration,
  isBrokerOperator,
  requireBrokerOperator
} = require('../services/brokerOperatorService');

test('broker operator access fails closed without an allowlist', () => {
  assert.equal(isBrokerOperator({ username: 'matt' }, {}), false);
  assert.throws(
    () => requireBrokerOperator({ username: 'matt' }, {}),
    err => err.status === 403 && err.code === 'BROKER_OPERATOR_REQUIRED'
  );
});

test('broker operator configuration requires exactly one deployment identifier', () => {
  assert.equal(getBrokerOperatorConfiguration({}).configured, false);
  assert.equal(getBrokerOperatorConfiguration({ ROBOTRADER_OPERATOR_USERNAMES: 'matt' }).configured, true);
  assert.equal(getBrokerOperatorConfiguration({
    ROBOTRADER_OPERATOR_USERNAMES: 'matt,operations'
  }).configured, false);
});

test('broker operator access accepts configured usernames or user ids case-insensitively', () => {
  assert.equal(isBrokerOperator(
    { username: 'Matt' },
    { ROBOTRADER_OPERATOR_USERNAMES: 'matt,operations' }
  ), true);
  assert.equal(isBrokerOperator(
    { _id: 'ABC123' },
    { ROBOTRADER_OPERATOR_USER_IDS: 'abc123' }
  ), true);
});

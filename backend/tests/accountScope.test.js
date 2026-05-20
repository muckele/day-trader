const test = require('node:test');
const assert = require('node:assert/strict');
const { getAccountIdForUser, getRequestAccountId } = require('../utils/accountScope');

test('getAccountIdForUser prefers username for stable account scoping across token versions', () => {
  assert.equal(
    getAccountIdForUser({ username: 'matt', userId: '507f1f77bcf86cd799439011' }),
    'user:matt'
  );
});

test('getRequestAccountId falls back to default only when no authenticated user identity exists', () => {
  assert.equal(getRequestAccountId({ user: { sub: '507f1f77bcf86cd799439011' } }), 'user:507f1f77bcf86cd799439011');
  assert.equal(getRequestAccountId({}), 'default');
});

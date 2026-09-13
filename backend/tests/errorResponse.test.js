const test = require('node:test');
const assert = require('node:assert/strict');
const { safeErrorResponse } = require('../utils/errorResponse');
test('unexpected provider errors never expose credentials or request config', () => {
  const response = safeErrorResponse(Object.assign(new Error('https://secret:password@broker'), { config: { headers: { Authorization: 'secret' } }, code: 'ECONNRESET' }));
  assert.equal(response.status, 500);
  assert.equal(response.message, 'Unexpected server error.');
  assert.ok(!JSON.stringify(response).includes('secret'));
});

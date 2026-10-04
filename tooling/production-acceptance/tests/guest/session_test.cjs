'use strict';

// Task 14's real browser/UI suite is intentionally unavailable until the
// final appliance, native B1 effect fence, Task 22 wiring, owned compiled
// frontend fixture and synthetic credential gates are separately approved.
const assert = require('node:assert/strict');
const test = require('node:test');

let nativePort = null;
function configureNative(port) {
  assert.equal(nativePort, null, 'NATIVE_SESSION_ALREADY_CONFIGURED');
  for (const name of ['loginOnce', 'observeAfterRestart', 'publicOutput']) assert.equal(typeof port?.[name], 'function');
  nativePort = port;
}
function port() {
  assert.equal(process.env.ACCEPTANCE_TASK14_GUEST, 'B1_QUALIFIED');
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64'); assert.equal(process.getuid(), 10002);
  assert.ok(nativePort, 'NATIVE_SESSION_PORT_UNAVAILABLE');
  return nativePort;
}

test('actual synthetic UI login binds exact private owner and cookie', async () => {
  const result = await port().loginOnce();
  assert.deepEqual(result, { status: 'SESSION_BOUND' });
});

test('same context and private session survive synthetic backend restart', async () => {
  const result = await port().observeAfterRestart();
  assert.deepEqual(result, { status: 'CONTINUOUS' });
});

test('private credential owner and cookie never enter public output', () => {
  const output = port().publicOutput();
  assert.equal(typeof output, 'string');
  for (const forbidden of ['password', 'daytrader_session', 'cookie', 'owner-id']) assert.equal(output.includes(forbidden), false);
});

module.exports = Object.freeze({ configureNative });

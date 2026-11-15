const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getOperationalAlertDeliveryConfiguration,
  notificationPayload,
  notifyOperationalAlert
} = require('../services/operationalAlertNotifier');

test('operational alert delivery fails closed without a secure webhook', () => {
  assert.equal(getOperationalAlertDeliveryConfiguration({}).configured, false);
  assert.equal(getOperationalAlertDeliveryConfiguration({
    NODE_ENV: 'production',
    ROBOTRADER_ALERT_WEBHOOK_URL: 'http://alerts.example.test/hook'
  }).configured, false);
  assert.equal(getOperationalAlertDeliveryConfiguration({
    NODE_ENV: 'production',
    ROBOTRADER_ALERT_WEBHOOK_URL: 'https://alerts.example.test/hook'
  }).configured, false);
  assert.equal(getOperationalAlertDeliveryConfiguration({
    NODE_ENV: 'production',
    ROBOTRADER_ALERT_WEBHOOK_URL: 'https://alerts.example.test/hook',
    ROBOTRADER_ALERT_WEBHOOK_BEARER_TOKEN: 'test-token'
  }).configured, true);
});

test('operational alerts send a bounded payload with the configured bearer token', async () => {
  let request;
  const result = await notifyOperationalAlert({
    eventType: 'robotrader_broker_error',
    category: 'broker',
    severity: 'critical',
    environment: 'paper',
    message: 'Broker unavailable',
    occurrences: 2,
    payload: { secret: 'must-not-leave-process' }
  }, {
    env: {
      NODE_ENV: 'production',
      ROBOTRADER_ALERT_WEBHOOK_URL: 'https://alerts.example.test/hook',
      ROBOTRADER_ALERT_WEBHOOK_BEARER_TOKEN: 'test-token'
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 202 };
    }
  });
  assert.equal(result.delivered, true);
  assert.equal(request.options.headers.authorization, 'Bearer test-token');
  assert.equal(request.options.redirect, 'error');
  const body = JSON.parse(request.options.body);
  assert.equal(body.eventType, 'robotrader_broker_error');
  assert.equal(Object.hasOwn(body, 'payload'), false);
  assert.equal(JSON.stringify(body).includes('must-not-leave-process'), false);
});

test('notification payload contains only operator-safe fields', () => {
  const payload = notificationPayload({ eventType: 'event', payload: { credentials: 'no' } });
  assert.deepEqual(Object.keys(payload).sort(), [
    'application', 'category', 'environment', 'eventType', 'message', 'occurredAt', 'occurrences', 'severity'
  ]);
});

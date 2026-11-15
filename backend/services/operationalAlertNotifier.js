const DEFAULT_TIMEOUT_MS = 3000;

function getOperationalAlertDeliveryConfiguration(env = process.env) {
  const webhookUrl = String(env.ROBOTRADER_ALERT_WEBHOOK_URL || '').trim();
  const bearerToken = String(env.ROBOTRADER_ALERT_WEBHOOK_BEARER_TOKEN || '').trim();
  if (!webhookUrl) {
    return { configured: false, webhookUrl: null, detail: 'No operational-alert webhook is configured.' };
  }
  try {
    const parsed = new URL(webhookUrl);
    const secure = parsed.protocol === 'https:';
    const localDevelopment = env.NODE_ENV !== 'production'
      && parsed.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
    if (!secure && !localDevelopment) {
      return {
        configured: false,
        webhookUrl: null,
        detail: 'Operational-alert webhook must use HTTPS (HTTP is allowed only for local development).'
      };
    }
    if (env.NODE_ENV === 'production' && !bearerToken) {
      return {
        configured: false,
        webhookUrl: null,
        detail: 'Operational-alert webhook bearer token is required in production deployments.'
      };
    }
    return {
      configured: true,
      webhookUrl: parsed.toString(),
      detail: env.NODE_ENV === 'production'
        ? 'Operational-alert webhook and bearer token are configured.'
        : 'Operational-alert webhook is configured.'
    };
  } catch {
    return { configured: false, webhookUrl: null, detail: 'Operational-alert webhook URL is invalid.' };
  }
}

function notificationPayload(alert = {}) {
  return {
    application: 'day-trader',
    eventType: alert.eventType,
    category: alert.category,
    severity: alert.severity,
    environment: alert.environment,
    message: alert.message,
    occurrences: Number(alert.occurrences || 1),
    occurredAt: alert.lastOccurredAt || new Date().toISOString()
  };
}

async function notifyOperationalAlert(alert, {
  env = process.env,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const configuration = getOperationalAlertDeliveryConfiguration(env);
  if (!configuration.configured) {
    return { delivered: false, status: 'disabled', detail: configuration.detail };
  }
  if (typeof fetchImpl !== 'function') {
    return { delivered: false, status: 'failed', detail: 'Fetch API is unavailable.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  try {
    const headers = { 'content-type': 'application/json' };
    const bearerToken = String(env.ROBOTRADER_ALERT_WEBHOOK_BEARER_TOKEN || '').trim();
    if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
    const response = await fetchImpl(configuration.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(notificationPayload(alert)),
      redirect: 'error',
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        delivered: false,
        status: 'failed',
        detail: `Operational-alert webhook returned HTTP ${response.status}.`
      };
    }
    return { delivered: true, status: 'sent', detail: `Delivered with HTTP ${response.status}.` };
  } catch (err) {
    return {
      delivered: false,
      status: 'failed',
      detail: err?.name === 'AbortError'
        ? 'Operational-alert webhook timed out.'
        : `Operational-alert webhook failed: ${String(err?.message || err).slice(0, 300)}`
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  getOperationalAlertDeliveryConfiguration,
  notificationPayload,
  notifyOperationalAlert
};

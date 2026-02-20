const DEFAULT_PROVIDER = process.env.ROBO_EMAIL_PROVIDER || (process.env.SMTP_HOST ? 'smtp' : 'log');

let cachedTransporter = null;

function getSmtpPort() {
  const value = Number(process.env.SMTP_PORT || 587);
  return Number.isFinite(value) ? value : 587;
}

function isSecurePort(port) {
  return port === 465;
}

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  let nodemailer;
  try {
    // Optional dependency: only required when using SMTP provider.
    nodemailer = require('nodemailer');
  } catch (_err) {
    const err = new Error('nodemailer is required for SMTP email provider.');
    err.code = 'EMAIL_PROVIDER_MISSING';
    throw err;
  }

  if (!process.env.SMTP_HOST) {
    const err = new Error('Missing SMTP_HOST for SMTP email provider.');
    err.code = 'EMAIL_CONFIG_MISSING';
    throw err;
  }

  const port = getSmtpPort();
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: isSecurePort(port),
    auth: process.env.SMTP_USER && process.env.SMTP_PASS
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      : undefined
  });

  return cachedTransporter;
}

function buildTradeEmailText(details) {
  const {
    symbol,
    side,
    qty,
    notional,
    estimatedPrice,
    timestamp,
    strategyName,
    orderId
  } = details;

  return [
    'Robo Trader Order Notification',
    '',
    `Symbol: ${symbol}`,
    `Side: ${String(side || '').toUpperCase()}`,
    `Qty: ${qty}`,
    `Notional: $${Number(notional || 0).toFixed(2)}`,
    `Estimated Price: $${Number(estimatedPrice || 0).toFixed(2)}`,
    `Timestamp: ${timestamp}`,
    `Strategy: ${strategyName || 'N/A'}`,
    `Order ID: ${orderId}`,
    '',
    'Disclaimer: Values are estimates and execution details may differ.'
  ].join('\n');
}

async function sendTradeEmail({ to, details }) {
  if (!to) {
    const err = new Error('Recipient email is required for Robo Trader notifications.');
    err.code = 'EMAIL_MISSING_RECIPIENT';
    throw err;
  }

  const subject = `Robo Trader ${String(details?.side || '').toUpperCase()} ${details?.symbol || ''}`.trim();
  const text = buildTradeEmailText(details || {});

  if (DEFAULT_PROVIDER === 'log') {
    console.log(`[robo-email] to=${to} subject="${subject}"`);
    return { provider: 'log', messageId: `log-${Date.now()}` };
  }

  if (DEFAULT_PROVIDER === 'smtp') {
    const transporter = getTransporter();
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    if (!from) {
      const err = new Error('Missing SMTP_FROM (or SMTP_USER) sender address.');
      err.code = 'EMAIL_CONFIG_MISSING';
      throw err;
    }

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text
    });

    return { provider: 'smtp', messageId: info?.messageId || null };
  }

  const err = new Error(`Unsupported Robo email provider "${DEFAULT_PROVIDER}".`);
  err.code = 'EMAIL_PROVIDER_UNSUPPORTED';
  throw err;
}

module.exports = {
  sendTradeEmail
};

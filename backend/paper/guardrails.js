function evaluateGuardrails({
  equity,
  orderNotional,
  dailyPnl,
  settings,
  now
}) {
  if (settings.cooldownUntil && now < settings.cooldownUntil) {
    return {
      ok: false,
      reason: `Cooldown active until ${settings.cooldownUntil.toISOString()}.`
    };
  }

  const maxPositionValue = equity * (settings.maxPositionPct / 100);
  if (orderNotional > maxPositionValue) {
    return {
      ok: false,
      reason: `Max position size exceeded (${settings.maxPositionPct}% of equity).`
    };
  }

  const maxDailyLoss = equity * (settings.maxDailyLossPct / 100);
  if (dailyPnl <= -maxDailyLoss) {
    return {
      ok: false,
      reason: `Daily loss limit reached (${settings.maxDailyLossPct}% of equity).`
    };
  }

  return { ok: true };
}

function updateCooldownState(settings, tradeRealizedPnl, now) {
  let consecutiveLosses = settings.consecutiveLosses || 0;
  let cooldownUntil = settings.cooldownUntil || null;

  if (tradeRealizedPnl < 0) {
    consecutiveLosses += 1;
  } else if (tradeRealizedPnl > 0) {
    consecutiveLosses = 0;
  }

  if (consecutiveLosses >= 3) {
    cooldownUntil = new Date(now.getTime() + settings.cooldownHours * 60 * 60 * 1000);
  }

  return { consecutiveLosses, cooldownUntil };
}

module.exports = { evaluateGuardrails, updateCooldownState };

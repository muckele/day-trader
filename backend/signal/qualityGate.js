const { config } = require('./signalConfig');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function evaluateQualityGate({ latestClose, avgDollarVolume, atrPct, avgRangePct, barsCount }) {
  const blockedReasons = [];

  if (!latestClose || !avgDollarVolume || !atrPct || !avgRangePct || !barsCount) {
    blockedReasons.push('Insufficient data for quality checks.');
  }

  if (barsCount < config.minBars) {
    blockedReasons.push(`Need at least ${config.minBars} daily bars.`);
  }

  if (config.priceFloorEnabled && latestClose < config.priceFloor) {
    blockedReasons.push(`Price below $${config.priceFloor.toFixed(2)} floor.`);
  }

  if (avgDollarVolume < config.minDollarVolume) {
    blockedReasons.push('Average dollar volume below minimum threshold.');
  }

  if (atrPct > config.maxAtrPct) {
    blockedReasons.push('Volatility too extreme for risk controls.');
  }

  if (avgRangePct > config.maxRangePct) {
    blockedReasons.push('Spread proxy too high for safe execution.');
  }

  const liquidityScore = avgDollarVolume
    ? clamp((avgDollarVolume / config.minDollarVolume) * 100, 0, 100)
    : 0;
  const volatilityScore = atrPct
    ? clamp((1 - atrPct / config.maxAtrPct) * 100, 0, 100)
    : 0;

  return {
    passed: blockedReasons.length === 0,
    blockedReasons,
    liquidityScore: Number(liquidityScore.toFixed(1)),
    volatilityScore: Number(volatilityScore.toFixed(1)),
    priceFloor: config.priceFloor,
    avgDollarVolume,
    atrPct,
    avgRangePct
  };
}

module.exports = { evaluateQualityGate };

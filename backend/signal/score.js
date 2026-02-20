function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scoreLabel(value) {
  if (value >= 70) return 'HIGH';
  if (value >= 40) return 'MEDIUM';
  return 'LOW';
}

function computeScore({ trendScore, qualityGate, regime, bias }) {
  let score = 40;
  const strength = clamp(Math.abs(trendScore) * 100, 0, 30);
  score += strength;

  if (qualityGate.passed) score += 15;
  else score -= 20;

  if (regime) {
    if (regime.trendChop === 'TREND') score += 5;
    if (regime.vol === 'EXPANSION') score += 5;
    if (bias === 'LONG' && regime.risk === 'RISK_ON') score += 5;
    if (bias === 'SHORT' && regime.risk === 'RISK_OFF') score += 5;
  }

  score = clamp(score, 0, 100);
  return {
    value: Number(score.toFixed(0)),
    label: scoreLabel(score)
  };
}

module.exports = { computeScore };

const {
  computeDrawdownSeries,
  aggregateStrategies,
  aggregateRegimes,
  computeRMultiple
} = require('./analyticsUtils');

function sum(values) {
  return values.reduce((acc, value) => acc + value, 0);
}

function stdDev(values) {
  if (values.length <= 1) return 0;
  const mean = sum(values) / values.length;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function buildSnapshot({ range, trades, equityPoints, guardrailBlocks }) {
  const expectancyValues = trades
    .map(trade => computeRMultiple(trade))
    .filter(value => value !== null && Number.isFinite(value));
  const expectancy = expectancyValues.length
    ? Number((sum(expectancyValues) / expectancyValues.length).toFixed(2))
    : null;
  const stdDevR = stdDev(expectancyValues);
  const sharpeLikeRaw = stdDevR === 0
    ? (expectancy || 0)
    : expectancy / stdDevR;
  const sharpeLike = expectancy === null ? null : Number(Math.min(sharpeLikeRaw, 5).toFixed(2));

  const { maxDrawdown } = computeDrawdownSeries(
    equityPoints.map(point => ({ timestamp: point.timestamp, equity: point.equity }))
  );

  return {
    range,
    asOf: new Date().toISOString(),
    expectancy,
    sharpeLike,
    drawdown: { maxDrawdown },
    regimeBreakdown: aggregateRegimes(trades),
    strategyBreakdown: aggregateStrategies(trades),
    guardrailBlocks
  };
}

module.exports = { buildSnapshot };

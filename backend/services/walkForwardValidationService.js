const { backtestStrategy, computeMetrics } = require('../backtest/backtestEngine');

const DEFAULT_TRAIN_BARS = 252;
const DEFAULT_TEST_BARS = 63;
const DEFAULT_STEP_BARS = 63;
const MIN_WALK_FORWARD_WINDOWS = 3;
const MIN_OUT_OF_SAMPLE_TRADES = 30;
const MIN_POSITIVE_WINDOW_RATE_PCT = 60;
const MAX_WALK_FORWARD_DRAWDOWN_PCT = 10;

function clampInteger(value, fallback, min, max) {
  const number = Math.floor(Number(value));
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback));
}

function barTime(bar = {}) {
  const value = bar.t || bar.date;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeWalkForwardParameters({ trainBars, testBars, stepBars } = {}) {
  const normalizedTestBars = clampInteger(testBars, DEFAULT_TEST_BARS, 20, 252);
  const requestedStepBars = clampInteger(stepBars, DEFAULT_STEP_BARS, 20, 252);
  return {
    trainBars: clampInteger(trainBars, DEFAULT_TRAIN_BARS, 100, 1000),
    testBars: normalizedTestBars,
    // Promotion evidence must be composed from independent OOS periods. A
    // smaller step would count the same dates and trades in multiple windows.
    stepBars: Math.max(normalizedTestBars, requestedStepBars)
  };
}

function aggregateWindowMetrics(windows = []) {
  const tradesByIdentity = new Map();
  let unkeyedTradeIndex = 0;
  for (const trade of windows.flatMap(window => window.outOfSample.trades || [])) {
    const hasStableIdentity = trade.entryDate && trade.exitDate && trade.side;
    const identity = hasStableIdentity
      ? [
          trade.symbol || '',
          trade.entryDate,
          trade.exitDate,
          trade.side,
          trade.entryPrice || '',
          trade.exitPrice || ''
        ].join('|')
      : `unkeyed:${unkeyedTradeIndex += 1}`;
    if (!tradesByIdentity.has(identity)) tradesByIdentity.set(identity, trade);
  }
  const trades = [...tradesByIdentity.values()];
  const wins = trades.filter(trade => Number(trade.pnl || 0) > 0).length;
  const avgR = trades.length
    ? trades.reduce((sum, trade) => sum + Number(trade.rMultiple || 0), 0) / trades.length
    : 0;
  const positiveWindows = windows.filter(window => window.outOfSample.metrics.avgR > 0).length;
  return {
    tradeCount: trades.length,
    winRate: trades.length ? Number(((wins / trades.length) * 100).toFixed(2)) : 0,
    avgR: Number(avgR.toFixed(2)),
    maxDrawdown: windows.length
      ? Number(Math.max(...windows.map(window => Number(window.outOfSample.metrics.maxDrawdown || 0))).toFixed(2))
      : 0,
    windowCount: windows.length,
    positiveWindowRatePct: windows.length
      ? Number(((positiveWindows / windows.length) * 100).toFixed(2))
      : 0
  };
}

function runWalkForwardValidation({
  bars = [],
  strategyId,
  trainBars = DEFAULT_TRAIN_BARS,
  testBars = DEFAULT_TEST_BARS,
  stepBars = DEFAULT_STEP_BARS
} = {}) {
  const normalized = normalizeWalkForwardParameters({ trainBars, testBars, stepBars });
  const normalizedTrainBars = normalized.trainBars;
  const normalizedTestBars = normalized.testBars;
  const normalizedStepBars = normalized.stepBars;
  const orderedBars = [...bars]
    .filter(bar => barTime(bar))
    .sort((a, b) => barTime(a) - barTime(b));
  const windows = [];
  for (
    let testStartIndex = normalizedTrainBars;
    testStartIndex + normalizedTestBars <= orderedBars.length;
    testStartIndex += normalizedStepBars
  ) {
    const train = orderedBars.slice(testStartIndex - normalizedTrainBars, testStartIndex);
    const test = orderedBars.slice(testStartIndex, testStartIndex + normalizedTestBars);
    const testStart = barTime(test[0]);
    const testEnd = barTime(test.at(-1));
    const training = backtestStrategy(train, strategyId);
    const combined = backtestStrategy([...train, ...test], strategyId, { tradeStartAt: testStart });
    const testTrades = combined.trades.filter(trade => {
      const entry = new Date(trade.entryDate);
      return !Number.isNaN(entry.getTime()) && entry >= testStart && entry <= testEnd;
    });
    const testEquity = combined.equityCurve.filter(point => {
      const timestamp = new Date(point.timestamp);
      return !Number.isNaN(timestamp.getTime()) && timestamp >= testStart && timestamp <= testEnd;
    });
    windows.push({
      index: windows.length + 1,
      trainStart: barTime(train[0]),
      trainEnd: barTime(train.at(-1)),
      testStart,
      testEnd,
      inSample: {
        metrics: {
          tradeCount: training.tradeCount,
          winRate: training.winRate,
          avgR: training.avgR,
          maxDrawdown: training.maxDrawdown
        }
      },
      outOfSample: {
        metrics: computeMetrics({
          trades: testTrades,
          equityCurve: testEquity,
          startingEquity: combined.assumptions?.startingEquity
        }),
        trades: testTrades
      }
    });
  }
  const metrics = aggregateWindowMetrics(windows);
  const gates = [
    {
      key: 'window_count',
      passed: metrics.windowCount >= MIN_WALK_FORWARD_WINDOWS,
      detail: `${metrics.windowCount}/${MIN_WALK_FORWARD_WINDOWS} rolling windows`
    },
    {
      key: 'out_of_sample_trades',
      passed: metrics.tradeCount >= MIN_OUT_OF_SAMPLE_TRADES,
      detail: `${metrics.tradeCount}/${MIN_OUT_OF_SAMPLE_TRADES} out-of-sample trades`
    },
    {
      key: 'out_of_sample_expectancy',
      passed: metrics.avgR > 0,
      detail: `${metrics.avgR} average out-of-sample R`
    },
    {
      key: 'window_stability',
      passed: metrics.positiveWindowRatePct >= MIN_POSITIVE_WINDOW_RATE_PCT,
      detail: `${metrics.positiveWindowRatePct}%/${MIN_POSITIVE_WINDOW_RATE_PCT}% positive windows`
    },
    {
      key: 'out_of_sample_drawdown',
      passed: metrics.maxDrawdown <= MAX_WALK_FORWARD_DRAWDOWN_PCT,
      detail: `${metrics.maxDrawdown}%/${MAX_WALK_FORWARD_DRAWDOWN_PCT}% maximum window drawdown`
    }
  ];
  return {
    strategyId,
    validationType: 'walk_forward',
    parameters: {
      trainBars: normalizedTrainBars,
      testBars: normalizedTestBars,
      stepBars: normalizedStepBars
    },
    passed: gates.every(gate => gate.passed),
    metrics,
    gates,
    windows
  };
}

module.exports = {
  DEFAULT_STEP_BARS,
  DEFAULT_TEST_BARS,
  DEFAULT_TRAIN_BARS,
  MAX_WALK_FORWARD_DRAWDOWN_PCT,
  MIN_OUT_OF_SAMPLE_TRADES,
  MIN_POSITIVE_WINDOW_RATE_PCT,
  MIN_WALK_FORWARD_WINDOWS,
  aggregateWindowMetrics,
  normalizeWalkForwardParameters,
  runWalkForwardValidation
};

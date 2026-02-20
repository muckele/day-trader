const STRATEGIES = [
  {
    strategyId: 'SMA_CROSS',
    name: 'SMA Crossover',
    description: 'Trend-following based on 20/50 day SMA cross.',
    tags: ['trend', 'momentum'],
    expectedHold: 'SWING'
  },
  {
    strategyId: 'PULLBACK_TREND',
    name: 'Pullback in Trend',
    description: 'Buy pullbacks while long-term trend stays positive.',
    tags: ['trend', 'meanReversion'],
    expectedHold: 'SWING'
  },
  {
    strategyId: 'MEAN_REVERSION_RSI',
    name: 'RSI Mean Reversion',
    description: 'Buy when RSI is oversold and mean reversion is likely.',
    tags: ['meanReversion'],
    expectedHold: 'INTRADAY'
  },
  {
    strategyId: 'BREAKOUT_VOLUME',
    name: 'Breakout Volume',
    description: 'Breakout with volume expansion.',
    tags: ['trend', 'momentum', 'highVol'],
    expectedHold: 'SWING'
  }
];

function getStrategy(strategyId) {
  return STRATEGIES.find(strategy => strategy.strategyId === strategyId);
}

module.exports = { STRATEGIES, getStrategy };

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
  },
  {
    strategyId: 'ROBO_MOMENTUM_BREAKOUT_V1',
    name: 'Robo Momentum Breakout v1',
    description: 'RoboTrader momentum, volume expansion, and moving-average alignment profile.',
    tags: ['robo', 'trend', 'momentum'],
    expectedHold: 'SWING'
  },
  {
    strategyId: 'ROBO_MEAN_REVERSION_V1',
    name: 'Robo Mean Reversion v1',
    description: 'RoboTrader oversold RSI and short-term pullback profile.',
    tags: ['robo', 'meanReversion'],
    expectedHold: 'INTRADAY'
  },
  {
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    name: 'Robo Trend Following v1',
    description: 'RoboTrader multi-horizon moving-average trend profile.',
    tags: ['robo', 'trend'],
    expectedHold: 'SWING'
  },
  {
    strategyId: 'ROBO_RISK_OFF_PROTECTION_V1',
    name: 'Robo Risk-Off Protection v1',
    description: 'RoboTrader downside-momentum protection profile.',
    tags: ['robo', 'riskOff', 'short'],
    expectedHold: 'INTRADAY'
  }
];

function getStrategy(strategyId) {
  return STRATEGIES.find(strategy => strategy.strategyId === strategyId);
}

module.exports = { STRATEGIES, getStrategy };

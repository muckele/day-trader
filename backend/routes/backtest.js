const router = require('express').Router();
const { fetchDaily } = require('../tradeLogic');
const auth = require('../middleware/auth');
const requireMongo = require('../middleware/requireMongo');
const { backtestStrategy } = require('../backtest/backtestEngine');
const { getStrategy, STRATEGIES } = require('../signal/strategies');
const { createStrategyRun, finalizeStrategyRun } = require('../services/strategyRunService');
const { getRequestAccountId } = require('../utils/accountScope');

router.get('/strategies', (req, res) => {
  res.json(STRATEGIES);
});

router.use(requireMongo);
router.use(auth);

router.post('/', async (req, res) => {
  let strategyRun = null;
  try {
    const accountId = getRequestAccountId(req);
    const { symbol, strategyId, start, end, timeframe } = req.body || {};
    if (!symbol || !strategyId) {
      return res.status(400).json({ error: 'symbol and strategyId are required.' });
    }
    if (timeframe && timeframe !== '1D') {
      return res.status(400).json({ error: 'Only 1D timeframe is supported for now.' });
    }

    const strategy = getStrategy(strategyId);
    if (!strategy) {
      return res.status(400).json({ error: 'Unknown strategyId.' });
    }

    strategyRun = await createStrategyRun({
      accountId,
      strategyId,
      strategyName: strategy.name,
      runType: 'backtest',
      mode: 'simulation',
      symbol: symbol.toUpperCase(),
      universe: [symbol.toUpperCase()],
      parameters: {
        start: start || null,
        end: end || null,
        timeframe: timeframe || '1D'
      },
      source: 'backtest',
      summary: {
        symbol: symbol.toUpperCase()
      },
      context: {
        accountId,
        route: '/api/backtest'
      }
    });

    const bars = await fetchDaily(symbol.toUpperCase());
    const filtered = bars.filter(bar => {
      const date = new Date(bar.t).toISOString().slice(0, 10);
      if (start && date < start) return false;
      if (end && date > end) return false;
      return true;
    });

    if (filtered.length < 50) {
      await finalizeStrategyRun(strategyRun, {
        status: 'failed',
        summary: { symbol: symbol.toUpperCase(), reason: 'NOT_ENOUGH_DATA' },
        error: 'Not enough data for backtest.'
      });
      return res.status(400).json({ error: 'Not enough data for backtest.' });
    }

    const results = backtestStrategy(filtered, strategyId);
    await finalizeStrategyRun(strategyRun, {
      status: 'completed',
      metrics: {
        tradeCount: results.tradeCount,
        winRate: results.winRate,
        avgR: results.avgR,
        maxDrawdown: results.maxDrawdown
      },
      summary: {
        symbol: symbol.toUpperCase(),
        strategyId
      },
      result: results
    });
    res.json({
      symbol: symbol.toUpperCase(),
      strategy,
      timeframe: timeframe || '1D',
      start,
      end,
      ...results
    });
  } catch (err) {
    await finalizeStrategyRun(strategyRun, {
      status: 'failed',
      error: err.message,
      summary: {
        reason: 'BACKTEST_ERROR'
      }
    });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const router = require('express').Router();
const { fetchDaily } = require('../tradeLogic');
const auth = require('../middleware/auth');
const requireMongo = require('../middleware/requireMongo');
const {
  DEFAULT_MAX_TRADE_AMOUNT,
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_STARTING_EQUITY,
  backtestStrategy
} = require('../backtest/backtestEngine');
const { getStrategy, STRATEGIES } = require('../signal/strategies');
const { createStrategyRun, finalizeStrategyRun } = require('../services/strategyRunService');
const { getRequestAccountId } = require('../utils/accountScope');
const {
  DEFAULT_STEP_BARS,
  DEFAULT_TEST_BARS,
  DEFAULT_TRAIN_BARS,
  MIN_WALK_FORWARD_WINDOWS,
  normalizeWalkForwardParameters,
  runWalkForwardValidation
} = require('../services/walkForwardValidationService');

router.get('/strategies', (req, res) => {
  res.json(STRATEGIES);
});

router.use(requireMongo);
router.use(auth);

router.post('/walk-forward', async (req, res) => {
  let strategyRun = null;
  try {
    const accountId = getRequestAccountId(req);
    const {
      symbol,
      strategyId,
      start,
      end,
      trainBars = DEFAULT_TRAIN_BARS,
      testBars = DEFAULT_TEST_BARS,
      stepBars = DEFAULT_STEP_BARS
    } = req.body || {};
    if (!symbol || !strategyId) {
      return res.status(400).json({ error: 'symbol and strategyId are required.' });
    }
    const strategy = getStrategy(strategyId);
    if (!strategy || !String(strategyId).startsWith('ROBO_')) {
      return res.status(400).json({ error: 'A canonical RoboTrader strategyId is required.' });
    }
    const normalizedWalkForward = normalizeWalkForwardParameters({ trainBars, testBars, stepBars });
    const parameters = {
      validationType: 'walk_forward',
      start: start || null,
      end: end || null,
      timeframe: '1D',
      assumptions: {
        startingEquity: DEFAULT_STARTING_EQUITY,
        maxTradeAmount: DEFAULT_MAX_TRADE_AMOUNT,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
        commission: 0,
        terminalPositionPolicy: 'close_at_window_end'
      },
      ...normalizedWalkForward
    };
    strategyRun = await createStrategyRun({
      accountId,
      strategyId,
      strategyName: strategy.name,
      runType: 'backtest',
      mode: 'simulation',
      symbol: symbol.toUpperCase(),
      universe: [symbol.toUpperCase()],
      parameters,
      source: 'backtest',
      summary: { symbol: symbol.toUpperCase(), validationType: 'walk_forward' },
      context: { accountId, route: '/api/backtest/walk-forward' }
    });
    const bars = (await fetchDaily(symbol.toUpperCase())).filter(bar => {
      const date = new Date(bar.t).toISOString().slice(0, 10);
      return (!start || date >= start) && (!end || date <= end);
    });
    const result = runWalkForwardValidation({ bars, strategyId, ...normalizedWalkForward });
    if (result.metrics.windowCount < MIN_WALK_FORWARD_WINDOWS) {
      await finalizeStrategyRun(strategyRun, {
        status: 'failed',
        metrics: result.metrics,
        summary: { symbol: symbol.toUpperCase(), validationType: 'walk_forward', reason: 'INSUFFICIENT_WINDOWS' },
        result
      });
      return res.status(400).json({ error: 'Not enough daily bars for three walk-forward windows.', result });
    }
    await finalizeStrategyRun(strategyRun, {
      status: 'completed',
      metrics: result.metrics,
      summary: {
        symbol: symbol.toUpperCase(),
        strategyId,
        validationType: 'walk_forward',
        passed: result.passed
      },
      result
    });
    res.json({ symbol: symbol.toUpperCase(), strategy, ...result });
  } catch (err) {
    await finalizeStrategyRun(strategyRun, {
      status: 'failed',
      error: err.message,
      summary: { validationType: 'walk_forward', reason: 'WALK_FORWARD_ERROR' }
    });
    res.status(500).json({ error: err.message });
  }
});

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
        timeframe: timeframe || '1D',
        assumptions: {
          startingEquity: DEFAULT_STARTING_EQUITY,
          maxTradeAmount: DEFAULT_MAX_TRADE_AMOUNT,
          slippageBps: DEFAULT_SLIPPAGE_BPS,
          commission: 0,
          terminalPositionPolicy: 'close_at_window_end'
        }
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

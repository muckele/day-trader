const router = require('express').Router();
const { fetchDaily } = require('../tradeLogic');
const auth = require('../middleware/auth');
const requireMongo = require('../middleware/requireMongo');
const { createRateLimit } = require('../middleware/rateLimit');
const {
  DEFAULT_MAX_TRADE_AMOUNT,
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_STARTING_EQUITY,
  backtestStrategy
} = require('../backtest/backtestEngine');
const { getStrategy, STRATEGIES } = require('../signal/strategies');
const { createStrategyRun, finalizeStrategyRun } = require('../services/strategyRunService');
const { getRequestAccountId } = require('../utils/accountScope');
const { normalizeIsoDate, normalizeMarketSymbol } = require('../utils/marketSymbol');
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
router.use(createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: 'backtest',
  distributed: true,
  message: 'Too many backtest requests. Try again later.'
}));

function validateBacktestInput({ symbol, start, end }) {
  const normalizedSymbol = normalizeMarketSymbol(symbol);
  const normalizedStart = normalizeIsoDate(start);
  const normalizedEnd = normalizeIsoDate(end);
  if (!normalizedSymbol) return { error: 'Invalid symbol.' };
  if (normalizedStart === '' || normalizedEnd === '') return { error: 'start and end must use YYYY-MM-DD.' };
  if (normalizedStart && normalizedEnd && normalizedStart > normalizedEnd) {
    return { error: 'start must be on or before end.' };
  }
  return { symbol: normalizedSymbol, start: normalizedStart, end: normalizedEnd };
}

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
    const validated = validateBacktestInput({ symbol, start, end });
    if (validated.error) return res.status(400).json({ error: validated.error });
    const normalizedSymbol = validated.symbol;
    const normalizedStart = validated.start;
    const normalizedEnd = validated.end;
    const strategy = getStrategy(strategyId);
    if (!strategy || !String(strategyId).startsWith('ROBO_')) {
      return res.status(400).json({ error: 'A canonical RoboTrader strategyId is required.' });
    }
    const normalizedWalkForward = normalizeWalkForwardParameters({ trainBars, testBars, stepBars });
    const parameters = {
      validationType: 'walk_forward',
      start: normalizedStart,
      end: normalizedEnd,
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
      symbol: normalizedSymbol,
      universe: [normalizedSymbol],
      parameters,
      source: 'backtest',
      summary: { symbol: normalizedSymbol, validationType: 'walk_forward' },
      context: { accountId, route: '/api/backtest/walk-forward' }
    });
    const bars = (await fetchDaily(normalizedSymbol)).filter(bar => {
      const date = new Date(bar.t).toISOString().slice(0, 10);
      return (!normalizedStart || date >= normalizedStart) && (!normalizedEnd || date <= normalizedEnd);
    });
    const result = runWalkForwardValidation({ bars, strategyId, ...normalizedWalkForward });
    if (result.metrics.windowCount < MIN_WALK_FORWARD_WINDOWS) {
      await finalizeStrategyRun(strategyRun, {
        status: 'failed',
        metrics: result.metrics,
        summary: { symbol: normalizedSymbol, validationType: 'walk_forward', reason: 'INSUFFICIENT_WINDOWS' },
        result
      });
      return res.status(400).json({ error: 'Not enough daily bars for three walk-forward windows.', result });
    }
    await finalizeStrategyRun(strategyRun, {
      status: 'completed',
      metrics: result.metrics,
      summary: {
        symbol: normalizedSymbol,
        strategyId,
        validationType: 'walk_forward',
        passed: result.passed
      },
      result
    });
    res.json({ symbol: normalizedSymbol, strategy, ...result });
  } catch (err) {
    await finalizeStrategyRun(strategyRun, {
      status: 'failed',
      error: err.message,
      summary: { validationType: 'walk_forward', reason: 'WALK_FORWARD_ERROR' }
    });
    res.status(500).json({ error: 'Walk-forward backtest failed.' });
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
    const validated = validateBacktestInput({ symbol, start, end });
    if (validated.error) return res.status(400).json({ error: validated.error });
    const normalizedSymbol = validated.symbol;
    const normalizedStart = validated.start;
    const normalizedEnd = validated.end;
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
      symbol: normalizedSymbol,
      universe: [normalizedSymbol],
      parameters: {
        start: normalizedStart,
        end: normalizedEnd,
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
        symbol: normalizedSymbol
      },
      context: {
        accountId,
        route: '/api/backtest'
      }
    });

    const bars = await fetchDaily(normalizedSymbol);
    const filtered = bars.filter(bar => {
      const date = new Date(bar.t).toISOString().slice(0, 10);
      if (normalizedStart && date < normalizedStart) return false;
      if (normalizedEnd && date > normalizedEnd) return false;
      return true;
    });

    if (filtered.length < 50) {
      await finalizeStrategyRun(strategyRun, {
        status: 'failed',
        summary: { symbol: normalizedSymbol, reason: 'NOT_ENOUGH_DATA' },
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
        symbol: normalizedSymbol,
        strategyId
      },
      result: results
    });
    res.json({
      symbol: normalizedSymbol,
      strategy,
      timeframe: timeframe || '1D',
      start: normalizedStart,
      end: normalizedEnd,
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
    res.status(500).json({ error: 'Backtest failed.' });
  }
});

module.exports = router;

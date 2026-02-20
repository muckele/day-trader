const router = require('express').Router();
const { fetchDaily } = require('../tradeLogic');
const { backtestStrategy } = require('../backtest/backtestEngine');
const { getStrategy, STRATEGIES } = require('../signal/strategies');

router.post('/', async (req, res) => {
  try {
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

    const bars = await fetchDaily(symbol.toUpperCase());
    const filtered = bars.filter(bar => {
      const date = new Date(bar.t).toISOString().slice(0, 10);
      if (start && date < start) return false;
      if (end && date > end) return false;
      return true;
    });

    if (filtered.length < 50) {
      return res.status(400).json({ error: 'Not enough data for backtest.' });
    }

    const results = backtestStrategy(filtered, strategyId);
    res.json({
      symbol: symbol.toUpperCase(),
      strategy,
      timeframe: timeframe || '1D',
      start,
      end,
      ...results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/strategies', (req, res) => {
  res.json(STRATEGIES);
});

module.exports = router;

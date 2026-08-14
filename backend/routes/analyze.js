// backend/routes/analyze.js
const router = require('express').Router();
const analysisEngine = require('../analysisEngine');
const { normalizeMarketSymbol } = require('../utils/marketSymbol');

router.get('/:symbol', async (req, res, next) => {
  try {
    const sym = normalizeMarketSymbol(req.params.symbol);
    if (!sym) return res.status(400).json({ error: 'Invalid symbol.' });
    const analysis = await analysisEngine.analyzeDeterministic({
      symbol: sym,
      strategyId: req.query?.strategyId || null,
      timeframe: req.query?.timeframe || '1D'
    });

    res.json({
      ok: true,
      error: null,
      message: null,
      analysis
    });
  } catch (err) {
    if (err?.code === 'NO_DATA' || err?.code === 'DATA_UNAVAILABLE') {
      return res.json({
        ok: false,
        error: err.code,
        message: err.message,
        analysis: null
      });
    }
    next(err);
  }
});

module.exports = router;

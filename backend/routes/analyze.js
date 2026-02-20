// backend/routes/analyze.js
const router = require('express').Router();
const analysisEngine = require('../analysisEngine');

router.get('/:symbol', async (req, res, next) => {
  try {
    const sym = req.params.symbol.toUpperCase();
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

/**
 * Verification:
 * Local:
 *   curl -s http://localhost:4000/api/debug/bars/AAPL
 * Fly:
 *   curl -s https://<backend>.fly.dev/api/debug/bars/AAPL
 */
const router = require('express').Router();
const tradeLogic = require('../tradeLogic');

router.get('/bars/:symbol', async (req, res, next) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const fetched = await tradeLogic.fetchDaily(symbol);
    const bars = Array.isArray(fetched) ? fetched : [];
    if (bars.length === 0) {
      return res.json({
        symbol,
        barCount: 0,
        lastBarTime: null,
        lastClose: null
      });
    }
    const lastBar = bars[bars.length - 1];
    res.json({
      symbol,
      barCount: bars.length,
      lastBarTime: lastBar?.t ?? lastBar?.time ?? lastBar?.timestamp ?? lastBar?.date ?? null,
      lastClose: lastBar?.c ?? lastBar?.close ?? null
    });
  } catch (err) {
    if (err?.code === 'DATA_UNAVAILABLE') {
      return res.json({
        symbol,
        ok: false,
        error: 'DATA_UNAVAILABLE',
        message: err.message
      });
    }
    next(err);
  }
});

module.exports = router;

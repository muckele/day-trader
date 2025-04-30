// backend/routes/recommend.js
const router = require('express').Router();
const { getRecommendations } = require('../tradeLogic');

router.get('/', async (req, res, next) => {
  try {
    const watchlist = ['AAPL','MSFT','GOOG'];
    const recs = await Promise.all(
      watchlist.map(sym => getRecommendations(sym))
    );
    res.json(recs.map(r => ({
      symbol: r.symbol,
      recommendation: r.recommendation
    })));
  } catch (err) { next(err); }
});

module.exports = router;

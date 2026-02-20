// backend/routes/recommend.js
const router = require('express').Router();
const { getRecommendations } = require('../tradeLogic');
const { getMarketStatus } = require('../utils/marketStatus');
const { buildRecommendation } = require('../utils/recommendationSchema');
const RegimeSnapshot = require('../models/RegimeSnapshot');
const { detectRegime } = require('../signal/regimeDetector');

async function getTodayRegime() {
  const today = new Date().toISOString().slice(0, 10);
  let snapshot = await RegimeSnapshot.findOne({ date: today }).lean();
  if (!snapshot) {
    const detected = await detectRegime();
    snapshot = await RegimeSnapshot.create({
      date: today,
      trendChop: detected.trendChop,
      vol: detected.vol,
      risk: detected.risk,
      notes: detected.notes
    });
  }
  return snapshot;
}

router.get('/', async (req, res, next) => {
  const status = getMarketStatus();
  try {
    const watchlist = ['AAPL','MSFT','GOOG'];
    const recs = await Promise.all(
      watchlist.map(sym => getRecommendations(sym))
    );
    const regime = await getTodayRegime();
    res.json({
      asOf: status.asOf,
      marketStatus: status.status,
      nextOpen: status.nextOpen,
      nextClose: status.nextClose,
      recommendations: recs.map(rec => buildRecommendation(rec, { regime }))
    });
  } catch (err) {
    if (err?.code === 'DATA_UNAVAILABLE' || /daily bars/i.test(String(err?.message || ''))) {
      return res.json({
        asOf: status.asOf,
        marketStatus: status.status,
        nextOpen: status.nextOpen,
        nextClose: status.nextClose,
        recommendations: [],
        warning: 'DATA_UNAVAILABLE',
        message: 'Could not fetch daily bars'
      });
    }
    next(err);
  }
});

router.get('/:symbol', async (req, res, next) => {
  try {
    const rec = await getRecommendations(req.params.symbol.toUpperCase());
    const status = getMarketStatus();
    const regime = await getTodayRegime();
    res.json({
      asOf: status.asOf,
      marketStatus: status.status,
      nextOpen: status.nextOpen,
      nextClose: status.nextClose,
      recommendations: [buildRecommendation(rec, { regime })]
    });
  } catch (err) { next(err); }
});

module.exports = router;

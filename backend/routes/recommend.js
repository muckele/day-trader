// backend/routes/recommend.js
const router = require('express').Router();
const { getMarketStatus } = require('../utils/marketStatus');
const { buildRecommendationFromIdea } = require('../utils/recommendationSchema');
const RegimeSnapshot = require('../models/RegimeSnapshot');
const { detectRegime } = require('../signal/regimeDetector');
const { generateRecommendationLists } = require('../services/recommendationEngine');
const mongoState = require('../utils/mongoState');
const requireMongo = require('../middleware/requireMongo');
const auth = require('../middleware/auth');

router.use(requireMongo);
router.use(auth);

async function getTodayRegime() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (!mongoState.isMongoReady()) {
      const detected = await detectRegime();
      return {
        date: today,
        trendChop: detected.trendChop,
        vol: detected.vol,
        risk: detected.risk,
        notes: detected.notes,
        source: 'runtime_fallback'
      };
    }
    let snapshot = await RegimeSnapshot.findOne({ date: today }).lean();
    if (snapshot) return snapshot;

    const detected = await detectRegime();
    try {
      snapshot = await RegimeSnapshot.create({
        date: today,
        trendChop: detected.trendChop,
        vol: detected.vol,
        risk: detected.risk,
        notes: detected.notes
      });
    } catch (persistErr) {
      // Degrade gracefully when DB is unavailable; keep recommendations alive.
      return {
        date: today,
        trendChop: detected.trendChop,
        vol: detected.vol,
        risk: detected.risk,
        notes: detected.notes,
        source: 'runtime_fallback'
      };
    }
    return snapshot;
  } catch (err) {
    try {
      const detected = await detectRegime();
      return {
        date: today,
        trendChop: detected.trendChop,
        vol: detected.vol,
        risk: detected.risk,
        notes: detected.notes,
        source: 'runtime_fallback'
      };
    } catch (_detectErr) {
      return {
        date: today,
        trendChop: 'CHOP',
        vol: 'CONTRACTION',
        risk: 'RISK_OFF',
        notes: ['Regime detection unavailable; using fallback regime.'],
        source: 'default_fallback'
      };
    }
  }
}

function isDailyBarsUnavailable(err) {
  return err?.code === 'DATA_UNAVAILABLE' || /daily bars/i.test(String(err?.message || ''));
}

function buildDataUnavailablePayload(status) {
  return {
    asOf: status.asOf,
    marketStatus: status.status,
    nextOpen: status.nextOpen,
    nextClose: status.nextClose,
    recommendations: [],
    warning: 'DATA_UNAVAILABLE',
    message: 'Could not fetch daily bars'
  };
}

router.get('/', async (req, res, next) => {
  const status = getMarketStatus();
  try {
    const regime = await getTodayRegime();
    const recommendationSet = await generateRecommendationLists({
      regime
    });
    res.json({
      asOf: status.asOf,
      marketStatus: status.status,
      nextOpen: status.nextOpen,
      nextClose: status.nextClose,
      regime,
      engineVersion: recommendationSet.engineVersion,
      universe: recommendationSet.universe,
      warnings: recommendationSet.warnings,
      featureFlags: recommendationSet.featureFlags,
      lists: recommendationSet.lists,
      recommendations: recommendationSet.topIdeas.map(idea => buildRecommendationFromIdea(idea, { regime }))
    });
  } catch (err) {
    if (isDailyBarsUnavailable(err)) {
      return res.json(buildDataUnavailablePayload(status));
    }
    next(err);
  }
});

router.get('/:symbol', async (req, res, next) => {
  try {
    const status = getMarketStatus();
    const regime = await getTodayRegime();
    const recommendationSet = await generateRecommendationLists({
      universe: [req.params.symbol.toUpperCase()],
      regime,
      persist: false
    });
    res.json({
      asOf: status.asOf,
      marketStatus: status.status,
      nextOpen: status.nextOpen,
      nextClose: status.nextClose,
      regime,
      engineVersion: recommendationSet.engineVersion,
      warnings: recommendationSet.warnings,
      lists: recommendationSet.lists,
      recommendations: recommendationSet.topIdeas.map(idea => buildRecommendationFromIdea(idea, { regime }))
    });
  } catch (err) {
    if (isDailyBarsUnavailable(err)) {
      return res.json(buildDataUnavailablePayload(getMarketStatus()));
    }
    next(err);
  }
});

module.exports = router;

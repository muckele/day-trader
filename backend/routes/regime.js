const router = require('express').Router();
const RegimeSnapshot = require('../models/RegimeSnapshot');
const { detectRegime } = require('../signal/regimeDetector');

router.get('/today', async (req, res, next) => {
  try {
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
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

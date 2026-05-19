const router = require('express').Router();
const { listStrategies } = require('../services/strategyRegistry');

router.get('/', async (_req, res, next) => {
  try {
    const strategies = await listStrategies();
    res.json(strategies);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

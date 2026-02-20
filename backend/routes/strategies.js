const router = require('express').Router();
const { STRATEGIES } = require('../signal/strategies');

router.get('/', (req, res) => {
  res.json(STRATEGIES);
});

module.exports = router;

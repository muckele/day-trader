const router = require('express').Router();
const { DEFAULT_WATCHLIST } = require('../data/defaultWatchlist');

router.get('/default', (req, res) => {
  res.json(DEFAULT_WATCHLIST);
});

module.exports = router;

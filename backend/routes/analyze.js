// backend/routes/analyze.js
const router = require('express').Router();
const axios = require('axios');
const { analyze } = require('../aiEngine');
const { fetchDaily } = require('../tradeLogic');

router.get('/:symbol', async (req, res, next) => {
  try {
    if (!process.env.NEWSAPI_KEY) {
      return res.status(500).json({ error: 'Missing NEWSAPI_KEY in your .env.' });
    }

    const sym = req.params.symbol.toUpperCase();

    // Reuse the same market-data fetch path used by recommendations/market routes.
    const bars = await fetchDaily(sym);
    const latestBar = bars[bars.length - 1];
    if (!latestBar) {
      return res.status(404).json({ error: `No bar data found for ${sym}.` });
    }

    // 2) Top 5 news headlines
    const newsRes = await axios.get(
      'https://newsapi.org/v2/everything',
      {
        params: {
          q: sym,
          apiKey: process.env.NEWSAPI_KEY,
          pageSize: 5,
          sortBy: 'publishedAt'
        }
      }
    );

    // 3) DeepSeek rationale
    const rationale = await analyze(sym, latestBar, newsRes.data.articles);
    res.json({ rationale });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

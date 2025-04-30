// backend/routes/analyze.js
const router = require('express').Router();
const axios  = require('axios');
const { analyze } = require('../aiEngine');

router.get('/:symbol', async (req, res, next) => {
  try {
    const sym = req.params.symbol;

    // 1. Latest daily bar
    const barRes = await axios.get(
      `${process.env.APCA_DATA_URL}/stocks/${sym}/bars`,
      {
        headers: {
          'APCA-API-KEY-ID':     process.env.BROKER_API_KEY,
          'APCA-API-SECRET-KEY': process.env.BROKER_API_SECRET
        },
        params: { timeframe: '1Day', limit: 1 }
      }
    );
    const latestBar = barRes.data.bars[0];

    // 2. Top 5 news headlines
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

    // 3. DeepSeek rationale
    const rationale = await analyze(sym, latestBar, newsRes.data.articles);
    res.json({ rationale });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

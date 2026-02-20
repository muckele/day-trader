// backend/routes/analyze.js
const router = require('express').Router();
const axios = require('axios');
const aiEngine = require('../aiEngine');
const tradeLogic = require('../tradeLogic');

function isAiUnavailableError(err) {
  const code = err?.code;
  if (code === 'AI_PROVIDER_ERROR' || code === 'AI_UNAVAILABLE') {
    return true;
  }
  const message = String(err?.message || '').toLowerCase();
  return (
    message.includes('insufficient balance') ||
    message.includes('rate limit') ||
    message.includes('quota exceeded')
  );
}

router.get('/:symbol', async (req, res, next) => {
  try {
    if (!process.env.NEWSAPI_KEY) {
      return res.status(500).json({ error: 'Missing NEWSAPI_KEY in your .env.' });
    }

    const sym = req.params.symbol.toUpperCase();

    // Reuse the same market-data fetch path used by recommendations/market routes.
    const bars = await tradeLogic.fetchDaily(sym);
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

    // 3) AI rationale (non-fatal if provider is unavailable)
    let analysis;
    try {
      analysis = await aiEngine.analyze(sym, latestBar, newsRes.data.articles);
    } catch (err) {
      if (isAiUnavailableError(err)) {
        return res.json({
          ok: false,
          error: 'AI_UNAVAILABLE',
          message: 'AI temporarily unavailable',
          analysis: null
        });
      }
      throw err;
    }

    res.json({
      ok: true,
      error: null,
      message: null,
      analysis,
      rationale: analysis
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

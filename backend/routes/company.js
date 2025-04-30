// backend/routes/company.js
const router = require('express').Router();
const axios  = require('axios');

const DATA_URL = process.env.APCA_DATA_URL;
const H = {
  'APCA-API-KEY-ID':     process.env.BROKER_API_KEY,
  'APCA-API-SECRET-KEY': process.env.BROKER_API_SECRET
};

router.get('/:symbol', async (req, res, next) => {
  try {
    const sym = req.params.symbol;

    // 1. Asset metadata
    const assetRes = await axios.get(`${DATA_URL}/assets/${sym}`, { headers: H });

    // 2. Fundamentals (annual, limit=1)
    const fundRes = await axios.get(
      `${DATA_URL}/stocks/${sym}/fundamentals`,
      { headers: H, params: { timeframe: 'annual', limit: 1 } }
    );
    const [fund] = Array.isArray(fundRes.data) ? fundRes.data : [fundRes.data];

    res.json({
      company: assetRes.data,
      stats: {
        marketcap:     fund.market_cap,
        peRatio:       fund.pe_ratio,
        dividendYield: fund.dividend_yield,
        employees:     fund.employees
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

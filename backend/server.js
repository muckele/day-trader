app.use(express.json()); // at top, to parse JSON bodies

app.post('/api/trade', async (req, res, next) => {
  try {
    const { symbol, side, qty } = req.body; // e.g. { symbol: 'AAPL', side: 'buy', qty: 1 }
    const resp = await axios.post(
      `${process.env.BROKER_BASE_URL}/v2/orders`,
      {
        symbol,
        side,             // 'buy' | 'sell'
        qty,
        type: 'market',   // or 'limit', etc.
        time_in_force: 'day'
      },
      {
        headers: {
          'APCA-API-KEY-ID': process.env.BROKER_API_KEY,
          'APCA-API-SECRET-KEY': process.env.BROKER_API_SECRET
        }
      }
    );
    res.json(resp.data);
  } catch (err) {
    next(err);
  }
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getRecommendations } = require('./tradeLogic');

const app = express();
app.use(cors());

app.get('/api/recommend/:symbol', async (req, res, next) => {
  try {
    const recs = await getRecommendations(req.params.symbol.toUpperCase());
    res.json(recs);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Day Trader API listening on http://localhost:${PORT}`));

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

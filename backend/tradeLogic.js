const axios = require('axios');
const API_KEY = process.env.ALPHA_VANTAGE_KEY;

async function fetchDaily(symbol) {
  const resp = await axios.get('https://www.alphavantage.co/query', {
    params: {
      function: 'TIME_SERIES_DAILY_ADJUSTED',
      symbol,
      outputsize: 'compact',
      apikey: API_KEY
    }
  });
  return resp.data['Time Series (Daily)'];
}

function sma(array, N) {
  const slice = array.slice(0, N);
  return slice.reduce((sum, day) => sum + parseFloat(day['4. close']), 0) / N;
}

async function getRecommendations(symbol) {
  const series = await fetchDaily(symbol);
  const dates = Object.keys(series).sort((a, b) => new Date(b) - new Date(a));
  const closes = dates.map(d => series[d]);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const recommendation = sma20 > sma50 ? 'LONG' : 'SHORT';
  const instructions = recommendation === 'LONG' ? [
    `1. In your brokerage platform, place a BUY order for ${symbol}.`,
    `2. Set a stop-loss ~5% below your entry price.`,
    `3. Set a take-profit ~10% above your entry price.`,
    `4. Monitor daily: if 20-day SMA crosses below 50-day SMA, exit the position.`
  ] : [
    `1. Borrow shares of ${symbol} via your broker.`,
    `2. SELL the borrowed shares at market price.`,
    `3. Place a buy-to-cover order ~5% below your entry price.`,
    `4. If 20-day SMA crosses above 50-day SMA, cover your short position.`
  ];

  return {
    symbol,
    sma20: sma20.toFixed(2),
    sma50: sma50.toFixed(2),
    recommendation,
    instructions
  };
}

module.exports = { getRecommendations };

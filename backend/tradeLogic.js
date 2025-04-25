const axios = require('axios');
const API_KEY = process.env.ALPHA_VANTAGE_KEY;

// Fetch daily series (unadjusted) with robust error handling
async function fetchDaily(symbol) {
  const url = 'https://www.alphavantage.co/query';
  const resp = await axios.get(url, {
    params: {
      function: 'TIME_SERIES_DAILY',   // <- switched to the free endpoint
      symbol,
      outputsize: 'compact',
      apikey: API_KEY
    }
  });

  const data = resp.data;
  // DEBUG: uncomment to inspect what comes back
  // console.error('RAW AV data:', JSON.stringify(data, null, 2));

  const series = data['Time Series (Daily)'];
  if (series) {
    return series;
  }

  // Rate limit hit?
  if (data.Note) {
    throw new Error('Rate limit reached. Please wait a minute and try again.');
  }
  // Invalid symbol?
  if (data['Error Message']) {
    throw new Error(`Symbol "${symbol}" not found.`);
  }
  // Other info message?
  if (data.Information) {
    throw new Error(data.Information);
  }

  throw new Error('Unexpected API response format. Check backend logs for details.');
}

// Simple moving average over the last N days
function sma(array, N) {
  const slice = array.slice(0, N);
  return slice.reduce((sum, day) =>
    sum + parseFloat(day['4. close']), 0
  ) / N;
}

// Main entry: fetch data, compute SMAs, and build trade instructions
async function getRecommendations(symbol) {
  const series = await fetchDaily(symbol);

  // Sort dates descending so index 0 is the most recent
  const dates = Object.keys(series)
    .sort((a, b) => new Date(b) - new Date(a));

  // Map to price objects
  const closes = dates.map(date => series[date]);

  // Compute 20- & 50-day SMAs
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const recommendation = sma20 > sma50 ? 'LONG' : 'SHORT';

  // Human-readable steps
  const instructions = recommendation === 'LONG'
    ? [
        `1. Place a BUY order for ${symbol} in your brokerage account.`,
        `2. Set a stop-loss roughly 5% below your entry price.`,
        `3. Set a take-profit roughly 10% above entry.`,
        `4. Monitor: if the 20-day SMA crosses below the 50-day SMA, exit your position.`
      ]
    : [
        `1. Borrow shares of ${symbol} from your broker.`,
        `2. SELL the borrowed shares at market price.`,
        `3. Place a buy-to-cover order about 5% below your sale price.`,
        `4. Monitor: if the 20-day SMA crosses above the 50-day SMA, cover your short.`
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
async function fetchIntraday(symbol) {
  const resp = await axios.get('https://www.alphavantage.co/query', {
    params: {
      function: 'TIME_SERIES_INTRADAY',
      symbol,
      interval: '5min',
      outputsize: 'compact',
      apikey: API_KEY
    }
  });
  const data = resp.data['Time Series (5min)'];
  if (!data) throw new Error('Intraday data unavailable');
  return Object.entries(data).map(([time, vals]) => ({
    time,
    open: +vals['1. open'],
    high: +vals['2. high'],
    low: +vals['3. low'],
    close: +vals['4. close'],
    volume: +vals['5. volume']
  })).reverse();
}

module.exports = { getRecommendations, fetchIntraday };

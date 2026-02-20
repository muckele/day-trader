const { sma, rsi } = require('../signal/indicators');
const { getStrategy } = require('../signal/strategies');

function seriesSma(values, period) {
  return values.map((_, index) => {
    const slice = values.slice(0, index + 1);
    return sma(slice, period);
  });
}

function seriesRsi(values, period) {
  return values.map((_, index) => {
    const slice = values.slice(0, index + 1);
    return rsi(slice, period);
  });
}

function computeMetrics({ trades, equityCurve }) {
  const tradeCount = trades.length;
  const wins = trades.filter(trade => trade.pnl > 0).length;
  const winRate = tradeCount ? wins / tradeCount : 0;
  const avgR = tradeCount
    ? trades.reduce((acc, trade) => acc + trade.rMultiple, 0) / tradeCount
    : 0;

  let peak = equityCurve.length ? equityCurve[0].equity : 0;
  let maxDrawdown = 0;
  equityCurve.forEach(point => {
    if (point.equity > peak) peak = point.equity;
    const drawdown = (peak - point.equity) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  });

  return {
    tradeCount,
    winRate: Number((winRate * 100).toFixed(2)),
    avgR: Number(avgR.toFixed(2)),
    maxDrawdown: Number((maxDrawdown * 100).toFixed(2))
  };
}

function backtestStrategy(bars, strategyId) {
  const strategy = getStrategy(strategyId);
  if (!strategy) {
    throw new Error('Unsupported strategy.');
  }

  const closes = bars.map(bar => bar.c);
  const dates = bars.map(bar => bar.t || bar.date);
  const sma20Series = seriesSma(closes, 20);
  const sma50Series = seriesSma(closes, 50);
  const rsiSeries = seriesRsi(closes, 14);

  let inPosition = false;
  let entryPrice = 0;
  let entryDate = null;
  let realized = 0;
  const trades = [];
  const equityCurve = [];
  const startingEquity = 100000;

  for (let i = 1; i < bars.length; i += 1) {
    const close = closes[i];
    const sma20 = sma20Series[i];
    const sma50 = sma50Series[i];
    const prevSma20 = sma20Series[i - 1];
    const prevSma50 = sma50Series[i - 1];
    const rsiValue = rsiSeries[i];

    const trendUp = sma20 && sma50 && sma20 > sma50;
    const crossUp = prevSma20 && prevSma50 && prevSma20 <= prevSma50 && sma20 > sma50;
    const crossDown = prevSma20 && prevSma50 && prevSma20 >= prevSma50 && sma20 < sma50;

    let enter = false;
    let exit = false;

    if (strategyId === 'SMA_CROSS') {
      enter = !inPosition && crossUp;
      exit = inPosition && crossDown;
    } else if (strategyId === 'PULLBACK_TREND') {
      enter = !inPosition && trendUp && close <= sma20 * 1.01;
      exit = inPosition && (close >= entryPrice * 1.05 || crossDown);
    } else if (strategyId === 'MEAN_REVERSION_RSI') {
      enter = !inPosition && rsiValue !== null && rsiValue < 30;
      exit = inPosition && rsiValue !== null && rsiValue > 50;
    } else {
      throw new Error('Backtest not implemented for this strategy.');
    }

    if (enter) {
      inPosition = true;
      entryPrice = close;
      entryDate = dates[i];
    }

    if (exit && inPosition) {
      const pnl = close - entryPrice;
      const risk = entryPrice * 0.02 || 1;
      const rMultiple = pnl / risk;
      realized += pnl;
      trades.push({
        entryDate,
        exitDate: dates[i],
        entryPrice,
        exitPrice: close,
        pnl: Number(pnl.toFixed(2)),
        rMultiple: Number(rMultiple.toFixed(2))
      });
      inPosition = false;
      entryPrice = 0;
      entryDate = null;
    }

    const unrealized = inPosition ? close - entryPrice : 0;
    equityCurve.push({
      timestamp: dates[i],
      equity: Number((startingEquity + realized + unrealized).toFixed(2))
    });
  }

  const metrics = computeMetrics({ trades, equityCurve });
  return {
    strategyId,
    trades,
    equityCurve,
    ...metrics
  };
}

module.exports = { backtestStrategy };

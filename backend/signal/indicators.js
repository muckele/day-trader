function sma(values, period) {
  if (!values.length) return null;
  const slice = values.slice(-period);
  if (slice.length < period) return null;
  const sum = slice.reduce((acc, value) => acc + value, 0);
  return sum / slice.length;
}

function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const high = bars[i].h;
    const low = bars[i].l;
    const prevClose = bars[i - 1].c;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  const sum = slice.reduce((acc, value) => acc + value, 0);
  return sum / slice.length;
}

function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  let rs = avgGain / avgLoss;
  let rsiValue = 100 - 100 / (1 + rs);

  for (let i = period + 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    if (avgLoss === 0) {
      rsiValue = 100;
    } else {
      rs = avgGain / avgLoss;
      rsiValue = 100 - 100 / (1 + rs);
    }
  }

  return rsiValue;
}

function averageDollarVolume(bars, period = 20) {
  if (!bars.length) return null;
  const slice = bars.slice(-period);
  const sum = slice.reduce((acc, bar) => acc + bar.c * bar.v, 0);
  return sum / slice.length;
}

function averageRangePct(bars, period = 20) {
  if (!bars.length) return null;
  const slice = bars.slice(-period);
  const sum = slice.reduce((acc, bar) => {
    const range = bar.h - bar.l;
    const pct = bar.c ? range / bar.c : 0;
    return acc + pct;
  }, 0);
  return sum / slice.length;
}

function rollingVolatility(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const returns = [];
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const curr = closes[i];
    returns.push((curr - prev) / prev);
  }
  const mean = returns.reduce((acc, value) => acc + value, 0) / returns.length;
  const variance = returns.reduce((acc, value) => acc + (value - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

function slope(values, period = 10) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const n = slice.length;
  const sumX = slice.reduce((acc, _value, idx) => acc + idx, 0);
  const sumY = slice.reduce((acc, value) => acc + value, 0);
  const sumXY = slice.reduce((acc, value, idx) => acc + idx * value, 0);
  const sumX2 = slice.reduce((acc, _value, idx) => acc + idx * idx, 0);
  const denominator = n * sumX2 - sumX * sumX;
  if (!denominator) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}

module.exports = {
  sma,
  atr,
  rsi,
  averageDollarVolume,
  averageRangePct,
  rollingVolatility,
  slope
};

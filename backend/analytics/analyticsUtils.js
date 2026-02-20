function parseRange(range) {
  if (!range || range === 'all') return null;
  const now = new Date();
  if (range === '7d') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (range === '30d') return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (range === '90d') return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  return null;
}

function matchesRegime(trade, regime) {
  if (!regime) return true;
  const snapshot = trade.regimeAtTrade || {};
  return [snapshot.trendChop, snapshot.vol, snapshot.risk].includes(regime);
}

function filterTrades(trades, { range, symbol, strategyId, regime }) {
  const startDate = parseRange(range);
  return trades.filter(trade => {
    if (startDate && new Date(trade.filledAt) < startDate) return false;
    if (symbol && trade.symbol !== symbol.toUpperCase()) return false;
    if (strategyId && trade.strategyId !== strategyId) return false;
    if (!matchesRegime(trade, regime)) return false;
    return true;
  });
}

function computeDrawdownSeries(equityPoints) {
  let peak = null;
  let maxDrawdown = 0;
  const series = equityPoints.map(point => {
    const equity = point.equity;
    if (peak === null || equity > peak) peak = equity;
    const drawdown = peak ? (peak - equity) / peak : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    return {
      timestamp: point.timestamp,
      equity,
      drawdown: Number((drawdown * 100).toFixed(2))
    };
  });
  return {
    series,
    maxDrawdown: Number((maxDrawdown * 100).toFixed(2))
  };
}

function computeRMultiple(trade) {
  if (trade.rMultiple !== undefined && trade.rMultiple !== null) {
    return trade.rMultiple;
  }
  if (!trade.stopPrice) return null;
  const riskPerShare = Math.abs(trade.price - trade.stopPrice);
  if (!riskPerShare) return null;
  return trade.realizedPnl / (riskPerShare * trade.qty);
}

function aggregateStrategies(trades) {
  const map = {};
  trades.forEach(trade => {
    const key = trade.strategyId || 'UNKNOWN';
    if (!map[key]) {
      map[key] = {
        strategyId: key,
        trades: 0,
        wins: 0,
        pnl: 0,
        rTotal: 0,
        rCount: 0,
        cumulative: 0,
        peak: 0,
        maxDrawdown: 0
      };
    }
    const entry = map[key];
    entry.trades += 1;
    entry.pnl += trade.realizedPnl;
    if (trade.realizedPnl > 0) entry.wins += 1;
    const r = computeRMultiple(trade);
    if (r !== null && Number.isFinite(r)) {
      entry.rTotal += r;
      entry.rCount += 1;
    }

    entry.cumulative += trade.realizedPnl;
    if (entry.cumulative > entry.peak) entry.peak = entry.cumulative;
    const drawdown = entry.peak - entry.cumulative;
    if (drawdown > entry.maxDrawdown) entry.maxDrawdown = drawdown;
  });

  return Object.values(map).map(entry => ({
    strategyId: entry.strategyId,
    trades: entry.trades,
    winRate: entry.trades ? Number(((entry.wins / entry.trades) * 100).toFixed(2)) : 0,
    totalPnl: Number(entry.pnl.toFixed(2)),
    avgR: entry.rCount ? Number((entry.rTotal / entry.rCount).toFixed(2)) : null,
    maxDrawdown: Number(entry.maxDrawdown.toFixed(2))
  }));
}

function aggregateRegimes(trades) {
  const buckets = {
    trendChop: {},
    vol: {},
    risk: {}
  };

  trades.forEach(trade => {
    const snapshot = trade.regimeAtTrade || {};
    [['trendChop', snapshot.trendChop], ['vol', snapshot.vol], ['risk', snapshot.risk]].forEach(([key, value]) => {
      if (!value) return;
      if (!buckets[key][value]) {
        buckets[key][value] = { label: value, trades: 0, wins: 0, pnl: 0, rTotal: 0, rCount: 0 };
      }
      const entry = buckets[key][value];
      entry.trades += 1;
      entry.pnl += trade.realizedPnl;
      if (trade.realizedPnl > 0) entry.wins += 1;
      const r = computeRMultiple(trade);
      if (r !== null && Number.isFinite(r)) {
        entry.rTotal += r;
        entry.rCount += 1;
      }
    });
  });

  const toArray = group => Object.values(group).map(entry => ({
    label: entry.label,
    trades: entry.trades,
    winRate: entry.trades ? Number(((entry.wins / entry.trades) * 100).toFixed(2)) : 0,
    totalPnl: Number(entry.pnl.toFixed(2)),
    avgR: entry.rCount ? Number((entry.rTotal / entry.rCount).toFixed(2)) : null
  }));

  return {
    trendChop: toArray(buckets.trendChop),
    vol: toArray(buckets.vol),
    risk: toArray(buckets.risk)
  };
}

function computeHoldTimes(trades) {
  const positions = {};
  const holdTimes = [];
  trades.forEach(trade => {
    const symbol = trade.symbol;
    const qtyDelta = trade.side === 'buy' ? trade.qty : -trade.qty;
    const current = positions[symbol] || { qty: 0, openTime: null };
    const nextQty = current.qty + qtyDelta;
    const tradeTime = new Date(trade.filledAt);

    if (current.qty === 0 && nextQty !== 0) {
      current.openTime = tradeTime;
    }

    if (current.qty !== 0 && nextQty === 0 && current.openTime) {
      holdTimes.push(tradeTime - current.openTime);
      current.openTime = null;
    }

    if (current.qty !== 0 && current.qty * nextQty < 0) {
      if (current.openTime) holdTimes.push(tradeTime - current.openTime);
      current.openTime = tradeTime;
    }

    current.qty = nextQty;
    positions[symbol] = current;
  });

  if (!holdTimes.length) return null;
  const avgMs = holdTimes.reduce((acc, value) => acc + value, 0) / holdTimes.length;
  return avgMs / (1000 * 60 * 60);
}

module.exports = {
  parseRange,
  filterTrades,
  computeDrawdownSeries,
  aggregateStrategies,
  aggregateRegimes,
  computeRMultiple,
  computeHoldTimes
};

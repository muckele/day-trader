function applyTradeToPosition(position, trade) {
  const qty = Number(trade.qty);
  const side = trade.side;
  const price = Number(trade.price);
  const tradeQty = side === 'buy' ? qty : -qty;

  const currentQty = position.qty || 0;
  const currentAvg = position.avgCost || 0;

  let realizedPnl = 0;
  let nextQty = currentQty + tradeQty;
  let nextAvg = currentAvg;

  if (currentQty === 0 || currentQty * tradeQty > 0) {
    const totalQty = Math.abs(currentQty) + Math.abs(tradeQty);
    nextAvg = totalQty === 0
      ? 0
      : (Math.abs(currentQty) * currentAvg + Math.abs(tradeQty) * price) / totalQty;
  } else {
    const closingQty = Math.min(Math.abs(currentQty), Math.abs(tradeQty));
    if (currentQty > 0) {
      realizedPnl = (price - currentAvg) * closingQty;
    } else {
      realizedPnl = (currentAvg - price) * closingQty;
    }

    if (nextQty === 0) {
      nextAvg = 0;
    } else if (currentQty * nextQty < 0) {
      nextAvg = price;
    } else {
      nextAvg = currentAvg;
    }
  }

  return {
    position: {
      qty: nextQty,
      avgCost: nextAvg
    },
    realizedPnl
  };
}

function buildPositions(trades) {
  const positions = {};
  let totalRealized = 0;

  trades.forEach(trade => {
    const symbol = trade.symbol;
    if (!positions[symbol]) {
      positions[symbol] = { qty: 0, avgCost: 0, realizedPnl: 0 };
    }

    const { position, realizedPnl } = applyTradeToPosition(positions[symbol], trade);
    positions[symbol] = {
      ...position,
      realizedPnl: (positions[symbol].realizedPnl || 0) + realizedPnl
    };
    totalRealized += realizedPnl;
  });

  return { positions, totalRealized };
}

function calculateCash(trades, startingCash) {
  let cash = startingCash;
  trades.forEach(trade => {
    const notional = trade.price * trade.qty;
    if (trade.side === 'buy') {
      cash -= notional + (trade.commission || 0);
    } else {
      cash += notional - (trade.commission || 0);
    }
  });
  return cash;
}

function calculateDailyPnl(trades, date = new Date()) {
  const targetDay = date.toISOString().slice(0, 10);
  return trades
    .filter(trade => trade.filledAt.toISOString().slice(0, 10) === targetDay)
    .reduce((sum, trade) => sum + (trade.realizedPnl || 0), 0);
}

function calculatePositionMetrics(position, marketPrice) {
  const qty = position.qty;
  const avgCost = position.avgCost;
  if (!qty) {
    return { marketValue: 0, unrealizedPnl: 0, unrealizedPnlPct: 0 };
  }
  const marketValue = qty * marketPrice;
  const unrealizedPnl = qty > 0
    ? (marketPrice - avgCost) * qty
    : (avgCost - marketPrice) * Math.abs(qty);
  const costBasis = Math.abs(qty * avgCost) || 1;
  const unrealizedPnlPct = (unrealizedPnl / costBasis) * 100;
  return {
    marketValue,
    unrealizedPnl,
    unrealizedPnlPct
  };
}

module.exports = {
  applyTradeToPosition,
  buildPositions,
  calculateCash,
  calculateDailyPnl,
  calculatePositionMetrics
};

const { atr, sma, rsi } = require('../signal/indicators');
const { getStrategy } = require('../signal/strategies');
const { evaluateResearch } = require('../robotrader/strategyEngine');

const DEFAULT_STARTING_EQUITY = 100000;
const DEFAULT_MAX_TRADE_AMOUNT = 1000;
const DEFAULT_SLIPPAGE_BPS = 25;

function seriesSma(values, period) {
  return values.map((_, index) => sma(values.slice(0, index + 1), period));
}

function seriesRsi(values, period) {
  return values.map((_, index) => rsi(values.slice(0, index + 1), period));
}

function seriesAtr(bars, period) {
  return bars.map((_, index) => atr(bars.slice(0, index + 1), period));
}

function toPositiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function applySlippage(price, side, slippageBps) {
  const factor = Math.max(0, Number(slippageBps) || 0) / 10000;
  return side === 'buy' ? price * (1 + factor) : price * (1 - factor);
}

function computeMetrics({ trades = [], equityCurve = [], startingEquity = DEFAULT_STARTING_EQUITY } = {}) {
  const tradeCount = trades.length;
  const wins = trades.filter(trade => trade.pnl > 0).length;
  const winRate = tradeCount ? wins / tradeCount : 0;
  const avgR = tradeCount
    ? trades.reduce((acc, trade) => acc + trade.rMultiple, 0) / tradeCount
    : 0;

  let peak = toPositiveNumber(startingEquity, DEFAULT_STARTING_EQUITY);
  let maxDrawdown = 0;
  equityCurve.forEach(point => {
    if (point.equity > peak) peak = point.equity;
    const drawdown = peak > 0 ? (peak - point.equity) / peak : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  });

  return {
    tradeCount,
    winRate: Number((winRate * 100).toFixed(2)),
    avgR: Number(avgR.toFixed(2)),
    maxDrawdown: Number((maxDrawdown * 100).toFixed(2))
  };
}

function buildRoboResearch({ bars, index, closes, volumes, indicatorSeries }) {
  const close = closes[index];
  const day5Ago = index >= 5 ? closes[index - 5] : null;
  const day20Ago = index >= 20 ? closes[index - 20] : null;
  const averageVolume20 = indicatorSeries.avgVolume20[index] || 0;
  const atr14 = indicatorSeries.atr14[index];
  return {
    symbol: 'BACKTEST',
    assetClass: 'stocks',
    price: close,
    quote: { price: close },
    bars: bars.slice(Math.max(0, index - 219), index + 1),
    indicators: {
      sma20: indicatorSeries.sma20[index],
      sma50: indicatorSeries.sma50[index],
      sma200: indicatorSeries.sma200[index],
      rsi14: indicatorSeries.rsi14[index],
      atr14,
      atrPct: close && atr14 ? (atr14 / close) * 100 : null,
      avgVolume20: averageVolume20,
      recentVolume: volumes[index],
      volumeRatio: averageVolume20 > 0 ? volumes[index] / averageVolume20 : null,
      fiveDayChangePct: day5Ago ? ((close - day5Ago) / day5Ago) * 100 : null,
      twentyDayChangePct: day20Ago ? ((close - day20Ago) / day20Ago) * 100 : null
    }
  };
}

function getNestedPrice(input, objectKey, fieldKey) {
  const value = input?.[objectKey]?.[fieldKey];
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getProtectivePrices(order = {}) {
  return {
    stopPrice: getNestedPrice(order, 'stopLoss', 'stop_price')
      || toPositiveNumber(order.riskStopPrice, null),
    targetPrice: getNestedPrice(order, 'takeProfit', 'limit_price')
      || (String(order.orderClass || '').toLowerCase() === 'simple'
        ? null
        : toPositiveNumber(order.riskTakeProfitPrice, null))
  };
}

function backtestStrategy(bars, strategyId, options = {}) {
  const strategy = getStrategy(strategyId);
  if (!strategy) throw new Error('Unsupported strategy.');

  const {
    tradeStartAt = null,
    startingEquity = DEFAULT_STARTING_EQUITY,
    maxTradeAmount = DEFAULT_MAX_TRADE_AMOUNT,
    riskLevel = 'balanced',
    allowFractionalShares = true,
    slippageBps = DEFAULT_SLIPPAGE_BPS,
    commission = 0
  } = options;
  const normalizedStartingEquity = toPositiveNumber(startingEquity, DEFAULT_STARTING_EQUITY);
  const strategySettings = {
    maxTradeAmount: toPositiveNumber(maxTradeAmount, DEFAULT_MAX_TRADE_AMOUNT),
    riskLevel,
    allowFractionalShares
  };
  const closes = bars.map(bar => Number(bar.c));
  const volumes = bars.map(bar => Number(bar.v || 0));
  const dates = bars.map(bar => bar.t || bar.date);
  const indicatorSeries = {
    sma20: seriesSma(closes, 20),
    sma50: seriesSma(closes, 50),
    sma200: seriesSma(closes, 200),
    avgVolume20: seriesSma(volumes, 20),
    rsi14: seriesRsi(closes, 14),
    atr14: seriesAtr(bars, 14)
  };

  let position = null;
  let realized = 0;
  const trades = [];
  const equityCurve = [];
  const tradeStart = tradeStartAt ? new Date(tradeStartAt) : null;

  function closePosition({ price, date, reason }) {
    const exitSide = position.side === 'short' ? 'buy' : 'sell';
    const exitPrice = applySlippage(price, exitSide, slippageBps);
    const grossPnl = position.side === 'short'
      ? (position.entryPrice - exitPrice) * position.qty
      : (exitPrice - position.entryPrice) * position.qty;
    const pnl = grossPnl - Number(commission || 0);
    const rMultiple = position.initialRiskUsd > 0 ? pnl / position.initialRiskUsd : 0;
    realized += pnl;
    trades.push({
      entryDate: position.entryDate,
      exitDate: date,
      entryPrice: Number(position.entryPrice.toFixed(4)),
      exitPrice: Number(exitPrice.toFixed(4)),
      qty: Number(position.qty.toFixed(6)),
      side: position.side,
      exitReason: reason,
      pnl: Number(pnl.toFixed(2)),
      rMultiple: Number(rMultiple.toFixed(2))
    });
    position = null;
  }

  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];
    const close = closes[i];
    const high = Number(bar.h ?? close);
    const low = Number(bar.l ?? close);
    const currentBarTime = new Date(dates[i]);
    const canEnter = !tradeStart
      || (!Number.isNaN(tradeStart.getTime()) && !Number.isNaN(currentBarTime.getTime()) && currentBarTime >= tradeStart);

    if (position) {
      if (position.side === 'long') {
        if (position.stopPrice && low <= position.stopPrice) {
          closePosition({ price: position.stopPrice, date: dates[i], reason: 'stop_loss' });
        } else if (position.targetPrice && high >= position.targetPrice) {
          closePosition({ price: position.targetPrice, date: dates[i], reason: 'take_profit' });
        }
      } else if (position.stopPrice && high >= position.stopPrice) {
        closePosition({ price: position.stopPrice, date: dates[i], reason: 'stop_loss' });
      } else if (position.targetPrice && low <= position.targetPrice) {
        closePosition({ price: position.targetPrice, date: dates[i], reason: 'take_profit' });
      }
    }

    if (!position && canEnter) {
      let recommendedOrder = null;
      if (String(strategyId).startsWith('ROBO_')) {
        const research = buildRoboResearch({ bars, index: i, closes, volumes, indicatorSeries });
        const decision = evaluateResearch(research, strategySettings);
        if (decision.strategyId === strategyId && decision.action !== 'hold') {
          recommendedOrder = decision.recommendedOrder;
        }
      } else {
        const sma20 = indicatorSeries.sma20[i];
        const sma50 = indicatorSeries.sma50[i];
        const prevSma20 = indicatorSeries.sma20[i - 1];
        const prevSma50 = indicatorSeries.sma50[i - 1];
        const crossUp = prevSma20 && prevSma50 && prevSma20 <= prevSma50 && sma20 > sma50;
        const trendUp = sma20 && sma50 && sma20 > sma50;
        const rsiValue = indicatorSeries.rsi14[i];
        const recentHigh = Math.max(...bars.slice(Math.max(0, i - 20), i).map(item => Number(item.h ?? item.c)));
        const volumeRatio = indicatorSeries.avgVolume20[i] > 0 ? volumes[i] / indicatorSeries.avgVolume20[i] : 0;
        const enter = strategyId === 'SMA_CROSS'
          ? crossUp
          : strategyId === 'PULLBACK_TREND'
            ? trendUp && close <= sma20 * 1.01
            : strategyId === 'MEAN_REVERSION_RSI'
              ? rsiValue !== null && rsiValue < 30
              : strategyId === 'BREAKOUT_VOLUME'
                ? close > recentHigh && volumeRatio > 1.5
                : false;
        if (enter) {
          recommendedOrder = {
            side: 'buy',
            qty: Math.max(0.000001, strategySettings.maxTradeAmount / close),
            orderClass: 'bracket',
            stopLoss: { stop_price: close * 0.98 },
            takeProfit: { limit_price: close * 1.05 }
          };
        }
      }

      if (recommendedOrder) {
        const entrySide = String(recommendedOrder.side).toLowerCase() === 'sell' ? 'short' : 'long';
        const brokerSide = entrySide === 'short' ? 'sell' : 'buy';
        const entryPrice = applySlippage(close, brokerSide, slippageBps);
        const quantity = toPositiveNumber(
          recommendedOrder.qty,
          toPositiveNumber(recommendedOrder.notional, strategySettings.maxTradeAmount) / entryPrice
        );
        const { stopPrice, targetPrice } = getProtectivePrices(recommendedOrder);
        const riskPerShare = stopPrice ? Math.abs(entryPrice - stopPrice) : entryPrice * 0.02;
        position = {
          side: entrySide,
          entryDate: dates[i],
          entryPrice,
          qty: quantity,
          stopPrice,
          targetPrice,
          initialRiskUsd: Math.max(riskPerShare * quantity, 0.01)
        };
      }
    }

    const unrealized = position
      ? (position.side === 'short'
        ? (position.entryPrice - close) * position.qty
        : (close - position.entryPrice) * position.qty)
      : 0;
    equityCurve.push({
      timestamp: dates[i],
      equity: Number((normalizedStartingEquity + realized + unrealized).toFixed(2))
    });
  }

  if (position && bars.length) {
    const lastIndex = bars.length - 1;
    closePosition({ price: closes[lastIndex], date: dates[lastIndex], reason: 'window_end' });
    if (equityCurve.length) {
      equityCurve[equityCurve.length - 1].equity = Number((normalizedStartingEquity + realized).toFixed(2));
    }
  }

  const metrics = computeMetrics({ trades, equityCurve, startingEquity: normalizedStartingEquity });
  return {
    strategyId,
    assumptions: {
      startingEquity: normalizedStartingEquity,
      maxTradeAmount: strategySettings.maxTradeAmount,
      riskLevel,
      allowFractionalShares,
      slippageBps: Number(slippageBps) || 0,
      commission: Number(commission) || 0,
      terminalPositionPolicy: 'close_at_window_end'
    },
    trades,
    equityCurve,
    ...metrics
  };
}

module.exports = {
  DEFAULT_MAX_TRADE_AMOUNT,
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_STARTING_EQUITY,
  backtestStrategy,
  computeMetrics
};

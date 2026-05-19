const router = require('express').Router();
const requireMongo = require('../middleware/requireMongo');
const PaperTrade = require('../models/PaperTrade');
const PaperOrder = require('../models/PaperOrder');
const PaperEquity = require('../models/PaperEquity');
const PaperSettings = require('../models/PaperSettings');
const PaperGuardrailEvent = require('../models/PaperGuardrailEvent');
const BrokerOrder = require('../models/BrokerOrder');
const Fill = require('../models/Fill');
const paperBroker = require('../paper/paperBrokerClient');
const {
  parseRange,
  filterTrades,
  computeDrawdownSeries,
  aggregateStrategies,
  aggregateRegimes,
  computeRMultiple,
  computeHoldTimes
} = require('../analytics/analyticsUtils');
const { buildSnapshot } = require('../analytics/snapshot');

const ACCOUNT_ID = 'default';

router.use(requireMongo);

function sum(values) {
  return values.reduce((acc, value) => acc + value, 0);
}

function profitFactor(trades) {
  const gains = sum(trades.filter(trade => trade.realizedPnl > 0).map(trade => trade.realizedPnl));
  const losses = Math.abs(sum(trades.filter(trade => trade.realizedPnl < 0).map(trade => trade.realizedPnl)));
  if (!losses) return null;
  return Number((gains / losses).toFixed(2));
}

function rollingMetrics(trades, days) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const slice = trades.filter(trade => new Date(trade.filledAt) >= start);
  const pnl = sum(slice.map(trade => trade.realizedPnl));
  const wins = slice.filter(trade => trade.realizedPnl > 0).length;
  const winRate = slice.length ? Number(((wins / slice.length) * 100).toFixed(2)) : 0;
  return {
    pnl: Number(pnl.toFixed(2)),
    winRate
  };
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 0) {
    return Number(((ordered[middle - 1] + ordered[middle]) / 2).toFixed(2));
  }
  return Number(ordered[middle].toFixed(2));
}

function buildExecutionQualityPayload({ range, orders, fills }) {
  const filledOrders = orders.filter(order => order.status === 'filled');
  const rejectedOrders = orders.filter(order => order.status === 'rejected');
  const attemptedOrders = filledOrders.length + rejectedOrders.length;
  const rejectRate = attemptedOrders
    ? Number(((rejectedOrders.length / attemptedOrders) * 100).toFixed(2))
    : 0;

  const slippageValues = filledOrders
    .map(order => Number(order.slippageBps ?? order.effectiveSlippageBps))
    .filter(value => Number.isFinite(value));
  const avgSlippageBps = slippageValues.length
    ? Number((sum(slippageValues) / slippageValues.length).toFixed(2))
    : 0;
  const maxSlippageBps = slippageValues.length
    ? Number(Math.max(...slippageValues).toFixed(2))
    : 0;

  const latencyValues = filledOrders
    .map(order => Number(order.fillLatencyMs))
    .filter(value => Number.isFinite(value) && value >= 0);
  const avgFillLatencyMs = latencyValues.length
    ? Number((sum(latencyValues) / latencyValues.length).toFixed(2))
    : null;
  const medianFillLatencyMs = median(latencyValues);

  const rejectReasonMap = rejectedOrders.reduce((acc, order) => {
    const key = String(order.rejectionReason || order.rejectedReason || 'UNKNOWN');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const topRejectReasons = Object.entries(rejectReasonMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));

  const pnlBySetupMap = fills.reduce((acc, fill) => {
    const key = String(fill.setupType || 'UNSPECIFIED');
    if (!acc[key]) {
      acc[key] = { setupType: key, trades: 0, totalPnl: 0 };
    }
    acc[key].trades += 1;
    acc[key].totalPnl += Number(fill.realizedPnl || 0);
    return acc;
  }, {});
  const pnlBySetup = Object.values(pnlBySetupMap)
    .map(item => ({
      setupType: item.setupType,
      trades: item.trades,
      totalPnl: Number(item.totalPnl.toFixed(2))
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  const pnlByRegimeMap = fills.reduce((acc, fill) => {
    const regime = fill.regimeAtTrade || {};
    const key = `${regime.trendChop || 'NA'}|${regime.vol || 'NA'}|${regime.risk || 'NA'}`;
    if (!acc[key]) {
      acc[key] = {
        regime: {
          trendChop: regime.trendChop || 'NA',
          vol: regime.vol || 'NA',
          risk: regime.risk || 'NA'
        },
        trades: 0,
        totalPnl: 0
      };
    }
    acc[key].trades += 1;
    acc[key].totalPnl += Number(fill.realizedPnl || 0);
    return acc;
  }, {});
  const pnlByRegime = Object.values(pnlByRegimeMap)
    .map(item => ({
      regime: item.regime,
      trades: item.trades,
      totalPnl: Number(item.totalPnl.toFixed(2))
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  return {
    range,
    counts: {
      attemptedOrders,
      filledOrders: filledOrders.length,
      rejectedOrders: rejectedOrders.length
    },
    quality: {
      rejectRate,
      avgSlippageBps,
      maxSlippageBps,
      avgFillLatencyMs,
      medianFillLatencyMs
    },
    topRejectReasons,
    pnlBySetup,
    pnlByRegime
  };
}

router.get('/summary', async (req, res, next) => {
  try {
    const { range = '30d', symbol = '', strategyId = '', regime = '' } = req.query;
    const startDate = parseRange(range);
    const tradeQuery = { accountId: ACCOUNT_ID };
    if (startDate) tradeQuery.filledAt = { $gte: startDate };
    if (symbol) tradeQuery.symbol = symbol.toUpperCase();
    if (strategyId) tradeQuery.strategyId = strategyId;

    const trades = await PaperTrade.find(tradeQuery).sort({ filledAt: 1 }).lean();
    const filtered = filterTrades(trades, { range, symbol, strategyId, regime });
    const totalPnl = sum(filtered.map(trade => trade.realizedPnl));
    const wins = filtered.filter(trade => trade.realizedPnl > 0).length;
    const winRate = filtered.length ? Number(((wins / filtered.length) * 100).toFixed(2)) : 0;
    const pf = profitFactor(filtered);
    const expectancyValues = filtered
      .map(trade => computeRMultiple(trade))
      .filter(value => value !== null && Number.isFinite(value));
    const expectancy = expectancyValues.length
      ? Number((sum(expectancyValues) / expectancyValues.length).toFixed(2))
      : null;
    const above1R = expectancyValues.length
      ? Number(((expectancyValues.filter(val => val >= 1).length / expectancyValues.length) * 100).toFixed(2))
      : 0;
    const belowMinus1R = expectancyValues.length
      ? Number(((expectancyValues.filter(val => val <= -1).length / expectancyValues.length) * 100).toFixed(2))
      : 0;

    const equityQuery = { accountId: ACCOUNT_ID };
    if (startDate) equityQuery.timestamp = { $gte: startDate };
    const equityPoints = await PaperEquity.find(equityQuery).sort({ timestamp: 1 }).lean();
    const { series: drawdownSeries, maxDrawdown } = computeDrawdownSeries(
      equityPoints.map(point => ({ timestamp: point.timestamp, equity: point.equity }))
    );

    const account = await paperBroker.getAccount();
    const settings = await PaperSettings.findOne({ accountId: ACCOUNT_ID }).lean();
    const cashPct = account.equity ? (account.cash / account.equity) * 100 : 0;
    const positionsPct = account.equity ? (account.positionsValue / account.equity) * 100 : 0;
    const maxPositionUtilization = account.positions.length
      ? Math.max(...account.positions.map(pos => pos.marketValue)) / (account.equity || 1)
      : 0;

    const guardrailQuery = { accountId: ACCOUNT_ID };
    if (startDate) guardrailQuery.createdAt = { $gte: startDate };
    const guardrailBlocks = await PaperGuardrailEvent.countDocuments(guardrailQuery);

    const avgHoldHours = computeHoldTimes(filtered);

    res.json({
      range,
      tradeCount: filtered.length,
      totalPnl: Number(totalPnl.toFixed(2)),
      totalReturn: settings?.startingCash
        ? Number(((totalPnl / settings.startingCash) * 100).toFixed(2))
        : 0,
      dailyPnl: Number(account.dailyPnl.toFixed(2)),
      winRate,
      profitFactor: pf,
      expectancy,
      avgHoldHours: avgHoldHours ? Number(avgHoldHours.toFixed(2)) : null,
      maxDrawdown,
      rStats: {
        above1R,
        belowMinus1R
      },
      exposure: {
        cashPct: Number(cashPct.toFixed(2)),
        positionsPct: Number(positionsPct.toFixed(2)),
        maxPositionUtilization: Number((maxPositionUtilization * 100).toFixed(2)),
        guardrailBlocks
      },
      rolling: {
        '7d': rollingMetrics(filtered, 7),
        '30d': rollingMetrics(filtered, 30)
      },
      equityCurve: equityPoints,
      drawdownSeries
    });
  } catch (err) {
    next(err);
  }
});

router.get('/snapshot', async (req, res, next) => {
  try {
    const { range = '30d' } = req.query;
    const startDate = parseRange(range);
    const tradeQuery = { accountId: ACCOUNT_ID };
    if (startDate) tradeQuery.filledAt = { $gte: startDate };
    const trades = await PaperTrade.find(tradeQuery).sort({ filledAt: 1 }).lean();

    const equityQuery = { accountId: ACCOUNT_ID };
    if (startDate) equityQuery.timestamp = { $gte: startDate };
    const equityPoints = await PaperEquity.find(equityQuery).sort({ timestamp: 1 }).lean();

    const guardrailQuery = { accountId: ACCOUNT_ID };
    if (startDate) guardrailQuery.createdAt = { $gte: startDate };
    const guardrailBlocks = await PaperGuardrailEvent.countDocuments(guardrailQuery);

    res.json(buildSnapshot({
      range,
      trades,
      equityPoints,
      guardrailBlocks
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/strategies', async (req, res, next) => {
  try {
    const { range = '30d' } = req.query;
    const startDate = parseRange(range);
    const tradeQuery = { accountId: ACCOUNT_ID };
    if (startDate) tradeQuery.filledAt = { $gte: startDate };
    const trades = await PaperTrade.find(tradeQuery).sort({ filledAt: 1 }).lean();
    const grouped = aggregateStrategies(trades);
    const sorted = [...grouped].sort((a, b) => (b.avgR || -999) - (a.avgR || -999));
    res.json({
      range,
      strategies: grouped,
      top: sorted.slice(0, 3),
      bottom: sorted.slice(-3).reverse()
    });
  } catch (err) {
    next(err);
  }
});

router.get('/regimes', async (req, res, next) => {
  try {
    const { range = '30d' } = req.query;
    const startDate = parseRange(range);
    const tradeQuery = { accountId: ACCOUNT_ID };
    if (startDate) tradeQuery.filledAt = { $gte: startDate };
    const trades = await PaperTrade.find(tradeQuery).sort({ filledAt: 1 }).lean();
    const regimes = aggregateRegimes(trades);
    res.json({ range, regimes });
  } catch (err) {
    next(err);
  }
});

router.get('/trades.csv', async (req, res, next) => {
  try {
    const { range = '30d', symbol = '', strategyId = '', regime = '' } = req.query;
    const startDate = parseRange(range);
    const tradeQuery = { accountId: ACCOUNT_ID };
    if (startDate) tradeQuery.filledAt = { $gte: startDate };
    if (symbol) tradeQuery.symbol = symbol.toUpperCase();
    if (strategyId) tradeQuery.strategyId = strategyId;
    const trades = await PaperTrade.find(tradeQuery).sort({ filledAt: 1 }).lean();
    const filtered = filterTrades(trades, { range, symbol, strategyId, regime });

    const rows = filtered.map(trade => ({
      filledAt: new Date(trade.filledAt).toISOString(),
      symbol: trade.symbol,
      side: trade.side,
      qty: trade.qty,
      price: trade.price,
      realizedPnl: trade.realizedPnl,
      strategyId: trade.strategyId || '',
      setupType: trade.setupType || '',
      strategyTags: (trade.strategyTags || []).join('|'),
      rMultiple: computeRMultiple(trade) ?? '',
      trendChop: trade.regimeAtTrade?.trendChop || '',
      vol: trade.regimeAtTrade?.vol || '',
      risk: trade.regimeAtTrade?.risk || ''
    }));

    const headers = Object.keys(rows[0] || {
      filledAt: '',
      symbol: '',
      side: '',
      qty: '',
      price: '',
      realizedPnl: '',
      strategyId: '',
      setupType: '',
      strategyTags: '',
      rMultiple: '',
      trendChop: '',
      vol: '',
      risk: ''
    });

    const csvLines = [
      headers.join(','),
      ...rows.map(row => headers.map(header => JSON.stringify(row[header] ?? '')).join(','))
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="paper-trades.csv"');
    res.send(csvLines.join('\n'));
  } catch (err) {
    next(err);
  }
});

router.get('/execution-quality', async (req, res, next) => {
  try {
    const { range = '30d' } = req.query;
    const startDate = parseRange(range);
    const brokerOrderQuery = { accountId: ACCOUNT_ID };
    const fillQuery = { accountId: ACCOUNT_ID };
    const paperOrderQuery = { accountId: ACCOUNT_ID };
    const tradeQuery = { accountId: ACCOUNT_ID };
    if (startDate) {
      brokerOrderQuery.submittedAt = { $gte: startDate };
      fillQuery.filledAt = { $gte: startDate };
      paperOrderQuery.filledAt = { $gte: startDate };
      tradeQuery.filledAt = { $gte: startDate };
    }

    const [brokerOrders, fills] = await Promise.all([
      BrokerOrder.find(brokerOrderQuery).sort({ submittedAt: 1 }).lean(),
      Fill.find(fillQuery).sort({ filledAt: 1 }).lean()
    ]);

    if (brokerOrders.length || fills.length) {
      return res.json(buildExecutionQualityPayload({
        range,
        orders: brokerOrders,
        fills
      }));
    }

    const [paperOrders, trades] = await Promise.all([
      PaperOrder.find(paperOrderQuery).sort({ filledAt: 1 }).lean(),
      PaperTrade.find(tradeQuery).sort({ filledAt: 1 }).lean()
    ]);

    return res.json(buildExecutionQualityPayload({
      range,
      orders: paperOrders.map(order => ({
        ...order,
        slippageBps: order.effectiveSlippageBps,
        rejectionReason: order.rejectedReason,
        submittedAt: order.filledAt
      })),
      fills: trades
    }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;

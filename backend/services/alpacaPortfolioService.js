const { createAlpacaBroker } = require('../robotrader/alpacaBroker');
const OrderIntent = require('../models/OrderIntent');
const Fill = require('../models/Fill');
const source = { broker: 'alpaca', executionSource: 'alpaca-paper' };
function numeric(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
function position(row) {
  return { ...source, symbol: row.symbol, assetClass: 'equity', qty: numeric(row.qty), avgCost: numeric(row.avg_entry_price), marketPrice: numeric(row.current_price), marketValue: numeric(row.market_value), unrealizedPnl: numeric(row.unrealized_pl) };
}
function mapIntent(input) {
  const intent = input.toObject ? input.toObject() : input;
  return { ...intent, ...source, intentId: intent._id, fillPrice: numeric(intent.filledAvgPrice) ?? (intent.filledQty > 0 ? intent.filledNotionalCents / 100 / intent.filledQty : null), notional: numeric(intent.filledNotionalCents) === null ? null : intent.filledNotionalCents / 100, rejectedReason: intent.rejectionReason || null };
}
function createAlpacaPortfolio({ broker = createAlpacaBroker(), expectedAccountId = process.env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID } = {}) {
  async function verifiedAccount() {
    const account = await broker.getAccount();
    if (!expectedAccountId || account?.id !== expectedAccountId) throw Object.assign(new Error('Alpaca paper account identity mismatch.'), { statusCode: 503 });
    return account;
  }
  return {
    async getAccount() {
      const account = await verifiedAccount();
      const positions = (await broker.getPositions()).map(position);
      const equity = numeric(account.equity); const priorEquity = numeric(account.last_equity);
      return { ...source, accountId: expectedAccountId, asOf: new Date().toISOString(), cash: numeric(account.cash), equity, positionsValue: positions.every(p => p.marketValue !== null) ? positions.reduce((sum, p) => sum + p.marketValue, 0) : null, dailyPnl: equity !== null && priorEquity !== null ? equity - priorEquity : null, totalPnl: null, positions };
    },
    async getPositions() { await verifiedAccount(); return (await broker.getPositions()).map(position); },
    async getOrders() { await verifiedAccount(); return (await OrderIntent.find({ accountId: expectedAccountId, broker: 'alpaca', environment: 'paper' }).sort({ createdAt: -1 }).limit(500).lean()).map(mapIntent); },
    async getTrades() { await verifiedAccount(); return (await Fill.find({ accountId: expectedAccountId, broker: 'alpaca', environment: 'paper' }).sort({ filledAt: -1 }).limit(500).lean()).map(fill => ({ ...fill, ...source })); },
    async getEquityCurve() {
      await verifiedAccount();
      if (typeof broker.getPortfolioHistory !== 'function') throw Object.assign(new Error('Alpaca equity history unavailable.'), { statusCode: 503 });
      const history = await broker.getPortfolioHistory();
      if (!Array.isArray(history.timestamp) || !Array.isArray(history.equity)) throw new Error('Alpaca equity history unavailable.');
      return history.timestamp.map((time, index) => ({ ...source, timestamp: new Date(time * 1000).toISOString(), equity: numeric(history.equity[index]) }));
    }
  };
}
module.exports = { createAlpacaPortfolio, mapIntent };

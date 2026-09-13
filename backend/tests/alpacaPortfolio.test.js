const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlpacaPortfolio } = require('../services/alpacaPortfolioService');
test('Alpaca portfolio uses only broker account/positions and labels unknown P&L', async () => {
  const service = createAlpacaPortfolio({ expectedAccountId: 'fixture', broker: { getAccount: async () => ({ id: 'fixture', cash: '100', equity: '140' }), getPositions: async () => [{ symbol: 'SPY', qty: '1', avg_entry_price: '35', current_price: '40', market_value: '40', unrealized_pl: '5' }] } });
  const account = await service.getAccount();
  assert.equal(account.executionSource, 'alpaca-paper');
  assert.equal(account.cash, 100);
  assert.equal(account.positions[0].qty, 1);
  assert.equal(account.dailyPnl, null);
  assert.equal(account.totalPnl, null);
});
test('Alpaca reads reject account mismatch instead of exposing the wrong portfolio', async () => {
  const service = createAlpacaPortfolio({ expectedAccountId: 'bound', broker: { getAccount: async () => ({ id: 'wrong' }), getPositions: async () => [] } });
  await assert.rejects(service.getAccount(), /identity/);
});
test('Alpaca account unknown cash is unavailable rather than zero', async () => {
  const service = createAlpacaPortfolio({ expectedAccountId: 'bound', broker: { getAccount: async () => ({ id: 'bound', cash: null }), getPositions: async () => [] } });
  assert.equal((await service.getAccount()).cash, null);
});
test('fill reader returns actual strict-schema lifecycle fills and excludes simulator/other account records', async t => {
  const Fill = require('../models/Fill');
  const fill = new Fill({ accountId: 'bound', broker: 'alpaca', executionSource: 'alpaca-paper', environment: 'paper', symbol: 'AAPL', side: 'buy', qty: 2, price: 100 }).toObject();
  assert.equal(fill.environment, undefined, 'Fill persists source, not an environment field');
  const rows = [fill, { ...fill, accountId: 'other' }, { ...fill, broker: 'paper', executionSource: 'local-simulation' }];
  t.mock.method(Fill, 'find', query => ({ sort: () => ({ limit: () => ({ lean: async () => rows.filter(row => Object.entries(query).every(([key, value]) => row[key] === value)) }) }) }));
  const service = createAlpacaPortfolio({ expectedAccountId: 'bound', broker: { getAccount: async () => ({ id: 'bound' }) } });
  const trades = await service.getTrades();
  assert.equal(trades.length, 1);
  assert.equal(trades[0].qty, 2);
  assert.equal(trades[0].executionSource, 'alpaca-paper');
});

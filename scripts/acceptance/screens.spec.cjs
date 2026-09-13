const { test, expect } = require('../../frontend/node_modules/@playwright/test');
const { startHarness } = require('./harness.cjs');
let h;
test.beforeEach(async () => { h = await startHarness(); });
test.afterEach(async () => { if (h) await h.close(); });
const screens = [
  { name: 'Home/watchlist', path: '/watchlist', heading: 'Daily Recommendations', ready: async p => { await expect(p.getByRole('heading', { name: 'Live Board', exact: true })).toBeVisible(); await expect(p.getByPlaceholder('Add symbol (AAPL, NVDA...)')).toBeVisible(); } },
  { name: 'Stock', path: '/stock/AAPL', heading: /\(AAPL\)/, ready: async p => { await expect(p.getByRole('button', { name: 'Review Paper Trade', exact: true })).toBeVisible(); } },
  { name: 'Research', path: '/research/AAPL', heading: 'Market dashboard and stock deep dives', ready: async p => { await expect(p.getByText(/Research generated/)).toBeVisible(); await expect(p.getByRole('button', { name: 'Trade', exact: true })).toBeVisible(); } },
  { name: 'Trade Plan', path: '/plan', heading: 'Daily Playbook', ready: async p => { await expect(p.getByRole('button', { name: /Generate/ }).first()).toBeVisible(); } },
  { name: 'Portfolio', path: '/portfolio', heading: 'Alpaca Paper', ready: async p => { await expect(p.getByText('Cash', { exact: true })).toBeVisible(); await expect(p.getByText('Positions', { exact: true })).toBeVisible(); } },
  { name: 'Activity', path: '/activity', heading: 'Orders & Trades', ready: async p => { await expect(p.getByText('Recent Activity', { exact: true })).toBeVisible(); } },
  { name: 'Analytics', path: '/analytics', heading: 'Local Simulator Performance', ready: async p => { await expect(p.getByText('Analytics · Local simulator only', { exact: true })).toBeVisible(); await expect(p.getByText(/^Trades \d+$/, { exact: true })).toBeVisible(); } },
  { name: 'RoboTrader', path: '/robo', heading: 'RoboTrader', ready: async p => { await expect(p.getByRole('heading', { name: 'Alpaca paper trading only', exact: true })).toBeVisible(); await expect(p.getByRole('button', { name: 'Live — unavailable', exact: true })).toBeDisabled(); } },
  { name: 'Trading System', path: '/trading-system', heading: 'Trading System', ready: async p => { await expect(p.getByTestId('backtest-assumptions')).toContainText('same close'); await expect(p.getByText('Live Disabled', { exact: true })).toBeVisible(); } }
];
async function login(page) {
  await page.goto(h.baseURL + '/login');
  await page.getByPlaceholder('Username').fill('acceptance-owner');
  await page.getByPlaceholder('Password').fill('local-test-password');
  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  await expect(page).toHaveURL(h.baseURL + '/');
}
async function visit(page, screen) {
  await page.goto(h.baseURL + screen.path);
  await expect(page.getByRole('heading', { name: screen.heading, exact: typeof screen.heading === 'string' })).toBeVisible();
  await screen.ready(page);
}
async function eachScreen(fn) { for (const screen of screens) await test.step(screen.name, () => fn(screen)); }

test('core screen empty persisted data remains explicit and source separated', async ({ page }) => {
  await login(page);
  await eachScreen(async s => {
    await visit(page, s);
    const empty = { 'Home/watchlist': /No eligible recommendations/, 'Stock': /No trade idea available/, 'Research': /No normalized earnings, rating, filing/, 'Trade Plan': /No plan for today yet/, Portfolio: /No open positions yet/, Activity: /No activity yet/, Analytics: /Trades 0/, RoboTrader: /No RoboTrader orders submitted yet/, 'Trading System': /No persisted strategy runs yet/ }[s.name];
    await expect(page.getByText(empty).first()).toBeVisible();
  });
  expect(h.provider.state.posts).toHaveLength(0);
});

test('core screen valid broker records never enter simulator performance', async ({ page, context }) => {
  await h.control({ patch: { trend: true } });
  await login(page);
  const order = await context.request.post(h.baseURL + '/api/paper-trades/order', { headers: { origin: h.baseURL, 'Idempotency-Key': 'screen-valid-order' }, data: { symbol: 'AAPL', side: 'buy', qty: 2, orderType: 'limit', limitPrice: 100 } });
  expect(order.status()).toBe(200);
  await h.control({ fill: { id: h.provider.state.orders[0].id, qty: 2 } });
  await h.run('reconcile');
  const fills = await (await context.request.get(h.baseURL + '/api/paper-trades/trades')).json();
  expect(fills).toHaveLength(1);
  expect(fills[0]).toMatchObject({ symbol: 'AAPL', qty: 2, executionSource: 'alpaca-paper' });
  const generatedPlan = await context.request.post(h.baseURL + '/api/trade-plan/generate', { headers: { origin: h.baseURL } });
  expect(generatedPlan.status()).toBe(200);
  expect((await generatedPlan.json()).plan._id).toBeTruthy();
  const backtest = await context.request.post(h.baseURL + '/api/backtest', { headers: { origin: h.baseURL }, data: { symbol: 'AAPL', strategyId: 'SMA_CROSS' } });
  expect(backtest.status()).toBe(200);
  expect((await backtest.json()).executionSource).toBe('historical-simulation');
  // Real persisted simulator fixtures coexist with broker fills in this isolated database.
  const PaperTrade = require('../../backend/models/PaperTrade');
  const PaperEquity = require('../../backend/models/PaperEquity');
  const PaperSettings = require('../../backend/models/PaperSettings');
  await PaperSettings.findOneAndUpdate({ accountId: 'user:acceptance-owner' }, { startingCash: 50000 }, { upsert: true });
  await PaperTrade.create({ accountId: 'user:acceptance-owner', broker: 'paper', symbol: 'SIMONLY', side: 'sell', qty: 1, price: 777, notional: 777, realizedPnl: 777 });
  await PaperEquity.create([
    { accountId: 'user:acceptance-owner', executionSource: 'local-simulation', equity: 50777, cash: 50777, positionsValue: 0, dailyPnl: 777, totalPnl: 777 },
    { accountId: 'user:acceptance-owner', executionSource: 'alpaca-paper', equity: 999999, cash: 999999, positionsValue: 0, dailyPnl: 999999, totalPnl: 999999 }
  ]);
  const summary = await (await context.request.get(h.baseURL + '/api/analytics/summary')).json();
  expect(summary.executionSource).toBe('local-simulation');
  expect(summary.tradeCount).toBe(1);
  expect(summary.totalPnl).toBe(777);
  expect(summary.equityCurve.every(row => row.executionSource === 'local-simulation')).toBe(true);
  expect(summary.equityCurve.some(row => row.equity === 50777)).toBe(true);
  const brokerCurve = await (await context.request.get(h.baseURL + '/api/paper-trades/equity')).json();
  expect(brokerCurve).toHaveLength(1);
  expect(brokerCurve[0]).toMatchObject({ executionSource: 'alpaca-paper', equity: 10000 });
  await eachScreen(async s => {
    await visit(page, s);
    if (s.name === 'Portfolio') { await expect(page.getByRole('button', { name: 'Review close AAPL' })).toBeVisible(); await expect(page.getByText('$9800.00', { exact: true })).toBeVisible(); await expect(page.getByText('SIMONLY')).toHaveCount(0); }
    if (s.name === 'Activity') { await expect(page.getByText(/Filled 2 of 2 requested shares/)).toBeVisible(); await expect(page.getByText(/Alpaca paper · fill/)).toBeVisible(); }
    if (s.name === 'Activity') await expect(page.getByText('SIMONLY')).toHaveCount(0);
    if (s.name === 'Trade Plan') { await expect(page.getByText('Ranked Strategies', { exact: true })).toBeVisible(); await expect(page.getByText(/No plan for today yet/)).toHaveCount(0); }
    if (s.name === 'Analytics') { await expect(page.getByText('Trades 1', { exact: true })).toBeVisible(); await expect(page.getByText('$777', { exact: true }).first()).toBeVisible(); }
    if (s.name === 'Trading System') await expect(page.getByText('backtest', { exact: true }).first()).toBeVisible();
  });
  expect(h.provider.state.posts).toHaveLength(1);
});

test('each core screen exposes a loading state before its actual data response', async ({ page, context }) => {
  await login(page);
  await page.addInitScript(() => {
    window.__observedScreenLoading = false;
    new MutationObserver(() => {
      if ([...document.querySelectorAll('main .animate-pulse')].some(element => element.getClientRects().length)) window.__observedScreenLoading = true;
    }).observe(document, { childList: true, subtree: true, attributes: true });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 450, downloadThroughput: -1, uploadThroughput: -1 });
  await eachScreen(async s => {
    await page.goto(h.baseURL + s.path, { waitUntil: 'commit' });
    await expect.poll(() => page.evaluate(() => window.__observedScreenLoading)).toBe(true);
    await expect(page.getByRole('heading', { name: s.heading, exact: typeof s.heading === 'string' })).toBeVisible();
    await s.ready(page);
  });
});

test('all core screens reject expired authentic sessions without showing cached private data', async ({ page }) => {
  await login(page);
  await h.advanceServerClock(3601000);
  await eachScreen(async s => {
    await page.goto(h.baseURL + s.path, { waitUntil: 'domcontentloaded' }).catch(error => { if (!error.message.includes('ERR_ABORTED')) throw error; });
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Log In', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: s.heading, exact: typeof s.heading === 'string' })).toHaveCount(0);
  });
});

test('all core screens show backend unavailable rather than false logout or fabricated data', async ({ page }) => {
  await login(page);
  const exited = new Promise(resolve => h.child.once('exit', resolve));
  h.child.kill('SIGTERM');
  await exited;
  await eachScreen(async s => {
    await page.goto(h.baseURL + s.path);
    await expect(page.getByText('Session service unavailable', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry session', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: s.heading, exact: typeof s.heading === 'string' })).toHaveCount(0);
    await expect(page).toHaveURL(h.baseURL + s.path);
  });
});

test('provider outage is explicit while persisted simulator and plan screens stay source honest', async ({ page }) => {
  await h.control({ patch: { unavailable: true } });
  await login(page);
  await eachScreen(async s => {
    await page.goto(h.baseURL + s.path);
    await expect(page.getByText('Market status unavailable', { exact: true }).first()).toBeVisible();
    if (['Stock', 'Portfolio', 'Activity'].includes(s.name)) {
      await expect(page.locator('main').getByRole('button', { name: 'Retry', exact: true }).first()).toBeVisible();
      await expect(page.getByRole('heading', { name: s.heading, exact: typeof s.heading === 'string' })).toHaveCount(0);
    } else if (s.name === 'Home/watchlist') {
      await expect(page.locator('main').getByText(/unavailable|Could not|failed|fetch/i).first()).toBeVisible();
    } else if (s.name === 'Research') {
      await expect(page.locator('main').getByText(/Data Quality|unavailable|stale/i).first()).toBeVisible();
    } else if (s.name === 'RoboTrader') {
      await expect(page.locator('main').getByText(/unavailable|failed|not checked/i).first()).toBeVisible();
    } else {
      await expect(page.getByRole('heading', { name: s.heading, exact: true })).toBeVisible();
      await s.ready(page);
    }
  });
  expect(h.provider.state.posts).toHaveLength(0);
});

for (const condition of ['emptyMarketData', 'staleMarketData']) {
  test(`${condition}: all core screens preserve source and expose unavailable research context`, async ({ page }) => {
    await h.control({ patch: { [condition]: true } });
    await login(page);
    await eachScreen(async s => {
      await visit(page, s);
      if (s.name === 'Research') {
        const details = page.locator('summary').filter({ hasText: /additional freshness warnings/ });
        if (await details.count()) await details.click();
        await expect(page.getByText(condition === 'emptyMarketData' ? /Daily bar history is unavailable/ : /Intraday bars appear stale/).first()).toBeVisible();
      }
      if (s.name === 'Home/watchlist') { await expect(page.getByText(/No eligible recommendations/)).toBeVisible(); await expect(page.getByText(condition === 'emptyMarketData' ? 'Quote unavailable' : /Stale quote/).first()).toBeVisible(); }
      if (s.name === 'Portfolio') await expect(page.getByText(/No open positions yet/)).toBeVisible();
      if (s.name === 'Activity') await expect(page.getByText(/No activity yet/)).toBeVisible();
      if (s.name === 'Analytics') await expect(page.getByText('Trades 0', { exact: true })).toBeVisible();
      if (s.name === 'Stock') { await expect(page.getByText(/No trade idea available/)).toBeVisible(); await expect(page.getByTestId('stock-price-freshness')).toContainText(condition === 'emptyMarketData' ? 'Price history unavailable' : 'Stale price history'); }
      if (s.name === 'Trade Plan') await expect(page.getByText(/No plan for today yet/)).toBeVisible();
      if (s.name === 'RoboTrader') await expect(page.getByText(/No RoboTrader orders submitted yet/)).toBeVisible();
      if (s.name === 'Trading System') await expect(page.getByText(/No persisted strategy runs yet/)).toBeVisible();
    });
    expect(h.provider.state.posts).toHaveLength(0);
  });
}

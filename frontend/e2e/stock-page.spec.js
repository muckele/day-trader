const { test, expect } = require('@playwright/test');

function buildIntradayBars() {
  return [
    { time: '2026-02-26T14:30:00.000Z', open: 271, high: 272, low: 270.8, close: 271.8, volume: 1000 },
    { time: '2026-02-26T14:35:00.000Z', open: 271.8, high: 272.2, low: 271.5, close: 272.1, volume: 900 },
    { time: '2026-02-26T14:40:00.000Z', open: 272.1, high: 272.4, low: 271.9, close: 272.3, volume: 1100 }
  ];
}

function buildHistoricalBars() {
  return [
    { date: '2026-02-24', close: 269.9 },
    { date: '2026-02-25', close: 271.7 },
    { date: '2026-02-26', close: 272.3 }
  ];
}

async function mockApiForStockFlow(page, {
  analyzePayload,
  recommendationBySymbolPayload
}) {
  await page.route('**/api/**', async route => {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());
    const path = url.pathname;

    const reply = body => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body)
    });

    if (method === 'GET' && path === '/api/market/status') {
      return reply({
        status: 'OPEN',
        nextOpen: null,
        nextClose: '2026-02-26T21:00:00.000Z'
      });
    }

    if (method === 'GET' && path === '/api/watchlist/default') {
      return reply([
        { symbol: 'AAPL', name: 'Apple' },
        { symbol: 'MSFT', name: 'Microsoft' }
      ]);
    }

    if (method === 'POST' && path === '/api/market/quotes') {
      return reply([
        { symbol: 'AAPL', price: 272.3, change: 1.4, changePercent: 0.52 },
        { symbol: 'MSFT', price: 418.2, change: -0.9, changePercent: -0.21 }
      ]);
    }

    if (method === 'POST' && path === '/api/market/sparkline') {
      const body = req.postDataJSON() || {};
      if (body.symbol === 'AAPL') {
        return reply([{ price: 270.5 }, { price: 271.4 }, { price: 272.3 }]);
      }
      return reply([{ price: 419.2 }, { price: 418.9 }, { price: 418.2 }]);
    }

    if (method === 'GET' && path === '/api/recommendations') {
      return reply({
        asOf: '2026-02-26T20:00:00.000Z',
        marketStatus: 'OPEN',
        nextOpen: null,
        nextClose: '2026-02-26T21:00:00.000Z',
        recommendations: [
          {
            ticker: 'AAPL',
            bias: 'LONG',
            entry: { price: 271.8 },
            risk: { stop: 268.5, takeProfit: [277.2], timeHorizon: '2-5d', positionSizePct: 3 },
            rationale: ['Momentum expansion with healthy breadth'],
            qualityGate: { passed: true, blockedReasons: [] },
            score: { label: 'A', value: 83 }
          }
        ]
      });
    }

    if (method === 'GET' && path === '/api/market/intraday/AAPL') {
      return reply(buildIntradayBars());
    }

    if (method === 'GET' && path === '/api/market/historical/AAPL') {
      return reply(buildHistoricalBars());
    }

    if (method === 'GET' && path === '/api/company/AAPL') {
      return reply({
        company: { symbol: 'AAPL', name: 'Apple Inc.' },
        stats: { marketcap: 3_000_000_000_000, peRatio: 30.2, dividendYield: 0.5, employees: 161000 }
      });
    }

    if (method === 'GET' && path === '/api/recommendations/AAPL') {
      return reply(recommendationBySymbolPayload);
    }

    if (method === 'GET' && path === '/api/paper-trades/settings') {
      return reply({ slippageBps: 10, commission: 0 });
    }

    if (method === 'GET' && path === '/api/paper-trades/account') {
      return reply({ equity: 100000, cash: 100000, positionsValue: 0, positions: [], totalPnl: 0, dailyPnl: 0 });
    }

    if (method === 'GET' && path === '/api/analyze/AAPL') {
      return reply(analyzePayload);
    }

    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: `Unhandled mock for ${method} ${path}` })
    });
  });
}

test.describe('Watchlist To Stock Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('token', 'playwright-e2e-token');
    });
  });

  test('clicking watchlist symbol loads Stock page content', async ({ page }) => {
    await mockApiForStockFlow(page, {
      analyzePayload: {
        ok: true,
        analysis: {
          setup: { setupType: 'TREND_PULLBACK', bias: 'LONG', confidenceScore: 78 },
          levels: { entry: 272.3, stop: 268.5, target: 277.2 },
          qualityGate: { passed: true, reasons: [] }
        }
      },
      recommendationBySymbolPayload: {
        asOf: '2026-02-26T20:00:00.000Z',
        marketStatus: 'OPEN',
        recommendations: [
          {
            ticker: 'AAPL',
            bias: 'LONG',
            entry: { price: 271.8 },
            risk: { stop: 268.5, takeProfit: [277.2], timeHorizon: '2-5d', positionSizePct: 3 },
            rationale: ['Momentum expansion with healthy breadth'],
            qualityGate: { passed: true, blockedReasons: [], liquidityScore: 82, volatilityScore: 71 },
            regime: { trendChop: 'TREND', vol: 'NORMAL', risk: 'RISK_ON' },
            disclaimer: 'Educational purposes only.'
          }
        ]
      }
    });

    await page.goto('/watchlist');
    await page.getByText('Apple').first().click();

    await expect(page).toHaveURL(/\/stock\/AAPL$/);
    await expect(page.getByRole('heading', { name: /Apple Inc\./i })).toBeVisible();
    await expect(page.getByText('Deterministic Analysis')).toBeVisible();
    await expect(page.getByText(/TREND_PULLBACK/i)).toBeVisible();
    await expect(page.getByText('Market Cap')).toBeVisible();
    await expect(page.getByLabel('SMA 20')).toBeVisible();
  });

  test('Stock page still renders when analyze/recommendation data is unavailable', async ({ page }) => {
    await mockApiForStockFlow(page, {
      analyzePayload: {
        ok: false,
        error: 'AI_UNAVAILABLE',
        message: 'AI temporarily unavailable',
        analysis: null
      },
      recommendationBySymbolPayload: {
        asOf: '2026-02-26T20:00:00.000Z',
        marketStatus: 'OPEN',
        recommendations: [],
        warning: 'DATA_UNAVAILABLE',
        message: 'Could not fetch daily bars'
      }
    });

    await page.goto('/watchlist');
    await page.getByText('Apple').first().click();

    await expect(page).toHaveURL(/\/stock\/AAPL$/);
    await expect(page.getByRole('heading', { name: /Apple Inc\./i })).toBeVisible();
    await expect(page.getByText('Market Cap')).toBeVisible();
    await expect(page.getByText('AI temporarily unavailable')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.getByText('No trade idea available.')).toBeVisible();
    await expect(page.getByText('Failed to fetch company info')).toHaveCount(0);
  });
});

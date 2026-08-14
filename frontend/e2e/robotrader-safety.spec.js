const { test, expect } = require('@playwright/test');

const settings = {
  isEnabled: true,
  mode: 'paper',
  liveTradingExplicitlyEnabled: false,
  allowedAssetClasses: ['stocks'],
  allowedSymbols: ['AAPL'],
  blockedSymbols: [],
  maxTradeAmount: 100,
  maxPositionSize: 250,
  maxDailyLoss: 50,
  maxOpenPositions: 1,
  maxTradesPerDay: 1,
  allowShortSelling: false,
  allowFractionalShares: true,
  allowExtendedHours: false,
  allowOptionsTrading: false,
  allowCryptoTrading: false,
  riskLevel: 'conservative',
  activeStrategyId: 'ROBO_TREND_FOLLOWING_V1',
  activeParameterVersionId: 'parameter-aapl-v1'
};

async function mockRoboTraderApi(page) {
  let paperSubmits = 0;
  let reconciliations = 0;
  let emergencyStops = 0;
  const unhandled = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const reply = (body, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body)
    });

    if (method === 'GET' && path === '/api/me') {
      return reply({ user: { id: 'operator-1', username: 'operator' }, databaseAvailable: true });
    }
    if (method === 'GET' && path === '/api/market/status') {
      return reply({ marketStatus: 'OPEN', isOpen: true, source: 'test-clock' });
    }
    if (path === '/api/robotrader/settings') {
      return reply({ settings });
    }
    if (method === 'GET' && path === '/api/robotrader/decisions') return reply({ decisions: [] });
    if (method === 'GET' && path === '/api/robotrader/orders') return reply({ orders: [] });
    if (method === 'GET' && path === '/api/robotrader/performance') return reply({ summary: {} });
    if (method === 'GET' && path === '/api/robotrader/audit') return reply({ events: [] });
    if (method === 'GET' && path === '/api/robotrader/health') {
      return reply({
        mongo: { connected: true, status: 'connected', name: 'fake-broker-test' },
        alpaca: { paper: { connected: true, accountStatus: 'ACTIVE', buyingPower: 100000 } },
        scheduler: { phase1WorkerEnabled: true, lastTickAt: '2026-07-20T12:00:00.000Z' },
        reconciliation: { latestDiscrepancy: null, lastReconciledAt: '2026-07-20T12:00:00.000Z' }
      });
    }
    if (method === 'GET' && path === '/api/robotrader/reconciliation-status') {
      return reply({ summary: { discrepancyCount: 0 }, latest: [] });
    }
    if (method === 'GET' && path === '/api/robotrader/exposure') return reply({ latest: null, snapshots: [] });
    if (method === 'GET' && path === '/api/robotrader/readiness') {
      return reply({
        technicalReady: true,
        status: 'ready_for_go_no_go',
        gates: [{ key: 'single_broker_operator', label: 'Exactly one broker operator is configured', passed: true, detail: 'Configured.' }],
        observation: { runs: 20, minShadowRuns: 20, distinctDays: 7, minShadowDays: 7 },
        safeguards: { deploymentLiveFlag: false, liveCredentialsConfigured: false },
        requiredEvidence: []
      });
    }
    if (method === 'GET' && path === '/api/robotrader/operational-alerts') return reply({ alerts: [] });
    if (method === 'GET' && path === '/api/robotrader/live-activation') {
      return reply({
        activation: null,
        readiness: { technicalReady: true },
        preLiveEvidence: {
          passed: false,
          symbols: ['AAPL'],
          gates: [
            { key: 'shadow_candidate_coverage', passed: true, detail: '1/1 intended symbols covered.' },
            { key: 'paper_execution_evidence', passed: false, detail: '12/20 comparable fills.' }
          ]
        },
        hardLimits: {
          maxOrderNotionalUsd: 100,
          maxDailyOrders: 1,
          maxDailyCumulativeNotionalUsd: 100,
          maxActivationHours: 24
        },
        confirmations: {}
      });
    }
    if (method === 'GET' && path === '/api/robotrader/live-promotion') {
      return reply({ assessment: { eligible: false, gates: [] }, requirements: { minimumDossiers: 3, minimumDistinctDays: 3, cooldownHours: 24 } });
    }
    if (method === 'POST' && path === '/api/robotrader/preview-paper') {
      return reply({
        preview: {
          ok: true,
          runId: 'fake-frozen-preview-1',
          environment: 'paper',
          generatedAt: '2026-08-14T16:00:00.000Z',
          decisions: [{
            symbol: 'AAPL',
            status: 'approved',
            wouldSubmit: true,
            intentId: '507f1f77bcf86cd799439011',
            orderFingerprint: 'sha256:frozen-aapl-order',
            strategyId: 'ROBO_TREND_FOLLOWING_V1',
            strategyName: 'Trend following',
            parameterVersionId: 'parameter-aapl-v1',
            confidenceScore: 80,
            rewardRiskRatio: 2,
            reasoningSummary: 'Frozen AAPL test decision.',
            recommendedOrder: { symbol: 'AAPL', side: 'buy', qty: 0.5, orderType: 'market', timeInForce: 'day' },
            riskChecks: [{ name: 'max_trade_amount', passed: true, message: 'Trade is within the $100 cap.' }],
            executionQuality: {
              approved: true,
              checks: [{ name: 'quote_fresh', passed: true, message: 'Alpaca quote is current.' }]
            },
            researchSummary: {
              dataProvenance: {
                provider: 'alpaca',
                symbol: 'AAPL',
                timestamp: '2026-08-14T15:59:55.000Z',
                ageSeconds: 5,
                environment: 'paper',
                simulated: false,
                trustedForExecution: true
              }
            }
          }]
        }
      });
    }
    if (method === 'POST' && /^\/api\/robotrader\/paper-intents\/[^/]+\/submit$/.test(path)) {
      paperSubmits += 1;
      if (!request.headers()['idempotency-key']) {
        return reply({ message: 'Missing idempotency key' }, 400);
      }
      return reply({
        ok: true,
        submitted: true,
        order: {
          _id: 'paper-order-1',
          status: 'accepted',
          clientOrderId: 'dt-robotrader-AAPL-browser-proof'
        }
      });
    }
    if (method === 'POST' && path === '/api/robotrader/reconcile') {
      reconciliations += 1;
      return reply({ result: { updatedCount: 1, discrepancyCount: 0 } });
    }
    if (method === 'POST' && path === '/api/robotrader/emergency-stop') {
      emergencyStops += 1;
      return reply({ settings: { ...settings, isEnabled: false }, canceledOrderIds: [] });
    }
    unhandled.push(`${method} ${path}`);
    return reply({ message: `Unhandled fake API route: ${method} ${path}` }, 500);
  });
  return {
    getPaperSubmits: () => paperSubmits,
    getReconciliations: () => reconciliations,
    getEmergencyStops: () => emergencyStops,
    getUnhandled: () => [...unhandled]
  };
}

test('RoboTrader keeps canary approval locked when pre-funds evidence is incomplete', async ({ page }) => {
  await mockRoboTraderApi(page);
  await page.goto('/robo');

  await expect(page.getByRole('heading', { name: 'RoboTrader', exact: true })).toBeVisible();
  await expect(page.getByText('Pre-funds evidence')).toBeVisible();
  await expect(page.getByText('12/20 comparable fills.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve Canary Snapshot' })).toBeDisabled();
  await expect(page.getByText(/controlled-live approval remains locked/i)).toBeVisible();
});

test('RoboTrader freezes, explicitly submits, and reconciles one exact paper intent', async ({ page }) => {
  const fake = await mockRoboTraderApi(page);
  await page.goto('/robo');

  await page.getByRole('button', { name: '1. Preview & Freeze' }).click();
  await expect(page.getByText(/No order was submitted/)).toBeVisible();
  await expect(page.getByText('Trusted for execution')).toBeVisible();
  await expect(page.getByText(/sha256:frozen-aapl-order/)).toBeVisible();

  await page.getByRole('button', { name: '2. Submit Exact Intent' }).click();
  await expect(page.getByText(/dt-robotrader-AAPL-browser-proof/)).toBeVisible();
  await page.getByRole('button', { name: '3. Reconcile' }).click();
  await expect(page.getByText(/Paper reconciliation complete: 1 updates, 0 discrepancies/)).toBeVisible();

  expect(fake.getPaperSubmits()).toBe(1);
  expect(fake.getReconciliations()).toBe(1);
  expect(fake.getUnhandled()).toEqual([]);
  await page.screenshot({ path: 'test-results/paper-mvp-desktop.png', fullPage: true });
});

test('RoboTrader keeps Emergency Stop accessible on a mobile viewport', async ({ page }) => {
  const fake = await mockRoboTraderApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/robo');

  const stop = page.getByRole('button', { name: 'Emergency Stop' }).first();
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(page.getByText(/Emergency stop completed/)).toBeVisible();
  expect(fake.getEmergencyStops()).toBe(1);
  expect(fake.getUnhandled()).toEqual([]);
  await page.screenshot({ path: 'test-results/paper-mvp-mobile.png', fullPage: true });
});

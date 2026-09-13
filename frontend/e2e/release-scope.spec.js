const { test, expect } = require('@playwright/test');

// UI contract fixtures only; actual authentication and persistence are verified separately.
async function fixtureApi(page, authenticated = false) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path === '/api/me') {
      if (!authenticated) return route.fulfill({ status: 401, json: { message: 'Sign in required' } });
      body = { user: { id: '507f1f77bcf86cd799439011', username: 'owner' } };
    }
    if (path === '/api/market/status') body = { status: 'CLOSED' };
    if (path === '/api/robotrader/settings') body = { settings: { mode: 'paper', isEnabled: false, allowedAssetClasses: ['stocks'], allowFractionalShares: false } };
    return route.fulfill({ status: 200, json: body });
  });
}

test('owner registration notice leads to login without public onboarding', async ({ page }) => {
  await fixtureApi(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type()) && !message.text().includes('401 (Unauthorized)')) errors.push(message.text());
  });
  await page.goto('/register');
  await expect(page).toHaveTitle('DayTrader');
  await expect(page.getByRole('heading', { name: 'Owner-only access' })).toBeVisible();
  await expect(page.getByText(/Public registration is disabled/)).toBeVisible();
  await expect(page.getByRole('button', { name: /create account/i })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/day-trader-owner-register.png' });
  await page.getByRole('link', { name: 'log in', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Log In' })).toBeVisible();
  await expect(page.getByRole('link', { name: /sign up/i })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('RoboTrader scope controls remain disabled on desktop and mobile', async ({ page }) => {
  await fixtureApi(page, true);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type()) && !message.text().includes('401 (Unauthorized)')) errors.push(message.text());
  });
  await page.goto('/robo');
  await expect(page).toHaveURL(/\/robo$/);
  await expect(page).toHaveTitle('DayTrader');
  await expect(page.getByRole('heading', { name: 'RoboTrader', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Live — unavailable' })).toBeDisabled();
  for (const name of ['Crypto', 'Options', 'Fractional Shares', 'Extended Hours', 'Short Selling', 'Crypto Trading', 'Options Trading']) {
    await expect(page.getByRole('checkbox', { name, exact: true })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
  }
  await page.getByRole('heading', { name: 'Alpaca paper trading only' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/day-trader-paper-scope-desktop.png' });
  await page.getByRole('button', { name: /save settings/i }).click();
  await expect(page.getByText('RoboTrader settings saved.')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Alpaca paper trading only' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Live — unavailable' })).toBeDisabled();
  await page.screenshot({ path: '/tmp/day-trader-paper-scope-mobile.png' });
  expect(errors).toEqual([]);
});

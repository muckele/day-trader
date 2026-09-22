const { test: base, expect } = require('../../frontend/node_modules/@playwright/test');
const { restrictBrowserContext } = require('./browser-network-only.cjs');
const test = base.extend({
  context: async ({ context }, use) => {
    await restrictBrowserContext(context);
    await use(context);
  }
});
module.exports = { test, expect };

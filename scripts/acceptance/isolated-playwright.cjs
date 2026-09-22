const { test: base, expect } = require('../../frontend/node_modules/@playwright/test');
const test = base.extend({
  context: async ({ context }, use) => {
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? route.continue() : route.abort();
    });
    await use(context);
  }
});
module.exports = { test, expect };

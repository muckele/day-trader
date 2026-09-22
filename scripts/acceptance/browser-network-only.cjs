const localBrowserArgs = ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'];
async function restrictBrowserContext(context) {
  const blocked = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue();
    blocked.push(url.origin);
    return route.abort('blockedbyclient');
  });
  return blocked;
}
module.exports = { restrictBrowserContext, localBrowserArgs };

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'frontend/package.json'));
const { chromium } = require('playwright');
const name = `pf001-${process.pid}-${Date.now()}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 });
let base, shell, js, css, browser;
before(async () => {
  // An optional immutable image exercises the final artifact without mounting replacements.
  const image = process.env.PF001_IMAGE;
  if (image) assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const pinned = readFileSync(path.join(root, 'frontend/Dockerfile'), 'utf8').match(/^FROM (nginx:\S+)$/m)[1];
  docker('network', 'create', name);
  const mounts = image ? [] : ['--mount', `type=bind,src=${root}frontend/nginx.conf,dst=/etc/nginx/conf.d/default.conf,readonly`, '--mount', `type=bind,src=${root}frontend/build,dst=/usr/share/nginx/html,readonly`];
  docker('run', '-d', '--name', name, '--network', name, '-p', '127.0.0.1::8080', ...mounts, image || pinned);
  const info = JSON.parse(docker('inspect', name))[0];
  base = `http://127.0.0.1:${info.NetworkSettings.Ports['8080/tcp'][0].HostPort}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base); if (r.status === 200) { shell = await r.text(); break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(shell, 'nginx must serve the built index');
  js = shell.match(/src="(\/static\/js\/[^"?]+\.js)"/)[1];
  css = shell.match(/href="(\/static\/css\/[^"?]+\.css)"/)[1];
});
after(async () => {
  await browser?.close();
  try { docker('rm', '-f', name); } finally { docker('network', 'rm', name); }
});
test('PF001 valid JavaScript MIME', async () => {
  const r = await fetch(base + js); assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^(application|text)\/javascript\b/);
  assert.notEqual(await r.text(), shell);
});
test('PF001 valid CSS MIME', async () => {
  const r = await fetch(base + css); assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/css\b/);
});
for (const [label, url] of [
  ['missing JavaScript', '/static/js/definitely-missing.js'],
  ['missing CSS', '/static/css/definitely-missing.css'],
  ['missing nested resource', '/static/nested/missing/resource'],
  ['query string missing JavaScript', '/static/js/definitely-missing.js?v=123'],
  ['query string missing CSS', '/static/css/definitely-missing.css?v=123']
]) test(`PF001 ${label}`, async () => {
  const r = await fetch(base + url); assert.equal(r.status, 404);
  assert.notEqual(await r.text(), shell, 'ordinary nginx error HTML is allowed, SPA fallback is not');
});
test('PF001 application deep and dotted routes', async () => {
  for (const url of ['/portfolio/deep/link', '/owner/example.name']) {
    const r = await fetch(base + url); assert.equal(r.status, 200); assert.equal(await r.text(), shell);
  }
});
test('PF001 static directories have no listing', async () => {
  for (const url of ['/static/', '/static/js/', '/static/css/']) {
    const r = await fetch(base + url); assert.ok([403, 404].includes(r.status));
    assert.doesNotMatch(await r.text(), /Index of \/static/);
  }
});
test('PF001 browser missing script onerror without parsing SPA', async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
  // Empty local document avoids executing the application or contacting its API.
  await page.route(base + '/pf001-probe', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>PF001</title>' }));
  await page.goto(base + '/pf001-probe');
  const response = page.waitForResponse(base + '/static/js/definitely-missing.js');
  const outcome = await page.evaluate(() => new Promise(resolve => {
    const script = document.createElement('script'); script.src = '/static/js/definitely-missing.js';
    script.onload = () => resolve('load'); script.onerror = () => resolve('error'); document.head.append(script);
    setTimeout(() => resolve('timeout'), 10000);
  }));
  const status = (await response).status();
  console.log(JSON.stringify({ status, outcome, uncaughtErrors: errors }));
  assert.equal(status, 404); assert.equal(outcome, 'error'); assert.deepEqual(errors, []);
  await browser.close(); browser = undefined;
});
test('PF001 nginx config and graceful shutdown', () => {
  docker('exec', name, 'nginx', '-t'); // execFileSync throws on a failed config check.
  docker('kill', '--signal=QUIT', name);
  assert.equal(docker('wait', name).trim(), '0');
  assert.equal(JSON.parse(docker('inspect', name))[0].State.Running, false);
});

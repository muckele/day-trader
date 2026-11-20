'use strict';

// This suite is intentionally guest-only. It is authored with Task 13 but must
// not run until the real B1 bootstrap, immutable appliance and owned fixture
// gates are separately approved and present.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const { chromium } = require('playwright');
const pkg = require('../../package.json');
// Task 16 (T13 I-6, m-1): the worker's own descriptor classification and status reader.
const { classifyDescriptor, socketInodeFamilies, procStatus: workerStatus } = require('../../guest/browser-worker.cjs');

const EXPECTED = pkg.acceptanceRuntime;
const FIXTURE_PATH = '/run/acceptance/task13-owned-fixture.json';

function runtimeGate() {
  assert.equal(process.env.ACCEPTANCE_TASK13_GUEST, 'B1_QUALIFIED');
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'arm64');
  assert.equal(process.getuid(), 10002);
}
function sha256(path) { return crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex'); }
function ownedFixture() {
  const stat = fs.lstatSync(FIXTURE_PATH);
  assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.nlink, 1); assert.equal(stat.uid, 0); assert.equal(stat.gid, 0);
  assert.equal(stat.mode & 0o7777, 0o444);
  const value = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  assert.deepEqual(Object.keys(value).sort(), ['allowedOrigin', 'approvalState', 'forbiddenOrigin', 'version']);
  assert.equal(value.version, 1);
  assert.equal(value.approvalState, 'OWNED_PUBLIC_FIXTURE_APPROVED');
  for (const key of ['allowedOrigin', 'forbiddenOrigin']) {
    const url = new URL(value[key]);
    assert.equal(url.protocol, 'https:'); assert.equal(url.port, '');
    assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.pathname, '/');
  }
  assert.notEqual(value.allowedOrigin, value.forbiddenOrigin);
  return Object.freeze({ allowed: value.allowedOrigin, forbidden: value.forbiddenOrigin });
}
function procStatus(pid) { return fs.readFileSync(`/proc/${pid}/status`, 'utf8'); }
// Task 16 fix round 1 (I-1): a child is filed under the thread that forked it, so every thread's
// children file is read (kernel/fork.c:2632, :2690; fs/proc/array.c:720-770).
function childPids(pid) {
  const children = [];
  for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
    const text = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'ascii').trim();
    for (const child of text ? text.split(/\s+/).map(Number) : []) if (!children.includes(child)) children.push(child);
  }
  return children;
}
function launchOptions() {
  return {
    executablePath: EXPECTED.chromium.executablePath,
    chromiumSandbox: true,
    headless: true,
    proxy: { server: 'http://127.0.0.1:3128', bypass: '' },
    ignoreDefaultArgs: ['--disable-dev-shm-usage'],
    args: ['--disable-extensions', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--enable-features=WebRtcHideLocalIpsWithMdns', '--proxy-bypass-list=<-loopback>'],
    env: {
      HOME: '/run/acceptance/browser/support',
      TMPDIR: '/run/acceptance/browser/profile',
      XDG_CACHE_HOME: '/run/acceptance/browser/cache',
    },
  };
}

test('guest_gate_and_exact_runtime_bytes', () => {
  runtimeGate();
  assert.equal(process.version, 'v' + EXPECTED.node.version);
  assert.equal(sha256(EXPECTED.node.executablePath), EXPECTED.node.executableSha256);
  assert.equal(sha256(EXPECTED.chromium.executablePath), EXPECTED.chromium.executableSha256);
  assert.equal(EXPECTED.chromium.distributionStatus, 'HOLD_PENDING_RUNTIME_QUALIFICATION');
});

test('actual_chromium_sandbox_children_and_tmpfs', async () => {
  runtimeGate();
  const browser = await chromium.launch(launchOptions());
  try {
    const roots = childPids(process.pid);
    assert.ok(roots.length > 0, 'browser family is absent');
    const family = new Set(roots), queue = [...roots];
    while (queue.length) for (const child of childPids(queue.shift())) if (!family.has(child)) { family.add(child); queue.push(child); }
    assert.ok(family.size > 1, 'Chromium descendants are absent');
    // Sockets are attributed only from /proc/net/{unix,tcp,tcp6,udp,udp6}; vsock has no table.
    const sockets = socketInodeFamilies(fs);
    for (const pid of family) {
      const status = procStatus(pid), parsed = workerStatus(fs, pid);
      assert.match(status, /^Uid:\s+10002\s+10002\s+10002\s+10002$/m);
      assert.match(status, /^Gid:\s+10002\s+10002\s+10002\s+10002$/m);
      assert.match(status, /^NoNewPrivs:\s+1$/m);
      // Seccomp mode 2 (filter) with at least the inherited filter; Chromium adds its own.
      assert.match(status, /^Seccomp:\s+2$/m);
      assert.equal(parsed.seccomp, 2);
      assert.ok(Number.isSafeInteger(parsed.seccompFilters) && parsed.seccompFilters >= 1, `${pid} Seccomp_filters ${parsed.seccompFilters}`);
      const directory = fs.opendirSync(`/proc/${pid}/fd`), kinds = [];
      try {
        for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
          let link = null;
          try { link = fs.readlinkSync(`/proc/${pid}/fd/${entry.name}`); } catch { link = null; }
          kinds.push([entry.name, link, classifyDescriptor(link, sockets)]);
        }
      } finally { directory.closeSync(); }
      for (const forbidden of ['CONSOLE', 'UNKNOWN_SOCKET', 'UNREADABLE'])
        assert.deepEqual(kinds.filter(row => row[2] === forbidden), [], `${pid} ${forbidden}`);
    }
    for (const path of ['/run/acceptance/browser/support', '/run/acceptance/browser/profile', '/run/acceptance/browser/cache', '/dev/shm']) {
      const mount = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').find(line => line.split(' ')[4] === path);
      assert.ok(mount && mount.includes(' - tmpfs '), `${path} is not tmpfs`);
    }
  } finally { await browser.close(); }
});

test('actual_context_blocks_persistence_popups_websocket_and_webtransport', async () => {
  runtimeGate();
  const fixture = ownedFixture();
  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false });
  try {
    let primary, popupClosedResolve, socketClosedResolve;
    const popupClosed = new Promise(resolve => { popupClosedResolve = resolve; });
    const socketClosed = new Promise(resolve => { socketClosedResolve = resolve; });
    context.on('page', async page => { if (!primary) primary = page; else { await page.close(); popupClosedResolve(); } });
    await context.routeWebSocket('**/*', async socket => { await socket.close(); socketClosedResolve(); });
    await context.addInitScript(() => { Object.defineProperty(globalThis, 'WebTransport', { configurable: false, value: undefined }); });
    const page = await context.newPage();
    await page.goto(fixture.allowed, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.evaluate(() => typeof WebTransport), 'undefined');
    await page.evaluate(origin => {
      window.open(origin + '?task13-popup=1', '_blank');
      const target = new URL(origin); target.protocol = 'wss:';
      new WebSocket(target.href + 'task13-websocket');
    }, fixture.allowed);
    await Promise.all([popupClosed, socketClosed]);
    assert.equal(context.pages().length, 1);
    assert.equal((await context.cookies()).some(cookie => !cookie.secure), false);
  } finally { await context.close(); await browser.close(); }
});

test('owned_fixture_proxy_positive_and_direct_negative', async () => {
  runtimeGate();
  assert.equal(process.env.ACCEPTANCE_TASK13_OWNED_FIXTURE, 'READY');
  const fixture = ownedFixture();
  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    const response = await page.goto(fixture.allowed, { waitUntil: 'domcontentloaded' });
    assert.equal(response && response.ok(), true);
    await assert.rejects(page.goto(fixture.forbidden, { waitUntil: 'commit', timeout: 5000 }));
  } finally { await context.close(); await browser.close(); }
});

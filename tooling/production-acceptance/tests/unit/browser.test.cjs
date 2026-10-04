'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const receipts = require('../../guest/receipts.cjs');
const budgetAPI = require('../../guest/budget.cjs');
const roles = require('../../guest/role-ports.cjs');
const { fixture: budgetFixture, A } = require('./budget.test.cjs');

const ROOT = path.resolve(__dirname, '../..');
const CONTROLLER = path.join(ROOT, 'guest/browser.cjs');
const WORKER = path.join(ROOT, 'guest/browser-worker.cjs');
const PACKAGE = path.join(ROOT, 'package.json');
const LOCK = path.join(ROOT, 'package-lock.json');
const RUN = '1'.repeat(32);
const KEY = '4'.repeat(64);
const FRONTEND = 'https://frontend.example.test';
const BACKEND = 'https://backend.example.test';
const PATHS = Object.freeze({
  profile: '/run/acceptance/browser/profile',
  support: '/run/acceptance/browser/support',
  cache: '/run/acceptance/browser/cache',
  shm: '/dev/shm',
});

function controller() {
  assert.equal(fs.existsSync(CONTROLLER), true, 'browser controller contract is absent');
  delete require.cache[CONTROLLER];
  return require(CONTROLLER);
}

function worker(playwright, receiptAPI, bindBrowserWorkerChannel) {
  assert.equal(fs.existsSync(WORKER), true, 'browser worker contract is absent');
  const source = fs.readFileSync(WORKER, 'utf8');
  const module = { exports: {} };
  function localRequire(name) {
    if (name === 'playwright') return playwright;
    if (name === './receipts.cjs') return receiptAPI;
    if (name === './role-ports.cjs') return { bindBrowserWorkerChannel };
    if (name === '../package.json') return JSON.parse(fs.readFileSync(PACKAGE));
    return require(name);
  }
  vm.runInNewContext(source, {
    module, exports: module.exports, require: localRequire, Buffer, TextDecoder,
    URL, setTimeout, clearTimeout, queueMicrotask,
  }, { filename: WORKER });
  return module.exports;
}

function config(api, overrides = {}) {
  return {
    runBinding: {
      runId: RUN,
      manifestIdentity: '2'.repeat(64),
      configIdentity: '3'.repeat(64),
      expiresAt: 2_000_000,
      origins: { FRONTEND, BACKEND },
    },
    runtime: JSON.parse(JSON.stringify(api.RUNTIME_PINS)),
    paths: { ...PATHS },
    assetEntries: [{ path: '/static/js/main.js', hash: 'a'.repeat(64), size: 3, mime: 'application/javascript' }],
    ...overrides,
  };
}

function trustedConfig(api, overrides = {}) {
  const runId = overrides.runId || crypto.randomBytes(16).toString('hex');
  const routeFixture = budgetFixture({ runId, configIdentity: '3'.repeat(64), assetPath: '/static/js/main.js', assetBody: Buffer.from('abc') });
  const bundle = receipts.createBrowserAssetBundle(routeFixture.release, routeFixture.assets, routeFixture.trust,
    routeFixture.releaseBytes, routeFixture.assetBytes);
  return receipts.createBrowserControllerConfig(routeFixture.release, routeFixture.assets, routeFixture.trust, bundle, {
    runtime: overrides.runtime || JSON.parse(JSON.stringify(api.RUNTIME_PINS)),
    paths: overrides.paths || { ...PATHS },
  }, compositionBinding(runId));
}

function compositionBinding(runId, overrides = {}) {
  return { version: 1, runId, manifestDigest: '2'.repeat(64), configIdentity: '3'.repeat(64),
    rolePolicyDigest: '5'.repeat(64), epoch: 1, expiresAtMs: 200, ...overrides };
}

function topology(overrides = {}) {
  return Object.freeze({
    version: 1, kind: 'TASK13_BROWSER_APPLICATION', runId: RUN, channelKeyHex: KEY, maxFrameBytes: 16384,
    uid: 10002, noNewPrivs: true, capabilities: 'EMPTY', filterInherited: true,
    procScope: 'BROWSER_FAMILY_ONLY', consoleFds: 0, vsockFds: 0,
    unexpectedFds: 0, networkDeviceCount: 0,
    tmpfsPaths: Object.freeze(['/dev/shm', PATHS.cache, PATHS.profile, PATHS.support]),
    ...overrides,
  });
}

function family(overrides = {}) {
  return Object.freeze({
    workerPid: 101,
    browserPid: 202,
    members: Object.freeze([
      Object.freeze({ pid: 101, uid: 10002, filterInherited: true, consoleFds: 0, vsockFds: 0, unexpectedFds: 0 }),
      Object.freeze({ pid: 202, uid: 10002, filterInherited: true, consoleFds: 0, vsockFds: 0, unexpectedFds: 0 }),
      Object.freeze({ pid: 203, uid: 10002, filterInherited: true, consoleFds: 0, vsockFds: 0, unexpectedFds: 0 }),
    ]),
    procScope: 'BROWSER_FAMILY_ONLY',
    ...overrides,
  });
}

function duplex(audit = topology(), inspected = family(), options = {}) {
  const logs = [];
  function endpoint(label) {
    const queued = [];
    const readers = [];
    let peer,writing=false,nextWriteGate;
    const value = {
      audit: () => audit,
      inspectBrowserFamily: () => inspected,
      async write(bytes) {
        if(options.strictWrites&&writing)throw Object.assign(new Error('FRAME_DENIED'),{code:'FRAME_DENIED'});
        writing=true;
        try {
        assert.ok(Buffer.isBuffer(bytes));
        if(nextWriteGate){const gate=nextWriteGate;nextWriteGate=null;await gate.promise;}
        if(options.strictWrites)await new Promise(resolve=>setImmediate(resolve));
        logs.push({ from: label, bytes: Buffer.from(bytes) });
        const copy = Buffer.from(bytes);
        const reader = peer.readers.shift();
        if (reader) reader(copy); else peer.queued.push(copy);
        } finally { writing=false; }
      },
      async read() {
        if (queued.length) return queued.shift();
        return new Promise(resolve => readers.push(resolve));
      },
      holdNextWrite(){if(nextWriteGate)throw new Error('write already held');let resolve;const promise=new Promise(yes=>{resolve=yes;});nextWriteGate={promise};return resolve;},
      queued, readers,
    };
    return { value, attach(other) { peer = other; } };
  }
  const controller = endpoint('controller'), worker = endpoint('worker');
  controller.attach(worker.value); worker.attach(controller.value);
  return { controller: controller.value, worker: worker.value, logs };
}

function decodedFrames(logs, from) {
  return logs.filter(row => row.from === from).map(row => JSON.parse(row.bytes.subarray(4).toString('ascii')));
}

const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
  value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
function inheritedFrame(value) {
  const body=Buffer.from(canonical(value),'ascii'),prefix=Buffer.alloc(4);prefix.writeUInt32BE(body.length);return Buffer.concat([prefix,body]);
}
function browserBootstrapFrame(binding,key,sequence,action,payload,identity) {
  const bare={version:1,binding,sequence,role:'BROWSER',childId:identity.childId,pipeId:identity.pipeId,action,payload};
  const mac=crypto.createHmac('sha256',Buffer.from(key,'hex')).update('acceptance:bootstrap-composition:v1\0BROWSER:FROM_BOOTSTRAP\0'+canonical(bare)).digest('hex');
  return inheritedFrame({...bare,mac});
}

function fakePlaywright(options = {}) {
  const calls = {
    launch: [], persistent: [], contexts: [], pages: [], selectors: [], events: [],
    websocketCloses: 0, popupCloses: 0, browserCloses: 0, contextCloses: 0,
    assetBodies: 0, routeFetches: 0,
  };
  const contextHandlers = {};
  let context;
  const page = {
    handlers: {},
    on(name, fn) { this.handlers[name] = fn; calls.events.push('page.on:' + name); },
    async goto(url, gotoOptions) {
      calls.events.push('goto:' + url);
      calls.goto = { url, options: gotoOptions };
      if (options.initialRoute) {
        let disposition;
        await calls.routeHandler({
          request: () => ({ method: () => 'GET', url: () => FRONTEND + '/',
            headers: () => ({ accept: 'text/html', 'user-agent': 'Chromium', 'sec-fetch-mode': 'navigate' }), postDataBuffer: () => null }),
          continue: async () => { disposition = 'CONTINUE'; }, abort: async () => { disposition = 'ABORT'; },
        });
        calls.initialRouteDisposition = disposition;
      }
      if (contextHandlers.response) {
        await contextHandlers.response({
          url: () => (options.assetOrigin || FRONTEND) + '/static/js/main.js',
          body: async () => { calls.assetBodies++; return Buffer.from('abc'); },
          headers: () => ({ 'content-type': 'application/javascript' }),
        });
      }
      return { ok: () => true };
    },
    async waitForLoadState() { calls.events.push('load'); },
    getByPlaceholder(name) {
      return { fill: async value => { calls.selectors.push(['placeholder', name, value]); } };
    },
    getByRole(role, options) {
      return { click: async () => { calls.selectors.push(['role', role, options]); } };
    },
    async close() { calls.popupCloses++; },
  };
  context = {
    async route(pattern, handler) { calls.events.push('route'); calls.routePattern = pattern; calls.routeHandler = handler; },
    async routeWebSocket(pattern, handler) { calls.events.push('routeWebSocket'); calls.wsPattern = pattern; calls.wsHandler = handler; },
    async addInitScript(script) { calls.events.push('addInitScript'); calls.initScripts = [...(calls.initScripts || []), script]; },
    on(name, handler) { calls.events.push('context.on:' + name); contextHandlers[name] = handler; },
    async newPage() {
      calls.events.push('newPage'); calls.pages.push(page);
      if (contextHandlers.page) await contextHandlers.page(page);
      return page;
    },
    async cookies() { return [{ name: 'daytrader_session', value: 'private-cookie', domain: 'backend.example.test', path: '/', secure: true, httpOnly: true, sameSite: 'None' }]; },
    async close() { calls.contextCloses++; if(options.contextCloseFailure)throw new Error('synthetic context close failure'); },
  };
  const browser = {
    async newContext(contextOptions) {
      calls.contexts.push(contextOptions);
      if (options.contextFailure) throw new Error('synthetic context failure');
      return context;
    },
    async close() { calls.browserCloses++; if(options.browserCloseFailure)throw new Error('synthetic browser close failure'); },
  };
  const chromium = {
    async launch(options) { calls.launch.push(options); return browser; },
    async launchPersistentContext(...args) { calls.persistent.push(args); throw new Error('persistent context forbidden'); },
  };
  return { chromium, calls, context, page, contextHandlers };
}

async function startHarness(options = {}) {
  const api = controller();
  const testRun=crypto.randomBytes(16).toString('hex');
  const fake = fakePlaywright(options.fake);
  const audit=topology({...(options.audit||{}),runId:testRun});
  const links = duplex(audit, options.family || family(), { strictWrites: options.strictWrites === true });
  const assetProofs = [];
  const launchEvents = [];
  let activationResolve,activationReject;
  const activationReady=new Promise((resolve,reject)=>{activationResolve=resolve;activationReject=reject;});
  const routeFixture = budgetFixture({ phase: options.phase || A, journal: options.journal,
    runId: testRun, configIdentity: '3'.repeat(64), assetPath: '/static/js/main.js', assetBody: Buffer.from('abc'),
    inspectBrowserEvidence: roles.inspectBrowserRequestEvidence });
  const bundle = receipts.createBrowserAssetBundle(routeFixture.release, routeFixture.assets, routeFixture.trust,
    routeFixture.releaseBytes, routeFixture.assetBytes);
  const binding = compositionBinding(testRun);
  const cfg = receipts.createBrowserControllerConfig(routeFixture.release, routeFixture.assets, routeFixture.trust, bundle,
    { runtime: JSON.parse(JSON.stringify(api.RUNTIME_PINS)), paths: { ...PATHS, ...(options.config?.paths || {}) } }, binding);
  const projected = receipts.inspectBrowserControllerConfig(cfg);
  const workerCfg = JSON.parse(JSON.stringify(projected));
  if (options.workerConfig) Object.assign(workerCfg, options.workerConfig);
  const launchContext = Object.freeze({
    channel: Object.freeze({}), expected: Object.freeze({ binding: options.expectedBinding || binding }), clock: Object.freeze({ sample: () => [160, 1000] }),
    cleanupBudget: Object.freeze({ remaining: () => 120000 }), prepareRecord: Buffer.from('synthetic-prepare'),
  });
  links.worker.launchContext = launchContext;
  const workerAPI = worker({ chromium: fake.chromium }, { ...receipts, validateAssetResponse(entry, body, contentType) {
    assetProofs.push({ entry, body: Buffer.from(body), contentType });
    return receipts.validateAssetResponse(entry, body, contentType);
  } }, async (channel, expected, clock, cleanupBudget) => {
    assert.equal(channel, launchContext.channel);
    assert.equal(expected, launchContext.expected);
    assert.equal(clock, launchContext.clock);
    assert.equal(cleanupBudget, launchContext.cleanupBudget);
    launchEvents.push('bind');
    const reservation = Object.freeze({});
    return Object.freeze({
      async prepare(record) {
        assert.equal(record, launchContext.prepareRecord);
        launchEvents.push('prepare');
        return reservation;
      },
      async commitFixedBrowserLaunch(value, launchPinnedBrowser) {
        assert.equal(value, reservation);
        assert.equal(typeof launchPinnedBrowser, 'function');
        launchEvents.push('commit');
        const before = fake.calls.launch.length;
        if (options.denyLaunch) { const error=Object.assign(new Error('synthetic guard denial'), { code: 'ACTIVATION_DENIED' });activationReject(error);throw error; }
        const pendingOwner = launchPinnedBrowser();
        assert.equal(fake.calls.launch.length, before + 1, 'Playwright launch must occur synchronously inside the guarded callback');
        let browserOwner;try{browserOwner=await pendingOwner;}catch(error){activationReject(error);throw error;}
        launchEvents.push('started');
        activationResolve();
        return Object.freeze({ status: 'STARTED', browserOwner, applicationPipe: links.worker });
      },
    });
  });
  let activations = 0, stops = 0, waits = 0;
  const grant = Object.freeze({}),handoff=Object.freeze({}),child=Object.freeze({});let waiting=true;
  const authority={
    inspectHandoff:value=>value===handoff?{kind:'BROWSER',runId:testRun,uid:10002,child,privatePipe:links.controller,waiting,confined:true}:null,
    inspectGrant:value=>value===grant?{kind:'BROWSER',runId:testRun,child,purpose:'CONFINEMENT_PROVED',session:null}:null,
    async activate(){activations++;await activationReady;waiting=false;},
    async stopOwned(owned){assert.equal(owned,child);stops++;return {status:options.stopTimeout?'TIMEOUT':'STOPPED',runId:testRun,child};},
    async waitExit(owned){assert.equal(owned,child);waits++;return {status:'EXITED',runId:testRun,child};},
  };
  const bootstrap=roles.bindRoleBootstrap(authority,testRun);bootstrap.audit(handoff);
  const rolePort=roles.adoptRole('BROWSER',handoff);
  const admissionPort=budgetAPI.createBrowserAdmissionPort(routeFixture.budget(),routeFixture.policy,routeFixture.browserRequestFromEvidence);
  const workerResult = workerAPI.runBrowserWorker(links.worker, workerCfg);
  workerResult.then(result=>{if(result?.status==='FAILED')activationReject(Object.assign(new Error(result.code),{code:result.code}));}).catch(activationReject);
  if (options.observed) Object.assign(options.observed, {
    fake, links, workerResult, stops: () => stops, waits: () => waits,
  });
  const session = await api.openBrowser(cfg, { rolePort, grant, admissionPort });
  return { api, fake, links, cfg, session, workerResult, assetProofs, decisions:routeFixture.intents, launchEvents,runId:testRun,
    activations: () => activations, stops: () => stops, waits: () => waits };
}

async function closeHarness(h) {
  const result = await h.session.close();
  const workerExit = await h.workerResult;
  return { result, workerExit };
}

test('no_bootstrap_proof_no_launch', async () => {
  const api = controller();
  let activated = 0;
  await assert.rejects(api.openBrowser(trustedConfig(api), {
    rolePort: { async activateOnce() { activated++; } }, grant: null,
    admissionPort: Object.freeze({}),
  }), { code: 'BOOTSTRAP_REQUIRED' });
  assert.equal(activated, 0);
});

test('inherited_entry_uses_only_fd3_fd4_and_malformed_init_never_launches', async () => {
  const fake = fakePlaywright(), workerAPI = worker({ chromium: fake.chromium }, receipts, async () => assert.fail('binding must not start'));
  const body = Buffer.from('{}', 'ascii'), prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
  const input = Buffer.concat([prefix, body]); const output = []; const closed = [];
  const fsBinding = {
    writeSync(fd, bytes, start, length) { assert.equal(fd, 4); output.push(Buffer.from(bytes.subarray(start, start + length))); return length; },
    closeSync(fd) { closed.push(fd); },
  };
  const reader={read:async()=>input,drain:()=>[],close(){}};
  assert.equal(await workerAPI.inheritedMain(['--inherited'], { fs: fsBinding,reader,platform: 'linux', arch: 'arm64', uid: 10002 }), 1);
  assert.equal(Buffer.concat(output).toString('ascii'), 'WAITING\n');
  assert.deepEqual(closed, [3, 4]);
  assert.equal(fake.calls.launch.length, 0);
  assert.equal(await workerAPI.inheritedMain([], { fs: fsBinding, platform: 'linux', arch: 'arm64', uid: 10002 }), 64);
});

test('valid_inherited_protocol_transports_config_but_denies_at_unavailable_native_fence', async () => {
  const api=controller(),fake=fakePlaywright(),runId=crypto.randomBytes(16).toString('hex'),key='6'.repeat(64);
  const binding=compositionBinding(runId),identity={childId:'7'.repeat(32),pipeId:'8'.repeat(32)};
  const routeFixture=budgetFixture({runId,configIdentity:binding.configIdentity,assetPath:'/static/js/main.js',assetBody:Buffer.from('abc')});
  const bundle=receipts.createBrowserAssetBundle(routeFixture.release,routeFixture.assets,routeFixture.trust,routeFixture.releaseBytes,routeFixture.assetBytes);
  const configValue=receipts.inspectBrowserControllerConfig(receipts.createBrowserControllerConfig(routeFixture.release,routeFixture.assets,routeFixture.trust,bundle,
    {runtime:JSON.parse(JSON.stringify(api.RUNTIME_PINS)),paths:{...PATHS}},binding));
  const init=inheritedFrame({version:1,kind:'BROWSER_WORKER_INIT',binding,role:'BROWSER',...identity,channelKeyHex:key});
  const proof={proofDigest:'9'.repeat(64),generation:1,expiresAtMs:190,monotonicDeadlineMs:9000},grantId='a'.repeat(32),commitId='b'.repeat(32);
  const prepare=browserBootstrapFrame(binding,key,1,'PREPARE',{grantId,...proof,browserConfig:configValue},identity);
  const queued=[init,prepare],waiters=[],outputFrames=[],closed=[];
  const deliver=bytes=>{const waiter=waiters.shift();if(waiter)waiter(bytes);else queued.push(bytes);};
  const reader={read:async()=>queued.length?queued.shift():new Promise(resolve=>waiters.push(resolve)),drain:()=>queued.splice(0),close(){}};
  const fsBinding={
    writeSync(fd,bytes,start,length){assert.equal(fd,4);const value=Buffer.from(bytes.subarray(start,start+length));
      if(value.toString('ascii')!=='WAITING\n'){const frame=JSON.parse(value.subarray(4).toString('ascii'));outputFrames.push(frame);
        if(frame.action==='PREPARED')setImmediate(()=>deliver(browserBootstrapFrame(binding,key,2,'COMMIT',{grantId,reservationId:frame.payload.reservationId,commitId,generation:1},identity)));
        if(frame.action==='REFRESH')setImmediate(()=>deliver(browserBootstrapFrame(binding,key,3,'CURRENT',{requestSequence:frame.sequence,grantId,reservationId:frame.payload.reservationId,commitId,generation:1,...proof,
          eventCheckpoint:{binding,generation:1,sequence:1,sourceIdentity:'c'.repeat(32),lostCount:0}},identity)));
      }return length;},
    closeSync(fd){closed.push(fd);},
    readlinkSync(path){const fd=path.split('/').pop();return fd==='3'?'pipe:[3]':fd==='4'?'pipe:[4]':'/dev/null';},
    readdirSync(){return ['0','1','2','3','4'];},
    readFileSync(path){if(path==='/proc/self/status')return 'Uid:\t10002\t10002\t10002\t10002\nNoNewPrivs:\t1\nSeccomp:\t2\nCapEff:\t0000000000000000\n';
      if(path==='/proc/net/dev')return 'Inter-| Receive | Transmit\n face |bytes\n lo: 0\n';
      if(path==='/proc/self/mountinfo')return '36 25 0:32 / / rw,nosuid - tmpfs tmpfs rw\n';throw new Error('unexpected read '+path);},
  };
  let bindCalls=0,bindError;
  const workerAPI=worker({chromium:fake.chromium},receipts,async(...args)=>{bindCalls++;try{return await roles.bindBrowserWorkerChannel(...args);}catch(error){bindError=error;throw error;}});
  assert.equal(await workerAPI.inheritedMain(['--inherited'],{fs:fsBinding,reader,clock:{sample:()=>[160,1000]},platform:'linux',arch:'arm64',uid:10002}),1);
  assert.equal(fake.calls.launch.length,0);
  assert.equal(bindCalls,1,bindError?.code);
  assert.equal(bindError,undefined,bindError?.code);
  assert.equal(outputFrames.some(frame=>frame.action==='STARTED'),false);
  assert.equal(outputFrames.some(frame=>frame.action==='FAILED'),true,JSON.stringify(outputFrames));
  assert.deepEqual(closed,[3,4]);
});

test('worker_local_guard_commits_the_only_playwright_launch', async () => {
  const h = await startHarness();
  assert.deepEqual(h.launchEvents, ['bind', 'prepare', 'commit', 'started']);
  assert.equal(h.fake.calls.launch.length, 1);
  await closeHarness(h);
});

test('initial_navigation_route_is_decided_before_assets_and_ready', async () => {
  const h = await startHarness({ fake: { initialRoute: true } });
  assert.ok(['CONTINUE', 'ABORT'].includes(h.fake.calls.initialRouteDisposition));
  const frames = decodedFrames(h.links.logs, 'worker');
  assert.deepEqual(frames.slice(0, 3).map(frame => frame.type), ['ROUTE', 'ASSETS', 'READY']);
  assert.equal(decodedFrames(h.links.logs, 'controller')[0].type, 'DECISION');
  await closeHarness(h);
});

test('worker_local_guard_denial_never_launches', async () => {
  const observed = {};
  await assert.rejects(startHarness({ denyLaunch: true, observed }), { code: 'ACTIVATION_DENIED' });
  assert.equal(observed.fake.calls.launch.length, 0);
  assert.equal(observed.stops(), 1);
});

test('sandbox_enabled_no_no_sandbox', async () => {
  const h = await startHarness();
  assert.equal(h.activations(), 1);
  assert.equal(h.fake.calls.launch.length, 1);
  const launch = h.fake.calls.launch[0];
  assert.equal(launch.chromiumSandbox, true);
  assert.equal(launch.executablePath, h.api.RUNTIME_PINS.chromium.executablePath);
  assert.equal(launch.args.includes('--no-sandbox'), false);
  await closeHarness(h);
});

test('one_nonpersistent_context', async () => {
  const h = await startHarness();
  assert.equal(h.fake.calls.persistent.length, 0);
  assert.equal(h.fake.calls.contexts.length, 1);
  assert.equal(h.fake.calls.pages.length, 1);
  assert.equal(Object.hasOwn(h.fake.calls.contexts[0], 'storageState'), false);
  await closeHarness(h);
});

test('SW_registration_and_fetch_blocked_extensions_downloads_capture_disabled', async () => {
  const h = await startHarness();
  const launch = h.fake.calls.launch[0], context = h.fake.calls.contexts[0];
  assert.equal(context.serviceWorkers, 'block');
  assert.equal(context.acceptDownloads, false);
  for (const key of ['recordHar', 'recordVideo']) assert.equal(Object.hasOwn(context, key), false);
  assert.ok(launch.args.includes('--disable-extensions'));
  assert.equal(h.fake.calls.assetBodies, 1);
  assert.equal(h.assetProofs.length, 1);
  assert.deepEqual([...h.assetProofs[0].body], [...Buffer.from('abc')]);
  assert.equal(h.fake.calls.routeFetches, 0);
  const workerFrames = decodedFrames(h.links.logs, 'worker');
  assert.deepEqual(workerFrames.slice(0, 2).map(frame => frame.type), ['ASSETS', 'READY']);
  assert.deepEqual(workerFrames[0].payload.proofs, [{
    entryId: 'frontend-asset:/static/js/main.js', hash: crypto.createHash('sha256').update('abc').digest('hex'),
    sizeMatch: true, hashMatch: true, mimeMatch: true,
  }]);
  await closeHarness(h);
});

test('all_required_asset_proofs_precede_ready', async () => {
  const observed = {};
  const assets = [
    { path: '/static/js/main.js', hash: 'a'.repeat(64), size: 3, mime: 'application/javascript' },
    { path: '/static/js/missing.js', hash: 'b'.repeat(64), size: 3, mime: 'application/javascript' },
  ];
  await assert.rejects(startHarness({ workerConfig: { assetEntries: assets }, observed }), { code: 'ACTIVATION_DENIED' });
  assert.equal(observed.fake.calls.contextCloses, 0);
  assert.equal(observed.fake.calls.browserCloses, 0);
  assert.equal(observed.stops(), 1);
});

test('asset_proof_requires_the_exact_frontend_origin', async () => {
  const observed = {};
  await assert.rejects(startHarness({ fake: { assetOrigin: BACKEND }, observed }), { code: 'OBSERVATION_FAILED' });
  assert.equal(observed.fake.calls.contextCloses, 1);
  assert.equal(observed.fake.calls.browserCloses, 1);
  assert.equal(observed.stops(), 1);
});

test('partial_launch_failure_closes_browser_and_original_role', async () => {
  const observed = {};
  await assert.rejects(startHarness({ fake: { contextFailure: true }, observed }), { code: 'ACTIVATION_DENIED' });
  assert.equal(observed.fake.calls.browserCloses, 1);
  assert.equal(observed.stops(), 1);
});

test('browser_owner_retains_both_cleanup_obligations_when_one_close_fails',async()=>{
  const h=await startHarness({fake:{contextCloseFailure:true}});
  await assert.rejects(h.session.close(),Error);
  await h.workerResult;
  assert.equal(h.fake.calls.contextCloses,1);
  assert.equal(h.fake.calls.browserCloses,1);
  assert.equal(h.stops(),1);
});
test('browser_exit_never_hides_original_role_cleanup_timeout',async()=>{
  const h=await startHarness({stopTimeout:true});
  const outcomes=await Promise.allSettled([h.session.close(),h.session.close()]);
  assert.deepEqual(outcomes.map(value=>[value.status,value.reason?.code]),[
    ['rejected','CLEANUP_UNCERTAIN'],['rejected','CLEANUP_UNCERTAIN'],
  ]);
  assert.equal((await h.workerResult).status,'EXITED');assert.equal(h.stops(),1);
});

test('popup_new_page_and_WebSocket_WebTransport_rejected_before_forward', async () => {
  const h = await startHarness();
  const events = h.fake.calls.events;
  assert.ok(events.indexOf('routeWebSocket') < events.indexOf('newPage'));
  assert.ok(events.indexOf('addInitScript') < events.indexOf('newPage'));
  const popup = { close: async () => { h.fake.calls.popupCloses++; } };
  await h.fake.contextHandlers.page(popup);
  let aborts = 0;
  await h.fake.calls.routeHandler({
    request: () => ({
      method: () => 'GET', url: () => FRONTEND + '/popup', headers: () => ({}), postDataBuffer: () => null,
      frame: () => ({ page: () => popup }),
    }),
    continue: async () => assert.fail('popup request forwarded'),
    abort: async () => { aborts++; },
  });
  await h.fake.calls.wsHandler({ close: async () => { h.fake.calls.websocketCloses++; } });
  assert.equal(h.fake.calls.popupCloses, 1);
  assert.equal(aborts, 1);
  assert.equal(h.decisions.length, 0);
  assert.equal(h.fake.calls.websocketCloses, 1);
  assert.match(h.fake.calls.initScripts.map(String).join('\n'), /WebTransport/);
  await closeHarness(h);
});

test('QUIC_WebRTC_nonproxy_disabled', async () => {
  const h = await startHarness();
  const args = h.fake.calls.launch[0].args;
  assert.ok(args.includes('--disable-quic'));
  assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  assert.ok(args.some(value => value.includes('WebRtcHideLocalIpsWithMdns')));
  await closeHarness(h);
});

test('ignoreHTTPSErrors_false_no_customCA', async () => {
  const h = await startHarness();
  const launch = h.fake.calls.launch[0], context = h.fake.calls.contexts[0];
  assert.equal(context.ignoreHTTPSErrors, false);
  assert.equal(Object.hasOwn(context, 'clientCertificates'), false);
  assert.equal(Object.hasOwn(launch.env, 'NODE_EXTRA_CA_CERTS'), false);
  assert.equal(Object.hasOwn(launch.env, 'SSL_CERT_FILE'), false);
  await closeHarness(h);
});

test('guest_proxy_no_DIRECT', async () => {
  const h = await startHarness();
  const launch = h.fake.calls.launch[0];
  assert.deepEqual(JSON.parse(JSON.stringify(launch.proxy)), { server: 'http://127.0.0.1:3128', bypass: '' });
  assert.ok(launch.args.includes('--proxy-bypass-list=<-loopback>'));
  assert.equal(launch.args.some(arg => /direct|no-proxy-server/i.test(arg)), false);
  await closeHarness(h);
});

test('profile_support_shm_tmpfs', async () => {
  const h = await startHarness();
  const launch = h.fake.calls.launch[0];
  assert.equal(launch.env.HOME, PATHS.support);
  assert.equal(launch.env.TMPDIR, PATHS.profile);
  assert.equal(launch.env.XDG_CACHE_HOME, PATHS.cache);
  assert.deepEqual([...launch.ignoreDefaultArgs], ['--disable-dev-shm-usage']);
  assert.equal(launch.args.some(arg => arg.startsWith('--user-data-dir')), false);
  await closeHarness(h);
  await assert.rejects(startHarness({ audit: topology({ tmpfsPaths: Object.freeze(['/dev/shm']) }) }), { code: 'ACTIVATION_DENIED' });
});

test('inherited_filter_all_children', async () => {
  const h = await startHarness();
  assert.equal(h.fake.calls.launch.length, 1);
  await closeHarness(h);
  const observed={};const bad = startHarness({ observed,family: family({ members: Object.freeze([
    Object.freeze({ pid: 101, uid: 10002, filterInherited: true, consoleFds: 0, vsockFds: 0, unexpectedFds: 0 }),
    Object.freeze({ pid: 202, uid: 10002, filterInherited: false, consoleFds: 0, vsockFds: 0, unexpectedFds: 0 }),
  ]) }) });
  await assert.rejects(bad, { code: 'ROLE_INVALID' });
  assert.equal(observed.fake.calls.contextCloses,1);assert.equal(observed.fake.calls.browserCloses,1);
});

test('browser_pid_uid_proc_console_inventory', async () => {
  const h = await startHarness();
  await closeHarness(h);
  for (const altered of [
    { browserPid: 0 }, { procScope: 'HOST' },
    { members: Object.freeze([Object.freeze({ pid: 202, uid: 0, filterInherited: true, consoleFds: 0, vsockFds: 0, unexpectedFds: 0 })]) },
    { members: Object.freeze([Object.freeze({ pid: 202, uid: 10002, filterInherited: true, consoleFds: 1, vsockFds: 0, unexpectedFds: 0 })]) },
  ]) await assert.rejects(startHarness({ family: family(altered) }), { code: 'ROLE_INVALID' });
});

test('runtime_inventory_package_and_lock_are_exact_and_hold_distribution', () => {
  assert.equal(fs.existsSync(PACKAGE), true, 'Task 13 package metadata is absent');
  assert.equal(fs.existsSync(LOCK), true, 'Task 13 lock metadata is absent');
  const pkg = JSON.parse(fs.readFileSync(PACKAGE));
  const lock = JSON.parse(fs.readFileSync(LOCK));
  assert.deepEqual(pkg.dependencies, { playwright: '1.58.2' });
  assert.equal(pkg.engines.node, '24.21.0');
  assert.equal(pkg.acceptanceRuntime.node.archiveSha256, '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2');
  assert.equal(pkg.acceptanceRuntime.node.executableSha256, '0f8949d1028f6d61506b2d5bc57e7e6fe893d7b1997509b7847294fc9c616584');
  assert.equal(pkg.acceptanceRuntime.playwright.packageSha256, '6dd31a6dc9705b7536c07827db143ebc6ec28c6a65b99a1e0baac5bc8a28c0eb');
  assert.equal(pkg.acceptanceRuntime.playwright.coreSha256, '50e358de81526d5b20ce75a89c96bdc50ae653f077bbc834ada26d92046ce713');
  assert.equal(pkg.acceptanceRuntime.chromium.revision, '1208');
  assert.equal(pkg.acceptanceRuntime.chromium.archiveSha256, '70b4620521b1ada360475e1059dfe9d549a6461a79b9342f85b7d47e44123077');
  assert.equal(pkg.acceptanceRuntime.chromium.executableSha256, '53f5a63ee5d5328f69599a179f174061d50f5b42d41a3a8dec42f379c8193792');
  assert.equal(pkg.acceptanceRuntime.chromium.publisherChecksum, 'OBSERVED_ONLY');
  assert.equal(pkg.acceptanceRuntime.chromium.licenseNotice, 'ABSENT_IN_ARCHIVE');
  assert.equal(pkg.acceptanceRuntime.chromium.distributionStatus, 'HOLD_PENDING_RUNTIME_QUALIFICATION');
  assert.equal(lock.packages['node_modules/playwright'].integrity, 'sha512-vA30H8Nvkq/cPBnNw4Q8TWz1EJyqgpuinBcHET0YVJVFldr8JDNiU9LaWAE1KqSkRYazuaBhTpB5ZzShOezQ6A==');
  assert.equal(lock.packages['node_modules/playwright-core'].integrity, 'sha512-yZkEtftgwS8CsfYo7nm0KE8jsvm6i/PTgVtB8DL726wNf6H2IMsDuxCpJj59KDaxCtSnrWan2AeDqM7JBaultg==');
  assert.equal(Object.keys(lock.packages).some(key => key.includes('@playwright/test') || key.includes('fsevents')), false);
});

test('untrusted_config_paths_origins_and_assets_are_denied_before_activation', async () => {
  const api = controller();
  for (const mutate of [
    value => { value.paths.profile = '/tmp/profile'; },
    value => { value.runBinding.origins.FRONTEND = 'http://frontend.example.test'; },
    value => { value.runBinding.origins.BACKEND = 'https://backend.example.test/path'; },
    value => { value.assetEntries[0].path = '/../secret'; },
    value => { value.assetEntries.push({ ...value.assetEntries[0] }); },
  ]) {
    const value = config(api); mutate(value); let activated = 0;
    await assert.rejects(api.openBrowser(value, {
      rolePort: { async activateOnce() { activated++; } }, grant: Object.freeze({}),
      decideRoute: async () => ({ decision: 'ABORT' }),
    }), { code: 'CONFIG_INVALID' });
    assert.equal(activated, 0);
  }
});

test('worker_independently_rejects_untrusted_config_before_launch', async () => {
  const observed = {};
  await assert.rejects(startHarness({ workerConfig: { paths: { ...PATHS, profile: '/tmp/profile' } }, observed }), { code: 'ACTIVATION_DENIED' });
  assert.equal(observed.fake.calls.launch.length, 0);
  assert.equal(observed.stops(), 1);
  const mismatched = {};
  await assert.rejects(startHarness({ expectedBinding: compositionBinding('0'.repeat(32)), observed: mismatched }), { code: 'ACTIVATION_DENIED' });
  assert.equal(mismatched.fake.calls.launch.length, 0);
});

test('fixed_actions_only_and_private_results', async () => {
  const h = await startHarness();
  await assert.rejects(h.session.perform('EVALUATE', { expression: '1+1' }), { code: 'ACTION_DENIED' });
  await assert.rejects(h.session.perform('OBSERVE_VIEW', { view: '/arbitrary-url' }), { code: 'ACTION_DENIED' });
  await assert.rejects(h.session.perform('LOGIN_FIELDS', { username: 'owner', password: 'secret', extra: true }), { code: 'ACTION_DENIED' });
  await assert.rejects(h.session.perform('LOGIN_FIELDS', { username: 'x'.repeat(513), password: 'secret' }), { code: 'ACTION_DENIED' });
  const result = await h.session.perform('LOGIN_FIELDS', { username: 'synthetic-owner', password: 'synthetic-password' });
  assert.throws(() => JSON.stringify(result), { code: 'PRIVATE_HANDLE' });
  assert.deepEqual(h.fake.calls.selectors.slice(-2).map(row => row.slice(0, 2)), [
    ['placeholder', 'Username'], ['placeholder', 'Password'],
  ]);
  await closeHarness(h);
});

test('authenticated_route_decision_keeps_body_private_and_never_overrides', async () => {
  const h = await startHarness();
  const secret = Buffer.from('{"username":"synthetic-owner","password":"synthetic-password"}');
  let continues = 0, aborts = 0, fetches = 0;
  const request = {
    method: () => 'POST', url: () => BACKEND + '/api/login',
    headers: () => ({ 'content-type': 'application/json', cookie: 'secret-cookie', 'user-agent': 'Chromium', 'sec-fetch-mode': 'cors' }),
    postDataBuffer: () => Buffer.from(secret),
  };
  await h.fake.calls.routeHandler({
    request: () => request,
    continue: async (...args) => { assert.equal(args.length, 0); continues++; },
    abort: async () => { aborts++; }, fetch: async () => { fetches++; },
  });
  assert.equal(continues, 1); assert.equal(aborts, 0); assert.equal(fetches, 0);
  assert.equal(h.decisions.length, 1);
  assert.equal(h.decisions[0].outcome, 'RESERVED');
  assert.equal(h.decisions[0].phase, A);
  assert.deepEqual(h.decisions[0].cost, { PAPER: 0, stock: 0 });
  const workerFrames = Buffer.concat(h.links.logs.filter(row => row.from === 'worker').map(row => row.bytes)).toString();
  assert.equal(workerFrames.includes('synthetic-password'), false);
  assert.equal(workerFrames.includes('secret-cookie'), false);
  assert.equal(workerFrames.includes(crypto.createHash('sha256').update(secret).digest('hex')), false);
  await closeHarness(h);
});

test('concurrent_intercepted_routes_are_serialized_on_the_original_application_pipe', async () => {
  const h=await startHarness({strictWrites:true}),dispositions=[];
  function intercepted(username){const bytes=Buffer.from(JSON.stringify({username,password:'synthetic-password'}));return {
    request:()=>({method:()=> 'POST',url:()=>BACKEND+'/api/login',headers:()=>({'content-type':'application/json','user-agent':'Chromium'}),postDataBuffer:()=>Buffer.from(bytes)}),
    continue:async()=>{dispositions.push('CONTINUE');},abort:async()=>{dispositions.push('ABORT');},
  };}
  await Promise.all([h.fake.calls.routeHandler(intercepted('first')),h.fake.calls.routeHandler(intercepted('second'))]);
  assert.equal(dispositions.length,2);
  assert.equal(decodedFrames(h.links.logs,'worker').filter(frame=>frame.type==='ROUTE').length,2);
  await closeHarness(h);
});

test('held_admission_serializes_controller_action_before_route_decision', async () => {
  let enterJournal,releaseJournal;
  const entered=new Promise(resolve=>{enterJournal=resolve;}),journalGate=new Promise(resolve=>{releaseJournal=resolve;});
  const h=await startHarness({strictWrites:true,journal:async()=>{enterJournal();await journalGate;}});
  const bytes=Buffer.from('{"username":"route","password":"synthetic-password"}');let disposition;
  const route=h.fake.calls.routeHandler({request:()=>({method:()=> 'POST',url:()=>BACKEND+'/api/login',
    headers:()=>({'content-type':'application/json'}),postDataBuffer:()=>Buffer.from(bytes)}),
    continue:async()=>{disposition='CONTINUE';},abort:async()=>{disposition='ABORT';}});
  await entered;
  const releaseWrite=h.links.controller.holdNextWrite();
  const action=h.session.perform('LOGIN_FIELDS',{username:'synthetic-owner',password:'synthetic-password'});
  await new Promise(resolve=>setImmediate(resolve));
  releaseJournal();await new Promise(resolve=>setImmediate(resolve));releaseWrite();
  await Promise.all([route,action]);assert.ok(['CONTINUE','ABORT'].includes(disposition));
  assert.deepEqual(decodedFrames(h.links.logs,'controller').filter(frame=>['ACTION','DECISION'].includes(frame.type)).map(frame=>frame.type),['ACTION','DECISION']);
  await closeHarness(h);
});

test('invalid_or_oversize_login_body_aborts_without_controller_admission', async () => {
  for (const body of [
    Buffer.from('{"username":"one","username":"two","password":"value"}'),
    Buffer.from('{"username":"user","password":"' + 'x'.repeat(16384) + '"}'),
  ]) {
    const h = await startHarness();
    let aborts = 0, continues = 0;
    const request = {
      method: () => 'POST', url: () => BACKEND + '/api/login',
      headers: () => ({ 'content-type': 'application/json' }), postDataBuffer: () => Buffer.from(body),
    };
    await h.fake.calls.routeHandler({ request: () => request, continue: async () => { continues++; }, abort: async () => { aborts++; } });
    assert.equal(aborts, 1); assert.equal(continues, 0); assert.equal(h.decisions.length, 0);
    assert.equal(Buffer.concat(h.links.logs.map(row => row.bytes)).toString().includes(crypto.createHash('sha256').update(body).digest('hex')), false);
    await closeHarness(h);
  }
});

test('only_one_action_may_be_in_flight', async () => {
  const h = await startHarness();
  const first = h.session.perform('LOGIN_FIELDS', { username: 'first', password: 'secret' });
  await assert.rejects(h.session.perform('LOGIN_FIELDS', { username: 'second', password: 'secret' }), { code: 'ACTION_DENIED' });
  await first;
  await closeHarness(h);
});

test('malformed_authenticated_channel_input_stops_original_role', async () => {
  const h = await startHarness();
  const body = Buffer.from('{}', 'ascii'), prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
  await h.links.worker.write(Buffer.concat([prefix, body]));
  for (let attempt = 0; attempt < 10 && h.stops() === 0; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.stops(), 1);
  await assert.rejects(h.session.perform('LOGIN_FIELDS', { username: 'user', password: 'secret' }), { code: 'ACTION_DENIED' });
});

test('tampered_runtime_pipe_or_body_fails_closed', async () => {
  const api = controller();
  const badRuntimeValue = JSON.parse(JSON.stringify(api.RUNTIME_PINS));
  badRuntimeValue.chromium.executableSha256 = '0'.repeat(64);
  const badRuntime = trustedConfig(api, { runtime: badRuntimeValue });
  let activated = 0;
  await assert.rejects(api.openBrowser(badRuntime, {
    rolePort: { async activateOnce() { activated++; } }, grant: Object.freeze({}), admissionPort: Object.freeze({}),
  }), { code: 'RUNTIME_IDENTITY_MISMATCH' });
  assert.equal(activated, 0);
  await assert.rejects(startHarness({ audit: topology({ maxFrameBytes: 65536 }) }), { code: 'HANDOFF_DENIED' });

  let bytes = Buffer.from('{"username":"synthetic-owner","password":"first"}');
  let mutate;
  const h = await startHarness({ journal: async () => { mutate(); await new Promise(resolve => setImmediate(resolve)); } });
  let aborts = 0, continues = 0;
  const gate = new Promise(resolve => { mutate = () => { bytes = Buffer.from('{"username":"synthetic-owner","password":"changed"}'); resolve(); }; });
  const request = { method: () => 'POST', url: () => BACKEND + '/api/login', headers: () => ({ 'content-type': 'application/json' }), postDataBuffer: () => bytes };
  await Promise.all([gate, h.fake.calls.routeHandler({ request: () => request, continue: async () => { continues++; }, abort: async () => { aborts++; } })]);
  assert.equal(continues, 0); assert.equal(aborts, 1);
  await closeHarness(h);
});

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// Task 16: session.test.cjs and observation.test.cjs load this file for its harness
// (exported at the end). Its own tests register only when it is the test entry point.
const test = require.main === module ? require('node:test') : () => {};
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
const INDEX_BODY = Buffer.from('<!doctype html><html><head><title>Day Trader</title></head><body><div id="root"></div></body></html>');
const INDEX_ASSET = Object.freeze({ path: '/index.html', body: INDEX_BODY, mime: 'text/html' });
const CSS_ASSET = Object.freeze({ path: '/static/css/main.css', body: Buffer.from('body{margin:0}'), mime: 'text/css' });
// P69: the pinned Chromium's default accept values (route-policy ACCEPT_VALUES).
const NAVIGATION_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const NAVIGATION_ACCEPT_NO_SXG = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
const STYLESHEET_ACCEPT = 'text/css,*/*;q=0.1';
const PATHS = Object.freeze({
  profile: '/run/acceptance/browser/profile',
  support: '/run/acceptance/browser/support',
  cache: '/run/acceptance/browser/cache',
  shm: '/dev/shm',
});

function controller() {
  assert.equal(fs.existsSync(CONTROLLER), true, 'browser controller contract is absent');
  // Task 16: one module instance per process. session.cjs and observation.cjs read
  // this instance's BrowserSession brand, so the require cache is no longer cleared.
  return require(CONTROLLER);
}

function worker(playwright, receiptAPI, bindBrowserWorkerChannel, globals = {}) {
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
    URL, setTimeout, clearTimeout, queueMicrotask, ...globals,
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

// Task 16 (T13 I-6, m-1): the worker's status facts are all four Uid and Gid fields,
// NoNewPrivs, the Seccomp mode and the Seccomp_filters depth; descriptor facts are the
// console, unattributed-socket, unreadable and control-pipe counts.
const ROLE_IDS = Object.freeze([10002, 10002, 10002, 10002]);
function statusFacts(overrides = {}) {
  return { uids: ROLE_IDS, gids: ROLE_IDS, noNewPrivs: true, seccomp: 2, seccompFilters: 1,
    consoleFds: 0, unknownSocketFds: 0, unreadableFds: 0, unexpectedFds: 0, ...overrides };
}
function topology(overrides = {}) {
  return Object.freeze({
    version: 1, kind: 'TASK13_BROWSER_APPLICATION', runId: RUN, maxFrameBytes: 16384,
    ...statusFacts(), capabilities: 'EMPTY', procScope: 'BROWSER_FAMILY_ONLY', networkDeviceCount: 0,
    tmpfsPaths: Object.freeze(['/dev/shm', PATHS.cache, PATHS.profile, PATHS.support]),
    ...overrides,
  });
}

function member(pid, overrides = {}) { return Object.freeze({ pid, ...statusFacts(overrides) }); }
function family(overrides = {}) {
  return Object.freeze({
    workerPid: 101,
    browserPid: 202,
    members: Object.freeze([member(101), member(202), member(203)]),
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
    assetBodies: 0, documentBodies: 0, routeFetches: 0,
  };
  const contextHandlers = {};
  let navigationCount = 0;
  const observationBodies = {
    '/api/robotrader/settings': { settings: { mode: 'paper', enabled: false, isEnabled: false, liveTradingExplicitlyEnabled: false } },
    '/api/robotrader/decisions?environment=paper&limit=25': { decisions: [] },
    '/api/robotrader/orders?environment=paper&limit=25': { orders: [] },
    '/api/robotrader/performance?environment=paper': {
      account: { id: 'paper-account', status: 'ACTIVE', cash: '100', equity: '100', buying_power: '100' },
      summary: { decisions: 0, submittedOrders: 0, filledOrders: 0, rejectedDecisions: 0, lastRunAt: null },
      positions: [], brokerError: null,
    },
    '/api/robotrader/audit?limit=25': { events: [] },
    '/api/robotrader/health': { mongo: { connected: true, status: 'connected' },
      alpaca: { paper: { connected: true, error: null, tradingBlocked: false, accountStatus: 'ACTIVE', buyingPower: 100 } },
      scheduler: { phase1WorkerEnabled: false } },
    '/api/robotrader/reconciliation-status?environment=paper': {
      summary: { total: 0, pending: 0, discrepancies: 0, lastReconciledAt: null },
      orders: [], latestDiscrepancies: [], historicalDiscrepancies: [],
    },
    '/api/paper-trades/account': { executionSource: 'alpaca-paper', broker: 'alpaca', accountId: 'paper-account',
      cash: 100, equity: 100, positionsValue: 0, dailyPnl: 0, totalPnl: null, positions: [] },
    '/api/paper-trades/equity': [],
    '/api/paper-trades/orders': [],
    '/api/paper-trades/trades': [],
    '/api/robotrader/notifications': { events: [], executionSource: 'alpaca-paper' },
    '/api/readiness': {
      contractVersion: 2, profile: 'owner-paper-maintenance', runtimeReady: true, maintenanceReady: true,
      checks: Object.fromEntries(['ownerConfiguration','authenticationConfiguration','databaseConnected','ownerIdentity','ownerSettings','persistence','paperMode','automationDisabled','schedulerSuppressed','paperDestination','paperBindingConfiguration','paperCredentialConfiguration'].map(name => [name, { status: 'pass' }])),
      automation: { enabled: false, isEnabled: false, liveEnabled: false, schedulerSuppressed: true, activationAuthorized: false },
    },
    ...(options.observationBodies || {}),
  };
  let context,currentUrl=FRONTEND+'/';
  function sectionRows(title) {
    if(title==='Recent strategy decisions')return Math.min(observationBodies['/api/robotrader/decisions?environment=paper&limit=25'].decisions.length,10);
    if(title==='RoboTrader orders')return Math.min(observationBodies['/api/robotrader/orders?environment=paper&limit=25'].orders.filter(row=>String(row.status).toLowerCase()!=='rejected').length,8);
    if(title==='Current positions')return Math.min(observationBodies['/api/robotrader/performance?environment=paper'].positions.length,8);
    if(title==='Recent RoboTrader events')return observationBodies['/api/robotrader/audit?limit=25'].events.length;
    if(title==='Broker/local order match')return Math.min(observationBodies['/api/robotrader/reconciliation-status?environment=paper'].orders.length,4);
    if(title==='Positions')return observationBodies['/api/paper-trades/account'].positions.length;
    if(title==='Recent Activity')return observationBodies['/api/paper-trades/orders'].length+observationBodies['/api/paper-trades/trades'].length;
    if(title==='Alpaca paper notification delivery')return observationBodies['/api/robotrader/notifications'].events.length;
    return 0;
  }
  function chartPath() {
    if(options.chartPath)return options.chartPath;
    return observationBodies['/api/paper-trades/equity'].map((row,index)=>(index?'L':'M')+index+','+(-Number(row.equity))).join('');
  }
  function hidden(title,value) {
    return options.hiddenText===value||options.hiddenSections?.includes(title);
  }
  function syntheticLocator(title,value) {
    const locator={
      async count(){if(options.missingText===value)return 0;return options.textCounts?.[value]??1;},
      first(){return this;},
      nth(){return this;},
      async isVisible(){return !hidden(title,value);},
      async waitFor(){if(hidden(title,value))throw new Error('hidden');},
      locator(selector){return syntheticCard(title,selector);},
      async getAttribute(name){return name==='d'&&!options.missingChart?chartPath():null;},
    };return locator;
  }
  function syntheticCard(title,selector) {
    return {
      async count(){
        if(selector==='path.recharts-line-curve')return options.missingChart?0:(observationBodies['/api/paper-trades/equity'].length?1:0);
        if(selector==='tbody tr'||selector==='.rt-panel'||selector==='.mt-5.space-y-3 > .rt-panel')return options.sectionCounts?.[title]??sectionRows(title);
        return 1;
      },
      first(){return this;},
      nth(){return this;},
      async isVisible(){return !options.hiddenRows?.includes(title);},
      async waitFor(){if(options.hiddenRows?.includes(title))throw new Error('hidden');},
      locator(next){return syntheticCard(title,next);},
      getByText(value,query){calls.selectors.push(['text',value,query,title]);return syntheticLocator(title,value);},
      async getAttribute(name){return name==='d'&&!options.missingChart?chartPath():null;},
    };
  }
  const page = {
    handlers: {},
    on(name, fn) { this.handlers[name] = fn; calls.events.push('page.on:' + name); },
    async goto(url, gotoOptions) {
      calls.events.push('goto:' + url);
      calls.goto = { url, options: gotoOptions };
      navigationCount++;
      if (options.initialRoute && navigationCount === 1) {
        let disposition;
        await calls.routeHandler({
          request: () => ({ method: () => 'GET', url: () => url,
            headers: () => ({ accept: options.navigationAccept || NAVIGATION_ACCEPT, 'user-agent': 'Chromium', 'sec-fetch-mode': 'navigate',
              'sec-fetch-dest': 'document', 'sec-fetch-site': 'none', 'sec-fetch-user': '?1', 'upgrade-insecure-requests': '1',
              'sec-ch-ua': '"Chromium";v="145"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Linux"' }), postDataBuffer: () => null }),
          continue: async () => { disposition = 'CONTINUE'; }, abort: async () => { disposition = 'ABORT'; },
        });
        calls.initialRouteDisposition = disposition;
        // Like Playwright, an aborted navigation request rejects goto.
        if (disposition !== 'CONTINUE') throw Object.assign(new Error('net::ERR_FAILED at ' + url), { code: 'NAVIGATION_ABORTED' });
      }
      if (options.gotoError && navigationCount === 1) throw Object.assign(new Error('synthetic navigation failure'), { code: options.gotoError });
      if (options.gotoHang && navigationCount === 1) { calls.events.push('goto:hang'); options.gotoHang(); await new Promise(() => {}); }
      if (options.routeOnObservation && navigationCount > 1 && (options.routeOnObservation !== 'first' || navigationCount === 2)) {
        let disposition;
        await calls.routeHandler({
          request: () => ({ method: () => 'GET', url: () => url, headers: () => ({ accept: NAVIGATION_ACCEPT, 'sec-fetch-mode': 'navigate' }), postDataBuffer: () => null }),
          continue: async () => { disposition = 'CONTINUE'; }, abort: async () => { disposition = 'ABORT'; },
        });
        calls.observationRouteDispositions = [...(calls.observationRouteDispositions || []), disposition];
        if(disposition==='ABORT')throw Object.assign(new Error('synthetic navigation aborted: '+url),{code:'ROUTE_DENIED'});
      }
      if (contextHandlers.response && navigationCount === 1) {
        if (!options.noDocumentResponse) await contextHandlers.response({
          url: () => url, status: () => options.documentStatus || 200,
          body: async () => { calls.documentBodies++; return Buffer.from(options.documentBody || INDEX_BODY); },
          headers: () => ({ 'content-type': 'text/html' }),
        });
        for (const asset of options.subresources || []) await contextHandlers.response({
          url: () => FRONTEND + asset.path, status: () => 200, body: async () => Buffer.from(asset.body),
          headers: () => ({ 'content-type': asset.mime }),
        });
        await contextHandlers.response({ status: () => 200,
          url: () => (options.assetOrigin || FRONTEND) + '/static/js/main.js',
          body: async () => { calls.assetBodies++; return Buffer.from('abc'); },
          headers: () => ({ 'content-type': 'application/javascript' }),
        });
      }
      currentUrl=url;return { ok: () => true };
    },
    async evaluate(_callback,url) {
      calls.events.push('evaluate:'+url);
      if(options.evaluateHang){options.evaluateHang();await new Promise(()=>{});}
      if(options.routeOnObservation&&(!calls.observationRouteDispositions?.length||options.routeOnObservation!=='first')){
        let disposition;
        await calls.routeHandler({
          request:()=>({method:()=> 'GET',url:()=>url,headers:()=>({accept:'application/json'}),postDataBuffer:()=>null}),
          continue:async()=>{disposition='CONTINUE';},abort:async()=>{disposition='ABORT';},
        });
        calls.observationRouteDispositions=[...(calls.observationRouteDispositions||[]),disposition];
        if(disposition==='ABORT')throw Object.assign(new Error('synthetic request aborted: '+url),{code:'ROUTE_DENIED'});
      }
    },
    url(){return currentUrl;},
    async waitForLoadState() { calls.events.push('load'); },
    getByPlaceholder(name) {
      return { fill: async value => { calls.selectors.push(['placeholder', name, value]);
        if (options.fillError !== undefined) throw Object.assign(new Error('synthetic fill failure'), { code: options.fillError }); } };
    },
    getByRole(role, query = {}) {
      const locator={
        click: async () => { calls.selectors.push(['role', role, query]);if(role==='link'){
          const path={"Robo Trader":'/robo',Portfolio:'/portfolio',Activity:'/activity'}[query.name];if(path)currentUrl=FRONTEND+path;} },
        isVisible: async () => options.hiddenHeading !== true,
        count: async () => role === 'alert' ? (options.alertCount || 0) : role === 'status' ? (options.statusCount || 0) : 1,
        async waitFor(){if(options.hiddenHeading)throw new Error('hidden');},
        first(){return this;},
      };return locator;
    },
    getByText(value, query) {
      calls.selectors.push(['text', value, query]);
      return syntheticLocator(value,value);
    },
    locator(selector) { calls.selectors.push(['locator', selector]);return syntheticCard('',selector); },
    async waitForResponse(predicate) {
      const ownerId=typeof options.ownerId==='function'?options.ownerId():options.ownerId;
      const ownerUsername=typeof options.ownerUsername==='function'?options.ownerUsername():options.ownerUsername;
      for(const status of options.meStatuses||[200]){
        const response={url:()=>BACKEND+'/api/me',status:()=>status,request:()=>({method:()=> 'GET'}),json:async()=>status===200?({user:{id:ownerId||'owner-id',username:ownerUsername||'synthetic-owner'}}):({message:'Unauthorized'})};
        const accepted=predicate(response);calls.responseCandidates=[...(calls.responseCandidates||[]),{status,accepted}];if(accepted)return response;
      }
      for(const [target,body] of Object.entries(observationBodies)){
        const response={url:()=>BACKEND+target,status:()=>200,request:()=>({method:()=> 'GET'}),json:async()=>structuredClone(body)};
        if(predicate(response))return response;
      }
      throw new Error('synthetic response sequence exhausted');
    },
    async reload() { calls.events.push('reload'); return { ok: () => true }; },
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
    async cookies() { const override=typeof options.cookie==='function'?options.cookie():options.cookie;
      const cookie=Object.assign({ name: 'daytrader_session', value: 'private-cookie', domain: 'backend.example.test', path: '/', secure: true, httpOnly: true, sameSite: 'None' },override||{});
      // I-10 M17: a second, otherwise valid daytrader_session cookie.
      return options.duplicateCookie ? [cookie, { ...cookie, value: 'second-private-cookie' }] : [cookie]; },
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
  const fake = fakePlaywright({ ...(options.fake || {}), subresources: options.cssAsset ? [CSS_ASSET] : [] });
  const audit=topology({...(options.audit||{}),runId:testRun});
  const links = duplex(audit, options.family || family(), { strictWrites: options.strictWrites === true });
  // T13 m-7: each family inspection is recorded with the number of Playwright events seen
  // before it; a function `family` option answers per inspection (1-based).
  const inspections = [], familySource = options.family || family();
  links.worker.inspectBrowserFamily = () => { inspections.push(fake.calls.events.length);
    return typeof familySource === 'function' ? familySource(inspections.length) : familySource; };
  const assetProofs = [];
  const launchEvents = [];
  let activationResolve,activationReject;
  const activationReady=new Promise((resolve,reject)=>{activationResolve=resolve;activationReject=reject;});
  const routeFixture = budgetFixture({ phase: options.phase || A, journal: options.journal,
    runId: testRun, configIdentity: '3'.repeat(64), assetPath: '/static/js/main.js', assetBody: Buffer.from('abc'),
    extraAssets: [...(options.indexAsset === false ? [] : [INDEX_ASSET]), ...(options.cssAsset ? [CSS_ASSET] : [])],
    inspectBrowserEvidence: roles.inspectBrowserRequestEvidence });
  const bundle = receipts.createBrowserAssetBundle(routeFixture.release, routeFixture.assets, routeFixture.trust,
    routeFixture.releaseBytes, routeFixture.assetBytes);
  const binding = compositionBinding(testRun);
  const cfg = receipts.createBrowserControllerConfig(routeFixture.release, routeFixture.assets, routeFixture.trust, bundle,
    { runtime: JSON.parse(JSON.stringify(api.RUNTIME_PINS)), paths: { ...PATHS, ...(options.config?.paths || {}) } }, binding);
  const projected = receipts.inspectBrowserControllerConfig(cfg);
  const workerCfg = JSON.parse(JSON.stringify(projected));
  if (options.workerConfig) Object.assign(workerCfg, options.workerConfig);
  // C1 double: the shared cleanup end exists only after the terminal start.
  let cleanupStarted = false;
  const launchContext = Object.freeze({
    channel: Object.freeze({}), expected: Object.freeze({ binding: options.expectedBinding || binding }),
    clock: options.workerClock || Object.freeze({ sample: () => [160, 1000] }),
    cleanupBudget: Object.freeze({
      startTerminal() { cleanupStarted = true; return 120000; },
      remaining() { if (!cleanupStarted) throw Object.assign(new Error('CLEANUP_NOT_STARTED'), { code: 'CLEANUP_NOT_STARTED' }); return 120000; },
    }), prepareRecord: Buffer.from('synthetic-prepare'),
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
    // Task 11 (P5): the authority reports the remaining activation time that bounds activateOnce.
    inspectGrant:value=>value===grant?{kind:'BROWSER',runId:testRun,child,purpose:'CONFINEMENT_PROVED',session:null,remainingMs:60000}:null,
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
    fake, links, workerResult, assetProofs, stops: () => stops, waits: () => waits, runId: testRun, inspections: () => [...inspections],
  });
  const clock = options.controllerClock || Object.freeze({ sample: () => [160, 1000] });
  const session = await api.openBrowser(cfg, { rolePort, grant, admissionPort, clock });
  return { api, fake, links, cfg, session, workerResult, assetProofs, decisions:routeFixture.intents, launchEvents,runId:testRun,
    activations: () => activations, stops: () => stops, waits: () => waits, cleanupStarted: () => cleanupStarted,
    inspections: () => [...inspections] };
}

// Task 16 (T13 I-8): a real BrowserSession whose worker side the test scripts frame by
// frame. The controller (browser.cjs), the adopted role port and the application pipe
// brand are all real; only the worker's frames are synthetic. `hooks` shape the answers.
const VIEW_ROUTES = Object.freeze({ ROBO: 7, PORTFOLIO: 2, ACTIVITY: 3 });
function scriptedBrowser(options = {}) {
  const api = controller();
  const runId = options.runId || crypto.randomBytes(16).toString('hex');
  const pipeRunId = options.pipeRunId || runId;
  const configIdentity = options.configIdentity || '3'.repeat(64);
  const routeFixture = budgetFixture({ runId, configIdentity, assetPath: '/static/js/main.js', assetBody: Buffer.from('abc'),
    extraAssets: options.extraAssets || [] });
  const bundle = receipts.createBrowserAssetBundle(routeFixture.release, routeFixture.assets, routeFixture.trust,
    routeFixture.releaseBytes, routeFixture.assetBytes);
  const cfg = receipts.createBrowserControllerConfig(routeFixture.release, routeFixture.assets, routeFixture.trust, bundle,
    { runtime: JSON.parse(JSON.stringify(api.RUNTIME_PINS)), paths: { ...PATHS } }, compositionBinding(runId, { configIdentity }));
  const entries = receipts.inspectBrowserControllerConfig(cfg).assetEntries;
  const links = duplex(topology({ runId: pipeRunId }));
  if (options.controllerAudit) links.controller.audit = options.controllerAudit;
  const handoff = Object.freeze({}), child = Object.freeze({}), grant = Object.freeze({});
  let waiting = true, stops = 0, outgoing = 0;
  const authority = {
    inspectHandoff: value => value === handoff ? { kind: 'BROWSER', runId: pipeRunId, uid: 10002, child, privatePipe: links.controller, waiting, confined: true } : null,
    inspectGrant: value => value === grant ? { kind: 'BROWSER', runId: pipeRunId, child, purpose: 'CONFINEMENT_PROVED', session: null, remainingMs: 60000 } : null,
    async activate() { waiting = false; },
    async stopOwned(owned) { assert.equal(owned, child); stops++; return { status: 'STOPPED', runId: pipeRunId, child }; },
    async waitExit(owned) { assert.equal(owned, child); return { status: 'EXITED', runId: pipeRunId, child }; },
  };
  roles.bindRoleBootstrap(authority, pipeRunId).audit(handoff);
  const rolePort = roles.adoptRole('BROWSER', handoff);
  const received = [], hooks = options.hooks || {};
  function send(type, payload) {
    const bare = { version: 1, runId: pipeRunId, sequence: ++outgoing, type, payload };
    // Only the legacy-branch test MACs its frames, in the removed acceptance:browser:v1 form.
    const mac = options.legacyMac ? { mac: crypto.createHmac('sha256', Buffer.from(options.legacyMac, 'hex'))
      .update('acceptance:browser:v1\0WORKER_TO_CONTROLLER\0' + canonical(bare)).digest('hex') } : {};
    return links.worker.write(inheritedFrame({ ...bare, ...mac }));
  }
  const fingerprint = (action, payload) => typeof hooks.fingerprint === 'function' ? hooks.fingerprint(action, payload) : options.fingerprint || 'b'.repeat(64);
  async function respond({ actionId, action, payload }) {
    const code = typeof hooks.error === 'function' ? hooks.error(action, payload) : null;
    if (code) return send('ERROR', { actionId, code });
    if (action === 'LOGIN_SESSION') {
      await send('FILLED', { actionId, status: 'FILLED' });
      if (typeof hooks.beforeBound === 'function') await hooks.beforeBound();
      return send('RESULT', { actionId, status: 'SESSION_BOUND', fingerprint: fingerprint(action, payload) });
    }
    if (action === 'SESSION_OBSERVATION') return send('RESULT', { actionId, status: 'SESSION_OBSERVED', fingerprint: fingerprint(action, payload) });
    if (typeof hooks.onView === 'function') hooks.onView(payload.view);
    return send('RESULT', { actionId, status: 'VIEW_OBSERVED', view: payload.view, phase: payload.phase, schemaValidation: true,
      renderedData: true, validEmptyState: false, noError: true, fresh: true, source: 'alpaca-paper', brokerError: false,
      routeCount: VIEW_ROUTES[payload.view], renderedCount: 1, fingerprint: fingerprint(action, payload), readinessValidation: payload.view === 'ROBO',
      ...(typeof hooks.view === 'function' ? hooks.view(payload.view) : {}) });
  }
  const valid = entries.map(entry => ({ entryId: 'frontend-asset:' + entry.path, hash: entry.hash, sizeMatch: true, hashMatch: true, mimeMatch: true }));
  const proofs = typeof options.proofs === 'function' ? options.proofs(valid) : valid;
  (async () => {
    await send('ASSETS', { proofs }); await send('READY', { status: 'READY' });
    while (true) {
      const frame = JSON.parse((await links.worker.read()).subarray(4).toString('ascii')); received.push(frame);
      if (frame.type === 'CLOSE') { await send('EXIT', { status: 'EXITED', runId: pipeRunId }); return; }
      if (frame.type === 'ACTION') await respond(frame.payload);
    }
  })().catch(() => {});
  const opened = api.openBrowser(cfg, { rolePort, grant, admissionPort: Object.freeze({}), clock: Object.freeze({ sample: () => [160, 1000] }) });
  opened.catch(() => {});
  return { api, cfg, links, runId, opened, stops: () => stops,
    actions: () => received.filter(frame => frame.type === 'ACTION').map(frame => frame.payload),
    written: () => Buffer.concat(links.logs.filter(row => row.from === 'controller').map(row => row.bytes)).toString('ascii') };
}
async function scriptedSession(options = {}) {
  const scripted = scriptedBrowser(options);
  scripted.session = await scripted.opened;
  return scripted;
}

// Task 16 (T13 I-6, m-1): a fake /proc in the Linux 6.8 formats, for the worker's native readers.
//  - fs/proc/array.c:189-196 (four Uid and four Gid fields, tab separated), :335-341 (NoNewPrivs,
//    Seccomp, Seccomp_filters); include/uapi/linux/seccomp.h:12 SECCOMP_MODE_FILTER 2.
//  - net/socket.c:362 `socket:[%lu]` and fs/pipe.c:881 `pipe:[%lu]` descriptor links.
//  - net/unix/af_unix.c:3282-3289 (header; inode is the 7th field), net/ipv4/tcp_ipv4.c:2896 and
//    :2945-2947, net/ipv6/tcp_ipv6.c:2211 and :2270-2275, net/ipv4/udp.c:3082 and :3098-3100,
//    net/ipv6/datagram.c:1055 with include/net/transp_v6.h:59-64 (inode is the 10th field).
//    Request and TIME_WAIT rows (tcp_ipv4.c:2835, :2929) carry inode 0.
const NET_TABLES = Object.freeze({
  unix: 'Num       RefCount Protocol Flags    Type St Inode Path\n' +
    '0000000000000000: 00000002 00000000 00000000 0001 03 41001\n' +
    '0000000000000000: 00000003 00000000 00010000 0001 01 41002 @chromium-sandbox-ipc\n',
  tcp: '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode' + ' '.repeat(12) + '\n' +
    '   0: 0100007F:E0A2 0100007F:0C38 01 00000000:00000000 00:00000000 00000000 10002        0 41003 1 0000000000000000 20 4 30 10 -1\n' +
    '   1: 0100007F:E0A4 0100007F:0C38 06 00000000:00000000 03:00000F9F 00000000     0        0 0 3 0000000000000000\n',
  tcp6: '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n' +
    '   0: 00000000000000000000000001000000:E0A6 00000000000000000000000001000000:0C38 01 00000000:00000000 00:00000000 00000000 10002        0 41004 1 0000000000000000 20 4 30 10 -1\n',
  udp: '   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops' + ' '.repeat(12) + '\n' +
    '  101: 0100007F:D431 00000000:0000 07 00000000:00000000 00:00000000 00000000 10002        0 41005 2 0000000000000000 0\n',
  udp6: '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n',
});
const SOCKET_INODES = Object.freeze({ 41001: 'UNIX', 41002: 'UNIX', 41003: 'TCP', 41004: 'TCP', 41005: 'UDP' });
function procError(code, target) { return Object.assign(new Error(code + ' ' + target), { code }); }
function statusText(overrides = {}) {
  const rows = { Uid: '10002\t10002\t10002\t10002', Gid: '10002\t10002\t10002\t10002', CapEff: '0000000000000000',
    NoNewPrivs: '1', Seccomp: '2', Seccomp_filters: '1', ...overrides };
  return ['Name:\tchrome', 'Umask:\t0022', 'State:\tS (sleeping)', 'Tgid:\t202', 'Pid:\t202', 'PPid:\t101', 'TracerPid:\t0',
    ...['Uid', 'Gid'].filter(name => rows[name] !== null).map(name => name + ':\t' + rows[name]),
    'FDSize:\t64', 'Groups:\t', 'CapInh:\t0000000000000000', 'CapPrm:\t0000000000000000',
    ...['CapEff', 'NoNewPrivs', 'Seccomp', 'Seccomp_filters'].filter(name => rows[name] !== null).map(name => name + ':\t' + rows[name]),
    'Speculation_Store_Bypass:\tthread vulnerable', ''].join('\n');
}
// The reader's own listing descriptor resolves only while its /proc/<pid>/fd listing is open.
const LISTING = open => { if (!open) throw procError('ENOENT', 'closed listing descriptor'); return '/proc/101/fd'; };
// Fix round 1 (I-1): `threads` maps each tid under /proc/<pid>/task/ to the children that
// thread forked. Linux files a child under the forking thread (kernel/fork.c:2632, :2690) and
// each task's `children` lists only that task's children (fs/proc/array.c:720-770). Here the
// browser (202) forks 204 from a non-main thread (251), as Chromium's launcher thread does.
function cleanProcesses() {
  return {
    101: { threads: { 101: [202], 102: [] }, status: statusText(), fds: { 0: '/dev/null', 1: '/dev/null', 2: '/dev/null', 3: 'pipe:[11]', 4: 'pipe:[12]',
      5: 'anon_inode:[eventpoll]', 6: 'pipe:[13]', 7: 'anon_inode:[eventfd]', 9: LISTING } },
    202: { threads: { 202: [203], 251: [204], 252: [] }, status: statusText(), fds: { 0: '/dev/null', 1: '/dev/null', 2: '/dev/null', 3: 'pipe:[13]',
      5: 'socket:[41001]', 6: 'socket:[41003]', 7: 'socket:[41004]', 8: 'socket:[41005]', 9: '/dev/shm/.org.chromium.Chromium.Ab12Cd (deleted)',
      10: 'anon_inode:[eventfd]', 11: '/run/acceptance/browser/profile/Default/Cookies' } },
    203: { threads: { 203: [] }, status: statusText({ Seccomp_filters: '3' }), fds: { 0: '/dev/null', 5: 'socket:[41002]', 6: '/memfd:shared_memory (deleted)' } },
    204: { threads: { 204: [] }, status: statusText({ Seccomp_filters: '2' }), fds: { 0: '/dev/null', 5: 'socket:[41001]', 6: 'anon_inode:[eventpoll]' } },
  };
}
function fakeProc(processes = cleanProcesses(), net = {}) {
  const tables = { ...NET_TABLES, ...net }, open = new Set();
  const processFor = (pid, target) => { const value = processes[pid === 'self' ? 'self' : pid]; if (!value) throw procError('ENOENT', target); return value; };
  return {
    readdirSync(target) {
      const match = /^\/proc\/([0-9]+)\/task$/.exec(target); if (!match) throw procError('ENOENT', target);
      const threads = processFor(match[1], target).threads; if (threads instanceof Error) throw threads;
      return Object.keys(threads);
    },
    readFileSync(target) {
      let match;
      if ((match = /^\/proc\/net\/(unix|tcp6?|udp6?)$/.exec(target))) { const value = tables[match[1]]; if (value instanceof Error) throw value; return value; }
      if ((match = /^\/proc\/([0-9]+)\/task\/([0-9]+)\/children$/.exec(target))) {
        const threads = processFor(match[1], target).threads, children = threads instanceof Error ? undefined : threads[match[2]];
        if (children === undefined) throw procError('ENOENT', target); if (children instanceof Error) throw children;
        return children.map(pid => pid + ' ').join(''); }
      if ((match = /^\/proc\/([0-9]+|self)\/status$/.exec(target))) { const status = processFor(match[1], target).status; if (status instanceof Error) throw status; return status; }
      if (processes.self && target === '/proc/net/dev') return processes.self.netDev;
      if (processes.self && target === '/proc/self/mountinfo') return processes.self.mountinfo;
      throw procError('ENOENT', target);
    },
    opendirSync(target) {
      const match = /^\/proc\/([0-9]+|self)\/fd$/.exec(target); if (!match) throw procError('ENOENT', target);
      const fds = processFor(match[1], target).fds; if (fds instanceof Error) throw fds;
      const names = Object.keys(fds); let index = 0; open.add(match[1]);
      return { readSync() { return index < names.length ? { name: names[index++] } : null; }, closeSync() { open.delete(match[1]); } };
    },
    readlinkSync(target) {
      const match = /^\/proc\/([0-9]+|self)\/fd\/([0-9]+)$/.exec(target); if (!match) throw procError('ENOENT', target);
      const link = processFor(match[1], target).fds[match[2]];
      if (typeof link === 'function') return link(open.has(match[1]));
      if (link === undefined) throw procError('ENOENT', target);
      if (link instanceof Error) throw link;
      return link;
    },
  };
}
const CONTROL_TARGETS = Object.freeze(['pipe:[11]', 'pipe:[12]']);
function nativeReaders() {
  const api = worker(fakePlaywright(), receipts, async () => assert.fail('binding must not start'), { process });
  for (const name of ['classifyDescriptor', 'socketInodeFamilies', 'procStatus', 'forbiddenDescriptorCounts', 'inspectNativeFamily', 'nativeTopology'])
    assert.equal(typeof api[name], 'function', name + ' native reader is absent');
  return api;
}
function plainCopy(value) { return JSON.parse(JSON.stringify(value)); }
// The worker's own /proc/self view for nativeTopology.
function selfProcesses(overrides = {}) {
  return { self: { status: statusText(), netDev: 'Inter-|   Receive\n face |bytes\n    lo: 0 0\n',
    mountinfo: '36 25 0:32 / / rw,nosuid - tmpfs tmpfs rw\n',
    fds: { 0: '/dev/null', 1: '/dev/null', 2: '/dev/null', 3: 'pipe:[11]', 4: 'pipe:[12]', 5: 'anon_inode:[eventpoll]',
      9: open => { if (!open) throw procError('ENOENT', 'closed listing descriptor'); return '/proc/101/fd'; } }, ...overrides } };
}
// The real init frame carries the composition channel key; the worker topology must not copy it (P28).
const SELF_INIT = Object.freeze({ binding: Object.freeze({ runId: RUN }), channelKeyHex: KEY });

async function closeHarness(h) {
  const result = await h.session.close();
  const workerExit = await h.workerResult;
  return { result, workerExit };
}

async function settled(condition, turns = 200) {
  for (let turn = 0; turn < turns && !condition(); turn++) await new Promise(resolve => setImmediate(resolve));
  return condition();
}
function within(promise, milliseconds) {
  let timer;
  return Promise.race([promise.then(() => 'RESOLVED', error => 'REJECTED:' + error.code),
    new Promise(resolve => { timer = setTimeout(() => resolve('BLOCKED'), milliseconds); })]).finally(() => clearTimeout(timer));
}
function steppedClock(start = [160, 1000]) {
  let now = [...start];
  return { clock: Object.freeze({ sample: () => [...now] }), set(value) { now = [...value]; } };
}
const login = () => ({ ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password' });

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
    opendirSync(){const names=['0','1','2','3','4'];return {readSync:()=>names.length?{name:names.shift()}:null,closeSync(){}};},
    readFileSync(path){if(path==='/proc/self/status')return statusText();
      if(/^\/proc\/net\/(unix|tcp6?|udp6?)$/.test(path))return NET_TABLES[path.slice(10)];
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

test('initial_navigation_is_login_and_continued_in_phase_P', async () => {
  // T13 I-1: the first navigation is FRONTEND/login, decided by admission before assets and READY.
  const first = {};
  const h = await startHarness({ phase: 'PREFLIGHT', fake: { initialRoute: true }, observed: first }).catch(error => error);
  const target = new URL(first.fake.calls.goto.url);
  assert.equal(target.origin, FRONTEND);
  assert.equal(target.pathname, '/login');
  assert.equal(target.search + target.hash, '');
  assert.equal(first.fake.calls.goto.options.waitUntil, 'domcontentloaded');
  assert.equal(first.fake.calls.initialRouteDisposition, 'CONTINUE');
  assert.equal(h instanceof Error, false, h?.code);
  const frames = decodedFrames(h.links.logs, 'worker');
  assert.deepEqual(frames.slice(0, 3).map(frame => frame.type), ['ROUTE', 'ASSETS', 'READY']);
  assert.equal(frames[0].payload.url, FRONTEND + '/login');
  assert.equal(frames[0].payload.method, 'GET');
  const decision = decodedFrames(h.links.logs, 'controller')[0];
  assert.equal(decision.type, 'DECISION');
  assert.deepEqual(decision.payload, { requestId: frames[0].payload.requestId, decision: 'CONTINUE' });
  assert.deepEqual(h.decisions.map(row => [row.routeId, row.phase, row.outcome]), [['frontend-document', 'PREFLIGHT', 'RESERVED']]);
  assert.equal(h.session.failureCode(), null);
  await closeHarness(h);
  // The fake goto rejects an aborted navigation: /login is not admissible in phase A, so READY is never reached.
  const observed = {};
  await assert.rejects(startHarness({ fake: { initialRoute: true }, observed }), { code: 'ROUTE_DENIED' });
  assert.equal(observed.fake.calls.initialRouteDisposition, 'ABORT');
  assert.equal(decodedFrames(observed.links.logs, 'worker').some(frame => ['ASSETS', 'READY'].includes(frame.type)), false);
  assert.equal(observed.stops(), 1);
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
  assert.equal(h.fake.calls.documentBodies, 1);
  assert.deepEqual(h.assetProofs.map(row => row.entry.path).sort(), ['/index.html', '/static/js/main.js']);
  assert.deepEqual([...h.assetProofs.find(row => row.entry.path === '/static/js/main.js').body], [...Buffer.from('abc')]);
  assert.deepEqual([...h.assetProofs.find(row => row.entry.path === '/index.html').body], [...INDEX_BODY]);
  assert.equal(h.fake.calls.routeFetches, 0);
  const workerFrames = decodedFrames(h.links.logs, 'worker');
  assert.deepEqual(workerFrames.slice(0, 2).map(frame => frame.type), ['ASSETS', 'READY']);
  assert.deepEqual(workerFrames[0].payload.proofs, [{
    entryId: 'frontend-asset:/static/js/main.js', hash: crypto.createHash('sha256').update('abc').digest('hex'),
    sizeMatch: true, hashMatch: true, mimeMatch: true,
  }, {
    entryId: 'frontend-asset:/index.html', hash: crypto.createHash('sha256').update(INDEX_BODY).digest('hex'),
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
  // A child whose seccomp filter is not inherited (mode 0, no filters).
  const observed={};const bad = startHarness({ observed,family: family({ members: Object.freeze([
    member(101), member(202, { seccomp: 0, seccompFilters: 0 }),
  ]) }) });
  await assert.rejects(bad, { code: 'ROLE_INVALID' });
  assert.equal(observed.fake.calls.contextCloses,1);assert.equal(observed.fake.calls.browserCloses,1);
});

test('browser_pid_uid_proc_console_inventory', async () => {
  const h = await startHarness();
  await closeHarness(h);
  // Each altered member sits in an otherwise valid two-member family, so only its own fact fails.
  for (const altered of [
    { browserPid: 0 }, { procScope: 'HOST' },
    { members: Object.freeze([member(101), member(202, { uids: Object.freeze([0, 0, 0, 0]) })]) },
    { members: Object.freeze([member(101), member(202, { uids: Object.freeze([10002, 0, 10002, 10002]) })]) },
    { members: Object.freeze([member(101), member(202, { gids: Object.freeze([10002, 10002, 10002, 0]) })]) },
    { members: Object.freeze([member(101), member(202, { consoleFds: 1 })]) },
    { members: Object.freeze([member(101), member(202, { unknownSocketFds: 1 })]) },
    { members: Object.freeze([member(101), member(202, { unexpectedFds: 1 })]) },
    { members: Object.freeze([member(101), member(202, { unreadableFds: 1 })]) },
  ]) await assert.rejects(startHarness({ family: family(altered) }), { code: 'ROLE_INVALID' }, JSON.stringify(altered));
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
  await assert.rejects(h.session.perform('LOGIN_SESSION', { ownerId:'owner-id',username: 'x'.repeat(513), password: 'secret' }), { code: 'ACTION_DENIED' });
  const result = await h.session.perform('LOGIN_SESSION', { ownerId:'owner-id',username: 'synthetic-owner', password: 'synthetic-password' },()=>{});
  assert.throws(() => JSON.stringify(result), { code: 'PRIVATE_HANDLE' });
  assert.deepEqual(h.session.inspectResult(result).kind, 'SESSION_BOUND');
  assert.deepEqual(h.fake.calls.selectors.slice(-3).map(row => row.slice(0, 2)), [
    ['placeholder', 'Username'], ['placeholder', 'Password'], ['role','button'],
  ]);
  await closeHarness(h);
});

test('task14_login_click_owner_cookie_and_private_fingerprint', async () => {
  const h = await startHarness();
  await assert.rejects(h.session.perform('LOGIN_FIELDS', { username: 'synthetic-owner', password: 'synthetic-password' }), { code: 'ACTION_DENIED' });
  const result = await h.session.perform('LOGIN_SESSION', {
    ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
  },()=>{});
  const inspected=h.session.inspectResult(result);
  assert.equal(inspected.kind, 'SESSION_BOUND');
  assert.match(inspected.fingerprint, /^[0-9a-f]{64}$/);
  assert.throws(() => JSON.stringify(result), { code: 'PRIVATE_HANDLE' });
  assert.deepEqual(h.fake.calls.selectors.slice(-3).map(row => row.slice(0, 2)), [
    ['placeholder', 'Username'], ['placeholder', 'Password'], ['role', 'button'],
  ]);
  const frames = Buffer.concat(h.links.logs.map(row => row.bytes)).toString();
  assert.equal(frames.includes('private-cookie'), false);
  await closeHarness(h);
});

test('task14_delayed_preauth_401_cannot_win_post_login_me_waiter', async () => {
  const h = await startHarness({ fake: { meStatuses: [401, 200] } });
  const result = await h.session.perform('LOGIN_SESSION', {
    ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
  },()=>{});
  assert.equal(h.session.inspectResult(result).kind, 'SESSION_BOUND');
  assert.deepEqual(h.fake.calls.responseCandidates, [
    { status: 401, accepted: false }, { status: 200, accepted: true },
  ]);
  await closeHarness(h);
});

test('task14_wrong_owner_and_cookie_widening_fail_closed', async () => {
  const wrongOwner = await startHarness({ fake: { ownerId: 'different-owner' } });
  await assert.rejects(wrongOwner.session.perform('LOGIN_SESSION', {
    ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
  },()=>{}), { code: 'IDENTITY_MISMATCH', workerCode: 'OWNER_MISMATCH' });
  for (const cookie of [
    { secure: false }, { httpOnly: false }, { sameSite: 'Lax' }, { path: '/api' },
    { domain: '.backend.example.test' }, { domain: 'frontend.example.test' },
  ]) {
    const h = await startHarness({ fake: { cookie } });
    await assert.rejects(h.session.perform('LOGIN_SESSION', {
      ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
    },()=>{}), { code: 'SESSION_MISMATCH', workerCode: 'COOKIE_INVALID' });
  }
});

test('task14_second_login_fails_and_continuity_uses_worker_local_cookie', async () => {
  let value = 'private-cookie';
  const h = await startHarness({ fake: { cookie: () => ({ value }) } });
  const before = await h.session.perform('LOGIN_SESSION', {
    ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
  },()=>{});
  await assert.rejects(h.session.perform('LOGIN_SESSION', {
    ownerId: 'owner-id', username: 'synthetic-owner', password: 'second-password',
  },()=>{}), { code: 'REPLAY', workerCode: 'LOGIN_ALREADY_ATTEMPTED' });
  assert.equal(h.fake.calls.contexts.length, 1);
  assert.equal(Buffer.concat(h.links.logs.map(row => row.bytes)).toString().includes('private-cookie'), false);
  // The second login intentionally terminates this worker. A fresh synthetic
  // run proves continuity comparison without adding a retry path.
  const continuous = await startHarness({ fake: { cookie: () => ({ value }) } });
  const first = await continuous.session.perform('LOGIN_SESSION', {
    ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
  },()=>{});
  value = 'replacement-cookie';
  const after = await continuous.session.perform('SESSION_OBSERVATION', {});
  assert.notEqual(continuous.session.inspectResult(first).fingerprint, continuous.session.inspectResult(after).fingerprint);
  assert.equal(continuous.fake.calls.events.includes('reload'), false);
  await closeHarness(continuous);
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
  // The login route's phase-A ceiling is 1: the second login is denied, and that denial latches (T13 I-7).
  assert.deepEqual([...dispositions].sort(),['ABORT','CONTINUE']);
  assert.equal(await settled(()=>h.session.failureCode()!==null),true);
  assert.equal(h.session.failureCode(),'ROUTE_DENIED');
  await assert.rejects(h.session.close(),{code:'ROUTE_DENIED'});
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
  const action=h.session.perform('LOGIN_SESSION',{ownerId:'owner-id',username:'synthetic-owner',password:'synthetic-password'},()=>{});
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
  const first = h.session.perform('LOGIN_SESSION', { ownerId:'owner-id',username: 'synthetic-owner', password: 'secret' },()=>{});
  await assert.rejects(h.session.perform('LOGIN_SESSION', { ownerId:'owner-id',username: 'synthetic-owner', password: 'secret' },()=>{}), { code: 'ACTION_DENIED' });
  await first;
  await closeHarness(h);
});

test('malformed_authenticated_channel_input_stops_original_role', async () => {
  const h = await startHarness();
  const body = Buffer.from('{}', 'ascii'), prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
  await h.links.worker.write(Buffer.concat([prefix, body]));
  for (let attempt = 0; attempt < 10 && h.stops() === 0; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.stops(), 1);
  assert.equal(h.session.failureCode(), 'INVALID_FRAME');
  await assert.rejects(h.session.perform('LOGIN_SESSION', { ownerId:'owner-id',username: 'user', password: 'secret' },()=>{}), { code: 'INVALID_FRAME' });
  assert.equal(decodedFrames(h.links.logs, 'controller').some(frame => frame.type === 'ACTION'), false);
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

test('task15_observe_view_action_is_fixed_and_nominal', async () => {
  const h = await startHarness();
  assert.equal(h.session.assertBinding({ runId: h.runId, configIdentity: '3'.repeat(64) }), true);
  assert.throws(() => h.session.assertBinding({ runId: '0'.repeat(32), configIdentity: '3'.repeat(64) }), { code: 'IDENTITY_MISMATCH' });
  await h.session.perform('LOGIN_SESSION', {
    ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
  }, () => {});
  await assert.rejects(h.session.perform('OBSERVE_VIEW', {
    phase: 'OBSERVE_BEFORE_RESTART', view: 'SETTINGS',
  }), { code: 'ACTION_DENIED' });
  await assert.rejects(h.session.perform('OBSERVE_VIEW', {
    phase: 'OBSERVE_AFTER_RESTART', view: 'PORTFOLIO',
  }), { code: 'ACTION_DENIED' });
  const result = await h.session.perform('OBSERVE_VIEW', {
    phase: 'OBSERVE_BEFORE_RESTART', view: 'ROBO',
  });
  const inspected = h.session.inspectResult(result);
  assert.equal(inspected.kind, 'VIEW_OBSERVED');
  assert.equal(inspected.view, 'ROBO');
  assert.equal(inspected.routeCount, 7);
  await closeHarness(h);
});

test('task15_secondary_views_use_spa_links_without_extra_document_or_owner_load', async () => {
  const h=await startHarness();
  await h.session.perform('LOGIN_SESSION',{
    ownerId:'owner-id',username:'synthetic-owner',password:'synthetic-password',
  },()=>{});
  await h.session.perform('OBSERVE_VIEW',{phase:'OBSERVE_BEFORE_RESTART',view:'ROBO'});
  const afterRobo=h.fake.calls.events.filter(event=>event.startsWith('goto:')).length;
  await h.session.perform('OBSERVE_VIEW',{phase:'OBSERVE_BEFORE_RESTART',view:'PORTFOLIO'});
  await h.session.perform('OBSERVE_VIEW',{phase:'OBSERVE_BEFORE_RESTART',view:'ACTIVITY'});
  assert.equal(h.fake.calls.events.filter(event=>event.startsWith('goto:')).length,afterRobo);
  assert.deepEqual(h.fake.calls.selectors.filter(row=>row[0]==='role'&&row[1]==='link').map(row=>row[2].name),['Robo Trader','Portfolio','Activity']);
  await closeHarness(h);
});

test('task15_activity_rows_without_exact_paper_source_fail_closed', async () => {
  const h = await startHarness({ fake: { observationBodies: {
    '/api/paper-trades/orders': [{ symbol: 'AAPL' }],
  } } });
  await h.session.perform('LOGIN_SESSION', {
    ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
  }, () => {});
  await assert.rejects(h.session.perform('OBSERVE_VIEW', {
    phase: 'OBSERVE_BEFORE_RESTART', view: 'ACTIVITY',
  }), { code: 'OBSERVATION_FAILED' });

  const wrongNotifications = await startHarness({ fake: { observationBodies: {
    '/api/robotrader/notifications': { events: [], executionSource: 'local-simulation' },
  } } });
  await wrongNotifications.session.perform('LOGIN_SESSION', {
    ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
  }, () => {});
  await assert.rejects(wrongNotifications.session.perform('OBSERVE_VIEW', {
    phase: 'OBSERVE_BEFORE_RESTART', view: 'ACTIVITY',
  }), { code: 'OBSERVATION_FAILED' });
});

test('task15_changed_cookie_fails_before_readiness_or_view_navigation', async () => {
  let value='private-cookie';const h=await startHarness({fake:{cookie:()=>({value})}});
  await h.session.perform('LOGIN_SESSION', {
    ownerId:'owner-id',username:'synthetic-owner',password:'synthetic-password',
  },()=>{});
  const before=h.fake.calls.events.filter(event=>event.startsWith('goto:')).length;value='replacement-cookie';
  await assert.rejects(h.session.perform('OBSERVE_VIEW', {
    phase:'OBSERVE_BEFORE_RESTART',view:'ROBO',
  }),{code:'SESSION_MISMATCH',workerCode:'SESSION_CHANGED'});
  assert.equal(h.fake.calls.events.filter(event=>event.startsWith('goto:')).length,before);
  assert.equal(h.fake.calls.events.filter(event=>event.startsWith('evaluate:')).length,0);
});

test('task15_observation_navigation_keeps_route_decision_loop_live', async () => {
  const h = await startHarness({ fake: { routeOnObservation: 'first' } });
  await h.session.perform('LOGIN_SESSION', {
    ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
  }, () => {});
  const action = h.session.perform('OBSERVE_VIEW', { phase: 'OBSERVE_BEFORE_RESTART', view: 'ROBO' });
  const outcome = await Promise.race([
    action.then(() => 'DONE',error=>'ERROR:'+error.code),
    new Promise(resolve => setTimeout(() => resolve('BLOCKED'), 100)),
  ]);
  assert.equal(outcome, 'ERROR:ROUTE_DENIED');
  // The controller's latch can reject the action before the worker's route handler records its abort.
  assert.equal(await settled(() => h.fake.calls.observationRouteDispositions?.length === 1), true);
  assert.equal(h.session.failureCode(), 'ROUTE_DENIED');
  assert.deepEqual(h.fake.calls.observationRouteDispositions, ['ABORT']);
});

test('task15_rendered_counts_require_each_visible_row_and_portfolio_chart', async () => {
  const bodies = {
    '/api/paper-trades/orders': [
      { _id:'order-1',symbol:'AAPL',side:'buy',qty:1,status:'open',orderType:'market',filledQty:0,fillPrice:null,
        createdAt:'2026-10-04T00:00:00.000Z',broker:'alpaca',executionSource:'alpaca-paper' },
      { _id:'order-2',symbol:'AAPL',side:'buy',qty:1,status:'open',orderType:'market',filledQty:0,fillPrice:null,
        createdAt:'2026-10-04T00:01:00.000Z',broker:'alpaca',executionSource:'alpaca-paper' },
    ],
  };
  const missingRow = await startHarness({ fake: { observationBodies: bodies, textCounts: { AAPL: 1 } } });
  await missingRow.session.perform('LOGIN_SESSION', {
    ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
  }, () => {});
  await assert.rejects(missingRow.session.perform('OBSERVE_VIEW', {
    phase: 'OBSERVE_BEFORE_RESTART', view: 'ACTIVITY',
  }), { code: 'OBSERVATION_FAILED' });

  const visibleRows = await startHarness({ fake: { observationBodies: bodies, textCounts: { AAPL: 2 } } });
  await visibleRows.session.perform('LOGIN_SESSION', {
    ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
  }, () => {});
  const visible = await visibleRows.session.perform('OBSERVE_VIEW', {
    phase: 'OBSERVE_BEFORE_RESTART', view: 'ACTIVITY',
  });
  assert.equal(visibleRows.session.inspectResult(visible).renderedCount, 2);
  await closeHarness(visibleRows);

  const missingChart = await startHarness({ fake: { missingChart: true, observationBodies: {
    '/api/paper-trades/equity': [{ timestamp: '2026-10-04T00:00:00.000Z', equity: 100,
      broker: 'alpaca', executionSource: 'alpaca-paper' }],
  } } });
  await missingChart.session.perform('LOGIN_SESSION', {
    ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
  }, () => {});
  await assert.rejects(missingChart.session.perform('OBSERVE_VIEW', {
    phase: 'OBSERVE_BEFORE_RESTART', view: 'PORTFOLIO',
  }), { code: 'OBSERVATION_FAILED' });

  const inconsistentChart = await startHarness({ fake: { chartPath:'M0,-100L1,-50',observationBodies: {
    '/api/paper-trades/equity': [
      { timestamp:'2026-10-04T00:00:00.000Z',equity:100,broker:'alpaca',executionSource:'alpaca-paper' },
      { timestamp:'2026-10-04T00:01:00.000Z',equity:200,broker:'alpaca',executionSource:'alpaca-paper' },
    ],
  } } });
  await inconsistentChart.session.perform('LOGIN_SESSION', {
    ownerId:'owner-id',username:'synthetic-owner',password:'synthetic-password',
  },()=>{});
  await assert.rejects(inconsistentChart.session.perform('OBSERVE_VIEW', {
    phase:'OBSERVE_BEFORE_RESTART',view:'PORTFOLIO',
  }),{code:'OBSERVATION_FAILED'});

  const distortedChart = await startHarness({ fake: { chartPath:'M0,100L1,99L2,0',observationBodies: {
    '/api/paper-trades/equity': [
      { timestamp:'2026-10-04T00:00:00.000Z',equity:100,broker:'alpaca',executionSource:'alpaca-paper' },
      { timestamp:'2026-10-04T00:01:00.000Z',equity:200,broker:'alpaca',executionSource:'alpaca-paper' },
      { timestamp:'2026-10-04T00:02:00.000Z',equity:300,broker:'alpaca',executionSource:'alpaca-paper' },
    ],
  } } });
  await distortedChart.session.perform('LOGIN_SESSION', {
    ownerId:'owner-id',username:'synthetic-owner',password:'synthetic-password',
  },()=>{});
  await assert.rejects(distortedChart.session.perform('OBSERVE_VIEW', {
    phase:'OBSERVE_BEFORE_RESTART',view:'PORTFOLIO',
  }),{code:'OBSERVATION_FAILED'});

  const hiddenEmptyState = await startHarness({ fake: { hiddenText:'No open positions yet.' } });
  await hiddenEmptyState.session.perform('LOGIN_SESSION', {
    ownerId:'owner-id',username:'synthetic-owner',password:'synthetic-password',
  },()=>{});
  await assert.rejects(hiddenEmptyState.session.perform('OBSERVE_VIEW', {
    phase:'OBSERVE_BEFORE_RESTART',view:'PORTFOLIO',
  }),{code:'OBSERVATION_FAILED'});
});

test('task15_robo_render_proof_matches_frontend_filters_limits_and_order_labels', async () => {
  const instant='2026-10-04T00:00:00.000Z';
  const decisions=Array.from({length:11},(_,index)=>({_id:'decision-'+index,environment:'paper',symbol:'D'+index,
    status:'approved',confidenceScore:80,rewardRiskRatio:null,reasoningSummary:null,decidedAt:instant}));
  const orders=Array.from({length:10},(_,index)=>({_id:'order-'+index,environment:'paper',executionSource:'alpaca-paper',
    broker:'alpaca',symbol:'O'+index,side:'buy',status:index===0?'rejected':'open',orderType:'market',timeInForce:'day',
    clientOrderId:null,externalOrderId:null}));
  const positions=Array.from({length:9},(_,index)=>({symbol:'P'+index,qty:'1',market_value:'100',side:'long'}));
  const reconciliation=Array.from({length:5},(_,index)=>({_id:'recon-'+index,environment:'paper',symbol:'R'+index,side:'buy',
    status:'open',reconciliationStatus:'matched',discrepancy:null,lastReconciledAt:instant,updatedAt:instant,createdAt:instant}));
  const h=await startHarness({fake:{observationBodies:{
    '/api/robotrader/decisions?environment=paper&limit=25':{decisions},
    '/api/robotrader/orders?environment=paper&limit=25':{orders},
    '/api/robotrader/performance?environment=paper':{account:{id:'paper-account',status:'ACTIVE',cash:'100',equity:'100',buying_power:'100'},
      summary:{decisions:11,submittedOrders:9,filledOrders:0,rejectedDecisions:0,lastRunAt:null},positions,brokerError:null},
    '/api/robotrader/reconciliation-status?environment=paper':{summary:{total:5,pending:0,discrepancies:0,lastReconciledAt:instant},
      orders:reconciliation,latestDiscrepancies:[],historicalDiscrepancies:[]},
  }}});
  await h.session.perform('LOGIN_SESSION',{ownerId:'owner-id',username:'synthetic-owner',password:'synthetic-password'},()=>{});
  const result=await h.session.perform('OBSERVE_VIEW',{phase:'OBSERVE_BEFORE_RESTART',view:'ROBO'});
  assert.equal(h.session.inspectResult(result).renderedCount,30);
  assert.equal(h.fake.calls.selectors.some(row=>row[0]==='text'&&row[1]==='BUY O1'&&row[2].exact===true),true);
  await closeHarness(h);
});

test('task15_malformed_portfolio_history_and_missing_activity_row_identity_fail', async () => {
  for (const observationBodies of [
    { '/api/paper-trades/equity': [{}] },
    { '/api/paper-trades/orders': [{ broker: 'alpaca', executionSource: 'alpaca-paper' }] },
  ]) {
    const h = await startHarness({ fake: { observationBodies } });
    await h.session.perform('LOGIN_SESSION', {
      ownerId: 'owner-id', username: 'synthetic-owner', password: 'synthetic-password',
    }, () => {});
    const view = Object.hasOwn(observationBodies, '/api/paper-trades/equity') ? 'PORTFOLIO' : 'ACTIVITY';
    await assert.rejects(h.session.perform('OBSERVE_VIEW', {
      phase: 'OBSERVE_BEFORE_RESTART', view,
    }), { code: 'OBSERVATION_FAILED' });
  }
});

// ---- Task 15 (Stage 1 remediation): routing, headers and asset integrity ----

test('authorization_x_header_and_method_override_abort_locally', async () => {
  // T13 I-2 / review D3: credential and method-override headers never reach admission or the network.
  const body = Buffer.from('{"username":"synthetic-owner","password":"synthetic-password"}');
  for (const extra of [
    { authorization: 'Bearer other-identity-jwt', 'x-http-method-override': 'DELETE', 'x-arbitrary': '1' },
    { authorization: 'Bearer other-identity-jwt' },
    { Authorization: 'Bearer other-identity-jwt' },
    { 'proxy-authorization': 'Basic c3ludGhldGljOnZhbHVl' },
    { 'x-http-method-override': 'DELETE' },
    { 'x-method-override': 'DELETE' },
    { 'x-arbitrary': '1' },
    { 'X-Requested-With': 'XMLHttpRequest' },
  ]) {
    const h = await startHarness();
    let continues = 0, aborts = 0;
    await h.fake.calls.routeHandler({
      request: () => ({ method: () => 'POST', url: () => BACKEND + '/api/login',
        headers: () => ({ 'content-type': 'application/json', ...extra }), postDataBuffer: () => Buffer.from(body) }),
      continue: async () => { continues++; }, abort: async () => { aborts++; },
    });
    assert.deepEqual([continues, aborts], [0, 1], JSON.stringify(extra));
    assert.equal(decodedFrames(h.links.logs, 'worker').filter(frame => frame.type === 'ROUTE').length, 0, JSON.stringify(extra));
    assert.equal(h.decisions.length, 0);
    await closeHarness(h);
  }
});

test('non_generated_headers_reach_controller_admission', async () => {
  // T13 I-2: only the fixed browser-generated headers are withheld; every other header is a ROUTE fact.
  const h = await startHarness();
  const generated = { 'user-agent': 'Chromium', 'accept-language': 'en-US', 'accept-encoding': 'gzip, br', referer: FRONTEND + '/login',
    cookie: 'secret-cookie', 'sec-ch-ua': '"Chromium";v="145"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Linux"',
    'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-user': '?1', 'upgrade-insecure-requests': '1' };
  const dispositions = [];
  const send = extra => h.fake.calls.routeHandler({
    request: () => ({ method: () => 'GET', url: () => BACKEND + '/api/me',
      headers: () => ({ accept: 'application/json', origin: FRONTEND, ...generated, ...extra }), postDataBuffer: () => null }),
    continue: async () => { dispositions.push('CONTINUE'); }, abort: async () => { dispositions.push('ABORT'); },
  });
  await send({});
  await send({ foo: 'bar' });
  const routes = decodedFrames(h.links.logs, 'worker').filter(frame => frame.type === 'ROUTE');
  assert.deepEqual(routes.map(frame => frame.payload.headers), [
    [['accept', 'application/json'], ['origin', FRONTEND]],
    [['accept', 'application/json'], ['foo', 'bar'], ['origin', FRONTEND]],
  ]);
  assert.equal(Buffer.concat(h.links.logs.map(row => row.bytes)).toString().includes('secret-cookie'), false);
  // The same request is admitted without `foo`; with it, the policy allowlist denies it and the denial latches.
  assert.deepEqual(dispositions, ['CONTINUE', 'ABORT']);
  assert.equal(await settled(() => h.session.failureCode() !== null), true);
  assert.equal(h.session.failureCode(), 'ROUTE_DENIED');
  assert.equal(await settled(() => h.stops() === 1), true);
});

test('login_document_bytes_validated_against_index_entry', async () => {
  // T13 I-3: SPA documents carry index.html bytes and are validated against the signed /index.html entry.
  const h = await startHarness();
  const index = h.assetProofs.filter(row => row.entry.path === '/index.html');
  assert.equal(index.length, 1);
  assert.deepEqual([...index[0].body], [...INDEX_BODY]);
  assert.equal(index[0].contentType, 'text/html');
  assert.equal(h.fake.calls.documentBodies, 1);
  // Every other SPA document path (/, and the fixed view paths) is validated the same way, for the whole run.
  for (const documentPath of ['/', '/robo', '/portfolio', '/activity']) {
    await h.fake.contextHandlers.response({ url: () => FRONTEND + documentPath, status: () => 200, body: async () => Buffer.from(INDEX_BODY),
      headers: () => ({ 'content-type': 'text/html; charset=utf-8' }) });
  }
  assert.equal(await settled(() => h.assetProofs.filter(row => row.entry.path === '/index.html').length === 5), true);
  assert.equal(h.session.failureCode(), null);
  await closeHarness(h);

  const tampered = Buffer.from(INDEX_BODY); tampered[tampered.length - 8] ^= 0x01;
  const observed = {};
  await assert.rejects(startHarness({ fake: { documentBody: tampered }, observed }), { code: 'OBSERVATION_FAILED' });
  const checked = observed.assetProofs.filter(row => row.entry.path === '/index.html');
  assert.equal(checked.length, 1);
  assert.deepEqual([...checked[0].body], [...tampered]);
  assert.equal(decodedFrames(observed.links.logs, 'worker').some(frame => ['ASSETS', 'READY'].includes(frame.type)), false);
  assert.deepEqual({ ...(await observed.workerResult) }, { status: 'FAILED', code: 'OBSERVATION_FAILED' });
  assert.equal(observed.fake.calls.contextCloses, 1);
  assert.equal(observed.fake.calls.browserCloses, 1);
  assert.equal(observed.stops(), 1);

  // Without a signed /index.html entry a document can never be validated, so READY is never reached:
  // neither when the /login document arrives, nor when no document response is seen at all.
  for (const fake of [{}, { noDocumentResponse: true }]) {
    const unsigned = {};
    await assert.rejects(startHarness({ indexAsset: false, fake, observed: unsigned }), { code: 'OBSERVATION_FAILED' }, JSON.stringify(fake));
    assert.equal(decodedFrames(unsigned.links.logs, 'worker').some(frame => ['ASSETS', 'READY'].includes(frame.type)), false);
    assert.deepEqual(unsigned.assetProofs.map(row => row.entry.path), ['/static/js/main.js']);
    assert.equal(unsigned.stops(), 1);
  }
});

test('post_ready_asset_tamper_latches_and_fails_next_action', async () => {
  // T13 I-3 / review D2: manifest assets are validated for the whole run, repeats included.
  const h = await startHarness();
  const before = h.assetProofs.length;
  await h.fake.contextHandlers.response({ url: () => FRONTEND + '/static/js/main.js', status: () => 200, body: async () => Buffer.from('abc'),
    headers: () => ({ 'content-type': 'application/javascript' }) });
  assert.equal(await settled(() => h.assetProofs.length === before + 1), true);
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.failureCode(), null, 'a valid repeat must not latch');
  await h.fake.contextHandlers.response({ url: () => FRONTEND + '/static/js/main.js', status: () => 200, body: async () => Buffer.from('EVIL-REPLACEMENT-SCRIPT'),
    headers: () => ({ 'content-type': 'application/javascript' }) });
  assert.equal(await settled(() => h.session.failureCode() !== null), true);
  assert.equal(h.assetProofs.length, before + 2);
  assert.deepEqual([...h.assetProofs[before + 1].body], [...Buffer.from('EVIL-REPLACEMENT-SCRIPT')]);
  assert.equal(h.session.failureCode(), 'OBSERVATION_FAILED');
  let filled = 0;
  await assert.rejects(h.session.perform('LOGIN_SESSION', login(), () => { filled++; }), { code: 'OBSERVATION_FAILED' });
  assert.equal(filled, 0);
  assert.equal(decodedFrames(h.links.logs, 'controller').some(frame => frame.type === 'ACTION'), false);
  await assert.rejects(h.session.close(), { code: 'OBSERVATION_FAILED' });
  assert.deepEqual({ ...(await h.workerResult) }, { status: 'FAILED', code: 'OBSERVATION_FAILED' });
  assert.equal(h.fake.calls.contextCloses, 1);
  assert.equal(h.fake.calls.browserCloses, 1);
  assert.equal(h.stops(), 1);
});

test('route_denial_latches_session_and_fails_next_perform', async () => {
  // T13 I-7 / review D7: an admission denial is terminal ROUTE_DENIED, not a swallowed ABORT.
  const h = await startHarness();
  await h.session.perform('LOGIN_SESSION', login(), () => {});
  let disposition;
  await h.fake.calls.routeHandler({
    request: () => ({ method: () => 'POST', url: () => BACKEND + '/api/trade', headers: () => ({ 'content-type': 'application/json' }), postDataBuffer: () => null }),
    continue: async () => { disposition = 'CONTINUE'; }, abort: async () => { disposition = 'ABORT'; },
  });
  assert.equal(disposition, 'ABORT');
  await settled(() => h.stops() === 1);
  await assert.rejects(h.session.perform('OBSERVE_VIEW', { phase: 'OBSERVE_BEFORE_RESTART', view: 'ROBO' }), { code: 'ROUTE_DENIED' });
  assert.equal(decodedFrames(h.links.logs, 'controller').filter(frame => frame.type === 'ACTION').length, 1);
  assert.equal(h.session.failureCode(), 'ROUTE_DENIED');
  assert.equal(h.stops(), 1);
  await assert.rejects(h.session.close(), { code: 'ROUTE_DENIED' });
  assert.equal(h.stops(), 1);

  // An expected timer abort (market status in LOGOUT) is an ABORT that does not latch.
  const timer = await startHarness({ phase: 'LOGOUT' });
  let timerDisposition;
  await timer.fake.calls.routeHandler({
    request: () => ({ method: () => 'GET', url: () => BACKEND + '/api/market/status', headers: () => ({ accept: 'application/json' }), postDataBuffer: () => null }),
    continue: async () => { timerDisposition = 'CONTINUE'; }, abort: async () => { timerDisposition = 'ABORT'; },
  });
  assert.equal(timerDisposition, 'ABORT');
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(timer.session.failureCode(), null);
  assert.equal(timer.session.inspectResult(await timer.session.perform('LOGIN_SESSION', login(), () => {})).kind, 'SESSION_BOUND');
  await closeHarness(timer);
  assert.equal(timer.stops(), 1);
});

test('startup_and_perform_bounded_by_run_expiry', async () => {
  // T13 m-6: the run binding's expiry (wall 200 here) bounds worker startup, controller startup and perform.
  const worker = steppedClock(), workerObserved = {};
  const workerStart = startHarness({ workerClock: worker.clock, observed: workerObserved,
    fake: { gotoHang: () => worker.set([250, 1090]) } });
  assert.equal(await within(workerStart, 2000), 'REJECTED:EXPIRED');
  assert.deepEqual({ ...(await workerObserved.workerResult) }, { status: 'FAILED', code: 'EXPIRED' });
  assert.equal(workerObserved.fake.calls.contextCloses, 1);
  assert.equal(workerObserved.fake.calls.browserCloses, 1);
  assert.equal(workerObserved.stops(), 1);

  const control = steppedClock(), stalled = steppedClock(), controlObserved = {};
  const controlStart = startHarness({ controllerClock: control.clock, workerClock: stalled.clock, observed: controlObserved,
    fake: { gotoHang: () => control.set([200, 1040]) } });
  assert.equal(await within(controlStart, 2000), 'REJECTED:EXPIRED');
  assert.equal(controlObserved.stops(), 1);
  stalled.set([200, 1040]);
  assert.deepEqual({ ...(await controlObserved.workerResult) }, { status: 'FAILED', code: 'EXPIRED' });

  const clock = steppedClock();
  const h = await startHarness({ controllerClock: clock.clock, fake: { evaluateHang: () => clock.set([201, 1041]) } });
  await h.session.perform('LOGIN_SESSION', login(), () => {});
  const actions = () => decodedFrames(h.links.logs, 'controller').filter(frame => frame.type === 'ACTION').length;
  assert.equal(await within(h.session.perform('OBSERVE_VIEW', { phase: 'OBSERVE_BEFORE_RESTART', view: 'ROBO' }), 2000), 'REJECTED:EXPIRED');
  assert.equal(h.session.failureCode(), 'EXPIRED');
  assert.equal(await settled(() => h.stops() === 1), true);
  const sent = actions();
  await assert.rejects(h.session.perform('SESSION_OBSERVATION', {}), { code: 'EXPIRED' });
  assert.equal(actions(), sent);
  await assert.rejects(h.session.close(), { code: 'EXPIRED' });

  // A perform that starts after expiry is refused before any ACTION frame.
  const late = steppedClock(), lateHarness = await startHarness({ controllerClock: late.clock });
  late.set([200, 1040]);
  await assert.rejects(lateHarness.session.perform('LOGIN_SESSION', login(), () => {}), { code: 'EXPIRED' });
  assert.equal(decodedFrames(lateHarness.links.logs, 'controller').some(frame => frame.type === 'ACTION'), false);
  assert.equal(lateHarness.session.failureCode(), 'EXPIRED');
  assert.equal(await settled(() => lateHarness.stops() === 1), true);
});

test('worker_codes_map_to_closed_enum', async () => {
  // T13 m-8: free worker strings never leave browser.cjs as failure codes.
  const wrongOwner = await startHarness({ fake: { ownerId: 'different-owner' } });
  await assert.rejects(wrongOwner.session.perform('LOGIN_SESSION', login(), () => {}), { code: 'IDENTITY_MISMATCH', workerCode: 'OWNER_MISMATCH' });
  const api = controller();
  const closed = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/schema.json'))).definitions.Failure.values;
  assert.equal(typeof api.WORKER_CODE_MAP, 'object');
  assert.equal(Object.isFrozen(api.WORKER_CODE_MAP), true);
  assert.equal(Object.getPrototypeOf(api.WORKER_CODE_MAP), null);
  for (const [code, mapped] of Object.entries(api.WORKER_CODE_MAP)) assert.ok(closed.includes(mapped), code + ' -> ' + mapped);
  for (const code of closed) assert.equal(api.WORKER_CODE_MAP[code], code);
  assert.deepEqual(Object.fromEntries(Object.entries(api.WORKER_CODE_MAP).filter(([code]) => !closed.includes(code))), {
    ACTION_DENIED: 'INVALID_FRAME', FRAME_DENIED: 'INVALID_FRAME', CHANNEL_DENIED: 'INVALID_FRAME', CHANNEL_EOF: 'TRANSPORT_LOST',
    AUTHORITY_LOST: 'ROLE_INVALID', BOOTSTRAP_REQUIRED: 'ROLE_INVALID', ACTIVATION_DENIED: 'ROLE_INVALID', HANDOFF_DENIED: 'ROLE_INVALID',
    NATIVE_EFFECT_FENCE_UNAVAILABLE: 'ROLE_INVALID', CONFIG_INVALID: 'IDENTITY_MISMATCH', RUNTIME_IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
    OWNER_MISMATCH: 'IDENTITY_MISMATCH', COOKIE_INVALID: 'SESSION_MISMATCH', SESSION_CHANGED: 'SESSION_MISMATCH',
    SESSION_INVALID: 'SESSION_MISMATCH', LOGIN_ALREADY_ATTEMPTED: 'REPLAY', CLEANUP_UNCERTAIN: 'CLEANUP_INCOMPLETE',
    FAMILY_UNREADABLE: 'ROLE_INVALID',
  });
  // Through the real session: an action error, the worker's terminal error and a startup error.
  for (const [workerCode, code] of [['OWNER_MISMATCH', 'IDENTITY_MISMATCH'], ['E_PLAYWRIGHT_SELECTOR', 'INTERNAL_FAILURE'],
    ['constructor', 'INTERNAL_FAILURE'], ['__proto__', 'INTERNAL_FAILURE'], ['route_denied', 'INTERNAL_FAILURE']]) {
    const h = await startHarness({ fake: workerCode === 'OWNER_MISMATCH' ? { ownerId: 'different-owner' } : { fillError: workerCode } });
    await assert.rejects(h.session.perform('LOGIN_SESSION', login(), () => {}), { code, workerCode });
    assert.equal(await settled(() => h.session.failureCode() !== null), true);
    assert.equal(h.session.failureCode(), code);
    await assert.rejects(h.session.close(), { code });
  }
  await assert.rejects(startHarness({ fake: { gotoError: 'E_NAVIGATION' } }), { code: 'INTERNAL_FAILURE', workerCode: 'E_NAVIGATION' });
});

test('worker_inner_cleanup_budget_starts_only_at_the_terminal_event', async () => {
  // P56 / P5 (C1, E7): a routine read of the worker's inner cleanup budget never allocates the shared end.
  const api=controller(),fake=fakePlaywright(),runId=crypto.randomBytes(16).toString('hex'),key='6'.repeat(64);
  const binding=compositionBinding(runId),identity={childId:'7'.repeat(32),pipeId:'8'.repeat(32)};
  const routeFixture=budgetFixture({runId,configIdentity:binding.configIdentity,assetPath:'/static/js/main.js',assetBody:Buffer.from('abc'),extraAssets:[INDEX_ASSET]});
  const bundle=receipts.createBrowserAssetBundle(routeFixture.release,routeFixture.assets,routeFixture.trust,routeFixture.releaseBytes,routeFixture.assetBytes);
  const configValue=receipts.inspectBrowserControllerConfig(receipts.createBrowserControllerConfig(routeFixture.release,routeFixture.assets,routeFixture.trust,bundle,
    {runtime:JSON.parse(JSON.stringify(api.RUNTIME_PINS)),paths:{...PATHS}},binding));
  const init=inheritedFrame({version:1,kind:'BROWSER_WORKER_INIT',binding,role:'BROWSER',...identity,channelKeyHex:key});
  const proof={proofDigest:'9'.repeat(64),generation:1,expiresAtMs:190,monotonicDeadlineMs:Number.MAX_SAFE_INTEGER-1},grantId='a'.repeat(32),commitId='b'.repeat(32);
  const prepare=browserBootstrapFrame(binding,key,1,'PREPARE',{grantId,...proof,browserConfig:configValue},identity);
  const queued=[init,prepare],waiters=[],outputFrames=[];
  const deliver=bytes=>{const waiter=waiters.shift();if(waiter)waiter(bytes);else queued.push(bytes);};
  const reader={read:async()=>queued.length?queued.shift():new Promise(resolve=>waiters.push(resolve)),drain:()=>queued.splice(0),close(){}};
  const fsBinding={
    writeSync(fd,bytes,start,length){const value=Buffer.from(bytes.subarray(start,start+length));
      if(value.toString('ascii')!=='WAITING\n'){const frame=JSON.parse(value.subarray(4).toString('ascii'));outputFrames.push(frame);
        if(frame.action==='PREPARED')setImmediate(()=>deliver(browserBootstrapFrame(binding,key,2,'COMMIT',{grantId,reservationId:frame.payload.reservationId,commitId,generation:1},identity)));
        if(frame.action==='REFRESH')setImmediate(()=>deliver(browserBootstrapFrame(binding,key,3,'CURRENT',{requestSequence:frame.sequence,grantId,reservationId:frame.payload.reservationId,commitId,generation:1,...proof,
          eventCheckpoint:{binding,generation:1,sequence:1,sourceIdentity:'c'.repeat(32),lostCount:0}},identity)));
      }return length;},
    closeSync(){},
    readlinkSync(target){const fd=target.split('/').pop();return fd==='3'?'pipe:[3]':fd==='4'?'pipe:[4]':'/dev/null';},
    opendirSync(){const names=['0','1','2','3','4'];return {readSync:()=>names.length?{name:names.shift()}:null,closeSync(){}};},
    readFileSync(target){if(target==='/proc/self/status')return statusText();
      if(/^\/proc\/net\/(unix|tcp6?|udp6?)$/.test(target))return NET_TABLES[target.slice(10)];
      if(target==='/proc/net/dev')return 'Inter-| Receive | Transmit\n face |bytes\n lo: 0\n';
      if(target==='/proc/self/mountinfo')return '36 25 0:32 / / rw,nosuid - tmpfs tmpfs rw\n';throw new Error('unexpected read '+target);},
  };
  // The worker's inner budget runs on the host monotonic clock, so the injected launch clock uses it too.
  const monotonic=()=>Number(process.hrtime.bigint()/1000000n);
  let budget;const seen=[];
  const workerAPI=worker({chromium:fake.chromium},receipts,async(...args)=>{
    budget=args[3];seen.push(['bind',budget.deadline]);
    let routine;try{routine=budget.remaining();}catch(error){routine=error.code;}
    seen.push(['routine-remaining',routine,budget.deadline]);
    const real=await roles.bindBrowserWorkerChannel(...args);
    return Object.freeze({
      async prepare(record){const value=await real.prepare(record);seen.push(['prepared',budget.deadline]);return value;},
      inspectPreparedBrowserConfig:value=>real.inspectPreparedBrowserConfig(value),
      async commitFixedBrowserLaunch(...commit){seen.push(['commit',budget.deadline]);return real.commitFixedBrowserLaunch(...commit);},
    });
  },{process});
  const before=monotonic();
  assert.equal(await workerAPI.inheritedMain(['--inherited'],{fs:fsBinding,reader,clock:{sample:()=>[160,monotonic()]},platform:'linux',arch:'arm64',uid:10002}),1);
  const after=monotonic();
  assert.deepEqual(seen,[['bind',null],['routine-remaining','CLEANUP_NOT_STARTED',null],['prepared',null],['commit',null]]);
  assert.equal(fake.calls.launch.length,0);
  assert.equal(outputFrames.some(frame=>frame.action==='FAILED'),true,JSON.stringify(outputFrames));
  // The native-fence denial is the first terminal event: it started the one 60000 ms end, once.
  assert.ok(Number.isSafeInteger(budget.deadline));
  assert.ok(budget.deadline>=before+60000&&budget.deadline<=after+60000,String(budget.deadline));
  const left=budget.remaining();assert.ok(left>0&&left<=60000,String(left));
  const end=budget.deadline;budget.startTerminal();assert.equal(budget.deadline,end);
});

// ---- Task 15 fix round 1: P69 (exact Chromium accept values) and P70 (redirects are terminal) ----

test('chromium_accept_values_admit_navigation_and_stylesheet_exactly', async () => {
  // P69 / E1: the /login navigation is admitted with each realistic navigation accept value.
  for (const navigationAccept of [NAVIGATION_ACCEPT, NAVIGATION_ACCEPT_NO_SXG]) {
    const h = await startHarness({ phase: 'PREFLIGHT', fake: { initialRoute: true, navigationAccept } });
    assert.equal(h.fake.calls.initialRouteDisposition, 'CONTINUE', navigationAccept);
    const route = decodedFrames(h.links.logs, 'worker').find(frame => frame.type === 'ROUTE');
    assert.deepEqual(route.payload.headers, [['accept', navigationAccept]]);
    assert.equal(h.session.failureCode(), null);
    await closeHarness(h);
  }
  // The CSS bundle (a signed manifest asset) is admitted with the stylesheet accept value.
  const css = await startHarness({ cssAsset: true });
  assert.deepEqual(css.assetProofs.map(row => row.entry.path).sort(), ['/index.html', '/static/css/main.css', '/static/js/main.js']);
  const dispositions = [];
  const sendCss = accept => css.fake.calls.routeHandler({
    request: () => ({ method: () => 'GET', url: () => FRONTEND + CSS_ASSET.path, postDataBuffer: () => null,
      headers: () => ({ accept, referer: FRONTEND + '/login', 'user-agent': 'Chromium', 'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'style', 'sec-ch-ua': '"Chromium";v="145"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Linux"' }) }),
    continue: async () => { dispositions.push('CONTINUE'); }, abort: async () => { dispositions.push('ABORT'); },
  });
  await sendCss(STYLESHEET_ACCEPT);
  assert.deepEqual(dispositions, ['CONTINUE']);
  assert.equal(css.decisions.at(-1).routeId, 'frontend-asset:' + CSS_ASSET.path);
  assert.equal(css.session.failureCode(), null);
  await closeHarness(css);
  // Exact match only: near misses (q-value, spacing, case, order, a prefix) are denied and latch.
  for (const accept of ['text/css,*/*;q=0.2', 'text/css, */*;q=0.1', 'TEXT/CSS,*/*;q=0.1', '*/*;q=0.1,text/css', 'text/css',
    'text/html,application/xhtml+xml', 'application/json,text/plain,*/*']) {
    const h = await startHarness({ cssAsset: true });
    let disposition;
    await h.fake.calls.routeHandler({
      request: () => ({ method: () => 'GET', url: () => FRONTEND + CSS_ASSET.path, headers: () => ({ accept }), postDataBuffer: () => null }),
      continue: async () => { disposition = 'CONTINUE'; }, abort: async () => { disposition = 'ABORT'; },
    });
    assert.equal(disposition, 'ABORT', accept);
    assert.equal(await settled(() => h.session.failureCode() !== null), true, accept);
    assert.equal(h.session.failureCode(), 'ROUTE_DENIED', accept);
  }
});

test('redirects_latch_route_denied', async () => {
  // P70 / E3: redirect hops never pass through the route handler, so any redirect is terminal ROUTE_DENIED.
  const cases = [
    ['307 on POST /api/login', h => h.fake.contextHandlers.response({ url: () => BACKEND + '/api/login', status: () => 307,
      request: () => ({ method: () => 'POST' }), headers: () => ({ location: BACKEND + '/api/other' }), body: async () => Buffer.alloc(0) })],
    ['302 on GET /api/me', h => h.fake.contextHandlers.response({ url: () => BACKEND + '/api/me', status: () => 302,
      request: () => ({ method: () => 'GET' }), headers: () => ({ location: BACKEND + '/api/other' }), body: async () => Buffer.alloc(0) })],
    ['300 on a frontend asset', h => h.fake.contextHandlers.response({ url: () => FRONTEND + '/static/js/main.js', status: () => 300,
      headers: () => ({ 'content-type': 'application/javascript' }), body: async () => Buffer.from('abc') })],
    ['redirected request event', h => h.fake.contextHandlers.request({ url: () => BACKEND + '/api/other', method: () => 'POST',
      redirectedFrom: () => ({ url: () => BACKEND + '/api/login' }) })],
    ['redirected request reaching the route handler', h => h.fake.calls.routeHandler({
      request: () => ({ method: () => 'GET', url: () => BACKEND + '/api/me', headers: () => ({ accept: 'application/json' }), postDataBuffer: () => null,
        redirectedFrom: () => ({ url: () => BACKEND + '/api/old' }) }),
      continue: async () => assert.fail('a redirected request was continued'), abort: async () => {} })],
  ];
  for (const [name, redirect] of cases) {
    const h = await startHarness();
    await h.session.perform('LOGIN_SESSION', login(), () => {});
    await redirect(h);
    assert.equal(await settled(() => h.session.failureCode() !== null), true, name);
    assert.equal(h.session.failureCode(), 'ROUTE_DENIED', name);
    const sent = decodedFrames(h.links.logs, 'controller').filter(frame => frame.type === 'ACTION').length;
    await assert.rejects(h.session.perform('OBSERVE_VIEW', { phase: 'OBSERVE_BEFORE_RESTART', view: 'ROBO' }), { code: 'ROUTE_DENIED' }, name);
    assert.equal(decodedFrames(h.links.logs, 'controller').filter(frame => frame.type === 'ACTION').length, sent, name);
    await assert.rejects(h.session.close(), { code: 'ROUTE_DENIED' }, name);
    assert.deepEqual({ ...(await h.workerResult) }, { status: 'FAILED', code: 'ROUTE_DENIED' }, name);
    assert.equal(h.fake.calls.browserCloses, 1, name);
  }
  // A redirected first navigation never reaches READY.
  const observed = {};
  await assert.rejects(startHarness({ fake: { documentStatus: 302 }, observed }), { code: 'ROUTE_DENIED' });
  assert.equal(decodedFrames(observed.links.logs, 'worker').some(frame => ['ASSETS', 'READY'].includes(frame.type)), false);
  // Non-redirect statuses (including the pre-auth 401 and a 404) and plain requests do not latch.
  const h = await startHarness();
  for (const status of [200, 204, 401, 404]) await h.fake.contextHandlers.response({ url: () => BACKEND + '/api/me', status: () => status,
    request: () => ({ method: () => 'GET' }), headers: () => ({}), body: async () => Buffer.alloc(0) });
  await h.fake.contextHandlers.request({ url: () => BACKEND + '/api/me', method: () => 'GET', redirectedFrom: () => null });
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.failureCode(), null);
  assert.equal(h.session.inspectResult(await h.session.perform('LOGIN_SESSION', login(), () => {})).kind, 'SESSION_BOUND');
  await closeHarness(h);
});

// ---- Task 16: browser provenance (T13 I-8), descriptor inventory (I-6, m-1, m-7) and unbound checks (I-10) ----

const CANARY = 'REVIEW-CANARY-PASSWORD';
function nativeFamily(processes, net) {
  const readers = nativeReaders();
  return () => readers.inspectNativeFamily(fakeProc(processes, net), new Set(CONTROL_TARGETS), 101);
}
function withProcess(pid, change) { const processes = cleanProcesses(); change(processes[pid], processes); return processes; }

test('forged_role_port_cannot_open_session', async () => {
  // Review D4: a duck-typed role port with an otherwise valid-looking pipe and grant.
  const api = controller();
  const cfg = trustedConfig(api), projected = receipts.inspectBrowserControllerConfig(cfg), runId = projected.runBinding.runId;
  const proofs = projected.assetEntries.map(entry => ({ entryId: 'frontend-asset:' + entry.path, hash: entry.hash, sizeMatch: true, hashMatch: true, mimeMatch: true }));
  const inbound = [inheritedFrame({ version: 1, runId, sequence: 1, type: 'ASSETS', payload: { proofs } }),
    inheritedFrame({ version: 1, runId, sequence: 2, type: 'READY', payload: { status: 'READY' } })];
  const written = [];
  const pipe = { audit: () => ({ version: 1, kind: 'TASK13_BROWSER_APPLICATION', runId, maxFrameBytes: 16384 }),
    async read() { return inbound.length ? inbound.shift() : new Promise(() => {}); }, async write(bytes) { written.push(Buffer.from(bytes)); } };
  let activations = 0, rejection = null, session = null;
  const rolePort = { kind: 'BROWSER', async activateOnce() { activations++;
    return { privatePipe: pipe, cleanupRemaining: () => 1000, async stopOwned() { return { status: 'STOPPED', runId }; } }; } };
  try { session = await api.openBrowser(cfg, { rolePort, grant: Object.freeze({}), admissionPort: Object.freeze({}), clock: Object.freeze({ sample: () => [160, 1000] }) }); }
  catch (error) { rejection = error; }
  if (session) session.perform('LOGIN_SESSION', { ownerId: 'owner-id', username: 'synthetic-owner', password: CANARY }, () => {}).catch(() => {});
  for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(rejection?.code, 'BOOTSTRAP_REQUIRED');
  assert.equal(activations, 0);
  assert.equal(Buffer.concat(written).toString('ascii').includes(CANARY), false);
  assert.equal(api.isBrowserSession(session), false);

  // A real adopted role port whose pipe was never adopted as an application pipe: the
  // handoff carried no audit, and one is attached afterwards. The pipe brand refuses it.
  const unadopted = {};
  const runId2 = crypto.randomBytes(16).toString('hex');
  const cfg2 = trustedConfig(api, { runId: runId2 }), entries2 = receipts.inspectBrowserControllerConfig(cfg2).assetEntries;
  const inbound2 = [inheritedFrame({ version: 1, runId: runId2, sequence: 1, type: 'ASSETS', payload: { proofs: entries2.map(entry => ({
    entryId: 'frontend-asset:' + entry.path, hash: entry.hash, sizeMatch: true, hashMatch: true, mimeMatch: true })) } }),
  inheritedFrame({ version: 1, runId: runId2, sequence: 2, type: 'READY', payload: { status: 'READY' } })];
  const written2 = [];
  Object.assign(unadopted, { async read() { return inbound2.length ? inbound2.shift() : new Promise(() => {}); }, async write(bytes) { written2.push(Buffer.from(bytes)); } });
  const handoff = Object.freeze({}), child = Object.freeze({}), grant = Object.freeze({});
  let waiting = true, stops = 0;
  const authority = {
    inspectHandoff: value => value === handoff ? { kind: 'BROWSER', runId: runId2, uid: 10002, child, privatePipe: unadopted, waiting, confined: true } : null,
    inspectGrant: value => value === grant ? { kind: 'BROWSER', runId: runId2, child, purpose: 'CONFINEMENT_PROVED', session: null, remainingMs: 60000 } : null,
    async activate() { waiting = false; }, async stopOwned() { stops++; return { status: 'STOPPED', runId: runId2, child }; },
    async waitExit() { return { status: 'EXITED', runId: runId2, child }; },
  };
  roles.bindRoleBootstrap(authority, runId2).audit(handoff);
  const adopted = roles.adoptRole('BROWSER', handoff);
  unadopted.audit = () => ({ version: 1, kind: 'TASK13_BROWSER_APPLICATION', runId: runId2, maxFrameBytes: 16384 });
  let second = null, secondRejection = null;
  try { second = await api.openBrowser(cfg2, { rolePort: adopted, grant, admissionPort: Object.freeze({}), clock: Object.freeze({ sample: () => [160, 1000] }) }); }
  catch (error) { secondRejection = error; }
  if (second) second.perform('LOGIN_SESSION', { ownerId: 'owner-id', username: 'synthetic-owner', password: CANARY }, () => {}).catch(() => {});
  for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondRejection?.code, 'ROLE_INVALID');
  assert.equal(stops, 1);
  assert.equal(Buffer.concat(written2).toString('ascii').includes(CANARY), false);
  // An adopted port of another role (VERIFIER) is refused before it is activated.
  const verifierRun = crypto.randomBytes(16).toString('hex'), verifierHandoff = Object.freeze({}), verifierChild = Object.freeze({}), verifierPipe = Object.freeze({});
  let verifierCalls = 0;
  roles.bindRoleBootstrap({
    inspectHandoff: value => value === verifierHandoff ? { kind: 'VERIFIER', runId: verifierRun, uid: 10003, child: verifierChild, privatePipe: verifierPipe, waiting: true, confined: true } : null,
    inspectGrant() { verifierCalls++; return null; }, async activate() { verifierCalls++; },
    async stopOwned() { verifierCalls++; return { status: 'STOPPED', runId: verifierRun, child: verifierChild }; },
    async waitExit() { verifierCalls++; return { status: 'EXITED', runId: verifierRun, child: verifierChild }; },
  }, verifierRun).audit(verifierHandoff);
  const verifierPort = roles.adoptRole('VERIFIER', verifierHandoff);
  assert.equal(roles.inspectAdoptedRolePort(verifierPort), true);
  await assert.rejects(api.openBrowser(trustedConfig(api, { runId: verifierRun }), { rolePort: verifierPort, grant: Object.freeze({}),
    admissionPort: Object.freeze({}), clock: Object.freeze({ sample: () => [160, 1000] }) }), { code: 'BOOTSTRAP_REQUIRED' });
  assert.equal(verifierCalls, 0);
  // Control: the same adoption path with a branded pipe opens a branded session.
  const control = await scriptedSession();
  assert.equal(api.isBrowserSession(control.session), true);
  assert.equal(api.isBrowserSession({ ...control.session }), false);
  assert.equal(api.isBrowserSession(Object.create(control.session)), false);
  await control.session.close();
});

test('legacy_confinement_boolean_branch_removed', async () => {
  // T13 I-8 / P28: the self-reported confinement booleans and the HMAC frame path are gone from browser.cjs.
  const source = fs.readFileSync(CONTROLLER, 'utf8');
  for (const legacy of ['channelKeyHex', 'createHmac', 'timingSafeEqual', 'filterInherited', 'noNewPrivs', 'vsockFds', 'consoleFds', 'acceptance:browser:v1'])
    assert.equal(source.includes(legacy), false, legacy);
  // An adopted pipe that later reports the legacy confinement form (and MACs its frames the
  // legacy way) is refused before any frame is read or written.
  let audits = 0;
  const legacyRun = crypto.randomBytes(16).toString('hex');
  const legacy = { version: 1, runId: legacyRun, channelKeyHex: KEY, uid: 10002, noNewPrivs: true, capabilities: 'EMPTY', filterInherited: true,
    procScope: 'BROWSER_FAMILY_ONLY', consoleFds: 0, vsockFds: 0, unexpectedFds: 0, networkDeviceCount: 0, maxFrameBytes: 16384,
    tmpfsPaths: ['/dev/shm', PATHS.cache, PATHS.profile, PATHS.support] };
  const scripted = scriptedBrowser({ runId: legacyRun, legacyMac: KEY,
    controllerAudit: () => ++audits === 1 ? { version: 1, kind: 'TASK13_BROWSER_APPLICATION', runId: legacyRun, maxFrameBytes: 16384 } : legacy });
  const outcome = await within(scripted.opened, 2000);
  assert.equal(outcome, 'REJECTED:ROLE_INVALID');
  assert.equal(scripted.stops(), 1);
  assert.equal(scripted.written(), '');
});

test('vsock_socket_unattributable_fails_inventory', async () => {
  // T13 I-6: a socket is attributed only from /proc/net/{unix,tcp,tcp6,udp,udp6}; vsock has no table.
  const readers = nativeReaders();
  const families = readers.socketInodeFamilies(fakeProc());
  assert.deepEqual(Object.fromEntries([...families.entries()]), { ...SOCKET_INODES });
  const known = new Map(Object.entries(SOCKET_INODES));
  for (const [link, kind] of [['socket:[41001]', 'UNIX'], ['socket:[41002]', 'UNIX'], ['socket:[41003]', 'TCP'], ['socket:[41004]', 'TCP'],
    ['socket:[41005]', 'UDP'], ['socket:[99999]', 'UNKNOWN_SOCKET'], ['socket:[0]', 'UNKNOWN_SOCKET'], ['socket:', 'UNKNOWN_SOCKET'],
    ['socket:[41001] ', 'UNKNOWN_SOCKET'], ['pipe:[41001]', 'PIPE'], ['/dev/null', 'NULL'], ['anon_inode:[eventpoll]', 'OTHER']])
    assert.equal(readers.classifyDescriptor(link, known), kind, link);
  assert.equal(readers.classifyDescriptor('socket:[41001]', new Map()), 'UNKNOWN_SOCKET');
  assert.equal(readers.classifyDescriptor('socket:[41001]', undefined), 'UNKNOWN_SOCKET');
  // A vsock descriptor (inode 99999 is in no table) fails a Chromium child, the browser and the worker itself.
  for (const pid of [203, 202]) {
    const processes = withProcess(pid, row => { row.fds[12] = 'socket:[99999]'; });
    const counts = readers.forbiddenDescriptorCounts(fakeProc(processes), String(pid), new Set(CONTROL_TARGETS), families);
    assert.deepEqual(plainCopy(counts), { consoleFds: 0, unknownSocketFds: 1, unreadableFds: 0, unexpectedFds: 0 });
    await assert.rejects(startHarness({ family: nativeFamily(processes) }), { code: 'ROLE_INVALID' }, String(pid));
  }
  const self = selfProcesses(); self.self.fds[6] = 'socket:[99999]';
  const observed = {};
  await assert.rejects(startHarness({ observed, audit: readers.nativeTopology(fakeProc(self), SELF_INIT) }), { code: 'ACTIVATION_DENIED' });
  assert.deepEqual({ ...(await observed.workerResult) }, { status: 'FAILED', code: 'ROLE_INVALID' });
  // Control: the attributed family and the clean worker view open a session.
  const h = await startHarness({ family: nativeFamily(), audit: readers.nativeTopology(fakeProc(selfProcesses()), SELF_INIT) });
  await closeHarness(h);
});

test('hvc0_vport_console_descriptors_fail', async () => {
  // T13 I-6: the virtio console (console=hvc0), virtio ports and every tty are consoles.
  const readers = nativeReaders(), known = new Map(Object.entries(SOCKET_INODES));
  for (const link of ['/dev/hvc0', '/dev/hvc1', '/dev/vport0p1', '/dev/vport1p2', '/dev/console', '/dev/tty', '/dev/tty1', '/dev/ttyAMA0',
    '/dev/ttyS0', '/dev/pts/0', '/dev/pts/12', '/dev/pts/3 (deleted)'])
    assert.equal(readers.classifyDescriptor(link, known), 'CONSOLE', link);
  for (const [link, kind] of [['/dev/null', 'NULL'], ['/dev/urandom', 'OTHER'], ['/dev/shm/.org.chromium.Chromium.x', 'OTHER'], ['/dev/ptmx', 'OTHER']])
    assert.equal(readers.classifyDescriptor(link, known), kind, link);
  for (const link of ['/dev/hvc0', '/dev/vport0p1', '/dev/console', '/dev/pts/0']) {
    const processes = withProcess(203, row => { row.fds[2] = link; });
    assert.deepEqual(plainCopy(readers.forbiddenDescriptorCounts(fakeProc(processes), '203', new Set(CONTROL_TARGETS))),
      { consoleFds: 1, unknownSocketFds: 0, unreadableFds: 0, unexpectedFds: 0 }, link);
    await assert.rejects(startHarness({ family: nativeFamily(processes) }), { code: 'ROLE_INVALID' }, link);
    const self = selfProcesses(); self.self.fds[2] = link;
    const observed = {};
    await assert.rejects(startHarness({ observed, audit: readers.nativeTopology(fakeProc(self), SELF_INIT) }), { code: 'ACTIVATION_DENIED' }, link);
    assert.deepEqual({ ...(await observed.workerResult) }, { status: 'FAILED', code: 'ROLE_INVALID' }, link);
  }
});

test('unreadable_descriptor_fails', async () => {
  // T13 I-6 / m-7: a readlink error is UNREADABLE; an unreadable Chromium child is FAMILY_UNREADABLE.
  const readers = nativeReaders();
  for (const link of [null, undefined, '', procError('EACCES', 'x')]) assert.equal(readers.classifyDescriptor(link, new Map()), 'UNREADABLE', String(link));
  const unreadableLink = withProcess(203, row => { row.fds[7] = procError('EACCES', '/proc/203/fd/7'); });
  assert.deepEqual(plainCopy(readers.forbiddenDescriptorCounts(fakeProc(unreadableLink), '203', new Set(CONTROL_TARGETS))),
    { consoleFds: 0, unknownSocketFds: 0, unreadableFds: 1, unexpectedFds: 0 });
  for (const [name, processes, net] of [
    ['unreadable descriptor', unreadableLink],
    ['closed descriptor', withProcess(204, row => { row.fds[8] = procError('ENOENT', '/proc/204/fd/8'); })],
    ['unreadable status', withProcess(204, row => { row.status = procError('EACCES', '/proc/204/status'); })],
    ['unreadable descriptor directory', withProcess(204, row => { row.fds = procError('EACCES', '/proc/204/fd'); })],
    ['unreadable children', withProcess(202, row => { row.threads[202] = procError('EACCES', '/proc/202/task/202/children'); })],
    ['vanished child', withProcess(202, row => { row.threads[202] = [203, 205]; })],
    // Fix round 1 (I-1): every thread's children file is read.
    ['unreadable non-main thread children', withProcess(202, row => { row.threads[251] = procError('EACCES', '/proc/202/task/251/children'); })],
    ['vanished child of a non-main thread', withProcess(202, row => { row.threads[251] = [204, 206]; })],
    ['unreadable task directory', withProcess(202, row => { row.threads = procError('EACCES', '/proc/202/task'); })],
    ['malformed task entry', withProcess(202, row => { row.threads = { 202: [203], 251: [204], 'self': [] }; })],
    ['malformed children entry', withProcess(202, row => { row.threads[252] = ['204x']; })],
    ['unreadable socket table', cleanProcesses(), { udp6: procError('EACCES', '/proc/net/udp6') }],
    ['malformed socket table', cleanProcesses(), { unix: 'Num RefCount Inode\n0000000000000000: 00000002 41001\n' }],
    // Well-formed rows under a header whose columns are not the 6.8 layout.
    ['reordered table header', cleanProcesses(), { unix: NET_TABLES.unix.replace('St Inode Path', 'Inode St Path') }],
    // One inode claimed by two families.
    ['inode in two families', cleanProcesses(), { udp6: NET_TABLES.udp6 +
      '  102: 00000000000000000000000001000000:D433 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000 10002        0 41003 2 0000000000000000 0\n' }],
  ]) {
    await assert.rejects(startHarness({ family: nativeFamily(processes, net) }), { code: 'ROLE_INVALID', workerCode: 'FAMILY_UNREADABLE' }, name);
  }
  // The worker's own unreadable descriptor fails its own audit.
  const self = selfProcesses(); self.self.fds[8] = procError('EACCES', '/proc/self/fd/8');
  const observed = {};
  await assert.rejects(startHarness({ observed, audit: readers.nativeTopology(fakeProc(self), SELF_INIT) }), { code: 'ACTIVATION_DENIED' });
  assert.deepEqual({ ...(await observed.workerResult) }, { status: 'FAILED', code: 'ROLE_INVALID' });
});

test('native_readers_parse_fake_proc', () => {
  // T13 I-6: inspectNativeFamily and forbiddenDescriptorCounts run against a fake /proc in the 6.8 formats.
  const readers = nativeReaders();
  const status = { uids: [10002, 10002, 10002, 10002], gids: [10002, 10002, 10002, 10002], noNewPrivs: true, seccomp: 2, capabilities: 'EMPTY' };
  const clean = { consoleFds: 0, unknownSocketFds: 0, unreadableFds: 0, unexpectedFds: 0 };
  assert.deepEqual(plainCopy(readers.inspectNativeFamily(fakeProc(), new Set(CONTROL_TARGETS), 101)), {
    workerPid: 101, browserPid: 202, procScope: 'BROWSER_FAMILY_ONLY', members: [
      { pid: 101, ...status, seccompFilters: 1, ...clean },
      { pid: 202, ...status, seccompFilters: 1, ...clean },
      { pid: 203, ...status, seccompFilters: 3, ...clean },
      { pid: 204, ...status, seccompFilters: 2, ...clean },
    ] });
  // The worker's control pipes are expected only in the worker; in a child they count.
  const leaked = withProcess(202, row => { row.fds[12] = 'pipe:[11]'; row.fds[13] = 'pipe:[12]'; row.fds[14] = '/dev/hvc0';
    row.fds[15] = 'socket:[88888]'; row.fds[16] = procError('EACCES', '/proc/202/fd/16'); });
  assert.deepEqual(plainCopy(readers.forbiddenDescriptorCounts(fakeProc(leaked), '202', new Set(CONTROL_TARGETS))),
    { consoleFds: 1, unknownSocketFds: 1, unreadableFds: 1, unexpectedFds: 2 });
  assert.deepEqual(plainCopy(readers.inspectNativeFamily(fakeProc(leaked), new Set(CONTROL_TARGETS), 101).members[1]),
    { pid: 202, ...status, seccompFilters: 1, consoleFds: 1, unknownSocketFds: 1, unreadableFds: 1, unexpectedFds: 2 });
  // The listing stays open while each descriptor is read, so the reader's own listing descriptor resolves.
  assert.deepEqual(plainCopy(readers.forbiddenDescriptorCounts(fakeProc(), '101', new Set())), clean);
  // procStatus reads all four Uid and Gid fields and both seccomp rows.
  assert.deepEqual(plainCopy(readers.procStatus(fakeProc(withProcess(203, row => { row.status = statusText({ Uid: '10002\t0\t10002\t10002', Seccomp_filters: '4' }); })), '203')),
    { ...status, uids: [10002, 0, 10002, 10002], seccompFilters: 4 });
  // The worker's own view. Fix round 1 (P28): the composition channel key is not copied into it.
  const self = plainCopy(readers.nativeTopology(fakeProc(selfProcesses()), SELF_INIT));
  assert.deepEqual(self, { version: 1, runId: RUN, maxFrameBytes: 16384, ...status, seccompFilters: 1,
    procScope: 'BROWSER_FAMILY_ONLY', ...clean, networkDeviceCount: 0, tmpfsPaths: ['/dev/shm', PATHS.cache, PATHS.profile, PATHS.support] });
});

test('family_walk_reads_every_thread_children', async () => {
  // Fix round 1 (I-1): a child forked by a non-main thread (filed under /proc/<pid>/task/<tid>/children,
  // kernel/fork.c:2632, :2690; fs/proc/array.c:720-770) is a family member and is inspected.
  const readers = nativeReaders();
  const family = plainCopy(readers.inspectNativeFamily(fakeProc(), new Set(CONTROL_TARGETS), 101));
  assert.deepEqual(family.members.map(row => row.pid), [101, 202, 203, 204]);
  assert.equal(family.browserPid, 202);
  // Deeper: a grandchild forked by a non-main thread of a non-main-thread child.
  const deep = cleanProcesses();
  deep[204].threads = { 204: [], 260: [205] };
  deep[205] = { threads: { 205: [] }, status: statusText({ Seccomp_filters: '2' }), fds: { 0: '/dev/null' } };
  assert.deepEqual(plainCopy(readers.inspectNativeFamily(fakeProc(deep), new Set(CONTROL_TARGETS), 101)).members.map(row => row.pid), [101, 202, 203, 204, 205]);
  // A member that only a non-main thread forked fails the run on its own facts: console, vsock, status, control pipe.
  for (const [name, change] of [
    ['console', row => { row.fds[2] = '/dev/hvc0'; }], ['vsock', row => { row.fds[7] = 'socket:[99999]'; }],
    ['seccomp', row => { row.status = statusText({ Seccomp: '0', Seccomp_filters: '0' }); }], ['control pipe', row => { row.fds[8] = 'pipe:[11]'; }],
  ]) {
    await assert.rejects(startHarness({ family: nativeFamily(withProcess(204, change)) }), { code: 'ROLE_INVALID' }, name);
    const deeper = cleanProcesses(); deeper[204].threads = { 204: [], 260: [205] };
    deeper[205] = { threads: { 205: [] }, status: statusText({ Seccomp_filters: '2' }), fds: { 0: '/dev/null' } }; change(deeper[205]);
    await assert.rejects(startHarness({ family: nativeFamily(deeper) }), { code: 'ROLE_INVALID' }, 'grandchild ' + name);
  }
  // The main thread's children come first, so the browser is still the root's first child.
  const root = cleanProcesses(); root[101].threads = { 102: [], 101: [202] };
  assert.equal(plainCopy(readers.inspectNativeFamily(fakeProc(root), new Set(CONTROL_TARGETS), 101)).browserPid, 202);
});

test('route_evidence_claim_refuses_mac_frame_form', async () => {
  // Fix round 1 (P28): the MAC'd frame form is gone, so a ROUTE frame carrying a `mac` key is not route evidence.
  const scripted = await scriptedSession();
  const payload = { runId: scripted.runId, requestId: 'browser-1', sequence: 1, method: 'GET', url: BACKEND + '/api/me',
    headers: [['accept', 'application/json']], byteLength: 0, schema: 'ABSENT' };
  const bare = { version: 1, runId: scripted.runId, sequence: 1, type: 'ROUTE', payload };
  assert.equal(roles.inspectBrowserRequestEvidence(roles.claimBrowserRequestEvidence(scripted.links.controller, inheritedFrame(bare), payload)).requestId, 'browser-1');
  assert.throws(() => roles.claimBrowserRequestEvidence(scripted.links.controller, inheritedFrame({ ...bare, mac: 'a'.repeat(64) }), payload), { code: 'IDENTITY_MISMATCH' });
  await scripted.session.close();
});

const STATUS_VARIANTS = Object.freeze([
  ['Seccomp 0', { Seccomp: '0' }], ['Seccomp 1 (strict)', { Seccomp: '1' }], ['Seccomp 3', { Seccomp: '3' }], ['Seccomp row absent', { Seccomp: null }],
  ['Seccomp 02', { Seccomp: '02' }], ['Seccomp_filters 0', { Seccomp_filters: '0' }], ['Seccomp_filters row absent', { Seccomp_filters: null }],
  ['Seccomp_filters -1', { Seccomp_filters: '-1' }], ['NoNewPrivs 0', { NoNewPrivs: '0' }],
  ...[0, 1, 2, 3].map(index => ['Uid field ' + index, { Uid: ROLE_IDS.map((id, at) => at === index ? 0 : id).join('\t') }]),
  ...[0, 1, 2, 3].map(index => ['Gid field ' + index, { Gid: ROLE_IDS.map((id, at) => at === index ? 10003 : id).join('\t') }]),
  ['Uid three fields', { Uid: '10002\t10002\t10002' }], ['Gid five fields', { Gid: '10002\t10002\t10002\t10002\t10002' }],
  ['Uid row absent', { Uid: null }], ['Gid row absent', { Gid: null }],
]);

test('seccomp_status_requires_mode_2_filters_and_all_uids', async () => {
  // T13 m-1 (Option A m3): Seccomp exactly 2, Seccomp_filters >= 1, all four Uid and all four Gid fields 10002.
  const readers = nativeReaders();
  for (const [name, change] of STATUS_VARIANTS) {
    // A Chromium child (its own seccomp depth is above the worker's) and the worker itself.
    const child = withProcess(204, row => { row.status = statusText({ Seccomp_filters: '2', ...change }); });
    await assert.rejects(startHarness({ family: nativeFamily(child) }), { code: 'ROLE_INVALID' }, 'child ' + name);
    const observed = {};
    await assert.rejects(startHarness({ observed, audit: readers.nativeTopology(fakeProc(selfProcesses({ status: statusText(change) })), SELF_INIT) }),
      { code: 'ACTIVATION_DENIED' }, 'self ' + name);
    assert.deepEqual({ ...(await observed.workerResult) }, { status: 'FAILED', code: 'ROLE_INVALID' }, 'self ' + name);
  }
  // Control: a deeper filter stack (Chromium adds its own filters) is accepted.
  const deep = withProcess(203, row => { row.status = statusText({ Seccomp_filters: '7' }); });
  await closeHarness(await startHarness({ family: nativeFamily(deep), audit: readers.nativeTopology(fakeProc(selfProcesses({ status: statusText({ Seccomp_filters: '2' }) })), SELF_INIT) }));
});

test('native_status_seccomp_checked', async () => {
  // I-10 M2: the native status check reads the seccomp mode, not only NoNewPrivs.
  const readers = nativeReaders();
  const off = withProcess(202, row => { row.status = statusText({ Seccomp: '0', Seccomp_filters: '0' }); });
  await assert.rejects(startHarness({ family: nativeFamily(off) }), { code: 'ROLE_INVALID' });
  const observed = {};
  await assert.rejects(startHarness({ observed, audit: readers.nativeTopology(fakeProc(selfProcesses({ status: statusText({ Seccomp: '0', Seccomp_filters: '0' }) })), SELF_INIT) }),
    { code: 'ACTIVATION_DENIED' });
  assert.deepEqual({ ...(await observed.workerResult) }, { status: 'FAILED', code: 'ROLE_INVALID' });
  await closeHarness(await startHarness({ family: nativeFamily() }));
});

test('family_reinspected_after_first_load', async () => {
  // T13 m-7: the family is inspected after launch and again after the first page load, before READY (so before credentials).
  const h = await startHarness();
  const [first, second, ...rest] = h.inspections(), events = h.fake.calls.events;
  assert.deepEqual(rest, []);
  assert.ok(first <= events.indexOf('route'), 'first inspection precedes routing: ' + first);
  assert.ok(second > events.indexOf('load'), 'second inspection follows the first page load: ' + second);
  await closeHarness(h);
  // A console, an unattributed socket or a status failure that appears only after the page load stops the run before READY.
  for (const later of [member(204, { consoleFds: 1 }), member(204, { unknownSocketFds: 1 }), member(204, { seccomp: 0 })]) {
    const observed = {};
    await assert.rejects(startHarness({ observed, family: call => call === 1 ? family() : family({ members: Object.freeze([...family().members, later]) }) }),
      { code: 'ROLE_INVALID' });
    assert.equal(observed.inspections().length, 2);
    assert.equal(decodedFrames(observed.links.logs, 'worker').some(frame => ['ASSETS', 'READY'].includes(frame.type)), false);
    assert.equal(observed.fake.calls.selectors.some(row => row[0] === 'placeholder'), false);
    assert.equal(observed.fake.calls.browserCloses, 1);
  }
  // Unreadable Chromium children after the load: the explicit FAMILY_UNREADABLE code.
  const unreadable = {};
  await assert.rejects(startHarness({ observed: unreadable, family: call => { if (call === 2) throw Object.assign(new Error('FAMILY_UNREADABLE'), { code: 'FAMILY_UNREADABLE' }); return family(); } }),
    { code: 'ROLE_INVALID', workerCode: 'FAMILY_UNREADABLE' });
  assert.equal(decodedFrames(unreadable.links.logs, 'worker').some(frame => ['ASSETS', 'READY'].includes(frame.type)), false);
  const unreadableMember = {};
  await assert.rejects(startHarness({ observed: unreadableMember, family: call => call === 1 ? family() : family({ members: Object.freeze([...family().members, member(204, { unreadableFds: 1 })]) }) }),
    { code: 'ROLE_INVALID', workerCode: 'FAMILY_UNREADABLE' });
});

test('controller_asset_proof_validation_bound', async () => {
  // I-10 M7: the controller checks the worker's asset proofs itself.
  const good = await scriptedSession({ extraAssets: [INDEX_ASSET] });
  await good.session.close();
  const first = (proofs, change) => [{ ...proofs[0], ...change }, ...proofs.slice(1)];
  for (const [name, change, code] of [
    ['wrong hash', proofs => first(proofs, { hash: 'f'.repeat(64) }), 'OBSERVATION_FAILED'],
    ['hash mismatch', proofs => first(proofs, { hashMatch: false }), 'OBSERVATION_FAILED'],
    ['size mismatch', proofs => first(proofs, { sizeMatch: false }), 'OBSERVATION_FAILED'],
    ['mime mismatch', proofs => first(proofs, { mimeMatch: false }), 'OBSERVATION_FAILED'],
    ['unknown entry', proofs => first(proofs, { entryId: 'frontend-asset:/static/js/other.js' }), 'OBSERVATION_FAILED'],
    ['duplicate entry', proofs => [proofs[0], proofs[0]], 'OBSERVATION_FAILED'],
    ['missing proof', proofs => proofs.slice(1), 'OBSERVATION_FAILED'],
    ['no proofs', () => [], 'OBSERVATION_FAILED'],
    ['extra proof key', proofs => first(proofs, { extra: true }), 'FRAME_DENIED'],
  ]) {
    const scripted = scriptedBrowser({ extraAssets: [INDEX_ASSET], proofs: change });
    assert.equal(await within(scripted.opened, 2000), 'REJECTED:' + code, name);
    assert.equal(scripted.stops(), 1, name);
    assert.equal(scripted.actions().length, 0, name);
  }
});

test('controller_discards_password_reference_after_filled', async () => {
  // I-10 M18: at FILLED the controller blanks and drops the caller's password reference, before any result.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const scripted = await scriptedSession({ hooks: { beforeBound: () => gate } });
  const payload = login();
  let filled = 0;
  const pending = scripted.session.perform('LOGIN_SESSION', payload, () => { filled++; });
  assert.equal(await settled(() => filled === 1), true);
  assert.equal(payload.password, '');
  release();
  assert.equal(scripted.session.inspectResult(await pending).kind, 'SESSION_BOUND');
  await scripted.session.close();
});

test('controller_run_binding_checked', async () => {
  // I-10 M23: an adopted pipe for a different run than the controller config is refused.
  const scripted = scriptedBrowser({ pipeRunId: crypto.randomBytes(16).toString('hex') });
  assert.equal(await within(scripted.opened, 2000), 'REJECTED:ROLE_INVALID');
  assert.equal(scripted.stops(), 1);
  assert.equal(scripted.written(), '');
});

test('duplicate_session_cookie_rejected', async () => {
  // I-10 M17: exactly one daytrader_session cookie; two, or none, fail.
  for (const fake of [{ duplicateCookie: true }, { cookie: { name: 'other_session' } }]) {
    const h = await startHarness({ fake });
    await assert.rejects(h.session.perform('LOGIN_SESSION', login(), () => {}), { code: 'SESSION_MISMATCH', workerCode: 'COOKIE_INVALID' }, JSON.stringify(fake));
  }
});

test('owner_username_checked', async () => {
  // I-10 M4: /api/me must name the expected owner username as well as the id.
  const h = await startHarness({ fake: { ownerUsername: 'different-username' } });
  await assert.rejects(h.session.perform('LOGIN_SESSION', login(), () => {}), { code: 'IDENTITY_MISMATCH', workerCode: 'OWNER_MISMATCH' });
});

test('robo_paper_health_connected_required', async () => {
  // I-10 M20: ROBO requires the PAPER health `connected` flag.
  const health = { mongo: { connected: true, status: 'connected' },
    alpaca: { paper: { connected: false, error: null, tradingBlocked: false, accountStatus: 'ACTIVE', buyingPower: 100 } },
    scheduler: { phase1WorkerEnabled: false } };
  const h = await startHarness({ fake: { observationBodies: { '/api/robotrader/health': health } } });
  await h.session.perform('LOGIN_SESSION', login(), () => {});
  await assert.rejects(h.session.perform('OBSERVE_VIEW', { phase: 'OBSERVE_BEFORE_RESTART', view: 'ROBO' }), { code: 'OBSERVATION_FAILED' });
});

test('alert_role_error_state_fails', async () => {
  // I-10 M25: a visible role=alert error state fails the view.
  const h = await startHarness({ fake: { alertCount: 1 } });
  await h.session.perform('LOGIN_SESSION', login(), () => {});
  await assert.rejects(h.session.perform('OBSERVE_VIEW', { phase: 'OBSERVE_BEFORE_RESTART', view: 'PORTFOLIO' }), { code: 'OBSERVATION_FAILED' });
});

test('popup_route_check_bound_with_policy_allowed_path', async () => {
  // I-10 M11: a popup's request is aborted in the worker even for a path the policy allows (GET /api/me).
  const h = await startHarness();
  const popup = { close: async () => {} };
  await h.fake.contextHandlers.page(popup);
  const me = page => ({ method: () => 'GET', url: () => BACKEND + '/api/me', headers: () => ({ accept: 'application/json', origin: FRONTEND }),
    postDataBuffer: () => null, frame: () => ({ page: () => page }) });
  const route = async page => { let disposition; await h.fake.calls.routeHandler({ request: () => me(page),
    continue: async () => { disposition = 'CONTINUE'; }, abort: async () => { disposition = 'ABORT'; } }); return disposition; };
  assert.equal(await route(popup), 'ABORT');
  assert.equal(decodedFrames(h.links.logs, 'worker').filter(frame => frame.type === 'ROUTE').length, 0);
  assert.equal(h.decisions.length, 0);
  // Control: the same request from the primary page is admitted by the policy.
  assert.equal(await route(h.fake.page), 'CONTINUE');
  assert.equal(decodedFrames(h.links.logs, 'worker').filter(frame => frame.type === 'ROUTE').length, 1);
  assert.equal(h.session.failureCode(), null);
  await closeHarness(h);
});

test('worker_ready_gate_bound', async () => {
  // I-10 M28: an ACTION that reaches the worker before READY is denied without running.
  let hanging;
  const reached = new Promise(resolve => { hanging = resolve; });
  const observed = {};
  const start = startHarness({ observed, fake: { gotoHang: () => hanging() } }).catch(error => error);
  await reached;
  await observed.links.controller.write(inheritedFrame({ version: 1, runId: observed.runId, sequence: 1, type: 'ACTION',
    payload: { actionId: 1, action: 'LOGIN_SESSION', payload: login() } }));
  assert.equal(await settled(() => decodedFrames(observed.links.logs, 'worker').some(frame => frame.type === 'ERROR')), true);
  const error = decodedFrames(observed.links.logs, 'worker').find(frame => frame.type === 'ERROR');
  assert.deepEqual(error.payload, { actionId: 1, code: 'ACTION_DENIED' });
  assert.equal(observed.fake.calls.selectors.some(row => row[0] === 'placeholder'), false);
  assert.equal(decodedFrames(observed.links.logs, 'worker').some(frame => frame.type === 'READY'), false);
  assert.equal((await start) instanceof Error, true);
});

test('route_backlog_bound_at_16', async () => {
  // I-10 M37: while 16 route decisions are pending, a 17th request is aborted locally with no ROUTE frame.
  const h = await startHarness();
  const release = h.links.worker.holdNextWrite();
  const dispositions = new Array(17).fill(null);
  const request = () => ({ method: () => 'GET', url: () => BACKEND + '/api/me', headers: () => ({ accept: 'application/json', origin: FRONTEND }), postDataBuffer: () => null });
  for (let index = 0; index < 17; index++) h.fake.calls.routeHandler({ request,
    continue: async () => { dispositions[index] = 'CONTINUE'; }, abort: async () => { dispositions[index] = 'ABORT'; } });
  assert.equal(await settled(() => dispositions[16] !== null), true);
  assert.equal(dispositions[16], 'ABORT');
  assert.deepEqual(dispositions.slice(0, 16), new Array(16).fill(null));
  release();
  assert.equal(await settled(() => decodedFrames(h.links.logs, 'worker').filter(frame => frame.type === 'ROUTE').length === 16), true);
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(decodedFrames(h.links.logs, 'worker').filter(frame => frame.type === 'ROUTE').length, 16);
});

module.exports = { startHarness, closeHarness, scriptedBrowser, scriptedSession, login, settled, within, decodedFrames, FRONTEND, BACKEND };

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
  delete require.cache[CONTROLLER];
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
      return [Object.assign({ name: 'daytrader_session', value: 'private-cookie', domain: 'backend.example.test', path: '/', secure: true, httpOnly: true, sameSite: 'None' },override||{})]; },
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
    fake, links, workerResult, assetProofs, stops: () => stops, waits: () => waits,
  });
  const clock = options.controllerClock || Object.freeze({ sample: () => [160, 1000] });
  const session = await api.openBrowser(cfg, { rolePort, grant, admissionPort, clock });
  return { api, fake, links, cfg, session, workerResult, assetProofs, decisions:routeFixture.intents, launchEvents,runId:testRun,
    activations: () => activations, stops: () => stops, waits: () => waits, cleanupStarted: () => cleanupStarted };
}

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
    readdirSync(){return ['0','1','2','3','4'];},
    readFileSync(target){if(target==='/proc/self/status')return 'Uid:\t10002\t10002\t10002\t10002\nNoNewPrivs:\t1\nSeccomp:\t2\nCapEff:\t0000000000000000\n';
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

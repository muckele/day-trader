// Test-process preload only. Production destination/account validation still runs.
// Never import this from application code or enable it via a production flag.
require('./local-network-only.cjs');
const axios = require('../../backend/node_modules/axios/dist/node/axios.cjs');
const target = new URL(process.env.ACCEPTANCE_PROVIDER_URL || '');
if (process.env.NODE_ENV !== 'test' || target.hostname !== '127.0.0.1' || target.protocol !== 'http:' || process.env.BROKER_API_KEY !== 'acceptance-dummy') throw new Error('Isolated acceptance transport configuration required');
const adapter = axios.getAdapter('http');
const allowed = new Set(['https://paper-api.alpaca.markets', 'https://data.alpaca.markets', 'https://finnhub.io']);
const barrierWaiters = new Map();
async function barrier(name, detail = {}) {
  if (!process.send) throw new Error('IPC required for controlled process barrier');
  process.send({ type: 'rc-barrier', name, ...detail });
  await new Promise(resolve => barrierWaiters.set(name, resolve));
}
process.on('message', message => {
  if (message?.type === 'rc-release') {
    barrierWaiters.get(message.name)?.();
    barrierWaiters.delete(message.name);
  }
});
let writeHeld = false;
let retryableCallbackActive = false;
axios.defaults.adapter = async config => {
  const original = new URL(config.url, config.baseURL);
  if (!allowed.has(original.origin) || original.protocol !== 'https:') throw new Error('Acceptance transport blocked unexpected provider destination');
  if (retryableCallbackActive && ['post', 'patch', 'delete'].includes(String(config.method).toLowerCase())) throw new Error('Broker mutation attempted inside retryable Mongo callback');
  if (process.env.RC_HOLD_TRANSPORT === 'true' && !writeHeld && ['post', 'patch', 'delete'].includes(String(config.method).toLowerCase())) {
    writeHeld = true;
    await barrier('transport', { method: config.method, path: original.pathname, payload: config.data });
  }
  return adapter({...config,baseURL:undefined,url:target.origin+original.pathname+original.search,proxy:false,headers:{...config.headers,'x-provider-host':original.hostname}});
};

// Controlled server wall-clock advancement exercises expiration of real issued sessions.
const actualNow=Date.now;let clockOffset=0;
Date.now=()=>actualNow()+clockOffset;
process.on('message',message=>{if(message?.type==='acceptance-clock'&&Number.isSafeInteger(message.offsetMs)){clockOffset=message.offsetMs;process.send?.({type:'acceptance-clock-set'});}});

// The wrappers below control database/heartbeat completion at the dependency
// boundary. Real Mongo writes and the production transaction callback still run.
if (process.env.RC_HOLD_RENEWAL || process.env.RC_CONTROL_HEARTBEAT === 'true') {
  const Lock = require('../../backend/models/RoboLock');
  const update = Lock.updateOne.bind(Lock);
  let renewals = 0, heartbeat, failHeartbeat = false;
  Lock.updateOne = function(filter, mutation, options) {
    if (!filter.lockedUntil?.$gt || options?.session) return update(filter, mutation, options);
    return (async () => {
      renewals++;
      if (failHeartbeat) { failHeartbeat = false; throw new Error('Controlled heartbeat database failure'); }
      if (renewals === Number(process.env.RC_HOLD_RENEWAL)) await barrier('renewal', { renewal: renewals });
      return update(filter, mutation, options);
    })();
  };
  const interval = global.setInterval;
  global.setInterval = function(callback, delay, ...args) {
    if (new Error().stack.includes('startWorkerLockHeartbeat')) heartbeat = callback;
    return interval(callback, delay, ...args);
  };
  process.on('message', message => {
    if (message?.type === 'rc-heartbeat-failure') {
      if (!heartbeat) throw new Error('Production heartbeat was not installed');
      failHeartbeat = true;
      heartbeat();
      setImmediate(() => process.send?.({ type: 'rc-heartbeat-failed' }));
    }
  });
}
if (['RC_AMBIGUOUS_DISPATCH_COMMIT', 'RC_RETRY_DISPATCH_TRANSACTION', 'RC_ABORT_DISPATCH_TRANSACTION'].some(name => process.env[name] === 'true')) {
  const mongoose = require('../../backend/node_modules/mongoose');
  const save = mongoose.Model.prototype.save;
  mongoose.Model.prototype.save = function(options) {
    if (options?.session && this.constructor.modelName === 'OrderIntent' && Object.keys(this.dispatchClaims || {}).length) options.session.rcContainsDispatch = true;
    return save.call(this, options);
  };
  const update = mongoose.Model.updateOne;
  mongoose.Model.updateOne = function(filter, mutation, options) {
    if (options?.session && this.modelName === 'OrderIntent' && Object.keys(mutation.$set || {}).some(key => key.startsWith('dispatchClaims.'))) options.session.rcContainsDispatch = true;
    return update.call(this, filter, mutation, options);
  };
  const startSession = mongoose.startSession.bind(mongoose);
  mongoose.startSession = async (...args) => {
    const session = await startSession(...args);
    const withTransaction = session.withTransaction.bind(session);
    session.withTransaction = async (...params) => {
      const callback = params[0];
      let injected = false;
      params[0] = async (...args) => {
        retryableCallbackActive = true;
        try {
          const result = await callback(...args);
          if (session.rcContainsDispatch && !injected && process.env.RC_RETRY_DISPATCH_TRANSACTION === 'true') {
            injected = true;
            process.send?.({ type: 'rc-transaction-retry' });
            const error = new mongoose.mongo.MongoServerError({ message: 'Controlled dispatch write conflict' });
            error.addErrorLabel('TransientTransactionError');
            throw error;
          }
          if (session.rcContainsDispatch && process.env.RC_ABORT_DISPATCH_TRANSACTION === 'true') {
            process.send?.({ type: 'rc-transaction-abort' });
            throw new Error('Controlled database failure before dispatch commit');
          }
          return result;
        } finally { retryableCallbackActive = false; }
      };
      const result = await withTransaction(...params);
      if (session.rcContainsDispatch && process.env.RC_AMBIGUOUS_DISPATCH_COMMIT === 'true') {
        process.send?.({ type: 'rc-ambiguous-commit', committed: true });
        throw Object.assign(new Error('Controlled dispatch commit acknowledgment lost'), { errorLabels: ['UnknownTransactionCommitResult'] });
      }
      return result;
    };
    return session;
  };
}

'use strict';

const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { chromium } = require('playwright');
const { validateAssetResponse, importBrowserAssetBundle } = require('./receipts.cjs');
const { bindBrowserWorkerChannel } = require('./role-ports.cjs');
const RUNTIME_PINS = require('../package.json').acceptanceRuntime;

function fail(code, cause) { const error = new Error(code, cause ? { cause } : undefined); error.code = code; throw error; }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function equal(left, right) { return canonical(left) === canonical(right); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('FRAME_DENIED');
}
function safe(value, minimum = 1) { return Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum; }
function sessionAction(action,payload) {
  if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('ACTION_DENIED');
  if(action==='LOGIN_SESSION'){
    exact(payload,['ownerId','password','username']);
    if(typeof payload.ownerId!=='string'||payload.ownerId.length<1||payload.ownerId.length>256||/[\0\r\n]/.test(payload.ownerId)||
       typeof payload.username!=='string'||payload.username.length<1||payload.username.length>512||/[\0\r\n]/.test(payload.username)||
       typeof payload.password!=='string'||payload.password.length<1||payload.password.length>4096||/[\0\r\n]/.test(payload.password))fail('ACTION_DENIED');
    return;
  }
  if(action==='SESSION_OBSERVATION'&&Reflect.ownKeys(payload).length===0)return;
  fail('ACTION_DENIED');
}
function meResponse(response,origin) {
  try {const url=new URL(response.url()),request=typeof response.request==='function'?response.request():null;
    return url.origin===origin&&url.pathname==='/api/me'&&!url.search&&!url.hash&&typeof response.status==='function'&&response.status()===200&&
      (!request||typeof request.method!=='function'||request.method()==='GET');}
  catch{return false;}
}
async function sessionSnapshot(context,response,backend,expectedOwner,key) {
  if(!response||typeof response.status!=='function'||response.status()!==200||typeof response.json!=='function')fail('OWNER_MISMATCH');
  let body;try{body=await response.json();}catch{fail('OWNER_MISMATCH');}
  if(!body||typeof body!=='object'||Array.isArray(body)||!body.user||typeof body.user!=='object'||Array.isArray(body.user)||
      body.user.id!==expectedOwner.id||body.user.username!==expectedOwner.username)fail('OWNER_MISMATCH');
  const url=new URL(backend),cookies=await context.cookies([backend]),matches=cookies.filter(cookie=>cookie&&cookie.name==='daytrader_session');
  if(matches.length!==1)fail('COOKIE_INVALID');const cookie=matches[0];
  if(typeof cookie.value!=='string'||cookie.value.length<1||cookie.value.length>4096||cookie.domain!==url.hostname||cookie.domain.startsWith('.')||
      cookie.path!=='/'||cookie.secure!==true||cookie.httpOnly!==true||cookie.sameSite!=='None')fail('COOKIE_INVALID');
  const fingerprint=createHmac('sha256',key).update('acceptance:session-cookie:v1\0','ascii').update(cookie.value,'utf8').digest('hex');
  return Object.freeze({fingerprint});
}
async function bounded(promise,milliseconds) {
  if(!Number.isSafeInteger(milliseconds)||milliseconds<0)fail('CLEANUP_UNCERTAIN');
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('CLEANUP_UNCERTAIN'),{code:'CLEANUP_UNCERTAIN'})),milliseconds);timer.unref?.();})]);}
  finally{clearTimeout(timer);}
}
function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).sort().join(',') !== 'assetBundle,assetEntries,paths,runBinding,runtime' || !equal(config.runtime, RUNTIME_PINS)) fail('CONFIG_INVALID');
  exact(config.paths, ['profile', 'support', 'cache', 'shm']);
  if (!equal(config.paths, { profile: '/run/acceptance/browser/profile', support: '/run/acceptance/browser/support', cache: '/run/acceptance/browser/cache', shm: '/dev/shm' })) fail('CONFIG_INVALID');
  exact(config.runBinding, ['runId', 'manifestIdentity', 'configIdentity', 'expiresAt', 'origins']);
  exact(config.runBinding.origins, ['FRONTEND', 'BACKEND']);
  if (!/^[0-9a-f]{32}$/.test(config.runBinding.runId) || !/^[0-9a-f]{64}$/.test(config.runBinding.manifestIdentity) ||
      !/^[0-9a-f]{64}$/.test(config.runBinding.configIdentity) || !safe(config.runBinding.expiresAt) || config.runBinding.origins.FRONTEND === config.runBinding.origins.BACKEND) fail('CONFIG_INVALID');
  for (const origin of Object.values(config.runBinding.origins)) {
    let parsed; try { parsed = new URL(origin); } catch { fail('CONFIG_INVALID'); }
    if (typeof origin !== 'string' || parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.pathname !== '/' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) fail('CONFIG_INVALID');
  }
  if (!Array.isArray(config.assetEntries) || config.assetEntries.length < 1 || config.assetEntries.length > 256) fail('CONFIG_INVALID');
  const paths = new Set();
  for (const entry of config.assetEntries) {
    exact(entry, ['path', 'hash', 'size', 'mime']);
    if (typeof entry.path !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(entry.path) || entry.path.includes('//') || entry.path.split('/').some(segment => segment === '.' || segment === '..') ||
        entry.path.endsWith('.map') || entry.path === '/static/js/acceptance-missing.js' || !/^[0-9a-f]{64}$/.test(entry.hash) || !safe(entry.size) || entry.size > 16777216 ||
        typeof entry.mime !== 'string' || entry.mime.length < 1 || entry.mime.length > 128 || /[\x00-\x20\x7f]/.test(entry.mime) || paths.has(entry.path)) fail('CONFIG_INVALID');
    paths.add(entry.path);
  }
}
function audit(pipe) {
  if (!pipe || typeof pipe.audit !== 'function' || typeof pipe.inspectBrowserFamily !== 'function') fail('ROLE_INVALID');
  const value = pipe.audit();
  if (!value || value.version !== 1 || value.uid !== 10002 || value.noNewPrivs !== true || value.capabilities !== 'EMPTY' ||
      value.filterInherited !== true || value.procScope !== 'BROWSER_FAMILY_ONLY' || value.consoleFds !== 0 || value.vsockFds !== 0 ||
      value.unexpectedFds !== 0 || value.networkDeviceCount !== 0 || value.maxFrameBytes !== 16384 ||
      !Array.isArray(value.tmpfsPaths) || !equal([...value.tmpfsPaths].sort(), ['/dev/shm', '/run/acceptance/browser/cache', '/run/acceptance/browser/profile', '/run/acceptance/browser/support']) ||
      !/^[0-9a-f]{32}$/.test(value.runId) || !/^[0-9a-f]{64}$/.test(value.channelKeyHex)) fail('ROLE_INVALID');
  return value;
}
function inspectFamily(pipe) {
  const value = pipe.inspectBrowserFamily();
  if (!value || !Number.isSafeInteger(value.workerPid) || value.workerPid < 1 || !Number.isSafeInteger(value.browserPid) || value.browserPid < 1 ||
      value.procScope !== 'BROWSER_FAMILY_ONLY' || !Array.isArray(value.members) || value.members.length < 2) fail('ROLE_INVALID');
  for (const member of value.members) if (!member || !Number.isSafeInteger(member.pid) || member.pid < 1 || member.uid !== 10002 ||
      member.filterInherited !== true || member.consoleFds !== 0 || member.vsockFds !== 0 || member.unexpectedFds !== 0) fail('ROLE_INVALID');
  return value;
}
function auditApplication(pipe,runId) {
  if(!pipe||typeof pipe.audit!=='function')fail('ROLE_INVALID');const value=pipe.audit();
  if(!value||value.version!==1||value.kind!=='TASK13_BROWSER_APPLICATION'||value.runId!==runId||value.maxFrameBytes!==16384)fail('ROLE_INVALID');
  return value;
}
function rpc(pipe, facts) {
  let outgoing = 0, incoming = 0, sending=Promise.resolve();
  const outer=facts.kind==='TASK13_BROWSER_APPLICATION';
  const key = outer?null:Buffer.from(facts.channelKeyHex, 'hex');
  function mac(frame, direction) { return createHmac('sha256', key).update('acceptance:browser:v1\0' + direction + '\0' + canonical(frame)).digest('hex'); }
  return Object.freeze({
    write(type, payload) {
      const operation=sending.then(async()=>{
        const bare = { version: 1, runId: facts.runId, sequence: ++outgoing, type, payload };
        const body = Buffer.from(canonical(outer?bare:{ ...bare, mac: mac(bare, 'WORKER_TO_CONTROLLER') }), 'ascii');
        if (body.length > facts.maxFrameBytes) fail('FRAME_DENIED');
        const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); await pipe.write(Buffer.concat([prefix, body]));
      });
      sending=operation.catch(()=>{});return operation;
    },
    async read() {
      const bytes = await pipe.read();
      if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.length > facts.maxFrameBytes + 4 || bytes.readUInt32BE() !== bytes.length - 4) fail('FRAME_DENIED');
      const body = bytes.subarray(4); if (body.some(value => value > 127)) fail('FRAME_DENIED');
      const text = body.toString('ascii'); let frame; try { frame = JSON.parse(text); } catch { fail('FRAME_DENIED'); }
      if (canonical(frame) !== text) fail('FRAME_DENIED');
      exact(frame, outer?['version','runId','sequence','type','payload']:['version', 'runId', 'sequence', 'type', 'payload', 'mac']);
      if (frame.version !== 1 || frame.runId !== facts.runId || frame.sequence !== incoming + 1 || !safe(frame.sequence) || typeof frame.type !== 'string') fail('FRAME_DENIED');
      if(!outer){if(typeof frame.mac!=='string')fail('FRAME_DENIED');const bare = { ...frame }; delete bare.mac; const expected = mac(bare, 'CONTROLLER_TO_WORKER');
        if (!/^[0-9a-f]{64}$/.test(frame.mac) || !timingSafeEqual(Buffer.from(frame.mac, 'hex'), Buffer.from(expected, 'hex'))) fail('FRAME_DENIED');}
      incoming++;
      return frame;
    },
  });
}
function loginJSON(bytes) {
  if (bytes.length > 16384) return false;
  const token = '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
  const pattern = new RegExp('^[ \\t\\r\\n]*\\{[ \\t\\r\\n]*(' + token + ')[ \\t\\r\\n]*:[ \\t\\r\\n]*(' + token + ')[ \\t\\r\\n]*,[ \\t\\r\\n]*(' + token + ')[ \\t\\r\\n]*:[ \\t\\r\\n]*(' + token + ')[ \\t\\r\\n]*\\}[ \\t\\r\\n]*$');
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), match = pattern.exec(text);
    if (!match) return false;
    const keys = [JSON.parse(match[1]), JSON.parse(match[3])].sort();
    return keys[0] === 'password' && keys[1] === 'username';
  } catch { return false; }
}
function bodyProof(runId, requestId, sequence, method, url, headers, bytes) {
  let schema = 'INVALID';
  if (method === 'POST' && new URL(url).pathname === '/api/login' && headers['content-type'] === 'application/json' && loginJSON(bytes)) schema = 'LOGIN_JSON';
  else if (bytes.length === 0) schema = 'ABSENT';
  return { runId, requestId, sequence, method, url,
    headers:Object.entries(headers).sort((a,b)=>a[0].localeCompare(b[0])),byteLength: bytes.length, schema };
}
function factsFor(request, requestId) {
  const admittedHeaders = new Set(['origin', 'content-type', 'accept', 'access-control-request-method', 'access-control-request-headers']);
  const headers = Object.entries(request.headers()).map(([name, value]) => [name.toLowerCase(), String(value)])
    .filter(([name]) => admittedHeaders.has(name)).sort((a, b) => a[0].localeCompare(b[0]));
  const method = request.method(), url = request.url();
  return { requestId, method, url, headers };
}
function launchOptions(config) {
  return {
    executablePath: RUNTIME_PINS.chromium.executablePath,
    chromiumSandbox: true,
    headless: true,
    proxy: { server: 'http://127.0.0.1:3128', bypass: '' },
    ignoreDefaultArgs: ['--disable-dev-shm-usage'],
    args: ['--disable-extensions', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--enable-features=WebRtcHideLocalIpsWithMdns', '--proxy-bypass-list=<-loopback>'],
    env: { HOME: config.paths.support, TMPDIR: config.paths.profile, XDG_CACHE_HOME: config.paths.cache },
  };
}

function inheritedReader(fs,fd=3) {
  if(typeof fs.createReadStream!=='function')fail('CHANNEL_DENIED');
  const stream=fs.createReadStream(null,{fd,autoClose:false}),queue=[],waiters=[];let pending=Buffer.alloc(0),terminal;
  function settle(error){if(terminal)return;terminal=error||Object.assign(new Error('CHANNEL_EOF'),{code:'CHANNEL_EOF'});while(waiters.length)waiters.shift().reject(terminal);}
  stream.on('data',chunk=>{
    if(terminal||!Buffer.isBuffer(chunk))return settle(Object.assign(new Error('FRAME_DENIED'),{code:'FRAME_DENIED'}));
    pending=Buffer.concat([pending,chunk]);
    while(pending.length>=4){const length=pending.readUInt32BE();if(length<1||length>16384)return settle(Object.assign(new Error('FRAME_DENIED'),{code:'FRAME_DENIED'}));
      if(pending.length<length+4)break;const frame=Buffer.from(pending.subarray(0,length+4));pending=pending.subarray(length+4);
      const waiter=waiters.shift();if(waiter)waiter.resolve(frame);else queue.push(frame);
    }
  });
  stream.on('error',settle);stream.on('end',()=>settle());
  return Object.freeze({
    read(){if(queue.length)return Promise.resolve(queue.shift());if(terminal)return Promise.reject(terminal);return new Promise((resolve,reject)=>waiters.push({resolve,reject}));},
    drain(){const frames=queue.splice(0);return frames;},
    close(){stream.destroy();},
  });
}
function writeExactly(fs,fd,bytes) {
  let offset=0;while(offset<bytes.length){const count=fs.writeSync(fd,bytes,offset,bytes.length-offset);if(!Number.isSafeInteger(count)||count<1)fail('CHANNEL_EOF');offset+=count;}
}
function decodeInheritedInit(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length<5||bytes.readUInt32BE()!==bytes.length-4)fail('CHANNEL_DENIED');
  const text=bytes.subarray(4).toString('ascii');let value;try{value=JSON.parse(text);}catch{fail('CHANNEL_DENIED');}
  if(canonical(value)!==text)fail('CHANNEL_DENIED');
  exact(value,['version','kind','binding','role','childId','pipeId','channelKeyHex']);
  if(value.version!==1||value.kind!=='BROWSER_WORKER_INIT'||value.role!=='BROWSER'||
      !/^[0-9a-f]{32}$/.test(value.childId)||!/^[0-9a-f]{32}$/.test(value.pipeId)||!/^[0-9a-f]{64}$/.test(value.channelKeyHex))fail('CHANNEL_DENIED');
  exact(value.binding,['version','runId','manifestDigest','configIdentity','rolePolicyDigest','epoch','expiresAtMs']);
  if(value.binding.version!==1||!/^[0-9a-f]{32}$/.test(value.binding.runId)||
      ['manifestDigest','configIdentity','rolePolicyDigest'].some(key=>!/^[0-9a-f]{64}$/.test(value.binding[key]))||
      !safe(value.binding.epoch)||!safe(value.binding.expiresAtMs))fail('CHANNEL_DENIED');
  return value;
}
function procStatus(fs,pid='self') {
  const text=fs.readFileSync('/proc/'+pid+'/status','utf8'),field=name=>text.match(new RegExp('^'+name+':\\s+(.+)$','m'))?.[1]||'';
  const uid=Number(field('Uid').split(/\s+/)[0]),noNewPrivs=field('NoNewPrivs')==='1',seccomp=Number(field('Seccomp'));
  const capabilities=/^0+$/.test(field('CapEff'));
  return {uid,noNewPrivs,filterInherited:noNewPrivs&&seccomp>0,capabilities:capabilities?'EMPTY':'PRESENT'};
}
function forbiddenDescriptorCounts(fs,pid='self',forbiddenTargets=new Set()) {
  let consoleFds=0,vsockFds=0,unexpectedFds=0;
  for(const name of fs.readdirSync('/proc/'+pid+'/fd'))try{const target=fs.readlinkSync('/proc/'+pid+'/fd/'+name);
    if(/\/dev\/(?:console|tty\d*|pts\/)/.test(target))consoleFds++;
    if(/vsock/i.test(target))vsockFds++;
    if(forbiddenTargets.has(target))unexpectedFds++;
  }catch{}
  return {consoleFds,vsockFds,unexpectedFds};
}
function tmpfsPaths(fs) {
  const required=['/dev/shm','/run/acceptance/browser/cache','/run/acceptance/browser/profile','/run/acceptance/browser/support'],mounts=[];
  for(const line of fs.readFileSync('/proc/self/mountinfo','utf8').split('\n')){const parts=line.split(' '),separator=parts.indexOf('-');
    if(separator>5)mounts.push({path:parts[4],type:parts[separator+1]});}
  return required.filter(path=>mounts.filter(row=>path===row.path||path.startsWith(row.path.endsWith('/')?row.path:row.path+'/'))
    .sort((a,b)=>b.path.length-a.path.length)[0]?.type==='tmpfs').sort();
}
function childPids(fs,pid) {
  const text=fs.readFileSync('/proc/'+pid+'/task/'+pid+'/children','ascii').trim();return text?text.split(/\s+/).map(Number):[];
}
function inspectNativeFamily(fs,controlTargets) {
  const root=process.pid,seen=new Set([root]),queue=[root],members=[];let browserPid=0;
  while(queue.length){const pid=queue.shift(),children=childPids(fs,pid);if(pid===root&&children.length&&!browserPid)browserPid=children[0];
    for(const child of children)if(!seen.has(child)){seen.add(child);queue.push(child);}
    const status=procStatus(fs,pid),fds=forbiddenDescriptorCounts(fs,pid,pid===root?new Set():controlTargets);
    members.push(Object.freeze({pid,uid:status.uid,filterInherited:status.filterInherited,...fds}));
  }
  return Object.freeze({workerPid:root,browserPid,members:Object.freeze(members),procScope:'BROWSER_FAMILY_ONLY'});
}
function nativeTopology(fs,init) {
  const status=procStatus(fs),fds=forbiddenDescriptorCounts(fs),devices=fs.readFileSync('/proc/net/dev','utf8').split('\n').slice(2)
    .map(line=>line.split(':',1)[0].trim()).filter(name=>name&&name!=='lo').length;
  return Object.freeze({version:1,runId:init.binding.runId,channelKeyHex:init.channelKeyHex,maxFrameBytes:16384,uid:status.uid,
    noNewPrivs:status.noNewPrivs,capabilities:status.capabilities,filterInherited:status.filterInherited,procScope:'BROWSER_FAMILY_ONLY',
    ...fds,networkDeviceCount:devices,tmpfsPaths:Object.freeze(tmpfsPaths(fs))});
}
function inheritedPipe(fs,reader,init,initBytes,clock) {
  const command=Object.freeze({fd:3}),result=Object.freeze({fd:4}),queue=[initBytes];
  const controlTargets=new Set([fs.readlinkSync('/proc/self/fd/3'),fs.readlinkSync('/proc/self/fd/4')]);
  const topology=nativeTopology(fs,init),channel={
    audit:()=>Object.freeze({role:'BROWSER',childId:init.childId,pipeId:init.pipeId,channelKeyHex:init.channelKeyHex,
      binding:init.binding,command,result}),
    async read(){return queue.length?queue.shift():reader.read();},
    async write(bytes){writeExactly(fs,4,bytes);},
    drain(){return reader.drain();},
  };
  let cleanupEnd=null;
  const monotonic=()=>Number(process.hrtime.bigint()/1000000n),cleanup={
    get deadline(){return cleanupEnd;},
    remaining(){const now=monotonic();if(cleanupEnd===null)cleanupEnd=now+60000;return Math.max(0,cleanupEnd-now);},
    clamp(end){if(!Number.isSafeInteger(end)||end<0)fail('CLEANUP_UNCERTAIN');const now=monotonic();if(cleanupEnd===null)cleanupEnd=now+60000;cleanupEnd=Math.min(cleanupEnd,end);},
  };
  const pipe={audit:()=>topology,inspectBrowserFamily:()=>inspectNativeFamily(fs,controlTargets)};
  const launchClock=clock&&typeof clock.sample==='function'?clock:Object.freeze({sample:()=>[Date.now(),Number(process.hrtime.bigint()/1000000n)]});
  pipe.launchContext=Object.freeze({channel,expected:channel.audit(),clock:launchClock,cleanupBudget:cleanup});
  return pipe;
}

async function inheritedMain(args,bindings) {
  if(!Array.isArray(args)||args.length!==1||args[0]!=='--inherited')return 64;
  if(!bindings||bindings.platform!=='linux'||bindings.arch!=='arm64'||bindings.uid!==10002||!bindings.fs)return 1;
  let reader;
  try{
    writeExactly(bindings.fs,4,Buffer.from('WAITING\n','ascii'));
    reader=bindings.reader||inheritedReader(bindings.fs);
    const initBytes=await reader.read(),init=decodeInheritedInit(initBytes),result=await runBrowserWorker(inheritedPipe(bindings.fs,reader,init,initBytes,bindings.clock));
    return result?.status==='EXITED'?0:1;
  }catch{return 1;}
  finally{try{reader?.close();}catch{}for(const fd of [3,4])try{bindings.fs.closeSync(fd);}catch{}}
}
function systemBindings() {
  const fs=require('node:fs');return Object.freeze({fs,platform:process.platform,arch:process.arch,uid:typeof process.getuid==='function'?process.getuid():-1});
}
async function main(args=process.argv.slice(2)) {return inheritedMain(args,systemBindings());}

async function runBrowserWorker(pipe, config) {
  let wire, state;
  try {
    const topology = audit(pipe);
    const launch = pipe.launchContext;
    if (!launch || !launch.channel) fail('BOOTSTRAP_REQUIRED');
    const binding = await bindBrowserWorkerChannel(launch.channel, launch.expected, launch.clock, launch.cleanupBudget);
    const prepareRecord=Buffer.isBuffer(launch.prepareRecord)?launch.prepareRecord:await launch.channel.read();
    const reservation = await binding.prepare(prepareRecord);
    const transported=typeof binding.inspectPreparedBrowserConfig==='function'?binding.inspectPreparedBrowserConfig(reservation):null;
    if(config===undefined||config===null)config=transported;
    else if(transported!==null&&!equal(config,transported))fail('CONFIG_INVALID');
    validateConfig(config);
    const imported=importBrowserAssetBundle(config.assetBundle,typeof launch.clock?.sample==='function'?()=>launch.clock.sample()[0]:undefined);
    if(!equal(imported.assets.entries,config.assetEntries))fail('CONFIG_INVALID');
    if (config.runBinding.runId !== topology.runId) fail('RUNTIME_IDENTITY_MISMATCH');
    if(launch.expected?.binding&&(config.runBinding.runId!==launch.expected.binding.runId||
        config.runBinding.configIdentity!==launch.expected.binding.configIdentity||
        config.runBinding.manifestIdentity!==launch.expected.binding.manifestDigest||
        config.runBinding.expiresAt!==launch.expected.binding.expiresAtMs))fail('RUNTIME_IDENTITY_MISMATCH');
    let launched, primaryPending=true, primary;
    const outcome = await binding.commitFixedBrowserLaunch(reservation, async () => {
      let browser, context;
      try {
        browser = await chromium.launch(launchOptions(config));
        context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false });
      } catch (cause) {
        try { if (context) await context.close(); } catch {}
        try { if (browser) await browser.close(); } catch {}
        fail('LAUNCH_FAILED', cause);
      }
      let closed = false,closing;
      const owner = Object.freeze({ async stopOwned(requested) {
        const remaining=typeof launch.cleanupBudget?.remaining==='function'?launch.cleanupBudget.remaining():0;
        const allowance=requested===undefined?remaining:Math.min(remaining,requested);
        if(!closing)closing=Promise.allSettled([Promise.resolve().then(()=>context.close()),Promise.resolve().then(()=>browser.close())]);
        const outcomes=await bounded(closing,allowance);
        if(outcomes.some(value=>value.status!=='fulfilled'))fail('CLEANUP_UNCERTAIN');closed=true;
        return { status: 'STOPPED', runId: topology.runId };
      } });
      launched = { browser, context, owner, get closed() { return closed; } };
      return owner;
    });
    if (!outcome || outcome.status !== 'STARTED' || !launched) fail('LAUNCH_FAILED');state=launched;
    wire=rpc(outcome.applicationPipe,auditApplication(outcome.applicationPipe,topology.runId));
    inspectFamily(pipe);
    const decisions=new Map();launched.decisions=decisions;let ready=false,commandFailure,loginSpent=false,boundSession=null;
    const sessionKey=randomBytes(32);
    const commandLoop=(async()=>{try{while(true){
      const frame=await wire.read();
      if(frame.type==='DECISION'){
        exact(frame.payload,['requestId','decision']);
        if(typeof frame.payload.requestId!=='string'||!['CONTINUE','ABORT'].includes(frame.payload.decision))fail('FRAME_DENIED');
        const slot=decisions.get(frame.payload.requestId);if(!slot)fail('FRAME_DENIED');decisions.delete(frame.payload.requestId);slot.resolve(frame.payload.decision);continue;
      }
      if(frame.type==='ACTION'){
        exact(frame.payload,['actionId','action','payload']);const {actionId,action,payload}=frame.payload;
        if(!ready||!Number.isSafeInteger(actionId)){await wire.write('ERROR',{actionId,code:'ACTION_DENIED'});continue;}
        sessionAction(action,payload);
        if(action==='LOGIN_SESSION'){
          if(loginSpent)fail('LOGIN_ALREADY_ATTEMPTED');loginSpent=true;
          const expectedOwner=Object.freeze({id:payload.ownerId,username:payload.username});
          const response=state.page.waitForResponse(value=>meResponse(value,config.runBinding.origins.BACKEND),{timeout:10000});
          let password=payload.password;
          try{await state.page.getByPlaceholder('Username').fill(payload.username);await state.page.getByPlaceholder('Password').fill(password);}
          finally{password=null;payload.password='';}
          await wire.write('FILLED',{actionId,status:'FILLED'});
          await state.page.getByRole('button',{name:'Log In',exact:true}).click();
          boundSession=await sessionSnapshot(state.context,await response,config.runBinding.origins.BACKEND,expectedOwner,sessionKey);
          boundSession=Object.freeze({...boundSession,expectedOwner});
          await wire.write('RESULT',{actionId,status:'SESSION_BOUND',fingerprint:boundSession.fingerprint});continue;
        }
        if(!boundSession)fail('SESSION_INVALID');
        const response=state.page.waitForResponse(value=>meResponse(value,config.runBinding.origins.BACKEND),{timeout:10000});
        await state.page.reload({waitUntil:'domcontentloaded'});
        const observed=await sessionSnapshot(state.context,await response,config.runBinding.origins.BACKEND,boundSession.expectedOwner,sessionKey);
        await wire.write('RESULT',{actionId,status:'SESSION_OBSERVED',fingerprint:observed.fingerprint});continue;
      }
      if(frame.type==='CLOSE'){exact(frame.payload,[]);const result=await state.owner.stopOwned();await wire.write('EXIT',{status:result.status,runId:result.runId});
        return Object.freeze({status:'EXITED',runId:topology.runId});}
      fail('FRAME_DENIED');
    }}catch(cause){commandFailure=cause;for(const slot of decisions.values())slot.reject(cause);decisions.clear();throw cause;}})();
    commandLoop.catch(()=>{});
    try {
      const validatedAssets = new Map(), assetTasks = [];
      let requestSequence = 0, assetFailure;
      const rejectedPages = new WeakSet();
      launched.context.on('page', async page => { if (primaryPending) { primaryPending = false; primary = page; } else { rejectedPages.add(page); await page.close(); } });
      await launched.context.routeWebSocket('**/*', async socket => socket.close());
      await launched.context.addInitScript(() => { Object.defineProperty(globalThis, 'WebTransport', { configurable: false, value: undefined }); });
      await launched.context.route('**/*', async route => {
        const request = route.request();
        if (typeof request.frame === 'function') { let page; try { page=request.frame().page(); } catch { return route.abort(); }
          if(!page||rejectedPages.has(page)||primary&&page!==primary)return route.abort(); }
        const before=Buffer.from(request.postDataBuffer()||Buffer.alloc(0)),sequence=++requestSequence,requestId='browser-'+sequence;
        const facts=factsFor(request,requestId),proof=bodyProof(topology.runId,requestId,sequence,facts.method,facts.url,Object.fromEntries(facts.headers),before);
        if(proof.schema==='INVALID'||decisions.size>=16)return route.abort();
        const digest=createHash('sha256').update(before).digest(),decision=new Promise((resolve,reject)=>decisions.set(requestId,{resolve,reject}));
        await wire.write('ROUTE',proof);const selected=await decision,after=Buffer.from(request.postDataBuffer()||Buffer.alloc(0));
        if(selected!=='CONTINUE'||before.length!==after.length||!timingSafeEqual(digest,createHash('sha256').update(after).digest()))await route.abort();else await route.continue();
      });
      launched.context.on('response',response=>{const task=(async()=>{
        const url=new URL(response.url()),index=config.assetEntries.findIndex(item=>item.path===url.pathname);if(index<0)return;
        const entry=imported.assets.entries[index];if(url.origin!==config.runBinding.origins.FRONTEND||url.search||url.hash||validatedAssets.has(entry.path))fail('OBSERVATION_FAILED');
        const declared=response.headers()['content-length'];if(declared!==undefined&&(!/^(?:0|[1-9][0-9]*)$/.test(declared)||Number(declared)!==entry.size))fail('OBSERVATION_FAILED');
        const body=await response.body(),type=String(response.headers()['content-type']||'').split(';',1)[0];validatedAssets.set(entry.path,validateAssetResponse(entry,body,type));
      })().catch(cause=>{assetFailure=cause;});assetTasks.push(task);});
      const page=await launched.context.newPage();primary=primary||page;await page.goto(config.runBinding.origins.FRONTEND,{waitUntil:'domcontentloaded'});
      if(typeof page.waitForLoadState==='function')await page.waitForLoadState('load');await Promise.all(assetTasks);
      if(commandFailure)throw commandFailure;
      if(assetFailure||validatedAssets.size!==config.assetEntries.length)fail('OBSERVATION_FAILED',assetFailure);
      launched.page=primary;launched.assetProofs=config.assetEntries.map(entry=>validatedAssets.get(entry.path));
    } catch(cause){try{await launched.owner.stopOwned();}catch{}throw cause;}
    await wire.write('ASSETS', { proofs: state.assetProofs });
    ready=true;
    await wire.write('READY', { status: 'READY' });
    return await commandLoop;
  } catch (cause) {
    const code = cause && cause.code || 'BROWSER_FAILED';
    try { if (state && state.owner) await state.owner.stopOwned(); } catch {}
    try { if (wire) await wire.write('ERROR', { code }); } catch {}
    return Object.freeze({ status: 'FAILED', code });
  }
}

module.exports = Object.freeze({ runBrowserWorker, inheritedMain, main });
if(require.main===module)main().then(code=>{process.exitCode=code;},()=>{process.exitCode=1;});

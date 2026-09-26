'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const policy=require('../tools/policy.cjs'),{B,F}=policy;
const request=(target='/api/market/status',method='GET',host=B,extra=[])=>({method,target,rawHeaders:['host',host,...extra]});
const make=(options={})=>require('../tools/entry-policy.cjs').createEntryPolicy(options);
const cors={'access-control-allow-origin':'https://'+F,'access-control-allow-credentials':'true'};
const pre={headers:cors,status:401,contentType:'application/json; charset=utf-8',body:'{"message":"Missing authentication token"}'};
const authenticated={headers:cors,status:200,contentType:'application/json; charset=utf-8',body:JSON.stringify({status:'OPEN',source:'alpaca-clock',executionSource:'alpaca-paper',asOf:new Date().toISOString(),nextOpen:null,nextClose:null})};
test('market route has auth-aware finite phase costs and expected responses',()=>{
 const d=policy.parseRequest(request());assert.equal(d?.id,'market-status');
 for(const [phase,limit,cost,status] of [['PREFLIGHT',1,0,401],['BEFORE',1,1,200],...['AUTH','HOLD','AFTER','LOGOUT','DONE'].map(p=>[p,0,0,null])]){
  assert.equal(policy.limitFor(d.id,phase),limit);assert.equal(policy.requestCost(d,phase),cost);assert.equal(policy.marketStatusExpected(phase),status);
 }
});
test('exact market method path query host and headers fail closed',()=>{
 for(const req of [request('/api/market/status?'),request('/api/market/status?x=1'),request('/api/market/status?x=&x='),request('/api/market/%73tatus'),request('/api/market/status/'),request('/api/market-status'),request('/api/market/status','POST'),request('/api/market/status','HEAD'),request('/api/market/status','GET',F),request('/api/market/status','GET','wrong.invalid'),request('/api/market/status','GET',B,['Host',B]),request('/api/market/status','GET',B,['x-forwarded-host',B])])assert.equal(policy.parseRequest(req),null);
});
test('diagnostic preserves only reviewed path and safe request metadata',()=>{
 const g=require('../tools/private-leakage.cjs').routeGuard();g.reject('https://'+B+'/api/market/status?secret=never-publish','POST','AUTH');
 const row=g.facts().rejected[0];assert.equal(row.path,'/api/market/status');assert.equal(row.method,'POST');assert.equal(row.phase,'AUTH');assert.equal(row.queryPresent,true);assert.ok(!JSON.stringify(row).includes('never-publish'));
});
test('transition arms once, activates only on login 200, denies each Home GET once then closes',()=>{
 const e=make();const r=request('/api/recommendations'),w=request('/api/watchlist/default');
 assert.equal(e.decide(r,'AUTH',null).kind,'unexpected');e.arm();assert.equal(e.decide(r,'AUTH',null).kind,'unexpected');e.loginResponse(200);
 for(const q of [r,w]){assert.equal(e.decide(q,'AUTH','session').kind,'transition-denied');assert.equal(policy.parseRequest(q),null);}
 assert.equal(e.complete(),true);e.close();assert.equal(e.facts().transition,'CLOSED');assert.equal(e.decide(r,'BEFORE','session').kind,'unexpected');assert.throws(()=>e.arm());
});
test('failed, expired, duplicate, wrong phase and malformed Home requests cannot use transition exception',()=>{
 const failed=make();failed.arm();failed.loginResponse(401);assert.equal(failed.decide(request('/api/recommendations'),'AUTH',null).kind,'unexpected');assert.throws(()=>failed.close());
 let now=0;const e=make({now:()=>now});e.arm();e.loginResponse(200);
 for(const q of [request('/api/recommendations?'),request('/api/recommendations?x=1'),request('/api/recommendations','POST'),request('/api/watchlist/default','GET',F),request('/api/market/quotes','POST'),request('/api/market/sparkline','POST'),request('/api/recommendations','GET',B,['forwarded','secret'])])assert.equal(e.decide(q,'AUTH','session').kind,'unexpected');
 assert.equal(e.decide(request('/api/recommendations'),'BEFORE','session').kind,'unexpected');
 assert.equal(e.decide(request('/api/recommendations'),'AUTH','session').kind,'transition-denied');assert.equal(e.decide(request('/api/recommendations'),'AUTH','session').kind,'unexpected');now=10001;assert.equal(e.decide(request('/api/watchlist/default'),'AUTH','session').kind,'unexpected');assert.throws(()=>e.close());
});
test('preauth receipt survives restart privately and prevents all additional real calls',()=>{
 let saved;const e=make({persistPreauth:r=>saved=r});assert.equal(e.decide(request(),'PREFLIGHT',null).kind,'forward');assert.equal(e.decide(request(),'PREFLIGHT',null).kind,'unexpected');e.capture('PREFLIGHT',pre,null);
 for(let i=0;i<5;i++)assert.deepEqual(e.decide(request(),'PREFLIGHT',null),{kind:'replay',response:pre});
 const restarted=make({preauth:saved});assert.deepEqual(restarted.decide(request(),'PREFLIGHT',null),{kind:'replay',response:pre});assert.equal(restarted.decide(request(),'AUTH','new-session').kind,'block');assert.equal(restarted.facts().preauthReplays,1);
 assert.throws(()=>make({preauth:{...pre,body:'{"message":"fake"}'}}));
});
test('authenticated replay requires real 200 and exact same session and invalidates permanently',()=>{
 const e=make({preauth:pre});assert.equal(e.decide(request(),'BEFORE','one').kind,'forward');assert.equal(e.decide(request(),'BEFORE','one').kind,'unexpected');e.capture('BEFORE',authenticated,'one');
 for(const phase of ['BEFORE','HOLD','AFTER']){const d=e.decide(request(),phase,'one');assert.equal(d.kind,'replay');assert.equal(d.response.body,authenticated.body);}
 assert.equal(e.decide(request('/api/market/status?'),'AFTER','one').kind,'unexpected');
 assert.equal(e.decide(request(),'AFTER','two').kind,'unexpected');assert.equal(e.decide(request(),'AFTER','one').kind,'unexpected');
 for(const cause of ['logout','auth-loss','failure','cleanup']){const p=make();p.decide(request(),'BEFORE','one');p.capture('BEFORE',authenticated,'one');p.invalidate(cause);assert.equal(p.decide(request(),'AFTER','one').kind,'unexpected');}
 assert.equal(make().decide(request(),'AFTER','one').kind,'unexpected');
});
test('capture validates actual response and bounded replay counts',()=>{
 for(const response of [{...pre,status:200},{...pre,contentType:'text/html'},{...pre,body:'secret'},{...pre,body:'x'.repeat(2049)}]){const e=make();e.decide(request(),'PREFLIGHT',null);assert.throws(()=>e.capture('PREFLIGHT',response,null));}
 const e=make({preauth:pre});for(let i=0;i<32;i++)assert.equal(e.decide(request(),'PREFLIGHT',null).kind,'replay');assert.equal(e.decide(request(),'PREFLIGHT',null).kind,'unexpected');
 assert.ok(!JSON.stringify(e.facts()).includes(pre.body));
});
test('expected denial and replay dispatch never invoke forwarding',async()=>{
 const {dispatch}=require('../tools/entry-policy.cjs');let forwards=0,aborts=0,replays=0;const route={continue:async()=>forwards++,abort:async()=>aborts++,fulfill:async r=>{replays++;assert.equal(r.body,pre.body);assert.equal(r.status,401);}};
 await dispatch(route,{kind:'transition-denied'});await dispatch(route,{kind:'replay',response:pre});await dispatch(route,{kind:'unexpected'});assert.equal(forwards,0);assert.equal(aborts,2);assert.equal(replays,1);
});
test('provider clock fixture is a fresh clock accepted by the unchanged application',()=>{
 let handler,body,status;const source=fs.readFileSync(require.resolve('../tools/standin.cjs'),'utf8');
 vm.runInNewContext(source,{require:n=>n==='./transport-observation.cjs'?{gatewayTrace:()=>require('../tools/transport-observation.cjs').noop,observeStandin:()=>({http(){}})}:n==='./security-probe.cjs'?require('../tools/security-probe.cjs'):n==='https'?{createServer:(_,fn)=>(handler=fn,{listen(){}})}:n==='http'?{}:n==='fs'?{readFileSync(){return ''},appendFileSync(){}}:{createServer:()=>({listen(){}})},Date,JSON});
 handler({headers:{host:'paper-api.alpaca.markets'},socket:{servername:'paper-api.alpaca.markets'},method:'GET',url:'/v2/clock'},{writeHead:s=>status=s,end:b=>body=b});assert.equal(status,200);
 const clock=JSON.parse(body),{evaluateBrokerClock}=require('../../../backend/services/brokerClock');assert.equal(evaluateBrokerClock(clock,{nowMs:Date.now()}).valid,true);
});
test('observational navigation uses one document then real SideNav links and main render evidence',async()=>{
 const source=fs.readFileSync(require.resolve('../tools/browser.cjs'),'utf8');const fn=source.slice(source.indexOf('async function view('),source.indexOf('const robo='));let gotos=0;const links=[];
 const page={goto:async()=>gotos++,waitForURL:async()=>{},waitForTimeout:async()=>{},locator:s=>{if(s==='aside')return {getByRole:(role,o)=>({click:async()=>links.push(o.name)})};assert.equal(s,'main');return {innerText:async()=>''}}};
 const view=vm.runInNewContext(fn+';view',{page,sequence:0,responses:[],FRONT:'https://'+F,c:{profile:'test'},routeGuard:{assert(){}},Object,Array});
 await view('/robo',[],true);await view('/portfolio',[]);await view('/activity',[]);await view('/robo',[]);assert.equal(gotos,1);assert.deepEqual(links,['Portfolio','Activity','Robo Trader']);
});
test('real gateway reserves phase cost once and cannot admit timer or Home effects',async()=>{
 const source=fs.readFileSync(require.resolve('../tools/gateway.cjs'),'utf8');let handler,control,journal;const effects=[],logs=[];
 const fakeFs={existsSync:()=>false,readFileSync:()=> '[]',writeFileSync:(p,b)=>{if(p.endsWith('.tmp'))journal=JSON.parse(b)},renameSync(){},appendFileSync:(_,b)=>logs.push(JSON.parse(b)),chmodSync(){}};
 const server={on(){},listen(){}};
 vm.runInNewContext(source,{require:n=>n==='./transport-observation.cjs'?{gatewayTrace:()=>require('../tools/transport-observation.cjs').noop,observeStandin:()=>({http(){}})}:n==='./security-probe.cjs'?require('../tools/security-probe.cjs'):n==='fs'?fakeFs:n==='http'?{createServer:(_,fn)=>(handler=fn,server)}:n==='net'?{createServer:fn=>(control=fn,server)}:n==='./config.cjs'?{load:()=>({run:'synthetic',lock:'lock',capability:'cap',paperAlready:6,paperMaximum:60})}:n==='./policy.cjs'?policy:n==='./private-leakage.cjs'?require('../tools/private-leakage.cjs'):{forward:async(c,d,body,callback)=>{effects.push(d.path);callback({statusCode:d.path==='/api/market/status'&&journal.phase==='PREFLIGHT'?401:200,headers:{},pipe(){}});return {on(){}};}},Buffer,JSON});
 const send=async q=>{let status;await handler({...q,url:q.target,headers:{host:B},async *[Symbol.asyncIterator](){}},{writeHead:s=>status=s,end(){}});return status;};
 function phase(p){let listener;control({setTimeout(){},on:(_,fn)=>listener=fn,end(){},destroy(){}});listener(JSON.stringify({run:'synthetic',capability:'cap',phase:p})+'\n');}
 assert.equal(await send(request()),401);assert.equal(journal.paperReserved,6);assert.equal(await send(request()),429);
 phase('AUTH');assert.equal(await send(request()),429);assert.equal(await send(request('/api/recommendations')),403);
 phase('BEFORE');assert.equal(await send(request()),200);assert.equal(await send(request()),429);assert.equal(journal.paperReserved,7);
 for(const p of ['HOLD','AFTER','LOGOUT','DONE']){phase(p);assert.equal(await send(request()),429);}
 assert.deepEqual(effects,['/api/market/status','/api/market/status']);assert.deepEqual(logs.filter(x=>x.event==='forward').map(x=>x.cost),[0,1]);
});
test('cross-origin market replay preserves only actual approved credentialed CORS headers',async()=>{
 const {dispatch}=require('../tools/entry-policy.cjs');const headers={'access-control-allow-origin':'https://'+F,'access-control-allow-credentials':'true'};
 const e=make();e.decide(request(),'PREFLIGHT',null);e.capture('PREFLIGHT',{...pre,headers},null);
 let replay;await dispatch({fulfill:async r=>replay=r},e.decide(request(),'PREFLIGHT',null));assert.deepEqual(replay.headers,headers);
 const bad=make();bad.decide(request(),'PREFLIGHT',null);assert.throws(()=>bad.capture('PREFLIGHT',{...pre,headers:{...headers,'access-control-allow-origin':'*'}},null));
});

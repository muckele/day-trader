'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('private browser scan catches raw and encoded password, session, capability without exporting them',()=>{
 const {variants,scan}=require('../tools/private-leakage.cjs'),root=fs.mkdtempSync(path.join(os.tmpdir(),'qualification-leak-'));
 try{const secrets=['synthetic/password+value=','synthetic-issued-session','synthetic-capability'];for(const value of variants(secrets)){fs.writeFileSync(path.join(root,'evidence'),value);assert.throws(()=>scan([root],secrets),/LEAKAGE/);}fs.writeFileSync(path.join(root,'evidence'),'safe');assert.equal(scan([root],secrets).hits,0);}finally{fs.rmSync(root,{recursive:true});}
});
test('unexpected route gate rejects blocked app APIs without changing route policy',()=>{
 const {routeGuard}=require('../tools/private-leakage.cjs'),g=routeGuard();
 g.reject('https://fonts.googleapis.com/css2?family=public');g.assert();
 g.reject('https://day-trader-backend.fly.dev/api/recommendations?secret=never-publish');assert.throws(()=>g.assert(),/UNEXPECTED_FRONTEND_ROUTE/);
 const facts=JSON.stringify(g.facts());assert.ok(!facts.includes('never-publish'));assert.ok(facts.includes('/api/recommendations'));
});
test('successful login cookie is retained privately even if subsequent UI wait fails',async()=>{
 const vm=require('node:vm'),source=fs.readFileSync(require.resolve('../tools/browser.cjs'),'utf8');
 const fn=source.slice(source.indexOf('async function login('),source.indexOf('const commands='));
 const session={name:'daytrader_session',value:'synthetic-partial-session',secure:true,httpOnly:true};
 const scope={gateway:async()=>{},stage:'AWAIT_CREDENTIAL',credentialCanary:null,issued:null,c:{username:'synthetic'},BACK:'https://backend.invalid',context:{cookies:async()=>[session]},page:{waitForResponse:async()=>({status:()=>200}),getByPlaceholder:()=>({fill:async()=>{}}),getByRole:(_,opts)=>({click:async()=>{},waitFor:async()=>{if(opts.name==='Sign Out')throw Error('UI_WAIT_FAILED')}})},save(){},instance:'synthetic',routeGuard:{assert(){}}};
 vm.runInNewContext(fn+';globalThis.login=login;',scope);await assert.rejects(scope.login('synthetic-password'),/UI_WAIT_FAILED/);assert.equal(scope.issued?.value,session.value);
});
test('private publication retrieves current accepted session even before issued assignment',async()=>{
 const vm=require('node:vm'),source=fs.readFileSync(require.resolve('../tools/browser.cjs'),'utf8');
 const fn=source.split("'publication-secrets':")[1].split(',\n shutdown:')[0];
 const call=vm.runInNewContext('('+fn+')',{probe:{qualification:()=>true},issued:null,context:{cookies:async()=>[{name:'daytrader_session',value:'synthetic-partial-session'}]},BACK:'https://backend.invalid'});
 const result=await call();assert.ok(result.values.includes('synthetic-partial-session'));
});

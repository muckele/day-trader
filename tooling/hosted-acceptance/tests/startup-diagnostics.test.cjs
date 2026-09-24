'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {safePath,facts,privateFilename}=require('../tools/startup-diagnostics.cjs');
test('extracts original operation facts without publishing exception text',()=>{
 const f=facts({name:'Error',message:"launchPersistentContext: EACCES: permission denied, mkdir '/profile/chromium'\nCookie: synthetic-session-canary"});
 assert.equal(f.code,'EACCES');assert.equal(f.syscall,'mkdir');assert.equal(f.path,'/profile/chromium');assert.ok(!JSON.stringify(f).includes('synthetic-session-canary'));
});
test('unexpected absolute paths and traversal do not leave diagnostics',()=>{
 assert.equal(safePath('/home/runner/work/_temp/private/run.json'),'<outside-container-allowlist>');
 assert.equal(safePath('/profile/../unexpected'),'<unrecognized-path>');
 assert.equal(safePath('/tmp/x\nsecret'),'<unrecognized-path>');
});
test('structured errno, syscall and listen endpoint survive',()=>{
 const f=facts({name:'Error',code:'EACCES',errno:-13,syscall:'listen',address:'127.0.0.1',port:443,message:'private ignored'});
 assert.equal(f.errno,-13);assert.equal(f.syscall,'listen');assert.equal(f.address,'127.0.0.1');assert.equal(f.port,443);assert.ok(!JSON.stringify(f).includes('private ignored'));
});
test('bounded stderr categories and child exit facts omit arbitrary contents',()=>{
 const f=facts({message:'[pid=123] Operation not permitted; cookie=never-public; exitCode=1, signal=SIGABRT'});
 assert.equal(f.childPid,123);assert.equal(f.exitCode,1);assert.equal(f.signal,'SIGABRT');assert.deepEqual(f.descriptions,['operation not permitted']);assert.ok(!JSON.stringify(f).includes('never-public'));
});

test('unquoted spawn errors retain executable boundary',()=>{
 const f=facts({message:'browserType.launchPersistentContext: spawn /opt/chromium/chrome-linux/chrome EACCES'});
 assert.equal(f.syscall,'spawn');assert.equal(f.path,'/opt/chromium/chrome-linux/chrome');assert.equal(f.code,'EACCES');
});

test('Chromium/browser error capture uses a single safe filename',()=>{assert.equal(privateFilename('Chromium/browser'),'Chromium_browser.txt');assert.ok(!privateFilename('../escape').includes('/'));});

test('mkdir stderr resource survives typographic quoting without full stderr',()=>{
 const f=facts({message:'mkdir: cannot create directory ‘/profile/chromium’: Permission denied'});
 assert.equal(f.syscall,'mkdir');assert.equal(f.path,'/profile/chromium');
});
test('actual Chromium/browser failure capture preserves original boundary',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),writes=[];
 const fakeFs={mkdirSync(){},writeFileSync(p,x){writes.push([p,x])},appendFileSync(p,x){writes.push([p,x])},lstatSync(){throw Object.assign(Error(),{code:'ENOENT'})}};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../tools/startup-diagnostics.cjs'),'utf8'),{module,require:n=>n==='node:fs'?fakeFs:n==='./startup-capture.cjs'?require('../tools/startup-capture.cjs'):require(n),process:{pid:10,getuid:()=>501,getgid:()=>20}});
 module.exports.failure('Chromium/browser','L',Object.assign(Error("EACCES: permission denied, mkdir '/profile/chromium'"),{code:'EACCES',syscall:'mkdir',path:'/profile/chromium'}));
 assert.ok(writes.some(([p])=>p==='/evidence/startup-private/Chromium_browser.txt'));
 const record=JSON.parse(writes.find(([p])=>p.endsWith('.jsonl'))[1]);assert.equal(record.error.code,'EACCES');assert.equal(record.error.syscall,'mkdir');assert.equal(record.error.path,'/profile/chromium');
});

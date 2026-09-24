'use strict';
// Synthetic recorder tests, not reproductions of the unknown browser defect.
const test=require('node:test'),assert=require('node:assert/strict');
const {capture}=require('../tools/startup-capture.cjs');
test('synthetic split chunks preserve native fatal source, unquoted path and ordering',()=>{
 const c=capture();c.push('[1:ERROR:base/files/file.cc:12] /profile/cache: Permission denied\n');
 c.push('[1:FATAL:content/browser/start');c.push('up.cc:345] Check failed: InitializeSandbox().\n');
 const s=c.snapshot(true);assert.equal(s.lines.length,2);assert.match(s.lines[1].text,/startup.cc:345.*Check failed/);assert.equal(s.truncated,false);
});
test('synthetic long prefix retains decisive terminal error and declares truncation',()=>{
 const c=capture();for(let i=0;i<500;i++)c.push('launch prefix '+i+'\n');c.push('[FATAL:unknown.cc:99] Unknown failing condition Z\n');
 const s=c.snapshot(true);assert.equal(s.truncated,true);assert.ok(s.omittedLines>0);assert.match(s.lines.at(-1).text,/Unknown failing condition Z/);assert.ok(JSON.stringify(s).length<60000);
});
test('overlong synthetic lines withheld completely, including split secret fragments',()=>{
 const c=capture();c.push('token='+ 'x'.repeat(90000));c.push('secret-tail\nFATAL: safe terminal\n');
 const s=c.snapshot(true);assert.equal(s.overlongLines,1);assert.equal(s.terminalWindowComplete,false);assert.ok(!JSON.stringify(s).includes('secret-tail'));assert.match(s.lines.at(-1).text,/safe terminal/);
});

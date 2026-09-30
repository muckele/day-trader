'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
// Run the actual stand-in canary callback in a child. HTTPS is inert and the
// canary binds an ephemeral loopback test port after asserting its real bind
// arguments remain port80/0.0.0.0. Inject exactly the observed socket error to
// avoid relying on OS-specific timing of the peer reset in this regression.
function child(code){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canary-reset-test-')),evidence=path.join(dir,'lifecycle.jsonl');
 const sourcePath=path.resolve(__dirname,'../tools/standin.cjs'),monitorPath=path.resolve(__dirname,'../tools/standin-lifecycle.cjs');
 const script=`const fs=require('fs'),vm=require('vm'),net=require('net'),assert=require('assert/strict'),{EventEmitter}=require('events');
 let canary;const noop=()=>{};const https={createServer:()=>{const s=new EventEmitter();s.listen=(p,h)=>{assert.equal(p,443);assert.equal(h,'0.0.0.0');s.emit('listening');};return s;}};
 const wrappedNet={createServer:callback=>{canary=net.createServer(callback);const listen=canary.listen.bind(canary);canary.listen=(port,host)=>{assert.equal(port,80);assert.equal(host,'0.0.0.0');return listen(0,'127.0.0.1');};return canary;}};
 const deps={https,http:{},fs:{readFileSync:()=>'',appendFileSync:noop},net:wrappedNet,'./standin-lifecycle.cjs':{observe:()=>require(${JSON.stringify(monitorPath)}).observe({write:r=>fs.appendFileSync(${JSON.stringify(evidence)},JSON.stringify(r)+'\\n')})},'./transport-observation.cjs':{observeStandin:()=>({http:noop})}};
 vm.runInNewContext(fs.readFileSync(${JSON.stringify(sourcePath)},'utf8'),{require:n=>deps[n]});
 canary.once('connection',socket=>{setImmediate(()=>{socket.emit('error',Object.assign(Error('synthetic peer reset'),{code:${JSON.stringify(code)}}));socket.destroy();const second=net.connect(canary.address().port,'127.0.0.1');let payload='';second.on('data',x=>payload+=x);second.on('end',()=>{assert.equal(payload,'synthetic-canary');canary.close(()=>console.log('CANARY_SURVIVED_RESET_AND_ACCEPTED_SECOND_PEER'));});});});
 canary.once('listening',()=>{const peer=net.connect(canary.address().port,'127.0.0.1',()=>peer.destroy());peer.on('error',noop);});`;
 try{const result=spawnSync(process.execPath,['-e',script],{encoding:'utf8',timeout:5000});return {status:result.status,error:result.error?.code,stdout:result.stdout,rows:fs.existsSync(evidence)?fs.readFileSync(evidence,'utf8').trim().split('\n').map(JSON.parse):[]};}finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('Run I regression: connection-local ECONNRESET must not terminate the listening canary',t=>{const r=child('ECONNRESET');assert.equal(r.error,undefined);if(r.status!==0){const fatal=r.rows.find(x=>x.stage==='STP04_FATAL_EXCEPTION_MONITOR');assert.equal(fatal?.safeErrorCode,'ECONNRESET');assert.equal(fatal?.source,'canary-socket');assert.equal(fatal?.origin,'uncaughtException');t.diagnostic(JSON.stringify({fatal,exitCode:r.rows.at(-1).exitCode}));}assert.equal(r.status,0,'stand-in died on the exact Run I canary reset');assert.match(r.stdout,/CANARY_SURVIVED_RESET_AND_ACCEPTED_SECOND_PEER/);assert.ok(r.rows.some(x=>x.stage==='CAN03_SOCKET_ERROR_MONITOR'&&x.safeErrorCode==='ECONNRESET'));assert.ok(!r.rows.some(x=>x.stage==='STP04_FATAL_EXCEPTION_MONITOR'));assert.equal(r.rows.at(-1).exitCode,0);});
test('unexpected canary error remains fatal; repair cannot hide other fixture failures',()=>{const r=child('EPIPE');assert.equal(r.status,1);const fatal=r.rows.find(x=>x.stage==='STP04_FATAL_EXCEPTION_MONITOR');assert.equal(fatal?.safeErrorCode,'EPIPE');assert.equal(fatal?.source,'canary-socket');assert.equal(r.rows.at(-1).exitCode,1);});

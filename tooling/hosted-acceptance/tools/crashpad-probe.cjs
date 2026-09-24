'use strict';
const fs=require('node:fs'),path=require('node:path');
const d=require('./startup-diagnostics.cjs');
const target='/profile/home/.config/google-chrome-for-testing/Crash Reports';
function enabled(env=process.env){return env.GITHUB_ACTIONS==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted'&&env.PILOT_DIAGNOSTIC_ONLY==='1'&&env.PILOT_CRASHPAD_EXPERIMENT==='aba-v1';}
function mountInfo(text){
 const line=text.split('\n').map(l=>l.split(' ')).find(a=>a[4]?.replace(/\\040/g,' ')===target);
 if(!line)throw Error('CRASH_MOUNT_ABSENT');
 const sep=line.indexOf('-');return {target,type:line[sep+1],mountFlags:line[5].split(',').sort(),superOptions:line[sep+3].split(',').sort()};
}
function metadata(phase){
 if(!enabled())return;
 const mount=mountInfo(fs.readFileSync('/proc/self/mountinfo','utf8'));
 const counts={files:0,directories:0,bytes:0,allocatedBytes:0,otherEntries:0,visited:0,complete:true};
 // Metadata only. Never open a crash file; do not follow symlinks or publish names.
 function walk(dir,depth=0){
  if(depth>16){counts.complete=false;return;}
  let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch(e){counts.complete=false;counts.errorCode=['EACCES','EPERM','ENOENT'].includes(e.code)?e.code:'METADATA_READ_FAILED';return;}
  for(const entry of entries){
   if(++counts.visited>4096){counts.complete=false;return;}
   const name=path.join(dir,entry.name);let stat;try{stat=fs.lstatSync(name);}catch{counts.complete=false;continue;}
   if(stat.isDirectory()){counts.directories++;walk(name,depth+1);}
   else if(stat.isFile()){counts.files++;counts.bytes+=stat.size;counts.allocatedBytes+=stat.blocks*512;}
   else counts.otherEntries++;
  }
 }
 walk(target);d.record('crash-mount','K',phase,{mount,object:d.metadata(target),counts,crashContentsRead:false});
}
async function finish(context,page,record=d.record){
 const first=await page.evaluate(()=>6*7);if(first!==42)throw Error('PROBE_EVALUATION_FAILED');
 await page.waitForTimeout(250);
 const second=await page.evaluate(()=>6*7);if(second!==42)throw Error('PROBE_RESPONSIVENESS_FAILED');
 record('startup-probe','O','responsive',{launchReturned:true,evaluation:true,namespaceSandbox:true,seccompSandbox:true});
 await context.close();record('startup-probe','O','closed',{normalClose:true,applicationNavigation:false,credentialsSubmitted:false});
}
module.exports={enabled,mountInfo,metadata,finish,target};

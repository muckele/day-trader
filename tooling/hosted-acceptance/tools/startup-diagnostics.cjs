'use strict';
// Facts and bounded originals pass a separate host publication gate before emission.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const privateRoot='/evidence/startup-private',publicFile='/evidence/startup-diagnostics.jsonl';
const roots=['/profile','/control','/tools','/opt/chromium','/tls','/gateway','/tmp','/dev/shm','/proc','/config'];
function safePath(value){
 if(typeof value!=='string')return undefined;
 if(value.length>300||/[\x00-\x1f\x7f]/.test(value)||value.split('/').includes('..'))return '<unrecognized-path>';
 if(value==='/opt'||roots.some(p=>value===p||value.startsWith(p+'/')))return value;
 return value.startsWith('/')?'<outside-container-allowlist>':'<non-absolute-path>';
}
function facts(error){
 const e=error||{},message=String(e.message||'').replace(/[‘’]/g,"'");
 const code=/^(E[A-Z0-9_]{2,40}|ERR_[A-Z_]{2,40})$/.test(e.code||'')?e.code:(message.match(/\b(EACCES|EPERM|ENOENT|EROFS|EADDRINUSE|EADDRNOTAVAIL|ENOTDIR|ENOSPC|ECONNREFUSED|SEC_ERROR_[A-Z_]{1,48}|PR_[A-Z_]{1,48}_ERROR)\b/)||[])[1];
 const op=message.match(/\b(mkdir|open|spawn|access|stat|lstat|unlink|connect|listen|scandir|write|read)\s+['"](\/[^'"\n]+)['"]/);
 const spawnOp=message.match(/\b(spawn)\s+(\/[^\s'"]+)\s+(?:EACCES|EPERM|ENOENT)\b/);
 const mkdirOp=message.match(/cannot create directory ['"](\/[^'"\n]+)['"]/);
 const inferred=op||spawnOp||(mkdirOp?['','mkdir',mkdirOp[1]]:null);
 const syscall=/^(mkdir|open|spawn|access|stat|lstat|unlink|connect|listen|scandir|write|read)$/.test(e.syscall||'')?e.syscall:inferred?.[1];
 const named=['Error','TypeError','RangeError','SystemError','TimeoutError'].includes(e.name)?e.name:'Error';
 const signal=(message.match(/signal=(SIG[A-Z0-9]+)/)||[])[1];
 const exit=(message.match(/exitCode=(-?\d+)/)||[])[1];
 const pid=(message.match(/\[pid=(\d+)\]/)||[])[1];
 const descriptions=[];
 for(const [pattern,label] of [[/Permission denied|permission denied/,'permission denied'],[/Operation not permitted/,'operation not permitted'],[/Read-only file system/,'read-only file system'],[/error while loading shared libraries/,'shared-library loading failure'],[/Failed to move to new namespace/,'namespace creation failed'],[/Missing X server|cannot open display/i,'display unavailable'],[/No usable sandbox/,'no usable sandbox'],[/Target page, context or browser has been closed/,'browser closed']])if(pattern.test(message))descriptions.push(label);
 return {name:named,...(code?{code}:{}),...(Number.isInteger(e.errno)?{errno:e.errno}:{}),...(syscall?{syscall}:{}),...(e.path||inferred?{path:safePath(e.path||inferred[2])}:{}),...(['127.0.0.1','::1'].includes(e.address)?{address:e.address}:{}),...(Number.isInteger(e.port)?{port:e.port}:{}),...(signal?{signal}:{}),...(exit?{exitCode:Number(exit)}:{}),...(pid?{childPid:Number(pid)}:{}),descriptions};
}
function record(component,stage,status,details={}){
 const row={at:new Date().toISOString(),component,stage,status,pid:process.pid,uid:process.getuid(),gid:process.getgid(),...details};
 fs.appendFileSync(publicFile,JSON.stringify(row)+'\n',{mode:0o600});
}
function privateFilename(component){return String(component).replace(/[^A-Za-z0-9_-]/g,'_').slice(0,64)+'.txt';}
function raw(component,value){
 fs.mkdirSync(privateRoot,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(privateRoot,privateFilename(component)),typeof value==='string'?value:JSON.stringify(value),{mode:0o600});
}
function failure(component,stage,e){
 try{
  const c=require('./startup-capture.cjs').capture({component,stage,pid:process.pid,kind:'exception'});
  c.push(String(e.message||''),'exception');
  const fields=Object.fromEntries(['code','errno','syscall','path','signal'].map(k=>[k,e[k]===undefined?null:e[k]]));
  raw(component,{...c.snapshot(true),originalFields:fields,absentOriginalFields:Object.keys(fields).filter(k=>fields[k]===null)});
 }catch{}
 const error=facts(e),p=error.path;record(component,stage,'failed',{error,...(p&&p.startsWith('/')?{object:metadata(p),parent:metadata(path.dirname(p))}:{})});
}
function metadata(target,probe=false){
 const result={path:safePath(target)};
 try{const s=fs.lstatSync(target);result.exists=true;result.type=s.isDirectory()?'directory':s.isFile()?'file':s.isSymbolicLink()?'symlink':s.isSocket()?'socket':'other';result.mode=(s.mode&0o7777).toString(8);result.ownerUid=s.uid;result.ownerGid=s.gid;
  for(const [name,flag] of [['readable',fs.constants.R_OK],['writable',fs.constants.W_OK],['executable',fs.constants.X_OK]]){try{fs.accessSync(target,flag);result[name]=true;}catch{result[name]=false;}}
  if(probe&&s.isDirectory()){const p=path.join(target,'.startup-probe-'+crypto.randomUUID());let fd;try{fd=fs.openSync(p,'wx',0o600);fs.closeSync(fd);fd=undefined;result.writeProbe=true;}catch(e){result.writeProbe=false;result.probeError=facts(e);}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(p))fs.unlinkSync(p);}}
 }catch(e){result.exists=false;result.error=facts(e);}return result;
}
function preflight(){
 const objects=['/opt','/opt/chromium','/opt/chromium/chrome-linux','/opt/chromium/chrome-linux/chrome','/profile','/profile/home','/profile/chromium','/control','/tmp','/dev/shm'];
 const permissions=objects.map(p=>metadata(p,['/profile','/profile/home','/profile/chromium','/control','/tmp','/dev/shm'].includes(p)));
 const security=Object.fromEntries(fs.readFileSync('/proc/self/status','utf8').split('\n').filter(l=>/^(Uid|Gid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp|Seccomp_filters):/.test(l)).map(l=>{const [k,v]=l.split(':');return [k,v.trim()]}));
 const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').filter(Boolean).map(l=>l.split(' ')).filter(a=>a[4]==='/'||objects.some(p=>p===a[4]||p.startsWith(a[4]+'/'))||a[4].startsWith('/profile/')).map(a=>({target:a[4]==='/'?'<container-root>':safePath(a[4].replace(/\\040/g,' ')),readOnly:a[5].split(',').includes('ro')}));
 record('browser','K','facts',{permissions,security,mounts,xDisplay:metadata('/tmp/.X11-unix/X99'),tlsListenReceipt:fs.existsSync('/evidence/startup-tls-ready.json')});
}
module.exports={privateFilename,safePath,facts,record,raw,failure,metadata,preflight};

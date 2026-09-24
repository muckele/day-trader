'use strict';
// Supervise the original startup commands with bounded private capture.
const fs=require('node:fs'),net=require('node:net'),{spawn}=require('node:child_process');
const d=require('./startup-diagnostics.cjs');
process.umask(0o077);
let stage='A';const children=[];
const resources={mkdir:['/profile/home/.pki/nssdb','/profile/home','/profile/chromium'], 'certutil-init':['/profile/home/.pki/nssdb'], 'certutil-import':['/profile/home/.pki/nssdb','/tls/cert.pem'], Xvfb:['/tmp','/tmp/.X11-unix','/tmp/.X11-unix/X99','/tmp/.X99-lock'], 'TLS-shim':['/tls/key.pem','/tls/cert.pem','/gateway/gateway.sock'], browser:['/opt/chromium/chrome-linux/chrome','/profile/chromium']};
function start(component,command,args){
 const spawnStage=stage;const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});let output='';
 function retain(b){if(output.length<16384){output=(output+b.toString()).slice(0,16384);d.raw(component,output);}}
 child.stdout.on('data',retain);child.stderr.on('data',retain);
 child.on('error',e=>{child.spawnFailure=e;d.failure(component,stage,e)});
 child.on('close',(exitCode,signal)=>d.record(component,spawnStage,'exit',{exitCode,signal,error:d.facts({message:output}),resources:(resources[component]||[]).map(p=>d.metadata(p))}));
 children.push(child);return child;
}
async function command(component,cmd,args){const c=start(component,cmd,args);await new Promise((resolve,reject)=>{c.once('error',reject);c.once('exit',code=>code===0?resolve():reject(Object.assign(Error('STARTUP_COMMAND_FAILED'),{code:'ERR_STARTUP_COMMAND'})))});}
function socketReady(p){return new Promise(resolve=>{const s=net.connect(p);s.on('connect',()=>{s.destroy();resolve(true)});s.on('error',()=>resolve(false));s.setTimeout(250,()=>{s.destroy();resolve(false)});});}
async function waitFor(child,condition){const until=Date.now()+10000;while(Date.now()<until){if(child.spawnFailure||child.exitCode!==null||child.signalCode!==null)throw Error('STARTUP_CHILD_EXITED');if(await condition())return;await new Promise(r=>setTimeout(r,100));}throw Error('STARTUP_READY_TIMEOUT');}
function stop(){for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill('SIGTERM');}
process.on('SIGTERM',()=>{stop();setTimeout(()=>process.exit(0),500)});
(async()=>{
 d.record('wrapper','A','entered',{home:d.safePath(process.env.HOME),display:process.env.DISPLAY===':99'?':99':'unexpected'});
 await command('mkdir','mkdir',['-p','/profile/home/.pki/nssdb','/profile/chromium']);stage='B';d.record('wrapper',stage,'complete',{paths:['/profile/home/.pki/nssdb','/profile/chromium'].map(p=>d.metadata(p))});
 stage='C';d.record('certutil',stage,'attempt');if(!fs.existsSync('/profile/home/.pki/nssdb/cert9.db'))await command('certutil-init','certutil',['-N','--empty-password','-d','sql:/profile/home/.pki/nssdb']);d.record('certutil',stage,'complete');
 stage='D';d.record('certutil',stage,'attempt');await command('certutil-import','certutil',['-A','-d','sql:/profile/home/.pki/nssdb','-n','acceptance-browser-only','-t','C,,','-i','/tls/cert.pem']);d.record('certutil',stage,'complete');
 stage='E';d.record('Xvfb',stage,'spawn');const xvfb=start('Xvfb','Xvfb',[':99','-screen','0','1280x800x24','-nolisten','tcp']);
 stage='F';await waitFor(xvfb,()=>socketReady('/tmp/.X11-unix/X99'));d.record('Xvfb',stage,'ready',{childPid:xvfb.pid,socket:d.metadata('/tmp/.X11-unix/X99')});
 stage='G';d.record('TLS-shim',stage,'spawn');const shim=start('TLS-shim','node',['/tools/tls-shim.cjs']);
 stage='H';await waitFor(shim,()=>{try{return JSON.parse(fs.readFileSync('/evidence/startup-tls-ready.json')).pid===shim.pid}catch{return false}});d.record('TLS-shim',stage,'ready',{childPid:shim.pid,address:'127.0.0.1',port:443});
 stage='I';const browser=start('browser','node',['/tools/browser.cjs']);
 browser.once('exit',code=>{stop();process.exitCode=code||0});
})().catch(e=>{d.failure('wrapper',stage,e);stop();process.exitCode=1});

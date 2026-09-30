'use strict';
// TEST ONLY observation. Never handles fatal errors or schedules exit-time work.
const fs=require('fs'),{errorMonitor}=require('events'),{safeError:transportError}=require('./transport-observation.cjs');
const CODES=['EPIPE','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ERR_STREAM_DESTROYED','ERR_SOCKET_CLOSED','TLS_REJECTED','TLS_PROTOCOL_ERROR','UNCLASSIFIED_STANDIN_FATAL'];
function safeError(error){
 try{const mapped=transportError(error),code=['ERR_STREAM_DESTROYED','ERR_SOCKET_CLOSED'].includes(error?.code)?error.code:mapped.safeErrorCode;return {errorClass:mapped.errorClass,safeErrorCode:CODES.includes(code)?code:'UNCLASSIFIED_STANDIN_FATAL'};}
 catch{return {errorClass:'OtherError',safeErrorCode:'UNCLASSIFIED_STANDIN_FATAL'};}
}
function observe({process:proc=process,write}={}){
 let order=0,httpsListened=false,canaryListened=false,writeFailed=false,canaryId=0,httpsId=0;
 const sources=new WeakMap(),watched=new WeakSet();
 const emit=(stage,fields={})=>{
  if(order>256)return;
  const row=++order===257?{stage:'STP_OBSERVATION_OVERFLOW',order}:{stage,order,httpsListened,canaryListened,...fields,...(writeFailed?{previousWriteFailed:true}:{})};
  try{if(write)write(row);else fs.appendFileSync('/evidence/standin-lifecycle.jsonl',JSON.stringify(row)+'\n');}catch{writeFailed=true;}
 };
 const remember=(error,source,connectionId)=>{if(error!==null&&typeof error==='object')sources.set(error,{source,...(connectionId?{connectionId}:{})});};
 const monitored=(stage,source,error,connectionId)=>{remember(error,source,connectionId);emit(stage,{...safeError(error),source,...(connectionId?{connectionId}:{})});};
 proc.on('uncaughtExceptionMonitor',(error,origin)=>emit('STP04_FATAL_EXCEPTION_MONITOR',{...safeError(error),origin:['uncaughtException','unhandledRejection'].includes(origin)?origin:'other',...(error!==null&&typeof error==='object'?sources.get(error):null)||{source:'unassociated'}}));
 const exitCode=code=>Number.isInteger(code)&&code>=0&&code<=255?code:null;
 proc.on('beforeExit',code=>emit('STP05_PROCESS_BEFORE_EXIT',{exitCode:exitCode(code)}));
 proc.on('exit',code=>emit('STP06_PROCESS_EXIT',{exitCode:exitCode(code)}));
 emit('STP01_PROCESS_STARTED');
 return {
  https(server){
   server.on('listening',()=>{httpsListened=true;emit('STP02_HTTPS_LISTENING');});
   server.on(errorMonitor,e=>monitored('HTTPS01_SERVER_ERROR_MONITOR','https-server',e));
   const socket=s=>{if(watched.has(s))return;watched.add(s);const id=++httpsId;s.on(errorMonitor,e=>monitored('HTTPS02_SOCKET_ERROR_MONITOR','https-socket',e,id));};
   server.on('connection',socket);server.on('secureConnection',socket);
  },
  canary(server){
   server.on('listening',()=>{canaryListened=true;emit('STP03_CANARY_LISTENING');emit('CAN01_SERVER_LISTENING');});
   server.on(errorMonitor,e=>monitored('CAN05_SERVER_ERROR_MONITOR','canary-server',e));
   // Appended after the original accepted-socket callback; no write/close change.
   server.on('connection',s=>{const id=++canaryId;emit('CAN02_CONNECTION_ACCEPTED',{connectionId:id});s.on(errorMonitor,e=>monitored('CAN03_SOCKET_ERROR_MONITOR','canary-socket',e,id));s.once('close',hadError=>emit('CAN04_SOCKET_CLOSE',{connectionId:id,hadError:!!hadError}));});
  }
 };
}
module.exports={observe,safeError,CODES};

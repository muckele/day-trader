'use strict';
const {StringDecoder}=require('node:string_decoder');
// Complete lines only: a cut line could expose a fragment of a secret.
const LIMIT=2048,HEAD=4,TAIL=12,IMPORTANT=4,FATAL=4;
function capture(identity={}) {
 let receivedBytes=0,lineCount=0,overlongLines=0,head=[],tail=[],important=[],fatal=[];
 const startedAt=new Date().toISOString(),streams=new Map();
 function line(text,stream,overlong=false){
  const row={sequence:++lineCount,at:new Date().toISOString(),stream,overlong,text:overlong?'[overlong line withheld]':text};
  if(overlong)overlongLines++;
  if(head.length<HEAD)head.push(row);
  tail.push(row);if(tail.length>TAIL)tail.shift();
  if(!overlong){
   if(/fatal|check failed|assert/i.test(text)){fatal.push(row);if(fatal.length>FATAL)fatal.shift();}
   else if(/error|signal=SIG/i.test(text)){important.push(row);if(important.length>IMPORTANT)important.shift();}
  }
 }
 function push(value,stream='stderr'){
  const b=Buffer.isBuffer(value)?value:Buffer.from(value);receivedBytes+=b.length;
  let s=streams.get(stream);if(!s){s={decoder:new StringDecoder('utf8'),pending:'',overlong:false};streams.set(stream,s);}
  const parts=s.decoder.write(b).split('\n');
  for(let i=0;i<parts.length;i++){
   if(!s.overlong){s.pending+=parts[i];if(s.pending.length>LIMIT){s.pending='';s.overlong=true;}}
   if(i<parts.length-1){line(s.pending,stream,s.overlong);s.pending='';s.overlong=false;}
  }
 }
 function snapshot(final=false){
  if(final)for(const [stream,s] of streams){s.pending+=s.decoder.end();if(s.pending||s.overlong)line(s.pending,stream,s.overlong);s.pending='';s.overlong=false;}
  const lines=[...new Map([...head,...tail,...important,...fatal].map(r=>[r.sequence,r])).values()].sort((a,b)=>a.sequence-b.sequence);
  return {...identity,startedAt,capturedAt:new Date().toISOString(),receivedBytes,lineCount,retainedLines:lines.length,omittedLines:lineCount-lines.length,overlongLines,truncated:lineCount>lines.length||overlongLines>0,policy:{headLines:HEAD,tailLines:TAIL,importantLines:IMPORTANT,fatalLines:FATAL,maxLineCharacters:LIMIT},terminalWindowComplete:final&&!tail.some(r=>r.overlong),final,lines};
 }
 return {push,snapshot};
}
module.exports={capture};

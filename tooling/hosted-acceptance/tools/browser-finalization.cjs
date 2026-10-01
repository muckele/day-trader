'use strict';
// Bounded observations only: no timer, retry, response wait, or error handling policy.
const fs=require('fs'),{errorMonitor}=require('events');
const STAGES=['BS01_SHUTDOWN_ENTER','BS02_ENTRY_INVALIDATED','BS03_PREAUTH_REMOVE_COMPLETE','BS04_ROUTE_FACTS_COMPLETE','BS05_PRIVATE_STATE_CLEARED','BS06_CONTEXT_CLOSE_START','BS07_CONTEXT_CLOSE_FINISH','BS08_CRASH_METADATA_START','BS09_CRASH_METADATA_FINISH','BS10_EXIT_TIMER_ARMED','BS11_COMMAND_RETURN','CS01_COMMAND_RESOLVED','CS02_RESPONSE_END_CALLED','CS03_RESPONSE_FINISH_OR_CALLBACK','CS_RESPONSE_FAILED','BS_FAILURE','browser-process-exit','BS_OBSERVATION_OVERFLOW'];
const FAILURES=['ENTRY_INVALIDATION_FAILED','PREAUTH_REMOVE_FAILED','ROUTE_FACTS_FAILED','PRIVATE_STATE_CLEAR_FAILED','CONTEXT_CLOSE_FAILED','CRASH_METADATA_FAILED','EXIT_TIMER_FAILED','CONTROL_RESPONSE_FAILED','UNCLASSIFIED_FINALIZATION_ERROR'];
function observe({instance,process:proc=process,write}={}){
 const identity=/^[0-9a-f-]{36}$/.test(instance)?instance:'unknown';let order=0,writeFailed=false;
 const flags={exitTimerArmed:false,commandReturned:false,responseEndCalled:false,responseFlushed:false,contextClosed:false,crashMetadataCompleted:false};
 const updates={BS07_CONTEXT_CLOSE_FINISH:'contextClosed',BS09_CRASH_METADATA_FINISH:'crashMetadataCompleted',BS10_EXIT_TIMER_ARMED:'exitTimerArmed',BS11_COMMAND_RETURN:'commandReturned',CS02_RESPONSE_END_CALLED:'responseEndCalled',CS03_RESPONSE_FINISH_OR_CALLBACK:'responseFlushed'};
 const emit=(stage,fields={})=>{if(order>256)return;const row={instance:identity,order:++order,stage:order===257?'BS_OBSERVATION_OVERFLOW':stage,...fields,...(writeFailed?{previousWriteFailed:true}:{})};try{if(write)write(row);else fs.appendFileSync('/evidence/browser-finalization.jsonl',JSON.stringify(row)+'\n');}catch{writeFailed=true;}};
 const mark=stage=>{if(!STAGES.includes(stage))return;if(updates[stage])flags[updates[stage]]=true;emit(stage);};
 proc.on('exit',code=>emit('browser-process-exit',{exitCode:Number.isInteger(code)&&code>=0&&code<=255?code:null,...flags}));
 return {mark,failure:category=>emit('BS_FAILURE',{failure:FAILURES.includes(category)?category:'UNCLASSIFIED_FINALIZATION_ERROR'}),get commandReturned(){return flags.commandReturned;},watch(socket){socket.once('finish',()=>mark('CS03_RESPONSE_FINISH_OR_CALLBACK'));socket.once(errorMonitor,()=>emit('CS_RESPONSE_FAILED',{failure:'CONTROL_RESPONSE_FAILED'}));}};
}
module.exports={observe,STAGES,FAILURES};

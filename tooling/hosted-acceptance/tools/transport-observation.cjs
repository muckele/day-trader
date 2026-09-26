'use strict';
// Observation only: no ordinary error handlers, socket writes, timers, or destruction.
const fs=require('fs'),{errorMonitor}=require('events');
const BACK='day-trader-backend.fly.dev';
const GT=['GT01_DESTINATION_LOOKUP','GT02_TLS_SOCKET_CREATE','GT03_TCP_CONNECT','GT04_SECURE_CONNECT','GT05_TLS_AUTHORIZATION','GT06_HTTP_REQUEST_CREATE','GT07_HTTP_REQUEST_FINISH','GT08_RESPONSE_HEADERS','GT09_HTTP_REQUEST_ERROR','GT10_TLS_SOCKET_ERROR','GT11_TIMEOUT','GT12_SOCKET_CLOSE','GT13_HTTP_REQUEST_CLOSE'];
const BRANCHES=['GATEWAY_FORWARD_THROW','GATEWAY_UPSTREAM_REQUEST_ERROR','GATEWAY_REDIRECT_DENIED','GATEWAY_TRANSPORT_BODY_REJECTED'];
const SI=['SI00_LISTENING','SI01_TCP_CONNECTION','SI02_TLS_SECURE_CONNECTION','SI03_TLS_CLIENT_ERROR','SI04_HTTP_HANDLER_ENTER','SI05_HTTP_RESPONSE_FINISH','SI06_SOCKET_CLOSE'];
function safeError(e){
 const code=typeof e==='string'?e:e?.code;
 const mapped={ERR_TLS_CERT_ALTNAME_INVALID:'TLS_CERT_ALTNAME',CERT_HAS_EXPIRED:'TLS_CERT_EXPIRED',DEPTH_ZERO_SELF_SIGNED_CERT:'TLS_UNKNOWN_CA',SELF_SIGNED_CERT_IN_CHAIN:'TLS_UNKNOWN_CA',UNABLE_TO_VERIFY_LEAF_SIGNATURE:'TLS_UNKNOWN_CA',UNABLE_TO_GET_ISSUER_CERT_LOCALLY:'TLS_UNKNOWN_CA',ERR_SSL_WRONG_VERSION_NUMBER:'TLS_PROTOCOL_ERROR',ERR_SSL_TLSV1_ALERT_UNKNOWN_CA:'TLS_UNKNOWN_CA',ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE:'TLS_REJECTED',ERR_TLS_HANDSHAKE_TIMEOUT:'TLS_TIMEOUT'};
 const literal=['ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT'];
 const own=['TLS_TIMEOUT','TLS_REJECTED','UPSTREAM_TIMEOUT','DESTINATION_REJECTED'];
 return {errorClass:['Error','TypeError','RangeError'].includes(e?.name)?e.name:'OtherError',safeErrorCode:literal.includes(code)?code:(Object.hasOwn(mapped,code)?mapped[code]:null)||(own.includes(e?.message)?e.message:'UNCLASSIFIED_TRANSPORT_ERROR')};
}
function writer(file,write){
 let order=0,failed=false;
 return row=>{
  if(order>512)return;
  const receipt=++order===513?{order,stage:'DIAGNOSTIC_OVERFLOW'}:{order,...row,...(failed?{previousWriteFailed:true}:{})};
  try{if(write)write(receipt);else fs.appendFileSync('/evidence/'+file,JSON.stringify(receipt)+'\n');}
  catch{failed=true;/* Evidence failure must not change transport outcomes. */}
 };
}
const gatewayWrite=writer('gateway-transport.jsonl');
const noop={event(){},branch(){},socket(){},request(){}};
function gatewayTrace(id,d,write){
 if(d.host!==BACK||d.path!=='/health'||d.method!=='GET')return noop;
 const emit=write?writer('gateway-transport.jsonl',write):gatewayWrite;
 const event=(stage,fields={})=>{
  if(![...GT,...BRANCHES].includes(stage))return;
  const row={requestId:id,destination:'backend-upstream',stage};
  for(const k of ['success','started','completed','authorized','secureObserved','hadError','timeout'])if(typeof fields[k]==='boolean')row[k]=fields[k];
  if(Number.isInteger(fields.httpStatus)&&fields.httpStatus>=100&&fields.httpStatus<=599)row.httpStatus=fields.httpStatus;
  if(['socket','request'].includes(fields.component))row.component=fields.component;
  if(fields.error)Object.assign(row,safeError(fields.error));
  if(['SOCKET_CLOSED_BEFORE_SECURE','SOCKET_CLOSED_AFTER_SECURE'].includes(fields.closeCode))row.safeErrorCode=fields.closeCode;
  emit(row);
 };
 return {event,branch:(stage,error)=>event(stage,{success:false,...(error?{error}:{})}),
  socket(s){let secure=false;
   s.once('connect',()=>event('GT03_TCP_CONNECT',{success:true}));
   s.once('secureConnect',()=>{secure=true;event('GT04_SECURE_CONNECT',{success:true});event('GT05_TLS_AUTHORIZATION',{success:s.authorized===true,authorized:s.authorized===true,...(!s.authorized?{error:s.authorizationError}:{})});});
   s.on(errorMonitor,e=>event('GT10_TLS_SOCKET_ERROR',{success:false,error:e}));
   s.once('close',hadError=>event('GT12_SOCKET_CLOSE',{secureObserved:secure,hadError:!!hadError,closeCode:secure?'SOCKET_CLOSED_AFTER_SECURE':'SOCKET_CLOSED_BEFORE_SECURE'}));
  },
  request(r){r.once('finish',()=>event('GT07_HTTP_REQUEST_FINISH',{success:true}));r.on(errorMonitor,e=>event('GT09_HTTP_REQUEST_ERROR',{success:false,error:e}));r.once('close',()=>event('GT13_HTTP_REQUEST_CLOSE',{completed:true}));}
 };
}
function hostClass(host){const known={[BACK]:'backend','day-trader-frontend.fly.dev':'frontend','paper-api.alpaca.markets':'paper'};return Object.hasOwn(known,host)?known[host]:'unknown';}
function observeStandin(server,write){
 const emit=writer('standin-transport.jsonl',write),sockets=new WeakMap();let next=0;
 // Node's accepted TLSSocket wraps the raw socket as _parent. Read only; if the
 // association is unavailable report connectionId=0, never infer TCP absence.
 const lookup=s=>sockets.get(s)||sockets.get(s?._parent)||{id:0,tcp:false,secure:false,host:'unknown'};
 const receipt=(stage,state,extra={})=>emit({stage,connectionId:state.id,hostClass:state.host,tcpObserved:state.tcp,secureObserved:state.secure,...extra});
 server.on('listening',()=>emit({stage:'SI00_LISTENING',port:443,listener:'synthetic-internal'}));
 server.on('connection',s=>{const state={id:++next,tcp:true,secure:false,host:'unknown'};sockets.set(s,state);receipt('SI01_TCP_CONNECTION',state);s.once('close',hadError=>receipt('SI06_SOCKET_CLOSE',state,{hadError:!!hadError}));});
 server.on('secureConnection',s=>{const state=lookup(s);state.secure=true;state.host=hostClass(s.servername);sockets.set(s,state);receipt('SI02_TLS_SECURE_CONNECTION',state);});
 server.on('tlsClientError',(e,s)=>{const state=lookup(s);state.host=hostClass(s?.servername);receipt('SI03_TLS_CLIENT_ERROR',state,safeError(e));});
 return {http(req,res){const state=lookup(req.socket);receipt('SI04_HTTP_HANDLER_ENTER',state,{hostClass:hostClass(req.headers.host)});res.once('finish',()=>receipt('SI05_HTTP_RESPONSE_FINISH',state,{hostClass:hostClass(req.headers.host),httpStatus:res.statusCode}));}};
}
module.exports={gatewayTrace,observeStandin,safeError,GT,SI,BRANCHES,noop};

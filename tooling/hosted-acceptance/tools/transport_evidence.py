"""Bounded, allowlisted transport receipts; no connection or network probes."""
import json
from security_probe_evidence import read_rows,digest
GT=['GT01_DESTINATION_LOOKUP','GT02_TLS_SOCKET_CREATE','GT03_TCP_CONNECT','GT04_SECURE_CONNECT','GT05_TLS_AUTHORIZATION','GT06_HTTP_REQUEST_CREATE','GT07_HTTP_REQUEST_FINISH','GT08_RESPONSE_HEADERS','GT09_HTTP_REQUEST_ERROR','GT10_TLS_SOCKET_ERROR','GT11_TIMEOUT','GT12_SOCKET_CLOSE','GT13_HTTP_REQUEST_CLOSE']
BRANCHES=['GATEWAY_FORWARD_THROW','GATEWAY_UPSTREAM_REQUEST_ERROR','GATEWAY_REDIRECT_DENIED','GATEWAY_TRANSPORT_BODY_REJECTED']
SI=['SI00_LISTENING','SI01_TCP_CONNECTION','SI02_TLS_SECURE_CONNECTION','SI03_TLS_CLIENT_ERROR','SI04_HTTP_HANDLER_ENTER','SI05_HTTP_RESPONSE_FINISH','SI06_SOCKET_CLOSE']
CODES=['ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT','TLS_TIMEOUT','TLS_REJECTED','UPSTREAM_TIMEOUT','DESTINATION_REJECTED','TLS_CERT_ALTNAME','TLS_CERT_EXPIRED','TLS_UNKNOWN_CA','TLS_PROTOCOL_ERROR','SOCKET_CLOSED_BEFORE_SECURE','SOCKET_CLOSED_AFTER_SECURE','UNCLASSIFIED_TRANSPORT_ERROR']
FILES={'gateway':'gateway-transport.jsonl','standin':'standin-transport.jsonl'}
def require(ok):
 if not ok:raise ValueError('TRANSPORT_EVIDENCE_INVALID')
def safe_row(row):
 bools=['success','started','completed','authorized','secureObserved','tcpObserved','hadError','timeout']
 require(type(row) is dict and set(row)<={'order','stage','requestId','destination','connectionId','hostClass','httpStatus','component','safeErrorCode','errorClass','port','listener',*bools})
 require(type(row.get('order')) is int and 1<=row['order']<=512 and row.get('stage') in GT+BRANCHES+SI)
 for k in bools:
  if k in row:require(type(row[k]) is bool)
 for k in ['requestId','connectionId']:
  if k in row:require(type(row[k]) is int and 0<=row[k]<=10000)
 if 'destination' in row:require(row['destination']=='backend-upstream')
 if 'hostClass' in row:require(row['hostClass'] in ['backend','frontend','paper','unknown'])
 if 'httpStatus' in row:require(type(row['httpStatus']) is int and 100<=row['httpStatus']<=599)
 if 'component' in row:require(row['component'] in ['socket','request'])
 if 'safeErrorCode' in row:require(row['safeErrorCode'] in CODES)
 if 'errorClass' in row:require(row['errorClass'] in ['Error','TypeError','RangeError','OtherError'])
 if 'port' in row:require(row['stage']=='SI00_LISTENING' and row['port']==443)
 if 'listener' in row:require(row['stage']=='SI00_LISTENING' and row['listener']=='synthetic-internal')
 return row

def begin(evidence):
 result={}
 for name,filename in FILES.items():
  rows=read_rows(evidence/filename);result[name]={'count':len(rows),'prefix':digest(rows)}
 return result

def collect(evidence,baseline):
 result={}
 for name,filename in FILES.items():
  rows=read_rows(evidence/filename);start=baseline[name]['count']
  require(len(rows)>=start and digest(rows[:start])==baseline[name]['prefix'] and len(rows)<=512)
  # Validate the full sequence, including pre-probe records, so overflow, missing
  # writes, replacement or arbitrary fields cannot be mistaken for absence.
  for order,row in enumerate(rows,1):safe_row(row);require(row['order']==order)
  result[name]=rows[start:];require(len(result[name])<=128)
  if name=='standin':result['listenerStarted']=any(r['stage']=='SI00_LISTENING' for r in rows[:start])
 return result

def container_states(secrets):
 from startup_probe_diagnostic import container_state
 result={}
 for name in ['gateway','standin','backend']:
  state=container_state('dapt-hosted-'+name,secrets)
  result[name]={k:state[k] for k in ['running','pidPresent','restartCount','exitCodeIfStopped']}
 return result

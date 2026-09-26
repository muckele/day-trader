"""Strict, bounded publication of security-probe stages and scoped boundary counts."""
import json,hashlib
STAGES=['SP01_STAGE_CHECK','SP02_PAGE_CREATE','SP03_HEALTH_NAVIGATION','SP04_INTERCEPTION_REMOVE','SP05_DENIED_FETCH','SP06_CONTROL_FETCH','SP07_INTERCEPTION_RESTORE','SP08_PAGE_CLOSE','SP09_ASSERT_DENIED_STATUS','SP10_ASSERT_CONTROL_STATUS']
PATHS=['health','denied-recommendations-query','control-me'];BOUNDARIES=['tls','gateway','backend']
CODES=['ERR_CERT_AUTHORITY_INVALID','ERR_CERT_COMMON_NAME_INVALID','ERR_CERT_DATE_INVALID','ERR_CONNECTION_REFUSED','ERR_CONNECTION_CLOSED','ERR_NAME_NOT_RESOLVED','ERR_BLOCKED_BY_RESPONSE','ERR_BLOCKED_BY_CLIENT','ERR_FAILED','CONTENT_SECURITY_POLICY','FETCH_REJECTED','TIMEOUT','UNCLASSIFIED','STATUS_MISMATCH']
ERRORS=['Error','TypeError','SyntaxError','TimeoutError','AbortError','SecurityError','DOMException','OtherError']
def require(condition):
 if not condition:raise ValueError('SECURITY_PROBE_EVIDENCE_INVALID')
def safe_stages(data):
 data={k:v for k,v in data.items() if k not in ['run','at']}
 require(set(data)=={'version','stages','firstFailure','restorationFatal','evidenceWriteFailed','browserErrors','pass'} and data['version']==1)
 require(type(data['pass']) is bool and type(data['restorationFatal']) is bool and type(data['evidenceWriteFailed']) is bool and data['firstFailure'] in [None,*STAGES])
 require(isinstance(data['browserErrors'],list) and len(data['browserErrors'])<=8 and all(x in CODES for x in data['browserErrors']))
 require(isinstance(data['stages'],list) and len(data['stages'])==10)
 bools=['started','completed','requestResolved','responseReceived','expectedOriginReached','evaluationRejected']
 for expected,row in zip(STAGES,data['stages']):
  require(isinstance(row,dict) and row.get('stage')==expected and {'stage','started','completed','success'}<=set(row))
  require(set(row)<={'stage','success','pathId','httpStatus','actualStatus','expectedStatus','startedOrder','finishedOrder','errorClass','safeErrorCode',*bools})
  for key in bools:
   if key in row:require(type(row[key]) is bool)
  require(row['success'] is None or type(row['success']) is bool)
  for key in ['httpStatus','actualStatus','expectedStatus']:
   if key in row:require(row[key] is None or type(row[key]) is int and 100<=row[key]<=599)
  for key in ['startedOrder','finishedOrder']:
   if key in row:require(type(row[key]) is int and 1<=row[key]<=40)
  if 'pathId' in row:require(row['pathId'] in PATHS)
  if 'errorClass' in row:require(row['errorClass'] in ERRORS)
  if 'safeErrorCode' in row:require(row['safeErrorCode'] in CODES)
 require(len(json.dumps(data))<=8192)
 return data

def read_rows(path):
 if not path.exists():return []
 require(path.stat().st_size<=1024*1024)
 rows=[json.loads(line) for line in path.read_text().splitlines()];require(len(rows)<=4096)
 return rows

def digest(rows):return hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest()
STREAMS={**{b:'security-boundary-'+b+'.jsonl' for b in BOUNDARIES},'upstream':'upstream.jsonl','tls-forward':'tls-forward.jsonl'}
def begin(evidence):
 result={}
 for boundary,filename in STREAMS.items():
  rows=read_rows(evidence/filename);result[boundary]={'count':len(rows),'prefix':digest(rows)}
 return result

def delta(evidence,baseline,stream):
 rows=read_rows(evidence/STREAMS[stream]);start=baseline[stream]['count'];require(len(rows)>=start and digest(rows[:start])==baseline[stream]['prefix'])
 return rows[start:]

def boundaries(evidence,baseline):
 result={p:{b:{'handlers':0,'responses':0,'statuses':[]} for b in BOUNDARIES} for p in PATHS}
 for boundary in BOUNDARIES:
  rows=delta(evidence,baseline,boundary);require(len(rows)<=64)
  for row in rows:
   require(set(row) in [{'boundary','pathId','event','method'},{'boundary','pathId','event','method','httpStatus'}])
   require(row['boundary']==boundary and row['pathId'] in PATHS and row['method']=='GET' and row['event'] in ['handler','response'])
   bucket=result[row['pathId']][boundary]
   if row['event']=='handler':require('httpStatus' not in row);bucket['handlers']+=1
   else:
    require(type(row.get('httpStatus')) is int and 100<=row['httpStatus']<=599);bucket['responses']+=1;bucket['statuses'].append(row['httpStatus'])
 # Existing independently authored forwarding/application receipts distinguish handler
 # arrival from an actual application response; only fixed IDs/counts/statuses leave.
 targets={'/health':'health','/api/recommendations?x=1':'denied-recommendations-query','/api/me':'control-me'}
 upstream=delta(evidence,baseline,'upstream');forwards=delta(evidence,baseline,'tls-forward')
 for target,path in targets.items():
  responses=[x.get('status') for x in upstream if x.get('type')=='application' and x.get('host')=='backend' and x.get('method')=='GET' and x.get('path')==target]
  require(len(responses)<=32 and all(type(x) is int and 100<=x<=599 for x in responses))
  result[path]['application']={'responses':len(responses),'statuses':responses}
  result[path]['tls']['forwards']=sum(x.get('method')=='GET' and x.get('path')==target.split('?')[0] and bool(x.get('queryPresent'))==('?' in target) for x in forwards)
 return result

def collect(evidence,baseline):
 path=evidence/'security-probe-stages.json';require(path.exists() and path.stat().st_size<=16384)
 stages=safe_stages(json.loads(path.read_text()));counts=boundaries(evidence,baseline)
 for n,p in [(2,'health'),(4,'denied-recommendations-query'),(5,'control-me')]:
  counts[p]['browser']={k:stages['stages'][n].get(k) for k in ['started','completed','success','requestResolved','responseReceived','httpStatus','evaluationRejected'] if k in stages['stages'][n]}
 return {'stages':stages,'boundaries':counts,'forbiddenDownstreamObserved':any(counts['denied-recommendations-query'][b]['handlers']>0 for b in ['gateway','backend'])}

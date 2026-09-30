"""Strict lifecycle publication and read-only stand-in state. No network probes."""
import json,re,subprocess
STP=['STP01_PROCESS_STARTED','STP02_HTTPS_LISTENING','STP03_CANARY_LISTENING','STP04_FATAL_EXCEPTION_MONITOR','STP05_PROCESS_BEFORE_EXIT','STP06_PROCESS_EXIT']
CAN=['CAN01_SERVER_LISTENING','CAN02_CONNECTION_ACCEPTED','CAN03_SOCKET_ERROR_MONITOR','CAN04_SOCKET_CLOSE','CAN05_SERVER_ERROR_MONITOR']
HTTPS=['HTTPS01_SERVER_ERROR_MONITOR','HTTPS02_SOCKET_ERROR_MONITOR']
# Names follow actual nested-loop order, including browser IPv6 before gateway IPv4.
NP=['NP01_BEFORE_STANDIN_SELF_CANARY','NP02_AFTER_STANDIN_SELF_CANARY','NP03_AFTER_BROWSER_PORT80_DENIAL','NP04_AFTER_BROWSER_IPV6_PORT80_DENIAL','NP05_AFTER_GATEWAY_PORT80_DENIAL','NP06_AFTER_GATEWAY_IPV6_PORT80_DENIAL','NP07_AFTER_BROWSER_DIRECT_443_DENIAL','NP08_AFTER_GATEWAY_IPV6_CANARY_SETUP','NP09_AFTER_GATEWAY_IPV6_CANARY_DENIAL','NP10_BEFORE_SECURITY_HEALTH']
CODES=['EPIPE','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ERR_STREAM_DESTROYED','ERR_SOCKET_CLOSED','TLS_REJECTED','TLS_PROTOCOL_ERROR','UNCLASSIFIED_STANDIN_FATAL']
STATE_KEYS={'running','pidPresent','restartCount','exitCodeIfStopped','OOMKilled','exitKind'}
def require(ok):
 if not ok:raise ValueError('STANDIN_EXIT_EVIDENCE_INVALID')
def safe_row(row):
 require(type(row) is dict and {'stage','order','httpsListened','canaryListened'}<=set(row) and set(row)<={'stage','order','httpsListened','canaryListened','errorClass','safeErrorCode','origin','exitCode','connectionId','source','hadError'})
 require(row['stage'] in STP+CAN+HTTPS and type(row['order']) is int and 1<=row['order']<=256)
 for k in ['httpsListened','canaryListened','hadError']:
  if k in row:require(type(row[k]) is bool)
 if 'errorClass' in row:require(row['errorClass'] in ['Error','TypeError','RangeError','OtherError'])
 if 'safeErrorCode' in row:require(row['safeErrorCode'] in CODES)
 if 'origin' in row:require(row['origin'] in ['uncaughtException','unhandledRejection','other'])
 if 'source' in row:require(row['source'] in ['canary-socket','canary-server','https-socket','https-server','unassociated'])
 if 'connectionId' in row:require(type(row['connectionId']) is int and 1<=row['connectionId']<=10000)
 if 'exitCode' in row:require(row['exitCode'] is None or type(row['exitCode']) is int and 0<=row['exitCode']<=255)
 return row

def state():
 unknown={'running':None,'pidPresent':None,'restartCount':None,'exitCodeIfStopped':None,'OOMKilled':None,'exitKind':'UNKNOWN'}
 fmt='{{json .State.Running}} {{json .State.ExitCode}} {{json .RestartCount}} {{json .State.Pid}} {{json .State.OOMKilled}}'
 try:q=subprocess.run(['docker','inspect','--format',fmt,'dapt-hosted-standin'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=8)
 except (OSError,subprocess.TimeoutExpired):return unknown
 if q.returncode!=0 or len(q.stdout)>256:return unknown
 m=re.fullmatch(r'(true|false) (\d{1,3}) (\d{1,6}) (\d{1,12}) (true|false)\s*',q.stdout)
 if not m or int(m[2])>255:return unknown
 running=m[1]=='true';oom=m[5]=='true'
 return {'running':running,'pidPresent':int(m[4])>0,'restartCount':int(m[3]),'exitCodeIfStopped':None if running else int(m[2]),'OOMKilled':oom,'exitKind':'OOM_KILLED' if oom else 'RUNNING' if running else 'STOPPED'}

def marker(evidence,stage):
 require(stage in NP);row={'stage':stage,**state()}
 try:
  with (evidence/'standin-prechecks.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
 except OSError:row['evidenceWriteFailed']=True
 return row

def read_rows(path,max_rows):
 if not path.exists():return []
 require(path.stat().st_size<=131072)
 rows=[json.loads(line) for line in path.read_text().splitlines()];require(len(rows)<=max_rows);return rows

def collect(evidence):
 lifecycle=read_rows(evidence/'standin-lifecycle.jsonl',256)
 for order,row in enumerate(lifecycle,1):safe_row(row);require(row['order']==order)
 timeline=read_rows(evidence/'standin-prechecks.jsonl',10)
 for index,row in enumerate(timeline):
  require(set(row)=={'stage',*STATE_KEYS} and row['stage']==NP[index])
  for key in ['running','pidPresent','OOMKilled']:require(row[key] is None or type(row[key]) is bool)
  for key in ['restartCount','exitCodeIfStopped']:require(row[key] is None or type(row[key]) is int and 0<=row[key]<=999999)
  require(row['exitKind'] in ['RUNNING','STOPPED','OOM_KILLED','UNKNOWN'])
 return {'lifecycle':lifecycle,'timeline':timeline,'firstStoppedStage':next((r['stage'] for r in timeline if r['running'] is False),None),'oomObserved':any(r['OOMKilled'] is True for r in timeline)}

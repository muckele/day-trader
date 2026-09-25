"""One original startup probe, bounded publication, read-only synthetic follow-ups.
No retry/readiness repair. Raw subprocess bytes never enter evidence/public logs.
"""
import datetime,json,re,subprocess,tempfile,time
from startup_publication import clean,variants,Withheld
PROBE=('docker','exec','dapt-hosted-mongo','mongosh','--quiet','--eval',"const x=db.getSiblingDB('acceptance').operationalreadiness.findOne({_id:'execution-write-probe'});print(x?.checkedAt?.toISOString()||'pending')")
WINDOW=32768
ISO=r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z'
def window(stream):
 stream.flush();stream.seek(0,2);size=stream.tell();stream.seek(0)
 if size<=WINDOW:return stream.read().decode('utf-8','replace'),size,False
 head=stream.read(4096).rsplit(b'\n',1)[0];stream.seek(-WINDOW+4096,2);tail=stream.read().split(b'\n',1)[-1]
 return (head+b'\n[OUTPUT OMITTED]\n'+tail).decode('utf-8','replace'),size,True

def excerpt(text,secrets):
 known=variants(secrets);lines=[]
 for line in text.splitlines():
  # Only recognized diagnostic lines; arbitrary banners/documents are withheld.
  if len(line)>2048:continue
  if not (re.match(r'^(?:[A-Za-z]+(?:Error|Exception)(?:\[[A-Za-z0-9]+\])?:|Error:|Error response from daemon:|OCI runtime exec failed:|connect ECONNREFUSED|not primary|Server selection timed out)',line) or re.fullmatch(ISO+r'|pending|\d{1,3}\.\d{1,3}\.\d{1,3}',line.strip())):continue
  line=re.sub(r'(?i)(?:mongodb(?:\+srv)?|https?|file)://[^\s\x27"<>]+','[URI REDACTED]',line)
  line=re.sub(r'''(?<![\w./])/(?!/)[^\s'"<>\]\[),;]+''','[PATH REDACTED]',line)
  # Never expose unexpected DNS names/IPs or absolute host paths in errors.
  line=re.sub(r'(?<![\w])(?:[a-zA-Z0-9-]+\.)+(?:[a-zA-Z][a-zA-Z0-9-]*)(?::\d+)?',lambda m:m[0] if m[0] in ['x.checkedAt.toISOString'] else '[HOST OR FILE REDACTED]',line)
  line=re.sub(r'(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?','[LOOPBACK]' if '127.0.0.1' in line else '[IP REDACTED]',line)
  try:line=clean(line,known)
  except Withheld:continue
  lines.append(line if len(line)<=512 else '[OVERLONG ERROR LINE WITHHELD]')
 # Preserve the final error, rather than only the initial banner.
 chosen=lines if len(lines)<=7 else lines[:1]+['[LINES OMITTED]']+lines[-6:]
 return '\n'.join(chosen)[:4096]

def category(code,out,err,timeout,launched):
 if not launched:return 'CLIENT_LAUNCH_ERROR'
 if timeout:return 'TIMEOUT'
 if code==0:
  value=out.strip()
  if value in ['pending','null']:return 'PENDING'
  if re.fullmatch(ISO,value):
   try:datetime.datetime.fromisoformat(value.replace('Z','+00:00'));return 'TIMESTAMP'
   except ValueError:pass
  return 'SUCCESS_OTHER'
 text=out+'\n'+err
 if re.search(r'(?i)OCI runtime exec failed|executable file not found|no such container|container .* is not running',text):return 'EXEC_LAUNCH_ERROR'
 if re.search(r'ECONNREFUSED|(?i:connection refused)',text):return 'CONNECTION_REFUSED'
 if re.search(r'(?i)not (?:writable )?primary|not master|NotWritablePrimary',text):return 'NOT_PRIMARY'
 if re.search(r'MongoServerSelectionError|(?i:server selection)',text):return 'SERVER_SELECTION'
 if re.search(r'(?:Syntax|Type|Reference|Range|Eval)Error|MongoshInvalidInputError',text):return 'EVALUATION_ERROR'
 return 'UNCLASSIFIED_ERROR'

def execute(args,secrets,timeout=180):
 start=time.monotonic();code=None;timed_out=False;launched=True;errno=None
 # Temporary files are private, automatically deleted, never evidence artifacts.
 # Only bounded head/tail windows are read; counts reflect full stream byte sizes.
 with tempfile.TemporaryFile() as stdout,tempfile.TemporaryFile() as stderr:
  try:code=subprocess.run(args,stdout=stdout,stderr=stderr,timeout=timeout).returncode
  except subprocess.TimeoutExpired:timed_out=True
  except OSError as error:launched=False;errno=error.errno
  out,out_size,out_truncated=window(stdout);err,err_size,err_truncated=window(stderr)
 elapsed=round(time.monotonic()-start,3);classification=category(code,out,err,timed_out,launched)
 record={'exitCode':code,'timeout':timed_out,'elapsedSeconds':elapsed,'stdoutBytes':out_size,'stderrBytes':err_size,'stdoutTruncated':out_truncated,'stderrTruncated':err_truncated,'stdoutExcerpt':excerpt(out,secrets),'stderrExcerpt':excerpt(err,secrets),'classification':classification,'dockerClientLaunched':launched,'execProcessLaunched':False if classification in ['CLIENT_LAUNCH_ERROR','EXEC_LAUNCH_ERROR'] else True if code==0 or classification in ['CONNECTION_REFUSED','NOT_PRIMARY','SERVER_SELECTION','EVALUATION_ERROR'] else None,'launchErrno':errno}
 # Defense in depth before any caller can publish the structured result.
 if any(v in json.dumps(record) for v in variants(secrets)):raise RuntimeError('PROBE_PUBLICATION_REJECTED')
 return record,out

def probe_subprocess(args,secrets,timeout=180):return execute(args,secrets,timeout)[0]

def container_state(name,secrets):
 fmt='{{json .State.Running}} {{json .State.ExitCode}} {{json .RestartCount}} {{json .State.Pid}} {{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}}'
 record,out=execute(('docker','inspect','--format',fmt,name),secrets,8)
 result={'command':record,'running':None,'exitCodeIfStopped':None,'restartCount':None,'pidPresent':None,'health':None}
 match=re.fullmatch(r'(true|false) (-?\d+) (\d+) (\d+) "(none|starting|healthy|unhealthy)"\s*',out)
 if record['exitCode']==0 and match:
  running=match[1]=='true';result.update(running=running,exitCodeIfStopped=None if running else int(match[2]),restartCount=int(match[3]),pidPresent=int(match[4])>0,health=match[5])
 return result

def safe_fields(out,spec):
 try:data=json.loads(out)
 except (ValueError,TypeError):return {}
 if not isinstance(data,dict):return {}
 return {k:data[k] for k,validate in spec.items() if k in data and validate(data[k])}

def readonly_diagnostics(secrets):
 mongo=container_state('dapt-hosted-mongo',secrets)
 version,v=execute(('docker','exec','dapt-hosted-mongo','mongosh','--version'),secrets,8)
 version_value=v.strip() if re.fullmatch(r'\d{1,3}\.\d{1,3}\.\d{1,3}',v.strip()) else None
 hello="const h=await db.hello();print(JSON.stringify({ok:h.ok,isWritablePrimary:h.isWritablePrimary??h.ismaster,secondary:h.secondary,setName:h.setName}))"
 h,hout=execute(('docker','exec','dapt-hosted-mongo','mongosh','--quiet','--eval',hello),secrets,8)
 lookup="const x=await db.getSiblingDB('acceptance').operationalreadiness.findOne({_id:'execution-write-probe'},{_id:0,checkedAt:1});print(JSON.stringify({documentFound:!!x,checkedAtPresent:!!x&&Object.hasOwn(x,'checkedAt'),checkedAtValidDate:!!x&&x.checkedAt instanceof Date&&!isNaN(x.checkedAt.getTime())}))"
 q,qout=execute(('docker','exec','dapt-hosted-mongo','mongosh','--quiet','--eval',lookup),secrets,8)
 backend=container_state('dapt-hosted-backend',secrets)
 health="const q=require('http').get('http://127.0.0.1:5001/health',r=>{console.log(r.statusCode);r.resume()});q.setTimeout(2000,()=>q.destroy());q.on('error',()=>{console.log('HEALTH_CONNECTION_ERROR');process.exitCode=1})"
 b,bout=execute(('docker','exec','dapt-hosted-backend','node','-e',health),secrets,8)
 boolean=lambda v:type(v) is bool
 hello_fields=safe_fields(hout,{'ok':lambda v:type(v) in [int,float] and v in [0,1],'isWritablePrimary':boolean,'secondary':boolean,'setName':lambda v:v=='acceptance'})
 lookup_fields=safe_fields(qout,{k:boolean for k in ['documentFound','checkedAtPresent','checkedAtValidDate']})
 return {'mongo':mongo,'mongosh':{'command':version,'available':True if version['exitCode']==0 else False if version['classification']=='EXEC_LAUNCH_ERROR' else None,'version':version_value},'hello':{'command':h,'fields':hello_fields},'lookup':{'command':q,'fields':lookup_fields},'backend':backend,'backendHealth':{'command':b,'ready':b['exitCode']==0 and bout.strip()=='200'},'startupProbeRecordReady':q['exitCode']==0 and all(lookup_fields.get(k) is True for k in ['documentFound','checkedAtPresent','checkedAtValidDate'])}

def diagnose_once(secrets,report):
 result=probe_subprocess(PROBE,secrets)
 report('startup-probe-attempt',attempt=1,targetDatabase='acceptance',query='execution-write-probe lookup',**result)
 failed=result['exitCode']!=0 or result['timeout']
 report('startup-probe-readonly',**readonly_diagnostics(secrets))
 report('startup-probe-diagnostic-stop',outcome='FAILED_CAPTURED' if failed else 'NOT_REPRODUCED',rootCauseAutomaticallyEstablished=False,credentialsSubmitted=False,fullQualificationExecuted=False)
 raise RuntimeError('STARTUP_PROBE_DIAGNOSTIC_STOP')

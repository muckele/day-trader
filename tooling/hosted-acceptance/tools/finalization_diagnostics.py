"""Private-finalization observations. Raw command data stays in memory; no recovery policy."""
import json,subprocess,time,pathlib
STAGES=['PF01_PUBLICATION_SECRETS_START','PF02_PUBLICATION_SECRETS_RESULT','PF03_FINAL_LEAKAGE_START','PF04_FINAL_LEAKAGE_RESULT','PF05_SHUTDOWN_RPC_START','PF06_SHUTDOWN_RPC_SUBPROCESS_RESULT','PF07_SHUTDOWN_RPC_JSON_RESULT','PF08_CONTAINER_POLL_START','PF09_CONTAINER_POLL_STOPPED','PF10_CONTAINER_EXIT_CODE_CHECK','PF11_NORMAL_SHUTDOWN_RECEIPT','PF12_PRIVATE_FINALIZATION_COMPLETE','PF_FAILURE','PF_CONTAINER_FAILURE_SNAPSHOT','PF_OBSERVATION_OVERFLOW']
FAILURES=['CONTROL_EXEC_FAILED','CONTROL_EXEC_TIMEOUT','CONTROL_RESPONSE_EMPTY','CONTROL_JSON_INVALID','CONTROL_RESPONSE_REJECTED','CONTAINER_INSPECT_FAILED','BROWSER_EXIT_NONZERO','BROWSER_SHUTDOWN_TIMEOUT','NORMAL_SHUTDOWN_RECEIPT_FAILED','UNCLASSIFIED_FINALIZATION_ERROR']
BROWSER_STAGES=['BS01_SHUTDOWN_ENTER','BS02_ENTRY_INVALIDATED','BS03_PREAUTH_REMOVE_COMPLETE','BS04_ROUTE_FACTS_COMPLETE','BS05_PRIVATE_STATE_CLEARED','BS06_CONTEXT_CLOSE_START','BS07_CONTEXT_CLOSE_FINISH','BS08_CRASH_METADATA_START','BS09_CRASH_METADATA_FINISH','BS10_EXIT_TIMER_ARMED','BS11_COMMAND_RETURN','CS01_COMMAND_RESOLVED','CS02_RESPONSE_END_CALLED','CS03_RESPONSE_FINISH_OR_CALLBACK','CS_RESPONSE_FAILED','BS_FAILURE','browser-process-exit','BS_OBSERVATION_OVERFLOW']
BROWSER_FAILURES=['ENTRY_INVALIDATION_FAILED','PREAUTH_REMOVE_FAILED','ROUTE_FACTS_FAILED','PRIVATE_STATE_CLEAR_FAILED','CONTEXT_CLOSE_FAILED','CRASH_METADATA_FAILED','EXIT_TIMER_FAILED','CONTROL_RESPONSE_FAILED','UNCLASSIFIED_FINALIZATION_ERROR']
BOOLS=['started','completed','success','timeout','validJson','responseOk','running','previousWriteFailed','exitTimerArmed','commandReturned','responseEndCalled','responseFlushed','contextClosed','crashMetadataCompleted']
NUMBERS=['elapsedMs','returnCode','stdoutBytes','stderrBytes','pollCount','exitCode']
def safe(fields):
 out={}
 for k,v in fields.items():
  if k in BOOLS and (type(v) is bool or v is None):out[k]=v
  elif k in NUMBERS and (v is None or type(v) is int and -65536<=v<=2**53):out[k]=v
  elif k=='failure' and v in FAILURES:out[k]=v
 return out
class Diagnostics:
 def __init__(self,evidence,runner=subprocess.run,write=None,sleep=time.sleep):
  self.evidence=pathlib.Path(evidence);self.runner=runner;self.write=write;self.sleep=sleep;self.order=0;self.write_failed=False
 def mark(self,stage,**fields):
  if stage not in STAGES or self.order>256:return
  self.order+=1
  row={'stage':stage if self.order<=256 else 'PF_OBSERVATION_OVERFLOW','order':self.order,**safe(fields)}
  if self.write_failed:row['previousWriteFailed']=True
  try:
   if self.write:self.write(row)
   else:
    with (self.evidence/'private-finalization.jsonl').open('a') as out:out.write(json.dumps(row)+'\n')
  except Exception:self.write_failed=True
 def control(self,command,intake):
  stages={'publication-secrets':('PF01_PUBLICATION_SECRETS_START','PF02_PUBLICATION_SECRETS_RESULT'),'leakage':('PF03_FINAL_LEAKAGE_START','PF04_FINAL_LEAKAGE_RESULT'),'shutdown':('PF05_SHUTDOWN_RPC_START','PF06_SHUTDOWN_RPC_SUBPROCESS_RESULT')}
  start,result=stages[command];self.mark(start,started=True);began=time.monotonic()
  try:
   m=json.loads(pathlib.Path(intake).read_text());payload={'run':m['run'],'capability':m['capability'],'command':command}
   out=self.runner(['docker','exec','--user','501:20','-i',m['container'],'node','/tools/control.cjs'],input=json.dumps(payload),text=True,capture_output=True,timeout=150)
  except Exception as error:
   timeout=isinstance(error,subprocess.TimeoutExpired)
   self.mark(result,completed=True,success=False,timeout=timeout,returnCode=None,elapsedMs=int((time.monotonic()-began)*1000),stdoutBytes=_size(getattr(error,'stdout',None)),stderrBytes=_size(getattr(error,'stderr',None)),failure='CONTROL_EXEC_TIMEOUT' if timeout else 'CONTROL_EXEC_FAILED');raise
  facts={'completed':True,'elapsedMs':int((time.monotonic()-began)*1000),'returnCode':out.returncode,'timeout':False,'stdoutBytes':_size(out.stdout),'stderrBytes':_size(out.stderr),'success':out.returncode==0}
  if out.returncode!=0:facts['failure']='CONTROL_EXEC_FAILED'
  self.mark(result,**facts)
  parsed='PF07_SHUTDOWN_RPC_JSON_RESULT' if command=='shutdown' else result
  try:r=json.loads(out.stdout or '{}')
  except Exception:
   self.mark(parsed,completed=True,success=False,validJson=False,responseOk=None,failure='CONTROL_JSON_INVALID');raise
  # Match the old wrapper: empty stdout parses as {}, return code is observed, not a new guard.
  try:ok=r.get('ok')
  except Exception:
   self.mark(parsed,completed=True,success=False,validJson=True,responseOk=None,failure='CONTROL_JSON_INVALID');raise
  success=ok==True
  self.mark(parsed,completed=True,success=success,validJson=bool(out.stdout),responseOk=ok if type(ok) is bool else None,**({} if success else {'failure':'CONTROL_RESPONSE_EMPTY' if not out.stdout else 'CONTROL_RESPONSE_REJECTED'}))
  if not success:raise RuntimeError('CONTROL_'+command.replace('-','_').upper())
  return r
 def poll(self):
  self.mark('PF08_CONTAINER_POLL_START',started=True);began=time.monotonic()
  for i in range(50):
   try:
    out=self.runner(('docker','inspect','dapt-hosted-browser'),capture_output=True,text=True,timeout=180)
    if out.returncode:raise RuntimeError('COMMAND_FAILED_docker')
    state=json.loads(out.stdout.strip())[0]['State']
    running=state['Running']
   except Exception:
    self.mark('PF09_CONTAINER_POLL_STOPPED',completed=True,success=False,pollCount=i+1,elapsedMs=int((time.monotonic()-began)*1000),failure='CONTAINER_INSPECT_FAILED');raise
   if not running:break
   self.sleep(.2)
  else:
   self.mark('PF09_CONTAINER_POLL_STOPPED',completed=True,success=False,pollCount=50,running=True,elapsedMs=int((time.monotonic()-began)*1000),failure='BROWSER_SHUTDOWN_TIMEOUT');raise RuntimeError('BROWSER_SHUTDOWN_TIMEOUT')
  self.mark('PF09_CONTAINER_POLL_STOPPED',completed=True,success=True,pollCount=i+1,running=False,exitCode=state.get('ExitCode'),elapsedMs=int((time.monotonic()-began)*1000))
  try:success=state['ExitCode']==0
  except Exception:
   self.mark('PF10_CONTAINER_EXIT_CODE_CHECK',completed=True,success=False,failure='CONTAINER_INSPECT_FAILED');raise
  self.mark('PF10_CONTAINER_EXIT_CODE_CHECK',completed=True,success=success,exitCode=state['ExitCode'],**({} if success else {'failure':'BROWSER_EXIT_NONZERO'}))
  if not success:raise RuntimeError('BROWSER_SHUTDOWN_FAILED')
  return state
 def receipt(self,report,code):
  self.mark('PF11_NORMAL_SHUTDOWN_RECEIPT',started=True)
  try:report('browser-normal-shutdown',passCheck=True,controllerExitCode=code)
  except Exception:
   self.mark('PF11_NORMAL_SHUTDOWN_RECEIPT',completed=True,success=False,failure='NORMAL_SHUTDOWN_RECEIPT_FAILED');raise
  self.mark('PF11_NORMAL_SHUTDOWN_RECEIPT',completed=True,success=True)
 def complete(self):self.mark('PF12_PRIVATE_FINALIZATION_COMPLETE',completed=True,success=True)
 def snapshot(self):
  # One read-only diagnostic observation after failure, never retrying an RPC or normal polling.
  try:
   out=self.runner(['docker','inspect','--format','{{json .State}}','dapt-hosted-browser'],capture_output=True,text=True,timeout=8)
   if out.returncode:raise ValueError()
   state=json.loads(out.stdout)
   self.mark('PF_CONTAINER_FAILURE_SNAPSHOT',completed=True,success=True,running=state['Running'],exitCode=state['ExitCode'])
  except Exception:self.mark('PF_CONTAINER_FAILURE_SNAPSHOT',completed=True,success=False,failure='CONTAINER_INSPECT_FAILED')
def _size(data):return len(data.encode() if isinstance(data,str) else data or b'')
def collect(evidence):
 result={}
 for key,name,stages,failures in [('python','private-finalization.jsonl',STAGES,FAILURES),('browser','browser-finalization.jsonl',BROWSER_STAGES,BROWSER_FAILURES)]:
  p=pathlib.Path(evidence)/name;rows=[]
  if p.exists():
   if p.stat().st_size>262144:raise ValueError('FINALIZATION_EVIDENCE_INVALID')
   for line in p.read_text().splitlines():
    r=json.loads(line)
    if not isinstance(r,dict) or r.get('stage') not in stages or type(r.get('order')) is not int or not 1<=r['order']<=257:raise ValueError('FINALIZATION_EVIDENCE_INVALID')
    for k,v in r.items():
     if k in ['stage','order']:continue
     if k=='instance' and isinstance(v,str) and (v=='unknown' or len(v)==36 and all(c in '0123456789abcdef-' for c in v)):continue
     if k=='failure' and v in failures:continue
     if k in safe({k:v}):continue
     raise ValueError('FINALIZATION_EVIDENCE_INVALID')
    rows.append(r)
   if len(rows)>800:raise ValueError('FINALIZATION_EVIDENCE_INVALID')
  result[key]=rows
 return result

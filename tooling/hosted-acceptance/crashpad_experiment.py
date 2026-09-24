"""One hosted, no-credential A1/B/A2 intervention; no local Docker execution."""
import os,pathlib,sys,json,subprocess,time,hashlib,shutil
ROOT=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'tools'))
import provision as p
import run as driver
TRIALS=(('A1',p.BASELINE_CRASH),('B',p.WRITABLE_CRASH),('A2',p.BASELINE_CRASH))
TIMEOUT=60

def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def report(name,**fields):driver.report(name,**fields)
def fresh_profile(profile):
 profile.mkdir(mode=0o700)
 (profile/'home/.config/google-chrome-for-testing/Crash Reports').mkdir(parents=True,mode=0o700)
 rows=[]
 for root,dirs,files in os.walk(profile):
  if files:raise RuntimeError('PROFILE_NOT_EMPTY')
  os.chown(root,501,20)
  st=pathlib.Path(root).stat();rows.append({'path':str(pathlib.Path(root).relative_to(profile)),'mode':oct(st.st_mode&0o7777),'uid':st.st_uid,'gid':st.st_gid})
 return sorted(rows,key=lambda x:x['path'])
def invariant_configuration(obj):
 h=obj['HostConfig'];c=obj['Config']
 # Trial paths/names and the single intended mount policy are excluded; all other
 # effective settings, container environment and mount destinations must agree.
 return {'image':obj['Image'],'user':c['User'],'hostname':c['Hostname'],'environmentHash':digest(c['Env']),'entrypoint':c['Entrypoint'],'command':c['Cmd'],
  'host':{k:h[k] for k in ['NetworkMode','CapAdd','CapDrop','SecurityOpt','Privileged','ReadonlyRootfs','ShmSize','Ulimits','Memory','MemorySwap','NanoCpus','PidsLimit','IpcMode','PidMode','CgroupnsMode','LogConfig']},
  'otherTmpfs':{k:v for k,v in h['Tmpfs'].items() if k!=p.CRASH_TARGET},
  'bindMounts':sorted([{'destination':m['Destination'],'rw':m['RW'],'type':m['Type'],'propagation':m['Propagation']} for m in obj['Mounts'] if m['Type']!='tmpfs'],key=lambda m:m['destination'])}
def public_configuration(value):
 public=json.loads(json.dumps(value));options=public['host'].pop('SecurityOpt')
 public['host']['securityOptions']={'noNewPrivileges':any(x.startswith('no-new-privileges') for x in options),'seccompOptionHash':digest([x for x in options if x.startswith('seccomp')]),'optionCount':len(options)}
 return public
def normal_flags(m):
 return {key:sorted(x for x in m[key] if x not in ['ro','rw'] and not x.startswith(('mode=','uid=','gid='))) for key in ['mountFlags','superOptions']}
def analyze(records,trial,exit_code,timed_out):
 rows=[d for r in records if r.get('check')=='startup-facts' for d in r['data']]
 excerpts=[r['data'] for r in records if r.get('check')=='startup-excerpt' and r.get('source')=='browser.txt']
 text='\n'.join(x['text'] for c in excerpts for x in c['lines'])
 before=next((x for x in rows if x.get('component')=='crash-mount' and x.get('status')=='before'),None)
 after=next((x for x in rows if x.get('component')=='crash-mount' and x.get('status')=='after'),None)
 versions=next((x for x in rows if x.get('status')=='versions'),None)
 security=next((x['security'] for x in rows if x.get('component')=='browser' and x.get('status')=='facts'),None)
 expected=('700',501,20,'rw') if trial=='B' else ('0',0,0,'ro')
 security_valid=bool(security and security.get('NoNewPrivs')=='1' and security.get('Seccomp')=='2' and all(security.get(k)=='0000000000000000' for k in ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) and security.get('Uid','').split()==['501']*4 and security.get('Gid','').split()==['20']*4)
 valid=bool(security_valid and before and after and versions and security and before['mount']['type']=='tmpfs' and before['object']['mode']==expected[0] and before['object']['ownerUid']==expected[1] and before['object']['ownerGid']==expected[2] and expected[3] in before['mount']['mountFlags'] and 'size=1024k' in before['mount']['superOptions'])
 terminal=bool(excerpts and all(x['final'] and x['terminalWindowComplete'] for x in excerpts) and not any(x.get('check')=='startup-evidence-withheld' for x in records))
 complete=terminal and all(not x['truncated'] for x in excerpts)
 success=bool(any(x.get('component')=='startup-probe' and x.get('status')=='closed' and x.get('normalClose') for x in rows) and any(x.get('component')=='startup-probe' and x.get('status')=='responsive' and x.get('namespaceSandbox') and x.get('seccompSandbox') for x in rows) and exit_code==0 and not timed_out and '<process did exit: exitCode=0, signal=null>' in text)
 denial=bool('mkdir '+p.CRASH_TARGET+'/new: Permission denied (13)' in text)
 original=bool(denial and 'recvmsg: Connection reset by peer (104)' in text and 'signal=SIGTRAP' in text and not success)
 return {'trial':trial,'success':success,'originalPattern':original,'mkdirDenial':denial,'exitCode':exit_code,'timedOut':timed_out,'configurationValid':valid,'completeBrowserDebugStream':complete,'terminalEvidenceRetained':terminal,'before':before,'after':after,'versions':versions,'security':security}
def outcome(results):
 if len(results)!=3 or not all(x['configurationValid'] and x['equivalent'] and x['terminalEvidenceRetained'] for x in results):return 'inconclusive'
 a,b,c=results
 if a['originalPattern'] and c['originalPattern']:
  if b['success']:return 'supported'
  if not b['success'] and not b['mkdirDenial'] and not b['timedOut'] and b['completeBrowserDebugStream']:return 'not sufficient'
 return 'inconclusive'
def main():
 if not p.experiment_enabled() or os.environ.get('GITHUB_RUN_ATTEMPT')!='1':raise RuntimeError('HOSTED_DIAGNOSTIC_ONLY')
 claim=p.R/'crashpad-experiment-started';claim.touch(mode=0o600,exist_ok=False)
 swap={k:int(v.split()[0])*1024 for k,v in (line.split(':',1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines()) if k in ['SwapTotal','SwapFree','SwapCached']}
 report('experiment-begin',trials=['A1','B','A2'],startupTimeoutSeconds=TIMEOUT,swapBytes=swap,swapDevices=len(pathlib.Path('/proc/swaps').read_text().splitlines())-1,tmpfsMayUseSwap=True,crashContentsRead=False)
 driver.run(sys.executable,str(ROOT/'tools/provision.py'))
 image=driver.run('docker','image','inspect',p.TOOL,'--format','{{.Id}}')
 ledger=json.loads((p.E/'resources.json').read_text());p.RES=ledger;p.LOCK=hashlib.sha256((p.P/'config/lock.json').read_bytes()).hexdigest()
 trials=p.P/'trials';trials.mkdir(mode=0o700);evroot=p.E/'trials';evroot.mkdir(mode=0o700)
 results=[];reference=None
 for trial,policy in TRIALS:
  profile=trials/trial;evidence=evroot/trial;evidence.mkdir(mode=0o700);os.chown(evidence,501,20)
  initial=fresh_profile(profile);cid=None;records=None;timed_out=False
  report('trial-begin',trial=trial,crashTarget=p.CRASH_TARGET,requestedPolicy=policy,image=image,emptyProfile=True,initialProfileMetadata=initial,initialProfileHash=digest(initial))
  try:
   cid=p.drun('browser-'+trial.lower(),p.browser_options(profile,evidence,policy,experiment=True),image,'sh','/tools/browser-start.sh')
   obj=json.loads(driver.run('docker','inspect',cid))[0];effective=invariant_configuration(obj)
   deadline=time.monotonic()+TIMEOUT
   while obj['State']['Running'] and time.monotonic()<deadline:
    time.sleep(.2);obj=json.loads(driver.run('docker','inspect',cid))[0]
   if obj['State']['Running']:
    timed_out=True;driver.run('docker','stop','--time','2',cid);obj=json.loads(driver.run('docker','inspect',cid))[0]
   records=driver.startup_summary(evidence,trial)
   result=analyze(records,trial,obj['State']['ExitCode'],timed_out)
   v=result['versions'] or {};stable={'configuration':effective,'initialProfile':initial,'versions':{k:v.get(k) for k in ['playwrightVersion','browserVersion','executable','executableSha256']},'mountFlags':normal_flags(result['before']['mount']) if result['before'] else None,'security':result['security']}
   if reference is None:reference=stable
   result['equivalent']=stable==reference
   report('trial-result',trial=trial,**{k:result[k] for k in ['success','originalPattern','mkdirDenial','exitCode','timedOut','configurationValid','completeBrowserDebugStream','terminalEvidenceRetained','equivalent']},invariantHash=digest(stable),effectiveConfiguration=public_configuration(effective))
   results.append(result)
  finally:
   try:
    if records is None and evidence.exists():driver.startup_summary(evidence,trial)
   finally:
    if cid:
     obj=json.loads(driver.run('docker','inspect',cid))[0]
     if obj['Config']['Labels'].get('day-trader.acceptance')!=p.PREFIX:raise RuntimeError('CLEANUP_IDENTITY_REJECTED')
     driver.run('docker','rm','-f','-v',cid)
    shutil.rmtree(profile);shutil.rmtree(evidence)
    report('trial-cleanup',trial=trial,containerRemoved=bool(cid),freshProfileRemoved=not profile.exists(),privateEvidenceRemoved=not evidence.exists(),crashTmpfsDestroyed=bool(cid))
  if not result['configurationValid'] or not result['equivalent'] or (trial=='A1' and not (result['originalPattern'] and result['completeBrowserDebugStream'])):
   report('experiment-stop',trial=trial,reason='BASELINE_OR_EQUIVALENCE_NOT_ESTABLISHED');break
 result=outcome(results);report('experiment-outcome',outcome=result,trialsExecuted=len(results),internalTrapInstructionIdentified=False,productionSuitabilityEstablished=False)
 print('HOSTED_CRASHPAD_EXPERIMENT_COMPLETE',flush=True)
if __name__=='__main__':
 try:main()
 except Exception:
  report('experiment-outcome',outcome='inconclusive',reason='EXPERIMENT_CONTROLLER_ERROR');raise SystemExit(1)

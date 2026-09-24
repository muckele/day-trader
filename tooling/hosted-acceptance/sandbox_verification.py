"""One fresh hosted B trial; no ABA loop, credentials, or application navigation."""
import os,sys,pathlib,json,time,hashlib,shutil,re
import crashpad_experiment as e
p=e.p;driver=e.driver;ROOT=e.ROOT
EXPECTED_BROWSER_HASH='481fea1516a1f2b76454664272f12cd9dd1f20117b21e1f1498e08bc7f872c00'

def assess(records,exit_code,timed_out):
 analysis=e.analyze(records,'B',exit_code,timed_out)
 facts=[d for row in records if row.get('check')=='startup-facts' for d in row['data']]
 observed=[d for d in facts if d.get('component')=='Chromium-sandbox' and d.get('status')=='observed']
 native=[x['text'] for row in records if row.get('check')=='startup-excerpt' and row.get('source')=='browser.txt' for x in row['data']['lines']]
 launched=[int(m.group(1)) for text in native if (m:=re.search(r'pw:browser <launched> pid=(\d+)',text))]
 exits=[{'pid':int(m.group(1)),'exitCode':m.group(2),'signal':m.group(3)} for text in native if (m:=re.search(r'pw:browser \[pid=(\d+)\] <process did exit: exitCode=([^,]+), signal=([^>]+)>',text))]
 forced=any('<kill>' in text or '<will force kill>' in text for text in native)
 normal=bool(len(launched)==1 and len(exits)==1 and exits[0]=={'pid':launched[0],'exitCode':'0','signal':'null'} and not forced)
 version=analysis['versions'] or {}
 identity=version.get('browserVersion')=='Google Chrome for Testing 145.0.7632.6' and version.get('playwrightVersion')=='1.58.2' and version.get('executableSha256')==EXPECTED_BROWSER_HASH
 expected_flags={'mountFlags':['nodev','noexec','nosuid','relatime'],'superOptions':['inode64','size=1024k']}
 mounts=bool(analysis['before'] and analysis['after'] and e.normal_flags(analysis['before']['mount'])==expected_flags and analysis['after']['mount']==analysis['before']['mount'])
 pass_check=bool(analysis['success'] and analysis['configurationValid'] and analysis['terminalEvidenceRetained'] and len(observed)==1 and observed[0].get('pass') is True and normal and identity and mounts)
 return {'passCheck':pass_check,'sandboxObserved':len(observed)==1,'sandboxPass':len(observed)==1 and observed[0].get('pass') is True,'normalChromiumExit':normal,'forcedKillObserved':forced,'termination':exits,'controllerExitCode':exit_code,'timedOut':timed_out,'identityMatchesPreviousB':identity,'mountControlsMatchPreviousB':mounts,'configurationValid':analysis['configurationValid'],'terminalEvidenceRetained':analysis['terminalEvidenceRetained']}
def main():
 if not p.experiment_enabled() or os.environ.get('GITHUB_RUN_ATTEMPT')!='1':raise RuntimeError('HOSTED_DIAGNOSTIC_ONLY')
 (p.R/'sandbox-verification-started').touch(mode=0o600,exist_ok=False)
 swap={k:int(v.split()[0])*1024 for k,v in (line.split(':',1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines()) if k in ['SwapTotal','SwapFree','SwapCached']}
 e.report('sandbox-verification-begin',trial='B',maximumStartupTrials=1,startupTimeoutSeconds=e.TIMEOUT,swapBytes=swap,swapDevices=len(pathlib.Path('/proc/swaps').read_text().splitlines())-1,tmpfsMayUseSwap=True,crashContentsRead=False)
 driver.run(sys.executable,str(ROOT/'tools/provision.py'))
 image=driver.run('docker','image','inspect',p.TOOL,'--format','{{.Id}}')
 p.RES=json.loads((p.E/'resources.json').read_text());p.LOCK=hashlib.sha256((p.P/'config/lock.json').read_bytes()).hexdigest()
 (p.P/'trials').mkdir(mode=0o700);(p.E/'trials').mkdir(mode=0o700)
 profile=p.P/'trials/B';evidence=p.E/'trials/B';evidence.mkdir(mode=0o700);os.chown(evidence,501,20)
 initial=e.fresh_profile(profile);cid=None;records=None;timed_out=False;result=None
 e.report('trial-begin',trial='B',crashTarget=p.CRASH_TARGET,requestedPolicy=p.WRITABLE_CRASH,image=image,emptyProfile=True,initialProfileMetadata=initial,initialProfileHash=e.digest(initial))
 try:
  # The only browser startup reachable in this driver.
  cid=p.drun('browser-b',p.browser_options(profile,evidence,p.WRITABLE_CRASH,experiment=True),image,'sh','/tools/browser-start.sh')
  obj=json.loads(driver.run('docker','inspect',cid))[0];effective=e.public_configuration(e.invariant_configuration(obj))
  deadline=time.monotonic()+e.TIMEOUT
  while obj['State']['Running'] and time.monotonic()<deadline:
   time.sleep(.2);obj=json.loads(driver.run('docker','inspect',cid))[0]
  if obj['State']['Running']:
   timed_out=True;driver.run('docker','stop','--time','2',cid);obj=json.loads(driver.run('docker','inspect',cid))[0]
  records=driver.startup_summary(evidence,'B');result=assess(records,obj['State']['ExitCode'],timed_out)
  e.report('sandbox-verification-observed',trial='B',**result,effectiveConfiguration=effective)
 finally:
  try:
   if records is None and evidence.exists():driver.startup_summary(evidence,'B')
  finally:
   if cid:
    obj=json.loads(driver.run('docker','inspect',cid))[0]
    if obj['Config']['Labels'].get('day-trader.acceptance')!=p.PREFIX:raise RuntimeError('CLEANUP_IDENTITY_REJECTED')
    driver.run('docker','rm','-f','-v',cid)
   shutil.rmtree(profile);shutil.rmtree(evidence)
   e.report('trial-cleanup',trial='B',containerRemoved=bool(cid),freshProfileRemoved=not profile.exists(),privateEvidenceRemoved=not evidence.exists(),crashTmpfsDestroyed=bool(cid))
 e.report('sandbox-verification-result',passCheck=result['passCheck'],browserCleanupPassed=True,sharedCleanupPending=True,startupTrialsExecuted=1)
 return 0 if result['passCheck'] else 1
if __name__=='__main__':
 try:code=main()
 except Exception:
  e.report('sandbox-verification-result',passCheck=False,reason='SANDBOX_VERIFICATION_CONTROLLER_ERROR');code=1
 sys.exit(code)

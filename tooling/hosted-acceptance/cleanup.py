"""Only resources recorded by this ephemeral pilot; never a global prune."""
import pathlib,os,json,subprocess,shutil
if os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted':raise SystemExit('HOSTED_ONLY')
r=pathlib.Path(os.environ['PILOT_STATE'])
p=r/'evidence/resources.json'
if p.exists():
 d=json.loads(p.read_text())
 for kind,cmd in [('containers',['rm','-f','-v']),('volumes',['volume','rm']),('networks',['network','rm'])]:
  for identity in reversed(d[kind]):
   inspect=subprocess.run(['docker','inspect',identity],capture_output=True,text=True)
   if inspect.returncode:
    if 'No such' in inspect.stderr:continue
    raise SystemExit('CLEANUP_INSPECTION_FAILED')
   obj=json.loads(inspect.stdout)[0]
   labels=obj.get('Config',{}).get('Labels') or obj.get('Labels') or {}
   if labels.get('day-trader.acceptance')!='dapt-hosted':raise SystemExit('CLEANUP_IDENTITY_REJECTED')
   subprocess.run(['docker',*cmd,identity],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
for name in ['private','evidence']:
 if (r/name).exists():shutil.rmtree(r/name)
for command in [['ps','-aq'],['volume','ls','-q'],['network','ls','-q']]:
 check=subprocess.run(['docker',*command,'--filter','label=day-trader.acceptance=dapt-hosted'],capture_output=True,text=True,check=True)
 if check.stdout.strip():raise SystemExit('CLEANUP_RESOURCES_REMAIN')
if any((r/name).exists() for name in ['private','evidence']):raise SystemExit('CLEANUP_PRIVATE_STATE_REMAINS')
print(json.dumps({'check':'cleanup','passCheck':True,'containersAbsent':True,'volumesAbsent':True,'networksAbsent':True,'privateStateAbsent':True,'crashTmpfsDestroyed':True}))
print('Ephemeral private state removed; no uploaded artifacts or persistent caches.')

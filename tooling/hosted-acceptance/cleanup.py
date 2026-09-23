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
   if inspect.returncode:continue
   obj=json.loads(inspect.stdout)[0]
   labels=obj.get('Config',{}).get('Labels') or obj.get('Labels') or {}
   if labels.get('day-trader.acceptance')!='dapt-hosted':raise SystemExit('CLEANUP_IDENTITY_REJECTED')
   subprocess.run(['docker',*cmd,identity],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
for name in ['private','evidence']:
 if (r/name).exists():shutil.rmtree(r/name)
print('Ephemeral private state removed; no uploaded artifacts or persistent caches.')

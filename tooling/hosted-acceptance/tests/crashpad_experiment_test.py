"""Non-Docker tests of experiment policy, classification, and controlled inputs."""
import os,pathlib,sys,unittest,copy,subprocess,ast,tempfile,json
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
os.environ.setdefault('PILOT_STATE','/tmp/synthetic-experiment-test-no-workload')
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'tools'))
# Existing cryptography is unnecessary for these pure policy tests.
import types
for name in ['cryptography','cryptography.x509','cryptography.x509.oid','cryptography.hazmat','cryptography.hazmat.primitives','cryptography.hazmat.primitives.asymmetric']:
 sys.modules[name]=types.ModuleType(name)
sys.modules['cryptography.x509.oid'].NameOID=object()
sys.modules['cryptography.hazmat.primitives'].hashes=object();sys.modules['cryptography.hazmat.primitives'].serialization=object();sys.modules['cryptography.hazmat.primitives.asymmetric'].rsa=object()
import crashpad_experiment as e
HOSTED={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','PILOT_DIAGNOSTIC_ONLY':'1','PILOT_CRASHPAD_EXPERIMENT':'aba-v1'}
def result(original=False,success=False,denial=False):
 return dict(configurationValid=True,equivalent=True,terminalEvidenceRetained=True,completeBrowserDebugStream=True,originalPattern=original,success=success,mkdirDenial=denial,timedOut=False)
class Experiment(unittest.TestCase):
 def test_only_mount_access_policy_differs(self):
  with patch.dict(os.environ,HOSTED,clear=True):
   options=[e.p.browser_options(pathlib.Path('/fresh/profile'),pathlib.Path('/fresh/evidence'),policy,True) for _,policy in e.TRIALS]
  a,b,c=options;self.assertEqual(a,c)
  differences=[(x,y) for x,y in zip(a,b) if x!=y];self.assertEqual(len(differences),1)
  self.assertEqual(differences[0],(e.p.CRASH_TARGET+':'+e.p.BASELINE_CRASH,e.p.CRASH_TARGET+':'+e.p.WRITABLE_CRASH));self.assertEqual(len(a),len(b))
 def test_production_default_remains_baseline(self):
  with patch.dict(os.environ,{},clear=True):
   a=e.p.browser_options(pathlib.Path('/profile'),pathlib.Path('/evidence'))
   self.assertIn(e.p.CRASH_TARGET+':'+e.p.BASELINE_CRASH,a);self.assertNotIn('PILOT_CRASHPAD_EXPERIMENT=aba-v1',a)
   with self.assertRaises(RuntimeError):e.p.browser_options(pathlib.Path('/profile'),pathlib.Path('/evidence'),e.p.WRITABLE_CRASH)
   with self.assertRaises(RuntimeError):e.p.browser_options(pathlib.Path('/profile'),pathlib.Path('/evidence'),e.p.WRITABLE_CRASH,True)
 def test_refactor_preserves_original_default_arguments(self):
  base=subprocess.check_output(['git','show','ad3b91f67bebe23e844f287e2621ddc5be04500b:tooling/hosted-acceptance/tools/provision.py'],text=True)
  tree=ast.parse(base);call=next(n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='drun' and isinstance(n.args[0],ast.Constant) and n.args[0].value=='browser')
  common=['-v',str(e.p.T)+':/tools:ro','-v',str(e.p.P/'config')+':/config:ro','-v',str(e.p.E)+':/evidence']
  old=eval(compile(ast.Expression(call.args[1]),'<baseline-options>','eval'),{'str':str,'T':e.p.T,'P':e.p.P,'PREFIX':e.p.PREFIX,'common':common})
  self.assertEqual(old,e.p.browser_options(e.p.P/'profile',e.p.E))
 def test_supported_requires_aba_reversal(self):
  a=result(original=True,denial=True);b=result(success=True);c=copy.deepcopy(a)
  self.assertEqual(e.outcome([a,b,c]),'supported');self.assertEqual(e.outcome([a,b]),'inconclusive')
  c['originalPattern']=False;self.assertEqual(e.outcome([a,b,c]),'inconclusive')
 def test_remaining_failure_is_not_sufficient_only_with_complete_negative_evidence(self):
  a=result(original=True,denial=True);b=result();self.assertEqual(e.outcome([a,b,a]),'not sufficient')
  b['completeBrowserDebugStream']=False;self.assertEqual(e.outcome([a,b,a]),'inconclusive')
 def test_inconsistent_or_missing_security_evidence_is_inconclusive(self):
  for key in ['configurationValid','equivalent','terminalEvidenceRetained']:
   a=result(original=True,denial=True);b=result(success=True);b[key]=False
   self.assertEqual(e.outcome([a,b,a]),'inconclusive')
 def test_effective_mount_comparison_keeps_non_access_flags(self):
  a={'mountFlags':['ro','nosuid','nodev','noexec'],'superOptions':['ro','size=1024k','mode=0']}
  b={'mountFlags':['rw','nosuid','nodev','noexec'],'superOptions':['rw','size=1024k','mode=700','uid=501','gid=20']}
  self.assertEqual(e.normal_flags(a),e.normal_flags(b));b['mountFlags'].remove('noexec');self.assertNotEqual(e.normal_flags(a),e.normal_flags(b))
 def test_public_configuration_omits_seccomp_host_path_or_json(self):
  value={'host':{'SecurityOpt':['no-new-privileges','seccomp=/private/runner/policy.json']}}
  public=e.public_configuration(value)
  self.assertNotIn('/private/runner',str(public));self.assertTrue(public['host']['securityOptions']['noNewPrivileges']);self.assertEqual(len(public['host']['securityOptions']['seccompOptionHash']),64)
  self.assertIn('SecurityOpt',value['host'])
 def test_controller_stops_after_non_reproducing_a1_and_cleans_state(self):
  with tempfile.TemporaryDirectory() as temp:
   r=pathlib.Path(temp);private=r/'private';evidence=r/'evidence';private.mkdir();evidence.mkdir();(private/'config').mkdir();(private/'config/lock.json').write_text('{}');(evidence/'resources.json').write_text('{"containers":[],"volumes":[],"networks":[]}')
   inv={'host':{'SecurityOpt':['no-new-privileges','seccomp=synthetic']}};events=[];launches=[];commands=[]
   def fake_run(*args):
    commands.append(args)
    if args[:3]==('docker','image','inspect'):return 'sha256:synthetic'
    if args[:2]==('docker','inspect'):return json.dumps([{'State':{'Running':False,'ExitCode':0},'Config':{'Labels':{'day-trader.acceptance':e.p.PREFIX}}}])
    return ''
   def fake_fresh(profile):profile.mkdir();return []
   original_read_text=pathlib.Path.read_text
   a=result(success=True);a.update(trial='A1',exitCode=0,before={'mount':{'mountFlags':['ro'],'superOptions':['size=1024k']}},after={},versions={},security={})
   # No subprocess is invoked: Docker-like arguments reach only this mock.
   with patch('builtins.print'),patch.dict(os.environ,{**HOSTED,'GITHUB_RUN_ATTEMPT':'1'},clear=True),patch.multiple(e.p,R=r,P=private,E=evidence),patch.object(e.driver,'run',side_effect=fake_run),patch.object(e.p,'drun',side_effect=lambda *args:launches.append(args) or 'synthetic-cid'),patch.object(e.driver,'startup_summary',return_value=[]),patch.object(e,'fresh_profile',side_effect=fake_fresh),patch.object(e.os,'chown'),patch.object(e,'invariant_configuration',return_value=inv),patch.object(e,'analyze',return_value=a),patch.object(e,'report',side_effect=lambda name,**kw:events.append((name,kw))),patch.object(pathlib.Path,'read_text',autospec=True,side_effect=lambda path,*args,**kwargs:'SwapTotal: 0 kB\nSwapFree: 0 kB\nSwapCached: 0 kB\n' if str(path)=='/proc/meminfo' else 'Filename Type Size Used Priority\n' if str(path)=='/proc/swaps' else original_read_text(path,*args,**kwargs)):
    e.main()
   self.assertEqual(len(launches),1);self.assertEqual(launches[0][0],'browser-a1');self.assertFalse((private/'trials/A1').exists());self.assertFalse((evidence/'trials/A1').exists());self.assertTrue(any(c[:4]==('docker','rm','-f','-v') for c in commands));self.assertEqual(events[-1][1]['outcome'],'inconclusive')
 def test_fresh_profiles_are_equivalent_and_never_reused(self):
  with tempfile.TemporaryDirectory() as temp,patch.object(e.os,'chown') as chown:
   root=pathlib.Path(temp);first=e.fresh_profile(root/'B');(root/'B/synthetic-state').write_text('synthetic')
   second=e.fresh_profile(root/'A2');self.assertEqual(first,second);self.assertFalse((root/'A2/synthetic-state').exists());self.assertTrue(chown.called)
   with self.assertRaises(FileExistsError):e.fresh_profile(root/'B')
if __name__=='__main__':unittest.main()

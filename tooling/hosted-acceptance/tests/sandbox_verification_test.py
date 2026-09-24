"""Constructed verification-result fixtures, never prior B runtime evidence."""
import pathlib,sys,unittest,copy,ast,tempfile,os,json
from unittest.mock import patch
# Reuse import stubs only; no Docker command or workload is executed.
import crashpad_experiment_test
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
import sandbox_verification as v

def fixture():
 rows=[{'component':'Chromium-sandbox','status':'observed','pass':True}]
 text=['pw:browser <launched> pid=43','pw:browser [pid=43] <process did exit: exitCode=0, signal=null>']
 return [{'check':'startup-facts','data':rows},{'check':'startup-excerpt','source':'browser.txt','data':{'lines':[{'text':x} for x in text]}}]
def analysis():
 mount={'mountFlags':['nodev','noexec','nosuid','relatime','rw'],'superOptions':['gid=20','inode64','mode=700','rw','size=1024k','uid=501']}
 return {'success':True,'configurationValid':True,'terminalEvidenceRetained':True,'before':{'mount':mount},'after':{'mount':mount},'versions':{'browserVersion':'Google Chrome for Testing 145.0.7632.6','playwrightVersion':'1.58.2','executableSha256':v.EXPECTED_BROWSER_HASH}}
class Verification(unittest.TestCase):
 def test_positive_needs_attestation_normal_exit_identity_and_mount_controls(self):
  with patch.object(v.e,'analyze',return_value=analysis()):self.assertTrue(v.assess(fixture(),0,False)['passCheck'])
 def test_forced_kill_missing_or_wrong_termination_rejected(self):
  for line in ['pw:browser [pid=43] <will force kill>','pw:browser [pid=43] <kill>']:
   rows=fixture();rows[1]['data']['lines'].append({'text':line})
   with patch.object(v.e,'analyze',return_value=analysis()):self.assertFalse(v.assess(rows,0,False)['passCheck'])
  for terminal in ['','pw:browser [pid=43] <process did exit: exitCode=null, signal=SIGTRAP>','pw:browser [pid=44] <process did exit: exitCode=0, signal=null>']:
   rows=fixture();rows[1]['data']['lines'][1]['text']=terminal
   with patch.object(v.e,'analyze',return_value=analysis()):self.assertFalse(v.assess(rows,0,False)['passCheck'])
 def test_launch_alone_or_failed_sandbox_cannot_pass(self):
  for rows in [[],[{'component':'Chromium-sandbox','status':'observed','pass':False}]]:
   f=fixture();f[0]['data']=rows
   with patch.object(v.e,'analyze',return_value=analysis()):self.assertFalse(v.assess(f,0,False)['passCheck'])
 def test_changed_browser_or_mount_fails(self):
  for mutate in [lambda a:a['versions'].update(executableSha256='wrong'),lambda a:a.update(after={'mount':{'mountFlags':[],'superOptions':[]}}),lambda a:a.update(configurationValid=False)]:
   a=analysis();mutate(a)
   with patch.object(v.e,'analyze',return_value=a):self.assertFalse(v.assess(fixture(),0,False)['passCheck'])
 def test_driver_has_one_startup_no_trial_loop_or_aba_main(self):
  source=pathlib.Path(v.__file__).read_text();tree=ast.parse(source)
  starts=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='drun']
  self.assertEqual(len(starts),1);self.assertEqual(starts[0].args[0].value,'browser-b')
  self.assertFalse(any(isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='main' for n in ast.walk(tree)))
  main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main');self.assertFalse(any(isinstance(n,ast.For) for n in ast.walk(main)))
 def test_orchestration_runs_once_on_pass_or_failure_and_always_cleans(self):
  for passed in [True,False]:
   with self.subTest(passed=passed),tempfile.TemporaryDirectory() as temp:
    r=pathlib.Path(temp);private=r/'private';evidence=r/'evidence';private.mkdir();evidence.mkdir();(private/'config').mkdir();(private/'config/lock.json').write_text('{}');(evidence/'resources.json').write_text('{"containers":[],"volumes":[],"networks":[]}')
    commands=[];launches=[];events=[];original_read=pathlib.Path.read_text
    def fake_run(*args):
     commands.append(args)
     if args[:3]==('docker','image','inspect'):return 'sha256:synthetic'
     if args[:2]==('docker','inspect'):return json.dumps([{'State':{'Running':False,'ExitCode':0 if passed else 1},'Config':{'Labels':{'day-trader.acceptance':v.p.PREFIX}}}])
     return ''
    def fresh(profile):profile.mkdir();return []
    def read(path,*args,**kwargs):
     if str(path)=='/proc/meminfo':return 'SwapTotal: 0 kB\nSwapFree: 0 kB\nSwapCached: 0 kB\n'
     if str(path)=='/proc/swaps':return 'Filename Type Size Used Priority\n'
     return original_read(path,*args,**kwargs)
    with patch.dict(os.environ,{**crashpad_experiment_test.HOSTED,'GITHUB_RUN_ATTEMPT':'1'},clear=True),patch.multiple(v.p,R=r,P=private,E=evidence),patch.object(v.driver,'run',side_effect=fake_run),patch.object(v.p,'drun',side_effect=lambda *args:launches.append(args) or 'synthetic-cid'),patch.object(v.driver,'startup_summary',return_value=[]),patch.object(v.e,'fresh_profile',side_effect=fresh),patch.object(v.os,'chown'),patch.object(v.e,'invariant_configuration',return_value={'host':{'SecurityOpt':['no-new-privileges','seccomp=synthetic']}}),patch.object(v,'assess',return_value={'passCheck':passed}),patch.object(v.e,'report',side_effect=lambda name,**kw:events.append((name,kw))),patch.object(pathlib.Path,'read_text',autospec=True,side_effect=read):
     self.assertEqual(v.main(),0 if passed else 1)
     with self.assertRaises(FileExistsError):v.main()
    self.assertEqual(len(launches),1);self.assertEqual(launches[0][0],'browser-b');self.assertFalse((private/'trials/B').exists());self.assertFalse((evidence/'trials/B').exists());self.assertTrue(any(c[:4]==('docker','rm','-f','-v') for c in commands));self.assertEqual(events[-1][1]['passCheck'],passed)
if __name__=='__main__':unittest.main()

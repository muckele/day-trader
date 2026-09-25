"""Pure regression tests: no Docker or hosted workloads are executed."""
import importlib.util,json,os,pathlib,sys,tempfile,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
SPEC=importlib.util.spec_from_file_location('hosted_qualification',ROOT/'tools/hosted_qualification.py')
class Qualification(unittest.TestCase):
 def module(self):
  module=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(module);return module
 def environment(self):
  return {'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_REF':'refs/heads/codex/hosted-acceptance-tooling','GITHUB_RUN_ATTEMPT':'1','PILOT_REPOSITORY_VISIBILITY':'public','PILOT_APPLICATION_SOURCE':'852fb22d9facf4bfe0bca7f419e22ee4bfbba17f','PILOT_PROFILE':'production-rehearsal','PILOT_QUALIFICATION':'full-v1','PILOT_DIAGNOSTIC_ONLY':'0'}
 def test_full_qualification_requires_every_guard(self):
  q=self.module();good=self.environment();q.require(good)
  for key in good:
   with self.subTest(key=key),self.assertRaises(RuntimeError):q.require({**good,key:'wrong'})
  for bad in [{'PILOT_PROFILE':'production'},{'GITHUB_RUN_ATTEMPT':'2'},{'PILOT_CRASHPAD_EXPERIMENT':'aba-v1'}]:
   with self.assertRaises(RuntimeError):q.require({**good,**bad})
 def test_claim_is_one_use(self):
  q=self.module()
  with tempfile.TemporaryDirectory() as temp:
   q.claim(pathlib.Path(temp),self.environment())
   with self.assertRaises(FileExistsError):q.claim(pathlib.Path(temp),self.environment())
 def test_full_driver_selected_and_diagnostic_flags_removed(self):
  text=(ROOT/'hosted.sh').read_text()
  self.assertIn('python3 tooling/hosted-acceptance/run.py',text)
  self.assertNotIn('python3 tooling/hosted-acceptance/sandbox_verification.py',text)
  self.assertIn('export PILOT_QUALIFICATION=full-v1',text)
  self.assertNotIn('export PILOT_CRASHPAD_EXPERIMENT=aba-v1',text)
 def test_leak_scan_rejects_encoded_values_and_never_reads_private_profile(self):
  q=self.module()
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp);share=root/'evidence';share.mkdir();private=root/'profile';private.mkdir();(private/'crash').write_text('never inspect')
   secrets=['SyntheticOnly-example-password','capability-long-example','private-key-example']
   for value in q.variants(secrets):
    (share/'public.txt').write_text(value)
    with self.assertRaises(RuntimeError):q.scan([share],secrets)
   (share/'public.txt').write_text('safe counts only')
   self.assertEqual(q.scan([share],secrets)['forbiddenMatches'],0)
 def test_secrets_collected_from_explicit_files_only(self):
  q=self.module()
  with tempfile.TemporaryDirectory() as temp:
   p=pathlib.Path(temp);(p/'config').mkdir();(p/'tls').mkdir()
   (p/'synthetic.json').write_text(json.dumps({'password':'synthetic-password'}));(p/'config/run.json').write_text(json.dumps({'capability':'synthetic-capability'}));(p/'backend.env').write_text('JWT_SECRET=synthetic-jwt\nOTHER=value\n');(p/'tls/key.pem').write_text('-----BEGIN PRIVATE KEY-----\nsynthetic-private-key\n-----END PRIVATE KEY-----\n')
   self.assertTrue({'synthetic-password','synthetic-capability','synthetic-jwt','synthetic-private-key'}.issubset(set(q.private_values(p))))

 def test_qualification_crash_override_is_explicit_and_guarded(self):
  # Reuse the existing pure tests' cryptography stubs; never execute Docker.
  sys.path.insert(0,str(ROOT/'tests'));import crashpad_experiment_test
  p=crashpad_experiment_test.e.p
  with patch.dict(os.environ,self.environment(),clear=True):
   options=p.browser_options(pathlib.Path('/fresh/profile'),pathlib.Path('/fresh/evidence'),p.WRITABLE_CRASH,qualification=True)
   self.assertIn(p.CRASH_TARGET+':'+p.WRITABLE_CRASH,options)
   for value in ['none','501:20','ALL','no-new-privileges','core=0:0','PILOT_QUALIFICATION=full-v1']:self.assertIn(value,options)
   self.assertIn(p.CRASH_TARGET+':'+p.BASELINE_CRASH,p.browser_options(pathlib.Path('/p'),pathlib.Path('/e')))
  with patch.dict(os.environ,{},clear=True),self.assertRaises(RuntimeError):p.browser_options(pathlib.Path('/p'),pathlib.Path('/e'),p.WRITABLE_CRASH,qualification=True)

 def test_full_driver_rejects_unapproved_host_before_provision(self):
  sys.path.insert(0,str(ROOT/'tests'));import crashpad_experiment_test
  driver=crashpad_experiment_test.e.driver
  with patch.dict(os.environ,{},clear=True),patch.object(driver,'run') as run,patch.object(driver,'ready',side_effect=RuntimeError('UNGUARDED_READY')):
   with self.assertRaisesRegex(RuntimeError,'HOSTED_SYNTHETIC_QUALIFICATION_ONLY'):driver.main()
   run.assert_not_called()
 def test_cleanup_confirms_all_resource_types_absent(self):
  import runpy,subprocess
  with tempfile.TemporaryDirectory() as temp:
   r=pathlib.Path(temp);(r/'private').mkdir();(r/'evidence').mkdir();(r/'evidence/resources.json').write_text(json.dumps({'containers':['cid'],'volumes':[],'networks':[]}));calls=[]
   def fake(args,**kwargs):
    calls.append(args)
    return subprocess.CompletedProcess(args,0,stdout=json.dumps([{'Config':{'Labels':{'day-trader.acceptance':'dapt-hosted'}}}]) if args[1]=='inspect' else '',stderr='')
   with patch.dict(os.environ,{'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','PILOT_STATE':temp},clear=True),patch('subprocess.run',side_effect=fake),patch('builtins.print'):
    runpy.run_path(str(ROOT/'cleanup.py'))
   self.assertTrue(any(c[1:3]==['ps','-aq'] for c in calls))
   self.assertTrue(any(c[1:4]==['volume','ls','-q'] for c in calls))
   self.assertTrue(any(c[1:4]==['network','ls','-q'] for c in calls))
   self.assertFalse((r/'private').exists());self.assertFalse((r/'evidence').exists())

 def test_late_unexpected_route_blocks_final_success(self):
  q=self.module();q.require_route({'unexpected':0,'pass':True})
  for row in [{'unexpected':1,'pass':False},{'unexpected':1,'pass':True},{'pass':True}]:
   with self.assertRaises(RuntimeError):q.require_route(row)
if __name__=='__main__':unittest.main()

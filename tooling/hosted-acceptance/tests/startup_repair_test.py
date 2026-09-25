"""Regression for Run C's proved expression boundary; no local Docker/DB use."""
import ast,json,pathlib,sys,unittest
from types import SimpleNamespace
from unittest.mock import Mock,patch
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
import startup_token as token
import startup_probe_diagnostic as diagnostic
VALUE={'$date':{'$numberLong':'1790370441152'}}
TOKEN='DAPT_DATE:'+json.dumps(VALUE,separators=(',',':'))
FRESH='DAPT_DATE:{"$date":{"$numberLong":"1790370442152"}}'
class StartupRepair(unittest.TestCase):
 def driver(self):
  rows=[]
  def old_run(*args,**kw):
   self.assertEqual(tuple(args),diagnostic.PROBE)
   raise RuntimeError('PROVEN_ORIGINAL_Date.prototype.toISOString_INCOMPATIBLE_RECEIVER_undefined')
  namespace={'publication_secrets':[],'run':old_run,'qualification':SimpleNamespace(private_values=lambda _:[]),'P':pathlib.Path('/unused-private-fixture'),'report':lambda name,**fields:rows.append({'check':name,**fields}),'time':Mock()}
  nodes=[x for x in ast.parse((ROOT/'run.py').read_text()).body if isinstance(x,ast.FunctionDef) and x.name in ['startup_probe','wait_startup']]
  exec(compile(ast.Module(body=nodes,type_ignores=[]),'startup-functions','exec'),namespace)
  return namespace,rows
 def result(self,code=0,out=TOKEN,timeout=False):
  return ({'exitCode':code,'timeout':timeout,'classification':'EVALUATION_ERROR' if code else 'SUCCESS_OTHER','stdoutBytes':len(out),'stderrBytes':87 if code else 0},out)
 def test_proven_date_retrieved_with_canonical_probe_instead_of_old_failure(self):
  ns,rows=self.driver()
  with self.assertRaisesRegex(RuntimeError,'PROVEN_ORIGINAL_Date.prototype.toISOString'):ns['run'](*diagnostic.PROBE)
  with patch.object(diagnostic,'execute',return_value=self.result()) as execute:
   self.assertEqual(ns['startup_probe'](),TOKEN)
  self.assertEqual(execute.call_args.args[0],(*diagnostic.PROBE[:-1],token.ALTERNATIVE));self.assertNotIn('toISOString',execute.call_args.args[0][-1])
 def test_missing_is_pending_but_malformed_and_wrong_types_fail_closed(self):
  ns,rows=self.driver()
  with patch.object(diagnostic,'execute',return_value=self.result(out='DAPT_PENDING')):self.assertIsNone(ns['startup_probe']())
  for out in ['DAPT_INVALID_TYPE','DAPT_DATE:null','DAPT_DATE:"2026-09-25T21:07:21.152Z"','DAPT_DATE:1790370441152','DAPT_DATE:{"$date":{"$numberLong":"1790370441152"},"extra":0}','arbitrary-success','DAPT_DATE:{']:
   with self.subTest(out=out),patch.object(diagnostic,'execute',return_value=self.result(out=out)),self.assertRaisesRegex(RuntimeError,'STARTUP_PROBE_TOKEN_INVALID'):ns['startup_probe']()
 def test_nonzero_and_timeout_are_fatal_after_one_attempt(self):
  ns,rows=self.driver()
  for code,timeout in [(1,False),(None,True)]:
   with patch.object(diagnostic,'execute',return_value=self.result(code=code,timeout=timeout)) as execute,self.assertRaisesRegex(RuntimeError,'STARTUP_PROBE_COMMAND_FAILED'):ns['wait_startup']()
   self.assertEqual(execute.call_count,1);self.assertEqual(rows[-1]['check'],'startup-probe-failure')
 def test_successful_pending_can_poll_then_ready_token_is_reported(self):
  ns,rows=self.driver();ns['startup_probe']=Mock(side_effect=[None,TOKEN])
  self.assertEqual(ns['wait_startup'](),TOKEN);self.assertEqual(ns['startup_probe'].call_count,2);self.assertEqual(rows[-1]['token'],TOKEN)
 def test_restart_requires_changed_valid_token(self):
  ns,rows=self.driver();ns['startup_probe']=Mock(side_effect=[TOKEN,None,TOKEN,FRESH])
  self.assertEqual(ns['wait_startup'](TOKEN),FRESH);self.assertEqual(ns['startup_probe'].call_count,4);self.assertEqual(rows[-1]['previousToken'],TOKEN);self.assertTrue(rows[-1]['changed'])
 def test_unchanged_restart_and_pending_keep_original_sixty_poll_bound(self):
  for value,previous in [(None,None),(TOKEN,TOKEN)]:
   ns,rows=self.driver();ns['startup_probe']=Mock(return_value=value)
   with self.assertRaisesRegex(RuntimeError,'STARTUP_PROBE_NOT_READY'):ns['wait_startup'](previous)
   self.assertEqual(ns['startup_probe'].call_count,60)
 def test_hosted_full_path_has_no_diagnostic_stop(self):
  hosted=(ROOT/'hosted.sh').read_text();driver=(ROOT/'run.py').read_text()
  self.assertNotIn('PILOT_STARTUP_PROBE_DIAGNOSTIC=once-v1',hosted);self.assertNotIn('diagnose_once(',driver);self.assertIn(" wait_startup()\n report('browser-start'",driver);self.assertIn('wait_startup(previous_probe)',driver)
if __name__=='__main__':unittest.main()

import unittest,pathlib,sys,tempfile,json,subprocess
from unittest.mock import Mock
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'tools'))
import finalization_diagnostics as f
SECRET='synthetic-password capability cookie JWT /private/path response-body'
class Diagnostics(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.intake=self.root/'intake.json';self.intake.write_text(json.dumps({'run':SECRET,'capability':SECRET,'container':'dapt-hosted-browser'}));self.rows=[]
 def tearDown(self):self.tmp.cleanup()
 def diagnostic(self,result=None,exc=None):
  self.runner=Mock(side_effect=exc,return_value=result);return f.Diagnostics(self.root,runner=self.runner,write=self.rows.append,sleep=lambda _:None)
 def result(self,stdout='{"ok":true}',code=0,stderr=SECRET):return subprocess.CompletedProcess([],code,stdout,stderr)
 def test_publication_values_remain_private_and_same_exec_protocol(self):
  d=self.diagnostic(self.result(json.dumps({'ok':True,'values':[SECRET]})));self.assertEqual(d.control('publication-secrets',self.intake)['values'],[SECRET]);a,k=self.runner.call_args;self.assertEqual(a[0],['docker','exec','--user','501:20','-i','dapt-hosted-browser','node','/tools/control.cjs']);self.assertEqual(k['timeout'],150);self.assertEqual(json.loads(k['input'])['capability'],SECRET);self.assertNotIn(SECRET,json.dumps(self.rows));self.assertEqual(self.rows[-1]['responseOk'],True)
 def test_leakage_and_shutdown_failures_are_distinguished(self):
  for cmd in ['leakage','shutdown']:
   for stdout,code,category in [('',1,'CONTROL_RESPONSE_EMPTY'),('not json '+SECRET,0,'CONTROL_JSON_INVALID'),('{"ok":false}',1,'CONTROL_RESPONSE_REJECTED')]:
    with self.subTest(cmd=cmd,category=category):
     self.rows.clear();d=self.diagnostic(self.result(stdout,code))
     with self.assertRaises(Exception):d.control(cmd,self.intake)
     self.assertEqual(self.rows[-1]['failure'],category);self.assertNotIn(SECRET,json.dumps(self.rows))
 def test_launch_failure_timeout_and_nonzero_exec_are_retained(self):
  for exc,category in [(OSError(SECRET),'CONTROL_EXEC_FAILED'),(subprocess.TimeoutExpired('private',150,output=SECRET,stderr=SECRET),'CONTROL_EXEC_TIMEOUT')]:
   self.rows.clear();d=self.diagnostic(exc=exc)
   with self.assertRaises(type(exc)):d.control('leakage',self.intake)
   self.assertEqual(self.rows[-1]['failure'],category)
   self.assertNotIn(SECRET,json.dumps(self.rows))
  # Existing control semantics ignore returncode when response ok=true: diagnostics must not tighten it in K.
  self.rows.clear();d=self.diagnostic(self.result('{"ok":true}',7));self.assertTrue(d.control('shutdown',self.intake)['ok']);self.assertEqual(self.rows[1]['returnCode'],7);self.assertEqual(self.rows[1]['failure'],'CONTROL_EXEC_FAILED')
 def test_success_and_original_empty_response_rejection(self):
  for cmd in ['leakage','shutdown']:
   self.rows.clear();d=self.diagnostic(self.result());self.assertTrue(d.control(cmd,self.intake)['ok']);self.assertTrue(self.rows[-1]['success'])
 def test_poll_immediate_delayed_and_nonzero(self):
  for count,exitcode in [(1,0),(4,0),(2,1)]:
   states=[self.result(json.dumps([{'State':{'Running':i<count-1,'ExitCode':exitcode},'Env':SECRET}])) for i in range(count)]
   d=self.diagnostic();self.runner.side_effect=states
   if exitcode:
    with self.assertRaisesRegex(RuntimeError,'BROWSER_SHUTDOWN_FAILED'):d.poll()
   else:self.assertEqual(d.poll()['ExitCode'],0)
   stopped=next(x for x in self.rows if x['stage']=='PF09_CONTAINER_POLL_STOPPED');self.assertEqual(stopped['pollCount'],count);self.assertNotIn(SECRET,json.dumps(self.rows));self.rows.clear()
 def test_poll_timeout_uses_existing_bound_and_inspect_failures(self):
  d=self.diagnostic(self.result('[{"State":{"Running":true,"ExitCode":0}}]'));sleeps=[];d.sleep=sleeps.append
  with self.assertRaisesRegex(RuntimeError,'BROWSER_SHUTDOWN_TIMEOUT'):d.poll()
  self.assertEqual(self.runner.call_count,50);self.assertEqual(sleeps,[.2]*50);self.assertEqual(self.rows[-1]['pollCount'],50)
  for response in [self.result('',1),self.result(SECRET)]:
   self.rows.clear();d=self.diagnostic(response)
   with self.assertRaises(Exception):d.poll()
   self.assertEqual(self.rows[-1]['failure'],'CONTAINER_INSPECT_FAILED')
 def test_receipt_failure_is_separate_and_propagates(self):
  d=self.diagnostic();error=RuntimeError(SECRET)
  with self.assertRaises(RuntimeError) as caught:d.receipt(lambda *a,**k:(_ for _ in ()).throw(error),0)
  self.assertIs(caught.exception,error);self.assertEqual(self.rows[-1]['stage'],'PF11_NORMAL_SHUTDOWN_RECEIPT');self.assertEqual(self.rows[-1]['failure'],'NORMAL_SHUTDOWN_RECEIPT_FAILED')
 def test_receipt_success_then_complete(self):
  d=self.diagnostic();calls=[];d.receipt(lambda *a,**k:calls.append((a,k)),0);d.complete();self.assertEqual(calls[0][0],('browser-normal-shutdown',));self.assertEqual(self.rows[-1]['stage'],'PF12_PRIVATE_FINALIZATION_COMPLETE');self.assertTrue(self.rows[-1]['success'])
 def test_write_failure_does_not_change_control_or_exception(self):
  d=self.diagnostic(self.result());d.write=lambda _:(_ for _ in ()).throw(OSError(SECRET));self.assertTrue(d.control('shutdown',self.intake)['ok'])
 def test_collector_rejects_unreviewed_private_fields_and_bounds(self):
  d=f.Diagnostics(self.root);d.mark('PF01_PUBLICATION_SECRETS_START',started=True);self.assertEqual(len(f.collect(self.root)['python']),1)
  with (self.root/'private-finalization.jsonl').open('a') as out:out.write(json.dumps({'stage':'PF02_PUBLICATION_SECRETS_RESULT','response':SECRET})+'\n')
  with self.assertRaisesRegex(ValueError,'FINALIZATION_EVIDENCE_INVALID'):f.collect(self.root)
 def test_readonly_failure_snapshot_does_not_retry_shutdown(self):
  d=self.diagnostic(self.result('{"Running":false,"ExitCode":0}'));d.snapshot();self.assertEqual(self.runner.call_count,1);self.assertEqual(self.rows[-1]['exitCode'],0);self.assertFalse(self.rows[-1]['running']);self.assertIn('--format',self.runner.call_args.args[0])
 def test_main_flow_and_original_shutdown_bounds_are_unchanged(self):
  source=(pathlib.Path(__file__).resolve().parents[1]/'run.py').read_text()
  main=source[source.index('def main():'):source.index('def startup_summary(')]
  self.assertNotIn('finalization.control',main)
  self.assertIn("publication_secrets.extend(control('publication-secrets')['values'])",main)
  shell=(pathlib.Path(__file__).resolve().parents[1]/'hosted.sh').read_text()
  self.assertNotIn('echo HOSTED_TOOLING_PILOT_VERIFIED',shell)
if __name__=='__main__':unittest.main()

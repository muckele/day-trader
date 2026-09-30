import ast,json,pathlib,sys,tempfile,unittest,subprocess
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
class StandinExitEvidence(unittest.TestCase):
 def test_state_uses_only_bounded_inspect_and_retains_oom(self):
  import standin_exit_evidence as m
  for output,kind in [('true 0 0 123 false','RUNNING'),('false 1 0 0 false','STOPPED'),('false 137 0 0 true','OOM_KILLED')]:
   with patch.object(m.subprocess,'run',return_value=type('R',(),{'returncode':0,'stdout':output})()) as run:
    r=m.state();self.assertEqual(r['exitKind'],kind);args=run.call_args[0][0];self.assertEqual(args[:3],['docker','inspect','--format']);self.assertEqual(args[-1],'dapt-hosted-standin');self.assertNotIn('State.Error',args[3]);self.assertNotIn('Env',args[3]);self.assertIn('OOMKilled',args[3])
   self.assertEqual(r['OOMKilled'],kind=='OOM_KILLED');self.assertEqual(r['pidPresent'],kind=='RUNNING')
 def test_invalid_state_and_timeout_are_unknown_without_raw_output(self):
  import standin_exit_evidence as m
  with patch.object(m.subprocess,'run',return_value=type('R',(),{'returncode':1,'stdout':'credential private.invalid'})()):r=m.state()
  self.assertEqual(r['exitKind'],'UNKNOWN');self.assertNotIn('private',json.dumps(r))
  with patch.object(m.subprocess,'run',side_effect=subprocess.TimeoutExpired('private',8)):self.assertEqual(m.state()['exitKind'],'UNKNOWN')
 def test_timeline_running_to_stopped_and_first_transition(self):
  import standin_exit_evidence as m
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)
   with patch.object(m,'state',side_effect=[{'running':True,'pidPresent':True,'restartCount':0,'exitCodeIfStopped':None,'OOMKilled':False,'exitKind':'RUNNING'},{'running':False,'pidPresent':False,'restartCount':0,'exitCodeIfStopped':1,'OOMKilled':False,'exitKind':'STOPPED'}]):
    m.marker(p,m.NP[0]);m.marker(p,m.NP[1])
   r=m.collect(p);self.assertEqual(r['firstStoppedStage'],m.NP[1]);self.assertEqual(len(r['timeline']),2)
 def test_receipt_sanitization_and_bounds(self):
  import standin_exit_evidence as m
  base={'stage':'STP04_FATAL_EXCEPTION_MONITOR','order':1,'httpsListened':True,'canaryListened':True,'errorClass':'Error','safeErrorCode':'EPIPE','origin':'uncaughtException','source':'canary-socket','connectionId':1}
  self.assertEqual(m.safe_row(base),base)
  for field,value in [('stack','/private/secret'),('message','credential'),('safeErrorCode','private.invalid'),('origin','192.0.2.77'),('order',257)]:
   with self.assertRaisesRegex(ValueError,'STANDIN_EXIT_EVIDENCE_INVALID'):m.safe_row({**base,field:value})
 def test_run_i_health_only_and_unconditional_stop(self):
  import transport_evidence as t,security_probe_evidence as s,os
  fn=next(n for n in ast.parse((ROOT/'run.py').read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='run_security_probe')
  for fails in [False,True]:
   calls=[];rows=[]
   def control(c):
    calls.append(c)
    if fails:raise RuntimeError('SYNTHETIC_FAILURE')
   ns={'E':pathlib.Path('/fixture'),'P':pathlib.Path('/fixture'),'control':control,'report':lambda name,**kw:rows.append(name),'os':os,'qualification':type('Q',(),{'private_values':staticmethod(lambda p:[])})(),'publication_secrets':[]}
   exec(compile(ast.Module(body=[fn],type_ignores=[]),'driver','exec'),ns)
   with patch.dict(os.environ,{'PILOT_SECURITY_PROBE_DIAGNOSTIC':'standin-exit-once-v1'}),patch.object(s,'begin',return_value={}),patch.object(s,'collect',return_value={}),patch.object(t,'begin',return_value={}),patch.object(t,'collect',return_value={}),patch.object(t,'container_states',return_value={}),self.assertRaisesRegex(RuntimeError,'STANDIN_EXIT_DIAGNOSTIC_STOP'):ns['run_security_probe']()
   self.assertEqual(calls,['security-probe-health-diagnostic']);self.assertEqual(rows[-1],'standin-exit-diagnostic-stop')
 def test_bad_lifecycle_publication_does_not_skip_existing_finalization(self):
  import standin_exit_evidence as m
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);seen=[]
   main=next(n for n in ast.parse((ROOT/'run.py').read_text()).body if isinstance(n,ast.If) and isinstance(n.test,ast.Compare))
   final=next(n for n in main.body if isinstance(n,ast.Try)).finalbody
   q=type('Q',(),{'scan':staticmethod(lambda *a:seen.append('scan') or {}),'private_values':staticmethod(lambda p:[])})()
   ns={'E':p,'P':p,'R':p,'ROOT':ROOT,'publication_secrets':[],'credential_attempted':False,'code':0,'qualification':q,'report':lambda name,**kw:seen.append(name),'startup_summary':lambda:seen.append('startup-summary'),'json':json}
   with patch.object(m,'collect',side_effect=ValueError('private.invalid')):exec(compile(ast.Module(body=final,type_ignores=[]),'finalization','exec'),ns)
   self.assertIn('standin-exit-diagnostics',seen);self.assertIn('scan',seen);self.assertIn('startup-summary',seen);self.assertEqual(ns['code'],1)
 def test_marker_write_failure_is_reported_without_stopping_existing_prechecks(self):
  import standin_exit_evidence as m
  with tempfile.TemporaryDirectory() as d,patch.object(m,'state',return_value={'running':True,'pidPresent':True,'restartCount':0,'exitCodeIfStopped':None,'OOMKilled':False,'exitKind':'RUNNING'}):
   r=m.marker(pathlib.Path(d)/'absent',m.NP[0]);self.assertTrue(r['evidenceWriteFailed']);self.assertTrue(r['running'])
if __name__=='__main__':unittest.main()

"""Diagnostic-only subprocess fakes. Never execute Docker or mongosh locally."""
import ast,importlib.util,json,pathlib,subprocess,sys,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
class ProbeDiagnostic(unittest.TestCase):
 def module(self):
  spec=importlib.util.spec_from_file_location('startup_probe_diagnostic',ROOT/'tools/startup_probe_diagnostic.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
 def fake(self,code=1,out=b'',err=b'',timeout=False):
  def run(args,**kw):
   kw['stdout'].write(out);kw['stderr'].write(err)
   if timeout:raise subprocess.TimeoutExpired(args,kw['timeout'])
   return subprocess.CompletedProcess(args,code)
  return run
 def test_original_probe_argv_and_timeout_unchanged(self):
  m=self.module();args=['docker','exec','dapt-hosted-mongo','mongosh','--quiet','--eval',"const x=db.getSiblingDB('acceptance').operationalreadiness.findOne({_id:'execution-write-probe'});print(x?.checkedAt?.toISOString()||'pending')"]
  self.assertEqual(list(m.PROBE),args)
  with patch.object(m.subprocess,'run',side_effect=self.fake()) as run:
   result=m.probe_subprocess(m.PROBE,secrets=[])
  self.assertEqual(result['exitCode'],1);self.assertTrue(result['dockerClientLaunched']);self.assertEqual(run.call_args.kwargs['timeout'],180)
 def test_categories_and_output_results(self):
  m=self.module()
  for code,out,err,expected in [(1,b'',b'MongoNetworkError: connect ECONNREFUSED 127.0.0.1:27017','CONNECTION_REFUSED'),(1,b'',b'MongoServerError: not primary','NOT_PRIMARY'),(1,b'',b'MongoServerSelectionError: Server selection timed out','SERVER_SELECTION'),(1,b'',b'TypeError: x?.checkedAt?.toISOString is not a function','EVALUATION_ERROR'),(0,b'pending\n',b'','PENDING'),(0,b'2026-09-25T01:02:03.000Z\n',b'','TIMESTAMP')]:
   with self.subTest(expected=expected),patch.object(m.subprocess,'run',side_effect=self.fake(code,out,err)):
    r=m.probe_subprocess(m.PROBE,secrets=[]);self.assertEqual(r['classification'],expected);self.assertEqual(r['stdoutBytes'],len(out));self.assertEqual(r['stderrBytes'],len(err));self.assertTrue(r['execProcessLaunched'])
 def test_timeout_and_missing_docker_are_explicit(self):
  m=self.module()
  with patch.object(m.subprocess,'run',side_effect=self.fake(timeout=True)):
   r=m.probe_subprocess(m.PROBE,secrets=[]);self.assertTrue(r['timeout']);self.assertIsNone(r['exitCode']);self.assertEqual(r['classification'],'TIMEOUT')
  with patch.object(m.subprocess,'run',side_effect=FileNotFoundError('/private/host/docker')):
   r=m.probe_subprocess(m.PROBE,secrets=[]);self.assertFalse(r['dockerClientLaunched']);self.assertEqual(r['classification'],'CLIENT_LAUNCH_ERROR');self.assertNotIn('/private/host',json.dumps(r))
 def test_secret_paths_uri_documents_and_terminal_error(self):
  m=self.module();secret='arbitrary-generated-value';raw=('banner\n'*20000+'{ "arbitraryDocument": "never-publish-this" }\n'+ 'password=unknown-password\n'+f'TypeError: {secret} /tmp/unexpected-host-material /Users/private/secret.js mongodb://user:password@unexpected.private/acceptance\n'+'TypeError: x?.checkedAt?.toISOString is not a function\n').encode()
  with patch.object(m.subprocess,'run',side_effect=self.fake(err=raw)):
   r=m.probe_subprocess(m.PROBE,secrets=[secret])
  text=json.dumps(r);self.assertLess(len(text),10000);self.assertTrue(r['stderrTruncated']);self.assertEqual(r['stderrBytes'],len(raw));self.assertIn('toISOString is not a function',text)
  for value in [secret,'unexpected-host-material','/Users/private','mongodb://','unexpected.private','never-publish-this','unknown-password']:self.assertNotIn(value,text)
 def test_unquoted_multiline_document_fields_are_not_error_excerpts(self):
  m=self.module();raw=b"{\n  error: 'unknown-document-secret',\n  message: 'never-publish',\n}\nTypeError: x?.checkedAt?.toISOString is not a function\n"
  with patch.object(m.subprocess,'run',side_effect=self.fake(err=raw)):r=m.probe_subprocess(m.PROBE,secrets=[])
  self.assertNotIn('unknown-document-secret',json.dumps(r));self.assertNotIn('never-publish',json.dumps(r));self.assertIn('toISOString is not a function',r['stderrExcerpt'])
 def test_final_error_is_retained_after_an_oversize_line(self):
  m=self.module()
  with patch.object(m.subprocess,'run',side_effect=self.fake(err=b'X'*200000+b'\nMongoServerError: not primary\n')):
   r=m.probe_subprocess(m.PROBE,secrets=[])
  self.assertIn('not primary',r['stderrExcerpt']);self.assertEqual(r['classification'],'NOT_PRIMARY');self.assertLess(len(r['stderrExcerpt']),4097)
 def test_supplementary_diagnostics_are_read_only_and_field_limited(self):
  m=self.module();calls=[]
  def run(args,**kw):
   calls.append(args)
   if 'inspect' in args:out='true 0 0 1234 "none"'
   elif '--version' in args:out='2.3.9'
   elif 'node' in args:out='200'
   elif 'db.hello' in args[-1]:out=json.dumps({'ok':1,'isWritablePrimary':True,'secondary':False,'setName':'acceptance','hosts':['secret.host']})
   elif 'DAPT_DATE:' in args[-1]:out='DAPT_DATE:{"$date":{"$numberLong":"1790000000000"}}'
   else:out=json.dumps({'state':'VALUE','serverBsonDate':True,'value':{'$date':{'$numberLong':'1790000000000'}}})
   kw['stdout'].write(out.encode());return subprocess.CompletedProcess(args,0)
  with patch.object(m.subprocess,'run',side_effect=run):r=m.readonly_diagnostics([])
  text=json.dumps(r);self.assertNotIn('secret.host',text);self.assertNotIn('never-publish',text);self.assertTrue(r['mongo']['running']);self.assertTrue(r['mongo']['pidPresent']);self.assertTrue(r['mongosh']['available']);self.assertTrue(r['hello']['fields']['isWritablePrimary']);self.assertTrue(r['lookup']['fields']['checkedAtIsCanonicalBsonDate']);self.assertTrue(r['backendHealth']['ready'])
  self.assertTrue(all(a[:2] in [('docker','exec'),('docker','inspect')] for a in calls));self.assertFalse(any(any(word in ' '.join(a) for word in ['insertOne','updateOne','deleteOne','rs.initiate','--env']) for a in calls))
 def test_diagnostic_success_does_not_continue_or_claim_root_cause(self):
  m=self.module();rows=[]
  with patch.object(m.subprocess,'run',side_effect=self.fake(0,b'2026-09-25T01:02:03.000Z\n')) as run,patch.object(m,'readonly_diagnostics',return_value={'safe':True}) as diag:
   with self.assertRaisesRegex(RuntimeError,'STARTUP_PROBE_DIAGNOSTIC_STOP'):m.diagnose_once([],lambda name,**fields:rows.append({'check':name,**fields}))
  self.assertEqual(run.call_count,1);self.assertEqual(rows[-1]['outcome'],'NOT_REPRODUCED');self.assertEqual(rows[0]['attempt'],1);diag.assert_called_once()
 def test_diagnostic_failure_stops_after_one_original_probe(self):
  m=self.module();rows=[]
  with patch.object(m.subprocess,'run',side_effect=self.fake(1,err=b'TypeError: evaluation failed')) as run,patch.object(m,'readonly_diagnostics',return_value={'safe':True}) as diag:
   with self.assertRaisesRegex(RuntimeError,'STARTUP_PROBE_DIAGNOSTIC_STOP'):m.diagnose_once([],lambda name,**fields:rows.append({'check':name,**fields}))
  self.assertEqual(run.call_count,1);diag.assert_called_once();self.assertEqual(rows[-1]['outcome'],'FAILED_CAPTURED')
 def test_diagnostic_fork_is_not_enabled_in_full_qualification(self):
  self.assertNotIn('diagnose_once(',(ROOT/'run.py').read_text());self.assertIn('unset PILOT_STARTUP_PROBE_DIAGNOSTIC',(ROOT/'hosted.sh').read_text())
if __name__=='__main__':unittest.main()

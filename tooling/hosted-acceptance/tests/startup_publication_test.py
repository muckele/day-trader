"""Synthetic recorder safety/usefulness tests; not browser-defect reproductions."""
import base64,json,pathlib,sys,tempfile,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'tools'))
from startup_publication import clean,variants,prepare,Withheld
class Publication(unittest.TestCase):
 def test_native_and_incidental_order(self):
  original='[123:ERROR:base/files/file.cc:12] open /profile/cache Permission denied\n[123:FATAL:content/browser/startup.cc:345] Check failed: InitializeSandbox(). signal=SIGTRAP'
  safe=clean(original,[])
  self.assertIn(original,safe);self.assertNotIn('errno',safe);self.assertLess(safe.index('Permission denied'),safe.index('Check failed'))
 def test_canaries_and_controls_mixed_with_useful_text(self):
  secret='synthetic-Pass+Word/17='
  original='\x1b[31m[FATAL:base/test.cc:8] Check failed: useful().\x1b[0m\n'+secret+'\n'+base64.b64encode(secret.encode()).decode()+'\nAuthorization: Bearer other-canary\npassword=third-canary\n::error::injection\n/home/runner/private/key'
  safe=clean(original,variants([secret]));self.assertIn('Check failed: useful()',safe)
  for absent in [secret,base64.b64encode(secret.encode()).decode(),'other-canary','third-canary','\x1b','::','/home/runner']:self.assertNotIn(absent,safe)
 def test_private_key(self):
  safe=clean('FATAL: useful\n-----BEGIN PRIVATE KEY-----\nsynthetic-key-canary\n-----END PRIVATE KEY-----',[])
  self.assertIn('FATAL: useful',safe);self.assertNotIn('synthetic-key-canary',safe)
 def test_sensitive_objects_withheld(self):
  for marker in ['environment dump','response body','browser state','private configuration']:
   with self.assertRaises(Withheld):clean(marker+'\nunknown sensitive data',[])
 def test_actual_private_to_public_route(self):
  with tempfile.TemporaryDirectory() as temp:
   e=pathlib.Path(temp);(e/'startup-private').mkdir()
   obj={'lines':[{'text':'FATAL: src/start.cc:9 Check failed: native(). password=synthetic-canary'}],'originalFields':{'errno':None,'syscall':None},'absentOriginalFields':['errno','syscall'],'truncated':True}
   (e/'startup-private/browser.txt').write_text(json.dumps(obj));rows,gate=prepare(e,['synthetic-canary']);out=json.dumps(rows)
   self.assertIn('Check failed: native()',out);self.assertIn('absentOriginalFields',out);self.assertNotIn('synthetic-canary',out);self.assertTrue(rows[0]['data']['truncated']);self.assertLess(gate['publicBytes'],gate['publicLimitBytes'])
 def test_cpp_condition_and_public_source_survive(self):
  safe=clean('[FATAL:../../content/browser/a.cc:91] Check failed: content::Start().',[])
  self.assertIn('content::Start()',safe);self.assertIn('../../content/browser/a.cc:91',safe)
 def test_multiline_key_capture_withheld(self):
  with tempfile.TemporaryDirectory() as temp:
   e=pathlib.Path(temp);(e/'startup-private').mkdir()
   obj={'lines':[{'text':x} for x in ['-----BEGIN PRIVATE KEY-----','unknown-private-key-material','-----END PRIVATE KEY-----']]}
   (e/'startup-private/browser.txt').write_text(json.dumps(obj));rows,_=prepare(e,[])
   self.assertEqual(rows[0]['reason'],'multiline_private_key_marker');self.assertNotIn('unknown-private-key-material',json.dumps(rows))
 def test_all_known_encodings_redacted(self):
  known=variants(['synthetic+pass/word=']);safe=clean(' '.join(known),known)
  for v in known:self.assertNotIn(v,safe)
 def test_whole_capture_sensitive_object_gate(self):
  with tempfile.TemporaryDirectory() as temp:
   e=pathlib.Path(temp);(e/'startup-private').mkdir()
   (e/'startup-private/browser.txt').write_text(json.dumps({'lines':[{'text':'response body:'},{'text':'private-value'}]}))
   rows,_=prepare(e,[]);self.assertEqual(rows[0]['reason'],'sensitive_object_marker');self.assertNotIn('private-value',json.dumps(rows))
 def test_colon_paths_and_quoted_config(self):
  safe=clean('open:/home/runner/private/key path:/private/config file:///home/runner/key /profile/chromium source.cc:123',[])
  self.assertNotIn('/home/runner',safe);self.assertNotIn('/private/config',safe);self.assertIn('/profile/chromium',safe);self.assertIn('source.cc:123',safe)
  for obj in ['{"capability":"unknown-secret","upstreams":{}}','{"Authorization":"Bearer unknown"}','HOME=/private/runner']:
   with self.assertRaises(Withheld):clean(obj,[])
 def test_source_derived_sandbox_failure_observations_survive_publication(self):
  # Constructed source-derived table, not prior B runtime evidence.
  with tempfile.TemporaryDirectory() as temp:
   e=pathlib.Path(temp)
   observed={'component':'Chromium-sandbox','pageUrl':'chrome://sandbox/','actualRows':[['Layer 1 Sandbox','Namespace'],['PID namespaces','No'],['Network namespaces','Yes'],['Seccomp-BPF sandbox','No']],'assessment':'You are NOT adequately sandboxed.','checks':[{'label':'PID namespaces','observed':['No'],'pass':False}],'pass':False,'errors':['TABLE_READINESS_TIMEOUT']}
   (e/'startup-diagnostics.jsonl').write_text(json.dumps(observed)+'\n')
   rows,_=prepare(e,[]);self.assertEqual(rows[0]['check'],'startup-facts');self.assertEqual(rows[0]['data'][0],observed)
if __name__=='__main__':unittest.main()

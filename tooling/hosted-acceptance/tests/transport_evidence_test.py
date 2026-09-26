import ast,json,pathlib,sys,tempfile,unittest,os
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
class TransportEvidence(unittest.TestCase):
 def test_scoped_sequences_and_listener_receipt(self):
  import transport_evidence as m
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)
   listener={'order':1,'stage':'SI00_LISTENING','port':443,'listener':'synthetic-internal'}
   (p/'standin-transport.jsonl').write_text(json.dumps(listener)+'\n');b=m.begin(p)
   gt={'order':1,'requestId':7,'destination':'backend-upstream','stage':'GT01_DESTINATION_LOOKUP','success':True}
   (p/'gateway-transport.jsonl').write_text(json.dumps(gt)+'\n')
   result=m.collect(p,b);self.assertEqual(result['gateway'],[gt]);self.assertEqual(result['standin'],[]);self.assertTrue(result['listenerStarted'])
 def test_rejects_raw_metadata_unknown_fields_codes_and_overflow(self):
  import transport_evidence as m
  for row in [{'order':1,'stage':'SI01_TCP_CONNECTION','address':'192.0.2.77'},{'order':1,'stage':'GT10_TLS_SOCKET_ERROR','safeErrorCode':'private.invalid'},{'order':513,'stage':'DIAGNOSTIC_OVERFLOW'}]:
   with self.assertRaisesRegex(ValueError,'TRANSPORT_EVIDENCE_INVALID'):m.safe_row(row)
 def test_prefix_changed_rejected(self):
  import transport_evidence as m
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);f=p/'gateway-transport.jsonl';f.write_text('{"order":1,"stage":"GT03_TCP_CONNECT"}\n');b=m.begin(p);f.write_text('')
   with self.assertRaises(ValueError):m.collect(p,b)
 def test_run_g_selects_health_only_and_stops_even_success(self):
  import transport_evidence as m,security_probe_evidence as s
  fn=next(n for n in ast.parse((ROOT/'run.py').read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='run_security_probe')
  for fail in [True,False]:
   rows=[];commands=[]
   def control(cmd):
    commands.append(cmd)
    if fail:raise RuntimeError('CONTROL_FAILURE')
   ns={'E':pathlib.Path('/fixture'),'P':pathlib.Path('/fixture'),'control':control,'report':lambda name,**kw:rows.append((name,kw)),'os':os,'qualification':type('Q',(),{'private_values':staticmethod(lambda p:[])})(),'publication_secrets':[]}
   exec(compile(ast.Module(body=[fn],type_ignores=[]),'driver','exec'),ns)
   with patch.dict(os.environ,{'PILOT_SECURITY_PROBE_DIAGNOSTIC':'transport-once-v1'}),patch.object(s,'begin',return_value={}),patch.object(s,'collect',return_value={}),patch.object(m,'begin',return_value={}),patch.object(m,'collect',return_value={}),patch.object(m,'container_states',return_value={}),self.assertRaisesRegex(RuntimeError,'GATEWAY_TRANSPORT_DIAGNOSTIC_STOP'):ns['run_security_probe']()
   self.assertEqual(commands,['security-probe-health-diagnostic']);self.assertEqual(rows[-1][0],'gateway-transport-diagnostic-stop');self.assertFalse(rows[-1][1]['credentialsSubmitted'])
if __name__=='__main__':unittest.main()

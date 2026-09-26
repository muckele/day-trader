import ast,json,pathlib,sys,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
class SecurityEvidence(unittest.TestCase):
 def test_scoped_counts_retain_denied_before_gateway_and_control_backend_status(self):
  import security_probe_evidence as m
  with tempfile.TemporaryDirectory() as directory:
   p=pathlib.Path(directory)
   row=lambda boundary,path,event,**kw:{'boundary':boundary,'pathId':path,'event':event,'method':'GET',**kw}
   (p/'security-boundary-tls.jsonl').write_text(json.dumps(row('tls','control-me','handler'))+'\n')
   baseline=m.begin(p)
   for boundary in ['tls','gateway','backend']:
    records=[row(boundary,'control-me','handler'),row(boundary,'control-me','response',httpStatus=401)]
    if boundary=='tls':records +=[row(boundary,'denied-recommendations-query','handler'),row(boundary,'denied-recommendations-query','response',httpStatus=403)]
    with (p/('security-boundary-'+boundary+'.jsonl')).open('a') as f:f.write(''.join(json.dumps(x)+'\n' for x in records))
   (p/'tls-forward.jsonl').write_text(json.dumps({'path':'/api/me','method':'GET','queryPresent':False})+'\n')
   result=m.boundaries(p,baseline)
   self.assertEqual(result['control-me']['tls']['forwards'],1);self.assertEqual(result['control-me']['application']['responses'],0)
   self.assertEqual(result['control-me']['tls']['handlers'],1);self.assertEqual(result['control-me']['backend']['statuses'],[401]);self.assertEqual(result['denied-recommendations-query']['tls']['statuses'],[403]);self.assertEqual(result['denied-recommendations-query']['gateway']['handlers'],0)
 def test_unknown_boundary_payload_is_rejected_without_echo(self):
  import security_probe_evidence as m
  with tempfile.TemporaryDirectory() as directory:
   p=pathlib.Path(directory);baseline=m.begin(p)
   (p/'security-boundary-tls.jsonl').write_text('{"cookie":"do-not-publish"}\n')
   with self.assertRaisesRegex(ValueError,'SECURITY_PROBE_EVIDENCE_INVALID'):m.boundaries(p,baseline)
 def test_stage_schema_bounded_and_rejects_private_fields(self):
  import security_probe_evidence as m
  data={'version':1,'stages':[{'stage':s,'started':False,'completed':False,'success':None} for s in m.STAGES],'firstFailure':None,'restorationFatal':False,'evidenceWriteFailed':False,'browserErrors':[],'pass':False}
  self.assertEqual(m.safe_stages(data),data)
  for field,value in [('cookie','do-not-publish'),('stack','/Users/private'),('url','https://secret.invalid')]:
   bad=json.loads(json.dumps(data));bad['stages'][0][field]=value
   with self.assertRaisesRegex(ValueError,'SECURITY_PROBE_EVIDENCE_INVALID'):m.safe_stages(bad)
 def test_run_e_stops_even_if_probe_passes_or_fails(self):
  from unittest.mock import patch
  import security_probe_evidence as m
  source=(ROOT/'run.py').read_text();fn=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='run_security_probe')
  for fails in [False,True]:
   rows=[]
   def control(*args):
    if fails:raise RuntimeError('CONTROL_SECURITY_PROBE')
   import os
   ns={'E':pathlib.Path('/fixture'),'control':control,'report':lambda name,**kw:rows.append((name,kw)),'os':os}
   exec(compile(ast.Module(body=[fn],type_ignores=[]),'security-driver','exec'),ns)
   with patch.dict(os.environ,{'PILOT_SECURITY_PROBE_DIAGNOSTIC':'once-v1'}),patch.object(m,'begin',return_value={}),patch.object(m,'collect',return_value={'safe':True}),self.assertRaisesRegex(RuntimeError,'SECURITY_PROBE_DIAGNOSTIC_STOP'):ns['run_security_probe']()
   self.assertEqual(rows[-1][0],'security-probe-diagnostic-stop');self.assertFalse(rows[-1][1]['credentialsSubmitted']);self.assertFalse(rows[-1][1]['fullQualificationExecuted'])
if __name__=='__main__':unittest.main()

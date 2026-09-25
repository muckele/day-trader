"""Pure expression diagnostics; no Docker, Mongo or production access."""
import copy,json,pathlib,sys,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
class ExpressionDiagnostic(unittest.TestCase):
 def module(self):
  import startup_token;return startup_token
 def test_exact_method_allowlist_and_no_dotted_token_escape(self):
  import startup_probe_diagnostic as d
  for method in ['toISOString','Date.prototype.toISOString','Date.prototype.toISOString()','findOne','getSiblingDB']:
   with self.subTest(method=method):self.assertEqual(d.method_identifier('TypeError: Method '+method+' called on incompatible receiver undefined')['identifier'],method)
  for method in ['secret.host.invalid','/Users/private/secret','https://user:password@secret.host','Date.prototype.toISOString.evil','arbitrary-secret']:
   r=d.method_identifier('TypeError: Method '+method+' called on incompatible receiver undefined');self.assertEqual(r['identifier'],'METHOD_IDENTIFIER_UNRECOGNIZED');self.assertNotIn(method,json.dumps(r))
 def test_method_field_does_not_weaken_normal_error_redaction(self):
  import startup_probe_diagnostic as d
  s='TypeError: Method Date.prototype.toISOString called on incompatible receiver undefined\nTypeError: secret.host.invalid /tmp/private-file https://private.host/path token=unknown-value generated-value'
  clean=d.excerpt(s,['generated-value']);self.assertNotIn('secret.host.invalid',clean);self.assertNotIn('/tmp/private-file',clean);self.assertNotIn('https://',clean);self.assertNotIn('generated-value',clean);self.assertNotIn('unknown-value',clean)
  self.assertEqual(d.method_identifier(s)['identifier'],'Date.prototype.toISOString')
 def test_canonical_date_lookup_and_alternative_same_token(self):
  m=self.module();value={'$date':{'$numberLong':'1790000000000'}};lookup=m.parse_lookup(json.dumps({'state':'VALUE','value':value,'serverBsonDate':True}));token=m.parse_token('DAPT_DATE:'+json.dumps(value));self.assertTrue(lookup['checkedAtIsCanonicalBsonDate']);self.assertEqual(lookup['token'],token);self.assertEqual(lookup['classification'],'BSON_DATE')
 def test_date_shaped_document_requires_server_scalar_date_type(self):
  m=self.module();value={'$date':{'$numberLong':'1790000000000'}}
  for attestation in [False,None]:
   envelope={'state':'VALUE','value':value}
   if attestation is not None:envelope['serverBsonDate']=attestation
   result=m.parse_lookup(json.dumps(envelope));self.assertFalse(result['checkedAtIsCanonicalBsonDate']);self.assertNotIn('token',result)
  for expression in [m.LOOKUP,m.ALTERNATIVE]:self.assertIn("$expr:{$eq:[{$type:'$checkedAt'},'date']}",expression)
 def test_missing_document_and_field_are_distinct(self):
  m=self.module()
  a=m.parse_lookup('{"state":"MISSING_DOCUMENT"}');b=m.parse_lookup('{"state":"MISSING_CHECKED_AT"}')
  self.assertFalse(a['documentFound']);self.assertTrue(b['documentFound']);self.assertFalse(a['checkedAtPresent']);self.assertFalse(b['checkedAtPresent']);self.assertFalse(a['checkedAtIsCanonicalBsonDate']);self.assertIsNone(m.parse_token('DAPT_PENDING'))
 def test_wrong_types_null_and_other_bson_are_not_dates(self):
  m=self.module()
  for value,kind in [('2026-09-25T00:00:00Z','STRING'),(None,'NULL'),(123,'OTHER_TYPE'),({'$numberLong':'123'},'OTHER_TYPE')]:
   r=m.parse_lookup(json.dumps({'state':'VALUE','value':value,'serverBsonDate':False}));self.assertEqual(r['classification'],kind);self.assertFalse(r['checkedAtIsCanonicalBsonDate']);self.assertNotIn('token',r)
   with self.assertRaises(ValueError):m.parse_token('DAPT_DATE:'+json.dumps(value))
 def test_strict_date_shape_bounds_duplicates_and_canonical_integer(self):
  m=self.module()
  for text in ['null','{"$date":"2026-09-25T00:00:00Z"}','{"$date":{"$numberLong":123}}','{"$date":{"$numberLong":"01"}}','{"$date":{"$numberLong":"-0"}}','{"$date":{"$numberLong":"8640000000000001"}}','{"$date":{"$numberLong":"1","extra":0}}','{"$date":{"$numberLong":"1"},"extra":0}','{"$date":{"$numberLong":"1","$numberLong":"2"}}','{}','not-json']:
   with self.subTest(text=text),self.assertRaises(ValueError):m.parse_token('DAPT_DATE:'+text)
  for value in ['0','-1','8640000000000000','-8640000000000000']:self.assertIsNotNone(m.parse_token('DAPT_DATE:'+json.dumps({'$date':{'$numberLong':value}})))
 def test_malformed_lookup_fails_without_publishing_values(self):
  m=self.module()
  for text in ['not-json','{"state":"VALUE"}','{"state":"MISSING_DOCUMENT","secret":"never-publish"}','{"state":"VALUE","value":{"$date":{"$numberLong":"NaN"}}}']:
   r=m.parse_lookup(text);self.assertFalse(r['checkedAtIsCanonicalBsonDate']);self.assertEqual(r['classification'],'INVALID_SERIALIZATION');self.assertNotIn('never-publish',json.dumps(r))
 def test_supplementary_sources_have_no_await_no_date_method_and_exact_projection(self):
  m=self.module()
  for expression in [m.HELLO,m.LOOKUP,m.ALTERNATIVE]:self.assertNotIn('await',expression);self.assertNotIn('toISOString',expression)
  for expression in [m.LOOKUP,m.ALTERNATIVE]:self.assertIn("findOne({_id:'execution-write-probe'},{_id:0,checkedAt:1})",expression);self.assertIn('EJSON.stringify',expression);self.assertIn('relaxed:false',expression)
 def good(self):
  return {'original':{'exitCode':1,'timeout':False,'classification':'EVALUATION_ERROR','dockerClientLaunched':True,'execProcessLaunched':True,'method':{'identifier':'Date.prototype.toISOString','receiver':'undefined'}},'diagnostics':{'mongo':{'running':True,'restartCount':0},'mongosh':{'available':True,'version':'2.3.8'},'hello':{'command':{'exitCode':0},'fields':{'ok':1,'isWritablePrimary':True,'secondary':False,'setName':'acceptance'}},'lookup':{'command':{'exitCode':0},'fields':{'documentFound':True,'checkedAtPresent':True,'checkedAtIsCanonicalBsonDate':True,'token':'DAPT_DATE:{"$date":{"$numberLong":"1790000000000"}}'}},'alternative':{'command':{'exitCode':0},'valid':True,'sameCheckedAt':True},'backend':{'running':True,'restartCount':0},'backendHealth':{'ready':True},'startupProbeRecordReady':True}}
 def test_root_gate_requires_every_original_and_healthy_boundary_fact(self):
  import startup_probe_diagnostic as d
  good=self.good();self.assertTrue(d.expression_gate(**good)['identified'])
  mutations=[('original','exitCode',0),('original','timeout',True),('original','execProcessLaunched',False),('original','method',{'identifier':'findOne'}),('diagnostics','hello',{'command':{'exitCode':1},'fields':{}}),('diagnostics','lookup',{'command':{'exitCode':0},'fields':{'checkedAtIsCanonicalBsonDate':False}}),('diagnostics','alternative',{'command':{'exitCode':0},'valid':True,'sameCheckedAt':False}),('diagnostics','backendHealth',{'ready':False}),('diagnostics','mongosh',{'available':False}),('diagnostics','mongo',{'running':False})]
  for section,key,value in mutations:
   r=copy.deepcopy(good);r[section][key]=value;self.assertFalse(d.expression_gate(**r)['identified'])
  for key,value in [('ok',0),('isWritablePrimary',False),('setName','other'),('secondary',True)]:
   r=copy.deepcopy(good);r['diagnostics']['hello']['fields'][key]=value;self.assertFalse(d.expression_gate(**r)['identified'])
if __name__=='__main__':unittest.main()

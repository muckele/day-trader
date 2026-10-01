import ast,importlib,json,os,pathlib,stat,sys,tempfile,unittest
from types import SimpleNamespace
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
class Marker(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.evidence=pathlib.Path(self.tmp.name);self.marker=self.evidence/'drop-response';self.owner=[0,0];self.calls=[];self.real_chmod=os.chmod
 def tearDown(self):self.tmp.cleanup()
 def chown(self,path,uid,gid):self.calls.append(('chown',path,uid,gid));self.owner[:]=[uid,gid]
 def chmod(self,path,mode):self.calls.append(('chmod',path,mode));self.real_chmod(path,mode)
 def lstat(self,path):
  s=path.stat();return SimpleNamespace(st_mode=s.st_mode,st_size=s.st_size,st_uid=self.owner[0],st_gid=self.owner[1])
 def mock_owner(self):return patch.object(pathlib.Path,'lstat',autospec=True,side_effect=self.lstat)
 def module(self):return importlib.import_module('drop_response_marker')
 def test_actual_driver_creation_corrects_root_owner_before_uncertain_fixture(self):
  tree=ast.parse((ROOT/'run.py').read_text());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main')
  candidates=[n for n in main.body if any(isinstance(x,ast.Constant) and x.value=='drop-response' or isinstance(x,ast.Name) and x.id=='create_drop_response' for x in ast.walk(n))]
  self.assertEqual(len(candidates),1)
  try:helper=self.module().create
  except ModuleNotFoundError:helper=None
  scope={'E':self.evidence,'create_drop_response':helper,'report':lambda *a,**kw:None}
  with patch('os.chown',side_effect=self.chown),patch('os.chmod',side_effect=self.chmod),self.mock_owner():
   exec(compile(ast.Module(body=candidates,type_ignores=[]),'marker-driver-boundary','exec'),scope)
  self.assertTrue(self.marker.is_file());self.assertEqual(self.marker.read_bytes(),b'')
  self.assertEqual(self.owner,[501,20],'root-created 0600 marker cannot be read by UID501 until ownership is corrected')
  self.assertIn(('chown',self.marker,501,20),self.calls);self.assertIn(('chmod',self.marker,0o600),self.calls)
  self.assertEqual(stat.S_IMODE(self.marker.stat().st_mode),0o600)
  statements=[ast.unparse(n) for n in main.body];i=main.body.index(candidates[0]);self.assertIn("control('logout')",'\n'.join(statements[:i]));self.assertIn("'gateway-framing'",'\n'.join(statements[:i]));self.assertIn("'gateway-uncertain-budget'",statements[i+2])
 def test_exact_safe_metadata_and_empty_marker(self):
  with patch('os.chown',side_effect=self.chown),patch('os.chmod',side_effect=self.chmod),self.mock_owner():r=self.module().create(self.evidence)
  self.assertEqual(r,{'label':'drop-response-marker','exists':True,'regularFile':True,'uid':501,'gid':20,'mode':'0600','size':0});self.assertEqual(self.marker.read_bytes(),b'');self.assertNotIn(str(self.evidence),json.dumps(r))
 def test_creation_failure_is_fatal(self):
  with patch.object(pathlib.Path,'touch',side_effect=PermissionError('private path')):
   with self.assertRaisesRegex(RuntimeError,'DROP_RESPONSE_MARKER_CREATE_FAILED'):self.module().create(self.evidence)
 def test_chown_failure_is_fatal_without_permission_fallback(self):
  with patch('os.chown',side_effect=PermissionError('private path')),patch('os.chmod') as chmod:
   with self.assertRaisesRegex(RuntimeError,'DROP_RESPONSE_MARKER_CREATE_FAILED'):self.module().create(self.evidence)
  chmod.assert_not_called();self.assertEqual(stat.S_IMODE(self.marker.stat().st_mode),0o600)
 def test_chmod_failure_is_fatal(self):
  with patch('os.chown',side_effect=self.chown),patch('os.chmod',side_effect=PermissionError('private path')):
   with self.assertRaisesRegex(RuntimeError,'DROP_RESPONSE_MARKER_CREATE_FAILED'):self.module().create(self.evidence)
 def test_incorrect_final_metadata_fails_closed(self):
  self.marker.touch(mode=0o600)
  good=dict(st_mode=stat.S_IFREG|0o600,st_uid=501,st_gid=20,st_size=0)
  for change in [{'st_uid':0},{'st_gid':0},{'st_mode':stat.S_IFREG|0o644},{'st_mode':stat.S_IFLNK|0o600},{'st_size':1}]:
   with self.subTest(change=change),patch.object(pathlib.Path,'lstat',return_value=SimpleNamespace(**{**good,**change})):
    with self.assertRaisesRegex(RuntimeError,'DROP_RESPONSE_MARKER_CONTRACT_FAILED'):self.module().verify(self.evidence)
 def test_failed_mode_correction_cannot_return_success(self):
  self.marker.touch(mode=0o644)
  with patch('os.chown',side_effect=self.chown),patch('os.chmod'),self.mock_owner():
   with self.assertRaisesRegex(RuntimeError,'DROP_RESPONSE_MARKER_CONTRACT_FAILED'):self.module().create(self.evidence)
 def test_missing_marker_at_final_scan_fails(self):
  with self.assertRaisesRegex(RuntimeError,'DROP_RESPONSE_MARKER_CONTRACT_FAILED'):self.module().verify(self.evidence)
 def test_local_model_separates_root_creation_from_browser_consumer(self):
  # Portable DAC contract model, not a claim to run a root->501 process on macOS.
  owner_uid,consumer_uid,mode=0,501,0o600
  self.assertFalse(bool(mode & (0o400 if owner_uid==consumer_uid else 0o004)))
  owner_uid=501;self.assertTrue(bool(mode & (0o400 if owner_uid==consumer_uid else 0o004)))
if __name__=='__main__':unittest.main()

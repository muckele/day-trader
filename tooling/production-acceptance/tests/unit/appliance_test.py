"""Synthetic byte fixtures; actual image tools and appliance construction never run."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('appliance_assembly', ROOT / 'appliance/assemble.py')
a = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = a
spec.loader.exec_module(a)

def sha(data): return hashlib.sha256(data).hexdigest()
def wire(value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

FEATURES = ['CONFIG_NAMESPACES', 'CONFIG_PID_NS', 'CONFIG_SECCOMP', 'CONFIG_SECCOMP_FILTER', 'CONFIG_TMPFS', 'CONFIG_USER_NS', 'CONFIG_VIRTIO', 'CONFIG_VIRTIO_BLK', 'CONFIG_VIRTIO_CONSOLE', 'CONFIG_VIRTIO_VSOCKETS', 'CONFIG_VSOCKETS']
PAYLOAD = ['controller', 'guestBootstrap', 'guestProbes', 'proxy', 'rolePolicy', 'routePolicy', 'seccompPolicy', 'verifier']
BASE = ['chromium', 'contracts', 'hostBroker', 'hostLauncher', 'initramfs', 'kernel', 'kernelConfig', 'node', 'playwright', 'python', 'rootfs']

def policy():
    return {
        'layout': {'guest': '/opt/acceptance/guest', 'contracts': '/opt/acceptance/contracts', 'nodeModules': '/opt/acceptance/node_modules', 'probes': '/opt/acceptance/tests/guest', 'bootstrap': '/opt/acceptance/guest/confinement.py', **{n+'Root': '/run/acceptance/'+n for n in ['controller','browser','verifier','proxy']}},
        'roles': {'controller':10001, 'browser':10002, 'verifier':10003, 'proxy':10004},
        'devices': {'bootLoader':'LINUX', 'baseBlock':'VIRTIO_READ_ONLY', 'entropy':1, 'serial':1, 'serialAttachment':'PRIVATE_PIPE', 'vsock':1, 'vsockHostCID':2, 'vsockPort':4050, **{n:0 for n in ['network','networkAttachments','shares','usb','audio','graphics','input','balloon','extra','hostTCPAdmin']}},
        'storage': {'baseReadOnly':True, 'writableDisks':0, 'runState':'TMPFS', **{n:False for n in ['guestSwap','zramSwap','hibernation','saveRestore','persistentCrash','hostShares']}},
        'resources': {'cpuCount':2, 'memoryBytes':2147483648, 'runTmpfsBytes':268435456, 'crashTmpfsBytes':1048576, 'shmBytes':67108864, 'tmpfsInodes':4096, 'aggregateTunnelBytes':1048576, 'idleTimeoutMs':10000, 'runTimeoutMs':60000, 'maxTunnels':16},
        'runtime': {'nodePath':'/opt/acceptance/runtime/node/bin/node', 'pythonPath':'/opt/acceptance/runtime/python/bin/python3', 'browserPath':'/opt/acceptance/runtime/chromium/chrome', 'browserSandbox':True, 'headless':True, 'nativeABIOnly':True, 'guestProxyAddress':'127.0.0.1', 'guestProxyPort':3128, 'vsockRole':'proxy', 'consoleRole':'controller', 'secretInputs':'NONE', 'downloads':False},
        'kernelFeatures':FEATURES,
        'compatibility':{'macOSMinimum':'14.0', 'sdkVersion':'27.0', 'hostArchitecture':'arm64'}}

def archive(entries):
    sink=io.BytesIO()
    with tarfile.open(fileobj=sink, mode='w') as tf:
        for name, content, kind, target, mode in entries:
            info=tarfile.TarInfo(name); info.mode=mode
            if kind == 'file':
                info.size=len(content); tf.addfile(info, io.BytesIO(content))
            else:
                info.type={'sym':tarfile.SYMTYPE,'hard':tarfile.LNKTYPE,'fifo':tarfile.FIFOTYPE,'dir':tarfile.DIRTYPE}[kind]
                info.linkname=target; tf.addfile(info)
    return sink.getvalue()

ARCHIVE_PATHS={'rootfs':'usr/share/synthetic-marker', 'node':'bin/node', 'python':'bin/python3', 'chromium':'chrome', 'playwright':'package.json', 'contracts':'schema.json'}

def artifact(id, data):
    return {'id':id, 'sha256':sha(data), 'sizeBytes':len(data), 'version':'synthetic-v1', 'sourceId':'synthetic-'+id}

class Fixture:
    def __init__(self, root):
        self.root=root; self.locations={}; self.bytes={}
        for id in BASE:
            data=('SYNTHETIC NONBOOTABLE '+id+'\n').encode()
            if id in ARCHIVE_PATHS:
                data=archive([(ARCHIVE_PATHS[id],data,'file','',0o755 if id in ['node','python','chromium'] else 0o644)])
            if id == 'kernelConfig': data=''.join(k+'=y\n' for k in FEATURES).encode()
            self.bytes[id]=data
            path=root/(id+'.fixture'); path.write_bytes(data); self.locations[id]=path
        tool=b'SYNTHETIC NONEXECUTABLE TOOL\n'; self.tool=root/'mke2fs.fixture'; self.tool.write_bytes(tool)
        self.manifest={'manifestVersion':1,'kind':'ASSEMBLY_INPUTS','architecture':'aarch64','distribution':'ubuntu-24.04','policy':policy(),'payloadState':'INCOMPLETE','missingPayload':PAYLOAD,'artifacts':[artifact(id,self.bytes[id]) for id in BASE],'tools':[artifact('mke2fs',tool)],'provenance':{'sourceRevision':'0'*40,'approvalId':'synthetic-review','buildEnvironmentId':'synthetic-offline','inputClass':'SYNTHETIC'}}
    def replace(self,id,data):
        self.bytes[id]=data; self.locations[id].write_bytes(data)
        self.manifest['artifacts']=[artifact(id,data) if x['id']==id else x for x in self.manifest['artifacts']]
    def validate(self, manifest=None):
        m=manifest if manifest is not None else self.manifest
        return a.validate_inputs(m,locations=self.locations,tool_locations={'mke2fs':self.tool},expected_inputs_digest=sha(wire(m)))

class FakeImageTool:
    def __init__(self, action=None): self.commands=[]; self.action=action; self.consumed={}
    def run(self, command):
        self.commands.append(command)
        if self.action: return self.action(command)
        self.consumed={id:path.read_bytes() for id,path in command.snapshots}
        command.output.write_bytes(b'SYNTHETIC BASE CONTRACT BYTES\n')

class ApplianceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='appliance-contract-'); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.f=Fixture(self.root)
    def denied(self, code, fn):
        with self.assertRaises(a.ApplianceError) as caught: fn()
        self.assertEqual(caught.exception.code,code)
    def test_wrong_architecture_denied(self):
        self.f.manifest['architecture']='x86_64'; self.denied('ARCHITECTURE',self.f.validate)
    def test_unknown_duplicate_and_ambiguous_wire_denied(self):
        raw=wire(self.f.manifest)
        for changed in [raw.replace(b'"manifestVersion":1',b'"manifestVersion":1,"manifestVersion":1'),raw.replace(b'"manifestVersion":1',b'"manifestVersion":1.0'),raw.replace(b'"manifestVersion":1',b'"manifestVersion":1e0'),raw.replace(b'"manifestVersion":1',b'"manifestVersion":true'),raw.replace(b'"manifestVersion":1',b'"manifestVersion":-0'),raw[:-1]+b',"extra":0}',b' '*65537+raw]:
            with self.subTest(wire=changed[:30]): self.denied('INVALID_MANIFEST',lambda:a.decode_inputs(changed))
    def test_missing_resources_and_integer_bounds_denied(self):
        for key,value in [('cpuCount',0),('memoryBytes',17179869185),('maxTunnels',17),('shmBytes',0),('tmpfsInodes',65537),('aggregateTunnelBytes',1073741825)]:
            m=copy.deepcopy(self.f.manifest); m['policy']['resources'][key]=value
            with self.subTest(key=key): self.denied('POLICY',lambda:self.f.validate(m))
        m=copy.deepcopy(self.f.manifest); del m['policy']['resources']['cpuCount']
        self.denied('INVALID_MANIFEST',lambda:self.f.validate(m))
    def test_role_device_layout_storage_runtime_drift_denied(self):
        for group,key,value in [('roles','browser',0),('devices','network',1),('devices','serial',2),('devices','serialAttachment','STDIO'),('devices','vsockPort',4051),('storage','baseReadOnly',False),('storage','writableDisks',1),('storage','saveRestore',True),('runtime','browserSandbox',False),('runtime','downloads',True),('layout','guest','/home/guest')]:
            m=copy.deepcopy(self.f.manifest); m['policy'][group][key]=value
            with self.subTest(key=key): self.denied('POLICY',lambda:self.f.validate(m))
    def test_missing_or_unpinned_runtime_denied(self):
        for id in ['node','python','playwright','chromium']:
            m=copy.deepcopy(self.f.manifest); m['artifacts']=[x for x in m['artifacts'] if x['id']!=id]
            with self.subTest(id=id): self.denied('MISSING_RUNTIME',lambda:self.f.validate(m))
        m=copy.deepcopy(self.f.manifest); m['artifacts'][0]['sha256']=''
        self.denied('INVALID_MANIFEST',lambda:self.f.validate(m))
    def test_identity_and_byte_hash_denied(self):
        self.denied('IDENTITY_MISMATCH',lambda:a.validate_inputs(self.f.manifest,locations=self.f.locations,tool_locations={'mke2fs':self.f.tool},expected_inputs_digest='f'*64))
        self.f.locations['kernel'].write_bytes(b'tampered')
        self.denied('ARTIFACT_MISMATCH',self.f.validate)
    def test_missing_module_or_contradictory_kernel_config_denied(self):
        for suffix in [b'',b'CONFIG_VSOCKETS=m\n',b'CONFIG_VSOCKETS=y\nCONFIG_VSOCKETS=n\n']:
            self.f.replace('kernelConfig',''.join(k+'=y\n' for k in FEATURES if k!='CONFIG_VSOCKETS').encode()+suffix)
            with self.subTest(suffix=suffix): self.denied('KERNEL_FEATURE',self.f.validate)
    def test_unauthorized_extra_input_and_location_denied(self):
        self.f.locations['secret']=self.f.tool
        self.denied('UNAUTHORIZED_INPUT',self.f.validate)
    def test_incomplete_payload_cannot_be_declared_complete(self):
        self.f.manifest['payloadState']='COMPLETE'; self.f.manifest['missingPayload']=[]
        self.denied('PAYLOAD_INCOMPLETE',self.f.validate)
    def test_archive_traversal_absolute_and_special_denied(self):
        for entry in [('../escape',b'x','file','',0o644),('/absolute',b'x','file','',0o644),('usr/fifo',b'','fifo','',0o644),('usr/bin/x',b'x','file','',0o4755)]:
            self.f.replace('rootfs',archive([entry])); self.denied('ARCHIVE_UNSAFE',self.f.validate)
    def test_archive_symlink_hardlink_escape_and_cycle_denied(self):
        for entries in [[('usr/link',b'','sym','../../escape',0o777)],[('usr/link',b'','hard','../escape',0o644)],[('a',b'','sym','b',0o777),('b',b'','sym','a',0o777)],[('usr',b'','sym','etc',0o777),('usr/new',b'x','file','',0o644)]]:
            self.f.replace('rootfs',archive(entries)); self.denied('ARCHIVE_UNSAFE',self.f.validate)
    def test_archive_safe_relative_links_and_bounded_members(self):
        self.f.replace('rootfs',archive([('usr/data',b'synthetic','file','',0o644),('usr/link',b'','sym','data',0o777),('usr/hard',b'','hard','usr/data',0o644)]))
        self.assertIsNotNone(self.f.validate())
        self.f.replace('rootfs',archive([('usr/data',b'x','file','',0o644),('usr/data',b'y','file','',0o644)]))
        self.denied('ARCHIVE_UNSAFE',self.f.validate)
    def test_archive_runtime_secret_and_unauthorized_path_denied(self):
        for name,code in [('etc/.env','SECRET_MATERIAL'),('home/matt/cookies.json','SECRET_MATERIAL'),('root/.ssh/id_rsa','SECRET_MATERIAL'),('opt/acceptance/guest/injected.py','UNAUTHORIZED_INPUT')]:
            self.f.replace('rootfs',archive([(name,b'synthetic forbidden material','file','',0o600)])); self.denied(code,self.f.validate)
    def test_runtime_archive_must_contain_fixed_executable(self):
        self.f.replace('chromium',archive([('other',b'x','file','',0o755)]))
        self.denied('MISSING_RUNTIME',self.f.validate)
    def test_symlink_and_hardlinked_input_denied(self):
        original=self.f.locations['kernel']; alias=self.root/'alias'; alias.symlink_to(original)
        self.f.locations['kernel']=alias; self.denied('UNAUTHORIZED_INPUT',self.f.validate)
        alias.unlink(); os.link(original,alias); self.denied('UNAUTHORIZED_INPUT',self.f.validate)
    def test_input_substitution_before_consumption_denied(self):
        checked=self.f.validate(); self.f.locations['kernel'].write_bytes(b'substitution')
        fake=FakeImageTool(); self.denied('INPUT_CHANGED',lambda:a.assemble(checked,self.root/'out',image_tool=fake))
        self.assertEqual(fake.commands,[]); self.assertFalse((self.root/'out').exists())
    def test_tool_substitution_denied(self):
        checked=self.f.validate(); self.f.tool.write_bytes(b'substitution')
        self.denied('INPUT_CHANGED',lambda:a.assemble(checked,self.root/'out',image_tool=FakeImageTool()))
    def test_input_mutation_by_runner_denied_and_partial_cleanup_confined(self):
        checked=self.f.validate(); sibling=self.root/'keep'; sibling.write_bytes(b'keep')
        def attack(command):
            self.f.locations['kernel'].write_bytes(b'substitution'); command.output.write_bytes(b'fake')
        self.denied('INPUT_CHANGED',lambda:a.assemble(checked,self.root/'out',image_tool=FakeImageTool(attack)))
        self.assertEqual(sibling.read_bytes(),b'keep'); self.assertFalse((self.root/'out').exists())
        self.assertEqual(list(self.root.glob('.out.partial-*')),[])
    def test_output_exists_file_directory_and_symlink_denied(self):
        for kind in ['file','directory','symlink']:
            out=self.root/kind
            if kind=='file': out.write_bytes(b'keep')
            elif kind=='directory': out.mkdir(); (out/'keep').write_bytes(b'keep')
            else: out.symlink_to(self.root/'missing')
            self.denied('OUTPUT_EXISTS',lambda:a.assemble(self.f.validate(),out,image_tool=FakeImageTool()))
            self.assertTrue(os.path.lexists(out))
    def test_symlink_output_parent_denied(self):
        alias=self.root/'alias'; alias.symlink_to(self.root,target_is_directory=True)
        self.denied('UNAUTHORIZED_INPUT',lambda:a.assemble(self.f.validate(),alias/'out',image_tool=FakeImageTool()))
    def test_runner_failure_cleanup_and_no_fallback(self):
        def fail(command): command.output.write_bytes(b'partial'); raise RuntimeError('private detail')
        self.denied('TOOL_FAILURE',lambda:a.assemble(self.f.validate(),self.root/'out',image_tool=FakeImageTool(fail)))
        self.assertFalse((self.root/'out').exists()); self.assertEqual(list(self.root.glob('.out.partial-*')),[])
        self.denied('TOOL_UNAVAILABLE',lambda:a.assemble(self.f.validate(),self.root/'out2',image_tool=None))
    def test_runner_output_symlink_substitution_denied(self):
        outside=self.root/'outside'; outside.write_bytes(b'keep')
        def attack(command): command.output.symlink_to(outside)
        self.denied('ARTIFACT_MISMATCH',lambda:a.assemble(self.f.validate(),self.root/'out',image_tool=FakeImageTool(attack)))
        self.assertEqual(outside.read_bytes(),b'keep')
    def test_synthetic_assembly_binds_exact_inputs_outputs_and_command(self):
        fake=FakeImageTool(); result=a.assemble(self.f.validate(),self.root/'out',image_tool=fake)
        self.assertIn('outputs',result)
        self.assertEqual(result['inputsDigest'],sha(wire(self.f.manifest)))
        self.assertEqual(result['components'],self.f.manifest['artifacts'])
        self.assertEqual(result['provenance']['assemblyMode'],'SYNTHETIC')
        self.assertEqual(result['manifestSigning'],'UNPERFORMED'); self.assertEqual(result['runtimeQualification'],'UNPERFORMED')
        outputs={x['id']:x for x in result['outputs']}
        self.assertEqual(outputs['base']['sha256'],sha(b'SYNTHETIC BASE CONTRACT BYTES\n'))
        self.assertEqual(outputs['kernel']['sha256'],sha(self.f.bytes['kernel']))
        self.assertEqual(len(fake.commands),1)
        self.assertEqual(fake.consumed,{**self.f.bytes,'mke2fs':b'SYNTHETIC NONEXECUTABLE TOOL\n'})
        cmd=fake.commands[0]
        self.assertEqual(cmd.argv,(str(cmd.tool_path),'-q','-t','ext4','-b','4096','-d',str(cmd.population),str(cmd.output),'262144'))
        self.assertEqual(cmd.tool_identity['sha256'],sha(self.f.tool.read_bytes()))
        provenance=json.loads((self.root/'out/provenance.json').read_bytes())
        self.assertEqual(provenance['inputsDigest'],result['inputsDigest'])
        self.assertEqual(provenance['manifestDigest'],sha(wire(result)))
        self.assertEqual(provenance['argv'],list(cmd.argv))
        self.assertEqual(a.decode_appliance(wire(result)),result)
    def test_synthetic_and_incomplete_cannot_be_qualified(self):
        result=a.assemble(self.f.validate(),self.root/'out',image_tool=FakeImageTool())
        self.denied('PAYLOAD_INCOMPLETE',lambda:a.require_qualified(result))
        # The wire cannot claim future proofs, even if a caller supplies them.
        changed=copy.deepcopy(result); changed['manifestSigning']='VERIFIED'
        self.denied('INVALID_MANIFEST',lambda:a.decode_appliance(wire(changed)))
    def test_cli_never_constructs_or_invokes_tool(self):
        self.assertNotEqual(a.cli(['--inputs',str(self.root/'nonexistent'),'--output',str(self.root/'out')]),0)
        self.assertFalse((self.root/'out').exists())
    def test_canonical_output_and_tamper_rejection(self):
        result=a.assemble(self.f.validate(),self.root/'out',image_tool=FakeImageTool())
        self.assertIn('outputs',result)
        self.assertEqual(a.canonical_manifest(result),wire(result))
        result['outputs'][1]['sha256']='f'*64
        self.denied('ARTIFACT_MISMATCH',lambda:a.decode_appliance(wire(result)))
    def test_private_key_material_denied_but_public_certificate_allowed(self):
        public=b"-----BEGIN CERTIFICATE-----\nSYNTHETIC PUBLIC CERTIFICATE DATA\n-----END CERTIFICATE-----\n"
        self.f.replace('rootfs',archive([('etc/ssl/certs/public.pem',public,'file','',0o644)]))
        self.assertIsNotNone(self.f.validate())
        private=b"SYNTHETIC DO NOT USE\n-----BEGIN PRIVATE KEY-----\nNOT A REAL KEY\n"
        self.f.replace('rootfs',archive([('etc/ssl/unknown.pem',private,'file','',0o600)]))
        self.denied('SECRET_MATERIAL',self.f.validate)
    def test_group_world_writable_payload_denied(self):
        self.f.replace('node',archive([('bin/node',b'synthetic','file','',0o777)]))
        self.denied('ARCHIVE_UNSAFE',self.f.validate)
    def test_snapshot_substitution_by_runner_denied(self):
        def attack(command):
            path=dict(command.snapshots)['kernel']; path.chmod(0o600); path.write_bytes(b'tampered')
            command.output.write_bytes(b'fake')
        self.denied('INPUT_CHANGED',lambda:a.assemble(self.f.validate(),self.root/'out',image_tool=FakeImageTool(attack)))
        self.assertFalse((self.root/'out').exists())
    def test_output_appearing_during_runner_preserved(self):
        out=self.root/'out'
        def attack(command):
            out.mkdir(); (out/'keep').write_bytes(b'other producer'); command.output.write_bytes(b'fake')
        self.denied('OUTPUT_EXISTS',lambda:a.assemble(self.f.validate(),out,image_tool=FakeImageTool(attack)))
        self.assertEqual((out/'keep').read_bytes(),b'other producer')
    def test_hardlinked_output_denied(self):
        outside=self.root/'outside'; outside.write_bytes(b'keep')
        def attack(command): os.link(outside,command.output)
        self.denied('ARTIFACT_MISMATCH',lambda:a.assemble(self.f.validate(),self.root/'out',image_tool=FakeImageTool(attack)))
        self.assertEqual(outside.read_bytes(),b'keep')
    def test_complete_synthetic_payload_still_cannot_qualify(self):
        for id in PAYLOAD:
            data=('SYNTHETIC '+id+'\n').encode()
            if id=='guestProbes': data=archive([('probe.txt',data,'file','',0o644)])
            path=self.root/(id+'.fixture'); path.write_bytes(data); self.f.locations[id]=path
            self.f.manifest['artifacts'].append(artifact(id,data))
        self.f.manifest['artifacts'].sort(key=lambda x:x['id'])
        self.f.manifest['payloadState']='COMPLETE'; self.f.manifest['missingPayload']=[]
        result=a.assemble(self.f.validate(),self.root/'out',image_tool=FakeImageTool())
        self.denied('SYNTHETIC_ONLY',lambda:a.require_qualified(result))
        changed=copy.deepcopy(result); changed['provenance']['assemblyMode']='NATIVE_ARM64_LINUX'
        self.denied('SIGNING_UNAVAILABLE',lambda:a.require_qualified(changed))
    def test_caller_record_cannot_create_approved_inputs(self):
        self.denied('UNAUTHORIZED_INPUT',lambda:a.ApprovedInputs(wire(self.f.manifest),(),()))
        self.denied('UNAUTHORIZED_INPUT',lambda:a.assemble(self.f.manifest,self.root/'out',image_tool=FakeImageTool()))
    def test_m1_helper_ceiling_and_safe_integer_unchanged(self):
        rule={'type':'object','fields':{'n':{'type':'integer','min':0,'max':9007199254740991}}}
        for data,limit in [(b'{"n":0}',65537),(b'{"n":1.0}',32),(b'{"n":-0}',32),(b'{"n":true}',32),(b'{"n":9007199254740992}',64),(b'{"n":1,"n":2}',32)]:
            with self.subTest(data=data,limit=limit), self.assertRaises(a._protocol.InvalidFrame):
                a._protocol.decode_document(data,rule=rule,definitions={},max_bytes=limit)
        self.assertEqual(a._protocol.canonical_document({'n':7},rule=rule,definitions={},max_bytes=32),b'{"n":7}')
    def test_wire_semantic_failures_have_stable_codes(self):
        wrong=copy.deepcopy(self.f.manifest); wrong['architecture']='x86_64'
        self.denied('ARCHITECTURE',lambda:a.decode_inputs(wire(wrong)))
        wrong=copy.deepcopy(self.f.manifest); wrong['policy']['devices']['network']=1
        self.denied('POLICY',lambda:a.decode_inputs(wire(wrong)))
    def test_required_kernel_disabled_declaration_rejected_in_both_orders(self):
        original=self.f.bytes['kernelConfig']
        for feature in FEATURES:
            disabled=('# '+feature+' is not set\n').encode()
            for data in [disabled+original,original+disabled]:
                with self.subTest(feature=feature,disabled_first=data.startswith(disabled)):
                    self.f.replace('kernelConfig',data)
                    self.denied('KERNEL_FEATURE',self.f.validate)
    def test_kernel_unrelated_comments_remain_allowed(self):
        self.f.replace('kernelConfig',self.f.bytes['kernelConfig']+b'# ordinary synthetic note\n# CONFIG_UNRELATED is not set\n')
        self.assertIsNotNone(self.f.validate())
    def direct_payload_validation(self,id,data):
        path=self.root/(id+'.direct'); path.write_bytes(data)
        manifest=copy.deepcopy(self.f.manifest)
        manifest['artifacts'].append(artifact(id,data)); manifest['artifacts'].sort(key=lambda item:item['id'])
        manifest['missingPayload']=[item for item in manifest['missingPayload'] if item!=id]
        return a.validate_inputs(manifest,locations={**self.f.locations,id:path},tool_locations={'mke2fs':self.f.tool},expected_inputs_digest=sha(wire(manifest)))
    def test_direct_authored_payload_private_marker_denied(self):
        data=b'SYNTHETIC NONSECRET TEST\n-----BEGIN PRIVATE KEY-----\nNOT A REAL KEY\n'
        for id in ['controller','guestBootstrap','proxy','verifier','rolePolicy','seccompPolicy','routePolicy']:
            with self.subTest(id=id):
                self.denied('SECRET_MATERIAL',lambda:self.direct_payload_validation(id,data))
    def test_direct_marker_across_stream_chunks_denied(self):
        data=b'SYNTHETIC '+b'.'*(65530-len(b'SYNTHETIC '))+b'PRIVATE KEY-----\nNOT A REAL KEY\n'
        self.denied('SECRET_MATERIAL',lambda:self.direct_payload_validation('controller',data))
    def test_direct_public_certificate_allowed(self):
        public=b'-----BEGIN CERTIFICATE-----\nSYNTHETIC PUBLIC CERTIFICATE\n-----END CERTIFICATE-----\n'
        self.assertIsNotNone(self.direct_payload_validation('controller',public))
    def test_composition_export(self):
        destination=os.environ.get('M3_APPLIANCE_OUTPUT')
        if not destination: return
        result=a.assemble(self.f.validate(),self.root/'assembled',image_tool=FakeImageTool())
        self.assertIn('outputs',result)
        out=Path(destination)
        self.assertFalse(os.path.lexists(out)); out.mkdir()
        files={id:id+'.synthetic' for id in ['base','initramfs','kernel']}
        for id,filename in files.items():
            with (out/filename).open('xb') as f: f.write((self.root/'assembled'/filename).read_bytes())
        bundle={'bundleVersion':1,'manifest':result,'expectedManifestDigest':sha(wire(result)),'files':files}
        with (out/'bundle.json').open('xb') as f: f.write(wire(bundle))
        self.assertEqual(len(list(out.iterdir())),4)

if __name__=='__main__': unittest.main()

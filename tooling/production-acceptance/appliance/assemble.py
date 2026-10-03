"""Bounded offline appliance identity/assembly contract; no operational default.

ImageToolRunner is an explicit trusted effect boundary. M3 accepts SYNTHETIC
inputs only for assembly and emits nonbootable fixture files. Native population,
image construction, signer trust and runtime qualification remain unavailable.
"""
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile
import tempfile
from typing import Mapping, Protocol

_spec = importlib.util.spec_from_file_location('acceptance_protocol', Path(__file__).resolve().parents[1] / 'guest/protocol.py')
_protocol = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_protocol)
_SCHEMA_PATH = Path(__file__).with_name('manifest.schema.json')
_SCHEMA = json.loads(_SCHEMA_PATH.read_bytes())
if (set(_SCHEMA) != {'schemaVersion','maxBytes','maxDepth','definitions','inputManifest','applianceManifest','legacyInputManifest','legacyApplianceManifest'}
        or _SCHEMA['schemaVersion'] != 2 or _SCHEMA['maxBytes'] != 65536 or _SCHEMA['maxDepth'] != 8
        or set(_SCHEMA['definitions']) != {'identity','policy','legacyIdentity','legacyPolicy'}):
    raise ValueError('INVALID_MANIFEST')

BASE_IDS = frozenset(['rootfs','kernel','initramfs','kernelConfig','node','python','playwright','chromium','hostLauncher','hostBroker','contracts'])
LEGACY_PAYLOAD_IDS = frozenset(['guestBootstrap','controller','proxy','verifier','rolePolicy','seccompPolicy','routePolicy','guestProbes'])
PAYLOAD_IDS = LEGACY_PAYLOAD_IDS | {'browserWorker'}
RUNTIME_IDS = frozenset(['node','python','playwright','chromium'])
ARCHIVE_IDS = frozenset(['rootfs','node','python','playwright','chromium','contracts','guestProbes'])
REQUIRED_FILES = {'node':'bin/node','python':'bin/python3','chromium':'chrome'}
LEGACY_FEATURES = tuple(sorted(['CONFIG_NAMESPACES','CONFIG_PID_NS','CONFIG_SECCOMP','CONFIG_SECCOMP_FILTER','CONFIG_TMPFS','CONFIG_USER_NS','CONFIG_VIRTIO','CONFIG_VIRTIO_BLK','CONFIG_VIRTIO_CONSOLE','CONFIG_VIRTIO_VSOCKETS','CONFIG_VSOCKETS']))
FEATURES = tuple(sorted((*LEGACY_FEATURES,'CONFIG_AUDIT','CONFIG_AUDITSYSCALL','CONFIG_INOTIFY_USER')))
EXECUTABLE_MAPPING = (
    ('browserWorker','','/opt/acceptance/guest/browser-worker.cjs'),
    ('chromium','chrome','/opt/acceptance/runtime/chromium/chrome'),
    ('controller','','/opt/acceptance/guest/controller.cjs'),
    ('node','bin/node','/opt/acceptance/runtime/node/bin/node'),
    ('proxy','','/opt/acceptance/guest/proxy.py'),
    ('python','bin/python3','/opt/acceptance/runtime/python/bin/python3'),
    ('verifier','','/opt/acceptance/guest/verifier.cjs'))
MAX_ARCHIVE_MEMBERS = 100000
MAX_EXPANDED_BYTES = 68719476736
MAX_SYNTHETIC_BYTES = 16 * 1024 * 1024

class ApplianceError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _fail(code): raise ApplianceError(code)
def _sha(data): return hashlib.sha256(data).hexdigest()
def _rule(value):
    if type(value) is not dict: _fail('INVALID_MANIFEST')
    key = {'ASSEMBLY_INPUTS':'inputManifest','APPLIANCE_MANIFEST':'applianceManifest'}.get(value.get('kind'))
    if key is None: _fail('INVALID_MANIFEST')
    version=value.get('manifestVersion')
    if type(version) is not int or version not in (1,2): _fail('INVALID_MANIFEST')
    return _SCHEMA[key if version == 2 else 'legacy'+key[0].upper()+key[1:]]

def _policy_rule(value):
    return _SCHEMA['definitions']['policy' if value['manifestVersion'] == 2 else 'legacyPolicy']


def _policy_shape(value, rule):
    """Separate structural omissions from correctly shaped forbidden policy."""
    if rule.get('type') == 'object':
        if type(value) is not dict or value.keys() != rule['fields'].keys(): _fail('INVALID_MANIFEST')
        for key, child in rule['fields'].items(): _policy_shape(value[key], child)


def _semantics(value):
    if value['architecture'] != 'aarch64': _fail('ARCHITECTURE')
    policy=_policy_rule(value)
    _policy_shape(value['policy'], policy)
    try: _protocol._check(value['policy'], policy, definitions=_SCHEMA['definitions'])
    except _protocol.InvalidFrame: _fail('POLICY')
    payload=PAYLOAD_IDS if value['manifestVersion'] == 2 else LEGACY_PAYLOAD_IDS
    features=FEATURES if value['manifestVersion'] == 2 else LEGACY_FEATURES
    if value['policy']['kernelFeatures'] != list(features): _fail('KERNEL_FEATURE')
    identities = value['artifacts'] if value['kind'] == 'ASSEMBLY_INPUTS' else value['components']
    ids = [item['id'] for item in identities]
    if ids != sorted(set(ids)) or set(ids) - BASE_IDS - payload: _fail('UNAUTHORIZED_INPUT')
    if not RUNTIME_IDS <= set(ids): _fail('MISSING_RUNTIME')
    if not BASE_IDS <= set(ids): _fail('UNAUTHORIZED_INPUT')
    missing = sorted(payload - set(ids))
    if value['missingPayload'] != missing or value['payloadState'] != ('INCOMPLETE' if missing else 'COMPLETE'):
        _fail('PAYLOAD_INCOMPLETE')
    tools = value['tools'] if value['kind'] == 'ASSEMBLY_INPUTS' else value['provenance']['tools']
    if [item['id'] for item in tools] != ['mke2fs']: _fail('UNAUTHORIZED_INPUT')
    if value['kind'] == 'APPLIANCE_MANIFEST':
        if [x['id'] for x in value['outputs']] != ['base','initramfs','kernel']: _fail('UNAUTHORIZED_INPUT')
        by_id = {x['id']:x for x in identities}
        for item in value['outputs'][1:]:
            if item != by_id[item['id']]: _fail('ARTIFACT_MISMATCH')


def _validated(value):
    try:
        rule = _rule(value)
        # Structural checks happen before semantic indexing. The same finite
        # descriptor is used except policy/architecture checks classified below.
        structural = {**rule, 'fields':dict(rule['fields'])}
        structural['fields']['architecture'] = {'type':'string','pattern':'[A-Za-z0-9_]+','max':32}
        _policy_shape(value.get('policy'), _policy_rule(value))
        # Validate every non-policy field exactly; policy is still validated below.
        fields = structural['fields']; fields.pop('policy')
        remaining = dict(value); remaining.pop('policy')
        _protocol._check(remaining, structural, definitions=_SCHEMA['definitions'])
        _semantics(value)
        _protocol._check(value, rule, definitions=_SCHEMA['definitions'])
        return value
    except ApplianceError: raise
    except (ValueError, TypeError, KeyError, RecursionError, OverflowError): _fail('INVALID_MANIFEST')


def _policy_wire_shape(rule):
    """Trusted schema-derived type check before exact semantic error reporting.

    No value is returned to callers before _validated enforces the original
    complete schema and policy. Receipt decoding never uses this shape.
    """
    kind = rule['type']
    if kind == 'object':
        return {'type':'object','fields':{k:_policy_wire_shape(v) for k,v in rule['fields'].items()}}
    if kind == 'array':
        return {**rule,'item':_policy_wire_shape(rule['item'])}
    if kind == 'integer': return {'type':'integer','min':0,'max':9007199254740991}
    if kind == 'enum':
        value = rule['values'][0]
        if type(value) is bool: return {'type':'boolean'}
        if type(value) is int: return {'type':'integer','min':0,'max':9007199254740991}
        return {'type':'string','pattern':'[ -~]*','max':256}
    return rule


def _decode(data, kind):
    try:
        # Parse with M1 strict primitive using a schema-specific structural rule.
        # Classification never adds a permissive generic JSON admission path.
        # Strict bounded JSON discrimination first. Every field then traverses
        # only one of the two frozen trusted descriptors, never a caller rule.
        if type(data) is not bytes or not 0 < len(data) <= 65536: _fail('INVALID_MANIFEST')
        discriminator=json.loads(data,object_pairs_hook=_protocol._pairs,parse_int=_protocol._integer,
                                 parse_float=lambda _: _fail('INVALID_MANIFEST'),parse_constant=lambda _: _fail('INVALID_MANIFEST'))
        rule = _rule(discriminator)
        if discriminator.get('kind') != kind: _fail('INVALID_MANIFEST')
        wire_rule = {**rule,'fields':dict(rule['fields'])}
        wire_rule['fields']['architecture'] = {'type':'string','pattern':'[A-Za-z0-9_]+','max':32}
        wire_rule['fields']['policy'] = _policy_wire_shape(_policy_rule(discriminator))
        value = _protocol.decode_document(data, rule=wire_rule, definitions=_SCHEMA['definitions'], max_bytes=65536)
        return _validated(value)
    except ApplianceError: raise
    except (_protocol.InvalidFrame,ValueError,TypeError,RecursionError): _fail('INVALID_MANIFEST')


def decode_inputs(data: bytes) -> dict: return _decode(data, 'ASSEMBLY_INPUTS')
def decode_appliance(data: bytes) -> dict: return _decode(data, 'APPLIANCE_MANIFEST')
def canonical_manifest(value: dict) -> bytes:
    _validated(value)
    try:
        return _protocol.canonical_document(value, rule=_rule(value), definitions=_SCHEMA['definitions'], max_bytes=65536)
    except _protocol.InvalidFrame: _fail('INVALID_MANIFEST')

def manifest_digest(value: dict) -> str: return _sha(canonical_manifest(value))


def _safe_path(path, code='UNAUTHORIZED_INPUT'):
    path = Path(path).absolute()
    if '..' in path.parts: _fail(code)
    for current in reversed([path, *path.parents]):
        try:
            if stat.S_ISLNK(current.lstat().st_mode): _fail(code)
        except FileNotFoundError: pass
    return path


def _fingerprint(s): return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_mode,s.st_nlink,s.st_uid,s.st_gid)


def _open_checked(path, code):
    path = _safe_path(path, code)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
            os.close(fd); _fail(code)
        return os.fdopen(fd,'rb'), _fingerprint(s)
    except OSError: _fail(code)


def _hash_file(path, identity, code, destination=None):
    source, before = _open_checked(path, code)
    total = 0; digest = hashlib.sha256()
    with source:
        while True:
            chunk = source.read(1024*1024)
            if not chunk: break
            total += len(chunk)
            if total > identity['sizeBytes']: _fail(code)
            digest.update(chunk)
            if destination is not None: destination.write(chunk)
        if _fingerprint(os.fstat(source.fileno())) != before: _fail(code)
    if total != identity['sizeBytes'] or digest.hexdigest() != identity['sha256']: _fail(code)
    try:
        if _fingerprint(Path(path).lstat()) != before: _fail(code)
    except OSError: _fail(code)
    return before


def _member_name(name):
    if not name or len(name.encode()) > 4096 or '\\' in name or any(ord(c)<32 or ord(c)>126 for c in name): _fail('ARCHIVE_UNSAFE')
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or str(p) != name.rstrip('/') or str(p) == '.': _fail('ARCHIVE_UNSAFE')
    return str(p)


def _link_target(name, link, hard):
    if not link or link.startswith('/') or '\\' in link: _fail('ARCHIVE_UNSAFE')
    parts = [] if hard else name.split('/')[:-1]
    for part in link.split('/'):
        if part == '..':
            if not parts: _fail('ARCHIVE_UNSAFE')
            parts.pop()
        elif part not in ['', '.']: parts.append(part)
    if not parts: _fail('ARCHIVE_UNSAFE')
    return _member_name('/'.join(parts))


def _reject_known_secret(stream, max_bytes):
    """Screen bounded archive members and direct authored payloads identically."""
    tail = b''
    consumed = 0
    while True:
        chunk = stream.read(65536)
        if not chunk: break
        consumed += len(chunk)
        if consumed > max_bytes: _fail('INPUT_CHANGED')
        window = tail + chunk
        if b'PRIVATE KEY-----' in window: _fail('SECRET_MATERIAL')
        tail = window[-128:]


def _archive(path, id):
    source, before = _open_checked(path, 'UNAUTHORIZED_INPUT')
    entries = {}; total = 0
    try:
        with source, tarfile.open(fileobj=source,mode='r:*') as tf:
            for member in tf:
                name = _member_name(member.name)
                if len(entries) >= MAX_ARCHIVE_MEMBERS or name in entries: _fail('ARCHIVE_UNSAFE')
                total += member.size
                if total > MAX_EXPANDED_BYTES or member.size < 0 or member.mode & 0o7000: _fail('ARCHIVE_UNSAFE')
                if not (member.isfile() or member.isdir() or member.issym() or member.islnk()): _fail('ARCHIVE_UNSAFE')
                if member.isfile() and member.mode & 0o022: _fail('ARCHIVE_UNSAFE')
                lowered = name.lower(); pieces = lowered.split('/')
                if any(p in {'.env','.aws','.ssh','id_rsa','id_ed25519','cookies.json','storagestate.json','credentials.json','credentials','secrets'} for p in pieces):
                    _fail('SECRET_MATERIAL')
                if id == 'rootfs' and (name == 'opt/acceptance' or name.startswith('opt/acceptance/') or (pieces[0] in ['root','home'] and not member.isdir())):
                    _fail('UNAUTHORIZED_INPUT')
                if member.isfile():
                    # Reject recognizable private-key material, without treating
                    # public CA certificates as secrets or exporting any bytes.
                    stream = tf.extractfile(member)
                    if stream is None: _fail('ARCHIVE_UNSAFE')
                    with stream: _reject_known_secret(stream, member.size)
                target = _link_target(name,member.linkname,member.islnk()) if member.issym() or member.islnk() else None
                entries[name] = (member, target)
            for name,(member,target) in entries.items():
                for parent in PurePosixPath(name).parents:
                    if str(parent) in entries and not entries[str(parent)][0].isdir(): _fail('ARCHIVE_UNSAFE')
                seen = set(); cursor = name
                while entries[cursor][1] is not None:
                    if cursor in seen or len(seen)>32: _fail('ARCHIVE_UNSAFE')
                    seen.add(cursor); cursor=entries[cursor][1]
                    if cursor not in entries: _fail('ARCHIVE_UNSAFE')
                if member.islnk() and not entries[cursor][0].isfile(): _fail('ARCHIVE_UNSAFE')
            if id in REQUIRED_FILES:
                member = entries.get(REQUIRED_FILES[id],(None,None))[0]
                if member is None or not member.isfile() or not member.mode & 0o111: _fail('MISSING_RUNTIME')
            if _fingerprint(os.fstat(source.fileno())) != before: _fail('INPUT_CHANGED')
    except ApplianceError: raise
    except (tarfile.TarError,OSError,ValueError): _fail('ARCHIVE_UNSAFE')


def _kernel(path):
    source, _ = _open_checked(path,'UNAUTHORIZED_INPUT')
    with source: data=source.read(1024*1024+1)
    if len(data)>1024*1024: _fail('KERNEL_FEATURE')
    try: lines=data.decode('ascii').splitlines()
    except UnicodeError: _fail('KERNEL_FEATURE')
    for feature in FEATURES:
        declarations = [line for line in lines if line.startswith(feature+'=')
                        or re.fullmatch(r'#\s*'+re.escape(feature)+r'\s+is\s+not\s+set\s*', line.strip())]
        if declarations != [feature+'=y']: _fail('KERNEL_FEATURE')


@dataclass(frozen=True)
class _Captured:
    id: str
    path: Path
    identity_bytes: bytes
    fingerprint: tuple
    owner: object
    @property
    def identity(self): return json.loads(self.identity_bytes)


class _RetainedSource:
    """Original regular-file handle, retained independently of its pathname."""
    def __init__(self,path,identity,fingerprint):
        self.path=path; self.identity_bytes=json.dumps(identity,sort_keys=True,separators=(',',':')).encode()
        self.file,self.fingerprint=_open_checked(path,'INPUT_CHANGED')
        if self.fingerprint != fingerprint: self.file.close(); _fail('INPUT_CHANGED')
        self.recheck()
    def chunks(self):
        size=json.loads(self.identity_bytes)['sizeBytes']; offset=0
        while offset < size:
            data=os.pread(self.file.fileno(),min(1048576,size-offset),offset)
            if not data: _fail('INPUT_CHANGED')
            offset+=len(data); yield data
    def __del__(self):
        source=getattr(self,'file',None)
        if source is not None: source.close()
    def recheck(self):
        try:
            before=_fingerprint(os.fstat(self.file.fileno()))
            if before != self.fingerprint or _fingerprint(self.path.lstat()) != before: _fail('INPUT_CHANGED')
            digest=hashlib.sha256(); size=0
            for data in self.chunks(): digest.update(data); size+=len(data)
            identity=json.loads(self.identity_bytes)
            if digest.hexdigest()!=identity['sha256'] or size!=identity['sizeBytes']: _fail('INPUT_CHANGED')
            if _fingerprint(os.fstat(self.file.fileno()))!=before or _fingerprint(self.path.lstat())!=before: _fail('INPUT_CHANGED')
        except (OSError,ValueError): _fail('INPUT_CHANGED')
    def recheck_safe(self):
        self.recheck()
        if os.fstat(self.file.fileno()).st_mode & 0o7022: _fail('ARTIFACT_MISMATCH')


_INPUT_TOKEN = object()
@dataclass(frozen=True, init=False)
class ApprovedInputs:
    """Checked integrity snapshot; not operator, signer or runtime authority."""
    canonical: bytes
    captured: tuple
    tools: tuple
    def __init__(self, canonical, captured, tools, *, _token=None):
        if _token is not _INPUT_TOKEN: _fail('UNAUTHORIZED_INPUT')
        object.__setattr__(self,'canonical',canonical)
        object.__setattr__(self,'captured',captured)
        object.__setattr__(self,'tools',tools)


def validate_inputs(manifest: dict, *, locations: Mapping[str,Path], tool_locations: Mapping[str,Path], expected_inputs_digest: str) -> ApprovedInputs:
    canonical = canonical_manifest(manifest)
    if manifest['kind'] != 'ASSEMBLY_INPUTS' or manifest['manifestVersion'] != 2: _fail('INVALID_MANIFEST')
    if type(expected_inputs_digest) is not str or not re.fullmatch('[a-f0-9]{64}',expected_inputs_digest) or _sha(canonical) != expected_inputs_digest:
        _fail('IDENTITY_MISMATCH')
    if set(locations) != {x['id'] for x in manifest['artifacts']} or set(tool_locations) != {'mke2fs'}: _fail('UNAUTHORIZED_INPUT')
    groups=[]
    for identities, paths in [(manifest['artifacts'],locations),(manifest['tools'],tool_locations)]:
        captured=[]
        for identity in identities:
            id=identity['id']; path=_safe_path(paths[id])
            # Reject links separately from otherwise valid files with wrong bytes.
            handle, _ = _open_checked(path,'UNAUTHORIZED_INPUT'); handle.close()
            fingerprint=_hash_file(path,identity,'ARTIFACT_MISMATCH')
            if id in ARCHIVE_IDS: _archive(path,id)
            elif id in PAYLOAD_IDS:
                source, _ = _open_checked(path,'UNAUTHORIZED_INPUT')
                with source:
                    if os.fstat(source.fileno()).st_mode & 0o7022: _fail('UNAUTHORIZED_INPUT')
                    _reject_known_secret(source, identity['sizeBytes'])
                if id == 'browserWorker' and tarfile.is_tarfile(path): _fail('UNAUTHORIZED_INPUT')
            if id=='kernelConfig': _kernel(path)
            if _hash_file(path,identity,'INPUT_CHANGED') != fingerprint: _fail('INPUT_CHANGED')
            owner=_RetainedSource(path,identity,fingerprint)
            captured.append(_Captured(id,path,json.dumps(identity,sort_keys=True,separators=(',',':')).encode(),fingerprint,owner))
        groups.append(tuple(captured))
    return ApprovedInputs(canonical,*groups,_token=_INPUT_TOKEN)


@dataclass(frozen=True)
class ImageCommand:
    tool_path: Path
    tool_identity_bytes: bytes
    argv: tuple[str,...]
    population: Path
    output: Path
    snapshots: tuple[tuple[str,Path],...]
    @property
    def tool_identity(self): return json.loads(self.tool_identity_bytes)


class ImageToolRunner(Protocol):
    def run(self, command: ImageCommand) -> None: ...


def _unchanged(inputs):
    for item in (*inputs.captured,*inputs.tools):
        item.owner.recheck()
        if _hash_file(item.path,item.identity,'INPUT_CHANGED') != item.fingerprint: _fail('INPUT_CHANGED')


class _MemberSnapshot:
    """Private inert byte snapshot; no archive extraction or executable launch."""
    def __init__(self,chunks):
        self.file=tempfile.TemporaryFile(mode='w+b')
        digest=hashlib.sha256(); size=0
        try:
            for data in chunks:
                size+=len(data)
                if size > MAX_EXPANDED_BYTES: _fail('ARCHIVE_UNSAFE')
                self.file.write(data); digest.update(data)
            if size == 0: _fail('ARTIFACT_MISMATCH')
            self.file.flush(); self.size=size; self.digest=digest.hexdigest()
            self.fingerprint=_fingerprint(os.fstat(self.file.fileno()))
        except BaseException: self.file.close(); raise
    def __del__(self):
        source=getattr(self,'file',None)
        if source is not None: source.close()
    def recheck(self):
        try:
            before=_fingerprint(os.fstat(self.file.fileno()))
            if before != self.fingerprint: _fail('INPUT_CHANGED')
            offset=0; digest=hashlib.sha256()
            while offset < self.size:
                data=os.pread(self.file.fileno(),min(1048576,self.size-offset),offset)
                if not data: _fail('INPUT_CHANGED')
                offset+=len(data); digest.update(data)
            if digest.hexdigest()!=self.digest or _fingerprint(os.fstat(self.file.fileno()))!=before: _fail('INPUT_CHANGED')
        except (OSError,ValueError): _fail('INPUT_CHANGED')


_MEMBER_TOKEN=object()
@dataclass(frozen=True,init=False)
class ValidatedExecutableMembers:
    inputs: ApprovedInputs
    canonical: bytes
    snapshots: tuple
    def __init__(self,inputs,rows,snapshots,*,_token=None):
        if _token is not _MEMBER_TOKEN: _fail('UNAUTHORIZED_INPUT')
        object.__setattr__(self,'inputs',inputs)
        object.__setattr__(self,'canonical',json.dumps(rows,sort_keys=True,separators=(',',':')).encode())
        object.__setattr__(self,'snapshots',snapshots)
    @property
    def rows(self): return json.loads(self.canonical)
    def recheck(self):
        _unchanged(self.inputs)
        if len(self.snapshots)!=7: _fail('ARTIFACT_MISMATCH')
        for row,(component,member,path),snapshot in zip(self.rows,EXECUTABLE_MAPPING,self.snapshots):
            snapshot.recheck()
            artifact=next(item for item in self.inputs.captured if item.id==component).identity
            expected={'componentId':component,'artifactSHA256':artifact['sha256'],'memberPath':member,
                      'memberSHA256':snapshot.digest,'sizeBytes':snapshot.size,'installedPath':path}
            if row != expected: _fail('ARTIFACT_MISMATCH')
        _unchanged(self.inputs)


def derive_executable_members(inputs: ApprovedInputs) -> ValidatedExecutableMembers:
    if type(inputs) is not ApprovedInputs: _fail('UNAUTHORIZED_INPUT')
    manifest=decode_inputs(inputs.canonical)
    if manifest['manifestVersion']!=2: _fail('INVALID_MANIFEST')
    if manifest['payloadState']!='COMPLETE': _fail('PAYLOAD_INCOMPLETE')
    _unchanged(inputs); captured={item.id:item for item in inputs.captured}; rows=[]; snapshots=[]
    for component,member,path in EXECUTABLE_MAPPING:
        item=captured[component]; owner=item.owner; owner.recheck()
        if member:
            # Borrow the original retained artifact, rather than reopening a
            # possibly replaced path. tarfile yields inert member bytes only.
            with os.fdopen(os.dup(owner.file.fileno()),'rb') as source:
                source.seek(0)
                with tarfile.open(fileobj=source,mode='r:*') as tf:
                    candidates=[entry for entry in tf if entry.name==member]
                    if len(candidates)!=1: _fail('ARCHIVE_UNSAFE')
                    entry=candidates[0]
                    if not entry.isfile() or entry.mode & 0o7022 or not entry.mode & 0o111: _fail('ARCHIVE_UNSAFE')
                    with tf.extractfile(entry) as stream:
                        snapshot=_MemberSnapshot(iter(lambda:stream.read(1048576),b''))
                    if snapshot.size!=entry.size: _fail('ARTIFACT_MISMATCH')
        else: snapshot=_MemberSnapshot(owner.chunks())
        owner.recheck(); snapshots.append(snapshot)
        rows.append({'componentId':component,'artifactSHA256':item.identity['sha256'],'memberPath':member,
                     'memberSHA256':snapshot.digest,'sizeBytes':snapshot.size,'installedPath':path})
    result=ValidatedExecutableMembers(inputs,rows,tuple(snapshots),_token=_MEMBER_TOKEN)
    result.recheck(); return result


_POPULATION_TOKEN=object()
@dataclass(frozen=True,init=False)
class NativePopulationOwner:
    """Reserved trusted adapter result. No native adapter/factory exists here.

    A future approved adapter must retain the original base and seven installed
    regular-file owners, in exact immutable install order. A hash getter, wire
    record or caller mode flag cannot substitute for those originals.
    """
    members: ValidatedExecutableMembers
    manifest_bytes: bytes
    base: _RetainedSource
    installed: tuple
    def __init__(self,members,manifest,base,installed,*,_token=None):
        if _token is not _POPULATION_TOKEN: _fail('UNAUTHORIZED_INPUT')
        if type(members) is not ValidatedExecutableMembers or type(base) is not _RetainedSource: _fail('UNAUTHORIZED_INPUT')
        installed=tuple(installed)
        if len(installed)!=7 or any(type(source) is not _RetainedSource for _,source in installed): _fail('UNAUTHORIZED_INPUT')
        object.__setattr__(self,'members',members)
        object.__setattr__(self,'manifest_bytes',canonical_manifest(manifest))
        object.__setattr__(self,'base',base); object.__setattr__(self,'installed',installed)


_INVENTORY_TOKEN=object()
@dataclass(frozen=True,init=False)
class InstalledExecutableInventory:
    members: ValidatedExecutableMembers
    population_owner: NativePopulationOwner
    canonical: bytes
    def __init__(self,members,population_owner,canonical,*,_token=None):
        if _token is not _INVENTORY_TOKEN: _fail('UNAUTHORIZED_INPUT')
        object.__setattr__(self,'members',members); object.__setattr__(self,'population_owner',population_owner)
        object.__setattr__(self,'canonical',canonical)
    def recheck(self):
        manifest=decode_appliance(self.population_owner.manifest_bytes)
        verify_installed_members(self.members,self.population_owner,manifest['outputs'][0])


@dataclass(frozen=True,init=False)
class OfflineInstalledExecutableInventory:
    members: ValidatedExecutableMembers
    canonical: bytes
    def __init__(self,members,canonical,*,_token=None):
        if _token is not _INVENTORY_TOKEN: _fail('UNAUTHORIZED_INPUT')
        object.__setattr__(self,'members',members); object.__setattr__(self,'canonical',canonical)


def _inventory_document(members,manifest,state):
    inputs=decode_inputs(members.inputs.canonical)
    if manifest['manifestVersion']!=2 or manifest['inputsDigest']!=_sha(members.inputs.canonical): _fail('IDENTITY_MISMATCH')
    if manifest['components']!=inputs['artifacts']: _fail('ARTIFACT_MISMATCH')
    # Duplicated output facts must agree with the retained input owner; an
    # output digest cannot independently certify its own altered policy.
    for key in ['manifestVersion','architecture','distribution','policy','payloadState','missingPayload']:
        if manifest[key]!=inputs[key]: _fail('POLICY' if key=='policy' else 'IDENTITY_MISMATCH')
    for key in ['sourceRevision','approvalId','buildEnvironmentId']:
        if manifest['provenance'][key]!=inputs['provenance'][key]: _fail('IDENTITY_MISMATCH')
    if manifest['provenance']['tools']!=inputs['tools']: _fail('ARTIFACT_MISMATCH')
    # inputClass and assemblyMode intentionally belong to different stages.
    if state=='VERIFIED':
        if (inputs['provenance']['inputClass']!='APPROVED_CANDIDATE'
                or manifest['provenance']['assemblyMode']!='NATIVE_ARM64_LINUX'): _fail('SYNTHETIC_ONLY')
    elif manifest['provenance']['assemblyMode']!='SYNTHETIC': _fail('SYNTHETIC_ONLY')
    return json.dumps({'inventoryVersion':1,'inputsDigest':manifest['inputsDigest'],
                       'manifestDigest':manifest_digest(manifest),'baseIdentity':manifest['outputs'][0],
                       'populationState':state,'members':members.rows},sort_keys=True,separators=(',',':')).encode()


def offline_installed_members(members,manifest) -> OfflineInstalledExecutableInventory:
    if type(members) is not ValidatedExecutableMembers: _fail('UNAUTHORIZED_INPUT')
    manifest=decode_appliance(canonical_manifest(manifest)); members.recheck()
    canonical=_inventory_document(members,manifest,'UNPERFORMED'); members.recheck()
    return OfflineInstalledExecutableInventory(members,canonical,_token=_INVENTORY_TOKEN)


def verify_installed_members(members,population_owner,base_identity) -> InstalledExecutableInventory:
    if type(members) is not ValidatedExecutableMembers or type(population_owner) is not NativePopulationOwner: _fail('UNAUTHORIZED_INPUT')
    if population_owner.members is not members: _fail('IDENTITY_MISMATCH')
    members.recheck(); manifest=decode_appliance(population_owner.manifest_bytes)
    canonical=_inventory_document(members,manifest,'VERIFIED')
    if base_identity != manifest['outputs'][0] or json.loads(population_owner.base.identity_bytes)!=base_identity: _fail('IDENTITY_MISMATCH')
    population_owner.base.recheck_safe()
    for row,(path,source) in zip(members.rows,population_owner.installed):
        if path!=row['installedPath']: _fail('ARTIFACT_MISMATCH')
        identity=json.loads(source.identity_bytes)
        if identity['sha256']!=row['memberSHA256'] or identity['sizeBytes']!=row['sizeBytes']: _fail('ARTIFACT_MISMATCH')
        source.recheck_safe()
    # No identity changes during any source/base/installed consumption.
    members.recheck(); population_owner.base.recheck_safe()
    for _,source in population_owner.installed: source.recheck_safe()
    return InstalledExecutableInventory(members,population_owner,canonical,_token=_INVENTORY_TOKEN)


def _cleanup_owned(path, inode):
    try:
        s=path.lstat()
        if stat.S_ISDIR(s.st_mode) and (s.st_dev,s.st_ino)==inode: shutil.rmtree(path)
    except FileNotFoundError: pass


def _publish(partial, output, names):
    # Reserve final pathname exclusively; all bytes are validated before this.
    # manifest.json is linked last. Never replace another producer's destination.
    try: output.mkdir(mode=0o700)
    except FileExistsError: _fail('OUTPUT_EXISTS')
    s=output.lstat(); inode=(s.st_dev,s.st_ino)
    fd=os.open(output,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for name in names:
            os.link(partial/name,name,dst_dir_fd=fd,follow_symlinks=False)
        if (output.lstat().st_dev,output.lstat().st_ino)!=inode: _fail('OUTPUT_EXISTS')
    except BaseException:
        _cleanup_owned(output,inode)
        raise
    finally: os.close(fd)


def assemble(inputs: ApprovedInputs, output: Path, *, image_tool: ImageToolRunner) -> dict:
    if type(inputs) is not ApprovedInputs: _fail('UNAUTHORIZED_INPUT')
    manifest=decode_inputs(inputs.canonical)
    if os.path.lexists(output): _fail('OUTPUT_EXISTS')
    output=_safe_path(output)
    if image_tool is None or not callable(getattr(image_tool,'run',None)): _fail('TOOL_UNAVAILABLE')
    if manifest['provenance']['inputClass'] != 'SYNTHETIC': _fail('TOOL_UNAVAILABLE')
    if sum(x.identity['sizeBytes'] for x in (*inputs.captured,*inputs.tools))>MAX_SYNTHETIC_BYTES: _fail('UNAUTHORIZED_INPUT')
    _unchanged(inputs)
    if not output.parent.is_dir(): _fail('UNAUTHORIZED_INPUT')
    partial=Path(tempfile.mkdtemp(prefix='.'+output.name+'.partial-',dir=output.parent))
    s=partial.lstat(); inode=(s.st_dev,s.st_ino)
    try:
        staging=partial/'inputs'; staging.mkdir(mode=0o700)
        snapshots=[]
        for item in (*inputs.captured,*inputs.tools):
            path=staging/(item.id+'.synthetic')
            with path.open('xb') as f: _hash_file(item.path,item.identity,'INPUT_CHANGED',f)
            path.chmod(0o400); snapshots.append((item.id,path))
        paths=dict(snapshots); base=partial/'base.synthetic'
        population=partial/'population-unperformed'
        # This is the fixed future argv contract. The M3 fake receives only small
        # archive snapshots, never an extracted rootfs or a real image file.
        argv=(str(paths['mke2fs']),'-q','-t','ext4','-b','4096','-d',str(population),str(base),'262144')
        command=ImageCommand(paths['mke2fs'],inputs.tools[0].identity_bytes,argv,population,base,tuple(snapshots))
        try: image_tool.run(command)
        except ApplianceError: raise
        except Exception: _fail('TOOL_FAILURE')
        _unchanged(inputs)
        for item in (*inputs.captured,*inputs.tools):
            _hash_file(paths[item.id],item.identity,'INPUT_CHANGED')
        source,before=_open_checked(base,'ARTIFACT_MISMATCH')
        with source: data=source.read(MAX_SYNTHETIC_BYTES+1)
        if not data or len(data)>MAX_SYNTHETIC_BYTES or _fingerprint(base.lstat())!=before: _fail('ARTIFACT_MISMATCH')
        outputs=[{'id':'base','sha256':_sha(data),'sizeBytes':len(data),'version':'synthetic-v1','sourceId':'synthetic-assembly'}]
        by_id={x['id']:x for x in manifest['artifacts']}
        for id in ['initramfs','kernel']:
            with (partial/(id+'.synthetic')).open('xb') as f: _hash_file(paths[id],by_id[id],'INPUT_CHANGED',f)
            outputs.append(by_id[id])
        common={k:manifest[k] for k in ['manifestVersion','architecture','distribution','policy','payloadState','missingPayload']}
        provenance={k:manifest['provenance'][k] for k in ['sourceRevision','approvalId','buildEnvironmentId']}
        result={**common,'kind':'APPLIANCE_MANIFEST','inputsDigest':_sha(inputs.canonical),'components':manifest['artifacts'],'outputs':outputs,'provenance':{**provenance,'assemblyMode':'SYNTHETIC','tools':manifest['tools']},'manifestSigning':'UNPERFORMED','runtimeQualification':'UNPERFORMED'}
        encoded=canonical_manifest(result)
        proof={'inputsDigest':result['inputsDigest'],'manifestDigest':_sha(encoded),'components':manifest['artifacts'],'tools':manifest['tools'],'argv':list(argv),'assemblyMode':'SYNTHETIC','population':'UNPERFORMED'}
        with (partial/'manifest.json').open('xb') as f: f.write(encoded)
        with (partial/'provenance.json').open('xb') as f: f.write(json.dumps(proof,sort_keys=True,separators=(',',':')).encode())
        for item in outputs: _hash_file(partial/(item['id']+'.synthetic'),item,'ARTIFACT_MISMATCH')
        _publish(partial,output,['base.synthetic','initramfs.synthetic','kernel.synthetic','provenance.json','manifest.json'])
        return decode_appliance(encoded)
    except ApplianceError: raise
    except (OSError,ValueError): _fail('TOOL_FAILURE')
    finally: _cleanup_owned(partial,inode)


def require_qualified(manifest: dict):
    _validated(manifest)
    if manifest['manifestVersion'] != 2: _fail('INVALID_MANIFEST')
    if manifest['payloadState']=='INCOMPLETE': _fail('PAYLOAD_INCOMPLETE')
    if manifest['provenance'].get('assemblyMode')=='SYNTHETIC': _fail('SYNTHETIC_ONLY')
    _fail('SIGNING_UNAVAILABLE')


def cli(argv):
    """Future CLI syntax is reserved; no implicit real runner or input effects."""
    return 78


if __name__=='__main__':
    import sys
    sys.exit(cli(sys.argv[1:]))

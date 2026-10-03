"""Offline Task 8 confinement policy and trusted, injected bootstrap boundary.

The native adapter is selected only by trusted bootstrap-check embedding with
a caller-validated pinned guest runtime. Import and the default CLI do nothing
native. Offline tests inject inert bindings and never qualify a guest.
KernelPort is trusted process code; fake observations never qualify a guest.

Reference binding: corrected Linux 6.8 / glibc 2.39 / AAPCS64 map SHA256
7c8714c95a67d8a2e6c1b4c8b8481525a61976c81dfe2037c251add071ac9898;
manifest bb5fb8c47a329b8792f85a957d5674690b8aac59580a604fa405855e745e49d5.
This is the reviewed finite outer restriction policy, NOT Chromium's complete
syscall allowlist. Pointer targets (connect, clone3, recvmsg) are never inspected
by BPF. Fixed vsock destinations and authenticated no-donor IPC are separate
trusted contracts. Additional native compatibility and qualification are gated.
"""
from dataclasses import dataclass, field
import hashlib
import re
import struct
from types import MappingProxyType
from typing import NoReturn, Protocol


class ConfinementError(ValueError):
    """Finite error codes, no raw worker or kernel data."""


class RoleStartFailure(ConfinementError):
    """KernelPort returns ownership on child setup failure for bounded reaping."""
    def __init__(self, owned):
        super().__init__('ROLE_START_FAILED')
        self.owned = owned


def _fail(code): raise ConfinementError(code)
def _run(value): return type(value) is str and re.fullmatch('[0-9a-f]{32}', value) is not None
def _deadline(value):
    if type(value) is not int or not 0 < value <= 1200000: _fail('EXIT_DENIED')


@dataclass(frozen=True, slots=True)
class CompositionBinding:
    """Shared immutable wire identity; possession alone grants no authority."""
    version: int
    runId: str
    manifestDigest: str
    configIdentity: str
    rolePolicyDigest: str
    epoch: str
    expiresAtMs: int

    def __post_init__(self):
        if (type(self.version) is not int or self.version != 1
                or not _run(self.runId) or not _run(self.epoch)
                or any(type(v) is not str or re.fullmatch('[0-9a-f]{64}', v) is None
                       for v in (self.manifestDigest, self.configIdentity, self.rolePolicyDigest))
                or type(self.expiresAtMs) is not int or not 0 < self.expiresAtMs <= 9007199254740991):
            _fail('COMPOSITION_BINDING_DENIED')

    @classmethod
    def from_record(cls, value):
        if type(value) is not dict or set(value) != set(cls.__dataclass_fields__):
            _fail('COMPOSITION_BINDING_DENIED')
        return cls(**value)

    def to_record(self):
        return {name: getattr(self, name) for name in self.__dataclass_fields__}


@dataclass(frozen=True)
class ProgramPin:
    path: str
    sha256: str


@dataclass(frozen=True)
class Descriptor:
    fd: int
    kind: str
    purpose: str
    peer: str
    run_id: str


@dataclass(frozen=True)
class RoleViews:
    role: str
    root: str
    visible_roles: tuple
    private_mode: int = 0o700
    console: bool = False
    separate_pid: bool = True
    separate_mount: bool = True
    initial_user_namespace: bool = True
    controlling_tty: bool = False
    read_only_base: bool = True
    device_nodes: tuple = ('/dev/null',)
    private_tmpfs: bool = True
    no_external_ip_interface: bool = True
    no_fd_donor: bool = True


@dataclass(frozen=True)
class BootstrapConfig:
    kernel: object
    run_id: str
    programs: tuple


@dataclass(frozen=True)
class RoleConfig:
    bootstrap: BootstrapConfig
    fds: tuple
    argv: tuple = ()


_SEAL = object()


@dataclass(frozen=True)
class RoleLaunch:
    role: str
    run_id: str
    uid: int
    argv: tuple
    programs: tuple
    fds: tuple
    views: RoleViews
    filter: tuple
    _seal: object = field(default=None, repr=False, compare=False)


@dataclass(frozen=True)
class RoleAttestation:
    pid: int
    run_id: str
    role: str
    uids: tuple
    gids: tuple
    groups: tuple
    capabilities: tuple  # effective, permitted, inheritable, ambient, bounding
    no_new_privs: int
    seccomp: int
    filter_digest: str
    fds: tuple
    views: RoleViews
    waiting: bool
    programs: tuple


class KernelPort(Protocol):
    """Native and injected implementations must uphold these effect contracts.

    spawn_waiting owns the child's process identity before entry and returns
    only private inherited pipe capabilities. On failure it raises
    RoleStartFailure(owned); it never loses an unreaped child. entry runs on a
    single-threaded child-bound port. establish_views establishes separate
    PID/mount/proc/device views and role-only 0700 tmpfs before UID drop.
    close_unaudited_fds closes every nonlisted descriptor and audits endpoints,
    direction and CLOEXEC inheritance, not merely integer FD names.
    drop_credentials clears supplementary groups, ambient/bounding caps while
    privileged, then all real/effective/saved GIDs and UIDs; clear_capabilities
    clears/verifies all remaining capability sets in the initial user namespace.
    inspect_programs captures the actual read-only pinned executable/script
    identities. exec_pinned consumes those same verified handles/snapshots,
    with exact argv and empty environment, no pathname substitution or shell.
    The waiting browser worker may activate pinned Chromium only after the
    separate one-use confinement grant; no --no-sandbox/second spawn RPC.
    inspect independently observes credentials, caps, no_new_privs, filter,
    descriptor endpoints and views. A caller-supplied bool is not observation.
    wait/stop reap or stop only the exact owned process, never a recycled PID.
    Trusted intake/export is separately isolated controller-UID authority;
    none of these automation worker ports receives its serial capability.
    """
    def spawn_waiting(self, launch, entry): ...
    def inspect(self, pid): ...
    def wait_owned(self, owned, deadline): ...
    def stop_owned(self, owned, deadline): ...


UIDS = MappingProxyType({'CONTROLLER': 10001, 'BROWSER': 10002, 'VERIFIER': 10003, 'PROXY': 10004})
NODE = '/opt/acceptance/runtime/node/bin/node'
PYTHON = '/opt/acceptance/runtime/python/bin/python3'
CHROME = '/opt/acceptance/runtime/chromium/chrome'
ARGV = MappingProxyType({
    'CONTROLLER': (NODE, '/opt/acceptance/guest/controller.cjs', '--inherited'),
    'BROWSER': (NODE, '/opt/acceptance/guest/browser-worker.cjs', '--inherited'),
    'VERIFIER': (NODE, '/opt/acceptance/guest/verifier.cjs', '--inherited'),
    'PROXY': (PYTHON, '/opt/acceptance/guest/proxy.py', '--inherited'),
})
PROGRAM_PATHS = frozenset((NODE, PYTHON, CHROME, *(argv[1] for argv in ARGV.values())))


def role_fds(role, run_id):
    if role not in UIDS or not _run(run_id): _fail('ROLE_DENIED')
    peer = 'BOOTSTRAP' if role == 'CONTROLLER' else 'CONTROLLER'
    return tuple(Descriptor(fd, kind, purpose, peer, run_id) for fd, kind, purpose in (
        (0, 'null', 'stdin'), (1, 'null', 'stdout'), (2, 'null', 'stderr'),
        (3, 'pipe', 'command'), (4, 'pipe', 'result')))


def _programs(pins):
    if type(pins) is not tuple or len(pins) != len(PROGRAM_PATHS): _fail('PROGRAM_DENIED')
    if any(type(p) is not ProgramPin or type(p.path) is not str or type(p.sha256) is not str or
           re.fullmatch('[0-9a-f]{64}', p.sha256) is None for p in pins): _fail('PROGRAM_DENIED')
    if {p.path for p in pins} != PROGRAM_PATHS: _fail('PROGRAM_DENIED')
    return tuple(sorted(pins, key=lambda p: p.path))


def filter_bytes(program):
    """Pinned sock_filter layout: u16 code, u8 jt, u8 jf, u32 k, size8."""
    return b''.join(struct.pack('<HBBI', *i) for i in program)


def build_filter(role):
    """Deterministic, inspectable classic-BPF outer policy; no external generator.

    Loads match pinned little-endian seccomp_data nr0/arch4/args16; both words
    of every constrained scalar are checked. Only ALLOW, EPERM, KILL_PROCESS
    exits exist. No TRACE/USER_NOTIF or listener flags. New restriction filters
    can only tighten this one. No AF_NETLINK exception is selected.
    """
    if role not in UIDS: _fail('ROLE_DENIED')
    code, labels, jumps = [], {}, []
    def load(offset): code.append((0x20, 0, 0, offset))
    def ret(value): code.append((0x06, 0, 0, value))
    def label(name): labels[name] = len(code)
    def eq(value, yes=None, no=None):
        jumps.append((len(code), yes, no)); code.append((0x15, 0, 0, value))
    def require(value): eq(value, no='deny')
    load(4); eq(0xc00000b7, yes='native'); ret(0x80000000)
    label('native')
    load(0); code.append((0x54, 0, 0, 0xc0000000)); eq(0, yes='syscall'); ret(0x80000000)
    label('syscall'); load(0)
    # Linux 6.8 native arm64 syscall numbers: no compat/multiplexed ABI.
    for nr in (425, 426, 427, 117, 270, 271, 438, 434,
               91, 143, 144, 145, 146, 147, 149, 151, 152, 159,
               268, 33, 39, 40, 41, 51): eq(nr, yes='deny')
    eq(198, yes='socket'); eq(199, yes='socket'); eq(167, yes='prctl'); eq(277, yes='seccomp')
    ret(0x7fff0000)
    label('prctl')
    load(20); require(0); load(16)
    for option in (8, 28): eq(option, yes='deny')
    eq(38, yes='nnp'); eq(4, yes='dumpable'); eq(47, yes='ambient'); eq(22, yes='inner-filter')
    ret(0x7fff0000)
    label('nnp'); load(28); require(0); load(24); require(1); ret(0x7fff0000)
    label('dumpable'); load(28); require(0); load(24); require(0); ret(0x7fff0000)
    label('ambient'); load(28); require(0); load(24); eq(2, yes='deny'); ret(0x7fff0000)
    # Chromium may tighten its inherited policy via prctl or seccomp; only
    # filter mode and 0/TSYNC flags are allowed, never a NEW_LISTENER escape.
    label('inner-filter'); load(28); require(0); load(24); require(2); ret(0x7fff0000)
    label('seccomp'); load(20); require(0); load(16); require(1)
    load(28); require(0); load(24); eq(0, yes='allow'); eq(1, yes='allow'); ret(0x00050001)
    label('socket')
    for offset in (20, 28, 36): load(offset); require(0)
    load(16); eq(1, yes='unix'); eq(2, yes='ip'); eq(10, yes='ip')
    if role == 'PROXY': eq(40, yes='vsock')
    ret(0x00050001)
    label('unix'); load(32); require(0)
    load(24); code.append((0x54, 0, 0, 0xfff7f7ff))
    for kind in (1, 2, 5): eq(kind, yes='allow')
    ret(0x00050001)
    # Fail closed to the default protocol scalar 0. No unreviewed IPPROTO_*
    # constants are consumed. Explicit protocol compatibility remains gated.
    label('ip'); load(32); require(0)
    load(24); code.append((0x54, 0, 0, 0xfff7f7ff))
    eq(1, yes='allow'); eq(2, yes='allow'); ret(0x00050001)
    if role == 'PROXY':
        label('vsock'); load(0); require(198)
        load(24); code.append((0x54, 0, 0, 0xfff7f7ff)); require(1)
        load(32); require(0)
    label('allow'); ret(0x7fff0000)
    label('deny'); ret(0x00050001)
    for index, yes, no in jumps:
        instruction = code[index]
        jt = labels[yes]-index-1 if yes is not None else 0
        jf = labels[no]-index-1 if no is not None else 0
        if not (0 <= jt <= 255 and 0 <= jf <= 255): _fail('FILTER_INVALID')
        code[index] = (instruction[0], jt, jf, instruction[3])
    if len(code) > 4096: _fail('FILTER_INVALID')
    return tuple(code)


def proxy_endpoint():
    """Trusted proxy code must use this one endpoint; BPF cannot inspect sockaddr."""
    return (2, 4050)


def validate_channel_message(data, ancillary, flags):
    """Only bounded bytes on private role pipes; reject all ancillary/truncation.

    Actual fixed command decoding/authentication belongs to the consuming role.
    This never accepts a SCM_RIGHTS pretense or a generic FD donation message.
    """
    if type(data) is not bytes or not 0 < len(data) <= 4096 or type(ancillary) is not tuple or ancillary or type(flags) is not int or flags != 0:
        _fail('CHANNEL_DENIED')
    return data


def prepare_role(role, config):
    if type(config) is not RoleConfig or role not in UIDS: _fail('ROLE_DENIED')
    b = config.bootstrap
    if type(b) is not BootstrapConfig or not _run(b.run_id): _fail('ROLE_DENIED')
    pins = _programs(b.programs)
    if config.argv not in ((), ARGV[role]): _fail('PROGRAM_DENIED')
    if type(config.fds) is not tuple or any(type(d) is not Descriptor or type(d.fd) is not int for d in config.fds) or config.fds != role_fds(role, b.run_id): _fail('FD_DENIED')
    return RoleLaunch(role, b.run_id, UIDS[role], ARGV[role], pins, config.fds,
                      RoleViews(role, '/run/acceptance/'+role.lower(), (role,)), build_filter(role), _SEAL)


def _attestation(facts):
    try:
        if type(facts) is not dict: _fail('ATTESTATION_FAILED')
        a = RoleAttestation(**facts)
        if type(a.pid) is not int or a.pid <= 0 or not _run(a.run_id) or a.role not in UIDS: _fail('ATTESTATION_FAILED')
        for vector in (a.uids, a.gids, a.groups, a.capabilities):
            if type(vector) is not tuple or any(type(x) is not int or x < 0 for x in vector): _fail('ATTESTATION_FAILED')
        if len(a.uids) != 3 or len(a.gids) != 3 or len(a.capabilities) != 5: _fail('ATTESTATION_FAILED')
        if type(a.no_new_privs) is not int or type(a.seccomp) is not int or type(a.waiting) is not bool: _fail('ATTESTATION_FAILED')
        if type(a.fds) is not tuple or any(type(d) is not Descriptor or type(d.fd) is not int for d in a.fds) or type(a.views) is not RoleViews or type(a.filter_digest) is not str: _fail('ATTESTATION_FAILED')
        if any(type(getattr(a.views,n)) is not bool for n in ('console','separate_pid','separate_mount','initial_user_namespace','controlling_tty','read_only_base','private_tmpfs','no_external_ip_interface','no_fd_donor')): _fail('ATTESTATION_FAILED')
        if type(a.views.private_mode) is not int or type(a.views.visible_roles) is not tuple or type(a.views.device_nodes) is not tuple: _fail('ATTESTATION_FAILED')
        _programs(a.programs)
        return a
    except (TypeError, ValueError, AttributeError): _fail('ATTESTATION_FAILED')


def _check(a, launch, *, waiting):
    if (a.run_id != launch.run_id or a.role != launch.role or a.uids != (launch.uid,)*3 or
        a.gids != (launch.uid,)*3 or a.groups != () or a.capabilities != (0,)*5 or
        a.no_new_privs != 1 or a.seccomp != 2 or a.filter_digest != hashlib.sha256(filter_bytes(launch.filter)).hexdigest() or
        a.fds != launch.fds or a.views != launch.views or a.waiting is not waiting or _programs(a.programs) != launch.programs):
        _fail('ATTESTATION_FAILED')


def exec_role(launch, *, kernel) -> NoReturn:
    if type(launch) is not RoleLaunch or launch._seal is not _SEAL: _fail('ROLE_DENIED')
    # Recompute immutable launch contract to reject fabricated/replaced records.
    expected = prepare_role(launch.role, RoleConfig(BootstrapConfig(kernel,launch.run_id,launch.programs), launch.fds))
    if launch != expected: _fail('ROLE_DENIED')
    try:
        kernel.establish_views(launch.views)
        kernel.close_unaudited_fds(launch.fds)
        kernel.drop_credentials(launch.uid, launch.uid)
        kernel.clear_capabilities()
        kernel.no_new_privs()
        # TSYNC return must be the integer zero, not bool or unsynchronized TID.
        result = kernel.install_seccomp(launch.filter, 1)
        if type(result) is not int or result != 0: _fail('TSYNC_FAILED')
        if _programs(kernel.inspect_programs()) != launch.programs: _fail('PROGRAM_DENIED')
        _check(_attestation(kernel.inspect()), launch, waiting=False)
        kernel.exec_pinned(launch.argv, launch.programs)
    except ConfinementError: raise
    except Exception: _fail('ROLE_START_FAILED')
    _fail('EXEC_RETURNED')


def inspect_role(pid, *, kernel):
    if type(pid) is not int or pid <= 0: _fail('ATTESTATION_FAILED')
    try:
        a = _attestation(kernel.inspect(pid))
        if a.pid != pid: _fail('ATTESTATION_FAILED')
        return a
    except Exception: _fail('ATTESTATION_FAILED')


@dataclass(frozen=True)
class RoleHandoff:
    """Private nominal owned-child record, not serializable runtime approval."""
    launch: RoleLaunch
    attestation: RoleAttestation
    _kernel: object = field(repr=False)
    _owned: object = field(repr=False)
    def _exit(self, operation, deadline):
        _deadline(deadline)
        try:
            # Cleanup authority is the original nominal owned-child token, not
            # mutable confinement observations (nor a post-exit /proc entry).
            result = operation(self._owned, deadline)
            if type(result) is not dict or set(result) != {'status','pid','run_id'} or result['status'] not in ('EXITED','STOPPED','TIMEOUT') or type(result['pid']) is not int or result['pid'] != self.attestation.pid or result['run_id'] != self.launch.run_id:
                _fail('EXIT_DENIED')
            return MappingProxyType(dict(result))
        except Exception: _fail('EXIT_DENIED')
    def wait_exit(self, deadline): return self._exit(self._kernel.wait_owned, deadline)
    def stop_owned(self, deadline): return self._exit(self._kernel.stop_owned, deadline)


def _endpoint_key(endpoint):
    return ('fd',endpoint) if type(endpoint) is int else ('object',id(endpoint))


def _ownership_facts(owned):
    return (owned.pid,owned.run_id,owned.role,id(getattr(owned,'identity',owned)),
            _endpoint_key(owned.command),_endpoint_key(owned.result))


def start_roles(config):
    if type(config) is not BootstrapConfig or config.kernel is None: _fail('KERNEL_PORT_REQUIRED')
    k = config.kernel
    if any(not callable(getattr(k,n,None)) for n in ('spawn_waiting','inspect','wait_owned','stop_owned')): _fail('KERNEL_PORT_REQUIRED')
    # Validate the entire fixed four-role launch plan before the first effect.
    launches = tuple(prepare_role(role,RoleConfig(config,role_fds(role,config.run_id))) for role in UIDS)
    owned_children, handoffs, ownership = [], {}, {}
    pids, identities, endpoints = set(), set(), set()
    try:
        for launch in launches:
            try:
                owned = k.spawn_waiting(launch, lambda port, launch=launch: exec_role(launch,kernel=port))
            except RoleStartFailure as error:
                owned_children.append(error.owned)
                raise
            owned_children.append(owned)
            identity = getattr(owned, 'identity', owned)
            if (type(owned.pid) is not int or owned.pid <= 0 or owned.pid in pids or
                id(identity) in identities or owned.command is None or owned.result is None or
                _endpoint_key(owned.command)==_endpoint_key(owned.result) or _endpoint_key(owned.command) in endpoints or _endpoint_key(owned.result) in endpoints):
                _fail('HANDOFF_DENIED')
            pids.add(owned.pid); identities.add(id(identity))
            endpoints.update((_endpoint_key(owned.command),_endpoint_key(owned.result)))
            # Retain original endpoint/identity objects as well as their keys:
            # object-id reuse cannot turn late mutation into a false collision.
            ownership[id(owned)]=(_ownership_facts(owned),getattr(owned,'identity',owned),owned.command,owned.result)
            a = inspect_role(owned.pid,kernel=k)
            if owned.run_id != launch.run_id or owned.role != launch.role or owned.command is owned.result or owned.command is None or owned.result is None: _fail('HANDOFF_DENIED')
            _check(a,launch,waiting=True)
            handoffs[launch.role] = RoleHandoff(launch,a,k,owned)
        # Recheck the complete inventory before publishing any private handle.
        for handoff in handoffs.values():
            if _ownership_facts(handoff._owned)!=ownership[id(handoff._owned)][0]: _fail('HANDOFF_DENIED')
            _check(inspect_role(handoff.attestation.pid,kernel=k),handoff.launch,waiting=True)
    except Exception:
        cleanup_failed = False
        cleaned, cleanup_pids, distinct = set(), set(), []
        for owned in owned_children:
            # Duplicate records are never a reason to signal the same child
            # twice. A contradictory PID/identity inventory is uncertain.
            # Claimed process identities may contradict each other. Distinct
            # nominal ownership tokens with distinct PIDs still require their
            # own authenticated stop receipt; never silently abandon either.
            key = id(owned)
            if key in cleaned or getattr(owned, 'pid', None) in cleanup_pids:
                cleanup_failed = True
                continue
            cleaned.add(key)
            cleanup_pids.add(getattr(owned, 'pid', None))
            distinct.append(owned)
        for owned in reversed(distinct):
            try:
                result = k.stop_owned(owned,120000)
                if type(result) is not dict or result.get('status') not in ('STOPPED','EXITED') or result.get('pid') != owned.pid or result.get('run_id') != config.run_id: cleanup_failed = True
            except Exception: cleanup_failed = True
        _fail('REAP_UNCERTAIN' if cleanup_failed else 'BOOTSTRAP_FAILED')
    return MappingProxyType(handoffs)


@dataclass
class NativeMemory:
    """Explicit reviewed Linux LP64 bytes; pointer relocation is not host layout."""
    data: bytearray
    pointers: dict = field(default_factory=dict)


@dataclass(frozen=True, eq=False)
class NativeOwned:
    pid: int
    run_id: str
    role: str
    command: object
    result: object
    identity: object = field(default_factory=object)


_NATIVE_SEAL=object()


@dataclass(frozen=True)
class GuestRuntimeIdentity:
    python: ProgramPin
    libc: ProgramPin
    image_sha256: str
    coverage_sha256: str = '7c8714c95a67d8a2e6c1b4c8b8481525a61976c81dfe2037c251add071ac9898'


@dataclass(frozen=True)
class _ValidatedRuntime:
    identity: object
    seal: object


def select_native_kernel(mode, *, runtime_identity, validate_runtime, bindings_factory=None):
    """No ambient env/CLI boolean grants native authority. The trusted caller
    must validate its pinned image/Python/libc/runtime identity and return that
    same nominal identity. A missing/failed validation precedes ALL effects.
    Injecting a factory is only a unit boundary, never qualification evidence.
    """
    if (mode != 'bootstrap-check' or type(runtime_identity) is not GuestRuntimeIdentity or
        type(runtime_identity.python) is not ProgramPin or runtime_identity.python.path!=PYTHON or
        type(runtime_identity.libc) is not ProgramPin or runtime_identity.libc.path not in
            ('/lib/aarch64-linux-gnu/libc.so.6','/usr/lib/aarch64-linux-gnu/libc.so.6') or
        any(type(v) is not str or re.fullmatch('[0-9a-f]{64}',v) is None for v in
            (runtime_identity.python.sha256,runtime_identity.libc.sha256,runtime_identity.image_sha256)) or
        runtime_identity.coverage_sha256!='7c8714c95a67d8a2e6c1b4c8b8481525a61976c81dfe2037c251add071ac9898' or
        not callable(validate_runtime)):
        _fail('NATIVE_GATE_DENIED')
    try:
        if validate_runtime(runtime_identity) is not runtime_identity: _fail('NATIVE_GATE_DENIED')
    except Exception: _fail('NATIVE_GATE_DENIED')
    return NativeKernelPort((bindings_factory or LinuxBindings)(_ValidatedRuntime(runtime_identity,_NATIVE_SEAL)))


def _native_apis(os_api,signal_api,resource_api):
    names=('fork','execve','pipe2','waitpid','waitstatus_to_exitcode','setsid','kill','open','read','write','close','dup2','dup',
           'set_inheritable','set_blocking','readlink','listdir','stat','fstat','makedirs','chown',
           'chroot','chdir','getpid','getppid','rmdir','unlink','_exit')
    if (any(not callable(getattr(os_api,name,None)) for name in names) or
        not hasattr(os_api,'WNOHANG') or not hasattr(signal_api,'SIGKILL') or
        not callable(getattr(getattr(os_api,'path',None),'isfile',None)) or
        not callable(getattr(getattr(os_api,'path',None),'lexists',None)) or
        any(not hasattr(resource_api,name) for name in ('RLIMIT_CORE','RLIMIT_NOFILE')) or
        not callable(getattr(resource_api,'setrlimit',None))): _fail('NATIVE_API_UNAVAILABLE')


class LinuxBindings:
    """Explicit Linux-only stdlib backend. Never constructed on import.

    Runtime identity validation belongs to the trusted native selector above;
    wrappers/errno/libffi behavior still require actual guest qualification.
    All numbers below are from the corrected reference, NOT Darwin constants.
    waitpid/kill/resource are selected by NAME only, as ruled by the owner.
    """
    def __init__(self, runtime_identity):
        import sys
        if (type(runtime_identity) is not _ValidatedRuntime or runtime_identity.seal is not _NATIVE_SEAL or
            sys.platform != 'linux'): _fail('NATIVE_GATE_DENIED')
        import os, signal, resource, time, select, ctypes
        if (os.uname().machine != 'aarch64' or sys.byteorder != 'little' or
            sys.executable != PYTHON or ctypes.sizeof(ctypes.c_long) != 8 or
            ctypes.sizeof(ctypes.c_void_p) != 8): _fail('NATIVE_GATE_DENIED')
        _native_apis(os,signal,resource)
        self.os, self.signal, self.resource = os, signal, resource
        self.monotonic, self.sleep, self.select = time.monotonic, time.sleep, select.select
        self._ctypes=ctypes
        self._runtime=runtime_identity
        # Hash actual guest interpreter and libc before native loading. The
        # immutable-image authority validates the remaining runtime/libffi.
        for pin in (runtime_identity.identity.python,runtime_identity.identity.libc):
            data=self.read_file(pin.path,1073741824)
            if hashlib.sha256(data).hexdigest()!=pin.sha256: _fail('NATIVE_RUNTIME_MISMATCH')
        self._libc=ctypes.CDLL(runtime_identity.identity.libc.path,use_errno=True)
        self._libc.syscall.restype=ctypes.c_long
        self._libc.syscall.argtypes=[ctypes.c_long]

    def syscall(self, nr, *args):
        # Keep relocated buffers alive until the call returns, including nested
        # fprog -> sock_filter. Explicit pointers/offsets are reviewed LP64.
        ct=self._ctypes; keep=[]
        def marshal(value):
            if type(value) is NativeMemory:
                data=bytearray(value.data)
                for offset,target in value.pointers.items():
                    if type(offset) is not int or offset < 0 or offset+8 > len(data): _fail('ABI_DENIED')
                    pointer=marshal(target)
                    struct.pack_into('<Q',data,offset,pointer.value)
                buf=ct.create_string_buffer(bytes(data),len(data)); keep.append((buf,value))
                return ct.c_void_p(ct.addressof(buf))
            if type(value) is bytearray: return marshal(NativeMemory(value))
            if type(value) is bytes:
                buf=ct.create_string_buffer(value); keep.append((buf,None)); return ct.c_void_p(ct.addressof(buf))
            if value is None: return ct.c_void_p(0)
            if type(value) is not int or not -(1<<63) <= value < (1<<64): _fail('ABI_DENIED')
            return ct.c_ulong(value & ((1<<64)-1))
        if type(nr) is not int or len(args)>6: _fail('ABI_DENIED')
        ct.set_errno(0)
        result=self._libc.syscall(ct.c_long(nr),*(marshal(a) for a in args))
        for buf,target in keep:
            if target is not None: target.data[:]=buf.raw
        if result == -1: raise OSError(ct.get_errno(),'NATIVE_OPERATION_FAILED')
        return int(result)

    def read_file(self,path,limit=65536):
        fd=self.os.open(path,524288|32768)
        try:
            out=bytearray()
            while len(out)<=limit:
                part=self.os.read(fd,min(65536,limit+1-len(out)))
                if not part: return bytes(out)
                out.extend(part)
            _fail('OBSERVATION_LIMIT')
        finally: self.os.close(fd)

    def check_appliance(self):
        # This observation is in addition to, not a substitute for the pinned
        # hypervisor device-list/image authority supplied at selection.
        mounts=self.read_file('/proc/self/mountinfo').decode('ascii').splitlines()
        parsed=[(r.split(' - ')[0].split(),r.split(' - ')[1].split()) for r in mounts]
        if (not any(a[4]=='/' and 'ro' in a[5].split(',') for a,b in parsed) or
            not any(a[4]=='/run' and b[0]=='tmpfs' for a,b in parsed) or
            len(self.read_file('/proc/swaps').splitlines()) != 1 or
            set(self.os.listdir('/sys/class/net')) != {'lo'}): _fail('APPLIANCE_DENIED')
        self.run_device=self.os.stat('/run').st_dev
        self.initial_namespaces={name:self.os.readlink('/proc/self/ns/'+name) for name in ('pid','mnt','user')}

    def pin_programs(self,pins):
        fds={}
        try:
            for pin in _programs(pins):
                original=self.os.open(pin.path,524288|32768)
                try: fd=self.syscall(25,original,1030,64) # F_DUPFD_CLOEXEC above audited FD0..4
                finally: self.os.close(original)
                fds[pin.path]=fd
                before=self.os.fstat(fd)
                if not self.os.path.isfile('/proc/self/fd/'+str(fd)) or before.st_mode & 0o022 or before.st_size>1073741824:
                    _fail('PROGRAM_DENIED')
                digest=hashlib.sha256(); total=0
                while total<=1073741824:
                    data=self.os.read(fd,65536)
                    if not data: break
                    total+=len(data); digest.update(data)
                after=self.os.fstat(fd)
                if (total>1073741824 or digest.hexdigest()!=pin.sha256 or
                    (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=
                    (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)):
                    _fail('PROGRAM_DENIED')
            return fds
        except BaseException:
            for fd in fds.values(): self.os.close(fd)
            raise

    def pin_sample(self,path,digest):
        # Probe-only caller first checks a finite sample path and its separately
        # approved immutable-image pin. This API is never a worker spawn RPC.
        fd=self.os.open(path,524288|32768)
        try:
            before=self.os.fstat(fd)
            if not self.os.path.isfile('/proc/self/fd/'+str(fd)) or before.st_mode&0o022 or before.st_size>1073741824: _fail('PROGRAM_DENIED')
            h=hashlib.sha256(); total=0
            while total<=1073741824:
                part=self.os.read(fd,65536)
                if not part: break
                total+=len(part); h.update(part)
            after=self.os.fstat(fd)
            if total>1073741824 or h.hexdigest()!=digest or (before.st_dev,before.st_ino)!=(after.st_dev,after.st_ino): _fail('PROGRAM_DENIED')
            high=self.syscall(25,fd,1030,64)
            return high
        finally: self.os.close(fd)


class NativeChildPort:
    """Single-threaded, child-only effect port. No public later spawn/UID RPC."""
    def __init__(self, bindings, launch, pins, ready_fd=None):
        self.b,self.launch,self.pins,self.ready_fd=bindings,launch,pins,ready_fd
        self.digest=None

    def establish_views(self,views):
        if views != self.launch.views: _fail('VIEW_DENIED')
        b=self.b; root=views.root+'/.root'
        b.os.setsid() # detach inherited controlling terminal before any worker
        b.syscall(40,None,b'/',None,262144|16384,None) # recursive private propagation
        b.os.makedirs(root,mode=0o755,exist_ok=False)
        # Read-only base is never copied to a writable overlay. Role mutable
        # state remains on the already bounded guest-private /run tmpfs.
        for directory in ('opt','usr','lib','lib64','etc'):
            target=root+'/'+directory; b.os.makedirs(target,mode=0o755,exist_ok=False)
            b.syscall(40,('/'+directory).encode(),target.encode(),None,4096,None)
            b.syscall(40,None,target.encode(),None,4096|32|1,None)
        state=views.root+'/.state'
        b.os.makedirs(state,mode=0o700,exist_ok=False); b.os.chown(state,self.launch.uid,self.launch.uid)
        for directory in ('tmp','var','run/acceptance/'+views.role.lower(),'dev/shm'):
            source=state+'/'+directory; target=root+'/'+directory
            b.os.makedirs(source,mode=0o700,exist_ok=False); b.os.chown(source,self.launch.uid,self.launch.uid)
            b.os.makedirs(target,mode=0o755,exist_ok=True)
            b.syscall(40,source.encode(),target.encode(),None,4096,None)
        b.os.makedirs(root+'/proc',mode=0o755,exist_ok=False)
        null=b.os.open(root+'/dev/null',64|128|524288|32768,0o600); b.os.close(null)
        b.syscall(40,b'/dev/null',(root+'/dev/null').encode(),None,4096,None)
        b.os.chroot(root); b.os.chdir('/')
        b.syscall(40,b'proc',b'/proc',b'proc',2|4|8,None)
        b.resource.setrlimit(b.resource.RLIMIT_CORE,(0,0))
        b.resource.setrlimit(b.resource.RLIMIT_NOFILE,(4096,4096))

    def close_unaudited_fds(self,fds):
        if fds != self.launch.fds: _fail('FD_DENIED')
        retained=set(self.pins.values())
        if self.ready_fd is not None: retained.add(self.ready_fd)
        if any(type(fd) is not int or fd<5 for fd in retained): _fail('FD_DENIED')
        first=5
        for fd in sorted(retained):
            if first<fd: self.b.syscall(436,first,fd-1,0)
            self.b.os.set_inheritable(fd,False); first=fd+1
        self.b.syscall(436,first,4294967295,0)
        for fd in range(5): self.b.os.set_inheritable(fd,True)

    def drop_credentials(self,uid,gid):
        if uid!=self.launch.uid or gid!=uid: _fail('UID_DENIED')
        self.b.syscall(159,0,0)
        self.b.syscall(167,47,4,0,0,0)
        for cap in range(41): self.b.syscall(167,24,cap,0,0,0)
        self.b.syscall(149,gid,gid,gid); self.b.syscall(147,uid,uid,uid)

    def clear_capabilities(self):
        self.b.syscall(91,NativeMemory(bytearray(struct.pack('<II',0x20080522,0))),NativeMemory(bytearray(24)))

    def no_new_privs(self): self.b.syscall(167,38,1,0,0,0)

    def install_seccomp(self,program,flags):
        if flags!=1 or not 0<len(program)<=4096: _fail('TSYNC_FAILED')
        instructions=NativeMemory(bytearray(filter_bytes(program)))
        header=NativeMemory(bytearray(struct.pack('<H6xQ',len(program),0)),{8:instructions})
        result=self.b.syscall(277,1,flags,header)
        if type(result) is int and result==0: self.digest=hashlib.sha256(filter_bytes(program)).hexdigest()
        return result

    def inspect_programs(self):
        verified=self.b.pin_programs(self.launch.programs)
        try:
            for path,fd in verified.items():
                if self.b.os.fstat(fd).st_ino != self.b.os.fstat(self.pins[path]).st_ino: _fail('PROGRAM_DENIED')
        finally:
            for fd in verified.values(): self.b.os.close(fd)
        return self.launch.programs

    def inspect(self):
        return _native_observe(self.b,self.b.os.getpid(),self.launch,self.digest,self.pins,False,local=True)

    def exec_pinned(self,argv,programs):
        if argv!=self.launch.argv or programs!=self.launch.programs or argv[0] not in self.pins: _fail('PROGRAM_DENIED')
        if self.ready_fd is not None:
            frame=self.digest.encode('ascii')
            if self.b.os.write(self.ready_fd,frame)!=64: _fail('ROLE_START_FAILED')
        # Executable is the same held verified FD; script path is on the pinned
        # read-only base, rechecked immediately before exec. No shell/environment.
        self.b.os.execve(self.pins[argv[0]],argv,{})
        _fail('EXEC_RETURNED')


def _native_observe(b,pid,launch,digest,pins,waiting,local=False):
    """Read kernel facts, never a self-authored `confined: true` receipt."""
    base='/proc/'+str(pid)
    fields={}
    for line in b.read_file(base+'/status').decode('ascii').splitlines():
        key,_,value=line.partition(':'); fields[key]=value.strip()
    uid=tuple(map(int,fields['Uid'].split()[:3])); gid=tuple(map(int,fields['Gid'].split()[:3]))
    caps=tuple(int(fields[k],16) for k in ('CapEff','CapPrm','CapInh','CapAmb','CapBnd'))
    listed=set(b.os.listdir(base+'/fd'))
    expected={str(fd) for fd in range(5)}
    if local:
        expected.update(str(fd) for fd in pins.values())
        # Reading /proc/fd transiently opens an observer FD; listdir closes it.
        listed={fd for fd in listed if _native_fd_exists(b,base,fd)}
        if not expected<=listed or len(listed-expected)>1: _fail('FD_DENIED')
    elif listed!=expected: _fail('FD_DENIED')
    for fd in (0,1,2):
        if b.os.readlink(base+'/fd/'+str(fd))!='/dev/null': _fail('FD_DENIED')
    links=[b.os.readlink(base+'/fd/'+str(fd)) for fd in (3,4)]
    if any(not re.fullmatch(r'pipe:\[\d+\]',x) for x in links) or links[0]==links[1]: _fail('FD_DENIED')
    # Direction is independently observed from Linux fdinfo flags.
    for fd,direction in ((3,0),(4,1)):
        info=b.read_file(base+'/fdinfo/'+str(fd)).decode('ascii')
        flags=int(next(x.split()[1] for x in info.splitlines() if x.startswith('flags:')),8)
        if flags&3!=direction: _fail('FD_DENIED')
    if not local:
        if b.read_file(base+'/cmdline',4096).split(b'\0')[:-1] != [a.encode() for a in launch.argv]: _fail('PROGRAM_DENIED')
        for namespace in ('pid','mnt'):
            if b.os.readlink(base+'/ns/'+namespace)==b.os.readlink('/proc/self/ns/'+namespace): _fail('VIEW_DENIED')
        if b.os.readlink(base+'/ns/user')!=b.os.readlink('/proc/self/ns/user'): _fail('VIEW_DENIED')
        if b.os.stat(base+'/root').st_ino!=b.os.stat(launch.views.root+'/.root').st_ino: _fail('VIEW_DENIED')
    devices=set(b.os.listdir(('/' if local else base+'/root/')+'dev'))
    if devices!={'null','shm'}: _fail('VIEW_DENIED')
    prefix='' if local else base+'/root'
    mounts={}
    for line in b.read_file(base+'/mountinfo').decode('ascii').splitlines():
        left,right=line.split(' - ',1); mount_fields=left.split(); mounts[mount_fields[4]]=(set(mount_fields[5].split(',')),right.split()[0])
    if any('ro' not in mounts.get('/'+directory,(set(),None))[0] for directory in ('opt','usr','lib','lib64','etc')): _fail('VIEW_DENIED')
    for path in ('/tmp','/var','/run/acceptance/'+launch.role.lower(),'/dev/shm'):
        if mounts.get(path,(None,None))[1]!='tmpfs': _fail('VIEW_DENIED')
        metadata=b.os.stat(prefix+path)
        if (metadata.st_mode&0o777!=0o700 or metadata.st_uid!=launch.uid or metadata.st_gid!=launch.uid or
            metadata.st_dev!=getattr(b,'run_device',None)): _fail('VIEW_DENIED')
    if set(b.os.listdir(prefix+'/run/acceptance'))!={launch.role.lower()}: _fail('VIEW_DENIED')
    if local:
        initial=getattr(b,'initial_namespaces',{})
        if (any(b.os.readlink('/proc/self/ns/'+name)==initial.get(name) for name in ('pid','mnt')) or
            b.os.readlink('/proc/self/ns/user')!=initial.get('user')): _fail('VIEW_DENIED')
    if digest is None: _fail('ATTESTATION_FAILED')
    return dict(pid=pid,run_id=launch.run_id,role=launch.role,uids=uid,gids=gid,
        groups=tuple(map(int,fields['Groups'].split())),capabilities=caps,
        no_new_privs=int(fields['NoNewPrivs']),seccomp=int(fields['Seccomp']),filter_digest=digest,
        fds=launch.fds,views=launch.views,waiting=waiting,programs=launch.programs)


def _native_fd_exists(b,base,fd):
    try: b.os.readlink(base+'/fd/'+fd); return True
    except FileNotFoundError: return False


class NativeKernelPort:
    """Root bootstrap parent + fixed per-role direct-parent reaper.

    The helper owns its unreaped inner child in the new PID namespace. A STOP
    frame has no PID/argv fields; only that direct child can be signalled. Parent
    waits only its original unreaped helper; terminal receipts are cached. Lost
    helper/control channel is cleanup uncertainty, never arbitrary kill fallback.
    """
    def __init__(self,bindings): self.b,self._owned=bindings,{}

    def spawn_waiting(self,launch,entry):
        if type(launch) is not RoleLaunch or launch._seal is not _SEAL: _fail('ROLE_DENIED')
        runtime=getattr(self.b,'_runtime',None)
        if runtime is not None and runtime.identity.python not in launch.programs: _fail('NATIVE_RUNTIME_MISMATCH')
        b=self.b; b.check_appliance(); pins=b.pin_programs(launch.programs)
        pairs=[]; outer=None; owned=None
        try:
            for _ in range(4): pairs.append(b.os.pipe2(524288))
            command,result,stop,ready=pairs
            outer=b.os.fork()
            if outer==0:
                inner=None; reaped=False; kill_sent=False; outcome=78
                def reap_inner():
                    # Only the original unreaped DIRECT child captured by fork.
                    # No supplied PID or post-reap signal; named APIs only.
                    nonlocal inner,reaped,kill_sent
                    if reaped: return True
                    if inner is None or inner<=0: return False
                    try:
                        if not kill_sent:
                            kill_sent=True
                            try: b.os.kill(inner,b.signal.SIGKILL)
                            except BaseException: pass # still attempt actual wait proof
                        until=b.monotonic()+2
                        while b.monotonic()<until:
                            try: pid,status=b.os.waitpid(inner,b.os.WNOHANG)
                            except ChildProcessError:
                                inner=None # lost ownership: never signal again
                                return False
                            if pid==inner:
                                reaped=True; return True
                            if pid!=0:
                                inner=None; return False
                            b.sleep(min(0.01,max(0,until-b.monotonic())))
                    except BaseException: return False
                    return False
                try:
                    # Namespace creation happens only in the private trusted
                    # helper, never changes the bootstrap parent's namespaces.
                    b.syscall(97,131072|536870912|134217728)
                    inner=b.os.fork()
                    if inner==0:
                        null=b.os.open('/dev/null',2|524288|32768)
                        # Relocate source endpoints before dup2 (avoid clobber
                        # when bootstrap originally had only FD0..2).
                        sources=(null,null,null,command[0],result[1])
                        temporary=[b.os.dup(fd) for fd in sources]
                        for fd,source in enumerate(temporary): b.os.dup2(source,fd,inheritable=True)
                        for fd in temporary: b.os.close(fd)
                        entry(NativeChildPort(b,launch,pins,ready[1]))
                        b.os._exit(78)
                    retained={stop[0],ready[1]}
                    for fd in pins.values(): b.os.close(fd)
                    for fd in range(0,4096):
                        if fd not in retained:
                            try: b.os.close(fd)
                            except OSError: pass
                    b.os.set_blocking(stop[0],False)
                    # Helpers never accept generic RPCs, reap only their direct
                    # child, and cannot restart it. Named APIs, no guessed flags.
                    while True:
                        try: pid,status=b.os.waitpid(inner,b.os.WNOHANG)
                        except ChildProcessError:
                            inner=None # cannot safely signal a possibly recycled PID
                            raise
                        if pid==inner:
                            reaped=True; outcome=0; break
                        if pid!=0:
                            inner=None; _fail('REAP_UNCERTAIN')
                        readable,_,_=b.select([stop[0]],[],[],0.01)
                        if readable:
                            frame=b.os.read(stop[0],5)
                            if frame!=b'STOP': _fail('STOP_FRAME_DENIED')
                            # PID namespace init death kills its descendants;
                            # don't reap/reuse its PID before the signal.
                            outcome=0 if reap_inner() else 78
                            break
                except BaseException:
                    # Setup/control/wait errors never deliberately abandon the
                    # exact child while its direct-parent authority survives.
                    outcome=0 if reap_inner() else 78
                b.os._exit(outcome) # zero only after proven original family exit
            owned=NativeOwned(outer,launch.run_id,launch.role,command[1],result[0])
            state={'outer':outer,'stop':stop[1],'closed':False,'terminal':None,'launch':launch,
                   'ready':ready[0],'child':None,'digest':None,'links':None}
            self._owned[owned]=state
            metadata=b.os.fstat(pins[launch.argv[0]])
            state['exec_identity']=(metadata.st_dev,metadata.st_ino)
            # Capture cleanup authority immediately after successful fork,
            # BEFORE any close/read/observation that may fail in the parent.
            for fd in pins.values(): b.os.close(fd)
            for fd in (command[0],result[1],stop[0],ready[1]): b.os.close(fd)
            b.os.set_blocking(stop[1],False)
            digest=self._read_exact(ready[0],64,2000).decode('ascii')
            if not re.fullmatch('[0-9a-f]{64}',digest): _fail('ROLE_START_FAILED')
            # A worker-owned fixed waiting frame is necessary, never infer
            # readiness from a successful fork or an empty pipe.
            if self._read_exact(result[0],8,2000)!=b'WAITING\n': _fail('ROLE_START_FAILED')
            child=self._child_pid(outer)
            state.update(child=child,digest=digest)
            state['links']=tuple(b.os.readlink('/proc/'+str(child)+'/fd/'+str(fd)) for fd in (3,4))
            # Public PID is the inner process identity; parent reaps the stable
            # outer helper through its private state, not by this mutable PID.
            replacement=NativeOwned(child,launch.run_id,launch.role,command[1],result[0],owned.identity)
            del self._owned[owned]; self._owned[replacement]=state
            return replacement
        except BaseException:
            if owned is not None: raise RoleStartFailure(owned) from None
            # No child exists before fork returns. A failed fork closes every
            # endpoint and pin. The child branch never returns to this cleanup.
            for pair in pairs:
                for fd in pair:
                    try: b.os.close(fd)
                    except OSError: pass
            for fd in pins.values():
                try: b.os.close(fd)
                except OSError: pass
            raise

    def _child_pid(self,outer):
        # Only the trusted helper's one DIRECT, unreaped child. No ordering race
        # between helper PID bytes and the child's pre-exec digest on a pipe.
        words=self.b.read_file('/proc/'+str(outer)+'/task/'+str(outer)+'/children',128).split()
        if len(words)!=1 or not re.fullmatch(b'[1-9][0-9]{0,9}',words[0]): _fail('ROLE_START_FAILED')
        return int(words[0])

    def _read_exact(self,fd,count,deadline):
        until=self.b.monotonic()+deadline/1000; data=bytearray()
        while len(data)<count and self.b.monotonic()<until:
            ready,_,_=self.b.select([fd],[],[],min(0.01,max(0,until-self.b.monotonic())))
            if ready:
                part=self.b.os.read(fd,count-len(data))
                if not part: _fail('ROLE_START_FAILED')
                data.extend(part)
        if len(data)!=count: _fail('ROLE_START_FAILED')
        return bytes(data)

    def inspect(self,pid):
        states=[s for owned,s in self._owned.items() if owned.pid==pid and s['terminal'] is None]
        if len(states)!=1 or states[0].get('child')!=pid: _fail('ATTESTATION_FAILED')
        s=states[0]; a=_native_observe(self.b,pid,s['launch'],s['digest'],{},True)
        executable=self.b.os.stat('/proc/'+str(pid)+'/exe')
        if (executable.st_dev,executable.st_ino)!=s.get('exec_identity'): _fail('PROGRAM_DENIED')
        links=tuple(self.b.os.readlink('/proc/'+str(pid)+'/fd/'+str(fd)) for fd in (3,4))
        if links!=s['links']: _fail('FD_DENIED')
        return a

    def _exit(self,owned,deadline,stop):
        _deadline(deadline)
        if owned not in self._owned: _fail('EXIT_DENIED')
        s=self._owned[owned]
        if s['terminal'] is not None: return dict(s['terminal'])
        if stop and not s.get('stop_sent',False):
            try:
                if self.b.os.write(s['stop'],b'STOP')!=4: _fail('EXIT_DENIED')
                s['stop_sent']=True
            except (OSError,ConfinementError):
                # Still try original parent wait: closed control may simply
                # mean it has already exited. Never signal a supplied PID.
                pass
        until=self.b.monotonic()+deadline/1000
        while self.b.monotonic()<until:
            try: pid,status=self.b.os.waitpid(s['outer'],self.b.os.WNOHANG)
            except ChildProcessError: _fail('REAP_UNCERTAIN')
            if pid==s['outer']:
                # Helper error/kill cannot certify inner family exit.
                if status!=0: _fail('REAP_UNCERTAIN')
                outcome={'status':'STOPPED' if stop else 'EXITED','pid':owned.pid,'run_id':owned.run_id}
                s['terminal']=outcome
                for name in ('stop','ready'):
                    if name in s:
                        try: self.b.os.close(s[name])
                        except OSError: pass
                for endpoint in (owned.command,owned.result):
                    if type(endpoint) is int:
                        try: self.b.os.close(endpoint)
                        except OSError: pass
                return dict(outcome)
            self.b.sleep(min(0.01,max(0,until-self.b.monotonic())))
        return {'status':'TIMEOUT','pid':owned.pid,'run_id':owned.run_id}

    def wait_owned(self,owned,deadline): return self._exit(owned,deadline,False)
    def stop_owned(self,owned,deadline): return self._exit(owned,deadline,True)


if __name__ == '__main__':
    # Import/CLI cannot fall back to the macOS host or manufacture runtime proof.
    raise SystemExit(78)

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
import hmac
import json
import re
import secrets
import struct
import threading
import time
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


_KEY_DERIVATION_DOMAIN = b'acceptance:key-derivation:v1\0'
CHANNEL_KEY_LABELS = ('vsock-stream', 'topology-admission')


def derive_channel_key(capability, label):
    """C3 (E3, T10-10): one key per channel from the 32-byte run capability.

    derive(capability, label) = HMAC-SHA256(key=capability,
    msg="acceptance:key-derivation:v1\\0" || label || "\\0"), for the two fixed
    labels only. The PROXY receives only the vsock-stream key (R6); the
    topology-admission key, like the capability, stays with the bootstrap and host.
    """
    if (type(capability) is not bytes or len(capability) != 32
            or type(label) is not str or label not in CHANNEL_KEY_LABELS):
        _fail('KEY_DERIVATION_DENIED')
    return hmac.new(capability, _KEY_DERIVATION_DOMAIN + label.encode('ascii') + b'\0',
                    hashlib.sha256).digest()


@dataclass(frozen=True, slots=True)
class CompositionBinding:
    """Shared immutable wire identity; possession alone grants no authority."""
    version: int
    runId: str
    manifestDigest: str
    configIdentity: str
    rolePolicyDigest: str
    epoch: int
    expiresAtMs: int

    def __post_init__(self):
        if (type(self.version) is not int or self.version != 1
                or not _run(self.runId)
                or type(self.epoch) is not int or not 0 < self.epoch <= 9007199254740991
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
    PID/mount/proc/device views and role-only 0700 tmpfs before UID drop; it
    enters the view by pivot_root inside the role's private mount namespace
    and detaches the old root; no chroot.
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


# Linux 6.8 native arm64 syscall numbers: no compat/multiplexed ABI. In order:
# io_uring_setup, io_uring_enter, io_uring_register, ptrace, process_vm_readv,
# process_vm_writev, pidfd_getfd, pidfd_open, capset, setregid, setgid,
# setreuid, setuid, setresuid, setresgid, setfsuid, setfsgid, setgroups, setns,
# mknodat, umount2, mount, pivot_root, chroot.
BASE_DENY_SYSCALLS = (425, 426, 427, 117, 270, 271, 438, 434,
                      91, 143, 144, 145, 146, 147, 149, 151, 152, 159,
                      268, 33, 39, 40, 41, 51)
# E1 (contract C6, ruling R1): Chromium's namespace sandbox calls these inside
# its own user namespace, so they leave the BROWSER deny list only: chroot,
# capset, setregid, setgid, setreuid, setuid, setresuid, setresgid, setfsuid,
# setfsgid, setgroups. mount, umount2, pivot_root, setns, mknodat and
# pidfd_open stay denied for BROWSER. unshare, clone and clone3 were never
# filtered (R2). Roles hold no capability in the initial user namespace.
BROWSER_SANDBOX_SYSCALLS = (51, 91, 143, 144, 145, 146, 147, 149, 151, 152, 159)
# seccomp(2) filter flags each role may pass: 0 and TSYNC; BROWSER also
# SPEC_ALLOW and TSYNC|SPEC_ALLOW (C6). Never LOG, NEW_LISTENER or TSYNC_ESRCH.
SECCOMP_FLAGS_BY_ROLE = MappingProxyType({
    'CONTROLLER': (0, 1), 'BROWSER': (0, 1, 4, 5), 'VERIFIER': (0, 1), 'PROXY': (0, 1)})


def build_filter(role):
    """Deterministic, inspectable classic-BPF outer policy; no external generator.

    Loads match pinned little-endian seccomp_data nr0/arch4/args16; both words
    of every constrained scalar are checked. Only ALLOW, EPERM, KILL_PROCESS
    exits exist. No TRACE/USER_NOTIF or listener flags. New restriction filters
    can only tighten this one. No AF_NETLINK exception is selected. BROWSER
    differs only in its deny list and seccomp flag set (E1, contract C6).
    """
    if role not in UIDS or role not in SECCOMP_FLAGS_BY_ROLE: _fail('ROLE_DENIED')
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
    deny = BASE_DENY_SYSCALLS if role != 'BROWSER' else tuple(
        nr for nr in BASE_DENY_SYSCALLS if nr not in BROWSER_SANDBOX_SYSCALLS)
    for nr in deny: eq(nr, yes='deny')
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
    # filter mode and the role's flags are allowed (0/TSYNC; BROWSER also
    # SPEC_ALLOW), never a NEW_LISTENER escape.
    label('inner-filter'); load(28); require(0); load(24); require(2); ret(0x7fff0000)
    label('seccomp'); load(20); require(0); load(16); require(1)
    load(28); require(0); load(24)
    for flags in SECCOMP_FLAGS_BY_ROLE[role]: eq(flags, yes='allow')
    ret(0x00050001)
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


def start_roles(config, *, cleanup_budget=None, acquisition_owner=None):
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
                if acquisition_owner is not None: acquisition_owner._originals.append(error.owned)
                raise
            owned_children.append(owned)
            if acquisition_owner is not None: acquisition_owner._originals.append(owned)
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
        # A failed acquisition is a terminal event: start the shared end (C1).
        if cleanup_budget is not None:
            try: cleanup_budget.start_terminal()
            except Exception: pass
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
                if acquisition_owner is not None:
                    result=acquisition_owner._stop_one(owned,acquisition_owner._cleanup_remaining())
                    if result['status'] not in ('STOPPED','EXITED'):cleanup_failed=True
                else:
                    result = (cleanup_budget.call(lambda ms,original=owned: k.stop_owned(original,ms))
                              if cleanup_budget is not None else k.stop_owned(owned,120000))
                    if type(result) is not dict or result.get('status') not in ('STOPPED','EXITED') or result.get('pid') != owned.pid or result.get('run_id') != config.run_id: cleanup_failed = True
            except Exception: cleanup_failed = True
        error=ConfinementError('REAP_UNCERTAIN' if cleanup_failed else 'BOOTSTRAP_FAILED')
        if acquisition_owner is not None: error.cleanup=acquisition_owner
        raise error
    return MappingProxyType(handoffs)


_COMPOSITION_SEAL=object()
_BOUND_ROLE_CONFIGS={}
_FRAME_DOMAIN=b'acceptance:bootstrap-composition:v1\0'
_PREPARE_FIELDS={'grantId','proofDigest','generation','expiresAtMs','monotonicDeadlineMs'}


def _v1_exact(value,fields):
    if type(value) is not dict or set(value)!=set(fields): _fail('FRAME_DENIED')


def _v1_int(value,minimum=1):
    if type(value) is not int or not minimum<=value<=9007199254740991: _fail('FRAME_DENIED')
    return value


def _v1_canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode('ascii')


def _v1_encode(value):
    body=_v1_canonical(value)
    if not 0<len(body)<=16384: _fail('FRAME_DENIED')
    return struct.pack('>I',len(body))+body


def _v1_decode(data,ancillary=(),flags=0):
    if type(data) is not bytes or not 4<len(data)<=16388 or type(ancillary) is not tuple or ancillary or type(flags) is not int or flags!=0 or struct.unpack('>I',data[:4])[0]!=len(data)-4: _fail('FRAME_DENIED')
    try:
        text=data[4:].decode('ascii');depth=0;quoted=False;escaped=False
        for char in text:
            if quoted:
                if escaped: escaped=False
                elif char=='\\': escaped=True
                elif char=='"': quoted=False
            elif char=='"': quoted=True
            elif char in '[{':
                depth+=1
                if depth>8: _fail('FRAME_DENIED')
            elif char in ']}': depth-=1
        value=json.loads(text)
        if _v1_canonical(value)!=data[4:]: _fail('FRAME_DENIED')
        return value
    except (ValueError,UnicodeError,OverflowError,RecursionError): _fail('FRAME_DENIED')


def _v1_proof(value):
    _v1_exact(value,('proofDigest','generation','expiresAtMs','monotonicDeadlineMs'))
    if type(value['proofDigest']) is not str or re.fullmatch('[0-9a-f]{64}',value['proofDigest']) is None: _fail('FRAME_DENIED')
    for key in ('generation','expiresAtMs','monotonicDeadlineMs'): _v1_int(value[key])
    return dict(value)


class BootstrapBrowserPreparation:
    """Bootstrap-local obligation. Its five-field projection is only data."""
    __slots__=('_roles','_child','_pipe','_proof','_grant','_reservation','_used','_prepared','_committed')
    def __init__(self,roles,proof,seal=None):
        if seal is not _COMPOSITION_SEAL: _fail('AUTHORITY_LOST')
        self._roles,self._proof=roles,dict(proof)
        self._child=roles._handoffs['BROWSER'];self._pipe=(self._child._owned.command,self._child._owned.result)
        self._grant=secrets.token_hex(16);self._reservation=None;self._used=False;self._prepared=False;self._committed=False

    def to_prepare_result(self):
        self._roles._check(self._proof)
        if not self._prepared or self._roles._preparation is not self: _fail('AUTHORITY_LOST')
        return MappingProxyType(dict(grantId=self._grant,**self._proof))

    def stop_owned(self,remaining_ms): return self._roles.stop_owned(remaining_ms)


class OriginalRoleSet:
    """Exact Task8 children and finite physical forwarding, never PID/FD RPC."""
    def __init__(self,config,binding,budget,seal=None):
        if seal is not _COMPOSITION_SEAL: _fail('AUTHORITY_LOST')
        self.binding,self._config,self._budget=binding,config,budget
        self._originals=[];self._handoffs={};self._map={};self._facts={};self._keys={}
        self._send={'CONTROLLER':0,'BROWSER':0};self._receive={'CONTROLLER':0,'BROWSER':0}
        self._terminal=False;self._preparation=None;self._source=None;self._last=None;self._busy=set();self._stopped=set();self._event=None
        self._cleanup_lock=threading.RLock();self._stop_tokens={};self._clock_failed=False
        self._application={name:dict(stream=0,message=0,index=0,size=0,open=False)
                           for name in ('CONTROLLER','BROWSER')}

    @property
    def originals(self): return tuple(self._originals)

    def _sample(self):
        if self._clock_failed:_fail('CLOCK')
        try:
            clock=getattr(self._budget,'clock',None)
            value=clock.sample() if clock is not None else (time.time_ns()//1000000,time.monotonic_ns()//1000000)
            if type(value) not in (tuple,list) or len(value)!=2: _fail('CLOCK')
            for v in value: _v1_int(v,0)
            if self._last is not None and any(a<b for a,b in zip(value,self._last)): _fail('CLOCK')
            self._last=tuple(value);return self._last
        except Exception:
            self._clock_failed=True;_fail('CLOCK')

    def _cleanup_remaining(self):
        # Every caller is terminal (failure, cancel, stop, wait-exit, clamp):
        # the first one starts the one shared end (C1). No direct deadline write.
        with self._cleanup_lock:
            try:
                if self._clock_failed:self._budget.clamp_end(0)
                return _v1_int(self._budget.start_terminal(),0)
            except Exception:
                try:self._budget.clamp_end(0)
                except Exception:pass
                return 0

    def _failed(self,error):
        self._terminal=True
        if self._preparation is not None:self._preparation._used=True
        if str(error)=='CHANNEL_EOF':self._clamp(0)
        self._cleanup_remaining()
        error.cleanup=self._preparation if self._preparation is not None else self

    def _check(self,proof=None):
        if self._terminal: _fail('CANCELLED')
        wall,mono=self._sample()
        if wall>=self.binding.expiresAtMs or (proof and (wall>=proof['expiresAtMs'] or mono>=proof['monotonicDeadlineMs'])): _fail('EXPIRED')
        if proof and (proof['generation']!=1 or proof['expiresAtMs']>self.binding.expiresAtMs): _fail('AUTHORITY_LOST')
        for role,h in self._handoffs.items():
            if _ownership_facts(h._owned)!=self._facts[role]: _fail('AUTHORITY_LOST')

    def bind_current_source(self,source):
        # Only trusted composition embedding supplies this original owner. It
        # is never selected/constructed by a decoded controller request.
        if self._source is not None or not callable(getattr(source,'require_current',None)): _fail('AUTHORITY_LOST')
        self._source=source

    def _current(self,proof):
        self._check(proof)
        if self._source is None: _fail('NATIVE_EFFECT_FENCE_UNAVAILABLE')
        value=self._source.require_current();self._check(proof)
        _v1_exact(value,(*proof,'eventCheckpoint'))
        if any(value[k]!=proof[k] for k in proof): _fail('AUTHORITY_LOST')
        event=value['eventCheckpoint'];_v1_exact(event,('binding','generation','sequence','sourceIdentity','lostCount'))
        if CompositionBinding.from_record(event['binding'])!=self.binding or event['generation']!=1 or not _run(event['sourceIdentity']) or type(event['lostCount']) is not int or event['lostCount']!=0: _fail('AUTHORITY_LOST')
        _v1_int(event['generation']);_v1_int(event['sequence'])
        if self._event is not None and (event['sourceIdentity']!=self._event['sourceIdentity'] or event['sequence']<self._event['sequence']): _fail('AUTHORITY_LOST')
        self._event=dict(event)
        return event

    def _frame(self,channel,role,action,payload):
        self._send[channel]=_v1_int(self._send[channel]+1)
        value=dict(version=1,binding=self.binding.to_record(),sequence=self._send[channel],**self._map[role],action=action,payload=payload)
        value['mac']=hmac.new(self._keys[channel],_FRAME_DOMAIN+channel.encode()+b':FROM_BOOTSTRAP\0'+_v1_canonical(value),hashlib.sha256).hexdigest()
        return _v1_encode(value)

    def _decode(self,channel,data,ancillary=(),flags=0):
        value=_v1_decode(data,ancillary,flags)
        _v1_exact(value,('version','binding','sequence','role','childId','pipeId','action','payload','mac'))
        row=self._map.get(value['role'])
        if not row or (channel=='BROWSER' and value['role']!='BROWSER') or type(value['version']) is not int or value['version']!=1 or CompositionBinding.from_record(value['binding'])!=self.binding or any(value[k]!=row[k] for k in row) or type(value['mac']) is not str: _fail('FRAME_DENIED')
        if _v1_int(value['sequence'])!=self._receive[channel]+1: _fail('FRAME_DENIED')
        unsigned=dict(value);unsigned.pop('mac')
        expected=hmac.new(self._keys[channel],_FRAME_DOMAIN+channel.encode()+b':TO_BOOTSTRAP\0'+_v1_canonical(unsigned),hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected,value['mac']): _fail('FRAME_DENIED')
        self._receive[channel]+=1;return value

    def _write(self,channel,role,action,payload,cleaning=False):
        if not cleaning:self._check(self._preparation._proof if self._preparation else None)
        data=self._frame(channel,role,action,payload)
        self._config.kernel.write_role(self._handoffs[channel]._owned,data)
        if not cleaning:self._check(self._preparation._proof if self._preparation else None)
        return self._send[channel]

    def _read_worker(self,remaining_ms):
        try:data=self._config.kernel.read_role(self._handoffs['BROWSER']._owned,remaining_ms)
        except ConfinementError as error:
            if str(error)=='CHANNEL_EOF':self._terminal=True;self._clamp(0)
            raise
        if data==b'':self._terminal=True;self._clamp(0);_fail('CHANNEL_EOF')
        return data

    def _worker(self):
        self._check(self._preparation._proof)
        wall,mono=self._sample();p=self._preparation._proof
        data=self._read_worker(min(p['expiresAtMs']-wall,p['monotonicDeadlineMs']-mono))
        self._check(p);value=self._decode('BROWSER',data)
        if value['action']=='FAILED':
            f=value['payload'];_v1_exact(f,('requestSequence','generation','code','failedAtMonotonicMs'))
            _v1_int(f['requestSequence']);_v1_int(f['failedAtMonotonicMs'],0)
            if f['generation']!=1 or f['code'] not in ('CANCELLED','EXPIRED','AUTHORITY_LOST','LAUNCH_FAILED','CLEANUP_UNCERTAIN'): _fail('FRAME_DENIED')
            self._clamp(f['failedAtMonotonicMs']+60000);_fail(f['code'])
        return value

    def _application_chunk(self,value,direction):
        _v1_exact(value,('streamSequence','messageSequence','chunkIndex','final','bytesHex'))
        for key in ('streamSequence','messageSequence'):_v1_int(value[key])
        _v1_int(value['chunkIndex'],0)
        if (type(value['final']) is not bool or type(value['bytesHex']) is not str
                or len(value['bytesHex'])>8192 or len(value['bytesHex'])%2
                or re.fullmatch('[0-9a-f]*',value['bytesHex']) is None):_fail('FRAME_DENIED')
        state=self._application[direction]
        if value['streamSequence']!=state['stream']+1:_fail('FRAME_DENIED')
        expected_message=state['message'] if state['open'] else state['message']+1
        expected_index=state['index'] if state['open'] else 0
        if value['messageSequence']!=expected_message or value['chunkIndex']!=expected_index:_fail('FRAME_DENIED')
        size=state['size']+len(value['bytesHex'])//2
        if size>16384:_fail('FRAME_DENIED')
        state.update(stream=value['streamSequence'],message=value['messageSequence'],
                     index=value['chunkIndex']+1,size=size,open=not value['final'])
        if value['final']:state.update(index=0,size=0)
        return value

    def audit(self,role,child_id=None,pipe_id=None):
        self._check()
        if role not in ('BROWSER','VERIFIER'): _fail('HANDOFF_DENIED')
        row=self._map[role]
        if (child_id is not None and child_id!=row['childId']) or (pipe_id is not None and pipe_id!=row['pipeId']): _fail('HANDOFF_DENIED')
        h=self._handoffs[role];_check(inspect_role(h.attestation.pid,kernel=self._config.kernel),h.launch,waiting=True)
        return dict(kind=role,runId=self.binding.runId,uid=UIDS[role],childId=row['childId'],pipeId=row['pipeId'],waiting=True,confined=True,attestationDigest=h.attestation.filter_digest)

    def prepare_browser(self,proof,browser_config=None):
        try:
            proof=_v1_proof(proof);self._check(proof)
            if browser_config is not None and type(browser_config) is not dict:_fail('FRAME_DENIED')
            if self._preparation is not None: _fail('AUTHORITY_LOST')
            self._preparation=BootstrapBrowserPreparation(self,proof,_COMPOSITION_SEAL)
            owner=self._preparation
            self._current(proof);self.audit('BROWSER')
            payload=dict(grantId=owner._grant,**proof)
            if browser_config is not None:payload['browserConfig']=browser_config
            seq=self._write('BROWSER','BROWSER','PREPARE',payload)
            response=self._worker();p=response['payload'];_v1_exact(p,('requestSequence','grantId','reservationId','generation'))
            _v1_int(p['requestSequence']);_v1_int(p['generation'])
            if response['action']!='PREPARED' or p['requestSequence']!=seq or p['grantId']!=owner._grant or not _run(p['reservationId']) or type(p['generation']) is not int or p['generation']!=1: _fail('AUTHORITY_LOST')
            self._current(proof);owner._reservation=p['reservationId'];owner._prepared=True;return owner
        except Exception as error:
            self._failed(error);raise

    def commit_browser(self,owner):
        try:
            if type(owner) is not BootstrapBrowserPreparation or owner is not self._preparation or owner._used or not owner._prepared: _fail('AUTHORITY_LOST')
            owner._used=True
            self._current(owner._proof)
            p=dict(grantId=owner._grant,reservationId=owner._reservation,commitId=secrets.token_hex(16),generation=1)
            seq=self._write('BROWSER','BROWSER','COMMIT',p);response=self._worker();v=response['payload']
            _v1_exact(v,('requestSequence',*p))
            _v1_int(v['requestSequence']);_v1_int(v['generation'])
            if response['action']!='REFRESH' or v!=dict(requestSequence=seq,**p): _fail('AUTHORITY_LOST')
            event=self._current(owner._proof)
            seq=self._write('BROWSER','BROWSER','CURRENT',dict(requestSequence=response['sequence'],**p,proofDigest=owner._proof['proofDigest'],eventCheckpoint=event,expiresAtMs=owner._proof['expiresAtMs'],monotonicDeadlineMs=owner._proof['monotonicDeadlineMs']))
            response=self._worker()
            _v1_exact(response['payload'],('requestSequence',*p));_v1_int(response['payload']['requestSequence']);_v1_int(response['payload']['generation'])
            if response['action']!='STARTED' or response['payload']!=dict(requestSequence=seq,**p): _fail('AUTHORITY_LOST')
            self._check(owner._proof);owner._committed=True
            if isinstance(self._config.kernel,NativeKernelPort):self._config.kernel._commit_browser_runtime(owner)
            return {'status':'ACTIVE','generation':1}
        except Exception as error:
            self._failed(error);raise

    def _clamp(self,end):
        _v1_int(end,0)
        with self._cleanup_lock:
            self._cleanup_remaining()
            self._budget.clamp_end(end)

    def cancel(self,cleanup_ends_at=None):
        self._terminal=True
        if self._preparation is not None:self._preparation._used=True
        try:
            # Without an authenticated earlier end, cancellation can only ask
            # for nonblocking cleanup, never allocate a fresh waiting window.
            self._clamp(0 if cleanup_ends_at is None else cleanup_ends_at)
            self._write('BROWSER','BROWSER','CANCEL',dict(generation=1,cleanupEndsAtMonotonicMs=self._budget.deadline),True)
            value=self._decode('BROWSER',self._read_worker(self._cleanup_remaining()))
            if value['action']!='CANCELLED' or value['payload']!=dict(requestSequence=self._send['BROWSER'],generation=1): _fail('FRAME_DENIED')
            return {'status':'CANCELLED','generation':1}
        except Exception as error:
            self._failed(error);raise

    def _stop_one(self,owned,remaining_ms,wait=False):
        token=object()
        with self._cleanup_lock:
            if id(owned) in self._busy: _fail('CLEANUP_UNCERTAIN')
            if id(owned) in self._stopped:return {'status':'STOPPED','runId':self.binding.runId}
            self._busy.add(id(owned))
            self._stop_tokens[id(owned)]=token
        def stop(allowance):
            try:
                op=self._config.kernel.wait_owned if wait else self._config.kernel.stop_owned
                r=op(owned,min(remaining_ms,allowance))
                if type(r) is not dict or set(r)!={'status','pid','run_id'} or r['pid']!=owned.pid or type(r['pid']) is not int or r['run_id']!=self.binding.runId or r['status'] not in ('STOPPED','EXITED','TIMEOUT'): _fail('CLEANUP_UNCERTAIN')
                with self._cleanup_lock:
                    if self._stop_tokens.get(id(owned)) is not token:_fail('CLEANUP_UNCERTAIN')
                    if r['status']!='TIMEOUT':self._stopped.add(id(owned))
                return {'status':r['status'],'runId':self.binding.runId}
            finally:
                with self._cleanup_lock:
                    if self._stop_tokens.get(id(owned)) is token:
                        self._busy.discard(id(owned));del self._stop_tokens[id(owned)]
        # A timed-out budget.call may still own its callback thread. Only that
        # callback retires this token; callers must not release it on timeout.
        return self._budget.call(stop) if self._cleanup_remaining() else stop(0)

    def wait_exit(self,role,remaining_ms):
        _v1_int(remaining_ms,0)
        if role not in self._handoffs: _fail('EXIT_DENIED')
        return self._stop_one(self._handoffs[role]._owned,remaining_ms,True)

    def stop_owned(self,remaining_ms):
        _v1_int(remaining_ms,0);self._terminal=True;uncertain=False
        for owned in reversed(self._originals):
            try:
                if self._stop_one(owned,remaining_ms)['status']=='TIMEOUT':uncertain=True
            except Exception:uncertain=True
        return {'status':'TIMEOUT' if uncertain else 'STOPPED','runId':self.binding.runId}

    def handle_controller(self,data,ancillary=(),flags=0):
        try:
            f=self._decode('CONTROLLER',data,ancillary,flags);role,action,p=f['role'],f['action'],f['payload']
            if action=='ADOPT':_v1_exact(p,());result=self.audit(role)
            elif action=='PREPARE_BROWSER' and role=='BROWSER':
                if type(p) is not dict:_fail('FRAME_DENIED')
                browser_config=p.get('browserConfig')
                proof=dict(p);proof.pop('browserConfig',None)
                result=dict(self.prepare_browser(proof,browser_config).to_prepare_result())
            elif action=='COMMIT_BROWSER' and role=='BROWSER':
                _v1_exact(p,('grantId','generation'))
                _v1_int(p['generation'])
                if self._preparation is None or p!=dict(grantId=self._preparation._grant,generation=1):_fail('AUTHORITY_LOST')
                result=self.commit_browser(self._preparation)
            elif action=='CANCEL' and role=='BROWSER':
                _v1_exact(p,('generation','cleanupEndsAtMonotonicMs'))
                if type(p['generation']) is not int or p['generation']!=1:_fail('FRAME_DENIED')
                result=self.cancel(p['cleanupEndsAtMonotonicMs'])
            elif action in ('STOP_OWNED','WAIT_EXIT'):
                _v1_exact(p,('remainingMs','cleanupEndsAtMonotonicMs'));_v1_int(p['remainingMs'],0);self._clamp(p['cleanupEndsAtMonotonicMs'])
                if action=='STOP_OWNED':self._terminal=True
                result=self._stop_one(self._handoffs[role]._owned,p['remainingMs'],action=='WAIT_EXIT')
            elif action=='TOPOLOGY_CURRENT' and role=='CONTROLLER':
                _v1_exact(p,('generation',))
                _v1_int(p['generation'])
                if p['generation']!=1 or self._preparation is None:_fail('AUTHORITY_LOST')
                result=dict(proofDigest=self._preparation._proof['proofDigest'],eventCheckpoint=self._current(self._preparation._proof))
            elif action=='PROXY_CURRENT' and role=='PROXY':_fail('NATIVE_PROXY_RUNTIME_UNAVAILABLE')
            elif action=='APP_WRITE' and role=='BROWSER':
                if self._preparation is None or not self._preparation._committed:_fail('AUTHORITY_LOST')
                self._application_chunk(p,'CONTROLLER')
                self._write('BROWSER','BROWSER','APP_CHUNK',p)
                result=dict(acceptedStreamSequence=p['streamSequence'])
            elif action=='APP_POLL' and role=='BROWSER':
                _v1_exact(p,())
                if self._preparation is None or not self._preparation._committed:_fail('AUTHORITY_LOST')
                self._check(self._preparation._proof)
                ready=self._config.kernel.poll_role(self._handoffs['BROWSER']._owned)
                if type(ready) is not bool:_fail('FRAME_DENIED')
                if not ready:result=dict(status='EMPTY')
                else:
                    value=self._decode('BROWSER',self._read_worker(0))
                    if value['action']!='APP_CHUNK':_fail('FRAME_DENIED')
                    self._application_chunk(value['payload'],'BROWSER')
                    result=dict(status='CHUNK',chunk=value['payload'])
            else:_fail('FRAME_DENIED')
            return self._frame('CONTROLLER',role,'RESULT',dict(requestSequence=f['sequence'],result=result))
        except Exception as error:
            self._failed(error);raise


def bind_original_roles(config,binding,cleanup_budget):
    if type(binding) is not CompositionBinding or type(config) is not BootstrapConfig or config.run_id!=binding.runId or any(not callable(getattr(cleanup_budget,name,None)) for name in ('remaining','call','start_terminal','clamp_end')): _fail('COMPOSITION_BINDING_DENIED')
    if id(config) in _BOUND_ROLE_CONFIGS:_fail('AUTHORITY_LOST')
    # Retain the exact configuration through the whole run, including failure;
    # a second call cannot respawn its four original children or recycle IDs.
    _BOUND_ROLE_CONFIGS[id(config)]=config
    owner=OriginalRoleSet(config,binding,cleanup_budget,_COMPOSITION_SEAL)
    try:
        owner._check();owner._handoffs=start_roles(config,cleanup_budget=cleanup_budget,acquisition_owner=owner)
        for role,handoff in owner._handoffs.items():
            owner._map[role]=dict(role=role,childId=secrets.token_hex(16),pipeId=secrets.token_hex(16))
            owner._facts[role]=_ownership_facts(handoff._owned)
        owner._keys={role:secrets.token_bytes(32) for role in ('CONTROLLER','BROWSER','PROXY')}
        owner._check()
        config.kernel.write_role(owner._handoffs['CONTROLLER']._owned,_v1_encode(dict(version=1,kind='BOOTSTRAP_INIT',binding=binding.to_record(),channelKeyHex=owner._keys['CONTROLLER'].hex(),roles=list(owner._map.values()))))
        owner._check()
        config.kernel.write_role(owner._handoffs['BROWSER']._owned,_v1_encode(dict(version=1,kind='BROWSER_WORKER_INIT',binding=binding.to_record(),channelKeyHex=owner._keys['BROWSER'].hex(),**owner._map['BROWSER'])))
        owner._check();return owner
    except Exception as error:
        owner._failed(error);raise


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
           'chdir','getpid','getppid','rmdir','unlink','_exit')
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
        # pivot_root needs the new root to be a mount root: bind it onto itself
        # (Linux 6.8 fs/namespace.c:4174-4177, 4235-4238).
        try: b.syscall(40,root.encode(),root.encode(),None,4096,None)
        except OSError: _fail('VIEW_ROOT_BIND_FAILED')
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
        # E-1 (C6): enter the view by pivot_root inside this role's private
        # mount namespace, never chroot: Linux 6.8 refuses a user namespace to
        # a chrooted caller (kernel/user_namespace.c:104-106), which would stop
        # Chromium's namespace sandbox. pivot_root(".", ".") stacks the old
        # root on "."; umount2(".", MNT_DETACH) detaches that whole old tree.
        # Runs before seccomp. No fallback after any failure.
        try: b.os.chdir(root)
        except OSError: _fail('VIEW_PIVOT_FAILED')
        try: b.syscall(41,b'.',b'.')
        except OSError: _fail('VIEW_PIVOT_FAILED')
        try: b.syscall(39,b'.',2)
        except OSError: _fail('VIEW_OLD_ROOT_DETACH_FAILED')
        try: b.os.chdir('/')
        except OSError: _fail('VIEW_PIVOT_FAILED')
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


def _native_observe(b,pid,launch,digest,pins,waiting,local=False,current_fds=None):
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
    elif current_fds is not None:
        rows={str(row['fd']):row for row in current_fds}
        if len(rows)!=len(current_fds) or not expected<=set(rows) or len(rows)>55: _fail('FD_DENIED')
        if listed-set(rows): _fail('NATIVE_CURRENT_INVENTORY_UNAVAILABLE')
        if listed!=set(rows): _fail('FD_DENIED')
        for fd,row in rows.items():
            metadata=b.os.stat(base+'/fd/'+fd)
            info=b.read_file(base+'/fdinfo/'+fd).decode('ascii')
            flags=int(next(x.split()[1] for x in info.splitlines() if x.startswith('flags:')),8)
            if (str(metadata.st_dev),str(metadata.st_ino),flags)!=(row['device'],row['inode'],row['flags']): _fail('FD_DENIED')
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


_RUNTIME_FD_KINDS={
    'NULL','COMMAND','RESULT','PROXY_LISTENER','PROXY_STOP_SELECTOR',
    'PROXY_ACCEPTED_STREAM','PROXY_VSOCK_STREAM','PROXY_CONNECT_SELECTOR',
}
# The only kinds above FD4, and only in PROXY's inventory (compB M-2).
_PROXY_RUNTIME_KINDS=frozenset(kind for kind in _RUNTIME_FD_KINDS if kind.startswith('PROXY_'))
_SELECTOR_KINDS=frozenset(('PROXY_STOP_SELECTOR','PROXY_CONNECT_SELECTOR'))
_DECIMAL=re.compile('0|[1-9][0-9]{0,19}')
_FD_NAME=re.compile('0|[1-9][0-9]{0,3}')
_U64_MAX=18446744073709551615


def _decimal(value):
    """Canonical unsigned decimal of at most 20 digits that fits a u64 (Swift twin)."""
    return type(value) is str and _DECIMAL.fullmatch(value) is not None and int(value)<=_U64_MAX


def fdinfo_facts(data):
    """(flags, tfd targets) from one Linux /proc/<pid>/fdinfo/<fd> text.

    `flags:` is the octal open-file flags line, exactly once. `tfd:` lines exist
    only for an epoll instance (one per registered target); their sorted target
    FD numbers bind a selector's identity beyond its shared anonymous inode
    (E4/C5, compA M-3). A procfs text format, like `flags:` (ABI ruling R13).
    """
    if type(data) is not bytes or len(data)>4096: _fail('FD_DENIED')
    try: lines=data.decode('ascii').splitlines()
    except UnicodeError: _fail('FD_DENIED')
    flags=[line.split() for line in lines if line.startswith('flags:')]
    if len(flags)!=1 or len(flags[0])!=2 or re.fullmatch('[0-7]{1,22}',flags[0][1]) is None: _fail('FD_DENIED')
    targets=[]
    for line in lines:
        if line.startswith('tfd:'):
            fields=line.split()
            if len(fields)<2 or _FD_NAME.fullmatch(fields[1]) is None or int(fields[1])>4095: _fail('FD_DENIED')
            targets.append(int(fields[1]))
    if len(set(targets))!=len(targets): _fail('FD_DENIED')
    return int(flags[0][1],8),tuple(sorted(targets))


def runtime_rows(value,role,lifecycle,*,_allow_proxy_pre_listener=False):
    """Pure RoleRuntimeObservation wire checks for one fixed role (amendment 4.1).

    Shared by the bootstrap observer, the composition consumer and, through the
    exported divergence vectors, the Swift twin `validateRoleRuntimeV1`.
    """
    if (type(value) is not dict
            or set(value)!=set(('role','childId','pipeId','lifecycle',
                                'inheritedFDs','currentFDs'))
            or role not in UIDS or value['role']!=role
            or value['lifecycle']!=lifecycle
            or lifecycle not in ('WAITING','SERVICE','BROWSER_ACTIVE')
            or not _run(value['childId']) or not _run(value['pipeId'])
            or value['inheritedFDs']!=[0,1,2,3,4]
            or type(value['currentFDs']) is not list
            or not 5<=len(value['currentFDs'])<=55):
        _fail('FD_DENIED')
    seen=[];owners=set()
    for row in value['currentFDs']:
        if (type(row) is not dict
                or set(row)!=set(('fd','kind','device','inode','flags','ownerId',
                                  'acquiredGeneration'))
                or type(row['fd']) is not int or not 0<=row['fd']<=4095
                or row['kind'] not in _RUNTIME_FD_KINDS
                or not _decimal(row['device']) or not _decimal(row['inode'])
                or type(row['flags']) is not int or not 0<=row['flags']<=9007199254740991
                or not _run(row['ownerId']) or row['ownerId'] in owners
                or type(row['acquiredGeneration']) is not int
                or row['acquiredGeneration']!=1):
            _fail('FD_DENIED')
        seen.append(row['fd']);owners.add(row['ownerId'])
    if seen!=sorted(set(seen)) or seen[:5]!=[0,1,2,3,4]: _fail('FD_DENIED')
    if [row['kind'] for row in value['currentFDs'][:5]]!=[
            'NULL','NULL','NULL','COMMAND','RESULT']:
        _fail('FD_DENIED')
    if len({(row['device'],row['inode'])
            for row in value['currentFDs'][3:5]})!=2:
        _fail('FD_DENIED')
    if lifecycle=='WAITING' and len(value['currentFDs'])!=5:
        _fail('NATIVE_CURRENT_INVENTORY_UNAVAILABLE')
    if role!='PROXY' and any(
            row['kind'].startswith('PROXY_') for row in value['currentFDs']):
        _fail('FD_DENIED')
    # compB M-2, T10 divergences: above FD4 only PROXY's own runtime kinds, never
    # a NULL/COMMAND/RESULT row and never another role's extra descriptor.
    if any(row['fd']>=5 and (role!='PROXY' or row['kind'] not in _PROXY_RUNTIME_KINDS)
           for row in value['currentFDs']):
        _fail('FD_DENIED')
    if role=='PROXY':
        counts={kind:sum(row['kind']==kind for row in value['currentFDs'])
                for kind in _RUNTIME_FD_KINDS}
        if (lifecycle!='SERVICE'
                or counts['PROXY_LISTENER']!=(0 if _allow_proxy_pre_listener else 1)
                or counts['PROXY_STOP_SELECTOR']>1
                or counts['PROXY_ACCEPTED_STREAM']>16
                or counts['PROXY_VSOCK_STREAM']>16
                or counts['PROXY_CONNECT_SELECTOR']>16
                or counts['PROXY_VSOCK_STREAM']>counts['PROXY_ACCEPTED_STREAM']
                or counts['PROXY_CONNECT_SELECTOR']>counts['PROXY_ACCEPTED_STREAM']):
            _fail('FD_DENIED')
    # From FD3 on, pipe and socket identities are unique and an epoll selector
    # (whose anonymous inode distinct selectors may share) never aliases one.
    plain=[(row['device'],row['inode']) for row in value['currentFDs'][3:]
           if row['kind'] not in _SELECTOR_KINDS]
    selectors={(row['device'],row['inode']) for row in value['currentFDs'][3:]
               if row['kind'] in _SELECTOR_KINDS}
    if len(set(plain))!=len(plain) or selectors&set(plain): _fail('FD_DENIED')
    return {key:([dict(row) for row in value[key]] if key=='currentFDs'
                 else list(value[key]) if key=='inheritedFDs' else value[key])
            for key in ('role','childId','pipeId','lifecycle','inheritedFDs','currentFDs')}


def validate_runtime_observation(value,handoff,lifecycle,*,originals=None,_allow_proxy_pre_listener=False):
    """Strictly retain inherited authority separately from current inventory.

    With `originals`, the row must also equal that retained original record
    exactly (the Swift twin's canonical original equality).
    """
    if type(handoff) is not RoleHandoff: _fail('FD_DENIED')
    row=runtime_rows(value,handoff.launch.role,lifecycle,
                     _allow_proxy_pre_listener=_allow_proxy_pre_listener)
    if originals is not None and row!=originals: _fail('FD_DENIED')
    return row


class NativeKernelPort:
    """Root bootstrap parent + fixed per-role direct-parent reaper.

    The helper owns its unreaped inner child in the new PID namespace. A STOP
    frame has no PID/argv fields; only that direct child can be signalled. Parent
    waits only its original unreaped helper; terminal receipts are cached. Lost
    helper/control channel is cleanup uncertainty, never arbitrary kill fallback.
    """
    def __init__(self,bindings): self.b,self._owned,self._runtime_owners=bindings,{},{}

    def bind_runtime_owner(self,handoff,lifecycle,runtime_owner,child_id,pipe_id,generation):
        """Trusted acquisition handoff; never populated from a runtime report.

        Capture inherited identities while the original child is still waiting.
        PROXY runtime descriptors are never registered: each bracketed observation
        of the child (`_adopt_child_inventory`) carries its complete inventory.
        Unknown Node/Chromium internals remain unavailable.
        """
        if type(handoff) is not RoleHandoff or handoff._kernel is not self or handoff._owned not in self._owned or id(handoff) in self._runtime_owners or runtime_owner is None or not _run(child_id) or not _run(pipe_id): _fail('AUTHORITY_LOST')
        expected='SERVICE' if handoff.launch.role in ('CONTROLLER','PROXY') else 'WAITING'
        if lifecycle!=expected or _v1_int(generation)!=1: _fail('AUTHORITY_LOST')
        _check(_attestation(self.inspect(handoff.attestation.pid)),handoff.launch,waiting=True)
        rows=[]
        for fd in range(5):
            path='/proc/'+str(handoff.attestation.pid)+'/fd/'+str(fd);metadata=self.b.os.stat(path)
            info=self.b.read_file('/proc/'+str(handoff.attestation.pid)+'/fdinfo/'+str(fd)).decode('ascii')
            flags=int(next(x.split()[1] for x in info.splitlines() if x.startswith('flags:')),8)
            rows.append(dict(fd=fd,kind='NULL' if fd<3 else 'COMMAND' if fd==3 else 'RESULT',device=str(metadata.st_dev),inode=str(metadata.st_ino),flags=flags,ownerId=secrets.token_hex(16),acquiredGeneration=1))
        self._runtime_owners[id(handoff)]=dict(handoff=handoff,owner=runtime_owner,lifecycle=lifecycle,childId=child_id,pipeId=pipe_id,rows=rows,targets={},facts=_ownership_facts(handoff._owned))

    def observe_child_descriptors(self,handoff):
        """The PROXY child's complete descriptor table, read from /proc/<pid> (E4, C5).

        Identity is os.stat('/proc/<pid>/fd/N'), never fstat of the same number in
        this bootstrap process, whose own descriptor table is unrelated. Flags and an
        epoll selector's tfd: targets come from /proc/<pid>/fdinfo/N; the link names
        the object class. Kinds are not observable here: the caller binds them to
        the two MAC'd reports that bracket this read. Read-only; it holds nothing.
        """
        if type(handoff) is not RoleHandoff or handoff._kernel is not self or handoff.launch.role!='PROXY': _fail('AUTHORITY_LOST')
        state=self._owned.get(handoff._owned)
        if not state or state['terminal'] is not None or state['child']!=handoff.attestation.pid: _fail('AUTHORITY_LOST')
        base='/proc/'+str(handoff.attestation.pid)
        listed=self.b.os.listdir(base+'/fd')
        if (type(listed) is not list or len(listed)>4096
                or any(type(name) is not str or _FD_NAME.fullmatch(name) is None or int(name)>4095 for name in listed)
                or len(set(listed))!=len(listed)):
            _fail('FD_DENIED')
        rows=[]
        for fd in sorted(int(name) for name in listed):
            path=base+'/fd/'+str(fd)
            metadata=self.b.os.stat(path)
            flags,targets=fdinfo_facts(self.b.read_file(base+'/fdinfo/'+str(fd),4096))
            link=self.b.os.readlink(path)
            if (type(link) is not str or not link.isascii() or not 0<len(link)<=256
                    or type(metadata.st_dev) is not int or type(metadata.st_ino) is not int
                    or not 0<=metadata.st_dev<=_U64_MAX or not 0<=metadata.st_ino<=_U64_MAX
                    or (targets and link!='anon_inode:[eventpoll]')):
                _fail('FD_DENIED')
            rows.append(dict(fd=fd,device=str(metadata.st_dev),inode=str(metadata.st_ino),
                             flags=flags,tfds=list(targets),link=link))
        return tuple(rows)

    def _adopt_child_inventory(self,handoff,runtime_owner,report):
        """The bootstrap's PROXY ledger after one accepted report-A, /proc, report-B bracket.

        Every observation carries the complete inventory; nothing is registered or
        retired by call. FD0..4 must still be the inherited originals captured while
        the child waited. A runtime descriptor whose (fd, kind, device, inode) is
        unchanged keeps its ownerId and must keep its flags and tfd: targets; a new
        identity is an observed acquisition with a new ownerId, and one absent from
        /proc is retired by that absence.
        """
        state=self._runtime_owners.get(id(handoff))
        if (not state or state['handoff'] is not handoff or state['owner'] is not runtime_owner
                or handoff.launch.role!='PROXY' or state['lifecycle']!='SERVICE'
                or _ownership_facts(handoff._owned)!=state['facts']): _fail('AUTHORITY_LOST')
        if type(report) is not tuple or not 5<=len(report)<=55: _fail('FD_DENIED')
        rows=[dict(row) for row in state['rows'][:5]];adopted={}
        previous={(row['fd'],row['kind'],row['device'],row['inode']):row for row in state['rows'][5:]}
        for index,row in enumerate(report):
            if type(row) is not dict or set(row)!={'fd','kind','device','inode','flags','tfds'} or type(row['tfds']) is not list: _fail('FD_DENIED')
            key=(row['fd'],row['kind'],row['device'],row['inode'])
            if index<5:
                inherited=rows[index]
                if key+(row['flags'],tuple(row['tfds']))!=(inherited['fd'],inherited['kind'],inherited['device'],inherited['inode'],inherited['flags'],()): _fail('FD_DENIED')
                continue
            old=previous.get(key)
            if old is not None and (old['flags']!=row['flags'] or state['targets'].get(key)!=tuple(row['tfds'])): _fail('FD_DENIED')
            rows.append(dict(fd=row['fd'],kind=row['kind'],device=row['device'],inode=row['inode'],flags=row['flags'],
                             ownerId=old['ownerId'] if old is not None else secrets.token_hex(16),acquiredGeneration=1))
            adopted[key]=tuple(row['tfds'])
        runtime_rows(dict(role='PROXY',childId=state['childId'],pipeId=state['pipeId'],lifecycle='SERVICE',
                          inheritedFDs=[0,1,2,3,4],currentFDs=rows),'PROXY','SERVICE')
        state['rows'][:]=rows;state['targets']=adopted
        return tuple(dict(row) for row in rows)

    def runtime_record(self,handoff):
        """The retained current record for one bound original child; no /proc read."""
        state=self._runtime_owners.get(id(handoff))
        if not state or state['handoff'] is not handoff or handoff._kernel is not self: _fail('AUTHORITY_LOST')
        return dict(role=handoff.launch.role,childId=state['childId'],pipeId=state['pipeId'],
                    lifecycle=state['lifecycle'],inheritedFDs=[0,1,2,3,4],
                    currentFDs=[dict(row) for row in sorted(state['rows'],key=lambda row:row['fd'])])

    def inspect_runtime(self,original_handoff,lifecycle,runtime_owner):
        state=self._runtime_owners.get(id(original_handoff))
        if not state or state['handoff'] is not original_handoff or state['owner'] is not runtime_owner or state['lifecycle']!=lifecycle or _ownership_facts(original_handoff._owned)!=state['facts']: _fail('AUTHORITY_LOST')
        h=original_handoff;s=self._owned.get(h._owned)
        if not s or s['terminal'] is not None or s['child']!=h.attestation.pid: _fail('AUTHORITY_LOST')
        # No bootstrap-side fstat: the rows are the inherited capture plus the last
        # bracketed PROXY observation, and _native_observe re-reads every one of
        # them from the child's own /proc/<pid>/fd and fdinfo.
        rows=tuple(sorted(state['rows'],key=lambda row:row['fd']))
        facts=_native_observe(self.b,h.attestation.pid,s['launch'],s['digest'],{},lifecycle=='WAITING',current_fds=rows)
        _check(_attestation(facts),h.launch,waiting=lifecycle=='WAITING')
        executable=self.b.os.stat('/proc/'+str(h.attestation.pid)+'/exe')
        if (executable.st_dev,executable.st_ino)!=s['exec_identity']: _fail('PROGRAM_DENIED')
        return validate_runtime_observation(dict(role=h.launch.role,
            childId=state['childId'],pipeId=state['pipeId'],lifecycle=lifecycle,
            inheritedFDs=[0,1,2,3,4],currentFDs=[dict(row) for row in rows]),
            h,lifecycle,_allow_proxy_pre_listener=(
                h.launch.role=='PROXY' and not any(
                    row['kind']=='PROXY_LISTENER' for row in rows)))

    def runtime_lifecycle(self,original_handoff,runtime_owner):
        """Return only the lifecycle retained with the original acquisition."""
        state=self._runtime_owners.get(id(original_handoff))
        if (not state or state['handoff'] is not original_handoff
                or state['owner'] is not runtime_owner
                or state['lifecycle'] not in ('WAITING','SERVICE','BROWSER_ACTIVE')
                or _ownership_facts(original_handoff._owned)!=state['facts']):
            _fail('AUTHORITY_LOST')
        return state['lifecycle']

    def _commit_browser_runtime(self,preparation):
        if type(preparation) is not BootstrapBrowserPreparation or not preparation._committed or preparation._roles._preparation is not preparation: _fail('AUTHORITY_LOST')
        handoff=preparation._child;state=self._runtime_owners.get(id(handoff))
        if not state or state['handoff'] is not handoff or handoff._kernel is not self or state['lifecycle']!='WAITING': _fail('AUTHORITY_LOST')
        state['lifecycle']='BROWSER_ACTIVE'

    def write_role(self,owned,data):
        state=self._owned.get(owned)
        if state is None or state['terminal'] is not None or type(data) is not bytes or not 0<len(data)<=16388: _fail('CHANNEL_DENIED')
        # No caller FD/PID; only the retained original physical command end.
        offset=0;end=self.b.monotonic()+1
        while offset<len(data) and self.b.monotonic()<end:
            _,ready,_=self.b.select([],[owned.command],[],0.01)
            if ready:
                count=self.b.os.write(owned.command,data[offset:])
                if type(count) is not int or count<=0: _fail('CHANNEL_DENIED')
                offset+=count
        if offset!=len(data): _fail('CHANNEL_DENIED')

    def read_role(self,owned,remaining_ms):
        state=self._owned.get(owned)
        if state is None or state['terminal'] is not None: _fail('CHANNEL_DENIED')
        remaining_ms=min(_v1_int(remaining_ms,0),1000)
        end=self.b.monotonic()+remaining_ms/1000
        header=self._read_exact(owned.result,4,remaining_ms,eof_code='CHANNEL_EOF')
        count=struct.unpack('>I',header)[0]
        if not 0<count<=16384: _fail('FRAME_DENIED')
        return header+self._read_exact(owned.result,count,max(0,int((end-self.b.monotonic())*1000)),eof_code='CHANNEL_EOF')

    def write_proxy_frame(self,owned,data):
        """One PROXY v2 FD3 frame (two-byte length, 1..4096 bytes) or the bare STOP.

        The class writer, never a per-instance replacement: only the retained
        original physical command end of the original PROXY child.
        """
        if (type(data) is not bytes or getattr(owned,'role',None)!='PROXY'
                or not (data==b'STOP' or (len(data)>=3 and int.from_bytes(data[:2],'big')==len(data)-2<=4096))):
            _fail('CHANNEL_DENIED')
        NativeKernelPort.write_role(self,owned,data)

    def read_proxy_frame(self,owned,remaining_ms):
        """One PROXY v2 FD4 frame: a two-byte length, then 1..16384 bytes (amendment 6.1).

        Only the retained original result end; same bounds as read_role otherwise.
        """
        state=self._owned.get(owned)
        if state is None or state['terminal'] is not None or owned.role!='PROXY': _fail('CHANNEL_DENIED')
        remaining_ms=min(_v1_int(remaining_ms,0),1000)
        end=self.b.monotonic()+remaining_ms/1000
        header=self._read_exact(owned.result,2,remaining_ms,eof_code='CHANNEL_EOF')
        count=int.from_bytes(header,'big')
        if not 0<count<=16384: _fail('FRAME_DENIED')
        return header+self._read_exact(owned.result,count,max(0,int((end-self.b.monotonic())*1000)),eof_code='CHANNEL_EOF')

    def poll_role(self,owned):
        if type(owned) is not NativeOwned or owned.result is None:_fail('HANDOFF_DENIED')
        try:ready,_,_=self.b.select([owned.result],[],[],0)
        except Exception:_fail('CHANNEL_EOF')
        if type(ready) is not list or any(endpoint is not owned.result and endpoint!=owned.result for endpoint in ready):_fail('CHANNEL_EOF')
        return bool(ready)

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

    def _read_exact(self,fd,count,deadline,*,eof_code='ROLE_START_FAILED'):
        until=self.b.monotonic()+deadline/1000; data=bytearray()
        while len(data)<count and self.b.monotonic()<until:
            ready,_,_=self.b.select([fd],[],[],min(0.01,max(0,until-self.b.monotonic())))
            if ready:
                part=self.b.os.read(fd,count-len(data))
                if not part: _fail(eof_code)
                data.extend(part)
        if len(data)!=count: _fail('ROLE_START_FAILED')
        return bytes(data)

    def inspect(self,pid):
        states=[s for owned,s in self._owned.items() if owned.pid==pid and s['terminal'] is None]
        if len(states)!=1 or states[0].get('child')!=pid: _fail('ATTESTATION_FAILED')
        s=states[0]
        runtimes=[r for r in self._runtime_owners.values() if r['handoff'].attestation.pid==pid]
        if runtimes:
            if len(runtimes)!=1:_fail('AUTHORITY_LOST')
            runtime=runtimes[0]
            observed=self.inspect_runtime(runtime['handoff'],runtime['lifecycle'],runtime['owner'])
            a=_native_observe(self.b,pid,s['launch'],s['digest'],{},runtime['lifecycle']=='WAITING',current_fds=observed['currentFDs'])
        else:a=_native_observe(self.b,pid,s['launch'],s['digest'],{},True)
        executable=self.b.os.stat('/proc/'+str(pid)+'/exe')
        if (executable.st_dev,executable.st_ino)!=s.get('exec_identity'): _fail('PROGRAM_DENIED')
        links=tuple(self.b.os.readlink('/proc/'+str(pid)+'/fd/'+str(fd)) for fd in (3,4))
        if links!=s['links']: _fail('FD_DENIED')
        return a

    def _exit(self,owned,deadline,stop):
        if type(deadline) is not int or not 0<=deadline<=1200000:_fail('EXIT_DENIED')
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
        first=True
        while first or self.b.monotonic()<until:
            first=False
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
            if self.b.monotonic()<until:self.b.sleep(min(0.01,max(0,until-self.b.monotonic())))
        return {'status':'TIMEOUT','pid':owned.pid,'run_id':owned.run_id}

    def terminal_receipt(self,owned):
        """The cached terminal receipt of one original child, or None. Read-only; no wait."""
        state=self._owned.get(owned)
        if state is None: _fail('EXIT_DENIED')
        return None if state['terminal'] is None else dict(state['terminal'])

    def wait_owned(self,owned,deadline): return self._exit(owned,deadline,False)
    def stop_owned(self,owned,deadline): return self._exit(owned,deadline,True)


if __name__ == '__main__':
    # Import/CLI cannot fall back to the macOS host or manufacture runtime proof.
    raise SystemExit(78)

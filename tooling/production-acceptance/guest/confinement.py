"""Offline Task 8 confinement policy and trusted, injected bootstrap boundary.

No native adapter/default exists here. No import, CLI, or test can load libc,
call a syscall, fork, exec, change credentials/mounts, or create a socket.
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
    """Future native implementation must uphold these effect contracts.

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
            a = inspect_role(self.attestation.pid,kernel=self._kernel)
            _check(a,self.launch,waiting=a.waiting)
            result = operation(self._owned, deadline)
            if type(result) is not dict or set(result) != {'status','pid','run_id'} or result['status'] not in ('EXITED','STOPPED','TIMEOUT') or type(result['pid']) is not int or result['pid'] != self.attestation.pid or result['run_id'] != self.launch.run_id:
                _fail('EXIT_DENIED')
            return MappingProxyType(dict(result))
        except Exception: _fail('EXIT_DENIED')
    def wait_exit(self, deadline): return self._exit(self._kernel.wait_owned, deadline)
    def stop_owned(self, deadline): return self._exit(self._kernel.stop_owned, deadline)


def start_roles(config):
    if type(config) is not BootstrapConfig or config.kernel is None: _fail('KERNEL_PORT_REQUIRED')
    k = config.kernel
    if any(not callable(getattr(k,n,None)) for n in ('spawn_waiting','inspect','wait_owned','stop_owned')): _fail('KERNEL_PORT_REQUIRED')
    # Validate the entire fixed four-role launch plan before the first effect.
    launches = tuple(prepare_role(role,RoleConfig(config,role_fds(role,config.run_id))) for role in UIDS)
    owned_children, handoffs = [], {}
    try:
        for launch in launches:
            try:
                owned = k.spawn_waiting(launch, lambda port, launch=launch: exec_role(launch,kernel=port))
            except RoleStartFailure as error:
                owned_children.append(error.owned)
                raise
            owned_children.append(owned)
            a = inspect_role(owned.pid,kernel=k)
            if owned.run_id != launch.run_id or owned.role != launch.role or owned.command is owned.result or owned.command is None or owned.result is None: _fail('HANDOFF_DENIED')
            _check(a,launch,waiting=True)
            handoffs[launch.role] = RoleHandoff(launch,a,k,owned)
    except Exception:
        cleanup_failed = False
        for owned in reversed(owned_children):
            try:
                result = k.stop_owned(owned,120000)
                if type(result) is not dict or result.get('status') not in ('STOPPED','EXITED') or result.get('pid') != owned.pid or result.get('run_id') != config.run_id: cleanup_failed = True
            except Exception: cleanup_failed = True
        _fail('REAP_UNCERTAIN' if cleanup_failed else 'BOOTSTRAP_FAILED')
    return MappingProxyType(handoffs)


if __name__ == '__main__':
    # Import/CLI cannot fall back to the macOS host or manufacture runtime proof.
    raise SystemExit(78)

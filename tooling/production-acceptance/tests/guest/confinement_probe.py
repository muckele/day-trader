"""Finite, separately gated adversarial Linux guest probes. No native default.

run_case invokes only an explicitly injected trusted ProbePort. Offline doubles
may test observation validation; their output is NOT kernel/runtime evidence.
NativeProbeFixtures takes only the sealed NativeKernelPort; OfflineProbeFixtures
the offline port. An epoch says which it came from and offline is never native.
The independently approved native harness must demonstrate each actual
attempt, denial at kernel/FD boundary, and owned receiver observation. Absence
of that harness is a failed/unavailable gate, never a skipped or mocked PASS.

Every result names its basis (BASIS): how the probe itself established it.
KERNEL_ERRNO is an accepted denial errno from the attempted call; it does not
tell the outer filter from DAC, a sysctl or an LSM (T8-12). The BROWSER filter
allows capset, the set*id family and chroot (E1), so those denials are the
kernel's capability check, KERNEL_CREDENTIAL_CHECK (P27, P48). The bootstrap
contract and TSYNC cases re-check library code in a probe family, not a
kernel/FD boundary: LIBRARY_RECHECK (T8-13). SECCOMP_KILL is a SIGSYS death of
the alternate-entry sample; for AArch32 the outcome decides (P53): a SIGSYS
death after the sample started is SECCOMP_ARCH_KILL, and an ENOEXEC exec refusal
observed in this module's own pre-exec child is AARCH32_EXEC_UNAVAILABLE (no
AArch32 process can exist: no CONFIG_COMPAT, or no 32-bit EL0 on the CPU).
OBSERVED is the probe's own observation of /proc, its descriptor table or the
outcome.

Residual fixture trust (compA M-8), recorded, not resolved: for exec-helper
positions (basis HELPER_EXIT) "attempted" and "denied" rest only on the pinned
sample's own FD4 marker and its exit code 23. The IP families have no audit
correlation and the receiver after-count proves only non-delivery, so a sample
that writes ATTEMPTED and exits 23 without attempting reads as DENIED. Add
seccomp/audit correlation for helper attempts before Stage 2 relies on them.
Likewise a pinned AArch32 sample that ends with exit 24 and no marker reads as
AARCH32_EXEC_UNAVAILABLE (review M-5).

Residual native fixture trust of the UNIX-name probes (P54), recorded, not
resolved: before and after each donor or trusted-name family the trusted parent
asks the fixture authority's confirm_reachable(name) whether that name exists
and is reachable from outside the family (the donor listening and ready to send
its descriptor, the trusted name accepting a connection); a False answer is
FIXTURE_UNAVAILABLE, so the family's ENOENT/ECONNREFUSED counts as isolation
only for a confirmed target. The probe cannot observe that control itself: it
trusts the authority's answer and the donor's promise to send one descriptor.
"""
from collections import namedtuple
import dataclasses
from dataclasses import replace
import hashlib
import importlib.util
import ipaddress
import json
import pathlib
import re
import secrets
import struct
import sys
import threading
import weakref
from types import MappingProxyType

ProbeCase = namedtuple('ProbeCase', 'operations denied receiver_count')

# Fixed step for a routine (non-terminal) probe-family stop or helper reap. It
# never starts the shared cleanup end (C1); topology.PROBE_FAMILY_STOP_MS mirrors it.
PROBE_FAMILY_STOP_MS = 2000

# Linux 6.8 AArch64 errno and signal values the probes compare, and the
# ancillary level/type they parse (Task 10, ABI-PIPELINE). abi_coverage_test
# binds each name to its coverage v2 symbol; no other errno or signal literal is
# compared or raised in this module.
_EPERM = 1
_ENOENT = 2
_ENOEXEC = 8
_EACCES = 13
_ENOTSOCK = 88
_ECONNREFUSED = 111
_SIGSYS = 31
_SOL_SOCKET = 1
_SCM_RIGHTS = 1

# Accepted denial errnos. EBADF is never a denial: a closed or absent
# descriptor proves nothing about the boundary (T8-01).
_KERNEL_DENIAL = (_EPERM, _EACCES)
# P27, P48: the kernel's capability check answers EPERM.
_CREDENTIAL_DENIAL = (_EPERM,)
# The node is absent from the role's view.
_ABSENT_OR_DENIED = (_EPERM, _EACCES, _ENOENT)
# No reachable listener of that UNIX name: absent path or unbound abstract name.
# Counted as isolation only after the parent's positive control (P54).
_UNIX_REFUSED = (_EPERM, _EACCES, _ENOENT, _ECONNREFUSED)
# P52: reopening another process's descriptor through its /proc magic link,
# following the link (never O_NOFOLLOW: an fd entry is S_IFLNK,
# linux-6.8/fs/proc/fd.c:206, and may_open answers ELOOP, fs/namei.c:3247-3248).
# The 6.8 kernel refuses a non-owner with EACCES: the fd directory is
# S_IRUSR|S_IXUSR (fs/proc/base.c:3250) and proc_fd_permission
# (fs/proc/fd.c:332-349) falls back to generic_permission (fs/namei.c:400,
# -EACCES :442) unless same_thread_group (:343-344); following the link,
# proc_pid_get_link (fs/proc/base.c:1738-1759) answers -EACCES unless
# proc_fd_access_allowed (:674-688, ptrace_may_access READ_FSCREDS). A pid not
# visible in the caller's /proc namespace is ENOENT (proc_pid_lookup,
# fs/proc/base.c:3449, :3458-3462). Nothing else; ELOOP and EPERM are not refusals.
_PROC_FD_REFUSED = (_EACCES, _ENOENT)

# R13 layout literals (LP64 AArch64), each justified in abi_coverage_test
# LAYOUT_LITERALS. _FRAME_LENGTH is this module's own frame prefix, not Linux ABI.
_IOVEC = '<QQ'
_USER_MSGHDR = '<Qi4xQQQQI4x'
_CMSGHDR = '<Qii'
_SCM_FD = '<i'
_SOCKADDR_UN = '<H108s'
_SOCKADDR_VM = '<HHIIB3x'
_SOCKADDR_IN = '<H2s4s8x'
_SOCKADDR_IN6 = '<H2sI16sI'
_CAPSET_HEADER = '<II'
_CAPSET_DATA = '<6I'
_FRAME_LENGTH = '<I'
_MSG_IOV = 16
_MSG_CONTROL = 32
_CMSG_ONE_FD = 24
_SUN_PATH_OFFSET = 2
_SUN_PATH_BYTES = 108

THEFT_OPERATIONS = ('proc-enumeration-family-only', 'controller-SCM_RIGHTS', 'proxy-SCM_RIGHTS',
                    'trusted-unix-names-unreachable', 'proc-controller-fd', 'proc-proxy-fd', 'pidfd_open-getfd',
                    'ptrace-attach', 'ptrace-seize', 'process_vm_readv', 'process_vm_writev')

PROBES = MappingProxyType({
    'vsock_browser_controller_verifier_denied': ProbeCase(tuple(
        role+'.'+op for role in ('BROWSER','CONTROLLER','VERIFIER') for op in ('socket-AF_VSOCK','socketpair-AF_VSOCK')),True,0),
    'child_fork_exec_network_gpu_crash_helper_inherits': ProbeCase(tuple(
        'BROWSER.'+kind+'.socket-AF_VSOCK' for kind in ('parent','fork','exec','network','gpu','crash'))+
        ('CONTROLLER.helper.socket-AF_VSOCK','VERIFIER.helper.socket-AF_VSOCK'),True,0),
    'proxy_fixed_vsock_positive': ProbeCase(('PROXY.fixed-vsock-CID2-port4050',),False,1),
    'io_uring_setup_register_enter_and_inherited_ring_denied': ProbeCase(tuple(
        role+'.'+op for role in ('CONTROLLER','BROWSER','VERIFIER','PROXY') for op in
        ('io_uring_setup','io_uring_register','io_uring_enter','inherited-ring')),True,0),
    # T8-02: on AArch64 the only alternate audit arch is AArch32 compat; an
    # x86_64 or unknown-arch attempt cannot be made, so those cases are gone.
    'alternate_ABI_denied': ProbeCase(('BROWSER.AArch32-audit','BROWSER.alternate-syscall-entry'),True,0),
    'SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied': ProbeCase(tuple(
        'BROWSER.'+op for op in THEFT_OPERATIONS),True,0),
    'privilege_gain_denied': ProbeCase(('BROWSER.setuid-helper','BROWSER.capability-file',
        'BROWSER.initial-namespace-capability','BROWSER.setresuid-root','BROWSER.chroot-initial-namespace'),True,0),
    'no_console_or_bridge_fd': ProbeCase(tuple(role+'.'+op for role in ('BROWSER','VERIFIER','PROXY') for op in
        ('dev-console-open','dev-hvc-open','proc-console-reopen','unaudited-bridge-fd')),True,0),
    'bootstrap_arbitrary_argv_denied': ProbeCase(('BROWSER.arbitrary-executable','BROWSER.arbitrary-argv','BROWSER.arbitrary-uid','BROWSER.arbitrary-fd'),True,0),
    'TSYNC_failure_abort': ProbeCase(('BOOTSTRAP.invalid-filter-einval','BOOTSTRAP.TSYNC-unsynchronized-tid'),True,0),
    'exact_fd_inventory': ProbeCase(tuple(role+'.exact-uid-capability-view-fd-inventory' for role in
        ('CONTROLLER','BROWSER','VERIFIER','PROXY')),False,0),
    **{'child_fork_exec_network_gpu_crash_helper_'+family.lower(): ProbeCase(tuple(
        'BROWSER.'+position+'.socket-'+family+'-TCP' for position in
        ('parent','fork','exec','network','gpu','crash'))+tuple(
        role+'.helper.socket-'+family+'-TCP' for role in ('CONTROLLER','VERIFIER')),True,0)
        for family in ('IPV4','IPV6')},
    'fixed_ip_denied': ProbeCase(('BROWSER.socket-IPV4-TCP','BROWSER.socket-IPV6-TCP',
        'BROWSER.socket-IPV4-UDP','CONTROLLER.DNS-TCP','CONTROLLER.DNS-UDP',
        'VERIFIER.socket-IPV4-TCP'),True,0),
    # P49: the only native evidence, before a real Chromium start, that a
    # BROWSER family may create its own user namespace after seccomp (E-1).
    'browser_user_namespace_available': ProbeCase(('BROWSER.unshare-CLONE_NEWUSER',),False,0),
})

HELPER_SAMPLES = MappingProxyType({
    **{position+'.socket-'+family: sample+'-'+suffix
       for family,suffix in (('AF_VSOCK','vsock'),('IPV4-TCP','ipv4'),('IPV6-TCP','ipv6'))
       for position,sample in (('exec','exec'),('helper','exec'),('network','chromium-network'),
                               ('gpu','chromium-gpu'),('crash','chromium-crash'))},
    'AArch32-audit':'aarch32-syscall','alternate-syscall-entry':'alternate-entry',
    'setuid-helper':'setuid-attempt','capability-file':'capability-attempt',
})

# The basis of each operation's result (module docstring). AArch32-audit alone
# may instead be AARCH32_EXEC_UNAVAILABLE, decided by the observed outcome (P53).
BASIS = MappingProxyType({
    **{name: 'KERNEL_ERRNO' for name in (
        'socket-AF_VSOCK','socketpair-AF_VSOCK','io_uring_setup','io_uring_register','io_uring_enter',
        'parent.socket-AF_VSOCK','parent.socket-IPV4-TCP','parent.socket-IPV6-TCP',
        'controller-SCM_RIGHTS','proxy-SCM_RIGHTS','trusted-unix-names-unreachable','proc-controller-fd',
        'proc-proxy-fd','pidfd_open-getfd','ptrace-attach','ptrace-seize','process_vm_readv','process_vm_writev',
        'dev-console-open','dev-hvc-open','proc-console-reopen',
        'socket-IPV4-TCP','socket-IPV6-TCP','socket-IPV4-UDP','DNS-TCP','DNS-UDP')},
    **{position+'.socket-'+family: 'HELPER_EXIT' for family in ('AF_VSOCK','IPV4-TCP','IPV6-TCP')
       for position in ('fork','exec','network','gpu','crash','helper')},
    'setuid-helper': 'HELPER_EXIT', 'capability-file': 'HELPER_EXIT',
    'AArch32-audit': 'SECCOMP_ARCH_KILL', 'alternate-syscall-entry': 'SECCOMP_KILL',
    **{name: 'KERNEL_CREDENTIAL_CHECK' for name in (
        'initial-namespace-capability','setresuid-root','chroot-initial-namespace')},
    **{name: 'LIBRARY_RECHECK' for name in (
        'arbitrary-executable','arbitrary-argv','arbitrary-uid','arbitrary-fd',
        'invalid-filter-einval','TSYNC-unsynchronized-tid')},
    **{name: 'OBSERVED' for name in (
        'fixed-vsock-CID2-port4050','inherited-ring','proc-enumeration-family-only',
        'unaudited-bridge-fd','exact-uid-capability-view-fd-inventory','unshare-CLONE_NEWUSER')},
})
BASES = frozenset(BASIS.values()) | {'AARCH32_EXEC_UNAVAILABLE'}

# The one operation the bootstrap-side parent observes itself (T8-03).
_PARENT_OBSERVED = 'exact-uid-capability-view-fd-inventory'


def allowed_bases(name):
    """The bases a result of NAME may carry: its own, and for AArch32-audit also the
    observed exec refusal (P53; the outcome decides, no kernel-feature answer)."""
    return (BASIS[name],'AARCH32_EXEC_UNAVAILABLE') if name == 'AArch32-audit' else (BASIS[name],)


def _denial_errnos(name):
    if name in ('initial-namespace-capability','setresuid-root','chroot-initial-namespace'): return _CREDENTIAL_DENIAL
    if name=='proc-console-reopen': return _PROC_FD_REFUSED
    if name in ('dev-console-open','dev-hvc-open'): return _ABSENT_OR_DENIED
    if name in ('controller-SCM_RIGHTS','proxy-SCM_RIGHTS','trusted-unix-names-unreachable'): return _UNIX_REFUSED
    return _KERNEL_DENIAL


def _sockaddr_vm():
    """struct sockaddr_vm of the fixed host broker: AF_VSOCK, port 4050, VMADDR_CID_HOST."""
    return struct.pack(_SOCKADDR_VM,40,0,4050,2,0)


def _unix_address(name):
    """(struct sockaddr_un, exact address length) for an abstract ('\\0'-prefixed)
    or absolute path name; a path carries its terminating NUL. Else unavailable."""
    if type(name) is not str or not name.isascii() or name[:1] not in ('\0','/') or (name[0] == '/' and '\0' in name):
        raise RuntimeGateUnavailable('UNIX_NAME_UNAVAILABLE')
    raw = name.encode('ascii')+(b'' if name[0] == '\0' else b'\0')
    if not len(raw) <= _SUN_PATH_BYTES or len(raw) < 2: raise RuntimeGateUnavailable('UNIX_NAME_UNAVAILABLE')
    return struct.pack(_SOCKADDR_UN,1,raw),_SUN_PATH_OFFSET+len(raw)


def _confinement():
    # Exactly topology's shared module instance, never a competing binding type.
    name = '_acceptance_topology_confinement'
    if name not in sys.modules:
        path = pathlib.Path(__file__).resolve().parents[2] / 'guest/confinement.py'
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


def receiver_shape(operation):
    if not any(operation in case.operations for case in PROBES.values()):
        raise ProbeFailure('RECEIVER_OPERATION_DENIED')
    if 'IPV6' in operation: return 'IPV6','TCP',443
    if 'DNS-' in operation: return 'IPV4',operation.rsplit('-',1)[1],53
    if 'IPV4' in operation: return 'IPV4','UDP' if operation.endswith('-UDP') else 'TCP',443
    return 'VSOCK','VSOCK',4050


class ReceiverBinding(namedtuple('_ReceiverBinding',
        'binding probeId operationId family transport port numericEndpoint sampleDigest')):
    """Exact immutable receiver identity; the independent channel authenticates it."""
    __slots__ = ()
    def __new__(cls, binding, probeId, operationId, family, transport, port, numericEndpoint, sampleDigest):
        if (type(binding) is not _confinement().CompositionBinding
                or type(probeId) is not str or probeId not in PROBES
                or type(operationId) is not str or operationId not in PROBES[probeId].operations
                or (family,transport,port) != receiver_shape(operationId) or type(port) is not int
                or type(numericEndpoint) is not str or type(sampleDigest) is not str
                or re.fullmatch('[0-9a-f]{64}',sampleDigest) is None):
            raise ProbeFailure('RECEIVER_BINDING_DENIED')
        try:
            if family == 'VSOCK':
                if numericEndpoint != '2': raise ValueError()
            else:
                address = ipaddress.ip_address(numericEndpoint)
                if (str(address) != numericEndpoint or address.version != (4 if family == 'IPV4' else 6)
                        or address.is_unspecified or address.is_multicast
                        or '%' in numericEndpoint): raise ValueError()
        except ValueError: raise ProbeFailure('RECEIVER_ENDPOINT_DENIED') from None
        return super().__new__(cls,binding,probeId,operationId,family,transport,port,numericEndpoint,sampleDigest)

    def to_record(self):
        return dict(self._asdict(), binding=self.binding.to_record())

    def address_bytes(self):
        if self.family == 'VSOCK': return _sockaddr_vm()
        packed = ipaddress.ip_address(self.numericEndpoint).packed
        port = self.port.to_bytes(2,'big') # sin_port / sin6_port are network order
        if self.family == 'IPV4': return struct.pack(_SOCKADDR_IN,2,port,packed)
        return struct.pack(_SOCKADDR_IN6,10,port,0,packed,0)


class ReceiverAuthority:
    """Original private observation channel plus separately approved inventory.

    The trusted embedding supplies both; no native factory or fallback exists.
    An injected channel is only offline contract evidence, never native approval.
    """
    def __init__(self, inventory, channel):
        if (type(inventory) is not tuple or not inventory or any(type(row) is not ReceiverBinding for row in inventory)
                or not callable(getattr(channel,'approve_inventory',None))
                or not callable(getattr(channel,'observe',None))):
            raise RuntimeGateUnavailable('RECEIVER_FIXTURES_UNAVAILABLE')
        expected = tuple((name,op) for name,case in PROBES.items() for op in case.operations)
        if tuple((row.probeId,row.operationId) for row in inventory) != expected:
            raise ProbeFailure('RECEIVER_INVENTORY_DENIED')
        for row in inventory: ReceiverBinding(*row) # tuple factories cannot bypass strict validation
        if any(row.binding != inventory[0].binding for row in inventory): raise ProbeFailure('RECEIVER_BINDING_DENIED')
        if channel.approve_inventory(inventory) is not channel:
            raise RuntimeGateUnavailable('RECEIVER_FIXTURES_UNAPPROVED')
        self._inventory,self._channel = inventory,channel
        self._claimed,self._sequence,self._active = False,0,None
        self._lock = threading.Lock()
        self.digest = hashlib.sha256(json.dumps([row.to_record() for row in inventory],sort_keys=True,separators=(',',':')).encode('ascii')).hexdigest()

    def claim(self, binding):
        with self._lock:
            if self._claimed or self._inventory[0].binding != binding:
                raise ProbeFailure('RECEIVER_EPOCH_DENIED')
            self._claimed = True

    def observe(self, receiver, nonce, phase):
        with self._lock:
            if (not self._claimed or not any(receiver is row for row in self._inventory)
                    or type(nonce) is not str or re.fullmatch('[0-9a-f]{32}',nonce) is None
                    or phase not in ('BEFORE','AFTER')):
                raise ProbeFailure('RECEIVER_OBSERVATION_DENIED')
            if phase == 'BEFORE':
                if self._active is not None: raise ProbeFailure('RECEIVER_SEQUENCE_DENIED')
                self._active = (receiver, nonce)
            elif self._active != (receiver,nonce): raise ProbeFailure('RECEIVER_SEQUENCE_DENIED')
            self._sequence += 1
            request = dict(receiver=receiver.to_record(), nonce=nonce, sequence=self._sequence, phase=phase)
            expected = json.loads(json.dumps(request))
        # The independent callback cannot extend its two-second observation bound.
        done, outcome = threading.Event(), []
        def invoke():
            try: outcome.append(self._channel.observe(request, 2000))
            except BaseException: outcome.append(None)
            finally: done.set()
        threading.Thread(target=invoke, daemon=True).start()
        if not done.wait(2): raise ProbeFailure('RECEIVER_OBSERVATION_TIMEOUT')
        row = outcome[0]
        if (type(row) is not dict or set(row) != set(expected)|{'healthy','terminal','count'}
                or json.dumps({key:row[key] for key in expected},sort_keys=True,separators=(',',':'))
                   != json.dumps(expected,sort_keys=True,separators=(',',':'))
                or type(row['sequence']) is not int or row['healthy'] is not True
                or row['terminal'] is not (phase == 'AFTER')
                or type(row['count']) is not int or not 0 <= row['count'] <= 1):
            raise ProbeFailure('RECEIVER_OBSERVATION_DENIED')
        if phase == 'AFTER': self._active = None
        return row['count']


_EPOCH_SEAL = object()
# Each minted epoch -> the exact values it was minted with (Task 9 review I-1).
_EPOCHS = weakref.WeakKeyDictionary()


class CompletedProbeEpoch:
    """Only the completed original-fixture sequence can mint this sealed value.

    `native` is its provenance (compA part A note): True only for an epoch that
    qualify_probe_epoch minted from NativeProbeFixtures anchored to this module's
    own confinement module and its sealed NativeKernelPort, False from offline
    ones. It is read only through a verified minted epoch: never one built with
    object.__new__, nor one whose fields were set after minting.
    """
    __slots__ = ('binding','cases','task10_projection','fixture_inventory_digest','digest','family_proofs','_native',
                 '__weakref__')
    def __init__(self, *args, _seal=None):
        if _seal is not _EPOCH_SEAL: raise ProbeFailure('PROBE_EPOCH_DENIED')
        if len(args) != 7 or type(args[6]) is not bool: raise ProbeFailure('PROBE_EPOCH_DENIED')
        for key,value in zip(self.__slots__[:7],args): object.__setattr__(self,key,value)
        _EPOCHS[self] = args

    def __setattr__(self, name, value): raise AttributeError('immutable completed epoch')

    def _minted(self):
        # An object.__new__ epoch was never minted; a field set afterwards with
        # object.__setattr__ is no longer the minted object.
        record = _EPOCHS.get(self)
        if record is None or any(getattr(self,key,None) is not value for key,value in zip(self.__slots__[:7],record)):
            raise ProbeFailure('PROBE_EPOCH_DENIED')
        return self

    @property
    def native(self):
        return self._minted()._native

    def require_current(self, binding, fixture_digest, wall_ms):
        self._minted()
        if (type(self) is not CompletedProbeEpoch
                or type(binding) is not _confinement().CompositionBinding or binding != self.binding
                or fixture_digest != self.fixture_inventory_digest or type(wall_ms) is not int
                or not 0 <= wall_ms < binding.expiresAtMs
                or any(not owner.proven for owner in self.family_proofs)):
            raise ProbeFailure('PROBE_EPOCH_DENIED')
        return self


def _anchored_native(fixtures):
    """Native provenance only over this module's own confinement module (topology's
    instance) and its sealed NativeKernelPort, never a caller-supplied module
    (Task 9 review I-1)."""
    anchor = _confinement()
    return (type(fixtures) is NativeProbeFixtures and fixtures.c is anchor
            and type(fixtures.kernel) is anchor.NativeKernelPort)


def qualify_probe_epoch(binding, fixtures, cleanup_budget):
    if (type(binding) is not _confinement().CompositionBinding
            or type(fixtures) not in (NativeProbeFixtures, OfflineProbeFixtures)
            or type(getattr(fixtures,'receivers',None)) is not ReceiverAuthority
            or not callable(getattr(getattr(fixtures,'clock',None),'sample',None))
            or not callable(getattr(cleanup_budget,'call',None))
            or not callable(getattr(cleanup_budget,'remaining',None))
            or not callable(getattr(cleanup_budget,'routine_call',None))
            or type(getattr(cleanup_budget,'started',None)) is not bool):
        raise RuntimeGateUnavailable('PROBE_EPOCH_UNAVAILABLE')
    # A NativeProbeFixtures that skipped its constructor, or whose module or kernel
    # is not the anchored sealed port, mints nothing, before any effect.
    native = _anchored_native(fixtures)
    if type(fixtures) is NativeProbeFixtures and not native:
        raise RuntimeGateUnavailable('NATIVE_FIXTURES_UNAVAILABLE')
    if fixtures.config.run_id != binding.runId or fixtures._epoch_started:
        raise ProbeFailure('PROBE_EPOCH_DENIED')
    fixtures._epoch_started = True
    fixtures.cleanup_budget = cleanup_budget
    receivers = fixtures.receivers
    receivers.claim(binding)
    # Check the approved sample inventory in the original parent before any
    # child. Opening/retained-FD verification still occurs at actual helper use.
    for receiver in receivers._inventory:
        name = receiver.operationId.partition('.')[2]
        if name in HELPER_SAMPLES:
            pin = fixtures.authority.helper_pin(name)
            if pin is None: raise RuntimeGateUnavailable('HELPER_SAMPLE_UNAVAILABLE')
            if (getattr(pin,'path',None) != '/opt/acceptance/tests/fixtures/'+HELPER_SAMPLES[name]
                    or getattr(pin,'sha256',None) != receiver.sampleDigest):
                raise ProbeFailure('HELPER_PIN_MISMATCH')
    last, monotonic_end = None, None
    def current():
        nonlocal last, monotonic_end
        sample = fixtures.clock.sample()
        if (type(sample) is not tuple or len(sample) != 2 or any(type(v) is not int or not 0 <= v <= 9007199254740991 for v in sample)
                or sample[0] >= binding.expiresAtMs or (last is not None and (sample[0] < last[0] or sample[1] < last[1]))):
            raise ProbeFailure('PROBE_EPOCH_EXPIRED')
        if monotonic_end is None:
            monotonic_end=sample[1]+binding.expiresAtMs-sample[0]
        if sample[1] >= monotonic_end: raise ProbeFailure('PROBE_EPOCH_EXPIRED')
        # Only a started (terminal) shared end forbids the next family.
        if cleanup_budget.started and not cleanup_budget.remaining():
            raise ProbeFailure('PROBE_CLEANUP_DEADLINE')
        last = sample
    port, cases, correlations = NativeProbePort(fixtures), [], []
    index = 0
    for name, case in PROBES.items():
        rows = []
        for operation in case.operations:
            current()
            receiver = receivers._inventory[index]; index += 1
            nonce = secrets.token_hex(16)
            before = receivers.observe(receiver, nonce, 'BEFORE')
            if before != 0: raise ProbeFailure('RECEIVER_BASELINE_DENIED')
            # Independent observation may consume time or revoke authority.
            # No family setup/acquisition may use the pre-callback sample.
            current()
            role,_,operation_name = operation.partition('.')
            def attempt(context):
                context.receiver_binding, context.nonce = receiver,nonce
                denied, basis = _outcome(port,operation_name,context)
                # A child cannot observe or claim an independent receiver count.
                return dict(operation=operation,attempted=True,denied=denied,receiver_count=0,basis=basis)
            row = fixtures.run_confined(role,operation,attempt)
            owner = fixtures.family_owners[-1]
            if not owner.proven or owner.operation != operation: raise ProbeFailure('PROBE_FAMILY_UNPROVED')
            after = receivers.observe(receiver,nonce,'AFTER')
            current()
            if (type(row) is not dict or set(row) != {'operation','attempted','denied','receiver_count','basis'}
                    or row['operation'] != operation or row['attempted'] is not True
                    or row['denied'] is not case.denied or type(row['receiver_count']) is not int
                    or row['receiver_count'] != 0 or after-before != case.receiver_count
                    or row['basis'] not in allowed_bases(operation_name)):
                raise ProbeFailure('PROBE_BOUNDARY_FAILED')
            rows.append((operation,True,case.denied,after-before,row['basis']))
            correlations.append((receiver.to_record(),nonce,before,after))
        cases.append((name,tuple(rows)))
    identifiers = ('BROWSER_FD_DONOR','BROWSER_HELPER_IPV4','BROWSER_HELPER_IPV6','BROWSER_IO_URING',
        'BROWSER_IPV4_TCP','BROWSER_IPV6_TCP','BROWSER_UDP','BROWSER_VSOCK','CONTROLLER_DNS_TCP',
        'CONTROLLER_DNS_UDP','PROXY_VSOCK_CONTROL','VERIFIER_IPV4_TCP')
    projection = tuple((name,True,'ALLOWED' if name == 'PROXY_VSOCK_CONTROL' else 'DENIED',
                        int(name == 'PROXY_VSOCK_CONTROL')) for name in identifiers)
    payload = dict(binding=binding.to_record(),cases=cases,receivers=correlations,fixtureInventoryDigest=receivers.digest,
        families=[dict(operation=owner.operation,pid=owner.owned.pid,runId=owner.owned.run_id,
                       exited=owner.exited,emptyScopes=owner.scopes,factsDigest=owner.facts_digest)
                  for owner in fixtures.family_owners])
    digest = hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode('ascii')).hexdigest()
    return CompletedProbeEpoch(binding,tuple(cases),projection,receivers.digest,digest,
                               tuple(fixtures.family_owners),native,_seal=_EPOCH_SEAL)


class ProbeFailure(ValueError):
    pass


class ProbeCleanupFailure(ProbeFailure):
    def __init__(self, cleanup):
        super().__init__('PROBE_CLEANUP_UNCERTAIN')
        self.cleanup = cleanup


class RuntimeGateUnavailable(RuntimeError):
    pass


class _HelperBoundaryDenied(PermissionError):
    """Raised only after the original helper's marker and exit/audit proof; its
    strerror is the basis that proof establishes."""


def _decode_child_result(data, operation, *, composition):
    """Bounded strict decoding before any result field has semantic effect."""
    def pairs(items):
        result={}
        for key,value in items:
            if key in result: raise ProbeFailure('PROBE_RESULT_DUPLICATE')
            result[key]=value
        return result
    def constant(value): raise ProbeFailure('PROBE_RESULT_INVALID')
    if type(data) is not bytes or not 0 < len(data) <= 512: raise ProbeFailure('PROBE_RESULT_LIMIT')
    try:
        result=json.loads(data.decode('ascii'),object_pairs_hook=pairs,parse_constant=constant)
    except (ValueError,UnicodeError,RecursionError):
        raise ProbeFailure('PROBE_RESULT_INVALID') from None
    if type(result) is not dict: raise ProbeFailure('PROBE_RESULT_INVALID')
    if result == {'unavailable':'HELPER_SAMPLE_UNAVAILABLE'}:
        raise RuntimeGateUnavailable('HELPER_SAMPLE_UNAVAILABLE')
    if result == {'failed':'PROBE_OPERATION_FAILED'}:
        raise ProbeFailure('PROBE_OPERATION_FAILED')
    fields={'attempted','denied','receiver_count','basis'}
    if composition or 'operation' in result: fields.add('operation')
    if (set(result) != fields
            or ('operation' in fields and (type(result['operation']) is not str or result['operation'] != operation))
            or result['attempted'] is not True or type(result['denied']) is not bool
            or type(result['receiver_count']) is not int or not 0 <= result['receiver_count'] <= 1
            or type(result['basis']) is not str or result['basis'] not in BASES):
        raise ProbeFailure('PROBE_RESULT_INVALID')
    return result


def run_case(name, port):
    """Validate finite attempted-operation records; never infer native execution."""
    if name not in PROBES or not callable(getattr(port,'attempt',None)):
        raise ProbeFailure('PROBE_UNAVAILABLE')
    case = PROBES[name]
    try: observations = port.attempt(case)
    except Exception: raise ProbeFailure('PROBE_OPERATION_FAILED') from None
    if type(observations) is not tuple or len(observations) != len(case.operations):
        raise ProbeFailure('PROBE_INCOMPLETE')
    for expected, actual in zip(case.operations,observations):
        if (type(actual) is not dict or set(actual) != {'operation','attempted','denied','receiver_count','basis'} or
            actual['operation'] != expected or actual['attempted'] is not True or actual['denied'] is not case.denied or
            type(actual['receiver_count']) is not int or actual['receiver_count'] != case.receiver_count or
            actual['basis'] not in allowed_bases(expected.partition('.')[2])):
            raise ProbeFailure('PROBE_BOUNDARY_FAILED')
    return observations


def _outcome(port, name, context):
    """(denied, basis) of one actual attempt, only from what that attempt raised."""
    try: port._operation(name,context)
    except OSError as error: return True,port._denial(name,error)
    return False,BASIS[name]


class NativeProbePort:
    """Execute the finite catalogue in fresh confined roles, not BPF simulation.

    Fixtures own the independent receiver and pinned executable/ABI samples.
    Missing native fixtures fail unavailable; a missing socket/invalid argument
    error is NOT reported as seccomp denial. Each attempt gets a fresh family.
    """
    def __init__(self, fixtures):
        if not callable(getattr(fixtures,'run_confined',None)): raise RuntimeGateUnavailable('NATIVE_FIXTURES_UNAVAILABLE')
        self.fixtures=fixtures

    @staticmethod
    def _denial(name,error):
        """The basis of an attempt that raised ERROR, else UNEXPECTED_KERNEL_ERROR.

        Only the operation's own accepted errnos deny; EBADF never does (T8-01).
        A helper's proven boundary carries the basis its proof established.
        """
        if type(error) is _HelperBoundaryDenied:
            if (BASIS[name] not in ('HELPER_EXIT','SECCOMP_KILL','SECCOMP_ARCH_KILL')
                    or error.strerror not in allowed_bases(name)): raise ProbeFailure('UNEXPECTED_KERNEL_ERROR') from None
            return error.strerror
        if error.errno not in _denial_errnos(name): raise ProbeFailure('UNEXPECTED_KERNEL_ERROR') from None
        return BASIS[name]

    def attempt(self,case):
        if not any(case is v for v in PROBES.values()): raise ProbeFailure('PROBE_DENIED')
        result=[]
        for operation in case.operations:
            role,_,name=operation.partition('.')
            def attempt(context,operation=operation,name=name):
                denied,basis=_outcome(self,name,context)
                return {'operation':operation,'attempted':True,'denied':denied,
                        'receiver_count':context.receiver_count(),'basis':basis}
            result.append(self.fixtures.run_confined(role,operation,attempt))
        return tuple(result)

    def _operation(self,name,ctx):
        if name in ('socket-IPV4-TCP','socket-IPV6-TCP','socket-IPV4-UDP','DNS-TCP','DNS-UDP'):
            return ctx.network_attempt()
        if name=='socket-AF_VSOCK': return ctx.syscall(198,40,1,0)
        if name=='socketpair-AF_VSOCK': return ctx.syscall(199,40,1,0,bytearray(8))
        if name=='io_uring_setup': return ctx.syscall(425,1,0)
        if name=='io_uring_register': return ctx.syscall(427,-1,0,0,0)
        if name=='io_uring_enter': return ctx.syscall(426,-1,0,0,0,0,0)
        if name=='inherited-ring':
            if any('io_uring' in link for link in ctx.fd_links()): raise ProbeFailure('INHERITED_RING_PRESENT')
            raise PermissionError(_EPERM,'FD_INVENTORY_BOUNDARY')
        if name=='fixed-vsock-CID2-port4050':
            fd=ctx.syscall(198,40,1,0)
            try:
                address=_sockaddr_vm()
                ctx.syscall(203,fd,address,len(address))
                payload = ctx.probe_payload() if getattr(ctx,'receiver_binding',None) is not None else b'TASK8'
                if ctx.syscall(64,fd,payload,len(payload))!=len(payload): raise ProbeFailure('POSITIVE_DELIVERY_FAILED')
            finally: ctx.close(fd)
            return
        # T8-01: the theft family attempts each named theft against a real
        # foreign object, never the browser's own descriptors or a null request.
        if name=='proc-enumeration-family-only': return ctx.family_only_processes()
        if name in ('controller-SCM_RIGHTS','proxy-SCM_RIGHTS'):
            ctx.inherited_endpoint_not_socket()
            return ctx.donor_unreachable()
        if name=='trusted-unix-names-unreachable': return ctx.trusted_names_unreachable()
        if name in ('proc-controller-fd','proc-proxy-fd'):
            pid=ctx.foreign_process('CONTROLLER' if name=='proc-controller-fd' else 'PROXY')
            fd=ctx.open_denied('/proc/'+str(pid)+'/fd/3')
            ctx.close(fd)
            raise ProbeFailure('FOREIGN_FD_OPENED')
        if name=='pidfd_open-getfd':
            pid=ctx.foreign_process('CONTROLLER')
            pidfd=ctx.syscall(434,pid,0)
            try:
                stolen=ctx.syscall(438,pidfd,3,0)
                ctx.close(stolen)
                raise ProbeFailure('FOREIGN_FD_STOLEN')
            finally: ctx.close(pidfd)
        if name in ('ptrace-attach','ptrace-seize'):
            pid=ctx.foreign_process('CONTROLLER')
            if name=='ptrace-attach': ctx.syscall(117,16,pid,0,0)
            else: ctx.syscall(117,0x4206,pid,0,0)
            raise ProbeFailure('FOREIGN_PROCESS_TRACED')
        if name in ('process_vm_readv','process_vm_writev'):
            ctx.cross_memory(name,ctx.foreign_process('CONTROLLER'))
            raise ProbeFailure('FOREIGN_MEMORY_ACCESSED')
        if name=='setresuid-root': return ctx.syscall(147,0,0,0)
        if name=='initial-namespace-capability':
            header=ctx.memory(struct.pack(_CAPSET_HEADER,0x20080522,0))
            data=ctx.memory(struct.pack(_CAPSET_DATA,1,1,0,0,0,0))
            return ctx.syscall(91,header,data)
        if name=='chroot-initial-namespace': return ctx.syscall(51,b'/')
        if name=='unshare-CLONE_NEWUSER':
            try: result=ctx.syscall(97,0x10000000)
            except OSError: raise ProbeFailure('USER_NAMESPACE_UNAVAILABLE') from None
            if result!=0: raise ProbeFailure('USER_NAMESPACE_UNAVAILABLE')
            return
        paths={'dev-console-open':'/dev/console','dev-hvc-open':'/dev/hvc0'}
        if name in paths:
            # T8-12: a node that refuses reads but takes writes is still a
            # console, so both directions are attempted.
            refused=None
            for write in (False,True):
                try: fd=ctx.open_denied(paths[name],write)
                except OSError as error:
                    self._denial(name,error); refused=error
                    continue
                ctx.close(fd)
                raise ProbeFailure('CONSOLE_OPENED')
            raise refused
        if name=='proc-console-reopen':
            # P52: the real reopen attack, following the magic link (an fd
            # entry is S_IFLNK; O_NOFOLLOW would only ever give ELOOP). The
            # console is the CONTROLLER role's (appliance consoleRole). This
            # family's /proc is its own PID namespace (linux-6.8/fs/proc/root.c
            # :252), where pid 1 is this family itself, so the target is the
            # controller-UID fixture process there, its fd 0, for reading and
            # for writing (T8-12). Only _PROC_FD_REFUSED denies.
            pid=ctx.foreign_process('CONTROLLER')
            refused=None
            for write in (False,True):
                try: fd=ctx.open_following('/proc/'+str(pid)+'/fd/0',write)
                except OSError as error:
                    self._denial(name,error); refused=error
                    continue
                ctx.close(fd)
                raise ProbeFailure('CONSOLE_REACHED')
            raise refused
        if name=='unaudited-bridge-fd':
            if len(ctx.fd_links())!=5: raise ProbeFailure('UNAUDITED_FD_PRESENT')
            raise PermissionError(_EPERM,'FD_INVENTORY_BOUNDARY')
        # T8-03: the bootstrap-side parent observes this family itself while it
        # waits (run_confined); the child reports nothing of its own.
        if name==_PARENT_OBSERVED: return
        # These are actual hostile exec/ABI and bootstrap-error fixtures, not
        # numeric policy evaluation. Their fixed sample pins/results are owned
        # by the separately approved native harness. No arbitrary helper argv.
        helpers={'parent.socket-AF_VSOCK','fork.socket-AF_VSOCK','exec.socket-AF_VSOCK',
            'network.socket-AF_VSOCK','gpu.socket-AF_VSOCK','crash.socket-AF_VSOCK','helper.socket-AF_VSOCK',
            'AArch32-audit','alternate-syscall-entry','setuid-helper','capability-file'}
        if name in helpers or name in HELPER_SAMPLES or name in (
                'parent.socket-IPV4-TCP','fork.socket-IPV4-TCP','parent.socket-IPV6-TCP','fork.socket-IPV6-TCP'):
            return ctx.helper(name)
        controls={'arbitrary-executable','arbitrary-argv','arbitrary-uid','arbitrary-fd',
                  'invalid-filter-einval','TSYNC-unsynchronized-tid'}
        if name in controls: return ctx.bootstrap_rejection(name)
        raise RuntimeGateUnavailable('NATIVE_OPERATION_UNAVAILABLE')


class NativeProbeContext:
    """Actual operations on the already-confined native child bindings.

    `witnesses` are the trusted native harness's pinned fixed helper samples,
    foreign-role identity witnesses and receiver counter, never worker claims.
    Absence is an unavailable gate. The offline doubles intentionally cannot
    establish any of these native qualification facts.
    """
    def __init__(self,port,authority,operation,confinement=None):
        self.port,self.authority,self.operation,self.c=port,authority,operation,confinement
        self.receiver_binding,self.nonce,self.cleanup_budget = None,None,None
        # P54: the UNIX names the trusted parent confirmed reachable for this family.
        self.unix_targets=None
    def syscall(self,nr,*args): return self.port.b.syscall(nr,*args)
    def memory(self,data):
        # Provided explicitly by the trusted embedding; no dynamic path import.
        return self.authority.memory(bytearray(data))
    def struct_memory(self,data,pointers):
        """Reviewed LP64 bytes with explicit pointer slots; the native syscall
        marshal relocates them and copies the kernel's writes back."""
        if self.c is None: raise RuntimeGateUnavailable('NATIVE_MEMORY_UNAVAILABLE')
        return self.c.NativeMemory(bytearray(data),dict(pointers))
    def close(self,fd): self.port.b.os.close(fd)
    def open_denied(self,path,write=False):
        if write: return self.port.b.os.open(path,1|32768|524288)
        return self.port.b.os.open(path,32768|524288)
    def open_following(self,path,write=False):
        """P52: open a /proc magic link following it (no O_NOFOLLOW); following
        the link is the reopen under test."""
        if write: return self.port.b.os.open(path,1|524288)
        return self.port.b.os.open(path,524288)
    def fd_link(self,fd): return self.port.b.os.readlink('/proc/self/fd/'+str(fd))
    def fd_links(self):
        fds=self.port.b.os.listdir('/proc/self/fd')
        if len(fds)>4096: raise ProbeFailure('FD_INVENTORY_LIMIT')
        out=[]
        for fd in fds:
            try: out.append(self.fd_link(int(fd)))
            except FileNotFoundError: pass # closed observer directory FD
        return tuple(out)
    def receiver_count(self):
        value=self.authority.receiver_count(self.operation)
        if type(value) is not int or not 0<=value<=1: raise ProbeFailure('RECEIVER_WITNESS_INVALID')
        return value
    def foreign_process(self,role):
        """A fixture-owned process of ROLE's UID inside this family's own PID
        namespace (T8-01), observed here: /proc/<pid> is visible and owned by
        that UID. Anything else is unavailability, never a denial."""
        uids=(self.c or _confinement()).UIDS
        if role not in uids or role==self.operation.partition('.')[0]:
            raise RuntimeGateUnavailable('FOREIGN_IDENTITY_UNAVAILABLE')
        pid=self.authority.foreign_uid_process_in_role_ns(role)
        b=self.port.b
        if type(pid) is not int or pid<=0 or pid==b.os.getpid():
            raise RuntimeGateUnavailable('FOREIGN_IDENTITY_UNAVAILABLE')
        try: owner=b.os.stat('/proc/'+str(pid)).st_uid
        except OSError: raise RuntimeGateUnavailable('FOREIGN_IDENTITY_UNAVAILABLE') from None
        if owner!=uids[role]: raise RuntimeGateUnavailable('FOREIGN_IDENTITY_UNAVAILABLE')
        return pid
    def family_only_processes(self):
        """/proc in this family's own PID namespace lists this fresh family only
        (T8-01). Any other pid, such as a process of another role, is a finding."""
        b=self.port.b
        entries=b.os.listdir('/proc')
        if len(entries)>4096: raise ProbeFailure('PROC_LISTING_LIMIT')
        pids={entry for entry in entries if re.fullmatch('[1-9][0-9]{0,9}',entry)}
        if pids!={str(b.os.getpid())}: raise ProbeFailure('NON_FAMILY_PROCESS_VISIBLE')
        raise PermissionError(_EPERM,'FAMILY_ONLY')
    def cross_memory(self,name,pid):
        """One non-empty local and one non-empty remote iovec (T8-01): with a zero
        total the kernel returns 0 before it resolves the pid
        (linux-6.8/mm/process_vm_access.c process_vm_rw)."""
        local=self.struct_memory(struct.pack(_IOVEC,0,8),{0:self.struct_memory(bytes(8),{})})
        remote=self.struct_memory(struct.pack(_IOVEC,4096,8),{})
        if name=='process_vm_readv': return self.syscall(270,pid,local,1,remote,1,0)
        return self.syscall(271,pid,local,1,remote,1,0)
    def receive_rights(self,fd):
        """recvmsg(2) with one one-byte iovec and room for one SCM_RIGHTS int;
        the descriptors received (closed on exec by MSG_CMSG_CLOEXEC)."""
        control=self.struct_memory(bytes(_CMSG_ONE_FD),{})
        iov=self.struct_memory(struct.pack(_IOVEC,0,1),{0:self.struct_memory(bytes(1),{})})
        message=self.struct_memory(struct.pack(_USER_MSGHDR,0,0,0,1,0,_CMSG_ONE_FD,0),
                                   {_MSG_IOV:iov,_MSG_CONTROL:control})
        self.syscall(212,fd,message,0x40000000)
        length=struct.unpack(_USER_MSGHDR,bytes(message.data))[5]
        header=struct.calcsize(_CMSGHDR)
        if length==0: return ()
        if not header<=length<=_CMSG_ONE_FD: raise ProbeFailure('ANCILLARY_INVALID')
        data=bytes(control.data)
        size,level,kind=struct.unpack_from(_CMSGHDR,data,0)
        if not header<=size<=length or (level,kind)!=(_SOL_SOCKET,_SCM_RIGHTS): raise ProbeFailure('ANCILLARY_INVALID')
        width=struct.calcsize(_SCM_FD)
        return tuple(struct.unpack_from(_SCM_FD,data,at)[0] for at in range(header,size-width+1,width))
    def inherited_endpoint_not_socket(self):
        """The inherited command endpoint FD3 is the bootstrap's pipe: recvmsg on
        it is ENOTSOCK, never an ancillary transfer (EBADF proves nothing)."""
        try: rights=self.receive_rights(3)
        except OSError as error:
            if error.errno!=_ENOTSOCK: raise ProbeFailure('UNEXPECTED_KERNEL_ERROR') from None
            return
        for received in rights: self.close(received)
        raise ProbeFailure('INHERITED_SOCKET_ENDPOINT')
    def connect_unix(self,name):
        """A fresh AF_UNIX stream socket connected to NAME, else the refusal,
        raised after its socket is closed. A failed socket is no attempt."""
        address,length=_unix_address(name)
        try: fd=self.syscall(198,1,1,0)
        except OSError: raise ProbeFailure('UNIX_SOCKET_UNAVAILABLE') from None
        try: self.syscall(203,fd,address,length)
        except OSError:
            self.close(fd)
            raise
        return fd
    def donor_unreachable(self):
        """Connect to the fixture donor the trusted parent confirmed reachable
        (P54), which sends one descriptor to any peer. Only a refused connect is
        a denial; reaching it is a finding."""
        targets=self.unix_targets
        if type(targets) is not tuple or len(targets)!=1: raise RuntimeGateUnavailable('FIXTURE_UNAVAILABLE')
        fd=self.connect_unix(targets[0])
        try:
            try: rights=self.receive_rights(fd)
            except OSError: rights=()
        finally: self.close(fd)
        for received in rights: self.close(received)
        raise ProbeFailure('FD_DONOR_REACHED' if rights else 'DONOR_ENDPOINT_REACHED')
    def trusted_names_unreachable(self):
        """Every abstract or path UNIX name a trusted role creates, each confirmed
        reachable by the trusted parent (P54), refuses this family. A bound name
        of another socket type answers EPROTOTYPE, which is not an accepted
        refusal: it fails closed."""
        names=self.unix_targets
        if type(names) is not tuple or not names: raise RuntimeGateUnavailable('FIXTURE_UNAVAILABLE')
        refused=None
        for name in names:
            try: fd=self.connect_unix(name)
            except OSError as error:
                NativeProbePort._denial('trusted-unix-names-unreachable',error); refused=error
                continue
            self.close(fd)
            raise ProbeFailure('TRUSTED_UNIX_NAME_REACHED')
        raise refused
    def probe_payload(self):
        if self.receiver_binding is None or re.fullmatch('[0-9a-f]{32}', self.nonce or '') is None:
            raise RuntimeGateUnavailable('RECEIVER_FIXTURES_UNAVAILABLE')
        return b'BC1'+bytes.fromhex(self.nonce)

    def network_attempt(self):
        receiver = self.receiver_binding
        if (type(receiver) is not ReceiverBinding or receiver.operationId != self.operation
                or receiver.family not in ('IPV4','IPV6')):
            raise RuntimeGateUnavailable('RECEIVER_FIXTURES_UNAVAILABLE')
        payload, address = self.probe_payload(),receiver.address_bytes()
        fd = self.syscall(198,2 if receiver.family == 'IPV4' else 10,1 if receiver.transport == 'TCP' else 2,0)
        try:
            if receiver.transport == 'TCP':
                self.syscall(203,fd,address,len(address))
                if self.syscall(64,fd,payload,len(payload)) != len(payload): raise ProbeFailure('PROBE_DELIVERY_INCOMPLETE')
            elif self.syscall(206,fd,payload,len(payload),0,address,len(address)) != len(payload):
                raise ProbeFailure('PROBE_DELIVERY_INCOMPLETE')
        finally:
            try: self.close(fd)
            except OSError: raise ProbeFailure('PROBE_CLOSE_FAILED') from None

    def helper(self,name):
        try:
            return self._helper(name)
        except OSError as error:
            # Parent positions directly attempt the syscall. Descendants prove
            # denial only via the marker/exit path below, never setup errno.
            if type(error) is _HelperBoundaryDenied or name in (
                    'parent.socket-AF_VSOCK','parent.socket-IPV4-TCP','parent.socket-IPV6-TCP'):
                raise
            raise ProbeFailure('HELPER_EFFECT_FAILED') from None

    def _helper(self,name):
        b=self.port.b
        samples=HELPER_SAMPLES
        network = name.endswith(('socket-IPV4-TCP','socket-IPV6-TCP'))
        if network and self.receiver_binding is None: raise RuntimeGateUnavailable('RECEIVER_FIXTURES_UNAVAILABLE')
        if network and name.startswith('parent.'): return self.network_attempt()
        if name=='parent.socket-AF_VSOCK': return self.syscall(198,40,1,0)
        if name not in samples and name not in ('fork.socket-AF_VSOCK','fork.socket-IPV4-TCP','fork.socket-IPV6-TCP'):
            raise ProbeFailure('HELPER_DENIED')
        # P53: for AArch32 the observed outcome decides. The kernel refuses an
        # AArch32 exec with ENOEXEC without CONFIG_COMPAT or without 32-bit EL0
        # on the CPU (linux-6.8/arch/arm64/kernel/process.c:601-620); seen by
        # this module's own pre-exec child, it means no AArch32 process can exist.
        fd=None; marker=None; target=None; pid=None; terminal=False
        try:
            if name in samples:
                pin=self.authority.helper_pin(name)
                path='/opt/acceptance/tests/fixtures/'+samples[name]
                if (pin.path!=path or type(pin.sha256) is not str or
                    re.fullmatch('[0-9a-f]{64}',pin.sha256) is None): raise ProbeFailure('HELPER_DENIED')
                if self.receiver_binding is not None and pin.sha256 != self.receiver_binding.sampleDigest:
                    raise ProbeFailure('HELPER_PIN_MISMATCH')
                try: fd=b.pin_sample(path,pin.sha256)
                except FileNotFoundError: raise RuntimeGateUnavailable('HELPER_SAMPLE_UNAVAILABLE') from None
                if self.receiver_binding is not None:
                    # The approved sample consumes this finite FD3 frame, never
                    # argv/env addresses. FD4 remains the attempted marker only.
                    frame=json.dumps(dict(version=1,operationId=self.operation,
                        addressHex=self.receiver_binding.address_bytes().hex(),
                        payloadHex=self.probe_payload().hex()),sort_keys=True,separators=(',',':')).encode('ascii')
                    if len(frame)>512: raise ProbeFailure('HELPER_TARGET_DENIED')
                    target=b.os.pipe2(524288)
                    if b.os.write(target[1],struct.pack(_FRAME_LENGTH,len(frame))+frame)!=len(frame)+4:
                        raise ProbeFailure('HELPER_TARGET_DENIED')
                    b.os.close(target[1]); target=(target[0],None)
            marker=b.os.pipe2(524288)
            pid=b.os.fork()
            if pid==0:
                try:
                    b.os.close(marker[0]); b.os.dup2(marker[1],4); b.os.set_inheritable(4,True)
                    b.os.close(marker[1])
                    if target is not None:
                        b.os.dup2(target[0],3); b.os.set_inheritable(3,True)
                        b.os.close(target[0])
                    if fd is None:
                        b.os.write(4,b'ATTEMPTED\n')
                        try:
                            if network: self.network_attempt()
                            else: self.syscall(198,40,1,0)
                        except OSError as error: b.os._exit(23 if error.errno==_EPERM else 78)
                        b.os._exit(0)
                    # Close all extra endpoints, retain only pinned CLOEXEC
                    # executable. Marker FD4 cannot carry private role results.
                    b.syscall(436,5,fd-1,0); b.syscall(436,fd+1,4294967295,0)
                    b.os.set_inheritable(fd,False)
                    try: b.os.execve(fd,(path,),{})
                    except OSError as error: b.os._exit(24 if name=='AArch32-audit' and error.errno==_ENOEXEC else 78)
                    b.os._exit(78)
                except Exception: b.os._exit(78)
            b.os.close(marker[1]); marker=(marker[0],None)
            until=b.monotonic()+2; proof=bytearray()
            while b.monotonic()<until:
                ready,_,_=b.select([marker[0]],[],[],0)
                if ready and len(proof)<10: proof.extend(b.os.read(marker[0],10-len(proof)))
                ended,status=b.os.waitpid(pid,b.os.WNOHANG)
                if ended==pid:
                    terminal=True
                    # A child may exit between select and waitpid. Drain its
                    # available marker bytes without assuming descendants have
                    # closed every inherited writer. Missing bytes fail closed.
                    while len(proof)<10:
                        ready,_,_=b.select([marker[0]],[],[],0)
                        if not ready: break
                        part=b.os.read(marker[0],10-len(proof))
                        if not part: break
                        proof.extend(part)
                    code=b.os.waitstatus_to_exitcode(status)
                    if name=='AArch32-audit' and not proof and code==24:
                        # The exec refusal, observed by this module's own
                        # pre-exec child: no sample code ran, so no marker.
                        raise _HelperBoundaryDenied(_ENOEXEC,'AARCH32_EXEC_UNAVAILABLE')
                    if proof!=b'ATTEMPTED\n': raise ProbeFailure('HELPER_ATTEMPT_UNPROVED')
                    if name in ('AArch32-audit','alternate-syscall-entry'):
                        # KILL_PROCESS ends the task with SIGSYS; any other end,
                        # an exit code included, is not this denial (T8-02, D1).
                        if -code!=_SIGSYS: raise ProbeFailure('ABI_ATTEMPT_UNPROVED')
                        if self.authority.audit_abi_termination(name,pid,status) is not self.authority: raise ProbeFailure('ABI_ATTEMPT_UNPROVED')
                        if name=='AArch32-audit': raise _HelperBoundaryDenied(_EPERM,'SECCOMP_ARCH_KILL')
                        raise _HelperBoundaryDenied(_EPERM,'SECCOMP_KILL')
                    if code==23: raise _HelperBoundaryDenied(_EPERM,'HELPER_EXIT')
                    if code!=0: raise ProbeFailure('HELPER_OPERATION_FAILED')
                    return
                b.sleep(0.01)
            raise ProbeFailure('HELPER_DEADLINE')
        finally:
            if pid is not None and pid>0 and not terminal:
                # Still an unreaped DIRECT child: PID reuse is impossible.
                try: b.os.kill(pid,b.signal.SIGKILL)
                except ProcessLookupError: pass
                budget=self.cleanup_budget
                allowance=(PROBE_FAMILY_STOP_MS if budget is None or not budget.started
                           else min(PROBE_FAMILY_STOP_MS,budget.remaining()))
                until=b.monotonic()+allowance/1000
                while b.monotonic()<until:
                    ended,_=b.os.waitpid(pid,b.os.WNOHANG)
                    if ended==pid: terminal=True; break
                    b.sleep(0.01)
                if not terminal: raise ProbeFailure('HELPER_REAP_UNCERTAIN')
            if fd is not None: b.os.close(fd)
            if marker is not None:
                for endpoint in marker:
                    if endpoint is not None: b.os.close(endpoint)
            if target is not None:
                for endpoint in target:
                    if endpoint is not None: b.os.close(endpoint)
    def bootstrap_rejection(self,name):
        """T8-13: library re-checks of the launch contract and TSYNC abort inside a
        probe family (basis LIBRARY_RECHECK), not a kernel/FD boundary.
        invalid-filter-einval passes an empty fprog, which is EINVAL, not a TSYNC
        failure."""
        c=self.c
        if c is None: raise RuntimeGateUnavailable('BOOTSTRAP_PROBE_UNAVAILABLE')
        launch=self.port.launch
        config=c.RoleConfig(c.BootstrapConfig(None,launch.run_id,launch.programs),launch.fds)
        try:
            if name=='arbitrary-executable': c.prepare_role(launch.role,replace(config,argv=('/bin/sh',)))
            elif name=='arbitrary-argv': c.prepare_role(launch.role,replace(config,argv=launch.argv+('--no-sandbox',)))
            elif name=='arbitrary-uid': c.exec_role(replace(launch,uid=0),kernel=self.port)
            elif name=='arbitrary-fd': c.prepare_role(launch.role,replace(config,fds=launch.fds+(c.Descriptor(5,'pipe','command','CONTROLLER',launch.run_id),)))
            elif name in ('invalid-filter-einval','TSYNC-unsynchronized-tid'):
                # Actual invalid-filter syscall or independently owned native
                # thread fixture. Neither substitutes a fake success/failure
                # value into the native KernelPort. Failure must abort exec.
                port=self.port
                class FaultPort:
                    def establish_views(self,value):
                        if value!=launch.views: raise ProbeFailure('PROBE_DENIED')
                    def close_unaudited_fds(self,value):
                        if value!=launch.fds: raise ProbeFailure('PROBE_DENIED')
                    def drop_credentials(self,uid,gid):
                        if (uid,gid)!=(launch.uid,launch.uid): raise ProbeFailure('PROBE_DENIED')
                    def clear_capabilities(self): c._check(c._attestation(port.inspect()),launch,waiting=False)
                    def no_new_privs(self): c._check(c._attestation(port.inspect()),launch,waiting=False)
                    def install_seccomp(self,program,flags):
                        if name=='invalid-filter-einval':
                            return port.b.syscall(277,1,1,c.NativeMemory(bytearray(16)))
                        with self_context.authority.unsynchronized_thread(port):
                            result=port.install_seccomp(program,flags)
                            if type(result) is not int or result<=0: raise ProbeFailure('TSYNC_THREAD_FIXTURE_FAILED')
                            return result
                    def exec_pinned(self,*args): raise ProbeFailure('UNTRUSTED_EXEC_AFTER_TSYNC_FAILURE')
                self_context=self
                c.exec_role(launch,kernel=FaultPort())
            else: raise ProbeFailure('BOOTSTRAP_PROBE_DENIED')
        except c.ConfinementError:
            raise PermissionError(_EPERM,'BOOTSTRAP_BOUNDARY_DENIED') from None
        raise ProbeFailure('BOOTSTRAP_CONTRACT_ACCEPTED')


class _ProbeFamilyOwner:
    """Retained before spawn; a timed-out cleanup call is never overlapped."""
    def __init__(self, fixtures, operation, role, root, state, cleanup_budget):
        self.fixtures,self.operation,self.role = fixtures,operation,role
        self.root,self.state,self.cleanup_budget = root,state,cleanup_budget
        self.owned,self.exited,self.proven,self.cleaning = None,False,False,False
        # T8-03: the digest of the facts the parent observed for this waiting
        # family, or None when the operation is not the parent-observed one.
        self.facts_digest=None
        self._lock=threading.Lock()
        self.scopes = (root+'/run/acceptance/'+role.lower(),root+'/run/acceptance',root+'/run',
            root+'/dev/shm',root+'/dev',*(root+'/'+d for d in ('proc','tmp','var','etc','lib64','lib','usr','opt')),root,
            state+'/run/acceptance/'+role.lower(),state+'/run/acceptance',state+'/run',
            state+'/dev/shm',state+'/dev',state+'/var',state+'/tmp',state)

    def receipt(self, value, statuses):
        if (type(value) is not dict or set(value) != {'status','pid','run_id'}
                or value['status'] not in statuses or type(value['pid']) is not int
                or value['pid'] != self.owned.pid or value['run_id'] != self.owned.run_id):
            raise ProbeCleanupFailure(self)

    def stop_owned(self, remaining_ms):
        with self._lock:
            if self.cleaning: raise ProbeCleanupFailure(self)
            self.cleaning = True
        if self.owned is None: raise ProbeCleanupFailure(self)
        if type(remaining_ms) is not int or remaining_ms <= 0: raise ProbeCleanupFailure(self)
        step=min(PROBE_FAMILY_STOP_MS,remaining_ms)
        b = self.fixtures.kernel.b
        until=b.monotonic()+step/1000
        self.receipt(self.fixtures.kernel.stop_owned(self.owned,step),('STOPPED','EXITED'))
        try: b.os.unlink(self.root+'/dev/null')
        except FileNotFoundError: pass
        for path in self.scopes:
            # Bounded by this fixed step, and by the shared end once a terminal
            # event has started it. A routine stop never starts it (C1).
            budget=self.cleanup_budget
            if b.monotonic()>=until or (budget is not None and budget.started
                                        and not budget.remaining()): raise ProbeCleanupFailure(self)
            try: b.os.rmdir(path)
            except FileNotFoundError: pass
        if b.os.path.lexists(self.root) or b.os.path.lexists(self.state): raise ProbeCleanupFailure(self)
        self.proven = self.exited
        return dict(status='STOPPED',pid=self.owned.pid,run_id=self.owned.run_id)


# Every method is required; absence is unavailability. foreign_pid (a pid of
# the bootstrap's namespace) and audit(port) (a self-reported inventory) are
# replaced by foreign_uid_process_in_role_ns and correlate_inventory (T8-01, T8-03).
# confirm_reachable is the parent's positive control (P54); kernel_feature is
# retired with the CONFIG_COMPAT keying (P53).
_FIXTURE_AUTHORITY = ('receiver_count','helper_pin','audit_abi_termination','unsynchronized_thread','memory',
                      'foreign_uid_process_in_role_ns','trusted_unix_names','scm_rights_donor',
                      'confirm_reachable','correlate_inventory')


def _fact_record(value):
    if dataclasses.is_dataclass(value) and not isinstance(value,type): return dataclasses.asdict(value)
    raise TypeError('unrecorded fact')


class _ProbeFixturesCore:
    """Concrete finite subprocess transport for separately approved fixtures.

    The one run_confined shared by both fixture kinds (P29), as _KernelPortCore
    is for ports. The authority supplies independently owned receiver and
    executable samples, not canned attempt dictionaries. Missing fixture
    callbacks fail closed. Every observation below is generated inside a freshly
    confined process, except the parent's own observation of a waiting family.
    """
    def _bind(self,confinement,kernel,config,authority,approval,unavailable,unapproved):
        if any(not callable(getattr(authority,n,None)) for n in (approval,)+_FIXTURE_AUTHORITY):
            raise RuntimeGateUnavailable(unavailable)
        if getattr(authority,approval)(config) is not authority: raise RuntimeGateUnavailable(unapproved)
        self.c,self.kernel,self.config,self.authority=confinement,kernel,config,authority
        self._epoch_started=False
        self.cleanup_budget=None
        self.family_owners=[]

    def _confirm_reachable(self,operation):
        """P54: the trusted parent's positive control for the donor and trusted-
        name probes, from outside the family: every target exists and is
        reachable now (confirm_reachable answers True), else FIXTURE_UNAVAILABLE,
        never a denial. The family attempts exactly these targets. None for
        every other operation."""
        name=operation.partition('.')[2]
        if name in ('controller-SCM_RIGHTS','proxy-SCM_RIGHTS'):
            targets=(self.authority.scm_rights_donor('CONTROLLER' if name=='controller-SCM_RIGHTS' else 'PROXY'),)
        elif name=='trusted-unix-names-unreachable':
            targets=self.authority.trusted_unix_names()
            if type(targets) is not tuple or not targets or len(targets)>64 or len(set(targets))!=len(targets):
                raise RuntimeGateUnavailable('TRUSTED_UNIX_NAMES_UNAVAILABLE')
        else: return None
        for target in targets:
            _unix_address(target)
            if self.authority.confirm_reachable(target) is not True: raise RuntimeGateUnavailable('FIXTURE_UNAVAILABLE')
        return targets

    def _observe_waiting_family(self,launch,owned,family):
        """T8-03 (D4): the bootstrap-side exact check of a waiting probe family,
        made by this parent while the child blocks reading its EXIT frame:
        _native_observe(local=False) and _check(waiting=True). The authority only
        correlates the observed facts' digest; it never supplies them."""
        c,b=self.c,self.kernel.b
        state=getattr(self.kernel,'_owned',{}).get(owned)
        if (type(state) is not dict or state.get('child')!=owned.pid or state.get('terminal') is not None
                or type(state.get('digest')) is not str):
            raise RuntimeGateUnavailable('PARENT_OBSERVATION_UNAVAILABLE')
        try:
            # A probe family never execs: it runs this bootstrap's own image, so
            # its cmdline must be the bootstrap's, never a role program's.
            own=tuple(part.decode('ascii') for part in b.read_file('/proc/self/cmdline',4096).split(b'\0')[:-1])
            facts=c._native_observe(b,owned.pid,replace(launch,argv=own),state['digest'],{},None,local=False)
            c._check(c._attestation(facts),launch,waiting=True)
            links=tuple(b.os.readlink('/proc/'+str(owned.pid)+'/fd/'+str(fd)) for fd in (3,4))
            if links!=state.get('links'): raise ProbeFailure('PARENT_INVENTORY_DENIED')
        except Exception: raise ProbeFailure('PARENT_INVENTORY_DENIED') from None
        digest=hashlib.sha256(json.dumps(facts,sort_keys=True,separators=(',',':'),
                                         default=_fact_record).encode('ascii')).hexdigest()
        if self.authority.correlate_inventory(launch.role,digest) is not self.authority:
            raise ProbeFailure('INVENTORY_CORRELATION_DENIED')
        family.facts_digest=digest

    def run_confined(self,role,operation,attempt):
        if role=='BOOTSTRAP': role='BROWSER' # trusted pre-exec fault probe, NEVER worker exec
        c=self.c; launch=c.prepare_role(role,c.RoleConfig(self.config,c.role_fds(role,self.config.run_id)))
        b=self.kernel.b
        root,state=launch.views.root+'/.root',launch.views.root+'/.state'
        if b.os.path.lexists(root) or b.os.path.lexists(state):
            raise RuntimeGateUnavailable('PROBE_SCOPE_ALREADY_EXISTS')
        # P54: before any family effect, the parent confirms the UNIX targets.
        targets=self._confirm_reachable(operation)
        family=_ProbeFamilyOwner(self,operation,role,root,state,self.cleanup_budget)
        self.family_owners.append(family)
        def child(port):
            try:
                port.establish_views(launch.views); port.close_unaudited_fds(launch.fds)
                port.drop_credentials(launch.uid,launch.uid); port.clear_capabilities(); port.no_new_privs()
                if port.install_seccomp(launch.filter,1)!=0: raise ProbeFailure('TSYNC_FAILED')
                c._check(c._attestation(port.inspect()),launch,waiting=False)
                # No inherited bootstrap-ready/pinned exec FD reaches the
                # adversarial attempt. A fixed frame authenticates this pipe.
                port.b.os.write(port.ready_fd,port.digest.encode('ascii'))
                for fd in set(port.pins.values())|{port.ready_fd}: port.b.os.close(fd)
                port.pins={}; port.ready_fd=None
                port.b.os.write(4,b'WAITING\n')
                context=NativeProbeContext(port,self.authority,operation,c)
                context.cleanup_budget=self.cleanup_budget
                context.unix_targets=targets
                data=json.dumps(attempt(context),separators=(',',':')).encode('ascii')
                if len(data)>512: raise ProbeFailure('PROBE_RESULT_LIMIT')
                if port.b.os.write(4,struct.pack(_FRAME_LENGTH,len(data))+data)!=len(data)+4: raise ProbeFailure('PROBE_RESULT_LIMIT')
                if port.b.os.read(3,4)!=b'EXIT': raise ProbeFailure('PROBE_RELEASE_DENIED')
                port.b.os._exit(0)
            except RuntimeGateUnavailable:
                # Finite unavailable result, no raw exception or private data.
                data=b'{"unavailable":"HELPER_SAMPLE_UNAVAILABLE"}'
                port.b.os.write(4,struct.pack(_FRAME_LENGTH,len(data))+data)
                port.b.os._exit(78)
            except ProbeFailure:
                data=b'{"failed":"PROBE_OPERATION_FAILED"}'
                port.b.os.write(4,struct.pack(_FRAME_LENGTH,len(data))+data)
                port.b.os._exit(78)
            except BaseException: port.b.os._exit(78)
        owned=None
        try:
            try: owned=self.kernel.spawn_waiting(launch,child); family.owned=owned
            except c.RoleStartFailure as error:
                owned=error.owned; family.owned=owned
                raise
            length=struct.unpack(_FRAME_LENGTH,self.kernel._read_exact(owned.result,4,2000))[0]
            if not 0<length<=512: raise ProbeFailure('PROBE_RESULT_LIMIT')
            result=_decode_child_result(self.kernel._read_exact(owned.result,length,2000),operation,
                                        composition=self._epoch_started)
            if operation.partition('.')[2]==_PARENT_OBSERVED: self._observe_waiting_family(launch,owned,family)
            self.kernel.b.os.write(owned.command,b'EXIT')
            family.receipt(self.kernel.wait_owned(owned,2000),('EXITED',))
            family.exited=True
            # P54: the same targets are still confirmed after the family, so a
            # target that vanished during the attempt is never read as isolation.
            if targets is not None and self._confirm_reachable(operation)!=targets:
                raise RuntimeGateUnavailable('FIXTURE_UNAVAILABLE')
            return result
        finally:
            if owned is not None:
                try:
                    # Routine family stop: fixed bounded step, never the shared end.
                    if self.cleanup_budget is None: family.stop_owned(PROBE_FAMILY_STOP_MS)
                    else: self.cleanup_budget.routine_call(family.stop_owned,PROBE_FAMILY_STOP_MS)
                except BaseException as error:
                    if isinstance(error,ProbeCleanupFailure): raise
                    raise ProbeCleanupFailure(family) from error


class NativeProbeFixtures(_ProbeFixturesCore):
    """Native fixtures: only over the sealed NativeKernelPort (T8-05), after the
    explicit native selector and pinned native fixture approval. The module and
    the port type are this module's own anchor, _confinement(); a substituted
    confinement module is refused (Task 9 review I-1)."""
    def __init__(self,confinement,kernel,config,authority):
        anchor=_confinement()
        if confinement is not anchor or type(kernel) is not anchor.NativeKernelPort:
            raise RuntimeGateUnavailable('NATIVE_FIXTURES_UNAVAILABLE')
        self._bind(confinement,kernel,config,authority,'approve_native_fixtures',
                   'NATIVE_FIXTURES_UNAVAILABLE','NATIVE_FIXTURES_UNAPPROVED')


class OfflineProbeFixtures(_ProbeFixturesCore):
    """Offline fixtures over the unsealed OfflineKernelPort: offline tests and the
    offline composition. Their epoch is never native (compA part A note)."""
    def __init__(self,confinement,kernel,config,authority):
        if type(kernel) is not confinement.OfflineKernelPort: raise RuntimeGateUnavailable('OFFLINE_FIXTURES_UNAVAILABLE')
        self._bind(confinement,kernel,config,authority,'approve_offline_fixtures',
                   'OFFLINE_FIXTURES_UNAVAILABLE','OFFLINE_FIXTURES_UNAPPROVED')


def select_native_probe(mode,*,confinement,config,runtime_identity,validate_runtime,fixture_authority):
    if mode!='bootstrap-check': raise RuntimeGateUnavailable('NATIVE_PROBE_GATE_DENIED')
    kernel=confinement.select_native_kernel(mode,runtime_identity=runtime_identity,validate_runtime=validate_runtime)
    return NativeProbePort(NativeProbeFixtures(confinement,kernel,config,fixture_authority))


if __name__ == '__main__':
    # No CLI import hook, adapter discovery, or host fallback can run an attempt.
    raise SystemExit(78)

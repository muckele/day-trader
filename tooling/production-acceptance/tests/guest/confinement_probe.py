"""Finite, separately gated adversarial Linux guest probes. No native default.

run_case invokes only an explicitly injected trusted ProbePort. Offline doubles
may test observation validation; their output is NOT kernel/runtime evidence.
NativeProbeFixtures takes only the sealed NativeKernelPort; OfflineProbeFixtures
the offline port. An epoch says which it came from and offline is never native.
The independently approved native harness must demonstrate each actual
attempt, denial at kernel/FD boundary, and owned receiver observation. Absence
of that harness is a failed/unavailable gate, never a skipped or mocked PASS.
"""
from collections import namedtuple
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
    'alternate_ABI_denied': ProbeCase(('BROWSER.AArch32-audit','BROWSER.x86_64-audit','BROWSER.unknown-audit','BROWSER.alternate-syscall-entry'),True,0),
    'SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied': ProbeCase(tuple('BROWSER.'+op for op in
        ('controller-SCM_RIGHTS','proxy-SCM_RIGHTS','proc-controller-fd','proc-proxy-fd','pidfd_getfd','ptrace','process_vm_readv','process_vm_writev')),True,0),
    'privilege_gain_denied': ProbeCase(('BROWSER.setuid-helper','BROWSER.capability-file','BROWSER.initial-namespace-capability','BROWSER.setresuid-root'),True,0),
    'no_console_or_bridge_fd': ProbeCase(tuple(role+'.'+op for role in ('BROWSER','VERIFIER','PROXY') for op in
        ('dev-console-open','dev-hvc-open','proc-console-reopen','unaudited-bridge-fd')),True,0),
    'bootstrap_arbitrary_argv_denied': ProbeCase(('BROWSER.arbitrary-executable','BROWSER.arbitrary-argv','BROWSER.arbitrary-uid','BROWSER.arbitrary-fd'),True,0),
    'TSYNC_failure_abort': ProbeCase(('BOOTSTRAP.TSYNC-error','BOOTSTRAP.TSYNC-unsynchronized-tid'),True,0),
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
})

HELPER_SAMPLES = MappingProxyType({
    **{position+'.socket-'+family: sample+'-'+suffix
       for family,suffix in (('AF_VSOCK','vsock'),('IPV4-TCP','ipv4'),('IPV6-TCP','ipv6'))
       for position,sample in (('exec','exec'),('helper','exec'),('network','chromium-network'),
                               ('gpu','chromium-gpu'),('crash','chromium-crash'))},
    'AArch32-audit':'aarch32-syscall','x86_64-audit':'x86_64-syscall',
    'unknown-audit':'unknown-abi','alternate-syscall-entry':'alternate-entry',
    'setuid-helper':'setuid-attempt','capability-file':'capability-attempt',
})


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
        if self.family == 'VSOCK': return struct.pack('<HHIIB3x',40,0,4050,2,0)
        packed = ipaddress.ip_address(self.numericEndpoint).packed
        return (struct.pack('<H',2)+struct.pack('>H',self.port)+packed+bytes(8)
                if self.family == 'IPV4' else struct.pack('<H',10)+struct.pack('>H',self.port)+bytes(4)+packed+bytes(4))


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
                denied = False
                try: port._operation(operation_name,context)
                except OSError as error:
                    denied = port._denial(operation_name,error)
                # A child cannot observe or claim an independent receiver count.
                return dict(operation=operation,attempted=True,denied=denied,receiver_count=0)
            row = fixtures.run_confined(role,operation,attempt)
            owner = fixtures.family_owners[-1]
            if not owner.proven or owner.operation != operation: raise ProbeFailure('PROBE_FAMILY_UNPROVED')
            after = receivers.observe(receiver,nonce,'AFTER')
            current()
            if (type(row) is not dict or set(row) != {'operation','attempted','denied','receiver_count'}
                    or row['operation'] != operation or row['attempted'] is not True
                    or row['denied'] is not case.denied or type(row['receiver_count']) is not int
                    or row['receiver_count'] != 0 or after-before != case.receiver_count):
                raise ProbeFailure('PROBE_BOUNDARY_FAILED')
            rows.append((operation,True,case.denied,after-before))
            correlations.append((receiver.to_record(),nonce,before,after))
        cases.append((name,tuple(rows)))
    identifiers = ('BROWSER_FD_DONOR','BROWSER_HELPER_IPV4','BROWSER_HELPER_IPV6','BROWSER_IO_URING',
        'BROWSER_IPV4_TCP','BROWSER_IPV6_TCP','BROWSER_UDP','BROWSER_VSOCK','CONTROLLER_DNS_TCP',
        'CONTROLLER_DNS_UDP','PROXY_VSOCK_CONTROL','VERIFIER_IPV4_TCP')
    projection = tuple((name,True,'ALLOWED' if name == 'PROXY_VSOCK_CONTROL' else 'DENIED',
                        int(name == 'PROXY_VSOCK_CONTROL')) for name in identifiers)
    payload = dict(binding=binding.to_record(),cases=cases,receivers=correlations,fixtureInventoryDigest=receivers.digest,
        families=[dict(operation=owner.operation,pid=owner.owned.pid,runId=owner.owned.run_id,
                       exited=owner.exited,emptyScopes=owner.scopes) for owner in fixtures.family_owners])
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
    """Raised only after the original helper's marker and exit/audit proof."""


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
    fields={'attempted','denied','receiver_count'}
    if composition or 'operation' in result: fields.add('operation')
    if (set(result) != fields
            or ('operation' in fields and (type(result['operation']) is not str or result['operation'] != operation))
            or result['attempted'] is not True or type(result['denied']) is not bool
            or type(result['receiver_count']) is not int or not 0 <= result['receiver_count'] <= 1):
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
        if (type(actual) is not dict or set(actual) != {'operation','attempted','denied','receiver_count'} or
            actual['operation'] != expected or actual['attempted'] is not True or actual['denied'] is not case.denied or
            type(actual['receiver_count']) is not int or actual['receiver_count'] != case.receiver_count):
            raise ProbeFailure('PROBE_BOUNDARY_FAILED')
    return observations


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
        if name in ('dev-console-open','dev-hvc-open','proc-console-reopen','proc-controller-fd','proc-proxy-fd') and isinstance(error,FileNotFoundError):
            return True
        allowed = (1,13,88,9) if name in ('controller-SCM_RIGHTS','proxy-SCM_RIGHTS') else (1,13)
        if error.errno not in allowed: raise ProbeFailure('UNEXPECTED_KERNEL_ERROR') from None
        return True

    def attempt(self,case):
        if not any(case is v for v in PROBES.values()): raise ProbeFailure('PROBE_DENIED')
        result=[]
        for operation in case.operations:
            role,_,name=operation.partition('.')
            def attempt(context,operation=operation,name=name):
                denied=False
                try: self._operation(name,context)
                except OSError as error:
                    allowed = (1,13) # EPERM / EACCES, independently pinned Linux errno
                    if name in ('dev-console-open','dev-hvc-open','proc-console-reopen',
                                'proc-controller-fd','proc-proxy-fd') and isinstance(error,FileNotFoundError): denied=True
                    if name in ('controller-SCM_RIGHTS','proxy-SCM_RIGHTS'): allowed+=(88,9) # pipe/nonexistent FD, not a donor socket
                    if not denied and error.errno not in allowed: raise ProbeFailure('UNEXPECTED_KERNEL_ERROR') from None
                    denied=True
                return {'operation':operation,'attempted':True,'denied':denied,'receiver_count':context.receiver_count()}
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
            raise PermissionError(1,'FD_INVENTORY_BOUNDARY')
        if name=='fixed-vsock-CID2-port4050':
            fd=ctx.syscall(198,40,1,0)
            try:
                address=struct.pack('<HHIIB3x',40,0,4050,2,0)
                ctx.syscall(203,fd,address,16)
                payload = ctx.probe_payload() if getattr(ctx,'receiver_binding',None) is not None else b'TASK8'
                if ctx.syscall(64,fd,payload,len(payload))!=len(payload): raise ProbeFailure('POSITIVE_DELIVERY_FAILED')
            finally: ctx.close(fd)
            return
        if name in ('ptrace','pidfd_getfd','process_vm_readv','process_vm_writev'):
            pid=ctx.foreign_pid('CONTROLLER')
            if name=='ptrace': return ctx.syscall(117,0,pid,0,0)
            if name=='pidfd_getfd': return ctx.syscall(438,-1,3,0)
            return ctx.syscall(270 if name=='process_vm_readv' else 271,pid,0,0,0,0,0)
        if name in ('proc-controller-fd','proc-proxy-fd'):
            return ctx.open_denied('/proc/'+str(ctx.foreign_pid('CONTROLLER' if name=='proc-controller-fd' else 'PROXY'))+'/fd/3')
        if name in ('controller-SCM_RIGHTS','proxy-SCM_RIGHTS'):
            # The only role command endpoint is an audited anonymous pipe.
            # Actual recvmsg on it must be ENOTSOCK, never SCM_RIGHTS acceptance.
            return ctx.syscall(212,3,0,1073741824)
        if name=='setresuid-root': return ctx.syscall(147,0,0,0)
        if name=='initial-namespace-capability':
            return ctx.syscall(91,ctx.memory(struct.pack('<II',0x20080522,0)),ctx.memory(struct.pack('<6I',1,1,0,0,0,0)))
        paths={'dev-console-open':'/dev/console','dev-hvc-open':'/dev/hvc0','proc-console-reopen':'/proc/1/fd/0'}
        if name in paths:
            if name=='proc-console-reopen':
                fd=ctx.open_denied(paths[name])
                try:
                    if ctx.fd_link(fd)!='/dev/null': raise ProbeFailure('CONSOLE_REOPENED')
                finally: ctx.close(fd)
                raise PermissionError(1,'NO_CONSOLE_NODE')
            return ctx.open_denied(paths[name])
        if name=='unaudited-bridge-fd':
            if len(ctx.fd_links())!=5: raise ProbeFailure('UNAUDITED_FD_PRESENT')
            raise PermissionError(1,'FD_INVENTORY_BOUNDARY')
        if name=='exact-uid-capability-view-fd-inventory': return ctx.audit_inventory()
        # These are actual hostile exec/ABI and bootstrap-error fixtures, not
        # numeric policy evaluation. Their fixed sample pins/results are owned
        # by the separately approved native harness. No arbitrary helper argv.
        helpers={'parent.socket-AF_VSOCK','fork.socket-AF_VSOCK','exec.socket-AF_VSOCK',
            'network.socket-AF_VSOCK','gpu.socket-AF_VSOCK','crash.socket-AF_VSOCK','helper.socket-AF_VSOCK',
            'AArch32-audit','x86_64-audit','unknown-audit','alternate-syscall-entry',
            'setuid-helper','capability-file'}
        if name in helpers or name in HELPER_SAMPLES or name in (
                'parent.socket-IPV4-TCP','fork.socket-IPV4-TCP','parent.socket-IPV6-TCP','fork.socket-IPV6-TCP'):
            return ctx.helper(name)
        controls={'arbitrary-executable','arbitrary-argv','arbitrary-uid','arbitrary-fd',
                  'TSYNC-error','TSYNC-unsynchronized-tid'}
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
    def syscall(self,nr,*args): return self.port.b.syscall(nr,*args)
    def memory(self,data):
        # Provided explicitly by the trusted embedding; no dynamic path import.
        return self.authority.memory(bytearray(data))
    def close(self,fd): self.port.b.os.close(fd)
    def open_denied(self,path): return self.port.b.os.open(path,32768|524288)
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
    def foreign_pid(self,role):
        value=self.authority.foreign_pid(role)
        if type(value) is not int or value<=0: raise RuntimeGateUnavailable('FOREIGN_IDENTITY_UNAVAILABLE')
        return value
    def audit_inventory(self): return self.authority.audit(self.port)
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
                    if b.os.write(target[1],struct.pack('<I',len(frame))+frame)!=len(frame)+4:
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
                        except OSError as error: b.os._exit(23 if error.errno==1 else 78)
                        b.os._exit(0)
                    # Close all extra endpoints, retain only pinned CLOEXEC
                    # executable. Marker FD4 cannot carry private role results.
                    b.syscall(436,5,fd-1,0); b.syscall(436,fd+1,4294967295,0)
                    b.os.set_inheritable(fd,False)
                    b.os.execve(fd,(path,),{})
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
                    if proof!=b'ATTEMPTED\n': raise ProbeFailure('HELPER_ATTEMPT_UNPROVED')
                    if code==23: raise _HelperBoundaryDenied(1,'HELPER_BOUNDARY_DENIED')
                    if code<0 and name in ('AArch32-audit','x86_64-audit','unknown-audit','alternate-syscall-entry'):
                        if self.authority.audit_abi_termination(name,pid,status) is not self.authority: raise ProbeFailure('ABI_ATTEMPT_UNPROVED')
                        raise _HelperBoundaryDenied(1,'ABI_BOUNDARY_DENIED')
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
        c=self.c
        if c is None: raise RuntimeGateUnavailable('BOOTSTRAP_PROBE_UNAVAILABLE')
        launch=self.port.launch
        config=c.RoleConfig(c.BootstrapConfig(None,launch.run_id,launch.programs),launch.fds)
        try:
            if name=='arbitrary-executable': c.prepare_role(launch.role,replace(config,argv=('/bin/sh',)))
            elif name=='arbitrary-argv': c.prepare_role(launch.role,replace(config,argv=launch.argv+('--no-sandbox',)))
            elif name=='arbitrary-uid': c.exec_role(replace(launch,uid=0),kernel=self.port)
            elif name=='arbitrary-fd': c.prepare_role(launch.role,replace(config,fds=launch.fds+(c.Descriptor(5,'pipe','command','CONTROLLER',launch.run_id),)))
            elif name in ('TSYNC-error','TSYNC-unsynchronized-tid'):
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
                        if name=='TSYNC-error':
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
            raise PermissionError(1,'BOOTSTRAP_BOUNDARY_DENIED') from None
        raise ProbeFailure('BOOTSTRAP_CONTRACT_ACCEPTED')


class _ProbeFamilyOwner:
    """Retained before spawn; a timed-out cleanup call is never overlapped."""
    def __init__(self, fixtures, operation, role, root, state, cleanup_budget):
        self.fixtures,self.operation,self.role = fixtures,operation,role
        self.root,self.state,self.cleanup_budget = root,state,cleanup_budget
        self.owned,self.exited,self.proven,self.cleaning = None,False,False,False
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


_FIXTURE_AUTHORITY = ('receiver_count','foreign_pid','audit','helper_pin','audit_abi_termination',
                      'unsynchronized_thread','memory')


class _ProbeFixturesCore:
    """Concrete finite subprocess transport for separately approved fixtures.

    The one run_confined shared by both fixture kinds (P29), as _KernelPortCore
    is for ports. The authority supplies independently owned receiver and
    executable samples, not canned attempt dictionaries. Missing fixture
    callbacks fail closed. Every observation below is generated inside a freshly
    confined process.
    """
    def _bind(self,confinement,kernel,config,authority,approval,unavailable,unapproved):
        if any(not callable(getattr(authority,n,None)) for n in (approval,)+_FIXTURE_AUTHORITY):
            raise RuntimeGateUnavailable(unavailable)
        if getattr(authority,approval)(config) is not authority: raise RuntimeGateUnavailable(unapproved)
        self.c,self.kernel,self.config,self.authority=confinement,kernel,config,authority
        self._epoch_started=False
        self.cleanup_budget=None
        self.family_owners=[]

    def run_confined(self,role,operation,attempt):
        if role=='BOOTSTRAP': role='BROWSER' # trusted pre-exec fault probe, NEVER worker exec
        c=self.c; launch=c.prepare_role(role,c.RoleConfig(self.config,c.role_fds(role,self.config.run_id)))
        b=self.kernel.b
        root,state=launch.views.root+'/.root',launch.views.root+'/.state'
        if b.os.path.lexists(root) or b.os.path.lexists(state):
            raise RuntimeGateUnavailable('PROBE_SCOPE_ALREADY_EXISTS')
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
                data=json.dumps(attempt(context),separators=(',',':')).encode('ascii')
                if len(data)>512: raise ProbeFailure('PROBE_RESULT_LIMIT')
                if port.b.os.write(4,struct.pack('<I',len(data))+data)!=len(data)+4: raise ProbeFailure('PROBE_RESULT_LIMIT')
                if port.b.os.read(3,4)!=b'EXIT': raise ProbeFailure('PROBE_RELEASE_DENIED')
                port.b.os._exit(0)
            except RuntimeGateUnavailable:
                # Finite unavailable result, no raw exception or private data.
                data=b'{"unavailable":"HELPER_SAMPLE_UNAVAILABLE"}'
                port.b.os.write(4,struct.pack('<I',len(data))+data)
                port.b.os._exit(78)
            except ProbeFailure:
                data=b'{"failed":"PROBE_OPERATION_FAILED"}'
                port.b.os.write(4,struct.pack('<I',len(data))+data)
                port.b.os._exit(78)
            except BaseException: port.b.os._exit(78)
        owned=None
        try:
            try: owned=self.kernel.spawn_waiting(launch,child); family.owned=owned
            except c.RoleStartFailure as error:
                owned=error.owned; family.owned=owned
                raise
            length=struct.unpack('<I',self.kernel._read_exact(owned.result,4,2000))[0]
            if not 0<length<=512: raise ProbeFailure('PROBE_RESULT_LIMIT')
            result=_decode_child_result(self.kernel._read_exact(owned.result,length,2000),operation,
                                        composition=self._epoch_started)
            self.kernel.b.os.write(owned.command,b'EXIT')
            family.receipt(self.kernel.wait_owned(owned,2000),('EXITED',))
            family.exited=True
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

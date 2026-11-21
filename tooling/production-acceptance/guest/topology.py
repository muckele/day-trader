"""Bounded Task 10 topology admission and explicitly selected native adapter.

Import is inert. Native bindings are only constructed by ``select_native_topology``
for the pinned guest platform; this module never selects or executes them itself.
"""
from dataclasses import dataclass, field, replace
import hashlib
import hmac
import importlib.util
import json
import os
import pathlib
import re
import secrets
import sys
import threading
import struct
import time
import weakref


class TopologyError(ValueError):
    """Finite public failure without raw observation data."""


class ActivationFailure(RuntimeError):
    """Typed failure that never drops the pre-effect cleanup transaction."""
    def __init__(self, code, cleanup):
        super().__init__(code)
        self.cleanup = cleanup


class CleanupFailure(TopologyError):
    """The exact retained cleanup authority survives terminal failure."""
    def __init__(self, cleanup):
        super().__init__('CLEANUP_UNCERTAIN')
        self.cleanup = cleanup


# Routine (non-terminal) probe-family stop step. Mirrors
# confinement_probe.PROBE_FAMILY_STOP_MS; a binding test keeps them equal.
PROBE_FAMILY_STOP_MS = 2000


class CleanupBudget:
    """One shared cleanup end, started only at the first terminal event (C1).

    The first stop, cancel, failure, drift or expiry allocates one absolute
    guest-monotonic end at start+60000ms, also bounded against a stalled
    injected clock by a real-time end. Later starts never move either end.
    Routine work uses ``routine_call`` with a fixed bounded step and never
    starts or reads the shared end. A timed-out call keeps running only with
    its retained original owner. No retry or replacement owner is launched.
    """
    def __init__(self, clock=None, *, real_clock=None):
        self.clock, self.deadline, self.real_deadline = clock, None, None
        self.last = None
        self.lock = threading.RLock()
        self._started = False
        self._real = real_clock if real_clock is not None else (
            lambda: time.monotonic_ns() // 1000000)

    @property
    def started(self):
        with self.lock: return self._started

    def _now(self):
        """(guest monotonic, real) from one sample, or None if either fails."""
        try:
            real = self._real()
            if type(real) is not int or real < 0: raise ValueError('clock')
            sample = self.clock.sample() if self.clock else (0, real)
            if not _sample(sample) or (self.last is not None and sample[1] < self.last):
                raise ValueError('clock')
        except Exception:
            return None
        self.last = sample[1]
        return sample[1], real

    def _start_locked(self):
        """Allocate the one end once; returns its allowance, or None if started."""
        if self._started: return None
        self._started = True
        now = self._now()
        if now is None:
            # A failed clock at the terminal event permits nonblocking cleanup only.
            self.deadline, self.real_deadline = 0, 0
            return 0
        self.deadline, self.real_deadline = now[0] + 60000, now[1] + 60000
        return 60000

    def start_terminal(self):
        """Start the shared end at this terminal event; return the allowance."""
        with self.lock:
            allowance = self._start_locked()
            return self.remaining() if allowance is None else allowance

    def remaining(self):
        """Allowance until the started end. Never allocates (C1)."""
        with self.lock:
            if not self._started: _fail('CLEANUP_NOT_STARTED')
            now = self._now()
            if now is None:
                self.deadline = 0
                return 0
            return max(0, min(self.deadline - now[0], self.real_deadline - now[1]))

    def clamp(self, remaining_ms):
        """A caller's stop is a terminal event: start, then shorten to its cap."""
        with self.lock:
            current = self.start_terminal()
            try:
                real = self._real()
                if type(real) is not int or real < 0: raise ValueError('clock')
            except Exception:
                self.deadline = 0
                return 0
            if self.last is None:
                self.deadline = 0
                self.real_deadline = real
                return 0
            self.deadline = min(self.deadline, self.last + remaining_ms)
            self.real_deadline = min(self.real_deadline, real + remaining_ms)
            return min(current, remaining_ms)

    def clamp_end(self, end_ms):
        """Terminal: start, then shorten to an earlier absolute monotonic end."""
        with self.lock:
            self._start_locked()
            if type(end_ms) is not int or end_ms < 0: end_ms = 0
            self.deadline = min(self.deadline, end_ms)

    def call(self, operation):
        """Terminal cleanup call bounded by the shared end; requires started."""
        remaining = self.remaining()
        if not remaining: _fail('CLEANUP_UNCERTAIN')
        done, outcome = threading.Event(), []
        def invoke():
            try:
                allowance = self.remaining()
                if not allowance: _fail('CLEANUP_UNCERTAIN')
                outcome.append((True, operation(allowance)))
            except BaseException as error:
                outcome.append((False, error))
            finally: done.set()
        threading.Thread(target=invoke, daemon=True).start()
        while not done.wait(min(remaining / 1000, 0.01)):
            remaining = self.remaining()
            if not remaining: _fail('CLEANUP_UNCERTAIN')
        if not outcome[0][0]: raise outcome[0][1]
        if not self.remaining(): _fail('CLEANUP_UNCERTAIN')
        return outcome[0][1]

    def routine_call(self, operation, step_ms=PROBE_FAMILY_STOP_MS):
        """Routine, non-terminal step with a fixed bounded wait (C1, D-1).

        Never starts the shared end. Before a terminal event the operation
        gets ``step_ms``; once one has started the end it gets
        ``min(step_ms, remaining())``. The wait is bounded by the step and by
        any end started meanwhile.
        """
        if type(step_ms) is not int or not 0 < step_ms <= 60000:
            _fail('CLEANUP_UNCERTAIN')
        with self.lock:
            started = self._started
            if not started:
                now = self._now()
                if now is None: _fail('CLEANUP_UNCERTAIN')
                step_end = (now[0] + step_ms, now[1] + step_ms)
        if started:
            return self.call(lambda allowance: operation(min(step_ms, allowance)))
        def left():
            with self.lock:
                now = self._now()
                if now is None: return 0
                value = min(step_end[0] - now[0], step_end[1] - now[1])
                if self._started:
                    value = min(value, self.deadline - now[0],
                                self.real_deadline - now[1])
                return max(0, value)
        done, outcome = threading.Event(), []
        def invoke():
            try: outcome.append((True, operation(step_ms)))
            except BaseException as error: outcome.append((False, error))
            finally: done.set()
        threading.Thread(target=invoke, daemon=True).start()
        remaining = step_ms
        while not done.wait(min(remaining / 1000, 0.01)):
            remaining = left()
            if not remaining: _fail('CLEANUP_UNCERTAIN')
        if not outcome[0][0]: raise outcome[0][1]
        if not left(): _fail('CLEANUP_UNCERTAIN')
        return outcome[0][1]


def _fail(code):
    raise TopologyError(code)


def _dependency(filename, name):
    target = pathlib.Path(__file__).with_name(filename).resolve()
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, target)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _fixed_dependency(target, name):
    target = pathlib.Path(target).resolve()
    if name in sys.modules:
        module = sys.modules[name]
        if pathlib.Path(getattr(module, '__file__', '')).resolve() != target:
            raise ImportError('fixed dependency identity mismatch')
        return module
    spec = importlib.util.spec_from_file_location(name, target)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_CONFINEMENT = _dependency('confinement.py', '_acceptance_topology_confinement')
_PROXY = _dependency('proxy.py', '_acceptance_topology_proxy')
_PROBES = _fixed_dependency(pathlib.Path(__file__).resolve().parents[1] /
    'tests/guest/confinement_probe.py', '_acceptance_topology_confinement_probe')
RuntimeGateUnavailable = _PROBES.RuntimeGateUnavailable
# The two kernel port types a consumer accepts, by exact type, never isinstance
# (T8-05, P11). Only NativeKernelPort counts as native.
_KERNEL_PORTS = (_CONFINEMENT.NativeKernelPort, _CONFINEMENT.OfflineKernelPort)
_RUN = re.compile(r'[0-9a-f]{32}')
_DIGEST = re.compile(r'[0-9a-f]{64}')
_MAX = 9007199254740991
# R4 (T10-7): guest-local window from the observation sample to the bracket end,
# on the guest clock only. Stage 2 may tighten it, never widen it.
GUEST_OBSERVATION_WINDOW_MS = 100
# C2 (E2): the host challenge is 16 random host bytes as 32 lowercase hex.
_HOST_CHALLENGE = re.compile(r'[0-9a-f]{32}')
_TOPOLOGY_ADMISSION = 'topology-admission'
_VSOCK_STREAM = 'vsock-stream'

HOST_DEVICES = (
    'LINUX_BOOT', 'VIRTIO_BLOCK_READ_ONLY', 'VIRTIO_ENTROPY',
    'VIRTIO_SERIAL_PRIVATE_PIPE', 'VIRTIO_VSOCK_CID2_PORT4050',
)
ROLE_UIDS = tuple(_CONFINEMENT.UIDS.items())
FIXED_PROBE_IDS = (
    'BROWSER_FD_DONOR', 'BROWSER_HELPER_IPV4', 'BROWSER_HELPER_IPV6',
    'BROWSER_IO_URING', 'BROWSER_IPV4_TCP', 'BROWSER_IPV6_TCP',
    'BROWSER_UDP', 'BROWSER_VSOCK', 'CONTROLLER_DNS_TCP',
    'CONTROLLER_DNS_UDP', 'PROXY_VSOCK_CONTROL', 'VERIFIER_IPV4_TCP',
)
NATIVE_OBSERVATION_PATHS = (
    '/proc/net/dev', '/proc/net/route', '/proc/net/ipv6_route',
    '/etc/resolv.conf', '/proc/net/tcp', '/proc/net/tcp6',
    '/proc/net/udp', '/proc/net/udp6', '/proc/net/unix',
)

# Linux 6.8 ABI values used by the /proc parsers (Task 4, R17 C4). Each is
# bound to coverage v2 by abi_coverage_test; nothing else spells them.
_RTF_UP = 0x0001  # include/uapi/linux/route.h:51
_RTF_GATEWAY = 0x0002  # include/uapi/linux/route.h:52
_RTF_REJECT = 0x0200  # include/uapi/linux/route.h:61
_RTF_NONEXTHOP = 0x00200000  # include/uapi/linux/ipv6_route.h:27
_RTF_LOCAL = 0x80000000  # include/uapi/linux/ipv6_route.h:40
_TCP_ESTABLISHED = 1  # include/net/tcp_states.h:13
_TCP_LISTEN = 10  # include/net/tcp_states.h:22 (implicit: tenth enumerator from 1)

# T10-2: the only /proc/net/ipv6_route rows that are not forbidden routes, as
# printed by ipv6_route_native_seq_show (net/ipv6/ip6_fib.c:2481-2512). Fields:
# (destination, prefix length, source, source prefix length, gateway, metric,
# use, flags, device); addresses are the 16 network-order bytes of %pi6. The
# reference count (:2508, refcount_read of fib6_ref) is live state, validated
# as >= 1 by _routes6 and never part of a shape.
_KERNEL_DEFAULT_IPV6_ROWS = (
    # fib6 null entry, the leaf of every table root (ip6_fib.c:245-247,
    # :2381-2384, :2393-2396), yielded by the walk as an RTN_RTINFO node
    # (:2100-2108). net/ipv6/route.c:285-292 fib6_null_entry_template: flags
    # RTF_REJECT|RTF_NONEXTHOP (:286), metric ~(u32)0 (:288); the copy of
    # :6476-6477 keeps the zeroed destination and fib6_nh of fib6_info_alloc
    # (ip6_fib.c:147-164), so no gateway (:2499-2504); the device is the
    # loopback device "lo" (route.c:6273-6274, drivers/net/loopback.c:214).
    (bytes(16), 0, bytes(16), 0, bytes(16), 0xffffffff, 0,
     _RTF_REJECT | _RTF_NONEXTHOP, 'lo'),
    # ::1/128 local route of lo: init_loopback/add_addr (net/ipv6/addrconf.c:
    # 3233-3248, :3144-3167) -> ipv6_add_addr -> addrconf_f6i_alloc (addrconf.c:
    # 1131; route.c:4546-4583: RT6_TABLE_LOCAL :4553, ifindex lo :4554, flags
    # RTF_UP|RTF_NONEXTHOP :4555 | RTF_LOCAL :4569, ::1/128 :4556-4557, no
    # fc_metric so metric 0 at route.c:3776, flags kept at :3778, not made a
    # reject route by fib6_is_reject :3498-3507), inserted by __ipv6_ifa_notify
    # (addrconf.c:6221).
    (bytes(15) + b'\x01', 128, bytes(16), 0, bytes(16), 0, 0,
     _RTF_UP | _RTF_NONEXTHOP | _RTF_LOCAL, 'lo'),
)

# Reviewed Linux 6.8 event constants. Native selection remains unavailable
# below because Task 2 could not establish exhaustive rule enumeration or a
# combined delivery fence. These values only drive bounded literal parsing and
# inert contract tests; they do not qualify the host running this module.
_EVENT_SOURCES = ('AUDIT', 'ROUTE', 'UEVENT', 'INOTIFY')
_EVENT_IDS = ('DEVICE', 'NIC', 'ROUTE', 'DNS', 'LISTENER', 'UNIX', 'ROLE',
              'OVERFLOW', 'SOURCE_DIED')
_EVENT_TRUNCATED = 1
_EVENT_ENOBUFS = 2
_ROUTE_GROUPS = 1 | 16 | 64 | 256 | 1024
_INOTIFY_MASK = (2 | 4 | 8 | 64 | 128 | 256 | 512 | 1024 | 2048 |
                 8192 | 16384 | 32768 | 33554432 | 268435456)
_NATIVE_EVENT_SEMANTICS_UNAVAILABLE = (
    'AUDIT_RULE_ENUMERATION', 'AUDIT_DELIVERY', 'ROUTE_DELIVERY',
    'COMBINED_EFFECT_FENCE',
)
# E-1b (P45; task-8b brief "E-1b rule"): the only Chromium namespace-sandbox
# calls admitted without an event, from a BROWSER-family pid other than the
# transition root once the transition is ACTIVE: chroot, and unshare whose a0
# is exactly CLONE_NEWUSER (never a mask test). abi_coverage_test binds both
# constants to __NR_chroot, __NR_unshare and CLONE_NEWUSER.
_SANDBOX_ADMITTED_SYSCALLS = (51, 97)
_SANDBOX_UNSHARE_FLAGS = 0x10000000
# Audit record text (kernel/auditsc.c audit_log_exit :1693-1709, audit_log_name
# :1513-1595, audit_log_execve_info :1125-1270). Fields are " key=value"; an
# untrusted string value is quoted or hex (kernel/audit.c:2090-2130), so no
# value holds a space. a0 is " a0=%lx": lowercase hex, no 0x, no leading zero
# (lib/vsprintf.c), at most 16 digits on LP64. PATH inode is %lu and dev is
# %02x:%02x of the kernel MAJOR/MINOR.
# P62: NLMSG_ALIGN(sizeof(struct nlmsghdr)), include/uapi/linux/netlink.h:100
# (struct nlmsghdr at :52-58 is two u32, two u16 and a u32: 16 bytes).
_NLMSG_HDRLEN = 16
# P63: audit serials are unique, not ordered (audit_serial, kernel/audit.c:
# 1829-1834, taken at the first audit_log_start, kernel/auditsc.c:2522-2528;
# the record is queued only at audit_log_end, kernel/audit.c:2442). A new group
# may start below the highest serial seen, within this window, never twice.
_AUDIT_SERIAL_WINDOW = 1024
# P86 (a): the boot AUDIT_KERNEL record exactly as audit_init logs it,
# audit_log(NULL, ..., "state=initialized audit_enabled=%u res=1") (kernel/
# audit.c:1722-1724), under the header "audit(%llu.%03lu:%u): " (:1924-1925):
# seconds with no leading zero, three-digit milliseconds, a fresh nonzero serial
# (no context, :1836-1842). Boot audit=1 sets audit_enabled to AUDIT_ON (:1734-
# 1747; include/linux/audit.h:153 AUDIT_ON 1; C10).
_AUDIT_KERNEL_TEXT = re.compile(r'audit\((?:0|[1-9][0-9]*)\.[0-9]{3}:[1-9][0-9]*\): '
                                r'state=initialized audit_enabled=1 res=1')
# P86(b'), P85: the install's own audit operations. One AUDIT_SET whose request
# mask is the OR of AUDIT_STATUS_ENABLED, _FAILURE, _PID, _RATE_LIMIT and
# _BACKLOG_LIMIT, then one AUDIT_ADD_RULE of _FIXED_AUDIT_RULE, each sent as one
# sendto(2) to sockaddr_nl{AF_NETLINK, nl_pid 0} (P88, a C10 contract for the
# native binding).
_AUDIT_SET_MASK = 1 | 2 | 4 | 8 | 16
# One (status field, new value, value before the request) per _AUDIT_SET_MASK bit,
# in bit order, the order audit_receive_msg tests them (kernel/audit.c:1259,
# :1264, :1269, :1330, :1335). The new values are the ones the health check
# requires; None is the owner's own pid. The previous values are Linux 6.8's:
# audit_enabled 1 with boot audit=1 (:1734-1747), audit_failure AUDIT_FAIL_PRINTK
# 1 (:79), no receiver 0, audit_rate_limit 0 (:115), audit_backlog_limit 64
# (:119; C10: no audit_backlog_limit= boot parameter).
_AUDIT_SET_CHANGES = (('audit_enabled', 1, 1), ('audit_failure', 0, 1),
                      ('audit_pid', None, 0), ('audit_rate_limit', 0, 0),
                      ('audit_backlog_limit', 256, 64))
# audit_log_session_info "auid=%u ses=%u" (kernel/audit.c:2164-2170) of a task
# that inherits init_task's unset loginuid and sessionid (init/init_task.c:
# 133-134; AUDIT_UID_UNSET and AUDIT_SID_UNSET are (unsigned int)-1, include/uapi/
# linux/audit.h:503-504). C10: nothing writes the bootstrap's loginuid, and no LSM
# adds " subj=" (kernel/audit.c:2188-2190).
_AUDIT_UNSET_SESSION = 'auid=4294967295 ses=4294967295'
_EVENT_OWNER = 'EVENT_OWNER'
_AUDIT_FIELD = re.compile(r'(?:^| )([A-Za-z_][A-Za-z0-9_]*)=([^ ]+)')
_AUDIT_A0 = re.compile(r'0|[1-9a-f][0-9a-f]{0,15}')
_AUDIT_INODE = re.compile(r'[1-9][0-9]{0,19}')
_AUDIT_DEV = re.compile(r'([0-9a-f]{2}|[1-9a-f][0-9a-f]{2,7}):'
                        r'([0-9a-f]{2}|[1-9a-f][0-9a-f]{2,7})')


def _fixed_audit_rule():
    words = [0] * 64
    for number in (33, 39, 40, 41, 51, 93, 94, 97, 200, 201, 220, 221,
                   268, 281, 435):
        words[number // 32] |= 1 << (number % 32)
    fields = [0] * 64; values = [0] * 64; operators = [0] * 64
    fields[0], values[0], operators[0] = 11, 3221225655, 1073741824
    return struct.pack('<III64I64I64I64II', 4, 2, 1, *words, *fields,
                       *values, *operators, 0)


_FIXED_AUDIT_RULE = _fixed_audit_rule()


def _install_config_bodies(pid):
    """P86(b'): the exact AUDIT_CONFIG_CHANGE bodies (after the "audit(...): "
    header) of the install's two groups, keyed 0 (AUDIT_SET) and 1 (AUDIT_ADD_RULE).
    audit_log_config_change prints "op=set %s=%u old=%u ", the session and
    " res=%d" (kernel/audit.c:383-399): one record per mask bit. The rule change is
    audit_log_rule_change (kernel/auditfilter.c:1108-1124): the session, " op=",
    " key=(null)" with no filterkey (kernel/audit.c:2172-2179) and " list=%d res=%d"
    with listnr = flags & ~AUDIT_FILTER_PREPEND (auditfilter.c:245, :277), here the
    fixed rule's own flags word."""
    changes = [change for bit, change in enumerate(_AUDIT_SET_CHANGES)
               if _AUDIT_SET_MASK >> bit & 1]
    listnr = struct.unpack_from('<I', _FIXED_AUDIT_RULE)[0]
    return {0: tuple('op=set %s=%d old=%d %s res=1' % (
                name, pid if new is None else new, old, _AUDIT_UNSET_SESSION)
                for name, new, old in changes),
            1: ('%s op=add_rule key=(null) list=%d res=1' % (_AUDIT_UNSET_SESSION, listnr),)}
_OFFLINE_EVENT_NATIVE_SEAL = object()
_EVENT_CHECKPOINT_SEAL = object()


def _event_nlmsg(kind, sequence, payload, *, flags=0):
    if (type(kind) is not int or not 0 <= kind <= 65535
            or type(sequence) is not int or not 0 <= sequence <= 2**32 - 1
            or type(flags) is not int or not 0 <= flags <= 65535
            or type(payload) is not bytes or len(payload) > 65520):
        _fail('EVENT_RECORD_DENIED')
    return struct.pack('<IHHII', _NLMSG_HDRLEN + len(payload), kind, flags,
                       sequence, 0) + payload


def _event_header(data):
    if type(data) is not bytes or not _NLMSG_HDRLEN <= len(data) <= 65536:
        _fail('EVENT_RECORD_DENIED')
    return struct.unpack_from('<IHHII', data)


def _parse_event_nlmsg(data, *, audit_unicast=False):
    """One netlink message. Strict nlmsg_len == len(data) for replies, ROUTE
    and any multicast copy. P62: an asynchronous AUDIT record on the unicast
    receiver path carries nlmsg_len = skb->len - NLMSG_HDRLEN
    (kernel/audit.c:2439, sent unrepaired at :715; only the multicast copy is
    repaired, :819-832), so exactly nlmsg_len + NLMSG_HDRLEN == len(data)."""
    length, kind, flags, sequence, pid = _event_header(data)
    whole = length + _NLMSG_HDRLEN if audit_unicast else length
    if whole != len(data) or pid != 0:
        _fail('EVENT_RECORD_DENIED')
    return kind, flags, sequence, data[_NLMSG_HDRLEN:]


@dataclass(frozen=True, slots=True)
class EventCheckpoint:
    _binding: object = field(repr=False)
    generation: int
    sequence: int
    sourceIdentity: str
    lostCount: int
    _seal: object = field(repr=False, compare=False)

    def __post_init__(self):
        if (self._seal is not _EVENT_CHECKPOINT_SEAL
                or type(self._binding) is not _CONFINEMENT.CompositionBinding
                or not _integer(self.generation, 1)
                or not _integer(self.sequence, 1)
                or _RUN.fullmatch(self.sourceIdentity) is None
                or not _integer(self.lostCount)):
            _fail('EVENT_CHECKPOINT_DENIED')

    @property
    def binding(self):
        return self._binding

    def to_record(self):
        return {'binding': self._binding.to_record(), 'generation': self.generation,
                'sequence': self.sequence, 'sourceIdentity': self.sourceIdentity,
                'lostCount': self.lostCount}


@dataclass(frozen=True)
class _OfflineEventNative:
    native: object = field(repr=False)
    _seal: object = field(repr=False)


@dataclass(frozen=True)
class _OfflineFenceRecords:
    records: tuple
    supported: bool
    _seal: object = field(repr=False)


class BrowserTransitionReservation:
    """One nominal bootstrap-only reservation; no wire projection exists."""
    __slots__ = ('_event_owner', '_binding', '_generation', '_handoff',
                 '_runtime_owner', '_proxy_authority', '_proxy_runtime_id',
                 '_proxy_facts', '_used', '_seal')

    def __init__(self, event_owner, binding, generation, handoff,
                 runtime_owner, proxy_authority, runtime_id, proxy_facts, seal=None):
        if seal is not _OFFLINE_EVENT_NATIVE_SEAL:
            _fail('AUTHORITY_LOST')
        self._event_owner, self._binding, self._generation = (
            event_owner, binding, generation)
        self._handoff, self._runtime_owner, self._proxy_authority = (
            handoff, runtime_owner, proxy_authority)
        self._proxy_runtime_id, self._proxy_facts = runtime_id, proxy_facts
        self._used, self._seal = False, seal


def qualify_offline_fence_records(records, supported):
    """Seal an inert combined-fence result and its original-stream records."""
    if (type(records) is not tuple or type(supported) is not bool
            or len(records) > 256
            or any(type(row) is not tuple or len(row) != 5 for row in records)):
        _fail('ADAPTER_DENIED')
    return _OfflineFenceRecords(records, supported, _OFFLINE_EVENT_NATIVE_SEAL)


def qualify_offline_event_native(native):
    """Seal a literal-record double; never native qualification."""
    methods = ('retain_pending', 'open_audit', 'open_route', 'open_uevent',
               'open_inotify', 'open_wakeup_pipe', 'poll_selector',
               'add_inotify_watch', 'install_audit_rule', 'audit_request',
               'poll_records', 'delivery_barrier',
               'close_owned', 'cleanup_pending', 'current_monotonic_ms')
    if (any(not callable(getattr(native, name, None)) for name in methods)
            or type(getattr(native, 'audit_receiver_pid', None)) is not int
            or not 1 <= native.audit_receiver_pid <= 2**32 - 1
            or type(getattr(native, 'audit_role_pids', None)) is not dict
            or set(native.audit_role_pids.values()) != set(_CONFINEMENT.UIDS)
            or len(native.audit_role_pids) != 4
            or any(type(pid) is not int or not 1 <= pid <= 2**31 - 1
                   or type(role) is not str
                   for pid, role in native.audit_role_pids.items())
            or getattr(native, 'selector_kind', None) != 'selectors.PollSelector'
            or not _browser_executable(getattr(native, 'browser_executable', None))):
        _fail('ADAPTER_DENIED')
    return _OfflineEventNative(native, _OFFLINE_EVENT_NATIVE_SEAL)


def _browser_executable(value):
    """The installed confinement.CHROME identity as audit PATH prints it:
    (MAJOR(dev), MINOR(dev), inode). The event port reports it once; the owner
    retains it and compares every Chromium exec against it."""
    return (type(value) is tuple and len(value) == 3
            and all(type(part) is int for part in value)
            and 0 <= value[0] <= 2**32 - 1 and 0 <= value[1] <= 2**32 - 1
            and 1 <= value[2] <= 2**64 - 1)


def select_native_bootstrap_event_source(reference, platform_name, machine):
    """Reviewed native constructor boundary: Task 2 remains unavailable."""
    if platform_name != 'linux' or machine != 'aarch64':
        _fail('ADAPTER_DENIED')
    # AUDIT_RULE_ENUMERATION, AUDIT_DELIVERY, ROUTE_DELIVERY and the
    # COMBINED_EFFECT_FENCE are source-reviewed UNAVAILABLE. No local runtime,
    # empty queue or successful PollSelector construction can upgrade them.
    _fail('NATIVE_EVENT_BARRIER_UNAVAILABLE')


class BootstrapEventOwner:
    """One finite original event owner with sticky failure and cleanup."""
    def __init__(self, binding, native, budget, seal=None):
        if (seal is not _OFFLINE_EVENT_NATIVE_SEAL
                or type(binding) is not _CONFINEMENT.CompositionBinding
                or type(native) is not _OfflineEventNative
                or native._seal is not _OFFLINE_EVENT_NATIVE_SEAL
                or type(budget) is not CleanupBudget):
            _fail('AUTHORITY_LOST')
        self.binding, self._native, self._port, self._budget = (
            binding, native, native.native, budget)
        self._source_identity = secrets.token_hex(16)
        self.generation, self.sequence = 1, 0
        self._sources, self._wakeup, self.selector = {}, None, None
        self._obligations, self._pending_groups = [], {}
        self._pending_count, self._pending_bytes = 0, 0
        self._audit_sequence, self._lost, self._last_health = 0, None, None
        self._audit_pids = dict(self._port.audit_role_pids)
        self._highest_audit_serial, self._seen_audit_serials = 0, set()
        # P86: asynchronous AUDIT records consumed so far, and whether install
        # completed (the end of the install window).
        self._audit_records, self._installed = 0, False
        # P86(b'), P87: the install's two expected groups still to consume (0
        # AUDIT_SET, 1 AUDIT_ADD_RULE), the pending group claiming each, the
        # install's start on the event clock and whether its steps returned.
        self._install_expected = _install_config_bodies(self._port.audit_receiver_pid)
        self._install_claims, self._install_started, self._install_done = {}, None, False
        self._uevent_sequence = None
        self._drift = False
        self._last_clock = None
        self._terminal, self._cleanup_status = None, None
        self._browser_reservation, self._browser_transition = None, None
        self._browser_executable = self._port.browser_executable
        if not _browser_executable(self._browser_executable):
            _fail('AUTHORITY_LOST')
        self._lock = threading.RLock()

    @property
    def descriptor_count(self): return len(self._sources)

    @property
    def wakeup_descriptor_count(self):
        return 2 if self._wakeup is not None else 0

    def _acquire(self, kind, operation):
        token = self._port.retain_pending(kind)
        self._obligations.append(('pending', token))
        owner = operation()
        if owner is None or not callable(getattr(owner, 'fileno', None)):
            _fail('EVENT_SETUP_DENIED')
        self._obligations.pop()
        self._obligations.append(('owner', owner))
        return owner

    def _install(self):
        try:
            self._check_binding()
            started = self._port.current_monotonic_ms()
            if type(started) is not int or started < 0:
                self._terminate('EVENT_SOURCE_TERMINAL')
            self._install_started = started  # P87: the drain bound counts from here
            self._sources['AUDIT'] = self._acquire('AUDIT', self._port.open_audit)
            self._port.install_audit_rule(self._sources['AUDIT'], _FIXED_AUDIT_RULE)
            self._sources['ROUTE'] = self._acquire(
                'ROUTE', lambda: self._port.open_route(_ROUTE_GROUPS))
            self._sources['UEVENT'] = self._acquire('UEVENT', self._port.open_uevent)
            self._sources['INOTIFY'] = self._acquire('INOTIFY', self._port.open_inotify)
            watches = (self._port.add_inotify_watch(
                self._sources['INOTIFY'], path, _INOTIFY_MASK)
                for path in ('/etc', '/etc/resolv.conf'))
            if tuple(watches) != (1, 2): _fail('EVENT_SETUP_DENIED')
            token = self._port.retain_pending('WAKEUP')
            self._obligations.append(('pending', token))
            self._wakeup = self._port.open_wakeup_pipe()
            if (self._wakeup is None
                    or not callable(getattr(self._wakeup, 'filenos', None))):
                _fail('EVENT_SETUP_DENIED')
            self._obligations.pop(); self._obligations.append(('owner', self._wakeup))
            fds = [owner.fileno() for owner in self._sources.values()]
            wake = self._wakeup.filenos()
            if (len(set(fds + list(wake))) != 6 or any(
                    type(fd) is not int or not 5 <= fd <= 4095
                    for fd in fds + list(wake))):
                _fail('EVENT_SETUP_DENIED')
            self.selector = self._port.poll_selector()
            if (self.selector is None or type(self.selector).__name__ != 'PollSelector'
                    or hasattr(self.selector, 'fileno')
                    or not callable(getattr(self.selector, 'register', None))
                    or not callable(getattr(self.selector, 'close', None))):
                _fail('EVENT_SETUP_DENIED')
            for owner in self._sources.values(): self.selector.register(owner, 1)
            self.selector.register(self._wakeup, 1)
            for endpoint in getattr(self._port, 'role_endpoints', ()):
                self.selector.register(endpoint, 1)
            self._verify_health_and_rules()
            if self._drift:
                self._terminate('EVENT_DRIFT')
            # P87: the install steps returned. Install completes (the P86 window
            # closes) once both expected groups are consumed, here or later in
            # the drain, bounded by the 1000 ms pending bound.
            self._install_done = True
            self._complete_install()
            self._check_pending(installing=True)
        except Exception as error:
            if isinstance(error, TopologyError): failure = error
            else: failure = TopologyError('EVENT_SETUP_DENIED')
            failure.cleanup = self
            raise failure from (None if isinstance(error, TopologyError) else error)

    def _check_binding(self):
        clock = self._budget.clock
        try:
            sample = clock.sample() if clock is not None else (
                time.time_ns() // 1000000, time.monotonic_ns() // 1000000)
        except Exception: self._terminate('EVENT_SOURCE_TERMINAL')
        if (not _sample(sample) or sample[0] >= self.binding.expiresAtMs
                or (self._last_clock is not None
                    and (sample[0] < self._last_clock[0]
                         or sample[1] < self._last_clock[1]))):
            self._terminate('EVENT_SOURCE_TERMINAL')
        self._last_clock = sample

    def _next_audit_sequence(self):
        self._audit_sequence += 1
        if self._audit_sequence > 2**32 - 1: self._terminate('EVENT_SOURCE_TERMINAL')
        return self._audit_sequence

    def _audit_exchange(self, request, sequence, failure_code):
        try:
            records = tuple(self._port.audit_request(
                self._sources['AUDIT'], request, sequence))
        except Exception:
            self._terminate(failure_code)
        if len(records) > 273:
            self._terminate(failure_code)
        replies, total = [], 0
        for value in records:
            if type(value) is not tuple or len(value) != 5:
                self._terminate(failure_code)
            source, sender, observed, raw, flags = value
            if source != 'AUDIT' or flags != 0:
                self._terminate(failure_code)
            try:
                message_sequence = _event_header(raw)[3]
            except TopologyError:
                self._terminate(failure_code)
            if message_sequence == 0:
                # An asynchronous audit record interleaved with the replies (P62:
                # unicast framing, parsed by _audit_record).
                self._record(value)
                continue
            try:
                kind, message_flags, message_sequence, payload = _parse_event_nlmsg(raw)
            except TopologyError:
                self._terminate(failure_code)
            total += len(raw)
            if (message_sequence != sequence or sender != 0
                    or type(observed) is not int or total > 65536):
                self._terminate(failure_code)
            replies.append((kind, message_flags, observed, payload))
        return tuple(replies)

    def _verify_health_and_rules(self):
        now = self._port.current_monotonic_ms()
        if type(now) is not int or now < 0: self._terminate('EVENT_SOURCE_TERMINAL')
        if self._last_health is not None and now - self._last_health > 100:
            self._terminate('EVENT_SOURCE_TERMINAL')
        health_sequence = self._next_audit_sequence()
        health = self._audit_exchange(
            'HEALTH', health_sequence, 'EVENT_SOURCE_TERMINAL')
        if len(health) != 1:
            self._terminate('EVENT_SOURCE_TERMINAL')
        kind, flags, observed, payload = health[0]
        if (kind != 1000 or flags != 0 or not now <= observed <= now + 100
                or len(payload) != 44):
            self._terminate('EVENT_SOURCE_TERMINAL')
        status = struct.unpack('<11I', payload)
        receiver = self._port.audit_receiver_pid
        # P85: the AUDIT_GET reply's mask word is 0. Linux 6.8 memsets the reply
        # (kernel/audit.c:1238) and sets every field except mask (:1239-1250);
        # the AUDIT_STATUS_* OR belongs only to an AUDIT_SET request mask.
        if (status[0] != 0 or status[1:6] != (1, 0, receiver, 0, 256)
                or (self._lost is None and status[6] != 0)
                or (self._lost is not None and status[6] != self._lost)):
            self._terminate('EVENT_SOURCE_TERMINAL')
        if self._lost is None: self._lost = status[6]
        rule_sequence = self._next_audit_sequence()
        records = self._audit_exchange(
            'LIST_RULES', rule_sequence, 'AUDIT_RULES_DENIED')
        if not 2 <= len(records) <= 17:
            self._terminate('AUDIT_RULES_DENIED')
        rules, done = [], False
        for kind, flags, observed, payload in records:
            if not now <= observed <= now + 100:
                self._terminate('AUDIT_RULES_DENIED')
            if done:
                self._terminate('AUDIT_RULES_DENIED')
            if kind == 3:
                if payload or flags not in (0, 2): self._terminate('AUDIT_RULES_DENIED')
                done = True
            elif kind == 1013:
                if flags & 2 != 2 or len(payload) != 1040:
                    self._terminate('AUDIT_RULES_DENIED')
                rules.append(payload)
            else: self._terminate('AUDIT_RULES_DENIED')
        if not done or rules != [_FIXED_AUDIT_RULE]:
            self._terminate('AUDIT_RULES_DENIED')
        self._last_health = now

    def _terminate(self, code):
        if self._terminal is None:
            self._terminal = code; self.generation += 1
            self._pending_groups.clear()
            self._pending_count = self._pending_bytes = 0
        _fail(code)

    def _proxy_facts(self, proxy_authority):
        # E4/C5: one bracketed cross-process observation of the PROXY child.
        if (type(proxy_authority) is not ProxyChildAuthority
                or proxy_authority._binding is not self.binding):
            self._terminate('EVENT_SOURCE_TERMINAL')
        try: value = proxy_authority.observe_current()
        except Exception: self._terminate('EVENT_SOURCE_TERMINAL')
        if (not _keys(value, ('runtimeId', 'rows'))
                or type(value['runtimeId']) is not str
                or _RUN.fullmatch(value['runtimeId']) is None
                or type(value['rows']) is not list
                or sum(row.get('kind') == 'PROXY_LISTENER'
                       for row in value['rows'] if type(row) is dict) != 1):
            self._terminate('EVENT_SOURCE_TERMINAL')
        try:
            facts = tuple((row['fd'], row['kind'], row['device'], row['inode'],
                           row['flags'], tuple(row['tfds'])) for row in value['rows'])
        except (KeyError, TypeError):
            self._terminate('EVENT_SOURCE_TERMINAL')
        return value['runtimeId'], facts

    def reserve_browser_transition(self, binding, generation, browser_handoff,
                                   browser_runtime_owner, proxy_authority):
        """Reserve the sole original Browser-family lifecycle transition."""
        with self._lock:
            if (self._terminal is not None or self._browser_reservation is not None
                    or binding is not self.binding or generation != self.generation
                    or type(browser_handoff) is not _CONFINEMENT.RoleHandoff
                    or browser_handoff.launch.role != 'BROWSER'
                    or type(browser_handoff._kernel) not in _KERNEL_PORTS
                    or self._audit_pids.get(browser_handoff.attestation.pid)
                        != 'BROWSER'
                    or type(proxy_authority) is not ProxyChildAuthority):
                self._terminate('EVENT_SOURCE_TERMINAL')
            try:
                lifecycle = browser_handoff._kernel.runtime_lifecycle(
                    browser_handoff, browser_runtime_owner)
                observed = browser_handoff._kernel.inspect_runtime(
                    browser_handoff, lifecycle, browser_runtime_owner)
                _CONFINEMENT.validate_runtime_observation(
                    observed, browser_handoff, lifecycle)
            except Exception:
                self._terminate('EVENT_SOURCE_TERMINAL')
            if lifecycle != 'WAITING':
                self._terminate('EVENT_SOURCE_TERMINAL')
            runtime_id, proxy_facts = self._proxy_facts(proxy_authority)
            reservation = BrowserTransitionReservation(self, binding, generation,
                browser_handoff, browser_runtime_owner, proxy_authority,
                runtime_id, proxy_facts, _OFFLINE_EVENT_NATIVE_SEAL)
            self._browser_reservation = reservation
            return reservation

    def commit_browser_transition(self, reservation):
        """Consume the exact nominal reservation before the launch effect."""
        with self._lock:
            if (type(reservation) is not BrowserTransitionReservation
                    or reservation is not self._browser_reservation
                    or reservation._seal is not _OFFLINE_EVENT_NATIVE_SEAL
                    or reservation._event_owner is not self or reservation._used
                    or reservation._binding is not self.binding
                    or reservation._generation != self.generation
                    or self._browser_transition is not None):
                self._terminate('EVENT_SOURCE_TERMINAL')
            try:
                lifecycle = reservation._handoff._kernel.runtime_lifecycle(
                    reservation._handoff, reservation._runtime_owner)
                observed = reservation._handoff._kernel.inspect_runtime(
                    reservation._handoff, lifecycle,
                    reservation._runtime_owner)
                _CONFINEMENT.validate_runtime_observation(
                    observed, reservation._handoff, lifecycle)
            except Exception:
                self._terminate('EVENT_SOURCE_TERMINAL')
            runtime_id, proxy_facts = self._proxy_facts(reservation._proxy_authority)
            if (lifecycle != 'WAITING'
                    or runtime_id != reservation._proxy_runtime_id
                    or proxy_facts != reservation._proxy_facts):
                self._terminate('EVENT_SOURCE_TERMINAL')
            now = self._port.current_monotonic_ms()
            if type(now) is not int or now < 0:
                self._terminate('EVENT_SOURCE_TERMINAL')
            reservation._used = True
            root = reservation._handoff.attestation.pid
            # Grammar CLONE -> EXEC -> ACTIVE (CB-I4). P61: 'family' holds only
            # initial-namespace pids from audit pid=/ppid= (kernel/audit.c:
            # 2257-2261): the root and every pid first seen with a family ppid.
            # P64: 'exited' maps a family pid removed by exit_group to that
            # exit_group's audit serial, for the P63 window.
            self._browser_transition = {
                'phase': 'CLONE', 'root': root, 'child': None,
                'family': {root}, 'exited': {}, 'committed': now,
            }

    def _attribute(self, pid, ppid):
        """P61: an original role by pid; after commit the BROWSER family by
        initial-namespace pid=/ppid= only. An unknown pid whose ppid is a family
        pid joins the family. A family pid (not the root) whose ppid is not a
        family pid is terminal: genuine members keep a family ppid, because an
        orphan reparents to a live thread of its parent, a subreaper in the same
        PID namespace or the namespace's child reaper (kernel/exit.c:585-600,
        :623-655, :690-706), and each of those is a family pid. So this catches
        a pid reused by a non-family process. Any other unknown pid is terminal.
        P64/P65: a family parent removed by exit_group still counts as a family
        parent, in either serial order, while its exit_group serial is within the
        P63 window: serials are not delivery order (P63), and the kernel logs the
        exit_group (audit_free, kernel/exit.c:853) before it reparents the
        children (exit_notify :891 -> forget_original_parent :736 -> :706), so
        a child's later record may
        still name it. It leaves with the window; pids are allocated cyclically
        (kernel/pid.c:229-237) and every clone is audited, so its number cannot be
        reused within the window (guest pid_max >= 32768, a C10 condition)."""
        role = self._audit_pids.get(pid)
        if role is not None:
            return role
        transition = self._browser_transition
        if transition is not None:
            family, exited = transition['family'], transition['exited']
            parent = ppid in family or ppid in exited
            if pid in family:
                if not parent:
                    self._terminate('EVENT_SOURCE_TERMINAL')
                return 'BROWSER'
            if parent:
                family.add(pid)
                return 'BROWSER'
        self._terminate('EVENT_SOURCE_TERMINAL')

    def _execs_pinned_chromium(self, group, *, launch):
        """EXEC evidence (P59). The executable is AUDIT_PATH item 0: execve and
        execveat take the syscall's first audit name (fs/exec.c:2134, :2144 ->
        getname -> audit_getname, fs/namei.c:204 -> kernel/auditsc.c:2229-2245,
        appended at :2189); opening it records the opened file's inode/dev on
        that same name as NORMAL (do_open_execat, fs/exec.c:1541, :911-951 ->
        do_open, fs/namei.c:3616 -> __audit_inode, kernel/auditsc.c:2325-2381),
        after following /proc/self/exe (fs/proc/base.c:1738-1756). The ELF
        interpreter is a later name (fs/binfmt_elf.c:893 open_exec ->
        getname_kernel, fs/exec.c:968 -> audit_getname, fs/namei.c:253), and
        items are numbered in that order (kernel/auditsc.c:1803-1807). Item 0
        must carry the retained identity. The launch (before ACTIVE, P61 a) also
        names confinement.CHROME literally in the PATH item and in the EXECVE
        argv[0]; a family re-exec in ACTIVE may pass any name."""
        paths = [row for row in group['paths'] if row.get('item') == '0']
        execves = [row for row in group['execves'] if 'argc' in row]
        if len(paths) != 1 or len(execves) != 1:
            return False
        path = paths[0]
        inode = _AUDIT_INODE.fullmatch(path.get('inode', ''))
        dev = _AUDIT_DEV.fullmatch(path.get('dev', ''))
        major, minor, number = self._browser_executable
        if (path.get('nametype') != 'NORMAL' or inode is None or dev is None
                or int(path['inode']) != number
                or (int(dev.group(1), 16), int(dev.group(2), 16)) != (major, minor)):
            return False
        name = '"' + _CONFINEMENT.CHROME + '"'
        return not launch or (path.get('name') == name and execves[0].get('a0') == name)

    def launch_pending(self):
        """P60: a committed transition whose launch is not yet observed (CLONE
        or EXEC) on a live source; its barriers are EVENT_PENDING until ACTIVE
        and terminal after the 1000 ms bound."""
        with self._lock:
            transition = self._browser_transition
            return (self._terminal is None and transition is not None
                    and transition['phase'] in ('CLONE', 'EXEC'))

    def _accept_browser_transition(self, syscall, group):
        transition = self._browser_transition
        if transition is None:
            self._terminate('EVENT_SOURCE_TERMINAL')
        number, pid, phase = syscall['number'], syscall['pid'], transition['phase']
        root, family = transition['root'], transition['family']
        # E13: only the browser root or its family may clone, exec or exit here.
        if syscall['role'] != 'BROWSER' or pid not in family:
            self._terminate('EVENT_SOURCE_TERMINAL')
        if number == 94:
            # P18/P58: the root's exit_group is terminal; there is no EXIT
            # phase. A family exit_group removes that process (P61 d).
            if pid == root:
                self._terminate('BROWSER_EXITED')
            if phase != 'ACTIVE':
                self._terminate('EVENT_SOURCE_TERMINAL')
            family.discard(pid)
            transition['exited'][pid] = syscall['serial']  # P64
            return
        if number in (220, 435):
            # P61: exit= is the child's number in the caller's PID namespace
            # (kernel_clone returns pid_vnr, kernel/fork.c:2915, kernel/pid.c:
            # 489-491), never an audit pid, so it is never stored or compared.
            # Before ACTIVE only the root clones (Node threads included).
            if phase != 'ACTIVE' and pid != root:
                self._terminate('EVENT_SOURCE_TERMINAL')
            if phase == 'CLONE':
                transition['phase'] = 'EXEC'
            return
        if number in (221, 281):
            if (not self._execs_pinned_chromium(group, launch=phase != 'ACTIVE')
                    or pid == root):
                self._terminate('EVENT_SOURCE_TERMINAL')
            if phase != 'ACTIVE':
                # P61 a: the launch is the first pinned exec by a non-root pid
                # whose ppid is the root, before or after the root's clone record.
                if syscall['ppid'] != root:
                    self._terminate('EVENT_SOURCE_TERMINAL')
                transition['child'] = pid
                transition['phase'] = 'ACTIVE'
            # ACTIVE (P59): a family re-exec of the pinned Chromium identity,
            # by any name (Chromium execs /proc/self/exe); never the root.
            return
        self._terminate('EVENT_SOURCE_TERMINAL')

    def _admit_browser_sandbox(self, syscall):
        """E-1b: True only for the exact Chromium namespace-sandbox calls."""
        transition = self._browser_transition
        chroot, unshare = _SANDBOX_ADMITTED_SYSCALLS
        return (transition is not None and transition['phase'] == 'ACTIVE'
                and syscall['role'] == 'BROWSER'
                and syscall['pid'] != transition['root']
                and syscall['success'] is True and syscall['exit'] == 0
                and (syscall['number'] == chroot
                     or (syscall['number'] == unshare
                         and syscall['argument0'] == _SANDBOX_UNSHARE_FLAGS)))

    def _audit_record(self, raw, observed):
        # A malformed record latches the source terminal (it used to raise
        # EVENT_RECORD_DENIED without latching).
        try: kind, flags, sequence, payload = _parse_event_nlmsg(raw, audit_unicast=True)
        except TopologyError: self._terminate('EVENT_SOURCE_TERMINAL')
        if flags & (16 | 4) or sequence != 0:
            self._terminate('EVENT_SOURCE_TERMINAL')
        try: text = payload.decode('ascii')
        except UnicodeError: self._terminate('EVENT_SOURCE_TERMINAL')
        match = re.search(r'audit\([^:]+:([1-9][0-9]*)\):', text)
        if match is None: self._terminate('EVENT_SOURCE_TERMINAL')
        serial = int(match.group(1))
        # P86 (c): a core-dump-signal death anywhere logs a standalone
        # AUDIT_ANOM_ABEND (audit_core_dumps, kernel/auditsc.c:2973-2989). It is
        # complete on arrival and deliberately always terminal (C10): any crash of
        # any process, a Chromium helper included, ends the run.
        if kind == 1701:
            self._terminate('ROLE_ABNORMAL_END')
        first = self._audit_records == 0
        self._audit_records += 1
        if kind == 2000:
            # P86 (a): with boot audit=1 the kernel holds its AUDIT_KERNEL record
            # (kauditd_hold_skb, kernel/audit.c:577-606) and unicasts the hold
            # queue to the first registered receiver ahead of the main queue
            # (:865-868, :885-893). Accepted at most once: only as the first record
            # after registration, before install completes, in the exact 6.8 text.
            # Complete on arrival, no drift; its serial is the first one seen (P63).
            if (self._installed or not first
                    or _AUDIT_KERNEL_TEXT.fullmatch(text) is None):
                self._terminate('EVENT_SOURCE_TERMINAL')
            self._seen_audit_serials.add(serial)
            self._highest_audit_serial = serial
            self.sequence += 1
            return
        # P86 (b), after-install clause: once install completes no configuration
        # change is expected; any AUDIT_CONFIG_CHANGE is terminal on arrival,
        # standalone or inside a syscall group, and never left pending.
        if kind == 1305 and self._installed:
            self._terminate('AUDIT_CONFIG_CHANGED')
        if kind == 1320:
            group = self._pending_groups.pop(serial, None)
            if group is None: self._terminate('EVENT_SOURCE_TERMINAL')
            self._pending_count -= group['count']
            self._pending_bytes -= group['bytes']
            if observed - group['first'] > 1000:
                self._terminate('EVENT_INSTALL_INCOMPLETE' if 'install' in group
                                else 'EVENT_SOURCE_TERMINAL')
            if 'install' in group:
                self._close_install_group(group, observed)
                self.sequence += 1
                return
            if (len(group['syscalls']) != 1
                    or (group['syscalls'][0]['number'] == 200
                        and group['syscalls'][0]['success']
                        and len(group['sockaddrs']) != 1)
                    or (group['syscalls'][0]['number'] != 200
                        and group['sockaddrs'])):
                self._terminate('EVENT_SOURCE_TERMINAL')
            syscall = group['syscalls'][0]
            if syscall['success']:
                if syscall['number'] == 93:
                    # P58: pid= is the tgid, so exit is one thread ending; it
                    # never terminates the run or removes a pid. Process exit is
                    # exit_group; root liveness stays with the role supervisor.
                    pass
                elif syscall['number'] in (94, 220, 221, 281, 435):
                    self._accept_browser_transition(syscall, group)
                elif self._admit_browser_sandbox(syscall):
                    pass
                else:
                    if self._browser_transition is not None:
                        self._terminate('EVENT_SOURCE_TERMINAL')
                    group['events'].add('DEVICE' if syscall['number'] == 33 else
                        ('UNIX' if syscall['number'] == 200
                         and group['sockaddrs'][0] == 1 else
                         'LISTENER' if syscall['number'] in (200, 201) else 'ROLE'))
            if group['events']:
                self._drift = True
            self.sequence += 1
            return
        if kind not in (1300, 1302, 1305, 1306, 1307, 1309, 1327):
            self._terminate('EVENT_SOURCE_TERMINAL')
        if serial not in self._pending_groups:
            # P63: a group serial is new exactly once, within the window below
            # the highest serial seen; a repeat or an older serial is terminal.
            highest = self._highest_audit_serial
            if (serial in self._seen_audit_serials
                    or highest - serial > _AUDIT_SERIAL_WINDOW):
                self._terminate('EVENT_SOURCE_TERMINAL')
            self._seen_audit_serials.add(serial)
            if serial > highest:
                self._highest_audit_serial = serial
                floor = serial - _AUDIT_SERIAL_WINDOW
                self._seen_audit_serials = {
                    seen for seen in self._seen_audit_serials if seen >= floor}
                transition = self._browser_transition
                if transition is not None:  # P64: exited members leave with the window
                    transition['exited'] = {
                        pid: ended for pid, ended in transition['exited'].items()
                        if ended >= floor}
        group = self._pending_groups.setdefault(serial, {
            'first': observed, 'events': set(), 'count': 0, 'bytes': 0,
            'syscalls': [], 'sockaddrs': [], 'paths': [], 'execves': [],
            'configs': [], 'proctitles': 0})
        group['count'] += 1; group['bytes'] += len(raw)
        self._pending_count += 1; self._pending_bytes += len(raw)
        if (len(self._pending_groups) > 64 or self._pending_count > 256
                or self._pending_bytes > 1048576):
            self._terminate('EVENT_SOURCE_TERMINAL')
        if observed - group['first'] > 1000:
            self._terminate('EVENT_INSTALL_INCOMPLETE' if 'install' in group
                            else 'EVENT_SOURCE_TERMINAL')
        pairs = _AUDIT_FIELD.findall(text)
        fields = dict(pairs)
        if kind in (1300, 1302, 1309) and len(fields) != len(pairs):
            self._terminate('EVENT_SOURCE_TERMINAL')
        if kind == 1300:
            # Kernel format (audit_log_exit): every SYSCALL record prints a0
            # exactly once as %lx; exit/exit_group are logged by __audit_free
            # with AUDITSC_INVALID, so they never carry success=/exit=.
            if _AUDIT_A0.fullmatch(fields.get('a0', '')) is None:
                self._terminate('EVENT_SOURCE_TERMINAL')
            try:
                number = int(fields['syscall'])
                pid, ppid = int(fields['pid']), int(fields['ppid'])
            except (KeyError, ValueError):
                self._terminate('EVENT_SOURCE_TERMINAL')
            # P86(b'), P88: an install group's one SYSCALL record is the event
            # owner's own sendto(2) of its AUDIT_SET or AUDIT_ADD_RULE request.
            # Logging the group's first CONFIG_CHANGE stamped the dummy syscall
            # context (kernel/auditsc.c:2522-2537) and cancelled its dummy flag
            # (kernel/audit.c:1920-1923), so audit_log_exit writes it (kernel/
            # auditsc.c:2064-2079, :1678-1818): pid= is the registered receiver
            # (kernel/audit.c:2255-2262) and sendto returns the bytes sent. During
            # install a sendto record outside a claimed install group, or anything
            # else in one, is terminal AUDIT_CONFIG_CHANGED.
            owner_send = 'install' in group or (number == 206 and not self._installed)
            if owner_send:
                try: exit_code = int(fields['exit'])
                except (KeyError, ValueError):
                    self._terminate('AUDIT_CONFIG_CHANGED')
                if ('install' not in group or number != 206 or group['syscalls']
                        or pid != self._port.audit_receiver_pid
                        or fields.get('success') != 'yes' or exit_code <= 0):
                    self._terminate('AUDIT_CONFIG_CHANGED')
                success = True
            elif number in (93, 94):
                if 'success' in fields or 'exit' in fields:
                    self._terminate('EVENT_SOURCE_TERMINAL')
                success, exit_code = True, None
            else:
                try: exit_code = int(fields['exit'])
                except (KeyError, ValueError):
                    self._terminate('EVENT_SOURCE_TERMINAL')
                if (fields.get('success') not in ('yes', 'no')
                        or (fields['success'] == 'yes'
                            and ((number in (220, 435) and exit_code <= 0)
                                 or (number not in (220, 435) and exit_code != 0)))
                        or (fields['success'] == 'no' and exit_code >= 0)):
                    self._terminate('EVENT_SOURCE_TERMINAL')
                success = fields['success'] == 'yes'
            if (fields.get('arch') != 'c00000b7'
                    or (not owner_send
                        and number not in (33, 39, 40, 41, 51, 93, 94, 97, 200,
                                           201, 220, 221, 268, 281, 435))
                    or pid < 1 or ppid < 0):
                self._terminate('EVENT_SOURCE_TERMINAL')
            group['syscalls'].append(dict(number=number,
                success=success, exit=exit_code,
                role=_EVENT_OWNER if owner_send else self._attribute(pid, ppid),
                pid=pid, ppid=ppid, argument0=int(fields['a0'], 16), serial=serial))
        elif kind == 1302:
            group['paths'].append(fields)
        elif kind == 1309:
            group['execves'].append(fields)
        elif kind == 1306:
            try: address = bytes.fromhex(fields['saddr'])
            except (KeyError, ValueError): self._terminate('EVENT_SOURCE_TERMINAL')
            if len(address) < 2:
                self._terminate('EVENT_SOURCE_TERMINAL')
            family = int.from_bytes(address[:2], 'little')
            if family not in (1, 2, 10):
                self._terminate('EVENT_SOURCE_TERMINAL')
            group['sockaddrs'].append(family)
        elif kind == 1305:
            # Only reached during install (after install it ended the run above).
            body = (text[match.end() + 1:] if match.start() == 0
                    and text[match.end():match.end() + 1] == ' ' else '')
            self._install_config(group, body)
        elif kind == 1327:
            group['proctitles'] += 1

    def _install_config(self, group, body):
        """P86(b'): during install a CONFIG_CHANGE is only the next expected body
        of one of the install's own two groups, before that group's SYSCALL record.
        The first body claims the group's expectation (P63: either group may come
        first); anything else is terminal AUDIT_CONFIG_CHANGED."""
        if 'install' not in group:
            matches = [index for index, bodies in self._install_expected.items()
                       if index not in self._install_claims and bodies[0] == body]
            if len(matches) != 1:
                self._terminate('AUDIT_CONFIG_CHANGED')
            group['install'] = matches[0]
            self._install_claims[matches[0]] = group
        expected = self._install_expected[group['install']]
        index = len(group['configs'])
        if group['syscalls'] or (index < len(expected) and expected[index] != body):
            self._terminate('AUDIT_CONFIG_CHANGED')
        group['configs'].append(body)

    def _close_install_group(self, group, observed):
        """P86(b'), P87: an install group closed by EOE inside the drain holds
        exactly its expected CONFIG_CHANGE bodies (compared on arrival, counted
        here), the owner's one sendto SYSCALL record and one PROCTITLE, and nothing
        else. Consuming the second group completes install."""
        if observed - self._install_started > 1000:
            self._terminate('EVENT_INSTALL_INCOMPLETE')
        index, syscalls = group['install'], group['syscalls']
        if (len(group['configs']) != len(self._install_expected[index])
                or len(syscalls) != 1 or syscalls[0]['role'] != _EVENT_OWNER
                or group['proctitles'] != 1
                or group['count'] != len(group['configs']) + 2):
            self._terminate('AUDIT_CONFIG_CHANGED')
        del self._install_expected[index], self._install_claims[index]
        self._complete_install()

    def _record(self, value):
        if type(value) is not tuple or len(value) != 5:
            self._terminate('EVENT_SOURCE_TERMINAL')
        source, sender, observed, raw, flags = value
        if (source not in (*_EVENT_SOURCES, 'ROLE', 'SOURCE_DIED')
                or type(sender) is not int or type(observed) is not int
                or type(raw) is not bytes or len(raw) > 65536
                or type(flags) is not int):
            self._terminate('EVENT_SOURCE_TERMINAL')
        if flags & (_EVENT_TRUNCATED | _EVENT_ENOBUFS):
            self._terminate('EVENT_SOURCE_TERMINAL')
        if source in ('ROLE', 'SOURCE_DIED'):
            self._terminate('EVENT_SOURCE_TERMINAL')
        if sender != 0: self._terminate('EVENT_SOURCE_TERMINAL')
        if source == 'AUDIT': self._audit_record(raw, observed); return
        if source == 'ROUTE':
            try: kind, _, sequence, payload = _parse_event_nlmsg(raw)
            except TopologyError: self._terminate('EVENT_SOURCE_TERMINAL')
            if kind not in (16, 17, 20, 21, 24, 25) or not payload:
                self._terminate('EVENT_SOURCE_TERMINAL')
            # Multicast sequence zero is normal and nonzero is not treated as
            # a universal delivery sequence. Every relevant change still drifts.
            self.sequence += 1; self._drift = True; return
        if source == 'UEVENT':
            try:
                fields = dict(part.split(b'=', 1) for part in raw.rstrip(b'\0').split(b'\0'))
                number = int(fields[b'SEQNUM'])
            except Exception: self._terminate('EVENT_SOURCE_TERMINAL')
            if number <= 0 or (self._uevent_sequence is not None
                               and number != self._uevent_sequence + 1):
                self._terminate('EVENT_SOURCE_TERMINAL')
            self._uevent_sequence = number; self.sequence += 1
            self._drift = True; return
        if source == 'INOTIFY':
            if len(raw) < 16: self._terminate('EVENT_SOURCE_TERMINAL')
            wd, mask, cookie, size = struct.unpack_from('<iIII', raw)
            if len(raw) != 16 + size or wd not in (-1, 1, 2):
                self._terminate('EVENT_SOURCE_TERMINAL')
            if mask & (16384 | 32768 | 8192):
                self._terminate('EVENT_SOURCE_TERMINAL')
            if not mask & _INOTIFY_MASK: self._terminate('EVENT_SOURCE_TERMINAL')
            # Equal adjacent notifications may be coalesced; never infer an
            # event count or delivery fence from their sequence/cookie.
            self.sequence += 1; self._drift = True; return

    def _consume_records(self, records):
        if (type(records) is not tuple or len(records) > 256
                or sum(len(row[3]) for row in records
                       if type(row) is tuple and len(row) == 5) > 1048576):
            self._terminate('EVENT_SOURCE_TERMINAL')
        for value in records:
            self._record(value)

    def _complete_install(self):
        """P87: install completes once its steps returned and both expected install
        groups were consumed."""
        if self._install_done and not self._install_expected:
            self._installed = True

    def _check_pending(self, *, installing=False):
        now = self._port.current_monotonic_ms()
        if type(now) is not int or now < 0:
            self._terminate('EVENT_SOURCE_TERMINAL')
        # P87: the install drain is bounded by the 1000 ms pending bound. An
        # expected install group still missing or open at the bound is terminal.
        if not self._installed and now - self._install_started > 1000:
            self._terminate('EVENT_INSTALL_INCOMPLETE')
        # A committed transition whose launch is not yet observed (CLONE or
        # EXEC) is pending at every barrier and terminal after the same
        # 1000 ms bound as an incomplete group.
        transition = self._browser_transition
        launching = (transition is not None
                     and transition['phase'] in ('CLONE', 'EXEC'))
        if launching and now - transition['committed'] > 1000:
            self._terminate('EVENT_SOURCE_TERMINAL')
        if self._pending_groups:
            if any(now - group['first'] > 1000
                   for group in self._pending_groups.values()):
                self._terminate('EVENT_SOURCE_TERMINAL')
            # At the end of the install steps only the install's own open groups
            # may stay pending (P87); anything else still fails the install.
            if not installing or any('install' not in group
                                     for group in self._pending_groups.values()):
                _fail('EVENT_PENDING')
        if launching:
            _fail('EVENT_PENDING')
        if not self._installed and not installing:
            _fail('EVENT_PENDING')  # P87: the install drain is still open

    def _sealed_fence(self):
        """Process every source through one sealed all-source fence."""
        try: fence = self._port.delivery_barrier(
            tuple(self._sources.values()), self._wakeup, self.selector)
        except Exception: fence = None
        fence_records = (fence.records if type(fence) is _OfflineFenceRecords
            and fence._seal is _OFFLINE_EVENT_NATIVE_SEAL else ())
        try: queued = tuple(self._port.poll_records(self.selector))
        except Exception: self._terminate('EVENT_SOURCE_TERMINAL')
        self._consume_records(fence_records + queued)
        if self._drift: self._terminate('EVENT_DRIFT')
        self._check_pending()
        if (type(fence) is not _OfflineFenceRecords
                or fence._seal is not _OFFLINE_EVENT_NATIVE_SEAL
                or not fence.supported):
            self._terminate('NATIVE_EVENT_BARRIER_UNAVAILABLE')

    def barrier(self):
        with self._lock:
            if self._terminal is not None: _fail('EVENT_SOURCE_TERMINAL')
            self._check_binding()
            try: records = tuple(self._port.poll_records(self.selector))
            except Exception: self._terminate('EVENT_SOURCE_TERMINAL')
            self._consume_records(records)
            if self._drift: self._terminate('EVENT_DRIFT')
            # P60: health and rules are verified before the first pending check,
            # so a barrier held pending by lagging records (at most the 1000 ms
            # bound) still keeps the at-most-100 ms health interval.
            self._verify_health_and_rules()
            if self._drift: self._terminate('EVENT_DRIFT')
            self._check_pending()
            self._sealed_fence()
            self._verify_health_and_rules()
            if self._drift: self._terminate('EVENT_DRIFT')
            self._check_pending()
            # Health/rule verification is itself fallible and may race every
            # producer. A second sealed all-source fence is the final external
            # publication guard; no health request follows it.
            self._sealed_fence()
            self._check_binding()
            self.sequence += 1
            return EventCheckpoint(self.binding, self.generation, self.sequence,
                                   self._source_identity, self._lost,
                                   _EVENT_CHECKPOINT_SEAL)

    def stop_owned(self, remaining_ms):
        if type(remaining_ms) is not int or not 0 <= remaining_ms <= 60000:
            _fail('CLEANUP_UNCERTAIN')
        with self._lock:
            if self._cleanup_status is not None:
                return {'status': self._cleanup_status, 'runId': self.binding.runId}
            self._cleanup_status = 'TIMEOUT'
            if self.selector is not None:
                try: self.selector.close()
                except Exception: pass
            # A stop is a terminal event: start the one shared end, then clamp
            # it to this caller's cap. No direct deadline write (C1).
            try: self._budget.clamp(remaining_ms)
            except Exception: self._budget.clamp_end(0)
            failed = False
            for kind, owner in reversed(self._obligations):
                try:
                    operation = (lambda allowance, owner=owner:
                        self._port.close_owned(owner, allowance)) if kind == 'owner' else (
                        lambda allowance, owner=owner:
                        self._port.cleanup_pending(owner, allowance))
                    allowance = self._budget.remaining()
                    if allowance:
                        self._budget.call(operation)
                    else:
                        operation(0)
                        failed = True
                    if kind == 'owner':
                        if owner is self._wakeup:
                            closed = owner.filenos()
                            if (type(closed) is not tuple
                                    or closed != (-1, -1)):
                                failed = True
                        else:
                            closed = owner.fileno()
                            if type(closed) is not int or closed != -1:
                                failed = True
                except Exception: failed = True
            self._cleanup_status = 'TIMEOUT' if failed else 'STOPPED'
            return {'status': self._cleanup_status,
                    'runId': self.binding.runId}


class LinuxBootstrapEventSource:
    """Fixed factory; it accepts no caller-selected sources, rules or masks."""
    @staticmethod
    def install(binding, native, cleanup_budget):
        owner = BootstrapEventOwner(binding, native, cleanup_budget,
                                    _OFFLINE_EVENT_NATIVE_SEAL)
        owner._install()
        return owner


_PROXY_CHILD_SEAL = object()
_PROXY_CHILD_AUTHORITIES = weakref.WeakKeyDictionary()
# Real-time liveness bound for each FD4 frame read (READY, CURRENT, TERMINAL),
# the read_role cap. Freshness is separate: the client admits a CURRENT only
# within 100 ms of its request on the guest clock (amendment 6.1).
_PROXY_FRAME_WAIT_MS = 1000
_EPOLL_LINK = 'anon_inode:[eventpoll]'


def _bracketed(rows, table):
    """Report rows equal the child's /proc rows (C5).

    Same FD set and order, identity, flags and tfd: targets; above FD4 the link
    must also name the reported kind's object class: an epoll instance for a
    selector, the reported socket inode for a socket. FD0..4 links are checked
    by the role observer against the inherited capture.
    """
    if type(table) is not tuple or len(table) != len(rows):
        return False
    for row, seen in zip(rows, table):
        if ((row['fd'], row['device'], row['inode'], row['flags'], list(row['tfds']))
                != (seen['fd'], seen['device'], seen['inode'], seen['flags'], list(seen['tfds']))):
            return False
        if row['fd'] >= 5 and seen['link'] != (
                _EPOLL_LINK if row['kind'] in _CONFINEMENT._SELECTOR_KINDS
                else 'socket:[' + row['inode'] + ']'):
            return False
    return True


class ProxyChildAuthority:
    """Bootstrap-side PROXY runtime authority across the process boundary (E4, C5).

    It holds no proxy object. Each current check sends one MAC'd request on the
    original PROXY FD3 and reads report A from FD4, then reads the child's own
    /proc/<pid>/fd and fdinfo, then requests report B. All three must agree
    exactly and B must be A's next observation; anything else is terminal
    PROXY_RUNTIME_DRIFT. Built only by the composition's trusted embedding.
    """
    __slots__ = ('_handoff', '_client', '_kernel', '_binding', '_lock',
                 '_runtime_id', '_terminal', '_stopped', '__weakref__')

    def __init__(self, handoff, client, kernel, binding, *, seal=None):
        originals = (_PROXY._CLIENT_ORIGINALS.get(client)
                     if type(client) is _PROXY.ProxyCompositionClient else None)
        if (seal is not _PROXY_CHILD_SEAL or originals is None
                or type(kernel) not in _KERNEL_PORTS
                or type(handoff) is not _CONFINEMENT.RoleHandoff
                or handoff.launch.role != 'PROXY' or handoff._kernel is not kernel
                or type(binding) is not _CONFINEMENT.CompositionBinding
                or originals[0].binding != binding
                or originals[0].child is not handoff._owned
                or originals[0].pipe != (handoff._owned.command, handoff._owned.result)
                or client._state() != (0, 0, 0, None, None, frozenset())):
            _fail('ADAPTER_DENIED')
        # The proxy loop must never run in the bootstrap process: this authority
        # only observes a separate PROXY child, through its pipes and its /proc.
        if handoff.attestation.pid == os.getpid():
            _fail('ADAPTER_DENIED')
        self._handoff, self._client, self._kernel = handoff, client, kernel
        self._binding, self._lock = binding, threading.Lock()
        self._runtime_id = self._terminal = self._stopped = None
        _PROXY_CHILD_AUTHORITIES[self] = (handoff, client, kernel, binding)

    @property
    def runtime_id(self):
        return self._runtime_id

    @property
    def native(self):
        """Derived from the kernel's exact type (P11): an offline port is never native."""
        return type(self._kernel) is _CONFINEMENT.NativeKernelPort

    def _live(self):
        originals = _PROXY_CHILD_AUTHORITIES.get(self)
        if (originals is None or self._terminal is not None or any(a is not b for a, b in zip(
                originals, (self._handoff, self._client, self._kernel, self._binding)))):
            _fail('PROXY_DENIED')

    def _read(self, remaining_ms):
        try:
            return self._kernel.read_proxy_frame(self._handoff._owned, remaining_ms)
        except _CONFINEMENT.ConfinementError as error:
            if str(error) == 'CHANNEL_EOF':
                # Physical EOF revokes at once (amendment 5); no fresh cleanup window.
                try: self._client.accept_frame(b'')
                except Exception: pass
            raise

    def _ready(self):
        with self._lock:
            self._live()
            try:
                if self._runtime_id is not None: _fail('PROXY_DENIED')
                value = self._client.accept_frame(self._read(_PROXY_FRAME_WAIT_MS))
                if type(value) is not dict or value.get('status') != 'READY':
                    _fail('PROXY_DENIED')
            except Exception:
                self._terminal = 'PROXY_DENIED'
                _fail('PROXY_DENIED')
            self._runtime_id = value['runtimeId']

    def _report(self):
        frame = self._client.current(secrets.token_hex(16), 1)
        self._kernel.write_proxy_frame(self._handoff._owned, frame)
        value = self._client.accept_frame(self._read(_PROXY_FRAME_WAIT_MS))
        if type(value) is not dict or value.get('status') != 'CURRENT':
            _fail('PROXY_DENIED')
        return value

    def observe_current(self) -> dict:
        """Report A, then the child's /proc, then report B (C5): {runtimeId, rows}."""
        with self._lock:
            self._live()
            try:
                first = self._report()
            except Exception:
                self._terminal = 'PROXY_DENIED'
                _fail('PROXY_DENIED')
            try:
                table = self._kernel.observe_child_descriptors(self._handoff)
            except Exception:
                self._terminal = 'PROXY_RUNTIME_DRIFT'
                _fail('PROXY_RUNTIME_DRIFT')
            try:
                second = self._report()
            except Exception:
                self._terminal = 'PROXY_DENIED'
                _fail('PROXY_DENIED')
            rows = first['currentFDs']
            if (first['runtimeId'] != self._runtime_id
                    or second['runtimeId'] != self._runtime_id
                    or second['sequence'] != first['sequence'] + 1
                    or second['currentFDs'] != rows
                    or not _bracketed(rows, table)):
                self._terminal = 'PROXY_RUNTIME_DRIFT'
                _fail('PROXY_RUNTIME_DRIFT')
            try:
                self._kernel._adopt_child_inventory(
                    self._handoff, self, tuple(dict(row) for row in rows))
            except Exception:
                self._terminal = 'PROXY_RUNTIME_DRIFT'
                _fail('PROXY_RUNTIME_DRIFT')
            return {'runtimeId': self._runtime_id,
                    'rows': [dict(row, tfds=list(row['tfds'])) for row in rows]}

    def stop_owned(self, remaining_ms):
        """Authenticated PROXY_STOP carrying the one shared cleanup end (amendment 5, 6.1).

        Never overlaps a current check or another stop. Once the original PROXY
        child has a proven terminal receipt its runtime ended with it. Without the
        authenticated channel it sends the bare STOP, which permits nonblocking
        cleanup only, and reports uncertainty; the child stays with the role owner.
        """
        if type(remaining_ms) is not int or not 0 <= remaining_ms <= 60000:
            _fail('CLEANUP_UNCERTAIN')
        run_id = self._binding.runId
        if self not in _PROXY_CHILD_AUTHORITIES or not self._lock.acquire(blocking=False):
            return {'status': 'TIMEOUT', 'runId': run_id}
        try:
            if self._stopped is not None:
                return dict(self._stopped)
            if self._terminal is None:
                self._terminal = 'STOPPED'
            status = 'TIMEOUT'
            budget = _PROXY._CLIENT_ORIGINALS[self._client][0].cleanup_budget
            try:
                budget.start_terminal()
                ended = self._kernel.terminal_receipt(self._handoff._owned)
                if ended is not None:
                    if ended.get('status') not in ('STOPPED', 'EXITED'):
                        _fail('CLEANUP_UNCERTAIN')
                    self._stopped = {'status': 'STOPPED', 'runId': run_id}
                    return dict(self._stopped)
                frame = self._client.stop(secrets.token_hex(16), budget.deadline)
                self._kernel.write_proxy_frame(self._handoff._owned, frame)
                value = self._client.accept_frame(
                    self._read(min(remaining_ms, budget.remaining())))
                if (self._runtime_id is not None and type(value) is dict
                        and value.get('runtimeId') == self._runtime_id
                        and value.get('cleanupStatus') == 'PROVEN'):
                    status = 'STOPPED'
            except Exception:
                try: self._kernel.write_proxy_frame(self._handoff._owned, b'STOP')
                except Exception: pass
            receipt = {'status': status, 'runId': run_id}
            if status == 'STOPPED':
                self._stopped = receipt
            return dict(receipt)
        finally:
            self._lock.release()


def observe_current_roles(handoffs, runtime_owners, proxy_authority, binding):
    """Observe complete runtime state through the accepted original owners.

    PROXY's inventory comes only from its child authority's bracketed report
    A, /proc, report B (E4, C5); R11 replaced the in-process owner gate.
    """
    if (type(handoffs) is not tuple or len(handoffs) != 4
            or type(runtime_owners) is not dict
            or set(runtime_owners) != set(_CONFINEMENT.UIDS)
            or type(proxy_authority) is not ProxyChildAuthority
            or type(binding) is not _CONFINEMENT.CompositionBinding
            or proxy_authority._binding is not binding):
        _fail('ROLE_DENIED')
    expected_roles = tuple(_CONFINEMENT.UIDS)
    result, proxy_rows = [], None
    for handoff, role in zip(handoffs, expected_roles):
        if (type(handoff) is not _CONFINEMENT.RoleHandoff
                or handoff.launch.role != role
                or type(handoff._kernel) not in _KERNEL_PORTS):
            _fail('ROLE_DENIED')
        owner = runtime_owners[role]
        if role == 'PROXY' and (owner is not proxy_authority
                                or handoff is not proxy_authority._handoff):
            _fail('ROLE_DENIED')
        if role == 'PROXY':
            proxy_rows = proxy_authority.observe_current()['rows']
        try:
            lifecycle = handoff._kernel.runtime_lifecycle(handoff, owner)
            expected = {'CONTROLLER': ('SERVICE',),
                        'BROWSER': ('WAITING', 'BROWSER_ACTIVE'),
                        'VERIFIER': ('WAITING',),
                        'PROXY': ('SERVICE',)}[role]
            if lifecycle not in expected:
                _fail('ROLE_DENIED')
            row = handoff._kernel.inspect_runtime(handoff, lifecycle, owner)
            row = _CONFINEMENT.validate_runtime_observation(row, handoff, lifecycle)
        except _CONFINEMENT.ConfinementError as error:
            if str(error) == 'NATIVE_CURRENT_INVENTORY_UNAVAILABLE':
                _fail('NATIVE_CURRENT_INVENTORY_UNAVAILABLE')
            _fail('ROLE_DENIED')
        except TopologyError:
            raise
        except Exception:
            _fail('ROLE_DENIED')
        result.append(row)
    def kernel_facts(rows):
        return [(row['fd'], row['kind'], row['device'], row['inode'], row['flags'])
                for row in rows]
    if kernel_facts(proxy_rows) != kernel_facts(result[3]['currentFDs']):
        _fail('PROXY_RUNTIME_DRIFT')
    return tuple(result)


def _integer(value, lower=0, upper=_MAX):
    return type(value) is int and lower <= value <= upper


def _ascii(value, limit):
    return type(value) is str and value.isascii() and 0 < len(value) <= limit


def _digest(value):
    return type(value) is str and _DIGEST.fullmatch(value) is not None


def _sample(value):
    return (type(value) is tuple and len(value) == 2
            and _integer(value[0]) and _integer(value[1]))


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=True).encode('ascii')


def _keys(value, names):
    return type(value) is dict and set(value) == set(names)


def _wire_shape(value, depth=0):
    if depth > 12:
        return False
    if type(value) is dict:
        return (len(value) <= 128 and all(type(key) is str and _ascii(key, 64)
                and _wire_shape(item, depth + 1) for key, item in value.items()))
    if type(value) is list:
        return len(value) <= 256 and all(_wire_shape(item, depth + 1) for item in value)
    if type(value) is str:
        return value.isascii() and len(value) <= 4096
    if type(value) is int:
        return -_MAX <= value <= _MAX
    return type(value) is bool or value is None


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail('HANDOFF_DENIED')
        result[key] = value
    return result


def _json_integer(value):
    parsed = int(value, 10)
    if not -_MAX <= parsed <= _MAX:
        _fail('HANDOFF_DENIED')
    return parsed


def _json_forbidden(_value):
    _fail('HANDOFF_DENIED')


@dataclass(frozen=True)
class Listener:
    namespace: str
    transport: str
    address: str
    port: int
    uid: int


@dataclass(frozen=True)
class ProbeResult:
    identifier: str
    attempted: bool
    outcome: str
    owned_receiver_count: int


@dataclass(frozen=True)
class ProxyRuntime:
    run_id: str
    manifest_identity: str
    config_identity: str
    expires_at: int
    listen_address: str
    listen_port: int
    host_cid: int
    service_port: int
    uid: int


@dataclass(frozen=True)
class TopologySnapshot:
    sequence: int
    observed_wall: int
    observed_monotonic: int
    run_id: str
    manifest_identity: str
    config_identity: str
    host_devices: tuple
    interfaces: tuple
    routes: tuple
    dns_servers: tuple
    listeners: tuple
    abstract_unix: tuple
    role_handoffs: tuple
    probes: tuple
    proxy_runtime: ProxyRuntime


_AUTHORITY_SEAL = object()


@dataclass(frozen=True)
class TopologyAuthority:
    run_id: str
    manifest_identity: str
    config_identity: str
    expires_at: int
    capability: bytes = field(repr=False)
    role_launches: tuple = field(repr=False)
    proxy_policy: object = field(repr=False)
    clock: object = field(repr=False)
    appliance_recheck: object = field(repr=False)
    host_devices: tuple = HOST_DEVICES
    role_uids: tuple = ROLE_UIDS
    probe_ids: tuple = FIXED_PROBE_IDS
    _seal: object = field(default=None, repr=False, compare=False)


@dataclass(frozen=True)
class AdmissionProof:
    run_id: str
    manifest_identity: str
    config_identity: str
    role_inventory_digest: str
    device_inventory_digest: str
    topology_digest: str
    expires_at: int
    sequence: int
    canonical: str
    handoff: str


def _launches_valid(launches, run_id):
    if type(launches) is not tuple or len(launches) != len(ROLE_UIDS):
        return False
    for launch, (role, uid) in zip(launches, ROLE_UIDS):
        if (type(launch) is not _CONFINEMENT.RoleLaunch
                or getattr(launch, '_seal', None) is not _CONFINEMENT._SEAL
                or launch.role != role or launch.uid != uid
                or launch.run_id != run_id):
            return False
        try:
            expected = _CONFINEMENT.prepare_role(
                role, _CONFINEMENT.RoleConfig(
                    _CONFINEMENT.BootstrapConfig(object(), run_id, launch.programs),
                    _CONFINEMENT.role_fds(role, run_id)))
        except Exception:
            return False
        if launch != expected:
            return False
    return True


def qualify_topology_authority(*, run_id, manifest_identity, config_identity,
                               expires_at, capability, role_launches,
                               proxy_policy, clock, appliance_recheck):
    """Create fixed policy only from accepted Task 8/9 and run authority."""
    binding = getattr(proxy_policy, 'binding', None)
    if (type(run_id) is not str or _RUN.fullmatch(run_id) is None
            or not _digest(manifest_identity) or not _digest(config_identity)
            or not _integer(expires_at, 1) or type(capability) is not bytes
            or len(capability) != 32 or not _launches_valid(role_launches, run_id)
            or type(proxy_policy) is not _PROXY.NativeAdmissionPolicy
            or getattr(proxy_policy, '_seal', None) is not _PROXY._NATIVE_ADMISSION_SEAL
            or type(binding) is not _PROXY.RunBinding
            or binding.run_id != run_id or binding.manifest_identity != manifest_identity
            or binding.config_identity != config_identity or binding.expires_at != expires_at
            # R6/P10: the proxy policy carries exactly derive(capability, 'vsock-stream').
            or not hmac.compare_digest(binding.vsock_key,
                                       _CONFINEMENT.derive_channel_key(capability, _VSOCK_STREAM))
            or tuple(item[0] for item in proxy_policy.destinations)
                != ('FRONTEND', 'BACKEND')
            or not callable(getattr(clock, 'sample', None))
            or not callable(appliance_recheck)):
        _fail('AUTHORITY_DENIED')
    return TopologyAuthority(run_id, manifest_identity, config_identity,
                             expires_at, capability, role_launches, proxy_policy,
                             clock, appliance_recheck, _seal=_AUTHORITY_SEAL)


def _authority(value):
    if (type(value) is not TopologyAuthority
            or value._seal is not _AUTHORITY_SEAL
            or value.host_devices != HOST_DEVICES
            or value.role_uids != ROLE_UIDS
            or value.probe_ids != FIXED_PROBE_IDS
            or not _launches_valid(value.role_launches, value.run_id)):
        _fail('AUTHORITY_DENIED')


def _descriptor(value):
    if (type(value) is not _CONFINEMENT.Descriptor
            or not _integer(value.fd, 0, 1024)
            or not _ascii(value.kind, 32) or not _ascii(value.purpose, 32)
            or not _ascii(value.peer, 32) or value.run_id is None):
        _fail('ROLE_DENIED')
    return {'fd': value.fd, 'kind': value.kind, 'peer': value.peer,
            'purpose': value.purpose, 'runId': value.run_id}


def _program(value):
    if (type(value) is not _CONFINEMENT.ProgramPin
            or not _ascii(value.path, 256) or not _digest(value.sha256)):
        _fail('ROLE_DENIED')
    return {'path': value.path, 'sha256': value.sha256}


def _views(value):
    boolean_names = ('console', 'separate_pid', 'separate_mount',
                     'initial_user_namespace', 'controlling_tty',
                     'read_only_base', 'private_tmpfs',
                     'no_external_ip_interface', 'no_fd_donor')
    if (type(value) is not _CONFINEMENT.RoleViews
            or not _ascii(value.role, 32) or not _ascii(value.root, 256)
            or type(value.visible_roles) is not tuple
            or any(not _ascii(item, 32) for item in value.visible_roles)
            or not _integer(value.private_mode, 0, 0o7777)
            or type(value.device_nodes) is not tuple
            or any(not _ascii(item, 128) for item in value.device_nodes)
            or any(type(getattr(value, name)) is not bool for name in boolean_names)):
        _fail('ROLE_DENIED')
    return {
        'role': value.role, 'root': value.root,
        'visibleRoles': list(value.visible_roles), 'privateMode': value.private_mode,
        'console': value.console, 'separatePid': value.separate_pid,
        'separateMount': value.separate_mount,
        'initialUserNamespace': value.initial_user_namespace,
        'controllingTty': value.controlling_tty,
        'readOnlyBase': value.read_only_base,
        'deviceNodes': list(value.device_nodes), 'privateTmpfs': value.private_tmpfs,
        'noExternalIpInterface': value.no_external_ip_interface,
        'noFdDonor': value.no_fd_donor,
    }


def _role(handoff, expected):
    if (type(handoff) is not _CONFINEMENT.RoleHandoff
            or type(handoff.launch) is not _CONFINEMENT.RoleLaunch
            or handoff.launch != expected
            or getattr(handoff.launch, '_seal', None) is not _CONFINEMENT._SEAL
            or getattr(expected, '_seal', None) is not _CONFINEMENT._SEAL
            or type(handoff.attestation) is not _CONFINEMENT.RoleAttestation):
        _fail('ROLE_DENIED')
    value = handoff.attestation
    numeric_vectors = (value.uids, value.gids, value.groups, value.capabilities)
    if (not _integer(value.pid, 1, 2**31 - 1)
            or value.run_id != expected.run_id or value.role != expected.role
            or any(type(vector) is not tuple
                   or any(not _integer(item, 0, 2**32 - 1) for item in vector)
                   for vector in numeric_vectors)
            or value.uids != (expected.uid,) * 3
            or value.gids != (expected.uid,) * 3 or value.groups != ()
            or value.capabilities != (0,) * 5
            or type(value.no_new_privs) is not int or value.no_new_privs != 1
            or type(value.seccomp) is not int or value.seccomp != 2
            or type(value.waiting) is not bool or value.waiting is not True
            or value.filter_digest != hashlib.sha256(
                _CONFINEMENT.filter_bytes(expected.filter)).hexdigest()
            or type(value.fds) is not tuple or value.fds != expected.fds
            or value.views != expected.views or value.programs != expected.programs
            or getattr(handoff, '_kernel', None) is None
            or getattr(handoff, '_owned', None) is None):
        _fail('ROLE_DENIED')
    owned = handoff._owned
    if (getattr(owned, 'pid', None) != value.pid
            or getattr(owned, 'run_id', None) != value.run_id
            or getattr(owned, 'role', None) != value.role
            or getattr(owned, 'identity', None) is None
            or getattr(owned, 'command', None) is None
            or getattr(owned, 'result', None) is None
            or _CONFINEMENT._endpoint_key(owned.command)
                == _CONFINEMENT._endpoint_key(owned.result)):
        _fail('ROLE_DENIED')
    return {
        'pid': value.pid, 'runId': value.run_id, 'role': value.role,
        'uids': list(value.uids), 'gids': list(value.gids),
        'groups': list(value.groups), 'capabilities': list(value.capabilities),
        'noNewPrivs': value.no_new_privs, 'seccomp': value.seccomp,
        'filterDigest': value.filter_digest,
        'fds': [_descriptor(item) for item in value.fds],
        'views': _views(value.views), 'waiting': value.waiting,
        'programs': [_program(item) for item in value.programs],
    }


def _listener(value):
    if (type(value) is not Listener or value.namespace not in ('GUEST', 'HOST')
            or value.transport not in ('TCP', 'UDP')
            or not _ascii(value.address, 64) or not _integer(value.port, 1, 65535)
            or not _integer(value.uid, 1, 2**32 - 1)):
        _fail('LISTENER_DENIED')
    return {'namespace': value.namespace, 'transport': value.transport,
            'address': value.address, 'port': value.port, 'uid': value.uid}


def _probe(value, identifier):
    if (type(value) is not ProbeResult or value.identifier != identifier
            or type(value.attempted) is not bool or value.attempted is not True
            or type(value.outcome) is not str
            or not _integer(value.owned_receiver_count, 0, 1)):
        _fail('PROBE_DENIED')
    positive = identifier == 'PROXY_VSOCK_CONTROL'
    if ((value.outcome, value.owned_receiver_count)
            != (('ALLOWED', 1) if positive else ('DENIED', 0))):
        _fail('PROBE_DENIED')
    return {'attempted': True, 'identifier': identifier,
            'outcome': value.outcome,
            'ownedReceiverCount': value.owned_receiver_count}


def _strings(values, *, empty=False, limit=256):
    if (type(values) is not tuple or (not empty and not values)
            or any(not _ascii(item, limit) for item in values)
            or len(set(values)) != len(values)):
        _fail('TOPOLOGY_DENIED')
    return list(values)


def _payload(snapshot, expected, before, after):
    _authority(expected)
    if type(snapshot) is not TopologySnapshot:
        _fail('SNAPSHOT_DENIED')
    if (not _sample(before) or not _sample(after)
            or after[0] < before[0] or after[1] < before[1]
            or not _integer(snapshot.sequence, 1)
            or not _integer(snapshot.observed_wall)
            or not _integer(snapshot.observed_monotonic)
            or not before[0] <= snapshot.observed_wall <= after[0]
            or not before[1] <= snapshot.observed_monotonic <= after[1]
            or after[0] - snapshot.observed_wall > GUEST_OBSERVATION_WINDOW_MS
            or after[1] - snapshot.observed_monotonic > GUEST_OBSERVATION_WINDOW_MS
            or after[0] >= expected.expires_at
            or type(snapshot.run_id) is not str
            or type(snapshot.manifest_identity) is not str
            or type(snapshot.config_identity) is not str
            or snapshot.run_id != expected.run_id
            or snapshot.manifest_identity != expected.manifest_identity
            or snapshot.config_identity != expected.config_identity):
        _fail('BINDING_DENIED')
    if snapshot.host_devices != HOST_DEVICES:
        _fail('DEVICE_DENIED')
    interfaces = _strings(snapshot.interfaces)
    routes = _strings(snapshot.routes, empty=True)
    dns = _strings(snapshot.dns_servers, empty=True)
    abstract = _strings(snapshot.abstract_unix, empty=True)
    if snapshot.interfaces != ('lo',) or snapshot.routes or snapshot.dns_servers or snapshot.abstract_unix:
        _fail('TOPOLOGY_DENIED')
    if type(snapshot.listeners) is not tuple:
        _fail('LISTENER_DENIED')
    listeners = [_listener(item) for item in snapshot.listeners]
    exact_listener = Listener('GUEST', 'TCP', '127.0.0.1', 3128, 10004)
    if snapshot.listeners != (exact_listener,):
        _fail('LISTENER_DENIED')
    if type(snapshot.role_handoffs) is not tuple or len(snapshot.role_handoffs) != 4:
        _fail('ROLE_DENIED')
    roles = [_role(item, launch) for item, launch
             in zip(snapshot.role_handoffs, expected.role_launches)]
    owned = [item._owned for item in snapshot.role_handoffs]
    identities = [id(item.identity) for item in owned]
    endpoints = [key for item in owned for key in (
        _CONFINEMENT._endpoint_key(item.command),
        _CONFINEMENT._endpoint_key(item.result))]
    if (len({item['pid'] for item in roles}) != len(roles)
            or len({id(item) for item in owned}) != len(owned)
            or len(set(identities)) != len(identities)
            or len(set(endpoints)) != len(endpoints)
            or len({id(item) for item in snapshot.role_handoffs}) != len(roles)
            or len({id(item.launch) for item in snapshot.role_handoffs}) != len(roles)):
        _fail('ROLE_DENIED')
    if type(snapshot.probes) is not tuple or len(snapshot.probes) != len(FIXED_PROBE_IDS):
        _fail('PROBE_DENIED')
    probes = [_probe(item, identifier)
              for item, identifier in zip(snapshot.probes, FIXED_PROBE_IDS)]
    runtime = snapshot.proxy_runtime
    if (type(runtime) is not ProxyRuntime
            or type(runtime.run_id) is not str
            or type(runtime.manifest_identity) is not str
            or type(runtime.config_identity) is not str
            or not _integer(runtime.expires_at, 1)
            or type(runtime.listen_address) is not str
            or not _integer(runtime.listen_port, 1, 65535)
            or not _integer(runtime.host_cid, 1, 2**32 - 1)
            or not _integer(runtime.service_port, 1, 65535)
            or not _integer(runtime.uid, 1, 2**32 - 1)
            or runtime != ProxyRuntime(expected.run_id, expected.manifest_identity,
                                       expected.config_identity, expected.expires_at,
                                       '127.0.0.1', 3128, 2, 4050, 10004)):
        _fail('PROXY_DENIED')
    devices = {'abstractUnix': abstract, 'dnsServers': dns,
               'hostDevices': list(snapshot.host_devices),
               'interfaces': interfaces, 'listeners': listeners, 'routes': routes}
    return {
        'configIdentity': expected.config_identity, 'devices': devices,
        'expiresAt': expected.expires_at, 'manifestIdentity': expected.manifest_identity,
        'observedMonotonic': snapshot.observed_monotonic,
        'observedWall': snapshot.observed_wall,
        'probes': probes,
        'proxy': {'configIdentity': runtime.config_identity, 'expiresAt': runtime.expires_at,
                  'hostCid': runtime.host_cid, 'listenAddress': runtime.listen_address,
                  'listenPort': runtime.listen_port,
                  'manifestIdentity': runtime.manifest_identity,
                  'runId': runtime.run_id, 'servicePort': runtime.service_port,
                  'uid': runtime.uid},
        'roles': roles, 'runId': expected.run_id, 'sequence': snapshot.sequence,
    }


def _validate_payload(payload, expected):
    """Strict common wire schema and semantic policy used by both producer/consumer."""
    top = ('configIdentity', 'devices', 'expiresAt', 'manifestIdentity',
           'observedMonotonic', 'observedWall', 'probes', 'proxy', 'roles',
           'runId', 'sequence')
    if (not _keys(payload, top) or not _wire_shape(payload)
            or payload['runId'] != expected.run_id
            or payload['manifestIdentity'] != expected.manifest_identity
            or payload['configIdentity'] != expected.config_identity
            or type(payload['expiresAt']) is not int
            or payload['expiresAt'] != expected.expires_at
            or not _integer(payload['observedWall'])
            or not _integer(payload['observedMonotonic'])
            or not _integer(payload['sequence'], 1)
            or payload['observedWall'] >= expected.expires_at):
        _fail('HANDOFF_DENIED')
    devices = payload['devices']
    listener_rows = devices.get('listeners') if type(devices) is dict else None
    if (not _keys(devices, ('abstractUnix', 'dnsServers', 'hostDevices',
                            'interfaces', 'listeners', 'routes'))
            or devices['hostDevices'] != list(HOST_DEVICES)
            or devices['interfaces'] != ['lo'] or devices['routes'] != []
            or devices['dnsServers'] != [] or devices['abstractUnix'] != []
            or devices['listeners'] != [{
                'namespace': 'GUEST', 'transport': 'TCP',
                'address': '127.0.0.1', 'port': 3128, 'uid': 10004}]):
        _fail('HANDOFF_DENIED')
    listener = listener_rows[0]
    if (type(listener['port']) is not int or type(listener['uid']) is not int
            or any(type(listener[name]) is not str
                   for name in ('namespace', 'transport', 'address'))):
        _fail('HANDOFF_DENIED')
    roles = payload['roles']
    if type(roles) is not list or len(roles) != len(expected.role_launches):
        _fail('HANDOFF_DENIED')
    role_keys = ('capabilities', 'fds', 'filterDigest', 'gids', 'groups',
                 'noNewPrivs', 'pid', 'programs', 'role', 'runId', 'seccomp',
                 'uids', 'views', 'waiting')
    pids = []
    for row, launch in zip(roles, expected.role_launches):
        expected_views = _views(launch.views)
        expected_fds = [_descriptor(item) for item in launch.fds]
        expected_programs = [_program(item) for item in launch.programs]
        if (not _keys(row, role_keys) or not _integer(row['pid'], 1, 2**31 - 1)
                or row['runId'] != expected.run_id or row['role'] != launch.role
                or type(row['uids']) is not list
                or any(type(item) is not int for item in row['uids'])
                or type(row['gids']) is not list
                or any(type(item) is not int for item in row['gids'])
                or type(row['groups']) is not list
                or any(type(item) is not int for item in row['groups'])
                or type(row['capabilities']) is not list
                or any(type(item) is not int for item in row['capabilities'])
                or row['uids'] != [launch.uid] * 3
                or row['gids'] != [launch.uid] * 3 or row['groups'] != []
                or row['capabilities'] != [0] * 5
                or type(row['noNewPrivs']) is not int or row['noNewPrivs'] != 1
                or type(row['seccomp']) is not int or row['seccomp'] != 2
                or type(row['waiting']) is not bool or row['waiting'] is not True
                or row['filterDigest'] != hashlib.sha256(
                    _CONFINEMENT.filter_bytes(launch.filter)).hexdigest()
                or type(row['fds']) is not list or row['fds'] != expected_fds
                or type(row['views']) is not dict or row['views'] != expected_views
                or row['programs'] != expected_programs):
            _fail('HANDOFF_DENIED')
        for descriptor in row['fds']:
            if (not _keys(descriptor, ('fd', 'kind', 'peer', 'purpose', 'runId'))
                    or type(descriptor['fd']) is not int
                    or any(type(descriptor[name]) is not str
                           for name in ('kind', 'peer', 'purpose', 'runId'))):
                _fail('HANDOFF_DENIED')
        views = row['views']
        bool_views = ('console', 'separatePid', 'separateMount',
                      'initialUserNamespace', 'controllingTty', 'readOnlyBase',
                      'privateTmpfs', 'noExternalIpInterface', 'noFdDonor')
        if (type(views.get('privateMode')) is not int
                or any(type(views.get(name)) is not bool for name in bool_views)
                or type(views.get('visibleRoles')) is not list
                or type(views.get('deviceNodes')) is not list
                or any(type(item) is not str for item in
                       views['visibleRoles'] + views['deviceNodes'])):
            _fail('HANDOFF_DENIED')
        if (type(row['programs']) is not list
                or any(not _keys(pin, ('path', 'sha256'))
                       or type(pin['path']) is not str or type(pin['sha256']) is not str
                       for pin in row['programs'])):
            _fail('HANDOFF_DENIED')
        pids.append(row['pid'])
    if len(set(pids)) != len(pids):
        _fail('HANDOFF_DENIED')
    probes = payload['probes']
    if type(probes) is not list or len(probes) != len(FIXED_PROBE_IDS):
        _fail('HANDOFF_DENIED')
    for row, identifier in zip(probes, FIXED_PROBE_IDS):
        positive = identifier == 'PROXY_VSOCK_CONTROL'
        if (not _keys(row, ('attempted', 'identifier', 'outcome',
                            'ownedReceiverCount'))
                or row['identifier'] != identifier
                or type(row['attempted']) is not bool or row['attempted'] is not True
                or row['outcome'] != ('ALLOWED' if positive else 'DENIED')
                or type(row['ownedReceiverCount']) is not int
                or row['ownedReceiverCount'] != (1 if positive else 0)):
            _fail('HANDOFF_DENIED')
    proxy = payload['proxy']
    expected_proxy = {
        'configIdentity': expected.config_identity, 'expiresAt': expected.expires_at,
        'hostCid': 2, 'listenAddress': '127.0.0.1', 'listenPort': 3128,
        'manifestIdentity': expected.manifest_identity, 'runId': expected.run_id,
        'servicePort': 4050, 'uid': 10004,
    }
    if (not _keys(proxy, expected_proxy) or proxy != expected_proxy
            or any(type(proxy[name]) is not int for name in
                   ('expiresAt', 'hostCid', 'listenPort', 'servicePort', 'uid'))
            or any(type(proxy[name]) is not str for name in
                   ('configIdentity', 'listenAddress', 'manifestIdentity', 'runId'))):
        _fail('HANDOFF_DENIED')
    return payload


def _admission_key(expected):
    """C3: the topology-admission key; the raw capability never MACs a handoff."""
    return _CONFINEMENT.derive_channel_key(expected.capability, _TOPOLOGY_ADMISSION)


def admit_topology(snapshot, expected, before, after):
    """Legacy v1 handoff from caller-supplied Task 8/9 projections (T10-15).

    Checks the snapshot against fixed policy and MACs a canonical v1 handoff
    with the topology-admission key (C3). The role attestations and probe
    results are caller-constructible projections, not independent native
    evidence, and a v1 handoff carries no host challenge: only the
    composition (v2) handoff can answer a host check.
    """
    try:
        payload = _payload(snapshot, expected, before, after)
        _validate_payload(payload, expected)
        canonical = _canonical(payload)
        roles = _canonical(payload['roles'])
        devices = _canonical(payload['devices'])
        stable = dict(payload)
        stable.pop('sequence'); stable.pop('observedWall'); stable.pop('observedMonotonic')
        topology_digest = hashlib.sha256(_canonical(stable)).hexdigest()
        mac = hmac.new(_admission_key(expected), canonical, hashlib.sha256).hexdigest()
        wire = _canonical({'mac': mac, 'payload': payload, 'version': 1}).decode('ascii')
        return AdmissionProof(
            expected.run_id, expected.manifest_identity, expected.config_identity,
            hashlib.sha256(roles).hexdigest(), hashlib.sha256(devices).hexdigest(),
            topology_digest, expected.expires_at, snapshot.sequence,
            canonical.decode('ascii'), wire)
    except TopologyError:
        raise
    except Exception:
        _fail('SNAPSHOT_DENIED')


def verify_handoff(wire, expected):
    """Offline only: verify a legacy v1 handoff's MAC, canonical bytes and policy.

    A v1 handoff carries no host challenge, so this consumer has no freshness
    and no sequence binding (T10-13). It returns the validated payload dict,
    never an AdmissionProof, and a v1 wire never satisfies the composition
    consumer (verify_bootstrap_handoff_v1).
    """
    _authority(expected)
    try:
        if type(wire) is not str or len(wire) > 131072 or not wire.isascii():
            _fail('HANDOFF_DENIED')
        envelope = json.loads(wire, object_pairs_hook=_json_object,
                              parse_int=_json_integer, parse_float=_json_forbidden,
                              parse_constant=_json_forbidden)
        if (type(envelope) is not dict or set(envelope) != {'mac', 'payload', 'version'}
                or type(envelope['version']) is not int or envelope['version'] != 1
                or type(envelope['mac']) is not str
                or _DIGEST.fullmatch(envelope['mac']) is None
                or type(envelope['payload']) is not dict
                or _canonical(envelope).decode('ascii') != wire):
            _fail('HANDOFF_DENIED')
        payload = envelope['payload']
        calculated = hmac.new(_admission_key(expected), _canonical(payload), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calculated, envelope['mac']):
            _fail('HANDOFF_DENIED')
        return _validate_payload(payload, expected)
    except TopologyError:
        raise
    except Exception:
        _fail('HANDOFF_DENIED')


class TopologyGate:
    """Terminal, resampling admission gate with a Task8 one-use activation.

    Only the sealed NativeTopologyBindings adapter, whose capture owner covers
    every acquisition before a snapshot exists (T10-5), and a required
    supervisor (T10-12) are accepted.
    """
    def __init__(self, expected, adapter, *, supervisor):
        _authority(expected)
        if (type(adapter) is not NativeTopologyBindings
                or getattr(adapter, '_seal', None) is not _NATIVE_SEAL):
            _fail('ADAPTER_DENIED')
        if supervisor is None or not callable(getattr(supervisor, 'begin', None)):
            _fail('ADAPTER_DENIED')
        self._expected, self._adapter, self._supervisor = expected, adapter, supervisor
        self._proof, self._snapshot = None, None
        self._failed, self._activated, self._sequence = False, False, 0
        self._last_clock, self._deadline = None, None
        self._lock = threading.RLock()
        self._generation, self._reservation = 0, None
        self._supervision = None
        self._owners, self._retired = [], set()
        self._unresolved_cleanup = []
        self._inflight, self._stopped_inflight = set(), set()
        self._cleanup_budget = CleanupBudget(expected.clock)
        adapter.bind_cleanup_budget(self._cleanup_budget)
        self._snapshot_cleanup = False
        self._pending_stops = set()
        self._pending_snapshots = set()
        self._cleanup_failed = False
        self._pending_captures = {}
        self._retain(adapter.capture_owner)
        adapter.capture_owner.run_id = expected.run_id

    @property
    def unresolved_cleanup(self):
        with self._lock:
            owners = list(self._unresolved_cleanup)
            if self._failed:
                for owner in self._adapter.capture_owner.unresolved_cleanup:
                    if all(item is not owner for item in owners): owners.append(owner)
            return owners

    @property
    def cleanup_uncertain(self):
        with self._lock:
            return bool(self._cleanup_failed or self._pending_stops
                        or self._pending_snapshots or self._pending_captures or (self._failed and (
                            self._inflight
                            or any(id(item) not in self._retired for item in self._owners))))

    def _remember_cleanup(self, owner):
        with self._lock:
            if owner is self: return  # Our pending state is not a failed stop.
            self._cleanup_failed = True
            if all(item is not owner for item in self._unresolved_cleanup):
                self._unresolved_cleanup.append(owner)

    def _remember_cleanup_failure(self, error):
        # Capture can fail first, then fail while compensating. Preserve both
        # original authorities from the exception chain, not only the last one.
        pending, seen = [error], set()
        while pending:
            current = pending.pop()
            if current is None or id(current) in seen: continue
            seen.add(id(current))
            if isinstance(current, CleanupFailure): self._remember_cleanup(current.cleanup)
            pending.extend((current.__cause__, current.__context__))

    def _clock(self):
        try:
            value = self._expected.clock.sample()
        except CleanupFailure:
            raise
        except Exception:
            _fail('CLOCK_DENIED')
        with self._lock:
            previous = self._last_clock
        if (not _sample(value) or (previous is not None
                and (value[0] < previous[0] or value[1] < previous[1]))):
            _fail('CLOCK_DENIED')
        with self._lock:
            if self._last_clock is not previous:
                _fail('CLOCK_DENIED')
            self._last_clock = value
            if self._deadline is None:
                timeout = self._expected.proxy_policy.run_timeout_ms
                if not _integer(timeout, 1):
                    _fail('CLOCK_DENIED')
                self._deadline = value[1] + timeout
            deadline = self._deadline
        if value[0] >= self._expected.expires_at or value[1] >= deadline:
            _fail('TOPOLOGY_EXPIRED')
        return value

    def _reserve(self, *, initial):
        invalid = False
        with self._lock:
            if (self._failed or self._reservation is not None
                    or (initial and self._proof is not None)
                    or (not initial and self._proof is None)):
                invalid = True
            else:
                token = (self._generation, object())
                self._reservation = token
                sequence = self._sequence + 1
        if invalid:
            self._latch()
            _fail('TOPOLOGY_FAILED')
        return token, sequence

    def _retain(self, owner):
        if not callable(getattr(owner, 'stop_owned', None)):
            _fail('ADAPTER_DENIED')
        with self._lock:
            if all(item is not owner for item in self._owners):
                self._owners.append(owner)

    def _cleanup(self):
        while True:
            with self._lock:
                pending = [item for item in self._owners
                           if id(item) not in self._retired and id(item) not in self._pending_stops
                           and all(item is not owner for owner in self._pending_captures.values())]
                self._retired.update(id(item) for item in pending)
                self._pending_stops.update(id(item) for item in pending)
                self._stopped_inflight.update(id(item) for item in pending if id(item) in self._inflight)
            if not pending: return
            for owner in reversed(pending):
                try:
                    result = self._cleanup_budget.call(owner.stop_owned)
                    if (not hasattr(result, 'get') or result.get('status') not in ('STOPPED', 'EXITED')
                            or result.get('run_id', result.get('runId')) != self._expected.run_id):
                        raise ValueError('EXIT_DENIED')
                except Exception as error:
                    self._remember_cleanup(owner)
                    self._remember_cleanup_failure(error)
                finally:
                    with self._lock: self._pending_stops.remove(id(owner))
            # Settlement can invalidate a stop selected before the last effect.
            # This caller compensates again after that stop, without overlap.

    def _cleanup_snapshot(self, snapshot):
        try:
            self._cleanup_budget.call(lambda remaining: self._adapter.cleanup(snapshot))
        except Exception as error:
            self._remember_cleanup(snapshot)
            self._remember_cleanup_failure(error)
        finally:
            with self._lock: self._pending_snapshots.remove(id(snapshot))

    def _latch(self):
        with self._lock:
            self._failed = True
            self._generation += 1
            self._reservation = None
            snapshot = self._snapshot if not self._snapshot_cleanup else None
            self._snapshot_cleanup = True
            if snapshot is not None and callable(getattr(self._adapter, 'cleanup', None)):
                self._pending_snapshots.add(id(snapshot))
            else: snapshot = None
        # Start the shared end at this first terminal latch even if every
        # owner is still acquiring. Clock callbacks run outside the gate lock.
        self._cleanup_budget.start_terminal()
        self._cleanup()
        if snapshot is not None: self._cleanup_snapshot(snapshot)
        if self.cleanup_uncertain: raise CleanupFailure(self)

    def _attempt(self, *, initial):
        token, sequence = self._reserve(initial=initial)
        snapshot = None
        capture_owner = None
        admitted = False
        try:
            with self._lock:
                if self._failed or self._reservation is not token:
                    _fail('TOPOLOGY_DRIFT')
                capture_owner = self._adapter.capture_owner
                self._pending_captures[token] = capture_owner
            before = self._clock()
            self._expected.appliance_recheck()
            before = self._clock()
            snapshot = self._adapter.capture(sequence, self._expected)
            after = self._clock()
            self._expected.appliance_recheck()
            final = self._clock()
            proof = admit_topology(snapshot, self._expected, before, after)
            final = self._clock()
            if proof.sequence != sequence:
                _fail('SEQUENCE_DENIED')
            if final[0] >= self._expected.expires_at:
                _fail('TOPOLOGY_EXPIRED')
            with self._lock:
                if (self._failed or self._reservation is not token
                        or self._generation != token[0]):
                    _fail('TOPOLOGY_DRIFT')
                if self._proof is not None and (
                        proof.topology_digest != self._proof.topology_digest
                        or proof.role_inventory_digest != self._proof.role_inventory_digest
                        or proof.device_inventory_digest != self._proof.device_inventory_digest):
                    _fail('TOPOLOGY_DRIFT')
                self._sequence, self._proof, self._snapshot = sequence, proof, snapshot
                if not initial:
                    self._reservation = None
            admitted = True
            return proof
        except Exception as error:
            if capture_owner is not None:
                with self._lock: self._pending_captures.pop(token, None)
            self._remember_cleanup_failure(error)
            extra_snapshot = (snapshot is not None and snapshot is not self._snapshot
                              and callable(getattr(self._adapter, 'cleanup', None)))
            if extra_snapshot:
                with self._lock: self._pending_snapshots.add(id(snapshot))
            try: self._latch()
            except CleanupFailure: pass
            if extra_snapshot: self._cleanup_snapshot(snapshot)
            if self.cleanup_uncertain: raise CleanupFailure(self)
            if isinstance(error, TopologyError):
                raise
            _fail('OBSERVATION_DENIED')
        finally:
            if capture_owner is not None:
                with self._lock: self._pending_captures.pop(token, None)
                # compA M-2: a drift after the final check found this capture
                # still pending and skipped its owner. Re-latch on the one
                # terminal path (it stops that owner now); never return the proof.
                if admitted and self._failed:
                    self._latch()
                    _fail('TOPOLOGY_DRIFT')

    def admit(self):
        proof = self._attempt(initial=True)
        handle = None
        try:
            handle = self._supervisor.begin(proof.handoff, self.topology_drifted)
            self._retain(handle)
            if not callable(getattr(handle, 'stop_owned', None)):
                _fail('ADAPTER_DENIED')
            with self._lock:
                if self._failed or self._supervision is not None:
                    _fail('TOPOLOGY_DRIFT')
                self._supervision = handle
            self._expected.appliance_recheck()
            self._clock()
            with self._lock:
                if self._failed: _fail('TOPOLOGY_DRIFT')
                self._reservation = None
            return proof
        except Exception as error:
            self._remember_cleanup_failure(error)
            self._latch()
            if isinstance(error, TopologyError): raise
            _fail('OBSERVATION_DENIED')

    def require_current(self):
        return self._attempt(initial=False)

    def activate_browser(self, activation):
        proof = self.require_current()
        with self._lock:
            duplicate = self._failed or self._activated
            self._activated = True
            token = self._generation
            browser = next(item for item in self._snapshot.role_handoffs
                           if item.launch.role == 'BROWSER')
        if duplicate:
            self._latch()
            _fail('ACTIVATION_DENIED')
        handle = None
        try:
            # Preparation may fail or drift; its cleanup owner must exist first.
            self._begin_activation(activation, token)
            self._expected.appliance_recheck()
            self._clock()
            self._begin_activation(activation, token)
            handle = activation.prepare(browser, proof)
            self._retain(handle)
            def authorize():
                self._expected.appliance_recheck()
                self._clock()
                with self._lock:
                    if self._failed or self._generation != token:
                        _fail('ACTIVATION_DENIED')
            authorize()
            self._begin_activation(handle, token)
            handle.activate(authorize)
            authorize()
            with self._lock:
                invalid = self._failed or self._generation != token
                if invalid: _fail('ACTIVATION_DENIED')
                self._finish_activation()
            return handle
        except Exception as error:
            self._remember_cleanup_failure(error)
            if isinstance(error, ActivationFailure):
                self._retain(error.cleanup)
            self._finish_activation()
            self._latch()
            _fail('ACTIVATION_DENIED')
        finally:
            self._finish_activation()

    def _begin_activation(self, owner, token):
        if not callable(getattr(owner, 'stop_owned', None)):
            _fail('ADAPTER_DENIED')
        with self._lock:
            if all(item is not owner for item in self._owners):
                self._owners.append(owner)
            if self._failed or self._generation != token or self._reservation is not None:
                _fail('ACTIVATION_DENIED')
            self._inflight.add(id(owner))

    def _finish_activation(self):
        with self._lock:
            # A stop before an in-flight operation settled cannot cover owners
            # that operation acquired later. Compensate the retained owner again.
            self._retired.difference_update(self._stopped_inflight)
            self._stopped_inflight.clear()
            self._inflight.clear()

    def topology_drifted(self):
        self._latch()


_NATIVE_SEAL = object()


def _text_lines(raw):
    try:
        return raw.decode('ascii').splitlines()
    except Exception:
        _fail('OBSERVATION_DENIED')


def _interfaces(raw):
    lines = _text_lines(raw)
    if len(lines) < 2 or 'Inter-|' not in lines[0] or 'face' not in lines[1]:
        _fail('OBSERVATION_DENIED')
    result = []
    for line in lines[2:]:
        if not line.strip():
            continue
        if ':' not in line:
            _fail('OBSERVATION_DENIED')
        name, counters = line.split(':', 1)
        name = name.strip()
        fields = counters.split()
        if not _ascii(name, 15) or len(fields) < 16 or any(
                not field.isdecimal() for field in fields):
            _fail('OBSERVATION_DENIED')
        result.append(name)
    if not result or len(set(result)) != len(result):
        _fail('OBSERVATION_DENIED')
    return tuple(result)


def _routes4(raw):
    lines = [line for line in _text_lines(raw) if line.strip()]
    if not lines or lines[0].split()[:4] != ['Iface', 'Destination', 'Gateway', 'Flags']:
        _fail('OBSERVATION_DENIED')
    result = []
    for line in lines[1:]:
        fields = line.split()
        if (len(fields) != 11 or not _ascii(fields[0], 15)
                or any(re.fullmatch(r'[0-9A-Fa-f]{8}', fields[index]) is None
                       for index in (1, 2, 7))
                or re.fullmatch(r'[0-9A-Fa-f]{4,8}', fields[3]) is None
                or any(not fields[index].isdecimal() for index in (4, 5, 6, 8, 9, 10))):
            _fail('OBSERVATION_DENIED')
        result.append('v4:' + ':'.join(fields[:4]))
    return tuple(result)


def _routes6(raw):
    """Forbidden /proc/net/ipv6_route rows (T10-2).

    Every row must be kernel format (ipv6_route_native_seq_show, net/ipv6/
    ip6_fib.c:2492-2509: lower-case %pi6, %02x and %08x columns). A row equal
    to a _KERNEL_DEFAULT_IPV6_ROWS shape is not a route the policy forbids;
    every other row is returned as one. While IPv6 is enabled each table
    without a default route prints the null entry, so a file with neither a
    forbidden row nor a null entry is not kernel output.
    """
    forbidden, null_entries = [], 0
    for line in _text_lines(raw):
        if not line.strip():
            continue
        fields = line.split()
        if (len(fields) != 10
                or any(re.fullmatch(r'[0-9a-f]{2}', fields[index]) is None
                       for index in (1, 3))
                or any(re.fullmatch(r'[0-9a-f]{8}', fields[index]) is None
                       for index in (5, 6, 7, 8))
                or not _ascii(fields[9], 15)):
            _fail('OBSERVATION_DENIED')
        destination, source, gateway = (_ipv6_from_proc(fields[index], 'pi6')
                                        for index in (0, 2, 4))
        prefix, source_prefix = int(fields[1], 16), int(fields[3], 16)
        metric, references, use, flags = (int(fields[index], 16) for index in (5, 6, 7, 8))
        # A gateway is printed only with RTF_GATEWAY set (ip6_fib.c:2499-2504);
        # a printed route holds a reference (:2508).
        if (prefix > 128 or source_prefix > 128 or references < 1
                or (gateway != bytes(16) and not flags & _RTF_GATEWAY)):
            _fail('OBSERVATION_DENIED')
        row = (destination, prefix, source, source_prefix, gateway, metric, use,
               flags, fields[9])
        if row == _KERNEL_DEFAULT_IPV6_ROWS[0]:
            null_entries += 1
        elif row not in _KERNEL_DEFAULT_IPV6_ROWS:
            forbidden.append('v6:' + ':'.join(fields))
    if not forbidden and not null_entries:
        _fail('OBSERVATION_DENIED')
    return tuple(forbidden)


def _dns(raw):
    result = []
    for line in _text_lines(raw):
        content = re.split(r'[#;]', line, maxsplit=1)[0].strip()
        if not content:
            continue
        fields = content.split()
        if len(fields) != 2 or fields[0] != 'nameserver' or not _ascii(fields[1], 64):
            _fail('OBSERVATION_DENIED')
        result.append(fields[1])
    return tuple(result)


_IPV6_PRINTERS = {
    # %pi6 (lib/vsprintf.c:1443-1456 ip6_string, hex_asc of lib/hexdump.c:14):
    # the 16 network-order bytes as 32 lower-case hex digits (ipv6_route).
    'pi6': re.compile(r'[0-9a-f]{32}'),
    # get_tcp6_sock (net/ipv6/tcp_ipv6.c:2211-2216) and the udp6 printer
    # (net/ipv6/datagram.c:1055-1057): %08X of each __be32 s6_addr32 word read
    # as a host-order u32. On little-endian aarch64 each word prints reversed.
    'be32_host_words': re.compile(r'[0-9A-F]{32}'),
}
_IPV6_LOOPBACK = bytes(15) + b'\x01'
_IPV4_MAPPED_LOOPBACK = bytes(10) + b'\xff\xff' + bytes((127, 0, 0, 1))


def _ipv6_from_proc(text, printer):
    """The 16 network-order address bytes of one /proc IPv6 address column."""
    pattern = _IPV6_PRINTERS.get(printer) if type(printer) is str else None
    if pattern is None or type(text) is not str or pattern.fullmatch(text) is None:
        _fail('OBSERVATION_DENIED')
    if printer == 'pi6':
        return bytes.fromhex(text)
    return b''.join(bytes.fromhex(text[index:index + 8])[::-1]
                    for index in range(0, 32, 8))


def _ipv4(hexadecimal):
    if re.fullmatch(r'[0-9A-Fa-f]{8}', hexadecimal) is None:
        _fail('OBSERVATION_DENIED')
    octets = bytes.fromhex(hexadecimal)
    return '.'.join(str(item) for item in reversed(octets))


def _ipv6(hexadecimal):
    """Label of a tcp6/udp6 address column, decoded per host-order word (T10-9)."""
    address = _ipv6_from_proc(hexadecimal, 'be32_host_words')
    if address == _IPV4_MAPPED_LOOPBACK:
        return '127.0.0.1'
    if address == _IPV6_LOOPBACK:
        return '::1'
    return address.hex()


def _network_rows(raw, transport, version):
    lines = [line for line in _text_lines(raw) if line.strip()]
    header = ['sl', 'local_address', 'rem_address', 'st', 'tx_queue', 'rx_queue',
              'tr', 'tm->when', 'retrnsmt', 'uid', 'timeout', 'inode']
    ipv6_header = list(header); ipv6_header[2] = 'remote_address'
    accepted_headers = [header]
    if version == 6: accepted_headers.append(ipv6_header)
    if transport == 'UDP': accepted_headers.extend([row + ['ref', 'pointer', 'drops'] for row in accepted_headers[:]])
    if not lines or lines[0].split() not in accepted_headers:
        _fail('OBSERVATION_DENIED')
    listeners = []
    for line in lines[1:]:
        fields = line.split()
        if len(fields) != 17 or re.fullmatch(r'[0-9]+:', fields[0]) is None:
            _fail('OBSERVATION_DENIED')
        try:
            local_hex, local_port = fields[1].split(':')
            remote_hex, remote_port = fields[2].split(':')
            state = int(fields[3], 16)  # %02X of the TCP state (R17 C4)
            port = int(local_port, 16); remote = int(remote_port, 16)
            uid = int(fields[7], 10)
        except Exception:
            _fail('OBSERVATION_DENIED')
        if (re.fullmatch(r'[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8}', fields[4]) is None
                or re.fullmatch(r'[0-9A-Fa-f]{2}:[0-9A-Fa-f]{8}', fields[5]) is None
                or re.fullmatch(r'[0-9A-Fa-f]{8}', fields[6]) is None
                or any(re.fullmatch(r'[0-9]+', fields[index]) is None
                       for index in (7, 8, 9, 10, 12, 13, 14, 15))
                or re.fullmatch(r'[0-9A-Fa-f]{8,16}', fields[11]) is None
                or re.fullmatch(r'-?[0-9]+', fields[16]) is None):
            _fail('OBSERVATION_DENIED')
        if (re.fullmatch(r'[0-9A-Fa-f]{4}', local_port) is None
                or re.fullmatch(r'[0-9A-Fa-f]{4}', remote_port) is None
                or re.fullmatch(r'[0-9A-Fa-f]{2}', fields[3]) is None
                or any(not _integer(int(fields[index])) for index in (8, 9, 10, 12, 13, 14, 15))
                or not -1 <= int(fields[16]) <= _MAX
                or not _integer(uid, 0, 2**32 - 1)):
            _fail('OBSERVATION_DENIED')
        decode = _ipv4 if version == 4 else _ipv6
        local_address, remote_address = decode(local_hex), decode(remote_hex)
        if not _integer(port, 0, 65535) or not _integer(remote, 0, 65535) or not _integer(uid):
            _fail('OBSERVATION_DENIED')
        if transport == 'TCP' and state == _TCP_LISTEN:
            if remote != 0 or remote_hex != '0' * (8 if version == 4 else 32):
                _fail('OBSERVATION_DENIED')
            listeners.append(Listener('GUEST', 'TCP', local_address, port, uid))
        elif transport == 'TCP' and state == _TCP_ESTABLISHED:
            approved = (
                (local_address == '127.0.0.1' and uid == 10002 and remote_address == '127.0.0.1' and remote == 3128),
                (local_address == '127.0.0.1' and uid == 10004 and port == 3128 and remote_address == '127.0.0.1'),
            )
            if not any(approved):
                _fail('OBSERVATION_DENIED')
        elif transport == 'UDP':
            _fail('OBSERVATION_DENIED')
        else:
            _fail('OBSERVATION_DENIED')
    return tuple(listeners)


def _abstract(raw):
    lines = [line for line in _text_lines(raw) if line.strip()]
    if not lines or lines[0].split() != ['Num', 'RefCount', 'Protocol', 'Flags', 'Type', 'St', 'Inode', 'Path']:
        _fail('OBSERVATION_DENIED')
    result = []
    for line in lines[1:]:
        fields = line.split()
        if (len(fields) not in (7, 8)
                or re.fullmatch(r'[0-9A-Fa-f]+:', fields[0]) is None
                or any(re.fullmatch(r'[0-9A-Fa-f]{8}', fields[index]) is None
                       for index in (1, 2, 3))
                or re.fullmatch(r'[0-9A-Fa-f]{4}', fields[4]) is None
                or re.fullmatch(r'[0-9A-Fa-f]{2}', fields[5]) is None
                or not fields[6].isdecimal()):
            _fail('OBSERVATION_DENIED')
        if (int(fields[2], 16) != 0 or int(fields[3], 16) not in (0, 65536)
                or int(fields[4], 16) not in (1, 2, 5)
                or int(fields[5], 16) not in (1, 2, 3, 4)
                or not _integer(int(fields[6]))):
            _fail('OBSERVATION_DENIED')
        if len(fields) == 8:
            path = fields[7]
            if not _ascii(path, 256):
                _fail('OBSERVATION_DENIED')
            result.append(('ABSTRACT:' if path.startswith('@') else 'PATH:') + path)
        else:
            result.append('UNIX:' + ':'.join(fields[3:7]))
    return tuple(result)


class _NativeCaptureOwner:
    """Original capture authority, including acquisition before any snapshot.

    The gate defers stop until capture and its compensation settle. Uncertain
    observation closes remain with their nominal owners for explicit cleanup;
    they never trigger a second raw close or an automatic retry.
    """
    def __init__(self, bindings):
        self.bindings, self.roles, self.run_id = bindings, None, None
        self._active, self._stopping = False, False
        self._lock = threading.Lock()

    @property
    def unresolved_cleanup(self):
        with self.bindings._observation_cleanup_lock:
            owners = list(self.bindings._unresolved)
        source = self.bindings.role_source
        if (type(source) is Task8RoleSource and type(source.bridge) is Task8Collection
                and source.bridge.cleanup_uncertain):
            owners.append(source.bridge)
        return owners

    def begin(self, authority):
        with self._lock:
            if self._active or self._stopping: raise CleanupFailure(self)
            self.run_id, self._active = authority.run_id, True

    def settle(self):
        with self._lock: self._active = False

    def stop_owned(self, remaining_ms):
        with self._lock:
            if self._active or self._stopping: raise CleanupFailure(self)
            self._stopping = True
        try:
            owners = self.unresolved_cleanup
            if owners: raise CleanupFailure(owners[0])
            if self.roles is not None:
                self.bindings.role_source.cleanup_owned(self.roles)
            return {'status': 'STOPPED', 'run_id': self.run_id}
        finally:
            with self._lock: self._stopping = False


@dataclass(frozen=True)
class NativeTopologyBindings:
    observation_port: object = field(repr=False)
    role_source: object = field(repr=False)
    host_device_source: object = field(repr=False)
    probe_source: object = field(repr=False)
    proxy_source: object = field(repr=False)
    _seal: object = field(repr=False)
    _unresolved: list = field(default_factory=list, repr=False, compare=False)
    _cleanup_budget: CleanupBudget = field(default_factory=CleanupBudget, repr=False, compare=False)
    capture_owner: object = field(init=False, repr=False, compare=False)
    _observation_cleanup_lock: object = field(default_factory=threading.Lock, repr=False, compare=False)
    _pending_observation_cleanup: set = field(default_factory=set, repr=False, compare=False)

    def __post_init__(self):
        object.__setattr__(self, 'capture_owner', _NativeCaptureOwner(self))

    def bind_cleanup_budget(self, budget):
        object.__setattr__(self, '_cleanup_budget', budget)
        if type(self.role_source) is Task8RoleSource and type(self.role_source.bridge) is Task8Collection:
            self.role_source.bridge.bind_cleanup_budget(budget)

    def _read(self, path):
        owner = None
        primary = None
        data = None
        try:
            owner = self.observation_port.open_owned(
                path, os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0))
            if (owner is None or not callable(getattr(owner, 'read', None))
                    or not callable(getattr(owner, 'close', None))
                    or not callable(getattr(owner, 'cleanup', None))):
                _fail('OBSERVATION_DENIED')
            chunks, size = [], 0
            for _ in range(1025):
                chunk = owner.read(min(4096, 65537 - size))
                if type(chunk) is not bytes:
                    _fail('OBSERVATION_DENIED')
                if not chunk:
                    break
                size += len(chunk)
                if size > 65536:
                    _fail('OBSERVATION_DENIED')
                chunks.append(chunk)
            else:
                _fail('OBSERVATION_DENIED')
            data = b''.join(chunks)
        except Exception as error:
            primary = error
        finally:
            if owner is not None:
                try:
                    owner.close()
                except CleanupFailure as error:
                    with self._observation_cleanup_lock: self._unresolved.append(owner)
                    raise error from primary
                except Exception:
                    with self._observation_cleanup_lock: self._unresolved.append(owner)
                    raise CleanupFailure(owner) from primary
        if isinstance(primary, TopologyError):
            raise primary
        if primary is not None or data is None:
            _fail('OBSERVATION_DENIED')
        return data

    def cleanup_unresolved(self):
        with self._observation_cleanup_lock:
            pending = tuple(self._unresolved)
            if self._pending_observation_cleanup:
                raise CleanupFailure(next(owner for owner in pending
                                          if id(owner) in self._pending_observation_cleanup))
            self._pending_observation_cleanup.update(id(owner) for owner in pending)
        # Explicit cleanup of an uncertain close follows a failure: terminal.
        if pending: self._cleanup_budget.start_terminal()
        failure = None
        for owner in pending:
            settled, abandoned = threading.Event(), threading.Event()
            def cleanup(remaining, owner=owner, settled=settled, abandoned=abandoned):
                try:
                    return owner.cleanup()
                finally:
                    with self._observation_cleanup_lock:
                        settled.set()
                        # A timed-out waiter cannot release a running callback.
                        if abandoned.is_set():
                            self._pending_observation_cleanup.discard(id(owner))
            try:
                self._cleanup_budget.call(cleanup)
            except Exception as error:
                failure = CleanupFailure(owner)
                failure.__cause__ = error
                with self._observation_cleanup_lock:
                    abandoned.set()
                    if settled.is_set(): self._pending_observation_cleanup.discard(id(owner))
            else:
                with self._observation_cleanup_lock:
                    self._unresolved[:] = [item for item in self._unresolved if item is not owner]
                    self._pending_observation_cleanup.discard(id(owner))
        if failure is not None: raise failure

    def cleanup(self, snapshot):
        if type(snapshot) is not TopologySnapshot:
            _fail('CLEANUP_UNCERTAIN')
        self.role_source.cleanup_owned(snapshot.role_handoffs)

    def capture(self, sequence, authority):
        self.capture_owner.begin(authority)
        try:
            return self._capture(sequence, authority)
        finally:
            self.capture_owner.settle()

    def _capture(self, sequence, authority):
        if self._seal is not _NATIVE_SEAL:
            _fail('ADAPTER_DENIED')
        raw = tuple(self._read(path) for path in NATIVE_OBSERVATION_PATHS)
        roles = None
        try:
            interfaces = _interfaces(raw[0])
            routes = _routes4(raw[1]) + _routes6(raw[2])
            dns = _dns(raw[3])
            listeners = (_network_rows(raw[4], 'TCP', 4)
                         + _network_rows(raw[5], 'TCP', 6)
                         + _network_rows(raw[6], 'UDP', 4)
                         + _network_rows(raw[7], 'UDP', 6))
            abstract = _abstract(raw[8])
            roles = self.role_source.collect(authority)
            self.capture_owner.roles = roles
            devices = self.host_device_source.observe(authority)
            probes = tuple(self.probe_source.execute(identifier)
                           for identifier in FIXED_PROBE_IDS)
            runtime = self.proxy_source.observe(authority.proxy_policy)
            # T10-7: sample after every device, probe and proxy observation,
            # immediately before the gate's bracket end, so probe latency never
            # ages it (GUEST_OBSERVATION_WINDOW_MS, guest clock only).
            sample = authority.clock.sample()
            if not _sample(sample): _fail('CLOCK_DENIED')
            return TopologySnapshot(
                sequence, sample[0], sample[1], authority.run_id,
                authority.manifest_identity, authority.config_identity,
                devices, interfaces, routes, dns, tuple(listeners), abstract,
                roles, probes, runtime)
        except Exception as error:
            if roles is not None:
                try: self.role_source.cleanup_owned(roles)
                except CleanupFailure:
                    raise
                except Exception:
                    raise CleanupFailure(self.role_source) from None
            if isinstance(error, TopologyError): raise
            _fail('OBSERVATION_DENIED')


def select_native_topology(observation_port, role_source, host_device_source,
                           probe_source, proxy_source, platform_name, machine):
    """Explicit source selection; performs no observation or probe."""
    if (platform_name != 'linux' or machine != 'aarch64'
            or not callable(getattr(observation_port, 'open_owned', None))
            or not callable(getattr(role_source, 'collect', None))
            or not callable(getattr(host_device_source, 'observe', None))
            or not callable(getattr(probe_source, 'execute', None))
            or not callable(getattr(proxy_source, 'observe', None))):
        _fail('ADAPTER_DENIED')
    return NativeTopologyBindings(observation_port, role_source, host_device_source,
                                  probe_source, proxy_source, _NATIVE_SEAL)


def select_native_topology_port(platform_name, machine):
    """The gated native port of tests/guest/topology_test.py (T10-8).

    No native topology port exists before separate Stage 2 approval, on any
    platform. This is a test error for that file: never a skip, never a pass.
    """
    raise RuntimeGateUnavailable('NATIVE_TOPOLOGY_PORT_UNAVAILABLE')


_COMPOSITION_SEAL = object()
_BOOTSTRAP_COMPOSITION_OWNER_SEAL = object()
_BOOTSTRAP_COMPOSITIONS = set()
BOOTSTRAP_HANDOFF_VERSION = 2
BOOTSTRAP_HANDOFF_LIMIT = 131072
BOOTSTRAP_HANDOFF_DOMAIN = b'acceptance:bootstrap-composition:v1\0'


@dataclass(frozen=True, eq=False)
class BootstrapHandoffV1:
    """A v2 wire envelope retained by its one original Python composition."""
    payload: dict
    mac: str
    wire: str
    _owner: object = field(repr=False, compare=False)
    _seal: object = field(repr=False, compare=False)

    def __post_init__(self):
        if (self._seal is not _BOOTSTRAP_COMPOSITION_OWNER_SEAL
                or self._owner not in _BOOTSTRAP_COMPOSITIONS):
            _fail('HANDOFF_DENIED')

    @property
    def host_eligible(self):
        """C2/R3: only a handoff answering a host challenge can reach the host."""
        return 'hostChallenge' in self.payload


def _runtime_wire_row(value, role, handoff=None, expected_lifecycle=None):
    lifecycle = {'CONTROLLER':'SERVICE','BROWSER':'WAITING',
                 'VERIFIER':'WAITING','PROXY':'SERVICE'}[role]
    if expected_lifecycle is not None:
        if (role != 'BROWSER'
                or expected_lifecycle not in ('WAITING','BROWSER_ACTIVE')):
            _fail('HANDOFF_DENIED')
        lifecycle = expected_lifecycle
    elif role == 'BROWSER' and type(value) is dict:
        if value.get('lifecycle') not in ('WAITING','BROWSER_ACTIVE'):
            _fail('HANDOFF_DENIED')
        lifecycle = value['lifecycle']
    if (type(value) is not dict
            or set(value) != {'role','childId','pipeId','lifecycle',
                              'inheritedFDs','currentFDs'}
            or value['role'] != role or not _RUN.fullmatch(value['childId'])
            or not _RUN.fullmatch(value['pipeId'])
            or value['inheritedFDs'] != [0,1,2,3,4]
            or value['lifecycle'] != lifecycle):
        _fail('HANDOFF_DENIED')
    # compB M-2: the same wire checks run with and without an owner (Swift twin),
    # and an owned row must also equal the bootstrap's retained original record.
    try:
        if handoff is None:
            _CONFINEMENT.runtime_rows(value, role, lifecycle)
        else:
            _CONFINEMENT.validate_runtime_observation(
                value, handoff, lifecycle,
                originals=handoff._kernel.runtime_record(handoff))
    except Exception:
        _fail('HANDOFF_DENIED')
    return value


_COMPOSITION_PAYLOAD_KEYS = frozenset({
    'configIdentity','devices','expiresAt','manifestIdentity',
    'observedMonotonic','observedWall','probes','proxy','roles',
    'runId','sequence','composition'})


def _validate_composition_payload(payload, expected, binding, owner=None):
    # C2: a host-facing handoff adds exactly hostChallenge; an internal one
    # (guest require_current) has the unchanged key set and no challenge.
    keys = set(payload) if type(payload) is dict else None
    if (keys not in (_COMPOSITION_PAYLOAD_KEYS,
                     _COMPOSITION_PAYLOAD_KEYS | {'hostChallenge'})
            or not _wire_shape(payload)):
        _fail('HANDOFF_DENIED')
    base = dict(payload); composition = base.pop('composition')
    if 'hostChallenge' in base:
        challenge = base.pop('hostChallenge')
        if type(challenge) is not str or _HOST_CHALLENGE.fullmatch(challenge) is None:
            _fail('HANDOFF_DENIED')
    _validate_payload(base, expected)
    if (not _keys(composition, ('binding','probeEpochDigest',
            'fixtureInventoryDigest','eventCheckpoint','proxyRuntimeId',
            'roleRuntime')) or not _digest(composition['probeEpochDigest'])
            or not _digest(composition['fixtureInventoryDigest'])
            or not _RUN.fullmatch(composition['proxyRuntimeId'])
            or _CONFINEMENT.CompositionBinding.from_record(
                composition['binding']) != binding):
        _fail('HANDOFF_DENIED')
    checkpoint = composition['eventCheckpoint']
    if (not _keys(checkpoint, ('binding','generation','sequence','sourceIdentity',
                               'lostCount'))
            or _CONFINEMENT.CompositionBinding.from_record(
                checkpoint['binding']) != binding
            or type(checkpoint['generation']) is not int
            or checkpoint['generation'] != 1
            or not _integer(checkpoint['sequence'], 1)
            or not _RUN.fullmatch(checkpoint['sourceIdentity'])
            or type(checkpoint['lostCount']) is not int
            or checkpoint['lostCount'] != 0):
        _fail('HANDOFF_DENIED')
    runtime = composition['roleRuntime']
    if type(runtime) is not list or len(runtime) != 4:
        _fail('HANDOFF_DENIED')
    handoffs = None if owner is None else tuple(owner._roles._handoffs[r]
                                               for r in _CONFINEMENT.UIDS)
    browser_lifecycle = None
    if owner is not None:
        preparation = owner._browser_preparation
        active = (owner._state == 'BROWSER_COMMITTED'
                  and type(preparation) is _CONFINEMENT.BootstrapBrowserPreparation
                  and preparation is owner._roles._preparation
                  and preparation._committed
                  and type(owner._browser_reservation) is BrowserTransitionReservation
                  and owner._browser_reservation._used)
        if owner._state == 'BROWSER_COMMITTED' and not active:
            _fail('HANDOFF_DENIED')
        browser_lifecycle = 'BROWSER_ACTIVE' if active else 'WAITING'
    for index, role in enumerate(_CONFINEMENT.UIDS):
        _runtime_wire_row(runtime[index], role,
                          None if handoffs is None else handoffs[index],
                          browser_lifecycle if role == 'BROWSER' else None)
    if owner is not None:
        if (binding is not owner.binding
                or composition['probeEpochDigest'] != owner._probe_epoch.digest
                or composition['fixtureInventoryDigest'] !=
                   owner._probe_epoch.fixture_inventory_digest
                or checkpoint['sourceIdentity'] != owner._event_source_id
                or composition['proxyRuntimeId'] != owner._proxy_runtime_id):
            _fail('HANDOFF_DENIED')
        for row, role in zip(runtime, _CONFINEMENT.UIDS):
            if any(row[key] != owner._roles._map[role][key]
                   for key in ('childId','pipeId')):
                _fail('HANDOFF_DENIED')
    return payload


def verify_bootstrap_handoff_v1(wire, expected, binding, owner=None):
    """Strict v2 consumer; a valid MAC alone is never original provenance."""
    _authority(expected)
    try:
        if (type(wire) is not str or not wire.isascii()
                or not 0 < len(wire.encode('ascii')) <= BOOTSTRAP_HANDOFF_LIMIT):
            _fail('HANDOFF_DENIED')
        envelope = json.loads(wire, object_pairs_hook=_json_object,
                              parse_int=_json_integer, parse_float=_json_forbidden,
                              parse_constant=_json_forbidden)
        if (not _keys(envelope, ('version','payload','mac'))
                or type(envelope['version']) is not int
                or envelope['version'] != BOOTSTRAP_HANDOFF_VERSION
                or type(envelope['mac']) is not str
                or _DIGEST.fullmatch(envelope['mac']) is None
                or _canonical(envelope).decode('ascii') != wire):
            _fail('HANDOFF_DENIED')
        payload = _validate_composition_payload(envelope['payload'], expected,
                                                binding, owner)
        calculated = hmac.new(_admission_key(expected),
            BOOTSTRAP_HANDOFF_DOMAIN + _canonical(payload), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calculated, envelope['mac']):
            _fail('HANDOFF_DENIED')
        return payload
    except TopologyError:
        raise
    except Exception:
        _fail('HANDOFF_DENIED')


def _proxy_initializer(binding, row, channel_key, policy, vsock_key):
    """The exact v2 PROXY_COMPOSITION_INIT frame (amendment 6.1) from trusted state only.

    It carries the vsock-stream key into the PROXY child (P10, R6), never the
    run capability; the nested v1 bootstrap is the unchanged Task 9 object.
    """
    run = policy.binding
    nested = dict(version=1, kind='PROXY_BOOTSTRAP', runId=run.run_id,
                  vsockKey=vsock_key.hex(), expiresAt=run.expires_at,
                  firstSequence=run.first_sequence, manifestIdentity=run.manifest_identity,
                  configIdentity=run.config_identity, origins=dict(run.origins),
                  aggregateBytes=policy.aggregate_bytes, idleTimeoutMs=policy.idle_timeout_ms,
                  runTimeoutMs=policy.run_timeout_ms, runtimeIdentity=policy.runtime_identity,
                  rolePolicyIdentity=policy.role_policy_identity,
                  handoff=dict(commandFd=3, confined=True, resultFd=4, role='PROXY',
                               uid=_CONFINEMENT.UIDS['PROXY'], waiting=True))
    body = _canonical(dict(version=2, kind='PROXY_COMPOSITION_INIT',
                           binding=binding.to_record(), childId=row['childId'],
                           pipeId=row['pipeId'], channelKeyHex=channel_key.hex(),
                           proxyBootstrap=nested))
    if not 0 < len(body) <= 4096:
        _fail('ADAPTER_DENIED')
    return len(body).to_bytes(2, 'big') + body


class _CompositionCurrentSource:
    def __init__(self, owner): self._owner = owner
    def require_current(self): return self._owner._role_current()


class BootstrapComposition:
    """One terminal owner for the fixed probe→role→proxy→event→snapshot chain.

    `native` is False whenever its fixtures are offline (T8-05). Native fixtures
    need the sealed NativeKernelPort as both the fixture and the role kernel;
    offline fixtures the OfflineKernelPort as both. No mixed chain is built.
    """
    def __init__(self, *, binding, expected, role_config, fixtures, proxy_entry,
                 observations, host_devices, events, cleanup_budget, seal=None):
        native = type(fixtures) is _PROBES.NativeProbeFixtures
        port = _CONFINEMENT.NativeKernelPort if native else _CONFINEMENT.OfflineKernelPort
        if (seal is not _BOOTSTRAP_COMPOSITION_OWNER_SEAL
                or type(binding) is not _CONFINEMENT.CompositionBinding
                or type(expected) is not TopologyAuthority
                or type(role_config) is not _CONFINEMENT.BootstrapConfig
                or role_config.run_id != binding.runId
                or type(fixtures) not in (_PROBES.NativeProbeFixtures, _PROBES.OfflineProbeFixtures)
                or type(getattr(fixtures, 'kernel', None)) is not port
                or type(role_config.kernel) is not port
                or (expected.run_id, expected.manifest_identity,
                    expected.config_identity, expected.expires_at) !=
                   (binding.runId, binding.manifestDigest,
                    binding.configIdentity, binding.expiresAtMs)
                or type(observations) is not NativeTopologyBindings
                or type(events) is not _OfflineEventNative
                or type(cleanup_budget) is not CleanupBudget
                or cleanup_budget.clock is not expected.clock
                or not callable(getattr(host_devices, 'observe', None))
                or not (callable(proxy_entry)
                        or callable(getattr(proxy_entry, 'activate_original', None)))):
            _fail('ADAPTER_DENIED')
        self.binding, self._expected, self._role_config = binding, expected, role_config
        self._fixtures, self._proxy_entry = fixtures, proxy_entry
        self._observations, self._host_devices, self._events = (
            observations, host_devices, events)
        self._budget, self._state = cleanup_budget, 'NEW'
        self._observations.bind_cleanup_budget(self._budget)
        self._probe_epoch = self._roles = self._proxy_authority = self._event_owner = None
        self._browser_preparation = self._browser_reservation = None
        self._browser_commit_currents = 0
        self._cleanup_chain = []
        self._proof = self._handoff = None
        self._proxy_runtime_id = self._event_source_id = None
        self._generation, self._sequence = 1, 0
        self._terminal, self._cleanup_status = False, None
        self._last_clock = None
        self._lock = threading.RLock()
        self._pending_acquisitions = {}
        self._retired_cleanup, self._pending_cleanup = set(), set()
        self._cleanup_uncertain = set()
        self._cleanup_running = self._cleanup_dirty = False
        self._observations_retired = False
        # C2: every host challenge this composition has answered (one use each).
        self._host_challenges = set()
        self._admission_key = _admission_key(expected)
        _BOOTSTRAP_COMPOSITIONS.add(self)

    @property
    def native(self) -> bool:
        """False whenever the fixtures are offline; never upgraded later."""
        return type(self._fixtures) is _PROBES.NativeProbeFixtures

    def _retain_cleanup(self, owner):
        if owner is None or not callable(getattr(owner, 'stop_owned', None)):
            return
        with self._lock:
            if any(owner is retained for retained in self._cleanup_chain):
                return
            wrapped = getattr(owner, '_roles', None)
            if any(wrapped is retained for retained in self._cleanup_chain):
                return
            self._cleanup_chain.append(owner)
            # A pass already running must pick this owner up before it ends.
            self._cleanup_dirty = True
            if self._terminal: self._cleanup_status = None

    def _reserve_acquisition(self, name):
        with self._lock:
            if self._terminal: _fail('TOPOLOGY_FAILED')
            token = (self._generation, object())
            self._pending_acquisitions[token] = name
            if name == 'capture': self._observations_retired = False
            return token

    def _checkpoint(self, token):
        with self._lock:
            if self._terminal or self._generation != token[0]:
                _fail('TOPOLOGY_FAILED')

    def _settle_acquisition(self, token, value=None, error=None):
        self._retain_cleanup(value)
        self._retain_cleanup(getattr(error, 'cleanup', None))
        with self._lock:
            name = self._pending_acquisitions.pop(token, None)
            if name is None: _fail('TOPOLOGY_FAILED')
            terminal = self._terminal or self._generation != token[0]
            if terminal:
                self._cleanup_status = None
                if name == 'capture': self._observations_retired = False
        if terminal: self._cleanup_retained()

    def _acquire(self, name, operation):
        token = self._reserve_acquisition(name)
        try: value = operation()
        except BaseException as error:
            self._settle_acquisition(token, error=error)
            raise
        self._settle_acquisition(token, value=value)
        self._checkpoint(token)
        return token, value

    def _publish(self, token, **values):
        with self._lock:
            if self._terminal or self._generation != token[0]:
                _fail('TOPOLOGY_FAILED')
            for key, value in values.items(): setattr(self, key, value)

    def _invalidate_terminal(self, state):
        # The first terminal event starts the one shared cleanup end (C1).
        self._budget.start_terminal()
        with self._lock:
            if self._terminal: return
            self._generation += 1
            preparation, reservation = (
                self._browser_preparation, self._browser_reservation)
            if type(preparation) is _CONFINEMENT.BootstrapBrowserPreparation:
                preparation._used = True
            if type(reservation) is BrowserTransitionReservation:
                reservation._used = True
            self._terminal = True; self._state = state
            self._proof = self._handoff = None
            self._browser_preparation = self._browser_reservation = None
            self._proxy_runtime_id = self._event_source_id = None
            self._cleanup_status = None

    def _failed(self, error):
        self._retain_cleanup(getattr(error, 'cleanup', None))
        self._invalidate_terminal('FAILED')
        try: self.stop_owned(self._budget.remaining())
        except Exception: pass
        try: error.cleanup = self
        except Exception: pass

    def _clock(self):
        value = self._expected.clock.sample()
        if (not _sample(value) or (self._last_clock is not None and
                (value[0] < self._last_clock[0] or value[1] < self._last_clock[1]))
                or value[0] >= self.binding.expiresAtMs):
            _fail('CLOCK_DENIED')
        self._last_clock = value
        return value

    def _activate_proxy(self):
        """Start the original PROXY child's composition and return its child authority.

        E4/C5: the bootstrap never holds a proxy object. It binds the PROXY runtime
        owner while the child still waits, writes the v2 initializer on the
        original FD3, lets the trusted embedding start the child, and reads READY.
        """
        operation = (self._proxy_entry if callable(self._proxy_entry) else
                     self._proxy_entry.activate_original)
        roles = self._roles
        handoff, row = roles._handoffs['PROXY'], roles._map['PROXY']
        owned, facts = handoff._owned, roles._facts['PROXY']
        # P10/R6 (C3): only the vsock-stream key crosses into the PROXY child, inside the
        # initializer below and as the entry's explicit argument; the run capability stays
        # with the bootstrap and the host.
        vsock_key = _CONFINEMENT.derive_channel_key(self._expected.capability, _VSOCK_STREAM)
        policy = self._expected.proxy_policy
        if not hmac.compare_digest(vsock_key, policy.binding.vsock_key):
            _fail('AUTHORITY_LOST')
        def provenance(child, pipe):
            return (child is owned and pipe == (owned.command, owned.result)
                    and _CONFINEMENT._ownership_facts(owned) == facts)
        client = _PROXY.ProxyCompositionClient(_PROXY.qualify_composition_proxy(
            self.binding, child=owned, pipe=(owned.command, owned.result),
            child_id=row['childId'], pipe_id=row['pipeId'], channel_key=roles._keys['PROXY'],
            admission_policy=policy, cleanup_budget=self._budget,
            provenance_validator=provenance), self._expected.clock)
        authority = ProxyChildAuthority(handoff, client, handoff._kernel, self.binding,
                                        seal=_PROXY_CHILD_SEAL)
        # Inherited FD0..4 identities are captured while the child still waits.
        handoff._kernel.bind_runtime_owner(
            handoff, 'SERVICE', authority, row['childId'], row['pipeId'], 1)
        handoff._kernel.write_proxy_frame(owned, _proxy_initializer(
            self.binding, row, roles._keys['PROXY'], policy, vsock_key))
        started = operation(roles, self.binding, self._budget, vsock_key)
        if started is not None:
            # R11: a returned in-process ProxyRuntimeOwner (or any object) is never
            # proxy authority; it is kept only for its own cleanup.
            error = TopologyError('ADAPTER_DENIED')
            error.cleanup = started
            raise error
        authority._ready()
        return authority

    def _bind_runtime_owners(self):
        for role in _CONFINEMENT.UIDS:
            handoff = self._roles._handoffs[role]
            if type(handoff._kernel) not in _KERNEL_PORTS:
                _fail('NATIVE_CURRENT_INVENTORY_UNAVAILABLE')
            if role == 'PROXY':
                continue  # bound to its child authority while waiting (_activate_proxy)
            row = self._roles._map[role]
            lifecycle = 'SERVICE' if role == 'CONTROLLER' else 'WAITING'
            handoff._kernel.bind_runtime_owner(
                handoff, lifecycle, self._roles, row['childId'], row['pipeId'], 1)
        # E4/C5: nothing is registered. The first bracketed observation adopts the
        # complete PROXY inventory, and every later one carries it again.
        self._proxy_authority.observe_current()

    def _read_topology(self, token):
        raw = []
        for path in NATIVE_OBSERVATION_PATHS:
            raw.append(self._observations._read(path)); self._checkpoint(token)
        raw = tuple(raw)
        interfaces = _interfaces(raw[0])
        routes = _routes4(raw[1]) + _routes6(raw[2])
        dns = _dns(raw[3])
        listeners = (_network_rows(raw[4], 'TCP', 4)
                     + _network_rows(raw[5], 'TCP', 6)
                     + _network_rows(raw[6], 'UDP', 4)
                     + _network_rows(raw[7], 'UDP', 6))
        return interfaces, routes, dns, tuple(listeners), _abstract(raw[8])

    def _capture(self, token, challenge=None):
        before = self._event_owner.barrier()
        self._checkpoint(token); self._clock(); self._checkpoint(token)
        self._expected.appliance_recheck(); self._checkpoint(token)
        topology = self._read_topology(token)
        devices = self._host_devices.observe(self._expected)
        self._checkpoint(token)
        handoffs = tuple(self._roles._handoffs[role] for role in _CONFINEMENT.UIDS)
        runtime_owners = {role:(self._proxy_authority if role == 'PROXY' else self._roles)
                          for role in _CONFINEMENT.UIDS}
        runtime = observe_current_roles(handoffs, runtime_owners,
                                        self._proxy_authority, self.binding)
        self._checkpoint(token)
        runtime_id = self._proxy_authority.runtime_id
        self._checkpoint(token); observed = self._clock(); self._checkpoint(token)
        after = self._event_owner.barrier()
        self._checkpoint(token); final = self._clock(); self._checkpoint(token)
        self._expected.appliance_recheck(); self._checkpoint(token)
        if (before.binding is not self.binding or after.binding is not self.binding
                or before.sourceIdentity != after.sourceIdentity
                or after.sequence <= before.sequence
                or before.generation != after.generation
                or before.lostCount != after.lostCount):
            _fail('EVENT_DRIFT')
        self._probe_epoch.require_current(
            self.binding, self._probe_epoch.fixture_inventory_digest, final[0])
        self._checkpoint(token)
        self._sequence += 1
        probes = tuple(ProbeResult(name, attempted, outcome, count)
                       for name, attempted, outcome, count
                       in self._probe_epoch.task10_projection)
        snapshot = TopologySnapshot(
            self._sequence, observed[0], observed[1], self.binding.runId,
            self.binding.manifestDigest, self.binding.configIdentity, devices,
            topology[0], topology[1], topology[2], topology[3], topology[4],
            handoffs, probes, ProxyRuntime(
                self.binding.runId, self.binding.manifestDigest,
                self.binding.configIdentity, self.binding.expiresAtMs,
                _PROXY._LISTEN_ADDRESS, _PROXY._LISTEN_PORT, _PROXY._HOST_CID,
                _PROXY._VSOCK_SERVICE, _CONFINEMENT.UIDS['PROXY']))
        base = _payload(snapshot, self._expected, observed, final)
        composition = dict(binding=self.binding.to_record(),
            probeEpochDigest=self._probe_epoch.digest,
            fixtureInventoryDigest=self._probe_epoch.fixture_inventory_digest,
            eventCheckpoint=after.to_record(),
            proxyRuntimeId=runtime_id,
            roleRuntime=[dict(row) for row in runtime])
        payload = dict(base, composition=composition)
        if challenge is not None: payload['hostChallenge'] = challenge
        self._publish(token, _proxy_runtime_id=runtime_id,
                      _event_source_id=after.sourceIdentity)
        _validate_composition_payload(payload, self._expected, self.binding, self)
        self._checkpoint(token)
        stable = json.loads(_canonical(payload))
        stable.pop('sequence'); stable.pop('observedWall'); stable.pop('observedMonotonic')
        stable.pop('hostChallenge', None)  # P6: MAC-covered, never in the stable digest
        stable['composition']['eventCheckpoint'].pop('sequence')
        proof_digest = hashlib.sha256(_canonical(stable)).hexdigest()
        mac = hmac.new(self._admission_key,
            BOOTSTRAP_HANDOFF_DOMAIN + _canonical(payload), hashlib.sha256).hexdigest()
        wire = _canonical({'mac':mac,'payload':payload,
                           'version':BOOTSTRAP_HANDOFF_VERSION}).decode('ascii')
        if len(wire.encode('ascii')) > BOOTSTRAP_HANDOFF_LIMIT:
            _fail('HANDOFF_DENIED')
        handoff = BootstrapHandoffV1(payload, mac, wire, self,
                                     _BOOTSTRAP_COMPOSITION_OWNER_SEAL)
        roles = _canonical(base['roles']); device_rows = _canonical(base['devices'])
        proof = AdmissionProof(self.binding.runId, self.binding.manifestDigest,
            self.binding.configIdentity, hashlib.sha256(roles).hexdigest(),
            hashlib.sha256(device_rows).hexdigest(), proof_digest,
            self.binding.expiresAtMs, self._sequence,
            _canonical(payload).decode('ascii'), wire)
        self._checkpoint(token)
        return proof, handoff

    def _capture_current(self, challenge=None):
        token = self._reserve_acquisition('capture')
        try: proof, handoff = self._capture(token, challenge)
        except BaseException as error:
            self._settle_acquisition(token, error=error)
            raise
        self._settle_acquisition(token)
        self._publish(token, _proof=proof, _handoff=handoff)
        return proof

    def _claim_host_challenge(self, challenge):
        # C2: a malformed challenge is CHALLENGE_DENIED and a reused one is
        # CHALLENGE_REPLAY; callers make both terminal before any effect.
        if type(challenge) is not str or _HOST_CHALLENGE.fullmatch(challenge) is None:
            _fail('CHALLENGE_DENIED')
        with self._lock:
            if challenge in self._host_challenges: _fail('CHALLENGE_REPLAY')
            self._host_challenges.add(challenge)

    def begin(self, challenge) -> AdmissionProof:
        """The initial host check; its handoff answers the host's challenge (C2)."""
        try:
            with self._lock:
                if self._state != 'NEW' or self._terminal: _fail('TOPOLOGY_FAILED')
                self._claim_host_challenge(challenge)
                self._state = 'PROBING'
            token, probe_epoch = self._acquire('probe', lambda:
                _PROBES.qualify_probe_epoch(self.binding, self._fixtures, self._budget))
            # The epoch's provenance must be this composition's (compA part A note).
            if (type(probe_epoch) is not _PROBES.CompletedProbeEpoch
                    or probe_epoch.native is not self.native):
                _fail('PROBE_EPOCH_DENIED')
            self._publish(token, _probe_epoch=probe_epoch, _state='PROBES_EXITED')
            token, roles = self._acquire('roles', lambda:
                _CONFINEMENT.bind_original_roles(
                    self._role_config, self.binding, self._budget))
            if type(roles) is not _CONFINEMENT.OriginalRoleSet:
                _fail('AUTHORITY_LOST')
            self._publish(token, _roles=roles, _state='ROLES_WAITING')
            token, proxy_authority = self._acquire('proxy', self._activate_proxy)
            # R11: replaces the in-process ProxyRuntimeOwner gate; never beside it.
            if type(proxy_authority) is not ProxyChildAuthority:
                _fail('ADAPTER_DENIED')
            self._publish(token, _proxy_authority=proxy_authority, _state='PROXY_READY')
            token, _ = self._acquire('runtime', self._bind_runtime_owners)
            self._checkpoint(token)
            token, event_owner = self._acquire('event', lambda:
                LinuxBootstrapEventSource.install(
                    self.binding, self._events, self._budget))
            if type(event_owner) is not BootstrapEventOwner:
                _fail('EVENT_SOURCE_TERMINAL')
            self._publish(token, _event_owner=event_owner, _state='WATCHING')
            token, _ = self._acquire('current-source', lambda:
                self._roles.bind_current_source(_CompositionCurrentSource(self)))
            self._checkpoint(token)
            proof = self._capture_current(challenge)
            with self._lock:
                if self._terminal: _fail('TOPOLOGY_FAILED')
                self._state = 'ADMITTED'
                return proof
        except Exception as error:
            self._failed(error)
            raise

    def host_current(self, challenge) -> AdmissionProof:
        """A host-facing current check (R3): binds a fresh one-use host challenge."""
        if self._state not in ('ADMITTED','BROWSER_COMMITTED') or self._terminal:
            _fail('TOPOLOGY_FAILED')
        try:
            self._claim_host_challenge(challenge)
            return self._capture_current(challenge)
        except Exception as error:
            if not self._launch_lag(error): self._failed(error)
            raise

    def require_current(self) -> AdmissionProof:
        """Guest-internal current (R3): no host challenge, never host-eligible."""
        if self._state not in ('ADMITTED','BROWSER_COMMITTED') or self._terminal:
            _fail('TOPOLOGY_FAILED')
        try:
            return self._capture_current()
        except Exception as error:
            if not self._launch_lag(error): self._failed(error)
            raise

    def _launch_lag(self, error):
        """P60: after STARTED the launch's audit records may lag. While the
        event source reports the committed launch unobserved, a current check
        is EVENT_PENDING without failing the composition, and no earlier
        current stays published; the source itself turns terminal after its
        1000 ms bound, which then fails the composition."""
        if (type(error) is not TopologyError or str(error) != 'EVENT_PENDING'
                or self._state != 'BROWSER_COMMITTED' or self._terminal
                or not self._event_owner.launch_pending()):
            return False
        with self._lock:
            self._proof = self._handoff = None
        return True

    def _role_current(self):
        proof = self.require_current()
        preparation = self._browser_preparation
        if (preparation is not None and preparation is self._roles._preparation
                and preparation._used and not preparation._committed):
            self._browser_commit_currents += 1
            if self._browser_commit_currents == 2:
                self._event_owner.commit_browser_transition(
                    self._browser_reservation)
            elif self._browser_commit_currents > 2:
                _fail('AUTHORITY_LOST')
        return dict(proofDigest=proof.topology_digest, generation=self._generation,
            expiresAtMs=self.binding.expiresAtMs,
            monotonicDeadlineMs=self._activation_deadline(),
            eventCheckpoint=self._handoff.payload['composition']['eventCheckpoint'])

    def _activation_deadline(self):
        wall, mono = self._clock()
        end = mono + self.binding.expiresAtMs - wall
        if end > _MAX: _fail('TOPOLOGY_EXPIRED')
        # Bounded by the run binding only; never by the cleanup end (E7).
        return end

    def prepare_browser(self) -> _CONFINEMENT.BootstrapBrowserPreparation:
        try:
            proof = self.require_current()
            record = dict(proofDigest=proof.topology_digest, generation=self._generation,
                expiresAtMs=self.binding.expiresAtMs,
                monotonicDeadlineMs=self._activation_deadline())
            owner = self._roles.prepare_browser(record)
            if type(owner) is not _CONFINEMENT.BootstrapBrowserPreparation:
                _fail('AUTHORITY_LOST')
            self._retain_browser_preparation(owner)
            return owner
        except Exception as error:
            self._failed(error)
            raise

    def _retain_browser_preparation(self, owner):
        if (self._state != 'ADMITTED'
                or type(owner) is not _CONFINEMENT.BootstrapBrowserPreparation
                or owner is not self._roles._preparation or not owner._prepared
                or owner._used or self._browser_preparation is not None
                or self._browser_reservation is not None):
            _fail('AUTHORITY_LOST')
        reservation = self._event_owner.reserve_browser_transition(
            self.binding, self._generation, self._roles._handoffs['BROWSER'],
            self._roles, self._proxy_authority)
        if type(reservation) is not BrowserTransitionReservation:
            _fail('AUTHORITY_LOST')
        self._browser_preparation, self._browser_reservation = owner, reservation

    def _finish_browser_commit(self, result):
        owner, reservation = self._browser_preparation, self._browser_reservation
        if (self._state != 'ADMITTED' or result != {'status':'ACTIVE','generation':1}
                or type(owner) is not _CONFINEMENT.BootstrapBrowserPreparation
                or owner is not self._roles._preparation or not owner._committed
                or type(reservation) is not BrowserTransitionReservation
                or reservation._event_owner is not self._event_owner
                or not reservation._used or self._browser_commit_currents != 2):
            _fail('AUTHORITY_LOST')
        self._state = 'BROWSER_COMMITTED'
        try: self.require_current()
        except TopologyError as error:
            # P60: STARTED can precede the launch's audit records; the commit
            # stands while the source holds the launch pending.
            if str(error) != 'EVENT_PENDING' or self._terminal: raise
        return result

    def commit_browser(self, owner):
        try:
            if (owner is not self._browser_preparation or self._terminal
                    or self._state != 'ADMITTED'):
                _fail('AUTHORITY_LOST')
            return self._finish_browser_commit(self._roles.commit_browser(owner))
        except Exception as error:
            self._failed(error)
            raise

    def handle_controller(self, data, ancillary=(), flags=0):
        """Forward one exact controller frame through the retained Task 6 owner."""
        if self._state not in ('ADMITTED','BROWSER_COMMITTED') or self._terminal:
            _fail('TOPOLOGY_FAILED')
        try:
            prior = self._browser_preparation
            result = self._roles.handle_controller(data, ancillary, flags)
            current = self._roles._preparation
            if prior is None and current is not None:
                self._retain_browser_preparation(current)
            elif (prior is not None and current is prior and current._committed
                  and self._state == 'ADMITTED'):
                self._finish_browser_commit({'status':'ACTIVE','generation':1})
            elif self._roles._terminal:
                reply = _CONFINEMENT._v1_decode(result)
                terminal = reply.get('payload', {}).get('result', {})
                state = ('CANCELLED' if type(terminal) is dict
                         and terminal.get('status') == 'CANCELLED' else 'FAILED')
                self._invalidate_terminal(state)
                try: self.stop_owned(self._budget.remaining())
                except Exception: pass
            return result
        except Exception as error:
            self._failed(error)
            raise

    def _cleanup_retained(self):
        with self._lock:
            if self._cleanup_running:
                # Never overlap a stop: the running pass loops for this owner.
                self._cleanup_dirty = True
                return False
            self._cleanup_running = True
        attempted = set()
        try:
            while True:
                with self._lock: self._cleanup_dirty = False
                while True:
                    with self._lock:
                        pending = [owner for owner in reversed(self._cleanup_chain)
                            if id(owner) not in self._retired_cleanup
                            and id(owner) not in self._pending_cleanup
                            and id(owner) not in attempted]
                        if pending:
                            owner = pending[0]
                            attempted.add(id(owner)); self._pending_cleanup.add(id(owner))
                        else: owner = None
                    if owner is None: break
                    stopped = False
                    try:
                        allowance = self._budget.remaining()
                        receipt = owner.stop_owned(allowance)
                        stopped = (type(receipt) is dict
                            and receipt.get('status') in ('STOPPED','EXITED')
                            and receipt.get('runId',receipt.get('run_id')) == self.binding.runId)
                    except Exception: stopped = False
                    finally:
                        with self._lock:
                            self._pending_cleanup.discard(id(owner))
                            if stopped:
                                self._retired_cleanup.add(id(owner))
                                self._cleanup_uncertain.discard(id(owner))
                            else: self._cleanup_uncertain.add(id(owner))
                observations_ok = self._observations_retired
                if not observations_ok:
                    try:
                        self._observations.cleanup_unresolved(); observations_ok = True
                    except Exception: observations_ok = False
                    with self._lock:
                        self._observations_retired = observations_ok
                with self._lock:
                    # A late owner retained by a concurrent settlement while this
                    # pass ran is stopped here, never left for a later caller.
                    if self._cleanup_dirty or any(
                            id(owner) not in self._retired_cleanup
                            and id(owner) not in self._pending_cleanup
                            and id(owner) not in attempted
                            for owner in self._cleanup_chain):
                        continue
                    complete = (not self._pending_acquisitions
                        and not self._pending_cleanup and not self._cleanup_uncertain
                        and self._observations_retired
                        and all(id(owner) in self._retired_cleanup
                                for owner in self._cleanup_chain))
                    self._cleanup_status = 'STOPPED' if complete else 'TIMEOUT'
                    # Released under the same lock as the dirty check.
                    self._cleanup_running = False
                    return complete
        except BaseException:
            with self._lock: self._cleanup_running = False
            raise

    def stop_owned(self, remaining_ms):
        if type(remaining_ms) is not int or not 0 <= remaining_ms <= 60000:
            _fail('CLEANUP_UNCERTAIN')
        # A stop is a terminal event: clamp() starts the one shared end, then
        # shortens it to this caller's cap, before any external stop callback.
        # Reentry observes provisional TIMEOUT; it never launches an overlapping stop.
        self._budget.clamp(remaining_ms)
        self._invalidate_terminal('STOPPED')
        try: self._budget.remaining()
        except Exception: pass
        complete = self._cleanup_retained()
        with self._lock:
            status = 'STOPPED' if complete else 'TIMEOUT'
            self._cleanup_status = status
        return {'status':status,'runId':self.binding.runId}


def compose_bootstrap_v1(*, binding, expected, role_config, fixtures,
                         proxy_entry, observations, host_devices, events,
                         cleanup_budget):
    """Select the inert composition; no probe, child, socket or event opens here."""
    return BootstrapComposition(binding=binding, expected=expected,
        role_config=role_config, fixtures=fixtures, proxy_entry=proxy_entry,
        observations=observations, host_devices=host_devices, events=events,
        cleanup_budget=cleanup_budget, seal=_BOOTSTRAP_COMPOSITION_OWNER_SEAL)


@dataclass(frozen=True)
class Task8RoleSource:
    bridge: object = field(repr=False)
    _seal: object = field(repr=False)
    def collect(self, authority):
        if self._seal is not _COMPOSITION_SEAL:
            _fail('ROLE_DENIED')
        try:
            if type(self.bridge) is Task8Collection and self.bridge.handoffs is None:
                self.bridge.bind_clock(authority.clock)
            value = self.bridge.collectOwned(authority.role_launches)
        except CleanupFailure:
            raise
        except TopologyError as error:
            if str(error) == 'CLEANUP_UNCERTAIN': raise CleanupFailure(self.bridge) from None
            raise
        except Exception:
            _fail('ROLE_DENIED')
        if type(value) is not tuple:
            _fail('ROLE_DENIED')
        return value
    def cleanup_owned(self, handoffs):
        try:
            self.bridge.cleanupOwned(handoffs)
        except CleanupFailure:
            raise
        except Exception:
            raise CleanupFailure(self.bridge) from None


class _CollectionKernel:
    """Retain exact children even when accepted start_roles throws internally."""
    def __init__(self, kernel, budget):
        self.kernel, self.budget, self.owners = kernel, budget, []
    def spawn_waiting(self, launch, child):
        try: owner = self.kernel.spawn_waiting(launch, child)
        except _CONFINEMENT.RoleStartFailure as error:
            self.owners.append(error.owned)
            raise
        self.owners.append(owner)
        return owner
    def inspect(self, pid): return self.kernel.inspect(pid)
    def wait_owned(self, owner, deadline):
        self.budget.start_terminal()  # cleanup of a retained child is terminal (C1)
        return self.budget.call(lambda remaining: self.kernel.wait_owned(owner, min(deadline, remaining)))
    def stop_owned(self, owner, deadline):
        self.budget.start_terminal()  # cleanup of a retained child is terminal (C1)
        return self.budget.call(lambda remaining: self.kernel.stop_owned(owner, min(deadline, remaining)))


class Task8Collection:
    """Retain the accepted start_roles collection and its original provenance.

    This implements collection/cleanup only. The accepted waiting-child native
    kernel has no activation surface; no new command is introduced here.
    """
    def __init__(self, config):
        if type(config) is not _CONFINEMENT.BootstrapConfig:
            _fail('ROLE_DENIED')
        self.config, self.handoffs, self.provenance = config, None, None
        self.retired = False
        self.cleanup_uncertain = False
        self._cleanup_lock = threading.Lock()
        self.proven_owners, self.unresolved_owners = [], []
        self.budget = CleanupBudget()
        self.kernel = _CollectionKernel(config.kernel, self.budget)

    def bind_clock(self, clock):
        if self.budget.clock is None and not self.budget.started:
            self.budget.clock = clock

    def bind_cleanup_budget(self, budget):
        if self.handoffs is not None or self.budget.started:
            _fail('ROLE_DENIED')
        self.budget = self.kernel.budget = budget

    def collectOwned(self, launches):
        if self.cleanup_uncertain: raise CleanupFailure(self)
        if self.retired: _fail('ROLE_DENIED')
        if self.handoffs is None:
            try:
                values = _CONFINEMENT.start_roles(replace(self.config, kernel=self.kernel))
            except Exception:
                self.retired = True
                # Accepted start_roles has already attempted cleanup, but does
                # not export partial owners. The wrapper retains every original.
                self.cleanup_uncertain = bool(self.kernel.owners)
                self.unresolved_owners.extend(self.kernel.owners)
                if self.cleanup_uncertain: raise CleanupFailure(self) from None
                _fail('ROLE_DENIED')
            self.handoffs = tuple(values[role] for role, _ in ROLE_UIDS)
            self.provenance = tuple((_CONFINEMENT._ownership_facts(h._owned),
                                    getattr(h._owned, 'identity', h._owned),
                                    h._owned.command, h._owned.result)
                                   for h in self.handoffs)
        try:
            if len(launches) != len(self.handoffs): _fail('ROLE_DENIED')
            for handoff, launch, provenance in zip(self.handoffs, launches, self.provenance):
                if (handoff.launch != launch
                        or _CONFINEMENT._ownership_facts(handoff._owned) != provenance[0]):
                    _fail('ROLE_DENIED')
                _CONFINEMENT._check(_CONFINEMENT.inspect_role(handoff.attestation.pid,
                                    kernel=handoff._kernel), launch, waiting=True)
            return self.handoffs
        except Exception:
            self.cleanupOwned(self.handoffs)
            _fail('ROLE_DENIED')

    def cleanupOwned(self, handoffs):
        with self._cleanup_lock:
            if handoffs is not self.handoffs: raise CleanupFailure(self)
            if self.cleanup_uncertain: raise CleanupFailure(self)
            if self.retired: return
            self.cleanup_uncertain = True  # Pending is not a proven stop.
            self.retired = True
        self.budget.start_terminal()  # collection cleanup is terminal (C1)
        uncertain = False
        for handoff in reversed(self.handoffs):
            try:
                remaining = self.budget.remaining()
                if not remaining or handoff.stop_owned(remaining)['status'] not in ('STOPPED', 'EXITED'):
                    raise ValueError('uncertain')
                self.proven_owners.append(handoff._owned)
            except Exception:
                uncertain = True
                self.unresolved_owners.append(handoff._owned)
        with self._cleanup_lock:
            self.cleanup_uncertain = uncertain
        if uncertain: raise CleanupFailure(self)


@dataclass(frozen=True)
class Task8RoleActivation:
    bridge: object = field(repr=False)
    grant: object = field(repr=False)
    _seal: object = field(repr=False)
    def prepare(self, handoff, proof):
        _fail('ACTIVATION_UNAVAILABLE')


class Task10RoleTransaction:
    """Unavailable until accepted Task8 can enforce current authority at effect.

    Calling a Python awaitable with the JS method's name cannot establish that
    contract. In particular, authorize-before-await permits an expired effect.
    """
    def __init__(self, port, grant, handoff):
        self.port, self.grant, self.handoff = port, grant, handoff
        self.owner, self.used = None, False
    def activate(self, authorize):
        _fail('ACTIVATION_UNAVAILABLE')
    def stop_owned(self, deadline):
        return self.handoff.stop_owned(deadline)


def select_task8_roles(bridge, grant):
    """No accepted combined Python collection / JS RolePort constructor exists."""
    _fail('COMPOSITION_UNAVAILABLE')


@dataclass(frozen=True)
class Task9ProxySource:
    observer: object = field(repr=False)
    policy: object = field(repr=False)
    _seal: object = field(repr=False)
    def observe(self, policy):
        if (self._seal is not _COMPOSITION_SEAL or policy is not self.policy
                or type(policy) is not _PROXY.NativeAdmissionPolicy
                or getattr(policy, '_seal', None) is not _PROXY._NATIVE_ADMISSION_SEAL):
            _fail('PROXY_DENIED')
        try:
            return self.observer.observeAccepted(policy)
        except CleanupFailure:
            raise
        except Exception:
            _fail('PROXY_DENIED')


def select_task9_proxy_source(observer, policy):
    if (type(policy) is not _PROXY.NativeAdmissionPolicy
            or getattr(policy, '_seal', None) is not _PROXY._NATIVE_ADMISSION_SEAL
            or not callable(getattr(observer, 'observeAccepted', None))):
        _fail('PROXY_DENIED')
    return Task9ProxySource(observer, policy, _COMPOSITION_SEAL)


class Task9RuntimeObserver:
    """Observe the retained Task9 listener/transport; never construct either."""
    def __init__(self, config, sockets, transport):
        if (type(config) is not _PROXY.ProxyConfig
                or type(sockets) is not _PROXY.NativeSockets
                or type(transport) is not _PROXY.NativeVsockTransport
                or type(sockets.listener) is not _PROXY.NativeListener
                or config.sockets is not sockets
                or transport.binding is not config.binding
                or sockets.module is not transport.module
                or sockets.selectors is not transport.selectors
                or sockets.listener.module is not sockets.module):
            _fail('PROXY_DENIED')
        self.config, self.sockets, self.transport = config, sockets, transport
        self.listener, self.endpoint = sockets.listener, sockets.listener.socket
        self._owners = (config, sockets, transport, config.binding, sockets.module, sockets.selectors)

    def observeAccepted(self, policy):
        _PROXY._admit_native_config(self.config, policy)
        config, sockets, transport, binding, module, selectors = self._owners
        if (self.config is not config or self.sockets is not sockets or self.transport is not transport
                or config.sockets is not sockets or config.binding is not binding
                or transport.binding is not binding
                or sockets.module is not module or transport.module is not module or self.listener.module is not module
                or sockets.selectors is not selectors or transport.selectors is not selectors
                or self.sockets.listener is not self.listener or self.listener.socket is not self.endpoint
                or self.sockets.closed or self.sockets.closing or self.sockets.stopped
                or self.sockets.listener_closed or self.listener.closed
                or self.listener.closing or self.listener.socket_closed
                or self.listener.endpoint != ('127.0.0.1', 3128)
                or self.endpoint.getsockname() != ('127.0.0.1', 3128)
                or not _PROXY._same_binding(self.transport.binding, policy.binding)
                or (self.transport.host_cid, self.transport.service) != (2, 4050)
                or policy.handoff_validator('PROXY', 10004, 3, 4) is not True):
            _fail('PROXY_DENIED')
        self.transport.check()
        # These exact-object checks reject substitutions, but accepted Task9
        # exports no retained runtime instance connecting this transport to the
        # invocation of serve_proxy(config, transport). Do not attest one from
        # three independently supplied objects, even with matching identities.
        _fail('PROXY_RUNTIME_UNAVAILABLE')


@dataclass(frozen=True)
class NativeTopologySupervisor:
    monitor: object = field(repr=False)
    _seal: object = field(repr=False)
    def begin(self, handoff, on_drift):
        if self._seal is not _COMPOSITION_SEAL:
            _fail('ADAPTER_DENIED')
        try:
            handle = self.monitor.beginOwned(handoff, on_drift)
        except CleanupFailure:
            raise
        except Exception:
            _fail('OBSERVATION_DENIED')
        if not callable(getattr(handle, 'stop_owned', None)):
            _fail('ADAPTER_DENIED')
        return handle


def select_native_supervisor(monitor, platform_name, machine):
    if (platform_name != 'linux' or machine != 'aarch64'
            or not callable(getattr(monitor, 'beginOwned', None))):
        _fail('ADAPTER_DENIED')
    return NativeTopologySupervisor(monitor, _COMPOSITION_SEAL)


class ServiceCreationMonitor:
    """Owned finite service-event boundary; every change invalidates admission.

    The signed/native embedding must supply an independently owned source for
    these kernel/service events. No event source is constructed by default.
    """
    EVENTS = ('DEVICE', 'NIC', 'ROUTE', 'DNS', 'LISTENER', 'UNIX', 'ROLE')
    def __init__(self, event_source, run_id):
        if (not callable(getattr(event_source, 'subscribe_fixed', None))
                or type(run_id) is not str or _RUN.fullmatch(run_id) is None):
            _fail('ADAPTER_DENIED')
        self.source, self.run_id, self.used = event_source, run_id, False

    def beginOwned(self, handoff, on_drift):
        if self.used: _fail('ADAPTER_DENIED')
        self.used = True
        # Subscribe only to the fixed creation/change catalogue. A malformed
        # event also invalidates; no event can confer additional authority.
        owner = self.source.subscribe_fixed(self.EVENTS, lambda event: on_drift())
        if not callable(getattr(owner, 'stop_owned', None)):
            # T10-12: the acquired subscription stays typed cleanup authority.
            raise CleanupFailure(owner)
        return owner


def compose_task10(*, mode, expected, observations, collection, host_devices,
                   probe_module, probe_port, proxy_runtime, service_events,
                   platform_name, machine):
    """Fail before collection/probes: their accepted fixed roots conflict.

    Activation, helper/receiver and event provenance are also unsupplied. A
    compatible reviewed ownership contract is required before composing these.
    """
    _fail('COMPOSITION_UNAVAILABLE')

"""Task 10 topology composition tests. All effects are inert injected fakes."""
import dataclasses
import importlib.util
import inspect
import json
import os
import pathlib
import struct
import sys
import tempfile
import threading
import time
import types
import unittest
import hashlib
import hmac
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


topology = load('task10_topology', 'guest/topology.py')
confinement = topology._CONFINEMENT
proxy = topology._PROXY

RUN = '1' * 32
MANIFEST = 'a' * 64
CONFIG = 'b' * 64
CAPABILITY = bytes([7]) * 32
# C2: the host-issued challenge exported to the Swift consumer (nonce bytes 00..0f).
TEST_HOST_CHALLENGE = '000102030405060708090a0b0c0d0e0f'


def admission_key(capability=CAPABILITY):
    """C3 topology-admission key; tests sign handoffs only with this key."""
    return confinement.derive_channel_key(capability, 'topology-admission')
DEVICES = ('LINUX_BOOT', 'VIRTIO_BLOCK_READ_ONLY', 'VIRTIO_ENTROPY',
           'VIRTIO_SERIAL_PRIVATE_PIPE', 'VIRTIO_VSOCK_CID2_PORT4050')
PROBES = (
    'BROWSER_FD_DONOR', 'BROWSER_HELPER_IPV4', 'BROWSER_HELPER_IPV6',
    'BROWSER_IO_URING', 'BROWSER_IPV4_TCP', 'BROWSER_IPV6_TCP',
    'BROWSER_UDP', 'BROWSER_VSOCK', 'CONTROLLER_DNS_TCP',
    'CONTROLLER_DNS_UDP', 'PROXY_VSOCK_CONTROL', 'VERIFIER_IPV4_TCP',
)

# --- Kernel-format /proc text -------------------------------------------------
# Built from the Linux 6.8 printers in the retained archive (SHA-256 c969dea4...
# e965f3), never b''. Field order, widths and hex case follow each cited
# printer; the guest parsers split on whitespace. Values are test literals,
# never topology.py constants, so a wrong product constant cannot pass.
DEV_HEADER = (  # net/core/net-procfs.c:108-112
    b'Inter-|   Receive                                                |  Transmit\n'
    b' face |bytes    packets errs drop fifo frame compressed multicast|'
    b'bytes    packets errs drop fifo colls carrier compressed\n')


def dev_row(name):
    """net/core/net-procfs.c:82-98 dev_seq_printf_stats, every counter zero."""
    return ('%6s: %7d %7d %4d %4d %4d %5d %10d %9d %8d %7d %4d %4d %4d %5d %7d %10d\n'
            % ((name,) + (0,) * 16)).encode('ascii')


# net/ipv4/fib_trie.c:2977-2979: header padded "%-127s\n". With lo only the
# main table is empty: 127.0.0.0/8 lives in the local table, never listed here.
ROUTE4_HEADER = ('%-127s\n' % 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\t'
                 'Metric\tMask\t\tMTU\tWindow\tIRTT').encode('ascii')


def route4_row(device, destination, gateway, flags, metric, mask):
    """net/ipv4/fib_trie.c:3004-3013 fib_route_seq_show (values as printed)."""
    text = '%s\t%08X\t%08X\t%04X\t%d\t%u\t%d\t%08X\t%d\t%u\t%u' % (
        device, destination, gateway, flags, 0, 0, metric, mask, 0, 0, 0)
    return ('%-127s\n' % text).encode('ascii')


def ipv6_route_row(destination, plen, gateway, metric, refcnt, flags, device):
    """net/ipv6/ip6_fib.c:2492-2509 ipv6_route_native_seq_show.

    %pi6 prints the 16 network-order bytes as 32 lowercase hex digits
    (lib/vsprintf.c:1443-1456 with lib/hexdump.c:14). The source column is the
    fixed text of :2497 without CONFIG_IPV6_SUBTREES and ::/0 with it for these
    routes. The use column is the literal 0 of :2508.
    """
    return ('%s %02x %s %02x %s %08x %08x %08x %08x %8s\n' % (
        destination.hex(), plen, '0' * 32, 0, gateway.hex(), metric, refcnt, 0,
        flags, device)).encode('ascii')


ANY6, LOOPBACK6 = bytes(16), bytes(15) + b'\x01'
# fib6 null entry: route.c:285-292 (flags RTF_REJECT|RTF_NONEXTHOP =
# 0x0200|0x00200000, uapi route.h:61 and ipv6_route.h:27; metric ~(u32)0;
# reference count 1), device lo from route.c:6273-6274.
NULL_ENTRY_ROW = ipv6_route_row(ANY6, 0, ANY6, 0xffffffff, 1, 0x00200200, 'lo')
# ::1/128 local route: addrconf.c:3247 -> route.c:4552-4570 (RTF_UP|RTF_NONEXTHOP|
# RTF_LOCAL = 0x1|0x00200000|0x80000000, uapi route.h:51 and ipv6_route.h:27,40;
# metric 0); its reference count is live (2 here).
LOOPBACK_ROW = ipv6_route_row(LOOPBACK6, 128, ANY6, 0, 2, 0x80200001, 'lo')
# One table: the walk prints children before their node (ip6_fib.c:2079-2110).
KERNEL_IPV6_ROUTE = LOOPBACK_ROW + NULL_ENTRY_ROW
# CONFIG_IPV6_MULTIPLE_TABLES: both roots lead to the null entry (ip6_fib.c:
# 2383-2396); main (254) is walked before local (255) (:2547-2566).
KERNEL_IPV6_ROUTE_TWO_TABLES = NULL_ENTRY_ROW + LOOPBACK_ROW + NULL_ENTRY_ROW
# ::/0 via fe80::1 on eth0 (RTF_UP|RTF_GATEWAY; the printer ORs RTF_GATEWAY, :2499-2501).
DEFAULT_ROUTE6_ROW = ipv6_route_row(
    ANY6, 0, bytes.fromhex('fe800000000000000000000000000001'), 1024, 1, 0x0003, 'eth0')
# 0.0.0.0/0 via 192.168.2.1 on eth0 (RTF_UP|RTF_GATEWAY, fib_trie.c:2944-2958).
DEFAULT_ROUTE4_ROW = route4_row('eth0', 0x00000000, 0x0102A8C0, 0x0003, 0, 0x00000000)

TCP4_HEADER = (b'  sl  local_address rem_address   st tx_queue rx_queue tr tm->when '
               b'retrnsmt   uid  timeout inode\n')  # net/ipv4/tcp_ipv4.c:2945-2947
TCP6_HEADER = (b'  sl  local_address                         remote_address                        '
               b'st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n')  # tcp_ipv6.c:2269-2274
UDP4_HEADER = (b'   sl  local_address rem_address   st tx_queue rx_queue tr tm->when '
               b'retrnsmt   uid  timeout inode ref pointer drops\n')  # net/ipv4/udp.c:3098-3100
UDP6_HEADER = (b'  sl  local_address                         remote_address                        '
               b'st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n'
               )  # include/net/transp_v6.h:59-64
UNIX_HEADER = b'Num       RefCount Protocol Flags    Type St Inode Path\n'  # net/unix/af_unix.c:3282-3283
STATE_ESTABLISHED, STATE_LISTEN = 1, 10  # include/net/tcp_states.h:13,22


def be32_words(address):
    """%08X of each __be32 word read as a little-endian (aarch64) u32."""
    return ''.join('%08X' % int.from_bytes(address[i:i + 4], 'little')
                   for i in range(0, len(address), 4))


def tcp_row(slot, local, lport, remote, rport, state, uid, inode):
    """get_tcp4_sock tcp_ipv4.c:2896-2897 / get_tcp6_sock tcp_ipv6.c:2211-2213."""
    return ('%4d: %s:%04X %s:%04X %02X %08X:%08X %02X:%08X %08X %5u %8d %d %d %016x %d %d %d %d %d\n' % (
        slot, be32_words(local), lport, be32_words(remote), rport, state, 0, 0, 0, 0, 0,
        uid, 0, inode, 1, 0, 100, 0, 0, 10, 0)).encode('ascii')


LISTENER_ROW = tcp_row(0, bytes((127, 0, 0, 1)), 3128, bytes(4), 0, STATE_LISTEN, 10004, 123)
EXTRA_LISTENER_ROW = tcp_row(1, bytes(4), 8080, bytes(4), 0, STATE_LISTEN, 10002, 124)


def unix_row(inode, path=None, flags=0, kind=1, state=1):
    """net/unix/af_unix.c:3289-3315 unix_seq_show; an abstract name prints '@'."""
    text = '%016x: %08X %08X %08X %04X %02X %5d' % (0, 2, 0, flags, kind, state, inode)
    return (text + (' ' + path if path else '') + '\n').encode('ascii')


def kernel_proc(overrides=None):
    """Kernel-default guest /proc text: lo only, the IPv6 null entry and ::1
    rows, one guest-loopback proxy listener, no DNS and no UNIX socket."""
    content = {
        '/proc/net/dev': DEV_HEADER + dev_row('lo'),
        '/proc/net/route': ROUTE4_HEADER,
        '/proc/net/ipv6_route': KERNEL_IPV6_ROUTE,
        '/etc/resolv.conf': b'# offline guest: no nameserver\n',
        '/proc/net/tcp': TCP4_HEADER + LISTENER_ROW,
        '/proc/net/tcp6': TCP6_HEADER, '/proc/net/udp': UDP4_HEADER,
        '/proc/net/udp6': UDP6_HEADER, '/proc/net/unix': UNIX_HEADER,
    }
    content.update(overrides or {})
    return content


class Kernel:
    def wait_owned(self, owned, deadline): raise AssertionError('not executed')
    def stop_owned(self, owned, deadline): raise AssertionError('not executed')


class Owned:
    def __init__(self, pid, run_id, role):
        self.pid, self.run_id, self.role = pid, run_id, role
        self.identity, self.command, self.result = object(), object(), object()


class Clock:
    def __init__(self, *samples):
        self.samples = list(samples or ((100, 10),))
        self.last = self.samples[-1]
    def sample(self):
        if self.samples: self.last = self.samples.pop(0)
        return self.last


class Recheck:
    def __init__(self): self.calls = 0
    def __call__(self): self.calls += 1


class Adapter:
    def __init__(self, values): self.values, self.calls = list(values), 0
    def capture(self, sequence, authority):
        self.calls += 1
        value = self.values.pop(0) if len(self.values) > 1 else self.values[0]
        if isinstance(value, BaseException): raise value
        return dataclasses.replace(value, sequence=sequence)


class Activation:
    def __init__(self, callback=None): self.calls, self.callback, self.cleaned = [], callback, 0
    def prepare(self, handoff, proof):
        self.pending = (handoff, proof)
        return self
    def activate(self, authorize):
        authorize()
        self.calls.append(self.pending)
        if self.callback: self.callback()
        return self
    def stop_owned(self, deadline):
        self.cleaned += 1
        return {'status':'STOPPED','run_id':RUN}


def launches_and_handoffs():
    kernel = Kernel()
    pins = tuple(confinement.ProgramPin(path, str(index + 1) * 64)
                 for index, path in enumerate(sorted(confinement.PROGRAM_PATHS)))
    bootstrap = confinement.BootstrapConfig(kernel, RUN, pins)
    launches, handoffs = [], []
    for index, role in enumerate(confinement.UIDS):
        launch = confinement.prepare_role(
            role, confinement.RoleConfig(bootstrap, confinement.role_fds(role, RUN)))
        attestation = confinement.RoleAttestation(
            pid=101 + index, run_id=RUN, role=role,
            uids=(launch.uid,) * 3, gids=(launch.uid,) * 3, groups=(),
            capabilities=(0,) * 5, no_new_privs=1, seccomp=2,
            filter_digest=__import__('hashlib').sha256(
                confinement.filter_bytes(launch.filter)).hexdigest(),
            fds=launch.fds, views=launch.views, waiting=True,
            programs=launch.programs, seccomp_filters=1, tty_nr=0)
        owned = Owned(attestation.pid, RUN, role)
        launches.append(launch)
        handoffs.append(confinement.RoleHandoff(launch, attestation, kernel, owned))
    return tuple(launches), tuple(handoffs)


def proxy_policy():
    # P10/R6: the proxy policy carries only the derived vsock-stream key.
    binding = proxy.RunBinding(
        RUN, confinement.derive_channel_key(CAPABILITY, 'vsock-stream'), 190, 1, MANIFEST, CONFIG,
        (('FRONTEND', 'https://frontend.example'),
         ('BACKEND', 'https://backend.example')))
    return proxy.qualify_native_admission(
        binding, {'FRONTEND': 'frontend.example', 'BACKEND': 'backend.example'},
        1024, 1000, 10000, runtime_identity='c' * 64,
        role_policy_identity='d' * 64, handoff_validator=lambda value: value)


def authority(clock=None, recheck=None, **changes):
    launches, _ = launches_and_handoffs()
    values = dict(run_id=RUN, manifest_identity=MANIFEST,
                  config_identity=CONFIG, expires_at=190,
                  capability=CAPABILITY, role_launches=launches,
                  proxy_policy=proxy_policy(), clock=clock or Clock(),
                  appliance_recheck=recheck or Recheck())
    values.update(changes)
    return topology.qualify_topology_authority(**values)


def result(identifier):
    positive = identifier == 'PROXY_VSOCK_CONTROL'
    return topology.ProbeResult(identifier, True,
                                'ALLOWED' if positive else 'DENIED',
                                1 if positive else 0)


def snapshot(**changes):
    _, handoffs = launches_and_handoffs()
    values = dict(
        sequence=1, observed_wall=100, observed_monotonic=10,
        run_id=RUN, manifest_identity=MANIFEST, config_identity=CONFIG,
        host_devices=DEVICES, interfaces=('lo',), routes=(), dns_servers=(),
        listeners=(topology.Listener('GUEST', 'TCP', '127.0.0.1', 3128, 10004),),
        abstract_unix=(), role_handoffs=handoffs,
        probes=tuple(result(identifier) for identifier in PROBES),
        proxy_runtime=topology.ProxyRuntime(
            RUN, MANIFEST, CONFIG, 190, '127.0.0.1', 3128, 2, 4050, 10004))
    values.update(changes)
    return topology.TopologySnapshot(**values)


def native_capture_fixture(clock, before_open, fail_probe=False, supervisor=None):
    """Real native/Task8 ownership with inert observation and kernel effects."""
    launches, handoffs = launches_and_handoffs()
    class CollectionKernel:
        def __init__(self): self.spawned, self.stops, self.allowances = [], [], []
        def spawn_waiting(self, launch, child):
            owner = handoffs[len(self.spawned)]._owned
            self.spawned.append(owner)
            return owner
        def inspect(self, pid):
            return next(dict(h.attestation.__dict__) for h in handoffs if h.attestation.pid == pid)
        def wait_owned(self, owner, deadline): raise AssertionError('not used')
        def stop_owned(self, owner, deadline):
            self.stops.append(owner); self.allowances.append(deadline)
            return {'status': 'STOPPED', 'pid': owner.pid, 'run_id': RUN}
    kernel = CollectionKernel()
    collection = topology.Task8Collection(confinement.BootstrapConfig(kernel, RUN, launches[0].programs))
    roles = topology.Task8RoleSource(collection, topology._COMPOSITION_SEAL)
    content = kernel_proc()
    class Observation:
        def open_owned(self, path, flags):
            before_open(path)
            class Owner:
                def __init__(self): self.chunks = [content[path], b'']
                def read(self, limit): return self.chunks.pop(0)
                def close(self): pass
                def cleanup(self): raise AssertionError('already closed')
            return Owner()
    class Devices:
        def observe(self, expected): return DEVICES
    class Probes:
        def execute(self, identifier):
            if fail_probe: raise topology.TopologyError('PROBE_DENIED')
            return result(identifier)
    class Proxy:
        def observe(self, policy): return snapshot().proxy_runtime
    bindings = topology.select_native_topology(Observation(), roles, Devices(), Probes(), Proxy(), 'linux', 'aarch64')
    gate = topology.TopologyGate(authority(clock=clock), bindings,
                                 supervisor=supervisor or supervision())
    return gate, bindings, collection, kernel


class ProcPort:
    """Owned reads of literal kernel-format /proc text; no native read or close."""
    def __init__(self, content=None, hook=None):
        self.content = kernel_proc() if content is None else content
        self.hook, self.opened, self.closed = hook, [], []

    def open_owned(self, path, flags):
        if self.hook: self.hook(path)
        self.opened.append(path)
        value = self.content[path]
        if isinstance(value, BaseException): raise value
        port = self
        class Owner:
            def __init__(self): self.chunks = [value, b'']
            def read(self, limit): return self.chunks.pop(0)
            def close(self): port.closed.append(path)
            def cleanup(self): raise AssertionError('already closed')
        return Owner()


class SnapshotSources:
    """Inert role, device, probe and proxy sources for NativeTopologyBindings.

    Each capture reports one queued snapshot's facts (or raises a queued
    exception). No process, probe or proxy is started.
    """
    def __init__(self, values=None):
        self.values = list(values or (snapshot(),))
        self.current, self.index, self.collects, self.cleaned = None, 0, 0, []
        sources = self
        class Roles:
            def collect(self, authority):
                sources.collects += 1
                value = sources.values.pop(0) if len(sources.values) > 1 else sources.values[0]
                if isinstance(value, BaseException): raise value
                sources.current, sources.index = value, 0
                return value.role_handoffs
            def cleanup_owned(self, handoffs): sources.cleaned.append(handoffs)
        class Devices:
            def observe(self, authority): return sources.current.host_devices
        class Probes:
            def execute(self, identifier):
                value = sources.current.probes[sources.index]
                sources.index += 1
                return value
        class Proxy:
            def observe(self, policy): return sources.current.proxy_runtime
        self.roles, self.devices, self.probes, self.proxy = Roles(), Devices(), Probes(), Proxy()


def native_bindings(values=None, content=None, port=None):
    """NativeTopologyBindings over literal /proc text and inert sources."""
    sources = SnapshotSources(values)
    bindings = topology.select_native_topology(
        port or ProcPort(content), sources.roles, sources.devices, sources.probes,
        sources.proxy, 'linux', 'aarch64')
    return bindings, sources


class Subscription:
    """One owned fixed-event subscription; stopping it is inert."""
    def __init__(self, callback): self.callback, self.stops = callback, 0
    def stop_owned(self, deadline):
        self.stops += 1
        return {'status': 'STOPPED', 'run_id': RUN}


class ServiceEvents:
    """Inert service-event source for the real ServiceCreationMonitor."""
    def __init__(self): self.subscriptions = []
    def subscribe_fixed(self, events, callback):
        owner = Subscription(callback)
        self.subscriptions.append(owner)
        return owner


def supervision(events=None):
    """The real native supervisor over an inert service-event source."""
    return topology.select_native_supervisor(
        topology.ServiceCreationMonitor(events or ServiceEvents(), RUN), 'linux', 'aarch64')


def native_gate(values=None, *, content=None, port=None, supervisor=None, **changes):
    """A TopologyGate over NativeTopologyBindings and the inert kernel text."""
    bindings, _ = native_bindings(values, content, port)
    return topology.TopologyGate(authority(**changes), bindings,
                                 supervisor=supervisor or supervision())


class EventFD:
    def __init__(self, native, kind, fd):
        self.native, self.kind, self.fd, self.closed = native, kind, fd, False
    def fileno(self): return -1 if self.closed else self.fd


class EventPipe:
    def __init__(self, native, read_fd, write_fd):
        self.native, self.read_fd, self.write_fd, self.closed = native, read_fd, write_fd, False
    def filenos(self): return (-1, -1) if self.closed else (self.read_fd, self.write_fd)


class PollSelector:
    """Inert PollSelector analogue: deliberately owns no descriptor."""
    def __init__(self): self.registered, self.closed = [], False
    def register(self, owner, mask): self.registered.append((owner, mask))
    def close(self): self.closed = True


class EventNative:
    """Literal-record effect double. It cannot invoke a native syscall."""
    def __init__(self, *, fence=True, fail_at=None):
        self.fence, self.fail_at = fence, fail_at
        self.visible, self.opened, self.closed, self.events = [], [], [], []
        self.rules_changed = False
        self.health_backlog = 0
        self.audit_receiver_pid = 4242
        self.audit_role_pids = {500: 'CONTROLLER', 501: 'BROWSER',
                                502: 'VERIFIER', 503: 'PROXY'}
        self.selector_kind = 'selectors.PollSelector'
        self.mono = 10
        self.role_endpoints = (object(), object())
        self.lost = 0
        # The installed confinement.CHROME identity as audit PATH prints it
        # (MAJOR, MINOR, inode); test literals, never topology.py values.
        self.browser_executable = CHROME_IDENTITY

    def retain_pending(self, kind):
        token = object(); self.visible.append((kind, token)); return token

    def _open(self, kind, fd):
        if self.fail_at == kind: raise RuntimeError('inert setup failure')
        owner = EventFD(self, kind, fd); self.opened.append(owner); return owner
    def open_audit(self): return self._open('AUDIT', 10)
    def open_route(self, groups):
        self.route_groups = groups; return self._open('ROUTE', 11)
    def open_uevent(self): return self._open('UEVENT', 12)
    def open_inotify(self): return self._open('INOTIFY', 13)
    def open_wakeup_pipe(self):
        if self.fail_at == 'WAKEUP': raise RuntimeError('inert setup failure')
        owner = EventPipe(self, 14, 15); self.opened.append(owner); return owner
    def poll_selector(self): return PollSelector()
    def add_inotify_watch(self, owner, path, mask):
        if self.fail_at == 'WATCH': raise RuntimeError('inert setup failure')
        return {'/etc': 1, '/etc/resolv.conf': 2}[path]
    def install_audit_rule(self, owner, rule):
        if self.fail_at == 'RULE': raise RuntimeError('inert setup failure')
        self.installed_rule = rule
    def audit_health(self, owner, sequence):
        payload = struct.pack('<11I', 0x1f, 1, 0, 4242, 0, 256, self.lost,
                              self.health_backlog, 0, 0, 0)
        return (0, self.mono, topology._event_nlmsg(1000, sequence, payload))
    def audit_rules(self, owner, sequence):
        # CB-I3: the enumerated rule is built from coverage v2 values, never
        # from topology._FIXED_AUDIT_RULE, so a changed production rule word
        # cannot also change what the kernel double reports.
        rule = bytearray(coverage_audit_rule())
        if self.rules_changed: rule[4] ^= 1
        return ((0, self.mono, topology._event_nlmsg(1013, sequence, bytes(rule), flags=2)),
                (0, self.mono, topology._event_nlmsg(3, sequence, b'')))
    def audit_request(self, owner, request, sequence):
        if request == 'HEALTH':
            sender, observed, raw = self.audit_health(owner, sequence)
            return (self.message('AUDIT', raw, sender=sender),)
        if request == 'LIST_RULES':
            return tuple(self.message('AUDIT', raw, sender=sender)
                         for sender, observed, raw in self.audit_rules(owner, sequence))
        raise AssertionError('non-fixed audit request')
    def poll_records(self, selector):
        values, self.events = tuple(self.events), []
        return values
    def delivery_barrier(self, owners, wakeup, selector):
        if not self.fence: return topology.qualify_offline_fence_records((), False)
        records = tuple(getattr(self, 'fence_events', ()))
        self.fence_events = []
        return topology.qualify_offline_fence_records(records, True)
    def close_owned(self, owner, remaining_ms):
        if owner.closed: raise RuntimeError('double close')
        owner.closed = True; self.closed.append(owner)
    def cleanup_pending(self, token, remaining_ms): self.closed.append(token)
    def current_monotonic_ms(self): return self.mono

    def message(self, source, payload, *, flags=0, sender=0):
        return (source, sender, self.mono, payload, flags)


def event_binding():
    return confinement.CompositionBinding(1, RUN, MANIFEST, CONFIG, 'd' * 64, 1, 190)


# --- Independent audit rule (CB-I3) ------------------------------------------
# The amendment's fixed rule (BOOTSTRAP_COMPOSITION_V1_AMENDMENT section 7),
# built from coverage v2 values only. A missing id fails as an assertion.
AUDITED_SYSCALL_NAMES = tuple('__NR_' + name for name in (
    'bind listen clone clone3 execve execveat exit exit_group setns unshare '
    'mount umount2 pivot_root chroot mknodat').split())


def coverage_values():
    data = json.loads((ROOT / 'appliance/abi-coverage-v2.json').read_bytes())
    return {record['id']: record['value'] for record in data['records']}


def coverage_value(name, values=None):
    values = coverage_values() if values is None else values
    if name not in values:
        raise AssertionError(name + ': symbol absent from coverage v2')
    return values[name]


def coverage_audit_rule():
    """struct audit_rule_data (include/uapi/linux/audit.h:510-520) for one
    AUDIT_FILTER_EXIT/AUDIT_ALWAYS rule with field AUDIT_ARCH AUDIT_EQUAL
    AUDIT_ARCH_AARCH64 and the amendment's syscall mask."""
    values = coverage_values()
    value = lambda name: coverage_value(name, values)
    mask = [0] * value('AUDIT_BITMASK_SIZE')
    for name in AUDITED_SYSCALL_NAMES:
        number = value(name)
        mask[number // 32] |= 1 << (number % 32)
    count = value('AUDIT_MAX_FIELDS')
    fields, operands, operators = [0] * count, [0] * count, [0] * count
    fields[0] = value('AUDIT_ARCH')
    operands[0] = value('AUDIT_ARCH_AARCH64')
    operators[0] = value('AUDIT_EQUAL')
    layout = '<III%dI%dI%dI%dII' % (len(mask), count, count, count)
    return struct.pack(layout, value('AUDIT_FILTER_EXIT'), value('AUDIT_ALWAYS'), 1,
                       *mask, *fields, *operands, *operators, 0)


# --- Kernel-format audit records ----------------------------------------------
# kernel/auditsc.c audit_log_exit (:1678-1712): "arch=%x syscall=%d", then
# " success=%s exit=%ld" only while return_valid is set (never for exit and
# exit_group, which __audit_free logs with AUDITSC_INVALID, :1838-1849), then
# " a0=%lx a1=%lx a2=%lx a3=%lx items=%d", then audit_log_task_info's
# " ppid=%d pid=%d ..." (kernel/audit.c:2245-2279).
CHROME_IDENTITY = (0xfd, 0x01, 4711)
KERNEL_DEFAULT = object()


def audit_nlmsg(kind, payload, *, flags=0):
    """An asynchronous audit record as the kernel unicasts it to the registered
    receiver: audit_log_end sets nlmsg_len = skb->len - NLMSG_HDRLEN
    (kernel/audit.c:2439) and only the multicast copy repairs it (:819-832).
    Sequence 0, sender port 0 (nlmsg_put(..., 0, 0, type, 0, 0), :1799)."""
    return struct.pack('<IHHII', len(payload), kind, flags, 0, 0) + payload


def audit_text(serial, syscall, *, pid, ppid, exit_code=0, success=KERNEL_DEFAULT,
               argument0='0', items=0, tail=''):
    if success is KERNEL_DEFAULT:
        success = None if syscall in (93, 94) else 'yes'
    text = 'audit(1.000:%d): arch=c00000b7 syscall=%d' % (serial, syscall)
    if success is not None:
        text += ' success=%s exit=%d' % (success, exit_code)
    if argument0 is not None:
        text += ' a0=%s' % argument0
    text += ' a1=0 a2=0 a3=0 items=%d ppid=%d pid=%d' % (items, ppid, pid)
    return text + tail


def audit_event(serial, syscall=201, *, pid=500, ppid=1, exit_code=0,
                success=KERNEL_DEFAULT, argument0='0', items=0, tail=''):
    return audit_nlmsg(1300, audit_text(
        serial, syscall, pid=pid, ppid=ppid, exit_code=exit_code, success=success,
        argument0=argument0, items=items, tail=tail).encode('ascii'))


def audit_eoe(serial):
    """AUDIT_EOE: the bare record header (kernel/audit.c audit_log_start)."""
    return audit_nlmsg(1320, ('audit(1.000:%d): ' % serial).encode('ascii'))


def audit_path(serial, *, name=None, item=0, inode=CHROME_IDENTITY[2],
               dev='%02x:%02x' % CHROME_IDENTITY[:2], nametype='NORMAL'):
    """AUDIT_PATH per audit_log_name (kernel/auditsc.c:1513-1595)."""
    name = confinement.CHROME if name is None else name
    text = ('audit(1.000:%d): item=%d name="%s" inode=%d dev=%s mode=0100755 ouid=0 '
            'ogid=0 rdev=00:00 nametype=%s cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 '
            'cap_frootid=0' % (serial, item, name, inode, dev, nametype))
    return audit_nlmsg(1302, text.encode('ascii'))


def audit_execve(serial, argv=None):
    """AUDIT_EXECVE per audit_log_execve_info (kernel/auditsc.c:1125-1270)."""
    argv = (confinement.CHROME, '--headless') if argv is None else argv
    text = 'audit(1.000:%d): argc=%d' % (serial, len(argv))
    text += ''.join(' a%d="%s"' % (index, value) for index, value in enumerate(argv))
    return audit_nlmsg(1309, text.encode('ascii'))


def audit_group(native, serial, syscall, *, pid, ppid, exit_code=0,
                success=KERNEL_DEFAULT, argument0='0'):
    """One complete single-syscall event: SYSCALL, PROCTITLE, EOE."""
    return [native.message('AUDIT', audit_event(
                serial, syscall, pid=pid, ppid=ppid, exit_code=exit_code,
                success=success, argument0=argument0)),
            native.message('AUDIT', audit_nlmsg(1327, (
                'audit(1.000:%d): proctitle=6368726F6D65' % serial).encode('ascii'))),
            native.message('AUDIT', audit_eoe(serial))]


def exec_group(native, serial, *, pid, ppid, syscall=221, name=None, argv0=None,
               inode=CHROME_IDENTITY[2], dev='%02x:%02x' % CHROME_IDENTITY[:2],
               paths=True, execve=True, nametype='NORMAL', interpreter_inode=99,
               interpreter_dev='fd:01'):
    """A kernel-ordered execve/execveat event: SYSCALL, EXECVE, CWD, PATH item 0
    (the executable: the syscall's own name, fs/exec.c:2134), PATH item 1 (the
    ELF interpreter, opened later by fs/binfmt_elf.c:893), PROCTITLE, EOE."""
    argv0 = confinement.CHROME if argv0 is None else argv0
    rows = [audit_event(serial, syscall, pid=pid, ppid=ppid, items=2)]
    if execve:
        rows.append(audit_execve(serial, (argv0, '--headless')))
    rows.append(audit_nlmsg(1307, (
        'audit(1.000:%d): cwd="/"' % serial).encode('ascii')))
    if paths:
        rows.append(audit_path(serial, name=name, inode=inode, dev=dev, nametype=nametype))
        rows.append(audit_path(serial, name='/lib/ld-linux-aarch64.so.1', item=1,
                               inode=interpreter_inode, dev=interpreter_dev))
    rows.append(audit_nlmsg(1327, (
        'audit(1.000:%d): proctitle=6368726F6D65' % serial).encode('ascii')))
    rows.append(audit_eoe(serial))
    return [native.message('AUDIT', row) for row in rows]


def audit_sockaddr(serial, family='inet'):
    values = {'inet': '02000c387f0000010000000000000000',
              'inet6': '0a000c3800000000000000000000000000000001',
              'unix': '01002f72756e2f6261642e736f636b00'}
    text = ('audit(1.000:%d): saddr=%s' % (serial, values[family])).encode('ascii')
    return audit_nlmsg(1306, text)


def audit_aux(serial, kind=1302, size=0):
    text = ('audit(1.000:%d): item=0 name="/fixed" ' % serial).encode('ascii')
    text += b'x' * size
    return audit_nlmsg(kind, text)


_SELECTOR_KINDS = ('PROXY_STOP_SELECTOR', 'PROXY_CONNECT_SELECTOR')


def literal_runtime_role(confinement_fixture, role, lifecycle, runtime_owner,
                         desired_rows=(), *, bind=True):
    """Actual OfflineKernelPort + a literal /proc table for one original child.

    `table` maps each FD to its kernel facts {fd, kind, device, inode, flags,
    tfds}; `active['fds']` is the listed FD set. Tests mutate both to model
    descriptor churn. Above FD4 the fd link names the object class (an epoll
    selector or a socket) and a selector's fdinfo carries its tfd: lines. The
    bootstrap's own descriptor table (`fstat`) deliberately holds unrelated
    identities, so nothing can pass by reading it. With bind=False the caller
    binds the runtime owner and then lists the extra FDs.
    """
    legacy = confinement_fixture.ConfinementTests()
    kernel = legacy.observed_native()
    original, state = next(iter(kernel._owned.items()))
    bindings = kernel.b
    launch = confinement.prepare_role(
        role, confinement.RoleConfig(legacy.config(), confinement.role_fds(role, RUN)))
    state.update(launch=launch, exec_identity=(1, 999),
                 digest=__import__('hashlib').sha256(
                     confinement.filter_bytes(launch.filter)).hexdigest())
    old_read, old_list = bindings.read_file, bindings.os.listdir
    old_link, old_stat = bindings.os.readlink, bindings.os.stat
    role_index = list(confinement.UIDS).index(role)
    table = {fd: dict(fd=fd, kind='NULL' if fd < 3 else 'COMMAND' if fd == 3 else 'RESULT',
                      device='2', inode=str(1000 + role_index * 10 + fd),
                      flags=1 if fd == 4 else 0, tfds=[]) for fd in range(5)}
    for row in desired_rows:
        if row['fd'] >= 5:
            table[row['fd']] = dict(fd=row['fd'], kind=row['kind'], device=row['device'],
                                    inode=row['inode'], flags=row['flags'],
                                    tfds=list(row.get('tfds', ())))
    active = {'fds': [0, 1, 2, 3, 4]}

    def read(path, *args):
        if '/fdinfo/' in path:
            row = table[int(path.rsplit('/', 1)[1])]
            text = 'pos:\t0\nflags:\t0%o\nmnt_id:\t15\n' % row['flags']
            for target in row['tfds']:
                text += 'tfd: %8d events: %8x data: %16x  pos:0 ino:%x sdev:%x\n' % (
                    target, 4, target, 1, 1)
            return text.encode('ascii')
        if path.endswith('/cmdline'):
            return b'\0'.join(value.encode() for value in launch.argv) + b'\0'
        return old_read(path, *args).replace(
            b'10002', str(launch.uid).encode()).replace(b'browser', role.lower().encode())

    def listed(path):
        if path.endswith('/fd'): return [str(fd) for fd in active['fds']]
        if path.endswith('/run/acceptance'): return [role.lower(), 'crash']  # Task 14 (C7): the crash bind
        return old_list(path)

    def linked(path):
        if '/fd/' in path and int(path.rsplit('/', 1)[1]) >= 5:
            row = table[int(path.rsplit('/', 1)[1])]
            return ('anon_inode:[eventpoll]' if row['kind'] in _SELECTOR_KINDS
                    else 'socket:[%s]' % row['inode'])
        return old_link(path)

    def stated(path):
        if '/fd/' in path:
            row = table.get(int(path.rsplit('/', 1)[1]))
            if row is not None:
                return types.SimpleNamespace(st_dev=int(row['device']), st_ino=int(row['inode']))
        value = old_stat(path)
        if path.endswith('/exe'):
            return types.SimpleNamespace(st_dev=1, st_ino=999)
        value.st_uid = value.st_gid = launch.uid
        return value

    bindings.read_file, bindings.os.listdir = read, listed
    bindings.os.readlink, bindings.os.stat = linked, stated
    bindings.os.fstat = lambda fd: types.SimpleNamespace(st_dev=9, st_ino=90000 + fd)
    owned = confinement.NativeOwned(300, RUN, role, original.command,
                                    original.result, original.identity)
    del kernel._owned[original]; kernel._owned[owned] = state
    handoff = confinement.RoleHandoff(launch, confinement.RoleAttestation(**dict(
        pid=300, run_id=RUN, role=role, uids=(launch.uid,) * 3,
        gids=(launch.uid,) * 3, groups=(), capabilities=(0,) * 5,
        no_new_privs=1, seccomp=2, filter_digest=state['digest'], fds=launch.fds,
        views=launch.views, waiting=True, programs=launch.programs,
        seccomp_filters=1, tty_nr=0)), kernel, owned)
    if bind:
        marker = {'CONTROLLER': '1', 'BROWSER': '3', 'VERIFIER': '5', 'PROXY': '7'}[role]
        kernel.bind_runtime_owner(handoff, lifecycle, runtime_owner,
                                  marker * 32, hex(int(marker, 16) + 1)[2:] * 32, 1)
        active['fds'] = sorted(table)
    return handoff, kernel, active, table


class LiteralProxyChild:
    """A literal PROXY child for the C5 bracket: MAC'd v2 frames over one /proc table.

    No proxy loop runs. Each CURRENT request is answered from the listed table
    (or from `report_rows(index)`), and `on_report(index)` runs after report
    `index` is queued, so a test can change the table between report A and the
    bootstrap's /proc read, or make report B differ.
    """
    DOMAIN = b'acceptance:bootstrap-composition:v1\0PROXY:'

    def __init__(self, table, active, binding, child_id, pipe_id, key, clock):
        self.table, self.active, self.binding, self.clock = table, active, binding, clock
        self.child_id, self.pipe_id, self.key = child_id, pipe_id, key
        self.sent = self.received = self.observation = self.reports = 0
        self.runtime_id, self.queue, self.writes = 'c' * 32, [], []
        self.report_rows = self.on_report = None
        self.closed = False

    def rows(self):
        return [dict(fd=fd, kind=self.table[fd]['kind'], device=self.table[fd]['device'],
                     inode=self.table[fd]['inode'], flags=self.table[fd]['flags'],
                     tfds=list(self.table[fd]['tfds'])) for fd in sorted(self.active['fds'])]

    def send(self, kind, payload):
        self.sent += 1
        value = dict(version=2, kind=kind, binding=self.binding.to_record(), childId=self.child_id,
                     pipeId=self.pipe_id, sequence=self.sent, payload=payload)
        value['mac'] = hmac.new(self.key, self.DOMAIN + b'TO_BOOTSTRAP\0' + topology._canonical(value),
                                hashlib.sha256).hexdigest()
        body = topology._canonical(value)
        self.queue.append(len(body).to_bytes(2, 'big') + body)

    def record(self, status, rows):
        self.observation += 1
        return dict(binding=self.binding.to_record(), runtimeId=self.runtime_id,
                    sequence=self.observation, status=status, listenAddress='127.0.0.1',
                    listenPort=3128, hostCID=2, servicePort=4050, uid=10004,
                    observedAtMonotonicMs=self.clock.sample()[1], currentFDs=rows)

    def ready(self):
        self.send('PROXY_READY', dict(observation=self.record('READY', self.rows())))

    def write(self, owned, data):
        self.writes.append(bytes(data))
        if data == b'STOP':
            self.closed = True
            return
        value = json.loads(data[2:2 + int.from_bytes(data[:2], 'big')])
        mac = value.pop('mac')
        if (mac != hmac.new(self.key, self.DOMAIN + b'FROM_BOOTSTRAP\0' + topology._canonical(value),
                            hashlib.sha256).hexdigest() or value['sequence'] != self.received + 1):
            raise AssertionError('literal child received an unauthenticated command')
        self.received = value['sequence']
        payload = value['payload']
        if value['kind'] == 'PROXY_CURRENT':
            index = self.reports; self.reports += 1
            rows = self.report_rows(index) if self.report_rows else self.rows()
            self.send('PROXY_CURRENT', dict(requestId=payload['requestId'],
                requestSequence=value['sequence'], observation=self.record('CURRENT', rows)))
            if self.on_report: self.on_report(index)
        else:
            self.closed = True
            self.send('PROXY_TERMINAL', dict(requestId=payload['requestId'],
                requestSequence=value['sequence'], runtimeId=self.runtime_id, code='COMPLETE',
                usedBytes=0, cleanupStatus='PROVEN', failedAtMonotonicMs=self.clock.sample()[1]))

    def read(self, owned, remaining_ms):
        if self.queue: return self.queue.pop(0)
        raise confinement.ConfinementError('CHANNEL_EOF' if self.closed else 'ROLE_START_FAILED')


# A serving PROXY inventory: the listener and the STOP selector over FD3/FD4.
LITERAL_PROXY_ROWS = (
    dict(fd=5, kind='PROXY_LISTENER', device='8', inode='800', flags=2050, tfds=[]),
    dict(fd=6, kind='PROXY_STOP_SELECTOR', device='16', inode='1066', flags=2, tfds=[3, 4]),
)


LITERAL_PROXY_KEY, LITERAL_PROXY_CHILD, LITERAL_PROXY_PIPE = bytes([10]) * 32, '7' * 32, '8' * 32


def literal_proxy_client(owned, binding, clock, budget=None):
    """A fresh bootstrap-side client on the literal child's original pipe pair."""
    policy = proxy.qualify_composition_proxy(binding, child=owned,
        pipe=(owned.command, owned.result), child_id=LITERAL_PROXY_CHILD,
        pipe_id=LITERAL_PROXY_PIPE, channel_key=LITERAL_PROXY_KEY,
        admission_policy=proxy_policy(), cleanup_budget=budget or topology.CleanupBudget(clock),
        provenance_validator=lambda c, p: c is owned and p == (owned.command, owned.result))
    return proxy.ProxyCompositionClient(policy, clock)


def literal_proxy_authority(confinement_fixture, rows=LITERAL_PROXY_ROWS, *, binding, clock,
                            budget=None):
    """A ProxyChildAuthority over a literal child: the composition's own construction order."""
    handoff, kernel, active, table = literal_runtime_role(
        confinement_fixture, 'PROXY', 'SERVICE', None, rows, bind=False)
    owned = handoff._owned
    key, child_id, pipe_id = LITERAL_PROXY_KEY, LITERAL_PROXY_CHILD, LITERAL_PROXY_PIPE
    child = LiteralProxyChild(table, active, binding, child_id, pipe_id, key, clock)
    kernel.write_proxy_frame, kernel.read_proxy_frame = child.write, child.read
    authority = topology.ProxyChildAuthority(handoff, literal_proxy_client(owned, binding, clock, budget),
                                             kernel, binding, seal=topology._PROXY_CHILD_SEAL)
    kernel.bind_runtime_owner(handoff, 'SERVICE', authority, child_id, pipe_id, 1)
    active['fds'] = sorted(table)
    child.ready(); authority._ready()
    return authority, child, handoff, kernel, active, table


_SHARED_CONFINEMENT_FIXTURE = []


def shared_confinement_fixture():
    """confinement_test loaded once as an inert literal-fixture module."""
    if not _SHARED_CONFINEMENT_FIXTURE:
        module = load('task11_event_confinement_fixture', 'tests/unit/confinement_test.py')
        module.c = confinement
        module.RUN = RUN
        _SHARED_CONFINEMENT_FIXTURE.append(module)
    return _SHARED_CONFINEMENT_FIXTURE[0]


class TopologyTests(unittest.TestCase):
    def test_v1_composition_handoff_requires_complete_proxy_runtime_inventory(self):
        expected = authority()
        binding = confinement.CompositionBinding(
            1, RUN, MANIFEST, CONFIG, 'd' * 64, 1, 190)
        base = topology._payload(snapshot(), expected, (100, 10), (100, 10))
        _, handoffs = launches_and_handoffs()
        runtime = []
        for index, (role, handoff) in enumerate(zip(confinement.UIDS, handoffs)):
            rows = [dict(fd=fd,kind='NULL' if fd < 3 else 'COMMAND' if fd == 3 else 'RESULT',
                         device='1',inode=str(100 + fd + index * 10),flags=0,
                         ownerId=('%x' % (index * 5 + fd + 1))[-1] * 32,
                         acquiredGeneration=1)
                    for fd in range(5)]
            runtime.append(dict(role=role,childId=('%x' % (index + 1)) * 32,
                pipeId=('%x' % (index + 5)) * 32,
                lifecycle='SERVICE' if role in ('CONTROLLER','PROXY') else 'WAITING',
                inheritedFDs=[0,1,2,3,4],currentFDs=rows))
        payload = dict(base, composition=dict(binding=binding.to_record(),
            probeEpochDigest='e' * 64, fixtureInventoryDigest='f' * 64,
            eventCheckpoint=dict(binding=binding.to_record(), generation=1,
                sequence=1, sourceIdentity='a' * 32, lostCount=0),
            proxyRuntimeId='b' * 32, roleRuntime=runtime))
        def wire(value):
            mac = hmac.new(admission_key(expected.capability), topology.BOOTSTRAP_HANDOFF_DOMAIN +
                topology._canonical(value), hashlib.sha256).hexdigest()
            return topology._canonical({'mac':mac,'payload':value,'version':2}).decode('ascii')
        with self.assertRaises(topology.TopologyError):
            topology.verify_bootstrap_handoff_v1(wire(payload), expected, binding)
        runtime[3]['currentFDs'].append(dict(fd=5,kind='PROXY_LISTENER',device='1',
            inode='999',flags=0,ownerId='9' * 32,acquiredGeneration=1))
        self.assertEqual(topology.verify_bootstrap_handoff_v1(
            wire(payload), expected, binding), payload)
        payload['composition']['eventCheckpoint']['lostCount'] = True
        with self.assertRaises(topology.TopologyError):
            topology.verify_bootstrap_handoff_v1(wire(payload), expected, binding)

    def install_events(self, native=None):
        native = native or EventNative()
        budget = topology.CleanupBudget(clock=Clock((100, 10), (100, 10), (100, 10)))
        owner = topology.LinuxBootstrapEventSource.install(
            event_binding(), topology.qualify_offline_event_native(native), budget)
        return owner, native, budget

    def test_v1_event_source_installed_before_first_snapshot(self):
        native = EventNative(); timeline = []
        original = native.retain_pending
        def visible(kind): timeline.append(('retain', kind)); return original(kind)
        native.retain_pending = visible
        owner, native, _ = self.install_events(native)
        timeline.append(('snapshot', owner.barrier().to_record()['sequence']))
        self.assertEqual([kind for action, kind in timeline if action == 'retain'],
                         ['AUDIT', 'ROUTE', 'UEVENT', 'INOTIFY', 'WAKEUP'])
        self.assertEqual(timeline[-1][0], 'snapshot')
        self.assertEqual(len(native.opened), 5)

    def test_v1_transient_listener_and_unix_creation_latch(self):
        for endpoint in ('inet', 'unix'):
            owner, native, _ = self.install_events()
            native.events += [native.message('AUDIT', audit_event(7, syscall=200)),
                              native.message('AUDIT', audit_sockaddr(7, endpoint)),
                              native.message('AUDIT', audit_nlmsg(1320, b'audit(1.000:7): end'))]
            with self.subTest(endpoint=endpoint), self.assertRaisesRegex(
                    topology.TopologyError, '^EVENT_DRIFT$'):
                owner.barrier()

    def test_v1_event_loss_overflow_death_fail_closed(self):
        records = (
            lambda n: n.message('AUDIT', b'', flags=topology._EVENT_TRUNCATED),
            lambda n: n.message('ROUTE', b'', flags=topology._EVENT_ENOBUFS),
            lambda n: n.message('INOTIFY', struct.pack('<iIII', -1, 16384, 0, 0)),
            lambda n: n.message('UEVENT', b'ACTION=add\0SEQNUM=9\0'),
            lambda n: n.message('SOURCE_DIED', b'AUDIT'),
        )
        for make in records:
            owner, native, _ = self.install_events(); native.events.append(make(native))
            with self.subTest(make=make), self.assertRaises(topology.TopologyError): owner.barrier()
            with self.assertRaisesRegex(topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
                owner.barrier()

    def test_v1_event_pending_group_cannot_pass_barrier(self):
        owner, native, _ = self.install_events()
        native.events.append(native.message('AUDIT', audit_event(20, syscall=93)))
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_PENDING$'):
            owner.barrier()
        owner, native, _ = self.install_events()
        native.events.append(('AUDIT', 0, 10, audit_event(21, syscall=93), 0))
        native.mono = 1011
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
            owner.barrier()

    def test_v1_audit_healthy_status_changed_list_rules_denied(self):
        owner, native, _ = self.install_events(); native.rules_changed = True
        with self.assertRaisesRegex(topology.TopologyError, '^AUDIT_RULES_DENIED$'):
            owner.barrier()

    def test_v1_all_fixed_audit_syscalls_require_complete_original_attribution(self):
        fixed = (33, 39, 40, 41, 51, 93, 94, 97, 200, 201, 220, 221,
                 268, 281, 435)
        for serial, syscall in enumerate(fixed, 1):
            owner, native, _ = self.install_events()
            rows = [native.message('AUDIT', audit_event(
                serial, syscall=syscall, exit_code=700 if syscall in (220, 435) else 0))]
            if syscall == 200:
                rows.append(native.message('AUDIT', audit_sockaddr(serial, 'inet')))
            rows.append(native.message('AUDIT', audit_nlmsg(1320, ('audit(1.000:%d): end' % serial).encode('ascii'))))
            native.events.extend(rows)
            if syscall == 93:
                # P58: exit ends one thread of an attributed role (pid= is the
                # tgid); it adds no event. exit_group (94) still ends the role.
                with self.subTest(syscall=syscall):
                    self.assertEqual(owner.barrier().generation, 1)
                continue
            with self.subTest(syscall=syscall), self.assertRaisesRegex(
                    topology.TopologyError, '^(EVENT_DRIFT|EVENT_SOURCE_TERMINAL)$'):
                owner.barrier()
        for fault in ('foreign', 'missing-pid', 'duplicate-syscall',
                      'missing-sockaddr', 'contradictory-exit',
                      'nonzero-return'):
            owner, native, _ = self.install_events(); serial = 80
            if fault == 'missing-pid':
                raw = audit_nlmsg(1300, b'audit(1.000:80): arch=c00000b7 syscall=40 success=yes exit=0 a0=0 '
                    b'a1=0 a2=0 a3=0 items=0 ppid=1')
            else:
                raw = audit_event(serial, syscall=200 if fault == 'missing-sockaddr' else 40,
                                  pid=999 if fault == 'foreign' else 500,
                                  exit_code=(-1 if fault == 'contradictory-exit'
                                             else 1 if fault == 'nonzero-return'
                                             else 0))
            native.events.append(native.message('AUDIT', raw))
            if fault == 'duplicate-syscall':
                native.events.append(native.message('AUDIT', raw))
            native.events.append(native.message('AUDIT', audit_nlmsg(1320, b'audit(1.000:80): end')))
            with self.subTest(fault=fault), self.assertRaisesRegex(
                    topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
                owner.barrier()
        owner, native, _ = self.install_events()
        native.events.extend((native.message('AUDIT', audit_nlmsg(1300, b'audit(1.000:81): arch=c00000b7 syscall=40 success=no '
                       b'exit=-1 a0=0 a1=0 a2=0 a3=0 items=0 ppid=1 pid=500')),
            native.message('AUDIT', audit_nlmsg(1320, b'audit(1.000:81): end'))))
        self.assertEqual(owner.barrier().binding, event_binding())

    def test_v1_audit_stream_demux_and_fence_records_precede_checkpoint(self):
        class Interleaved(EventNative):
            def audit_request(self, owner, request, sequence):
                values = list(super().audit_request(owner, request, sequence))
                if request == 'HEALTH' and not getattr(self, 'injected', False):
                    self.injected = True
                    values[0:0] = [self.message('AUDIT', audit_event(90, syscall=40)),
                        self.message('AUDIT', audit_nlmsg(1320, b'audit(1.000:90): end'))]
                return tuple(values)
        with self.assertRaisesRegex(topology.TopologyError,
                                    '^(EVENT_DRIFT|EVENT_SOURCE_TERMINAL)$'):
            self.install_events(Interleaved())

        class FenceArrival(EventNative):
            def delivery_barrier(self, owners, wakeup, selector):
                rows = (self.message('AUDIT', audit_event(91, syscall=40)),
                        self.message('AUDIT', audit_nlmsg(1320, b'audit(1.000:91): end')))
                return topology.qualify_offline_fence_records(rows, True)
        owner, _, _ = self.install_events(FenceArrival())
        with self.assertRaisesRegex(topology.TopologyError,
                                   '^(EVENT_DRIFT|EVENT_SOURCE_TERMINAL)$'):
            owner.barrier()

    def test_v1_final_all_source_fence_closes_every_post_health_window(self):
        def event(native, source):
            if source == 'ROUTE':
                return native.message(
                    source, topology._event_nlmsg(16, 0, b'\0' * 16))
            if source == 'UEVENT':
                return native.message(source, b'ACTION=change\0SEQNUM=1\0')
            if source == 'INOTIFY':
                return native.message(source, struct.pack('<iIII', 2, 2, 0, 0))
            return native.message('ROLE', b'BROWSER')
        for request_count in (5, 6):
            for source in ('ROUTE', 'UEVENT', 'INOTIFY', 'ROLE'):
                class PostHealthArrival(EventNative):
                    def __init__(self):
                        super().__init__(); self.request_count = 0
                    def audit_request(self, owner, request, sequence):
                        self.request_count += 1
                        if self.request_count == request_count:
                            self.events.append(event(self, source))
                        return super().audit_request(owner, request, sequence)
                owner, _, _ = self.install_events(PostHealthArrival())
                with self.subTest(request_count=request_count, source=source), \
                        self.assertRaisesRegex(topology.TopologyError,
                            '^(EVENT_DRIFT|EVENT_SOURCE_TERMINAL)$'):
                    owner.barrier()

    def test_v1_pending_caps_are_aggregate_across_groups_and_barriers(self):
        owner, native, _ = self.install_events()
        native.events.append(native.message('AUDIT', audit_event(1, syscall=93)))
        native.events.extend(native.message('AUDIT', audit_aux(1)) for _ in range(127))
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_PENDING$'):
            owner.barrier()
        native.events.append(native.message('AUDIT', audit_event(2, syscall=93)))
        native.events.extend(native.message('AUDIT', audit_aux(2)) for _ in range(127))
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_PENDING$'):
            owner.barrier()
        native.events.append(native.message('AUDIT', audit_aux(2)))
        with self.assertRaisesRegex(topology.TopologyError,
                                   '^EVENT_SOURCE_TERMINAL$'):
            owner.barrier()

        owner, native, _ = self.install_events()
        native.events.append(native.message('AUDIT', audit_event(3, syscall=93)))
        native.events.extend(native.message('AUDIT', audit_aux(3, size=65000))
                             for _ in range(17))
        with self.assertRaisesRegex(topology.TopologyError,
                                   '^EVENT_SOURCE_TERMINAL$'):
            owner.barrier()

    def test_v1_cleanup_clamps_zero_smaller_and_expired_shared_allowance(self):
        class AllowanceNative(EventNative):
            def __init__(self): super().__init__(); self.allowances = []
            def close_owned(self, owner, remaining_ms):
                self.allowances.append(remaining_ms)
                return super().close_owned(owner, remaining_ms)
            def cleanup_pending(self, token, remaining_ms):
                self.allowances.append(remaining_ms)
                return super().cleanup_pending(token, remaining_ms)
        owner, native, _ = self.install_events(AllowanceNative())
        self.assertEqual(owner.stop_owned(0)['status'], 'TIMEOUT')
        self.assertTrue(native.allowances)
        self.assertTrue(all(value == 0 for value in native.allowances))
        self.assertEqual(owner.stop_owned(60000)['status'], 'TIMEOUT')

        # An earlier terminal event started the one shared end (C1); tests no
        # longer write its deadline directly.
        owner, native, budget = self.install_events(AllowanceNative())
        budget.start_terminal(); budget.clamp_end(1000)
        self.assertEqual(owner.stop_owned(7)['status'], 'STOPPED')
        self.assertTrue(all(0 <= value <= 7 for value in native.allowances))
        self.assertLessEqual(budget.deadline, 17)

        for expired in ('monotonic', 'real'):
            with self.subTest(expired=expired):
                owner, native, budget = self.install_events(AllowanceNative())
                budget.start_terminal()
                if expired == 'monotonic': budget.clamp_end(10)
                else: budget._real = lambda: budget.real_deadline
                self.assertEqual(owner.stop_owned(50)['status'], 'TIMEOUT')
                self.assertTrue(all(value == 0 for value in native.allowances))

    def test_v1_cleanup_requires_exact_original_descriptor_closed_facts(self):
        class BrokenClose(EventNative):
            def __init__(self, fault): super().__init__(); self.fault = fault
            def close_owned(self, owner, remaining_ms):
                if self.fault == 'substitute':
                    replacement = EventFD(self, 'SUBSTITUTE', 99)
                    replacement.closed = True; self.closed.append(replacement)
                    return None
                self.closed.append(owner)
                if self.fault == 'false-return': return False
                if self.fault == 'live': return object()
                if self.fault == 'partial-wakeup' and isinstance(owner, EventPipe):
                    owner.filenos = lambda: (-1, owner.write_fd)
                    return None
                owner.closed = True
                if self.fault == 'observation' and isinstance(owner, EventFD):
                    owner.fileno = lambda: (_ for _ in ()).throw(RuntimeError('fact'))
        for fault in ('false-return', 'live', 'substitute',
                      'partial-wakeup', 'observation'):
            owner, native, _ = self.install_events(BrokenClose(fault))
            receipt = owner.stop_owned(1000)
            with self.subTest(fault=fault):
                self.assertEqual(receipt['status'], 'TIMEOUT')
                self.assertEqual(owner.stop_owned(1000)['status'], 'TIMEOUT')
                self.assertTrue(native.closed)

    def test_v1_audit_empty_main_backlog_pending_delivery_unavailable(self):
        owner, native, _ = self.install_events(EventNative(fence=False))
        self.assertEqual(native.health_backlog, 0)
        with self.assertRaisesRegex(topology.TopologyError,
                                   '^NATIVE_EVENT_BARRIER_UNAVAILABLE$'):
            owner.barrier()

    def test_v1_list_rules_incomplete_foreign_or_oversized_denied(self):
        for fault in ('incomplete', 'foreign', 'oversized'):
            native = EventNative(); original = native.audit_rules
            def bad(owner, sequence, fault=fault):
                rows = list(original(owner, sequence))
                if fault == 'incomplete': rows.pop()
                elif fault == 'foreign': rows[0] = (42, rows[0][1], rows[0][2])
                else: rows = rows[:1] * 17 + rows[-1:]
                return tuple(rows)
            native.audit_rules = bad
            with self.subTest(fault=fault), self.assertRaisesRegex(
                    topology.TopologyError, '^AUDIT_RULES_DENIED$'):
                self.install_events(native)

    def test_v1_source_specific_sequence_and_coalescing_limits(self):
        owner, native, _ = self.install_events()
        native.events += [
            native.message('ROUTE', topology._event_nlmsg(16, 0, b'\x00' * 16)),
            native.message('ROUTE', topology._event_nlmsg(20, 0, b'\x00' * 8)),
            native.message('INOTIFY', struct.pack('<iIII', 2, 2, 0, 0)),
            native.message('INOTIFY', struct.pack('<iIII', 2, 2, 0, 0)),
        ]
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_DRIFT$'): owner.barrier()
        owner, native, _ = self.install_events()
        native.events += [native.message('UEVENT', b'ACTION=change\0SEQNUM=4\0'),
                          native.message('UEVENT', b'ACTION=change\0SEQNUM=6\0')]
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
            owner.barrier()

    def test_v1_event_fd_inventory_never_reaches_roles(self):
        owner, native, _ = self.install_events()
        self.assertEqual(owner.descriptor_count, 4)
        self.assertEqual(owner.wakeup_descriptor_count, 2)
        self.assertEqual(tuple(fd for launch in authority().role_launches
                               for fd in (item.fd for item in launch.fds)),
                         tuple(fd for _ in authority().role_launches for fd in range(5)))
        self.assertFalse(hasattr(owner.selector, 'fileno'))

    def test_v1_event_setup_failure_keeps_typed_cleanup(self):
        native = EventNative(fail_at='INOTIFY')
        with self.assertRaises(topology.TopologyError) as raised:
            self.install_events(native)
        self.assertTrue(hasattr(raised.exception, 'cleanup'))
        receipt = raised.exception.cleanup.stop_owned(60000)
        self.assertIn(receipt['status'], ('STOPPED', 'TIMEOUT'))
        self.assertEqual(receipt['runId'], RUN)
        self.assertGreaterEqual(len(native.closed), 4)

    def test_v1_current_roles_use_real_observer_and_proxy_inventory(self):
        confinement_fixture = load(
            'task8_event_current_confinement_fixture',
            'tests/unit/confinement_test.py')
        confinement_fixture.c = confinement
        confinement_fixture.RUN = RUN
        binding = event_binding()
        authority, child, proxy_handoff, proxy_kernel, proxy_active, _ = literal_proxy_authority(
            confinement_fixture, binding=binding, clock=Clock())
        runtime_owners = {role: object() for role in confinement.UIDS}
        runtime_owners['PROXY'] = authority
        handoffs, controls = [], {}
        for role, lifecycle in zip(confinement.UIDS,
                ('SERVICE', 'WAITING', 'WAITING', 'SERVICE')):
            if role == 'PROXY':
                handoffs.append(proxy_handoff); controls[role] = (proxy_kernel, proxy_active)
                continue
            handoff, kernel, active, _ = literal_runtime_role(
                confinement_fixture, role, lifecycle, runtime_owners[role])
            handoffs.append(handoff); controls[role] = (kernel, active)
        before = topology.observe_current_roles(
            tuple(handoffs), runtime_owners, authority, binding)
        self.assertEqual([row['lifecycle'] for row in before],
                         ['SERVICE', 'WAITING', 'WAITING', 'SERVICE'])
        self.assertEqual([row['kind'] for row in before[3]['currentFDs']][5:],
                         ['PROXY_LISTENER', 'PROXY_STOP_SELECTOR'])
        # Each composed PROXY observation is one bracketed pair of child reports.
        self.assertEqual(child.reports, 2)

        # Task 6 already proves only its completed original preparation can
        # reach this private transition. Exercise that authored transition,
        # then require the composed helper to derive BROWSER_ACTIVE.
        browser = handoffs[1]; kernel = controls['BROWSER'][0]
        preparation = object.__new__(confinement.BootstrapBrowserPreparation)
        roles = types.SimpleNamespace(_preparation=preparation)
        object.__setattr__(preparation, '_roles', roles)
        object.__setattr__(preparation, '_child', browser)
        object.__setattr__(preparation, '_committed', True)
        kernel._commit_browser_runtime(preparation)
        after = topology.observe_current_roles(
            tuple(handoffs), runtime_owners, authority, binding)
        self.assertEqual(after[1]['lifecycle'], 'BROWSER_ACTIVE')
        self.assertEqual(after[3], before[3])

        controls['BROWSER'][1]['fds'].append(6)
        with self.assertRaisesRegex(topology.TopologyError,
                '^NATIVE_CURRENT_INVENTORY_UNAVAILABLE$'):
            topology.observe_current_roles(
                tuple(handoffs), runtime_owners, authority, binding)
        controls['BROWSER'][1]['fds'].pop()
        substituted = dict(runtime_owners); substituted['PROXY'] = object()
        with self.assertRaisesRegex(topology.TopologyError, '^ROLE_DENIED$'):
            topology.observe_current_roles(
                tuple(handoffs), substituted, authority, binding)
        # R11: anything but the child authority (an in-process owner included) is denied.
        for candidate in (object(), substituted['PROXY']):
            with self.assertRaisesRegex(topology.TopologyError, '^ROLE_DENIED$'):
                topology.observe_current_roles(
                    tuple(handoffs), dict(runtime_owners, PROXY=candidate), candidate, binding)
        self.assertEqual(topology.observe_current_roles(
            tuple(handoffs), runtime_owners, authority, binding)[3], before[3])

    def test_v1_browser_family_event_reservation_is_nominal_ordered_and_one_use(self):
        confinement_fixture = load(
            'task8_event_reservation_confinement_fixture',
            'tests/unit/confinement_test.py')
        confinement_fixture.c = confinement
        confinement_fixture.RUN = RUN
        binding = event_binding()
        proxy_authority, child, _, _, _, _ = literal_proxy_authority(
            confinement_fixture, binding=binding, clock=Clock())
        runtime_owners = {role: object() for role in confinement.UIDS}
        runtime_owners['PROXY'] = proxy_authority
        browser, _, _, _ = literal_runtime_role(
            confinement_fixture, 'BROWSER', 'WAITING',
            runtime_owners['BROWSER'])

        def event_owner():
            native = EventNative()
            del native.audit_role_pids[501]
            native.audit_role_pids[300] = 'BROWSER'
            budget = topology.CleanupBudget(clock=Clock(
                (100, 10), (100, 10), (100, 10), (100, 10),
                (100, 10), (100, 10), (100, 10), (100, 10)))
            value = topology.LinuxBootstrapEventSource.install(
                binding, topology.qualify_offline_event_native(native), budget)
            return value, native

        def group(native, serial, syscall, pid, ppid, exit_code,
                  argument0='0'):
            return (native.message('AUDIT', audit_event(serial, syscall,
                pid=pid, ppid=ppid, exit_code=exit_code,
                argument0=argument0)),
                native.message('AUDIT', audit_nlmsg(1320, ('audit(1.000:%d): end' % serial).encode())))

        source, native = event_owner()
        self.assertTrue(hasattr(source, 'reserve_browser_transition'))
        reservation = source.reserve_browser_transition(
            binding, 1, browser, runtime_owners['BROWSER'], proxy_authority)
        source.commit_browser_transition(reservation)
        # Reservation and commit each observed the child through one bracket.
        self.assertEqual(child.reports, 4)
        native.events.extend(group(native, 101, 220, 300, 1, 2))
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_PENDING$'):
            source.barrier()
        # Task 11 (P18): no EXIT phase. The pinned-Chromium exec moves the
        # transition to ACTIVE, which a barrier publishes.
        native.events.extend(exec_group(native, 102, pid=600, ppid=300))
        checkpoint = source.barrier()
        self.assertEqual(source._browser_transition['phase'], 'ACTIVE')
        self.assertEqual(checkpoint.generation, 1)

        source, native = event_owner()
        native.events.extend(group(native, 104, 220, 300, 1, 601))
        with self.assertRaisesRegex(topology.TopologyError,
                                   '^EVENT_SOURCE_TERMINAL$'):
            source.barrier()

        for fault in ('mismatch', 'out-of-order', 'extra', 'replay'):
            source, native = event_owner()
            reservation = source.reserve_browser_transition(
                binding, 1, browser, runtime_owners['BROWSER'], proxy_authority)
            source.commit_browser_transition(reservation)
            if fault == 'replay':
                with self.assertRaisesRegex(topology.TopologyError,
                                           '^EVENT_SOURCE_TERMINAL$'):
                    source.commit_browser_transition(reservation)
                continue
            values = {'mismatch': (105, 220, 301, 1, 602),
                      'out-of-order': (106, 221, 300, 1, 0),
                      'extra': (107, 40, 300, 1, 0)}[fault]
            native.events.extend(group(native, *values))
            with self.assertRaisesRegex(topology.TopologyError,
                                       '^EVENT_SOURCE_TERMINAL$'):
                source.barrier()

        source, _ = event_owner()
        with self.assertRaisesRegex(topology.TopologyError,
                                   '^EVENT_SOURCE_TERMINAL$'):
            source.reserve_browser_transition(
                binding, 2, browser, runtime_owners['BROWSER'], proxy_authority)
        for fault in ('binding', 'role-owner', 'runtime-owner', 'proxy-owner'):
            source, _ = event_owner()
            values = dict(binding=binding, handoff=browser,
                runtime=runtime_owners['BROWSER'], proxy=proxy_authority)
            if fault == 'binding':
                values['binding'] = dataclasses.replace(binding, epoch=2)
            elif fault == 'role-owner':
                values['handoff'] = dataclasses.replace(browser)
            elif fault == 'runtime-owner':
                values['runtime'] = object()
            else: values['proxy'] = object()
            with self.subTest(fault=fault), self.assertRaisesRegex(
                    topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
                source.reserve_browser_transition(values['binding'], 1,
                    values['handoff'], values['runtime'], values['proxy'])
        # The PROXY report changed between reservation and commit: never consumed.
        source, _ = event_owner()
        reservation = source.reserve_browser_transition(
            binding, 1, browser, runtime_owners['BROWSER'], proxy_authority)
        child.table[6]['flags'] = 3
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
            source.commit_browser_transition(reservation)
        self.assertFalse(reservation._used)
        first, _ = event_owner(); second, _ = event_owner()
        other, _, _, _, _, _ = literal_proxy_authority(
            confinement_fixture, binding=binding, clock=Clock())
        reservation = first.reserve_browser_transition(
            binding, 1, browser, runtime_owners['BROWSER'], other)
        with self.assertRaisesRegex(topology.TopologyError,
                                   '^EVENT_SOURCE_TERMINAL$'):
            second.commit_browser_transition(reservation)

    # --- Task 11: event literals, the Chromium launch family and E-1b ---------
    def browser_source(self, *, commit=True, launch=False):
        """An installed event source over the literal BROWSER child (root pid
        300; CONTROLLER 500, VERIFIER 502, PROXY 503). commit reserves and
        commits the transition; launch then observes the pinned launch (root
        clones 600, 600 execs confinement.CHROME), so the transition is ACTIVE."""
        fixture = shared_confinement_fixture()
        binding = event_binding()
        proxy_authority, _, _, _, _, _ = literal_proxy_authority(
            fixture, binding=binding, clock=Clock())
        runtime_owners = {role: object() for role in confinement.UIDS}
        runtime_owners['PROXY'] = proxy_authority
        browser, _, _, _ = literal_runtime_role(
            fixture, 'BROWSER', 'WAITING', runtime_owners['BROWSER'])
        root = browser.attestation.pid
        self.assertEqual(root, 300)
        native = EventNative()
        del native.audit_role_pids[501]
        native.audit_role_pids[root] = 'BROWSER'
        source = topology.LinuxBootstrapEventSource.install(
            binding, topology.qualify_offline_event_native(native),
            topology.CleanupBudget(clock=Clock((100, 10))))
        if commit:
            source.commit_browser_transition(source.reserve_browser_transition(
                binding, 1, browser, runtime_owners['BROWSER'], proxy_authority))
        if launch:
            native.events += audit_group(native, 101, 220, pid=root, ppid=1, exit_code=2)
            native.events += exec_group(native, 102, pid=600, ppid=root)
            try:
                source.barrier()
            except topology.TopologyError as error:
                self.fail('the observed pinned launch must reach ACTIVE, got %s' % error)
            self.assertEqual(source._browser_transition['phase'], 'ACTIVE')
        return source, native, root

    def assert_publishes(self, source):
        """The barrier publishes a checkpoint; any TopologyError is an assertion failure."""
        try:
            return source.barrier()
        except topology.TopologyError as error:
            self.fail('barrier must publish a checkpoint, got %s' % error)

    def assert_terminal(self, source, code='EVENT_SOURCE_TERMINAL'):
        with self.assertRaisesRegex(topology.TopologyError, '^%s$' % code):
            source.barrier()
        # Latched: every later barrier stays terminal.
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
            source.barrier()

    def test_v1_enumerated_rule_built_independently_of_production_constant(self):
        values = coverage_values()
        enumerated = topology._parse_event_nlmsg(
            EventNative().audit_rules(None, 7)[0][2])[3]
        self.assertEqual(enumerated, coverage_audit_rule())
        # Every word of the production rule equals the coverage-built one (E2,
        # E4, E15 and every mask word).
        rule = topology._FIXED_AUDIT_RULE
        size, count = (coverage_value(name, values)
                       for name in ('AUDIT_BITMASK_SIZE', 'AUDIT_MAX_FIELDS'))
        words = struct.unpack('<III%dI%dI%dI%dII' % (size, count, count, count), rule)
        expected = struct.unpack('<III%dI%dI%dI%dII' % (size, count, count, count), enumerated)
        self.assertEqual(len(words), len(expected))
        for index, (got, want) in enumerate(zip(words, expected)):
            self.assertEqual(got, want, 'audit_rule_data word %d' % index)
        self.assertEqual(rule, enumerated)
        # The double never reads the production constant: a changed production
        # rule leaves the enumeration unchanged, so install sees changed rules.
        changed = bytearray(rule)
        changed[4:8] = struct.pack('<I', 0)
        with mock.patch.object(topology, '_FIXED_AUDIT_RULE', bytes(changed)):
            self.assertEqual(topology._parse_event_nlmsg(
                EventNative().audit_rules(None, 8)[0][2])[3], enumerated)
            with self.assertRaisesRegex(topology.TopologyError, '^AUDIT_RULES_DENIED$'):
                self.install_events()

    def test_v1_audit_unicast_framing_only_for_async_audit_records(self):
        # P62: the registered unicast receiver gets nlmsg_len without the header
        # (kernel/audit.c:2439, sent unrepaired at :715; only the multicast copy
        # is repaired, :819-832). Exactly that form is accepted for asynchronous
        # AUDIT records; replies and ROUTE keep nlmsg_len == len(data).
        text = audit_text(7, 200, pid=500, ppid=1, success='no', exit_code=-13).encode('ascii')

        def full(kind, payload, sequence=0):
            return struct.pack('<IHHII', 16 + len(payload), kind, 0, sequence, 0) + payload

        def bare(kind, payload, sequence=0):
            return struct.pack('<IHHII', len(payload), kind, 0, sequence, 0) + payload

        owner, native, _ = self.install_events()
        native.events += [native.message('AUDIT', audit_nlmsg(1300, text)),
                          native.message('AUDIT', audit_eoe(7))]
        before = owner.sequence
        self.assertEqual(self.assert_publishes(owner).sequence, before + 2)
        faults = {
            'audit-full-length': lambda n: [n.message('AUDIT', full(1300, text)),
                                            n.message('AUDIT', audit_eoe(7))],
            'audit-off-by-one': lambda n: [n.message('AUDIT', bare(1300, text)[:-1]),
                                           n.message('AUDIT', audit_eoe(7))],
            'route-bare-length': lambda n: [n.message('ROUTE', bare(16, b'\0' * 16))],
        }
        for fault, rows in faults.items():
            owner, native, _ = self.install_events()
            native.events += rows(native)
            with self.subTest(fault=fault):
                self.assert_terminal(owner)

        class BareReply(EventNative):  # a reply in the unicast event form
            def audit_health(self, owner, sequence):
                sender, observed, raw = super().audit_health(owner, sequence)
                return sender, observed, bare(1000, raw[16:], sequence)
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
            self.install_events(BareReply())

        for form, expected in ((audit_nlmsg, None), (lambda k, p: full(k, p), 'EVENT_SOURCE_TERMINAL')):
            class Interleaved(EventNative):  # an async record inside a reply stream
                def audit_request(self, owner, request, sequence, form=form):
                    values = list(super().audit_request(owner, request, sequence))
                    if request == 'HEALTH' and not getattr(self, 'done', False):
                        self.done = True
                        values[0:0] = [self.message('AUDIT', form(1300, text)),
                                       self.message('AUDIT', form(1320, b'audit(1.000:7): '))]
                    return tuple(values)
            with self.subTest(interleaved=expected or 'accepted'):
                if expected is None:
                    owner, _, _ = self.install_events(Interleaved())
                    self.assertEqual(self.assert_publishes(owner).generation, 1)
                else:
                    with self.assertRaisesRegex(topology.TopologyError, '^%s$' % expected):
                        self.install_events(Interleaved())

    def test_v1_audit_serials_unique_within_window_not_ordered(self):
        # P63: serials are taken at the first log call and records are queued
        # later (kernel/auditsc.c:2522-2528, kernel/audit.c:2442), so N+1 may
        # arrive before N. A new serial is accepted once, within 1024 below the
        # highest seen; a repeat or an older serial is terminal.
        def group(native, serial):
            text = audit_text(serial, 40, pid=500, ppid=1, success='no', exit_code=-1)
            return [native.message('AUDIT', audit_nlmsg(1300, text.encode('ascii'))),
                    native.message('AUDIT', audit_eoe(serial))]

        owner, native, _ = self.install_events()
        native.events += group(native, 8) + group(native, 7)
        self.assertEqual(self.assert_publishes(owner).generation, 1)
        native.events += group(native, 2000)
        self.assertEqual(self.assert_publishes(owner).generation, 1)
        native.events += group(native, 976)  # exactly the window
        self.assertEqual(self.assert_publishes(owner).generation, 1)
        native.events += group(native, 975)
        self.assert_terminal(owner)
        for repeat in (8, 976):
            owner, native, _ = self.install_events()
            native.events += group(native, 8) + group(native, 2000) + group(native, 976)
            self.assert_publishes(owner)
            native.events += group(native, repeat)
            with self.subTest(repeat=repeat):
                self.assert_terminal(owner)

    def test_v1_audit_lost_counter_increase_latches_terminal(self):
        owner, native, _ = self.install_events()
        self.assertEqual(self.assert_publishes(owner).lostCount, 0)
        native.lost = 1
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
            owner.barrier()
        native.lost = 0  # a later healthy status cannot clear the latch
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
            owner.barrier()
        self.assertEqual(owner.generation, 2)
        native = EventNative(); native.lost = 3
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
            self.install_events(native)

    def test_v1_async_audit_record_with_ack_flag_terminal(self):
        # A failed call would otherwise add no event, so the flag alone decides.
        text = audit_text(7, 200, pid=500, ppid=1, success='no', exit_code=-13)
        for flag in (4, 16):  # NLM_F_ACK, NLM_F_DUMP_INTR
            owner, native, _ = self.install_events()
            native.events += [native.message('AUDIT', audit_nlmsg(1300, text.encode('ascii'), flags=flag)),
                native.message('AUDIT', audit_eoe(7))]
            with self.subTest(flag=flag):
                self.assert_terminal(owner)
        owner, native, _ = self.install_events()
        native.events += [native.message('AUDIT', audit_nlmsg(1300, text.encode('ascii'))), native.message('AUDIT', audit_eoe(7))]
        self.assertEqual(self.assert_publishes(owner).generation, 1)

        class Interleaved(EventNative):
            def audit_request(self, owner, request, sequence):
                values = list(super().audit_request(owner, request, sequence))
                if request == 'HEALTH':
                    values.insert(0, self.message('AUDIT', audit_nlmsg(1300, text.encode('ascii'), flags=4)))
                return tuple(values)
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
            self.install_events(Interleaved())

        class Acknowledged(EventNative):  # NLMSG_ERROR (2) in place of AUDIT_GET
            def audit_health(self, owner, sequence):
                return (0, self.mono, topology._event_nlmsg(2, sequence, bytes(20)))
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
            self.install_events(Acknowledged())

    def test_v1_exec_must_name_pinned_chromium_executable(self):
        source, native, root = self.browser_source()
        native.events += audit_group(native, 101, 220, pid=root, ppid=1, exit_code=2)
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_PENDING$'):  # E5
            source.barrier()
        self.assertEqual(source._browser_transition['phase'], 'EXEC')
        native.events += exec_group(native, 102, pid=600, ppid=root)
        self.assertEqual(self.assert_publishes(source).generation, 1)
        self.assertEqual(source._browser_transition['phase'], 'ACTIVE')
        source, native, root = self.browser_source()
        native.events += audit_group(native, 101, 220, pid=root, ppid=1, exit_code=2)
        native.events += exec_group(native, 102, pid=600, ppid=root, syscall=281)
        self.assertEqual(self.assert_publishes(source).generation, 1)

        faults = {
            'wrong-ppid': dict(ppid=1),  # E6
            'root-execs': dict(pid=300),
            'other-path': dict(name='/bin/sh'),
            'proc-self-exe': dict(name='/proc/self/exe'),
            'other-argv0': dict(argv0='/bin/sh'),
            'other-inode': dict(inode=4712),
            'other-dev': dict(dev='fd:02'),
            'uppercase-dev': dict(dev='FD:01'),
            'no-path': dict(paths=False),
            'no-execve': dict(execve=False),
        }
        for fault, change in faults.items():
            source, native, root = self.browser_source()
            native.events += audit_group(native, 101, 220, pid=root, ppid=1, exit_code=2)
            values = dict(pid=600, ppid=root); values.update(change)
            native.events += exec_group(native, 102, **values)
            with self.subTest(fault=fault):
                self.assert_terminal(source)
        source, native, root = self.browser_source()
        native.events += audit_group(native, 101, 220, pid=root, ppid=1, exit_code=2)
        rows = exec_group(native, 102, pid=600, ppid=root)
        rows.insert(3, native.message('AUDIT', audit_path(102)))  # two item-0 PATH records
        native.events += rows
        self.assert_terminal(source)

    def test_v1_launch_exec_before_or_after_root_clone_record(self):
        # P61 a: the launch is the first pinned exec by a non-root pid whose ppid
        # is the root, in either order with the root's clone record. The clone's
        # exit= (2, the child's number in the BROWSER PID namespace) is never the
        # child's audit pid (600, initial namespace). Root clone3 records (Node
        # threads) between commit and the exec are allowed (review M-2).
        for order in ('exec-first', 'clone-first', 'thread-then-clone-first'):
            source, native, root = self.browser_source()
            if order == 'thread-then-clone-first':
                native.events += audit_group(native, 99, 435, pid=root, ppid=1, exit_code=5)
            if order != 'exec-first':
                native.events += audit_group(native, 100, 220, pid=root, ppid=1, exit_code=2)
                with self.assertRaisesRegex(topology.TopologyError, '^EVENT_PENDING$'):
                    source.barrier()
            native.events += exec_group(native, 101, pid=600, ppid=root)
            if order == 'exec-first':
                native.events += audit_group(native, 102, 220, pid=root, ppid=1, exit_code=2)
            with self.subTest(order=order):
                self.assert_publishes(source)
                transition = source._browser_transition
                self.assertEqual((transition['phase'], transition['child']), ('ACTIVE', 600))
                self.assertEqual(transition['family'], {root, 600})
        faults = {
            'not-a-family-pid': [lambda n: exec_group(n, 101, pid=600, ppid=1)],
            'non-root-clone-before-launch': [
                lambda n: audit_group(n, 101, 435, pid=600, ppid=300, exit_code=3)],
            'other-binary': [lambda n: exec_group(n, 101, pid=600, ppid=300, name='/bin/sh')],
            # 600 joins through its ppid with a failed call; its child's exec has a
            # family ppid that is not the root, so it is not the launch.
            'grandchild-exec': [lambda n: audit_group(n, 100, 97, pid=600, ppid=300, success='no',
                                                      exit_code=-1),
                                lambda n: exec_group(n, 101, pid=601, ppid=600)],
            'root-exec': [lambda n: exec_group(n, 101, pid=300, ppid=1)],
        }
        for fault, rows in faults.items():
            source, native, root = self.browser_source()
            for make in rows:
                native.events += make(native)
            with self.subTest(fault=fault):
                self.assert_terminal(source)

    def test_v1_family_by_initial_namespace_pid_and_ppid_only(self):
        # P61 b/c/d: a pid joins through its ppid; clone exit= values change
        # nothing, even when they equal another process's audit pid; an orphan
        # keeps a family ppid (its PID-namespace init); a family pid whose ppid is
        # not a family pid is a reused pid and terminal; exit_group removes.
        source, native, root = self.browser_source(launch=True)
        family = source._browser_transition['family']
        native.events += audit_group(native, 103, 220, pid=600, ppid=root, exit_code=3)
        native.events += audit_group(native, 104, 435, pid=600, ppid=root, exit_code=500)
        native.events += audit_group(native, 105, 220, pid=root, ppid=1, exit_code=600)
        native.events += audit_group(native, 106, 51, pid=4101, ppid=600)       # child joins
        native.events += audit_group(native, 107, 51, pid=4102, ppid=4101)      # grandchild
        self.assertEqual(self.assert_publishes(source).generation, 1)
        self.assertEqual(family, {root, 600, 4101, 4102})
        # 4101 exits; its orphan 4102 reparents to the BROWSER namespace init
        # (the root, kernel/exit.c:585-600, :690-706) and stays a member.
        native.events += audit_group(native, 108, 94, pid=4101, ppid=600)
        native.events += audit_group(native, 109, 51, pid=4102, ppid=root)
        self.assertEqual(self.assert_publishes(source).generation, 1)
        self.assertEqual(family, {root, 600, 4102})
        # Reuse: the removed pid 4101 seen again with a non-family parent is not
        # a member; a remaining member seen with a non-family parent is terminal.
        for pid in (4101, 4102):
            source, native, root = self.browser_source(launch=True)
            native.events += audit_group(native, 103, 51, pid=4101, ppid=600)
            native.events += audit_group(native, 104, 51, pid=4102, ppid=4101)
            native.events += audit_group(native, 105, 94, pid=4101, ppid=600)
            self.assert_publishes(source)
            # A failed call adds no event, so attribution alone decides.
            native.events += audit_group(native, 106, 97, pid=pid, ppid=1, success='no',
                                         exit_code=-1)
            with self.subTest(reused=pid):
                self.assert_terminal(source)

    def test_v1_exited_parent_counts_for_its_earlier_child_records(self):
        # P64/P65: a family parent removed by exit_group still counts as a family
        # parent, in either serial order, while its exit_group serial is within
        # the 1024-serial P63 window. Lower serials: records logged before the
        # exit but queued after it (P63). Higher serials: the kernel logs the
        # exit_group (kernel/exit.c:853) before it reparents the children
        # (:891 -> :736 -> :706), so a child's record in between still names it.
        def setup():
            source, native, root = self.browser_source(launch=True)
            native.events += audit_group(native, 200, 51, pid=4101, ppid=600)   # child joins
            native.events += audit_group(native, 201, 51, pid=4102, ppid=4101)  # grandchild joins
            self.assert_publishes(source)
            native.events += audit_group(native, 210, 94, pid=4101, ppid=600)   # child exits
            self.assert_publishes(source)
            transition = source._browser_transition
            self.assertEqual((transition['family'], transition['exited']),
                             ({root, 600, 4102}, {4101: 210}))
            return source, native
        # Lower and higher serials naming the exited parent, for a member (4102)
        # and a newcomer (4103): all attributed.
        for serials in ((205, 206), (215, 216)):
            source, native = setup()
            native.events += audit_group(native, serials[0], 51, pid=4102, ppid=4101)
            native.events += audit_group(native, serials[1], 51, pid=4103, ppid=4101)
            with self.subTest(serials=serials):
                self.assertEqual(self.assert_publishes(source).generation, 1)
                self.assertIn(4103, source._browser_transition['family'])
        # At the window's edge (highest 1234 = 210 + 1024) it still counts.
        source, native = setup()
        native.events += audit_group(native, 1234, 51, pid=4102, ppid=4101)
        self.assertEqual(self.assert_publishes(source).generation, 1)
        self.assertEqual(source._browser_transition['exited'], {4101: 210})
        # One serial later it has left the window: a record naming it is terminal
        # (P61(c) for the member, unknown parent for a newcomer).
        for pid in (4102, 4103):
            source, native = setup()
            native.events += audit_group(native, 1234, 93, pid=600, ppid=300)
            self.assert_publishes(source)
            native.events += audit_group(native, 1235, 51, pid=pid, ppid=4101)
            with self.subTest(after_window=pid):
                self.assert_terminal(source)
                self.assertEqual(source._browser_transition['exited'], {})

    def test_v1_reserved_transition_stuck_in_clone_is_pending_then_terminal(self):
        # Barriers at the health cadence (at most 100 ms apart) keep the source
        # healthy; an unobserved launch stays EVENT_PENDING through 1000 ms after
        # commit and is terminal after it (P60 keeps that bound).
        source, native, root = self.browser_source()
        for mono in range(10, 1011, 100):
            native.mono = mono
            with self.subTest(phase='CLONE', mono=mono), self.assertRaisesRegex(
                    topology.TopologyError, '^EVENT_PENDING$'):
                source.barrier()
        native.mono = 1011
        self.assert_terminal(source)
        self.assertEqual(source.generation, 2)
        source, native, root = self.browser_source()
        native.events += audit_group(native, 101, 220, pid=root, ppid=1, exit_code=2)
        for mono in range(10, 1011, 100):
            native.mono = mono
            with self.subTest(phase='EXEC', mono=mono), self.assertRaisesRegex(
                    topology.TopologyError, '^EVENT_PENDING$'):
                source.barrier()
        native.mono = 1011
        self.assert_terminal(source)
        # A pending barrier still verifies health: a gap beyond the 100 ms health
        # interval is terminal even inside the launch bound.
        source, native, root = self.browser_source()
        native.mono = 500
        self.assert_terminal(source)
        # Without a commit there is nothing pending.
        source, native, root = self.browser_source(commit=False)
        self.assertEqual(self.assert_publishes(source).generation, 1)

    def test_v1_launch_records_lagging_within_bound_reach_active(self):
        # P60: launch records may arrive well after commit; the transition is
        # EVENT_PENDING meanwhile and reaches ACTIVE when they arrive in bound.
        source, native, root = self.browser_source()
        for mono in (10, 100, 190, 280):
            native.mono = mono
            with self.assertRaisesRegex(topology.TopologyError, '^EVENT_PENDING$'):
                source.barrier()
        native.mono = 370
        native.events += audit_group(native, 101, 220, pid=root, ppid=1, exit_code=2)
        with self.assertRaisesRegex(topology.TopologyError, '^EVENT_PENDING$'):
            source.barrier()
        native.mono = 460
        native.events += exec_group(native, 102, pid=600, ppid=root)
        self.assertEqual(self.assert_publishes(source).generation, 1)
        self.assertEqual(source._browser_transition['phase'], 'ACTIVE')
        self.assertFalse(source.launch_pending())

    def test_v1_kernel_format_exit_record_without_success_field_parses(self):
        tail = (' auid=4294967295 uid=10002 gid=10002 euid=10002 suid=10002 fsuid=10002'
                ' egid=10002 sgid=10002 fsgid=10002 tty=(none) ses=4294967295'
                ' comm="chrome" exe="/opt/acceptance/runtime/chromium/chrome" key=(null)')
        for number in (93, 94):
            source, native, root = self.browser_source(launch=True)
            native.events += audit_group(native, 103, 220, pid=600, ppid=root, exit_code=3)
            native.events += [native.message('AUDIT', audit_nlmsg(1300, (
                'audit(1.000:104): arch=c00000b7 syscall=%d a0=0 a1=7f00 a2=0 a3=0 items=0'
                ' ppid=600 pid=601' % number + tail).encode('ascii'))),
                native.message('AUDIT', audit_eoe(104))]
            before = source.sequence
            checkpoint = self.assert_publishes(source)
            with self.subTest(number=number):
                self.assertEqual(checkpoint.sequence, before + 3)
                # P58: exit ends a thread (the pid stays); exit_group the process.
                self.assertEqual(601 in source._browser_transition['family'], number == 93)
                self.assertIn(600, source._browser_transition['family'])
        faults = {
            'exit-with-success': audit_text(104, 94, pid=601, ppid=600, success='yes'),
            'exit-without-a0': audit_text(104, 94, pid=601, ppid=600, argument0=None),
            'clone-without-success': audit_text(104, 220, pid=601, ppid=600, success=None),
        }
        for fault, text in faults.items():
            source, native, root = self.browser_source(launch=True)
            native.events += audit_group(native, 103, 220, pid=600, ppid=root, exit_code=3)
            native.events += [native.message('AUDIT', audit_nlmsg(1300, text.encode('ascii'))), native.message('AUDIT', audit_eoe(104))]
            with self.subTest(fault=fault):
                self.assert_terminal(source)

    def test_v1_family_reexec_of_pinned_chromium_accepted_other_exec_terminal(self):
        source, native, root = self.browser_source(launch=True)
        native.events += audit_group(native, 103, 220, pid=600, ppid=root, exit_code=3)
        native.events += exec_group(native, 104, pid=601, ppid=600)
        # 602's exec is logged before its parent's clone record (K12); it joins
        # through its ppid (P61).
        native.events += exec_group(native, 105, pid=602, ppid=601, syscall=281)
        native.events += audit_group(native, 106, 435, pid=601, ppid=600, exit_code=4)
        self.assertEqual(self.assert_publishes(source).generation, 1)
        self.assertEqual(source._browser_transition['family'], {root, 600, 601, 602})
        faults = {
            'other-binary': lambda n: exec_group(n, 107, pid=601, ppid=600, name='/bin/sh',
                                                 argv0='/bin/sh', inode=5000),
            'other-identity': lambda n: exec_group(n, 107, pid=601, ppid=600, inode=1),
            'other-device': lambda n: exec_group(n, 107, pid=601, ppid=600, dev='fd:02'),
            'not-normal': lambda n: exec_group(n, 107, pid=601, ppid=600, nametype='PARENT'),
            # P59: the ELF interpreter's item is never the executable.
            'interpreter-carries-identity': lambda n: exec_group(
                n, 107, pid=601, ppid=600, inode=5000, interpreter_inode=CHROME_IDENTITY[2],
                interpreter_dev='%02x:%02x' % CHROME_IDENTITY[:2]),
            'root-reexec': lambda n: exec_group(n, 107, pid=300, ppid=1),
            'non-family-ppid': lambda n: exec_group(n, 107, pid=700, ppid=1),
            'controller-exec': lambda n: exec_group(n, 107, pid=500, ppid=1),
        }
        for fault, rows in faults.items():
            source, native, root = self.browser_source(launch=True)
            native.events += audit_group(native, 103, 220, pid=600, ppid=root, exit_code=3)
            native.events += rows(native)
            with self.subTest(fault=fault):
                self.assert_terminal(source)

    def test_v1_family_reexec_via_proc_self_exe_accepted_by_identity(self):
        # P59: Chromium execs /proc/self/exe for its zygote and children. In
        # ACTIVE the executable's identity (AUDIT_PATH item 0) decides, whatever
        # name was passed; the launch itself still needs the literal path.
        for syscall in (221, 281):
            source, native, root = self.browser_source(launch=True)
            native.events += audit_group(native, 103, 220, pid=600, ppid=root, exit_code=3)
            native.events += exec_group(native, 104, pid=601, ppid=600, syscall=syscall,
                                        name='/proc/self/exe', argv0='/proc/self/exe')
            with self.subTest(syscall=syscall):
                self.assertEqual(self.assert_publishes(source).generation, 1)
        # Same name, different identity: terminal.
        source, native, root = self.browser_source(launch=True)
        native.events += audit_group(native, 103, 220, pid=600, ppid=root, exit_code=3)
        native.events += exec_group(native, 104, pid=601, ppid=600, name='/proc/self/exe',
                                    argv0='/proc/self/exe', inode=5000)
        self.assert_terminal(source)
        # The launch keeps requiring confinement.CHROME literally, in both orders.
        for order in ('clone-first', 'exec-first'):
            source, native, root = self.browser_source()
            if order == 'clone-first':
                native.events += audit_group(native, 101, 220, pid=root, ppid=1, exit_code=2)
            native.events += exec_group(native, 102, pid=600, ppid=root, name='/proc/self/exe',
                                        argv0='/proc/self/exe')
            with self.subTest(order=order):
                self.assert_terminal(source)

    def test_v1_clone_only_from_browser_root_or_family(self):
        # E13: before ACTIVE only the root clones: not another role, and not a
        # browser-family pid that joined through its ppid (P61).
        for pid, ppid in ((500, 1), (502, 1), (503, 1), (650, 300)):
            source, native, root = self.browser_source()
            native.events += audit_group(native, 101, 220, pid=pid, ppid=ppid, exit_code=2)
            with self.subTest(phase='CLONE', pid=pid):
                self.assert_terminal(source)
        # ACTIVE: root and family clones change nothing (P61: exit= is a
        # namespace-local number, never stored or compared), even when the
        # number equals another process's audit pid.
        source, native, root = self.browser_source(launch=True)
        for serial, (pid, ppid, child) in enumerate(
                ((root, 1, 5), (600, root, 3), (600, root, 500), (600, root, 600),
                 (600, root, 300)), 103):
            native.events += audit_group(native, serial, 435, pid=pid, ppid=ppid, exit_code=child)
        self.assertEqual(self.assert_publishes(source).generation, 1)
        self.assertEqual(source._browser_transition['family'], {root, 600})
        faults = {'controller': (500, 1, 6), 'verifier': (502, 1, 6),
                  'proxy': (503, 1, 6), 'unattributed': (700, 1, 6)}
        for fault, (pid, ppid, child) in faults.items():
            source, native, root = self.browser_source(launch=True)
            native.events += audit_group(native, 103, 220, pid=pid, ppid=ppid, exit_code=child)
            with self.subTest(phase='ACTIVE', fault=fault):
                self.assert_terminal(source)

    def test_v1_root_browser_exit_is_terminal_browser_exited(self):
        # P18 (reviewer mutant E7) and P58: the root browser's exit_group is
        # terminal in every phase.
        for phase in ('CLONE', 'EXEC', 'ACTIVE'):
            source, native, root = self.browser_source(launch=phase == 'ACTIVE')
            if phase == 'EXEC':
                native.events += audit_group(native, 101, 220, pid=root, ppid=1,
                                             exit_code=2)
            native.events += audit_group(native, 110, 94, pid=root, ppid=1)
            with self.subTest(phase=phase):
                self.assert_terminal(source, 'BROWSER_EXITED')
        # A family exit_group removes that process (P61 d).
        source, native, root = self.browser_source(launch=True)
        native.events += audit_group(native, 110, 94, pid=600, ppid=root)
        self.assertEqual(self.assert_publishes(source).generation, 1)
        self.assertEqual(source._browser_transition['family'], {root})

    def test_v1_thread_exit_is_not_process_exit(self):
        # P58: pid= is the tgid (kernel/audit.c:2257-2261), so exit (93) is one
        # thread ending. It never terminates the run and never removes a pid.
        for phase in ('CLONE', 'EXEC', 'ACTIVE'):
            source, native, root = self.browser_source(launch=phase == 'ACTIVE')
            if phase == 'EXEC':
                native.events += audit_group(native, 101, 220, pid=root, ppid=1,
                                             exit_code=2)
            native.events += audit_group(native, 110, 93, pid=root, ppid=1)
            with self.subTest(phase=phase):
                if phase == 'ACTIVE':
                    self.assertEqual(self.assert_publishes(source).generation, 1)
                else:  # the launch is still pending, never terminal
                    with self.assertRaisesRegex(topology.TopologyError, '^EVENT_PENDING$'):
                        source.barrier()
                self.assertIsNone(source._terminal)
                self.assertIn(root, source._browser_transition['family'])
        source, native, root = self.browser_source(launch=True)
        native.events += audit_group(native, 111, 93, pid=600, ppid=root)
        native.events += audit_group(native, 112, 93, pid=4102, ppid=600)  # joins via ppid
        native.events += audit_group(native, 113, 93, pid=500, ppid=1)     # another role's thread
        self.assertEqual(self.assert_publishes(source).generation, 1)
        transition = source._browser_transition
        self.assertEqual(transition['family'], {root, 600, 4102})
        # Its exit_group then removes it (P61 d).
        native.events += audit_group(native, 114, 94, pid=4102, ppid=600)
        self.assertEqual(self.assert_publishes(source).generation, 1)
        self.assertEqual(transition['family'], {root, 600})
        owner, native, _ = self.install_events()  # no transition
        native.events += audit_group(native, 115, 93, pid=500, ppid=1)
        self.assertEqual(self.assert_publishes(owner).generation, 1)

    def test_v1_browser_sandbox_unshare_newuser_admitted_after_exec(self):
        source, native, root = self.browser_source()
        native.events += audit_group(native, 101, 220, pid=root, ppid=1, exit_code=2)
        native.events += exec_group(native, 102, pid=600, ppid=root)
        self.assert_publishes(source)
        before = source.sequence
        native.events += audit_group(native, 103, 97, pid=600, ppid=root,
                                     argument0='10000000')
        native.events += audit_group(native, 104, 220, pid=600, ppid=root, exit_code=3)
        native.events += audit_group(native, 105, 97, pid=601, ppid=600,
                                     argument0='10000000')
        checkpoint = self.assert_publishes(source)
        self.assertEqual(checkpoint.sequence, before + 4)
        self.assertEqual(checkpoint.generation, 1)
        self.assertFalse(source._drift)
        self.assertIsNone(source._terminal)

    def test_v1_browser_sandbox_chroot_admitted_from_family_child(self):
        source, native, root = self.browser_source(launch=True)
        native.events += audit_group(native, 103, 220, pid=600, ppid=root, exit_code=3)
        native.events += audit_group(native, 104, 51, pid=601, ppid=600)
        self.assertEqual(self.assert_publishes(source).generation, 1)
        # Vfork order (K12): the helper's chroot and exit are logged before its
        # parent's clone record, whose exit= (4) is namespace-local (P61).
        native.events += audit_group(native, 105, 51, pid=602, ppid=601)
        native.events += audit_group(native, 106, 94, pid=602, ppid=601)
        native.events += audit_group(native, 107, 220, pid=601, ppid=600, exit_code=4)
        before = source.sequence
        checkpoint = self.assert_publishes(source)
        self.assertEqual(checkpoint.sequence, before + 4)
        self.assertEqual(source._browser_transition['family'], {root, 600, 601})
        # The clone record did not re-add 602: a later record from that pid whose
        # parent is not a family pid is terminal.
        native.events += audit_group(native, 108, 51, pid=602, ppid=1)
        self.assert_terminal(source)

    def test_v1_browser_sandbox_admission_exact(self):
        def attempt(rows, *, commit=True, launch=True, clone=False):
            source, native, root = self.browser_source(commit=commit, launch=launch)
            if clone:
                native.events += audit_group(native, 101, 220, pid=root, ppid=1,
                                             exit_code=2)
            native.events += rows(native)
            return source

        def unshare(a0, pid=600, ppid=300):
            return lambda n: audit_group(n, 120, 97, pid=pid, ppid=ppid, argument0=a0)

        def chroot(pid=600, ppid=300):
            return lambda n: audit_group(n, 120, 51, pid=pid, ppid=ppid)

        terminal = {}
        for a0 in ('20000', '10020000', '50000000', '30000000', '0', '10000001'):
            terminal['a0=' + a0] = dict(rows=unshare(a0))
        terminal['root-unshare'] = dict(rows=unshare('10000000', pid=300, ppid=1))
        terminal['root-chroot'] = dict(rows=chroot(pid=300, ppid=1))
        for role, pid in (('CONTROLLER', 500), ('VERIFIER', 502), ('PROXY', 503)):
            terminal[role + '-unshare'] = dict(rows=unshare('10000000', pid=pid, ppid=1))
            terminal[role + '-chroot'] = dict(rows=chroot(pid=pid, ppid=1))
        terminal['unattributable'] = dict(rows=unshare('10000000', pid=700, ppid=1))
        terminal['phase-CLONE'] = dict(rows=chroot(), launch=False)
        terminal['phase-EXEC'] = dict(rows=unshare('10000000'), launch=False, clone=True)
        for number in (40, 39, 41, 268, 33, 201):
            terminal['call-%d' % number] = dict(
                rows=lambda n, number=number: audit_group(n, 120, number, pid=600, ppid=300))
        for name, a0 in (('0x', '0x10000000'), ('uppercase', 'A0000000'),
                         ('leading-zero', '010000000'), ('missing', None),
                         ('duplicated', '10000000 a0=10000000')):
            terminal['malformed-' + name] = dict(rows=unshare(a0))
        for name, case in terminal.items():
            source = attempt(**case)
            with self.subTest(case=name):
                self.assert_terminal(source)
        # No transition: the same calls drift (ROLE), as before E-1b.
        for name, rows in (('unshare', unshare('10000000', pid=300, ppid=1)),
                           ('chroot', chroot(pid=300, ppid=1))):
            source = attempt(rows, commit=False, launch=False)
            with self.subTest(case='no-transition-' + name), self.assertRaisesRegex(
                    topology.TopologyError, '^EVENT_DRIFT$'):
                source.barrier()
        # Control: the exact admitted forms pass.
        for name, rows in (('unshare', unshare('10000000')), ('chroot', chroot())):
            source = attempt(rows)
            with self.subTest(case='admitted-' + name):
                self.assertEqual(self.assert_publishes(source).generation, 1)

    def test_v1_first_terminal_latch_freezes_budget_before_capture_settles(self):
        for settlement in (30010, 70010):
            with self.subTest(settlement=settlement):
                entered, release = threading.Event(), threading.Event()
                clock = Clock()
                def before_open(path):
                    if not entered.is_set():
                        entered.set()
                        if not release.wait(2): raise AssertionError('observation not released')
                gate, bindings, collection, kernel = native_capture_fixture(clock, before_open, fail_probe=True)
                errors = []
                def admit():
                    try: gate.admit()
                    except Exception as error: errors.append(error)
                worker = threading.Thread(target=admit, daemon=True)
                worker.start()
                try:
                    self.assertTrue(entered.wait(1))
                    before = time.monotonic_ns() // 1000000
                    with self.assertRaises(topology.CleanupFailure): gate.topology_drifted()
                    after = time.monotonic_ns() // 1000000
                    first_deadline = gate._cleanup_budget.deadline
                    first_real_deadline = gate._cleanup_budget.real_deadline
                    self.assertTrue(gate.cleanup_uncertain)
                    self.assertIs(collection.budget, gate._cleanup_budget)
                    self.assertIs(bindings._cleanup_budget, gate._cleanup_budget)
                    clock.last = (100, settlement)
                finally:
                    release.set(); worker.join(2)
                self.assertFalse(worker.is_alive())
                self.assertEqual(len(errors), 1)
                self.assertEqual(first_deadline, 60010)
                self.assertTrue(before + 60000 <= first_real_deadline <= after + 60000)
                self.assertEqual(gate._cleanup_budget.deadline, first_deadline)
                self.assertEqual(gate._cleanup_budget.real_deadline, first_real_deadline)
                if settlement < first_deadline:
                    self.assertEqual(kernel.stops, list(reversed(kernel.spawned)))
                    self.assertTrue(all(0 < allowance <= first_deadline - settlement for allowance in kernel.allowances))
                    self.assertFalse(gate.cleanup_uncertain)
                else:
                    self.assertEqual(kernel.allowances, [])
                    self.assertTrue(gate.cleanup_uncertain)
                    self.assertIn(collection, gate.unresolved_cleanup)
                    with self.assertRaises(topology.CleanupFailure): gate.admit()

    def test_v1_prior_current_settlement_cannot_clear_later_capture(self):
        prior_finally, release_prior, later_entered, release_later = (threading.Event() for _ in range(4))
        captures = 0
        def before_open(path):
            nonlocal captures
            if path == topology.NATIVE_OBSERVATION_PATHS[0]:
                captures += 1
                if captures == 3:
                    later_entered.set()
                    if not release_later.wait(2): raise AssertionError('later capture not released')
        gate, bindings, collection, kernel = native_capture_fixture(Clock(), before_open)
        gate.admit()
        lines, start = inspect.getsourcelines(topology.TopologyGate._attempt)
        settle_line = max(start + offset for offset, line in enumerate(lines)
                          if line.lstrip().startswith('with self._lock: self._pending_captures.'))
        errors = []
        def schedule(frame, event, arg):
            if (event == 'line' and frame.f_code is topology.TopologyGate._attempt.__code__
                    and frame.f_lineno == settle_line):
                prior_finally.set()
                if not release_prior.wait(2): raise AssertionError('prior completion not released')
            return schedule
        def prior():
            sys.settrace(schedule)
            try: gate.require_current()
            except Exception as error: errors.append(error)
            finally: sys.settrace(None)
        def later():
            try: gate.require_current()
            except Exception as error: errors.append(error)
        first = threading.Thread(target=prior, daemon=True)
        second = threading.Thread(target=later, daemon=True)
        first.start()
        try:
            self.assertTrue(prior_finally.wait(1))
            second.start()
            self.assertTrue(later_entered.wait(1))
            self.assertTrue(gate.cleanup_uncertain)
            release_prior.set(); first.join(1)
            self.assertFalse(first.is_alive())
            active_after_prior = bindings.capture_owner._active
            pending_after_prior = gate.cleanup_uncertain
            reservation_after_prior = gate._reservation
            pending_count = len(gate._pending_captures)
        finally:
            release_prior.set(); release_later.set(); first.join(2)
            if second.ident is not None: second.join(2)
        self.assertFalse(second.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(active_after_prior)
        self.assertIsNotNone(reservation_after_prior)
        self.assertEqual(pending_count, 1)
        self.assertTrue(pending_after_prior)
        self.assertFalse(gate.cleanup_uncertain)
        self.assertEqual(len(kernel.spawned), 4)
        self.assertEqual(kernel.stops, [])

    def test_v1_observation_cleanup_remains_reserved_until_receipt_settles(self):
        errors = []
        class Owner:
            cleanups = 0
            def read(self, limit): return b''
            def close(self): raise OSError('inert uncertain close')
            def cleanup(self): self.cleanups += 1
        owner = Owner()
        class CleanupClock(Clock):
            reentered = False
            def sample(self):
                if owner.cleanups and not self.reentered:
                    self.reentered = True
                    try: adapter.cleanup_unresolved()
                    except Exception as error: errors.append(error)
                return super().sample()
        class Source:
            def open_owned(self, path, flags): return owner
            def collect(self, expected): raise AssertionError('not reached')
            def observe(self, expected): raise AssertionError('not reached')
            def execute(self, identifier): raise AssertionError('not reached')
        source, clock = Source(), CleanupClock()
        adapter = topology.select_native_topology(source, source, source, source, source, 'linux', 'aarch64')
        gate = topology.TopologyGate(authority(clock=clock), adapter, supervisor=supervision())
        with self.assertRaises(topology.CleanupFailure): gate.admit()
        adapter.cleanup_unresolved()
        self.assertEqual(owner.cleanups, 1)
        self.assertEqual(len(errors), 1)
        self.assertIs(errors[0].cleanup, owner)
        self.assertEqual(adapter._unresolved, [])
        self.assertFalse(adapter._pending_observation_cleanup)

    def test_v1_capture_owner_precedes_first_observation_acquisition(self):
        test = self
        observed = []
        class Owner:
            closes = 0
            def read(self, limit): return b''
            def close(self): self.closes += 1
            def cleanup(self): raise AssertionError('already closed')
        owner = Owner()
        class Source:
            def open_owned(self, path, flags):
                observed.append((adapter.capture_owner in gate._owners, gate.cleanup_uncertain))
                with test.assertRaises(topology.CleanupFailure) as caught: gate.topology_drifted()
                test.assertIs(caught.exception.cleanup, gate)
                return owner
            def collect(self, expected): raise AssertionError('not reached')
            def observe(self, expected): raise AssertionError('not reached')
            def execute(self, identifier): raise AssertionError('not reached')
        source = Source()
        adapter = topology.select_native_topology(source, source, source, source, source, 'linux', 'aarch64')
        gate = topology.TopologyGate(authority(), adapter, supervisor=supervision())
        with self.assertRaises(topology.TopologyError): gate.admit()
        self.assertEqual(observed, [(True, True)] * len(topology.NATIVE_OBSERVATION_PATHS))
        self.assertEqual(owner.closes, len(topology.NATIVE_OBSERVATION_PATHS))
        self.assertFalse(gate.cleanup_uncertain)

    def test_v1_capture_pending_cleanup_is_visible_before_snapshot(self):
        for disposition in ('TIMEOUT', 'STOPPED'):
            with self.subTest(disposition=disposition):
                entered, release = threading.Event(), threading.Event()
                launches, handoffs = launches_and_handoffs()
                class CollectionKernel:
                    def __init__(self): self.spawned, self.stops, self.allowances = [], [], []
                    def spawn_waiting(self, launch, child):
                        owner = handoffs[len(self.spawned)]._owned
                        self.spawned.append(owner)
                        return owner
                    def inspect(self, pid):
                        return next(dict(h.attestation.__dict__) for h in handoffs if h.attestation.pid == pid)
                    def wait_owned(self, owner, deadline): raise AssertionError('not reached')
                    def stop_owned(self, owner, deadline):
                        self.stops.append(owner); self.allowances.append(deadline)
                        entered.set()
                        if not release.wait(2): raise AssertionError('stop not released')
                        return {'status': disposition, 'pid': owner.pid, 'run_id': RUN}
                kernel = CollectionKernel()
                collection = topology.Task8Collection(confinement.BootstrapConfig(kernel, RUN, launches[0].programs))
                roles = topology.Task8RoleSource(collection, topology._COMPOSITION_SEAL)
                content = kernel_proc({'/proc/net/tcp': TCP4_HEADER})
                class Observation:
                    def open_owned(self, path, flags):
                        class Owner:
                            def __init__(self): self.chunks = [content[path], b'']
                            def read(self, limit): return self.chunks.pop(0)
                            def close(self): pass
                            def cleanup(self): raise AssertionError('already closed')
                        return Owner()
                class Devices:
                    def observe(self, expected): return DEVICES
                class Probes:
                    def execute(self, identifier): raise topology.TopologyError('PROBE_DENIED')
                class Proxy:
                    def observe(self, policy): raise AssertionError('not reached')
                adapter = topology.select_native_topology(Observation(), roles, Devices(), Probes(), Proxy(), 'linux', 'aarch64')
                gate = topology.TopologyGate(authority(), adapter, supervisor=supervision())
                errors = []
                def admit():
                    try: gate.admit()
                    except Exception as error: errors.append(error)
                worker = threading.Thread(target=admit, daemon=True)
                worker.start()
                try:
                    self.assertTrue(entered.wait(1))
                    self.assertTrue(collection.cleanup_uncertain)
                    self.assertEqual(len(kernel.stops), 1)
                    for operation in (gate.topology_drifted, gate.admit, gate.require_current):
                        with self.assertRaises(topology.CleanupFailure) as caught: operation()
                        self.assertIs(caught.exception.cleanup, gate)
                        self.assertTrue(gate.cleanup_uncertain)
                        self.assertIn(collection, gate.unresolved_cleanup)
                    self.assertIs(collection.budget, gate._cleanup_budget)
                    self.assertIs(adapter._cleanup_budget, gate._cleanup_budget)
                    self.assertIn(adapter.capture_owner, gate._owners)
                    deadline = gate._cleanup_budget.deadline
                    self.assertEqual(len(kernel.stops), 1)
                finally:
                    release.set(); worker.join(2)
                self.assertFalse(worker.is_alive())
                self.assertEqual(kernel.stops, list(reversed(kernel.spawned)))
                self.assertTrue(all(0 < allowance <= 60000 for allowance in kernel.allowances))
                self.assertEqual(gate._cleanup_budget.deadline, deadline)
                self.assertEqual(len(errors), 1)
                self.assertEqual(gate.cleanup_uncertain, disposition == 'TIMEOUT')
                if disposition == 'TIMEOUT':
                    self.assertIs(errors[0].cleanup, gate)
                    with self.assertRaises(topology.CleanupFailure): gate.admit()
                    self.assertIn(collection, gate.unresolved_cleanup)

    def test_v1_ordinary_observation_close_failure_exports_original_owner(self):
        for primary_typed in (False, True):
            with self.subTest(primary_typed=primary_typed):
                entered, release = threading.Event(), threading.Event()
                primary_owner = object()
                primary = topology.CleanupFailure(primary_owner)
                class Owner:
                    def __init__(self): self.closes, self.cleanups = 0, 0
                    def read(self, limit):
                        if primary_typed: raise primary
                        return b''
                    def close(self):
                        self.closes += 1
                        raise OSError('inert uncertain close')
                    def cleanup(self):
                        self.cleanups += 1; entered.set()
                        if not release.wait(2): raise AssertionError('cleanup not released')
                        raise OSError('inert unresolved cleanup')
                owner = Owner()
                class Source:
                    def open_owned(self, path, flags): return owner
                    def collect(self, expected): raise AssertionError('not reached')
                    def observe(self, expected): raise AssertionError('not reached')
                    def execute(self, identifier): raise AssertionError('not reached')
                source = Source()
                adapter = topology.select_native_topology(source, source, source, source, source, 'linux', 'aarch64')
                gate = topology.TopologyGate(authority(), adapter, supervisor=supervision())
                with self.assertRaises(topology.TopologyError) as caught: gate.admit()
                self.assertIsInstance(caught.exception, topology.CleanupFailure)
                self.assertIs(caught.exception.cleanup, gate)
                self.assertIn(owner, gate.unresolved_cleanup)
                if primary_typed: self.assertIn(primary_owner, gate.unresolved_cleanup)
                self.assertEqual(adapter._unresolved, [owner])
                errors = []
                def cleanup():
                    try: adapter.cleanup_unresolved()
                    except Exception as error: errors.append(error)
                worker = threading.Thread(target=cleanup, daemon=True)
                worker.start()
                try:
                    self.assertTrue(entered.wait(1))
                    self.assertEqual(adapter._unresolved, [owner])
                    for operation in (gate.admit, gate.topology_drifted, adapter.cleanup_unresolved):
                        with self.assertRaises(topology.CleanupFailure): operation()
                    self.assertTrue(gate.cleanup_uncertain)
                    self.assertIn(owner, gate.unresolved_cleanup)
                    self.assertEqual((owner.closes, owner.cleanups), (1, 1))
                finally:
                    release.set(); worker.join(2)
                self.assertFalse(worker.is_alive())
                self.assertEqual(len(errors), 1)
                self.assertIs(errors[0].cleanup, owner)
                self.assertFalse(adapter._pending_observation_cleanup)
                with self.assertRaises(topology.CleanupFailure): gate.admit()
                self.assertTrue(gate.cleanup_uncertain)
                self.assertEqual((owner.closes, owner.cleanups), (1, 1))

    def test_local_n5_typed_cleanup_survives_native_source_boundaries(self):
        cleanup = object()
        failure = topology.CleanupFailure(cleanup)
        class Source:
            def beginOwned(self, *args): raise failure
            def observeAccepted(self, *args): raise failure
        source, policy = Source(), proxy_policy()
        supervisor = topology.select_native_supervisor(source, 'linux', 'aarch64')
        proxy_source = topology.select_task9_proxy_source(source, policy)
        def terminal_call():
            budget = topology.CleanupBudget(); budget.start_terminal()  # call() requires a started end (C1)
            return budget.call(lambda remaining: source.beginOwned())
        # The legacy Task8ProbeSource boundary was deleted with its catalogue (T10-4, P9).
        for operation in (lambda: supervisor.begin('wire', lambda: None),
                          lambda: proxy_source.observe(policy),
                          terminal_call):
            with self.subTest(operation=operation):
                with self.assertRaises(topology.TopologyError) as caught: operation()
                self.assertIs(caught.exception, failure)

    def test_local_n5_owned_observation_close_preserves_typed_cleanup(self):
        cleanup = object()
        failure = topology.CleanupFailure(cleanup)
        class Owner:
            def read(self, limit): return b''
            def close(self): raise failure
            def cleanup(self): pass
        owner = Owner()
        class Source:
            def open_owned(self, path, flags): return owner
            def collect(self, expected): raise AssertionError('not reached')
            def observe(self, expected): raise AssertionError('not reached')
            def execute(self, identifier): raise AssertionError('not reached')
        source = Source()
        adapter = topology.select_native_topology(source, source, source, source, source, 'linux', 'aarch64')
        gate = topology.TopologyGate(authority(), adapter, supervisor=supervision())
        with self.assertRaises(topology.TopologyError) as caught: gate.admit()
        self.assertIs(getattr(caught.exception, 'cleanup', None), gate)
        self.assertIn(cleanup, gate.unresolved_cleanup)
        self.assertEqual(adapter._unresolved, [owner])
        self.assertTrue(gate.cleanup_uncertain)

    def test_local_n3_pending_early_stop_cannot_retire_late_preparation(self):
        prepared, settle, entered, release = (threading.Event() for _ in range(4))
        class Preparation(Activation):
            live = False
            def prepare(self, handoff, proof):
                prepared.set(); settle.wait(2); self.live = True
                return super().prepare(handoff, proof)
            def stop_owned(self, deadline):
                self.cleaned += 1
                if self.cleaned == 1:
                    entered.set(); release.wait(2)
                else: self.live = False
                return {'status':'STOPPED','run_id':RUN}
        activation = Preparation()
        gate = native_gate()
        gate.admit(); errors = []
        def activate():
            try: gate.activate_browser(activation)
            except Exception as error: errors.append(error)
        activation_worker = threading.Thread(target=activate, daemon=True)
        drift_errors = []
        def drift():
            try: gate.topology_drifted()
            except Exception as error: drift_errors.append(error)
        drift_worker = threading.Thread(target=drift, daemon=True)
        activation_worker.start()
        try:
            self.assertTrue(prepared.wait(0.5)); drift_worker.start()
            self.assertTrue(entered.wait(0.5)); settle.set(); activation_worker.join(1)
            self.assertFalse(activation_worker.is_alive())
            self.assertTrue(gate.cleanup_uncertain)
            self.assertEqual(len(errors), 1)
            self.assertIs(getattr(errors[0], 'cleanup', None), gate)
        finally:
            settle.set(); release.set(); activation_worker.join(1)
            if drift_worker.ident is not None: drift_worker.join(1)
        self.assertEqual(drift_errors, [])
        self.assertEqual(activation.cleaned, 2)
        self.assertFalse(activation.live)
        self.assertFalse(gate.cleanup_uncertain)

    def test_local_n3_drift_during_preparation_recheck_prevents_prepare(self):
        class Preparation(Activation):
            prepared = 0
            def prepare(self, handoff, proof):
                self.prepared += 1
                return super().prepare(handoff, proof)
        activation = Preparation()
        class Recheck:
            fired = False
            def __call__(self):
                if activation in gate._owners and not self.fired:
                    self.fired = True
                    try: gate.topology_drifted()
                    except topology.CleanupFailure: pass
        recheck = Recheck()
        gate = native_gate(recheck=recheck)
        gate.admit()
        with self.assertRaises(topology.TopologyError): gate.activate_browser(activation)
        self.assertTrue(recheck.fired)
        self.assertEqual(activation.prepared, 0)
        self.assertFalse(gate.cleanup_uncertain)

    def test_local_n3_late_preparation_owner_is_compensated_after_early_stop(self):
        gate = native_gate()
        gate.admit()
        class Preparation(Activation):
            live = False
            def prepare(self, handoff, proof):
                try: gate.topology_drifted()
                except topology.CleanupFailure: pass
                self.live = True
                return super().prepare(handoff, proof)
            def stop_owned(self, deadline):
                self.live = False
                return super().stop_owned(deadline)
        activation = Preparation()
        with self.assertRaises(topology.TopologyError): gate.activate_browser(activation)
        self.assertFalse(activation.live)
        self.assertEqual(activation.cleaned, 2)
        self.assertFalse(gate.cleanup_uncertain)

    def test_local_n5_pending_gate_role_and_snapshot_cleanup_is_visible(self):
        for target, outcome in (('role', 'STOPPED'), ('role', 'TIMEOUT'), ('snapshot', 'STOPPED')):
            with self.subTest(target=target, outcome=outcome):
                entered, release = threading.Event(), threading.Event()
                class Pending(Activation):
                    def stop_owned(self, deadline):
                        entered.set(); release.wait(1)
                        return {'status':outcome, 'run_id':RUN}
                bindings, sources = native_bindings()
                def cleanup_owned(handoffs):
                    # Only the gate's snapshot cleanup: no owner stop is pending then.
                    if target == 'snapshot' and gate._pending_snapshots and not gate._pending_stops:
                        entered.set(); release.wait(1)
                sources.roles.cleanup_owned = cleanup_owned
                gate = topology.TopologyGate(authority(), bindings, supervisor=supervision())
                gate.admit()
                gate.activate_browser(Pending() if target == 'role' else Activation())
                errors = []
                def drift():
                    try: gate.topology_drifted()
                    except Exception as error: errors.append(error)
                worker = threading.Thread(target=drift, daemon=True); worker.start()
                try:
                    self.assertTrue(entered.wait(0.5))
                    self.assertTrue(gate.cleanup_uncertain)
                    for operation in (gate.topology_drifted, gate.admit, gate.require_current):
                        with self.assertRaises(topology.CleanupFailure) as caught: operation()
                        self.assertIs(caught.exception.cleanup, gate)
                finally: release.set(); worker.join(1)
                self.assertFalse(worker.is_alive())
                if outcome == 'TIMEOUT':
                    self.assertEqual(len(errors), 1)
                    self.assertIs(getattr(errors[0], 'cleanup', None), gate)
                    self.assertTrue(gate.cleanup_uncertain)
                    with self.assertRaises(topology.CleanupFailure): gate.topology_drifted()
                else:
                    self.assertEqual(errors, [])
                    self.assertFalse(gate.cleanup_uncertain)

    def test_local_n5_native_capture_preserves_actual_collection_cleanup_authority(self):
        for failure_at in ('device', 'probe', 'proxy', 'typed-probe'):
            with self.subTest(failure_at=failure_at):
                probe_cleanup = object()
                launches, handoffs = launches_and_handoffs()
                class CollectionKernel:
                    def __init__(self): self.spawned, self.stops = [], []
                    def spawn_waiting(self, launch, child):
                        owner = handoffs[len(self.spawned)]._owned
                        self.spawned.append(owner); return owner
                    def inspect(self, pid):
                        return next(dict(h.attestation.__dict__) for h in handoffs if h.attestation.pid == pid)
                    def wait_owned(self, owner, deadline): raise AssertionError('not used')
                    def stop_owned(self, owner, deadline):
                        self.stops.append(owner)
                        return {'status':'TIMEOUT', 'pid':owner.pid, 'run_id':RUN}
                kernel = CollectionKernel()
                collection = topology.Task8Collection(confinement.BootstrapConfig(kernel, RUN, launches[0].programs))
                roles = topology.Task8RoleSource(collection, topology._COMPOSITION_SEAL)
                content = kernel_proc({'/proc/net/tcp': TCP4_HEADER})
                class Observation:
                    def open_owned(self, path, flags):
                        class Owner:
                            def __init__(self): self.chunks = [content[path], b'']
                            def read(self, limit): return self.chunks.pop(0)
                            def close(self): pass
                            def cleanup(self): pass
                        return Owner()
                class Devices:
                    def observe(self, expected):
                        if failure_at == 'device': raise RuntimeError('inert device failure')
                        return DEVICES
                class Probes:
                    def execute(self, identifier):
                        if failure_at == 'typed-probe': raise topology.CleanupFailure(probe_cleanup)
                        if failure_at == 'probe': raise topology.TopologyError('PROBE_DENIED')
                        return result(identifier)
                class Proxy:
                    def observe(self, policy): raise topology.TopologyError('PROXY_DENIED')
                adapter = topology.select_native_topology(Observation(), roles, Devices(), Probes(), Proxy(), 'linux', 'aarch64')
                gate = topology.TopologyGate(authority(), adapter, supervisor=supervision())
                for operation in (gate.admit, gate.admit, gate.topology_drifted):
                    with self.assertRaises(topology.CleanupFailure) as caught: operation()
                    self.assertIs(caught.exception.cleanup, gate)
                    self.assertTrue(gate.cleanup_uncertain)
                    self.assertIn(collection, gate.unresolved_cleanup)
                    if failure_at == 'typed-probe': self.assertIn(probe_cleanup, gate.unresolved_cleanup)
                self.assertEqual(kernel.stops, list(reversed(kernel.spawned)))
                self.assertEqual(collection.unresolved_owners, list(reversed(kernel.spawned)))

    def test_round4_async_roleport_is_unavailable_before_any_effect(self):
        clock = Clock()
        class Port:
            effects = 0
            async def activateOnce(self, grant):
                clock.samples[:] = [(190, 10010)]
                self.effects += 1
                return object()
        port = Port()
        transaction = topology.Task10RoleTransaction(port, object(), snapshot().role_handoffs[1])
        with self.assertRaises((topology.TopologyError, topology.ActivationFailure)):
            transaction.activate(lambda: None)
        self.assertEqual(port.effects, 0)

    def test_round4_post_authorization_expiry_compensates_and_never_succeeds(self):
        clock = Clock()
        gate = native_gate(clock=clock)
        gate.admit()
        activation = Activation(callback=lambda: clock.samples.append((190, 10010)))
        with self.assertRaises(topology.TopologyError): gate.activate_browser(activation)
        self.assertEqual(activation.cleaned, 1)
        self.assertTrue(gate._failed)

    def test_round4_duplicate_activation_cleans_role_and_monitor(self):
        monitor = Activation()
        monitor.begin = lambda wire, callback: monitor
        gate = native_gate(supervisor=monitor)
        gate.admit(); activation = Activation(); gate.activate_browser(activation)
        with self.assertRaises(topology.TopologyError): gate.activate_browser(activation)
        self.assertEqual((activation.cleaned, monitor.cleaned), (1, 1))

    def test_round4_prepare_throw_retains_preparation_owner(self):
        class PrepareFailure(Activation):
            def prepare(self, handoff, proof): raise RuntimeError('inert prepare')
            def stop_owned(self, deadline):
                self.cleaned += 1
                return {'status':'TIMEOUT','run_id':RUN}
        gate = native_gate()
        gate.admit(); activation = PrepareFailure()
        with self.assertRaises(topology.TopologyError) as caught: gate.activate_browser(activation)
        self.assertEqual(activation.cleaned, 1)
        self.assertTrue(gate.cleanup_uncertain)
        self.assertIs(getattr(caught.exception, 'cleanup', None), gate)

    def test_round4_late_owner_is_compensated_after_pending_fallback(self):
        gate = native_gate()
        gate.admit()
        class Late(Activation):
            late = False
            late_stops = 0
            def activate(self, authorize):
                authorize()
                try: gate.topology_drifted()
                except topology.TopologyError: pass
                self.late = True
            def stop_owned(self, deadline):
                if self.late: self.late_stops += 1
                self.cleaned += 1
                return {'status':'STOPPED' if self.late else 'TIMEOUT','run_id':RUN}
        activation = Late()
        with self.assertRaises(topology.TopologyError) as caught: gate.activate_browser(activation)
        self.assertEqual((activation.cleaned, activation.late_stops), (2, 1))
        self.assertIs(getattr(caught.exception, 'cleanup', None), gate)

    def test_round4_collection_uncertainty_remains_truthful_and_budget_is_shared(self):
        launches, handoffs = launches_and_handoffs()
        clock = Clock()
        class CollectionKernel:
            def __init__(self): self.spawned, self.stops = [], []
            def spawn_waiting(self, launch, child):
                owner = handoffs[len(self.spawned)]._owned
                self.spawned.append(owner); return owner
            def inspect(self, pid):
                return next(dict(h.attestation.__dict__) for h in handoffs if h.attestation.pid == pid)
            def wait_owned(self, owned, deadline): raise AssertionError('not used')
            def stop_owned(self, owned, deadline):
                self.stops.append((owned, deadline))
                clock.last = (100, clock.last[1] + 20000)
                return {'status':'TIMEOUT','pid':owned.pid,'run_id':RUN}
        kernel = CollectionKernel()
        collection = topology.Task8Collection(confinement.BootstrapConfig(kernel, RUN, launches[0].programs))
        source = topology.Task8RoleSource(collection, topology._COMPOSITION_SEAL)
        owned = source.collect(authority(clock=clock))
        for _ in range(2):
            with self.assertRaisesRegex(topology.TopologyError, '^CLEANUP_UNCERTAIN$'):
                collection.cleanupOwned(owned)
        self.assertLessEqual(len(kernel.stops), 3)
        self.assertTrue(all(0 < bound <= 60000 - 20000 * index
                            for index, (_, bound) in enumerate(kernel.stops)))
        self.assertEqual({id(h._owned) for h in owned}, {id(h._owned) for h in collection.handoffs})

    def test_round4_collection_failure_keeps_uncertainty_in_gate_on_every_call(self):
        launches, handoffs = launches_and_handoffs()
        class CollectionKernel:
            def __init__(self): self.spawned, self.stopped = [], []
            def spawn_waiting(self, launch, child):
                owner = handoffs[len(self.spawned)]._owned
                self.spawned.append(owner); return owner
            def inspect(self, pid):
                return next(dict(h.attestation.__dict__) for h in handoffs if h.attestation.pid == pid)
            def wait_owned(self, owner, deadline): raise AssertionError('not used')
            def stop_owned(self, owner, deadline):
                self.stopped.append(owner)
                raise RuntimeError('inert cleanup uncertainty')
        kernel = CollectionKernel()
        collection = topology.Task8Collection(confinement.BootstrapConfig(kernel, RUN, launches[0].programs))
        source = topology.Task8RoleSource(collection, topology._COMPOSITION_SEAL)
        expected = authority()
        _, sources = native_bindings()
        bindings = topology.select_native_topology(ProcPort(), source, sources.devices,
            sources.probes, sources.proxy, 'linux', 'aarch64')
        gate = topology.TopologyGate(expected, bindings, supervisor=supervision())
        owned = source.collect(expected)
        owned[0]._owned.command = object()
        for _ in range(2):
            with self.assertRaisesRegex(topology.TopologyError, '^CLEANUP_UNCERTAIN$'):
                gate.admit()
        self.assertTrue(gate.cleanup_uncertain)
        self.assertIs(gate.unresolved_cleanup[0], collection)
        self.assertEqual({id(owner) for owner in collection.unresolved_owners},
                         {id(h._owned) for h in owned})
        self.assertEqual(len(kernel.stopped), 4)

    def test_round4_concurrent_collection_cleanup_cannot_report_pending_as_success(self):
        entered, release = threading.Event(), threading.Event()
        launches, handoffs = launches_and_handoffs()
        class WaitingKernel:
            def stop_owned(self, owner, deadline):
                entered.set(); release.wait(1)
                return {'status':'STOPPED','pid':owner.pid,'run_id':RUN}
        kernel = WaitingKernel()
        collection = topology.Task8Collection(confinement.BootstrapConfig(kernel, RUN, launches[0].programs))
        owned = tuple(dataclasses.replace(h, _kernel=kernel) for h in handoffs)
        collection.handoffs = owned
        worker = threading.Thread(target=lambda: collection.cleanupOwned(owned), daemon=True)
        worker.start()
        try:
            self.assertTrue(entered.wait(0.2))
            with self.assertRaisesRegex(topology.TopologyError, '^CLEANUP_UNCERTAIN$'):
                collection.cleanupOwned(owned)
        finally: release.set(); worker.join(1)
        self.assertEqual(len(collection.proven_owners), 4)

    def test_round4_unbound_proxy_transport_cannot_attest_a_running_instance(self):
        policy = dataclasses.replace(proxy_policy(), handoff_validator=lambda *args: True)
        class Endpoint:
            def getsockname(self): return ('127.0.0.1', 3128)
        module, selectors = object(), object()
        sockets = proxy.NativeSockets(module, selectors, stop_fd=3, os_module=object())
        sockets.listener = proxy.NativeListener(Endpoint(), module); sockets.listener_closed = False
        transport = proxy.NativeVsockTransport(module, selectors, policy.binding, 2, 4050)
        transport.claim()
        config = proxy.ProxyConfig(dict(policy.destinations), policy.binding,
            policy.aggregate_bytes, policy.idle_timeout_ms, policy.run_timeout_ms, Clock(), sockets,
            native_admission=proxy.NativeAdmission(policy.runtime_identity, policy.role_policy_identity))
        observer = topology.Task9RuntimeObserver(config, sockets, transport)
        with self.assertRaisesRegex(topology.TopologyError, '^PROXY_RUNTIME_UNAVAILABLE$'):
            observer.observeAccepted(policy)

    def test_round4_never_finishing_cleanup_returns_at_shared_deadline(self):
        clock, release, completed = Clock(), threading.Event(), threading.Event()
        class Waiting(Activation):
            def stop_owned(self, deadline):
                self.cleaned += 1; clock.last = (100, 60010)
                release.wait(1)
                return {'status':'STOPPED','run_id':RUN}
        gate = native_gate(clock=clock)
        gate.admit(); activation = Waiting(); gate.activate_browser(activation)
        def drift():
            try: gate.topology_drifted()
            except topology.TopologyError: pass
            finally: completed.set()
        worker = threading.Thread(target=drift, daemon=True); worker.start()
        try: self.assertTrue(completed.wait(0.2), 'cleanup exceeded exhausted shared deadline')
        finally: release.set(); worker.join(1)
        self.assertTrue(gate.cleanup_uncertain)

    def test_round4_proxy_owner_mismatch_and_substitution_are_denied(self):
        policy = dataclasses.replace(proxy_policy(), handoff_validator=lambda *args: True)
        class Endpoint:
            def getsockname(self): return ('127.0.0.1', 3128)
        module, selectors = object(), object()
        sockets = proxy.NativeSockets(module, selectors, stop_fd=3, os_module=object())
        sockets.listener = proxy.NativeListener(Endpoint(), module); sockets.listener_closed = False
        transport = proxy.NativeVsockTransport(module, selectors, policy.binding, 2, 4050)
        transport.claim()
        config = proxy.ProxyConfig(dict(policy.destinations), policy.binding,
            policy.aggregate_bytes, policy.idle_timeout_ms, policy.run_timeout_ms, Clock(), object(),
            native_admission=proxy.NativeAdmission(policy.runtime_identity, policy.role_policy_identity))
        with self.assertRaisesRegex(topology.TopologyError, '^PROXY_DENIED$'):
            topology.Task9RuntimeObserver(config, sockets, transport)
        config.sockets = sockets
        observer = topology.Task9RuntimeObserver(config, sockets, transport)
        with self.assertRaisesRegex(topology.TopologyError, '^PROXY_RUNTIME_UNAVAILABLE$'):
            observer.observeAccepted(policy)
        for target, name, value in ((config, 'sockets', object()),
                                    (transport, 'binding', dataclasses.replace(policy.binding)),
                                    (transport, 'module', object())):
            old = getattr(target, name); setattr(target, name, value)
            try:
                with self.assertRaisesRegex(topology.TopologyError, '^PROXY_DENIED$'):
                    observer.observeAccepted(policy)
            finally: setattr(target, name, old)

    def test_actual_task8_collection_retains_identity_endpoints_and_original_cleanup(self):
        launches, handoffs = launches_and_handoffs()
        class CollectionKernel:
            def __init__(self): self.spawned, self.stopped = [], []
            def spawn_waiting(self, launch, child):
                owned = handoffs[len(self.spawned)]._owned
                self.spawned.append(owned); return owned
            def inspect(self, pid):
                return next(dict(h.attestation.__dict__) for h in handoffs if h.attestation.pid == pid)
            def wait_owned(self, owned, deadline): raise AssertionError('not needed')
            def stop_owned(self, owned, deadline):
                self.stopped.append((owned, deadline))
                return {'status':'STOPPED','pid':owned.pid,'run_id':RUN}
        kernel = CollectionKernel()
        collection = topology.Task8Collection(confinement.BootstrapConfig(kernel, RUN, launches[0].programs))
        original = collection.collectOwned(launches)
        self.assertEqual(len(kernel.spawned), 4)
        self.assertIs(collection.collectOwned(launches), original)
        original[0]._owned.command = object()
        with self.assertRaises(topology.TopologyError): collection.collectOwned(launches)
        self.assertEqual(len(kernel.stopped), 4)
        self.assertEqual({id(item[0]) for item in kernel.stopped}, {id(h._owned) for h in original})
        collection.cleanupOwned(original)
        self.assertEqual(len(kernel.stopped), 4)

    def test_async_roleport_is_never_entered_without_accepted_effect_authority(self):
        browser = snapshot().role_handoffs[1]
        class Cleanup:
            def __init__(self): self.calls = []
            async def stopOwned(self, deadline):
                self.calls.append(deadline); return {'status':'STOPPED','runId':RUN}
            async def waitExit(self, deadline): return {'status':'TIMEOUT','runId':RUN}
        cleanup = Cleanup()
        class Port:
            async def activateOnce(self, grant):
                self.grant = grant
                raise topology.ActivationFailure('CLEANUP_UNCERTAIN', cleanup)
        port, grant = Port(), object()
        transaction = topology.Task10RoleTransaction(port, grant, browser)
        with self.assertRaisesRegex(topology.TopologyError, '^ACTIVATION_UNAVAILABLE$'):
            transaction.activate(lambda: None)
        self.assertFalse(hasattr(port, 'grant'))
        self.assertEqual(cleanup.calls, [])

    def test_concrete_task9_observer_rechecks_actual_owned_listener_and_transport(self):
        policy = dataclasses.replace(proxy_policy(), handoff_validator=lambda *args: args == ('PROXY',10004,3,4))
        class Endpoint:
            def getsockname(self): return ('127.0.0.1',3128)
        endpoint = Endpoint()
        module, selectors = object(), object()
        sockets = proxy.NativeSockets(module, selectors, stop_fd=3, os_module=object())
        sockets.listener = proxy.NativeListener(endpoint, module)
        sockets.listener_closed = False
        transport = proxy.NativeVsockTransport(module, selectors, policy.binding, 2, 4050)
        transport.claim()
        config = proxy.ProxyConfig(dict(policy.destinations), policy.binding,
            policy.aggregate_bytes, policy.idle_timeout_ms, policy.run_timeout_ms,
            Clock(), sockets, native_admission=proxy.NativeAdmission(policy.runtime_identity,policy.role_policy_identity))
        observer = topology.Task9RuntimeObserver(config, sockets, transport)
        source = topology.select_task9_proxy_source(observer, policy)
        with self.assertRaises(topology.TopologyError): source.observe(policy)
        module = load('task10_composition_probe_contract', 'tests/guest/confinement_probe.py')
        class NoEffects:
            calls = 0
            def open_owned(self, *args): self.calls += 1; raise AssertionError('not executed')
            def observe(self, *args): self.calls += 1; raise AssertionError('not executed')
            def run_confined(self, *args): self.calls += 1; raise AssertionError('not executed')
            def subscribe_fixed(self, *args): self.calls += 1; raise AssertionError('not executed')
        boundary = NoEffects()
        a = dataclasses.replace(authority(), proxy_policy=policy)
        collection = topology.Task8Collection(confinement.BootstrapConfig(
            Kernel(), RUN, a.role_launches[0].programs))
        with self.assertRaisesRegex(topology.TopologyError, '^COMPOSITION_UNAVAILABLE$'):
            topology.compose_task10(mode='bootstrap-check', expected=a,
                observations=boundary, collection=collection, host_devices=boundary,
                probe_module=module, probe_port=module.NativeProbePort(boundary),
                proxy_runtime=observer, service_events=boundary,
                platform_name='linux', machine='aarch64')
        self.assertIsNone(collection.handoffs)
        self.assertEqual(boundary.calls, 0)
        sockets.listener.socket = Endpoint()
        with self.assertRaisesRegex(topology.TopologyError, '^PROXY_DENIED$'):
            observer.observeAccepted(policy)

    def test_fixed_policy_cannot_be_relaxed(self):
        a = authority()
        self.assertEqual(a.host_devices, DEVICES)
        self.assertEqual(a.role_uids, tuple(confinement.UIDS.items()))
        self.assertEqual(a.probe_ids, PROBES)
        for change in (
            {'host_devices': ('LINUX_BOOT',)},
            {'role_handoffs': tuple(dataclasses.replace(
                h, attestation=dataclasses.replace(h.attestation,
                    uids=(20002,) * 3)) if h.launch.role == 'BROWSER' else h
                for h in snapshot().role_handoffs)},
            {'probes': (result('BROWSER_IPV4_TCP'),)},
            {'listeners': (topology.Listener('GUEST', 'TCP', '127.0.0.1', 3128, 10003),)},
        ):
            with self.subTest(change=change), self.assertRaises(topology.TopologyError):
                topology.admit_topology(snapshot(**change), a, (100, 10), (100, 10))

    def test_task9_proxy_source_requires_and_forwards_sealed_policy(self):
        policy = proxy_policy()
        class Observer:
            def __init__(self): self.seen = []
            def observeAccepted(self, value):
                self.seen.append(value)
                return snapshot().proxy_runtime
        observer = Observer(); source = topology.select_task9_proxy_source(observer, policy)
        self.assertEqual(source.observe(policy), snapshot().proxy_runtime)
        self.assertEqual(observer.seen, [policy])
        with self.assertRaises(topology.TopologyError): source.observe(proxy_policy())

    def test_task8_attestation_is_revalidated_without_projection_loss(self):
        a = authority()
        proof = topology.admit_topology(snapshot(), a, (100, 10), (100, 10))
        payload = json.loads(proof.canonical)
        browser = next(row for row in payload['roles'] if row['role'] == 'BROWSER')
        self.assertEqual(browser['uids'], [10002, 10002, 10002])
        self.assertEqual(browser['capabilities'], [0, 0, 0, 0, 0])
        self.assertEqual(browser['fds'][3]['purpose'], 'command')
        self.assertEqual(browser['views']['root'], '/run/acceptance/browser')
        self.assertGreater(len(browser['programs']), 1)
        handoffs = snapshot().role_handoffs
        browser_handoff = next(h for h in handoffs if h.launch.role == 'BROWSER')
        mutations = (
            dataclasses.replace(browser_handoff.attestation, gids=(10002, 10002, 0)),
            dataclasses.replace(browser_handoff.attestation, capabilities=(1, 0, 0, 0, 0)),
            dataclasses.replace(browser_handoff.attestation, filter_digest='0' * 64),
            dataclasses.replace(browser_handoff.attestation,
                                views=dataclasses.replace(browser_handoff.attestation.views, console=True)),
            dataclasses.replace(browser_handoff.attestation,
                                fds=browser_handoff.attestation.fds[:-1]),
            dataclasses.replace(browser_handoff.attestation,
                                programs=browser_handoff.attestation.programs[:-1]),
        )
        for changed in mutations:
            replacement = dataclasses.replace(browser_handoff, attestation=changed)
            roles = tuple(replacement if h.launch.role == 'BROWSER' else h for h in handoffs)
            with self.subTest(changed=changed), self.assertRaises(topology.TopologyError):
                topology.admit_topology(snapshot(role_handoffs=roles), a, (100, 10), (100, 10))

    def test_complete_authenticated_handoff_rejects_substitution(self):
        a = authority()
        proof = topology.admit_topology(snapshot(), a, (100, 10), (100, 10))
        decoded = topology.verify_handoff(proof.handoff, a)
        self.assertEqual(decoded['runId'], RUN)
        self.assertEqual(decoded['devices']['routes'], [])
        wire = json.loads(proof.handoff)
        wire['payload']['devices']['dnsServers'] = ['127.0.0.53']
        with self.assertRaisesRegex(topology.TopologyError, '^HANDOFF_DENIED$'):
            topology.verify_handoff(json.dumps(wire, sort_keys=True,
                                               separators=(',', ':')), a)

    def test_handoff_schema_and_valid_mac_semantic_substitutions_fail(self):
        a = authority()
        original = json.loads(topology.admit_topology(
            snapshot(), a, (100, 10), (100, 10)).handoff)

        def signed(mutate):
            wire = json.loads(json.dumps(original))
            mutate(wire)
            wire['mac'] = __import__('hmac').new(
                admission_key(), json.dumps(wire['payload'], sort_keys=True,
                                       separators=(',', ':')).encode('ascii'),
                __import__('hashlib').sha256).hexdigest()
            return json.dumps(wire, sort_keys=True, separators=(',', ':'))

        mutations = (
            lambda w: w.__setitem__('version', True),
            lambda w: w['payload']['roles'][0]['uids'].__setitem__(0, 10002),
            lambda w: w['payload']['roles'][0]['programs'][0].__setitem__('sha256', 'f' * 64),
            lambda w: w['payload']['probes'][0].__setitem__('outcome', 'ALLOWED'),
            lambda w: w['payload']['devices'].__setitem__('unexpected', []),
            lambda w: w['payload'].__setitem__('sequence', True),
            lambda w: w['payload']['roles'][0]['capabilities'].__setitem__(0, False),
            lambda w: w['payload']['roles'][0]['fds'][1].__setitem__('fd', True),
            lambda w: w['payload']['roles'][0]['views'].__setitem__('separatePid', 1),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate), self.assertRaisesRegex(
                    topology.TopologyError, '^HANDOFF_DENIED$'):
                topology.verify_handoff(signed(mutate), a)
        duplicate = original.copy()
        duplicate_wire = ('{"mac":"%s","payload":%s,"version":1,"version":1}' %
                          (duplicate['mac'], json.dumps(duplicate['payload'], sort_keys=True,
                                                       separators=(',', ':'))))
        with self.assertRaisesRegex(topology.TopologyError, '^HANDOFF_DENIED$'):
            topology.verify_handoff(duplicate_wire, a)

    def test_bad_first_admission_malformed_and_exception_latch(self):
        for name, values, content in (
                ('default-v4', None, kernel_proc({'/proc/net/route': ROUTE4_HEADER + DEFAULT_ROUTE4_ROW})),
                ('malformed', [dataclasses.replace(snapshot(), role_handoffs=object()), snapshot()], None),
                ('exception', [RuntimeError('capture'), snapshot()], None)):
            gate = native_gate(values, content=content, clock=Clock((100, 10), (100, 10)))
            with self.subTest(bad=name), self.assertRaises(topology.TopologyError): gate.admit()
            with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_FAILED$'): gate.admit()

    def test_strict_numeric_and_container_types_latch(self):
        base = snapshot()
        browser = next(h for h in base.role_handoffs if h.launch.role == 'BROWSER')
        malformed_role = dataclasses.replace(browser, attestation=dataclasses.replace(
            browser.attestation, no_new_privs=True))
        mutations = (
            dataclasses.replace(base, observed_wall=True),
            dataclasses.replace(base, listeners=(topology.Listener('GUEST', 'TCP', '127.0.0.1', 3128.0, 10004),)),
            dataclasses.replace(base, probes=(dataclasses.replace(base.probes[0], owned_receiver_count=False),) + base.probes[1:]),
            dataclasses.replace(base, role_handoffs=tuple(malformed_role if h.launch.role == 'BROWSER' else h for h in base.role_handoffs)),
            dataclasses.replace(base, routes=[]),
        )
        for bad in mutations:
            with self.subTest(bad=bad), self.assertRaises(topology.TopologyError):
                topology.admit_topology(bad, authority(), (100, 10), (100, 10))
        for bad in mutations[2:4]:  # reportable by the native probe and role sources
            gate = native_gate([bad], clock=Clock((100, 10), (100, 10)))
            with self.subTest(bad=bad), self.assertRaises(topology.TopologyError): gate.admit()
            with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_FAILED$'): gate.require_current()

    def test_clock_freshness_sequence_recheck_and_expiry_latch(self):
        recheck = Recheck()
        clock = Clock(*([(100, 10)] * 13), (190, 12))
        gate = native_gate(clock=clock, recheck=recheck)
        gate.admit()
        gate.require_current()
        self.assertGreaterEqual(recheck.calls, 4)
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_EXPIRED$'):
            gate.require_current()
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_FAILED$'):
            gate.require_current()

    def test_clock_rollback_or_stale_observation_latches(self):
        for samples in (
            ((100, 10), (99, 11)),
            ((100, 10), (100, 10), (98, 8), (100, 10)),
        ):
            gate = native_gate(clock=Clock(*samples))
            with self.assertRaises(topology.TopologyError): gate.admit()
            with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_FAILED$'): gate.require_current()

    def test_one_use_browser_activation_uses_task8_handoff(self):
        gate = native_gate(clock=Clock((100, 10), (100, 10), (100, 10), (100, 10)))
        gate.admit(); activation = Activation()
        gate.activate_browser(activation)
        self.assertEqual(activation.calls[0][0].launch.role, 'BROWSER')
        with self.assertRaisesRegex(topology.TopologyError, '^ACTIVATION_DENIED$'):
            gate.activate_browser(activation)

    def test_duplicate_admission_and_drift_during_capture_latch(self):
        gate = native_gate(clock=Clock(*([(100, 10)] * 8)))
        gate.admit()
        with self.assertRaises(topology.TopologyError): gate.admit()
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_FAILED$'):
            gate.require_current()

        bindings, sources = native_bindings()
        execute = sources.probes.execute
        def drifting(identifier):
            # Drift while the native capture is still running its probes.
            gate.topology_drifted()
            return execute(identifier)
        sources.probes.execute = drifting
        gate = topology.TopologyGate(authority(clock=Clock(*([(100, 10)] * 8))), bindings,
                                     supervisor=supervision())
        with self.assertRaises(topology.TopologyError): gate.admit()
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_FAILED$'): gate.require_current()

    def test_reentrant_activation_calls_effect_once_and_compensates(self):
        gate = native_gate(clock=Clock(*([(100, 10)] * 16)))
        gate.admit()
        activation = Activation(callback=lambda: self.assertRaises(
            topology.TopologyError, gate.activate_browser, activation))
        with self.assertRaises(topology.TopologyError): gate.activate_browser(activation)
        self.assertEqual(len(activation.calls), 1)
        self.assertEqual(activation.cleaned, 2)

    def test_monotonic_deadline_and_expiry_during_final_recheck_latch(self):
        gate = native_gate(clock=Clock((100, 10), (100, 1000000)))
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_EXPIRED$'): gate.admit()

    def test_deadline_expiry_inside_validation_and_authorize_denies_without_effect(self):
        clock = Clock(*([(100, 10)] * 20))
        gate = native_gate(clock=clock)
        gate.admit()
        original = topology.admit_topology
        def expiring(*args):
            value = original(*args); clock.samples[:] = [(190, 10010)]; return value
        topology.admit_topology = expiring
        try:
            with self.assertRaises(topology.TopologyError): gate.require_current()
        finally:
            topology.admit_topology = original
        self.assertTrue(gate._failed)

        clock = Clock(*([(100, 10)] * 20))
        gate = native_gate(clock=clock)
        gate.admit()
        class Delayed(Activation):
            def activate(self, authorize):
                clock.samples[:] = [(190, 10010)]
                return super().activate(authorize)
        delayed = Delayed()
        with self.assertRaises(topology.TopologyError): gate.activate_browser(delayed)
        self.assertEqual((len(delayed.calls), delayed.cleaned), (0, 1))
        class ExpiringRecheck:
            def __init__(self, clock): self.clock, self.calls = clock, 0
            def __call__(self):
                self.calls += 1
                if self.calls == 2: self.clock.samples[:] = [(190, 12)]
        clock = Clock((100, 10), (100, 10), (100, 10))
        gate = native_gate(clock=clock, recheck=ExpiringRecheck(clock))
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_EXPIRED$'): gate.admit()

    def test_duplicate_role_process_and_owned_identity_are_denied(self):
        base = snapshot()
        first, second = base.role_handoffs[:2]
        duplicate_pid = dataclasses.replace(second, attestation=dataclasses.replace(
            second.attestation, pid=first.attestation.pid),
            _owned=Owned(first.attestation.pid, RUN, second.launch.role))
        for roles in (
            (first, duplicate_pid) + base.role_handoffs[2:],
            (first, dataclasses.replace(second, _owned=first._owned)) + base.role_handoffs[2:],
        ):
            with self.subTest(), self.assertRaises(topology.TopologyError):
                topology.admit_topology(dataclasses.replace(base, role_handoffs=roles),
                                        authority(), (100, 10), (100, 10))

        shared_identity, shared_endpoint = object(), object()
        first._owned.identity = shared_identity; second._owned.identity = shared_identity
        with self.assertRaises(topology.TopologyError):
            topology.admit_topology(base, authority(), (100, 10), (100, 10))
        first._owned.identity, second._owned.identity = object(), object()
        first._owned.command = shared_endpoint; second._owned.result = shared_endpoint
        with self.assertRaises(topology.TopologyError):
            topology.admit_topology(base, authority(), (100, 10), (100, 10))
        first._owned.command, second._owned.result = object(), object()
        first._owned.result = first._owned.command
        with self.assertRaises(topology.TopologyError):
            topology.admit_topology(base, authority(), (100, 10), (100, 10))

    def test_supervised_final_drift_and_ordinary_failure_cleanup_before_return(self):
        class Supervisor:
            def __init__(self): self.stops = 0; self.callback = None
            def begin(self, handoff, callback): self.callback = callback; return self
            def stop_owned(self, deadline):
                self.stops += 1; return {'status':'STOPPED','run_id':RUN}
        supervisor = Supervisor()
        class Recheck:
            calls = 0
            def __call__(self):
                self.calls += 1
                if self.calls == 3: supervisor.callback()
        gate = native_gate(recheck=Recheck(), supervisor=supervisor)
        with self.assertRaises(topology.TopologyError): gate.admit()
        self.assertEqual(supervisor.stops, 1)
        supervisor = Supervisor()
        gate = native_gate([snapshot(), RuntimeError('capture')], supervisor=supervisor)
        gate.admit()
        with self.assertRaises(topology.TopologyError): gate.require_current()
        self.assertEqual(supervisor.stops, 1)

    def test_partial_and_post_success_activation_cleanup_is_retained(self):
        class Partial(Activation):
            def activate(self, authorize):
                authorize(); self.calls.append(self.pending)
                raise topology.ActivationFailure('CLEANUP_UNCERTAIN', self)
        gate = native_gate(clock=Clock(*([(100, 10)] * 30)))
        gate.admit(); partial = Partial()
        with self.assertRaises(topology.TopologyError): gate.activate_browser(partial)
        self.assertEqual((len(partial.calls), partial.cleaned), (1, 1))

        supervisor = type('Supervisor', (), {
            'begin': lambda self, wire, callback: setattr(self, 'callback', callback) or self,
            'stop_owned': lambda self, deadline: {'status':'STOPPED','run_id':RUN},
        })()
        gate = native_gate(clock=Clock(*([(100, 10)] * 30)), supervisor=supervisor)
        gate.admit(); activation = Activation(); gate.activate_browser(activation)
        supervisor.callback()
        self.assertEqual(activation.cleaned, 1)

    def test_native_adapter_is_explicit_bounded_and_closes_owned_fds(self):
        content = kernel_proc({'/etc/resolv.conf': b'  # none\n'})
        class Owner:
            def __init__(self, parent, path):
                self.parent, self.path = parent, path
                data = content[path]; self.chunks = [data[:11], data[11:], b'']
            def read(self, limit): return self.chunks.pop(0)
            def close(self): self.parent.closed.append(self.path)
            def cleanup(self): self.parent.cleaned.append(self.path)
        class OS:
            def __init__(self): self.opened, self.closed, self.cleaned = [], [], []
            def open_owned(self, path, flags): self.opened.append((path, flags)); return Owner(self, path)
        class Roles:
            def collect(self, expected): return snapshot().role_handoffs
        class Devices:
            def observe(self, expected): return DEVICES
        class Probes:
            def execute(self, identifier): return result(identifier)
        class Proxy:
            def observe(self, policy): return snapshot().proxy_runtime
        os_port = OS(); a = authority()
        bindings = topology.select_native_topology(
            os_port, Roles(), Devices(), Probes(), Proxy(), 'linux', 'aarch64')
        observed = bindings.capture(1, a)
        self.assertEqual(observed.interfaces, ('lo',))
        self.assertEqual(tuple(os_port.closed), topology.NATIVE_OBSERVATION_PATHS)
        self.assertEqual(tuple(path for path, _ in os_port.opened), topology.NATIVE_OBSERVATION_PATHS)
        with self.assertRaises(topology.TopologyError):
            topology.select_native_topology(os_port, Roles(), Devices(), Probes(), Proxy(),
                                            'darwin', 'arm64')

    def test_native_parser_detects_late_rows_dns_malformed_and_allows_established(self):
        header = b'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'
        late = (header +
                b'0: 0100007F:D000 0100007F:0C38 01 00000000:00000000 00:00000000 00000000 10002 0 123 1 0000000000000000 20 4 30 10 -1\n' +
                b'1: 0100007F:0C38 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10004 0 124 1 0000000000000000 100 0 0 10 0\n')
        self.assertEqual(topology._network_rows(late, 'TCP', 4),
                         (topology.Listener('GUEST', 'TCP', '127.0.0.1', 3128, 10004),))
        self.assertEqual(topology._dns(b'\t nameserver\t127.0.0.53 # local\n'), ('127.0.0.53',))
        for malformed in (header + b'junk\n', header + b'0: bad\n'):
            with self.assertRaises(topology.TopologyError):
                topology._network_rows(malformed, 'TCP', 4)
        malformed_fields = header + b'0: 0100007F:0C38 00000000:0000 0A BAD BAD BAD 10004\n'
        with self.assertRaises(topology.TopologyError):
            topology._network_rows(malformed_fields, 'TCP', 4)
        with self.assertRaises(topology.TopologyError):
            topology._abstract(b'Num RefCount Protocol Flags Type St Inode Path\nBAD BAD BAD BAD BAD BAD BAD\n')
        self.assertEqual(topology._abstract(
            b'Num RefCount Protocol Flags Type St Inode Path\n000: 00000002 00000000 00010000 0001 01 123 /run/unauthorized.sock\n'),
            ('PATH:/run/unauthorized.sock',))

    def test_uncertain_owned_close_is_retained_and_cleaned_by_owner_not_fd(self):
        class Owner:
            def __init__(self): self.reads, self.closes, self.cleanups = 0, 0, 0
            def read(self, limit):
                self.reads += 1
                return b''
            def close(self):
                self.closes += 1
                raise OSError('unknown close state')
            def cleanup(self): self.cleanups += 1
        owner = Owner()
        class Port:
            def open_owned(self, path, flags): return owner
        inert = type('Source', (), {'collect': lambda s, a: (), 'observe': lambda s, a: (),
                                    'execute': lambda s, a: None})()
        bindings = topology.select_native_topology(Port(), inert, inert, inert, inert,
                                                   'linux', 'aarch64')
        with self.assertRaises(topology.TopologyError): bindings._read('/proc/net/dev')
        self.assertEqual(owner.closes, 1)
        bindings.cleanup_unresolved()
        self.assertEqual((owner.closes, owner.cleanups), (1, 1))

    def test_legacy_capture_admits_with_1ms_per_probe_and_samples_before_bracket_end(self):
        # Reviewer witness tmp/reviews/task10/scripts/probe_latency.py (T10-7):
        # each fixed probe costs `cost` ms on the guest clock. The observation
        # sample must follow device, probe and proxy observation, immediately
        # before the gate's bracket end, so probe latency never ages it.
        content = kernel_proc()
        for cost in (1, 6):
            now = [100, 10]
            class AdvancingClock:
                def sample(self): return tuple(now)
            def advance(ms): now[0] += ms; now[1] += ms
            class Owner:
                def __init__(self, path): self.parts = [content[path], b'']
                def read(self, size): return self.parts.pop(0)
                def close(self): pass
                def cleanup(self): pass
            class Observations:
                def open_owned(self, path, flags): return Owner(path)
            class Roles:
                def collect(self, expected): return snapshot().role_handoffs
                def cleanup_owned(self, handoffs): pass
            class Devices:
                def observe(self, expected): advance(1); return DEVICES
            class Probes:
                def execute(self, identifier): advance(cost); return result(identifier)
            class Proxy:
                def observe(self, policy): advance(1); return snapshot().proxy_runtime
            with self.subTest(cost=cost):
                gate = topology.TopologyGate(authority(clock=AdvancingClock()),
                    topology.select_native_topology(Observations(), Roles(), Devices(),
                                                    Probes(), Proxy(), 'linux', 'aarch64'),
                    supervisor=supervision())
                try: proof = gate.admit()
                except topology.TopologyError as error:
                    self.fail('%d ms per probe denied the legacy capture: %s' % (cost, error))
                self.assertEqual(proof.sequence, 1)
                # Sampled after devices (+1), all 12 probes and the proxy (+1).
                end = 10 + 1 + len(PROBES) * cost + 1
                self.assertEqual((gate._snapshot.observed_wall, gate._snapshot.observed_monotonic),
                                 (100 + end - 10, end))

    def test_legacy_verify_handoff_is_offline_only(self):
        # T10-13: the legacy v1 consumer has no sequence or freshness binding.
        # Its result is a plain validated payload, never an AdmissionProof, and
        # the same v1 wire never satisfies the composition (v2) consumer.
        a = authority()
        proof = topology.admit_topology(snapshot(), a, (100, 10), (100, 10))
        decoded = topology.verify_handoff(proof.handoff, a)
        self.assertIs(type(decoded), dict)
        self.assertNotIsInstance(decoded, topology.AdmissionProof)
        self.assertNotIn('hostChallenge', decoded)
        self.assertNotIn('composition', decoded)
        binding = confinement.CompositionBinding(1, RUN, MANIFEST, CONFIG, 'd' * 64, 1, 190)
        with self.assertRaisesRegex(topology.TopologyError, '^HANDOFF_DENIED$'):
            topology.verify_bootstrap_handoff_v1(proof.handoff, a, binding)
        doc = ' '.join(topology.verify_handoff.__doc__.split()).lower()
        self.assertIn('offline only', doc)
        self.assertIn('no freshness', doc)

    def test_export_composition_fixture_for_swift_consumer(self):
        proof = topology.admit_topology(snapshot(), authority(), (100, 10), (100, 10))
        path = os.environ.get('TASK10_TOPOLOGY_OUTPUT')
        if path:
            with pathlib.Path(path).open('x', encoding='ascii') as output: output.write(proof.handoff)
        vectors = []
        mutations = (
            lambda p: p['roles'][0]['capabilities'].__setitem__(0, False),
            lambda p: p['roles'][0]['fds'][1].__setitem__('fd', True),
            lambda p: p['roles'][0]['views'].__setitem__('separatePid', 1),
            lambda p: p['roles'][0]['views'].__setitem__('console', 0),
            lambda p: p['roles'][0].__setitem__('noNewPrivs', True),
            lambda p: p['proxy'].__setitem__('listenPort', True),
        )
        for mutate in mutations:
            envelope = json.loads(proof.handoff); mutate(envelope['payload'])
            envelope['mac'] = __import__('hmac').new(admission_key(),
                topology._canonical(envelope['payload']), __import__('hashlib').sha256).hexdigest()
            wire = topology._canonical(envelope).decode('ascii')
            with self.assertRaises(topology.TopologyError): topology.verify_handoff(wire, authority())
            vectors.append(wire)
        if path:
            with pathlib.Path(path + '.invalid.json').open('x', encoding='ascii') as output:
                json.dump(vectors, output, separators=(',', ':'))

        expected = authority()
        binding = confinement.CompositionBinding(
            1, RUN, MANIFEST, CONFIG, 'd' * 64, 1, 190)
        payload = topology._payload(snapshot(), expected, (100, 10), (100, 10))
        # The roleRuntime rows and the runtime-row divergence vectors are defined
        # once (confinement_test), so Python and Swift consume the same vectors (P12).
        vector_source = load('task7_runtime_row_vectors', 'tests/unit/confinement_test.py')
        role_runtime = vector_source.composition_role_runtime()
        payload['composition'] = dict(binding=binding.to_record(),
            probeEpochDigest='e' * 64,fixtureInventoryDigest='f' * 64,
            eventCheckpoint=dict(binding=binding.to_record(),generation=1,
                sequence=1,sourceIdentity='a' * 32,lostCount=0),
            proxyRuntimeId='b' * 32,roleRuntime=role_runtime)
        payload['hostChallenge'] = TEST_HOST_CHALLENGE
        def composition_wire(value):
            mac = hmac.new(admission_key(expected.capability),topology.BOOTSTRAP_HANDOFF_DOMAIN +
                topology._canonical(value),hashlib.sha256).hexdigest()
            return topology._canonical(
                {'mac':mac,'payload':value,'version':2}).decode('ascii')
        valid_composition = composition_wire(payload)
        self.assertEqual(topology.verify_bootstrap_handoff_v1(
            valid_composition,expected,binding),payload)
        composition_vectors = []
        def invalid_composition(mutate, *, remac=True):
            envelope=json.loads(valid_composition);mutate(envelope)
            if remac:
                envelope['mac']=hmac.new(admission_key(expected.capability),
                    topology.BOOTSTRAP_HANDOFF_DOMAIN +
                    topology._canonical(envelope['payload']),hashlib.sha256).hexdigest()
            value=topology._canonical(envelope).decode('ascii')
            with self.assertRaises(topology.TopologyError):
                topology.verify_bootstrap_handoff_v1(value,expected,binding)
            composition_vectors.append(value)
        invalid_composition(lambda e:e.__setitem__('version',1))
        invalid_composition(lambda e:e['payload']['composition']['eventCheckpoint']
            .__setitem__('lostCount',True))
        invalid_composition(lambda e:e['payload']['composition']['roleRuntime'][3]
            ['currentFDs'].pop())
        invalid_composition(lambda e:e['payload']['composition']['roleRuntime'][0]
            ['currentFDs'][4].update(device=e['payload']['composition']
                ['roleRuntime'][0]['currentFDs'][3]['device'],
                inode=e['payload']['composition']['roleRuntime'][0]
                ['currentFDs'][3]['inode']))
        invalid_composition(lambda e:e['payload']['composition']['binding']
            .__setitem__('epoch',2))
        invalid_composition(lambda e:e['payload']['composition']
            .__setitem__('unknown',0))
        invalid_composition(lambda e:e.__setitem__('mac','0' * 64),remac=False)
        invalid_composition(lambda e:e['payload'].__setitem__('hostChallenge',
            TEST_HOST_CHALLENGE.upper()))
        self.assertEqual(len(composition_vectors), 8)
        # compB M-2 and T10 runtime-row divergences, appended as objects after the
        # eight envelope strings: {id, code, originals, roleRuntime}. A SELF vector
        # is a structural fault the ownerless Python consumer rejects as well; the
        # FIXTURE vector differs only from the retained original rows (confinement_test).
        runtime_vectors = vector_source.runtime_row_divergence_vectors(role_runtime)
        self.assertEqual([v['id'] for v in runtime_vectors],
                         list(vector_source.RUNTIME_ROW_VECTOR_IDS))
        for vector in runtime_vectors:
            changed = [row for row, original in zip(vector['roleRuntime'], role_runtime)
                       if row != original]
            self.assertEqual(len(changed), 1, vector['id'])
            if vector['originals'] == 'SELF':
                with self.subTest(vector=vector['id']):
                    with self.assertRaisesRegex(topology.TopologyError, '^HANDOFF_DENIED$'):
                        topology._runtime_wire_row(changed[0], changed[0]['role'])
                    invalid_composition(lambda e, v=vector:
                        e['payload']['composition'].__setitem__('roleRuntime', v['roleRuntime']))
                    composition_vectors.pop()
        composition_vectors.extend(runtime_vectors)
        if path:
            with pathlib.Path(path + '.bootstrap-v1.json').open(
                    'x',encoding='ascii') as output:
                output.write(valid_composition)
            with pathlib.Path(path + '.bootstrap-v1.invalid.json').open(
                    'x',encoding='ascii') as output:
                json.dump(composition_vectors,output,separators=(',',':'))
            self.assertTrue(pathlib.Path(path + '.bootstrap-v1.json').is_file())
            self.assertTrue(pathlib.Path(path + '.bootstrap-v1.invalid.json').is_file())
        self.assertEqual(json.loads(proof.handoff)['version'], 1)


# T10-3 named negative vectors (P8, P33). A vector is host-verifiable only when
# the Swift verifier inspects the field it changes; observation_skew compares
# guest clock values and is guest-only (E2).
NAMED_VECTOR_IDS = (
    'nic', 'default_route_v4', 'default_route_v6', 'dns_nameserver', 'extra_listener',
    'missing_proxy_listener', 'abstract_unix', 'incorrect_uid', 'seccomp_mode',
    'fd_substitution', 'probe_attempted', 'probe_failed', 'host_listener',
    'observation_skew',
)
GUEST_ONLY_VECTOR_IDS = ('observation_skew',)


def get_path(value, path):
    for key in path: value = value[key]
    return value


def set_path(value, path, replacement):
    get_path(value, path[:-1])[path[-1]] = replacement


def signed_v1(payload, capability=CAPABILITY):
    """A v1 wire MAC'd with the topology-admission key, never the capability."""
    mac = hmac.new(admission_key(capability), topology._canonical(payload), hashlib.sha256).hexdigest()
    return topology._canonical({'mac': mac, 'payload': payload, 'version': 1}).decode('ascii')


def named_vector_changes():
    """id -> (payload path, value) as the guest producer reports each kernel fact."""
    extra = topology._network_rows(TCP4_HEADER + EXTRA_LISTENER_ROW, 'TCP', 4)
    return {
        'nic': (['devices', 'interfaces'],
                list(topology._interfaces(DEV_HEADER + dev_row('lo') + dev_row('eth0')))),
        'default_route_v4': (['devices', 'routes'],
                             list(topology._routes4(ROUTE4_HEADER + DEFAULT_ROUTE4_ROW))),
        'default_route_v6': (['devices', 'routes'], list(topology._routes6(DEFAULT_ROUTE6_ROW))),
        'dns_nameserver': (['devices', 'dnsServers'], list(topology._dns(b'nameserver 10.0.2.3\n'))),
        'extra_listener': (['devices', 'listeners'], [
            {'namespace': 'GUEST', 'transport': 'TCP', 'address': '127.0.0.1', 'port': 3128, 'uid': 10004},
            dataclasses.asdict(extra[0])]),
        'missing_proxy_listener': (['devices', 'listeners'], []),
        'abstract_unix': (['devices', 'abstractUnix'], list(topology._abstract(
            UNIX_HEADER + unix_row(4321, '@agent', flags=0x00010000)))),
        'incorrect_uid': (['roles', 1, 'uids'], [0, 0, 0]),
        'seccomp_mode': (['roles', 1, 'seccomp'], 0),
        'fd_substitution': (['roles', 1, 'fds', 3, 'purpose'], 'donor'),
        'probe_attempted': (['probes', 0, 'attempted'], False),
        'probe_failed': (['probes', 0, 'outcome'], 'ALLOWED'),
        'host_listener': (['devices', 'listeners', 0, 'namespace'], 'HOST'),
    }


class NamedTopologyPredicateTests(unittest.TestCase):
    """Task 4: kernel-format rows, plan-named predicates and native-only gate."""

    def test_kernel_default_ipv6_rows_admit_exactly(self):
        for name, rows in (('one table', KERNEL_IPV6_ROUTE),
                           ('main and local tables', KERNEL_IPV6_ROUTE_TWO_TABLES),
                           ('live reference counts', LOOPBACK_ROW.replace(b' 00000002 ', b' 00000005 ')
                            + NULL_ENTRY_ROW.replace(b' 00000001 ', b' 00000003 '))):
            with self.subTest(table=name):
                self.assertEqual(topology._routes6(rows), ())
                proof = native_gate(content=kernel_proc({'/proc/net/ipv6_route': rows})).admit()
                self.assertEqual(json.loads(proof.canonical)['devices']['routes'], [])
        # IPv6 absent: the file does not exist, and observation fails.
        gate = native_gate(content=kernel_proc(
            {'/proc/net/ipv6_route': FileNotFoundError(2, 'No such file or directory')}))
        with self.assertRaisesRegex(topology.TopologyError, '^OBSERVATION_DENIED$'): gate.admit()
        # Not kernel output: no null entry, upper-case %pi6, a zero reference count.
        for name, rows in (('empty', b''), ('upper case', KERNEL_IPV6_ROUTE.upper()),
                           ('zero references', LOOPBACK_ROW + NULL_ENTRY_ROW.replace(
                               b' 00000001 ', b' 00000000 '))):
            with self.subTest(malformed=name), self.assertRaisesRegex(
                    topology.TopologyError, '^OBSERVATION_DENIED$'):
                topology._routes6(rows)

    def test_ipv6_default_gateway_or_non_lo_route_rejects(self):
        cases = {
            # A table with a default route prints it as the root leaf (no null entry).
            'default via gateway on eth0': LOOPBACK_ROW + DEFAULT_ROUTE6_ROW,
            '::1/128 on eth0': ipv6_route_row(LOOPBACK6, 128, ANY6, 0, 2, 0x80200001, 'eth0') + NULL_ENTRY_ROW,
            'null entry with metric 0': LOOPBACK_ROW + ipv6_route_row(ANY6, 0, ANY6, 0, 1, 0x00200200, 'lo'),
            # The main-table ::1 prefix route a later NETDEV_UP of lo adds (addrconf.c:3555-3558).
            'extra third row': KERNEL_IPV6_ROUTE + ipv6_route_row(LOOPBACK6, 128, ANY6, 256, 1, 0x00000001, 'lo'),
            # Fix round 1: every shape field is bound. A non-reject ::/0 metric ~0 on lo
            # (possible through a nexthop object, which skips fib6_is_reject,
            # route.c:3794-3812) is not the null entry: flags differ.
            'non-reject ::/0 metric ffffffff on lo': LOOPBACK_ROW + ipv6_route_row(
                ANY6, 0, ANY6, 0xffffffff, 1, 0x00000001, 'lo'),
            # ::1/128 on lo without RTF_LOCAL is not the local route: flags differ.
            '::1/128 without RTF_LOCAL': ipv6_route_row(
                LOOPBACK6, 128, ANY6, 0, 2, 0x00200001, 'lo') + NULL_ENTRY_ROW,
            # A local ::/0 on lo is not the ::1/128 local route: destination differs.
            'local ::/0 on lo': ipv6_route_row(ANY6, 0, ANY6, 0, 2, 0x80200001, 'lo') + NULL_ENTRY_ROW,
            # A reject 2001:db8::/32 metric ~0 on lo is not the null entry: destination differs.
            'reject 2001:db8::/32 on lo': LOOPBACK_ROW + ipv6_route_row(
                bytes.fromhex('20010db8' + '0' * 24), 32, ANY6, 0xffffffff, 1, 0x00200200, 'lo'),
        }
        for name, rows in cases.items():
            with self.subTest(case=name):
                self.assertEqual(len(topology._routes6(rows)), 1)
                gate = native_gate(content=kernel_proc({'/proc/net/ipv6_route': rows}))
                with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_DENIED$'): gate.admit()

    def test_unexpected_NIC_default_v4_v6_route_DNS_listener_fail_before_prompt(self):
        cases = {
            'nic': ({'/proc/net/dev': DEV_HEADER + dev_row('lo') + dev_row('eth0')}, 'TOPOLOGY_DENIED'),
            'default_route_v4': ({'/proc/net/route': ROUTE4_HEADER + DEFAULT_ROUTE4_ROW}, 'TOPOLOGY_DENIED'),
            'default_route_v6': ({'/proc/net/ipv6_route': LOOPBACK_ROW + DEFAULT_ROUTE6_ROW}, 'TOPOLOGY_DENIED'),
            'dns_nameserver': ({'/etc/resolv.conf': b'nameserver 10.0.2.3\n'}, 'TOPOLOGY_DENIED'),
            'extra_listener': ({'/proc/net/tcp': TCP4_HEADER + LISTENER_ROW + EXTRA_LISTENER_ROW},
                               'LISTENER_DENIED'),
        }
        for name, (content, code) in cases.items():
            with self.subTest(vector=name):
                events = ServiceEvents()
                gate = native_gate(content=kernel_proc(content), supervisor=supervision(events))
                with self.assertRaisesRegex(topology.TopologyError, '^%s$' % code): gate.admit()
                self.assertEqual(events.subscriptions, [])  # denied before supervision or prompt
                with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_FAILED$'):
                    gate.require_current()

    def test_missing_proxy_fail(self):
        gate = native_gate(content=kernel_proc({'/proc/net/tcp': TCP4_HEADER}))
        with self.assertRaisesRegex(topology.TopologyError, '^LISTENER_DENIED$'): gate.admit()
        with self.assertRaisesRegex(topology.TopologyError, '^LISTENER_DENIED$'):
            topology.admit_topology(snapshot(listeners=()), authority(), (100, 10), (100, 10))

    def test_extra_abstract_UNIX_agent_fail(self):
        rows = UNIX_HEADER + unix_row(4321, '@agent', flags=0x00010000)
        self.assertEqual(topology._abstract(rows), ('ABSTRACT:@agent',))
        gate = native_gate(content=kernel_proc({'/proc/net/unix': rows}))
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_DENIED$'): gate.admit()
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_DENIED$'):
            topology.admit_topology(snapshot(abstract_unix=('ABSTRACT:@agent',)),
                                    authority(), (100, 10), (100, 10))

    def test_incorrect_uid_seccomp_fd_fail(self):
        base = snapshot()
        browser = base.role_handoffs[1]
        attestation = browser.attestation
        donor = dataclasses.replace(attestation.fds[3], purpose='donor')
        cases = {
            'incorrect_uid': dataclasses.replace(attestation, uids=(0, 0, 0)),
            'seccomp_mode': dataclasses.replace(attestation, seccomp=0),
            'fd_substitution': dataclasses.replace(
                attestation, fds=attestation.fds[:3] + (donor,) + attestation.fds[4:]),
        }
        for name, changed in cases.items():
            with self.subTest(vector=name):
                roles = tuple(dataclasses.replace(h, attestation=changed) if h is browser else h
                              for h in base.role_handoffs)
                gate = native_gate([dataclasses.replace(base, role_handoffs=roles)])
                with self.assertRaisesRegex(topology.TopologyError, '^ROLE_DENIED$'): gate.admit()

    def test_role_probe_failed_or_skipped_fail(self):
        base = snapshot()
        cases = {
            'probe_attempted': dataclasses.replace(base.probes[0], attempted=False),
            'probe_failed': dataclasses.replace(base.probes[0], outcome='ALLOWED', owned_receiver_count=1),
        }
        for name, probe in cases.items():
            with self.subTest(vector=name):
                gate = native_gate([dataclasses.replace(base, probes=(probe,) + base.probes[1:])])
                with self.assertRaisesRegex(topology.TopologyError, '^PROBE_DENIED$'): gate.admit()

    def test_host_listener_not_guest_loopback(self):
        host = topology.Listener('HOST', 'TCP', '127.0.0.1', 3128, 10004)
        with self.assertRaisesRegex(topology.TopologyError, '^LISTENER_DENIED$'):
            topology.admit_topology(snapshot(listeners=(host,)), authority(), (100, 10), (100, 10))
        # The native parser reports guest-namespace sockets only.
        self.assertEqual(topology._network_rows(TCP4_HEADER + LISTENER_ROW, 'TCP', 4),
                         (topology.Listener('GUEST', 'TCP', '127.0.0.1', 3128, 10004),))

    def test_observation_skew_beyond_window_fails(self):
        self.assertEqual(topology.GUEST_OBSERVATION_WINDOW_MS, 100)
        observed = snapshot(observed_wall=80, observed_monotonic=10)
        topology.admit_topology(observed, authority(), (80, 10), (180, 110))  # exactly the window
        for after in ((181, 110), (180, 111), (181, 111)):
            with self.subTest(after=after), self.assertRaisesRegex(topology.TopologyError, '^BINDING_DENIED$'):
                topology.admit_topology(observed, authority(), (80, 10), after)
        # Native: the capture's own sample is 101 ms older than the bracket end.
        gate = native_gate(clock=Clock((80, 10), (80, 10), (80, 10), (181, 111)))
        with self.assertRaisesRegex(topology.TopologyError, '^BINDING_DENIED$'): gate.admit()

    def test_named_negative_vectors_exported(self):
        a = authority()
        valid = json.loads(topology.admit_topology(snapshot(), a, (100, 10), (100, 10)).handoff)
        self.assertEqual(signed_v1(valid['payload']), topology._canonical(valid).decode('ascii'))
        changes, records = named_vector_changes(), []
        for identifier in NAMED_VECTOR_IDS:
            with self.subTest(vector=identifier):
                if identifier in GUEST_ONLY_VECTOR_IDS:
                    with self.assertRaisesRegex(topology.TopologyError, '^BINDING_DENIED$'):
                        topology.admit_topology(snapshot(observed_wall=80, observed_monotonic=10),
                                                a, (80, 10), (181, 111))
                    records.append({'id': identifier, 'hostVerifiable': False, 'path': None,
                                    'wire': None, 'guest': {'observed': [80, 10], 'bracketEnd': [181, 111],
                                    'windowMs': topology.GUEST_OBSERVATION_WINDOW_MS}})
                    continue
                path, value = changes[identifier]
                payload = json.loads(json.dumps(valid['payload']))
                set_path(payload, path, value)
                self.assertNotEqual(payload, valid['payload'])
                restored = json.loads(json.dumps(payload))
                set_path(restored, path, get_path(valid['payload'], path))
                self.assertEqual(restored, valid['payload'])  # only the named field differs
                wire = signed_v1(payload)
                with self.assertRaisesRegex(topology.TopologyError, '^HANDOFF_DENIED$'):
                    topology.verify_handoff(wire, a)
                records.append({'id': identifier, 'hostVerifiable': True, 'path': path,
                                'wire': wire, 'guest': None})
        self.assertEqual(tuple(item['id'] for item in records), NAMED_VECTOR_IDS)
        output = os.environ.get('TASK10_TOPOLOGY_OUTPUT')
        if output:
            with pathlib.Path(output + '.named-invalid.json').open('x', encoding='ascii') as handle:
                json.dump(records, handle, separators=(',', ':'), sort_keys=True)

    def test_tcp6_loopback_decodes_per_host_order_words(self):
        # T10-9: get_tcp6_sock prints %08X of each __be32 word as a host (LE) u32.
        self.assertEqual(be32_words(LOOPBACK6), '00000000000000000000000001000000')
        self.assertEqual(topology._ipv6_from_proc('00000000000000000000000001000000',
                                                  'be32_host_words'), LOOPBACK6)
        self.assertEqual(topology._ipv6_from_proc('0000000000000000FFFF00000100007F', 'be32_host_words'),
                         bytes(10) + b'\xff\xff' + bytes((127, 0, 0, 1)))
        self.assertEqual(topology._ipv6_from_proc('00000000000000000000000000000001', 'pi6'), LOOPBACK6)
        rows = TCP6_HEADER + tcp_row(0, LOOPBACK6, 3128, ANY6, 0, STATE_LISTEN, 10004, 125)
        self.assertEqual(topology._network_rows(rows, 'TCP', 6),
                         (topology.Listener('GUEST', 'TCP', '::1', 3128, 10004),))
        for text, printer in (('0000000000000000FFFF00000100007F', 'pi6'),        # %pi6 is lower case
                              ('0000000000000000ffff00000100007f', 'be32_host_words'),  # %08X upper
                              ('0' * 31, 'pi6'), ('0' * 32, 'hex'), (b'0' * 32, 'pi6')):
            with self.subTest(text=text, printer=printer), self.assertRaisesRegex(
                    topology.TopologyError, '^OBSERVATION_DENIED$'):
                topology._ipv6_from_proc(text, printer)

    def test_gate_rejects_non_native_adapter_and_missing_supervisor(self):
        bindings, _ = native_bindings()
        class Subclass(topology.NativeTopologyBindings): pass
        sources = SnapshotSources()
        foreign = (
            Adapter([snapshot()]),
            Subclass(ProcPort(), sources.roles, sources.devices, sources.probes, sources.proxy,
                     topology._NATIVE_SEAL),
            topology.NativeTopologyBindings(ProcPort(), sources.roles, sources.devices,
                                            sources.probes, sources.proxy, object()),
        )
        for adapter in foreign:
            with self.subTest(adapter=type(adapter).__name__), self.assertRaisesRegex(
                    topology.TopologyError, '^ADAPTER_DENIED$'):
                topology.TopologyGate(authority(), adapter, supervisor=supervision())
        for supervisor in (None, object()):
            with self.subTest(supervisor=supervisor), self.assertRaisesRegex(
                    topology.TopologyError, '^ADAPTER_DENIED$'):
                topology.TopologyGate(authority(), bindings, supervisor=supervisor)
        with self.assertRaises(TypeError): topology.TopologyGate(authority(), bindings)
        with self.assertRaises(TypeError):
            topology.TopologyGate(authority(), bindings, supervision())
        # T10-12: a subscription acquired inside begin() without a stop surface
        # stays typed cleanup authority; it is never dropped as OBSERVATION_DENIED.
        orphan = object()
        class OrphanEvents:
            def subscribe_fixed(self, events, callback): return orphan
        gate = native_gate(supervisor=topology.select_native_supervisor(
            topology.ServiceCreationMonitor(OrphanEvents(), RUN), 'linux', 'aarch64'))
        with self.assertRaises(topology.CleanupFailure) as caught: gate.admit()
        self.assertIs(caught.exception.cleanup, gate)
        self.assertIn(orphan, gate.unresolved_cleanup)
        self.assertTrue(gate.cleanup_uncertain)

    def test_n5a_drift_during_pending_capture_is_typed_cleanup_at_gate(self):
        # T10-5 regression at the gate (reviewer witness n5_probe.py, N5-A).
        entered, release = threading.Event(), threading.Event()
        bindings, sources = native_bindings()
        collect = sources.roles.collect
        def blocking(authority):
            entered.set(); release.wait(5)
            return collect(authority)
        sources.roles.collect = blocking
        gate = topology.TopologyGate(authority(clock=Clock(*([(100, 10)] * 50))), bindings,
                                     supervisor=supervision())
        errors = []
        def admit():
            try: gate.admit()
            except Exception as error: errors.append(error)
        worker = threading.Thread(target=admit, daemon=True); worker.start()
        try:
            self.assertTrue(entered.wait(2))
            with self.assertRaises(topology.CleanupFailure) as caught: gate.topology_drifted()
            self.assertIs(caught.exception.cleanup, gate)
            self.assertTrue(gate.cleanup_uncertain)
            self.assertIn(bindings.capture_owner, gate._pending_captures.values())
        finally:
            release.set(); worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], topology.TopologyError)
        self.assertFalse(gate.cleanup_uncertain)
        self.assertIn(id(bindings.capture_owner), gate._retired)
        self.assertTrue(sources.cleaned)  # the collected roles were stopped by their owner

    def test_n5b_ordinary_close_failure_is_typed_cleanup_at_gate(self):
        # T10-6 regression at the gate (reviewer witness n5_probe.py, N5-B).
        class Owner:
            def __init__(self): self.chunks, self.closes = [ROUTE4_HEADER, b''], 0
            def read(self, limit): return self.chunks.pop(0)
            def close(self):
                self.closes += 1
                raise OSError('ordinary close failure')
            def cleanup(self): pass
        failing = Owner()
        port = ProcPort()
        open_owned = port.open_owned
        port.open_owned = lambda path, flags: failing if path == '/proc/net/route' else open_owned(path, flags)
        bindings, _ = native_bindings(port=port)
        gate = topology.TopologyGate(authority(), bindings, supervisor=supervision())
        with self.assertRaises(topology.CleanupFailure) as caught: gate.admit()
        self.assertEqual(str(caught.exception), 'CLEANUP_UNCERTAIN')
        self.assertIs(caught.exception.cleanup, gate)
        self.assertTrue(gate.cleanup_uncertain)
        self.assertIn(failing, gate.unresolved_cleanup)
        self.assertEqual(bindings._unresolved, [failing])
        self.assertEqual(failing.closes, 1)

    def test_n5b_read_raises_cleanup_failure_with_owner_and_primary_cause(self):
        # compA M-1: the adapter-level _read binds the owner and the primary cause.
        for primary in (OSError('inert read failure'), topology.TopologyError('OBSERVATION_DENIED'), None):
            with self.subTest(primary=primary):
                class Owner:
                    def read(self, limit):
                        if primary is not None: raise primary
                        return b''
                    def close(self): raise OSError('ordinary close failure')
                    def cleanup(self): pass
                owner = Owner()
                class Port:
                    def open_owned(self, path, flags): return owner
                bindings, _ = native_bindings(port=Port())
                with self.assertRaises(topology.CleanupFailure) as caught: bindings._read('/proc/net/route')
                self.assertIs(caught.exception.cleanup, owner)
                self.assertIs(caught.exception.__cause__, primary)
                self.assertEqual(bindings._unresolved, [owner])

    def test_success_path_drift_relatches_cleanup(self):
        # compA M-2, with the reviewer's sys.settrace arrangement (probes/
        # review_race_test.py): a drift between _attempt's final drift check and
        # its pending-capture pop skipped the still-pending capture owner.
        lines, start = inspect.getsourcelines(topology.TopologyGate._attempt)
        ret_line = next(start + i for i, l in enumerate(lines) if l.strip() == 'return proof')
        for operation in ('admit', 'require_current'):
            with self.subTest(operation=operation):
                events = ServiceEvents()
                gate, bindings, collection, kernel = native_capture_fixture(
                    Clock(), lambda path: None, supervisor=supervision(events))
                if operation == 'require_current': gate.admit()
                begun = len(events.subscriptions)
                at_return, release = threading.Event(), threading.Event()
                def trace(frame, event, arg):
                    if (event == 'line' and frame.f_code is topology.TopologyGate._attempt.__code__
                            and frame.f_lineno == ret_line):
                        at_return.set(); release.wait(2)
                    return trace
                errors, results = [], []
                def run():
                    sys.settrace(trace)
                    try: results.append(getattr(gate, operation)())
                    except Exception as error: errors.append(error)
                    finally: sys.settrace(None)
                worker = threading.Thread(target=run, daemon=True); worker.start()
                try:
                    self.assertTrue(at_return.wait(2))
                    with self.assertRaises(topology.CleanupFailure) as caught: gate.topology_drifted()
                    self.assertIs(caught.exception.cleanup, gate)  # capture still pending here
                finally:
                    release.set(); worker.join(5)
                self.assertFalse(worker.is_alive())
                self.assertEqual(results, [])
                self.assertEqual([str(error) for error in errors], ['TOPOLOGY_DRIFT'])
                self.assertNotIsInstance(errors[0], topology.CleanupFailure)
                self.assertFalse(gate.cleanup_uncertain)
                self.assertIn(id(bindings.capture_owner), gate._retired)
                self.assertEqual(gate._pending_captures, {})
                self.assertEqual(kernel.stops, list(reversed(kernel.spawned)))
                self.assertEqual(len(events.subscriptions), begun)  # no supervision after a drift

    def test_legacy_task8_probe_source_removed(self):
        # T10-4 (P9): the legacy probe catalogue and its native attempts are gone;
        # the composition's probe epoch is the only probe source.
        for name in ('TASK8_PROBE_CASES', 'select_task8_probe_source', 'Task10NativeAttempts',
                     'Task8ProbeSource'):
            with self.subTest(name=name):
                self.assertFalse(hasattr(topology, name))

    def test_guest_topology_test_is_gated_native_test(self):
        # T10-8: tests/guest/topology_test.py has no native default; without a
        # native port every test errors (never passes, never skips).
        for platform_name, machine in (('linux', 'aarch64'), ('darwin', 'arm64')):
            with self.subTest(platform=platform_name), self.assertRaisesRegex(
                    topology.RuntimeGateUnavailable, '^NATIVE_TOPOLOGY_PORT_UNAVAILABLE$'):
                topology.select_native_topology_port(platform_name, machine)
        guest = load('task04_guest_topology_test', 'tests/guest/topology_test.py')
        suite = unittest.defaultTestLoader.loadTestsFromModule(guest)
        result = unittest.TestResult()
        suite.run(result)
        self.assertGreater(result.testsRun, 0)
        self.assertEqual((result.failures, result.skipped, result.expectedFailures,
                          result.unexpectedSuccesses), ([], [], [], []))
        self.assertEqual(len(result.errors), result.testsRun)
        for _, trace in result.errors:
            self.assertIn('RuntimeGateUnavailable: NATIVE_TOPOLOGY_PORT_UNAVAILABLE', trace)


def execute_fixed_probes(port):
    """Request every reviewed probe exactly once; return typed observations."""
    return tuple(port.execute(identifier) for identifier in PROBES)


class InertGuestDriverTests(unittest.TestCase):
    """Inert driver coverage moved from tests/guest/topology_test.py (T10-8).

    These are unit tests over doubles. They select and execute no probe and
    are never evidence for the gated native guest file.
    """
    def test_each_fixed_probe_is_requested_once_in_reviewed_order(self):
        class Port:
            def __init__(self): self.requested = []
            def execute(self, identifier):
                self.requested.append(identifier)
                return ('OBSERVED', identifier)
        port = Port()
        self.assertEqual(execute_fixed_probes(port), tuple(('OBSERVED', item) for item in PROBES))
        self.assertEqual(tuple(port.requested), PROBES)
        self.assertEqual(PROBES, topology.FIXED_PROBE_IDS)

    def test_probe_failure_stops_without_self_authorizing_result(self):
        class Port:
            def __init__(self): self.requested = []
            def execute(self, identifier):
                self.requested.append(identifier)
                if len(self.requested) == 3: raise RuntimeError('inert failure')
                return identifier
        port = Port()
        with self.assertRaisesRegex(RuntimeError, '^inert failure$'):
            execute_fixed_probes(port)
        self.assertEqual(tuple(port.requested), PROBES[:3])

    def test_task8_role_and_task9_proxy_adapters_retain_owned_authority(self):
        class Handle:
            def __init__(self): self.stops = 0
            async def stopOwned(self, deadline):
                self.stops += 1
                return {'status':'STOPPED','runId':'1' * 32}
            async def waitExit(self, deadline):
                return {'status':'EXITED','runId':'1' * 32}
        class Bridge:
            def __init__(self): self.activated = 0; self.handle = Handle(); self.cleaned = []
            def collectOwned(self, launches): return ('roles', launches)
            def cleanupOwned(self, handoffs): self.cleaned.append(handoffs)
            async def activateOnce(self, grant):
                self.activated += 1
                return self.handle
        bridge = Bridge()
        with self.assertRaisesRegex(topology.TopologyError, '^COMPOSITION_UNAVAILABLE$'):
            topology.select_task8_roles(bridge, object())
        self.assertEqual((bridge.activated, bridge.handle.stops, bridge.cleaned), (0, 0, []))

        class Observer:
            def __init__(self): self.seen = []
            def observeAccepted(self, policy): self.seen.append(policy); return 'runtime'
        # A caller cannot fabricate the accepted Task9 seal.
        with self.assertRaises(topology.TopologyError):
            topology.select_task9_proxy_source(Observer(), object())

    def test_native_supervision_is_explicit_owned_and_drift_callback_is_retained(self):
        class Handle:
            def __init__(self): self.stops = 0
            def stop_owned(self): self.stops += 1
        class Monitor:
            def __init__(self): self.callback = None; self.handle = Handle()
            def beginOwned(self, handoff, callback):
                self.callback = callback
                return self.handle
        monitor = Monitor()
        supervisor = topology.select_native_supervisor(monitor, 'linux', 'aarch64')
        handle = supervisor.begin('authenticated-handoff', lambda: None)
        self.assertIs(handle, monitor.handle)
        self.assertIsNotNone(monitor.callback)
        with self.assertRaises(topology.TopologyError):
            topology.select_native_supervisor(monitor, 'darwin', 'arm64')

    def test_concrete_service_monitor_subscribes_only_finite_events(self):
        class Owner:
            def stop_owned(self, deadline): return {'status':'STOPPED','run_id':'1' * 32}
        class Events:
            def subscribe_fixed(self, events, callback):
                self.events, self.callback = events, callback
                return Owner()
        events, drift = Events(), []
        monitor = topology.ServiceCreationMonitor(events, '1' * 32)
        handle = monitor.beginOwned('wire', lambda: drift.append(True))
        self.assertEqual(events.events, ('DEVICE','NIC','ROUTE','DNS','LISTENER','UNIX','ROLE'))
        events.callback('LISTENER'); events.callback(object())
        self.assertEqual(drift, [True,True])
        self.assertEqual(handle.stop_owned(120000)['status'], 'STOPPED')
        with self.assertRaises(topology.TopologyError): monitor.beginOwned('wire', lambda: None)


if __name__ == '__main__':
    unittest.main()

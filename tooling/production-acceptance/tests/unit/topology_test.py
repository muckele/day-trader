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
DEVICES = ('LINUX_BOOT', 'VIRTIO_BLOCK_READ_ONLY', 'VIRTIO_ENTROPY',
           'VIRTIO_SERIAL_PRIVATE_PIPE', 'VIRTIO_VSOCK_CID2_PORT4050')
PROBES = (
    'BROWSER_FD_DONOR', 'BROWSER_HELPER_IPV4', 'BROWSER_HELPER_IPV6',
    'BROWSER_IO_URING', 'BROWSER_IPV4_TCP', 'BROWSER_IPV6_TCP',
    'BROWSER_UDP', 'BROWSER_VSOCK', 'CONTROLLER_DNS_TCP',
    'CONTROLLER_DNS_UDP', 'PROXY_VSOCK_CONTROL', 'VERIFIER_IPV4_TCP',
)


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
            programs=launch.programs)
        owned = Owned(attestation.pid, RUN, role)
        launches.append(launch)
        handoffs.append(confinement.RoleHandoff(launch, attestation, kernel, owned))
    return tuple(launches), tuple(handoffs)


def proxy_policy():
    binding = proxy.RunBinding(
        RUN, CAPABILITY, 190, 1, MANIFEST, CONFIG,
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


def native_capture_fixture(clock, before_open, fail_probe=False):
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
    header = b'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'
    content = {
        '/proc/net/dev': b'Inter-| Receive\n face |bytes packets errs drop fifo frame compressed multicast\n lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n',
        '/proc/net/route': b'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n',
        '/proc/net/ipv6_route': b'', '/etc/resolv.conf': b'',
        '/proc/net/tcp': header + b'0: 0100007F:0C38 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10004 0 123 1 0000000000000000 100 0 0 10 0\n',
        '/proc/net/tcp6': header, '/proc/net/udp': header, '/proc/net/udp6': header,
        '/proc/net/unix': b'Num RefCount Protocol Flags Type St Inode Path\n',
    }
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
    gate = topology.TopologyGate(authority(clock=clock), bindings)
    return gate, bindings, collection, kernel


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
        payload = struct.pack('<11I', 0x1f, 1, 0, 4242, 0, 256, 0,
                              self.health_backlog, 0, 0, 0)
        return (0, self.mono, topology._event_nlmsg(1000, sequence, payload))
    def audit_rules(self, owner, sequence):
        rule = bytearray(topology._FIXED_AUDIT_RULE)
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


def audit_event(serial, syscall=201, *, pid=500, ppid=1, exit_code=0,
                success='yes', argument0=None):
    text = ('audit(1.000:%d): arch=c00000b7 syscall=%d success=%s exit=%d '
            'pid=%d ppid=%d' %
            (serial, syscall, success, exit_code, pid, ppid))
    if argument0 is not None: text += ' a0=%s' % argument0
    text = text.encode('ascii')
    return topology._event_nlmsg(1300, 0, text)


def audit_sockaddr(serial, family='inet'):
    values = {'inet': '02000c387f0000010000000000000000',
              'inet6': '0a000c3800000000000000000000000000000001',
              'unix': '01002f72756e2f6261642e736f636b00'}
    text = ('audit(1.000:%d): saddr=%s' % (serial, values[family])).encode('ascii')
    return topology._event_nlmsg(1306, 0, text)


def audit_aux(serial, kind=1302, size=0):
    text = ('audit(1.000:%d): item=0 name="/fixed" ' % serial).encode('ascii')
    text += b'x' * size
    return topology._event_nlmsg(kind, 0, text)


def literal_runtime_role(confinement_fixture, role, lifecycle, runtime_owner,
                         desired_rows=()):
    """Actual NativeKernelPort + literal /proc facts, with inert byte owners."""
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
    rows = {row['fd']: row for row in desired_rows}
    role_index = list(confinement.UIDS).index(role)
    inherited = {fd:types.SimpleNamespace(
        st_dev=2,st_ino=1000 + role_index * 10 + fd) for fd in range(5)}
    active = {'fds': [0, 1, 2, 3, 4]}

    def read(path, *args):
        if '/fdinfo/' in path:
            fd = int(path.rsplit('/', 1)[1])
            flags = rows.get(fd, {}).get('flags', 1 if fd == 4 else 0)
            return ('flags:\t%s\n' % oct(flags)[2:]).encode('ascii')
        if path.endswith('/cmdline'):
            return b'\0'.join(value.encode() for value in launch.argv) + b'\0'
        return old_read(path, *args).replace(
            b'10002', str(launch.uid).encode()).replace(b'browser', role.lower().encode())

    def listed(path):
        if path.endswith('/fd'): return [str(fd) for fd in active['fds']]
        if path.endswith('/run/acceptance'): return [role.lower()]
        return old_list(path)

    def linked(path):
        if '/fd/' in path and int(path.rsplit('/', 1)[1]) >= 5:
            return 'socket:[%s]' % rows[int(path.rsplit('/', 1)[1])]['inode']
        return old_link(path)

    def stated(path):
        if '/fd/' in path:
            fd = int(path.rsplit('/', 1)[1])
            row = rows.get(fd)
            if row is not None:
                return types.SimpleNamespace(st_dev=int(row['device']), st_ino=int(row['inode']))
            if fd in inherited:return inherited[fd]
        value = old_stat(path)
        if path.endswith('/exe'):
            return types.SimpleNamespace(st_dev=1, st_ino=999)
        value.st_uid = value.st_gid = launch.uid
        return value

    bindings.read_file, bindings.os.listdir = read, listed
    bindings.os.readlink, bindings.os.stat = linked, stated
    bindings.os.fstat = lambda fd: types.SimpleNamespace(
        st_dev=int(rows[fd]['device']), st_ino=int(rows[fd]['inode']))
    owned = confinement.NativeOwned(300, RUN, role, original.command,
                                    original.result, original.identity)
    del kernel._owned[original]; kernel._owned[owned] = state
    handoff = confinement.RoleHandoff(launch, confinement.RoleAttestation(**dict(
        pid=300, run_id=RUN, role=role, uids=(launch.uid,) * 3,
        gids=(launch.uid,) * 3, groups=(), capabilities=(0,) * 5,
        no_new_privs=1, seccomp=2, filter_digest=state['digest'], fds=launch.fds,
        views=launch.views, waiting=True, programs=launch.programs)), kernel, owned)
    marker = {'CONTROLLER': '1', 'BROWSER': '3', 'VERIFIER': '5', 'PROXY': '7'}[role]
    kernel.bind_runtime_owner(handoff, lifecycle, runtime_owner,
                              marker * 32, hex(int(marker, 16) + 1)[2:] * 32, 1)
    endpoints = []
    for row in desired_rows:
        if row['fd'] < 5: continue
        endpoint = types.SimpleNamespace(fileno=lambda fd=row['fd']: fd)
        endpoints.append(endpoint)
        kernel.register_runtime_descriptor(
            handoff, runtime_owner, endpoint, row['kind'], 1)
    active['fds'] = sorted(rows) if rows else [0, 1, 2, 3, 4]
    return handoff, kernel, active, endpoints


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
            mac = hmac.new(expected.capability, topology.BOOTSTRAP_HANDOFF_DOMAIN +
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
                              native.message('AUDIT', topology._event_nlmsg(
                                  1320, 0, b'audit(1.000:7): end'))]
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
            rows.append(native.message('AUDIT', topology._event_nlmsg(
                1320, 0, ('audit(1.000:%d): end' % serial).encode('ascii'))))
            native.events.extend(rows)
            with self.subTest(syscall=syscall), self.assertRaisesRegex(
                    topology.TopologyError, '^(EVENT_DRIFT|EVENT_SOURCE_TERMINAL)$'):
                owner.barrier()
        for fault in ('foreign', 'missing-pid', 'duplicate-syscall',
                      'missing-sockaddr', 'contradictory-exit',
                      'nonzero-return'):
            owner, native, _ = self.install_events(); serial = 80
            if fault == 'missing-pid':
                raw = topology._event_nlmsg(1300, 0,
                    b'audit(1.000:80): arch=c00000b7 syscall=40 success=yes exit=0 ppid=1')
            else:
                raw = audit_event(serial, syscall=200 if fault == 'missing-sockaddr' else 40,
                                  pid=999 if fault == 'foreign' else 500,
                                  exit_code=(-1 if fault == 'contradictory-exit'
                                             else 1 if fault == 'nonzero-return'
                                             else 0))
            native.events.append(native.message('AUDIT', raw))
            if fault == 'duplicate-syscall':
                native.events.append(native.message('AUDIT', raw))
            native.events.append(native.message('AUDIT', topology._event_nlmsg(
                1320, 0, b'audit(1.000:80): end')))
            with self.subTest(fault=fault), self.assertRaisesRegex(
                    topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
                owner.barrier()
        owner, native, _ = self.install_events()
        native.events.extend((native.message('AUDIT', topology._event_nlmsg(
            1300, 0, b'audit(1.000:81): arch=c00000b7 syscall=40 success=no '
                       b'exit=-1 pid=500 ppid=1')),
            native.message('AUDIT', topology._event_nlmsg(
                1320, 0, b'audit(1.000:81): end'))))
        self.assertEqual(owner.barrier().binding, event_binding())

    def test_v1_audit_stream_demux_and_fence_records_precede_checkpoint(self):
        class Interleaved(EventNative):
            def audit_request(self, owner, request, sequence):
                values = list(super().audit_request(owner, request, sequence))
                if request == 'HEALTH' and not getattr(self, 'injected', False):
                    self.injected = True
                    values[0:0] = [self.message('AUDIT', audit_event(90, syscall=40)),
                        self.message('AUDIT', topology._event_nlmsg(
                            1320, 0, b'audit(1.000:90): end'))]
                return tuple(values)
        with self.assertRaisesRegex(topology.TopologyError,
                                    '^(EVENT_DRIFT|EVENT_SOURCE_TERMINAL)$'):
            self.install_events(Interleaved())

        class FenceArrival(EventNative):
            def delivery_barrier(self, owners, wakeup, selector):
                rows = (self.message('AUDIT', audit_event(91, syscall=40)),
                        self.message('AUDIT', topology._event_nlmsg(
                            1320, 0, b'audit(1.000:91): end')))
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
        proxy_fixture = load('task8_event_current_proxy_fixture',
                             'tests/unit/proxy_test.py')
        proxy_fixture.proxy = proxy
        observations = []
        def capture(harness, owner):
            # Sample the exact serving owner once to configure an independent
            # literal /proc view of the same kernel facts. The composed helper
            # must then call both real observers itself.
            proxy_rows = owner.observe_current(
                harness.nominal_binding).to_record()['currentFDs']
            runtime_owners = {role: object() for role in confinement.UIDS}
            runtime_owners['PROXY'] = owner
            handoffs, controls, retained = [], {}, []
            for role, lifecycle in zip(confinement.UIDS,
                    ('SERVICE', 'WAITING', 'WAITING', 'SERVICE')):
                rowset = proxy_rows if role == 'PROXY' else ()
                handoff, kernel, active, endpoints = literal_runtime_role(
                    confinement_fixture, role, lifecycle,
                    runtime_owners[role], rowset)
                handoffs.append(handoff); controls[role] = (kernel, active)
                retained.extend(endpoints)
            before = topology.observe_current_roles(
                tuple(handoffs), runtime_owners, owner, harness.nominal_binding)
            self.assertEqual([row['lifecycle'] for row in before],
                             ['SERVICE', 'WAITING', 'WAITING', 'SERVICE'])
            self.assertEqual(before[3]['currentFDs'][-2]['kind'],
                             'PROXY_LISTENER')

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
                tuple(handoffs), runtime_owners, owner, harness.nominal_binding)
            self.assertEqual(after[1]['lifecycle'], 'BROWSER_ACTIVE')

            controls['BROWSER'][1]['fds'].append(6)
            with self.assertRaisesRegex(topology.TopologyError,
                    '^NATIVE_CURRENT_INVENTORY_UNAVAILABLE$'):
                topology.observe_current_roles(
                    tuple(handoffs), runtime_owners, owner,
                    harness.nominal_binding)
            controls['BROWSER'][1]['fds'].pop()
            substituted = dict(runtime_owners); substituted['PROXY'] = object()
            with self.assertRaisesRegex(topology.TopologyError, '^ROLE_DENIED$'):
                topology.observe_current_roles(
                    tuple(handoffs), substituted, owner,
                    harness.nominal_binding)
            observations.extend((before, after, tuple(retained)))
        proxy_fixture.CompositionHarness(self, sink=capture).run()
        self.assertEqual(len(observations), 3)

    def test_v1_browser_family_event_reservation_is_nominal_ordered_and_one_use(self):
        confinement_fixture = load(
            'task8_event_reservation_confinement_fixture',
            'tests/unit/confinement_test.py')
        confinement_fixture.c = confinement
        confinement_fixture.RUN = RUN
        proxy_fixture = load('task8_event_reservation_proxy_fixture',
                             'tests/unit/proxy_test.py')
        proxy_fixture.proxy = proxy
        completed = []
        def capture(harness, proxy_owner):
            runtime_owners = {role: object() for role in confinement.UIDS}
            runtime_owners['PROXY'] = proxy_owner
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
                    harness.nominal_binding,
                    topology.qualify_offline_event_native(native), budget)
                return value, native

            def group(native, serial, syscall, pid, ppid, exit_code,
                      argument0=None):
                return (native.message('AUDIT', audit_event(serial, syscall,
                    pid=pid, ppid=ppid, exit_code=exit_code,
                    argument0=argument0)),
                    native.message('AUDIT', topology._event_nlmsg(
                        1320, 0, ('audit(1.000:%d): end' % serial).encode())))

            source, native = event_owner()
            completed.append(hasattr(source, 'reserve_browser_transition'))
            self.assertTrue(completed[-1])
            reservation = source.reserve_browser_transition(
                harness.nominal_binding, 1, browser,
                runtime_owners['BROWSER'], proxy_owner)
            source.commit_browser_transition(reservation)
            native.events.extend(group(native, 101, 220, 300, 1, 600))
            with self.assertRaisesRegex(topology.TopologyError, '^EVENT_PENDING$'):
                source.barrier()
            native.events.extend(group(native, 102, 221, 600, 300, 0))
            with self.assertRaisesRegex(topology.TopologyError, '^EVENT_PENDING$'):
                source.barrier()
            native.events.extend(group(native, 103, 93, 600, 300, 0, '0'))
            self.assertEqual(source.barrier().generation, 1)

            source, native = event_owner()
            native.events.extend(group(native, 104, 220, 300, 1, 601))
            with self.assertRaisesRegex(topology.TopologyError,
                                       '^EVENT_SOURCE_TERMINAL$'):
                source.barrier()

            for fault in ('mismatch', 'out-of-order', 'extra', 'replay'):
                source, native = event_owner()
                reservation = source.reserve_browser_transition(
                    harness.nominal_binding, 1, browser,
                    runtime_owners['BROWSER'], proxy_owner)
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
                    harness.nominal_binding, 2, browser,
                    runtime_owners['BROWSER'], proxy_owner)
            for fault in ('binding', 'role-owner', 'runtime-owner',
                          'proxy-owner'):
                source, _ = event_owner()
                values = dict(binding=harness.nominal_binding,
                    handoff=browser, runtime=runtime_owners['BROWSER'],
                    proxy=proxy_owner)
                if fault == 'binding':
                    values['binding'] = dataclasses.replace(
                        harness.nominal_binding, epoch=2)
                elif fault == 'role-owner':
                    values['handoff'] = dataclasses.replace(browser)
                elif fault == 'runtime-owner':
                    values['runtime'] = object()
                else: values['proxy'] = object()
                with self.subTest(fault=fault), self.assertRaisesRegex(
                        topology.TopologyError, '^EVENT_SOURCE_TERMINAL$'):
                    source.reserve_browser_transition(values['binding'], 1,
                        values['handoff'], values['runtime'], values['proxy'])
            first, _ = event_owner(); second, _ = event_owner()
            reservation = first.reserve_browser_transition(
                harness.nominal_binding, 1, browser,
                runtime_owners['BROWSER'], proxy_owner)
            with self.assertRaisesRegex(topology.TopologyError,
                                       '^EVENT_SOURCE_TERMINAL$'):
                second.commit_browser_transition(reservation)
        proxy_fixture.CompositionHarness(self, sink=capture).run()
        self.assertEqual(completed, [True])

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
        gate = topology.TopologyGate(authority(clock=clock), adapter)
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
        gate = topology.TopologyGate(authority(), adapter)
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
                header = b'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'
                content = {
                    '/proc/net/dev': b'Inter-| Receive\n face |bytes packets errs drop fifo frame compressed multicast\n lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n',
                    '/proc/net/route': b'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n',
                    '/proc/net/ipv6_route': b'', '/etc/resolv.conf': b'',
                    '/proc/net/tcp': header, '/proc/net/tcp6': header,
                    '/proc/net/udp': header, '/proc/net/udp6': header,
                    '/proc/net/unix': b'Num RefCount Protocol Flags Type St Inode Path\n',
                }
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
                gate = topology.TopologyGate(authority(), adapter)
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
                gate = topology.TopologyGate(authority(), adapter)
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
            def execute_native(self, *args): raise failure
        source, policy = Source(), proxy_policy()
        supervisor = topology.select_native_supervisor(source, 'linux', 'aarch64')
        proxy_source = topology.select_task9_proxy_source(source, policy)
        probes = topology.Task8ProbeSource(object(), object(), source, topology._COMPOSITION_SEAL)
        def terminal_call():
            budget = topology.CleanupBudget(); budget.start_terminal()  # call() requires a started end (C1)
            return budget.call(lambda remaining: source.beginOwned())
        for operation in (lambda: supervisor.begin('wire', lambda: None),
                          lambda: proxy_source.observe(policy),
                          lambda: probes.execute('BROWSER_IPV4_TCP'),
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
        gate = topology.TopologyGate(authority(), adapter)
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
        gate = topology.TopologyGate(authority(), Adapter([snapshot()]))
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
        gate = topology.TopologyGate(authority(recheck=recheck), Adapter([snapshot()]))
        gate.admit()
        with self.assertRaises(topology.TopologyError): gate.activate_browser(activation)
        self.assertTrue(recheck.fired)
        self.assertEqual(activation.prepared, 0)
        self.assertFalse(gate.cleanup_uncertain)

    def test_local_n3_late_preparation_owner_is_compensated_after_early_stop(self):
        gate = topology.TopologyGate(authority(), Adapter([snapshot()]))
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
                class SnapshotAdapter(Adapter):
                    def cleanup(self, value):
                        if target == 'snapshot': entered.set(); release.wait(1)
                gate = topology.TopologyGate(authority(), SnapshotAdapter([snapshot()]))
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
                header = b'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'
                content = {
                    '/proc/net/dev': b'Inter-| Receive\n face |bytes packets errs drop fifo frame compressed multicast\n lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n',
                    '/proc/net/route': b'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n',
                    '/proc/net/ipv6_route': b'', '/etc/resolv.conf': b'',
                    '/proc/net/tcp': header, '/proc/net/tcp6': header,
                    '/proc/net/udp': header, '/proc/net/udp6': header,
                    '/proc/net/unix': b'Num RefCount Protocol Flags Type St Inode Path\n',
                }
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
                gate = topology.TopologyGate(authority(), adapter)
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
        gate = topology.TopologyGate(authority(clock=clock), Adapter([snapshot()]))
        gate.admit()
        activation = Activation(callback=lambda: clock.samples.append((190, 10010)))
        with self.assertRaises(topology.TopologyError): gate.activate_browser(activation)
        self.assertEqual(activation.cleaned, 1)
        self.assertTrue(gate._failed)

    def test_round4_duplicate_activation_cleans_role_and_monitor(self):
        monitor = Activation()
        monitor.begin = lambda wire, callback: monitor
        gate = topology.TopologyGate(authority(), Adapter([snapshot()]), monitor)
        gate.admit(); activation = Activation(); gate.activate_browser(activation)
        with self.assertRaises(topology.TopologyError): gate.activate_browser(activation)
        self.assertEqual((activation.cleaned, monitor.cleaned), (1, 1))

    def test_round4_prepare_throw_retains_preparation_owner(self):
        class PrepareFailure(Activation):
            def prepare(self, handoff, proof): raise RuntimeError('inert prepare')
            def stop_owned(self, deadline):
                self.cleaned += 1
                return {'status':'TIMEOUT','run_id':RUN}
        gate = topology.TopologyGate(authority(), Adapter([snapshot()]))
        gate.admit(); activation = PrepareFailure()
        with self.assertRaises(topology.TopologyError) as caught: gate.activate_browser(activation)
        self.assertEqual(activation.cleaned, 1)
        self.assertTrue(gate.cleanup_uncertain)
        self.assertIs(getattr(caught.exception, 'cleanup', None), gate)

    def test_round4_late_owner_is_compensated_after_pending_fallback(self):
        gate = topology.TopologyGate(authority(), Adapter([snapshot()]))
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
        owned = source.collect(expected)
        owned[0]._owned.command = object()
        class FailedAdapter(Adapter):
            def capture(self, sequence, expected):
                return dataclasses.replace(snapshot(), role_handoffs=source.collect(expected), sequence=sequence)
        gate = topology.TopologyGate(expected, FailedAdapter([snapshot()]))
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
        transport.authenticate(policy.binding)
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
        gate = topology.TopologyGate(authority(clock=clock), Adapter([snapshot()]))
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
        transport.authenticate(policy.binding)
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

    def test_concrete_ip_attempt_source_uses_actual_task8_port_and_inert_syscall_boundary(self):
        module = load('task10_native_probe_contract', 'tests/guest/confinement_probe.py')
        class Context:
            def __init__(self): self.calls, self.closed = [], []
            def syscall(self, number, *args):
                self.calls.append((number, args))
                if number == 198: return 77
                raise OSError(101, 'inert absent route')
            def close(self, fd): self.closed.append(fd)
            def receiver_count(self): return 0
        class Fixtures:
            def __init__(self): self.calls = []
            def run_confined(self, role, operation, callback):
                context = Context(); self.calls.append((role, operation, context))
                return callback(context)
        fixtures = Fixtures()
        source = topology.Task10NativeAttempts(module, module.NativeProbePort(fixtures))
        for identifier in ('BROWSER_IPV4_TCP','BROWSER_IPV6_TCP','BROWSER_UDP',
                           'CONTROLLER_DNS_TCP','CONTROLLER_DNS_UDP','VERIFIER_IPV4_TCP'):
            self.assertEqual(source.execute_native(identifier), result(identifier))
        self.assertEqual([row[0] for row in fixtures.calls],
                         ['BROWSER','BROWSER','BROWSER','CONTROLLER','CONTROLLER','VERIFIER'])
        self.assertTrue(all(row[2].closed == [77] for row in fixtures.calls))
        self.assertEqual(fixtures.calls[1][2].calls[1][1][1][8:24],
                         bytes.fromhex('20010db8000000000000000000000001'))
        with self.assertRaisesRegex(topology.TopologyError, '^NATIVE_HELPER_UNAVAILABLE$'):
            source.execute_native('BROWSER_HELPER_IPV4')

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
        transport.authenticate(policy.binding)
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
                CAPABILITY, json.dumps(wire['payload'], sort_keys=True,
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
        for bad in (snapshot(routes=('default-v4',)), object(), RuntimeError('capture')):
            gate = topology.TopologyGate(authority(clock=Clock((100, 10), (100, 10))), Adapter([bad, snapshot()]))
            with self.subTest(bad=bad), self.assertRaises(topology.TopologyError): gate.admit()
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
            gate = topology.TopologyGate(authority(clock=Clock((100, 10), (100, 10))), Adapter([bad]))
            with self.subTest(bad=bad), self.assertRaises(topology.TopologyError): gate.admit()
            with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_FAILED$'): gate.require_current()

    def test_clock_freshness_sequence_recheck_and_expiry_latch(self):
        recheck = Recheck()
        clock = Clock(*([(100, 10)] * 10), (190, 12))
        gate = topology.TopologyGate(authority(clock=clock, recheck=recheck), Adapter([snapshot(), snapshot()]))
        gate.admit()
        gate.require_current()
        self.assertGreaterEqual(recheck.calls, 4)
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_EXPIRED$'):
            gate.require_current()
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_FAILED$'):
            gate.require_current()

    def test_clock_rollback_or_stale_observation_latches(self):
        for samples, observed in (
            (((100, 10), (99, 11)), (100, 10)),
            (((100, 10), (100, 10)), (98, 8)),
        ):
            bad = dataclasses.replace(snapshot(), observed_wall=observed[0], observed_monotonic=observed[1])
            gate = topology.TopologyGate(authority(clock=Clock(*samples)), Adapter([bad]))
            with self.assertRaises(topology.TopologyError): gate.admit()
            with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_FAILED$'): gate.require_current()

    def test_one_use_browser_activation_uses_task8_handoff(self):
        gate = topology.TopologyGate(authority(clock=Clock((100, 10), (100, 10), (100, 10), (100, 10))),
                                     Adapter([snapshot(), snapshot()]))
        gate.admit(); activation = Activation()
        gate.activate_browser(activation)
        self.assertEqual(activation.calls[0][0].launch.role, 'BROWSER')
        with self.assertRaisesRegex(topology.TopologyError, '^ACTIVATION_DENIED$'):
            gate.activate_browser(activation)

    def test_duplicate_admission_and_drift_during_capture_latch(self):
        gate = topology.TopologyGate(
            authority(clock=Clock(*([(100, 10)] * 8))), Adapter([snapshot(), snapshot()]))
        gate.admit()
        with self.assertRaises(topology.TopologyError): gate.admit()
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_FAILED$'):
            gate.require_current()

        class DriftAdapter:
            gate = None
            def capture(self, sequence, expected):
                self.gate.topology_drifted()
                return dataclasses.replace(snapshot(), sequence=sequence)
        adapter = DriftAdapter()
        gate = topology.TopologyGate(authority(clock=Clock(*([(100, 10)] * 8))), adapter)
        adapter.gate = gate
        with self.assertRaises(topology.TopologyError): gate.admit()
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_FAILED$'): gate.require_current()

    def test_reentrant_activation_calls_effect_once_and_compensates(self):
        gate = topology.TopologyGate(
            authority(clock=Clock(*([(100, 10)] * 16))), Adapter([snapshot(), snapshot()]))
        gate.admit()
        activation = Activation(callback=lambda: self.assertRaises(
            topology.TopologyError, gate.activate_browser, activation))
        with self.assertRaises(topology.TopologyError): gate.activate_browser(activation)
        self.assertEqual(len(activation.calls), 1)
        self.assertEqual(activation.cleaned, 2)

    def test_monotonic_deadline_and_expiry_during_final_recheck_latch(self):
        gate = topology.TopologyGate(
            authority(clock=Clock((100, 10), (100, 1000000))), Adapter([snapshot()]))
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_EXPIRED$'): gate.admit()

    def test_deadline_expiry_inside_validation_and_authorize_denies_without_effect(self):
        clock = Clock(*([(100, 10)] * 20))
        gate = topology.TopologyGate(authority(clock=clock), Adapter([snapshot(), snapshot()]))
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
        gate = topology.TopologyGate(authority(clock=clock), Adapter([snapshot(), snapshot()]))
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
        gate = topology.TopologyGate(authority(clock=clock, recheck=ExpiringRecheck(clock)),
                                     Adapter([snapshot()]))
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
        gate = topology.TopologyGate(authority(recheck=Recheck()), Adapter([snapshot()]), supervisor)
        with self.assertRaises(topology.TopologyError): gate.admit()
        self.assertEqual(supervisor.stops, 1)
        supervisor = Supervisor()
        gate = topology.TopologyGate(authority(), Adapter([snapshot(), RuntimeError('capture')]), supervisor)
        gate.admit()
        with self.assertRaises(topology.TopologyError): gate.require_current()
        self.assertEqual(supervisor.stops, 1)

    def test_partial_and_post_success_activation_cleanup_is_retained(self):
        class Partial(Activation):
            def activate(self, authorize):
                authorize(); self.calls.append(self.pending)
                raise topology.ActivationFailure('CLEANUP_UNCERTAIN', self)
        gate = topology.TopologyGate(authority(clock=Clock(*([(100, 10)] * 30))),
                                     Adapter([snapshot(), snapshot()]))
        gate.admit(); partial = Partial()
        with self.assertRaises(topology.TopologyError): gate.activate_browser(partial)
        self.assertEqual((len(partial.calls), partial.cleaned), (1, 1))

        supervisor = type('Supervisor', (), {
            'begin': lambda self, wire, callback: setattr(self, 'callback', callback) or self,
            'stop_owned': lambda self, deadline: {'status':'STOPPED','run_id':RUN},
        })()
        gate = topology.TopologyGate(authority(clock=Clock(*([(100, 10)] * 30))),
                                     Adapter([snapshot(), snapshot()]), supervisor)
        gate.admit(); activation = Activation(); gate.activate_browser(activation)
        supervisor.callback()
        self.assertEqual(activation.cleaned, 1)

    def test_native_adapter_is_explicit_bounded_and_closes_owned_fds(self):
        empty_network = b'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'
        content = {
            '/proc/net/dev': b'Inter-| Receive\n face |bytes packets errs drop fifo frame compressed multicast\n lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n',
            '/proc/net/route': b'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n',
            '/proc/net/ipv6_route': b'', '/etc/resolv.conf': b'  # none\n',
            '/proc/net/tcp': empty_network + b'0: 0100007F:0C38 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10004 0 123 1 0000000000000000 100 0 0 10 0\n',
            '/proc/net/tcp6': empty_network, '/proc/net/udp': empty_network,
            '/proc/net/udp6': empty_network,
            '/proc/net/unix': b'Num RefCount Protocol Flags Type St Inode Path\n',
        }
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
            envelope['mac'] = __import__('hmac').new(CAPABILITY,
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
        role_runtime = []
        for index, role in enumerate(confinement.UIDS):
            rows = [dict(fd=fd,
                kind='NULL' if fd < 3 else 'COMMAND' if fd == 3 else 'RESULT',
                device='1', inode=str(100 + index * 10 + fd), flags=1 if fd == 4 else 0,
                ownerId=('%x' % (index * 5 + fd + 1))[-1] * 32,
                acquiredGeneration=1) for fd in range(5)]
            if role == 'PROXY':
                rows.append(dict(fd=5,kind='PROXY_LISTENER',device='1',
                    inode='999',flags=0,ownerId='9' * 32,
                    acquiredGeneration=1))
            role_runtime.append(dict(role=role,
                childId=('%x' % (index + 1)) * 32,
                pipeId=('%x' % (index + 5)) * 32,
                lifecycle='SERVICE' if role in ('CONTROLLER','PROXY') else 'WAITING',
                inheritedFDs=[0,1,2,3,4],currentFDs=rows))
        payload['composition'] = dict(binding=binding.to_record(),
            probeEpochDigest='e' * 64,fixtureInventoryDigest='f' * 64,
            eventCheckpoint=dict(binding=binding.to_record(),generation=1,
                sequence=1,sourceIdentity='a' * 32,lostCount=0),
            proxyRuntimeId='b' * 32,roleRuntime=role_runtime)
        def composition_wire(value):
            mac = hmac.new(expected.capability,topology.BOOTSTRAP_HANDOFF_DOMAIN +
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
                envelope['mac']=hmac.new(expected.capability,
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


if __name__ == '__main__':
    unittest.main()

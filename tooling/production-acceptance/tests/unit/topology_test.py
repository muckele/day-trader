"""Task 10 topology composition tests. All effects are inert injected fakes."""
import dataclasses
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest


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


class TopologyTests(unittest.TestCase):
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
        for operation in (lambda: supervisor.begin('wire', lambda: None),
                          lambda: proxy_source.observe(policy),
                          lambda: probes.execute('BROWSER_IPV4_TCP'),
                          lambda: topology.CleanupBudget().call(lambda remaining: source.beginOwned())):
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
        self.assertEqual(json.loads(proof.handoff)['version'], 1)


if __name__ == '__main__':
    unittest.main()

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
    def activate(self, handoff, proof, authorize):
        authorize()
        self.calls.append((handoff, proof))
        if self.callback: self.callback()
        return self
    def stop_owned(self): self.cleaned += 1


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
        clock = Clock(*([(100, 10)] * 8), (190, 12))
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
        self.assertEqual(activation.cleaned, 1)

    def test_monotonic_deadline_and_expiry_during_final_recheck_latch(self):
        gate = topology.TopologyGate(
            authority(clock=Clock((100, 10), (100, 1000000))), Adapter([snapshot()]))
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_EXPIRED$'): gate.admit()
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

    def test_native_adapter_is_explicit_bounded_and_closes_owned_fds(self):
        empty_network = b'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid\n'
        content = {
            '/proc/net/dev': b'Inter-| Receive\n face |bytes packets errs drop fifo frame compressed multicast\n lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n',
            '/proc/net/route': b'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n',
            '/proc/net/ipv6_route': b'', '/etc/resolv.conf': b'  # none\n',
            '/proc/net/tcp': empty_network + b'0: 0100007F:0C38 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10004\n',
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
        header = b'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid\n'
        late = (header +
                b'0: 0100007F:D000 0100007F:0C38 01 0:0 0:0 0 10002\n' +
                b'1: 0100007F:0C38 00000000:0000 0A 0:0 0:0 0 10004\n')
        self.assertEqual(topology._network_rows(late, 'TCP', 4),
                         (topology.Listener('GUEST', 'TCP', '127.0.0.1', 3128, 10004),))
        self.assertEqual(topology._dns(b'\t nameserver\t127.0.0.53 # local\n'), ('127.0.0.53',))
        for malformed in (header + b'junk\n', header + b'0: bad\n'):
            with self.assertRaises(topology.TopologyError):
                topology._network_rows(malformed, 'TCP', 4)

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
            pathlib.Path(path).write_text(proof.handoff, encoding='ascii')
        self.assertEqual(json.loads(proof.handoff)['version'], 1)


if __name__ == '__main__':
    unittest.main()

"""Task 10 topology composition tests. All effects are inert injected fakes."""
import dataclasses
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
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
    def __init__(self): self.calls = []
    def activate(self, handoff, proof): self.calls.append((handoff, proof))


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
        clock = Clock((100, 10), (100, 10), (100, 10), (100, 10), (190, 12))
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

    def test_native_adapter_is_explicit_bounded_and_closes_owned_fds(self):
        class OS:
            def __init__(self): self.opened, self.closed = [], []
            def open(self, path, flags): self.opened.append((path, flags)); return len(self.opened) + 2
            def read(self, fd, limit): return {
                3:b'Inter-| Receive\n lo: 0 0 0\n', 4:b'Iface Destination\n',
                5:b'', 6:b'# none\n',
                7:b'sl local remote state queue timer retr uid\n0: 0100007F:0C38 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10004\n',
                8:b'', 9:b'', 10:b'', 11:b'Num Ref Protocol Flags Type St Inode Path\n'}[fd]
            def close(self, fd): self.closed.append(fd)
        os_port = OS(); a = authority()
        bindings = topology.select_native_topology(
            os_port, role_provider=lambda: snapshot().role_handoffs,
            host_device_provider=lambda: DEVICES,
            probe_port=lambda identifier: result(identifier),
            proxy_provider=lambda: snapshot().proxy_runtime,
            platform_name='linux', machine='aarch64')
        observed = bindings.capture(1, a)
        self.assertEqual(observed.interfaces, ('lo',))
        self.assertEqual(os_port.closed, list(range(3, 12)))
        self.assertEqual(tuple(path for path, _ in os_port.opened), topology.NATIVE_OBSERVATION_PATHS)
        with self.assertRaises(topology.TopologyError):
            topology.select_native_topology(os_port, lambda: (), lambda: (), lambda _: None,
                                            lambda: None, 'darwin', 'arm64')

    def test_export_composition_fixture_for_swift_consumer(self):
        proof = topology.admit_topology(snapshot(), authority(), (100, 10), (100, 10))
        path = os.environ.get('TASK10_TOPOLOGY_OUTPUT')
        if path:
            pathlib.Path(path).write_text(proof.handoff, encoding='ascii')
        self.assertEqual(json.loads(proof.handoff)['version'], 1)


if __name__ == '__main__':
    unittest.main()

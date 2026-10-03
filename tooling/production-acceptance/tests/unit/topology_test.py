"""Offline topology admission tests; every observation is an inert typed fixture."""
import dataclasses
import importlib.util
import pathlib
import re
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    'acceptance_topology', ROOT / 'guest/topology.py')
topology = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = topology
SPEC.loader.exec_module(topology)
GUEST_SPEC = importlib.util.spec_from_file_location(
    'acceptance_guest_topology_probe', ROOT / 'tests/guest/topology_test.py')
guest_probe = importlib.util.module_from_spec(GUEST_SPEC)
sys.modules[GUEST_SPEC.name] = guest_probe
GUEST_SPEC.loader.exec_module(guest_probe)

RUN_ID = '1' * 32
MANIFEST = 'b' * 64
HOST_DEVICES = (
    'LINUX_BOOT', 'VIRTIO_BLOCK_READ_ONLY', 'VIRTIO_ENTROPY',
    'VIRTIO_SERIAL_PRIVATE_PIPE', 'VIRTIO_VSOCK_CID2_PORT4050',
)
PROBE_IDS = (
    'BROWSER_FD_DONOR', 'BROWSER_HELPER_IPV4', 'BROWSER_HELPER_IPV6',
    'BROWSER_IO_URING', 'BROWSER_IPV4_TCP', 'BROWSER_IPV6_TCP',
    'BROWSER_UDP', 'BROWSER_VSOCK', 'CONTROLLER_DNS_TCP',
    'CONTROLLER_DNS_UDP', 'PROXY_VSOCK_CONTROL', 'VERIFIER_IPV4_TCP',
)


def role(name, uid):
    digests = {'BROWSER': '1' * 64, 'CONTROLLER': '2' * 64,
               'PROXY': '3' * 64, 'VERIFIER': '4' * 64}
    return topology.RoleInventory(
        role=name, uid=uid, gids=(uid,), groups=(), capabilities=((),) * 5,
        no_new_privs=1, seccomp=2, fds=(0, 1, 2, 3, 4),
        waiting=True, filter_digest=digests[name],
    )


def probe(identifier):
    allowed = identifier == 'PROXY_VSOCK_CONTROL'
    return topology.ProbeResult(
        identifier=identifier, attempted=True,
        outcome='ALLOWED' if allowed else 'DENIED',
        owned_receiver_count=1 if allowed else 0,
    )


def policy(**changes):
    values = dict(
        run_id=RUN_ID, manifest_identity=MANIFEST, expires_at=190,
        host_devices=HOST_DEVICES,
        role_uids=(('BROWSER', 10002), ('CONTROLLER', 10001),
                   ('PROXY', 10004), ('VERIFIER', 10003)),
        probe_ids=PROBE_IDS,
    )
    values.update(changes)
    return topology.TopologyPolicy(**values)


def snapshot(**changes):
    values = dict(
        run_id=RUN_ID, manifest_identity=MANIFEST, observed_at=100,
        expires_at=190, host_devices=HOST_DEVICES,
        interfaces=('lo',), routes=(), dns_servers=(),
        listeners=(topology.Listener('GUEST', 'TCP', '127.0.0.1', 3128, 10004),),
        abstract_unix=(),
        roles=tuple(sorted((role('CONTROLLER', 10001), role('BROWSER', 10002),
                            role('VERIFIER', 10003), role('PROXY', 10004)),
                           key=lambda value: value.role)),
        probes=tuple(probe(identifier) for identifier in PROBE_IDS),
    )
    values.update(changes)
    return topology.TopologySnapshot(**values)


class TopologyTests(unittest.TestCase):
    # Break: the guest driver omits, duplicates, reorders, or caller-selects probes.
    def test_guest_probe_driver_uses_each_fixed_id_once(self):
        class Port:
            def __init__(self): self.calls = []
            def execute(self, identifier):
                self.calls.append(identifier)
                return 'observed:' + identifier
        port = Port()
        result = guest_probe.execute_fixed_probes(port)
        self.assertEqual(tuple(port.calls), PROBE_IDS)
        self.assertEqual(result, tuple('observed:' + identifier for identifier in PROBE_IDS))

    # Break: any extra interface or default route could restore a direct IP path.
    def test_unexpected_NIC_default_v4_v6_route_DNS_listener_fail_before_prompt(self):
        mutations = (
            {'interfaces': ('eth0', 'lo')},
            {'routes': ('default-v4',)},
            {'routes': ('default-v6',)},
            {'dns_servers': ('127.0.0.53',)},
            {'listeners': snapshot().listeners +
                          (topology.Listener('GUEST', 'UDP', '0.0.0.0', 53, 10001),)},
        )
        for changes in mutations:
            with self.subTest(changes=changes), self.assertRaises(topology.TopologyError):
                topology.admit_topology(snapshot(**changes), policy())

    # Break: absence of the exact guest proxy becomes indistinguishable from confinement.
    def test_missing_proxy_fail(self):
        with self.assertRaisesRegex(topology.TopologyError, '^LISTENER_DENIED$'):
            topology.admit_topology(snapshot(listeners=()), policy())

    # Break: an abstract namespace agent can donate descriptors across role boundaries.
    def test_extra_abstract_UNIX_agent_fail(self):
        with self.assertRaisesRegex(topology.TopologyError, '^ABSTRACT_UNIX_DENIED$'):
            topology.admit_topology(snapshot(abstract_unix=('dbus-agent',)), policy())

    # Break: role admission accepts the wrong identity, missing outer filter, or bridge FD.
    def test_incorrect_uid_seccomp_fd_fail(self):
        admitted = snapshot()
        browser = next(item for item in admitted.roles if item.role == 'BROWSER')
        for replacement in (
            dataclasses.replace(browser, uid=0),
            dataclasses.replace(browser, seccomp=0),
            dataclasses.replace(browser, fds=(0, 1, 2, 3, 4, 9)),
        ):
            roles = tuple(replacement if item.role == 'BROWSER' else item
                          for item in admitted.roles)
            with self.subTest(replacement=replacement), self.assertRaises(topology.TopologyError):
                topology.admit_topology(snapshot(roles=roles), policy())

    # Break: skipped, failed, duplicated, or receiver-observed negative probes count as proof.
    def test_role_probe_failed_or_skipped_fail(self):
        admitted = snapshot()
        first = admitted.probes[0]
        mutations = (
            (dataclasses.replace(first, attempted=False),) + admitted.probes[1:],
            (dataclasses.replace(first, outcome='FAILED'),) + admitted.probes[1:],
            (dataclasses.replace(first, owned_receiver_count=1),) + admitted.probes[1:],
            admitted.probes[:-1],
            admitted.probes + (first,),
        )
        for probes in mutations:
            with self.subTest(probes=probes), self.assertRaises(topology.TopologyError):
                topology.admit_topology(snapshot(probes=probes), policy())

    # Break: a host-loopback listener is treated as the guest-loopback proxy.
    def test_host_listener_not_guest_loopback(self):
        host_only = (topology.Listener('HOST', 'TCP', '127.0.0.1', 3128, 10004),)
        with self.assertRaisesRegex(topology.TopologyError, '^LISTENER_DENIED$'):
            topology.admit_topology(snapshot(listeners=host_only), policy())

    # Break: proof drops the run, manifest, role/device inventory, or finite expiry binding.
    def test_proof_binds_run_manifest_role_device_inventories_and_expiry(self):
        proof = topology.admit_topology(snapshot(), policy())
        self.assertEqual((proof.run_id, proof.manifest_identity, proof.expires_at),
                         (RUN_ID, MANIFEST, 190))
        self.assertRegex(proof.role_inventory_digest, r'^[0-9a-f]{64}$')
        self.assertRegex(proof.device_inventory_digest, r'^[0-9a-f]{64}$')
        self.assertRegex(proof.snapshot_digest, r'^[0-9a-f]{64}$')
        self.assertNotEqual(proof.role_inventory_digest, proof.device_inventory_digest)
        for changed in (
            snapshot(run_id='2' * 32), snapshot(manifest_identity='a' * 64),
            snapshot(expires_at=191), snapshot(observed_at=190),
        ):
            with self.assertRaises(topology.TopologyError):
                topology.admit_topology(changed, policy())

    # Break: a later drift can be followed by a good sample and re-authorize browser work.
    def test_topology_drift_latches_failure(self):
        gate = topology.TopologyGate(policy())
        proof = gate.admit(snapshot())
        self.assertEqual(gate.observe(snapshot()), proof)
        with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_DRIFT$'):
            gate.observe(snapshot(routes=('default-v4',)))
        for later in (snapshot(), snapshot(observed_at=101)):
            with self.assertRaisesRegex(topology.TopologyError, '^TOPOLOGY_FAILED$'):
                gate.observe(later)


if __name__ == '__main__':
    unittest.main()

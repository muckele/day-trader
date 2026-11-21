"""Separately gated native guest topology tests. NOT part of offline discovery.

A reviewed Linux guest harness must supply a native topology port under
separate Stage 2 VM/kernel execution approval. ``select_native_topology_port``
has no native default: it raises RuntimeGateUnavailable, so every test here is
an error (never a pass, never a skip) until that port exists. There is no fake
factory, environment bool or platform auto-selection. The inert driver checks
that used to live here are unit tests (tests/unit/topology_test.py,
InertGuestDriverTests) and are never evidence for this gate.
"""
import importlib.util
import pathlib
import platform
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('task10_guest_topology', ROOT / 'guest/topology.py')
topology = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = topology
spec.loader.exec_module(topology)


class TopologyGuestTests(unittest.TestCase):
    """Plan Task 10 cases, run only through an actual native topology port."""

    def setUp(self):
        # Raises RuntimeGateUnavailable('NATIVE_TOPOLOGY_PORT_UNAVAILABLE').
        self.port = topology.select_native_topology_port(sys.platform, platform.machine())

    def test_kernel_default_topology_admits(self):
        self.port.run_case('kernel_default_topology_admits')

    def test_unexpected_NIC_default_v4_v6_route_DNS_listener_fail_before_prompt(self):
        self.port.run_case('unexpected_NIC_default_v4_v6_route_DNS_listener_fail_before_prompt')

    def test_missing_proxy_fail(self):
        self.port.run_case('missing_proxy_fail')

    def test_extra_abstract_UNIX_agent_fail(self):
        self.port.run_case('extra_abstract_UNIX_agent_fail')

    def test_incorrect_uid_seccomp_fd_fail(self):
        self.port.run_case('incorrect_uid_seccomp_fd_fail')

    def test_role_probe_failed_or_skipped_fail(self):
        self.port.run_case('role_probe_failed_or_skipped_fail')

    def test_host_listener_not_guest_loopback(self):
        self.port.run_case('host_listener_not_guest_loopback')

    def test_topology_drift_latches_failure(self):
        self.port.run_case('topology_drift_latches_failure')


if __name__ == '__main__':
    unittest.main()

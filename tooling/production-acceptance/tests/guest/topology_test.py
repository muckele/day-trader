"""Future guest qualification contract; intentionally has no native default.

The signed guest bootstrap will provide a concrete ``GuestProbePort`` only at
the separately approved VM qualification gate. Importing this file performs no
probe, syscall, socket operation, process launch, or filesystem inspection.
"""
from typing import Protocol
import unittest


FIXED_PROBE_IDS = (
    'BROWSER_FD_DONOR', 'BROWSER_HELPER_IPV4', 'BROWSER_HELPER_IPV6',
    'BROWSER_IO_URING', 'BROWSER_IPV4_TCP', 'BROWSER_IPV6_TCP',
    'BROWSER_UDP', 'BROWSER_VSOCK', 'CONTROLLER_DNS_TCP',
    'CONTROLLER_DNS_UDP', 'PROXY_VSOCK_CONTROL', 'VERIFIER_IPV4_TCP',
)


class GuestProbePort(Protocol):
    """Trusted native adapter with owned receivers and exact role targeting."""
    def execute(self, identifier: str): ...


def execute_fixed_probes(port: GuestProbePort):
    """Request every reviewed probe exactly once; return typed observations."""
    return tuple(port.execute(identifier) for identifier in FIXED_PROBE_IDS)


class GuestTopologyDriverTests(unittest.TestCase):
    """Inert driver coverage; no probe implementation is selected or executed."""
    def test_each_fixed_probe_is_requested_once_in_reviewed_order(self):
        class Port:
            def __init__(self): self.requested = []
            def execute(self, identifier):
                self.requested.append(identifier)
                return ('OBSERVED', identifier)
        port = Port()
        self.assertEqual(execute_fixed_probes(port),
                         tuple(('OBSERVED', item) for item in FIXED_PROBE_IDS))
        self.assertEqual(tuple(port.requested), FIXED_PROBE_IDS)

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
        self.assertEqual(tuple(port.requested), FIXED_PROBE_IDS[:3])


if __name__ == '__main__':
    unittest.main()

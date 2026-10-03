"""Future guest qualification contract; intentionally has no native default.

The signed guest bootstrap will provide a concrete ``GuestProbePort`` only at
the separately approved VM qualification gate. Importing this file performs no
probe, syscall, socket operation, process launch, or filesystem inspection.
"""
from typing import Protocol


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

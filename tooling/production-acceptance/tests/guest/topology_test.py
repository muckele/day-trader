"""Future guest qualification contract; intentionally has no native default.

The signed guest bootstrap will provide a concrete ``GuestProbePort`` only at
the separately approved VM qualification gate. Importing this file performs no
probe, syscall, socket operation, process launch, or filesystem inspection.
"""
from typing import Protocol
import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('task10_guest_topology', ROOT / 'guest/topology.py')
topology = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = topology
spec.loader.exec_module(topology)


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

    def test_explicit_task8_probe_composition_runs_reviewed_prerequisites(self):
        class Module:
            PROBES = {name: object() for name in set(topology.TASK8_PROBE_CASES.values())}
            class NativeProbePort: pass
            called = []
            @staticmethod
            def run_case(name, port): Module.called.append((name, port))
        class Native:
            def __init__(self): self.ids = []
            def execute_native(self, identifier):
                self.ids.append(identifier)
                positive = identifier == 'PROXY_VSOCK_CONTROL'
                return topology.ProbeResult(identifier, True,
                    'ALLOWED' if positive else 'DENIED', 1 if positive else 0)
        port, native = Module.NativeProbePort(), Native()
        source = topology.select_task8_probe_source(Module, port, native, 'linux', 'aarch64')
        values = execute_fixed_probes(source)
        self.assertEqual(tuple(item.identifier for item in values), FIXED_PROBE_IDS)
        self.assertEqual(tuple(native.ids), FIXED_PROBE_IDS)
        self.assertEqual(tuple(name for name, _ in Module.called),
                         tuple(topology.TASK8_PROBE_CASES[item]
                               for item in FIXED_PROBE_IDS
                               if item in topology.TASK8_PROBE_CASES))
        with self.assertRaises(topology.TopologyError):
            topology.select_task8_probe_source(Module, port, native, 'darwin', 'arm64')

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
        bridge = Bridge(); source, activation = topology.select_task8_roles(bridge, object())
        expected = type('Authority', (), {'role_launches': ('launches',)})()
        self.assertEqual(source.collect(expected), ('roles', ('launches',)))
        handoff = type('Handoff', (), {'launch': type('Launch', (), {'role':'BROWSER','run_id':'1' * 32})()})()
        authorized = []
        handle = activation.prepare(handoff, object())
        handle.activate(lambda: authorized.append(True))
        self.assertEqual((authorized, bridge.activated), ([True], 1))
        handle.stop_owned(120000); self.assertEqual(bridge.handle.stops, 1)

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

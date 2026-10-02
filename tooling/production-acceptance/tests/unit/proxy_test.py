"""Offline contract tests: literal wire oracles; no native socket is opened."""
import dataclasses
import importlib.util
import json
import pathlib
import socket
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('acceptance_proxy', ROOT / 'guest/proxy.py')
proxy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = proxy
spec.loader.exec_module(proxy)
VECTORS = json.loads((ROOT / 'contracts/vectors.json').read_text())
# Test-only endpoints from M1 release/control fixtures, never production facts.
HOSTS = {'FRONTEND': 'frontend.example.test', 'BACKEND': 'backend.example.test'}
ORIGINS = tuple((key, 'https://' + value) for key, value in HOSTS.items())
REQUEST = b'CONNECT frontend.example.test:443 HTTP/1.1\r\nHost: frontend.example.test:443\r\n\r\n'
OK = b'HTTP/1.1 200 Connection Established\r\n\r\n'
CONTROL = next(v['canonical'].encode() for v in VECTORS['accepted'] if v['name'] == 'control')


class Clock:
    def __init__(self): self.wall, self.mono = 100, 10
    def sample(self): return self.wall, self.mono
    def wait(self, milliseconds):
        self.wall += milliseconds
        self.mono += milliseconds


class Stream:
    """Exact nonblocking bytes/ancillary boundary, with controllable partial I/O."""
    def __init__(self, data=(), *, partial=4096, ancillary=(), flags=0):
        self.parts = list(data)
        self.partial = partial
        self.ancillary, self.flags = ancillary, flags
        self.written = bytearray()
        self.closes = self.ends = 0
        self.read_bounds, self.write_bounds = [], []
    def read(self, max_bytes):
        self.read_bounds.append(max_bytes)
        if not self.parts: return None
        part = self.parts.pop(0)
        if isinstance(part, Exception): raise part
        if part is None: return None
        if len(part) > max_bytes:
            self.parts.insert(0, part[max_bytes:])
            part = part[:max_bytes]
        return proxy.ChannelMessage(part, self.ancillary, self.flags)
    def write(self, data):
        self.write_bounds.append(len(data))
        if isinstance(self.partial, Exception): raise self.partial
        if self.partial is None: return None
        n = min(self.partial, len(data))
        self.written.extend(data[:n])
        return n
    def end_write(self): self.ends += 1
    def close(self): self.closes += 1


class Listener:
    def __init__(self, clients, endpoint):
        self.clients, self.endpoint, self.closes = list(clients), endpoint, 0
    def accept(self): return self.clients.pop(0) if self.clients else None
    def close(self): self.closes += 1


class Sockets:
    def __init__(self, clients=(), *, complete=True, endpoint=('127.0.0.1', 3128)):
        self.clients = list(clients)
        self.complete, self.endpoint = complete, endpoint
        self.calls, self.listener = [], None
    def listen(self, address, port, backlog):
        self.calls.append((address, port, backlog))
        self.listener = Listener(self.clients, self.endpoint)
        return self.listener
    def stop_requested(self):
        return self.complete and all(c.closes == 1 for c in self.clients)


class Transport:
    def __init__(self, streams=(), *, binding=None, loss_at=None):
        self.streams, self.binding = list(streams), binding
        self.calls, self.closes, self.claims, self.checks = [], 0, 0, 0
        self.loss_at = loss_at
    def authenticate(self, binding):
        self.claims += 1
        if self.claims > 1: raise OSError('one use')
        return self.binding if self.binding is not None else binding
    def check(self):
        self.checks += 1
        if self.loss_at is not None and self.checks >= self.loss_at: raise OSError('lost')
    def open(self, cid, service, binding):
        self.calls.append((cid, service, binding))
        if not self.streams: raise OSError('no stream')
        result = self.streams.pop(0)
        if isinstance(result, Exception): raise result
        return result
    def close(self): self.closes += 1


def config(sockets, clock=None, **changes):
    binding = proxy.RunBinding('1' * 32, b'\x07' * 32, 190, 1,
                               'b' * 64, 'a' * 64, ORIGINS)
    values = dict(destinations=HOSTS.copy(), binding=binding,
                  aggregate_bytes=10000, idle_timeout_ms=20, run_timeout_ms=50,
                  clock=clock or Clock(), sockets=sockets)
    values.update(changes)
    return proxy.ProxyConfig(**values)


class ProxyTests(unittest.TestCase):
    # Break: accepting a broadened target or normalizing ambiguous authority.
    def test_FE_BE_443_accept(self):
        for name, target in [('FRONTEND', 'frontend.example.test'), ('BACKEND', 'backend.example.test')]:
            wire = ('CONNECT ' + target + ':443 HTTP/1.1\r\nHost: ' + target + ':443\r\n\r\n').encode()
            self.assertEqual(proxy.parse_connect(wire, HOSTS), name)

    def test_alternate_host_suffix_dot_IP_port_reject(self):
        for authority in ['frontend.example.test.evil:443', 'frontend.example.test.:443',
                          'FRONTEND.example.test:443', '8.8.8.8:443', '[::1]:443',
                          '[::ffff:127.0.0.1]:443', 'frontend.example.test:0443',
                          'frontend.example.test:8443', 'user@frontend.example.test:443',
                          'https://frontend.example.test:443', 'frontend%2eexample.test:443',
                          'frontend.example.test:443/path', 'frontend.example.test:443#x']:
            with self.subTest(authority=authority), self.assertRaises(proxy.ProxyError):
                proxy.parse_connect(('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n\r\n').encode(), HOSTS)

    def test_duplicate_malformed_oversized_headers_reject(self):
        for wire in [REQUEST.replace(b'\r\n\r\n', b'\r\nHost: frontend.example.test:443\r\n\r\n'),
                     REQUEST.replace(b'Host:', b'Host :'), REQUEST.replace(b'\r\n', b'\n'),
                     REQUEST.replace(b'Host:', b' host:'), REQUEST.replace(b'Host:', b'X-Target:'),
                     REQUEST.replace(b'Host: frontend', b'Host: backend'),
                     REQUEST[:-2], REQUEST + b'extra', REQUEST.replace(b'\r\n\r\n', b'\r\nContent-Length: 0\r\n\r\n'),
                     REQUEST.replace(b'\r\n\r\n', b'\r\nTransfer-Encoding: chunked\r\n\r\n'),
                     REQUEST.replace(b'\r\n\r\n', b'\r\nUser-Agent: ' + b'x' * 4096 + b'\r\n\r\n'),
                     REQUEST.replace(b'Host:', b'Host:\x00'), REQUEST.replace(b'Host:', b'Host:\xff')]:
            with self.subTest(wire=wire[:100]), self.assertRaises(proxy.ProxyError): proxy.parse_connect(wire, HOSTS)

    def test_header_exact_4096_boundary(self):
        wire = REQUEST[:-2] + b'User-Agent: ' + b'x' * (4096 - len(REQUEST) - 14) + b'\r\n\r\n'
        self.assertEqual(len(wire), 4096)
        self.assertEqual(proxy.parse_connect(wire, HOSTS), 'FRONTEND')
        with self.assertRaises(proxy.ProxyError): proxy.parse_connect(wire[:-4] + b'x\r\n\r\n', HOSTS)

    def test_ordinary_HTTP_SOCKS_CONNECT_UDP_reject(self):
        for wire in [b'GET https://frontend.example.test/ HTTP/1.1\r\n\r\n', b'\x05\x01\x00',
                     REQUEST.replace(b'CONNECT ', b'CONNECT-UDP '), REQUEST.replace(b'HTTP/1.1', b'HTTP/2'),
                     REQUEST.replace(b'CONNECT ', b'connect '), REQUEST.replace(b'CONNECT ', b'CONNECT  ')]:
            with self.subTest(wire=wire[:100]), self.assertRaises(proxy.ProxyError): proxy.parse_connect(wire, HOSTS)

    def run_case(self, clients, brokers, **changes):
        sockets = Sockets(clients)
        cfg = config(sockets, **changes)
        transport = Transport(brokers)
        return proxy.serve_proxy(cfg, transport), cfg, sockets, transport

    # Break: sending hostnames, TLS bytes before control, or physical EOF as logical EOF.
    def test_control_vector_fixed_endpoint_and_opaque_EOF_framing(self):
        client = Stream([REQUEST + b'\x16\x03\x01secret', b''])
        broker = Stream([b'\x00\x03\x80\xff\x01\x00\x00'])
        outcome, cfg, sockets, transport = self.run_case([client], [broker])
        self.assertEqual(outcome.code, 'COMPLETE')
        self.assertEqual(bytes(broker.written), len(CONTROL).to_bytes(2, 'big') + CONTROL + b'\x00\x09\x16\x03\x01secret\x00\x00')
        self.assertEqual(bytes(client.written), OK + b'\x80\xff\x01')
        self.assertEqual((client.ends, client.closes, broker.closes), (1, 1, 1))
        self.assertEqual([(cid, port) for cid, port, _ in transport.calls], [(2, 4050)])
        self.assertEqual(outcome.used_bytes, 12)

    def test_partial_header_control_data_and_writes_preserve_bytes(self):
        client = Stream([REQUEST[:7], REQUEST[7:], b'abc', b''], partial=2)
        broker = Stream([b'\x00', b'\x02', b'\x00', b'\xff', b'\x00', b'\x00'], partial=7)
        outcome, _, _, _ = self.run_case([client], [broker], idle_timeout_ms=120000, run_timeout_ms=1000)
        self.assertEqual(outcome.code, 'COMPLETE')
        self.assertEqual(bytes(client.written), OK + b'\x00\xff')
        self.assertEqual(bytes(broker.written), len(CONTROL).to_bytes(2, 'big') + CONTROL + b'\x00\x03abc\x00\x00')
        self.assertLessEqual(max(client.read_bounds + broker.read_bounds + client.write_bounds + broker.write_bounds), 4096)

    def test_listens_127001_only(self):
        sockets, transport = Sockets(), Transport()
        outcome = proxy.serve_proxy(config(sockets), transport)
        self.assertEqual(outcome.code, 'COMPLETE')
        self.assertEqual(sockets.calls, [('127.0.0.1', 3128, 16)])
        for endpoint in [('0.0.0.0', 3128), ('::1', 3128), ('127.0.0.1', 9999)]:
            sockets, transport = Sockets(endpoint=endpoint), Transport()
            outcome = proxy.serve_proxy(config(sockets), transport)
            self.assertEqual(outcome.code, 'LISTENER_DENIED')
            self.assertEqual(sockets.listener.closes, 1)

    def test_no_DNS_api(self):
        client, broker = Stream([REQUEST, b'']), Stream([b'\x00\x00'])
        with patch.object(socket, 'socket', side_effect=AssertionError('real socket')), \
             patch.object(socket, 'getaddrinfo', side_effect=AssertionError('DNS')), \
             patch.object(socket, 'gethostbyname', side_effect=AssertionError('DNS')), \
             patch.object(socket, 'create_connection', side_effect=AssertionError('real connect')):
            outcome, _, _, _ = self.run_case([client], [broker])
        self.assertEqual(outcome.code, 'COMPLETE')

    def test_broker_loss_closes_all_tunnels_latches_failed(self):
        clients, brokers = [Stream([REQUEST]), Stream([REQUEST])], [Stream(), Stream()]
        sockets, transport = Sockets(clients), Transport(brokers, loss_at=8)
        cfg = config(sockets)
        outcome = proxy.serve_proxy(cfg, transport)
        self.assertEqual(outcome.code, 'TRANSPORT_LOST')
        self.assertEqual([c.closes for c in clients + brokers], [1, 1, 1, 1])
        self.assertEqual(sockets.listener.closes, 1)
        self.assertEqual(transport.closes, 1)
        self.assertEqual(proxy.serve_proxy(cfg, transport).code, 'TERMINAL')
        self.assertEqual(len(transport.calls), 2)

    def test_no_retry_or_restart_resume(self):
        client, broker = Stream([REQUEST]), Stream([OSError('lost')])
        outcome, cfg, sockets, transport = self.run_case([client], [broker])
        self.assertEqual(outcome.code, 'TRANSPORT_LOST')
        self.assertEqual(proxy.serve_proxy(cfg, transport).code, 'TERMINAL')
        fresh = config(Sockets([Stream([REQUEST])]))
        self.assertEqual(proxy.serve_proxy(fresh, transport).code, 'IDENTITY_MISMATCH')
        self.assertEqual(len(transport.calls), 1)

    def test_ancillary_fd_reject(self):
        for side in ['client', 'broker']:
            client = Stream([REQUEST], ancillary=((1, 1, b'fd'),) if side == 'client' else ())
            broker = Stream([b'\x00\x00'], ancillary=((1, 1, b'fd'),) if side == 'broker' else ())
            outcome, _, sockets, _ = self.run_case([client], [broker])
            self.assertEqual(outcome.code, 'CHANNEL_DENIED')
            self.assertEqual(client.closes, 1)
            self.assertEqual(sockets.listener.closes, 1)
        for flags in [1, 8, 32, True]:
            outcome, _, _, _ = self.run_case([Stream([REQUEST], flags=flags)], [Stream()])
            self.assertEqual(outcome.code, 'CHANNEL_DENIED')

    def test_capability_run_and_release_binding_mismatch_stops_before_listener(self):
        for field, value in [('capability', b'\x08' * 32), ('run_id', '2' * 32),
                             ('config_identity', 'c' * 64), ('manifest_identity', 'c' * 64),
                             ('first_sequence', 2), ('expires_at', 180),
                             ('origins', (('FRONTEND', 'https://evil.example.test'), ORIGINS[1]))]:
            sockets = Sockets()
            cfg = config(sockets)
            transport = Transport(binding=dataclasses.replace(cfg.binding, **{field: value}))
            self.assertEqual(proxy.serve_proxy(cfg, transport).code, 'IDENTITY_MISMATCH')
            self.assertEqual(sockets.calls, [])

    def test_sequence_controls_do_not_reset_across_tunnels(self):
        clients = [Stream([REQUEST, b'']), Stream([REQUEST.replace(b'frontend', b'backend'), b''])]
        brokers = [Stream([b'\x00\x00']), Stream([b'\x00\x00'])]
        outcome, _, _, _ = self.run_case(clients, brokers)
        self.assertEqual(outcome.code, 'COMPLETE')
        expected = CONTROL.replace(b'FRONTEND', b'BACKEND').replace(b'"sequence":1', b'"sequence":2')
        self.assertEqual(bytes(brokers[1].written), len(expected).to_bytes(2, 'big') + expected + b'\x00\x00')

    def test_seventeenth_live_tunnel_fails_without_opening_bridge(self):
        clients, brokers = [Stream([REQUEST]) for _ in range(17)], [Stream() for _ in range(16)]
        outcome, _, sockets, transport = self.run_case(clients, brokers, idle_timeout_ms=100)
        self.assertEqual(outcome.code, 'CAPACITY')
        self.assertEqual(len(transport.calls), 16)
        self.assertEqual([s.closes for s in clients + brokers], [1] * 33)
        self.assertEqual(sockets.listener.closes, 1)

    def test_aggregate_bytes_counts_both_directions_before_forwarding(self):
        client, broker = Stream([REQUEST + b'abcd']), Stream([b'\x00\x03xyz'])
        outcome, _, _, _ = self.run_case([client], [broker], aggregate_bytes=6)
        self.assertEqual(outcome.code, 'BYTE_LIMIT')
        self.assertEqual(outcome.used_bytes, 4)
        self.assertEqual(bytes(client.written), OK)
        self.assertEqual(bytes(broker.written), len(CONTROL).to_bytes(2, 'big') + CONTROL + b'\x00\x04abcd')

    def test_aggregate_bytes_never_reset_between_completed_tunnels(self):
        # Hold the second CONNECT until the first has completed; common ceiling persists.
        first, second = Stream([REQUEST + b'abcd', b'']), Stream([None] * 8 + [REQUEST + b'xyz', b''])
        brokers = [Stream([b'\x00\x00']), Stream([b'\x00\x00'])]
        outcome, _, _, _ = self.run_case([first, second], brokers, aggregate_bytes=6)
        self.assertEqual(outcome.code, 'BYTE_LIMIT')
        self.assertEqual(outcome.used_bytes, 4)
        self.assertNotIn(b'xyz', bytes(brokers[1].written))

    def test_idle_timeout_incomplete_header_and_pending_write(self):
        for client, broker in [(Stream([b'CON']), Stream()), (Stream([REQUEST]), Stream(partial=None)),
                               (Stream([REQUEST]), Stream([b'\x00']))]:
            outcome, _, sockets, _ = self.run_case([client], [broker], idle_timeout_ms=3)
            self.assertEqual(outcome.code, 'IDLE_TIMEOUT')
            self.assertEqual(client.closes, 1)
            self.assertEqual(sockets.listener.closes, 1)

    def test_run_lifetime_expiry_without_tunnels(self):
        clock, sockets = Clock(), Sockets(complete=False)
        outcome = proxy.serve_proxy(config(sockets, clock, run_timeout_ms=3), Transport())
        self.assertEqual(outcome.code, 'EXPIRED')
        self.assertEqual(clock.mono, 13)
        self.assertEqual(sockets.listener.closes, 1)

    def test_wall_expiry_and_backward_clock_fail_closed(self):
        class JumpClock(Clock):
            def wait(self, milliseconds): self.wall = 190
        class BackwardClock(Clock):
            def wait(self, milliseconds): self.mono = 9
        for clock, code in [(JumpClock(), 'EXPIRED'), (BackwardClock(), 'CLOCK')]:
            sockets = Sockets([Stream([REQUEST])], complete=False)
            transport = Transport([Stream()])
            outcome = proxy.serve_proxy(config(sockets, clock), transport)
            self.assertEqual(outcome.code, code)
            self.assertEqual(sockets.listener.closes, 1)

    def test_physical_EOF_never_counts_as_logical_EOF(self):
        for data in [[b''], [b'\x00', b''], [b'\x00\x02x', b'']]:
            client, broker = Stream([REQUEST]), Stream(data)
            outcome, _, _, _ = self.run_case([client], [broker])
            self.assertEqual(outcome.code, 'TRANSPORT_LOST')
            self.assertEqual((client.closes, broker.closes), (1, 1))

    def test_oversized_broker_record_is_rejected_before_body(self):
        outcome, _, _, _ = self.run_case([Stream([REQUEST])], [Stream([b'\x10\x01forbidden'])])
        self.assertEqual(outcome.code, 'CHANNEL_DENIED')

    def test_zero_invalid_and_failed_writes_latch_failure(self):
        for partial in [0, OSError('write')]:
            client, broker = Stream([REQUEST]), Stream(partial=partial)
            outcome, _, _, transport = self.run_case([client], [broker])
            self.assertEqual(outcome.code, 'TRANSPORT_LOST')
            self.assertEqual((client.closes, broker.closes, transport.closes), (1, 1, 1))

    def test_config_rejects_unvalidated_limits_destinations_and_binding(self):
        for changes in [dict(aggregate_bytes=0), dict(aggregate_bytes=1073741825), dict(aggregate_bytes=True),
                        dict(idle_timeout_ms=120001), dict(idle_timeout_ms=0), dict(run_timeout_ms=1200001),
                        dict(run_timeout_ms=0), dict(destinations={'FRONTEND': HOSTS['FRONTEND']}),
                        dict(destinations={'FRONTEND': HOSTS['FRONTEND'], 'BACKEND': 'evil.example.test'}),
                        dict(destinations={'FRONTEND': '8.8.8.8', 'BACKEND': HOSTS['BACKEND']})]:
            sockets = Sockets()
            outcome = proxy.serve_proxy(config(sockets, **changes), Transport())
            self.assertEqual(outcome.code, 'CONFIG_DENIED')
            self.assertEqual(sockets.calls, [])

    def test_binding_invalid_fields_are_denied(self):
        for field, value in [('run_id', 'owner'), ('capability', b'x'), ('capability', bytearray(32)),
                             ('first_sequence', True), ('first_sequence', 0), ('first_sequence', 9007199254740992),
                             ('manifest_identity', 'z' * 64), ('expires_at', True), ('expires_at', 100)]:
            sockets = Sockets()
            cfg = config(sockets)
            cfg = dataclasses.replace(cfg, binding=dataclasses.replace(cfg.binding, **{field: value}))
            outcome = proxy.serve_proxy(cfg, Transport())
            self.assertEqual(outcome.code, 'CONFIG_DENIED')
            self.assertEqual(sockets.calls, [])

    def test_terminal_phase_or_abort_never_opens_listener(self):
        for phase, event in [('DONE', 'readResult'), ('FAILED', 'cleanup'), ('FINALIZE', 'finalize'),
                             ('PREFLIGHT', 'abort'), ('PREFLIGHT', 'login')]:
            sockets = Sockets()
            outcome = proxy.serve_proxy(config(sockets, phase=phase, event=event), Transport())
            self.assertEqual(outcome.code, 'CONFIG_DENIED')
            self.assertEqual(sockets.calls, [])


if __name__ == '__main__': unittest.main()

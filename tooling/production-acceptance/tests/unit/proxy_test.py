"""Offline contract tests: literal wire oracles; no native socket is opened."""
import dataclasses
import errno
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

    # Independent deadline oracles: equality is expired, and ready data cannot
    # renew an already elapsed idle/run lease.
    def test_idle_and_run_deadlines_precede_late_header_data_broker_and_write(self):
        class DeadlineClock(Clock):
            def __init__(self, jump): super().__init__(); self.jump = jump
            def wait(self, milliseconds): self.wall += self.jump; self.mono += self.jump

        cases = [
            (Stream([b'CON', REQUEST]), Stream(), 'header'),
            (Stream([REQUEST, b'late']), Stream(), 'client'),
            (Stream([REQUEST]), Stream([b'\x00\x04late']), 'broker'),
            (Stream([REQUEST], partial=None), Stream(), 'write'),
        ]
        for client, broker, name in cases:
            with self.subTest(path=name):
                sockets, transport = Sockets([client]), Transport([broker])
                outcome = proxy.serve_proxy(config(sockets, DeadlineClock(20)), transport)
                self.assertEqual(outcome.code, 'IDLE_TIMEOUT')
                self.assertNotIn(b'late', bytes(client.written) + bytes(broker.written))
                self.assertEqual((client.closes, broker.closes,
                                  sockets.listener.closes, transport.closes),
                                 (1, 0 if name == 'header' else 1, 1, 1))

        client, broker = Stream([REQUEST, b'late']), Stream()
        sockets, transport = Sockets([client]), Transport([broker])
        outcome = proxy.serve_proxy(
            config(sockets, DeadlineClock(20), idle_timeout_ms=100, run_timeout_ms=20),
            transport)
        self.assertEqual(outcome.code, 'EXPIRED')
        self.assertNotIn(b'late', broker.written)

    def test_deadline_and_wall_rollback_rechecked_after_fallible_read(self):
        class MutableClock(Clock): pass
        class ClockedStream(Stream):
            def __init__(self, clock, data, change):
                super().__init__(data); self.clock, self.change = clock, change
            def read(self, maximum):
                message = super().read(maximum)
                if self.read_bounds and len(self.read_bounds) == 2:
                    self.change(self.clock)
                return message

        for code, change in [
            ('IDLE_TIMEOUT', lambda clock: setattr(clock, 'mono', 30)),
            ('CLOCK', lambda clock: setattr(clock, 'wall', 99)),
        ]:
            with self.subTest(code=code):
                clock = MutableClock()
                client = ClockedStream(clock, [REQUEST, b'late'], change)
                broker = Stream()
                sockets, transport = Sockets([client]), Transport([broker])
                cfg = config(sockets, clock)
                outcome = proxy.serve_proxy(cfg, transport)
                self.assertEqual(outcome.code, code)
                self.assertNotIn(b'late', broker.written)
                self.assertEqual(proxy.serve_proxy(cfg, transport).code, 'TERMINAL')
                self.assertEqual((client.closes, broker.closes,
                                  sockets.listener.closes, transport.closes), (1, 1, 1, 1))

    def test_deadline_is_rechecked_before_fallible_terminal_decisions(self):
        class DeadlineTransport(Transport):
            def __init__(self, clock, path, streams=()):
                super().__init__(streams); self.clock, self.path = clock, path
            def authenticate(self, binding):
                if self.path == 'authenticate':
                    self.clock.mono = 30
                    raise OSError('late authenticate failure')
                return super().authenticate(binding)
            def check(self):
                if self.path == 'check':
                    self.clock.mono = 30
                    raise OSError('late check failure')
                return super().check()
            def open(self, cid, service, binding):
                if self.path == 'open':
                    self.clock.mono = 30
                    raise OSError('late open failure')
                return super().open(cid, service, binding)

        class DeadlineStream(Stream):
            def __init__(self, clock, path, data=()):
                super().__init__(data); self.clock, self.path = clock, path
            def read(self, maximum):
                if self.path == 'read' and len(self.read_bounds) == 1:
                    self.clock.mono = 30
                    raise OSError('late read failure')
                return super().read(maximum)
            def write(self, data):
                if self.path == 'write':
                    self.clock.mono = 30
                    raise OSError('late write failure')
                return super().write(data)
            def end_write(self):
                if self.path == 'end':
                    self.clock.mono = 30
                    raise OSError('late end failure')
                return super().end_write()

        for path in ('authenticate', 'check'):
            with self.subTest(path=path):
                clock, sockets = Clock(), Sockets(complete=False)
                outcome = proxy.serve_proxy(
                    config(sockets, clock, run_timeout_ms=20),
                    DeadlineTransport(clock, path))
                self.assertEqual(outcome.code, 'EXPIRED')

        for path in ('read', 'write', 'open', 'end'):
            with self.subTest(path=path):
                clock = Clock()
                client = DeadlineStream(clock, path, [REQUEST, b''])
                broker = DeadlineStream(clock, path, [None])
                sockets = Sockets([client])
                transport = DeadlineTransport(clock, path, [broker])
                outcome = proxy.serve_proxy(config(sockets, clock), transport)
                self.assertEqual(outcome.code, 'IDLE_TIMEOUT')
                self.assertEqual((client.closes, broker.closes if path != 'open' else 0,
                                  sockets.listener.closes, transport.closes),
                                 (1, 1 if path != 'open' else 0, 1, 1))

        class DeadlineListener(Listener):
            def __init__(self, clock): super().__init__((), ('127.0.0.1', 3128)); self.clock = clock
            def accept(self):
                self.clock.mono = 30
                raise OSError('late accept failure')
        class DeadlineSockets(Sockets):
            def __init__(self, clock, path): super().__init__(complete=False); self.clock, self.path = clock, path
            def listen(self, address, port, backlog):
                if self.path == 'listen':
                    self.clock.mono = 30
                    raise OSError('late listen failure')
                self.listener = DeadlineListener(self.clock)
                return self.listener
            def stop_requested(self):
                self.clock.mono = 30
                raise OSError('late stop failure')

        for path in ('listen', 'accept'):
            with self.subTest(path=path):
                clock = Clock(); sockets = DeadlineSockets(clock, path)
                outcome = proxy.serve_proxy(
                    config(sockets, clock, run_timeout_ms=20), Transport())
                self.assertEqual(outcome.code, 'EXPIRED')

        class StopSockets(DeadlineSockets):
            def listen(self, address, port, backlog):
                self.listener = Listener((), ('127.0.0.1', 3128))
                return self.listener
        clock = Clock()
        sockets = StopSockets(clock, 'stop')
        outcome = proxy.serve_proxy(
            config(sockets, clock, run_timeout_ms=20), Transport())
        self.assertEqual(outcome.code, 'EXPIRED')

    def test_backward_wall_between_iterations_fails_before_progress(self):
        class WallRollbackClock(Clock):
            def wait(self, milliseconds): self.wall = 99; self.mono += 1
        client, broker = Stream([REQUEST, b'late']), Stream([None, b'\x00\x00'])
        sockets, transport = Sockets([client]), Transport([broker])
        cfg = config(sockets, WallRollbackClock())
        outcome = proxy.serve_proxy(cfg, transport)
        self.assertEqual(outcome.code, 'CLOCK')
        self.assertNotIn(b'late', broker.written)
        self.assertEqual(proxy.serve_proxy(cfg, transport).code, 'TERMINAL')
        self.assertEqual((client.closes, broker.closes,
                          sockets.listener.closes, transport.closes), (1, 1, 1, 1))

    def _bootstrap_wire(self, change=None):
        value = {
            'aggregateBytes': 10000,
            'capability': '07' * 32,
            'configIdentity': 'a' * 64,
            'expiresAt': 190,
            'firstSequence': 1,
            'handoff': {'commandFd': 3, 'confined': True, 'resultFd': 4,
                        'role': 'PROXY', 'uid': 10004, 'waiting': True},
            'idleTimeoutMs': 20,
            'kind': 'PROXY_BOOTSTRAP',
            'manifestIdentity': 'b' * 64,
            'origins': {'BACKEND': 'https://backend.example.test',
                        'FRONTEND': 'https://frontend.example.test'},
            'rolePolicyIdentity': 'c' * 64,
            'runId': '1' * 32,
            'runTimeoutMs': 50,
            'runtimeIdentity': 'd' * 64,
            'version': 1,
        }
        if change: change(value)
        body = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
        return len(body).to_bytes(2, 'big') + body

    def test_inherited_entry_exact_frame_fixed_fds_and_pinned_admission(self):
        class FakeOS:
            def __init__(self, wire):
                self.input=bytearray(wire); self.reads=[]; self.writes=[]; self.output=bytearray(); self.closes=[]
            def read(self, fd, size):
                self.reads.append((fd, size)); part=bytes(self.input[:min(size, 7)]); del self.input[:len(part)]; return part
            def write(self, fd, data):
                count=min(5, len(data)); content=bytes(data[:count])
                self.writes.append((fd, content)); self.output.extend(content); return count
            def close(self, fd): self.closes.append(fd)
        class FakeSocketModule:
            AF_INET=2; AF_VSOCK=40; SOCK_STREAM=1; SOCK_NONBLOCK=2048; SOCK_CLOEXEC=524288
            SOL_SOCKET=1; SO_ERROR=4; SHUT_WR=1; MSG_CTRUNC=8
            @staticmethod
            def CMSG_SPACE(size): return size + 16
            def socket(self, *args): raise AssertionError('native socket must remain inert')
        class FakeSelectorModule:
            EVENT_READ=1; EVENT_WRITE=2
            class DefaultSelector:
                def __init__(self): pass
                def close(self): pass
        class FakeTime:
            def time(self): return .1
            def monotonic(self): return .01
            def sleep(self, seconds): raise AssertionError('runner is injected')

        captured=[]
        def runner(cfg, transport):
            captured.append((cfg, transport)); return proxy.ProxyOutcome('COMPLETE', 7)
        fake_os = FakeOS(self._bootstrap_wire())
        self.assertTrue(hasattr(proxy, 'qualify_native_admission'))
        self.assertTrue(hasattr(proxy, 'admitted_inherited_main'))
        expected_binding=proxy.RunBinding(
            '1'*32, b'\x07'*32, 190, 1, 'b'*64, 'a'*64, ORIGINS)
        validations=[]
        policy=proxy.qualify_native_admission(
            expected_binding, HOSTS.copy(), 10000, 20, 50,
            runtime_identity='d'*64, role_policy_identity='c'*64,
            handoff_validator=lambda role,uid,command_fd,result_fd:
                validations.append((role,uid,command_fd,result_fd)) or True)
        for runtime, validator in [(None, lambda *_: True), ('d'*64, True)]:
            with self.subTest(runtime=runtime, validator=validator), self.assertRaises(proxy.ProxyError):
                proxy.qualify_native_admission(
                    expected_binding, HOSTS.copy(), 10000, 20, 50,
                    runtime_identity=runtime, role_policy_identity='c'*64,
                    handoff_validator=validator)
        bindings = proxy.qualify_native_bindings(
            fake_os, FakeSocketModule(), FakeSelectorModule(), FakeTime(),
            platform_name='linux', machine='aarch64', runner=runner)
        self.assertEqual(proxy.admitted_inherited_main(('--inherited',), bindings, policy), 0)
        self.assertEqual(validations, [('PROXY',10004,3,4)])
        self.assertEqual(bytes(fake_os.output[:8]), b'WAITING\n')
        self.assertEqual({fd for fd, _ in fake_os.reads}, {3})
        self.assertEqual({fd for fd, _ in fake_os.writes}, {4})
        self.assertEqual(fake_os.closes, [3, 4])
        cfg, transport = captured[0]
        self.assertEqual(cfg.destinations, HOSTS)
        self.assertEqual((cfg.aggregate_bytes, cfg.idle_timeout_ms, cfg.run_timeout_ms),
                         (10000, 20, 50))
        self.assertEqual((transport.host_cid, transport.service), (2, 4050))
        result = bytes(fake_os.output[8:])
        size = int.from_bytes(result[:2], 'big')
        self.assertEqual(json.loads(result[2:2+size]), {
            'code':'COMPLETE','kind':'PROXY_RESULT','runId':'1'*32,
            'usedBytes':7,'version':1})

        for mutate in [
            lambda value: value.pop('runtimeIdentity'),
            lambda value: value.__setitem__('runtimeIdentity', 'e' * 64),
            lambda value: value['handoff'].__setitem__('commandFd', 9),
            lambda value: value['handoff'].__setitem__('confined', False),
            lambda value: value.__setitem__('rolePolicyIdentity', 'e' * 64),
            lambda value: value.__setitem__('configIdentity', 'e' * 64),
        ]:
            with self.subTest(mutate=mutate):
                denied_os=FakeOS(self._bootstrap_wire(mutate))
                denied=proxy.qualify_native_bindings(
                    denied_os, FakeSocketModule(), FakeSelectorModule(), FakeTime(),
                    platform_name='linux', machine='aarch64',
                    runner=lambda *_: self.fail('invalid admission reached runner'))
                self.assertEqual(proxy.admitted_inherited_main(
                    ('--inherited',), denied, policy), 1)
                self.assertEqual(denied_os.closes, [3, 4])

        denied_os=FakeOS(self._bootstrap_wire())
        denied_bindings=proxy.qualify_native_bindings(
            denied_os, FakeSocketModule(), FakeSelectorModule(), FakeTime(),
            platform_name='linux', machine='aarch64',
            runner=lambda *_: self.fail('unadmitted handoff reached runner'))
        denied_policy=proxy.qualify_native_admission(
            expected_binding, HOSTS.copy(), 10000, 20, 50,
            runtime_identity='d'*64, role_policy_identity='c'*64,
            handoff_validator=lambda *_: False)
        self.assertEqual(proxy.admitted_inherited_main(
            ('--inherited',), denied_bindings, denied_policy), 1)
        self.assertEqual(denied_os.reads, [])

    def test_task8_waiting_precedes_bootstrap_and_operational_entry_fails_closed(self):
        class HandshakeOS:
            def __init__(self):
                self.input=bytearray(self_wire); self.events=[]; self.output=bytearray()
            def read(self, fd, size):
                self.events.append(('read', fd, size))
                if self.output != b'WAITING\n':
                    raise OSError('Task8 has not published FD3')
                part=bytes(self.input[:size]); del self.input[:len(part)]; return part
            def write(self, fd, data):
                content=bytes(data); self.events.append(('write', fd, content))
                if fd == 4: self.output.extend(content)
                return len(content)
            def close(self, fd): self.events.append(('close', fd))
        class SocketModule:
            AF_INET=2; AF_VSOCK=40; SOCK_STREAM=1; SOCK_NONBLOCK=2048; SOCK_CLOEXEC=524288
            SOL_SOCKET=1; SO_ERROR=4; SHUT_WR=1; MSG_CTRUNC=8
            @staticmethod
            def CMSG_SPACE(size): return size + 16
            def socket(self, *args): raise AssertionError('no native socket')
        class Selectors:
            EVENT_READ=1; EVENT_WRITE=2
            class DefaultSelector: pass
        class Time:
            def time(self): return .1
            def monotonic(self): return .01
            def sleep(self, seconds): raise AssertionError('no wait')

        self_wire=self._bootstrap_wire()
        os_module=HandshakeOS(); invoked=[]
        bindings=proxy.qualify_native_bindings(
            os_module, SocketModule(), Selectors, Time(),
            platform_name='linux', machine='aarch64',
            runner=lambda *_: invoked.append(True) or proxy.ProxyOutcome('COMPLETE'))
        self.assertEqual(proxy.inherited_main(('--inherited',), bindings), 1)
        self.assertEqual(os_module.events[0], ('write', 4, b'WAITING\n'))
        self.assertEqual(os_module.output, b'WAITING\n')
        self.assertFalse(any(event[0] == 'read' for event in os_module.events))
        self.assertEqual(invoked, [])

    def test_native_entry_gate_and_socket_adapters_use_only_fixed_arguments(self):
        class Endpoint:
            def __init__(self, family, kind, protocol):
                self.created=(family,kind,protocol); self.calls=[]; self.closes=0
                self.recv=(b'x', (), 0, None); self.error=0
            def setsockopt(self,*args): self.calls.append(('setsockopt',args))
            def setblocking(self,value): self.calls.append(('setblocking',value))
            def bind(self,address): self.calls.append(('bind',address))
            def listen(self,backlog): self.calls.append(('listen',backlog))
            def getsockname(self): return ('127.0.0.1',3128)
            def accept(self): return Endpoint(2,1,0), ('127.0.0.1',40000)
            def recvmsg(self,*args): self.calls.append(('recvmsg',args)); return self.recv
            def send(self,data): self.calls.append(('send',bytes(data))); return len(data)
            def shutdown(self,how): self.calls.append(('shutdown',how))
            def connect_ex(self,address): self.calls.append(('connect_ex',address)); return 0
            def getsockopt(self,*args): return self.error
            def close(self): self.closes += 1
        class SocketModule:
            AF_INET=2; AF_VSOCK=40; SOCK_STREAM=1; SOCK_NONBLOCK=2048; SOCK_CLOEXEC=524288
            SOL_SOCKET=1; SO_ERROR=4; SHUT_WR=1; MSG_CTRUNC=8
            def __init__(self): self.created=[]
            @staticmethod
            def CMSG_SPACE(size): return size + 16
            def socket(self,*args): endpoint=Endpoint(*args); self.created.append(endpoint); return endpoint
        class Selector:
            EVENT_READ=1; EVENT_WRITE=2
            class DefaultSelector:
                def __init__(self): self.calls=[]
                def register(self,*args): self.calls.append(('register',args))
                def select(self,*args): self.calls.append(('select',args)); return ((object(),2),)
                def close(self): self.calls.append(('close',))
        module=SocketModule()
        sockets=proxy.NativeSockets(module, Selector, stop_fd=3, os_module=object())
        listener=sockets.listen('127.0.0.1',3128,16)
        self.assertEqual(module.created[0].created, (2, 1|2048|524288, 0))
        self.assertIn(('bind',('127.0.0.1',3128)), module.created[0].calls)
        self.assertIn(('listen',16), module.created[0].calls)
        with self.assertRaises(proxy.ProxyError): sockets.listen('0.0.0.0',3128,16)

        stream=listener.accept(); stream.socket.recv=((b'x'), ((1,1,b'fd'),), 0, None)
        with self.assertRaises(Exception): stream.read(4096)
        stream.socket.recv=(b'x', (), 8, None)
        with self.assertRaises(Exception): stream.read(4096)
        stream.socket.send_limit=1
        original_send=stream.socket.send
        stream.socket.send=lambda data: min(stream.socket.send_limit, original_send(data))
        self.assertEqual(stream.write(b'abc'), 1)
        binding=config(Sockets()).binding
        transport=proxy.NativeVsockTransport(module, Selector, binding, 2, 4050)
        self.assertIs(transport.authenticate(binding), binding)
        with self.assertRaises(OSError): transport.authenticate(binding)
        native=transport.open(2,4050,binding)
        self.assertEqual(module.created[-1].created, (40, 1|2048|524288, 0))
        self.assertIn(('connect_ex',(2,4050)), module.created[-1].calls)
        with self.assertRaises(proxy.ProxyError): transport.open(3,4050,binding)
        native.close(); listener.close(); transport.close()
        self.assertTrue(all(endpoint.closes == 1 for endpoint in module.created))

        empty=type('NoEffects',(),{'reads':[]})()
        self.assertEqual(proxy.inherited_main((), empty), 64)
        with self.assertRaises(proxy.ProxyError):
            proxy.qualify_native_bindings(
                object(), module, Selector, object(), platform_name='darwin',
                machine='arm64', runner=lambda *_: None)

    def test_native_stop_probe_accepts_only_fixed_task8_command_or_clean_eof(self):
        class ReadySelector:
            EVENT_READ=1
            class DefaultSelector:
                def register(self, *args): pass
                def select(self, timeout): return ((object(), 1),)
                def close(self): pass
        class StopOS:
            def __init__(self, parts): self.parts=list(parts); self.reads=[]
            def read(self, fd, size):
                self.reads.append((fd, size))
                return self.parts.pop(0)

        stop_os=StopOS([b'ST', b'OP'])
        sockets=proxy.NativeSockets(object(), ReadySelector, stop_fd=3, os_module=stop_os)
        self.assertFalse(sockets.stop_requested())
        self.assertTrue(sockets.stop_requested())
        self.assertEqual(stop_os.reads, [(3, 4), (3, 2)])

        eof_os=StopOS([b''])
        self.assertTrue(proxy.NativeSockets(
            object(), ReadySelector, stop_fd=3, os_module=eof_os).stop_requested())
        for denied in ([b'NO'], [b'S', b'']):
            with self.subTest(denied=denied):
                denied_sockets=proxy.NativeSockets(
                    object(), ReadySelector, stop_fd=3, os_module=StopOS(denied))
                with self.assertRaises(OSError):
                    while not denied_sockets.stop_requested(): pass

    def test_pending_native_connect_never_blocks_the_shared_serve_loop(self):
        selected=[]
        class Endpoint:
            def __init__(self): self.closes=0
            def setblocking(self, value): pass
            def connect_ex(self, address): return errno.EINPROGRESS
            def getsockopt(self, level, option): return 0
            def send(self, data): return len(data)
            def close(self): self.closes += 1
        class SocketModule:
            AF_VSOCK=40; SOCK_STREAM=1; SOCK_NONBLOCK=2048; SOCK_CLOEXEC=524288
            SOL_SOCKET=1; SO_ERROR=4
            def __init__(self): self.endpoint=Endpoint()
            def socket(self, *args): return self.endpoint
        class Selectors:
            EVENT_WRITE=2
            class DefaultSelector:
                def register(self, *args): pass
                def select(self, seconds): selected.append(seconds); return ((object(), 2),)
                def close(self): pass
        binding=config(Sockets()).binding
        transport=proxy.NativeVsockTransport(SocketModule(), Selectors, binding, 2, 4050, 20)
        transport.authenticate(binding)
        stream=transport.open(2,4050,binding)
        self.assertEqual(selected, [])
        self.assertEqual(stream.write(b'x'), 1)
        self.assertEqual(selected, [0])
        self.assertFalse(stream.closed)
        transport.close()

    def test_native_cleanup_attempts_every_resource_and_retries_only_unresolved(self):
        created=[]
        class FailingSelectorModule:
            EVENT_READ=1; EVENT_WRITE=2
            class DefaultSelector:
                def __init__(self): self.attempts=0; created.append(self)
                def register(self, *args): raise OSError('register')
                def close(self): self.attempts += 1
        sockets=proxy.NativeSockets(object(), FailingSelectorModule, stop_fd=3, os_module=object())
        with self.assertRaises(OSError): sockets.stop_requested()
        self.assertEqual(created[0].attempts, 1)

        binding=config(Sockets()).binding
        transport=proxy.NativeVsockTransport(object(), object(), binding, 2, 4050)
        class Closing:
            def __init__(self, failures): self.failures=failures; self.attempts=0; self.closed=0
            def close(self):
                self.attempts += 1; self.closed += 1
                if self.attempts <= self.failures: raise OSError('close')
        first, second, third=Closing(1), Closing(0), Closing(1)
        transport.streams=[first,second,third]
        with self.assertRaises(OSError): transport.close()
        self.assertEqual((first.attempts,second.attempts,third.attempts), (1,1,1))
        self.assertFalse(transport.closed)
        transport.close()
        self.assertEqual((first.attempts,second.attempts,third.attempts), (2,1,2))
        self.assertTrue(transport.closed)

        class ObservableClosing(Closing):
            def __init__(self, failures): super().__init__(failures); self.proven_closed=False
            def close(self): super().close(); self.proven_closed=True
        listener, selector=ObservableClosing(1), Closing(1)
        sockets=proxy.NativeSockets(object(), object(), stop_fd=3, os_module=object())
        sockets.listener=listener; sockets.listener_closed=False
        sockets.stop_selector=selector; sockets.stop_selector_closed=False
        with self.assertRaises(OSError): sockets.close()
        self.assertEqual((listener.attempts,selector.attempts), (1,1))
        self.assertFalse(sockets.closed)
        sockets.close()
        self.assertEqual((listener.attempts,selector.attempts), (2,2))
        self.assertTrue(sockets.closed)

    def test_listener_setup_retains_endpoint_when_compensating_close_fails(self):
        class Endpoint:
            def __init__(self, failures=1, permanent=False):
                self.failures=failures; self.permanent=permanent; self.attempts=0
            def setblocking(self, value): pass
            def bind(self, address): raise OSError('bind')
            def close(self):
                self.attempts += 1
                if self.permanent or self.attempts <= self.failures: raise OSError('close')
        class SocketModule:
            AF_INET=2; SOCK_STREAM=1; SOCK_NONBLOCK=2048; SOCK_CLOEXEC=524288
            def __init__(self, endpoint): self.endpoint=endpoint
            def socket(self, *args): return self.endpoint
        class Closing:
            def __init__(self, failures): self.failures=failures; self.attempts=0
            def close(self):
                self.attempts += 1
                if self.attempts <= self.failures: raise OSError('close')

        endpoint=Endpoint()
        sockets=proxy.NativeSockets(SocketModule(endpoint), object(), stop_fd=3, os_module=object())
        with self.assertRaises(OSError):
            sockets.listen('127.0.0.1',3128,16)
        self.assertEqual(endpoint.attempts, 1)
        self.assertTrue(proxy._cleanup_resources((sockets,)))
        self.assertEqual(endpoint.attempts, 2)
        self.assertTrue(proxy._cleanup_resources((sockets,)))
        self.assertEqual(endpoint.attempts, 2)

        closed=Endpoint(failures=0)
        sockets=proxy.NativeSockets(SocketModule(closed), object(), stop_fd=3, os_module=object())
        with self.assertRaises(OSError): sockets.listen('127.0.0.1',3128,16)
        self.assertTrue(proxy._cleanup_resources((sockets,)))
        self.assertEqual(closed.attempts, 1)

        unresolved=Endpoint(permanent=True); selector=Closing(1)
        sockets=proxy.NativeSockets(SocketModule(unresolved), object(), stop_fd=3, os_module=object())
        sockets.stop_selector=selector; sockets.stop_selector_closed=False
        with self.assertRaises(OSError):
            sockets.listen('127.0.0.1',3128,16)
        self.assertFalse(proxy._cleanup_resources((sockets,)))
        self.assertEqual(unresolved.attempts, 3)
        self.assertEqual(selector.attempts, 2)
        self.assertFalse(sockets.closed)

    def test_accept_setup_retains_child_when_compensating_close_fails(self):
        class Child:
            def __init__(self, failures=1, permanent=False):
                self.failures=failures; self.permanent=permanent; self.attempts=0
            def setblocking(self, value): raise OSError('setblocking')
            def close(self):
                self.attempts += 1
                if self.permanent or self.attempts <= self.failures: raise OSError('close')
        class Parent:
            def __init__(self, child, failures=0):
                self.child=child; self.failures=failures; self.attempts=0
            def accept(self): return self.child, ('127.0.0.1',40000)
            def close(self):
                self.attempts += 1
                if self.attempts <= self.failures: raise OSError('close')

        child=Child(); parent=Parent(child); listener=proxy.NativeListener(parent, object())
        with self.assertRaises(OSError): listener.accept()
        self.assertEqual(child.attempts, 1)
        self.assertTrue(proxy._cleanup_resources((listener,)))
        self.assertEqual((child.attempts,parent.attempts), (2,1))
        self.assertTrue(proxy._cleanup_resources((listener,)))
        self.assertEqual((child.attempts,parent.attempts), (2,1))

        child=Child(failures=0); parent=Parent(child)
        listener=proxy.NativeListener(parent, object())
        with self.assertRaises(OSError): listener.accept()
        self.assertTrue(proxy._cleanup_resources((listener,)))
        self.assertEqual((child.attempts,parent.attempts), (1,1))

        child=Child(permanent=True); parent=Parent(child, failures=1)
        listener=proxy.NativeListener(parent, object())
        with self.assertRaises(OSError): listener.accept()
        self.assertFalse(proxy._cleanup_resources((listener,)))
        self.assertEqual((child.attempts,parent.attempts), (3,2))
        self.assertFalse(listener.closed)


if __name__ == '__main__': unittest.main()

"""Offline contract tests: literal wire oracles; no native socket is opened."""
import dataclasses
import copy
import errno
import hashlib
import hmac
import importlib.util
import json
import pathlib
import socket
import sys
import types
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


BACKEND_REQUEST = REQUEST.replace(b'frontend', b'backend')
# T9-1: the CONNECT shape Chromium's proxy client sends (brief literal; test-only hosts).
CHROMIUM_HOSTS = {'FRONTEND': 'fe.example.test', 'BACKEND': 'be.example.test'}
CHROMIUM_CONNECT = (b'CONNECT fe.example.test:443 HTTP/1.1\r\nHost: fe.example.test:443\r\n'
                    b'Proxy-Connection: keep-alive\r\nUser-Agent: Mozilla/5.0 (X11; Linux aarch64)\r\n\r\n')
# One schema-valid denial per pinned inherited-frame field (T9-4).
FRAME_FIELD_DENIALS = (
    ('runId', '2' * 32), ('capability', '08' * 32), ('expiresAt', 191), ('firstSequence', 2),
    ('manifestIdentity', 'e' * 64), ('configIdentity', 'e' * 64),
    ('origins', {'BACKEND': 'https://backend.example.test', 'FRONTEND': 'https://other.example.test'}),
    ('aggregateBytes', 9999), ('idleTimeoutMs', 21), ('runTimeoutMs', 51))


def control(destination='FRONTEND', sequence=1):
    """The literal Task 1 control vector, re-targeted; length-prefixed as on the wire."""
    value = CONTROL.replace(b'FRONTEND', destination.encode()).replace(
        b'"sequence":1', b'"sequence":' + str(sequence).encode())
    return len(value).to_bytes(2, 'big') + value


def connect_result(wire, hosts):
    """parse_connect's destination, or its rejection code, so a rejection is an assertion failure."""
    try:
        return proxy.parse_connect(wire, hosts)
    except proxy.ProxyError as error:
        return 'REJECTED:' + str(error)


def oserror(code):
    """Inert OSError carrying exactly one errno (Python maps it to its subclass)."""
    return OSError(code, 'inert ' + errno.errorcode[code])


class FaultStream(Stream):
    """Raises a chosen inert error on the nth call of one operation; optional failing close."""
    def __init__(self, data=(), *, faults=None, close_error=None, **kwargs):
        super().__init__(data, **kwargs)
        self.faults, self.counts, self.close_error = dict(faults or {}), {}, close_error
    def _fault(self, operation):
        self.counts[operation] = self.counts.get(operation, 0) + 1
        error = self.faults.get((operation, self.counts[operation]))
        if error is not None: raise error
    def read(self, max_bytes):
        self._fault('read'); return super().read(max_bytes)
    def write(self, data):
        self._fault('write'); return super().write(data)
    def end_write(self):
        self._fault('end'); return super().end_write()
    def close(self):
        super().close()
        if self.close_error is not None: raise self.close_error


class TickClock(Clock):
    """Calls on_tick(n) after the nth 1 ms loop wait; the loop's only sleep."""
    def __init__(self, on_tick=None):
        super().__init__(); self.ticks = 0; self.on_tick = on_tick
    def wait(self, milliseconds):
        super().wait(milliseconds); self.ticks += 1
        if self.on_tick: self.on_tick(self.ticks)


class CountingListener(Listener):
    def __init__(self, clients, endpoint):
        super().__init__(clients, endpoint); self.accepts = 0
    def accept(self):
        self.accepts += 1; return super().accept()


class CountingSockets(Sockets):
    """Counts accept() calls; stop_requested() is supplied by the test."""
    def __init__(self, clients, stop):
        super().__init__(clients, complete=False); self.stop = stop
    def listen(self, address, port, backlog):
        self.calls.append((address, port, backlog))
        self.listener = CountingListener(self.clients, self.endpoint)
        return self.listener
    def stop_requested(self): return self.stop()


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

    def test_idle_incomplete_header_and_pending_write_close_only_that_tunnel(self):
        for name, client, broker, opened in [
                ('header', Stream([b'CON']), Stream(), 0),
                ('pending-write', Stream([REQUEST]), Stream(partial=None), 1),
                ('partial-record', Stream([REQUEST]), Stream([b'\x00']), 1)]:
            with self.subTest(path=name):
                outcome, _, sockets, transport = self.run_case([client], [broker], idle_timeout_ms=3)
                self.assertNotEqual(outcome.code, 'IDLE_TIMEOUT')
                self.assertEqual(outcome.code, 'COMPLETE')
                self.assertEqual((client.closes, broker.closes, len(transport.calls)), (1, opened, opened))
                self.assertEqual((sockets.listener.closes, transport.closes), (1, 1))

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
                # T9-2: the idle deadline closes only this tunnel; the run then stops normally.
                self.assertEqual(outcome.code, 'COMPLETE')
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
            ('COMPLETE', lambda clock: setattr(clock, 'mono', 30)),   # idle: per-tunnel close (T9-2)
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
            # mono 30: idle (20) has elapsed; the run (50) has not, unless run_timeout_ms is 20.
            for run_timeout, code in ((50, 'TRANSPORT_LOST'), (20, 'EXPIRED')):
                with self.subTest(path=path, run_timeout=run_timeout):
                    clock = Clock()
                    client = DeadlineStream(clock, path, [REQUEST, b''])
                    broker = DeadlineStream(clock, path, [None])
                    sockets = Sockets([client])
                    transport = DeadlineTransport(clock, path, [broker])
                    outcome = proxy.serve_proxy(config(sockets, clock, run_timeout_ms=run_timeout), transport)
                    self.assertEqual(outcome.code, code)
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

    # ---- Task 5: T9-1 Chromium CONNECT shape.
    def chromium_config(self, sockets, clock=None, **changes):
        binding = dataclasses.replace(config(Sockets()).binding, origins=tuple(
            (name, 'https://' + host) for name, host in CHROMIUM_HOSTS.items()))
        return config(sockets, clock, destinations=CHROMIUM_HOSTS.copy(), binding=binding, **changes)

    def test_chromium_connect_with_proxy_connection_keep_alive_accepted(self):
        self.assertEqual(connect_result(CHROMIUM_CONNECT, CHROMIUM_HOSTS), 'FRONTEND')
        backend = CHROMIUM_CONNECT.replace(b'fe.example.test', b'be.example.test')
        self.assertEqual(connect_result(backend, CHROMIUM_HOSTS), 'BACKEND')
        # Optional and order-independent, like Host and User-Agent.
        reordered = (b'CONNECT fe.example.test:443 HTTP/1.1\r\nProxy-Connection: keep-alive\r\n'
                     b'Host: fe.example.test:443\r\n\r\n')
        self.assertEqual(connect_result(reordered, CHROMIUM_HOSTS), 'FRONTEND')
        # The serving loop admits it end to end: one control, the 200, opaque bytes, logical EOF.
        client, broker = Stream([CHROMIUM_CONNECT + b'\x16\x03\x01', b'']), Stream([b'\x00\x01\x17\x00\x00'])
        sockets, transport = Sockets([client]), Transport([broker])
        outcome = proxy.serve_proxy(self.chromium_config(sockets), transport)
        self.assertEqual(outcome.code, 'COMPLETE')
        self.assertEqual(bytes(broker.written), control() + b'\x00\x03\x16\x03\x01\x00\x00')
        self.assertEqual(bytes(client.written), OK + b'\x17')
        self.assertEqual(len(transport.calls), 1)

    def test_proxy_connection_variants_rejected(self):
        self.assertEqual(connect_result(CHROMIUM_CONNECT, CHROMIUM_HOSTS), 'FRONTEND')
        line = b'Proxy-Connection: keep-alive\r\n'
        variants = {
            'duplicate': CHROMIUM_CONNECT.replace(line, line + line),
            'close': CHROMIUM_CONNECT.replace(line, b'Proxy-Connection: close\r\n'),
            'lowercase-name': CHROMIUM_CONNECT.replace(line, b'proxy-connection: keep-alive\r\n'),
            'proxy-authorization': CHROMIUM_CONNECT.replace(line, b'Proxy-Authorization: Basic AAAA\r\n'),
            'connection': CHROMIUM_CONNECT.replace(line, b'Connection: keep-alive\r\n'),
            'value-case': CHROMIUM_CONNECT.replace(line, b'Proxy-Connection: Keep-Alive\r\n'),
            'trailing-space': CHROMIUM_CONNECT.replace(line, b'Proxy-Connection: keep-alive \r\n'),
            'no-space': CHROMIUM_CONNECT.replace(line, b'Proxy-Connection:keep-alive\r\n'),
            'plus-connection': CHROMIUM_CONNECT.replace(line, line + b'Connection: keep-alive\r\n'),
        }
        for name, wire in variants.items():
            with self.subTest(variant=name), self.assertRaisesRegex(proxy.ProxyError, '^INVALID_CONNECT$'):
                proxy.parse_connect(wire, CHROMIUM_HOSTS)
        # In the serving loop a rejected variant is a protocol violation: the whole run latches.
        client, broker = Stream([variants['duplicate']]), Stream()
        sockets, transport = Sockets([client]), Transport([broker])
        outcome = proxy.serve_proxy(self.chromium_config(sockets), transport)
        self.assertEqual(outcome.code, 'CHANNEL_DENIED')
        self.assertEqual((transport.calls, client.closes), ([], 1))

    # ---- Task 5: T9-2 per-tunnel events stay local.
    def test_idle_tunnel_closes_only_itself_and_run_continues(self):
        clock, closed_at = Clock(), {}
        class Recorded(Stream):
            def __init__(self, name, data): super().__init__(data); self.name = name
            def close(self): super().close(); closed_at.setdefault(self.name, clock.mono)
        idle, idle_broker = Recorded('idle', [REQUEST + b'abc']), Recorded('idle-broker', [])
        active = Recorded('active', [BACKEND_REQUEST] + [b'x'] * 60 + [b''])
        active_broker = Recorded('active-broker', [b'\x00\x01y'] * 60 + [b'\x00\x00'])
        sockets, transport = Sockets([idle, active]), Transport([idle_broker, active_broker])
        outcome = proxy.serve_proxy(config(sockets, clock, run_timeout_ms=1000), transport)
        self.assertEqual(outcome.code, 'COMPLETE')
        self.assertEqual([s.closes for s in (idle, idle_broker, active, active_broker)], [1, 1, 1, 1])
        # A (last progress at mono 10, idle 20) closed at its own deadline, client and vsock
        # together, while B kept exchanging bytes and finished much later.
        self.assertEqual((closed_at['idle'], closed_at['idle-broker']), (30, 30))
        self.assertGreater(closed_at['active'], 60)
        self.assertEqual(bytes(idle_broker.written), control() + b'\x00\x03abc')
        self.assertEqual(bytes(active.written), OK + b'y' * 60)
        self.assertEqual(bytes(active_broker.written), control('BACKEND', 2) + b'\x00\x01x' * 60 + b'\x00\x00')
        # Bytes stay charged: A's 3 bytes count with B's 120.
        self.assertEqual(outcome.used_bytes, 3 + 60 + 60)
        self.assertEqual((sockets.listener.closes, transport.closes, len(transport.calls)), (1, 1, 2))

    def test_client_eof_before_header_closes_only_that_client(self):
        other, broker = Stream([REQUEST, None, None, b'']), Stream([None, None, b'\x00\x01z\x00\x00'])
        quiet, partial = Stream([b'']), Stream([REQUEST[:10], b''])
        outcome, _, sockets, transport = self.run_case([other, quiet, partial], [broker],
                                                       idle_timeout_ms=1000, run_timeout_ms=1000)
        self.assertEqual(outcome.code, 'COMPLETE')
        self.assertEqual([s.closes for s in (other, quiet, partial, broker)], [1, 1, 1, 1])
        self.assertEqual(len(transport.calls), 1, 'no vsock for a client that never sent a header')
        self.assertEqual(bytes(quiet.written) + bytes(partial.written), b'')
        self.assertEqual(bytes(other.written), OK + b'z')
        self.assertEqual(bytes(broker.written), control() + b'\x00\x00')
        self.assertEqual(outcome.used_bytes, 1)

    def test_write_after_client_close_closes_only_that_tunnel(self):
        # Reviewer probe2: the browser closed a pooled tunnel; the server's late record
        # (TLS close_notify) is written after the client's EOF and gets EPIPE.
        class ClosedPeer(Stream):
            eof = False
            def read(self, max_bytes):
                message = super().read(max_bytes)
                if message is not None and message.data == b'': self.eof = True
                return message
            def write(self, data):
                if self.eof: raise BrokenPipeError(errno.EPIPE, 'inert EPIPE')
                return super().write(data)
        closing = ClosedPeer([REQUEST, None, None, b''])
        closing_broker = Stream([None] * 6 + [b'\x00\x05\x15\x03\x03\x00\x02', b'\x00\x00'])
        other = Stream([BACKEND_REQUEST] + [None] * 10 + [b''])
        other_broker = Stream([None] * 10 + [b'\x00\x01w\x00\x00'])
        outcome, _, sockets, transport = self.run_case(
            [closing, other], [closing_broker, other_broker], idle_timeout_ms=1000, run_timeout_ms=1000)
        self.assertEqual(outcome.code, 'COMPLETE')
        self.assertEqual([s.closes for s in (closing, closing_broker, other, other_broker)], [1, 1, 1, 1])
        self.assertEqual(bytes(closing.written), OK)
        self.assertEqual(bytes(closing_broker.written), control() + b'\x00\x00')
        self.assertEqual(bytes(other.written), OK + b'w')
        self.assertEqual(outcome.used_bytes, 5 + 1, 'the undelivered late record stays charged')

    def p36_case(self, op, code):
        """Tunnel A fails on the client socket with errno CODE at OP; tunnel B completes."""
        error = oserror(code)
        if op == 'read-header':
            a, a_broker, charged = Stream([REQUEST[:7], error]), None, 0
        elif op == 'read-tunnel':
            a, a_broker, charged = Stream([REQUEST + b'ab', error]), Stream(), 2
        elif op == 'write-ok':
            a, a_broker, charged = FaultStream([REQUEST], faults={('write', 1): error}), Stream(), 0
        elif op == 'write-data':
            a, a_broker, charged = FaultStream([REQUEST], faults={('write', 2): error}), Stream([b'\x00\x03xyz']), 3
        else:  # shutdown of the client write side after the broker's logical EOF
            a, a_broker, charged = FaultStream([REQUEST], faults={('end', 1): error}), Stream([b'\x00\x02xy\x00\x00']), 2
        b, b_broker = Stream([BACKEND_REQUEST + b'q', None, b'']), Stream([None, b'\x00\x01r\x00\x00'])
        return a, a_broker, b, b_broker, charged

    def test_client_reset_pipe_or_notconn_closes_only_that_tunnel(self):
        for code in (errno.ECONNRESET, errno.EPIPE, errno.ENOTCONN):
            for op in ('read-header', 'read-tunnel', 'write-ok', 'write-data', 'shutdown'):
                with self.subTest(errno=errno.errorcode[code], op=op):
                    a, a_broker, b, b_broker, charged = self.p36_case(op, code)
                    brokers = [s for s in (a_broker, b_broker) if s is not None]
                    outcome, _, sockets, transport = self.run_case(
                        [a, b], brokers, idle_timeout_ms=1000, run_timeout_ms=1000)
                    self.assertEqual(outcome.code, 'COMPLETE')
                    self.assertEqual([s.closes for s in [a] + brokers + [b]], [1] * (len(brokers) + 2))
                    sequence = len(brokers)
                    self.assertEqual(bytes(b_broker.written),
                                     control('BACKEND', sequence) + b'\x00\x01q\x00\x00')
                    self.assertEqual(bytes(b.written), OK + b'r')
                    self.assertEqual(outcome.used_bytes, charged + 2, 'bytes stay charged')
                    self.assertEqual((sockets.listener.closes, transport.closes), (1, 1))
        # The tunnel's vsock stream needs a proven close; a failed one is whole-run uncertainty.
        b, b_broker = Stream([BACKEND_REQUEST] + [None] * 5), Stream()
        a = Stream([REQUEST + b'ab', oserror(errno.ECONNRESET)])
        a_broker = FaultStream(close_error=OSError('inert unresolved vsock close'))
        outcome, _, sockets, _ = self.run_case([b, a], [b_broker, a_broker],
                                               idle_timeout_ms=1000, run_timeout_ms=1000)
        self.assertEqual(outcome.code, 'CLEANUP_UNCERTAIN')
        self.assertEqual((a.closes, b.closes, b_broker.closes, sockets.listener.closes), (1, 1, 1, 1))
        self.assertEqual(a_broker.closes, 2, 'only the unresolved vsock close is retried, once')

    def test_other_client_errno_still_latches(self):
        for code in (errno.EBADF, errno.EINVAL, None):
            for op in ('read-header', 'read-tunnel', 'write-ok', 'write-data', 'shutdown'):
                with self.subTest(errno=errno.errorcode.get(code), op=op):
                    a, a_broker, b, b_broker, _ = self.p36_case(op, errno.ECONNRESET)
                    error = oserror(code) if code is not None else OSError('inert, no errno')
                    if isinstance(a, FaultStream):
                        a.faults = {key: error for key in a.faults}
                    else:
                        a.parts = [error if isinstance(part, Exception) else part for part in a.parts]
                    # The bystander opens first, so a whole-run latch must close its vsock too.
                    bystander, bystander_broker = Stream([BACKEND_REQUEST] + [None] * 5), Stream()
                    brokers = [s for s in (bystander_broker, a_broker) if s is not None]
                    outcome, _, sockets, _ = self.run_case(
                        [bystander, a], brokers, idle_timeout_ms=1000, run_timeout_ms=1000)
                    self.assertEqual(outcome.code, 'TRANSPORT_LOST')
                    self.assertEqual([s.closes for s in [a, bystander] + brokers], [1] * (2 + len(brokers)))
        # The vsock side never uses the client set: these errnos on the broker stream are loss.
        for name, broker in [
                ('read-ECONNRESET', Stream([None, oserror(errno.ECONNRESET)])),
                ('write-EPIPE', FaultStream(faults={('write', 1): oserror(errno.EPIPE)})),
                ('shutdown-ENOTCONN', FaultStream([None, None], faults={('end', 1): oserror(errno.ENOTCONN)}))]:
            with self.subTest(vsock=name):
                client = Stream([REQUEST, None, b''])
                outcome, _, _, _ = self.run_case([client], [broker], idle_timeout_ms=1000, run_timeout_ms=1000)
                self.assertEqual(outcome.code, 'TRANSPORT_LOST')
                self.assertEqual((client.closes, broker.closes), (1, 1))

    def test_whole_run_latch_kept_for_transport_protocol_caps_and_clock(self):
        class BackwardAt3(Clock):
            waits = 0
            def wait(self, milliseconds):
                super().wait(milliseconds); self.waits += 1
                if self.waits == 3: self.mono -= 2
        cases = [
            ('vsock-loss:check', dict(loss_at=3), [REQUEST], Stream(), {}, 'TRANSPORT_LOST'),
            ('vsock-loss:physical-eof', {}, [REQUEST], Stream([None, b'']), {}, 'TRANSPORT_LOST'),
            ('vsock-loss:read-error', {}, [REQUEST], Stream([None, OSError('inert vsock loss')]), {}, 'TRANSPORT_LOST'),
            ('protocol:oversized-record', {}, [REQUEST], Stream([None, b'\x10\x01x']), {}, 'CHANNEL_DENIED'),
            ('protocol:ancillary', {}, [REQUEST], Stream([None, b'x'], ancillary=((1, 1, b'fd'),)), {}, 'CHANNEL_DENIED'),
            ('protocol:connect', {}, [None, None, b'GET / HTTP/1.1\r\n\r\n'], None, {}, 'CHANNEL_DENIED'),
            ('aggregate-cap', {}, [REQUEST, None, b'abcd'], Stream(), dict(aggregate_bytes=3), 'BYTE_LIMIT'),
            ('run-expiry', {}, [REQUEST], Stream(), dict(run_timeout_ms=5), 'EXPIRED'),
            ('clock-fault', {}, [REQUEST], Stream(), dict(clock=BackwardAt3()), 'CLOCK'),
        ]
        for name, transport_options, a_parts, a_broker, changes, code in cases:
            with self.subTest(cause=name):
                a = Stream(a_parts)
                b, b_broker = Stream([BACKEND_REQUEST] + [None] * 10), Stream()
                brokers = [s for s in (a_broker, b_broker) if s is not None]
                sockets, transport = Sockets([a, b], complete=False), Transport(brokers, **transport_options)
                settings = dict(idle_timeout_ms=1000, run_timeout_ms=1000); settings.update(changes)
                cfg = config(sockets, **settings)
                outcome = proxy.serve_proxy(cfg, transport)
                self.assertEqual(outcome.code, code)
                # Whole run: the healthy bystander tunnel B is closed with it.
                self.assertEqual([s.closes for s in [a, b] + brokers], [1] * (2 + len(brokers)))
                self.assertEqual((sockets.listener.closes, transport.closes), (1, 1))
                self.assertEqual(proxy.serve_proxy(cfg, transport).code, 'TERMINAL')

    def test_per_tunnel_close_rechecks_transport_first(self):
        # P37: a transport fault visible when a tunnel would close on its own is whole-run.
        class ArmedTransport(Transport):
            armed = False
            def check(self):
                super().check()
                if self.armed: raise OSError('inert vsock loss seen at the per-tunnel close')
        class DisarmingClock(Clock):
            transport = None
            def wait(self, milliseconds):
                super().wait(milliseconds); self.transport.armed = False
        class Arming(Stream):
            """On read number AT: optionally make the transport fault visible, and advance the clock."""
            def __init__(self, data, transport, clock, at, advance, arm):
                super().__init__(data)
                self.transport, self.clock, self.at, self.advance, self.arm = transport, clock, at, advance, arm
            def read(self, max_bytes):
                if len(self.read_bounds) + 1 == self.at:
                    if self.arm: self.transport.armed = True
                    self.clock.mono += self.advance
                return super().read(max_bytes)
        for name, parts, at, advance in [('eof-before-header', [b''], 1, 0),
                                         ('client-reset', [REQUEST, oserror(errno.ECONNRESET)], 2, 0),
                                         ('idle', [REQUEST[:7], None], 2, 20)]:
            for arm in (True, False):
                with self.subTest(close=name, armed=arm):
                    clock, transport = DisarmingClock(), ArmedTransport([Stream()])
                    clock.transport = transport
                    client = Arming(parts, transport, clock, at, advance, arm)
                    sockets = Sockets([client])
                    outcome = proxy.serve_proxy(config(sockets, clock, run_timeout_ms=1000), transport)
                    # Armed: the fault is visible at the close itself (the loop-top check had passed).
                    self.assertEqual(outcome.code, 'TRANSPORT_LOST' if arm else 'COMPLETE')
                    self.assertEqual(client.closes, 1)

    def test_vsock_failure_after_idle_deadline_latches_not_absorbed(self):
        # P37: a vsock-side failure observed after the tunnel's idle deadline is loss; the idle
        # deadline only discards late *data*. Client-socket failures follow P36.
        def late(stream_type, clock, **kwargs):
            class Late(stream_type):
                def read(self, max_bytes):
                    if len(self.read_bounds) == 1: clock.mono += 25
                    return super().read(max_bytes)
            return Late(**kwargs)
        cases = [
            ('vsock-read-error', 'broker', [None, OSError('inert vsock loss')], 'TRANSPORT_LOST'),
            ('vsock-physical-eof', 'broker', [None, b''], 'TRANSPORT_LOST'),
            ('client-other-errno', 'client', [REQUEST, oserror(errno.EBADF)], 'TRANSPORT_LOST'),
            ('client-reset', 'client', [REQUEST, oserror(errno.ECONNRESET)], 'COMPLETE'),
            ('vsock-late-data', 'broker', [None, b'\x00\x04late'], 'COMPLETE'),
        ]
        for name, side, parts, code in cases:
            with self.subTest(case=name):
                clock = Clock()
                if side == 'broker':
                    a, a_broker = Stream([REQUEST, None, None]), late(Stream, clock, data=parts)
                else:
                    a, a_broker = late(Stream, clock, data=parts), Stream()
                sockets, transport = Sockets([a]), Transport([a_broker])
                outcome = proxy.serve_proxy(config(sockets, clock, run_timeout_ms=1000), transport)
                self.assertEqual(outcome.code, code)
                self.assertNotIn(b'late', bytes(a.written))
                self.assertEqual((a.closes, a_broker.closes, transport.closes), (1, 1, 1))
        # A vsock write failure after the idle deadline is loss as well.
        clock = Clock()
        class LateFailingWrite(Stream):
            def write(self, data):
                clock.mono += 25; raise OSError('inert vsock write loss')
        a, a_broker = Stream([REQUEST]), LateFailingWrite()
        outcome = proxy.serve_proxy(config(Sockets([a]), clock, run_timeout_ms=1000), Transport([a_broker]))
        self.assertEqual(outcome.code, 'TRANSPORT_LOST')

    def test_protocol_violation_read_across_idle_deadline_latches_whole_run(self):
        # Fix round 1 (review I-1): bytes read across a tunnel's idle deadline are discarded,
        # never forwarded or charged, but a protocol violation in them (with the bytes already
        # buffered) is still a whole-run cause. Valid late bytes stay a per-tunnel idle close.
        def late(clock, parts, at):
            class Late(Stream):
                def read(self, max_bytes):
                    if len(self.read_bounds) + 1 == at: clock.mono += 25   # straddles idle (20)
                    return super().read(max_bytes)
            return Late(parts)
        # (name, late side, parts, expected outcome, client bytes, vsock opened, used bytes)
        cases = [
            # The reviewer's four probe cases.
            ('broker:oversized-record', 'broker', [None, b'\x10\x01x'], 'CHANNEL_DENIED', OK, 1, 0),
            ('broker:bytes-after-logical-eof', 'broker', [None, b'\x00\x00x'], 'CHANNEL_DENIED', OK, 1, 0),
            ('client:non-connect', 'client', [None, b'GET / HTTP/1.1\r\n\r\n'], 'CHANNEL_DENIED', b'', 0, 0),
            ('client:header-over-4096', 'client', [None, b'C' * 4096], 'CHANNEL_DENIED', b'', 0, 0),
            # The violation needs the bytes buffered before the deadline as well.
            ('broker:oversized-split', 'broker', [b'\x10', b'\x01x'], 'CHANNEL_DENIED', OK, 1, 0),
            ('broker:after-eof-split', 'broker', [b'\x00\x01y\x00', b'\x00x'], 'CHANNEL_DENIED', OK + b'y', 1, 1),
            ('client:non-connect-split', 'client', [b'GET / HTTP/1.1\r\n', b'\r\n'], 'CHANNEL_DENIED', b'', 0, 0),
            ('client:over-4096-split', 'client', [b'C' * 4000, b'C' * 96], 'CHANNEL_DENIED', b'', 0, 0),
            # Controls: valid late bytes are discarded by a per-tunnel close; the run continues.
            ('control:broker-record', 'broker', [None, b'\x00\x04late'], 'COMPLETE', OK, 1, 0),
            ('control:broker-logical-eof', 'broker', [None, b'\x00\x02la\x00\x00'], 'COMPLETE', OK, 1, 0),
            ('control:client-connect', 'client', [None, REQUEST], 'COMPLETE', b'', 0, 0),
            ('control:client-partial-header', 'client', [REQUEST[:7], REQUEST[7:20]], 'COMPLETE', b'', 0, 0),
            ('control:client-tunnel-data', 'client', [REQUEST, b'late'], 'COMPLETE', OK, 1, 0),
        ]
        for name, side, parts, code, client_bytes, opened, used in cases:
            with self.subTest(case=name):
                clock = Clock()
                if side == 'broker':
                    client, broker = Stream([REQUEST, None, None]), late(clock, parts, 2)
                else:
                    client, broker = late(clock, parts, 2), Stream()
                sockets, transport = Sockets([client]), Transport([broker])
                outcome = proxy.serve_proxy(config(sockets, clock, run_timeout_ms=1000), transport)
                self.assertEqual(outcome.code, code)
                self.assertEqual(bytes(client.written), client_bytes)
                self.assertEqual(len(transport.calls), opened)
                if opened:
                    self.assertEqual(bytes(broker.written), control(), 'late bytes never forwarded')
                self.assertEqual(outcome.used_bytes, used, 'late bytes never charged')
                self.assertEqual((client.closes, broker.closes, sockets.listener.closes, transport.closes),
                                 (1, opened, 1, 1))

    # ---- Task 5: capacity (P35 deferral, 1024 per-run cap).
    def test_seventeenth_concurrent_connection_deferred_not_latched(self):
        self.assertEqual(proxy._MAX_TUNNELS, 16)
        # (1) Fake loop: one live tunnel frees its slot after the 17th has waited.
        slot = Stream([None] * 20 + [b''])               # header phase; EOF at its 21st read
        live = [Stream([REQUEST]) for _ in range(15)]
        seventeenth, seventeenth_broker = Stream([REQUEST, b'']), Stream([b'\x00\x00'])
        brokers = [Stream() for _ in range(15)] + [seventeenth_broker]
        snapshots = []
        sockets = CountingSockets([slot] + live + [seventeenth], stop=lambda: seventeenth.closes == 1)
        clock = TickClock(lambda tick: snapshots.append(
            (tick, sockets.listener.accepts, len(sockets.listener.clients), slot.closes)))
        transport = Transport(brokers)
        outcome = proxy.serve_proxy(config(sockets, clock, idle_timeout_ms=1000, run_timeout_ms=1000), transport)
        self.assertEqual(outcome.code, 'COMPLETE')
        at_capacity = [s for s in snapshots if s[1] == 16 and s[3] == 0]
        self.assertGreaterEqual(len(at_capacity), 4)
        # Deferred: while 16 are live, accept() is never called (no spin on a readable
        # listener; the loop still sleeps once per iteration) and the 17th stays queued.
        self.assertTrue(all(s[2] == 1 for s in at_capacity))
        self.assertEqual([s[1] for s in snapshots[:16]], list(range(1, 17)))
        first_after = next(s for s in snapshots if s[3] == 1)
        self.assertEqual(first_after[1], 16, 'no accept in the iteration that freed the slot')
        self.assertEqual(sockets.listener.accepts, 17)
        self.assertEqual(len(transport.calls), 16)
        self.assertEqual(bytes(seventeenth_broker.written), control('FRONTEND', 16) + b'\x00\x00')
        self.assertEqual([s.closes for s in [slot] + live + [seventeenth] + brokers], [1] * 33)
        self.assertEqual((sockets.listener.closes, transport.closes), (1, 1))

        # (2) STOP while at capacity is serviced at once; the deferred client is never accepted.
        live = [Stream([REQUEST]) for _ in range(16)]
        deferred, brokers = Stream([REQUEST]), [Stream() for _ in range(16)]
        clock = TickClock()
        sockets = CountingSockets(live + [deferred], stop=lambda: clock.ticks >= 20)
        outcome = proxy.serve_proxy(config(sockets, clock, idle_timeout_ms=1000, run_timeout_ms=1000),
                                    Transport(brokers))
        self.assertEqual(outcome.code, 'COMPLETE')
        self.assertEqual((sockets.listener.accepts, deferred.read_bounds, deferred.closes), (16, [], 0))
        self.assertEqual([s.closes for s in live + brokers], [1] * 32)
        self.assertEqual(sockets.listener.closes, 1)

        # (3) Production path: the actual composition loop, FD ledger and native adapters.
        state = dict(iteration=0, stop=False, accepts=[], snapshots=[])
        slot, seventeenth = [], [REQUEST]
        def sink(h, owner):
            h.clients.extend([slot] + [[REQUEST] for _ in range(15)] + [seventeenth])
            rows = owner._context._inventory.rows
            endpoint, selector = owner._listener.socket, owner._sockets.stop_selector
            original_accept, original_select = endpoint.accept, selector.select
            def accept():
                state['accepts'].append((state['iteration'],
                    sum(row['kind'] == 'PROXY_ACCEPTED_STREAM' for row in rows.values())))
                return original_accept()
            endpoint.accept = accept
            # FD3 stays quiet until the test asks for STOP.
            selector.select = lambda timeout: [row for row in original_select(timeout)
                                               if state['stop'] or row[0].fd != 3]
        h = CompositionHarness(self, commands=[b'STOP'], sink=sink, limits=(1000, 1000))
        def tick():
            state['iteration'] += 1; i = state['iteration']
            state['snapshots'].append((i, len(h.clients), h.budget.deadline))
            if i == 20: slot.append(b'')                 # EOF before header frees one slot
            if i == 23: state['stop'] = True
        h.on_sleep = tick
        h.run(); self.assertEqual(len(h.owners), 1)
        self.assertEqual([i for i, _ in state['accepts']], list(range(16)) + [21])
        self.assertTrue(all(live < 16 for _, live in state['accepts']), 'accept() called at capacity')
        self.assertEqual([n for i, n, _ in state['snapshots'] if 16 <= i <= 21], [1] * 6)
        self.assertEqual(state['snapshots'][21][1], 0)
        self.assertEqual({deadline for _, _, deadline in state['snapshots']}, {None},
                         'a per-tunnel close never starts the shared cleanup budget')
        self.assertEqual((h.exit, h.frames[-1]['payload']['code'], h.frames[-1]['payload']['cleanupStatus']),
                         (0, 'COMPLETE', 'PROVEN'))
        self.assertEqual(sum(e.family == 40 for e in h.endpoints), 16)
        self.assertTrue(all(e.closes == 1 for e in h.endpoints))

    def test_total_tunnels_per_run_bounded_at_1024(self):
        self.assertEqual(getattr(proxy, '_MAX_TUNNELS_PER_RUN', None), 1024)
        ceiling = proxy._MAX_SAFE_INTEGER - (1024 - 1)
        class Sequential(Listener):
            """Hands out the next client only after every earlier one has closed."""
            def __init__(self, clients): super().__init__(clients, ('127.0.0.1', 3128)); self.given = []
            def accept(self):
                if not self.clients or any(c.closes == 0 for c in self.given): return None
                self.given.append(self.clients.pop(0)); return self.given[-1]
        class SequentialSockets(Sockets):
            def listen(self, address, port, backlog):
                self.calls.append((address, port, backlog)); self.listener = Sequential(self.clients)
                return self.listener
            def stop_requested(self): return False
        clients = [Stream([REQUEST, b'']) for _ in range(1025)]
        brokers = [Stream([b'\x00\x00']) for _ in range(1024)]
        sockets, transport = SequentialSockets(clients), Transport(brokers)
        binding = dataclasses.replace(config(Sockets()).binding, expires_at=10 ** 12, first_sequence=ceiling)
        cfg = config(sockets, binding=binding, idle_timeout_ms=1000, run_timeout_ms=1200000)
        outcome = proxy.serve_proxy(cfg, transport)
        self.assertEqual(outcome.code, 'CAPACITY')
        self.assertEqual(len(transport.calls), 1024, 'the 1025th CONNECT never opens a vsock')
        self.assertEqual(bytes(brokers[-1].written), control('FRONTEND', proxy._MAX_SAFE_INTEGER) + b'\x00\x00')
        self.assertEqual((bytes(clients[-1].written), clients[-1].closes), (b'', 1))
        self.assertTrue(all(s.closes == 1 for s in clients + brokers))
        self.assertEqual((sockets.listener.closes, transport.closes), (1, 1))
        self.assertEqual(proxy.serve_proxy(cfg, transport).code, 'TERMINAL')
        # The firstSequence ceiling admits exactly 1024 sequences, at every entry point.
        for value, code in ((ceiling, 'COMPLETE'), (ceiling + 1, 'CONFIG_DENIED')):
            with self.subTest(first_sequence=value):
                sockets = Sockets()
                cfg = config(sockets, binding=dataclasses.replace(binding, first_sequence=value))
                self.assertEqual(proxy.serve_proxy(cfg, Transport()).code, code)
        self.assertEqual(proxy._BOOTSTRAP_RULE['fields']['firstSequence']['max'], ceiling)
        admit = lambda first: proxy.qualify_native_admission(
            dataclasses.replace(binding, first_sequence=first), HOSTS.copy(), 10000, 20, 50,
            runtime_identity='d' * 64, role_policy_identity='c' * 64, handoff_validator=lambda *_: True)
        self.assertEqual(admit(ceiling).binding.first_sequence, ceiling)
        with self.assertRaisesRegex(proxy.ProxyError, '^ADMISSION_DENIED$'): admit(ceiling + 1)

    # ---- Task 5: T9-6 STOP or FD3 EOF ends admission at once.
    def test_stop_or_eof_stops_new_admission_in_every_mode(self):
        # Legacy loop: STOP at the 2nd check while a tunnel is live; a client at the 5th accept.
        class Scheduled(Listener):
            def __init__(self, schedule):
                super().__init__((), ('127.0.0.1', 3128)); self.schedule, self.accepts = schedule, 0
            def accept(self):
                self.accepts += 1; return self.schedule.pop(self.accepts, None)
        class StopSockets(Sockets):
            def __init__(self, schedule, stop_at):
                super().__init__(complete=False); self.schedule, self.stop_at, self.checks = schedule, stop_at, 0
            def listen(self, address, port, backlog):
                self.calls.append((address, port, backlog)); self.listener = Scheduled(self.schedule)
                return self.listener
            def stop_requested(self):
                self.checks += 1; return self.checks >= self.stop_at
        first, late = Stream([REQUEST]), Stream([REQUEST + b'after-stop'])
        brokers = [Stream(), Stream()]
        sockets, transport = StopSockets({1: first, 5: late}, 2), Transport(brokers)
        outcome = proxy.serve_proxy(config(sockets, idle_timeout_ms=1000, run_timeout_ms=1000), transport)
        self.assertEqual(outcome.code, 'COMPLETE')
        self.assertEqual((sockets.listener.accepts, len(transport.calls), late.read_bounds), (2, 1, []))
        self.assertNotIn(b'after-stop', bytes(brokers[1].written))
        self.assertEqual((first.closes, brokers[0].closes, sockets.listener.closes), (1, 1, 1))

        # Native legacy and composition loops: STOP and FD3 EOF, with a client still queued.
        for mode in ('legacy', 'composition'):
            for commands in ([b'STOP'], []):
                with self.subTest(mode=mode, signal='STOP' if commands else 'EOF'):
                    if mode == 'legacy':
                        h = CompositionHarness(self)
                        h.clients = [[REQUEST], [REQUEST + b'after-stop']]
                        h.run(legacy=True, legacy_commands=list(commands))
                        self.assertEqual((h.exit, h.frames[-1]['code']), (0, 'COMPLETE'))
                    else:
                        sink = lambda h, owner: h.clients.extend([[REQUEST], [REQUEST + b'after-stop']])
                        h = CompositionHarness(self, commands=list(commands), sink=sink)
                        h.run()
                        self.assertEqual(h.frames[-1]['payload']['code'], 'COMPLETE')
                    # The first client was admitted and its vsock opened before STOP/EOF; the
                    # queued one never was, and nothing after STOP reached a vsock.
                    self.assertEqual(h.clients, [[REQUEST + b'after-stop']])
                    vsocks = [e for e in h.endpoints if e.family == 40]
                    self.assertEqual(len(vsocks), 1)
                    self.assertNotIn(b'after-stop', bytes(vsocks[0].sent))
                    self.assertTrue(all(e.closes == 1 for e in h.endpoints))

    # ---- Task 5: T9-5 serving-loop header bound.
    def test_serving_loop_header_without_terminator_denied_at_4096(self):
        for parts in ([b'C' * 4096], [b'C' * 2048, b'C' * 2048], [b'C' * 4096, b'D' * 4096]):
            with self.subTest(reads=[len(p) for p in parts]):
                client = Stream(parts)
                outcome, _, sockets, transport = self.run_case([client], [Stream()],
                                                               idle_timeout_ms=1000, run_timeout_ms=1000)
                self.assertEqual(outcome.code, 'CHANNEL_DENIED')
                self.assertEqual((transport.calls, bytes(client.written)), ([], b''))
                self.assertEqual((client.closes, sockets.listener.closes, transport.closes), (1, 1, 1))
        # One byte under the limit is still an incomplete header, not a denial.
        client = Stream([b'C' * 4095])
        outcome, _, _, transport = self.run_case([client], [Stream()], idle_timeout_ms=5)
        self.assertEqual((outcome.code, transport.calls, client.closes), ('COMPLETE', [], 1))

    def test_serving_loop_header_split_across_reads_crossing_4096(self):
        exact = REQUEST[:-2] + b'User-Agent: ' + b'x' * (4096 - len(REQUEST) - 14) + b'\r\n\r\n'
        over = exact[:-4] + b'x\r\n\r\n'
        self.assertEqual((len(exact), len(over)), (4096, 4097))
        for split in (1, 2048, 4092, 4095):
            with self.subTest(accepted_split=split):
                client, broker = Stream([exact[:split], exact[split:], b'']), Stream([b'\x00\x00'])
                outcome, _, _, transport = self.run_case([client], [broker], idle_timeout_ms=1000)
                self.assertEqual(outcome.code, 'COMPLETE')
                self.assertEqual(bytes(broker.written), control() + b'\x00\x00')
        for parts in ([b'C' * 4000, b'C' * 96], [b'C' * 4000, b'C' * 200], [over[:3000], over[3000:]],
                      [over[:4096], over[4096:]], [b'C' * 3, b'C' * 4093]):
            with self.subTest(denied=[len(p) for p in parts]):
                client = Stream(parts)
                outcome, _, sockets, transport = self.run_case([client], [Stream()], idle_timeout_ms=1000)
                self.assertEqual(outcome.code, 'CHANNEL_DENIED')
                self.assertEqual((transport.calls, client.closes, sockets.listener.closes), ([], 1, 1))

    # ---- Task 5: T9-10 cases C and M.
    def test_bytes_after_logical_eof_latch(self):
        for record in (b'\x00\x00x', b'\x00\x02ab\x00\x00\x00', b'\x00\x00\x00\x00'):
            with self.subTest(record=record):
                client, broker = Stream([REQUEST, None, b'']), Stream([None, record])
                outcome, _, sockets, transport = self.run_case([client], [broker], idle_timeout_ms=1000)
                self.assertEqual(outcome.code, 'CHANNEL_DENIED')
                self.assertEqual(bytes(client.written), OK, 'nothing from a record with trailing bytes')
                self.assertEqual((client.closes, broker.closes, sockets.listener.closes), (1, 1, 1))

    def native_vsock(self, *, so_errors=(), ready=True):
        """Inert AF_VSOCK adapter: pending connect, readiness, and SO_ERROR per created socket."""
        created = []
        class Endpoint:
            def __init__(self, *args):
                self.args, self.closes, self.sent = args, 0, bytearray()
                self.error = so_errors[len(created)] if len(created) < len(so_errors) else 0
                created.append(self)
            def setblocking(self, value): pass
            def connect_ex(self, address): return errno.EINPROGRESS
            def getsockopt(self, level, option): return self.error
            def send(self, data): self.sent.extend(data); return len(data)
            def recvmsg(self, size, ancillary): raise BlockingIOError()
            def shutdown(self, how): pass
            def close(self): self.closes += 1
        class SocketModule:
            AF_VSOCK = 40; SOCK_STREAM = 1; SOCK_NONBLOCK = 2048; SOCK_CLOEXEC = 524288
            SOL_SOCKET = 1; SO_ERROR = 4; SHUT_WR = 1
            @staticmethod
            def CMSG_SPACE(size): return size + 16
            def socket(self, *args): return Endpoint(*args)
        class Selectors:
            EVENT_WRITE = 2
            class DefaultSelector:
                def register(self, *args): pass
                def select(self, timeout): return ((object(), 2),) if ready else ()
                def close(self): pass
        return SocketModule(), Selectors, created

    def test_async_vsock_so_error_latches(self):
        module, selectors, created = self.native_vsock(so_errors=(errno.ECONNREFUSED,))
        binding = config(Sockets()).binding
        transport = proxy.NativeVsockTransport(module, selectors, binding, 2, 4050, 20, clock=Clock())
        transport.authenticate(binding)
        stream = transport.open(2, 4050, binding)
        with self.assertRaises(OSError) as raised: stream.write(b'x')
        self.assertEqual(raised.exception.errno, errno.ECONNREFUSED)
        self.assertEqual(bytes(created[0].sent), b'')
        transport.close()
        # In the serving loop the asynchronous connect error is vsock loss: the whole run
        # latches, the bystander's connected vsock closes too, and nothing is sent on it.
        module, selectors, created = self.native_vsock(so_errors=(0, errno.ECONNREFUSED))
        clock = Clock()
        bystander, client = Stream([BACKEND_REQUEST] + [None] * 5), Stream([None, REQUEST])
        sockets = Sockets([bystander, client], complete=False)
        transport = proxy.NativeVsockTransport(module, selectors, binding, 2, 4050, 20, clock=clock)
        outcome = proxy.serve_proxy(config(sockets, clock), transport)
        self.assertEqual(outcome.code, 'TRANSPORT_LOST')
        self.assertEqual([bytes(e.sent) for e in created], [control('BACKEND', 1), b''])
        self.assertEqual([e.closes for e in created] + [bystander.closes, client.closes], [1, 1, 1, 1])

    def test_vsock_connect_timeout_enforced(self):
        module, selectors, created = self.native_vsock(ready=False)
        binding, clock = config(Sockets()).binding, Clock()
        transport = proxy.NativeVsockTransport(module, selectors, binding, 2, 4050, 20, clock=clock)
        transport.authenticate(binding)
        stream = transport.open(2, 4050, binding)          # opened at mono 10: deadline 30
        clock.mono = 29
        self.assertIsNone(stream.write(b'x')); self.assertIsNone(stream.read(16)); transport.check()
        clock.mono = 30
        for operation in (lambda: stream.write(b'x'), lambda: stream.read(16), transport.check):
            with self.assertRaises(OSError) as raised: operation()
            self.assertEqual(raised.exception.errno, errno.ETIMEDOUT)
        self.assertEqual(bytes(created[0].sent), b'')
        transport.close(); self.assertEqual(created[0].closes, 1)
        # Serving loop with connect timeout == idle timeout (as _inherited_entry sets it): the
        # stalled connect latches TRANSPORT_LOST and is never turned into a per-tunnel idle close.
        module, selectors, created = self.native_vsock(ready=False)
        clock, client = Clock(), Stream([REQUEST])
        sockets = Sockets([client])
        transport = proxy.NativeVsockTransport(module, selectors, binding, 2, 4050, 20, clock=clock)
        outcome = proxy.serve_proxy(config(sockets, clock, run_timeout_ms=1000), transport)
        self.assertEqual((outcome.code, clock.mono), ('TRANSPORT_LOST', 30))
        self.assertEqual((bytes(created[0].sent), created[0].closes, client.closes), (b'', 1, 1))

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
        # T9-9: the vsock connect deadline runs on the run clock, bounded like the idle lease.
        self.assertIs(transport.clock, cfg.clock)
        self.assertEqual(transport.connect_timeout_ms, cfg.idle_timeout_ms)
        result = bytes(fake_os.output[8:])
        size = int.from_bytes(result[:2], 'big')
        self.assertEqual(json.loads(result[2:2+size]), {
            'code':'COMPLETE','kind':'PROXY_RESULT','runId':'1'*32,
            'usedBytes':7,'version':1})

        # T9-4: a denied case must never reach the runner. The runner records instead of
        # raising, so the entry's own exception handling cannot hide a reached runner.
        def setter(field, value):
            return lambda frame: frame.__setitem__(field, copy.deepcopy(value))
        denials = [('frame:' + field, setter(field, value)) for field, value in FRAME_FIELD_DENIALS] + [
            ('runtimeIdentity:absent', lambda value: value.pop('runtimeIdentity')),
            ('runtimeIdentity', setter('runtimeIdentity', 'e' * 64)),
            ('handoff:commandFd', lambda value: value['handoff'].__setitem__('commandFd', 9)),
            ('handoff:confined', lambda value: value['handoff'].__setitem__('confined', False)),
            ('rolePolicyIdentity', setter('rolePolicyIdentity', 'e' * 64)),
        ]
        self.assertEqual(len(denials), 15)
        for name, mutate in denials:
            with self.subTest(denial=name):
                reached=[]
                denied_os=FakeOS(self._bootstrap_wire(mutate))
                denied=proxy.qualify_native_bindings(
                    denied_os, FakeSocketModule(), FakeSelectorModule(), FakeTime(),
                    platform_name='linux', machine='aarch64',
                    runner=lambda cfg, transport: reached.append(cfg) or proxy.ProxyOutcome('COMPLETE'))
                self.assertEqual(proxy.admitted_inherited_main(
                    ('--inherited',), denied, policy), 1)
                self.assertEqual(reached, [])
                self.assertEqual(bytes(denied_os.output), b'WAITING\n')
                self.assertEqual(denied_os.closes, [3, 4])

        # Each comparison in the admission itself is bound on its own. Destinations and the
        # binding's origins both derive from the frame's origins, so only a direct case can
        # diverge them (reviewer mutant O3).
        native=proxy.NativeAdmission('d'*64, 'c'*64)
        def admitted(**changes):
            values=dict(destinations=HOSTS.copy(), binding=expected_binding, aggregate_bytes=10000,
                        idle_timeout_ms=20, run_timeout_ms=50, clock=Clock(), sockets=Sockets(),
                        native_admission=native)
            values.update(changes); return proxy.ProxyConfig(**values)
        self.assertIsNone(proxy._admit_native_config(admitted(), policy))
        rebound=lambda **change: dict(binding=dataclasses.replace(expected_binding, **change))
        for name, changes in [
                ('destinations', dict(destinations={'FRONTEND':'other.example.test','BACKEND':HOSTS['BACKEND']})),
                ('aggregateBytes', dict(aggregate_bytes=9999)), ('idleTimeoutMs', dict(idle_timeout_ms=21)),
                ('runTimeoutMs', dict(run_timeout_ms=51)),
                ('runId', rebound(run_id='2'*32)), ('capability', rebound(capability=b'\x08'*32)),
                ('expiresAt', rebound(expires_at=191)), ('firstSequence', rebound(first_sequence=2)),
                ('manifestIdentity', rebound(manifest_identity='e'*64)),
                ('configIdentity', rebound(config_identity='e'*64)),
                ('origins', rebound(origins=(('FRONTEND','https://other.example.test'), ORIGINS[1]))),
                ('runtimeIdentity', dict(native_admission=proxy.NativeAdmission('e'*64, 'c'*64))),
                ('rolePolicyIdentity', dict(native_admission=proxy.NativeAdmission('d'*64, 'e'*64))),
                ('admission-absent', dict(native_admission=None))]:
            with self.subTest(direct=name), self.assertRaisesRegex(proxy.ProxyError, '^ADMISSION_DENIED$'):
                proxy._admit_native_config(admitted(**changes), policy)

        reached=[]
        denied_os=FakeOS(self._bootstrap_wire())
        denied_bindings=proxy.qualify_native_bindings(
            denied_os, FakeSocketModule(), FakeSelectorModule(), FakeTime(),
            platform_name='linux', machine='aarch64',
            runner=lambda cfg, transport: reached.append(cfg) or proxy.ProxyOutcome('COMPLETE'))
        denied_policy=proxy.qualify_native_admission(
            expected_binding, HOSTS.copy(), 10000, 20, 50,
            runtime_identity='d'*64, role_policy_identity='c'*64,
            handoff_validator=lambda *_: False)
        self.assertEqual(proxy.admitted_inherited_main(
            ('--inherited',), denied_bindings, denied_policy), 1)
        self.assertEqual(denied_os.reads, [])
        self.assertEqual(reached, [])

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
        bare=proxy.NativeVsockTransport(module, Selector, binding, 2, 4050)
        bare.authenticate(binding); created=len(module.created)
        with self.assertRaisesRegex(proxy.ProxyError, '^TRANSPORT_DENIED$'): bare.open(2,4050,binding)
        self.assertEqual(len(module.created), created, 'no vsock socket without a connect deadline clock')
        transport=proxy.NativeVsockTransport(module, Selector, binding, 2, 4050, clock=Clock())
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
        transport=proxy.NativeVsockTransport(SocketModule(), Selectors, binding, 2, 4050, 20, clock=Clock())
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


class CompositionHarness:
    """Real inherited decoder, selector parser and loop; inert OS bytes only."""
    def __init__(self, test, *, commands=None, mutate=None, sink=None, limits=(20, 50)):
        self.test, self.owners, self.frames, self.events = test, [], [], []
        # (idleTimeoutMs, runTimeoutMs) for both the frame and the independent admission.
        self.limits = limits
        self.clock = Clock()
        self.clock.wall, self.clock.mono = 100, 10
        self.live = {fd: [1, fd + 100, 0 if fd != 4 else 1] for fd in range(5)}
        self.next_fd, self.endpoints, self.selectors = 5, [], []
        self.child, self.pipe = object(), (object(), object())
        self.key = b'\x09' * 32
        self.binding = dict(version=1, runId='1'*32, manifestDigest='b'*64,
                            configIdentity='a'*64, rolePolicyDigest='c'*64,
                            epoch=7, expiresAtMs=190)
        self.output, self.input = bytearray(), bytearray()
        self.pending_commands = commands if commands is not None else [self.command('PROXY_CURRENT'), b'STOP']
        self.on_ready, self.on_sleep, self.on_write = sink, None, None
        self.fail_bind = self.fail_auth = self.fail_close = False
        self.fragment, self.write_fragment = 7, 13
        self.clients = []
        # Terminal-start double (C1): a set deadline means started; remaining()
        # never allocates. Tests may pre-set deadline to model an earlier start.
        self.budget = types.SimpleNamespace(clock=self.clock, deadline=None, real_deadline=None)
        self.budget.remaining = self.remaining
        self.budget.start_terminal = self.start_terminal
        self.budget.clamp_end = self.clamp_end
        self.budget.call = lambda fn: fn(self.remaining())
        bootstrap = json.loads(ProxyTests()._bootstrap_wire()[2:])
        bootstrap['idleTimeoutMs'], bootstrap['runTimeoutMs'] = limits
        initial = dict(version=2, kind='PROXY_COMPOSITION_INIT', binding=self.binding.copy(),
                       childId='2'*32, pipeId='3'*32, channelKeyHex=self.key.hex(), proxyBootstrap=bootstrap)
        if mutate: mutate(initial)
        self.input.extend(self.frame(initial))
        harness = self

        class Endpoint:
            def __init__(self, family=2):
                self.fd = harness.allocate(); self.family = family; self.closes = 0
                self.data, self.sent = [], bytearray()
                harness.endpoints.append(self)
            def fileno(self): return self.fd
            def setblocking(self, value):
                if value: harness.live[self.fd][2] &= ~2048
                else: harness.live[self.fd][2] |= 2048
            def bind(self, address):
                harness.events.append('bind')
                if harness.fail_bind: raise OSError('inert bind')
            def listen(self, backlog): harness.events.append('listen')
            def getsockname(self): return ('127.0.0.1', 3128)
            def accept(self):
                if harness.clients:
                    client = harness.clients.pop(0)
                    if type(client) is list:
                        endpoint = Endpoint(); harness.live[endpoint.fd][2] &= ~2048
                        endpoint.data = client; client = endpoint
                    return client, ('127.0.0.1', 41000)
                raise BlockingIOError()
            def connect_ex(self, address): return errno.EINPROGRESS
            def getsockopt(self, *args): return 0
            def recvmsg(self, size, ancillary):
                if self.data:
                    item = self.data.pop(0)
                    if isinstance(item, BaseException): raise item
                    return item, (), 0, None
                raise BlockingIOError()
            def send(self, data): self.sent.extend(data); return len(data)
            def shutdown(self, how): pass
            def close(self):
                self.closes += 1
                if harness.fail_close: raise OSError('inert close')
                harness.live.pop(self.fd, None); self.fd = -1

        class Selector:
            def __init__(self):
                self.fd = harness.allocate(); self.target = None; self.closes = 0
                harness.selectors.append(self)
            def fileno(self): return self.fd
            def register(self, target, event): self.target = target
            def select(self, timeout):
                return [(types.SimpleNamespace(fd=3),1),(types.SimpleNamespace(fd=4),2)]
            def close(self):
                self.closes += 1
                if harness.fail_close: raise OSError('inert selector close')
                harness.live.pop(self.fd, None); self.fd = -1

        self.Endpoint = Endpoint
        class SelectWriter:
            def register(self, fd, event): pass
            def select(self, timeout): return [(types.SimpleNamespace(fd=4),2)]
            def close(self): pass
        self.socket = types.SimpleNamespace(AF_INET=2, AF_VSOCK=40, SOCK_STREAM=1,
            SOCK_NONBLOCK=2048, SOCK_CLOEXEC=524288, SOL_SOCKET=1, SO_ERROR=4,
            SHUT_WR=1, MSG_CTRUNC=8, CMSG_SPACE=lambda size: size+16,
            socket=lambda family, kind, protocol: Endpoint(family))
        self.selector_module = types.SimpleNamespace(DefaultSelector=Selector,
            SelectSelector=SelectWriter, EVENT_READ=1, EVENT_WRITE=2)
        self.time = types.SimpleNamespace(time=lambda: self.clock.wall/1000,
            monotonic=lambda: self.clock.mono/1000, sleep=self.sleep)
        self.files, self.fd_closes = {}, []
        self.os = types.SimpleNamespace(read=self.read, write=self.write, close=self.close,
            fstat=self.fstat, listdir=lambda path: [str(fd) for fd in self.live],
            open=self.open, O_RDONLY=0, O_CLOEXEC=524288)

    def start_terminal(self):
        if self.budget.deadline is None: self.budget.deadline = self.clock.mono + 60000
        return self.remaining()
    def clamp_end(self, end):
        self.start_terminal(); self.budget.deadline = min(self.budget.deadline, end)
    def remaining(self):
        if self.budget.deadline is None: raise ValueError('CLEANUP_NOT_STARTED')
        return max(0, self.budget.deadline - self.clock.mono)
    def allocate(self):
        fd = self.next_fd; self.next_fd += 1
        self.live[fd] = [1, fd+100, 2048|524288]; return fd
    def fstat(self, fd):
        if fd not in self.live: raise OSError('inert missing descriptor')
        dev, inode, flags = self.live[fd]
        return types.SimpleNamespace(st_dev=dev, st_ino=inode)
    def open(self, path, flags):
        target = int(path.rsplit('/', 1)[1]); fd = 4000
        self.files[fd] = bytearray(('flags:\t'+oct(self.live[target][2])[2:]+'\n').encode())
        return fd
    def read(self, fd, size):
        source = self.input if fd == 3 else self.files[fd]
        if fd == 3 and not source and self.pending_commands:
            item = self.pending_commands.pop(0)
            source.extend(item() if callable(item) else item)
        part = bytes(source[:min(size, self.fragment)]); del source[:len(part)]
        return part
    def write(self, fd, data):
        if self.on_write: self.on_write()
        part = bytes(data[:self.write_fragment]); self.output.extend(part); return len(part)
    def close(self, fd):
        if fd in self.files: del self.files[fd]
        else: self.fd_closes.append(fd)
    def sleep(self, seconds):
        self.clock.wait(max(1, int(seconds*1000)))
        if self.on_sleep: self.on_sleep()
    @staticmethod
    def frame(value):
        body = json.dumps(value, sort_keys=True, separators=(',', ':')).encode('ascii')
        return len(body).to_bytes(2, 'big') + body
    def command(self, kind, sequence=1, request_id='4'*32, **changes):
        payload = dict(requestId=request_id, generation=1) if kind == 'PROXY_CURRENT' else dict(requestId=request_id, cleanupEndsAtMonotonicMs=25)
        value = dict(version=2, kind=kind, binding=self.binding, childId='2'*32,
                     pipeId='3'*32, sequence=sequence, payload=payload)
        value.update(changes)
        body = self.frame(value)[2:]
        value['mac'] = hmac.new(self.key, b'acceptance:bootstrap-composition:v1\0PROXY:FROM_BOOTSTRAP\0'+body, hashlib.sha256).hexdigest()
        return self.frame(value)
    def capture(self, owner):
        self.events.append('owner'); self.owners.append(owner)
        if self.on_ready: self.on_ready(self, owner)
    def run(self, *, legacy=False, policy_override=None, legacy_commands=None):
        admitted = proxy.qualify_native_admission(config(Sockets()).binding, HOSTS, 10000, *self.limits,
            runtime_identity='d'*64, role_policy_identity='c'*64, handoff_validator=lambda *_: True)
        bindings = proxy.qualify_native_bindings(self.os, self.socket, self.selector_module, self.time,
            platform_name='linux', machine='aarch64')
        if legacy:
            self.input = bytearray(ProxyTests()._bootstrap_wire())
            self.pending_commands = [b'STOP'] if legacy_commands is None else legacy_commands
        kwargs = {}
        if hasattr(proxy, 'qualify_composition_proxy') and not legacy:
            self.nominal_binding = proxy.CompositionBinding.from_record(self.binding)
            self.policy = proxy.qualify_composition_proxy(self.nominal_binding,
                child=self.child, pipe=self.pipe, child_id='2'*32, pipe_id='3'*32,
                channel_key=self.key, admission_policy=admitted, cleanup_budget=self.budget,
                provenance_validator=lambda child, pipe: child is self.child and pipe is self.pipe,
                runtime_sink=self.capture)
            kwargs['composition_policy'] = policy_override or self.policy
        self.exit = proxy.admitted_inherited_main(('--inherited',), bindings, admitted, **kwargs)
        data = bytes(self.output)
        self.test.assertTrue(data.startswith(b'WAITING\n'))
        data = data[8:]
        while data:
            size = int.from_bytes(data[:2], 'big')
            self.test.assertLessEqual(size, 16384)
            self.frames.append(json.loads(data[2:2+size])); data = data[2+size:]
        return self


class ProxyCompositionTests(unittest.TestCase):
    def ready(self, h):
        self.assertEqual([f['kind'] for f in h.frames[:1]], ['PROXY_READY'],
                         'trusted v2 ingress must reach actual serving owner')
        self.assertEqual(len(h.owners), 1)
        return h.owners[0]

    def test_v1_runtime_owner_minted_only_after_auth_and_listen(self):
        h = CompositionHarness(self).run(); self.ready(h)
        self.assertEqual(h.events[:3], ['bind','listen','owner'])
        self.assertEqual(h.exit, 0)
        h = CompositionHarness(self); h.fail_bind = True; h.run()
        self.assertEqual(h.owners, [])
        self.assertEqual(h.frames[-1]['payload']['runtimeId'], '')

    def test_v1_equal_objects_cannot_substitute_serving_owner(self):
        failures = []
        def sink(h, owner):
            original = owner._config
            owner._config = dataclasses.replace(original)
            with self.assertRaises(proxy.ProxyError): owner.observe_current(h.nominal_binding)
            owner._config = original
            with self.assertRaises(proxy.ProxyError): owner.observe_current(h.nominal_binding)
            failures.append(True)
        h = CompositionHarness(self, sink=sink).run(); self.ready(h)
        self.assertEqual(failures, [True])
        self.assertNotIn('PROXY_CURRENT', [f['kind'] for f in h.frames])

    def test_v1_inherited_v2_epoch_checked_before_runtime_mint(self):
        self.ready(CompositionHarness(self).run())
        for change in [lambda v: v['binding'].__setitem__('epoch', 8),
                       lambda v: v.__setitem__('childId', '5'*32),
                       lambda v: v.__setitem__('pipeId', '5'*32),
                       lambda v: v.__setitem__('channelKeyHex', '00'*32),
                       lambda v: v['proxyBootstrap'].__setitem__('configIdentity', 'e'*64),
                       lambda v: v.__setitem__('extra', 1)]:
            with self.subTest(change=change):
                h = CompositionHarness(self, mutate=change).run()
                self.assertEqual((h.exit, h.owners, h.events, h.frames), (1, [], [], []))

    def test_v1_inherited_current_request_reaches_actual_loop(self):
        h = CompositionHarness(self).run(); self.ready(h)
        self.assertEqual([f['kind'] for f in h.frames], ['PROXY_READY','PROXY_CURRENT','PROXY_TERMINAL'])
        ready, current, terminal = h.frames
        self.assertEqual([f['sequence'] for f in h.frames], [1,2,3])
        observation = current['payload']['observation']
        self.assertEqual((observation['sequence'], observation['status']), (2,'CURRENT'))
        self.assertEqual((current['payload']['requestSequence'], current['payload']['requestId']), (1,'4'*32))
        self.assertEqual(observation['runtimeId'], ready['payload']['observation']['runtimeId'])
        self.assertEqual([r['kind'] for r in observation['currentFDs']],
            ['NULL','NULL','NULL','COMMAND','RESULT','PROXY_LISTENER','PROXY_STOP_SELECTOR'])
        for f in h.frames:
            mac = f.pop('mac')
            self.assertEqual(mac, hmac.new(h.key, b'acceptance:bootstrap-composition:v1\0PROXY:TO_BOOTSTRAP\0'+h.frame(f)[2:], hashlib.sha256).hexdigest())

    def test_v1_inherited_current_malformed_replay_stale_denied(self):
        self.ready(CompositionHarness(self).run())
        for bad in [b'\x10\x01', b'NOPE', b'\x00\x05{}', b'\x00\x00']:
            h = CompositionHarness(self, commands=[bad]).run()
            self.assertEqual(h.frames[-1]['kind'], 'PROXY_TERMINAL')
            self.assertNotEqual(h.frames[-1]['payload']['code'], 'COMPLETE')
        h = CompositionHarness(self)
        h.pending_commands = [h.command('PROXY_CURRENT'), h.command('PROXY_CURRENT')]
        h.run(); self.assertEqual(len([f for f in h.frames if f['kind']=='PROXY_CURRENT']), 1)
        self.assertEqual(h.frames[-1]['payload']['code'], 'CHANNEL_DENIED')

    def test_v1_inherited_eof_and_stop_keep_original_cleanup(self):
        for commands in ([], [b'STOP'], [b'ST']):
            h = CompositionHarness(self, commands=commands).run(); self.ready(h)
            self.assertEqual(h.budget.remaining(), 0)
            self.assertTrue(all(e.closes == 1 for e in h.endpoints))
            self.assertEqual(h.fd_closes, [3,4])

    def test_v1_legacy_result_never_qualifies_composition(self):
        self.ready(CompositionHarness(self).run())
        h = CompositionHarness(self).run(legacy=True)
        self.assertEqual((h.exit, h.owners), (0, []))
        self.assertEqual([f['kind'] for f in h.frames], ['PROXY_RESULT'])
        self.assertEqual(set(h.frames[0]), {'code','kind','runId','usedBytes','version'})

    def test_v1_runtime_terminal_never_revives(self):
        h = CompositionHarness(self).run(); owner = self.ready(h)
        for _ in range(2):
            with self.assertRaises(proxy.ProxyError): owner.observe_current(h.nominal_binding)
        self.assertEqual(owner.stop_owned(60000), {'status':'STOPPED','runId':'1'*32})
        self.assertEqual(len([f for f in h.frames if f['kind']=='PROXY_TERMINAL']), 1)

    def test_v1_runtime_cleanup_shares_composition_budget(self):
        h = CompositionHarness(self)
        h.pending_commands = [h.command('PROXY_STOP')]; h.budget.deadline = 20
        h.run(); owner = self.ready(h)
        self.assertEqual(h.budget.deadline, 20)
        self.assertEqual(h.frames[-1]['payload']['requestSequence'], 1)
        self.assertEqual(h.frames[-1]['payload']['requestId'], '4'*32)
        self.assertIs(owner._budget, h.budget)
        owner.stop_owned(60000); self.assertEqual(h.budget.deadline, 20)

    def test_v1_runtime_fd_inventory_follows_original_endpoint_lifecycle(self):
        seen = []
        def sink(h, owner):
            observation = owner.observe_current(h.nominal_binding)
            self.assertEqual(type(observation).__name__, 'ProxyRuntimeObservation')
            row = observation.to_record()['currentFDs'][5]
            self.assertEqual(row['kind'], 'PROXY_LISTENER')
            h.live[row['fd']][1] += 1
            with self.assertRaises(proxy.ProxyError): owner.observe_current(h.nominal_binding)
            seen.append(True)
        h = CompositionHarness(self, sink=sink).run(); self.ready(h)
        self.assertEqual(seen, [True])

    def test_v1_copied_context_and_endpoint_collections_never_admit(self):
        results = []
        def sink(h, owner):
            with self.assertRaises(proxy.ProxyError): copy.copy(owner).observe_current(h.nominal_binding)
            observation = owner.observe_current(h.nominal_binding)
            with self.assertRaises(proxy.ProxyError): dataclasses.replace(observation).to_record()
            context = owner._context
            copied = copy.copy(context)
            cfg = dataclasses.replace(owner._config, sockets=Sockets())
            transport = Transport()
            result = proxy.serve_proxy(cfg, transport, composition=copied)
            self.assertEqual(cfg.sockets.calls, [], 'foreign context must be denied before listener acquisition')
            self.assertEqual(result.code, 'CONFIG_DENIED')
            results.append(True)
        h = CompositionHarness(self, sink=sink).run(); self.ready(h)
        self.assertEqual(results, [True])

    def test_v1_current_client_requires_correlated_fresh_original_response(self):
        h = CompositionHarness(self).run(); self.ready(h)
        self.assertTrue(hasattr(proxy, 'ProxyCompositionClient'), 'no live response correlation/freshness boundary')
        for mutation in ('none','stale','request','binding','legacy','replay','boolean','extra'):
            with self.subTest(mutation=mutation):
                h.clock.mono = 10
                client = proxy.ProxyCompositionClient(h.policy, h.clock)
                ready = copy.deepcopy(h.frames[0]); current = copy.deepcopy(h.frames[1])
                client.accept_frame(h.frame(ready))
                command = client.current('4'*32, 1)
                self.assertEqual(json.loads(command[2:])['sequence'], 1)
                if mutation == 'stale': h.clock.mono += 101
                if mutation == 'request': current['payload']['requestId'] = '8'*32
                if mutation == 'binding': current['binding']['epoch'] = 8
                if mutation == 'legacy': current = dict(version=1, kind='PROXY_RESULT', runId='1'*32, code='COMPLETE',usedBytes=0)
                if mutation == 'replay': current = ready
                if mutation == 'boolean': current['payload']['requestSequence'] = True
                if mutation == 'extra': current['payload']['observation']['extra'] = 1
                if mutation not in ('none','legacy'):
                    current.pop('mac', None)
                    current['mac'] = hmac.new(h.key, b'acceptance:bootstrap-composition:v1\0PROXY:TO_BOOTSTRAP\0'+h.frame(current)[2:], hashlib.sha256).hexdigest()
                if mutation == 'none':
                    self.assertEqual(client.accept_frame(h.frame(current))['status'], 'CURRENT')
                    with self.assertRaises(proxy.ProxyError): client.accept_frame(h.frame(current))
                else:
                    with self.assertRaises(proxy.ProxyError): client.accept_frame(h.frame(current))
                    with self.assertRaises(proxy.ProxyError): client.current('5'*32, 1)
                h.clock.mono = 10

    def test_v1_current_command_union_and_fragment_deadline(self):
        mutations = [dict(sequence=True), dict(sequence=2), dict(kind='PROXY_READY'),
                     dict(payload={'requestId':'4'*32,'generation':True}),
                     dict(payload={'requestId':'4'*32,'generation':2}),
                     dict(payload={'requestId':'4'*32,'generation':1,'extra':0})]
        for change in mutations:
            with self.subTest(change=change):
                h = CompositionHarness(self)
                h.pending_commands = [h.command(change.get('kind', 'PROXY_CURRENT'), **{k:v for k,v in change.items() if k!='kind'})]
                h.run(); self.ready(h)
                self.assertEqual(h.frames[-1]['payload']['code'], 'CHANNEL_DENIED')
                self.assertEqual(len(h.frames), 2)
        h = CompositionHarness(self)
        command = h.command('PROXY_CURRENT'); h.pending_commands = [command]
        original_read = h.os.read
        def slow_read(fd, size):
            if fd == 3 and h.owners: h.clock.mono += 101
            return original_read(fd, size)
        h.os.read = slow_read
        h.run(); self.ready(h)
        self.assertIn(h.frames[-1]['payload']['code'], ('CHANNEL_DENIED','EXPIRED'))
        self.assertNotIn('PROXY_CURRENT', [f['kind'] for f in h.frames])

    def test_v1_pending_selector_retirement_and_uncertain_close(self):
        observations = []
        def sink(h, owner):
            # These are actual authored NativeStream/connector acquisitions.
            stream = owner._transport.open(2,4050,owner._config.binding)
            observation = owner.observe_current(h.nominal_binding).to_record()
            self.assertEqual([r['kind'] for r in observation['currentFDs']][-2:],
                             ['PROXY_VSOCK_STREAM','PROXY_CONNECT_SELECTOR'])
            selector = stream.connector
            self.assertEqual(stream.write(b'x'), 1)
            observation = owner.observe_current(h.nominal_binding).to_record()
            self.assertEqual(observation['currentFDs'][-1]['kind'], 'PROXY_VSOCK_STREAM')
            self.assertEqual(selector.closes, 1)
            owner._transport.streams = []
            with self.assertRaises(proxy.ProxyError): owner.observe_current(h.nominal_binding)
            observations.append(True)
        h = CompositionHarness(self, sink=sink).run(); self.ready(h)
        self.assertEqual(observations, [True])

    def test_v1_listener_and_transport_auth_fail_before_mint(self):
        with patch.object(proxy.NativeVsockTransport, 'authenticate', return_value=None):
            h = CompositionHarness(self).run()
        self.assertEqual((h.owners, h.endpoints), ([], []))
        self.assertEqual(h.frames[-1]['payload']['code'], 'IDENTITY_MISMATCH')
        self.assertEqual(h.frames[-1]['payload']['runtimeId'], '')

    def test_v1_actual_task6_raw_observer_consumes_loop_inventory(self):
        import confinement_test as fixture
        checked = []
        def sink(h, owner):
            kernel, handoff, native = fixture.V1RoleTests().runtime(extra=False)
            original_read, original_stat = native.read_file, native.os.stat
            original_list = native.os.listdir
            def stat(path):
                if '/fd/' in path: return h.fstat(int(path.rsplit('/',1)[1]))
                return original_stat(path)
            def read(path, *args):
                if '/fdinfo/' in path:
                    fd = int(path.rsplit('/',1)[1])
                    return ('flags:\t'+oct(h.live[fd][2])[2:]+'\n').encode()
                return original_read(path,*args)
            native.os.stat = stat; native.read_file = read
            native.os.listdir = lambda path: [str(fd) for fd in h.live] if path.endswith('/fd') else original_list(path)
            rows = owner.observe_current(h.nominal_binding).to_record()['currentFDs']
            facts = fixture.c._native_observe(native,300,handoff.launch,
                handoff.attestation.filter_digest,{},False,current_fds=rows)
            self.assertFalse(facts['waiting'])
            self.assertEqual(tuple(d.fd for d in facts['fds']), (0,1,2,3,4))
            h.live[19] = [1,199,0]
            with self.assertRaisesRegex(fixture.c.ConfinementError,'NATIVE_CURRENT_INVENTORY_UNAVAILABLE'):
                fixture.c._native_observe(native,300,handoff.launch,
                    handoff.attestation.filter_digest,{},False,current_fds=rows)
            del h.live[19]; checked.append(True)
        h = CompositionHarness(self,sink=sink).run(); self.ready(h)
        self.assertEqual(checked,[True])

    def test_v1_uncertain_connector_close_stays_owned_and_forbids_current(self):
        checked=[]
        def sink(h, owner):
            stream = owner._transport.open(2,4050,owner._config.binding)
            connector = stream.connector
            original = connector.close
            def fail(): raise OSError('inert unresolved selector')
            connector.close = fail
            with self.assertRaises(OSError): stream.write(b'x')
            self.assertIs(stream.connector,connector)
            with self.assertRaises(proxy.ProxyError): owner.observe_current(h.nominal_binding)
            connector.close = original
            checked.append(True)
        h=CompositionHarness(self,sink=sink).run(); self.ready(h)
        self.assertEqual(checked,[True])
        self.assertTrue(all(e.closes==1 for e in h.endpoints))

    def test_v1_descriptor_substitution_cleans_only_original_endpoint(self):
        originals=[]; substitutes=[]
        def sink(h,owner):
            original=owner._listener.socket; originals.append(original)
            substitute=types.SimpleNamespace(fileno=original.fileno, close=lambda:substitutes.append(True))
            owner._listener.socket=substitute
            with self.assertRaises(proxy.ProxyError):owner.observe_current(h.nominal_binding)
        h=CompositionHarness(self,sink=sink).run();self.ready(h)
        self.assertEqual((originals[0].closes,substitutes),(1,[]))

    def test_v1_bad_duplicate_depth_second_init_and_output_loss_are_terminal(self):
        for kind in ('duplicate','depth','second-init','mac','output'):
            h=CompositionHarness(self)
            command=h.command('PROXY_CURRENT')
            if kind=='duplicate':
                body=command[2:].replace(b'"sequence":1',b'"sequence":1,"sequence":1')
                command=len(body).to_bytes(2,'big')+body
            if kind=='depth':command=h.frame({'x':[[[[[[[[[0]]]]]]]]]})
            if kind=='second-init':command=bytes(h.input)
            if kind=='mac':command=command.replace(b'"mac":"',b'"mac":"0',1)
            if kind=='output':
                def lose():
                    if h.owners:raise OSError('inert result loss')
                h.on_write=lose
            h.pending_commands=[command];h.run();self.ready(h)
            self.assertEqual(h.exit,1)
            self.assertTrue(all(e.closes==1 for e in h.endpoints))
            with self.assertRaises(proxy.ProxyError):h.owners[0].observe_current(h.nominal_binding)

    def test_v1_swapped_os_or_context_policy_cannot_reobserve(self):
        for target in ('os','policy','transport','clock'):
            seen=[]
            def sink(h,owner):
                if target=='os': owner._sockets.os=copy.copy(h.os)
                elif target=='policy': owner._context._policy=dataclasses.replace(h.policy)
                elif target=='clock': owner._transport.clock=Clock()
                else: owner._transport.host_cid=3
                with self.assertRaises(proxy.ProxyError):owner.observe_current(h.nominal_binding)
                seen.append(True)
            h=CompositionHarness(self,sink=sink).run();self.ready(h)
            self.assertEqual(seen,[True],target)
            self.assertTrue(all(e.closes==1 for e in h.endpoints))

    def test_v1_cleanup_reentry_is_uncertain_without_overlapping_close(self):
        receipts=[]
        def sink(h,owner):
            endpoint=owner._listener.socket; original=endpoint.close
            def close():
                receipts.append(owner.stop_owned(60000));original()
            endpoint.close=close
        h=CompositionHarness(self,sink=sink).run();self.ready(h)
        self.assertEqual(receipts,[{'status':'TIMEOUT','runId':'1'*32}])
        self.assertEqual(h.endpoints[0].closes,1)

    def test_v1_result_backpressure_fails_without_waiting_or_reopening(self):
        h=CompositionHarness(self)
        def sink(h,owner):
            original=owner._sockets.stop_selector.select
            owner._sockets.stop_selector.select=lambda timeout:[x for x in original(timeout) if x[0].fd==3]
        h.on_ready=sink;h.run();self.ready(h)
        self.assertEqual(h.exit,1)
        self.assertNotIn('PROXY_CURRENT',[f['kind'] for f in h.frames])
        self.assertEqual(len(h.selectors),1)

    def test_v1_live_loop_current_lists_accepted_and_vsock_originals(self):
        h=CompositionHarness(self,sink=lambda h,owner:h.clients.append([REQUEST]))
        h.run();self.ready(h)
        currents=[f for f in h.frames if f['kind']=='PROXY_CURRENT']
        self.assertEqual(len(currents),1)
        current=currents[0]['payload']['observation']
        self.assertEqual([r['kind'] for r in current['currentFDs']][-2:],
                         ['PROXY_ACCEPTED_STREAM','PROXY_VSOCK_STREAM'])
        self.assertEqual(h.frames[-1]['payload']['cleanupStatus'],'PROVEN')
        self.assertTrue(all(e.closes==1 for e in h.endpoints))

    def test_v1_shared_real_budget_and_first_terminal_end_never_renew(self):
        import bootstrap_composition_test as fixture
        h=CompositionHarness(self)
        h.budget=fixture.t.CleanupBudget(h.clock)
        h.pending_commands=[h.command('PROXY_STOP')]
        h.run();owner=self.ready(h)
        self.assertEqual(h.budget.deadline,25)
        self.assertIsNotNone(h.budget.real_deadline)
        failed=h.frames[-1]['payload']['failedAtMonotonicMs']
        h.clock.mono+=1000
        self.assertEqual(owner.stop_owned(60000)['status'],'STOPPED')
        self.assertEqual(h.budget.deadline,25)
        self.assertEqual(owner._context._failed_at,failed)

    def test_v1_partial_result_failure_never_appends_a_new_frame(self):
        h=CompositionHarness(self); writes=[]
        def failure():
            if h.owners:
                writes.append(True)
                if len(writes)==2:
                    h.on_write=None
                    raise OSError('inert partial result failure')
        h.on_write=failure
        with self.assertRaises(ValueError):h.run()
        self.ready(h)
        self.assertNotIn(b'PROXY_TERMINAL',h.output)
        self.assertEqual(h.exit,1)
        self.assertTrue(all(e.closes==1 for e in h.endpoints))

    def test_v1_initial_inventory_close_uncertainty_retains_original_channel(self):
        h=CompositionHarness(self); attempts=[]; original=h.os.close
        def close(fd):
            if fd==4000:
                attempts.append(fd);raise OSError('inert unresolved proc read')
            original(fd)
        h.os.close=close;h.run()
        self.assertEqual(h.owners,[])
        self.assertEqual([f['kind'] for f in h.frames],['PROXY_TERMINAL'])
        self.assertEqual(h.frames[-1]['payload']['cleanupStatus'],'UNCERTAIN')
        self.assertEqual(h.frames[-1]['payload']['code'],'CLEANUP_UNCERTAIN')
        self.assertEqual(attempts,[4000])
        self.assertEqual(h.fd_closes,[3,4])

    def test_v1_r1_inventory_drift_cannot_redirect_cleanup(self):
        for target in ('listener','sockets','transport','stream','connector'):
            with self.subTest(target=target):
                originals=[]; substitutes=[]
                def sink(h,owner):
                    def substitute(endpoint):
                        return types.SimpleNamespace(fileno=endpoint.fileno,
                            close=lambda:substitutes.append(target))
                    if target=='listener':
                        originals.append(owner._listener.socket)
                        owner._listener.inventory=None
                        owner._listener.socket=substitute(originals[-1])
                    elif target=='sockets':
                        originals.extend((owner._listener.socket,owner._sockets.stop_selector))
                        owner._sockets.inventory=None
                        owner._sockets.listener=types.SimpleNamespace(close=lambda:substitutes.append(target))
                        owner._sockets.stop_selector=substitute(originals[-1])
                    else:
                        stream=owner._transport.open(2,4050,owner._config.binding)
                        originals.extend((stream.socket,stream.connector))
                        if target=='transport':
                            owner._transport.inventory=None
                            owner._transport.streams=[types.SimpleNamespace(close=lambda:substitutes.append(target))]
                        else:
                            stream.inventory=None
                            if target=='stream':stream.socket=substitute(originals[0])
                            else:stream.connector=substitute(originals[1])
                    with self.assertRaises(proxy.ProxyError):owner.observe_current(h.nominal_binding)
                h=CompositionHarness(self,sink=sink).run();self.ready(h)
                self.assertEqual(substitutes,[])
                self.assertTrue(all(e.closes==1 and e.fileno()==-1 for e in originals))
                self.assertEqual(h.frames[-1]['payload']['cleanupStatus'],'PROVEN')

    def test_v1_r1_proven_cleanup_requires_retired_original_obligations(self):
        h=CompositionHarness(self)
        def sink(h,owner):
            endpoint=owner._listener.socket
            # A broken effect boundary returns normally without closing. A
            # mutable inventory pointer must not suppress independent proof.
            endpoint.close=lambda:None
            owner._listener.inventory=None
        h.on_ready=sink;h.run();self.ready(h)
        self.assertEqual(h.frames[-1]['payload']['cleanupStatus'],'UNCERTAIN')
        self.assertEqual(h.frames[-1]['payload']['code'],'CLEANUP_UNCERTAIN')
        self.assertIn(h.endpoints[0].fd,h.live)

    def delayed_client(self):
        h=CompositionHarness(self).run();h.clock.wall,h.clock.mono=100,10
        delay={'wall':0,'mono':0}; callbacks=[]
        def provenance(child,pipe):
            callbacks.append((child,pipe))
            h.clock.wall+=delay['wall'];h.clock.mono+=delay['mono']
            return child is h.child and pipe is h.pipe
        policy=proxy.qualify_composition_proxy(h.nominal_binding,
            child=h.child,pipe=h.pipe,child_id='2'*32,pipe_id='3'*32,
            channel_key=h.key,admission_policy=h.policy.admission_policy,
            cleanup_budget=h.budget,provenance_validator=provenance)
        return h,proxy.ProxyCompositionClient(policy,h.clock),delay,callbacks

    def test_v1_r2_final_client_guard_follows_provenance(self):
        for stage in ('READY','REQUEST','CURRENT'):
            for change in ('wall','mono'):
                with self.subTest(stage=stage,change=change):
                    h,client,delay,_=self.delayed_client()
                    if stage!='READY':client.accept_frame(h.frame(h.frames[0]))
                    if stage=='CURRENT':client.current('4'*32,1)
                    delay[change]=90 if change=='wall' else 101
                    # Request publication has no previous round-trip deadline;
                    # monotonic progress is legal, and its send time must be fresh.
                    if stage=='REQUEST' and change=='mono':
                        client.current('4'*32,1)
                        self.assertEqual(client._pending[3],111)
                    else:
                        with self.assertRaises(proxy.ProxyError):
                            if stage=='REQUEST':client.current('4'*32,1)
                            else:client.accept_frame(h.frame(h.frames[0 if stage=='READY' else 1]))
                        deadline=h.budget.deadline
                        delay['wall']=delay['mono']=0
                        with self.assertRaises(proxy.ProxyError):client.current('5'*32,1)
                        self.assertEqual(h.budget.deadline,deadline)

    def test_v1_r3_eof_clamps_even_after_expiry_clock_failure_or_terminal(self):
        for failure in ('expired','backward','throwing','terminal'):
            with self.subTest(failure=failure):
                h,client,_,callbacks=self.delayed_client()
                client.accept_frame(h.frame(h.frames[0]));client.current('4'*32,1)
                h.budget.deadline=60010
                if failure=='expired':h.clock.wall=190
                elif failure=='backward':h.clock.mono=9
                elif failure=='throwing':h.clock.sample=lambda:(_ for _ in ()).throw(OSError('inert clock'))
                else:
                    with self.assertRaises(proxy.ProxyError):client.accept_frame(b'bad')
                count=len(callbacks)
                with self.assertRaises(proxy.ProxyError):client.accept_frame(b'')
                self.assertEqual(h.budget.deadline,0)
                self.assertEqual(h.budget.remaining(),0)
                self.assertEqual(len(callbacks),count)
                with self.assertRaises(proxy.ProxyError):client.accept_frame(b'')
                self.assertEqual(h.budget.deadline,0)

    def test_v1_r4_accepted_flags_finalize_only_owned_nonblocking_transition(self):
        for mutation in ('none','inode','flags','substitute','later-flags','refinalize'):
            with self.subTest(mutation=mutation):
                registered=[]
                def sink(h,owner):
                    endpoint=h.Endpoint();h.live[endpoint.fd][2]=524288
                    def setblocking(value):
                        row=owner._context._inventory.rows[endpoint.fd]
                        self.assertEqual(row['flags'],524288)
                        registered.append(row['ownerId'])
                        self.assertIs(value,False)
                        h.live[endpoint.fd][2]|=2048
                        if mutation=='inode':h.live[endpoint.fd][1]+=1
                        if mutation=='flags':h.live[endpoint.fd][2]|=1024
                        if mutation=='substitute':
                            stream=owner._context._inventory.endpoints[id(endpoint)][1]
                            stream.socket=types.SimpleNamespace(fileno=endpoint.fileno,
                                close=lambda:self.fail('substitute must not be closed'))
                    endpoint.setblocking=setblocking;endpoint.data=[REQUEST];h.clients.append(endpoint)
                    if mutation in ('later-flags','refinalize'):
                        def command():
                            if mutation=='later-flags':h.live[endpoint.fd][2]|=1024
                            else:owner._context._inventory.finalize_nonblocking(endpoint)
                            return h.command('PROXY_CURRENT')
                        h.pending_commands=[command]
                h=CompositionHarness(self,sink=sink).run();self.ready(h)
                self.assertEqual(len(registered),1)
                currents=[f for f in h.frames if f['kind']=='PROXY_CURRENT']
                if mutation=='none':
                    self.assertEqual(len(currents),1)
                    row=next(r for r in currents[0]['payload']['observation']['currentFDs'] if r['kind']=='PROXY_ACCEPTED_STREAM')
                    self.assertEqual((row['ownerId'],row['flags']),(registered[0],524288|2048))
                else:self.assertEqual(currents,[])
                self.assertTrue(all(e.closes==1 for e in h.endpoints))


    def test_v1_composition_entry_pins_every_frame_field(self):
        self.ready(CompositionHarness(self).run())
        for field, value in FRAME_FIELD_DENIALS:
            with self.subTest(field=field):
                def mutate(initial, field=field, value=value):
                    initial['proxyBootstrap'][field] = copy.deepcopy(value)
                h = CompositionHarness(self, mutate=mutate).run()
                # Denied before any context, descriptor, listener, owner or frame exists.
                self.assertEqual((h.exit, h.owners, h.events, h.frames), (1, [], [], []))
                self.assertEqual(h.endpoints, [])

    def test_v1_per_tunnel_close_never_starts_shared_budget(self):
        import bootstrap_composition_test as fixture
        state = dict(iteration=0, stop=False, owner=None, seen=[])
        clients = dict(eof=[b''], reset=[REQUEST, ConnectionResetError(errno.ECONNRESET, 'inert reset')],
                       idle=[REQUEST])
        def sink(h, owner):
            state['owner'] = owner
            h.clients.extend(clients.values())
            selector = owner._sockets.stop_selector; original = selector.select
            selector.select = lambda timeout: [row for row in original(timeout)
                                               if state['stop'] or row[0].fd != 3]
        h = CompositionHarness(self, commands=[b'STOP'], sink=sink)
        h.budget = fixture.t.CleanupBudget(h.clock)
        def tick():
            state['iteration'] += 1
            rows = state['owner']._context._inventory.rows.values()
            state['seen'].append((state['iteration'], h.budget.started, h.budget.deadline,
                                  sum(r['kind'] in ('PROXY_ACCEPTED_STREAM', 'PROXY_VSOCK_STREAM') for r in rows)))
            if state['iteration'] == 30: state['stop'] = True
        h.on_sleep = tick
        h.run(); self.ready(h)
        # All three tunnels (EOF before header, client ECONNRESET, idle) closed on their own,
        # with proven ledger retirement, and the shared cleanup end was never started.
        self.assertEqual(len(state['seen']), 30, 'the run must survive all three per-tunnel closes')
        self.assertEqual(state['seen'][-1], (30, False, None, 0))
        self.assertTrue(all(started is False and deadline is None for _, started, deadline, _ in state['seen']))
        self.assertEqual(max(n for *_, n in state['seen']), 2)
        self.assertEqual(sum(e.family == 40 for e in h.endpoints), 2)
        self.assertEqual((h.exit, h.frames[-1]['payload']['code'], h.frames[-1]['payload']['cleanupStatus']),
                         (0, 'COMPLETE', 'PROVEN'))
        self.assertIs(h.budget.started, True, 'the terminal STOP starts it, once')
        self.assertTrue(all(e.closes == 1 for e in h.endpoints))

if __name__ == '__main__': unittest.main()

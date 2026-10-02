"""Finite guest CONNECT-to-vsock proxy with injected, offline-testable effects."""
from dataclasses import dataclass, field
import errno
import hmac
import importlib.util
import json
import pathlib
import re


_PROTOCOL_SPEC = importlib.util.spec_from_file_location(
    'acceptance_guest_protocol', pathlib.Path(__file__).with_name('protocol.py'))
_PROTOCOL = importlib.util.module_from_spec(_PROTOCOL_SPEC)
_PROTOCOL_SPEC.loader.exec_module(_PROTOCOL)

_HOST_RE = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
                      r'(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*'
                      r'\.[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?')
_HEX32_RE = re.compile(r'[0-9a-f]{32}')
_HEX64_RE = re.compile(r'[0-9a-f]{64}')
_DESTINATIONS = ('FRONTEND', 'BACKEND')
_MAX_SAFE_INTEGER = 9007199254740991
_HEADER_LIMIT = 4096
_CONTROL_LIMIT = 256
_CHUNK_LIMIT = 4096
_MAX_TUNNELS = 16
_AGGREGATE_LIMIT = 1073741824
_IDLE_LIMIT_MS = 120000
_RUN_LIMIT_MS = 1200000
_LISTEN_ADDRESS = '127.0.0.1'
_LISTEN_PORT = 3128
_HOST_CID = 2
_VSOCK_SERVICE = 4050
_OK = b'HTTP/1.1 200 Connection Established\r\n\r\n'
_OUTCOME_CODES = frozenset({
    'BYTE_LIMIT', 'CAPACITY', 'CHANNEL_DENIED', 'CLOCK', 'COMPLETE',
    'CONFIG_DENIED', 'EXPIRED', 'IDENTITY_MISMATCH', 'IDLE_TIMEOUT',
    'INTERNAL_FAILURE', 'LISTENER_DENIED', 'TERMINAL', 'TRANSPORT_LOST',
})


class ProxyError(ValueError):
    """Finite public parser rejection; never includes owner traffic."""


class _ChannelDenied(Exception):
    pass


class _TransportLost(Exception):
    pass


class _ClockFailure(Exception):
    pass


class _RunExpired(Exception):
    pass


class _IdleExpired(Exception):
    pass


@dataclass(frozen=True)
class ChannelMessage:
    data: bytes
    ancillary: tuple = ()
    flags: int = 0


@dataclass(frozen=True)
class RunBinding:
    run_id: str
    capability: bytes
    expires_at: int
    first_sequence: int
    manifest_identity: str
    config_identity: str
    origins: tuple


@dataclass
class ProxyConfig:
    destinations: dict
    binding: RunBinding
    aggregate_bytes: int
    idle_timeout_ms: int
    run_timeout_ms: int
    clock: object
    sockets: object
    phase: str = 'PREFLIGHT'
    event: str = 'validate'
    native_admission: object = None
    _terminal: bool = field(default=False, init=False, repr=False)


@dataclass(frozen=True)
class ProxyOutcome:
    code: str
    used_bytes: int = 0


@dataclass
class _Tunnel:
    client: object
    last_progress: int
    header: bytearray = field(default_factory=bytearray)
    broker: object = None
    to_client: bytearray = field(default_factory=bytearray)
    to_broker: bytearray = field(default_factory=bytearray)
    broker_input: bytearray = field(default_factory=bytearray)
    client_eof: bool = False
    broker_eof: bool = False
    broker_write_ended: bool = False
    client_write_ended: bool = False
    closed: bool = False


def _plain_integer(value, lower, upper):
    return type(value) is int and lower <= value <= upper


def _valid_hostname(value):
    return (type(value) is str and len(value) <= 253 and value.isascii()
            and _HOST_RE.fullmatch(value) is not None)


def _validated_destinations(destinations):
    if type(destinations) is not dict or set(destinations) != set(_DESTINATIONS):
        raise ProxyError('INVALID_DESTINATIONS')
    result = {}
    for name in _DESTINATIONS:
        host = destinations[name]
        if not _valid_hostname(host) or host in result.values():
            raise ProxyError('INVALID_DESTINATIONS')
        result[name] = host
    return result


def parse_connect(data, destinations):
    """Return the exact finite destination enum for one complete CONNECT header."""
    if type(data) is not bytes or not 1 <= len(data) <= _HEADER_LIMIT:
        raise ProxyError('INVALID_CONNECT')
    try:
        hosts = _validated_destinations(destinations)
        text = data.decode('ascii', errors='strict')
    except (UnicodeError, ProxyError):
        raise ProxyError('INVALID_CONNECT') from None
    if not text.endswith('\r\n\r\n') or '\x00' in text:
        raise ProxyError('INVALID_CONNECT')
    lines = text[:-4].split('\r\n')
    if len(lines) < 2:
        raise ProxyError('INVALID_CONNECT')
    request = lines[0].split(' ')
    if len(request) != 3 or request[0] != 'CONNECT' or request[2] != 'HTTP/1.1':
        raise ProxyError('INVALID_CONNECT')
    authority = request[1]
    destination = next((name for name, host in hosts.items()
                        if authority == host + ':443'), None)
    if destination is None:
        raise ProxyError('INVALID_CONNECT')
    host_count = user_agent_count = 0
    for line in lines[1:]:
        if line.startswith('Host: '):
            host_count += 1
            if line[6:] != authority:
                raise ProxyError('INVALID_CONNECT')
        elif line.startswith('User-Agent: '):
            user_agent_count += 1
            value = line[12:]
            if not value or any(ord(character) < 0x20 or ord(character) > 0x7e
                                for character in value):
                raise ProxyError('INVALID_CONNECT')
        else:
            raise ProxyError('INVALID_CONNECT')
    if host_count != 1 or user_agent_count > 1:
        raise ProxyError('INVALID_CONNECT')
    return destination


def _control(binding, sequence, phase, event, destination):
    frame = {
        'version': 1,
        'kind': 'CONTROL',
        'runId': binding.run_id,
        'sequence': sequence,
        'payload': {
            'phase': phase,
            'event': event,
            'destination': destination,
        },
    }
    try:
        encoded = _PROTOCOL.canonical_bytes(frame)
        _PROTOCOL.decode_frame(encoded, 'CONTROL')
    except _PROTOCOL.InvalidFrame:
        raise ProxyError('INVALID_CONTROL') from None
    if len(encoded) > _CONTROL_LIMIT:
        raise ProxyError('INVALID_CONTROL')
    return encoded


def _sample(clock):
    try:
        sample = clock.sample()
    except Exception:
        raise ProxyError('INVALID_CLOCK') from None
    if (type(sample) is not tuple or len(sample) != 2
            or not _plain_integer(sample[0], 0, _MAX_SAFE_INTEGER)
            or not _plain_integer(sample[1], 0, _MAX_SAFE_INTEGER)):
        raise ProxyError('INVALID_CLOCK')
    return sample


def _validate_config(config, now):
    if type(config) is not ProxyConfig:
        raise ProxyError('INVALID_CONFIG')
    hosts = _validated_destinations(config.destinations)
    binding = config.binding
    if (type(binding) is not RunBinding
            or type(binding.run_id) is not str
            or _HEX32_RE.fullmatch(binding.run_id) is None
            or type(binding.capability) is not bytes or len(binding.capability) != 32
            or not _plain_integer(binding.expires_at, now[0] + 1, _MAX_SAFE_INTEGER)
            or not _plain_integer(binding.first_sequence, 1,
                                  _MAX_SAFE_INTEGER - (_MAX_TUNNELS - 1))
            or type(binding.manifest_identity) is not str
            or _HEX64_RE.fullmatch(binding.manifest_identity) is None
            or type(binding.config_identity) is not str
            or _HEX64_RE.fullmatch(binding.config_identity) is None):
        raise ProxyError('INVALID_CONFIG')
    expected_origins = tuple((name, 'https://' + hosts[name]) for name in _DESTINATIONS)
    if type(binding.origins) is not tuple or binding.origins != expected_origins:
        raise ProxyError('INVALID_CONFIG')
    if (not _plain_integer(config.aggregate_bytes, 1, _AGGREGATE_LIMIT)
            or not _plain_integer(config.idle_timeout_ms, 1, _IDLE_LIMIT_MS)
            or not _plain_integer(config.run_timeout_ms, 1, _RUN_LIMIT_MS)
            or not callable(getattr(config.clock, 'wait', None))
            or not callable(getattr(config.sockets, 'listen', None))):
        raise ProxyError('INVALID_CONFIG')
    if config.phase in ('FINALIZE', 'DONE', 'FAILED') or config.event == 'abort':
        raise ProxyError('INVALID_CONFIG')
    _control(binding, binding.first_sequence, config.phase, config.event, 'FRONTEND')


def _same_binding(expected, actual):
    if type(actual) is not RunBinding:
        return False
    return (actual.run_id == expected.run_id
            and type(actual.capability) is bytes
            and hmac.compare_digest(actual.capability, expected.capability)
            and actual.expires_at == expected.expires_at
            and actual.first_sequence == expected.first_sequence
            and actual.manifest_identity == expected.manifest_identity
            and actual.config_identity == expected.config_identity
            and actual.origins == expected.origins)


def _message(stream):
    try:
        message = stream.read(_CHUNK_LIMIT)
    except _ChannelDenied:
        raise
    except Exception:
        raise _TransportLost() from None
    if message is None:
        return None
    if (type(message) is not ChannelMessage or type(message.data) is not bytes
            or len(message.data) > _CHUNK_LIMIT
            or type(message.ancillary) is not tuple or message.ancillary
            or type(message.flags) is not int or message.flags != 0):
        raise _ChannelDenied()
    return message.data


def _write(stream, pending):
    if not pending:
        return False
    try:
        written = stream.write(bytes(pending[:_CHUNK_LIMIT]))
    except Exception:
        raise _TransportLost() from None
    if written is None:
        return False
    if type(written) is not int or not 1 <= written <= min(_CHUNK_LIMIT, len(pending)):
        raise _TransportLost()
    del pending[:written]
    return True


def _end_write(stream):
    try:
        stream.end_write()
    except Exception:
        raise _TransportLost() from None


def _close(stream):
    try:
        stream.close()
    except Exception:
        pass


def _close_tunnel(tunnel):
    if tunnel.closed:
        return
    tunnel.closed = True
    _close(tunnel.client)
    if tunnel.broker is not None:
        _close(tunnel.broker)


def _consume_budget(used, amount, ceiling):
    if amount > ceiling - used:
        raise OverflowError
    return used + amount


class _Timeline:
    """Check both clocks before and after every injected fallible boundary."""
    def __init__(self, config, initial):
        self.config = config
        self.start_mono = initial[1]
        self.wall, self.mono = initial

    def observe(self, tunnel=None):
        try:
            wall, monotonic = _sample(self.config.clock)
        except ProxyError:
            raise _ClockFailure() from None
        if wall < self.wall or monotonic < self.mono:
            raise _ClockFailure()
        self.wall, self.mono = wall, monotonic
        if (wall >= self.config.binding.expires_at
                or monotonic - self.start_mono >= self.config.run_timeout_ms):
            raise _RunExpired()
        if tunnel is not None and monotonic - tunnel.last_progress >= self.config.idle_timeout_ms:
            raise _IdleExpired()
        return wall, monotonic

    def progressed(self, tunnel):
        # Observe once more before renewing a lease. A read that returned after
        # the deadline is discarded and cannot revive the tunnel.
        self.observe(tunnel)
        tunnel.last_progress = self.mono


def serve_proxy(config, transport):
    """Run one injected finite proxy authority; any terminal outcome is latched."""
    if type(config) is ProxyConfig and config._terminal:
        return ProxyOutcome('TERMINAL')

    listener = None
    tunnels = []
    used = 0
    outcome = 'INTERNAL_FAILURE'
    try:
        now = _sample(config.clock)
        _validate_config(config, now)
    except Exception:
        if type(config) is ProxyConfig:
            config._terminal = True
        _close(transport)
        return ProxyOutcome('CONFIG_DENIED')

    timeline = _Timeline(config, now)

    def checked_message(stream, tunnel):
        timeline.observe(tunnel)
        try:
            return _message(stream)
        finally:
            timeline.observe(tunnel)

    def checked_write(stream, pending, tunnel):
        timeline.observe(tunnel)
        try:
            return _write(stream, pending)
        finally:
            timeline.observe(tunnel)

    def checked_end(stream, tunnel):
        timeline.observe(tunnel)
        try:
            _end_write(stream)
        finally:
            timeline.observe(tunnel)

    try:
        try:
            actual = transport.authenticate(config.binding)
        except Exception:
            timeline.observe()
            return ProxyOutcome('IDENTITY_MISMATCH')
        timeline.observe()
        if not _same_binding(config.binding, actual):
            return ProxyOutcome('IDENTITY_MISMATCH')

        try:
            listener = config.sockets.listen(_LISTEN_ADDRESS, _LISTEN_PORT, _MAX_TUNNELS)
        except Exception:
            timeline.observe()
            return ProxyOutcome('LISTENER_DENIED')
        timeline.observe()
        if getattr(listener, 'endpoint', None) != (_LISTEN_ADDRESS, _LISTEN_PORT):
            return ProxyOutcome('LISTENER_DENIED')

        sequence = config.binding.first_sequence
        while True:
            _, monotonic = timeline.observe()
            try:
                transport.check()
            except Exception:
                timeline.observe()
                outcome = 'TRANSPORT_LOST'
                break
            timeline.observe()

            try:
                client = listener.accept()
            except Exception:
                timeline.observe()
                outcome = 'LISTENER_DENIED'
                break
            try:
                timeline.observe()
            except Exception:
                if client is not None:
                    _close(client)
                raise
            if client is not None:
                if len(tunnels) >= _MAX_TUNNELS:
                    _close(client)
                    outcome = 'CAPACITY'
                    break
                tunnel = _Tunnel(client, timeline.mono)
                tunnels.append(tunnel)
                timeline.observe(tunnel)

            failure = None
            for tunnel in list(tunnels):
                progressed = False
                try:
                    timeline.observe(tunnel)
                    if tunnel.broker is None:
                        incoming = checked_message(tunnel.client, tunnel)
                        if incoming == b'':
                            raise _TransportLost()
                        if incoming:
                            tunnel.header.extend(incoming)
                            progressed = True
                            marker = tunnel.header.find(b'\r\n\r\n')
                            if marker < 0:
                                if len(tunnel.header) >= _HEADER_LIMIT:
                                    raise _ChannelDenied()
                            else:
                                header_end = marker + 4
                                if header_end > _HEADER_LIMIT:
                                    raise _ChannelDenied()
                                destination = parse_connect(bytes(tunnel.header[:header_end]),
                                                            config.destinations)
                                remainder = bytes(tunnel.header[header_end:])
                                tunnel.header.clear()
                                control = _control(config.binding, sequence, config.phase,
                                                   config.event, destination)
                                sequence += 1
                                timeline.observe(tunnel)
                                try:
                                    tunnel.broker = transport.open(
                                        _HOST_CID, _VSOCK_SERVICE, config.binding)
                                except Exception:
                                    timeline.observe(tunnel)
                                    raise _TransportLost() from None
                                timeline.observe(tunnel)
                                tunnel.to_broker.extend(len(control).to_bytes(2, 'big'))
                                tunnel.to_broker.extend(control)
                                tunnel.to_client.extend(_OK)
                                if remainder:
                                    used = _consume_budget(
                                        used, len(remainder), config.aggregate_bytes)
                                    tunnel.to_broker.extend(len(remainder).to_bytes(2, 'big'))
                                    tunnel.to_broker.extend(remainder)
                                if checked_write(tunnel.broker, tunnel.to_broker, tunnel):
                                    progressed = True
                                if checked_write(tunnel.client, tunnel.to_client, tunnel):
                                    progressed = True
                    else:
                        # A bounded single-frame queue supplies backpressure in
                        # each direction; do not keep reading behind a stalled
                        # destination.
                        if not tunnel.client_eof and not tunnel.to_broker:
                            incoming = checked_message(tunnel.client, tunnel)
                            if incoming == b'':
                                tunnel.client_eof = True
                                tunnel.to_broker.extend(b'\x00\x00')
                                progressed = True
                            elif incoming:
                                used = _consume_budget(
                                    used, len(incoming), config.aggregate_bytes)
                                tunnel.to_broker.extend(len(incoming).to_bytes(2, 'big'))
                                tunnel.to_broker.extend(incoming)
                                progressed = True
                        if not tunnel.broker_eof and not tunnel.to_client:
                            incoming = checked_message(tunnel.broker, tunnel)
                            if incoming == b'':
                                raise _TransportLost()
                            if incoming:
                                tunnel.broker_input.extend(incoming)
                                progressed = True
                                while len(tunnel.broker_input) >= 2:
                                    size = int.from_bytes(tunnel.broker_input[:2], 'big')
                                    if size > _CHUNK_LIMIT:
                                        raise _ChannelDenied()
                                    if len(tunnel.broker_input) < size + 2:
                                        break
                                    del tunnel.broker_input[:2]
                                    payload = bytes(tunnel.broker_input[:size])
                                    del tunnel.broker_input[:size]
                                    if size == 0:
                                        if tunnel.broker_input:
                                            raise _ChannelDenied()
                                        tunnel.broker_eof = True
                                        break
                                    used = _consume_budget(
                                        used, size, config.aggregate_bytes)
                                    tunnel.to_client.extend(payload)

                        if checked_write(tunnel.broker, tunnel.to_broker, tunnel):
                            progressed = True
                        if tunnel.client_eof and not tunnel.to_broker and not tunnel.broker_write_ended:
                            checked_end(tunnel.broker, tunnel)
                            tunnel.broker_write_ended = True
                            progressed = True
                        if checked_write(tunnel.client, tunnel.to_client, tunnel):
                            progressed = True
                        if tunnel.broker_eof and not tunnel.to_client and not tunnel.client_write_ended:
                            checked_end(tunnel.client, tunnel)
                            tunnel.client_write_ended = True
                            progressed = True
                        if (tunnel.client_eof and tunnel.broker_eof
                                and not tunnel.to_client and not tunnel.to_broker):
                            timeline.observe(tunnel)
                            _close_tunnel(tunnel)
                            tunnels.remove(tunnel)
                            continue
                    if progressed:
                        timeline.progressed(tunnel)
                except ProxyError:
                    failure = 'CHANNEL_DENIED'
                    break
                except _ChannelDenied:
                    failure = 'CHANNEL_DENIED'
                    break
                except OverflowError:
                    failure = 'BYTE_LIMIT'
                    break
                except _TransportLost:
                    failure = 'TRANSPORT_LOST'
                    break
            if failure is not None:
                outcome = failure
                break
            timeline.observe()
            try:
                stopped = config.sockets.stop_requested()
            finally:
                timeline.observe()
            if stopped and not tunnels:
                outcome = 'COMPLETE'
                break
            try:
                try:
                    config.clock.wait(1)
                finally:
                    timeline.observe()
            except (_ClockFailure, _RunExpired, _IdleExpired):
                raise
            except Exception:
                raise _ClockFailure() from None
    except _ClockFailure:
        outcome = 'CLOCK'
    except _RunExpired:
        outcome = 'EXPIRED'
    except _IdleExpired:
        outcome = 'IDLE_TIMEOUT'
    except ProxyError:
        outcome = 'CLOCK'
    except Exception:
        outcome = 'INTERNAL_FAILURE'
    finally:
        config._terminal = True
        for tunnel in tunnels:
            _close_tunnel(tunnel)
        if listener is not None:
            _close(listener)
        _close(transport)
    return ProxyOutcome(outcome, used)


# The inherited worker frame is a strict authenticated-controller handoff. It
# contains identities and finite policy, never a pathname, descriptor choice,
# URL, arbitrary command, or default/environment-derived authority.
_BOOTSTRAP_DEFINITIONS = {
    'Digest': {'type': 'string', 'pattern': '[0-9a-f]{64}', 'max': 64},
    'Origin': {
        'type': 'string',
        'pattern': ('https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
                    '(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*'
                    '\\.[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?'),
        'max': 253,
    },
    'RunId': {'type': 'string', 'pattern': '[0-9a-f]{32}', 'max': 32},
}
_BOOTSTRAP_RULE = {
    'type': 'object',
    'fields': {
        'aggregateBytes': {'type': 'integer', 'min': 1, 'max': _AGGREGATE_LIMIT},
        'capability': {'ref': 'Digest'},
        'configIdentity': {'ref': 'Digest'},
        'expiresAt': {'type': 'integer', 'min': 1, 'max': _MAX_SAFE_INTEGER},
        'firstSequence': {'type': 'integer', 'min': 1,
                          'max': _MAX_SAFE_INTEGER - (_MAX_TUNNELS - 1)},
        'handoff': {
            'type': 'object',
            'fields': {
                'commandFd': {'type': 'enum', 'values': [3]},
                'confined': {'type': 'enum', 'values': [True]},
                'resultFd': {'type': 'enum', 'values': [4]},
                'role': {'type': 'enum', 'values': ['PROXY']},
                'uid': {'type': 'enum', 'values': [10004]},
                'waiting': {'type': 'enum', 'values': [True]},
            },
        },
        'idleTimeoutMs': {'type': 'integer', 'min': 1, 'max': _IDLE_LIMIT_MS},
        'kind': {'type': 'enum', 'values': ['PROXY_BOOTSTRAP']},
        'manifestIdentity': {'ref': 'Digest'},
        'origins': {
            'type': 'object',
            'fields': {
                'BACKEND': {'ref': 'Origin'},
                'FRONTEND': {'ref': 'Origin'},
            },
        },
        'rolePolicyIdentity': {'ref': 'Digest'},
        'runId': {'ref': 'RunId'},
        'runTimeoutMs': {'type': 'integer', 'min': 1, 'max': _RUN_LIMIT_MS},
        'runtimeIdentity': {'ref': 'Digest'},
        'version': {'type': 'enum', 'values': [1]},
    },
}


@dataclass(frozen=True)
class NativeAdmission:
    runtime_identity: str
    role_policy_identity: str
    role: str = 'PROXY'
    uid: int = 10004
    command_fd: int = 3
    result_fd: int = 4


def _read_exact_fd(os_module, fd, size):
    if type(size) is not int or not 0 <= size <= _HEADER_LIMIT:
        raise ProxyError('BOOTSTRAP_DENIED')
    result = bytearray()
    while len(result) < size:
        try:
            part = os_module.read(fd, size - len(result))
        except Exception:
            raise ProxyError('BOOTSTRAP_DENIED') from None
        if type(part) is not bytes or not part:
            raise ProxyError('BOOTSTRAP_DENIED')
        if len(part) > size - len(result):
            raise ProxyError('BOOTSTRAP_DENIED')
        result.extend(part)
    return bytes(result)


def _read_inherited_frame(os_module):
    size = int.from_bytes(_read_exact_fd(os_module, 3, 2), 'big')
    if not 1 <= size <= _HEADER_LIMIT:
        raise ProxyError('BOOTSTRAP_DENIED')
    return _read_exact_fd(os_module, 3, size)


def _write_all_fd(os_module, fd, data):
    pending = memoryview(data)
    while pending:
        try:
            count = os_module.write(fd, pending)
        except Exception:
            raise ProxyError('RESULT_DENIED') from None
        if type(count) is not int or not 1 <= count <= len(pending):
            raise ProxyError('RESULT_DENIED')
        pending = pending[count:]


def _write_inherited_result(os_module, run_id, outcome):
    if (type(outcome) is not ProxyOutcome or _HEX32_RE.fullmatch(run_id) is None
            or outcome.code not in _OUTCOME_CODES
            or not _plain_integer(outcome.used_bytes, 0, _AGGREGATE_LIMIT)):
        raise ProxyError('RESULT_DENIED')
    value = {
        'code': outcome.code,
        'kind': 'PROXY_RESULT',
        'runId': run_id,
        'usedBytes': outcome.used_bytes,
        'version': 1,
    }
    data = json.dumps(value, sort_keys=True, separators=(',', ':')).encode('ascii')
    if not 1 <= len(data) <= 512:
        raise ProxyError('RESULT_DENIED')
    _write_all_fd(os_module, 4, len(data).to_bytes(2, 'big') + data)


def _decode_bootstrap(data, clock, sockets):
    try:
        value = _PROTOCOL.decode_document(
            data, rule=_BOOTSTRAP_RULE, definitions=_BOOTSTRAP_DEFINITIONS,
            max_bytes=_HEADER_LIMIT)
    except _PROTOCOL.InvalidFrame:
        raise ProxyError('BOOTSTRAP_DENIED') from None
    origins = value['origins']
    destinations = {
        'FRONTEND': origins['FRONTEND'][8:],
        'BACKEND': origins['BACKEND'][8:],
    }
    _validated_destinations(destinations)
    admission = NativeAdmission(value['runtimeIdentity'], value['rolePolicyIdentity'])
    binding = RunBinding(
        value['runId'], bytes.fromhex(value['capability']), value['expiresAt'],
        value['firstSequence'], value['manifestIdentity'], value['configIdentity'],
        tuple((name, origins[name]) for name in _DESTINATIONS))
    return ProxyConfig(
        destinations, binding, value['aggregateBytes'], value['idleTimeoutMs'],
        value['runTimeoutMs'], clock, sockets, native_admission=admission)


class NativeClock:
    """Linux worker clock; milliseconds, with no environment configuration."""
    def __init__(self, time_module):
        self.time = time_module

    def sample(self):
        return (int(self.time.time() * 1000), int(self.time.monotonic() * 1000))

    def wait(self, milliseconds):
        if not _plain_integer(milliseconds, 1, 1000):
            raise ProxyError('INVALID_CLOCK')
        self.time.sleep(milliseconds / 1000)


class NativeStream:
    """Owned nonblocking stream retaining recvmsg ancillary evidence."""
    def __init__(self, endpoint, socket_module):
        self.socket = endpoint
        self.module = socket_module
        self.closed = False

    def read(self, max_bytes):
        if self.closed or not _plain_integer(max_bytes, 1, _CHUNK_LIMIT):
            raise OSError('stream')
        try:
            data, ancillary, flags, _ = self.socket.recvmsg(
                max_bytes, self.module.CMSG_SPACE(4))
        except BlockingIOError:
            return None
        if type(data) is not bytes or type(flags) is not int:
            raise OSError('stream')
        if ancillary or flags != 0:
            raise _ChannelDenied()
        return ChannelMessage(data, tuple(ancillary), flags)

    def write(self, data):
        if self.closed or type(data) is not bytes or not 1 <= len(data) <= _CHUNK_LIMIT:
            raise OSError('stream')
        try:
            return self.socket.send(data)
        except BlockingIOError:
            return None

    def end_write(self):
        if self.closed:
            raise OSError('stream')
        self.socket.shutdown(self.module.SHUT_WR)

    def close(self):
        if not self.closed:
            self.closed = True
            self.socket.close()


class NativeListener:
    def __init__(self, endpoint, socket_module):
        self.socket = endpoint
        self.module = socket_module
        self.endpoint = ('127.0.0.1', 3128)
        self.closed = False

    def accept(self):
        if self.closed:
            raise OSError('listener')
        try:
            endpoint, _ = self.socket.accept()
        except BlockingIOError:
            return None
        try:
            endpoint.setblocking(False)
            return NativeStream(endpoint, self.module)
        except Exception:
            endpoint.close()
            raise

    def close(self):
        if not self.closed:
            self.closed = True
            self.socket.close()


class NativeSockets:
    """Exact loopback listener plus fixed inherited STOP/EOF probe."""
    def __init__(self, socket_module, selectors_module, *, stop_fd, os_module):
        if stop_fd != 3:
            raise ProxyError('BOOTSTRAP_DENIED')
        self.module = socket_module
        self.selectors = selectors_module
        self.stop_fd = stop_fd
        self.os = os_module
        self.listener = None
        self.stop_selector = None
        self.stop_data = bytearray()
        self.stopped = False
        self.closed = False

    def listen(self, address, port, backlog):
        if (address, port, backlog) != ('127.0.0.1', 3128, 16) or self.listener is not None:
            raise ProxyError('LISTENER_DENIED')
        kind = self.module.SOCK_STREAM | self.module.SOCK_NONBLOCK | self.module.SOCK_CLOEXEC
        endpoint = self.module.socket(self.module.AF_INET, kind, 0)
        try:
            endpoint.setblocking(False)
            endpoint.bind(('127.0.0.1', 3128))
            endpoint.listen(16)
            if endpoint.getsockname() != ('127.0.0.1', 3128):
                raise ProxyError('LISTENER_DENIED')
            self.listener = NativeListener(endpoint, self.module)
            return self.listener
        except Exception:
            endpoint.close()
            raise

    def stop_requested(self):
        if self.closed or self.stopped:
            return True
        if self.stop_selector is None:
            selector = self.selectors.DefaultSelector()
            selector.register(self.stop_fd, self.selectors.EVENT_READ)
            self.stop_selector = selector
        if not self.stop_selector.select(0):
            return False
        data = self.os.read(self.stop_fd, 4 - len(self.stop_data))
        if type(data) is not bytes or len(data) > 4 - len(self.stop_data):
            raise OSError('unexpected inherited command data')
        if data == b'':
            if self.stop_data:
                raise OSError('truncated inherited command')
            self.stopped = True
            return True
        self.stop_data.extend(data)
        if not b'STOP'.startswith(self.stop_data):
            raise OSError('unexpected inherited command data')
        if self.stop_data == b'STOP':
            self.stopped = True
            return True
        return False

    def close(self):
        if not self.closed:
            self.closed = True
            if self.listener is not None:
                self.listener.close()
            if self.stop_selector is not None:
                self.stop_selector.close()


class NativeVsockTransport:
    """One-use binding and fixed AF_VSOCK CID2/service4050 connector."""
    def __init__(self, socket_module, selectors_module, binding, host_cid, service,
                 connect_timeout_ms=10000):
        if (host_cid, service) != (2, 4050):
            raise ProxyError('TRANSPORT_DENIED')
        if not _plain_integer(connect_timeout_ms, 1, _IDLE_LIMIT_MS):
            raise ProxyError('TRANSPORT_DENIED')
        self.module = socket_module
        self.selectors = selectors_module
        self.binding = binding
        self.host_cid = host_cid
        self.service = service
        self.connect_timeout_ms = connect_timeout_ms
        self.claimed = False
        self.closed = False
        self.streams = []

    def authenticate(self, binding):
        if self.closed or self.claimed or not _same_binding(self.binding, binding):
            raise OSError('identity')
        self.claimed = True
        return self.binding

    def check(self):
        if self.closed or not self.claimed:
            raise OSError('transport')

    def open(self, cid, service, binding):
        if (cid, service) != (2, 4050) or not _same_binding(self.binding, binding):
            raise ProxyError('TRANSPORT_DENIED')
        if self.closed or not self.claimed:
            raise OSError('transport')
        kind = self.module.SOCK_STREAM | self.module.SOCK_NONBLOCK | self.module.SOCK_CLOEXEC
        endpoint = self.module.socket(self.module.AF_VSOCK, kind, 0)
        try:
            endpoint.setblocking(False)
            result = endpoint.connect_ex((2, 4050))
            pending = {errno.EINPROGRESS, errno.EALREADY, errno.EWOULDBLOCK}
            if result != 0:
                if result not in pending:
                    raise OSError(result, 'vsock connect')
                selector = self.selectors.DefaultSelector()
                try:
                    selector.register(endpoint, self.selectors.EVENT_WRITE)
                    if not selector.select(self.connect_timeout_ms / 1000):
                        raise OSError('vsock timeout')
                    error = endpoint.getsockopt(self.module.SOL_SOCKET, self.module.SO_ERROR)
                    if error != 0:
                        raise OSError(error, 'vsock connect')
                finally:
                    selector.close()
            stream = NativeStream(endpoint, self.module)
            self.streams.append(stream)
            return stream
        except Exception:
            endpoint.close()
            raise

    def close(self):
        if not self.closed:
            self.closed = True
            for stream in self.streams:
                stream.close()


_NATIVE_BINDINGS_SEAL = object()


@dataclass(frozen=True)
class NativeBindings:
    os: object
    socket: object
    selectors: object
    time: object
    runner: object
    _seal: object = field(repr=False)


def qualify_native_bindings(os_module, socket_module, selectors_module, time_module,
                            *, platform_name, machine, runner=serve_proxy):
    """Select native effects only for the pinned Linux AArch64 worker."""
    if platform_name != 'linux' or machine != 'aarch64':
        raise ProxyError('NATIVE_DENIED')
    if (not all(callable(getattr(os_module, name, None)) for name in ('read', 'write', 'close'))
            or not callable(getattr(socket_module, 'socket', None))
            or not callable(getattr(socket_module, 'CMSG_SPACE', None))
            or not callable(getattr(selectors_module, 'DefaultSelector', None))
            or not all(callable(getattr(time_module, name, None))
                       for name in ('time', 'monotonic', 'sleep'))
            or not callable(runner)):
        raise ProxyError('NATIVE_DENIED')
    for name in ('AF_INET', 'AF_VSOCK', 'SOCK_STREAM', 'SOCK_NONBLOCK',
                 'SOCK_CLOEXEC', 'SOL_SOCKET', 'SO_ERROR', 'SHUT_WR',
                 'MSG_CTRUNC'):
        if type(getattr(socket_module, name, None)) is not int:
            raise ProxyError('NATIVE_DENIED')
    for name in ('EVENT_READ', 'EVENT_WRITE'):
        if type(getattr(selectors_module, name, None)) is not int:
            raise ProxyError('NATIVE_DENIED')
    return NativeBindings(os_module, socket_module, selectors_module, time_module,
                          runner, _NATIVE_BINDINGS_SEAL)


def inherited_main(arguments, bindings):
    """Fixed Task8 `proxy.py --inherited` entry; no argv/env/FD widening."""
    if tuple(arguments) != ('--inherited',):
        return 64
    if type(bindings) is not NativeBindings or bindings._seal is not _NATIVE_BINDINGS_SEAL:
        return 1
    sockets = transport = None
    try:
        clock = NativeClock(bindings.time)
        sockets = NativeSockets(bindings.socket, bindings.selectors,
                                stop_fd=3, os_module=bindings.os)
        frame = _read_inherited_frame(bindings.os)
        config = _decode_bootstrap(frame, clock, sockets)
        if (type(config.native_admission) is not NativeAdmission
                or config.native_admission.command_fd != 3
                or config.native_admission.result_fd != 4):
            raise ProxyError('BOOTSTRAP_DENIED')
        transport = NativeVsockTransport(
            bindings.socket, bindings.selectors, config.binding, 2, 4050,
            config.idle_timeout_ms)
        outcome = bindings.runner(config, transport)
        _write_inherited_result(bindings.os, config.binding.run_id, outcome)
        return 0 if outcome.code == 'COMPLETE' else 1
    except Exception:
        return 1
    finally:
        if sockets is not None:
            sockets.close()
        if transport is not None:
            transport.close()
        for fd in (3, 4):
            try:
                bindings.os.close(fd)
            except Exception:
                pass


def _system_bindings():
    # Lazy imports ensure module import and all offline tests are effect-free.
    import os
    import platform
    import selectors
    import socket
    import sys
    import time
    return qualify_native_bindings(
        os, socket, selectors, time, platform_name=sys.platform,
        machine=platform.machine(), runner=serve_proxy)


def main(arguments=None):
    import sys
    args = tuple(sys.argv[1:] if arguments is None else arguments)
    if args != ('--inherited',):
        return 64
    try:
        bindings = _system_bindings()
    except ProxyError:
        return 1
    return inherited_main(args, bindings)


if __name__ == '__main__':
    raise SystemExit(main())

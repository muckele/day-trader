"""Finite guest CONNECT-to-vsock proxy with injected, offline-testable effects."""
from dataclasses import dataclass, field
import hmac
import importlib.util
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


class ProxyError(ValueError):
    """Finite public parser rejection; never includes owner traffic."""


class _ChannelDenied(Exception):
    pass


class _TransportLost(Exception):
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

    try:
        try:
            actual = transport.authenticate(config.binding)
        except Exception:
            return ProxyOutcome('IDENTITY_MISMATCH')
        if not _same_binding(config.binding, actual):
            return ProxyOutcome('IDENTITY_MISMATCH')

        try:
            listener = config.sockets.listen(_LISTEN_ADDRESS, _LISTEN_PORT, _MAX_TUNNELS)
        except Exception:
            return ProxyOutcome('LISTENER_DENIED')
        if getattr(listener, 'endpoint', None) != (_LISTEN_ADDRESS, _LISTEN_PORT):
            return ProxyOutcome('LISTENER_DENIED')

        start_mono = previous_mono = now[1]
        sequence = config.binding.first_sequence
        while True:
            wall, monotonic = _sample(config.clock)
            if monotonic < previous_mono:
                outcome = 'CLOCK'
                break
            previous_mono = monotonic
            if wall >= config.binding.expires_at or monotonic - start_mono >= config.run_timeout_ms:
                outcome = 'EXPIRED'
                break
            try:
                transport.check()
            except Exception:
                outcome = 'TRANSPORT_LOST'
                break

            try:
                client = listener.accept()
            except Exception:
                outcome = 'LISTENER_DENIED'
                break
            if client is not None:
                if len(tunnels) >= _MAX_TUNNELS:
                    _close(client)
                    outcome = 'CAPACITY'
                    break
                tunnels.append(_Tunnel(client, monotonic))

            failure = None
            for tunnel in list(tunnels):
                progressed = False
                try:
                    if tunnel.broker is None:
                        incoming = _message(tunnel.client)
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
                                try:
                                    tunnel.broker = transport.open(
                                        _HOST_CID, _VSOCK_SERVICE, config.binding)
                                except Exception:
                                    raise _TransportLost() from None
                                tunnel.to_broker.extend(len(control).to_bytes(2, 'big'))
                                tunnel.to_broker.extend(control)
                                tunnel.to_client.extend(_OK)
                                if remainder:
                                    used = _consume_budget(
                                        used, len(remainder), config.aggregate_bytes)
                                    tunnel.to_broker.extend(len(remainder).to_bytes(2, 'big'))
                                    tunnel.to_broker.extend(remainder)
                                # Establishment bytes precede any broker response.
                                if _write(tunnel.broker, tunnel.to_broker):
                                    progressed = True
                                if _write(tunnel.client, tunnel.to_client):
                                    progressed = True
                    else:
                        # A bounded single-frame queue supplies backpressure in
                        # each direction; do not keep reading behind a stalled
                        # destination.
                        if not tunnel.client_eof and not tunnel.to_broker:
                            incoming = _message(tunnel.client)
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
                            incoming = _message(tunnel.broker)
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

                        if _write(tunnel.broker, tunnel.to_broker):
                            progressed = True
                        if tunnel.client_eof and not tunnel.to_broker and not tunnel.broker_write_ended:
                            _end_write(tunnel.broker)
                            tunnel.broker_write_ended = True
                            progressed = True
                        if _write(tunnel.client, tunnel.to_client):
                            progressed = True
                        if tunnel.broker_eof and not tunnel.to_client and not tunnel.client_write_ended:
                            _end_write(tunnel.client)
                            tunnel.client_write_ended = True
                            progressed = True
                        if (tunnel.client_eof and tunnel.broker_eof
                                and not tunnel.to_client and not tunnel.to_broker):
                            _close_tunnel(tunnel)
                            tunnels.remove(tunnel)
                            continue
                    if progressed:
                        tunnel.last_progress = monotonic
                    elif monotonic - tunnel.last_progress >= config.idle_timeout_ms:
                        failure = 'IDLE_TIMEOUT'
                        break
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
            if config.sockets.stop_requested() and not tunnels:
                outcome = 'COMPLETE'
                break
            try:
                config.clock.wait(1)
            except Exception:
                outcome = 'CLOCK'
                break
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

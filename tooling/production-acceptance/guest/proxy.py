"""Finite guest CONNECT-to-vsock proxy with injected, offline-testable effects."""
from dataclasses import dataclass, field
import errno
import hashlib
import hmac
import importlib.util
import json
import pathlib
import re
import secrets
import sys
import threading
import time
import weakref


_CONFINEMENT_NAME = '_acceptance_topology_confinement'
if _CONFINEMENT_NAME not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        _CONFINEMENT_NAME, pathlib.Path(__file__).with_name('confinement.py'))
    _module = importlib.util.module_from_spec(_spec)
    sys.modules[_CONFINEMENT_NAME] = _module
    _spec.loader.exec_module(_module)
CompositionBinding = sys.modules[_CONFINEMENT_NAME].CompositionBinding


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
# One sequence per tunnel (one vsock stream) for the whole run (T9-8, C9).
_MAX_TUNNELS_PER_RUN = 1024
_MAX_FIRST_SEQUENCE = _MAX_SAFE_INTEGER - (_MAX_TUNNELS_PER_RUN - 1)
# P36: on the client socket only, these errnos are an ordinary browser close.
_CLIENT_CLOSE_ERRNOS = frozenset({errno.ECONNRESET, errno.EPIPE, errno.ENOTCONN})
_AGGREGATE_LIMIT = 1073741824
_IDLE_LIMIT_MS = 120000
_RUN_LIMIT_MS = 1200000
_LISTEN_ADDRESS = '127.0.0.1'
_LISTEN_PORT = 3128
_HOST_CID = 2
_VSOCK_SERVICE = 4050
# C4 (E3): the host challenges every vsock stream with a frame of a 2-byte length (exactly 16)
# and 16 random bytes. The proxy answers with its control frame, then a proof frame of a 2-byte
# length (32) and stream_proof(...), keyed by k_vsock, the only key it holds (R6, P10).
VSOCK_PROOF_DOMAIN = b'acceptance:vsock-stream:v1\0'
_NONCE_SIZE = 16
_CHALLENGE_HEADER = _NONCE_SIZE.to_bytes(2, 'big')
_CHALLENGE_SIZE = 2 + _NONCE_SIZE
_PROOF_HEADER = (32).to_bytes(2, 'big')
_OK = b'HTTP/1.1 200 Connection Established\r\n\r\n'
_OUTCOME_CODES = frozenset({
    'BYTE_LIMIT', 'CAPACITY', 'CHANNEL_DENIED', 'CLOCK', 'COMPLETE',
    'CONFIG_DENIED', 'CLEANUP_UNCERTAIN', 'EXPIRED', 'IDENTITY_MISMATCH', 'IDLE_TIMEOUT',
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


class _TunnelClosed(Exception):
    """An ordinary event of one tunnel; it never ends the run (T9-2, P36)."""


class _TerminalOutcome(Exception):
    def __init__(self, code):
        self.code = code


@dataclass(frozen=True)
class ChannelMessage:
    data: bytes
    ancillary: tuple = ()
    flags: int = 0


@dataclass(frozen=True)
class RunBinding:
    run_id: str
    # R6/P10 (C3): k_vsock = derive(capability, 'vsock-stream'). The proxy never holds the run
    # capability; the bootstrap and the host keep it.
    vsock_key: bytes = field(repr=False)
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
    # T9-7 (C9): the proxy and the host broker are phase-unaware. CONTROL.phase and .event are
    # fixed constants (the native decoder never sets them); the route gate is the phase authority.
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
    client_closed: bool = False
    broker_closed: bool = False
    closed: bool = False
    # C4 stream setup: the parsed CONNECT waits for the setup slot, its stream then reads the
    # host's challenge, and `setup` counts its control and proof bytes not yet written.
    destination: str = None
    remainder: bytes = b''
    sequence: int = None
    challenge: bytearray = field(default_factory=bytearray)
    established: bool = False
    setup: int = 0


def _in_setup(tunnel):
    """Between its vsock connect and its fully written proof (C4)."""
    return tunnel.broker is not None and (not tunnel.established or tunnel.setup > 0)


def _check_challenge(frame):
    """C4: the challenge frame's length is exactly 16; any other length is a protocol violation."""
    head = bytes(frame[:2])
    if head != _CHALLENGE_HEADER[:len(head)]:
        raise _ChannelDenied()


def stream_proof(vsock_key, nonce, run_id, sequence):
    """C4: HMAC-SHA256(k_vsock, domain || nonce || runId (32 ASCII hex) || sequence (8-byte BE))."""
    if (type(vsock_key) is not bytes or len(vsock_key) != 32
            or type(nonce) is not bytes or len(nonce) != _NONCE_SIZE
            or type(run_id) is not str or _HEX32_RE.fullmatch(run_id) is None
            or not _plain_integer(sequence, 1, _MAX_SAFE_INTEGER)):
        raise ProxyError('INVALID_PROOF')
    message = VSOCK_PROOF_DOMAIN + nonce + run_id.encode('ascii') + sequence.to_bytes(8, 'big')
    return hmac.new(vsock_key, message, hashlib.sha256).digest()


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
    host_count = user_agent_count = keep_alive_count = 0
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
        elif line == 'Proxy-Connection: keep-alive':
            # T9-1: Chromium's proxy client always sends exactly this line.
            keep_alive_count += 1
        else:
            raise ProxyError('INVALID_CONNECT')
    if host_count != 1 or user_agent_count > 1 or keep_alive_count > 1:
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
            or type(binding.vsock_key) is not bytes or len(binding.vsock_key) != 32
            or not _plain_integer(binding.expires_at, now[0] + 1, _MAX_SAFE_INTEGER)
            or not _plain_integer(binding.first_sequence, 1, _MAX_FIRST_SEQUENCE)
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
            and type(actual.vsock_key) is bytes
            and hmac.compare_digest(actual.vsock_key, expected.vsock_key)
            and actual.expires_at == expected.expires_at
            and actual.first_sequence == expected.first_sequence
            and actual.manifest_identity == expected.manifest_identity
            and actual.config_identity == expected.config_identity
            and actual.origins == expected.origins)


def _io_failure(error, client):
    """P36: exactly ECONNRESET, EPIPE or ENOTCONN on the client socket closes only
    that tunnel. Every other client error and every vsock-side error is loss."""
    if (client and isinstance(error, OSError) and type(error.errno) is int
            and error.errno in _CLIENT_CLOSE_ERRNOS):
        return _TunnelClosed()
    return _TransportLost()


def _message(stream, client=False, limit=_CHUNK_LIMIT):
    try:
        message = stream.read(limit)
    except _ChannelDenied:
        raise
    except Exception as error:
        raise _io_failure(error, client) from None
    if message is None:
        return None
    if (type(message) is not ChannelMessage or type(message.data) is not bytes
            or len(message.data) > limit
            or type(message.ancillary) is not tuple or message.ancillary
            or type(message.flags) is not int or message.flags != 0):
        raise _ChannelDenied()
    return message.data


def _write(stream, pending, client=False):
    if not pending:
        return False
    try:
        written = stream.write(bytes(pending[:_CHUNK_LIMIT]))
    except Exception as error:
        raise _io_failure(error, client) from None
    if written is None:
        return False
    if type(written) is not int or not 1 <= written <= min(_CHUNK_LIMIT, len(pending)):
        raise _TransportLost()
    del pending[:written]
    return True


def _end_write(stream, client=False):
    try:
        stream.end_write()
    except Exception as error:
        raise _io_failure(error, client) from None


def _close(stream):
    try:
        stream.close()
        return True
    except Exception:
        return False


def _close_tunnel(tunnel):
    if tunnel.closed:
        return True
    if not tunnel.client_closed:
        tunnel.client_closed = _close(tunnel.client)
    if tunnel.broker is None:
        tunnel.broker_closed = True
    elif not tunnel.broker_closed:
        tunnel.broker_closed = _close(tunnel.broker)
    tunnel.closed = tunnel.client_closed and tunnel.broker_closed
    return tunnel.closed


def _next_record(buffer):
    """Remove and return the next complete broker record's payload from BUFFER, or None
    if incomplete. b'' is the logical EOF. A record over 4096 bytes, or any byte after a
    logical EOF, is a protocol violation."""
    if len(buffer) < 2:
        return None
    size = int.from_bytes(buffer[:2], 'big')
    if size > _CHUNK_LIMIT:
        raise _ChannelDenied()
    if len(buffer) < size + 2:
        return None
    payload = bytes(buffer[2:size + 2])
    del buffer[:size + 2]
    if size == 0 and buffer:
        raise _ChannelDenied()
    return payload


def _header_end(header):
    """End offset of a complete CONNECT header, or None while it is incomplete. A
    header that cannot end within 4096 bytes is a protocol violation."""
    marker = header.find(b'\r\n\r\n')
    if marker < 0:
        if len(header) >= _HEADER_LIMIT:
            raise _ChannelDenied()
        return None
    if marker + 4 > _HEADER_LIMIT:
        raise _ChannelDenied()
    return marker + 4


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


def serve_proxy(config, transport, *, composition=None, runtime_sink=None):
    """Run one injected finite proxy authority; any terminal outcome is latched."""
    if type(config) is ProxyConfig and config._terminal:
        return ProxyOutcome('TERMINAL')

    listener = None
    tunnels = []
    used = 0
    outcome = 'INTERNAL_FAILURE'
    runtime = None
    try:
        now = _sample(config.clock)
        _validate_config(config, now)
        if composition is not None:
            if type(composition) is not ProxyCompositionContext or composition not in _COMPOSITION_CONTEXTS:
                raise ProxyError('ADMISSION_DENIED')
            composition._claim(config, transport)
    except Exception:
        if type(config) is ProxyConfig:
            config._terminal = True
        return ProxyOutcome('CONFIG_DENIED' if _close(transport)
                            else 'CLEANUP_UNCERTAIN')

    timeline = _Timeline(config, now)

    def bracket(tunnel, operation):
        timeline.observe(tunnel)
        try:
            return operation()
        except Exception:
            # Run expiry and clock faults still come first. A failure is never
            # absorbed by this tunnel's idle deadline (P37); the idle deadline
            # only discards data that arrived after it.
            timeline.observe()
            raise

    def checked_message(stream, tunnel, client, limit=_CHUNK_LIMIT):
        data = bracket(tunnel, lambda: _message(stream, client, limit))
        if data == b'' and not client:
            # Physical vsock EOF is loss, never logical EOF or an idle close.
            timeline.observe()
            raise _TransportLost()
        try:
            timeline.observe(tunnel)
        except _IdleExpired:
            if data:
                examine_late(tunnel, data, client)
            raise
        return data

    def examine_late(tunnel, data, client):
        """Bytes read across the idle deadline are discarded, never forwarded or
        charged, but a protocol violation in them, with what is already buffered,
        still ends the whole run. The same framing and header checks run on a copy."""
        if not client and not tunnel.established:
            _check_challenge(tunnel.challenge + data)
        elif not client:
            late = bytearray(tunnel.broker_input)
            late.extend(data)
            while _next_record(late):
                pass
        elif tunnel.broker is None:
            late = bytes(tunnel.header) + data
            header_end = _header_end(late)
            if header_end is not None:
                parse_connect(late[:header_end], config.destinations)

    def checked_write(stream, pending, tunnel, client):
        written = bracket(tunnel, lambda: _write(stream, pending, client))
        timeline.observe(tunnel)
        return written

    def checked_end(stream, tunnel, client):
        bracket(tunnel, lambda: _end_write(stream, client))
        timeline.observe(tunnel)

    def write_broker(tunnel):
        pending = len(tunnel.to_broker)
        written = checked_write(tunnel.broker, tunnel.to_broker, tunnel, False)
        # The stream's setup ends once its control and proof frames are fully written.
        tunnel.setup = max(0, tunnel.setup - (pending - len(tunnel.to_broker)))
        return written

    def close_one(tunnel):
        """Close one tunnel after an ordinary per-tunnel event (T9-2, P35-P37).

        Bytes stay charged and nothing is retried. The shared cleanup budget is
        never touched. The transport is re-checked first, so a per-tunnel close
        never masks a whole-run cause such as a vsock connect timeout. Returns a
        whole-run outcome, or None when the run continues.
        """
        timeline.observe()
        try:
            transport.check()
        except Exception:
            timeline.observe()
            return 'TRANSPORT_LOST'
        timeline.observe()
        # A proven close of both endpoints, else whole-run uncertainty.
        if not _close_tunnel(tunnel):
            return 'CLEANUP_UNCERTAIN'
        tunnels.remove(tunnel)
        timeline.observe()
        return None

    try:
        # One use per run. Streams are authenticated by the host's challenge (C4), not here.
        try:
            transport.claim()
        except Exception:
            timeline.observe()
            raise _TerminalOutcome('IDENTITY_MISMATCH') from None
        timeline.observe()

        try:
            listener = config.sockets.listen(_LISTEN_ADDRESS, _LISTEN_PORT, _MAX_TUNNELS)
        except Exception:
            timeline.observe()
            raise _TerminalOutcome('LISTENER_DENIED') from None
        timeline.observe()
        if getattr(listener, 'endpoint', None) != (_LISTEN_ADDRESS, _LISTEN_PORT):
            raise _TerminalOutcome('LISTENER_DENIED')

        if composition is not None:
            config.sockets._ensure_selector()
            runtime = ProxyRuntimeOwner(composition, config, transport, listener,
                                        timeline, _COMPOSITION_SEAL)
            composition._runtime = runtime
            composition._send('PROXY_READY', {'observation': runtime._observe('READY').to_record()})
            sink = runtime_sink if runtime_sink is not None else composition._policy.runtime_sink
            if sink is not None:
                sink(runtime)

        sequence = config.binding.first_sequence
        while True:
            if runtime is not None:
                runtime._check()
            _, monotonic = timeline.observe()
            try:
                transport.check()
            except Exception:
                timeline.observe()
                outcome = 'TRANSPORT_LOST'
                break
            timeline.observe()

            # P35: at 16 live tunnels, further clients wait in the kernel listen
            # backlog and are accepted when a tunnel closes. accept() is not called
            # at capacity, so a readable listener cannot spin the loop; STOP and
            # FD3 EOF are still checked and the 1 ms wait still runs every pass.
            if len(tunnels) < _MAX_TUNNELS:
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
                    # Its idle lease is checked in the per-tunnel pass below.
                    tunnels.append(_Tunnel(client, timeline.mono))

            failure = None
            for tunnel in list(tunnels):
                progressed = False
                try:
                    timeline.observe(tunnel)
                    if tunnel.broker is None:
                        if tunnel.destination is None:
                            incoming = checked_message(tunnel.client, tunnel, True)
                            if incoming == b'':
                                # Client EOF before its header closes only this tunnel.
                                raise _TunnelClosed()
                            if incoming:
                                tunnel.header.extend(incoming)
                                progressed = True
                                header_end = _header_end(tunnel.header)
                                if header_end is not None:
                                    tunnel.destination = parse_connect(
                                        bytes(tunnel.header[:header_end]), config.destinations)
                                    tunnel.remainder = bytes(tunnel.header[header_end:])
                                    tunnel.header.clear()
                        # C4 and the T9 broker sequence-ordering note: at most one stream is
                        # between its vsock connect and its fully written proof, and streams
                        # open in sequence order. A parsed CONNECT waits here meanwhile.
                        if tunnel.destination is not None and not any(map(_in_setup, tunnels)):
                            # The 1025th CONNECT of the run latches before its vsock opens.
                            if sequence - config.binding.first_sequence >= _MAX_TUNNELS_PER_RUN:
                                raise _TerminalOutcome('CAPACITY')
                            # The stream consumes its sequence before its control is delivered;
                            # a per-tunnel close from here on leaves a gap (P38).
                            tunnel.sequence = sequence
                            sequence += 1
                            timeline.observe(tunnel)
                            try:
                                tunnel.broker = transport.open(
                                    _HOST_CID, _VSOCK_SERVICE, config.binding)
                            except Exception:
                                timeline.observe()
                                raise _TransportLost() from None
                            timeline.observe(tunnel)
                            progressed = True
                    if tunnel.broker is not None and not tunnel.established:
                        # C4: read exactly the host's challenge frame, within the idle deadline.
                        incoming = checked_message(tunnel.broker, tunnel, False,
                                                   _CHALLENGE_SIZE - len(tunnel.challenge))
                        if incoming:
                            tunnel.challenge.extend(incoming)
                            progressed = True
                            _check_challenge(tunnel.challenge)
                            if len(tunnel.challenge) == _CHALLENGE_SIZE:
                                # Answer: the control frame, then the proof frame.
                                control = _control(config.binding, tunnel.sequence, config.phase,
                                                   config.event, tunnel.destination)
                                proof = stream_proof(config.binding.vsock_key,
                                                     bytes(tunnel.challenge[2:]),
                                                     config.binding.run_id, tunnel.sequence)
                                tunnel.to_broker.extend(len(control).to_bytes(2, 'big'))
                                tunnel.to_broker.extend(control)
                                tunnel.to_broker.extend(_PROOF_HEADER)
                                tunnel.to_broker.extend(proof)
                                tunnel.setup = len(tunnel.to_broker)
                                tunnel.established = True
                                tunnel.to_client.extend(_OK)
                                if tunnel.remainder:
                                    used = _consume_budget(
                                        used, len(tunnel.remainder), config.aggregate_bytes)
                                    tunnel.to_broker.extend(len(tunnel.remainder).to_bytes(2, 'big'))
                                    tunnel.to_broker.extend(tunnel.remainder)
                                    tunnel.remainder = b''
                    if tunnel.established:
                        # A bounded single-frame queue supplies backpressure in
                        # each direction; do not keep reading behind a stalled
                        # destination.
                        if not tunnel.client_eof and not tunnel.to_broker:
                            incoming = checked_message(tunnel.client, tunnel, True)
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
                            incoming = checked_message(tunnel.broker, tunnel, False)
                            if incoming:
                                tunnel.broker_input.extend(incoming)
                                progressed = True
                                while True:
                                    payload = _next_record(tunnel.broker_input)
                                    if payload is None:
                                        break
                                    if not payload:
                                        tunnel.broker_eof = True
                                        break
                                    used = _consume_budget(
                                        used, len(payload), config.aggregate_bytes)
                                    tunnel.to_client.extend(payload)

                        if write_broker(tunnel):
                            progressed = True
                        if tunnel.client_eof and not tunnel.to_broker and not tunnel.broker_write_ended:
                            checked_end(tunnel.broker, tunnel, False)
                            tunnel.broker_write_ended = True
                            progressed = True
                        if checked_write(tunnel.client, tunnel.to_client, tunnel, True):
                            progressed = True
                        if tunnel.broker_eof and not tunnel.to_client and not tunnel.client_write_ended:
                            checked_end(tunnel.client, tunnel, True)
                            tunnel.client_write_ended = True
                            progressed = True
                        if (tunnel.client_eof and tunnel.broker_eof
                                and not tunnel.to_client and not tunnel.to_broker):
                            timeline.observe(tunnel)
                            if _close_tunnel(tunnel):
                                tunnels.remove(tunnel)
                                continue
                            else:
                                failure = 'CLEANUP_UNCERTAIN'
                                break
                    if progressed:
                        timeline.progressed(tunnel)
                except (_TunnelClosed, _IdleExpired):
                    # Idle, client EOF before the header, or a client close errno.
                    failure = close_one(tunnel)
                    if failure is not None:
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
            timeline.observe()
            try:
                stopped = config.sockets.stop_requested()
            finally:
                timeline.observe()
            if stopped:
                # STOP or FD3 EOF ends admission at once in every mode (T9-6):
                # the finally block closes the listener, which resets backlog
                # clients, and every tunnel.
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
        # Defensive only: idle is raised for a tunnel and handled per tunnel above.
        outcome = 'IDLE_TIMEOUT'
    except _TerminalOutcome as terminal:
        outcome = terminal.code
    except _ChannelDenied:
        outcome = 'CHANNEL_DENIED'
    except ProxyError:
        outcome = 'CHANNEL_DENIED' if composition is not None else 'CLOCK'
    except Exception:
        outcome = 'INTERNAL_FAILURE'
    finally:
        config._terminal = True
        if composition is not None:
            composition._invalidate()
            cleaned = composition._cleanup(passes=1)
        else:
            cleaned = True
            for tunnel in tunnels:
                cleaned = _close_tunnel(tunnel) and cleaned
            if listener is not None:
                cleaned = _close(listener) and cleaned
            cleaned = _close(transport) and cleaned
        if not cleaned:
            outcome = 'CLEANUP_UNCERTAIN'
    return ProxyOutcome(outcome, used)


# A v2 document carries correlations, never authority. Only this independently
# supplied policy and the live serving invocation populate the nominal stores.
_COMPOSITION_SEAL = object()
_COMPOSITION_POLICIES = weakref.WeakSet()
_ENTERED_POLICIES = weakref.WeakSet()
_COMPOSITION_CONTEXTS = weakref.WeakSet()
_CONTEXT_ORIGINALS = weakref.WeakKeyDictionary()
_RUNTIME_OWNERS = weakref.WeakKeyDictionary()
_OBSERVATIONS = weakref.WeakSet()
_COMPOSITION_DOMAIN = b'acceptance:bootstrap-composition:v1\0PROXY:'
_FD_LIMITS = {'PROXY_LISTENER': 1, 'PROXY_STOP_SELECTOR': 1,
              'PROXY_ACCEPTED_STREAM': 16, 'PROXY_VSOCK_STREAM': 16,
              'PROXY_CONNECT_SELECTOR': 16}


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=True, allow_nan=False).encode('ascii')


def _exact(value, fields):
    if type(value) is not dict or set(value) != set(fields):
        raise ProxyError('CHANNEL_DENIED')


def _document(data, limit):
    try:
        if type(data) is not bytes or not 1 <= len(data) <= limit:
            raise ProxyError('CHANNEL_DENIED')
        text = data.decode('ascii')
        _PROTOCOL._depth(text)
        value = json.loads(text, object_pairs_hook=_PROTOCOL._pairs,
                           parse_int=_PROTOCOL._integer,
                           parse_float=lambda _: _PROTOCOL._invalid(),
                           parse_constant=lambda _: _PROTOCOL._invalid())
        # All finite v2 strings are ASCII even when JSON escape sequences were used.
        if not json.dumps(value, ensure_ascii=False).isascii():
            raise ProxyError('CHANNEL_DENIED')
        return value
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise ProxyError('CHANNEL_DENIED') from None


@dataclass(frozen=True, eq=False)
class CompositionProxyPolicy:
    binding: CompositionBinding
    child: object = field(repr=False)
    pipe: object = field(repr=False)
    child_id: str
    pipe_id: str
    channel_key: bytes = field(repr=False)
    admission_policy: object = field(repr=False)
    cleanup_budget: object = field(repr=False)
    provenance_validator: object = field(repr=False)
    runtime_sink: object = field(repr=False)


def qualify_composition_proxy(binding, *, child, pipe, child_id, pipe_id,
                              channel_key, admission_policy, cleanup_budget,
                              provenance_validator, runtime_sink=None):
    """Trusted embedding only; no expected value is taken from incoming bytes.

    The validator audits these exact original child and physical pipe owners.
    An embedding without that provenance cannot select the composition path.
    """
    if (type(binding) is not CompositionBinding or child is None or pipe is None
            or type(child_id) is not str or _HEX32_RE.fullmatch(child_id) is None
            or type(pipe_id) is not str or _HEX32_RE.fullmatch(pipe_id) is None
            or type(channel_key) is not bytes or len(channel_key) != 32
            or type(admission_policy) is not NativeAdmissionPolicy
            or admission_policy._seal is not _NATIVE_ADMISSION_SEAL
            or not callable(provenance_validator)
            or not callable(getattr(cleanup_budget, 'remaining', None))
            or not callable(getattr(cleanup_budget, 'call', None))
            or not callable(getattr(cleanup_budget, 'start_terminal', None))
            or not callable(getattr(cleanup_budget, 'clamp_end', None))
            or (runtime_sink is not None and not callable(runtime_sink))):
        raise ProxyError('ADMISSION_DENIED')
    run = admission_policy.binding
    if (binding.runId, binding.manifestDigest, binding.configIdentity,
            binding.rolePolicyDigest, binding.expiresAtMs) != (
            run.run_id, run.manifest_identity, run.config_identity,
            admission_policy.role_policy_identity, run.expires_at):
        raise ProxyError('ADMISSION_DENIED')
    if provenance_validator(child, pipe) is not True:
        raise ProxyError('ADMISSION_DENIED')
    policy = CompositionProxyPolicy(binding, child, pipe, child_id, pipe_id,
        channel_key, admission_policy, cleanup_budget, provenance_validator, runtime_sink)
    _COMPOSITION_POLICIES.add(policy)
    return policy


_NATIVE_INVENTORIES = weakref.WeakKeyDictionary()


class _RuntimeDescriptors:
    """Finite original acquisition ledger; never accepts caller-supplied FD rows."""
    def __init__(self, os_module):
        self.os, self.rows, self.endpoints = os_module, {}, {}
        self.unresolved_reads = []
        self.pending_nonblocking = set()

    def capture_inherited(self):
        for fd in range(5):
            self._add(fd, 'NULL' if fd < 3 else 'COMMAND' if fd == 3 else 'RESULT')

    def _facts(self, fd):
        stat = self.os.fstat(fd)
        handle = self.os.open('/proc/self/fdinfo/' + str(fd), self.os.O_RDONLY | self.os.O_CLOEXEC)
        self.unresolved_reads.append(handle)
        try:
            data = bytearray()
            while len(data) <= 4096:
                part = self.os.read(handle, 4097-len(data))
                if type(part) is not bytes: raise ProxyError('CHANNEL_DENIED')
                if not part: break
                data.extend(part)
            if len(data) > 4096: raise ProxyError('CHANNEL_DENIED')
            flags = [line.split()[1] for line in data.decode('ascii').splitlines()
                     if line.startswith('flags:')]
            if len(flags) != 1: raise ProxyError('CHANNEL_DENIED')
            flags = int(flags[0], 8)
        finally:
            self.os.close(handle)
            self.unresolved_reads.remove(handle)
        if (not _plain_integer(flags, 0, _MAX_SAFE_INTEGER)
                or any(type(v) is not int or not 0 <= v <= 99999999999999999999
                       for v in (stat.st_dev, stat.st_ino))):
            raise ProxyError('CHANNEL_DENIED')
        return str(stat.st_dev), str(stat.st_ino), flags

    def _add(self, fd, kind):
        if not _plain_integer(fd, 0, 4095) or fd in self.rows:
            raise ProxyError('CHANNEL_DENIED')
        if kind in _FD_LIMITS and sum(row['kind'] == kind for row in self.rows.values()) >= _FD_LIMITS[kind]:
            raise ProxyError('CHANNEL_DENIED')
        dev, inode, flags = self._facts(fd)
        self.rows[fd] = dict(fd=fd, kind=kind, device=dev, inode=inode, flags=flags,
                            ownerId=secrets.token_hex(16), acquiredGeneration=1)

    def acquire(self, endpoint, kind, owner, attribute):
        fd = endpoint.fileno()
        # Retain the original before reading any fallible descriptor facts.
        self.endpoints[ id(endpoint) ] = (endpoint, owner, attribute, fd)
        self._add(fd, kind)
        if kind == 'PROXY_ACCEPTED_STREAM':
            self.pending_nonblocking.add(id(endpoint))

    def finalize_nonblocking(self, endpoint):
        original = self.endpoints.get(id(endpoint))
        if (id(endpoint) not in self.pending_nonblocking or original is None
                or original[0] is not endpoint):
            raise ProxyError('CHANNEL_DENIED')
        _, owner, attribute, fd = original
        row = self.rows[fd]
        # Only this initial Linux O_NONBLOCK transition may change captured
        # facts. Keep the original acquisition identity, never relearn drift.
        if (getattr(owner, attribute) is not endpoint or endpoint.fileno() != fd
                or self._facts(fd) != (row['device'], row['inode'], row['flags'] | 2048)):
            raise ProxyError('CHANNEL_DENIED')
        row['flags'] |= 2048
        self.pending_nonblocking.remove(id(endpoint))

    def retire(self, endpoint):
        original = self.endpoints.get(id(endpoint))
        if original is None or original[0] is not endpoint:
            raise ProxyError('CLEANUP_UNCERTAIN')
        fd = original[3]
        if endpoint.fileno() != -1 or str(fd) in self.os.listdir('/proc/self/fd'):
            raise ProxyError('CLEANUP_UNCERTAIN')
        self.endpoints.pop(id(endpoint)); self.rows.pop(fd, None)
        self.pending_nonblocking.discard(id(endpoint))

    def current(self):
        if self.unresolved_reads or self.pending_nonblocking: raise ProxyError('CLEANUP_UNCERTAIN')
        for endpoint, owner, attribute, fd in self.endpoints.values():
            if (getattr(owner, attribute) is not endpoint or endpoint.fileno() != fd
                    or owner.inventory is not self or _NATIVE_INVENTORIES.get(owner) is not self
                    or getattr(owner, 'closing', False) or getattr(owner, 'cleanup_uncertain', False)):
                raise ProxyError('CLEANUP_UNCERTAIN')
        listed = self.os.listdir('/proc/self/fd')
        if set(listed) != {str(fd) for fd in self.rows} or len(listed) != len(self.rows):
            raise ProxyError('NATIVE_CURRENT_INVENTORY_UNAVAILABLE')
        for fd, row in self.rows.items():
            if self._facts(fd) != (row['device'], row['inode'], row['flags']):
                raise ProxyError('CHANNEL_DENIED')
        return tuple(tuple(row.items()) for _, row in sorted(self.rows.items()))


@dataclass(frozen=True, eq=False)
class ProxyRuntimeObservation:
    _binding: CompositionBinding = field(repr=False)
    _runtime_id: str
    _sequence: int
    _status: str
    _observed: int
    _rows: tuple = field(repr=False)

    def to_record(self):
        if self not in _OBSERVATIONS: raise ProxyError('CHANNEL_DENIED')
        return dict(binding=self._binding.to_record(), runtimeId=self._runtime_id,
                    sequence=self._sequence, status=self._status,
                    listenAddress=_LISTEN_ADDRESS, listenPort=_LISTEN_PORT,
                    hostCID=_HOST_CID, servicePort=_VSOCK_SERVICE, uid=10004,
                    observedAtMonotonicMs=self._observed,
                    currentFDs=[dict(row) for row in self._rows])


def _config_facts(config):
    return (config.binding, tuple(sorted(config.destinations.items())),
            config.aggregate_bytes, config.idle_timeout_ms, config.run_timeout_ms,
            config.phase, config.event, config.clock, config.sockets, config.native_admission)


class ProxyRuntimeOwner:
    def __init__(self, context, config, transport, listener, timeline, seal=None):
        if seal is not _COMPOSITION_SEAL or context not in _COMPOSITION_CONTEXTS:
            raise ProxyError('ADMISSION_DENIED')
        self._context, self._config, self._transport = context, config, transport
        self._sockets, self._listener, self._timeline = config.sockets, listener, timeline
        self._budget = context._policy.cleanup_budget
        self._runtime_id, self._sequence = secrets.token_hex(16), 0
        _RUNTIME_OWNERS[self] = (context, config, transport, config.sockets, listener,
                               timeline, self._budget, _config_facts(config),
                               transport.binding, transport.module, transport.selectors,
                               config.sockets.module, config.sockets.selectors)

    def _check(self):
        originals = _RUNTIME_OWNERS.get(self)
        if originals is None: raise ProxyError('TERMINAL')
        context, config, transport, sockets, listener, timeline, budget, facts, binding, module, selectors, smodule, sselectors = originals
        try:
            if (any(a is not b for a, b in zip(
                    (self._context,self._config,self._transport,self._sockets,self._listener,self._timeline,self._budget), originals[:7]))
                    or _config_facts(config) != facts or config.binding is not facts[0]
                    or config._terminal or sockets.listener is not listener
                    or transport.binding is not binding or transport.module is not module
                    or transport.selectors is not selectors or sockets.module is not smodule
                    or sockets.selectors is not sselectors or not transport.claimed
                    or config.clock is not facts[7] or config.sockets is not sockets
                    or config.native_admission is not facts[9]
                    or (transport.host_cid,transport.service,transport.connect_timeout_ms) != (2,4050,config.idle_timeout_ms)
                    or transport.clock is not config.clock
                    or listener.module is not smodule
                    or listener.endpoint != (_LISTEN_ADDRESS, _LISTEN_PORT)
                    or any(owner.inventory is not context._inventory
                           or _NATIVE_INVENTORIES.get(owner) is not context._inventory
                           for owner in (sockets, transport, listener))
                    or tuple(map(id, transport.streams)) != tuple(map(id, transport._owned_streams))
                    or tuple(map(id, listener.streams)) != tuple(map(id, listener._owned_streams))
                    or transport.closed or transport.closing or listener.closed or listener.closing):
                raise ProxyError('TERMINAL')
            context._check(); timeline.observe()
        except Exception:
            context._invalidate(); raise ProxyError('TERMINAL') from None

    def _observe(self, status):
        original = _RUNTIME_OWNERS.get(self)
        if original is None: raise ProxyError('TERMINAL')
        context = original[0]
        try:
            self._check()
            rows = context._inventory.current()
            self._check()
            self._sequence += 1
            if self._sequence > _MAX_SAFE_INTEGER: raise ProxyError('TERMINAL')
            observation = ProxyRuntimeObservation(context._policy.binding,
                self._runtime_id, self._sequence, status, self._timeline.mono, rows)
            _OBSERVATIONS.add(observation)
            return observation
        except Exception:
            context._invalidate(); raise ProxyError('TERMINAL') from None

    def observe_current(self, binding):
        original = _RUNTIME_OWNERS.get(self)
        if original is None: raise ProxyError('TERMINAL')
        if type(binding) is not CompositionBinding or binding != original[0]._policy.binding:
            original[0]._invalidate(); raise ProxyError('TERMINAL')
        return self._observe('CURRENT')

    def stop_owned(self, remaining_ms):
        original = _RUNTIME_OWNERS.get(self)
        if original is None: raise ProxyError('TERMINAL')
        context, _, transport, sockets = original[:4]
        context._invalidate()
        if not _plain_integer(remaining_ms, 0, 60000): raise ProxyError('CLEANUP_UNCERTAIN')
        context._clamp(context._last_mono + remaining_ms)
        cleaned = context._cleanup()
        return {'status': 'STOPPED' if cleaned else 'TIMEOUT', 'runId': context._policy.binding.runId}


class ProxyCompositionContext:
    def __init__(self, policy, config, sockets, seal=None):
        if seal is not _COMPOSITION_SEAL or policy not in _COMPOSITION_POLICIES:
            raise ProxyError('ADMISSION_DENIED')
        self._policy, self._config, self._sockets = policy, config, sockets
        self._inventory = _RuntimeDescriptors(sockets.os)
        self._runtime, self._transport = None, None
        self._terminal, self._terminal_sent, self._claimed = False, False, False
        self._output_failed = False
        self._receive, self._send_sequence = 0, 0
        self._requests, self._stop_request = set(), ('', 0)
        self._last_mono, self._last_wall = _sample(config.clock)[1], None
        self._failed_at, self._real_end = None, None
        self._cleanup_lock = threading.Lock()
        _COMPOSITION_CONTEXTS.add(self)
        _CONTEXT_ORIGINALS[self] = (policy, config, sockets, self._inventory,
                                    sockets.os, sockets.selectors, None)

    def _check(self):
        if self not in _COMPOSITION_CONTEXTS or self._terminal:
            raise ProxyError('TERMINAL')
        original = _CONTEXT_ORIGINALS[self]
        if any(a is not b for a,b in zip((self._policy,self._config,self._sockets,
                self._inventory,self._sockets.os,self._sockets.selectors,self._transport),original)):
            raise ProxyError('TERMINAL')
        wall, mono = _sample(self._config.clock)
        if mono < self._last_mono or (self._last_wall is not None and wall < self._last_wall):
            self._clamp(0); raise ProxyError('CLOCK')
        self._last_wall, self._last_mono = wall, mono
        if wall >= self._policy.binding.expiresAtMs:
            raise ProxyError('EXPIRED')
        if self._policy.provenance_validator(self._policy.child, self._policy.pipe) is not True:
            raise ProxyError('CHANNEL_DENIED')
        return mono

    def _claim(self, config, transport):
        self._check()
        if self._claimed or config is not self._config or config.sockets is not self._sockets or type(transport) is not NativeVsockTransport:
            raise ProxyError('ADMISSION_DENIED')
        self._claimed = True; self._transport = transport
        _CONTEXT_ORIGINALS[self] = (*_CONTEXT_ORIGINALS[self][:-1], transport)
        transport.inventory = self._inventory
        _NATIVE_INVENTORIES[transport] = self._inventory

    def _clamp(self, end):
        # Terminal only: clamp_end starts the one shared end first, then
        # shortens it. The proxy never writes the budget deadline (C1).
        _CONTEXT_ORIGINALS[self][0].cleanup_budget.clamp_end(end)

    def _invalidate(self, immediate=False):
        if immediate: self._clamp(0)
        if not self._terminal:
            self._terminal = True
            policy, config = _CONTEXT_ORIGINALS[self][:2]
            try:
                _, mono = _sample(config.clock)
                if mono < self._last_mono: raise ProxyError('CLOCK')
                self._last_mono = mono
            except Exception:
                self._clamp(0)
            self._failed_at = self._last_mono
            self._real_end = time.monotonic_ns()//1000000 + 60000
            try:
                policy.cleanup_budget.start_terminal()
                real = getattr(policy.cleanup_budget, 'real_deadline', None)
                if real is not None: self._real_end = min(self._real_end, real)
                end = self._failed_at + 60000
                self._clamp(end if end <= _MAX_SAFE_INTEGER else 0)
            except Exception:
                self._clamp(0)

    def _cleanup(self, passes=2):
        self._invalidate()
        if not self._cleanup_lock.acquire(blocking=False): return False
        try:
            policy, _, sockets, inventory, _, _, transport = _CONTEXT_ORIGINALS[self]
            # Every native close below is nonblocking. Zero/expired budgets
            # permit only these finite attempts, never a wait or fresh window.
            try:
                if time.monotonic_ns()//1000000 >= self._real_end:
                    self._clamp(0)
                policy.cleanup_budget.remaining()
            except Exception:
                self._clamp(0)
            cleaned = _cleanup_resources((sockets, transport), passes=passes)
            # A failed close of a proc reader is retained uncertainty. Never
            # retry an integer descriptor that the kernel may already recycle.
            return (cleaned and not inventory.unresolved_reads and not inventory.endpoints
                    and not any(fd >= 5 for fd in inventory.rows))
        finally:
            self._cleanup_lock.release()

    def _send(self, kind, payload, *, started=None):
        if self._output_failed: raise ProxyError('RESULT_DENIED')
        if self._send_sequence >= _MAX_SAFE_INTEGER: raise ProxyError('CHANNEL_DENIED')
        if kind != 'PROXY_TERMINAL': self._check()
        self._send_sequence += 1
        p, _, sockets, _, os_module, selectors, _ = _CONTEXT_ORIGINALS[self]
        value = dict(version=2, kind=kind, binding=p.binding.to_record(), childId=p.child_id,
                     pipeId=p.pipe_id, sequence=self._send_sequence, payload=payload)
        value['mac'] = hmac.new(p.channel_key, _COMPOSITION_DOMAIN+b'TO_BOOTSTRAP\0'+_canonical(value), hashlib.sha256).hexdigest()
        body = _canonical(value)
        if len(body) > 16384: raise ProxyError('RESULT_DENIED')
        data = memoryview(len(body).to_bytes(2, 'big')+body)
        selector = None
        terminal = kind == 'PROXY_TERMINAL'
        try:
            if terminal:
                # SelectSelector owns no kernel descriptor on pinned Linux.
                # Terminal delivery cannot reacquire a runtime selector FD.
                selector = selectors.SelectSelector()
                selector.register(4, selectors.EVENT_WRITE)
            else:
                selector = sockets._owned_stop_selector
            if selector is None: raise ProxyError('RESULT_DENIED')
            while data:
                if not terminal:
                    mono = self._check()
                    if started is not None and mono-started > 100: raise ProxyError('CHANNEL_DENIED')
                # Original sole-writer Linux pipe: one writable event permits
                # an atomic <=4096-byte write. Never wait or retry on full.
                if not any(getattr(key, 'fd', None) == 4 and events & selectors.EVENT_WRITE
                           for key, events in selector.select(0)):
                    raise ProxyError('RESULT_DENIED')
                chunk = data[:4096]
                count = os_module.write(4, chunk)
                if not _plain_integer(count, 1, len(chunk)): raise ProxyError('RESULT_DENIED')
                data = data[count:]
        except Exception:
            self._output_failed = True
            self._invalidate()
            raise
        finally:
            if terminal and selector is not None: selector.close()
        if kind != 'PROXY_TERMINAL':
            mono = self._check()
            if started is not None and mono-started > 100: raise ProxyError('CHANNEL_DENIED')

    def _command(self, data, started):
        try:
            mono = self._check()
            if mono-started > 100: raise ProxyError('CHANNEL_DENIED')
            value = _document(data, 4096)
            _exact(value, ('version','kind','binding','childId','pipeId','sequence','payload','mac'))
            p = self._policy
            if (type(value['version']) is not int or value['version'] != 2
                    or CompositionBinding.from_record(value['binding']) != p.binding
                    or value['childId'] != p.child_id or value['pipeId'] != p.pipe_id
                    or not _plain_integer(value['sequence'], 1, _MAX_SAFE_INTEGER)
                    or value['sequence'] != self._receive+1
                    or type(value['mac']) is not str or _HEX64_RE.fullmatch(value['mac']) is None):
                raise ProxyError('CHANNEL_DENIED')
            mac = value.pop('mac')
            expected = hmac.new(p.channel_key, _COMPOSITION_DOMAIN+b'FROM_BOOTSTRAP\0'+_canonical(value), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(mac, expected): raise ProxyError('CHANNEL_DENIED')
            payload, kind = value['payload'], value['kind']
            if kind == 'PROXY_CURRENT':
                _exact(payload, ('requestId','generation'))
                if type(payload['generation']) is not int or payload['generation'] != 1:
                    raise ProxyError('CHANNEL_DENIED')
            elif kind == 'PROXY_STOP':
                _exact(payload, ('requestId','cleanupEndsAtMonotonicMs'))
                if not _plain_integer(payload['cleanupEndsAtMonotonicMs'], 0, _MAX_SAFE_INTEGER):
                    raise ProxyError('CHANNEL_DENIED')
            else: raise ProxyError('CHANNEL_DENIED')
            request_id = payload['requestId']
            if type(request_id) is not str or _HEX32_RE.fullmatch(request_id) is None or request_id in self._requests:
                raise ProxyError('CHANNEL_DENIED')
            # Bound memory independently of attacker-selected request IDs.
            if len(self._requests) >= 4096: raise ProxyError('CHANNEL_DENIED')
            self._requests.add(request_id); self._receive = value['sequence']
            if kind == 'PROXY_STOP':
                self._stop_request = (request_id, self._receive)
                self._clamp(payload['cleanupEndsAtMonotonicMs']); self._invalidate()
                return True
            observation = self._runtime.observe_current(p.binding)
            self._send('PROXY_CURRENT', dict(requestId=request_id, requestSequence=self._receive,
                observation=observation.to_record()), started=started)
            return False
        except Exception:
            self._invalidate(); raise _ChannelDenied() from None

    def _finish(self, outcome, cleaned):
        self._invalidate()
        if self._terminal_sent: raise ProxyError('TERMINAL')
        self._terminal_sent = True
        request_id, request_sequence = self._stop_request
        self._send('PROXY_TERMINAL', dict(requestId=request_id, requestSequence=request_sequence,
            runtimeId=self._runtime._runtime_id if self._runtime is not None else '',
            code=outcome.code, usedBytes=outcome.used_bytes,
            cleanupStatus='PROVEN' if cleaned else 'UNCERTAIN', failedAtMonotonicMs=self._failed_at))


def _observation_record(value, binding, status):
    _exact(value, ('binding','runtimeId','sequence','status','listenAddress','listenPort',
                   'hostCID','servicePort','uid','observedAtMonotonicMs','currentFDs'))
    if (CompositionBinding.from_record(value['binding']) != binding
            or type(value['runtimeId']) is not str or _HEX32_RE.fullmatch(value['runtimeId']) is None
            or not _plain_integer(value['sequence'], 1, _MAX_SAFE_INTEGER)
            or value['status'] != status or value['listenAddress'] != _LISTEN_ADDRESS
            or any(type(value[k]) is not int or value[k] != v for k,v in
                   (('listenPort',3128),('hostCID',2),('servicePort',4050),('uid',10004)))
            or not _plain_integer(value['observedAtMonotonicMs'], 0, _MAX_SAFE_INTEGER)
            or type(value['currentFDs']) is not list or not 6 <= len(value['currentFDs']) <= 55):
        raise ProxyError('CHANNEL_DENIED')
    last, counts, owners = -1, {}, set()
    for row in value['currentFDs']:
        _exact(row, ('fd','kind','device','inode','flags','ownerId','acquiredGeneration'))
        fd = row['fd']
        if (not _plain_integer(fd, last+1, 4095)
                or not _plain_integer(row['flags'], 0, _MAX_SAFE_INTEGER)
                or type(row['acquiredGeneration']) is not int or row['acquiredGeneration'] != 1
                or type(row['ownerId']) is not str or _HEX32_RE.fullmatch(row['ownerId']) is None
                or row['ownerId'] in owners
                or any(type(row[k]) is not str or re.fullmatch(r'0|[1-9][0-9]{0,19}', row[k]) is None
                       for k in ('device','inode'))):
            raise ProxyError('CHANNEL_DENIED')
        kind = row['kind']
        if fd < 5:
            if fd != last+1 or kind != ('NULL' if fd<3 else 'COMMAND' if fd==3 else 'RESULT'):
                raise ProxyError('CHANNEL_DENIED')
        elif kind not in _FD_LIMITS: raise ProxyError('CHANNEL_DENIED')
        counts[kind] = counts.get(kind, 0)+1; owners.add(row['ownerId']); last = fd
    if [r['fd'] for r in value['currentFDs'][:5]] != [0,1,2,3,4] or counts.get('PROXY_LISTENER') != 1:
        raise ProxyError('CHANNEL_DENIED')
    if any(counts.get(kind,0)>limit for kind,limit in _FD_LIMITS.items()):
        raise ProxyError('CHANNEL_DENIED')
    return value


_CLIENT_ORIGINALS = weakref.WeakKeyDictionary()


class ProxyCompositionClient:
    """Bootstrap-side finite correlation. Returned records are data, not owners.

    The embedding sends/receives these two-byte frames on the policy's original
    physical pipe. This class cannot adopt a new pipe or mint serving authority.
    """
    def __init__(self, policy, clock):
        if type(policy) is not CompositionProxyPolicy or policy not in _COMPOSITION_POLICIES:
            raise ProxyError('ADMISSION_DENIED')
        self._policy, self._clock = policy, clock
        self._sent = self._received = self._observation = 0
        self._pending = self._runtime = None
        self._requests, self._terminal, self._last = set(), False, None
        _CLIENT_ORIGINALS[self] = (policy, clock)

    def _state(self):
        return (self._sent, self._received, self._observation, self._pending,
                self._runtime, frozenset(self._requests))

    def _guard(self, expected):
        """Final clock/state check; never invokes the provenance callback."""
        if self._terminal: raise ProxyError('TERMINAL')
        policy, clock = _CLIENT_ORIGINALS[self]
        if self._policy is not policy or self._clock is not clock:
            raise ProxyError('TERMINAL')
        now = _sample(clock)
        if (self._terminal or self._policy is not policy or self._clock is not clock
                or self._state() != expected):
            raise ProxyError('TERMINAL')
        if (self._last is not None and any(a<b for a,b in zip(now,self._last))) or now[0] >= policy.binding.expiresAtMs:
            raise ProxyError('EXPIRED')
        self._last = now
        return now[1]

    def _check(self, expected):
        self._guard(expected)
        policy = _CLIENT_ORIGINALS[self][0]
        if policy.provenance_validator(policy.child, policy.pipe) is not True:
            raise ProxyError('CHANNEL_DENIED')
        return self._guard(expected)

    def _fail(self, immediate=False, end=None):
        policy, clock = _CLIENT_ORIGINALS[self]
        budget = policy.cleanup_budget
        # Every client failure is terminal: start the one shared end, then
        # clamp it. No direct deadline write (C1).
        if immediate:
            self._terminal = True
            budget.clamp_end(0)
            return
        if not self._terminal:
            self._terminal = True
            try:
                mono = _sample(clock)[1]
                first_end = mono+60000
                if first_end > _MAX_SAFE_INTEGER: first_end = 0
                end = first_end if end is None else min(end, first_end)
                budget.start_terminal()
            except Exception: end = 0
        if end is not None:
            budget.clamp_end(end)

    def _request(self, kind, request_id, value):
        try:
            expected = self._state()
            self._check(expected)
            if (self._runtime is None or self._pending is not None
                    or type(request_id) is not str or _HEX32_RE.fullmatch(request_id) is None
                    or request_id in self._requests or len(self._requests) >= 4096
                    or self._sent >= _MAX_SAFE_INTEGER): raise ProxyError('CHANNEL_DENIED')
            if kind == 'PROXY_CURRENT':
                if type(value) is not int or value != 1: raise ProxyError('CHANNEL_DENIED')
                payload = dict(requestId=request_id, generation=value)
            else:
                if not _plain_integer(value, 0, _MAX_SAFE_INTEGER): raise ProxyError('CHANNEL_DENIED')
                payload = dict(requestId=request_id, cleanupEndsAtMonotonicMs=value)
            p = self._policy
            frame = dict(version=2, kind=kind, binding=p.binding.to_record(), childId=p.child_id,
                         pipeId=p.pipe_id, sequence=self._sent+1, payload=payload)
            frame['mac'] = hmac.new(p.channel_key, _COMPOSITION_DOMAIN+b'FROM_BOOTSTRAP\0'+_canonical(frame), hashlib.sha256).hexdigest()
            body = _canonical(frame)
            mono = self._guard(expected)
            self._sent += 1; self._requests.add(request_id)
            self._pending = (kind, request_id, self._sent, mono)
            return len(body).to_bytes(2,'big')+body
        except Exception:
            self._fail(); raise ProxyError('CHANNEL_DENIED') from None

    def current(self, request_id, generation):
        return self._request('PROXY_CURRENT', request_id, generation)

    def stop(self, request_id, cleanup_ends_at_monotonic_ms):
        return self._request('PROXY_STOP', request_id, cleanup_ends_at_monotonic_ms)

    def accept_frame(self, wire):
        # Physical EOF revokes authority even if expiry/clock/terminal checks
        # would fail first. It requires neither a clock nor provenance callback.
        if type(wire) is bytes and wire == b'':
            self._fail(immediate=True)
            raise ProxyError('CHANNEL_DENIED')
        try:
            state = self._state()
            mono = self._check(state)
            if type(wire) is not bytes or len(wire)<3 or not 1<=int.from_bytes(wire[:2],'big')<=16384 or len(wire)!=2+int.from_bytes(wire[:2],'big'):
                raise ProxyError('CHANNEL_DENIED')
            f = _document(wire[2:], 16384)
            _exact(f, ('version','kind','binding','childId','pipeId','sequence','payload','mac'))
            p = self._policy
            if (type(f['version']) is not int or f['version'] != 2
                    or CompositionBinding.from_record(f['binding']) != p.binding
                    or f['childId'] != p.child_id or f['pipeId'] != p.pipe_id
                    or not _plain_integer(f['sequence'], 1, _MAX_SAFE_INTEGER) or f['sequence'] != self._received+1
                    or type(f['mac']) is not str or _HEX64_RE.fullmatch(f['mac']) is None):
                raise ProxyError('CHANNEL_DENIED')
            mac = f.pop('mac')
            if not hmac.compare_digest(mac, hmac.new(p.channel_key, _COMPOSITION_DOMAIN+b'TO_BOOTSTRAP\0'+_canonical(f), hashlib.sha256).hexdigest()):
                raise ProxyError('CHANNEL_DENIED')
            payload, kind = f['payload'], f['kind']
            if kind == 'PROXY_TERMINAL':
                _exact(payload, ('requestId','requestSequence','runtimeId','code','usedBytes','cleanupStatus','failedAtMonotonicMs'))
                expected = self._pending[1:3] if self._pending and self._pending[0]=='PROXY_STOP' else ('',0)
                if ((payload['requestId'],payload['requestSequence']) != expected
                        or type(payload['requestSequence']) is not int
                        or payload['runtimeId'] != (self._runtime or '')
                        or payload['code'] not in _OUTCOME_CODES
                        or not _plain_integer(payload['usedBytes'],0,_AGGREGATE_LIMIT)
                        or payload['cleanupStatus'] not in ('PROVEN','UNCERTAIN')
                        or not _plain_integer(payload['failedAtMonotonicMs'],0,mono)):
                    raise ProxyError('CHANNEL_DENIED')
                self._guard(state)
                self._fail(end=min(_MAX_SAFE_INTEGER, payload['failedAtMonotonicMs']+60000))
                return dict(payload)
            if kind == 'PROXY_READY':
                _exact(payload, ('observation',))
                if self._runtime is not None or self._pending is not None: raise ProxyError('CHANNEL_DENIED')
                observed = _observation_record(payload['observation'], p.binding, 'READY')
                start = max(0, mono-100)
            elif kind == 'PROXY_CURRENT':
                _exact(payload, ('requestId','requestSequence','observation'))
                if (self._pending is None or self._pending[0] != 'PROXY_CURRENT'
                        or type(payload['requestSequence']) is not int
                        or (payload['requestId'],payload['requestSequence']) != self._pending[1:3]):
                    raise ProxyError('CHANNEL_DENIED')
                observed = _observation_record(payload['observation'], p.binding, 'CURRENT')
                start = self._pending[3]
                if observed['runtimeId'] != self._runtime or mono-start>100: raise ProxyError('CHANNEL_DENIED')
            else: raise ProxyError('CHANNEL_DENIED')
            mono = self._guard(state)
            if kind == 'PROXY_READY': start = max(0, mono-100)
            elif mono-start > 100: raise ProxyError('CHANNEL_DENIED')
            if not start <= observed['observedAtMonotonicMs'] <= mono or observed['sequence'] <= self._observation:
                raise ProxyError('CHANNEL_DENIED')
            self._received = f['sequence']; self._runtime = observed['runtimeId']
            self._observation = observed['sequence']; self._pending = None
            return observed
        except Exception:
            self._fail(); raise ProxyError('CHANNEL_DENIED') from None


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
        'configIdentity': {'ref': 'Digest'},
        'expiresAt': {'type': 'integer', 'min': 1, 'max': _MAX_SAFE_INTEGER},
        'firstSequence': {'type': 'integer', 'min': 1, 'max': _MAX_FIRST_SEQUENCE},
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
        # P10/R6: the derived vsock-stream key (64 lowercase hex), never the run capability.
        'vsockKey': {'ref': 'Digest'},
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


_NATIVE_ADMISSION_SEAL = object()


@dataclass(frozen=True)
class NativeAdmissionPolicy:
    """Nominal authority supplied only by a separately attested composition."""
    binding: RunBinding
    destinations: tuple
    aggregate_bytes: int
    idle_timeout_ms: int
    run_timeout_ms: int
    runtime_identity: str
    role_policy_identity: str
    handoff_validator: object = field(repr=False)
    _seal: object = field(repr=False)


def qualify_native_admission(binding, destinations, aggregate_bytes,
                             idle_timeout_ms, run_timeout_ms, *,
                             runtime_identity, role_policy_identity,
                             handoff_validator):
    """Build explicit expected authority; never derives it from bootstrap data."""
    try:
        hosts = _validated_destinations(destinations)
    except ProxyError:
        raise ProxyError('ADMISSION_DENIED') from None
    expected_origins = tuple((name, 'https://' + hosts[name]) for name in _DESTINATIONS)
    if (type(binding) is not RunBinding
            or _HEX32_RE.fullmatch(getattr(binding, 'run_id', '')) is None
            or type(binding.vsock_key) is not bytes or len(binding.vsock_key) != 32
            or not _plain_integer(binding.expires_at, 1, _MAX_SAFE_INTEGER)
            or not _plain_integer(binding.first_sequence, 1, _MAX_FIRST_SEQUENCE)
            or _HEX64_RE.fullmatch(getattr(binding, 'manifest_identity', '')) is None
            or _HEX64_RE.fullmatch(getattr(binding, 'config_identity', '')) is None
            or binding.origins != expected_origins
            or not _plain_integer(aggregate_bytes, 1, _AGGREGATE_LIMIT)
            or not _plain_integer(idle_timeout_ms, 1, _IDLE_LIMIT_MS)
            or not _plain_integer(run_timeout_ms, 1, _RUN_LIMIT_MS)
            or type(runtime_identity) is not str
            or _HEX64_RE.fullmatch(runtime_identity) is None
            or type(role_policy_identity) is not str
            or _HEX64_RE.fullmatch(role_policy_identity) is None
            or not callable(handoff_validator)):
        raise ProxyError('ADMISSION_DENIED')
    return NativeAdmissionPolicy(
        binding, tuple((name, hosts[name]) for name in _DESTINATIONS),
        aggregate_bytes, idle_timeout_ms, run_timeout_ms,
        runtime_identity, role_policy_identity, handoff_validator,
        _NATIVE_ADMISSION_SEAL)


def _admit_native_config(config, policy):
    if (type(policy) is not NativeAdmissionPolicy
            or policy._seal is not _NATIVE_ADMISSION_SEAL
            or type(config.native_admission) is not NativeAdmission
            or not _same_binding(policy.binding, config.binding)
            or tuple((name, config.destinations.get(name))
                     for name in _DESTINATIONS) != policy.destinations
            or config.aggregate_bytes != policy.aggregate_bytes
            or config.idle_timeout_ms != policy.idle_timeout_ms
            or config.run_timeout_ms != policy.run_timeout_ms
            or config.native_admission.runtime_identity != policy.runtime_identity
            or config.native_admission.role_policy_identity != policy.role_policy_identity):
        raise ProxyError('ADMISSION_DENIED')


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


def _decode_bootstrap(data, clock, sockets, composition_policy=None):
    composition = None
    value = _document(data, _HEADER_LIMIT)
    if type(value) is dict and value.get('version') == 2:
        _exact(value, ('version','kind','binding','childId','pipeId','channelKeyHex','proxyBootstrap'))
        policy = composition_policy
        if (type(policy) is not CompositionProxyPolicy or policy not in _COMPOSITION_POLICIES
                or type(value['version']) is not int or value['version'] != 2
                or value['kind'] != 'PROXY_COMPOSITION_INIT'
                or CompositionBinding.from_record(value['binding']) != policy.binding
                or value['childId'] != policy.child_id or value['pipeId'] != policy.pipe_id
                or type(value['channelKeyHex']) is not str
                or not hmac.compare_digest(value['channelKeyHex'], policy.channel_key.hex())
                or policy.provenance_validator(policy.child, policy.pipe) is not True):
            raise ProxyError('BOOTSTRAP_DENIED')
        composition = policy
        data = _canonical(value['proxyBootstrap'])
    elif composition_policy is not None:
        raise ProxyError('BOOTSTRAP_DENIED')
    try:
        value = _PROTOCOL.decode_document(
            data, rule=_BOOTSTRAP_RULE, definitions=_BOOTSTRAP_DEFINITIONS,
            max_bytes=_HEADER_LIMIT)
    except _PROTOCOL.InvalidFrame:
        # Any field outside the exact rule, such as a leftover 'capability', is an invalid config.
        raise ProxyError('INVALID_CONFIG') from None
    origins = value['origins']
    destinations = {
        'FRONTEND': origins['FRONTEND'][8:],
        'BACKEND': origins['BACKEND'][8:],
    }
    _validated_destinations(destinations)
    admission = NativeAdmission(value['runtimeIdentity'], value['rolePolicyIdentity'])
    binding = RunBinding(
        value['runId'], bytes.fromhex(value['vsockKey']), value['expiresAt'],
        value['firstSequence'], value['manifestIdentity'], value['configIdentity'],
        tuple((name, origins[name]) for name in _DESTINATIONS))
    config = ProxyConfig(
        destinations, binding, value['aggregateBytes'], value['idleTimeoutMs'],
        value['runTimeoutMs'], clock, sockets, native_admission=admission)
    if composition is not None:
        _admit_native_config(config, composition.admission_policy)
        sockets.composition = ProxyCompositionContext(composition, config, sockets, _COMPOSITION_SEAL)
        sockets.inventory = sockets.composition._inventory
        _NATIVE_INVENTORIES[sockets] = sockets.inventory
        sockets.inventory.capture_inherited()
    return config


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
    def __init__(self, endpoint, socket_module, connector=None, inventory=None):
        self.socket = endpoint
        self._owned_socket = endpoint
        self.module = socket_module
        self.connector = connector
        self._owned_connector = connector
        self.connector_closed = connector is None
        self.socket_closed = False
        self.closing = False
        self.closed = False
        self.inventory = inventory
        self.cleanup_uncertain = False
        # T9-9: a pending connect carries its deadline on the run clock.
        self.connect_clock = None
        self.connect_deadline = None
        if inventory is not None: _NATIVE_INVENTORIES[self] = inventory

    def connect_expired(self):
        """True once a still-pending connect reaches its deadline (equality expires)."""
        if self.connector_closed:
            return False
        if self.connect_deadline is None:
            raise OSError('vsock connect')
        return _sample(self.connect_clock)[1] >= self.connect_deadline

    def attach_connector(self, connector):
        if self.connector is not None or self.closing:
            raise OSError('stream')
        self.connector = connector
        self._owned_connector = connector
        self.connector_closed = False
        inventory = _NATIVE_INVENTORIES.get(self)
        if inventory is not None:
            inventory.acquire(connector, 'PROXY_CONNECT_SELECTOR', self, 'connector')

    def _connected(self):
        inventory = _NATIVE_INVENTORIES.get(self)
        if inventory is not None and (self.inventory is not inventory
                or self.socket is not self._owned_socket or self.connector is not self._owned_connector):
            raise OSError('stream ownership')
        if self.connector is None:
            return True
        if self.connect_expired():
            raise OSError(errno.ETIMEDOUT, 'vsock connect')
        if not self.connector.select(0):
            return False
        error = self.socket.getsockopt(self.module.SOL_SOCKET, self.module.SO_ERROR)
        if error != 0:
            raise OSError(error, 'vsock connect')
        try:
            self.connector.close()
            if inventory is not None:
                inventory.retire(self.connector)
        except Exception:
            self.cleanup_uncertain = True
            raise OSError('connector cleanup') from None
        self.connector_closed = True
        self.connector = None
        self._owned_connector = None
        return True

    def read(self, max_bytes):
        if self.closed or self.closing or not _plain_integer(max_bytes, 1, _CHUNK_LIMIT):
            raise OSError('stream')
        if not self._connected():
            return None
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
        if (self.closed or self.closing or type(data) is not bytes
                or not 1 <= len(data) <= _CHUNK_LIMIT):
            raise OSError('stream')
        if not self._connected():
            return None
        try:
            return self.socket.send(data)
        except BlockingIOError:
            return None

    def end_write(self):
        if self.closed or self.closing or not self._connected():
            raise OSError('stream')
        self.socket.shutdown(self.module.SHUT_WR)

    def close(self):
        if self.closed:
            return
        self.closing = True
        error = None
        inventory = _NATIVE_INVENTORIES.get(self)
        connector = self._owned_connector if inventory is not None else self.connector
        endpoint = self._owned_socket if inventory is not None else self.socket
        if not self.connector_closed and connector is not None:
            try:
                connector.close()
                if inventory is not None:
                    inventory.retire(connector)
                self.connector_closed = True
                self.connector = None
                self._owned_connector = None
            except Exception as failure:
                error = failure
        if not self.socket_closed:
            try:
                endpoint.close()
                if inventory is not None:
                    inventory.retire(endpoint)
                self.socket_closed = True
            except Exception as failure:
                if error is None:
                    error = failure
        self.closed = self.connector_closed and self.socket_closed
        if error is not None:
            raise error


class NativeListener:
    def __init__(self, endpoint, socket_module, inventory=None):
        self.socket = endpoint
        self._owned_socket = endpoint
        self.module = socket_module
        self.endpoint = ('127.0.0.1', 3128)
        self.streams = []
        self._owned_streams = []
        self.closed_streams = set()
        self.socket_closed = False
        self.closing = False
        self.closed = False
        self.inventory = inventory
        if inventory is not None: _NATIVE_INVENTORIES[self] = inventory

    def accept(self):
        if self.closed or self.closing:
            raise OSError('listener')
        inventory = _NATIVE_INVENTORIES.get(self)
        if inventory is not None and (self.inventory is not inventory or self.socket is not self._owned_socket):
            raise OSError('listener ownership')
        try:
            endpoint, _ = self.socket.accept()
        except BlockingIOError:
            return None
        stream = NativeStream(endpoint, self.module, inventory=inventory)
        self.streams.append(stream)
        self._owned_streams.append(stream)
        try:
            if inventory is not None:
                inventory.acquire(endpoint, 'PROXY_ACCEPTED_STREAM', stream, 'socket')
            endpoint.setblocking(False)
            if inventory is not None:
                inventory.finalize_nonblocking(endpoint)
            return stream
        except Exception:
            try:
                stream.close()
                self.closed_streams.add(id(stream))
            except Exception:
                pass
            raise

    def close(self):
        if self.closed:
            return
        self.closing = True
        error = None
        inventory = _NATIVE_INVENTORIES.get(self)
        streams = self._owned_streams if inventory is not None else self.streams
        for stream in streams:
            key = id(stream)
            if key in self.closed_streams:
                continue
            try:
                stream.close()
                self.closed_streams.add(key)
            except Exception as failure:
                if error is None:
                    error = failure
        if not self.socket_closed:
            try:
                endpoint = self._owned_socket if inventory is not None else self.socket
                endpoint.close()
                if inventory is not None:
                    inventory.retire(endpoint)
                self.socket_closed = True
            except Exception as failure:
                if error is None:
                    error = failure
        self.closed = self.socket_closed and len(self.closed_streams) == len(streams)
        if error is not None:
            raise error


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
        self._owned_listener = None
        self.listener_closed = True
        self.stop_selector = None
        self._owned_stop_selector = None
        self.stop_selector_closed = True
        self.stop_data = bytearray()
        self.stopped = False
        self.closing = False
        self.closed = False
        self.composition = None
        self.inventory = None
        self.command_started = None

    def listen(self, address, port, backlog):
        inventory = _NATIVE_INVENTORIES.get(self)
        if (address, port, backlog) != ('127.0.0.1', 3128, 16) or self.listener is not None or self.closing:
            raise ProxyError('LISTENER_DENIED')
        kind = self.module.SOCK_STREAM | self.module.SOCK_NONBLOCK | self.module.SOCK_CLOEXEC
        endpoint = self.module.socket(self.module.AF_INET, kind, 0)
        self.listener = NativeListener(endpoint, self.module, inventory)
        self._owned_listener = self.listener
        self.listener_closed = False
        try:
            if inventory is not None:
                inventory.acquire(endpoint, 'PROXY_LISTENER', self.listener, 'socket')
            endpoint.setblocking(False)
            endpoint.bind(('127.0.0.1', 3128))
            endpoint.listen(16)
            if endpoint.getsockname() != ('127.0.0.1', 3128):
                raise ProxyError('LISTENER_DENIED')
            return self.listener
        except Exception:
            try:
                self.listener.close()
                self.listener_closed = True
            except Exception:
                pass
            raise

    def stop_requested(self):
        if self.closed or self.closing or self.stopped:
            return True
        self._ensure_selector()
        if self.composition is not None:
            return self._composition_command()
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

    def _ensure_selector(self):
        inventory = _NATIVE_INVENTORIES.get(self)
        if self.stop_selector is None:
            selector = self.selectors.DefaultSelector()
            self.stop_selector = selector
            self._owned_stop_selector = selector
            self.stop_selector_closed = False
            try:
                if inventory is not None:
                    inventory.acquire(selector, 'PROXY_STOP_SELECTOR', self, 'stop_selector')
                selector.register(self.stop_fd, self.selectors.EVENT_READ)
                if self.composition is not None:
                    selector.register(4, self.selectors.EVENT_WRITE)
            except Exception:
                try:
                    selector.close()
                    if inventory is not None:
                        inventory.retire(selector)
                    self.stop_selector_closed = True
                    self.stop_selector = None
                    self._owned_stop_selector = None
                except Exception:
                    pass
                raise

    def _composition_command(self):
        context = self.composition
        try:
            # Read at most one finite command per loop. Partial commands retain
            # their initial deadline; no next iteration renews it.
            consumed = 0
            while consumed < 4098:
                mono = context._check()
                if self.command_started is not None and mono-self.command_started > 100:
                    raise _ChannelDenied()
                if not any(getattr(key,'fd',None)==3 and events & self.selectors.EVENT_READ
                           for key,events in self.stop_selector.select(0)): return False
                target = 2 if len(self.stop_data) < 2 else (
                    4 if self.stop_data[:2] == b'ST' else 2+int.from_bytes(self.stop_data[:2], 'big'))
                if not 2 <= target <= 4098: raise _ChannelDenied()
                data = self.os.read(3, target-len(self.stop_data))
                if type(data) is not bytes or len(data) > target-len(self.stop_data): raise _ChannelDenied()
                if not data:
                    context._invalidate(immediate=True)
                    if self.stop_data: raise _ChannelDenied()
                    self.stopped = True; return True
                if self.command_started is None: self.command_started = mono
                self.stop_data.extend(data); consumed += len(data)
                if len(self.stop_data) < target or target == 2:
                    if len(self.stop_data) == 2 and self.stop_data != b'ST':
                        size = int.from_bytes(self.stop_data, 'big')
                        if not 1 <= size <= 4096: raise _ChannelDenied()
                    continue
                if self.stop_data[:2] == b'ST':
                    if self.stop_data != b'STOP': raise _ChannelDenied()
                    context._invalidate(immediate=True); self.stopped = True; return True
                body = bytes(self.stop_data[2:]); started = self.command_started
                self.stop_data.clear(); self.command_started = None
                self.stopped = context._command(body, started)
                return self.stopped
            return False
        except Exception:
            context._invalidate(); raise _ChannelDenied() from None

    def close(self):
        if self.closed:
            return
        self.closing = True
        error = None
        inventory = _NATIVE_INVENTORIES.get(self)
        listener = self._owned_listener if inventory is not None else self.listener
        selector = self._owned_stop_selector if inventory is not None else self.stop_selector
        if listener is not None and not self.listener_closed:
            try:
                listener.close()
                self.listener_closed = True
            except Exception as failure:
                error = failure
        if not self.stop_selector_closed and selector is not None:
            try:
                selector.close()
                if inventory is not None:
                    inventory.retire(selector)
                self.stop_selector_closed = True
                self.stop_selector = None
                self._owned_stop_selector = None
            except Exception as failure:
                if error is None:
                    error = failure
        self.closed = self.listener_closed and self.stop_selector_closed
        if error is not None:
            raise error


class NativeVsockTransport:
    """One-use fixed AF_VSOCK CID2/service4050 connector for one run binding.

    It authenticates nothing itself (T9-3): the host challenges every stream and verifies the
    proof the serving loop writes (C4)."""
    def __init__(self, socket_module, selectors_module, binding, host_cid, service,
                 connect_timeout_ms=10000, *, clock=None):
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
        self.clock = clock
        self.claimed = False
        self.closing = False
        self.closed = False
        self.streams = []
        self._owned_streams = []
        self.closed_streams = set()
        self.inventory = None

    def claim(self):
        """One use per run: the serving loop claims the transport once. Not authentication."""
        if self.closed or self.closing or self.claimed:
            raise OSError('transport')
        self.claimed = True

    def check(self):
        if self.closed or self.closing or not self.claimed:
            raise OSError('transport')
        # T9-9: a vsock connect still pending at connect_timeout_ms is loss.
        for stream in tuple(self._owned_streams):
            if not stream.closed and stream.connect_expired():
                raise OSError(errno.ETIMEDOUT, 'vsock connect')

    def open(self, cid, service, binding):
        inventory = _NATIVE_INVENTORIES.get(self)
        if (cid, service) != (2, 4050) or not _same_binding(self.binding, binding):
            raise ProxyError('TRANSPORT_DENIED')
        if not callable(getattr(self.clock, 'sample', None)):
            # No unbounded connect: a transport without the run clock never opens.
            raise ProxyError('TRANSPORT_DENIED')
        if self.closed or self.closing or not self.claimed:
            raise OSError('transport')
        started = _sample(self.clock)[1]
        kind = self.module.SOCK_STREAM | self.module.SOCK_NONBLOCK | self.module.SOCK_CLOEXEC
        endpoint = self.module.socket(self.module.AF_VSOCK, kind, 0)
        stream = NativeStream(endpoint, self.module, inventory=inventory)
        self.streams.append(stream)
        self._owned_streams.append(stream)
        try:
            if inventory is not None:
                inventory.acquire(endpoint, 'PROXY_VSOCK_STREAM', stream, 'socket')
            endpoint.setblocking(False)
            result = endpoint.connect_ex((2, 4050))
            pending = {errno.EINPROGRESS, errno.EALREADY, errno.EWOULDBLOCK}
            if result != 0:
                if result not in pending:
                    raise OSError(result, 'vsock connect')
                stream.connect_clock = self.clock
                stream.connect_deadline = started + self.connect_timeout_ms
                selector = self.selectors.DefaultSelector()
                stream.attach_connector(selector)
                try:
                    selector.register(endpoint, self.selectors.EVENT_WRITE)
                except Exception:
                    stream.close()
                    raise
            return stream
        except Exception:
            try:
                stream.close()
            except Exception:
                pass
            raise

    def close(self):
        if self.closed:
            return
        self.closing = True
        error = None
        inventory = _NATIVE_INVENTORIES.get(self)
        streams = self._owned_streams if inventory is not None else self.streams
        for stream in streams:
            key = id(stream)
            if key in self.closed_streams:
                continue
            try:
                stream.close()
                self.closed_streams.add(key)
            except Exception as failure:
                if error is None:
                    error = failure
        self.closed = len(self.closed_streams) == len(streams)
        if error is not None:
            raise error


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


def _cleanup_resources(resources, passes=2):
    """Two finite passes retry only owners whose preceding close raised."""
    pending = [resource for resource in resources if resource is not None]
    for _ in range(passes):
        unresolved = []
        for resource in pending:
            try:
                resource.close()
            except Exception:
                unresolved.append(resource)
        pending = unresolved
        if not pending:
            break
    return not pending


def _inherited_entry(arguments, bindings, policy, composition_policy=None):
    if tuple(arguments) != ('--inherited',):
        return 64
    if type(bindings) is not NativeBindings or bindings._seal is not _NATIVE_BINDINGS_SEAL:
        return 1
    sockets = transport = None
    config = outcome = None
    composition = None
    result_ok = False
    try:
        # Task8 does not publish FD3 until it has consumed this exact worker
        # readiness frame from audited FD4.
        _write_all_fd(bindings.os, 4, b'WAITING\n')
        if (type(policy) is not NativeAdmissionPolicy
                or policy._seal is not _NATIVE_ADMISSION_SEAL):
            raise ProxyError('ADMISSION_DENIED')
        try:
            admitted = policy.handoff_validator('PROXY', 10004, 3, 4)
        except Exception:
            raise ProxyError('ADMISSION_DENIED') from None
        if type(admitted) is not bool or not admitted:
            raise ProxyError('ADMISSION_DENIED')
        if composition_policy is not None:
            if (type(composition_policy) is not CompositionProxyPolicy
                    or composition_policy not in _COMPOSITION_POLICIES
                    or composition_policy in _ENTERED_POLICIES
                    or composition_policy.admission_policy is not policy
                    or composition_policy.provenance_validator(composition_policy.child, composition_policy.pipe) is not True
                    or bindings.runner is not serve_proxy):
                raise ProxyError('ADMISSION_DENIED')
            _ENTERED_POLICIES.add(composition_policy)
        clock = NativeClock(bindings.time)
        sockets = NativeSockets(bindings.socket, bindings.selectors,
                                stop_fd=3, os_module=bindings.os)
        frame = _read_inherited_frame(bindings.os)
        config = _decode_bootstrap(frame, clock, sockets, composition_policy)
        composition = sockets.composition
        if (type(config.native_admission) is not NativeAdmission
                or config.native_admission.command_fd != 3
                or config.native_admission.result_fd != 4):
            raise ProxyError('BOOTSTRAP_DENIED')
        _admit_native_config(config, policy)
        transport = NativeVsockTransport(
            bindings.socket, bindings.selectors, config.binding, 2, 4050,
            config.idle_timeout_ms, clock=config.clock)
        outcome = (serve_proxy(config, transport, composition=composition) if composition is not None
                   else bindings.runner(config, transport))
    except Exception:
        # A validated initializer can fail during descriptor observation. The
        # context was registered before that acquisition and retains uncertainty.
        if sockets is not None and sockets.composition is not None:
            composition = sockets.composition
            config = _CONTEXT_ORIGINALS[composition][1]
        outcome = ProxyOutcome('CHANNEL_DENIED') if composition is not None else None

    if composition is not None:
        composition._invalidate()

    cleaned = (composition._cleanup() if composition is not None
               else _cleanup_resources((sockets, transport)))
    if not cleaned and config is not None:
        used = outcome.used_bytes if type(outcome) is ProxyOutcome else 0
        outcome = ProxyOutcome('CLEANUP_UNCERTAIN', used)
    if config is not None and outcome is not None:
        try:
            if composition is not None:
                composition._finish(outcome, cleaned)
            else:
                _write_inherited_result(bindings.os, config.binding.run_id, outcome)
            result_ok = True
        except Exception:
            result_ok = False
    exit_code = (0 if cleaned and result_ok and type(outcome) is ProxyOutcome
                 and outcome.code == 'COMPLETE' else 1)
    for fd in (3, 4):
        try:
            bindings.os.close(fd)
        except Exception:
            exit_code = 1
    return exit_code


def inherited_main(arguments, bindings):
    """Operational Task8 entry: ready handshake, then deny absent Task10 authority."""
    return _inherited_entry(arguments, bindings, None)


def admitted_inherited_main(arguments, bindings, policy, *, composition_policy=None):
    """Injected future-composition entry requiring independent nominal policy."""
    return _inherited_entry(arguments, bindings, policy, composition_policy)


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

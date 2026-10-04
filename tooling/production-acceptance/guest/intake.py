"""One-use, no-echo guest credential intake for the trusted controller role.

Importing this module performs no I/O.  The sole credential source accepted by
``consume_credential`` is the caller-owned TTY descriptor.
"""
from dataclasses import dataclass, field
import fcntl
import importlib.util
import os
import pathlib
import select
import signal
import stat
import sys
import termios
import threading
import time


_TOPOLOGY_NAME = '_acceptance_intake_topology'
if _TOPOLOGY_NAME not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        _TOPOLOGY_NAME, pathlib.Path(__file__).with_name('topology.py'))
    _module = importlib.util.module_from_spec(_spec)
    sys.modules[_TOPOLOGY_NAME] = _module
    _spec.loader.exec_module(_module)
_TOPOLOGY = sys.modules[_TOPOLOGY_NAME]
AdmissionProof = _TOPOLOGY.AdmissionProof
RunBinding = _TOPOLOGY._PROXY.RunBinding

_DESTINATIONS = ('FRONTEND', 'BACKEND')
_CONSUMER = 'BROWSER'
_MAX_CREDENTIAL_BYTES = 4096
_MAX_INTAKE_MS = 120000


class IntakeFailure(ValueError):
    """Finite failure code that never includes credential or terminal data."""


class _SignalCancellation(Exception):
    pass


@dataclass(frozen=True)
class ConsumeResult:
    run_id: str
    byte_length: int


@dataclass(frozen=True)
class IntakeGrant:
    proof: AdmissionProof = field(repr=False)
    binding: RunBinding = field(repr=False)
    consumer: str
    destinations: tuple
    issued_at_ms: int
    expires_at_ms: int
    clock: object = field(repr=False)
    child_id: str
    _consumed: bool = field(default=False, init=False, repr=False)
    _lock: object = field(default_factory=threading.Lock, init=False,
                          repr=False)

    @classmethod
    def issue(cls, *, proof, binding, consumer, destinations,
              issued_at_ms, expires_at_ms, clock, child_id):
        if (type(proof) is not AdmissionProof or type(binding) is not RunBinding
                or proof.run_id != binding.run_id
                or proof.manifest_identity != binding.manifest_identity
                or proof.config_identity != binding.config_identity):
            raise IntakeFailure('IDENTITY_MISMATCH')
        if consumer != _CONSUMER:
            raise IntakeFailure('CONSUMER_DENIED')
        if (type(child_id) is not str or len(child_id) != 32
                or any(character not in '0123456789abcdef' for character in child_id)):
            raise IntakeFailure('CONSUMER_DENIED')
        if (type(destinations) is not tuple
                or tuple(sorted(destinations)) != tuple(sorted(_DESTINATIONS))
                or tuple(sorted(key for key, _ in binding.origins))
                   != tuple(sorted(_DESTINATIONS))):
            raise IntakeFailure('DESTINATION_DENIED')
        if (type(issued_at_ms) is not int or type(expires_at_ms) is not int
                or expires_at_ms <= issued_at_ms
                or expires_at_ms - issued_at_ms > _MAX_INTAKE_MS
                or expires_at_ms > binding.expires_at
                or expires_at_ms > proof.expires_at
                or not callable(clock)):
            raise IntakeFailure('EXPIRED')
        try:
            now = clock()
        except Exception:
            raise IntakeFailure('CLOCK') from None
        if type(now) is not int or now < issued_at_ms or now >= expires_at_ms:
            raise IntakeFailure('EXPIRED')
        return cls(proof, binding, consumer, tuple(destinations),
                   issued_at_ms, expires_at_ms, clock, child_id)

    def claim(self):
        try:
            now = self.clock()
        except Exception:
            raise IntakeFailure('CLOCK') from None
        if type(now) is not int or now < self.issued_at_ms or now >= self.expires_at_ms:
            raise IntakeFailure('EXPIRED')
        with self._lock:
            if self._consumed:
                raise IntakeFailure('ALREADY_CONSUMED')
            object.__setattr__(self, '_consumed', True)
        return now


@dataclass(frozen=True)
class PrivatePipeSink:
    """Exact one-way inherited-pipe endpoint for the browser consumer."""
    binding: RunBinding = field(repr=False)
    consumer: str
    destinations: tuple
    child_id: str
    pipe_fd: int = field(repr=False)
    device: int
    inode: int

    @classmethod
    def issue(cls, *, binding, consumer, destinations, child_id, pipe_fd):
        if (type(binding) is not RunBinding or consumer != _CONSUMER
                or type(destinations) is not tuple
                or tuple(sorted(destinations)) != tuple(sorted(_DESTINATIONS))
                or type(child_id) is not str or len(child_id) != 32
                or type(pipe_fd) is not int or pipe_fd < 0):
            raise IntakeFailure('SINK_DENIED')
        try:
            facts = os.fstat(pipe_fd)
            flags = fcntl.fcntl(pipe_fd, fcntl.F_GETFL)
            fcntl.fcntl(pipe_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        except OSError:
            raise IntakeFailure('SINK_DENIED') from None
        if (not stat.S_ISFIFO(facts.st_mode) or os.isatty(pipe_fd)
                or flags & os.O_ACCMODE != os.O_WRONLY):
            raise IntakeFailure('SINK_DENIED')
        return cls(binding, consumer, tuple(destinations), child_id, pipe_fd,
                   facts.st_dev, facts.st_ino)

    def matches(self, grant):
        try:
            facts = os.fstat(self.pipe_fd)
            flags = fcntl.fcntl(self.pipe_fd, fcntl.F_GETFL)
        except OSError:
            return False
        return (self.binding == grant.binding
                and self.consumer == grant.consumer
                and self.destinations == grant.destinations
                and self.child_id == grant.child_id
                and facts.st_dev == self.device and facts.st_ino == self.inode
                and stat.S_ISFIFO(facts.st_mode) and not os.isatty(self.pipe_fd)
                and flags & os.O_ACCMODE == os.O_WRONLY
                and flags & os.O_NONBLOCK == os.O_NONBLOCK)

    def consume_private(self, run_id, value):
        if run_id != self.binding.run_id or not 0 < len(value) <= _MAX_CREDENTIAL_BYTES:
            raise IntakeFailure('SINK_DENIED')
        frame = len(value).to_bytes(4, 'big') + bytes(value)
        offset = 0
        while offset < len(frame):
            try:
                written = os.write(self.pipe_fd, frame[offset:])
            except InterruptedError:
                continue
            except BlockingIOError:
                raise IntakeFailure('SINK_FAILED') from None
            except OSError:
                raise IntakeFailure('SINK_FAILED') from None
            if written <= 0:
                raise IntakeFailure('SINK_FAILED')
            offset += written


def _read_credential(fd, grant, start_ms):
    real_end = time.monotonic() + min(
        _MAX_INTAKE_MS, grant.expires_at_ms - start_ms) / 1000
    value = bytearray()
    while True:
        try:
            now = grant.clock()
        except Exception:
            raise IntakeFailure('CLOCK') from None
        if (type(now) is not int or now < start_ms or now >= grant.expires_at_ms
                or time.monotonic() >= real_end):
            raise IntakeFailure('EXPIRED')
        ready, _, _ = select.select(
            (fd,), (), (), min(.05, max(0, real_end - time.monotonic())))
        if not ready:
            continue
        try:
            chunk = os.read(fd, 1)
        except InterruptedError:
            continue
        except OSError:
            raise IntakeFailure('TERMINAL_LOST') from None
        if not chunk:
            raise IntakeFailure('TERMINAL_LOST')
        if chunk == b'\n':
            break
        value.extend(chunk)
        if len(value) > _MAX_CREDENTIAL_BYTES:
            raise IntakeFailure('CREDENTIAL_INVALID')
    if value.endswith(b'\r'):
        del value[-1]
    try:
        decoded = value.decode('utf-8')
    except UnicodeDecodeError:
        raise IntakeFailure('CREDENTIAL_INVALID') from None
    if not decoded or '\x00' in decoded or '\n' in decoded or '\r' in decoded:
        raise IntakeFailure('CREDENTIAL_INVALID')
    return value


def consume_credential(grant, tty_fd, sink):
    """Consume one private UTF-8 credential from ``tty_fd`` into ``sink``.

    The grant is spent before any private sink effect.  Returned data contains
    only the run binding and byte count; plaintext never enters public output.
    """
    if type(grant) is not IntakeGrant:
        raise IntakeFailure('IDENTITY_MISMATCH')
    if type(tty_fd) is not int or tty_fd < 0 or not os.isatty(tty_fd):
        raise IntakeFailure('NON_TTY')
    if type(sink) is not PrivatePipeSink or not sink.matches(grant):
        raise IntakeFailure('SINK_DENIED')
    try:
        original = termios.tcgetattr(tty_fd)
    except (OSError, termios.error):
        raise IntakeFailure('NON_TTY') from None
    started = grant.claim()
    muted = list(original)
    muted[3] &= ~(termios.ECHO | getattr(termios, 'ECHONL', 0))
    previous = {}
    can_handle_signals = threading.current_thread() is threading.main_thread()

    def cancel(_number, _frame):
        raise _SignalCancellation()

    value = None
    restore_failed = False
    try:
        if can_handle_signals:
            for name in ('SIGINT', 'SIGTERM'):
                number = getattr(signal, name, None)
                if number is not None:
                    previous[number] = signal.getsignal(number)
                    signal.signal(number, cancel)
        termios.tcsetattr(tty_fd, termios.TCSANOW, muted)
        value = _read_credential(tty_fd, grant, started)
        length = len(value)
        try:
            current = grant.clock()
        except Exception:
            raise IntakeFailure('CLOCK') from None
        if type(current) is not int or current < started or current >= grant.expires_at_ms:
            raise IntakeFailure('EXPIRED')
        try:
            sink.consume_private(grant.binding.run_id, memoryview(value))
        except _SignalCancellation:
            raise
        except BaseException:
            raise IntakeFailure('SINK_FAILED') from None
        return ConsumeResult(grant.binding.run_id, length)
    except (_SignalCancellation, KeyboardInterrupt):
        raise IntakeFailure('CANCELLED') from None
    finally:
        if value is not None:
            for index in range(len(value)):
                value[index] = 0
        try:
            termios.tcsetattr(tty_fd, termios.TCSANOW, original)
        except (OSError, termios.error):
            restore_failed = True
        for number, handler in previous.items():
            try:
                signal.signal(number, handler)
            except (OSError, ValueError):
                restore_failed = True
        if restore_failed:
            raise IntakeFailure('TERMINAL_LOST')

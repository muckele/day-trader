"""One-use, no-echo guest credential intake for the trusted controller role.

Importing this module performs no I/O.  The sole credential source accepted by
``consume_credential`` is the caller-owned TTY descriptor.

Wire format (C8, decision E6): the host sends one frame, a 4-byte big-endian
length n with 1 <= n <= CREDENTIAL_LIMIT, then exactly n credential bytes.  The
intake reads it in raw mode set with TCSAFLUSH (R10), so no length or credential
byte is a line-discipline control and typeahead never becomes a length prefix.

Residuals, recorded rather than fixed:
- T11-M6: TIOCEXCL only stops new opens of the console by unprivileged
  processes.  Nothing here can tell an operator from recording or unattended
  input on the host side (for example a PTY-driven automation or ``script``).
- T11-M4: signal handlers are installed only when the intake runs on the main
  thread.  A signal handled after the restore has finished (mask and handlers
  back) reaches the caller's restored handler, as any later signal would.
- Raw mode is set with TCSAFLUSH, which first waits for pending console output
  to drain; a console whose output is never read blocks that call.
- Zeroing is best effort.  CPython, the kernel TTY layer and the host hold
  copies this module cannot erase; no erasure guarantee is made.
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

CREDENTIAL_LIMIT = 4096
_HEADER_BYTES = 4
_DESTINATIONS = ('FRONTEND', 'BACKEND')
_CONSUMER = 'BROWSER'
_MAX_INTAKE_MS = 120000
_POLL_SECONDS = .05
_HEX = '0123456789abcdef'
_INTAKE_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT, signal.SIGTSTP)
# T11-M5: one consumed grant per run.  Process memory only, like every other one-use latch here.
_CONSUMED_RUNS = set()
_CONSUMED_RUNS_LOCK = threading.Lock()
_CLOCK_FAILED = object()


class IntakeFailure(ValueError):
    """Finite failure code that never includes credential or terminal data."""


def _failure(code):
    """A fresh IntakeFailure with nothing chained (T11-I1).  Every caller raises it outside any except block, so
    the interpreter attaches no handled exception as its context either."""
    failure = IntakeFailure(code)
    failure.__context__ = None
    failure.__cause__ = None
    return failure


def _zero(buffer):
    """Best-effort erasure of a bytearray in place.  The same-length assignment neither reallocates nor leaves a
    copy behind; CPython and the kernel may still hold other copies, so no erasure guarantee is made."""
    buffer[:] = bytes(len(buffer))


def _sample(clock):
    try:
        return clock()
    except Exception:
        return _CLOCK_FAILED


@dataclass(frozen=True)
class ConsumeResult:
    """Public result: the run only.  The credential length stays in guest memory (T11-M7)."""
    run_id: str


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
    # Set by the intake's signal handlers; the read and the sink poll it.
    _cancel: object = field(default_factory=threading.Event, init=False,
                            repr=False, compare=False)

    @classmethod
    def issue(cls, *, proof, binding, consumer, destinations,
              issued_at_ms, expires_at_ms, clock, child_id):
        if (type(proof) is not AdmissionProof or type(binding) is not RunBinding
                or proof.run_id != binding.run_id
                or proof.manifest_identity != binding.manifest_identity
                or proof.config_identity != binding.config_identity):
            raise _failure('IDENTITY_MISMATCH')
        if consumer != _CONSUMER:
            raise _failure('CONSUMER_DENIED')
        if (type(child_id) is not str or len(child_id) != 32
                or any(character not in _HEX for character in child_id)):
            raise _failure('CONSUMER_DENIED')
        if (type(destinations) is not tuple
                or tuple(sorted(destinations)) != tuple(sorted(_DESTINATIONS))
                or tuple(sorted(key for key, _ in binding.origins))
                   != tuple(sorted(_DESTINATIONS))):
            raise _failure('DESTINATION_DENIED')
        if (type(issued_at_ms) is not int or type(expires_at_ms) is not int
                or expires_at_ms <= issued_at_ms
                or expires_at_ms - issued_at_ms > _MAX_INTAKE_MS
                or expires_at_ms > binding.expires_at
                or expires_at_ms > proof.expires_at
                or not callable(clock)):
            raise _failure('EXPIRED')
        now = _sample(clock)
        if now is _CLOCK_FAILED:
            raise _failure('CLOCK')
        if type(now) is not int or now < issued_at_ms or now >= expires_at_ms:
            raise _failure('EXPIRED')
        with _CONSUMED_RUNS_LOCK:
            spent = binding.run_id in _CONSUMED_RUNS
        if spent:
            raise _failure('ALREADY_CONSUMED')
        return cls(proof, binding, consumer, tuple(destinations),
                   issued_at_ms, expires_at_ms, clock, child_id)

    def claim(self):
        """Spends the grant, and with it the run (T11-M5), before any terminal or sink effect."""
        now = _sample(self.clock)
        if now is _CLOCK_FAILED:
            raise _failure('CLOCK')
        if type(now) is not int or now < self.issued_at_ms or now >= self.expires_at_ms:
            raise _failure('EXPIRED')
        with self._lock, _CONSUMED_RUNS_LOCK:
            spent = self._consumed or self.binding.run_id in _CONSUMED_RUNS
            if not spent:
                object.__setattr__(self, '_consumed', True)
                _CONSUMED_RUNS.add(self.binding.run_id)
        if spent:
            raise _failure('ALREADY_CONSUMED')
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
    _closed: bool = field(default=False, init=False, repr=False)

    @classmethod
    def issue(cls, *, binding, consumer, destinations, child_id, pipe_fd):
        if (type(binding) is not RunBinding or consumer != _CONSUMER
                or type(destinations) is not tuple
                or tuple(sorted(destinations)) != tuple(sorted(_DESTINATIONS))
                or type(child_id) is not str or len(child_id) != 32
                or any(character not in _HEX for character in child_id)
                or type(pipe_fd) is not int or pipe_fd < 0):
            raise _failure('SINK_DENIED')
        facts = flags = None
        try:
            facts = os.fstat(pipe_fd)
            flags = fcntl.fcntl(pipe_fd, fcntl.F_GETFL)
        except OSError:
            pass
        # Only a write-only, non-TTY pipe end is ever made non-blocking; a refused descriptor is left untouched.
        if (facts is None or not stat.S_ISFIFO(facts.st_mode) or os.isatty(pipe_fd)
                or flags & os.O_ACCMODE != os.O_WRONLY):
            raise _failure('SINK_DENIED')
        updated = True
        try:
            fcntl.fcntl(pipe_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        except OSError:
            updated = False
        if not updated:
            raise _failure('SINK_DENIED')
        return cls(binding, consumer, tuple(destinations), child_id, pipe_fd,
                   facts.st_dev, facts.st_ino)

    def matches(self, grant):
        if self._closed:
            return False
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

    def consume_private(self, run_id, value, deadline):
        """Writes one frame, a 4-byte big-endian length then VALUE, before DEADLINE (time.monotonic seconds).

        The frame is written from memoryviews of VALUE, never copied.  A frame not written whole by the deadline
        (T11-M8: it exceeds PIPE_BUF, so partial writes happen) is SINK_FAILED and closes the pipe, so the reader
        sees EOF after a prefix and never a usable credential."""
        length = len(value)
        if self._closed or run_id != self.binding.run_id or not 0 < length <= CREDENTIAL_LIMIT:
            raise _failure('SINK_DENIED')
        header = bytearray(length.to_bytes(_HEADER_BYTES, 'big'))
        head, body = memoryview(header), memoryview(value)
        total, offset, failure = _HEADER_BYTES + length, 0, None
        while offset < total and failure is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                failure = 'SINK_FAILED'
                continue
            try:
                _, ready, _ = select.select((), (self.pipe_fd,), (), min(_POLL_SECONDS, remaining))
            except (OSError, ValueError):
                ready = None
            if ready is None:
                failure = 'SINK_FAILED'
                continue
            if not ready:
                continue
            views = (head[offset:], body) if offset < _HEADER_BYTES else (body[offset - _HEADER_BYTES:],)
            try:
                written = os.writev(self.pipe_fd, views)
            except (BlockingIOError, InterruptedError):
                written = None
            except OSError:
                written = 0
            if written is None:
                continue
            if written <= 0:
                failure = 'SINK_FAILED'
                continue
            offset += written
        _zero(header)
        if failure is not None:
            self._close()
            raise _failure(failure)

    def _close(self):
        object.__setattr__(self, '_closed', True)
        try:
            os.close(self.pipe_fd)
        except OSError:
            pass


def _raw_attributes(fd):
    """FD's attributes with raw input (R10), from named termios constants only."""
    iflag, oflag, cflag, lflag, ispeed, ospeed, cc = termios.tcgetattr(fd)
    cc = list(cc)
    cc[termios.VMIN] = 1
    cc[termios.VTIME] = 0
    iflag &= ~(termios.ICRNL | termios.INLCR | termios.IGNCR | termios.IXON | termios.ISTRIP)
    lflag &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG | termios.IEXTEN)
    return [iflag, oflag, cflag, lflag, ispeed, ospeed, cc]


def _read_exact(fd, target, count, grant, start_ms, real_end):
    """Reads exactly COUNT bytes into TARGET[0:COUNT] with readv, so no intermediate bytes object holds them.
    Returns None, or a failure code; terminal, clock and cancellation events never raise here."""
    view = memoryview(target)
    offset = 0
    while offset < count:
        if grant._cancel.is_set():
            return 'CANCELLED'
        now = _sample(grant.clock)
        if now is _CLOCK_FAILED:
            return 'CLOCK'
        remaining = real_end - time.monotonic()
        if type(now) is not int or now < start_ms or now >= grant.expires_at_ms or remaining <= 0:
            return 'EXPIRED'
        try:
            ready, _, _ = select.select((fd,), (), (), min(_POLL_SECONDS, remaining))
        except (OSError, ValueError):
            ready = None
        if ready is None:
            return 'TERMINAL_LOST'
        if not ready:
            continue
        try:
            got = os.readv(fd, (view[offset:count],))
        except InterruptedError:
            got = None
        except OSError:
            got = 0
        if got is None:
            continue
        if got <= 0:
            return 'TERMINAL_LOST'
        offset += got
    return None


def _valid_credential(buffer, length):
    """Bounded UTF-8 check of BUFFER[0:LENGTH] that creates no exception or str object; NUL is rejected."""
    index = 0
    while index < length:
        lead = buffer[index]
        if lead == 0:
            return False
        if lead < 0x80:
            index += 1
            continue
        if 0xc2 <= lead <= 0xdf:
            tail, low, high = 1, 0x80, 0xbf
        elif lead == 0xe0:
            tail, low, high = 2, 0xa0, 0xbf
        elif lead == 0xed:
            tail, low, high = 2, 0x80, 0x9f
        elif 0xe1 <= lead <= 0xef:
            tail, low, high = 2, 0x80, 0xbf
        elif lead == 0xf0:
            tail, low, high = 3, 0x90, 0xbf
        elif 0xf1 <= lead <= 0xf3:
            tail, low, high = 3, 0x80, 0xbf
        elif lead == 0xf4:
            tail, low, high = 3, 0x80, 0x8f
        else:
            return False
        if index + tail >= length or not low <= buffer[index + 1] <= high:
            return False
        for position in range(index + 2, index + tail + 1):
            if not 0x80 <= buffer[position] <= 0xbf:
                return False
        index += tail + 1
    return True


def _release(fd, exclusive):
    """tcflush(TCIFLUSH), so no unread byte waits for the next reader (T11-M1), then TIOCNXCL."""
    released = True
    try:
        termios.tcflush(fd, termios.TCIFLUSH)
    except (OSError, termios.error):
        released = False
    if exclusive:
        try:
            fcntl.ioctl(fd, termios.TIOCNXCL)
        except OSError:
            released = False
    return released


def _read_credential(fd, grant, start_ms):
    """Reads one C8 frame from FD and returns exactly the credential bytes.

    1. Raw mode with TCSAFLUSH (typeahead is discarded, R10), then TIOCEXCL.
    2. Exactly 4 header bytes, a big-endian length n; 1 <= n <= CREDENTIAL_LIMIT, otherwise CREDENTIAL_INVALID
       before any body byte is read.
    3. Exactly n bytes into a preallocated bytearray(CREDENTIAL_LIMIT).
    4. Bounded UTF-8 validation that creates no exception object.  5. NUL is rejected.
    6. The preallocated buffer and the header are zeroed on every path.
    7. tcflush(TCIFLUSH) on exit.
    The caller restores the original attributes and zeroes the returned bytearray."""
    real_end = time.monotonic() + min(_MAX_INTAKE_MS, grant.expires_at_ms - start_ms) / 1000
    buffer = bytearray(CREDENTIAL_LIMIT)
    header = bytearray(_HEADER_BYTES)
    credential = failure = None
    exclusive = False
    try:
        try:
            termios.tcsetattr(fd, termios.TCSAFLUSH, _raw_attributes(fd))
            fcntl.ioctl(fd, termios.TIOCEXCL)
            exclusive = True
        except (OSError, termios.error):
            failure = 'TERMINAL_LOST'
        if failure is not None and grant._cancel.is_set():
            failure = 'CANCELLED'  # a signal interrupted the TCSAFLUSH drain
        if failure is None:
            failure = _read_exact(fd, header, _HEADER_BYTES, grant, start_ms, real_end)
        if failure is None:
            length = int.from_bytes(header, 'big')
            if not 1 <= length <= CREDENTIAL_LIMIT:
                failure = 'CREDENTIAL_INVALID'
        if failure is None:
            failure = _read_exact(fd, buffer, length, grant, start_ms, real_end)
        if failure is None and not _valid_credential(buffer, length):
            failure = 'CREDENTIAL_INVALID'
        if failure is None:
            credential = bytearray(memoryview(buffer)[:length])
        length = 0
    finally:
        _zero(buffer)
        _zero(header)
        released = _release(fd, exclusive)
    if failure is None and not released:
        failure = 'TERMINAL_LOST'
    if failure is not None:
        if credential is not None:
            _zero(credential)
        raise _failure(failure)
    return credential


def _drain_pending():
    """Consumes intake signals that are pending while blocked; returns whether any was."""
    try:
        pending = signal.sigpending() & set(_INTAKE_SIGNALS)
    except OSError:
        return False
    for number in pending:
        try:
            if hasattr(signal, 'sigtimedwait'):
                signal.sigtimedwait((number,), 0)
            else:  # macOS has no sigtimedwait; NUMBER is pending, so sigwait returns at once
                signal.sigwait((number,))
        except (OSError, ValueError):
            pass
    return bool(pending)


def _install(cancel, previous):
    """Latches the intake signals into CANCEL (main thread only).  The handler only sets the latch, so no signal
    can raise an exception in the middle of the read or of cleanup."""
    if threading.current_thread() is not threading.main_thread():
        return None

    def latch(_number, _frame):
        cancel.set()
    installed = True
    for number in _INTAKE_SIGNALS:
        handler = signal.getsignal(number)
        if handler is None:  # installed outside Python; it could not be restored
            continue
        previous[number] = handler  # recorded first, so whatever is installed is always restored
        try:
            signal.signal(number, latch)
        except (OSError, ValueError):
            installed = False
    return None if installed else 'TERMINAL_LOST'


class _Restore:
    """The restore after an intake: steps that always all run (T11-M4; fix round 1, I1).

    pthread_sigmask blocks the five intake signals for the calling thread only.  In a process with other threads,
    a process-directed signal (kill(2), a terminal ^C) goes to an unblocked thread, and CPython then runs its
    Python-level handler on the main thread whatever the main thread's mask.  Once a raising handler such as
    default_int_handler is restored, it can raise in the middle of the restore.  So each step runs in its own try:
    an interruption is remembered (a finite CANCELLED) and the remaining steps still run.  run() moves past a step
    before running it, so an interrupted step is not retried; the caller calls run() again, in its finally, if an
    interruption escapes between steps.

    Order: zero the private copy; record the mask; block the intake signals; restore the terminal; drain; restore
    every original handler; drain; restore the mask.  A signal that arrives while blocked stays pending, is
    drained, and latches cancellation."""

    def __init__(self, fd, original, previous, cancel):
        self._fd, self._original, self._previous, self._cancel = fd, original, previous, cancel
        self.secret = None
        self.restored = True
        self.interrupted = False
        self._mask = None
        self._steps = None
        self._next = 0

    def done(self):
        return self._steps is not None and self._next >= len(self._steps)

    def interrupt(self):
        self.interrupted = True
        self._cancel.set()

    def run(self):
        if self._steps is None:
            self._steps = ((self._erase, self._record_mask, self._block, self._terminal, self._drain)
                           + tuple(self._handler(number, handler) for number, handler in self._previous.items())
                           + (self._drain, self._unblock))
        while self._next < len(self._steps):
            step = self._steps[self._next]
            self._next += 1
            try:
                step()
            except (OSError, ValueError, TypeError, termios.error):
                self.restored = False
            except BaseException:  # a Python-level signal handler raised during this step
                self.interrupt()

    def _erase(self):
        if self.secret is not None:
            _zero(self.secret)

    def _record_mask(self):
        self._mask = signal.pthread_sigmask(signal.SIG_BLOCK, ())  # the current mask, unchanged

    def _block(self):
        if self._mask is not None:  # never block without a recorded mask to restore
            signal.pthread_sigmask(signal.SIG_BLOCK, _INTAKE_SIGNALS)

    def _terminal(self):
        termios.tcsetattr(self._fd, termios.TCSANOW, self._original)

    def _drain(self):
        if self._mask is not None and _drain_pending():
            self._cancel.set()

    def _handler(self, number, handler):
        return lambda: signal.signal(number, handler)

    def _unblock(self):
        if self._mask is not None:
            signal.pthread_sigmask(signal.SIG_SETMASK, self._mask)


def consume_credential(grant, tty_fd, sink):
    """Consume one private UTF-8 credential frame from ``tty_fd`` into ``sink``.

    The grant, and with it the run, is spent before any terminal or sink effect.
    The result names the run only; plaintext and its length never enter public
    output.  Every failure is a finite IntakeFailure with nothing chained.
    """
    if type(grant) is not IntakeGrant:
        raise _failure('IDENTITY_MISMATCH')
    if type(tty_fd) is not int or tty_fd < 0 or not os.isatty(tty_fd):
        raise _failure('NON_TTY')
    if type(sink) is not PrivatePipeSink or not sink.matches(grant):
        raise _failure('SINK_DENIED')
    try:
        original = termios.tcgetattr(tty_fd)
    except (OSError, termios.error):
        original = None
    if original is None:
        raise _failure('NON_TTY')
    started = grant.claim()
    deadline = time.monotonic() + min(_MAX_INTAKE_MS, grant.expires_at_ms - started) / 1000
    previous = {}
    restore = _Restore(tty_fd, original, previous, grant._cancel)
    value = failure = None
    stage = 'TERMINAL_LOST'
    try:
        failure = _install(grant._cancel, previous)
        if failure is None:
            try:
                value = restore.secret = _read_credential(tty_fd, grant, started)
            except IntakeFailure as caught:
                failure = caught.args[0]
        if failure is None:
            now = _sample(grant.clock)
            if now is _CLOCK_FAILED:
                failure = 'CLOCK'
            elif type(now) is not int or now < started or now >= grant.expires_at_ms:
                failure = 'EXPIRED'
        if failure is None:
            stage = 'SINK_FAILED'
            try:
                sink.consume_private(grant.binding.run_id, memoryview(value), deadline)
            except IntakeFailure:
                failure = 'SINK_FAILED'
    except Exception:
        failure = failure or stage
    except BaseException:  # a Python-level signal handler raised during the intake (KeyboardInterrupt and kin)
        restore.interrupt()
    finally:
        while not restore.done():
            try:
                restore.run()
            except BaseException:  # an interruption that escaped between restore steps; run() resumes after it
                restore.interrupt()
    # Fix round 1 (I1): any interruption during the intake or the restore is a finite CANCELLED.
    if not restore.restored:
        failure = 'TERMINAL_LOST'
    elif restore.interrupted or (failure is None and grant._cancel.is_set()):
        failure = 'CANCELLED'
    if failure is not None:
        raise _failure(failure)
    return ConsumeResult(grant.binding.run_id)

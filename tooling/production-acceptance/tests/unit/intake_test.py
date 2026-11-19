"""Synthetic Task 11/12 private-intake contract tests (C8, decision E6); no real credentials.

Only synthetic canaries are used.  Every intake test drives a real PTY (``os.openpty``) whose master is drained by
one reader thread for the PTY's whole life, and every test is bounded by ``signal.alarm(5)``.
"""
import contextlib
import dataclasses
import fcntl
import importlib.util
import inspect
import io
import json
import os
import pathlib
import pty
import select
import signal
import stat
import struct
import sys
import tempfile
import termios
import threading
import time
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


intake = load('task11_intake', 'guest/intake.py')

MANIFEST = 'a' * 64
CONFIG = 'b' * 64
CANARY = b'synthetic-private-canary'
# Every 8-byte window of the canary, so a split or partial copy is still found.
CANARY_WINDOWS = tuple(CANARY[index:index + 8] for index in range(len(CANARY) - 7))
WINDOW_MS = 1500
INTAKE_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT, signal.SIGTSTP)
# C8 vectors, the same table as ConsoleTests.swift credentialVectors: (case, secret, header hex).
FRAME_VECTORS = (
    ('a', b'synthetic-private-canary', '00000018'),
    ('b', b'0123456789', '0000000a'),
    ('c', b'pa\nss\x03\x04\x15\x7fword', '0000000d'),
    ('d', b'a' * 4096, '00001000'),
)


class _Alarm(BaseException):
    """Raised by the per-test SIGALRM bound.  A BaseException, so no intake handler can absorb it."""


class Clock:
    def __init__(self, now=1000): self.now = now
    def __call__(self): return self.now


def fresh_run():
    return os.urandom(16).hex()


def frame(secret):
    return len(secret).to_bytes(4, 'big') + secret


def modes(fd):
    """tcgetattr(FD) without PENDIN.  XNU sets PENDIN itself whenever TIOCSETA turns ICANON back on
    (bsd/kern/tty.c ttioctl), so a TCSANOW restore of canonical mode shows it; the intake never sets it."""
    attributes = termios.tcgetattr(fd)
    attributes[3] &= ~termios.PENDIN
    return attributes


def capture(operation):
    """The operation's result, or the IntakeFailure it raised.  CANARY is never a local of this frame or of the
    callers' lambdas, so a failure's traceback holds no test-side copy of it."""
    try:
        return operation()
    except intake.IntakeFailure as failure:
        return failure


def capture_any(operation):
    """Like capture, but returns any BaseException (for example KeyboardInterrupt) instead of propagating it."""
    try:
        return operation()
    except BaseException as failure:
        return failure


def leaks(value, depth=0):
    if isinstance(value, (bytes, bytearray)):
        data = bytes(value)
    elif isinstance(value, memoryview):
        try:
            data = value.tobytes()
        except ValueError:
            return False
    elif isinstance(value, str):
        data = value.encode('utf-8', 'surrogatepass')
    elif isinstance(value, (list, tuple, set, frozenset)) and depth < 4:
        return any(leaks(item, depth + 1) for item in value)
    elif isinstance(value, dict) and depth < 4:
        return any(leaks(key, depth + 1) or leaks(item, depth + 1) for key, item in value.items())
    else:
        try:
            data = repr(value).encode('utf-8', 'surrogatepass')
        except Exception:
            return False
    return any(window in data for window in CANARY_WINDOWS)


def canary_hits(failure):
    """Every place a canary window is reachable from FAILURE: the __context__ and __cause__ chain, each exception's
    args and .object, and every local of every frame in each exception's __traceback__."""
    hits, seen, pending = [], set(), [failure]
    while pending:
        current = pending.pop()
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        if leaks(current.args):
            hits.append((type(current).__name__, 'args'))
        if leaks(getattr(current, 'object', None)):
            hits.append((type(current).__name__, '.object'))
        trace = current.__traceback__
        while trace is not None:
            for name, value in trace.tb_frame.f_locals.items():
                if leaks(value):
                    hits.append((trace.tb_frame.f_code.co_qualname, name))
            trace = trace.tb_next
        pending += [current.__context__, current.__cause__]
    return hits


class Terminal:
    """A real PTY.  One thread drains the master for the PTY's whole life (macOS TCSAFLUSH waits until pending
    output has drained), and only that thread ever closes the master."""

    def __init__(self, start=True):
        self.master, self.slave = pty.openpty()
        self.original = modes(self.slave)
        self._output = bytearray()
        self._lock = threading.Lock()
        self._stop, self._lose, self._lost = threading.Event(), threading.Event(), threading.Event()
        self._thread = threading.Thread(target=self._drain, daemon=True)
        if start:
            self.start()

    def start(self):
        self._thread.start()

    def _drain(self):
        while not self._stop.is_set():
            if self._lose.is_set():
                os.close(self.master)
                self._lost.set()
                return
            ready, _, _ = select.select((self.master,), (), (), .005)
            if ready:
                try:
                    data = os.read(self.master, 65536)
                except OSError:
                    data = b''
                if not data:
                    time.sleep(.005)
                with self._lock:
                    self._output += data

    def type(self, data):
        view = memoryview(data)
        while view:
            view = view[os.write(self.master, view):]

    def wait_mode(self, done=None, limit=2.0):
        """Waits, bounded, until the slave's local modes differ from their original value, that is until the
        intake has applied its own mode, or DONE is set.  Returns whether the mode changed."""
        end = time.monotonic() + limit
        while time.monotonic() < end and not (done is not None and done.is_set()):
            if modes(self.slave)[3] != self.original[3]:
                return True
            time.sleep(.001)
        return False

    def wait_consumed(self, limit=1.0):
        """Waits, bounded, until the slave's input queue is empty (the intake has read every typed byte)."""
        end = time.monotonic() + limit
        while time.monotonic() < end:
            if struct.unpack('i', fcntl.ioctl(self.slave, termios.FIONREAD, struct.pack('i', 0)))[0] == 0:
                return True
            time.sleep(.001)
        return False

    def unread(self):
        """Bytes still queued on the slave, partial canonical lines included: FIONREAD counts only complete lines
        in canonical mode, so the count is taken in non-canonical mode (TCSANOW keeps the queues), then the
        original mode comes back."""
        attributes = termios.tcgetattr(self.slave)
        attributes[3] &= ~termios.ICANON
        termios.tcsetattr(self.slave, termios.TCSANOW, attributes)
        try:
            return struct.unpack('i', fcntl.ioctl(self.slave, termios.FIONREAD, struct.pack('i', 0)))[0]
        finally:
            termios.tcsetattr(self.slave, termios.TCSANOW, self.original)

    def lose_master(self):
        self._lose.set()
        self._lost.wait(1)

    def output(self):
        """Every byte the master received, once the master has been quiet for 50 ms."""
        last, quiet = -1, time.monotonic()
        while time.monotonic() - quiet < .05:
            with self._lock:
                size = len(self._output)
            if size != last:
                last, quiet = size, time.monotonic()
            time.sleep(.005)
        with self._lock:
            return bytes(self._output)

    def read_line(self, limit=.5):
        ready, _, _ = select.select((self.slave,), (), (), limit)
        return os.read(self.slave, 4096) if ready else b''

    def close(self):
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(1)
        if not self._lost.is_set():
            os.close(self.master)
        try:  # a session leader's exit revokes the slave (controlling_terminal_intake)
            termios.tcsetattr(self.slave, termios.TCSANOW, self.original)
        except (OSError, termios.error):
            pass
        os.close(self.slave)


class Private:
    """The browser-side private pipe.  The sink holds the write end; the test reads the other end."""

    def __init__(self):
        self.read_fd, self.write_fd = os.pipe()
        self._identity = os.fstat(self.write_fd)[stat.ST_INO]
        fcntl.fcntl(self.read_fd, fcntl.F_SETFL, fcntl.fcntl(self.read_fd, fcntl.F_GETFL) | os.O_NONBLOCK)

    def fill(self, leave=0):
        """Fills the pipe until the kernel refuses more, then frees LEAVE bytes; returns the bytes left in it."""
        fcntl.fcntl(self.write_fd, fcntl.F_SETFL, fcntl.fcntl(self.write_fd, fcntl.F_GETFL) | os.O_NONBLOCK)
        filled = 0
        while True:
            try:
                filled += os.write(self.write_fd, b'x' * 4096)
            except BlockingIOError:
                break
        if leave:
            os.read(self.read_fd, leave)
        return filled - leave

    def lose_reader(self):
        """Closes the reading end (the browser died); /dev/null takes its place so drain() and close() stay valid."""
        os.close(self.read_fd)
        self.read_fd = os.open(os.devnull, os.O_RDONLY | os.O_NONBLOCK)

    def drain(self):
        """(every byte in the pipe now, whether the write end is closed)."""
        data = bytearray()
        while True:
            try:
                chunk = os.read(self.read_fd, 65536)
            except BlockingIOError:
                return bytes(data), False
            if not chunk:
                return bytes(data), True
            data += chunk

    def close(self):
        os.close(self.read_fd)
        try:
            same = os.fstat(self.write_fd)[stat.ST_INO] == self._identity
        except OSError:
            same = False
        if same:  # a sink that failed has closed it; never close a reused descriptor number
            os.close(self.write_fd)


@dataclasses.dataclass
class Run:
    outcome: object
    private: bytes
    closed: bool
    terminal: Terminal
    elapsed: float


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        previous = signal.signal(signal.SIGALRM, self._alarm)
        self.addCleanup(signal.signal, signal.SIGALRM, previous)
        signal.alarm(5)
        self.addCleanup(signal.alarm, 0)

    @staticmethod
    def _alarm(_number, _frame):
        raise _Alarm('test exceeded its signal.alarm(5) bound')

    def grant(self, run=None, *, proof_run=None, consumer='BROWSER', destinations=('FRONTEND', 'BACKEND'),
              issued=1000, expires=1000 + WINDOW_MS, binding_expires=200000, proof_expires=200000,
              child_id='2' * 32):
        run = run or fresh_run()
        binding = intake.RunBinding(
            run, b'7' * 32, binding_expires, 1, MANIFEST, CONFIG,
            (('BACKEND', 'https://backend.example.test'),
             ('FRONTEND', 'https://frontend.example.test')))
        proof = intake.AdmissionProof(
            proof_run or run, MANIFEST, CONFIG, 'c' * 64, 'd' * 64, 'e' * 64,
            proof_expires, 1, '{}', 'handoff')
        return intake.IntakeGrant.issue(
            proof=proof, binding=binding, consumer=consumer,
            destinations=destinations, issued_at_ms=issued,
            expires_at_ms=expires, clock=self.clock, child_id=child_id)

    def private(self):
        private = Private()
        self.addCleanup(private.close)
        return private

    def terminal(self, start=True):
        terminal = Terminal(start)
        self.addCleanup(terminal.close)
        return terminal

    def sink(self, grant, private, child_id=None):
        return intake.PrivatePipeSink.issue(
            binding=grant.binding, consumer=grant.consumer, destinations=grant.destinations,
            child_id=child_id or grant.child_id, pipe_fd=private.write_fd)

    def run_intake(self, grant, typed=b'', *, ahead=b'', lose=False, private=None):
        """consume_credential(grant, slave, sink) on a fresh real PTY.  AHEAD is typed before the intake starts;
        TYPED once the intake has applied its own mode; LOSE closes the master once every typed byte was read."""
        terminal = self.terminal()
        private = private or self.private()
        sink = self.sink(grant, private)
        done = threading.Event()
        if ahead:
            terminal.type(ahead)

        def writer():
            if not terminal.wait_mode(done) and done.is_set():
                return
            if typed:
                terminal.type(typed)
            if lose:
                terminal.wait_consumed()
                terminal.lose_master()
        thread = threading.Thread(target=writer, daemon=True)
        thread.start()
        started = time.monotonic()
        outcome = capture(lambda: intake.consume_credential(grant, terminal.slave, sink))
        elapsed = time.monotonic() - started
        done.set()
        thread.join(2)
        data, closed = private.drain()
        return Run(outcome, data, closed, terminal, elapsed)

    def code(self, run):
        self.assertIsInstance(run.outcome, intake.IntakeFailure)
        return str(run.outcome)

    def assert_code(self, code, operation):
        with self.assertRaises(intake.IntakeFailure) as raised:
            operation()
        self.assertEqual(str(raised.exception), code)

    def assert_clean_failure(self, name, failure, expected):
        self.assertIsInstance(failure, intake.IntakeFailure, name)
        self.assertEqual(str(failure), expected, name)
        self.assertIsNone(failure.__context__, name)
        self.assertIsNone(failure.__cause__, name)
        self.assertEqual(canary_hits(failure), [], name)

    @contextlib.contextmanager
    def reads(self):
        """Records the byte count of every os.readv the intake makes."""
        counts, real = [], os.readv

        def counting(fd, buffers):
            got = real(fd, buffers)
            counts.append(got)
            return got
        with mock.patch.object(intake.os, 'readv', counting):
            yield counts

    def handlers(self, handler):
        """Installs HANDLER for every intake signal; the originals come back at cleanup."""
        for number in INTAKE_SIGNALS:
            self.addCleanup(signal.signal, number, signal.signal(number, handler))

    def assert_handlers(self, expected):
        for number in INTAKE_SIGNALS:
            self.assertIs(signal.getsignal(number), expected[number], number)

    # --- C8 framing -------------------------------------------------------------------------------------------

    def test_length_prefixed_frame_vectors_decode_exactly(self):
        for case, secret, header in FRAME_VECTORS:
            self.assertEqual(frame(secret)[:4].hex(), header, case)
            run = self.run_intake(self.grant(), bytes.fromhex(header) + secret)
            self.assertIsInstance(run.outcome, intake.ConsumeResult, case)
            # The browser frame has the same format, so it carries the secret byte-exact.
            self.assertEqual(run.private, bytes.fromhex(header) + secret, case)
            self.assertFalse(run.closed, case)
        for case, typed in (('e', bytes.fromhex('00001001')), ('f', bytes.fromhex('00000000'))):
            with self.reads() as counts:
                run = self.run_intake(self.grant(), typed)
            self.assertEqual(self.code(run), 'CREDENTIAL_INVALID', case)
            self.assertEqual(sum(counts), 4, case)  # the header only: no body byte is read
            self.assertEqual(run.private, b'', case)
        run = self.run_intake(self.grant(), bytes.fromhex('00000018') + CANARY[:13], lose=True)
        self.assertEqual(self.code(run), 'TERMINAL_LOST', 'g')
        self.assertEqual(run.private, b'', 'g')
        run = self.run_intake(self.grant(), bytes.fromhex('00000001') + b'\xff')
        self.assertEqual(self.code(run), 'CREDENTIAL_INVALID', 'h')
        self.assertEqual(run.private, b'', 'h')
        run = self.run_intake(self.grant(), frame(b'synthetic\x00canary'))
        self.assertEqual(self.code(run), 'CREDENTIAL_INVALID', 'NUL')
        self.assertEqual(run.private, b'', 'NUL')

    def test_length_prefix_control_bytes_before_raw_mode_flushed_and_fail(self):
        # Header 00 00 00 03 and a body 0x03 are VINTR bytes.  The PTY is the intake's controlling terminal, so an
        # ISIG line discipline would deliver SIGINT and swallow the byte; in raw mode both are data.  (First, so
        # the fork happens before this test starts any thread.)
        status, private = self.controlling_terminal_intake(frame(b'x\x03y'))
        self.assertEqual(status, b'OK')
        self.assertEqual(private, frame(b'x\x03y'))
        # Review Focus 5: typeahead 00 00 00 0a, typed while the TTY is still canonical (a complete line), is
        # discarded by TCSAFLUSH; it never becomes a length prefix, and the following valid frame decodes.
        secret = b'0123456789'
        run = self.run_intake(self.grant(), frame(secret), ahead=b'\x00\x00\x00\x0a')
        self.assertIsInstance(run.outcome, intake.ConsumeResult)
        self.assertEqual(run.private, frame(secret))

    def controlling_terminal_intake(self, typed):
        """Runs the intake in a forked child whose controlling terminal is the PTY slave (setsid, TIOCSCTTY).
        Returns (the child's status, every byte the sink wrote)."""
        grant = self.grant()
        private = self.private()
        sink = self.sink(grant, private)
        terminal = self.terminal(start=False)
        status_read, status_write = os.pipe()
        pid = os.fork()
        if pid == 0:
            status = b'EXCEPTION'
            try:
                signal.alarm(5)
                os.close(terminal.master)
                os.close(status_read)
                os.setsid()
                fcntl.ioctl(terminal.slave, termios.TIOCSCTTY, 0)
                try:
                    intake.consume_credential(grant, terminal.slave, sink)
                    status = b'OK'
                except intake.IntakeFailure as failure:
                    status = str(failure).encode()
            finally:
                os.write(status_write, status)
                os._exit(0)
        os.close(status_write)
        terminal.start()
        try:
            terminal.wait_mode()
            terminal.type(typed)
            ready, _, _ = select.select((status_read,), (), (), 4)
            status = os.read(status_read, 64) if ready else b'NO_STATUS'
        finally:
            os.close(status_read)
            os.waitpid(pid, 0)
        return status, private.drain()[0]

    # --- T11-I1: no credential in any exception chain ------------------------------------------------------------

    def test_exception_chain_holds_no_credential(self):
        run = self.run_intake(self.grant(), frame(CANARY + b'\xff'))
        self.assert_clean_failure('consume utf8', run.outcome, 'CREDENTIAL_INVALID')
        reader_gone = self.private()
        reader_gone.lose_reader()
        run = self.run_intake(self.grant(), frame(CANARY), private=reader_gone)
        self.assert_clean_failure('consume sink', run.outcome, 'SINK_FAILED')

        def leaking_sink(_sink, _run_id, value, _deadline):
            raise RuntimeError(bytes(value))  # an unexpected sink error that captured the private bytes
        with mock.patch.object(intake.PrivatePipeSink, 'consume_private', leaking_sink):
            run = self.run_intake(self.grant(), frame(CANARY))
        self.assert_clean_failure('consume unexpected sink error', run.outcome, 'SINK_FAILED')
        # The same two events at the inner raise sites, _read_credential and PrivatePipeSink.consume_private.
        grant = self.grant()
        terminal = self.terminal()
        started = grant.claim()

        def writer():
            terminal.wait_mode()
            terminal.type(frame(CANARY + b'\xff'))
        thread = threading.Thread(target=writer, daemon=True)
        thread.start()
        failure = capture(lambda: intake._read_credential(terminal.slave, grant, started))
        thread.join(2)
        self.assert_clean_failure('read utf8', failure, 'CREDENTIAL_INVALID')
        gone = self.private()
        sink = self.sink(grant, gone)
        gone.lose_reader()
        value = bytearray(CANARY)
        failure = capture(lambda: sink.consume_private(grant.binding.run_id, memoryview(value),
                                                       time.monotonic() + .5))
        value[:] = bytes(len(value))  # the caller's erasure, as consume_credential does
        self.assert_clean_failure('sink epipe', failure, 'SINK_FAILED')

    # --- T11-I2: privacy observed where it would leak --------------------------------------------------------------

    def test_no_echo_on_pty_master(self):
        run = self.run_intake(self.grant(), frame(CANARY))
        self.assertIsInstance(run.outcome, intake.ConsumeResult)
        self.assertEqual(run.private, frame(CANARY))
        output = run.terminal.output()
        self.assertFalse(any(window in output for window in CANARY_WINDOWS))
        self.assertEqual(output, b'')

    def test_fd_level_output_has_no_canary(self):
        capture_read, capture_write = os.pipe()
        collected = bytearray()

        def collect():
            while True:
                chunk = os.read(capture_read, 65536)
                if not chunk:
                    return
                collected.extend(chunk)
        thread = threading.Thread(target=collect, daemon=True)
        thread.start()
        saved = os.dup(1), os.dup(2)
        sys.stdout.flush()
        sys.stderr.flush()
        os.dup2(capture_write, 1)
        os.dup2(capture_write, 2)
        try:
            run = self.run_intake(self.grant(), frame(CANARY))
            sys.stdout.flush()
            sys.stderr.flush()
        finally:
            os.dup2(saved[0], 1)
            os.dup2(saved[1], 2)
            os.close(saved[0])
            os.close(saved[1])
            os.close(capture_write)
        thread.join(2)
        os.close(capture_read)
        self.assertIsInstance(run.outcome, intake.ConsumeResult)
        self.assertEqual(run.private, frame(CANARY))
        self.assertFalse(any(window in collected for window in CANARY_WINDOWS))

    def test_oversize_terminal_loss_handler_restore_and_late_signal(self):
        calls = []

        def sentinel(number, _frame):
            calls.append(number)
        self.handlers(sentinel)
        expected = {number: sentinel for number in INTAKE_SIGNALS}
        run = self.run_intake(self.grant(), bytes.fromhex('00001001') + b'a' * 16)
        self.assertEqual(self.code(run), 'CREDENTIAL_INVALID')
        self.assertEqual(run.private, b'')
        self.assertEqual(modes(run.terminal.slave), run.terminal.original)
        self.assertEqual(run.terminal.unread(), 0)  # T11-M1: the 16 unread bytes are flushed, not left queued
        self.assert_handlers(expected)
        # Terminal loss: the master closes while the intake waits for the header.
        run = self.run_intake(self.grant(expires=1000 + 3000), lose=True)
        self.assertEqual(self.code(run), 'TERMINAL_LOST')
        self.assertLess(run.elapsed, 1.0)
        self.assert_handlers(expected)
        # SIGINT during the read cancels.  A second SIGINT arrives during the terminal restore, and a third right
        # after SIGINT's handler is restored to default_int_handler (which would raise KeyboardInterrupt).  Both
        # stay blocked and are drained: echo is restored and the failure is finite.
        signal.signal(signal.SIGINT, signal.default_int_handler)
        expected[signal.SIGINT] = signal.default_int_handler
        main = threading.main_thread().ident
        real_signal, real_setattr = signal.signal, termios.tcsetattr
        armed = {'terminal': True, 'handler': True}

        def setattr_then_signal(fd, when, attributes):
            real_setattr(fd, when, attributes)
            if armed['terminal'] and when == termios.TCSANOW:
                armed['terminal'] = False
                signal.pthread_kill(main, signal.SIGINT)

        def restore_then_signal(number, handler):
            previous = real_signal(number, handler)
            if armed['handler'] and number == signal.SIGINT and handler is signal.default_int_handler:
                armed['handler'] = False
                signal.pthread_kill(main, signal.SIGINT)
            return previous
        grant = self.grant()
        terminal = self.terminal()
        sink = self.sink(grant, self.private())

        def interrupter():
            terminal.wait_mode()
            signal.pthread_kill(main, signal.SIGINT)
        thread = threading.Thread(target=interrupter, daemon=True)
        thread.start()
        with mock.patch.object(intake.termios, 'tcsetattr', setattr_then_signal), \
                mock.patch.object(intake.signal, 'signal', restore_then_signal):
            outcome = capture_any(lambda: intake.consume_credential(grant, terminal.slave, sink))
        thread.join(2)
        self.assertIs(type(outcome), intake.IntakeFailure)
        self.assertEqual(str(outcome), 'CANCELLED')
        self.assertEqual(armed, {'terminal': False, 'handler': False})
        self.assertEqual(modes(terminal.slave), terminal.original)
        self.assertTrue(termios.tcgetattr(terminal.slave)[3] & termios.ECHO)
        self.assert_handlers(expected)
        self.assertEqual(calls, [])

    # --- T11-M5, T11-M7 ------------------------------------------------------------------------------------------

    def test_second_grant_for_same_run_rejected(self):
        run_id = fresh_run()
        first, second = self.grant(run_id), self.grant(run_id)
        run = self.run_intake(first, frame(CANARY))
        self.assertIsInstance(run.outcome, intake.ConsumeResult)
        for name, grant in (('second grant', second), ('spent grant', first)):
            terminal = self.terminal()
            private = self.private()
            sink = self.sink(grant, private)
            terminal.type(b'unread-marker\n')
            outcome = capture(lambda: intake.consume_credential(grant, terminal.slave, sink))
            self.assertIsInstance(outcome, intake.IntakeFailure, name)
            self.assertEqual(str(outcome), 'ALREADY_CONSUMED', name)
            # Rejected before any terminal effect: mode unchanged and the typed line still unread.
            self.assertEqual(modes(terminal.slave), terminal.original, name)
            self.assertEqual(terminal.read_line(), b'unread-marker\n', name)
            self.assertEqual(private.drain(), (b'', False), name)
        self.assert_code('ALREADY_CONSUMED', lambda: self.grant(run_id))

    def test_consume_result_has_no_length(self):
        self.assertEqual([item.name for item in dataclasses.fields(intake.ConsumeResult)], ['run_id'])
        grant = self.grant()
        run = self.run_intake(grant, frame(CANARY))
        self.assertEqual(dataclasses.asdict(run.outcome), {'run_id': grant.binding.run_id})
        self.assertFalse(hasattr(run.outcome, 'byte_length'))

    def test_swift_credential_frames_decode_in_python(self):
        path = os.environ.get('CREDENTIAL_FRAME_INPUT')
        if not path:
            self.skipTest('CREDENTIAL_FRAME_INPUT absent')
        document = json.loads(pathlib.Path(path).read_bytes())
        self.assertEqual(set(document), {'vectors'})
        self.assertEqual([set(vector) for vector in document['vectors']],
                         [{'secretHex', 'frameHex'}] * len(FRAME_VECTORS))
        exported = [(bytes.fromhex(vector['secretHex']), bytes.fromhex(vector['frameHex']))
                    for vector in document['vectors']]
        self.assertEqual(exported, [(secret, bytes.fromhex(header) + secret) for _, secret, header in FRAME_VECTORS])
        for secret, swift_frame in exported:
            run = self.run_intake(self.grant(), swift_frame)
            self.assertIsInstance(run.outcome, intake.ConsumeResult)
            self.assertEqual(run.private, frame(secret))

    # --- Task 11 contract tests, kept ---------------------------------------------------------------------------

    def test_nonTTY_redirect_reject(self):
        read_fd, write_fd = os.pipe()
        grant = self.grant()
        try:
            os.write(write_fd, frame(b'synthetic-only-password'))
            self.assert_code('NON_TTY', lambda: intake.consume_credential(grant, read_fd, object()))
        finally:
            os.close(read_fd)
            os.close(write_fd)
        run = self.run_intake(grant, frame(b'synthetic-only-password'))
        self.assertIsInstance(run.outcome, intake.ConsumeResult)
        self.assertEqual(run.private, frame(b'synthetic-only-password'))

    def test_argv_env_file_clipboard_not_sources(self):
        grant = self.grant()
        old_argv = list(sys.argv)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'credential.txt'
            path.write_bytes(b'file-canary')
            os.environ['TASK11_CREDENTIAL_CANARY'] = 'environment-canary'
            sys.argv[:] = ['intake.py', 'argv-canary', str(path), 'clipboard-canary']
            try:
                run = self.run_intake(grant, frame(b'tty-canary'))
            finally:
                sys.argv[:] = old_argv
                os.environ.pop('TASK11_CREDENTIAL_CANARY', None)
        self.assertIsInstance(run.outcome, intake.ConsumeResult)
        self.assertEqual(run.private, frame(b'tty-canary'))
        self.assertEqual(tuple(inspect.signature(intake.consume_credential).parameters),
                         ('grant', 'tty_fd', 'sink'))

    def test_wrong_run_consumer_destination_expiry_second_consume_reject(self):
        self.assert_code('IDENTITY_MISMATCH', lambda: self.grant(proof_run='2' * 32))
        self.assert_code('CONSUMER_DENIED', lambda: self.grant(consumer='VERIFIER'))
        self.assert_code('DESTINATION_DENIED', lambda: self.grant(destinations=('FRONTEND',)))
        self.assert_code('EXPIRED', lambda: self.grant(expires=121001))
        expired = self.grant(expires=1001)
        self.clock.now = 1001
        self.assertEqual(self.code(self.run_intake(expired, frame(CANARY))), 'EXPIRED')
        self.clock.now = 1000
        grant = self.grant()
        self.assertIsInstance(self.run_intake(grant, frame(CANARY)).outcome, intake.ConsumeResult)
        self.assertEqual(self.code(self.run_intake(grant, frame(CANARY))), 'ALREADY_CONSUMED')

    def test_cancelled_signal_exception_restore_both_echo(self):
        # A process-directed SIGINT during the read cancels; the terminal is restored and the grant is spent.
        grant = self.grant()
        terminal = self.terminal()
        sink = self.sink(grant, self.private())

        def interrupter():
            terminal.wait_mode()
            os.kill(os.getpid(), signal.SIGINT)
        thread = threading.Thread(target=interrupter, daemon=True)
        thread.start()
        self.assert_code('CANCELLED', lambda: intake.consume_credential(grant, terminal.slave, sink))
        thread.join(2)
        self.assertEqual(modes(terminal.slave), terminal.original)
        self.assert_code('ALREADY_CONSUMED', lambda: intake.consume_credential(grant, terminal.slave, sink))
        # A failed terminal restore is TERMINAL_LOST, whatever the read did.
        real_setattr = termios.tcsetattr

        def fail_restore(fd, when, attributes):
            if when == termios.TCSANOW:
                raise termios.error('synthetic restore failure')
            return real_setattr(fd, when, attributes)
        with mock.patch.object(intake.termios, 'tcsetattr', side_effect=fail_restore):
            run = self.run_intake(self.grant(), frame(b'synthetic-restore-canary'))
        self.assertEqual(self.code(run), 'TERMINAL_LOST')
        # A sink that cannot take the frame before the intake deadline fails, restores, and closes its pipe.
        full = self.private()
        full.fill()
        run = self.run_intake(self.grant(expires=1000 + 600), frame(b'synthetic-full-pipe'), private=full)
        self.assertEqual(self.code(run), 'SINK_FAILED')
        self.assertTrue(run.closed)
        self.assertEqual(modes(run.terminal.slave), run.terminal.original)
        # T11-M8: a partial write is SINK_FAILED and closes the pipe, so the reader sees EOF after the prefix.
        partial = self.private()
        prefilled = partial.fill(leave=1000)
        run = self.run_intake(self.grant(expires=1000 + 600), frame(b'a' * 4096), private=partial)
        self.assertEqual(self.code(run), 'SINK_FAILED')
        self.assertTrue(run.closed)
        written = run.private[prefilled:]
        self.assertTrue(0 < len(written) < len(frame(b'a' * 4096)), len(written))
        self.assertEqual(written, frame(b'a' * 4096)[:len(written)])

    def test_synthetic_canary_absent_from_host_output_and_evidence(self):
        output, error = io.StringIO(), io.StringIO()
        grant = self.grant()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            run = self.run_intake(grant, frame(CANARY))
        self.assertEqual(modes(run.terminal.slave), run.terminal.original)
        self.assertEqual(run.private, frame(CANARY))
        public = repr(run.outcome) + repr(dataclasses.asdict(run.outcome)) + output.getvalue() + error.getvalue()
        self.assertNotIn(CANARY.decode(), public)
        self.assertEqual(dataclasses.asdict(run.outcome), {'run_id': grant.binding.run_id})

    def test_sink_issue_rejects_console_fd_facts_offline(self):
        """Offline: issue-time descriptor facts and identity only.  No child process and no real descriptor
        inventory are inspected (renamed from test_automation_child_no_console_access, T11-I2)."""
        grant = self.grant()
        terminal = self.terminal()
        private = self.private()

        def issue(**changes):
            arguments = dict(binding=grant.binding, consumer='BROWSER', destinations=grant.destinations,
                             child_id=grant.child_id, pipe_fd=private.write_fd)
            arguments.update(changes)
            return intake.PrivatePipeSink.issue(**arguments)
        flags = fcntl.fcntl(terminal.slave, fcntl.F_GETFL)
        self.assert_code('SINK_DENIED', lambda: issue(pipe_fd=terminal.slave))  # a console descriptor
        self.assertEqual(fcntl.fcntl(terminal.slave, fcntl.F_GETFL), flags)  # and left untouched
        self.assert_code('SINK_DENIED', lambda: issue(pipe_fd=private.read_fd))  # the reading end
        with tempfile.TemporaryFile() as regular:
            self.assert_code('SINK_DENIED', lambda: issue(pipe_fd=regular.fileno()))
        for child_id in ('g' * 32, 'A' * 32, '2' * 31, '2' * 33, 2):  # T11-M8: hex-validated
            self.assert_code('SINK_DENIED', lambda: issue(child_id=child_id))
        self.assert_code('SINK_DENIED', lambda: issue(consumer='VERIFIER'))
        wrong = issue(child_id='3' * 32)
        self.assert_code('SINK_DENIED', lambda: intake.consume_credential(grant, terminal.slave, wrong))
        self.assertEqual(modes(terminal.slave), terminal.original)
        run = self.run_intake(grant, frame(b'synthetic-only-password'))
        self.assertFalse(hasattr(run.outcome, 'credential'))
        self.assertFalse(hasattr(run.outcome, 'tty_fd'))
        self.assertEqual(run.private, frame(b'synthetic-only-password'))
        with self.assertRaises(dataclasses.FrozenInstanceError):
            grant.consumer = 'VERIFIER'


if __name__ == '__main__': unittest.main()

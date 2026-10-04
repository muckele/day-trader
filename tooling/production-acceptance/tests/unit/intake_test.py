"""Synthetic Task 11 private-intake contract tests; no real credentials."""
import contextlib
import dataclasses
import importlib.util
import inspect
import io
import os
import pathlib
import pty
import signal
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

RUN = '1' * 32
MANIFEST = 'a' * 64
CONFIG = 'b' * 64


class Clock:
    def __init__(self, now=1000): self.now = now
    def __call__(self): return self.now


class IntakeTests(unittest.TestCase):
    def setUp(self): self.clock = Clock()

    def grant(self, *, run=RUN, proof_run=RUN, consumer='BROWSER',
              destinations=('FRONTEND', 'BACKEND'), issued=1000,
              expires=121000, binding_expires=200000, proof_expires=200000,
              child_id='2' * 32):
        binding = intake.RunBinding(
            run, b'7' * 32, binding_expires, 1, MANIFEST, CONFIG,
            (('BACKEND', 'https://backend.example.test'),
             ('FRONTEND', 'https://frontend.example.test')))
        proof = intake.AdmissionProof(
            proof_run, MANIFEST, CONFIG, 'c' * 64, 'd' * 64, 'e' * 64,
            proof_expires, 1, '{}', 'handoff')
        return intake.IntakeGrant.issue(
            proof=proof, binding=binding, consumer=consumer,
            destinations=destinations, issued_at_ms=issued,
            expires_at_ms=expires, clock=self.clock, child_id=child_id)

    def consume(self, grant, secret=b'synthetic-only-password'):
        master, slave = pty.openpty(); private_read, private_write = os.pipe()
        sink = intake.PrivatePipeSink.issue(
            binding=grant.binding, consumer=grant.consumer,
            destinations=grant.destinations, child_id=grant.child_id,
            pipe_fd=private_write)
        original = termios.tcgetattr(slave)
        def writer():
            for _ in range(1000):
                if not termios.tcgetattr(slave)[3] & termios.ECHO: break
                time.sleep(.001)
            os.write(master, secret + b'\n')
        thread = threading.Thread(target=writer, daemon=True); thread.start()
        try:
            result = intake.consume_credential(grant, slave, sink)
            thread.join(1)
            length = int.from_bytes(os.read(private_read, 4), 'big')
            private = os.read(private_read, length)
            return result, private, original, termios.tcgetattr(slave)
        finally:
            os.close(master); os.close(slave)
            os.close(private_read); os.close(private_write)

    def assert_code(self, code, operation):
        with self.assertRaises(intake.IntakeFailure) as raised: operation()
        self.assertEqual(str(raised.exception), code)

    def test_nonTTY_redirect_reject(self):
        read_fd, write_fd = os.pipe(); grant = self.grant()
        try:
            os.write(write_fd, b'synthetic-only-password\n')
            self.assert_code('NON_TTY', lambda: intake.consume_credential(grant, read_fd, object()))
        finally:
            os.close(read_fd); os.close(write_fd)
        result, private, _, _ = self.consume(grant)
        self.assertEqual(result.byte_length, len(b'synthetic-only-password'))
        self.assertEqual(private, b'synthetic-only-password')

    def test_argv_env_file_clipboard_not_sources(self):
        grant = self.grant(); old_argv = list(sys.argv)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'credential.txt'
            path.write_bytes(b'file-canary')
            os.environ['TASK11_CREDENTIAL_CANARY'] = 'environment-canary'
            sys.argv[:] = ['intake.py', 'argv-canary', str(path), 'clipboard-canary']
            try: result, private, _, _ = self.consume(grant, b'tty-canary')
            finally:
                sys.argv[:] = old_argv
                os.environ.pop('TASK11_CREDENTIAL_CANARY', None)
        self.assertEqual(result.byte_length, len(b'tty-canary'))
        self.assertEqual(private, b'tty-canary')
        self.assertEqual(tuple(inspect.signature(intake.consume_credential).parameters),
                         ('grant', 'tty_fd', 'sink'))

    def test_wrong_run_consumer_destination_expiry_second_consume_reject(self):
        self.assert_code('IDENTITY_MISMATCH', lambda: self.grant(proof_run='2' * 32))
        self.assert_code('CONSUMER_DENIED', lambda: self.grant(consumer='VERIFIER'))
        self.assert_code('DESTINATION_DENIED',
                         lambda: self.grant(destinations=('FRONTEND',)))
        self.assert_code('EXPIRED', lambda: self.grant(expires=121001))
        expired = self.grant(expires=1001); self.clock.now = 1001
        self.assert_code('EXPIRED', lambda: self.consume(expired))
        self.clock.now = 1000; grant = self.grant(); self.consume(grant)
        self.assert_code('ALREADY_CONSUMED', lambda: self.consume(grant))

    def test_cancelled_signal_exception_restore_both_echo(self):
        grant = self.grant(); master, slave = pty.openpty(); read_fd, write_fd = os.pipe()
        sink = intake.PrivatePipeSink.issue(binding=grant.binding,consumer=grant.consumer,
            destinations=grant.destinations,child_id=grant.child_id,pipe_fd=write_fd)
        before = termios.tcgetattr(slave)
        def interrupter():
            for _ in range(1000):
                if not termios.tcgetattr(slave)[3] & termios.ECHO: break
                time.sleep(.001)
            os.kill(os.getpid(), signal.SIGINT)
        thread = threading.Thread(target=interrupter, daemon=True); thread.start()
        try:
            self.assert_code('CANCELLED', lambda: intake.consume_credential(grant, slave, sink))
            thread.join(1); self.assertEqual(termios.tcgetattr(slave), before)
            self.assert_code('ALREADY_CONSUMED',
                lambda: intake.consume_credential(grant, slave, sink))
        finally:
            os.close(master); os.close(slave); os.close(read_fd); os.close(write_fd)

        grant = self.grant(); master, slave = pty.openpty(); read_fd, write_fd = os.pipe()
        sink = intake.PrivatePipeSink.issue(binding=grant.binding,consumer=grant.consumer,
            destinations=grant.destinations,child_id=grant.child_id,pipe_fd=write_fd)
        real_setattr, calls = termios.tcsetattr, 0
        def fail_restore(*args):
            nonlocal calls
            calls += 1
            if calls == 2: raise termios.error('synthetic restore failure')
            return real_setattr(*args)
        def writer():
            while termios.tcgetattr(slave)[3] & termios.ECHO: time.sleep(.001)
            os.write(master,b'synthetic-restore-canary\n')
        thread=threading.Thread(target=writer,daemon=True);thread.start()
        try:
            with mock.patch.object(intake.termios,'tcsetattr',side_effect=fail_restore):
                self.assert_code('TERMINAL_LOST',lambda:intake.consume_credential(grant,slave,sink))
        finally:
            real_setattr(slave,termios.TCSANOW,before)
            os.close(master);os.close(slave);os.close(read_fd);os.close(write_fd)

        grant=self.grant();master,slave=pty.openpty();read_fd,write_fd=os.pipe()
        sink=intake.PrivatePipeSink.issue(binding=grant.binding,consumer=grant.consumer,
            destinations=grant.destinations,child_id=grant.child_id,pipe_fd=write_fd)
        while True:
            try:os.write(write_fd,b'x'*4096)
            except BlockingIOError:break
        before=termios.tcgetattr(slave)
        def writer():
            while termios.tcgetattr(slave)[3] & termios.ECHO:time.sleep(.001)
            os.write(master,b'synthetic-full-pipe\n')
        thread=threading.Thread(target=writer,daemon=True);thread.start()
        try:
            self.assert_code('SINK_FAILED',lambda:intake.consume_credential(grant,slave,sink))
            self.assertEqual(termios.tcgetattr(slave),before)
        finally:
            os.close(master);os.close(slave);os.close(read_fd);os.close(write_fd)

    def test_synthetic_canary_absent_from_host_output_and_evidence(self):
        output, error = io.StringIO(), io.StringIO(); secret = b'synthetic-private-canary'
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            result, private, before, after = self.consume(self.grant(), secret)
        self.assertEqual(before, after)
        self.assertEqual(private, secret)
        public = repr(result) + repr(dataclasses.asdict(result)) + output.getvalue() + error.getvalue()
        self.assertNotIn(secret.decode(), public)
        self.assertEqual(dataclasses.asdict(result), {'run_id': RUN, 'byte_length': len(secret)})

    def test_automation_child_no_console_access(self):
        grant=self.grant(); result, private, _, _ = self.consume(grant)
        self.assertFalse(hasattr(result, 'credential'))
        self.assertFalse(hasattr(result, 'tty_fd'))
        self.assertEqual(set(dataclasses.asdict(result)), {'run_id', 'byte_length'})
        self.assertEqual(private,b'synthetic-only-password')
        with self.assertRaises(dataclasses.FrozenInstanceError): grant.consumer='VERIFIER'
        read_fd,write_fd=os.pipe()
        try:
            wrong=intake.PrivatePipeSink.issue(binding=grant.binding,consumer='BROWSER',
                destinations=grant.destinations,child_id='3'*32,pipe_fd=write_fd)
            master,slave=pty.openpty()
            try:self.assert_code('SINK_DENIED',lambda:intake.consume_credential(self.grant(),slave,wrong))
            finally:os.close(master);os.close(slave)
        finally:os.close(read_fd);os.close(write_fd)


if __name__ == '__main__': unittest.main()

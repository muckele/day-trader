"""Offline composition contracts. Every kernel/channel effect here is inert."""
import dataclasses
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import struct
import sys
import types
import unittest
import os
import tempfile
from unittest import mock
import contextlib
import threading
import time

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


t = load('bootstrap_v1_test_topology', ROOT / 'guest/topology.py')
c = t._CONFINEMENT
p = t._PROBES
proxy_fixture = load('bootstrap_v1_proxy_fixture', ROOT / 'tests/unit/proxy_test.py')
topology_fixture = load('bootstrap_v1_topology_fixture', ROOT / 'tests/unit/topology_test.py')
confinement_fixture = load('bootstrap_v1_confinement_fixture', ROOT / 'tests/unit/confinement_test.py')
# The module originals the composition must use unreplaced (E4, P12).
ORIGINAL_OBSERVE_CURRENT_ROLES = t.observe_current_roles
# A CONNECT to the stand-in child's own FRONTEND destination.
STAND_IN_CONNECT = b'CONNECT frontend.example:443 HTTP/1.1\r\nHost: frontend.example:443\r\n\r\n'
# C2: host-issued one-use challenges (32 lowercase hex). The first is the
# shared exported test value (nonce bytes 00..0f); the second is another.
TEST_HOST_CHALLENGE = topology_fixture.TEST_HOST_CHALLENGE
OTHER_HOST_CHALLENGE = '101112131415161718191a1b1c1d1e1f'


class Clock:
    def __init__(self): self.wall, self.mono = 1000, 100
    def sample(self): return self.wall, self.mono


class Channel:
    """Independent private fixture endpoint; never a child-reported counter."""
    def __init__(self): self.requests, self.mutate = [], lambda value: value
    def approve_inventory(self, inventory): self.inventory = inventory; return self
    def observe(self, request, timeout_ms):
        assert 0 < timeout_ms <= 2000
        self.requests.append(request)
        value = dict(request, healthy=True, count=int(
            request['phase'] == 'AFTER' and request['receiver']['probeId'] == 'proxy_fixed_vsock_positive'),
            terminal=request['phase'] == 'AFTER')
        return self.mutate(value)


class Exit(BaseException): pass


class InertFamily:
    """Drive the actual confined child/result/cleanup code with finite OS effects.

    Task 10: the authority supplies fixture processes of the controller and proxy UIDs in each family's PID
    namespace, the trusted UNIX names, the SCM_RIGHTS donors, a positive reachability control (P54) and a
    rubber-stamp inventory correlation. The inert kernel refuses every attempt with EPERM except: AF_UNIX sockets
    open (E1) and their connects are refused; recvmsg on the FD3 pipe is ENOTSOCK; unshare(CLONE_NEWUSER) succeeds (P49); the AArch32 and
    alternate-entry samples die by SIGSYS; nodes are absent and foreign /proc/<pid>/fd is EACCES. The parent observes
    each waiting exact-inventory family through literal Linux /proc (confinement_test.LiteralProc).
    """
    BOOTSTRAP_ARGV = ('/opt/acceptance/runtime/python/bin/python3', '/opt/acceptance/guest/bootstrap.py')
    FOREIGN = {'CONTROLLER': 7, 'PROXY': 8}
    SIGSYS = 31  # include/uapi/asm-generic/signal.h:46
    def __init__(self, binding, receivers, clock, budget):
        self.events, self.clock, self.current = [], clock, None
        self.wait_status, self.scope_failure = 'EXITED', False
        self.pid, self.buffer, self.sample, self.proc = 200, bytearray(), None, None
        self.authority = types.SimpleNamespace(
            approve_offline_fixtures=lambda config: self.authority,
            receiver_count=lambda operation: 987, # must never be trusted by v1
            helper_pin=lambda name: c.ProgramPin('/opt/acceptance/tests/fixtures/' + p.HELPER_SAMPLES[name], 'f'*64),
            audit_abi_termination=lambda *args: self.authority,
            unsynchronized_thread=lambda port: None, memory=lambda value: value,
            foreign_uid_process_in_role_ns=lambda role: self.FOREIGN[role],
            trusted_unix_names=lambda: ('\0acceptance-trusted', '/run/acceptance/controller/trusted.sock'),
            scm_rights_donor=lambda role: '/run/acceptance/' + role.lower() + '/donor',
            confirm_reachable=lambda name: True,
            correlate_inventory=lambda role, digest: self.authority)
        self.elapsed = 0
        def mono(): self.elapsed += .001; return self.elapsed
        def write(fd, data):
            if fd == 4 and data != b'WAITING\n': self.buffer.extend(data)
            return len(data)
        def rmdir(path):
            self.events.append(('scope', path))
            if self.scope_failure: raise OSError('inert occupied scope')
        def syscall(nr, *args):
            self.events.append(('syscall', nr, args))
            if self.current.role == 'PROXY' and nr in (198, 203, 64):
                return 19 if nr == 198 else args[-1] if nr == 64 else 0
            if nr == 97: return 0                      # P49: unshare(CLONE_NEWUSER) in a fresh family
            if nr == 198 and args[0] == 1: return 21   # AF_UNIX sockets are allowed (E1); connects are refused
            if nr == 212: raise OSError(88, 'inert ENOTSOCK')  # recvmsg on the FD3 pipe
            raise PermissionError(1, 'inert kernel denial')
        def end(code): raise Exit(code)
        foreign = {'/proc/%d' % pid: c.UIDS[role] for role, pid in self.FOREIGN.items()}
        def stat(path):
            if path in foreign: return types.SimpleNamespace(st_uid=foreign[path])
            if self.proc is not None: return self.proc.stat(path)
            raise FileNotFoundError(2, path)
        def open_(path, *args):
            if path.startswith(('/proc/7/fd/', '/proc/8/fd/')): raise PermissionError(13, 'inert foreign descriptor')
            raise FileNotFoundError(2, 'inert absent node')
        def listdir(path):
            if path == '/proc': return ['1', 'self', 'thread-self']
            if self.proc is not None and path.startswith(self.proc.base): return self.proc.listdir(path)
            return ['0','1','2','3','4']
        def readlink(path):
            if self.proc is not None and path.startswith((self.proc.base, '/proc/self/ns/')): return self.proc.readlink(path)
            return '/dev/null'
        cmdline = b''.join(arg.encode() + b'\0' for arg in self.BOOTSTRAP_ARGV)
        def read_file(path, limit=65536):
            return cmdline if path == '/proc/self/cmdline' else self.proc.read_file(path, limit)
        def pin_sample(path, digest):
            self.sample = path; return 39
        def exitcode(status):
            if self.sample is not None and self.sample.endswith(('/aarch32-syscall', '/alternate-entry')): return -self.SIGSYS
            return status >> 8
        self.b = types.SimpleNamespace(monotonic=mono, sleep=lambda duration: None,
            syscall=syscall, select=lambda *args: ([31], [], []),
            pin_sample=pin_sample, signal=types.SimpleNamespace(SIGKILL=9),
            read_file=read_file, run_device=confinement_fixture.LiteralProc.RUN_DEV,
            crash_device=confinement_fixture.LiteralProc.CRASH_DEV,
            os=types.SimpleNamespace(path=types.SimpleNamespace(lexists=lambda path: False),
                write=write, read=lambda fd, size: b'EXIT' if fd == 3 else b'ATTEMPTED\n'[:size],
                close=lambda fd: None, unlink=lambda path: None, rmdir=rmdir,
                listdir=listdir, readlink=readlink, stat=stat, getpid=lambda: 1,
                open=open_,
                fork=lambda: 901, pipe2=lambda flags: (31,32), WNOHANG=1,
                waitpid=lambda pid, flags: (pid,23<<8), waitstatus_to_exitcode=exitcode,
                kill=lambda pid, sig: self.events.append(('kill',pid)), _exit=end))
        kernel = c.OfflineKernelPort(self.b)
        def spawn(launch, entry):
            self.pid += 1; self.current = launch; self.sample = None
            owned = c.NativeOwned(self.pid, binding.runId, launch.role, object(), object())
            self.events.append(('spawn', owned))
            # The waiting family as the parent observes it (T8-03): literal /proc of this pid; a probe family never
            # execs, so its cmdline is the bootstrap's own.
            self.proc = confinement_fixture.LiteralProc(launch.role)
            self.proc.pid, self.proc.base = self.pid, '/proc/%d' % self.pid
            self.proc.cmdline = list(self.BOOTSTRAP_ARGV)
            kernel._owned[owned] = {'child': self.pid, 'terminal': None, 'launch': launch, 'digest': self.proc.digest,
                                    'links': ('pipe:[30]', 'pipe:[40]')}
            facts = dict(pid=self.pid, run_id=binding.runId, role=launch.role,
                uids=(launch.uid,)*3, gids=(launch.uid,)*3, groups=(), capabilities=(0,)*5,
                no_new_privs=1, seccomp=2, filter_digest=hashlib.sha256(b''.join(
                    struct.pack('<HBBI', *row) for row in launch.filter)).hexdigest(),
                fds=launch.fds, views=launch.views, waiting=False, programs=launch.programs,
                seccomp_filters=1, tty_nr=0)
            port = types.SimpleNamespace(b=self.b, launch=launch, pins={}, ready_fd=30, digest='d'*64,
                establish_views=lambda value: None, close_unaudited_fds=lambda value: None,
                drop_credentials=lambda *args: None, clear_capabilities=lambda: None,
                no_new_privs=lambda: None, install_seccomp=lambda *args: 0,
                inspect=lambda: facts, scope_digest=lambda: bytes(32))  # Task 14 (P17): the ready frame's 32 bytes
            try: entry(port)
            except Exit: pass
            return owned
        def read_exact(endpoint, size, deadline):
            value = bytes(self.buffer[:size]); del self.buffer[:size]
            if len(value) != size: raise ValueError('inert result absent')
            return value
        def receipt(owned, timeout, kind):
            self.events.append((kind, owned, timeout))
            return dict(status=self.wait_status if kind == 'wait' else 'STOPPED', pid=owned.pid, run_id=owned.run_id)
        kernel.spawn_waiting, kernel._read_exact = spawn, read_exact
        kernel.wait_owned = lambda owner, duration: receipt(owner, duration, 'wait')
        kernel.stop_owned = lambda owner, duration: receipt(owner, duration, 'stop')
        config = c.BootstrapConfig(kernel, binding.runId, tuple(c.ProgramPin(path, 'a'*64) for path in sorted(c.PROGRAM_PATHS)))
        self.fixtures = p.OfflineProbeFixtures(c, kernel, config, self.authority)
        self.fixtures.receivers = receivers
        self.fixtures.clock = clock


class BootstrapProbeCompositionTests(unittest.TestCase):
    def test_t5_r1_helper_setup_errno_cannot_prove_an_attempt(self):
        # Reviewer witnesses, extended across setup/transport/wait boundaries.
        # The real qualifier, child callback and helper execute over inert OS.
        for fault in ('pin-eperm','pin-eacces','pipe','target-write','fork','marker-read','wait','audit'):
            with self.subTest(fault=fault):
                setup=self.setup_epoch(); family=setup[4]; hits=[]
                def denied(*args): hits.append(fault); raise PermissionError(13 if fault=='pin-eacces' else 1,'inert setup failure')
                if fault.startswith('pin-'):
                    original=family.b.pin_sample
                    family.b.pin_sample=lambda path,digest: denied() if path.endswith('/exec-ipv4') else original(path,digest)
                elif fault=='pipe': family.b.os.pipe2=denied
                elif fault=='target-write':
                    original=family.b.os.write
                    family.b.os.write=lambda fd,data: denied() if fd==32 else original(fd,data)
                elif fault=='fork': family.b.os.fork=denied
                elif fault=='marker-read':
                    original=family.b.os.read
                    family.b.os.read=lambda fd,size: denied() if fd==31 else original(fd,size)
                elif fault=='wait': family.b.os.waitpid=denied
                else:
                    original=family.authority.helper_pin; helper=[None]
                    def pin(name): helper[0]=name; return original(name)
                    family.authority.helper_pin=pin
                    # T8-02: only a SIGSYS death reaches the termination audit, which then refuses.
                    family.b.os.waitstatus_to_exitcode=lambda status: -31 if helper[0]=='AArch32-audit' else 23
                    family.authority.audit_abi_termination=denied
                try: p.qualify_probe_epoch(setup[0],family.fixtures,setup[3])
                except (p.ProbeFailure,p.RuntimeGateUnavailable): pass
                else: self.fail('helper '+fault+' was sealed as an attempted denial')
                self.assertTrue(hits)
                self.assertIs(family.fixtures.cleanup_budget,setup[3])
                for owner in family.fixtures.family_owners:
                    self.assertTrue(any(row[:2]==('stop',owner.owned) for row in family.events))
                self.assertLess(len(family.fixtures.family_owners),94)

    def test_t5_r2_epoch_is_a_positive_safe_integer_on_the_wire(self):
        for epoch in (1,2,9007199254740991):
            with self.subTest(epoch=epoch):
                try: binding=c.CompositionBinding(1,'a'*32,'b'*64,'c'*64,'d'*64,epoch,100000)
                except c.ConfinementError as error: self.fail('approved integer epoch rejected: '+str(error))
                self.assertIs(type(binding.epoch),int)
                self.assertEqual(c.CompositionBinding.from_record(binding.to_record()),binding)
                self.assertEqual(json.loads(json.dumps(binding.to_record()))['epoch'],epoch)
        for epoch in (True,False,0,-1,1.0,'1','e'*32,9007199254740992,None):
            with self.subTest(invalid=epoch), self.assertRaises(c.ConfinementError):
                c.CompositionBinding(1,'a'*32,'b'*64,'c'*64,'d'*64,epoch,100000)

    def test_t5_r1_fork_network_cleanup_errno_is_not_operation_denial(self):
        setup=self.setup_epoch(); b=setup[4].b
        operation='BROWSER.fork.socket-IPV4-TCP'
        receiver=next(row for row in setup[4].fixtures.receivers._inventory if row.operationId==operation)
        b.os.fork=lambda: 0
        b.os.dup2=lambda *args: None
        b.os.set_inheritable=lambda *args: None
        b.os.close=lambda fd: (_ for _ in ()).throw(PermissionError(1,'inert close failure')) if fd==19 else None
        b.syscall=lambda nr,*args: 19 if nr==198 else len(args[1]) if nr==64 else 0
        context=p.NativeProbeContext(types.SimpleNamespace(b=b),setup[4].authority,operation,c)
        context.receiver_binding,context.nonce=receiver,'1'*32
        with self.assertRaises(Exit) as caught: context.helper('fork.socket-IPV4-TCP')
        self.assertEqual(caught.exception.args,(78,),'cleanup errno was encoded as proved denial exit23')

    def test_t5_r3_all_framed_child_results_reject_duplicate_and_unknown_fields(self):
        operations=tuple(op for case in p.PROBES.values() for op in case.operations)
        self.assertEqual(len(operations),94)
        for target in range(94):
            for prefix in (b'{"operation":"UNTRUSTED_DUPLICATE",',b'{"attempted":false,',b'{"unknown":0,'):
                with self.subTest(operation=operations[target],prefix=prefix):
                    setup=self.setup_epoch(); family=setup[4]
                    original=family.fixtures.kernel._read_exact; pending=[]; position=[0]; altered=[]
                    def read(endpoint,count,deadline):
                        if pending:
                            value=pending.pop(); self.assertEqual(count,len(value)); return value
                        header=original(endpoint,count,deadline); self.assertEqual(count,4)
                        value=original(endpoint,struct.unpack('<I',header)[0],deadline)
                        if position[0]==target:
                            value=prefix+value[1:]; altered.append(True)
                        position[0]+=1; pending.append(value)
                        return struct.pack('<I',len(value))
                    family.fixtures.kernel._read_exact=read
                    with self.assertRaises(p.ProbeFailure): p.qualify_probe_epoch(setup[0],family.fixtures,setup[3])
                    self.assertEqual(altered,[True])
                    self.assertEqual(len(family.fixtures.family_owners),target+1)
                    self.assertEqual(len(setup[1].requests),2*target+1,
                        'malformed result reached receiver AFTER interpretation')

    def test_t5_r4_receiver_before_expiry_has_zero_family_effects(self):
        for kind in ('wall','budget','monotonic'):
            with self.subTest(kind=kind):
                setup=self.setup_epoch(); binding,channel,clock,budget,family=setup
                # A terminal event elsewhere started the one shared end (E7).
                if kind=='budget': budget.start_terminal()
                original_end=budget.deadline
                def expire(row):
                    if row['phase']=='BEFORE':
                        if kind=='wall': clock.wall=binding.expiresAtMs
                        elif kind=='budget': clock.mono+=60001
                        else: clock.mono+=binding.expiresAtMs
                    return row
                channel.mutate=expire
                with self.assertRaises(p.ProbeFailure): p.qualify_probe_epoch(binding,family.fixtures,budget)
                self.assertFalse(any(row[0]=='spawn' for row in family.events),'expired BEFORE observation acquired a family')
                self.assertEqual(family.fixtures.family_owners,[])
                self.assertIs(family.fixtures.cleanup_budget,budget)
                self.assertEqual(budget.deadline,original_end)
                with self.assertRaises(p.ProbeFailure): p.qualify_probe_epoch(binding,family.fixtures,budget)

    def test_t5_r3_result_bytes_reject_invalid_encoding_and_primitives(self):
        valid=b'{"operation":"BROWSER.socket-AF_VSOCK","attempted":true,"denied":true,"receiver_count":0}'
        invalid=(b'\xff'+valid,valid.decode('ascii').encode('utf-16'),b'[]',
                 valid.replace(b'"attempted":true',b'"attempted":1'),
                 valid.replace(b'"denied":true',b'"denied":1'),
                 *(valid.replace(b'"receiver_count":0',b'"receiver_count":'+value)
                   for value in (b'true',b'0.0',b'NaN',b'Infinity',b'9007199254740992')))
        for raw in invalid:
            with self.subTest(raw=raw):
                setup=self.setup_epoch(); original=setup[4].fixtures.kernel._read_exact; pending=[]
                def read(endpoint,count,deadline):
                    if pending: return pending.pop()
                    header=original(endpoint,count,deadline)
                    original(endpoint,struct.unpack('<I',header)[0],deadline)
                    pending.append(raw); return struct.pack('<I',len(raw))
                setup[4].fixtures.kernel._read_exact=read
                with self.assertRaises(p.ProbeFailure): p.qualify_probe_epoch(setup[0],setup[4].fixtures,setup[3])
                self.assertEqual(len(setup[1].requests),1)

    def test_t5_r3_legacy_task10_shape_stays_legacy_only(self):
        # T10-4 (Task 4, P9): the legacy Task10 attempt shape is deleted; the
        # probe epoch is the only probe source.
        self.assertFalse(hasattr(t,'Task10NativeAttempts'))
        # A v1 result with a missing operation must still be rejected.
        setup=self.setup_epoch(); original=setup[4].fixtures.kernel._read_exact; pending=[]
        def read(endpoint,count,deadline):
            if pending: return pending.pop()
            header=original(endpoint,count,deadline)
            row=json.loads(original(endpoint,struct.unpack('<I',header)[0],deadline)); row.pop('operation')
            data=json.dumps(row).encode('ascii'); pending.append(data)
            return struct.pack('<I',len(data))
        setup[4].fixtures.kernel._read_exact=read
        with self.assertRaises(p.ProbeFailure): p.qualify_probe_epoch(setup[0],setup[4].fixtures,setup[3])
        self.assertEqual(len(setup[1].requests),1)

    def setup_epoch(self):
        self.assertTrue(callable(getattr(p, 'qualify_probe_epoch', None)), 'epoch qualification must reject incomplete families and bind independent receivers')
        binding = c.CompositionBinding(1, 'a'*32, 'b'*64, 'c'*64, 'd'*64, 1, 100000)
        channel, clock = Channel(), Clock()
        inventory = []
        for name, case in p.PROBES.items():
            for operation in case.operations:
                family, transport, port = p.receiver_shape(operation)
                endpoint = '127.0.0.2' if family == 'IPV4' else '::2' if family == 'IPV6' else '2'
                inventory.append(p.ReceiverBinding(binding, name, operation, family, transport, port, endpoint, 'f'*64))
        receivers = p.ReceiverAuthority(tuple(inventory), channel)
        budget = t.CleanupBudget(clock)
        family = InertFamily(binding, receivers, clock, budget)
        return binding, channel, clock, budget, family

    def complete(self, setup):
        binding, channel, clock, budget, family = setup
        try: result = p.qualify_probe_epoch(binding, family.fixtures, budget)
        except Exception as error: self.fail('complete original families must qualify offline: ' + str(error))
        self.assertIs(type(result), p.CompletedProbeEpoch)
        return result

    def test_offline_epoch_is_never_native(self):
        # compA part A note (T8-05): an epoch minted from offline fixtures carries its provenance; it is never
        # type-identical to a native one and never says native.
        self.assertTrue(hasattr(p, 'OfflineProbeFixtures'), 'no distinct offline probe fixtures (compA part A)')
        setup = self.setup_epoch()
        self.assertIs(type(setup[4].fixtures), p.OfflineProbeFixtures)
        self.assertIs(type(setup[4].fixtures.kernel), c.OfflineKernelPort)
        epoch = self.complete(setup)
        self.assertIs(epoch.native, False)
        self.assertIs(epoch.require_current(setup[0], epoch.fixture_inventory_digest, 0), epoch)
        # Only the completed sequence mints an epoch, and its provenance is a bool, never a truthy stand-in.
        values = (epoch.binding, epoch.cases, epoch.task10_projection, epoch.fixture_inventory_digest, epoch.digest,
                  epoch.family_proofs)
        for native in (1, 'false', None):
            with self.subTest(native=native), self.assertRaisesRegex(p.ProbeFailure, '^PROBE_EPOCH_DENIED$'):
                p.CompletedProbeEpoch(*values, native, _seal=p._EPOCH_SEAL)
        with self.assertRaisesRegex(p.ProbeFailure, '^PROBE_EPOCH_DENIED$'):
            p.CompletedProbeEpoch(*values, False)

    def test_native_fixtures_reject_substituted_confinement_module(self):
        # Task 9 review I-1: native fixtures and a native epoch are anchored to the probe module's own confinement
        # module (_confinement(), topology's instance) and its sealed port, never to a module the caller passes.
        anchor = p._confinement()
        self.assertIs(anchor, c)
        def substitute():
            # The reviewer's construction: a stand-in namespace whose NativeKernelPort is the offline port.
            fake = types.SimpleNamespace(**vars(c)); fake.NativeKernelPort = c.OfflineKernelPort
            return fake
        forged_port = object.__new__(c.NativeKernelPort)  # the anchored native type, never constructed
        binding, channel, clock, budget, family = self.setup_epoch()
        offline, authority = family.fixtures, family.authority
        authority.approve_native_fixtures = lambda config: authority
        for name, module, kernel in (('reviewer: substituted module, offline port', substitute(), offline.kernel),
                                     ('substituted module, port of the anchored native type', substitute(), forged_port),
                                     ('anchored module, offline port', c, offline.kernel)):
            with self.subTest(construct=name):
                with self.assertRaisesRegex(p.RuntimeGateUnavailable, '^NATIVE_FIXTURES_UNAVAILABLE$'):
                    p.NativeProbeFixtures(module, kernel, offline.config, authority)
        # A NativeProbeFixtures that skipped its constructor (object.__new__) mints no epoch, native or not, unless
        # it holds the anchored module and port: refused before any receiver claim or family effect.
        for name, module, kernel in (('anchored module, offline port', c, None),
                                     ('substituted module, offline port', substitute(), None),
                                     ('substituted module, port of the anchored native type', substitute(), forged_port)):
            binding, channel, clock, budget, family = self.setup_epoch()
            forged = object.__new__(p.NativeProbeFixtures); forged.__dict__.update(vars(family.fixtures))
            forged.c = module
            if kernel is not None: forged.kernel = kernel
            with self.subTest(qualify=name):
                with self.assertRaisesRegex(p.RuntimeGateUnavailable, '^NATIVE_FIXTURES_UNAVAILABLE$'):
                    p.qualify_probe_epoch(binding, forged, budget)
                self.assertFalse(forged._epoch_started)
                self.assertFalse(forged.receivers._claimed)
                self.assertEqual(channel.requests, [])
                self.assertFalse(any(row[0] == 'spawn' for row in family.events))

    def test_forged_native_epoch_rejected(self):
        # Task 9 review I-1: provenance is read only from a verified minted epoch. Neither an epoch built with
        # object.__new__ nor a minted one whose fields were set afterwards is accepted by require_current, and
        # reading `native` from either raises instead of answering.
        binding, channel, clock, budget, family = setup = self.setup_epoch()
        epoch = self.complete(setup)
        fields = ('binding', 'cases', 'task10_projection', 'fixture_inventory_digest', 'digest', 'family_proofs')
        forged = object.__new__(p.CompletedProbeEpoch)
        for key in fields: object.__setattr__(forged, key, getattr(epoch, key))
        object.__setattr__(forged, '_native', True)
        with self.subTest(epoch='object.__new__', read='native'), self.assertRaisesRegex(p.ProbeFailure, '^PROBE_EPOCH_DENIED$'):
            forged.native
        with self.subTest(epoch='object.__new__', read='require_current'):
            with self.assertRaisesRegex(p.ProbeFailure, '^PROBE_EPOCH_DENIED$'):
                forged.require_current(binding, epoch.fixture_inventory_digest, 0)
        for name in ('native', '_native'):
            with self.subTest(assign=name), self.assertRaises(AttributeError):
                setattr(epoch, name, True)
        for key, value in (('_native', True), ('digest', '0' * 64), ('binding', dataclasses.replace(epoch.binding))):
            original = getattr(epoch, key)
            object.__setattr__(epoch, key, value)
            try:
                with self.subTest(field_set=key, read='native'), self.assertRaisesRegex(p.ProbeFailure, '^PROBE_EPOCH_DENIED$'):
                    epoch.native
                with self.subTest(field_set=key, read='require_current'):
                    with self.assertRaisesRegex(p.ProbeFailure, '^PROBE_EPOCH_DENIED$'):
                        epoch.require_current(binding, epoch.fixture_inventory_digest, 0)
            finally:
                object.__setattr__(epoch, key, original)
        # Control: the untouched minted epoch is accepted and says offline.
        self.assertIs(epoch.native, False)
        self.assertIs(epoch.require_current(binding, epoch.fixture_inventory_digest, 0), epoch)

    def test_v1_receiver_endpoint_nonce_epoch_mismatch_denied(self):
        self.complete(self.setup_epoch())
        for key, value in [('nonce', '0'*32), ('sequence', 0), ('phase', 'AFTER')]:
            with self.subTest(key=key):
                setup = self.setup_epoch(); setup[1].mutate = lambda row, k=key, v=value: dict(row, **{k:v})
                with self.assertRaises(p.ProbeFailure): p.qualify_probe_epoch(setup[0], setup[4].fixtures, setup[3])
        for key, value in [('numericEndpoint','127.0.0.3'), ('family','IPV6'), ('transport','UDP'),
                           ('port',80), ('operationId','foreign'), ('probeId','foreign'), ('sampleDigest','0'*64)]:
            setup = self.setup_epoch()
            setup[1].mutate = lambda row, k=key, v=value: dict(row, receiver=dict(row['receiver'], **{k:v}))
            with self.subTest(key=key), self.assertRaises(p.ProbeFailure):
                p.qualify_probe_epoch(setup[0], setup[4].fixtures, setup[3])
        for key, value in [('runId','0'*32), ('epoch',2), ('manifestDigest','0'*64)]:
            setup = self.setup_epoch()
            setup[1].mutate = lambda row, k=key, v=value: dict(row, receiver=dict(row['receiver'], binding=dict(row['receiver']['binding'], **{k:v})))
            with self.subTest(key=key), self.assertRaises(p.ProbeFailure):
                p.qualify_probe_epoch(setup[0], setup[4].fixtures, setup[3])

    def test_v1_missing_receiver_health_or_terminal_count_denied(self):
        self.complete(self.setup_epoch())
        for change in ('health', 'missing', 'denied-delivery', 'positive-zero', 'positive-two', 'boolean'):
            setup = self.setup_epoch()
            def mutate(row):
                if change == 'health': row['healthy'] = False
                if row['phase'] == 'AFTER':
                    if change == 'missing': row.pop('count')
                    if change == 'denied-delivery': row['count'] = 1
                    if change == 'positive-zero': row['count'] = 0
                    if change == 'positive-two' and row['receiver']['probeId'] == 'proxy_fixed_vsock_positive': row['count'] = 2
                    if change == 'boolean': row['count'] = False
                return row
            setup[1].mutate = mutate
            with self.subTest(change=change), self.assertRaises(p.ProbeFailure):
                p.qualify_probe_epoch(setup[0], setup[4].fixtures, setup[3])

    def test_v1_probe_family_exit_and_empty_scope_precede_completion(self):
        setup = self.setup_epoch(); proof = self.complete(setup)
        events = setup[4].events
        self.assertEqual(len(proof.family_proofs), sum(len(case.operations) for case in p.PROBES.values()))
        for previous, current in zip(proof.family_proofs, proof.family_proofs[1:]):
            self.assertLess(events.index(('scope', previous.scopes[-1])), events.index(('spawn', current.owned)))
        self.assertEqual(len(proof.task10_projection), 12)
        self.assertEqual(proof.binding, setup[0])
        with self.assertRaises(p.ProbeFailure): p.qualify_probe_epoch(setup[0], setup[4].fixtures, setup[3])
        for fault in ('wait', 'scope'):
            setup = self.setup_epoch()
            if fault == 'wait': setup[4].wait_status = 'TIMEOUT'
            else: setup[4].scope_failure = True
            with self.subTest(fault=fault), self.assertRaises(p.ProbeFailure):
                p.qualify_probe_epoch(setup[0], setup[4].fixtures, setup[3])
            self.assertEqual(sum(event[0]=='spawn' for event in setup[4].events), 1)

    def test_v1_probe_cleanup_uses_original_budget(self):
        setup = self.setup_epoch(); self.complete(setup)
        for owner in setup[4].fixtures.family_owners:
            self.assertIs(owner.cleanup_budget, setup[3])
            self.assertTrue(owner.proven)
        setup = self.setup_epoch(); setup[4].scope_failure = True
        with self.assertRaises(p.ProbeCleanupFailure) as caught:
            p.qualify_probe_epoch(setup[0], setup[4].fixtures, setup[3])
        self.assertIs(caught.exception.cleanup, setup[4].fixtures.family_owners[0])
        self.assertIs(caught.exception.cleanup.cleanup_budget, setup[3])

    def test_v1_binding_strict_immutable_and_epoch_sealed(self):
        setup = self.setup_epoch(); proof = self.complete(setup)
        for key, value in [('version',True), ('expiresAtMs',True), ('epoch','bad'), ('runId','A'*32)]:
            with self.subTest(key=key), self.assertRaises(c.ConfinementError):
                c.CompositionBinding.from_record(dict(setup[0].to_record(), **{key:value}))
        with self.assertRaises(c.ConfinementError): c.CompositionBinding.from_record(dict(setup[0].to_record(), extra=1))
        with self.assertRaises((AttributeError, TypeError)): proof.binding = setup[0]
        with self.assertRaises(p.ProbeFailure): p.CompletedProbeEpoch()
        self.assertIs(proof.require_current(setup[0], proof.fixture_inventory_digest, 1001), proof)
        with self.assertRaises(p.ProbeFailure): proof.require_current(setup[0], '0'*64, 1001)
        with self.assertRaises(p.ProbeFailure): proof.require_current(setup[0], proof.fixture_inventory_digest, 100000)
        changed=c.CompositionBinding.from_record(dict(setup[0].to_record(),epoch=2))
        with self.assertRaises(p.ProbeFailure): proof.require_current(changed,proof.fixture_inventory_digest,1001)
        self.assertFalse(hasattr(p.CompletedProbeEpoch,'_make'),'tuple factories must not bypass the epoch seal')

    def test_v1_fixed_targets_and_descendant_fork_attempt_the_bound_family(self):
        setup=self.setup_epoch()
        for family,address in (('IPV4','020001bb7f0000020000000000000000'),
                               ('IPV6','0a0001bb000000000000000000000000000000000000000200000000')):
            operation='BROWSER.fork.socket-'+family+'-TCP'
            receiver=next(row for row in setup[4].fixtures.receivers._inventory if row.operationId==operation)
            effects=[]; b=setup[4].b
            b.os.fork=lambda: 0
            b.os.dup2=lambda source,target: effects.append(('dup',source,target))
            b.os.set_inheritable=lambda *args: None
            b.os.write=lambda fd,data: effects.append(('write',fd,data)) or len(data)
            def syscall(nr,*args):
                effects.append((nr,args))
                if nr==198: return 19
                if nr==203: raise PermissionError(1,'inert connect denial')
                raise AssertionError('unexpected syscall')
            b.syscall=syscall
            ctx=p.NativeProbeContext(types.SimpleNamespace(b=b),setup[4].authority,operation,c)
            ctx.receiver_binding,ctx.nonce=receiver,'1'*32
            with self.assertRaises(Exit): ctx.helper(operation.partition('.')[2])
            self.assertIn(('write',4,b'ATTEMPTED\n'),effects)
            self.assertIn((198,(2 if family=='IPV4' else 10,1,0)),effects)
            self.assertIn((203,(19,bytes.fromhex(address),16 if family=='IPV4' else 28)),effects)

    def test_v1_receiver_inventory_revalidates_tuple_factory_bypass(self):
        setup=self.setup_epoch(); inventory=list(setup[4].fixtures.receivers._inventory)
        inventory[0]=inventory[0]._replace(port=True)
        with self.assertRaises(p.ProbeFailure): p.ReceiverAuthority(tuple(inventory),Channel())

    def test_v1_helper_terminal_marker_never_uses_a_blocking_drain(self):
        setup=self.setup_epoch(); b=setup[4].b
        b.select=lambda *args: ([],[],[])
        b.os.read=lambda *args: (_ for _ in ()).throw(AssertionError('unready read could block'))
        context=p.NativeProbeContext(types.SimpleNamespace(b=b),setup[4].authority,'BROWSER.exec.socket-AF_VSOCK',c)
        try: context.helper('exec.socket-AF_VSOCK')
        except Exception as error: self.assertIsInstance(error,p.ProbeFailure)
        else: self.fail('missing attempted marker must deny completion')

    def test_v1_ip_exec_uses_pinned_fd_empty_environment_and_private_target_frame(self):
        for family,suffix in (('IPV4','ipv4'),('IPV6','ipv6')):
            setup=self.setup_epoch(); b=setup[4].b; effects=[]
            operation='BROWSER.exec.socket-'+family+'-TCP'
            receiver=next(row for row in setup[4].fixtures.receivers._inventory if row.operationId==operation)
            pairs=iter(((41,42),(51,52)))
            b.os.pipe2=lambda flags: next(pairs)
            b.os.fork=lambda: 0
            b.os.dup2=lambda source,target: effects.append(('dup',source,target))
            b.os.set_inheritable=lambda *args: None
            b.os.write=lambda fd,data: effects.append(('write',fd,data)) or len(data)
            b.pin_sample=lambda path,digest: effects.append(('pin',path,digest)) or 39
            b.syscall=lambda *args: 0 # fixed close_range only in this exec branch
            def execve(fd,argv,env): effects.append(('exec',fd,argv,env)); raise Exit()
            b.os.execve=execve
            ctx=p.NativeProbeContext(types.SimpleNamespace(b=b),setup[4].authority,operation,c)
            ctx.receiver_binding,ctx.nonce=receiver,'1'*32
            with self.assertRaises(Exit): ctx.helper(operation.partition('.')[2])
            self.assertIn(('pin','/opt/acceptance/tests/fixtures/exec-'+suffix,'f'*64),effects)
            self.assertIn(('exec',39,('/opt/acceptance/tests/fixtures/exec-'+suffix,),{}),effects)
            self.assertIn(('dup',41,3),effects)
            self.assertIn(('dup',52,4),effects)
            frame=next(row[2] for row in effects if row[:2]==('write',42))
            self.assertEqual(struct.unpack('<I',frame[:4])[0],len(frame)-4)
            self.assertEqual(json.loads(frame[4:]),dict(version=1,operationId=operation,
                addressHex=receiver.address_bytes().hex(),payloadHex=(b'BC1'+bytes.fromhex('1'*32)).hex()))

    def test_v1_missing_pinned_sample_bytes_stays_explicitly_unavailable(self):
        setup=self.setup_epoch()
        setup[4].b.pin_sample=lambda *args: (_ for _ in ()).throw(FileNotFoundError())
        try: p.qualify_probe_epoch(setup[0],setup[4].fixtures,setup[3])
        except Exception as error: self.assertIsInstance(error,p.RuntimeGateUnavailable)
        else: self.fail('absent fixed sample bytes must not qualify')

    def test_v1_receiver_nested_boolean_and_partial_terminal_are_denied(self):
        # Break caught: Python dict equality treats True and 1 as equal.
        for mutation in ('version', 'terminal', 'before-count'):
            setup = self.setup_epoch()
            def alter(row):
                if mutation == 'version': row['receiver']['binding']['version'] = True
                if mutation == 'terminal' and row['phase'] == 'AFTER': row['terminal'] = False
                if mutation == 'before-count' and row['phase'] == 'BEFORE': row['count'] = 1
                return row
            setup[1].mutate = alter
            with self.subTest(mutation=mutation), self.assertRaises(p.ProbeFailure):
                p.qualify_probe_epoch(setup[0], setup[4].fixtures, setup[3])

    def test_v1_missing_fixture_and_foreign_exit_never_complete(self):
        setup = self.setup_epoch(); setup[4].fixtures.receivers = None
        with self.assertRaises(p.RuntimeGateUnavailable): p.qualify_probe_epoch(setup[0],setup[4].fixtures,setup[3])
        self.assertEqual(setup[4].events, [])
        setup = self.setup_epoch()
        setup[4].fixtures.kernel.wait_owned = lambda owner, duration: dict(status='EXITED',pid=999,run_id=owner.run_id)
        with self.assertRaises(p.ProbeCleanupFailure): p.qualify_probe_epoch(setup[0],setup[4].fixtures,setup[3])
        self.assertEqual(sum(event[0] == 'spawn' for event in setup[4].events),1)
        setup = self.setup_epoch(); setup[4].authority.helper_pin = lambda name: None
        try: p.qualify_probe_epoch(setup[0],setup[4].fixtures,setup[3])
        except Exception as error: self.assertIsInstance(error,p.RuntimeGateUnavailable)
        else: self.fail('missing separately supplied helper pins must remain unavailable')

    def test_v1_receiver_after_count_follows_original_family_scope_cleanup(self):
        setup = self.setup_epoch(); seen=[]
        def observe(row):
            if row['phase'] == 'AFTER':
                owner=setup[4].fixtures.family_owners[-1]
                seen.append(owner.proven and setup[4].events[-1] == ('scope',owner.scopes[-1]))
            return row
        setup[1].mutate=observe
        proof=self.complete(setup)
        self.assertEqual(seen,[True]*len(proof.family_proofs))

    def test_v1_expired_shared_budget_keeps_original_owner_and_no_retry(self):
        setup=self.setup_epoch(); original=setup[4].fixtures.kernel.stop_owned; calls=[]
        def stop(owner,duration):
            # A terminal event starts the one shared end; it then expires.
            calls.append((owner,duration)); setup[3].start_terminal(); setup[2].mono+=60001
            return original(owner,duration)
        setup[4].fixtures.kernel.stop_owned=stop
        with self.assertRaises(p.ProbeCleanupFailure) as caught:
            p.qualify_probe_epoch(setup[0],setup[4].fixtures,setup[3])
        owner=caught.exception.cleanup
        self.assertIs(owner,setup[4].fixtures.family_owners[0])
        self.assertIs(calls[0][0],owner.owned)
        self.assertEqual(setup[3].remaining(),0)
        with self.assertRaises(p.ProbeCleanupFailure): owner.stop_owned(60000)
        self.assertEqual(len(calls),1)

    def test_v1_routine_family_stop_step_is_fixed_and_never_starts_shared_end(self):
        self.assertEqual((t.PROBE_FAMILY_STOP_MS,p.PROBE_FAMILY_STOP_MS),(2000,2000))
        clock=Clock(); budget=t.CleanupBudget(clock,real_clock=lambda: 5000); seen=[]
        self.assertEqual(budget.routine_call(lambda allowance: seen.append(allowance) or 'done'),'done')
        self.assertEqual(seen,[2000])
        self.assertIs(budget.started,False); self.assertIsNone(budget.deadline)
        with self.assertRaisesRegex(t.TopologyError,'^CLEANUP_NOT_STARTED$'): budget.remaining()
        with self.assertRaisesRegex(t.TopologyError,'^CLEANUP_NOT_STARTED$'): budget.call(seen.append)
        self.assertEqual(seen,[2000])
        budget.start_terminal(); clock.mono+=59000
        budget.routine_call(seen.append)
        self.assertEqual(seen,[2000,1000])

    def test_v1_expired_terminal_end_forbids_further_cleanup_calls(self):
        clock=Clock(); budget=t.CleanupBudget(clock,real_clock=lambda: 5000); invoked=[]
        self.assertEqual(budget.start_terminal(),60000)
        clock.mono+=60001
        with self.assertRaisesRegex(t.TopologyError,'^CLEANUP_UNCERTAIN$'): budget.call(invoked.append)
        self.assertEqual(invoked,[])


class LiveProxyChannel:
    """The original PROXY FD3/FD4 pipe pair between the bootstrap and its stand-in child.

    Bootstrap writes (the port's write_proxy_frame) reach the child's FD3; the
    child's FD4 bytes are read back by the bootstrap's real read_proxy_frame through
    its kernel bindings. The child's own 'WAITING\\n' is consumed as spawn does.
    """
    def __init__(self):
        self.ready=threading.Condition()
        self.command,self.result=bytearray(),bytearray()
        self.command_eof=self.result_eof=False
        self.waiting=bytearray();self.writes=[]
    def write_command(self,data):
        with self.ready:
            self.command.extend(data);self.writes.append(bytes(data));self.ready.notify_all()
        return len(data)
    def close_command(self):
        with self.ready:self.command_eof=True;self.ready.notify_all()
    def result_ready(self,timeout):
        with self.ready:
            self.ready.wait_for(lambda:self.result or self.result_eof,timeout)
            return bool(self.result) or self.result_eof
    def read_result(self,size):
        with self.ready:
            part=bytes(self.result[:size]);del self.result[:size];return part
    # The stand-in child's side.
    def command_ready(self):
        with self.ready:return bool(self.command) or self.command_eof
    def read_command(self,size):
        with self.ready:
            self.ready.wait_for(lambda:self.command or self.command_eof,5)
            part=bytes(self.command[:size]);del self.command[:size];return part
    def write_result(self,data):
        with self.ready:
            if len(self.waiting)<8:
                take=8-len(self.waiting);self.waiting.extend(data[:take]);data=data[take:]
            self.result.extend(data);self.ready.notify_all()
    def close_result(self):
        with self.ready:self.result_eof=True;self.ready.notify_all()
    def idle(self):time.sleep(0.0005)


class LiteralRoleProc:
    """Literal /proc for the four original children: the OfflineKernelPort bindings seam.

    Each child's inherited FD0..4 are per-role literals; the PROXY child's table is
    its stand-in's own inert descriptor table (fd -> [device, inode, flags], plus each
    selector's registered tfd: targets), served at the stand-in's distinct attested
    PID. The bootstrap's own descriptor table (fstat) holds unrelated identities.
    """
    def __init__(self,harness):
        self.h,self.children,self.run_device,self.crash_device=harness,{},2,4
        self.os=types.SimpleNamespace(listdir=self.listdir,readlink=self.readlink,stat=self.stat,
            fstat=lambda fd:types.SimpleNamespace(st_dev=9,st_ino=90000+fd),
            read=self.read,write=self.write)
        self.monotonic=time.monotonic
    def child(self,path):
        parts=path.split('/')
        if len(parts)<3 or parts[1]!='proc' or not parts[2].isdigit() or int(parts[2]) not in self.children:
            return None,None,None
        role,launch=self.children[int(parts[2])]
        return role,launch,'/'+'/'.join(parts[3:])
    def table(self,role,index):
        """{fd:(device,inode,flags,targets,link)} for one child, read at call time."""
        if role=='PROXY':
            stand_in=self.h.proxy_harness
            live=dict(stand_in.live) if stand_in is not None else {fd:[1,fd+100,int(fd==4)] for fd in range(5)}
            selectors={selector.fd for selector in (stand_in.selectors if stand_in else ())}
            targets=dict(stand_in.targets) if stand_in is not None else {}
            return {fd:(dev,inode,flags,tuple(sorted(targets.get(fd,()))),
                        '/dev/null' if fd<3 else 'pipe:[%d]'%inode if fd<5 else
                        'anon_inode:[eventpoll]' if fd in selectors else 'socket:[%d]'%inode)
                    for fd,(dev,inode,flags) in live.items()}
        return {fd:(2,1000+index*10+fd,int(fd==4),(),'/dev/null' if fd<3 else 'pipe:[%d]'%(1000+index*10+fd))
                for fd in range(5)}
    def facts(self,path):
        role,launch,rest=self.child(path)
        fd=int(rest.rsplit('/',1)[1])
        table=self.table(role,list(c.UIDS).index(role))
        if fd not in table:raise FileNotFoundError(path)
        return table[fd]
    def read_file(self,path,limit=65536):
        role,launch,rest=self.child(path)
        if role is None:raise FileNotFoundError(path)
        uid=launch.uid
        if rest=='/status':
            return ('Uid:\t%d %d %d %d\nGid:\t%d %d %d %d\nGroups:\nCapEff:\t0\nCapPrm:\t0\nCapInh:\t0\n'
                    'CapAmb:\t0\nCapBnd:\t0\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t1\n'%((uid,)*8)).encode()
        if rest=='/stat':
            pid=path.split('/')[2]
            return ('%s (node) S 1 %s %s 0 -1 4194560\n'%(pid,pid,pid)).encode()
        if rest=='/cmdline':return b'\0'.join(arg.encode() for arg in launch.argv)+b'\0'
        if rest=='/mountinfo':
            # The Task 8b view (P47) with Task 14's role tmpfs (0:3) and crash bind (0:4, P50): self-bound root,
            # read-only base, role state, /dev/shm, /run/acceptance/crash, /dev/null and /proc.
            mounts='1 0 0:2 /acceptance/'+role.lower()+'/.root / rw - tmpfs base rw\n'
            mounts+=''.join('1 0 0:1 / /'+d+' ro - ext4 base ro\n' for d in ('opt','usr','lib','lib64','etc'))
            mounts+=''.join('1 0 0:2 / /'+d+' rw - tmpfs base rw\n' for d in
                            ('tmp','var','run/acceptance/'+role.lower()))
            mounts+='1 0 0:3 / /dev/shm rw,nosuid,nodev,noexec - tmpfs shm rw,size=65536k,mode=700,uid=%d,gid=%d\n'%(uid,uid)
            mounts+='1 0 0:4 /'+role.lower()+' /run/acceptance/crash rw,nosuid,nodev,noexec - tmpfs crash rw,size=1024k\n'
            return (mounts+'1 0 0:5 /null /dev/null rw - devtmpfs udev rw\n1 0 0:30 / /proc rw - proc proc rw\n').encode()
        if rest.startswith('/fdinfo/'):
            dev,inode,flags,targets,link=self.facts(path)
            text='pos:\t0\nflags:\t0%o\nmnt_id:\t15\nino:\t%d\n'%(flags,inode)
            for target in targets:
                text+='tfd: %8d events: %8x data: %16x  pos:0 ino:%x sdev:%x\n'%(target,4,target,1,1)
            return text.encode()
        raise FileNotFoundError(path)
    def listdir(self,path):
        role,launch,rest=self.child(path)
        if rest=='/fd':return [str(fd) for fd in sorted(self.table(role,list(c.UIDS).index(role)))]
        if rest=='/root/dev':return ['null','shm']
        if rest=='/root/run/acceptance':return [role.lower(),'crash']
        raise FileNotFoundError(path)
    def readlink(self,path):
        if path.startswith('/proc/self/ns/'):
            return {'pid':'pid:[1]','mnt':'mnt:[1]','user':'user:[1]'}[path.rsplit('/',1)[1]]
        role,launch,rest=self.child(path)
        if rest.startswith('/ns/'):return {'pid':'pid:[20]','mnt':'mnt:[20]','user':'user:[1]'}[rest[4:]]
        if rest.startswith('/fd/'):return self.facts(path)[4]
        raise FileNotFoundError(path)
    def stat(self,path):
        role,launch,rest=self.child(path)
        if role is not None and rest.startswith('/fd/'):
            dev,inode,_,_,_=self.facts(path)
            return types.SimpleNamespace(st_dev=dev,st_ino=inode)
        if role is not None and rest=='/exe':return types.SimpleNamespace(st_dev=1,st_ino=999)
        uid=launch.uid if role is not None else 0
        return types.SimpleNamespace(st_dev=1 if path.endswith('/root') or path.endswith('/.root') else
                                     3 if path.endswith('/dev/shm') else 4 if path.endswith('/run/acceptance/crash') else 2,
                                     st_ino=555,st_mode=0o700,st_uid=uid,st_gid=uid)
    # The original PROXY pipe ends: FD3's writer and FD4's reader.
    def select(self,reads,writes,errors,timeout):
        endpoints=self.h.proxy_endpoints
        ready=[r for r in reads if endpoints and r is endpoints[1] and self.h.proxy_channel.result_ready(timeout)]
        return ready,[w for w in writes if endpoints and w is endpoints[0]],[]
    def read(self,fd,size):
        if not self.h.proxy_endpoints or fd is not self.h.proxy_endpoints[1]:raise OSError('inert read')
        return self.h.proxy_channel.read_result(size)
    def write(self,fd,data):
        if not self.h.proxy_endpoints or fd is not self.h.proxy_endpoints[0]:raise OSError('inert write')
        return self.h.proxy_channel.write_command(bytes(data))


class BootstrapOwnedCompositionTests(unittest.TestCase):
    """Task 9 public boundary; full inert integration is built below this API."""

    class Harness:
        def __init__(self, test, *, expires_at=190, real_clock=None):
            # expires_at/real_clock are local test bindings; the exporters keep
            # the default 190 ms binding and the default real clock.
            self.test=test;self.timeline=[];self.clock=Clock()
            self.clock.wall,self.clock.mono=100,10
            self.binding=c.CompositionBinding(
                1,'1'*32,'b'*64,'a'*64,'c'*64,7,expires_at)
            confinement_fixture.c=c;confinement_fixture.RUN=self.binding.runId
            self.role_finite=confinement_fixture.Kernel()
            # E4: the actual (offline) kernel port observes each original child through a
            # literal /proc (its bindings seam); no observation method is replaced.
            self.role_proc=LiteralRoleProc(self)
            self.role_kernel=c.OfflineKernelPort(self.role_proc)
            self.proxy_channel=LiveProxyChannel();self.proxy_endpoints=None
            spawn_waiting=self.role_finite.spawn_waiting
            def spawn_identified(launch,entry):
                fixture=spawn_waiting(launch,entry)
                owned=c.NativeOwned(fixture.pid,fixture.run_id,fixture.role,fixture.command,fixture.result)
                self.role_finite.children[fixture.pid].owned=owned
                self.role_proc.children[owned.pid]=(launch.role,launch)
                index=list(c.UIDS).index(launch.role)
                links=tuple(self.role_proc.table(launch.role,index)[fd][4] for fd in (3,4))
                self.role_kernel._owned[owned]=dict(outer=owned.pid+1000,child=owned.pid,
                    terminal=None,launch=launch,links=links,exec_identity=(1,999),
                    digest=hashlib.sha256(c.filter_bytes(launch.filter)).hexdigest())
                if launch.role=='PROXY':self.proxy_endpoints=(owned.command,owned.result)
                return owned
            self.role_kernel.spawn_waiting=spawn_identified
            def stop_owned(owned,deadline):
                # Stopping the original PROXY child ends its stand-in loop (FD3 EOF).
                # A proven stop is cached in the kernel state, as the port's _exit does.
                if owned.role=='PROXY':self.proxy_channel.close_command()
                receipt=self.role_finite.stop_owned(owned,deadline)
                state=self.role_kernel._owned.get(owned)
                if state is not None and receipt['status'] in ('STOPPED','EXITED'):state['terminal']=dict(receipt)
                return receipt
            self.role_kernel.stop_owned=stop_owned
            self.role_kernel.wait_owned=self.role_finite.wait_owned
            self.role_config=confinement_fixture.ConfinementTests().config(self.role_kernel)
            launches=tuple(c.prepare_role(role,c.RoleConfig(
                self.role_config,c.role_fds(role,self.binding.runId))) for role in c.UIDS)
            self.role_init={};self.role_queue=[];self.worker_sequence=0;self.application_to_worker=[];self.browser_prepare_payload=None
            # Task 11: the worker launches the pinned Chromium after CURRENT and
            # before STARTED; the kernel then delivers that launch's audit
            # records (root clone, child exec). launch=False models a launch
            # whose records never arrive; refresh_fault mis-correlates REFRESH.
            self.launch=True;self.refresh_fault=None;self.worker_actions=[]
            def write_role(owned,data):
                value=json.loads(data[4:])
                if 'kind' in value:self.role_init[owned.role]=value;return
                payload=value['payload'];action=value['action']
                self.worker_actions.append(action)
                if action=='APP_CHUNK':
                    self.application_to_worker.append(payload);return
                self.worker_sequence+=1
                if action=='PREPARE':
                    self.browser_prepare_payload=payload
                    result_action='PREPARED';result_payload=dict(
                        requestSequence=value['sequence'],grantId=payload['grantId'],
                        reservationId='6'*32,generation=1)
                elif action=='COMMIT':
                    result_action='REFRESH';result_payload=dict(
                        requestSequence=value['sequence'],**payload)
                    if self.refresh_fault is not None:
                        result_action,result_payload=self.refresh_fault(result_action,result_payload)
                elif action=='CURRENT':
                    if self.launch:
                        root=self.roles._handoffs['BROWSER'].attestation.pid
                        native=self.event_native
                        # P61: the clone's exit= is the child's number in the
                        # BROWSER PID namespace (2), never its audit pid.
                        native.events+=topology_fixture.audit_group(
                            native,9001,220,pid=root,ppid=1,exit_code=2)
                        native.events+=topology_fixture.exec_group(
                            native,9002,pid=root+100,ppid=root)
                    result_action='STARTED';result_payload={key:payload[key] for key in
                        ('grantId','reservationId','commitId','generation')}
                    result_payload['requestSequence']=value['sequence']
                else:raise AssertionError('unexpected role action')
                response=dict(version=1,binding=self.binding.to_record(),
                    sequence=self.worker_sequence,role='BROWSER',childId=value['childId'],
                    pipeId=value['pipeId'],action=result_action,payload=result_payload)
                unsigned=c._v1_canonical(response)
                response['mac']=__import__('hmac').new(
                    bytes.fromhex(self.role_init['BROWSER']['channelKeyHex']),
                    b'acceptance:bootstrap-composition:v1\0BROWSER:TO_BOOTSTRAP\0'+unsigned,
                    hashlib.sha256).hexdigest()
                self.role_queue.append(c._v1_encode(response))
            self.role_kernel.write_role=write_role
            self.role_kernel.read_role=lambda owned,remaining:self.role_queue.pop(0)
            self.role_kernel.poll_role=lambda owned:bool(self.role_queue)
            # P10/R6: the proxy policy carries only the derived vsock-stream key.
            self.vsock_key=c.derive_channel_key(b'7'*32,'vsock-stream')
            run=t._PROXY.RunBinding(self.binding.runId,self.vsock_key,expires_at,1,
                self.binding.manifestDigest,self.binding.configIdentity,
                (('FRONTEND','https://frontend.example'),('BACKEND','https://backend.example')))
            self.proxy_run=run
            # Long-lived local bindings let the shared clock advance past a minute.
            self.proxy_limits=(1000,10000) if expires_at==190 else (120000,1200000)
            policy=t._PROXY.qualify_native_admission(run,
                {'FRONTEND':'frontend.example','BACKEND':'backend.example'},1024,*self.proxy_limits,
                runtime_identity='e'*64,role_policy_identity=self.binding.rolePolicyDigest,
                handoff_validator=lambda value:value)
            self.expected=t.qualify_topology_authority(run_id=self.binding.runId,
                manifest_identity=self.binding.manifestDigest,config_identity=self.binding.configIdentity,
                expires_at=expires_at,capability=b'7'*32,role_launches=tuple(launches),
                proxy_policy=policy,clock=self.clock,appliance_recheck=lambda:self.timeline.append('recheck'))
            self.roles=None
            self.budget=(t.CleanupBudget(self.clock) if real_clock is None
                         else t.CleanupBudget(self.clock,real_clock=real_clock))
            inventory=[]
            for name,case in p.PROBES.items():
                for operation in case.operations:
                    family,transport,port=p.receiver_shape(operation)
                    endpoint='127.0.0.2' if family=='IPV4' else '::2' if family=='IPV6' else '2'
                    inventory.append(p.ReceiverBinding(self.binding,name,operation,family,
                        transport,port,endpoint,'f'*64))
            self.probe_channel=Channel();receivers=p.ReceiverAuthority(tuple(inventory),self.probe_channel)
            self.probe_family=InertFamily(self.binding,receivers,self.clock,self.budget)
            self.fixture=self.probe_family.fixtures
            # Kernel-format /proc text with the kernel-default IPv6 rows (T10-2).
            content=topology_fixture.kernel_proc()
            class Observation:
                def open_owned(_,path,flags):
                    self.timeline.append(('open',path))
                    class Owner:
                        def __init__(owner):owner.parts=[content[path],b'']
                        def read(owner,n):return owner.parts.pop(0)
                        def close(owner):pass
                        def cleanup(owner):pass
                    return Owner()
            dummy=types.SimpleNamespace(collect=lambda value:(),cleanup_owned=lambda value:None,
                observe=lambda value:t.HOST_DEVICES,execute=lambda value:None)
            self.observations=t.NativeTopologyBindings(Observation(),dummy,dummy,dummy,dummy,t._NATIVE_SEAL)
            self.host=types.SimpleNamespace(observe=lambda expected:t.HOST_DEVICES)
            self.event_native=topology_fixture.EventNative()
            retain=self.event_native.retain_pending
            self.event_native.retain_pending=lambda kind:(self.timeline.append(('event-retain',kind)) or retain(kind))
            self.events=t.qualify_offline_event_native(self.event_native)
            self.proxy_harness=self.proxy_thread=None;self.proxy_errors=[]

        def child_admission(self,vsock_key):
            """The stand-in child's own trusted admission policy, qualified independently."""
            run=t._PROXY.RunBinding(self.binding.runId,vsock_key,self.binding.expiresAtMs,1,
                self.binding.manifestDigest,self.binding.configIdentity,
                (('FRONTEND','https://frontend.example'),('BACKEND','https://backend.example')))
            return t._PROXY.qualify_native_admission(run,
                {'FRONTEND':'frontend.example','BACKEND':'backend.example'},1024,*self.proxy_limits,
                runtime_identity='e'*64,role_policy_identity=self.binding.rolePolicyDigest,
                handoff_validator=lambda *_:True)

        def build(self):
            stack=contextlib.ExitStack()
            qualify=p.qualify_probe_epoch
            def run_probes(*args):
                value=qualify(*args);self.timeline.append('probes');return value
            stack.enter_context(mock.patch.object(p,'qualify_probe_epoch',side_effect=run_probes))
            bind_roles=c.bind_original_roles
            def start_roles(*args):
                self.timeline.append('roles');self.roles=bind_roles(*args)
                self.event_native.audit_role_pids={
                    handoff.attestation.pid:role
                    for role,handoff in self.roles._handoffs.items()}
                return self.roles
            stack.enter_context(mock.patch.object(c,'bind_original_roles',side_effect=start_roles))
            stack.enter_context(mock.patch.object(proxy_fixture,'proxy',t._PROXY))
            stack.enter_context(mock.patch.object(topology_fixture,'topology',t))
            stack.enter_context(mock.patch.object(topology_fixture,'confinement',c))
            self.proxy_entry_args=None
            def proxy_entry(roles,binding,budget,vsock_key):
                # P10: the 4th argument is the key the bootstrap's initializer carries as
                # vsockKey. This trusted embedding only starts the stand-in PROXY child:
                # the actual serve_proxy in another thread, with its own policy, reading
                # the bootstrap's FD3 bytes. It returns no proxy object (E4, R11).
                self.proxy_entry_args=(roles,binding,budget,vsock_key)
                row=roles._map['PROXY']
                child=proxy_fixture.CompositionHarness(self.test,commands=[],channel=self.proxy_channel,
                    clock=self.clock,limits=self.proxy_limits,vsock_key=vsock_key,
                    sink=lambda harness,owner:self.timeline.append('proxy-loop-owner'),
                    child_policy=(binding.to_record(),row['childId'],row['pipeId'],
                                  roles._keys['PROXY'],self.child_admission(vsock_key)))
                def serve():
                    try:child.run()
                    except BaseException as error:self.proxy_errors.append(error)
                    finally:self.proxy_channel.close_result()
                thread=threading.Thread(target=serve,daemon=True)
                self.proxy_harness,self.proxy_thread=child,thread
                thread.start()
                def finish():
                    self.proxy_channel.close_command();thread.join(5)
                    if thread.is_alive():raise AssertionError('stand-in proxy loop did not terminate')
                stack.callback(finish)
                self.timeline.append('proxy')
            composition=t.compose_bootstrap_v1(binding=self.binding,expected=self.expected,
                role_config=self.role_config,fixtures=self.fixture,
                proxy_entry=proxy_entry,
                observations=self.observations,host_devices=self.host,events=self.events,
                cleanup_budget=self.budget)
            return composition,stack

    def test_topology_consumers_never_count_an_offline_port_as_native(self):
        # T8-05 (P11): offline ports and fixtures run the offline composition, and no consumer counts them as native.
        self.assertTrue(hasattr(c, 'OfflineKernelPort'), 'no distinct offline kernel port (T8-05)')
        h = self.Harness(self); composition, stack = h.build()
        self.assertIs(type(h.role_kernel), c.OfflineKernelPort)
        self.assertIs(type(h.fixture), p.OfflineProbeFixtures)
        self.assertIs(composition.native, False)
        with stack:
            composition.begin(TEST_HOST_CHALLENGE)
            self.assertIs(composition._probe_epoch.native, False)
            self.assertIs(type(composition._proxy_authority._kernel), c.OfflineKernelPort)
            self.assertIs(composition._proxy_authority.native, False)
        # Provenance must agree across the chain: native fixtures need the sealed native role kernel, offline
        # fixtures the offline one. Each mismatch is refused when the composition is built, before any effect.
        def compose(harness, **changes):
            values = dict(binding=harness.binding, expected=harness.expected, role_config=harness.role_config,
                          fixtures=harness.fixture, proxy_entry=lambda *args: None, observations=harness.observations,
                          host_devices=harness.host, events=harness.events, cleanup_budget=harness.budget)
            values.update(changes)
            return t.compose_bootstrap_v1(**values)
        class SubPort(c.OfflineKernelPort): pass
        forged = object.__new__(p.NativeProbeFixtures); forged.__dict__.update(vars(self.Harness(self).fixture))
        def swapped(harness):
            harness.fixture.kernel = SubPort(harness.fixture.kernel.b)
            return dict(fixtures=harness.fixture)
        for name, change in (
                ('forged native fixtures over offline ports', lambda harness: dict(fixtures=forged)),
                ('offline fixtures holding a subclassed kernel', swapped),
                ('offline fixtures, finite role kernel',
                 lambda harness: dict(role_config=dataclasses.replace(harness.role_config,
                                                                      kernel=confinement_fixture.Kernel()))),
                ('offline fixtures, subclassed role kernel',
                 lambda harness: dict(role_config=dataclasses.replace(harness.role_config,
                                                                      kernel=SubPort(harness.role_proc))))):
            harness = self.Harness(self)
            with self.subTest(compose=name), self.assertRaisesRegex(t.TopologyError, '^ADAPTER_DENIED$'):
                compose(harness, **change(harness))
        # An epoch claiming native for an offline composition is refused before any role starts.
        h = self.Harness(self); composition, stack = h.build(); original = p.qualify_probe_epoch
        def native_claim(*args):
            epoch = original(*args)
            return p.CompletedProbeEpoch(epoch.binding, epoch.cases, epoch.task10_projection,
                                         epoch.fixture_inventory_digest, epoch.digest, epoch.family_proofs, True,
                                         _seal=p._EPOCH_SEAL)
        with stack:
            stack.enter_context(mock.patch.object(p, 'qualify_probe_epoch', side_effect=native_claim))
            with self.assertRaisesRegex(t.TopologyError, '^PROBE_EPOCH_DENIED$'):
                composition.begin(TEST_HOST_CHALLENGE)
            self.assertNotIn('roles', h.timeline)
            self.assertIsNone(composition._roles)

    def test_v1_foreign_probe_module_is_rejected_before_persistent_effects(self):
        h=self.Harness(self);original,stack=h.build()
        module_name='task9_foreign_probe_adapter';module=types.ModuleType(module_name)
        class ForeignFixtures:pass
        class ForeignEpoch:
            def __init__(self,binding):
                self.binding=binding;self.task10_projection=tuple(
                    (name,True,'ALLOWED' if name=='PROXY_VSOCK_CONTROL' else 'DENIED',
                     int(name=='PROXY_VSOCK_CONTROL')) for name in t.FIXED_PROBE_IDS)
                self.fixture_inventory_digest='f'*64;self.digest='e'*64
                self.family_proofs=()
            def require_current(self,*args):return self
        ForeignFixtures.__module__=ForeignEpoch.__module__=module_name
        module.CompletedProbeEpoch=ForeignEpoch
        module.qualify_probe_epoch=lambda binding,fixtures,budget:ForeignEpoch(binding)
        sys.modules[module_name]=module
        try:
            with stack,self.assertRaises(t.TopologyError):
                composition=t.compose_bootstrap_v1(binding=h.binding,expected=h.expected,
                    role_config=h.role_config,fixtures=ForeignFixtures(),
                    proxy_entry=original._proxy_entry,observations=h.observations,
                    host_devices=h.host,events=h.events,cleanup_budget=h.budget)
                composition.begin(TEST_HOST_CHALLENGE)
            self.assertNotIn('roles',h.timeline);self.assertNotIn('proxy',h.timeline)
            self.assertFalse(h.event_native.opened)
        finally:sys.modules.pop(module_name,None)

    def test_v1_original_browser_commit_consumes_task8_transition_once(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE);preparation=composition.prepare_browser()
            reservation=composition._browser_reservation
            self.assertIs(composition._browser_preparation,preparation)
            self.assertIs(reservation._event_owner,composition._event_owner)
            self.assertEqual(composition.commit_browser(preparation),
                             {'status':'ACTIVE','generation':1})
            self.assertTrue(reservation._used)
            self.assertEqual(composition._state,'BROWSER_COMMITTED')
            proof=composition.require_current()
            runtime=json.loads(proof.handoff)['payload']['composition']['roleRuntime']
            self.assertEqual(runtime[1]['lifecycle'],'BROWSER_ACTIVE')
            # Task 11 (CB-I4): the commit's own current proof consumed the
            # kernel-format launch records (root clone, pinned-Chromium exec);
            # the transition is ACTIVE with the launched child in the family.
            browser_pid=h.roles._handoffs['BROWSER'].attestation.pid
            transition=composition._event_owner._browser_transition
            self.assertEqual(transition['phase'],'ACTIVE')
            self.assertEqual(transition['family'],{browser_pid,browser_pid+100})
            with self.assertRaises(Exception):composition.commit_browser(preparation)
            self.assertTrue(composition._terminal);self.assertEqual(composition._state,'FAILED')
            self.assertEqual(composition._generation,2)
            self.assertIsNone(composition._proof);self.assertIsNone(composition._handoff)

    @staticmethod
    def deliver_launch(h):
        """The kernel's records of the worker's launch: root clone, pinned exec."""
        root=h.roles._handoffs['BROWSER'].attestation.pid;native=h.event_native
        native.events+=topology_fixture.audit_group(native,9001,220,pid=root,ppid=1,exit_code=2)
        native.events+=topology_fixture.exec_group(native,9002,pid=root+100,ppid=root)

    def test_v1_launch_records_after_started_within_bound_succeed(self):
        # P60 with CB-I4(b): STARTED may precede the launch's audit records. The
        # commit stands, no current proof is published while the launch is
        # unobserved, each current check (internal or host) is EVENT_PENDING
        # without failing, and records arriving within the bound make the next
        # current BROWSER_ACTIVE. Barriers keep the 100 ms health cadence.
        h=self.Harness(self);h.launch=False;composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE);preparation=composition.prepare_browser()
            self.assertEqual(composition.commit_browser(preparation),{'status':'ACTIVE','generation':1})
            self.assertEqual(composition._state,'BROWSER_COMMITTED');self.assertFalse(composition._terminal)
            self.assertIsNone(composition._proof);self.assertIsNone(composition._handoff)
            self.assertEqual(composition._event_owner._browser_transition['phase'],'CLONE')
            for check in (composition.require_current,lambda:composition.host_current('1f'*16)):
                h.event_native.mono+=90
                with self.assertRaisesRegex(t.TopologyError,'^EVENT_PENDING$'):check()
                self.assertFalse(composition._terminal);self.assertIsNone(composition._proof)
                self.assertEqual(composition._state,'BROWSER_COMMITTED')
            h.event_native.mono+=90;self.deliver_launch(h)
            proof=composition.require_current()
            runtime=json.loads(proof.handoff)['payload']['composition']['roleRuntime']
            self.assertEqual(runtime[1]['lifecycle'],'BROWSER_ACTIVE')
            self.assertEqual(composition._event_owner._browser_transition['phase'],'ACTIVE')
            self.assertIs(composition._proof,proof)

    def test_v1_launch_records_missing_beyond_bound_terminal(self):
        # P60: the lag is bounded by the brief's 1000 ms pending bound from the
        # transition commit; after it the source and the composition are terminal
        # and late records cannot revive them.
        h=self.Harness(self);h.launch=False;composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE);preparation=composition.prepare_browser()
            self.assertEqual(composition.commit_browser(preparation),{'status':'ACTIVE','generation':1})
            committed=composition._event_owner._browser_transition['committed']
            for mono in range(committed+90,committed+1001,90):
                h.event_native.mono=mono
                with self.subTest(mono=mono),self.assertRaisesRegex(t.TopologyError,'^EVENT_PENDING$'):
                    composition.require_current()
                self.assertFalse(composition._terminal)
            h.event_native.mono=committed+1001
            with self.assertRaisesRegex(t.TopologyError,'^EVENT_SOURCE_TERMINAL$'):
                composition.require_current()
            self.assertTrue(composition._terminal);self.assertEqual(composition._state,'FAILED')
            self.assertEqual(composition._generation,2)
            self.deliver_launch(h)
            with self.assertRaisesRegex(t.TopologyError,'^TOPOLOGY_FAILED$'):composition.require_current()

    def test_v1_refresh_correlation_checked_by_bootstrap(self):
        # compB M-4 K1: the bootstrap correlates the worker's REFRESH with its
        # own COMMIT (requestSequence and every COMMIT field) before it commits
        # the event transition or sends CURRENT; a mismatch launches nothing.
        faults={
            'request-sequence':lambda a,p:(a,dict(p,requestSequence=p['requestSequence']+1)),
            'commit-id':lambda a,p:(a,dict(p,commitId='0'*32)),
            'grant-id':lambda a,p:(a,dict(p,grantId='0'*32)),
            'reservation-id':lambda a,p:(a,dict(p,reservationId='0'*32)),
            'generation':lambda a,p:(a,dict(p,generation=2)),
            'action':lambda a,p:('STARTED',p),
        }
        for fault,change in faults.items():
            h=self.Harness(self);h.refresh_fault=change;composition,stack=h.build()
            with stack,self.subTest(fault=fault):
                composition.begin(TEST_HOST_CHALLENGE);preparation=composition.prepare_browser()
                with self.assertRaises(Exception):composition.commit_browser(preparation)
                self.assertEqual(h.worker_actions.count('COMMIT'),1)
                self.assertNotIn('CURRENT',h.worker_actions)
                self.assertIsNone(composition._event_owner._browser_transition)
                self.assertEqual(h.event_native.events,[])
                self.assertTrue(composition._terminal)
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE);preparation=composition.prepare_browser()
            self.assertEqual(composition.commit_browser(preparation),{'status':'ACTIVE','generation':1})
            self.assertEqual(h.worker_actions[-2:],['COMMIT','CURRENT'])

    def test_v1_composed_handoff_retains_distinct_command_result_identities(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            proof=composition.begin(TEST_HOST_CHALLENGE)
            runtime=json.loads(proof.handoff)['payload']['composition']['roleRuntime']
            self.assertEqual([row['role'] for row in runtime],list(c.UIDS))
            for row in runtime:
                command,result=row['currentFDs'][3:5]
                self.assertNotEqual(
                    (command['device'],command['inode']),
                    (result['device'],result['inode']),row['role'])

    def test_v1_controller_forwarder_owns_prepare_and_commit_state_change(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            admitted=composition.begin(TEST_HOST_CHALLENGE);row=next(value for value in
                h.role_init['CONTROLLER']['roles'] if value['role']=='BROWSER')
            key=bytes.fromhex(h.role_init['CONTROLLER']['channelKeyHex'])
            def request(sequence,action,payload):
                value=dict(version=1,binding=h.binding.to_record(),sequence=sequence,
                    **row,action=action,payload=payload)
                value['mac']=hmac.new(key,
                    b'acceptance:bootstrap-composition:v1\0CONTROLLER:TO_BOOTSTRAP\0'
                    +c._v1_canonical(value),hashlib.sha256).hexdigest()
                return c._v1_encode(value)
            composition.handle_controller(request(1,'ADOPT',{}))
            proof=dict(proofDigest=composition.require_current().topology_digest,
                generation=1,expiresAtMs=h.binding.expiresAtMs,
                monotonicDeadlineMs=composition._activation_deadline())
            browser_config={'version':1,'assetBundle':{'release':'public-signed-bytes'}}
            prepared=json.loads(composition.handle_controller(
                request(2,'PREPARE_BROWSER',dict(**proof,browserConfig=browser_config)))[4:])['payload']['result']
            self.assertEqual(h.browser_prepare_payload['browserConfig'],browser_config)
            result=json.loads(composition.handle_controller(request(
                3,'COMMIT_BROWSER',dict(grantId=prepared['grantId'],generation=1)))[4:])
            self.assertEqual(result['payload']['result'],{'status':'ACTIVE','generation':1})
            self.assertEqual(composition._state,'BROWSER_COMMITTED')
            self.assertTrue(composition._browser_reservation._used)
            self.assertNotEqual(admitted.handoff,composition._proof.handoff)

    def test_v1_task13_application_chunks_use_the_original_browser_pipe_only(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE);preparation=composition.prepare_browser();composition.commit_browser(preparation)
            controller=h.role_init['CONTROLLER'];row=next(value for value in controller['roles'] if value['role']=='BROWSER')
            key=bytes.fromhex(controller['channelKeyHex'])
            def request(sequence,action,payload):
                value=dict(version=1,binding=h.binding.to_record(),sequence=sequence,**row,action=action,payload=payload)
                value['mac']=hmac.new(key,b'acceptance:bootstrap-composition:v1\0CONTROLLER:TO_BOOTSTRAP\0'+c._v1_canonical(value),hashlib.sha256).hexdigest()
                return c._v1_encode(value)
            chunk=dict(streamSequence=1,messageSequence=1,chunkIndex=0,final=True,bytesHex=b'task13'.hex())
            written=json.loads(composition.handle_controller(request(1,'APP_WRITE',chunk))[4:])['payload']['result']
            self.assertEqual(written,{'acceptedStreamSequence':1});self.assertEqual(h.application_to_worker,[chunk])
            h.worker_sequence+=1
            worker=dict(version=1,binding=h.binding.to_record(),sequence=h.worker_sequence,**row,action='APP_CHUNK',payload=chunk)
            worker['mac']=hmac.new(bytes.fromhex(h.role_init['BROWSER']['channelKeyHex']),
                b'acceptance:bootstrap-composition:v1\0BROWSER:TO_BOOTSTRAP\0'+c._v1_canonical(worker),hashlib.sha256).hexdigest()
            h.role_queue.append(c._v1_encode(worker))
            polled=json.loads(composition.handle_controller(request(2,'APP_POLL',{}))[4:])['payload']['result']
            self.assertEqual(polled,{'status':'CHUNK','chunk':chunk})
            empty=json.loads(composition.handle_controller(request(3,'APP_POLL',{}))[4:])['payload']['result']
            self.assertEqual(empty,{'status':'EMPTY'})

    def test_v1_browser_failure_and_expiry_never_revive_reserved_transition(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE);preparation=composition.prepare_browser()
            reservation=composition._browser_reservation
            read=h.role_kernel.read_role;reads=0
            def fail_after_refresh(owned,remaining):
                nonlocal reads
                reads+=1
                return read(owned,remaining) if reads==1 else b'bad'
            h.role_kernel.read_role=fail_after_refresh
            with self.assertRaises(Exception):composition.commit_browser(preparation)
            self.assertTrue(reservation._used)
            self.assertEqual(composition._state,'FAILED')
            self.assertEqual(composition._generation,2)
            self.assertIsNone(composition._proof);self.assertIsNone(composition._handoff)
            self.assertIsNone(composition._browser_preparation)
            self.assertIsNone(composition._browser_reservation)
            with self.assertRaises(Exception):composition.require_current()
            with self.assertRaises(Exception):composition.commit_browser(preparation)
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE);preparation=composition.prepare_browser()
            reservation=composition._browser_reservation
            h.clock.wall=h.binding.expiresAtMs
            with self.assertRaises(Exception):composition.commit_browser(preparation)
            self.assertTrue(reservation._used)
            self.assertEqual(composition._state,'FAILED')
            self.assertEqual(composition._generation,2)
            self.assertIsNone(composition._proof);self.assertIsNone(composition._handoff)

    def test_v1_authenticated_cancel_terminalizes_composition_and_cleanup_once(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE);preparation=composition.prepare_browser()
            reservation=composition._browser_reservation
            def write_cancelled(owned,data):
                value=json.loads(data[4:]);self.assertEqual(value['action'],'CANCEL')
                h.worker_sequence+=1
                response=dict(version=1,binding=h.binding.to_record(),
                    sequence=h.worker_sequence,role='BROWSER',childId=value['childId'],
                    pipeId=value['pipeId'],action='CANCELLED',
                    payload=dict(requestSequence=value['sequence'],generation=1))
                response['mac']=hmac.new(bytes.fromhex(
                    h.role_init['BROWSER']['channelKeyHex']),
                    b'acceptance:bootstrap-composition:v1\0BROWSER:TO_BOOTSTRAP\0'
                    +c._v1_canonical(response),hashlib.sha256).hexdigest()
                h.role_queue.append(c._v1_encode(response))
            h.role_kernel.write_role=write_cancelled
            controller=h.role_init['CONTROLLER'];row=next(value for value in
                controller['roles'] if value['role']=='BROWSER')
            # The controller's own first-terminal end; the bootstrap budget
            # starts only when this authenticated cancel arrives (E7).
            self.assertIs(h.budget.started,False)
            request=dict(version=1,binding=h.binding.to_record(),sequence=1,**row,
                action='CANCEL',payload=dict(generation=1,
                    cleanupEndsAtMonotonicMs=h.clock.mono+60000))
            request['mac']=hmac.new(bytes.fromhex(controller['channelKeyHex']),
                b'acceptance:bootstrap-composition:v1\0CONTROLLER:TO_BOOTSTRAP\0'
                +c._v1_canonical(request),hashlib.sha256).hexdigest()
            response=json.loads(composition.handle_controller(c._v1_encode(request))[4:])
            self.assertEqual(response['payload']['result'],
                             {'status':'CANCELLED','generation':1})
            self.assertTrue(composition._terminal);self.assertEqual(composition._state,'CANCELLED')
            self.assertEqual(composition._generation,2)
            self.assertIsNone(composition._proof);self.assertIsNone(composition._handoff)
            self.assertIsNone(composition._browser_preparation)
            self.assertIsNone(composition._browser_reservation)
            self.assertTrue(preparation._used);self.assertTrue(reservation._used)
            stopped=tuple(h.role_finite.stopped)
            for operation in (composition.require_current,composition.prepare_browser,
                    lambda:composition.commit_browser(preparation),
                    lambda:composition.handle_controller(c._v1_encode(request)),
                    composition.begin):
                with self.assertRaises(Exception):operation()
                self.assertEqual(composition._state,'CANCELLED')
            self.assertEqual(tuple(h.role_finite.stopped),stopped)
            self.assertEqual(composition.stop_owned(0)['status'],'STOPPED')
            self.assertEqual(tuple(h.role_finite.stopped),stopped)

    def test_v1_rejected_restart_terminalizes_admitted_and_committed_once(self):
        for committed in (False,True):
            with self.subTest(committed=committed):
                h=self.Harness(self);composition,stack=h.build()
                with stack:
                    first=composition.begin(TEST_HOST_CHALLENGE);preparation=reservation=None
                    if committed:
                        preparation=composition.prepare_browser()
                        reservation=composition._browser_reservation
                        self.assertEqual(composition.commit_browser(preparation),
                                         {'status':'ACTIVE','generation':1})
                        self.assertEqual(composition._state,'BROWSER_COMMITTED')
                    with self.assertRaisesRegex(t.TopologyError,'^TOPOLOGY_FAILED$'):
                        composition.begin(TEST_HOST_CHALLENGE)
                    self.assertTrue(composition._terminal)
                    self.assertEqual(composition._state,'FAILED')
                    self.assertEqual(composition._generation,2)
                    self.assertIsNone(composition._proof)
                    self.assertIsNone(composition._handoff)
                    self.assertIsNone(composition._browser_preparation)
                    self.assertIsNone(composition._browser_reservation)
                    if committed:
                        self.assertTrue(preparation._used);self.assertTrue(reservation._used)
                    self.assertIsNot(first,composition._proof)
                    stopped=tuple(h.role_finite.stopped)
                    self.assertEqual(len(stopped),4)
                    operations=(lambda:composition.begin(TEST_HOST_CHALLENGE),composition.require_current,
                        composition.prepare_browser,
                        lambda:composition.commit_browser(preparation),
                        lambda:composition.handle_controller(b'bad'))
                    for operation in operations:
                        with self.assertRaises(Exception):operation()
                        self.assertEqual(composition._generation,2)
                        self.assertEqual(tuple(h.role_finite.stopped),stopped)
                    self.assertEqual(composition.stop_owned(0)['status'],'STOPPED')
                    self.assertEqual(tuple(h.role_finite.stopped),stopped)

    def test_v1_stop_during_every_acquisition_never_publishes_or_advances(self):
        for boundary in ('probe','roles','proxy','event','capture','publication'):
            with self.subTest(boundary=boundary):
                h=self.Harness(self);composition,stack=h.build();receipts=[]
                def stop():receipts.append(composition.stop_owned(60000))
                if boundary=='probe':
                    original=h.probe_channel.observe
                    def observe(*args):
                        if not receipts:stop()
                        return original(*args)
                    h.probe_channel.observe=observe
                elif boundary=='roles':
                    original=h.role_kernel.spawn_waiting
                    def spawn(*args):
                        if not receipts:stop()
                        return original(*args)
                    h.role_kernel.spawn_waiting=spawn
                elif boundary=='proxy':
                    original=composition._proxy_entry
                    def activate(*args):
                        owner=original(*args);stop();return owner
                    composition._proxy_entry=activate
                elif boundary=='event':
                    original=t.LinuxBootstrapEventSource.install
                    def install(*args):
                        owner=original(*args);stop();return owner
                    stack.enter_context(mock.patch.object(
                        t.LinuxBootstrapEventSource,'install',side_effect=install))
                elif boundary=='capture':
                    original=h.host.observe
                    def observe(*args):stop();return original(*args)
                    h.host.observe=observe
                else:
                    original=t._validate_composition_payload
                    def validate(*args):
                        value=original(*args);stop();return value
                    stack.enter_context(mock.patch.object(
                        t,'_validate_composition_payload',side_effect=validate))
                result=error=None
                with stack:
                    try:result=composition.begin(TEST_HOST_CHALLENGE)
                    except Exception as caught:error=caught
                    self.assertEqual(receipts,[{'status':'TIMEOUT','runId':h.binding.runId}])
                    self.assertIsNone(result);self.assertIsNotNone(error)
                    self.assertTrue(composition._terminal)
                    self.assertEqual(composition._state,'STOPPED')
                    self.assertEqual(composition._generation,2)
                    self.assertIsNone(composition._proof);self.assertIsNone(composition._handoff)
                    self.assertEqual(composition.stop_owned(60000)['status'],'STOPPED')
                    self.assertTrue(all(owner.closed for owner in h.event_native.opened))
                    generation=composition._generation
                    for operation in (lambda:composition.begin(TEST_HOST_CHALLENGE),composition.require_current,
                                      composition.prepare_browser):
                        with self.assertRaises(Exception):operation()
                        self.assertEqual(composition._generation,generation)
                if boundary=='probe':self.assertNotIn('roles',h.timeline)
                if boundary=='roles':self.assertNotIn('proxy',h.timeline)
                if boundary=='proxy':
                    self.assertFalse(any(type(value) is tuple and
                        value[0]=='event-retain' for value in h.timeline))
                if boundary=='event':
                    self.assertFalse(any(type(value) is tuple and
                        value[0]=='open' for value in h.timeline))

    def test_v1_late_cleanup_authority_is_serialized_and_never_cached_away(self):
        for mode in ('substitute','throw','reentry','exhausted'):
            with self.subTest(mode=mode):
                h=self.Harness(self);composition,stack=h.build();receipts=[]
                class LateOwner:
                    def __init__(self):self.calls=self.active=self.maximum=0
                    def stop_owned(owner,remaining):
                        owner.calls+=1;owner.active+=1
                        owner.maximum=max(owner.maximum,owner.active)
                        try:
                            if mode=='reentry' and owner.calls==1:
                                receipts.append(composition.stop_owned(remaining))
                            return {'status':'TIMEOUT' if mode=='exhausted' else 'STOPPED',
                                    'runId':h.binding.runId}
                        finally:owner.active-=1
                late=LateOwner()
                def activate(*args):
                    receipts.append(composition.stop_owned(60000))
                    if mode=='exhausted':h.clock.mono+=60001
                    if mode=='throw':
                        error=t.TopologyError('LATE_FAILURE');error.cleanup=late;raise error
                    return late
                composition._proxy_entry=activate
                with stack,self.assertRaises(Exception):composition.begin(TEST_HOST_CHALLENGE)
                self.assertEqual(receipts[0],{'status':'TIMEOUT','runId':h.binding.runId})
                self.assertEqual(late.maximum,1)
                self.assertGreaterEqual(late.calls,1)
                final=composition.stop_owned(60000)
                self.assertEqual(final['status'],
                                 'TIMEOUT' if mode=='exhausted' else 'STOPPED')
                self.assertIsNone(composition._proof);self.assertIsNone(composition._handoff)
                self.assertEqual(composition._generation,2)
                if mode=='reentry':
                    self.assertIn({'status':'TIMEOUT','runId':h.binding.runId},receipts[1:])

    def test_v1_stop_clamps_to_caller_and_never_widens_shared_budget(self):
        for supplied,shared_cap in ((0,None),(7,None),(60000,3)):
            with self.subTest(supplied=supplied,shared_cap=shared_cap):
                # Real time moves only through the injected real clock (M-1).
                real=[time.monotonic_ns()//1000000]
                h=self.Harness(self,real_clock=lambda:real[0])
                composition,stack=h.build();allowances=[]
                original=t.BootstrapEventOwner.stop_owned
                def stop(owner,remaining):
                    allowances.append(remaining);return original(owner,remaining)
                with stack:
                    composition.begin(TEST_HOST_CHALLENGE)
                    self.assertIsNone(h.budget.deadline)
                    if shared_cap is not None:
                        # An earlier terminal event already started the shared end.
                        h.budget.start_terminal()
                        h.clock.mono=h.budget.deadline-shared_cap
                    with mock.patch.object(t.BootstrapEventOwner,'stop_owned',new=stop):
                        first=composition.stop_owned(supplied)
                        self.assertIsNotNone(h.budget.deadline)
                        call_count=len(allowances)
                        repeated=composition.stop_owned(60000)
                    limit=supplied if shared_cap is None else shared_cap
                    self.assertTrue(allowances)
                    self.assertTrue(all(0 <= value <= limit for value in allowances))
                    if limit==0:
                        self.assertTrue(all(value==0 for value in allowances))
                        self.assertEqual(first['status'],'TIMEOUT')
                        self.assertEqual(repeated['status'],'TIMEOUT')
                    else:
                        self.assertEqual(len(allowances),call_count)
                    self.assertLessEqual(composition._budget.remaining(),limit)

    def test_v1_stop_cap_survives_late_registration_and_reentry(self):
        for supplied in (0,7):
            with self.subTest(supplied=supplied):
                h=self.Harness(self);composition,stack=h.build();receipts=[]
                class LateOwner:
                    def __init__(owner):owner.allowances=[];owner.reentered=False
                    def stop_owned(owner,remaining):
                        owner.allowances.append(remaining)
                        if supplied and not owner.reentered:
                            owner.reentered=True
                            receipts.append(composition.stop_owned(0))
                        return {'status':'STOPPED','runId':h.binding.runId}
                late=LateOwner()
                def activate(*args):
                    receipts.append(composition.stop_owned(supplied))
                    receipts.append(composition.stop_owned(60000))
                    return late
                composition._proxy_entry=activate
                with stack,self.assertRaises(Exception):composition.begin(TEST_HOST_CHALLENGE)
                self.assertEqual(receipts[0],
                                 {'status':'TIMEOUT','runId':h.binding.runId})
                self.assertEqual(receipts[1],
                                 {'status':'TIMEOUT','runId':h.binding.runId})
                self.assertEqual(len(late.allowances),1)
                self.assertLessEqual(late.allowances[0],supplied)
                if supplied==0:self.assertEqual(late.allowances,[0])
                if supplied:self.assertIn(
                    {'status':'TIMEOUT','runId':h.binding.runId},receipts[2:])
                self.assertEqual(composition._budget.remaining(),0)
                self.assertEqual(composition.stop_owned(60000)['status'],'STOPPED')
                self.assertEqual(len(late.allowances),1)

    LONG_LIVED_EXPIRES_MS=200000  # local only; never reaches an exported fixture

    def test_v1_shared_cleanup_end_unarmed_after_successful_begin(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            self.assertIs(type(composition.begin(TEST_HOST_CHALLENGE)),t.AdmissionProof)
            self.assertEqual(composition._state,'ADMITTED')
            self.assertIs(h.budget.started,False)
            self.assertIsNone(h.budget.deadline)

    def test_v1_terminal_cleanup_gets_full_window_after_61s_of_normal_operation(self):
        real=[time.monotonic_ns()//1000000]
        h=self.Harness(self,expires_at=self.LONG_LIVED_EXPIRES_MS,real_clock=lambda:real[0])
        composition,stack=h.build();allowances=[]
        def recording(kind):
            original=kind.stop_owned
            def stop(owner,remaining):
                allowances.append((owner,remaining));return original(owner,remaining)
            return mock.patch.object(kind,'stop_owned',new=stop)
        with stack:
            composition.begin(TEST_HOST_CHALLENGE)
            h.clock.wall+=61000;h.clock.mono+=61000;real[0]+=61000
            retained=list(composition._cleanup_chain);mono=h.clock.mono
            self.assertEqual([type(owner) for owner in retained],
                [c.OriginalRoleSet,t.ProxyChildAuthority,t.BootstrapEventOwner])
            with recording(c.OriginalRoleSet),recording(t.ProxyChildAuthority), \
                    recording(t.BootstrapEventOwner):
                receipt=composition.stop_owned(60000)
            self.assertEqual(receipt,{'status':'STOPPED','runId':h.binding.runId})
            self.assertEqual([id(owner) for owner,_ in allowances],
                             [id(owner) for owner in reversed(retained)])
            self.assertTrue(all(1<=value<=60000 for _,value in allowances),allowances)
            self.assertEqual(h.budget.deadline,mono+60000)

    def test_v1_probe_catalogue_longer_than_60s_still_qualifies(self):
        real=[time.monotonic_ns()//1000000]
        h=self.Harness(self,expires_at=self.LONG_LIVED_EXPIRES_MS,real_clock=lambda:real[0])
        composition,stack=h.build();start=h.clock.mono
        kernel=h.fixture.kernel;stop=kernel.stop_owned
        def slow_family_stop(owner,duration):
            h.clock.wall+=1000;h.clock.mono+=1000;real[0]+=1000
            return stop(owner,duration)
        kernel.stop_owned=slow_family_stop
        with stack:
            try:composition.begin(TEST_HOST_CHALLENGE)
            except Exception as error:self.fail('a >60 s probe catalogue was denied: '+repr(error))
            self.assertEqual(composition._state,'ADMITTED')
            self.assertEqual(len(h.fixture.family_owners),94)
            self.assertGreaterEqual(h.clock.mono-start,94000)
            self.assertIs(h.budget.started,False)
            self.assertIsNone(h.budget.deadline)

    def test_v1_activation_deadline_not_capped_by_unstarted_cleanup(self):
        h=self.Harness(self,expires_at=self.LONG_LIVED_EXPIRES_MS);composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE)
            h.clock.wall+=61000;h.clock.mono+=61000;wall,mono=h.clock.wall,h.clock.mono
            try:composition.prepare_browser()
            except Exception as error:self.fail('activation capped by cleanup end: '+repr(error))
            self.assertEqual(h.browser_prepare_payload['monotonicDeadlineMs'],
                             mono+h.binding.expiresAtMs-wall)
            self.assertIs(h.budget.started,False)
            # E7: even a started shared end never caps the activation deadline (C8).
            h.budget.start_terminal();h.clock.mono+=61000
            self.assertEqual(composition._activation_deadline(),
                             h.clock.mono+h.binding.expiresAtMs-h.clock.wall)

    def test_v1_no_routine_path_arms_shared_end(self):
        h=self.Harness(self);composition,stack=h.build();calls=[]
        original=t.CleanupBudget.start_terminal
        def spy(budget):
            calls.append(budget);return original(budget)
        def unarmed(step):
            # State, not only the spy: a direct deadline write is also caught.
            self.assertIs(h.budget.started,False,step)
            self.assertIsNone(h.budget.deadline,step)
            self.assertIsNone(h.budget.real_deadline,step)
            if h.proxy_harness is not None:
                self.assertIsNone(h.proxy_harness.budget.deadline,step)
        with stack,mock.patch.object(t.CleanupBudget,'start_terminal',new=spy):
            unarmed('built')
            composition.begin(TEST_HOST_CHALLENGE);unarmed('begin')
            for index in range(3):
                composition.require_current();unarmed('current-%d'%index)
            # Host-facing current checks (C2) are routine as well.
            composition.host_current(OTHER_HOST_CHALLENGE);unarmed('host-current')
            preparation=composition.prepare_browser();unarmed('prepare')
            self.assertEqual(composition.commit_browser(preparation),
                             {'status':'ACTIVE','generation':1})
            unarmed('commit')
            composition.require_current();unarmed('committed-current')
            composition.host_current('20'*16);unarmed('committed-host-current')
        self.assertEqual([budget for budget in calls if budget is h.budget],[])

    def test_v1_late_acquisition_racing_cleanup_is_stopped(self):
        # Two-thread port of the Stage 1 reviewer's late_acquisition_race.py.
        h=self.Harness(self);composition,stack=h.build();role_stops=[]
        finite_stop=h.role_kernel.stop_owned
        def counted_stop(owned,ms):
            role_stops.append(owned.role);return finite_stop(owned,ms)
        h.role_kernel.stop_owned=counted_stop
        in_final,release,roles_entered=threading.Event(),threading.Event(),threading.Event()
        original_unresolved=t.NativeTopologyBindings.cleanup_unresolved
        def blocking_unresolved(bindings):
            if threading.current_thread().name=='stopper':
                in_final.set()
                if not release.wait(5):raise AssertionError('stopper release missing')
            return original_unresolved(bindings)
        receipts,begin_errors=[],[]
        with stack:
            harness_bind=c.bind_original_roles
            def bind(*args):
                roles_entered.set()
                if not in_final.wait(5):raise AssertionError('stopper never reached its final phase')
                return harness_bind(*args)
            with mock.patch.object(c,'bind_original_roles',side_effect=bind), \
                    mock.patch.object(t.NativeTopologyBindings,'cleanup_unresolved',blocking_unresolved):
                def run_begin():
                    try:composition.begin(TEST_HOST_CHALLENGE)
                    except Exception as error:begin_errors.append(error)
                begin=threading.Thread(target=run_begin,name='begin',daemon=True);begin.start()
                self.assertTrue(roles_entered.wait(5))
                stopper=threading.Thread(target=lambda:receipts.append(composition.stop_owned(60000)),
                                         name='stopper',daemon=True)
                stopper.start();begin.join(10);release.set();stopper.join(10)
                self.assertFalse(begin.is_alive());self.assertFalse(stopper.is_alive())
            self.assertEqual(len(begin_errors),1)
            self.assertTrue(any(owner is h.roles for owner in composition._cleanup_chain))
            # No third stop: the running pass picked up the late original owner.
            self.assertEqual(role_stops,['PROXY','VERIFIER','BROWSER','CONTROLLER'])
            self.assertEqual(composition._cleanup_status,'STOPPED')
            self.assertEqual(receipts,[{'status':'STOPPED','runId':h.binding.runId}])

    def test_v1_bootstrap_clamps_to_worker_first_terminal_end(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE)
            h.clock.mono+=5000;failed_at=h.clock.mono-5000
            write=h.role_kernel.write_role
            def fail_prepare(owned,data):
                value=json.loads(data[4:])
                if value.get('action')!='PREPARE':return write(owned,data)
                h.worker_sequence+=1
                response=dict(version=1,binding=h.binding.to_record(),
                    sequence=h.worker_sequence,role='BROWSER',childId=value['childId'],
                    pipeId=value['pipeId'],action='FAILED',payload=dict(
                        requestSequence=value['sequence'],generation=1,
                        code='LAUNCH_FAILED',failedAtMonotonicMs=failed_at))
                response['mac']=hmac.new(bytes.fromhex(
                    h.role_init['BROWSER']['channelKeyHex']),
                    b'acceptance:bootstrap-composition:v1\0BROWSER:TO_BOOTSTRAP\0'
                    +c._v1_canonical(response),hashlib.sha256).hexdigest()
                h.role_queue.append(c._v1_encode(response))
            h.role_kernel.write_role=fail_prepare
            with self.assertRaisesRegex(Exception,'LAUNCH_FAILED'):composition.prepare_browser()
            self.assertTrue(composition._terminal)
            self.assertIs(h.budget.started,True)
            # K6: the composition end never exceeds the worker's earliest terminal time.
            self.assertLessEqual(h.budget.deadline,failed_at+60000)

    def test_v1_zero_stop_never_starts_unresolved_observation_cleanup(self):
        h=self.Harness(self);composition,stack=h.build();calls=[]
        class Unresolved:
            def cleanup(owner):calls.append(owner)
        unresolved=Unresolved();h.observations._unresolved.append(unresolved)
        with stack:
            receipt=composition.stop_owned(0)
        self.assertEqual(receipt,{'status':'TIMEOUT','runId':h.binding.runId})
        self.assertEqual(calls,[])
        self.assertIs(h.observations._cleanup_budget,h.budget)

    def test_v1_all_probe_families_exit_before_persistent_roles(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack: composition.begin(TEST_HOST_CHALLENGE)
        self.assertLess(h.timeline.index('probes'),h.timeline.index('roles'))
        self.assertLess(h.timeline.index('roles'),h.timeline.index('proxy'))
        event_index=next(i for i,v in enumerate(h.timeline) if isinstance(v,tuple) and v[0]=='event-retain')
        open_index=next(i for i,v in enumerate(h.timeline) if isinstance(v,tuple) and v[0]=='open')
        self.assertLess(event_index,open_index)

    def test_v1_resample_reuses_probe_epoch_without_spawn(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE);composition.require_current()
        self.assertEqual(h.timeline.count('probes'),1);self.assertEqual(h.timeline.count('roles'),1)

    def test_v1_binding_mutation_invalidates_every_owner(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack:proof=composition.begin(TEST_HOST_CHALLENGE)
        self.assertEqual(t.verify_bootstrap_handoff_v1(proof.handoff,h.expected,h.binding,composition)['runId'],h.binding.runId)
        # C3: re-sign with the topology-admission key, so only the binding can fail;
        # the unmutated control proves the re-signing key is the right one.
        key=c.derive_channel_key(h.expected.capability,'topology-admission')
        def resigned(value):
            value['mac']=hmac.new(key,t.BOOTSTRAP_HANDOFF_DOMAIN+t._canonical(value['payload']),hashlib.sha256).hexdigest()
            return t._canonical(value).decode()
        control=resigned(json.loads(proof.handoff))
        self.assertEqual(control,proof.handoff)
        self.assertEqual(t.verify_bootstrap_handoff_v1(control,h.expected,h.binding,composition)['runId'],h.binding.runId)
        value=json.loads(proof.handoff);value['payload']['composition']['binding']['epoch']=2
        with self.assertRaises(t.TopologyError):t.verify_bootstrap_handoff_v1(resigned(value),h.expected,h.binding,composition)

    def test_v1_owned_consumer_rejects_rows_that_differ_from_retained_originals(self):
        # T10 divergence (Swift twin: canonical original equality): a validly MAC'd
        # handoff whose runtime rows differ from the bootstrap's retained records.
        h=self.Harness(self);composition,stack=h.build()
        with stack:proof=composition.begin(TEST_HOST_CHALLENGE)
        key=c.derive_channel_key(h.expected.capability,'topology-admission')
        def resigned(value):
            value['mac']=hmac.new(key,t.BOOTSTRAP_HANDOFF_DOMAIN+t._canonical(value['payload']),hashlib.sha256).hexdigest()
            return t._canonical(value).decode()
        self.assertEqual(t.verify_bootstrap_handoff_v1(proof.handoff,h.expected,h.binding,composition)['runId'],h.binding.runId)
        for index,field,value in ((3,'ownerId','d'*32),(3,'inode','4242'),(0,'ownerId','d'*32)):
            with self.subTest(role=index,field=field):
                envelope=json.loads(proof.handoff)
                row=envelope['payload']['composition']['roleRuntime'][index]['currentFDs'][-1]
                row[field]=value
                wire=resigned(envelope)
                # Structurally valid: the ownerless consumer accepts it ...
                self.assertEqual(t.verify_bootstrap_handoff_v1(wire,h.expected,h.binding)['runId'],h.binding.runId)
                # ... the owned consumer compares it with the retained original record.
                with self.assertRaisesRegex(t.TopologyError,'^HANDOFF_DENIED$'):
                    t.verify_bootstrap_handoff_v1(wire,h.expected,h.binding,composition)

    def test_v1_capture_failure_at_each_acquisition_keeps_original_cleanup(self):
        h=self.Harness(self);composition,stack=h.build()
        h.observations.observation_port.open_owned=lambda *args:(_ for _ in ()).throw(OSError('inert capture'))
        with stack,self.assertRaises(Exception) as caught:composition.begin(TEST_HOST_CHALLENGE)
        self.assertEqual(composition._state,'FAILED');self.assertIs(composition._roles,h.roles)
        self.assertIs(caught.exception.cleanup,composition)

    def test_v1_partial_role_and_event_acquisitions_keep_exact_cleanup_owners(self):
        h=self.Harness(self);h.role_finite.fail_spawn='PROXY';composition,stack=h.build()
        with stack,self.assertRaises(Exception) as caught:composition.begin(TEST_HOST_CHALLENGE)
        self.assertIs(caught.exception.cleanup,composition)
        self.assertTrue(any(type(owner) is c.OriginalRoleSet
                            for owner in composition._cleanup_chain))
        h=self.Harness(self);h.event_native.fail_at='ROUTE';composition,stack=h.build()
        with stack,self.assertRaises(Exception) as caught:composition.begin(TEST_HOST_CHALLENGE)
        self.assertIs(caught.exception.cleanup,composition)
        events=[owner for owner in composition._cleanup_chain
                if type(owner) is t.BootstrapEventOwner]
        self.assertEqual(len(events),1)
        self.assertIs(events[0]._port,h.event_native)
        self.assertTrue(h.event_native.opened)
        self.assertTrue(all(owner.closed for owner in h.event_native.opened))
        self.assertIs(caught.exception.cleanup,composition)

    def test_v1_complete_guest_composition_uses_actual_accepted_modules(self):
        # E4 (P12): nothing on the observation path is replaced. The composition's
        # own (offline) kernel port reads a literal /proc per original child; the PROXY
        # child's table is its stand-in's inert descriptor table at its own attested
        # PID, and the actual serve_proxy runs in another thread standing in for that
        # child. Labelled (RB5): literal /proc and a thread, never native evidence;
        # the bracket tests below are the C5 binding.
        for name in ('register_runtime_descriptor','retire_runtime_descriptor'):
            self.assertFalse(hasattr(c.NativeKernelPort,name),name)
        h=self.Harness(self);composition,stack=h.build()
        for name in ('bind_runtime_owner','inspect_runtime','runtime_lifecycle',
                     'observe_child_descriptors','read_proxy_frame','write_proxy_frame'):
            self.assertNotIn(name,vars(h.role_kernel),name)
            self.assertIs(getattr(h.role_kernel,name).__func__,getattr(c._KernelPortCore,name),name)
        with stack:
            self.assertIs(t.observe_current_roles,ORIGINAL_OBSERVE_CURRENT_ROLES)
            proof=composition.begin(TEST_HOST_CHALLENGE)
            authority=composition._proxy_authority
            self.assertIs(type(authority),t.ProxyChildAuthority)
            self.assertIs(authority._handoff,h.roles._handoffs['PROXY'])
            self.assertNotEqual(authority._handoff.attestation.pid,os.getpid())
            self.assertTrue(h.proxy_thread.is_alive())
            self.assertIsNot(h.proxy_thread,threading.current_thread())
            # The child minted its own in-process owner; the bootstrap holds none.
            self.assertEqual(h.proxy_harness.events[:3],['bind','listen','owner'])
            self.assertEqual(len(h.proxy_harness.owners),1)
            self.assertFalse(any(type(value) is t._PROXY.ProxyRuntimeOwner
                                 for value in vars(composition).values()))
            self.assertNotIn(h.proxy_harness.owners[0],composition._cleanup_chain)
            self.assertIs(type(composition._handoff),t.BootstrapHandoffV1)
            self.assertEqual(json.loads(proof.handoff)['version'],2)
            payload=composition._handoff.payload['composition']
            self.assertEqual([r['role'] for r in payload['roleRuntime']],list(c.UIDS))
            self.assertEqual(payload['proxyRuntimeId'],h.proxy_harness.owners[0]._runtime_id)
            rows=payload['roleRuntime'][3]['currentFDs']
            self.assertEqual([r['kind'] for r in rows],['NULL','NULL','NULL','COMMAND','RESULT',
                                                        'PROXY_LISTENER','PROXY_STOP_SELECTOR'])
            live=h.proxy_harness.live
            self.assertEqual([(r['fd'],r['device'],r['inode'],r['flags']) for r in rows],
                             [(fd,str(live[fd][0]),str(live[fd][1]),live[fd][2]) for fd in sorted(live)])
        self.assertEqual(h.proxy_errors,[])

    def literal_child(self,rows=None):
        """A ProxyChildAuthority over a literal child (topology_test fixture), on this module."""
        self.assertTrue(hasattr(t,'ProxyChildAuthority'),'no cross-process PROXY child authority (E4)')
        confinement_fixture.c=c;confinement_fixture.RUN=topology_fixture.RUN
        stack=contextlib.ExitStack()
        for name,value in (('topology',t),('confinement',c),('proxy',t._PROXY)):
            stack.enter_context(mock.patch.object(topology_fixture,name,value))
        with stack:
            return topology_fixture.literal_proxy_authority(confinement_fixture,
                rows if rows is not None else topology_fixture.LITERAL_PROXY_ROWS,
                binding=topology_fixture.event_binding(),clock=topology_fixture.Clock())

    LITERAL_STREAM=dict(fd=7,kind='PROXY_ACCEPTED_STREAM',device='8',inode='801',flags=2050,tfds=[])

    def test_v1_proxy_authority_observes_child_proc_not_bootstrap_fds(self):
        rows=topology_fixture.LITERAL_PROXY_ROWS+(self.LITERAL_STREAM,)
        authority,child,handoff,kernel,active,table=self.literal_child(rows)
        # The bootstrap's own FD5..7 hold unrelated identities; only the child's count.
        own={5:(3,7005),6:(3,7006),7:(3,7007)}
        kernel.b.os.fstat=lambda fd:types.SimpleNamespace(st_dev=own.get(fd,(4,0))[0],st_ino=own.get(fd,(4,0))[1])
        self.assertNotEqual(handoff.attestation.pid,os.getpid())
        observed=authority.observe_current()
        self.assertEqual(set(observed),{'runtimeId','rows'})
        self.assertEqual(observed['runtimeId'],child.runtime_id)
        expected=[dict(fd=fd,kind=table[fd]['kind'],device=table[fd]['device'],inode=table[fd]['inode'],
                       flags=table[fd]['flags'],tfds=table[fd]['tfds']) for fd in sorted(table)]
        self.assertEqual(observed['rows'],expected)
        self.assertTrue(all((row['device'],row['inode'])!=tuple(map(str,own[row['fd']]))
                            for row in observed['rows'] if row['fd'] in own))
        retained=kernel.runtime_record(handoff)['currentFDs']
        self.assertEqual([(r['fd'],r['kind'],r['device'],r['inode'],r['flags']) for r in retained],
                         [(r['fd'],r['kind'],r['device'],r['inode'],r['flags']) for r in expected])
        # Report A, the /proc read, then report B: two CURRENT requests per observation.
        self.assertEqual(child.reports,2)
        self.assertEqual([json.loads(w[2:])['kind'] for w in child.writes],['PROXY_CURRENT']*2)

    def test_v1_in_process_proxy_runtime_owner_rejected(self):
        # R11: the in-process ProxyRuntimeOwner gate is replaced, not kept beside the
        # child authority. A stand-in child's own owner handed back is ADAPTER_DENIED.
        self.assertTrue(hasattr(t,'ProxyChildAuthority'),'no cross-process PROXY child authority (E4)')
        for path in ('entry','activation'):
            with self.subTest(path=path):
                h=self.Harness(self);composition,stack=h.build()
                entry=composition._proxy_entry;owners=[]
                def in_process(*args):
                    entry(*args);deadline=time.monotonic()+5
                    while not h.proxy_harness.owners and time.monotonic()<deadline:time.sleep(.001)
                    owners.append(h.proxy_harness.owners[0]);return owners[0]
                if path=='entry':composition._proxy_entry=in_process
                else:
                    activate=composition._activate_proxy
                    def activation():
                        activate();return h.proxy_harness.owners[0]
                    composition._activate_proxy=activation
                with stack:
                    with self.assertRaisesRegex(t.TopologyError,'^ADAPTER_DENIED$'):
                        composition.begin(TEST_HOST_CHALLENGE)
                    owner=h.proxy_harness.owners[0]
                    self.assertIs(type(owner),t._PROXY.ProxyRuntimeOwner)
                    self.assertIsNone(composition._proxy_authority)
                    self.assertTrue(composition._terminal)
                    self.assertTrue(any(value is owner for value in composition._cleanup_chain))
                    self.assertFalse(any(type(value) is tuple and value[0]=='event-retain'
                                         for value in h.timeline))
        # The authority itself admits no in-process proxy: the PID check, the exact
        # nominal types and a fresh original client are all required.
        authority,child,handoff,kernel,active,table=self.literal_child()
        binding=authority._binding
        def client():
            return topology_fixture.literal_proxy_client(handoff._owned,binding,topology_fixture.Clock())
        same_process=dataclasses.replace(handoff,attestation=dataclasses.replace(
            handoff.attestation,pid=os.getpid()))
        class SubKernel(c.OfflineKernelPort):pass
        used=client();used._sent=1
        browser=dataclasses.replace(handoff,launch=dataclasses.replace(handoff.launch,role='BROWSER'))
        # Task 7 review M3: only the kernel's exact type is wrong here; the handoff names that same kernel,
        # so nothing but the type gate can refuse it.
        sub=SubKernel(kernel.b);typed=dataclasses.replace(handoff,_kernel=sub)
        self.assertEqual(t.ProxyChildAuthority(handoff,client(),kernel,binding,seal=t._PROXY_CHILD_SEAL).native,False)
        for name,args,seal in (('same-process',(same_process,client(),kernel,binding),t._PROXY_CHILD_SEAL),
                               ('kernel-type-only',(typed,client(),sub,binding),t._PROXY_CHILD_SEAL),
                               ('unsealed',(handoff,client(),kernel,binding),None),
                               ('foreign-client',(handoff,types.SimpleNamespace(),kernel,binding),t._PROXY_CHILD_SEAL),
                               ('used-client',(handoff,used,kernel,binding),t._PROXY_CHILD_SEAL),
                               ('kernel-subclass',(handoff,client(),object.__new__(SubKernel),binding),t._PROXY_CHILD_SEAL),
                               ('not-proxy',(browser,client(),kernel,binding),t._PROXY_CHILD_SEAL)):
            with self.subTest(construct=name),self.assertRaisesRegex(t.TopologyError,'^ADAPTER_DENIED$'):
                t.ProxyChildAuthority(*args,seal=seal)

    def test_v1_proxy_report_omitting_or_adding_descriptor_denied(self):
        base=topology_fixture.LITERAL_PROXY_ROWS+(self.LITERAL_STREAM,)
        extra=dict(fd=8,kind='PROXY_VSOCK_STREAM',device='8',inode='802',flags=2050,tfds=[])
        for change in ('omit','add','inode','flags','targets'):
            with self.subTest(change=change):
                authority,child,handoff,kernel,active,table=self.literal_child(base)
                before=kernel.runtime_record(handoff)
                def report(index,change=change):
                    rows=child.rows()
                    if change=='omit':rows=[r for r in rows if r['fd']!=7]
                    elif change=='add':rows=rows+[dict(extra)]
                    elif change=='inode':rows[7]['inode']='899'
                    elif change=='flags':rows[7]['flags']=2
                    elif change=='targets':rows[6]['tfds']=[3,4]
                    return rows
                child.report_rows=report
                if change=='targets':
                    # The child reports its fixed STOP targets; its /proc selector watches another set.
                    table[6]['tfds']=[3]
                with self.assertRaisesRegex(t.TopologyError,'^PROXY_RUNTIME_DRIFT$'):
                    authority.observe_current()
                self.assertEqual(kernel.runtime_record(handoff),before,'nothing adopted')
                with self.assertRaisesRegex(t.TopologyError,'^PROXY_DENIED$'):
                    authority.observe_current()

    def test_v1_proxy_report_and_proc_must_bracket_same_generation(self):
        # Review Focus 3: report A, /proc, report B must describe one generation. A
        # descriptor change between them, even one undone before B, is terminal drift.
        base=topology_fixture.LITERAL_PROXY_ROWS+(self.LITERAL_STREAM,)
        added=dict(fd=8,kind='PROXY_VSOCK_STREAM',device='8',inode='802',flags=2050,tfds=[])
        for churn in ('fd-added-after-A','fd-closed-after-A','substituted-and-restored',
                      'inherited-pipe-substituted','selector-identity-substituted',
                      'targets-changed-after-A','object-class-after-A','B-differs','sequence-gap'):
            with self.subTest(churn=churn):
                authority,child,handoff,kernel,active,table=self.literal_child(base)
                original=child.rows()
                def after(index,churn=churn):
                    if index==0 and churn=='fd-added-after-A':
                        table[8]=dict(added);active['fds'].append(8)
                    elif index==0 and churn=='fd-closed-after-A':
                        active['fds'].remove(7)
                    elif churn=='substituted-and-restored':
                        table[7]['inode']='899' if index==0 else '801'
                    elif churn=='inherited-pipe-substituted':
                        # Inherited FD3 is replaced and restored between the reports.
                        table[3]['inode']='1999' if index==0 else original[3]['inode']
                    elif churn=='selector-identity-substituted':
                        # Same epoll class and tfd: set; only its device:inode reveals it.
                        table[6]['device']='17' if index==0 else '16'
                    elif index==0 and churn=='targets-changed-after-A':
                        table[6]['tfds']=[3]
                    elif index==0 and churn=='object-class-after-A':
                        table[7]['kind']='PROXY_CONNECT_SELECTOR'
                    elif index==0 and churn=='sequence-gap':
                        child.observation+=1
                child.on_report=after
                if churn in ('substituted-and-restored','inherited-pipe-substituted',
                             'selector-identity-substituted','targets-changed-after-A',
                             'object-class-after-A'):
                    # The child's reports never change; only its /proc does, between them.
                    child.report_rows=lambda index:[dict(row) for row in original]
                elif churn=='B-differs':
                    child.report_rows=lambda index:original if index==0 else original[:-1]
                with self.assertRaisesRegex(t.TopologyError,'^PROXY_RUNTIME_DRIFT$'):
                    authority.observe_current()
                self.assertEqual(child.reports,2,'report B is always requested')
                with self.assertRaisesRegex(t.TopologyError,'^PROXY_DENIED$'):
                    authority.observe_current()
        # Control: the same bracket with no churn is accepted.
        authority,child,handoff,kernel,active,table=self.literal_child(base)
        self.assertEqual(len(authority.observe_current()['rows']),8)

    def test_v1_accepted_streams_after_admission_are_observed_not_registered(self):
        # E4: a stream the child accepts after admission is never registered; the next
        # bracketed observation adopts it, and every retained identity keeps its owner.
        for name in ('register_runtime_descriptor','retire_runtime_descriptor'):
            self.assertFalse(hasattr(c.NativeKernelPort,name),name)
        h=self.Harness(self);composition,stack=h.build();adopted=[]
        adopt=c._KernelPortCore._adopt_child_inventory
        def spy(kernel,handoff,owner,report):
            adopted.append([row['kind'] for row in report]);return adopt(kernel,handoff,owner,report)
        with stack,mock.patch.object(c.OfflineKernelPort,'_adopt_child_inventory',new=spy):
            first=composition.begin(TEST_HOST_CHALLENGE)
            before=json.loads(first.handoff)['payload']['composition']['roleRuntime'][3]['currentFDs']
            stand_in=h.proxy_harness;stand_in.clients.append([STAND_IN_CONNECT])
            deadline=time.monotonic()+5
            def settled():
                return (len(stand_in.live)==9 and any(e.family==40 and len(e.sent)>=66
                        for e in stand_in.endpoints))
            while not settled() and time.monotonic()<deadline:time.sleep(.001)
            self.assertTrue(settled(),'stand-in child never established its tunnel')
            current=composition.require_current()
            rows=json.loads(current.handoff)['payload']['composition']['roleRuntime'][3]['currentFDs']
            self.assertEqual([r['kind'] for r in rows][5:],['PROXY_LISTENER','PROXY_STOP_SELECTOR',
                                                            'PROXY_ACCEPTED_STREAM','PROXY_VSOCK_STREAM'])
            live=stand_in.live
            self.assertEqual([(r['fd'],r['device'],r['inode'],r['flags']) for r in rows],
                             [(fd,str(live[fd][0]),str(live[fd][1]),live[fd][2]) for fd in sorted(live)])
            self.assertEqual(rows[:7],before,'retained identities keep their ownerIds')
            self.assertEqual(len({r['ownerId'] for r in rows}),9)
            self.assertEqual(adopted[-1][5:],['PROXY_LISTENER','PROXY_STOP_SELECTOR',
                                              'PROXY_ACCEPTED_STREAM','PROXY_VSOCK_STREAM'])
        self.assertEqual(h.proxy_errors,[])

    def test_v1_composition_preparation_returns_original_python_owner(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE);owner=composition.prepare_browser()
        self.assertIs(type(owner),c.BootstrapBrowserPreparation)
        self.assertEqual(set(owner.to_prepare_result()),{'grantId','proofDigest','generation','expiresAtMs','monotonicDeadlineMs'})
        self.assertIs(owner._roles,h.roles)

    def test_v1_handoff_envelope_is_distinct_strict_and_bounded(self):
        self.assertEqual(t.BOOTSTRAP_HANDOFF_VERSION, 2)
        self.assertEqual(t.BOOTSTRAP_HANDOFF_LIMIT, 131072)
        self.assertEqual(t.BOOTSTRAP_HANDOFF_DOMAIN,
                         b'acceptance:bootstrap-composition:v1\0')

    def test_v1_handoff_payload_carries_exact_host_challenge(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            proof=composition.begin(TEST_HOST_CHALLENGE)
            payload=json.loads(proof.handoff)['payload']
            self.assertEqual(payload.get('hostChallenge'),TEST_HOST_CHALLENGE)
            self.assertEqual(json.loads(proof.canonical).get('hostChallenge'),TEST_HOST_CHALLENGE)
            self.assertEqual(composition._handoff.payload.get('hostChallenge'),TEST_HOST_CHALLENGE)
            self.assertIs(composition._handoff.host_eligible,True)
            current=composition.host_current(OTHER_HOST_CHALLENGE)
            self.assertEqual(json.loads(current.handoff)['payload'].get('hostChallenge'),
                             OTHER_HOST_CHALLENGE)
            self.assertEqual(current.sequence,proof.sequence+1)
            self.assertIs(composition._handoff.host_eligible,True)

    def test_v1_host_challenge_format_and_reuse_denied(self):
        bad_values=(TEST_HOST_CHALLENGE.upper(),TEST_HOST_CHALLENGE[:31],
                    TEST_HOST_CHALLENGE+'0','g'*32,TEST_HOST_CHALLENGE[:31]+'\n',
                    TEST_HOST_CHALLENGE.encode('ascii'),None)
        for bad in bad_values:
            with self.subTest(begin=bad):
                h=self.Harness(self);composition,stack=h.build()
                with stack:
                    with self.assertRaisesRegex(t.TopologyError,'^CHALLENGE_DENIED$'):
                        composition.begin(bad)
                    self.assertTrue(composition._terminal)
                    self.assertEqual(composition._state,'FAILED')
                    self.assertNotIn('probes',h.timeline)
        with self.subTest(host_current='uppercase'):
            h=self.Harness(self);composition,stack=h.build()
            with stack:
                composition.begin(TEST_HOST_CHALLENGE)
                with self.assertRaisesRegex(t.TopologyError,'^CHALLENGE_DENIED$'):
                    composition.host_current(OTHER_HOST_CHALLENGE.upper())
                self.assertTrue(composition._terminal)
                self.assertEqual(composition._state,'FAILED')
        with self.subTest(replay='begin-then-host-current'):
            h=self.Harness(self);composition,stack=h.build()
            with stack:
                composition.begin(TEST_HOST_CHALLENGE)
                with self.assertRaisesRegex(t.TopologyError,'^CHALLENGE_REPLAY$'):
                    composition.host_current(TEST_HOST_CHALLENGE)
                self.assertTrue(composition._terminal)
                self.assertEqual(composition._state,'FAILED')
                self.assertIsNone(composition._proof)
        with self.subTest(replay='host-current-twice'):
            h=self.Harness(self);composition,stack=h.build()
            with stack:
                composition.begin(TEST_HOST_CHALLENGE)
                composition.host_current(OTHER_HOST_CHALLENGE)
                with self.assertRaisesRegex(t.TopologyError,'^CHALLENGE_REPLAY$'):
                    composition.host_current(OTHER_HOST_CHALLENGE)
                self.assertTrue(composition._terminal)
                self.assertEqual(composition._state,'FAILED')

    def test_v1_internal_current_handoff_has_no_host_challenge(self):
        # R3: guest-internal currents (browser commit paths) carry no host
        # challenge, so the host can never accept them (Swift twin denies).
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE)
            self.assertIs(composition._handoff.host_eligible,True)
            proof=composition.require_current()
            self.assertNotIn('hostChallenge',json.loads(proof.handoff)['payload'])
            self.assertNotIn('hostChallenge',json.loads(proof.canonical))
            self.assertIs(composition._handoff.host_eligible,False)
            composition.prepare_browser()
            self.assertNotIn('hostChallenge',composition._handoff.payload)
            self.assertIs(composition._handoff.host_eligible,False)

    def test_v1_host_challenge_excluded_from_stable_digest_but_macd(self):
        # P6: hostChallenge is MAC-covered but outside the stable topology digest.
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            first=composition.begin(TEST_HOST_CHALLENGE)
            second=composition.host_current(OTHER_HOST_CHALLENGE)
            internal=composition.require_current()
            self.assertEqual(first.topology_digest,second.topology_digest)
            self.assertEqual(first.topology_digest,internal.topology_digest)
            self.assertEqual(t.verify_bootstrap_handoff_v1(second.handoff,h.expected,h.binding)
                             .get('hostChallenge'),OTHER_HOST_CHALLENGE)
            tampered=json.loads(second.handoff)
            tampered['payload']['hostChallenge']=TEST_HOST_CHALLENGE
            with self.assertRaisesRegex(t.TopologyError,'^HANDOFF_DENIED$'):
                t.verify_bootstrap_handoff_v1(t._canonical(tampered).decode('ascii'),
                                              h.expected,h.binding)

    def test_v1_handoff_mac_uses_topology_admission_key(self):
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            proof=composition.begin(TEST_HOST_CHALLENGE)
            envelope=json.loads(proof.handoff)
            body=t.BOOTSTRAP_HANDOFF_DOMAIN+t._canonical(envelope['payload'])
            capability=h.expected.capability
            # Independent C3 derivation; the module function must agree with it.
            derived=hmac.new(capability,b'acceptance:key-derivation:v1\0topology-admission\0',
                             hashlib.sha256).digest()
            self.assertEqual(c.derive_channel_key(capability,'topology-admission'),derived)
            self.assertEqual(envelope['mac'],hmac.new(derived,body,hashlib.sha256).hexdigest())
            raw_mac=hmac.new(capability,body,hashlib.sha256).hexdigest()
            self.assertNotEqual(envelope['mac'],raw_mac)
            self.assertEqual(t.verify_bootstrap_handoff_v1(proof.handoff,h.expected,h.binding)
                             .get('hostChallenge'),TEST_HOST_CHALLENGE)
            raw=dict(envelope,mac=raw_mac)
            with self.assertRaisesRegex(t.TopologyError,'^HANDOFF_DENIED$'):
                t.verify_bootstrap_handoff_v1(t._canonical(raw).decode('ascii'),
                                              h.expected,h.binding)

    def test_v1_proxy_initializer_carries_derived_vsock_key_only(self):
        # P10/R6 (C3): _activate_proxy passes derive(capability,'vsock-stream') to the proxy entry
        # as an explicit argument; the PROXY initializer carries it as vsockKey (64 lowercase hex)
        # and the serving proxy holds only that key, never the run capability.
        h=self.Harness(self);composition,stack=h.build()
        capability=h.expected.capability
        derived=hmac.new(capability,b'acceptance:key-derivation:v1\0vsock-stream\0',hashlib.sha256).digest()
        # The entry's arguments, recorded before any proxy runs.
        seen=[]
        class Recorded(Exception):pass
        def record(*args):seen.append(args);raise Recorded()
        composition._proxy_entry=record
        with stack,self.assertRaises(Exception):composition.begin(TEST_HOST_CHALLENGE)
        self.assertEqual(len(seen),1)
        self.assertEqual(len(seen[0]),4)
        self.assertEqual(seen[0][3],derived)
        self.assertNotIn(capability,[arg for arg in seen[0] if type(arg) is bytes])
        # End to end: the bootstrap's own initializer frame on the original PROXY FD3
        # (E4: the bootstrap carries the key into the child) and the child's binding.
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE)
            self.assertEqual(h.proxy_entry_args[3],derived)
            initializer=h.proxy_channel.writes[0]
            self.assertEqual(int.from_bytes(initializer[:2],'big'),len(initializer)-2)
            initial=json.loads(initializer[2:])
            self.assertEqual((initial['version'],initial['kind']),(2,'PROXY_COMPOSITION_INIT'))
            self.assertEqual(initial['channelKeyHex'],h.roles._keys['PROXY'].hex())
            boot=initial['proxyBootstrap']
            self.assertEqual(boot['vsockKey'],derived.hex())
            self.assertNotIn('capability',boot)
            self.assertNotIn(capability.hex(),initializer.decode('ascii'))
            binding=h.proxy_harness.owners[0]._config.binding
            self.assertEqual(binding.vsock_key,derived)
            self.assertFalse(hasattr(binding,'capability'))
            self.assertEqual(h.expected.proxy_policy.binding.vsock_key,derived)
        # The topology authority admits a proxy policy only with exactly that derived key.
        for name,key in (('capability',capability),
                         ('topology-admission',c.derive_channel_key(capability,'topology-admission')),
                         ('other-capability',c.derive_channel_key(b'8'*32,'vsock-stream'))):
            with self.subTest(key=name):
                run=dataclasses.replace(h.proxy_run,vsock_key=key)
                policy=t._PROXY.qualify_native_admission(run,
                    {'FRONTEND':'frontend.example','BACKEND':'backend.example'},1024,1000,10000,
                    runtime_identity='e'*64,role_policy_identity=h.binding.rolePolicyDigest,
                    handoff_validator=lambda value:value)
                with self.assertRaisesRegex(t.TopologyError,'^AUTHORITY_DENIED$'):
                    t.qualify_topology_authority(run_id=h.binding.runId,
                        manifest_identity=h.binding.manifestDigest,config_identity=h.binding.configIdentity,
                        expires_at=h.expected.expires_at,capability=capability,
                        role_launches=h.expected.role_launches,proxy_policy=policy,clock=h.clock,
                        appliance_recheck=lambda:None)

    def test_v1_guest_observation_window_is_100ms_with_advancing_clock(self):
        # T10-7 with an advancing guest clock: every read advances 1 ms, and the
        # closing event barrier ends gap-1 ms after `observed` (whatever it reads
        # itself), so the next read, `final`, is exactly gap ms after `observed`.
        for gap,admitted in ((99,True),(100,True),(101,False)):
            with self.subTest(gap=gap):
                h=self.Harness(self,expires_at=self.LONG_LIVED_EXPIRES_MS)
                composition,stack=h.build();clock=h.clock
                def sample(clock=clock):
                    clock.wall+=1;clock.mono+=1;return clock.wall,clock.mono
                clock.sample=sample
                barrier=t.BootstrapEventOwner.barrier
                def slow_barrier(owner,clock=clock,gap=gap):
                    wall,mono=clock.wall,clock.mono;value=barrier(owner)
                    clock.wall,clock.mono=wall+gap-1,mono+gap-1;return value
                windows=[];payload=t._payload
                def measured(snapshot,expected,observed,final):
                    windows.append((final[0]-snapshot.observed_wall,
                                    final[1]-snapshot.observed_monotonic))
                    return payload(snapshot,expected,observed,final)
                stack.enter_context(mock.patch.object(t.BootstrapEventOwner,'barrier',slow_barrier))
                stack.enter_context(mock.patch.object(t,'_payload',side_effect=measured))
                with stack:
                    if admitted:
                        try:composition.begin(TEST_HOST_CHALLENGE)
                        except t.TopologyError as error:
                            self.fail('%d ms guest window denied: %s'%(gap,error))
                        self.assertEqual(composition._state,'ADMITTED')
                    else:
                        with self.assertRaisesRegex(t.TopologyError,'^BINDING_DENIED$'):
                            composition.begin(TEST_HOST_CHALLENGE)
                        self.assertTrue(composition._terminal)
                    self.assertEqual(windows,[(gap,gap)])

    def test_v1_exchange_directory_is_created_only_when_explicitly_requested(self):
        target = os.environ.get('BOOTSTRAP_V1_EXCHANGE')
        if target is None:
            return
        self.assertFalse(Path(target).exists(), 'exchange must start absent')
        Path(target).mkdir(parents=False)
        def actual_forwarder(cancel_at=None):
            forwarder=confinement_fixture.c
            captured=[];original_bind=forwarder.bind_original_roles
            def bind(config,binding,budget):
                write=config.kernel.write_role
                def capture_write(owned,data):
                    captured.append(bytes(data));return write(owned,data)
                config.kernel.write_role=capture_write
                return original_bind(config,binding,budget)
            case=confinement_fixture.V1RoleTests(methodName='runTest')
            with mock.patch.object(forwarder,'bind_original_roles',side_effect=bind):
                roles,k,budget,proof,_,init=case.setup_roles()
            received=[];read=k.read_role
            def capture_read(owned,remaining):
                data=read(owned,remaining);received.append(bytes(data));return data
            k.read_role=capture_read
            controller=init['CONTROLLER'];rows=controller['roles']
            browser=next(row for row in rows if row['role']=='BROWSER')
            key=bytes.fromhex(controller['channelKeyHex'])
            def request(sequence,action,payload):
                value=dict(version=1,binding=roles.binding.to_record(),
                    sequence=sequence,**browser,action=action,payload=payload)
                value['mac']=hmac.new(key,
                    b'acceptance:bootstrap-composition:v1\0CONTROLLER:TO_BOOTSTRAP\0'
                    +forwarder._v1_canonical(value),hashlib.sha256).hexdigest()
                return forwarder._v1_encode(value)
            controller_init=next(data for data in captured
                if json.loads(data[4:]).get('kind')=='BOOTSTRAP_INIT')
            worker_init=next(data for data in captured
                if json.loads(data[4:]).get('kind')=='BROWSER_WORKER_INIT')
            controller_adopt=request(1,'ADOPT',{})
            controller_adopt_result=roles.handle_controller(controller_adopt)
            controller_prepare=request(2,'PREPARE_BROWSER',proof)
            controller_prepare_result=roles.handle_controller(controller_prepare)
            preparation=json.loads(controller_prepare_result[4:])['payload']['result']
            controller_commit=request(3,'COMMIT_BROWSER',dict(
                grantId=preparation['grantId'],generation=1))
            if cancel_at == 'PREPARED':
                # The controller's own first-terminal end (E7); identical
                # bytes to the controller's startTerminal() end at mono 100.
                controller_final=request(3,'CANCEL',dict(generation=1,
                    cleanupEndsAtMonotonicMs=budget.clock.mono+60000))
                controller_final_result=roles.handle_controller(controller_final)
            elif cancel_at in ('REFRESH','CURRENT'):
                window,release=threading.Event(),threading.Event();errors=[]
                if cancel_at == 'REFRESH':
                    source_current=roles._source.require_current;current_calls=0
                    def pause_after_refresh():
                        nonlocal current_calls
                        current_calls+=1;value=source_current()
                        if current_calls == 2:
                            window.set()
                            if not release.wait(5):raise AssertionError('cancel window release missing')
                        return value
                    roles._source.require_current=pause_after_refresh
                else:
                    forward_write=k.write_role
                    def pause_after_current(owned,data):
                        value=json.loads(data[4:])
                        if value.get('action') == 'CURRENT':
                            captured.append(bytes(data));window.set()
                            if not release.wait(5):raise AssertionError('cancel window release missing')
                            return
                        return forward_write(owned,data)
                    k.write_role=pause_after_current
                def commit():
                    try:roles.handle_controller(controller_commit)
                    except Exception as error:errors.append(error)
                worker=threading.Thread(target=commit,daemon=True);worker.start()
                self.assertTrue(window.wait(5),cancel_at+' cancellation window absent')
                controller_final=request(4,'CANCEL',dict(generation=1,
                    cleanupEndsAtMonotonicMs=budget.clock.mono+60000))
                try:controller_final_result=roles.handle_controller(controller_final)
                finally:release.set();worker.join(5)
                self.assertFalse(worker.is_alive());self.assertEqual(len(errors),1)
            else:
                controller_final=controller_commit
                controller_final_result=roles.handle_controller(controller_final)
            sent_actions={json.loads(data[4:])['action']:data for data in captured
                          if 'action' in json.loads(data[4:])}
            received_actions={json.loads(data[4:])['action']:data for data in received}
            frames=dict(controllerInit=controller_init,workerInit=worker_init,
                controllerAdopt=controller_adopt,
                controllerAdoptResult=controller_adopt_result,
                controllerPrepare=controller_prepare,
                browserPrepare=sent_actions['PREPARE'],
                browserPrepared=received_actions['PREPARED'],
                controllerPrepareResult=controller_prepare_result)
            if cancel_at:
                if cancel_at != 'PREPARED':
                    frames.update(controllerCommit=controller_commit,
                        browserCommit=sent_actions['COMMIT'],
                        browserRefresh=received_actions['REFRESH'])
                    if cancel_at == 'CURRENT':
                        frames.update(browserCurrent=sent_actions['CURRENT'])
                frames.update(controllerCancel=controller_final,
                    browserCancel=sent_actions['CANCEL'],
                    browserCancelled=received_actions['CANCELLED'],
                    controllerCancelResult=controller_final_result)
            else:
                frames.update(controllerCommit=controller_final,
                    browserCommit=sent_actions['COMMIT'],
                    browserRefresh=received_actions['REFRESH'],
                    browserCurrent=sent_actions['CURRENT'],
                    browserStarted=received_actions['STARTED'],
                    controllerCommitResult=controller_final_result)
            order=list(frames)
            return {'binding':roles.binding.to_record(),'roles':list(rows),
                'order':order,'frames':{name:value.hex() for name,value in frames.items()},
                'frameSHA256':{name:hashlib.sha256(value).hexdigest()
                               for name,value in frames.items()}}
        success=actual_forwarder()
        cancellations={hop:actual_forwarder(hop)
                       for hop in ('PREPARED','REFRESH','CURRENT')}
        record={'version':1,'producer':'python-original-role-set-forwarder',
            'frameEncoding':'length-prefixed-canonical-ascii',
            'nominalContexts':['PYTHON_BOOTSTRAP','CONTROLLER_JS','BROWSER_WORKER_JS'],
            **success,'cancelVariants':cancellations}
        (Path(target) / 'roles.json').write_text(
            json.dumps(record, sort_keys=True, separators=(',', ':')), encoding='ascii')


if __name__ == '__main__': unittest.main()

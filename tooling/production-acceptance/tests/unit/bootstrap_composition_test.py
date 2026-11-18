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
    """Drive the actual confined child/result/cleanup code with finite OS effects."""
    def __init__(self, binding, receivers, clock, budget):
        self.events, self.clock, self.current = [], clock, None
        self.wait_status, self.scope_failure = 'EXITED', False
        self.pid, self.buffer = 200, bytearray()
        self.authority = types.SimpleNamespace(
            approve_native_fixtures=lambda config: self.authority,
            receiver_count=lambda operation: 987, # must never be trusted by v1
            foreign_pid=lambda role: 500, audit=lambda port: None,
            helper_pin=lambda name: c.ProgramPin('/opt/acceptance/tests/fixtures/' + p.HELPER_SAMPLES[name], 'f'*64),
            audit_abi_termination=lambda *args: self.authority,
            unsynchronized_thread=lambda port: None, memory=lambda value: value)
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
            raise PermissionError(1, 'inert kernel denial')
        def end(code): raise Exit(code)
        self.b = types.SimpleNamespace(monotonic=mono, sleep=lambda duration: None,
            syscall=syscall, select=lambda *args: ([31], [], []),
            pin_sample=lambda path, digest: 39, signal=types.SimpleNamespace(SIGKILL=9),
            os=types.SimpleNamespace(path=types.SimpleNamespace(lexists=lambda path: False),
                write=write, read=lambda fd, size: b'EXIT' if fd == 3 else b'ATTEMPTED\n'[:size],
                close=lambda fd: None, unlink=lambda path: None, rmdir=rmdir,
                listdir=lambda path: ['0','1','2','3','4'], readlink=lambda path: '/dev/null',
                open=lambda *args: (_ for _ in ()).throw(FileNotFoundError()),
                fork=lambda: 901, pipe2=lambda flags: (31,32), WNOHANG=1,
                waitpid=lambda pid, flags: (pid,23<<8), waitstatus_to_exitcode=lambda status: status>>8,
                kill=lambda pid, sig: self.events.append(('kill',pid)), _exit=end))
        kernel = c.NativeKernelPort(self.b)
        def spawn(launch, entry):
            self.pid += 1; self.current = launch
            owned = c.NativeOwned(self.pid, binding.runId, launch.role, object(), object())
            self.events.append(('spawn', owned))
            facts = dict(pid=self.pid, run_id=binding.runId, role=launch.role,
                uids=(launch.uid,)*3, gids=(launch.uid,)*3, groups=(), capabilities=(0,)*5,
                no_new_privs=1, seccomp=2, filter_digest=hashlib.sha256(b''.join(
                    struct.pack('<HBBI', *row) for row in launch.filter)).hexdigest(),
                fds=launch.fds, views=launch.views, waiting=False, programs=launch.programs)
            port = types.SimpleNamespace(b=self.b, launch=launch, pins={}, ready_fd=30, digest='d'*64,
                establish_views=lambda value: None, close_unaudited_fds=lambda value: None,
                drop_credentials=lambda *args: None, clear_capabilities=lambda: None,
                no_new_privs=lambda: None, install_seccomp=lambda *args: 0,
                inspect=lambda: facts)
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
        self.fixtures = p.NativeProbeFixtures(c, kernel, config, self.authority)
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
                    family.b.os.waitstatus_to_exitcode=lambda status: -9 if helper[0]=='AArch32-audit' else 23
                    family.authority.audit_abi_termination=denied
                try: p.qualify_probe_epoch(setup[0],family.fixtures,setup[3])
                except (p.ProbeFailure,p.RuntimeGateUnavailable): pass
                else: self.fail('helper '+fault+' was sealed as an attempted denial')
                self.assertTrue(hits)
                self.assertIs(family.fixtures.cleanup_budget,setup[3])
                for owner in family.fixtures.family_owners:
                    self.assertTrue(any(row[:2]==('stop',owner.owned) for row in family.events))
                self.assertLess(len(family.fixtures.family_owners),91)

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
        self.assertEqual(len(operations),91)
        for target in range(91):
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
            self.role_kernel=c.NativeKernelPort(types.SimpleNamespace())
            spawn_waiting=self.role_finite.spawn_waiting
            def spawn_identified(launch,entry):
                owned=spawn_waiting(launch,entry);owned.identity=object();return owned
            self.role_kernel.spawn_waiting=spawn_identified
            self.role_kernel.inspect=self.role_finite.inspect
            self.role_kernel.stop_owned=self.role_finite.stop_owned
            self.role_kernel.wait_owned=self.role_finite.wait_owned
            self.native_runtime={}
            def bind_runtime(handoff,lifecycle,owner,child_id,pipe_id,generation):
                index=list(c.UIDS).index(handoff.launch.role)
                rows=[dict(fd=fd,
                    kind='NULL' if fd<3 else 'COMMAND' if fd==3 else 'RESULT',
                    device='1',inode=str(index*10+fd+1),flags=0,
                    ownerId=hex(index*10+fd+1)[-1]*32,acquiredGeneration=1)
                    for fd in range(5)]
                self.native_runtime[id(handoff)]=dict(handoff=handoff,owner=owner,
                    role=handoff.launch.role,lifecycle=lifecycle,
                    childId=child_id,pipeId=pipe_id,
                    inheritedFDs=[0,1,2,3,4],currentFDs=rows)
            def runtime_lifecycle(handoff,owner):
                state=self.native_runtime[id(handoff)]
                if state['owner'] is not owner:raise c.ConfinementError('AUTHORITY_LOST')
                return state['lifecycle']
            def inspect_runtime(handoff,lifecycle,owner):
                state=self.native_runtime[id(handoff)]
                if state['owner'] is not owner or state['lifecycle']!=lifecycle:
                    raise c.ConfinementError('AUTHORITY_LOST')
                return {key:([dict(row) for row in state[key]] if key=='currentFDs'
                    else list(state[key]) if key=='inheritedFDs' else state[key])
                    for key in ('role','childId','pipeId','lifecycle','inheritedFDs','currentFDs')}
            def register_runtime(handoff,owner,endpoint,kind,generation):
                record=owner.observe_current(self.binding).to_record()
                row=next(value for value in record['currentFDs']
                         if value['fd']==endpoint.fileno())
                self.native_runtime[id(handoff)]['currentFDs'].append(dict(row))
            def commit_runtime(preparation):
                state=self.native_runtime[id(preparation._child)]
                if preparation is not preparation._roles._preparation or not preparation._committed:
                    raise c.ConfinementError('AUTHORITY_LOST')
                state['lifecycle']='BROWSER_ACTIVE'
            self.role_kernel.bind_runtime_owner=bind_runtime
            self.role_kernel.runtime_lifecycle=runtime_lifecycle
            self.role_kernel.inspect_runtime=inspect_runtime
            self.role_kernel.register_runtime_descriptor=register_runtime
            self.role_kernel._commit_browser_runtime=commit_runtime
            self.role_config=confinement_fixture.ConfinementTests().config(self.role_kernel)
            launches=tuple(c.prepare_role(role,c.RoleConfig(
                self.role_config,c.role_fds(role,self.binding.runId))) for role in c.UIDS)
            self.role_init={};self.role_queue=[];self.worker_sequence=0;self.application_to_worker=[];self.browser_prepare_payload=None
            def write_role(owned,data):
                value=json.loads(data[4:])
                if 'kind' in value:self.role_init[owned.role]=value;return
                payload=value['payload'];action=value['action']
                if action=='APP_CHUNK':
                    self.application_to_worker.append(payload);return
                self.worker_sequence+=1
                if action=='PREPARE':
                    self.browser_prepare_payload=payload
                    result_action='PREPARED';result_payload=dict(
                        requestSequence=value['sequence'],grantId=payload['grantId'],
                        reservationId='6'*32,generation=1)
                elif action=='COMMIT':result_action='REFRESH';result_payload=dict(
                    requestSequence=value['sequence'],**payload)
                elif action=='CURRENT':
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
            policy=t._PROXY.qualify_native_admission(run,
                {'FRONTEND':'frontend.example','BACKEND':'backend.example'},1024,1000,10000,
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
            self.runtime=None
            self.raw_handoffs=self.raw_endpoints=None
            self.proxy_harness=self.proxy_thread=self.proxy_release=None

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
            observe_current_roles=t.observe_current_roles
            def current_roles(handoffs,runtime_owners,proxy_owner,binding):
                proxy_rows=proxy_owner.observe_current(binding).to_record()['currentFDs']
                roles_owner=runtime_owners['CONTROLLER'];raw=[];retained=[]
                if self.raw_handoffs is None:
                    for role in c.UIDS:
                        lifecycle='SERVICE' if role in ('CONTROLLER','PROXY') else 'WAITING'
                        rowset=proxy_rows if role=='PROXY' else ()
                        handoff,kernel,_,endpoints=topology_fixture.literal_runtime_role(
                            confinement_fixture,role,lifecycle,runtime_owners[role],rowset)
                        state=kernel._runtime_owners[id(handoff)]
                        state['childId']=roles_owner._map[role]['childId']
                        state['pipeId']=roles_owner._map[role]['pipeId']
                        raw.append(handoff);retained.extend(endpoints)
                    self.raw_handoffs,self.raw_endpoints=tuple(raw),tuple(retained)
                if (self.roles._preparation is not None
                        and self.roles._preparation._committed):
                    browser=self.raw_handoffs[1]
                    browser._kernel._runtime_owners[id(browser)]['lifecycle']='BROWSER_ACTIVE'
                self.runtime=observe_current_roles(
                    self.raw_handoffs,runtime_owners,proxy_owner,binding)
                return self.runtime
            stack.enter_context(mock.patch.object(t,'observe_current_roles',side_effect=current_roles))
            stack.enter_context(mock.patch.object(proxy_fixture,'proxy',t._PROXY))
            stack.enter_context(mock.patch.object(topology_fixture,'topology',t))
            stack.enter_context(mock.patch.object(topology_fixture,'confinement',c))
            if self.binding.expiresAtMs!=190:
                # Local long-lived proxy admission matching this binding only.
                proxy_config=proxy_fixture.config
                def long_lived_config(sockets,clock=None,**changes):
                    changes.setdefault('binding',t._PROXY.RunBinding('1'*32,self.vsock_key,
                        self.binding.expiresAtMs,1,'b'*64,'a'*64,proxy_fixture.ORIGINS))
                    return proxy_config(sockets,clock,**changes)
                stack.enter_context(mock.patch.object(proxy_fixture,'config',long_lived_config))
            self.proxy_entry_args=None
            def proxy_entry(*args):
                # P10: the 4th argument is the key the proxy initializer carries as vsockKey.
                self.proxy_entry_args=args
                vsock_key=args[3] if len(args)>3 else self.vsock_key
                ready,release=threading.Event(),threading.Event();box=[]
                def sink(harness,owner):
                    self.timeline.append('proxy-loop-owner');box.append(owner);ready.set()
                    if not release.wait(5): raise AssertionError('bounded proxy loop release missing')
                expires=self.binding.expiresAtMs
                def long_lived(initial):
                    initial['binding']['expiresAtMs']=expires
                    initial['proxyBootstrap']['expiresAt']=expires
                harness=proxy_fixture.CompositionHarness(self.test,commands=[],sink=sink,
                    mutate=None if expires==190 else long_lived,vsock_key=vsock_key)
                harness.binding['expiresAtMs']=expires
                thread=threading.Thread(target=harness.run,daemon=True);thread.start()
                if not ready.wait(5): raise AssertionError('actual inherited proxy loop did not mint owner')
                self.proxy_harness,self.proxy_thread,self.proxy_release=harness,thread,release
                def finish():
                    release.set();thread.join(5)
                    if thread.is_alive(): raise AssertionError('actual proxy loop did not terminate')
                stack.callback(finish)
                self.timeline.append('proxy');return box[0]
            composition=t.compose_bootstrap_v1(binding=self.binding,expected=self.expected,
                role_config=self.role_config,fixtures=self.fixture,
                proxy_entry=proxy_entry,
                observations=self.observations,host_devices=self.host,events=self.events,
                cleanup_budget=self.budget)
            return composition,stack

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
            browser_pid=h.roles._handoffs['BROWSER'].attestation.pid
            child=browser_pid+100
            for event in (dict(number=220,pid=browser_pid,ppid=1,exit=child,
                               argument0='0',success=True),
                          dict(number=221,pid=child,ppid=browser_pid,exit=0,
                               argument0='0',success=True),
                          dict(number=93,pid=child,ppid=browser_pid,exit=0,
                               argument0='0',success=True)):
                composition._event_owner._accept_browser_transition(event)
            self.assertIsNone(composition._event_owner._browser_transition)
            with self.assertRaises(Exception):composition.commit_browser(preparation)
            self.assertTrue(composition._terminal);self.assertEqual(composition._state,'FAILED')
            self.assertEqual(composition._generation,2)
            self.assertIsNone(composition._proof);self.assertIsNone(composition._handoff)

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
                [c.OriginalRoleSet,t._PROXY.ProxyRuntimeOwner,t.BootstrapEventOwner])
            with recording(c.OriginalRoleSet),recording(t._PROXY.ProxyRuntimeOwner), \
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
            self.assertEqual(len(h.fixture.family_owners),91)
            self.assertGreaterEqual(h.clock.mono-start,91000)
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
        h=self.Harness(self);composition,stack=h.build()
        with stack:proof=composition.begin(TEST_HOST_CHALLENGE)
        self.assertEqual(h.proxy_harness.events[:3],['bind','listen','owner'])
        self.assertEqual(len(h.proxy_harness.owners),1)
        self.assertIs(type(composition._proxy_owner),t._PROXY.ProxyRuntimeOwner)
        self.assertEqual(h.proxy_harness.exit,0)
        self.assertIs(type(composition._handoff),t.BootstrapHandoffV1)
        self.assertEqual(json.loads(proof.handoff)['version'],2)
        self.assertEqual([r['role'] for r in composition._handoff.payload['composition']['roleRuntime']],list(c.UIDS))

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
        # End to end: the initializer frame and the serving proxy's own binding.
        h=self.Harness(self);composition,stack=h.build()
        with stack:
            composition.begin(TEST_HOST_CHALLENGE)
            self.assertEqual(h.proxy_entry_args[3],derived)
            boot=h.proxy_harness.initial['proxyBootstrap']
            self.assertEqual(boot['vsockKey'],derived.hex())
            self.assertNotIn('capability',boot)
            self.assertNotIn(capability.hex(),json.dumps(h.proxy_harness.initial))
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

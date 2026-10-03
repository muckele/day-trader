"""Offline composition contracts. Every kernel/channel effect here is inert."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import types
import unittest

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
p = load('bootstrap_v1_test_probes', ROOT / 'tests/guest/confinement_probe.py')


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
    def setup_epoch(self):
        self.assertTrue(callable(getattr(p, 'qualify_probe_epoch', None)), 'epoch qualification must reject incomplete families and bind independent receivers')
        binding = c.CompositionBinding(1, 'a'*32, 'b'*64, 'c'*64, 'd'*64, 'e'*32, 100000)
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
        for key, value in [('runId','0'*32), ('epoch','0'*32), ('manifestDigest','0'*64)]:
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
            calls.append((owner,duration)); setup[2].mono+=60001
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

    def test_v1_expired_cleanup_end_forbids_the_next_probe_family(self):
        setup=self.setup_epoch()
        def mutate(row):
            if row['phase']=='AFTER': setup[2].mono+=60001
            return row
        setup[1].mutate=mutate
        with self.assertRaises(p.ProbeFailure): p.qualify_probe_epoch(setup[0],setup[4].fixtures,setup[3])
        self.assertEqual(sum(event[0]=='spawn' for event in setup[4].events),1)


if __name__ == '__main__': unittest.main()

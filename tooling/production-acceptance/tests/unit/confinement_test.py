"""Offline contract tests. Linux effects exist only in the finite KernelPort below.

Breaks caught: omitted syscall/ABI restrictions, widened socket arguments,
unattested exec, incorrect UID/view/FD setup, TSYNC continuation and foreign reaping.
Numeric expectations are independently transcribed from approved Linux 6.8 /
glibc 2.39 / AAPCS64 evidence, coverage SHA256 7c8714c95a67d8a2e6c1b4c8b8481525a61976c81dfe2037c251add071ac9898.
"""
import dataclasses
import hashlib
import importlib.util
from pathlib import Path
import struct
import sys
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('acceptance_confinement', ROOT / 'guest/confinement.py')
c = None
if Path(spec.origin).exists():
    c = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = c
    spec.loader.exec_module(c)

RUN = 'a' * 32
ALLOW, DENY, KILL = 0x7fff0000, 0x00050001, 0x80000000


def evaluate(program, nr, args=(), arch=0xc00000b7):
    """Independent finite classic-BPF interpreter; no production policy helper.

    Linux seccomp_data: int nr @0, u32 arch @4, u64 ip @8, args @16.
    Only documented emitted instructions are admitted; malformed jumps fail.
    """
    data = struct.pack('<iIQ6Q', nr, arch, 0, *(tuple(args) + (0,) * (6-len(args))))
    a = 0
    pc = 0
    for _ in range(4096):
        if not 0 <= pc < len(program):
            raise AssertionError('filter has no return or an invalid jump')
        code, jt, jf, k = program[pc]
        if code == 0x20:
            if k % 4 or k > 60: raise AssertionError('invalid seccomp data load')
            a = struct.unpack_from('<I', data, k)[0]
        elif code == 0x15: pc += jt if a == k else jf
        elif code == 0x54: a &= k
        elif code == 0x06: return k
        else: raise AssertionError('unsupported BPF instruction')
        pc += 1
    raise AssertionError('unbounded filter')


class ExecBoundary(BaseException):
    pass


class Kernel:
    """Finite effect double, NOT a confinement implementation or a native adapter.

    It records supplied kernel operations; the production filter and independent
    interpreter determine syscall results. It cannot open sockets, fork or exec.
    """
    def __init__(self, tsync=0, drift=None, fail_spawn=None):
        self.tsync = tsync
        self.drift = drift or {}
        self.fail_spawn = fail_spawn
        self.children = {}
        self.stopped = []
        self.next_pid = 200

    def spawn_waiting(self, launch, entry):
        if launch.role == self.fail_spawn: raise RuntimeError('finite spawn failure')
        self.next_pid += 1
        child = ChildKernel(self, self.next_pid, launch)
        self.children[child.pid] = child
        try:
            entry(child)
        except ExecBoundary:
            return child.owned
        except c.ConfinementError:
            raise c.RoleStartFailure(child.owned) from None
        raise AssertionError('exec must not return')

    def inspect(self, pid): return dict(self.children[pid].facts, **self.drift)
    def stop_owned(self, owned, deadline):
        if owned is not self.children[owned.pid].owned: raise AssertionError('foreign child')
        self.stopped.append(owned.pid)
        return {'status': 'STOPPED', 'pid': owned.pid, 'run_id': RUN}
    def wait_owned(self, owned, deadline):
        if owned is not self.children[owned.pid].owned: raise AssertionError('foreign child')
        return {'status': 'EXITED', 'pid': owned.pid, 'run_id': RUN}


class ChildKernel:
    def __init__(self, parent, pid, launch):
        self.parent, self.pid, self.launch = parent, pid, launch
        self.events = []
        self.owned = types.SimpleNamespace(pid=pid, run_id=RUN, role=launch.role,
                                           command=object(), result=object())
        self.facts = {'pid': pid, 'run_id': RUN, 'role': launch.role,
                      'uids': (0, 0, 0), 'gids': (0, 0, 0), 'groups': (0,),
                      'capabilities': (1, 1, 1, 1, 1), 'no_new_privs': 0,
                      'seccomp': 0, 'filter_digest': '', 'fds': (),
                      'views': None, 'waiting': False, 'programs': launch.programs}
    def establish_views(self, views):
        self.events.append('views'); self.facts['views'] = views
    def close_unaudited_fds(self, fds):
        self.events.append('fds'); self.facts['fds'] = fds
    def drop_credentials(self, uid, gid):
        self.events.append('credentials'); self.facts.update(uids=(uid,)*3, gids=(gid,)*3, groups=())
    def clear_capabilities(self):
        self.events.append('caps'); self.facts['capabilities'] = (0,)*5
    def inspect_programs(self):
        data = (('node/bin/node', b'synthetic-node'), ('python/bin/python3', b'synthetic-python'),
                ('chromium/chrome', b'synthetic-chrome'))
        runtime = tuple(c.ProgramPin('/opt/acceptance/runtime/'+p,hashlib.sha256(v).hexdigest()) for p,v in data)
        workers = tuple(c.ProgramPin('/opt/acceptance/guest/'+p,hashlib.sha256(v).hexdigest()) for p,v in (
            ('controller.cjs', b'controller'), ('browser-worker.cjs', b'browser'),
            ('verifier.cjs', b'verifier'), ('proxy.py', b'proxy')))
        return runtime+workers
    def no_new_privs(self):
        self.events.append('nnp'); self.facts['no_new_privs'] = 1
    def install_seccomp(self, program, flags):
        self.events.append(('filter', flags))
        if self.parent.tsync == 0:
            self.facts.update(seccomp=2, filter_digest=hashlib.sha256(b''.join(struct.pack('<HBBI', *i) for i in program)).hexdigest())
        return self.parent.tsync
    def inspect(self): return dict(self.facts, **self.parent.drift)
    def exec_pinned(self, argv, programs):
        self.events.append(('exec', argv, programs)); self.facts['waiting'] = True
        raise ExecBoundary()


class ConfinementTests(unittest.TestCase):
    def api(self):
        self.assertIsNotNone(c, 'Task 8 confinement behavior is absent')
        return c
    def config(self, kernel=None, **changes):
        m = self.api()
        # Synthetic pins from literal bytes; no upstream executable is loaded.
        programs = tuple(m.ProgramPin(path, hashlib.sha256(data).hexdigest()) for path, data in (
            ('/opt/acceptance/runtime/node/bin/node', b'synthetic-node'),
            ('/opt/acceptance/runtime/python/bin/python3', b'synthetic-python'),
            ('/opt/acceptance/runtime/chromium/chrome', b'synthetic-chrome'),
            ('/opt/acceptance/guest/controller.cjs', b'controller'),
            ('/opt/acceptance/guest/browser-worker.cjs', b'browser'),
            ('/opt/acceptance/guest/verifier.cjs', b'verifier'),
            ('/opt/acceptance/guest/proxy.py', b'proxy')))
        return m.BootstrapConfig(kernel or Kernel(), RUN, programs, **changes)
    def test_vsock_browser_controller_verifier_denied(self):
        for role in ('BROWSER', 'CONTROLLER', 'VERIFIER'):
            for nr in (198, 199):
                self.assertEqual(evaluate(self.api().build_filter(role), nr, (40, 1, 0)), DENY)
    def test_child_fork_exec_network_gpu_crash_helper_inherits(self):
        h = self.api().start_roles(self.config())
        browser = h['BROWSER']
        p = browser.launch.filter
        for kind in ('parent', 'fork', 'exec', 'network', 'gpu', 'crash'):
            with self.subTest(descendant=kind):
                self.assertEqual(evaluate(p, 198, (40, 1, 0)), DENY)
        self.assertEqual(evaluate(p, 220, (17,)), ALLOW)
        self.assertEqual(evaluate(p, 221), ALLOW)
        self.assertEqual(browser.attestation.capabilities, (0,)*5)
    def test_proxy_fixed_vsock_positive(self):
        m = self.api()
        self.assertEqual(evaluate(m.build_filter('PROXY'), 198, (40, 1, 0)), ALLOW)
        self.assertEqual(m.proxy_endpoint(), (2, 4050))
        self.assertEqual(evaluate(m.build_filter('PROXY'), 199, (40, 1, 0)), DENY)
    def test_socket_domain_type_protocol_and_high_words(self):
        p = self.api().build_filter('BROWSER')
        for nr in (198,199):
            for args in ((1,1,0),(1,2,0),(1,5,0),(2,1,0),(2,2,0),(10,1,0),(10,2,0),(2,1|0x80800,0)):
                self.assertEqual(evaluate(p,nr,args),ALLOW, args)
            for args in ((17,1,0),(16,2,0),(41,1,0),(2,3,0),(1,1,99),(2,1|0x1000,0),(1<<32|1,1,0),(2,1<<32|1,0),(2,1,1<<32)):
                self.assertEqual(evaluate(p,nr,args),DENY,args)
    def test_all_nonzero_protocol_scalars_fail_closed_without_unreviewed_constants(self):
        p=self.api().build_filter('BROWSER')
        for nr in (198,199):
            for family,kind in ((1,1),(1,2),(1,5),(2,1),(2,2),(10,1),(10,2)):
                self.assertEqual(evaluate(p,nr,(family,kind,0)),ALLOW)
                for nonzero in (1,6,17,123,0xffffffff,1<<32):
                    self.assertEqual(evaluate(p,nr,(family,kind,nonzero)),DENY,(nr,family,kind,nonzero))
    def test_io_uring_setup_register_enter_and_inherited_ring_denied(self):
        for role in ('CONTROLLER','BROWSER','VERIFIER','PROXY'):
            for nr in (425,426,427):
                self.assertEqual(evaluate(self.api().build_filter(role),nr,(9,)),DENY)
        config = self.config()
        with self.assertRaises(c.ConfinementError):
            c.prepare_role('BROWSER',c.RoleConfig(config, (c.Descriptor(7,'io_uring','ring','BROWSER',RUN),)))
    def test_alternate_ABI_denied(self):
        p = self.api().build_filter('BROWSER')
        for arch in (0x40000028,0xc000003e,0,0x800000b7):
            self.assertEqual(evaluate(p,198,(1,1,0),arch),KILL)
        self.assertEqual(evaluate(p,-1),KILL)
        self.assertEqual(evaluate(p,0x400000c6,(1,1,0)),KILL)
    def test_SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied(self):
        m = self.api()
        for nr in (117,270,271,438,434):
            self.assertEqual(evaluate(m.build_filter('BROWSER'),nr),DENY)
        with self.assertRaises(m.ConfinementError): m.validate_channel_message(b'fixed',((1,1,b'fd'),),0)
        with self.assertRaises(m.ConfinementError): m.validate_channel_message(b'fixed',(),8)
        browser = m.start_roles(self.config())['BROWSER']
        self.assertEqual(browser.attestation.views.visible_roles,('BROWSER',))
        self.assertFalse(browser.attestation.views.console)
        self.assertEqual(browser.attestation.views.private_mode,0o700)
    def test_privilege_gain_denied(self):
        for nr in (91,146,147,144,149,159,151,152,268,40,41,51,33):
            self.assertEqual(evaluate(self.api().build_filter('BROWSER'),nr),DENY,nr)
        for args in ((47,2,0),(38,0),(8,1),(28,0),(22,0)):
            self.assertEqual(evaluate(c.build_filter('BROWSER'),167,args),DENY)
        for args in ((39,),(21,),(4,0),(38,1)):
            self.assertEqual(evaluate(c.build_filter('BROWSER'),167,args),ALLOW)
    def test_chromium_inner_filter_tightening_preserved_without_listener(self):
        p=self.api().build_filter('BROWSER')
        self.assertEqual(evaluate(p,167,(22,2,1234)),ALLOW)
        for args in ((1,0,1234),(1,1,1234)):
            self.assertEqual(evaluate(p,277,args),ALLOW)
        for args in ((0,0,1234),(1,8,1234),(1,9,1234),(1,16,1234),(1<<32|1,0,1234),(1,1<<32,1234)):
            self.assertEqual(evaluate(p,277,args),DENY,args)
        # An added inner policy cannot override the outer AF_VSOCK denial.
        self.assertEqual(evaluate(p,198,(40,1,0)),DENY)
    def test_no_console_or_bridge_fd(self):
        m = self.api()
        for kind in ('console','tty','vsock','bridge','socket','io_uring'):
            with self.subTest(kind=kind):
                with self.assertRaises(m.ConfinementError):
                    m.prepare_role('BROWSER',m.RoleConfig(self.config(),(m.Descriptor(3,kind,'command','CONTROLLER',RUN),)))
    def test_bootstrap_arbitrary_argv_denied(self):
        m=self.api()
        with self.assertRaises(m.ConfinementError):
            m.prepare_role('BROWSER',m.RoleConfig(self.config(),m.role_fds('BROWSER',RUN),argv=('/bin/sh','-c','echo')))
        with self.assertRaises(m.ConfinementError): m.prepare_role('ROOT',m.RoleConfig(self.config(),()))
    def test_TSYNC_failure_abort(self):
        for failure in (-1,901,True):
            k=Kernel(tsync=failure)
            with self.assertRaises(self.api().ConfinementError): c.start_roles(self.config(k))
            self.assertFalse(any(any(isinstance(e,tuple) and e[0]=='exec' for e in child.events) for child in k.children.values()))
            self.assertEqual(k.stopped,[201])
    def test_exact_fd_inventory(self):
        m=self.api()
        h=m.start_roles(self.config())
        self.assertEqual(tuple(h),('CONTROLLER','BROWSER','VERIFIER','PROXY'))
        for role,uid in (('CONTROLLER',10001),('BROWSER',10002),('VERIFIER',10003),('PROXY',10004)):
            a=h[role].attestation
            self.assertEqual(a.uids,(uid,)*3)
            self.assertEqual(a.gids,(uid,)*3)
            self.assertEqual(tuple((f.fd,f.kind,f.purpose) for f in a.fds),((0,'null','stdin'),(1,'null','stdout'),(2,'null','stderr'),(3,'pipe','command'),(4,'pipe','result')))
        k=Kernel(drift={'fds':()})
        with self.assertRaises(m.ConfinementError): m.start_roles(self.config(k))
    def test_attestation_drift_aborts_and_reaps_only_owned_children(self):
        m=self.api()
        for drift in ({'uids':(0,0,0)},{'capabilities':(0,0,0,1,0)},{'no_new_privs':0},{'seccomp':0},{'run_id':'b'*32},{'filter_digest':'0'*64}):
            k=Kernel(drift=drift)
            with self.assertRaises(m.ConfinementError): m.start_roles(self.config(k))
            self.assertEqual(k.stopped,[201])
        k=Kernel(fail_spawn='VERIFIER')
        with self.assertRaises(m.ConfinementError): m.start_roles(self.config(k))
        self.assertEqual(k.stopped,[202,201])
    def test_exec_order_and_fixed_hash_identity(self):
        m=self.api(); k=Kernel(); h=m.start_roles(self.config(k))
        for child in k.children.values():
            self.assertEqual(child.events[:6],['views','fds','credentials','caps','nnp',('filter',1)])
            self.assertEqual(child.events[-1][0],'exec')
            self.assertEqual(child.events[-1][1][-1],'--inherited')
        self.assertEqual(h['BROWSER'].launch.argv,('/opt/acceptance/runtime/node/bin/node','/opt/acceptance/guest/browser-worker.cjs','--inherited'))
        bad=dataclasses.replace(self.config(),programs=())
        with self.assertRaises(m.ConfinementError): m.start_roles(bad)
        bad=dataclasses.replace(self.config(),programs=(m.ProgramPin('/opt/acceptance/runtime/node/bin/node','0'*64),)+self.config().programs[1:])
        with self.assertRaises(m.ConfinementError): m.start_roles(bad)
    def test_exit_handle_bound_to_run_and_owned_child(self):
        m=self.api(); k=Kernel(); h=m.start_roles(self.config(k))
        self.assertEqual(h['BROWSER'].wait_exit(100),{'status':'EXITED','pid':202,'run_id':RUN})
        self.assertEqual(h['VERIFIER'].stop_owned(100),{'status':'STOPPED','pid':203,'run_id':RUN})
        with self.assertRaises(m.ConfinementError): h['BROWSER'].wait_exit(True)
        with self.assertRaises(m.ConfinementError): m.inspect_role(999,kernel=k)
    def test_no_effect_port_default(self):
        with self.assertRaises(self.api().ConfinementError): c.start_roles(dataclasses.replace(self.config(),kernel=None))
    def test_descriptor_boolean_and_view_type_confusion_denied(self):
        m=self.api(); fds=m.role_fds('BROWSER',RUN)
        bad=(fds[0],dataclasses.replace(fds[1],fd=True),*fds[2:])
        with self.assertRaises(m.ConfinementError): m.prepare_role('BROWSER',m.RoleConfig(self.config(),bad))
        k=Kernel(drift={'views':dataclasses.replace(m.RoleViews('CONTROLLER','/run/acceptance/controller',('CONTROLLER',)),console=0)})
        with self.assertRaises(m.ConfinementError): m.start_roles(self.config(k))
    def test_owned_exit_rechecks_attestation_and_sanitizes_outcomes(self):
        m=self.api(); k=Kernel(); h=m.start_roles(self.config(k))['BROWSER']
        k.drift={'uids':(0,0,0)}
        with self.assertRaises(m.ConfinementError): h.wait_exit(100)
        k.drift={}; k.wait_owned=lambda owned,deadline:{'status':'EXITED','pid':owned.pid,'run_id':'b'*32}
        with self.assertRaises(m.ConfinementError): h.wait_exit(100)
    def test_probe_contract_requires_attempt_and_no_receiver_delivery(self):
        probe_path=ROOT/'tests/guest/confinement_probe.py'
        self.assertTrue(probe_path.exists(),'Task8 probe attempt validation is absent')
        s=importlib.util.spec_from_file_location('task8_probe_contract',probe_path)
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        expected=('vsock_browser_controller_verifier_denied','child_fork_exec_network_gpu_crash_helper_inherits',
                  'proxy_fixed_vsock_positive','io_uring_setup_register_enter_and_inherited_ring_denied',
                  'alternate_ABI_denied','SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied',
                  'privilege_gain_denied','no_console_or_bridge_fd','bootstrap_arbitrary_argv_denied',
                  'TSYNC_failure_abort','exact_fd_inventory')
        self.assertEqual(tuple(probe.PROBES),expected)
        # Fake probe observations exercise only result validation, never native qualification.
        port=types.SimpleNamespace(attempt=lambda case:tuple({'operation':op,'attempted':True,'denied':True,'receiver_count':0} for op in case.operations))
        self.assertEqual(len(probe.run_case('vsock_browser_controller_verifier_denied',port)),6)
        port.attempt=lambda case:tuple({'operation':op,'attempted':False,'denied':True,'receiver_count':0} for op in case.operations)
        with self.assertRaises(probe.ProbeFailure): probe.run_case('vsock_browser_controller_verifier_denied',port)
        port.attempt=lambda case:tuple({'operation':op,'attempted':True,'denied':True,'receiver_count':1} for op in case.operations)
        with self.assertRaises(probe.ProbeFailure): probe.run_case('vsock_browser_controller_verifier_denied',port)
    def test_probe_proxy_positive_requires_actual_delivery(self):
        p=ROOT/'tests/guest/confinement_probe.py'
        self.assertTrue(p.exists(),'Task8 proxy probe result validation is absent')
        s=importlib.util.spec_from_file_location('task8_proxy_probe_contract',p)
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        port=types.SimpleNamespace(attempt=lambda case:({'operation':'PROXY.fixed-vsock-CID2-port4050','attempted':True,'denied':False,'receiver_count':0},))
        with self.assertRaises(probe.ProbeFailure): probe.run_case('proxy_fixed_vsock_positive',port)
        port.attempt=lambda case:({'operation':'PROXY.fixed-vsock-CID2-port4050','attempted':True,'denied':False,'receiver_count':1},)
        self.assertEqual(len(probe.run_case('proxy_fixed_vsock_positive',port)),1)


if __name__ == '__main__': unittest.main()

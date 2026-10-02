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


class InertBindings:
    """No host imports/calls. Sentinel names deliberately are not Linux numbers."""
    def __init__(self):
        self.calls=[]; self.clock=0; self.answer=0
        def record(name):
            def call(*args):
                self.calls.append((name,args))
                if name=='waitpid': return (0,0)
                if name=='getpid': return 201
            return call
        self.os=types.SimpleNamespace(**{n:record(n) for n in
            ('waitpid','waitstatus_to_exitcode','kill','execve','close','dup2','set_inheritable','getpid','setsid')},WNOHANG=object())
        self.signal=types.SimpleNamespace(SIGKILL=object())
        self.resource=types.SimpleNamespace(RLIMIT_CORE=object(),RLIMIT_NOFILE=object(),setrlimit=record('setrlimit'))
        self.syscall=self.invoke
        self.monotonic=lambda:self.clock
        self.sleep=self.advance
    def invoke(self,nr,*args): self.calls.append((nr,args)); return self.answer
    def advance(self,seconds): self.clock+=seconds


def helper_branch(launch,fault,cleanup='reaped'):
    """Run real helper control flow over finite inert process/pipe effects.

    Fixed original child701, foreign999. No real fork, signal, FD or wait.
    Faults happen before the named effect. An exit sentinel ends simulation.
    """
    b=InertBindings(); events=[]; failed=False; signalled=False
    pairs=iter(((20,21),(22,23),(24,25),(26,27))); forks=iter((0,701))
    def fail_once(stage):
        nonlocal failed
        if fault==stage and not failed:
            failed=True
            if stage=='lost-child': raise ChildProcessError('inert ownership lost')
            raise OSError('inert '+stage+' fault')
    def syscall(nr,*args): events.append(('syscall',nr,args)); fail_once('before-inner')
    def fork():
        value=next(forks)
        if value==701: fail_once('inner-fork')
        events.append(('fork',value)); return value
    def close(fd):
        if fd==19: fail_once('pin-close')
    def setup(fd,blocking): events.append(('setup',fd,blocking)); fail_once('stop-setup')
    def select(read,write,error,timeout):
        events.append(('select',tuple(read),timeout)); fail_once('stop-select'); return ([24],[],[])
    def read(fd,size): events.append(('read',fd,size)); fail_once('stop-read'); return b'STOP'
    def kill(pid,sig):
        nonlocal signalled
        events.append(('kill',pid,sig)); signalled=True
        if cleanup=='kill-error': raise OSError('inert kill failure')
        if cleanup=='kill-unexpected': raise RuntimeError('inert interrupted kill boundary')
    def wait(pid,flags):
        events.append(('waitpid',pid,flags))
        if flags is not b.os.WNOHANG: raise AssertionError('helper wait must remain bounded/nonblocking')
        fail_once('wait'); fail_once('lost-child')
        if fault=='natural-exit': return (701,0)
        if signalled:
            if cleanup=='reaped': return (701,0)
            if cleanup=='lost-child': raise ChildProcessError('inert cleanup ownership lost')
            if cleanup=='wait-error': raise OSError('inert cleanup wait failure')
        return (0,0)
    def leave(code):
        # Real _exit cannot return/throw. Record only its first semantic exit;
        # the sentinel may traverse broad handlers while ending this simulation.
        if not any(e[0]=='exit' for e in events): events.append(('exit',code))
        raise ExecBoundary()
    b.check_appliance=lambda:None; b.pin_programs=lambda pins:{c.NODE:19}
    b.os.pipe2=lambda flags:next(pairs); b.os.fork=fork; b.os.close=close
    b.os.set_blocking=setup; b.os.read=read; b.os.kill=kill; b.os.waitpid=wait; b.os._exit=leave
    b.syscall=syscall; b.select=select
    try: c.NativeKernelPort(b).spawn_waiting(launch,lambda port:None)
    except ExecBoundary: pass
    return b,events


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
    def observed_native(self,drift=None):
        b=InertBindings(); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        base='/proc/300'; readonly=('opt','usr','lib','lib64','etc')
        files={base+'/status':b'Uid:\t10002 10002 10002 10002\nGid:\t10002 10002 10002 10002\nGroups:\nCapEff:\t0\nCapPrm:\t0\nCapInh:\t0\nCapAmb:\t0\nCapBnd:\t0\nNoNewPrivs:\t1\nSeccomp:\t2\n',
               base+'/fdinfo/3':b'flags:\t00\n',base+'/fdinfo/4':b'flags:\t01\n',
               base+'/cmdline':b'/opt/acceptance/runtime/node/bin/node\0/opt/acceptance/guest/browser-worker.cjs\0--inherited\0'}
        mounts=''.join('1 0 0:1 / /'+d+' '+('rw' if drift=='readonly' and d=='opt' else 'ro')+' - ext4 base ro\n' for d in readonly)
        mounts+=''.join('1 0 0:2 / /'+d+' rw - '+('ext4' if drift=='tmpfs' else 'tmpfs')+' base rw\n' for d in ('tmp','var','run/acceptance/browser','dev/shm'))
        files[base+'/mountinfo']=mounts.encode()
        b.read_file=lambda path,*a:files[path]; b.run_device=2
        b.os.listdir=lambda path:['0','1','2','3','4'] if path==base+'/fd' else ['null','shm'] if path==base+'/root/dev' else ['browser']
        def link(path):
            if '/fd/' in path: return '/dev/null' if path[-1] in '012' else 'pipe:[30]' if path[-1]=='3' else 'pipe:[40]'
            return ('user:[1]' if path.endswith('/user') else ('pid:[1]' if path.startswith('/proc/self') else 'pid:[20]') if path.endswith('/pid') else ('mnt:[1]' if path.startswith('/proc/self') else 'mnt:[20]'))
        b.os.readlink=link
        b.os.stat=lambda path:types.SimpleNamespace(st_dev=1 if path.endswith('/exe') or path.endswith('/root') or path.endswith('/.root') else 2,
            st_ino=999 if path.endswith('/exe') else 555,st_mode=0o700,st_uid=10002,st_gid=10002)
        k=c.NativeKernelPort(b); owned=c.NativeOwned(300,RUN,'BROWSER',object(),object())
        k._owned[owned]={'outer':200,'child':300,'terminal':None,'launch':launch,'digest':'e'*64,
            'links':('pipe:[30]','pipe:[40]'),'exec_identity':(1,777)}
        return k
    def test_R1_native_live_readonly_or_tmpfs_drift_denies_attestation(self):
        for drift in ('readonly','tmpfs'):
            with self.subTest(drift=drift), self.assertRaisesRegex(c.ConfinementError,'VIEW_DENIED'):
                self.observed_native(drift).inspect(300)
    def test_R1_native_actual_executable_inode_must_match_held_pin(self):
        with self.assertRaisesRegex(c.ConfinementError,'PROGRAM_DENIED'): self.observed_native().inspect(300)
    def test_R1_native_observation_conforms_to_public_KernelPort_fact_shape(self):
        k=self.observed_native()
        next(iter(k._owned.values()))['exec_identity']=(1,999)
        a=c.inspect_role(300,kernel=k)
        self.assertEqual((a.pid,a.role,a.uids,a.capabilities,a.no_new_privs,a.seccomp),(300,'BROWSER',(10002,)*3,(0,)*5,1,2))
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
        self.assertEqual(h.stop_owned(100),{'status':'STOPPED','pid':202,'run_id':RUN})
        self.assertEqual(k.stopped,[202])
        k.drift={}; k.wait_owned=lambda owned,deadline:{'status':'EXITED','pid':owned.pid,'run_id':'b'*32}
        with self.assertRaises(m.ConfinementError): h.wait_exit(100)
    def test_R2_owned_cleanup_survives_lost_live_process_facts(self):
        m=self.api(); k=Kernel(); h=m.start_roles(self.config(k))['BROWSER']
        def gone(pid): raise ProcessLookupError('owned role exited')
        k.inspect=gone
        self.assertEqual(h.wait_exit(100),{'status':'EXITED','pid':202,'run_id':RUN})
        self.assertEqual(h.stop_owned(100),{'status':'STOPPED','pid':202,'run_id':RUN})
        self.assertEqual(k.stopped,[202])
    def test_R4_duplicate_pid_identity_or_endpoint_aborts_without_double_reaping(self):
        m=self.api()
        for collision in ('pid','identity','command','result','cross-direction'):
            with self.subTest(collision=collision):
                class Colliding(Kernel):
                    def spawn_waiting(self,launch,entry):
                        owned=super().spawn_waiting(launch,entry)
                        if len(self.children)==1:
                            self.first=owned; owned.identity=object()
                        elif len(self.children)==2:
                            if collision=='pid': owned.pid=self.first.pid
                            if collision=='identity': owned.identity=self.first.identity
                            if collision=='command': owned.command=self.first.command
                            if collision=='result': owned.result=self.first.result
                            if collision=='cross-direction': owned.command=self.first.result
                        return owned
                    def stop_owned(self,owned,deadline):
                        self.stopped.append(id(owned))
                        return {'status':'STOPPED','pid':owned.pid,'run_id':RUN}
                k=Colliding()
                with self.assertRaises(m.ConfinementError): m.start_roles(self.config(k))
                self.assertEqual(len(k.stopped),len(set(k.stopped)))
                self.assertIn(id(k.first),k.stopped)
                self.assertEqual(len(k.stopped),1 if collision=='pid' else 2)
    def test_R4_uncertain_rollback_is_explicit(self):
        m=self.api(); k=Kernel(fail_spawn='VERIFIER')
        k.stop_owned=lambda owned,deadline:{'status':'TIMEOUT','pid':owned.pid,'run_id':RUN}
        with self.assertRaisesRegex(m.ConfinementError,'REAP_UNCERTAIN'): m.start_roles(self.config(k))
    def test_R4_late_owned_endpoint_mutation_is_rechecked_before_publication(self):
        class LateMutation(Kernel):
            def spawn_waiting(self,*args):
                owned=super().spawn_waiting(*args)
                if len(self.children)==1: self.first=owned
                if len(self.children)==2: self.first.command=owned.result
                return owned
        k=LateMutation()
        with self.assertRaises(c.ConfinementError): c.start_roles(self.config(k))
        self.assertEqual(k.stopped,[204,203,202,201])
    def test_R4_equal_numeric_endpoint_directions_cannot_alias_across_roles(self):
        class NumericEndpoints(Kernel):
            def spawn_waiting(self,*args):
                owned=super().spawn_waiting(*args)
                owned.command=int('512'); owned.result=int(str(1000+owned.pid))
                return owned
        with self.assertRaises(c.ConfinementError): c.start_roles(self.config(NumericEndpoints()))
    def test_R1_native_selection_requires_mode_runtime_identity_and_validation(self):
        self.assertTrue(hasattr(c,'select_native_kernel'),'required gated native KernelPort source absent')
        effect=[]
        factory=lambda identity:effect.append(identity)
        for mode,identity,validator in [('worker',object(),lambda x:x),('bootstrap-check',None,lambda x:x),
                                        ('bootstrap-check',object(),lambda x:None)]:
            with self.assertRaisesRegex(c.ConfinementError,'NATIVE_GATE_DENIED'):
                c.select_native_kernel(mode,runtime_identity=identity,validate_runtime=validator,bindings_factory=factory)
        self.assertEqual(effect,[])
    def test_R1_native_selector_rejects_boolean_or_unpinned_guest_identity(self):
        effects=[]
        for value in (True,object(),{'python':'unreviewed'}):
            with self.assertRaisesRegex(c.ConfinementError,'NATIVE_GATE_DENIED'):
                c.select_native_kernel('bootstrap-check',runtime_identity=value,validate_runtime=lambda x:x,
                    bindings_factory=lambda identity:effects.append(identity))
        self.assertEqual(effects,[])
    def test_R1_native_required_named_APIs_fail_closed_when_missing(self):
        self.assertTrue(hasattr(c,'_native_apis'),'Linux named stdlib API validation absent')
        b=InertBindings()
        b.os.path=types.SimpleNamespace(isfile=lambda path:True,lexists=lambda path:False)
        for name in ('fork','pipe2','dup','set_blocking','readlink','listdir','stat','fstat','open','read','write','makedirs','chown','chroot','chdir','getppid','rmdir','unlink','_exit'):
            setattr(b.os,name,lambda *a:None)
        c._native_apis(b.os,b.signal,b.resource)
        del b.os.WNOHANG
        with self.assertRaisesRegex(c.ConfinementError,'NATIVE_API_UNAVAILABLE'): c._native_apis(b.os,b.signal,b.resource)
    def test_R1_raw_syscall_marshalling_relocates_Linux_pointer_and_preserves_errno(self):
        self.assertTrue(hasattr(c,'LinuxBindings'),'native libc/syscall source absent')
        buffers={}; errno=[0]; calls=[]
        class Scalar:
            def __init__(self,value): self.value=value
        class Buffer:
            def __init__(self,data): self.raw=data
        def create(data,size=None):
            out=Buffer(data if size is not None else data+b'\0'); buffers[4096+len(buffers)*256]=out; return out
        def invoke(nr,*args): calls.append((nr.value,tuple(x.value for x in args))); errno[0]=1; return -1
        ct=types.SimpleNamespace(c_long=Scalar,c_ulong=Scalar,c_void_p=Scalar,create_string_buffer=create,
            addressof=lambda b:next(k for k,v in buffers.items() if v is b),set_errno=lambda n:errno.__setitem__(0,n),get_errno=lambda:errno[0])
        backend=c.LinuxBindings.__new__(c.LinuxBindings); backend._ctypes=ct; backend._libc=types.SimpleNamespace(syscall=invoke)
        header=c.NativeMemory(bytearray(b'\x01\x00'+bytes(14)),{8:c.NativeMemory(bytearray(bytes.fromhex('0600000000000080')))})
        with self.assertRaises(PermissionError) as failure: backend.syscall(277,1,1,header)
        self.assertEqual(failure.exception.errno,1)
        self.assertEqual(calls,[(277,(1,1,4352))])
        self.assertEqual(struct.unpack_from('<Q',buffers[4352].raw,8)[0],4096)
        self.assertEqual(buffers[4096].raw,bytes.fromhex('0600000000000080'))
    def test_R1_stop_retries_are_nonblocking_and_send_one_fixed_frame(self):
        b=InertBindings(); k=c.NativeKernelPort(b); owned=c.NativeOwned(201,RUN,'BROWSER',object(),object())
        k._owned[owned]={'outer':201,'stop':11,'closed':False,'terminal':None}
        b.os.write=lambda fd,data:b.calls.append(('write',(fd,data))) or 4
        k.stop_owned(owned,1); k.stop_owned(owned,1)
        self.assertEqual([x for x in b.calls if x[0]=='write'],[('write',(11,b'STOP'))])
    def test_R1_child_credentials_use_pinned_raw_ABI_and_zero_capability_layout(self):
        self.assertTrue(hasattr(c,'NativeChildPort'),'native child effects absent')
        b=InertBindings(); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        p=c.NativeChildPort(b,launch,{})
        p.drop_credentials(10002,10002); p.clear_capabilities(); p.no_new_privs()
        raw=[x for x in b.calls if type(x[0]) is int]
        self.assertEqual(raw[:2],[(159,(0,0)),(167,(47,4,0,0,0))])
        self.assertEqual(raw[2:43],[(167,(24,n,0,0,0)) for n in range(41)])
        self.assertEqual(raw[43:45],[(149,(10002,10002,10002)),(147,(10002,10002,10002))])
        nr,args=raw[45]; self.assertEqual(nr,91)
        self.assertEqual(bytes(args[0].data),bytes.fromhex('2205082000000000'))
        self.assertEqual(bytes(args[1].data),bytes(24))
        self.assertEqual(raw[-1],(167,(38,1,0,0,0)))
    def test_R1_native_filter_uses_explicit_Linux_fprog_layout_and_preserves_TSYNC_error(self):
        self.assertTrue(hasattr(c,'NativeChildPort'),'native seccomp boundary absent')
        b=InertBindings(); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        p=c.NativeChildPort(b,launch,{})
        program=((0x20,0,0,4),(0x06,0,0,0x80000000))
        b.answer=71; self.assertEqual(p.install_seccomp(program,1),71)
        nr,args=b.calls[-1]; self.assertEqual((nr,args[:2]),(277,(1,1)))
        fprog=args[2]; self.assertEqual(bytes(fprog.data),b'\x02\x00'+bytes(14))
        self.assertEqual(tuple(fprog.pointers), (8,))
        self.assertEqual(bytes(fprog.pointers[8].data),bytes.fromhex('20000000040000000600000000000080'))
        b.answer=-1; self.assertEqual(p.install_seccomp(program,1),-1)
    def test_R1_owned_reaping_uses_named_apis_no_live_attestation_or_recycled_pid(self):
        self.assertTrue(hasattr(c,'NativeKernelPort'),'native owned process boundary absent')
        b=InertBindings(); k=c.NativeKernelPort(b)
        owned=c.NativeOwned(201,RUN,'BROWSER',object(),object())
        k._owned[owned]= {'outer':201,'stop':11,'closed':False,'terminal':None}
        b.os.write=lambda fd,data:b.calls.append(('write',(fd,data))) or len(data)
        result=k.stop_owned(owned,2)
        self.assertEqual(result,{'status':'TIMEOUT','pid':201,'run_id':RUN})
        self.assertIn(('write',(11,b'STOP')),b.calls)
        self.assertIn(('waitpid',(201,b.os.WNOHANG)),b.calls)
        self.assertFalse(any(n=='kill' for n,_ in b.calls)) # only trusted direct-parent helper signals inner child
        foreign=c.NativeOwned(201,RUN,'BROWSER',object(),object())
        with self.assertRaisesRegex(c.ConfinementError,'EXIT_DENIED'): k.stop_owned(foreign,2)
        b.os.waitpid=lambda pid,flags:(pid,0)
        self.assertEqual(k.wait_owned(owned,2)['status'],'EXITED')
        b.os.waitpid=lambda *args: (_ for _ in ()).throw(AssertionError('recycled PID must not be waited'))
        self.assertEqual(k.stop_owned(owned,2)['status'],'EXITED')
    def test_R1_post_fork_parent_failure_preserves_owned_cleanup_state(self):
        self.assertTrue(hasattr(c,'NativeKernelPort'),'native spawn ownership source absent')
        b=InertBindings(); b.check_appliance=lambda:None; b.pin_programs=lambda pins:{c.NODE:19}
        pairs=iter(((20,21),(22,23),(24,25),(26,27)))
        b.os.pipe2=lambda flags:next(pairs); b.os.fork=lambda:501
        b.os.close=lambda fd: (_ for _ in ()).throw(OSError(9,'inert post-fork fault'))
        k=c.NativeKernelPort(b); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        with self.assertRaises(c.RoleStartFailure) as failure: k.spawn_waiting(launch,lambda port:None)
        self.assertEqual(k._owned[failure.exception.owned]['outer'],501)
        self.assertEqual(failure.exception.owned.run_id,RUN)
    def test_R5_handled_helper_faults_stop_and_reap_original_inner_before_exit(self):
        # Break caught: handled post-fork helper errors discard original child
        # authority; cleanup must precede the sole proven-family terminal exit.
        launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        for fault in ('pin-close','stop-setup','stop-select','stop-read','wait'):
            with self.subTest(fault=fault):
                b,events=helper_branch(launch,fault)
                self.assertEqual([e for e in events if e[0]=='kill'],[('kill',701,b.signal.SIGKILL)])
                waited=[e for e in events if e[0]=='waitpid']
                self.assertTrue(waited); self.assertTrue(all(e[1]==701 and e[2] is b.os.WNOHANG for e in waited))
                self.assertEqual([e for e in events if e[0]=='exit'],[('exit',0)])
                self.assertLess(events.index(('kill',701,b.signal.SIGKILL)),events.index(('exit',0)))
    def test_R5_failed_helper_cleanup_is_bounded_and_never_claims_family_exit(self):
        launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        for cleanup in ('timeout','kill-error','kill-unexpected','wait-error','lost-child'):
            with self.subTest(cleanup=cleanup):
                b,events=helper_branch(launch,'pin-close',cleanup)
                self.assertEqual([e for e in events if e[0]=='kill'],[('kill',701,b.signal.SIGKILL)])
                self.assertTrue(any(e[0]=='waitpid' for e in events))
                self.assertEqual([e for e in events if e[0]=='exit'],[('exit',78)])
                self.assertLessEqual(b.clock,2.01)
                if cleanup=='timeout': self.assertGreaterEqual(b.clock,2)
    def test_R5_no_inner_child_or_lost_ownership_never_signals_a_pid(self):
        launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        for fault in ('before-inner','inner-fork','lost-child'):
            with self.subTest(fault=fault):
                b,events=helper_branch(launch,fault)
                self.assertFalse(any(e[0]=='kill' for e in events))
                self.assertEqual([e for e in events if e[0]=='exit'],[('exit',78)])
                if fault!='lost-child': self.assertFalse(any(e[0]=='waitpid' for e in events))
    def test_R5_STOP_reaps_nonblocking_and_natural_exit_never_resignals_recycled_identity(self):
        launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        b,events=helper_branch(launch,'STOP')
        self.assertEqual([e for e in events if e[0]=='kill'],[('kill',701,b.signal.SIGKILL)])
        self.assertEqual([e for e in events if e[0]=='exit'],[('exit',0)])
        self.assertTrue(all(e[2] is b.os.WNOHANG for e in events if e[0]=='waitpid'))
        b,events=helper_branch(launch,'natural-exit')
        self.assertFalse(any(e[0]=='kill' for e in events))
        self.assertEqual([e for e in events if e[0]=='exit'],[('exit',0)])
    def test_R1_inner_pid_is_single_observed_direct_child_not_a_racy_shared_pipe_frame(self):
        k=c.NativeKernelPort(InertBindings())
        self.assertTrue(callable(getattr(k,'_child_pid',None)),'independent owned child PID observation absent')
        paths=[]
        k.b.read_file=lambda path,limit:paths.append((path,limit)) or b'701\n'
        self.assertEqual(k._child_pid(501),701)
        self.assertEqual(paths,[('/proc/501/task/501/children',128)])
        for data in (b'',b'701 702',b'0',b'-1',b'x'):
            k.b.read_file=lambda *args,data=data:data
            with self.assertRaisesRegex(c.ConfinementError,'ROLE_START_FAILED'): k._child_pid(501)
    def test_R1_fixed_exec_uses_verified_fd_exact_argv_and_empty_environment(self):
        self.assertTrue(hasattr(c,'NativeChildPort'),'native pinned exec absent')
        b=InertBindings(); launch=c.prepare_role('VERIFIER',c.RoleConfig(self.config(),c.role_fds('VERIFIER',RUN)))
        p=c.NativeChildPort(b,launch,{c.NODE:19})
        b.os.execve=lambda fd,argv,env: (b.calls.append(('execve',(fd,argv,env))), (_ for _ in ()).throw(ExecBoundary()))[-1]
        with self.assertRaises(ExecBoundary): p.exec_pinned(launch.argv,launch.programs)
        self.assertEqual(b.calls[-1],('execve',(19,('/opt/acceptance/runtime/node/bin/node','/opt/acceptance/guest/verifier.cjs','--inherited'),{})))
        with self.assertRaisesRegex(c.ConfinementError,'PROGRAM_DENIED'): p.exec_pinned(('/bin/sh',),launch.programs)
    def test_R1_native_mount_view_is_private_readonly_base_and_role_only_tmpfs(self):
        self.assertTrue(hasattr(c,'NativeChildPort'),'native namespace/view source absent')
        b=InertBindings(); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        b.os.makedirs=lambda path,mode,exist_ok:b.calls.append(('mkdir',(path,mode,exist_ok)))
        b.os.chroot=lambda path:b.calls.append(('chroot',(path,)))
        b.os.chdir=lambda path:b.calls.append(('chdir',(path,)))
        b.os.chown=lambda *a:b.calls.append(('chown',a))
        b.os.open=lambda *a:99
        p=c.NativeChildPort(b,launch,{})
        p.establish_views(launch.views)
        self.assertIn(('setsid',()),b.calls)
        raw=[x for x in b.calls if type(x[0]) is int]
        self.assertEqual(raw[0],(40,(None,b'/',None,278528,None)))
        # Approved storage contract: all writable paths stay on the existing
        # bounded /run tmpfs; allocating additional root tmpfs budgets is denied.
        self.assertFalse(any(args[0]==b'tmpfs' for nr,args in raw if nr==40))
        self.assertIn((40,(b'/opt',b'/run/acceptance/browser/.root/opt',None,4096,None)),raw)
        self.assertIn((40,(None,b'/run/acceptance/browser/.root/opt',None,4129,None)),raw)
        self.assertIn((40,(b'proc',b'/proc',b'proc',14,None)),raw)
        self.assertIn(('chroot',('/run/acceptance/browser/.root',)),b.calls)
    def test_R1_descriptor_close_ranges_keep_only_audited_and_CLOEXEC_pins(self):
        self.assertTrue(hasattr(c,'NativeChildPort'),'native close-range source absent')
        b=InertBindings(); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        p=c.NativeChildPort(b,launch,{c.NODE:19},ready_fd=15)
        p.close_unaudited_fds(launch.fds)
        self.assertEqual([v for v in b.calls if v[0]==436],[(436,(5,14,0)),(436,(16,18,0)),(436,(20,4294967295,0))])
        self.assertIn(('set_inheritable',(19,False)),b.calls)
    def test_R1_probe_native_socket_and_io_uring_attempts_derive_denial_from_actual_result(self):
        s=importlib.util.spec_from_file_location('task8_native_probe',ROOT/'tests/guest/confinement_probe.py')
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        self.assertTrue(hasattr(probe,'NativeProbePort'),'actual adversarial operation source absent')
        calls=[]
        class Context:
            def syscall(self,nr,*args): calls.append((nr,args)); raise PermissionError(1,'inert denial')
            def receiver_count(self): return 0
            def fd_links(self): return ('/dev/null','pipe:[100]')
        fixture=types.SimpleNamespace(run_confined=lambda role,op,attempt:attempt(Context()))
        port=probe.NativeProbePort(fixture)
        result=port.attempt(probe.PROBES['vsock_browser_controller_verifier_denied'])
        self.assertEqual(calls,[(198,(40,1,0)),(199,(40,1,0,bytearray(8)))]*3)
        self.assertTrue(all(o['denied'] and o['attempted'] for o in result))
        calls.clear(); port.attempt(probe.PROBES['io_uring_setup_register_enter_and_inherited_ring_denied'])
        self.assertEqual([nr for nr,_ in calls],[425,427,426]*4) # inherited-ring uses separate real FD witness
    def test_R1_probe_fixture_setup_failure_reaps_original_owned_family(self):
        s=importlib.util.spec_from_file_location('task8_fixture_cleanup',ROOT/'tests/guest/confinement_probe.py')
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        self.assertTrue(hasattr(probe,'NativeProbeFixtures'),'native fixture subprocess source absent')
        b=InertBindings(); k=c.NativeKernelPort(b); config=self.config(k); stopped=[]
        b.os.path=types.SimpleNamespace(lexists=lambda path:False)
        b.os.unlink=lambda path:None; b.os.rmdir=lambda path:None
        owned=c.NativeOwned(501,RUN,'BROWSER',object(),object())
        k.spawn_waiting=lambda *a: (_ for _ in ()).throw(c.RoleStartFailure(owned))
        k.stop_owned=lambda child,deadline:stopped.append(child) or {'status':'STOPPED','pid':501,'run_id':RUN}
        authority=types.SimpleNamespace(**{n:lambda *a:None for n in
            ('receiver_count','foreign_pid','audit','helper_pin','audit_abi_termination','unsynchronized_thread','memory')})
        authority.approve_native_fixtures=lambda config:authority
        fixture=probe.NativeProbeFixtures(c,k,config,authority)
        with self.assertRaises(c.RoleStartFailure): fixture.run_confined('BROWSER','BROWSER.socket-AF_VSOCK',lambda context:None)
        self.assertEqual(stopped,[owned])
        b.os.path.lexists=lambda path:True
        stopped.clear()
        with self.assertRaises(probe.RuntimeGateUnavailable): fixture.run_confined('BROWSER','BROWSER.socket-AF_VSOCK',lambda context:None)
        self.assertEqual(stopped,[]) # pre-existing/historical role scope is untouched
    def test_R1_probe_proxy_actual_connect_vector_and_delivery_witness(self):
        s=importlib.util.spec_from_file_location('task8_proxy_vector',ROOT/'tests/guest/confinement_probe.py')
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe); calls=[]
        class Context:
            def syscall(self,nr,*args): calls.append((nr,args)); return 9 if nr==198 else 5 if nr==64 else 0
            def close(self,fd): calls.append(('close',(fd,)))
            def receiver_count(self): return 1
        fixture=types.SimpleNamespace(run_confined=lambda role,op,attempt:attempt(Context()))
        probe.run_case('proxy_fixed_vsock_positive',probe.NativeProbePort(fixture))
        self.assertEqual(calls,[(198,(40,1,0)),(203,(9,bytes.fromhex('28000000d20f00000200000000000000'),16)),(64,(9,b'TASK8',5)),('close',(9,))])
    def test_R1_probe_invalid_argument_or_missing_feature_error_is_not_security_denial(self):
        s=importlib.util.spec_from_file_location('task8_probe_error',ROOT/'tests/guest/confinement_probe.py')
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        class Context:
            def syscall(self,*args): raise OSError(22,'inert EINVAL')
            def receiver_count(self): return 0
        fixture=types.SimpleNamespace(run_confined=lambda role,op,attempt:attempt(Context()))
        with self.assertRaisesRegex(probe.ProbeFailure,'UNEXPECTED_KERNEL_ERROR'):
            probe.NativeProbePort(fixture).attempt(probe.PROBES['vsock_browser_controller_verifier_denied'])
    def test_R1_probe_helper_launch_is_fixed_pinned_empty_env_and_owned_bounded(self):
        s=importlib.util.spec_from_file_location('task8_helper_exec',ROOT/'tests/guest/confinement_probe.py')
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        b=InertBindings(); effects=[]
        b.os.fork=lambda:0
        b.os.pipe2=lambda flags:(31,32)
        b.pin_sample=lambda path,sha:effects.append(('pin',path,sha)) or 19
        b.os.execve=lambda fd,argv,env: effects.append(('exec',fd,argv,env)) or (_ for _ in ()).throw(ExecBoundary())
        b.os._exit=lambda code: (_ for _ in ()).throw(ExecBoundary())
        pin=c.ProgramPin('/opt/acceptance/tests/fixtures/exec-vsock',hashlib.sha256(b'inert-approved-helper').hexdigest())
        authority=types.SimpleNamespace(helper_pin=lambda name:pin,run_fixed_helper=lambda *args:None)
        context=probe.NativeProbeContext(types.SimpleNamespace(b=b),authority,'BROWSER.exec.socket-AF_VSOCK')
        with self.assertRaises(ExecBoundary): context.helper('exec.socket-AF_VSOCK')
        self.assertEqual(effects,[('pin',pin.path,pin.sha256),('exec',19,(pin.path,),{})])
        with self.assertRaisesRegex(probe.ProbeFailure,'HELPER_DENIED'): context.helper('/bin/sh')
    def test_R1_bootstrap_probe_rejects_real_modified_launch_contract_before_effects(self):
        s=importlib.util.spec_from_file_location('task8_bootstrap_probe',ROOT/'tests/guest/confinement_probe.py')
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        b=InertBindings(); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        authority=types.SimpleNamespace(attempt_bootstrap_rejection=lambda name:None)
        ctx=probe.NativeProbeContext(c.NativeChildPort(b,launch,{}),authority,'BROWSER.arbitrary-executable'); ctx.c=c
        for name in ('arbitrary-executable','arbitrary-argv','arbitrary-uid','arbitrary-fd'):
            with self.assertRaises(PermissionError): ctx.bootstrap_rejection(name)
        self.assertEqual(b.calls,[])
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

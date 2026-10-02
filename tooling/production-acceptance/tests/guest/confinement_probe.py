"""Finite, separately gated adversarial Linux guest probes. No native default.

run_case invokes only an explicitly injected trusted ProbePort. Offline doubles
may test observation validation; their output is NOT kernel/runtime evidence.
The independently approved native harness must demonstrate each actual
attempt, denial at kernel/FD boundary, and owned receiver observation. Absence
of that harness is a failed/unavailable gate, never a skipped or mocked PASS.
"""
from collections import namedtuple
from dataclasses import replace
import json
import re
import struct
from types import MappingProxyType

ProbeCase = namedtuple('ProbeCase', 'operations denied receiver_count')

PROBES = MappingProxyType({
    'vsock_browser_controller_verifier_denied': ProbeCase(tuple(
        role+'.'+op for role in ('BROWSER','CONTROLLER','VERIFIER') for op in ('socket-AF_VSOCK','socketpair-AF_VSOCK')),True,0),
    'child_fork_exec_network_gpu_crash_helper_inherits': ProbeCase(tuple(
        'BROWSER.'+kind+'.socket-AF_VSOCK' for kind in ('parent','fork','exec','network','gpu','crash'))+
        ('CONTROLLER.helper.socket-AF_VSOCK','VERIFIER.helper.socket-AF_VSOCK'),True,0),
    'proxy_fixed_vsock_positive': ProbeCase(('PROXY.fixed-vsock-CID2-port4050',),False,1),
    'io_uring_setup_register_enter_and_inherited_ring_denied': ProbeCase(tuple(
        role+'.'+op for role in ('CONTROLLER','BROWSER','VERIFIER','PROXY') for op in
        ('io_uring_setup','io_uring_register','io_uring_enter','inherited-ring')),True,0),
    'alternate_ABI_denied': ProbeCase(('BROWSER.AArch32-audit','BROWSER.x86_64-audit','BROWSER.unknown-audit','BROWSER.alternate-syscall-entry'),True,0),
    'SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied': ProbeCase(tuple('BROWSER.'+op for op in
        ('controller-SCM_RIGHTS','proxy-SCM_RIGHTS','proc-controller-fd','proc-proxy-fd','pidfd_getfd','ptrace','process_vm_readv','process_vm_writev')),True,0),
    'privilege_gain_denied': ProbeCase(('BROWSER.setuid-helper','BROWSER.capability-file','BROWSER.initial-namespace-capability','BROWSER.setresuid-root'),True,0),
    'no_console_or_bridge_fd': ProbeCase(tuple(role+'.'+op for role in ('BROWSER','VERIFIER','PROXY') for op in
        ('dev-console-open','dev-hvc-open','proc-console-reopen','unaudited-bridge-fd')),True,0),
    'bootstrap_arbitrary_argv_denied': ProbeCase(('BROWSER.arbitrary-executable','BROWSER.arbitrary-argv','BROWSER.arbitrary-uid','BROWSER.arbitrary-fd'),True,0),
    'TSYNC_failure_abort': ProbeCase(('BOOTSTRAP.TSYNC-error','BOOTSTRAP.TSYNC-unsynchronized-tid'),True,0),
    'exact_fd_inventory': ProbeCase(tuple(role+'.exact-uid-capability-view-fd-inventory' for role in
        ('CONTROLLER','BROWSER','VERIFIER','PROXY')),False,0),
})


class ProbeFailure(ValueError):
    pass


class RuntimeGateUnavailable(RuntimeError):
    pass


def run_case(name, port):
    """Validate finite attempted-operation records; never infer native execution."""
    if name not in PROBES or not callable(getattr(port,'attempt',None)):
        raise ProbeFailure('PROBE_UNAVAILABLE')
    case = PROBES[name]
    try: observations = port.attempt(case)
    except Exception: raise ProbeFailure('PROBE_OPERATION_FAILED') from None
    if type(observations) is not tuple or len(observations) != len(case.operations):
        raise ProbeFailure('PROBE_INCOMPLETE')
    for expected, actual in zip(case.operations,observations):
        if (type(actual) is not dict or set(actual) != {'operation','attempted','denied','receiver_count'} or
            actual['operation'] != expected or actual['attempted'] is not True or actual['denied'] is not case.denied or
            type(actual['receiver_count']) is not int or actual['receiver_count'] != case.receiver_count):
            raise ProbeFailure('PROBE_BOUNDARY_FAILED')
    return observations


class NativeProbePort:
    """Execute the finite catalogue in fresh confined roles, not BPF simulation.

    Fixtures own the independent receiver and pinned executable/ABI samples.
    Missing native fixtures fail unavailable; a missing socket/invalid argument
    error is NOT reported as seccomp denial. Each attempt gets a fresh family.
    """
    def __init__(self, fixtures):
        if not callable(getattr(fixtures,'run_confined',None)): raise RuntimeGateUnavailable('NATIVE_FIXTURES_UNAVAILABLE')
        self.fixtures=fixtures

    def attempt(self,case):
        if not any(case is v for v in PROBES.values()): raise ProbeFailure('PROBE_DENIED')
        result=[]
        for operation in case.operations:
            role,_,name=operation.partition('.')
            def attempt(context,operation=operation,name=name):
                denied=False
                try: self._operation(name,context)
                except OSError as error:
                    allowed = (1,13) # EPERM / EACCES, independently pinned Linux errno
                    if name in ('dev-console-open','dev-hvc-open','proc-console-reopen',
                                'proc-controller-fd','proc-proxy-fd') and isinstance(error,FileNotFoundError): denied=True
                    if name in ('controller-SCM_RIGHTS','proxy-SCM_RIGHTS'): allowed+=(88,9) # pipe/nonexistent FD, not a donor socket
                    if not denied and error.errno not in allowed: raise ProbeFailure('UNEXPECTED_KERNEL_ERROR') from None
                    denied=True
                return {'operation':operation,'attempted':True,'denied':denied,'receiver_count':context.receiver_count()}
            result.append(self.fixtures.run_confined(role,operation,attempt))
        return tuple(result)

    def _operation(self,name,ctx):
        if name=='socket-AF_VSOCK': return ctx.syscall(198,40,1,0)
        if name=='socketpair-AF_VSOCK': return ctx.syscall(199,40,1,0,bytearray(8))
        if name=='io_uring_setup': return ctx.syscall(425,1,0)
        if name=='io_uring_register': return ctx.syscall(427,-1,0,0,0)
        if name=='io_uring_enter': return ctx.syscall(426,-1,0,0,0,0,0)
        if name=='inherited-ring':
            if any('io_uring' in link for link in ctx.fd_links()): raise ProbeFailure('INHERITED_RING_PRESENT')
            raise PermissionError(1,'FD_INVENTORY_BOUNDARY')
        if name=='fixed-vsock-CID2-port4050':
            fd=ctx.syscall(198,40,1,0)
            try:
                address=struct.pack('<HHIIB3x',40,0,4050,2,0)
                ctx.syscall(203,fd,address,16)
                if ctx.syscall(64,fd,b'TASK8',5)!=5: raise ProbeFailure('POSITIVE_DELIVERY_FAILED')
            finally: ctx.close(fd)
            return
        if name in ('ptrace','pidfd_getfd','process_vm_readv','process_vm_writev'):
            pid=ctx.foreign_pid('CONTROLLER')
            if name=='ptrace': return ctx.syscall(117,0,pid,0,0)
            if name=='pidfd_getfd': return ctx.syscall(438,-1,3,0)
            return ctx.syscall(270 if name=='process_vm_readv' else 271,pid,0,0,0,0,0)
        if name in ('proc-controller-fd','proc-proxy-fd'):
            return ctx.open_denied('/proc/'+str(ctx.foreign_pid('CONTROLLER' if name=='proc-controller-fd' else 'PROXY'))+'/fd/3')
        if name in ('controller-SCM_RIGHTS','proxy-SCM_RIGHTS'):
            # The only role command endpoint is an audited anonymous pipe.
            # Actual recvmsg on it must be ENOTSOCK, never SCM_RIGHTS acceptance.
            return ctx.syscall(212,3,0,1073741824)
        if name=='setresuid-root': return ctx.syscall(147,0,0,0)
        if name=='initial-namespace-capability':
            return ctx.syscall(91,ctx.memory(struct.pack('<II',0x20080522,0)),ctx.memory(struct.pack('<6I',1,1,0,0,0,0)))
        paths={'dev-console-open':'/dev/console','dev-hvc-open':'/dev/hvc0','proc-console-reopen':'/proc/1/fd/0'}
        if name in paths:
            if name=='proc-console-reopen':
                fd=ctx.open_denied(paths[name])
                try:
                    if ctx.fd_link(fd)!='/dev/null': raise ProbeFailure('CONSOLE_REOPENED')
                finally: ctx.close(fd)
                raise PermissionError(1,'NO_CONSOLE_NODE')
            return ctx.open_denied(paths[name])
        if name=='unaudited-bridge-fd':
            if len(ctx.fd_links())!=5: raise ProbeFailure('UNAUDITED_FD_PRESENT')
            raise PermissionError(1,'FD_INVENTORY_BOUNDARY')
        if name=='exact-uid-capability-view-fd-inventory': return ctx.audit_inventory()
        # These are actual hostile exec/ABI and bootstrap-error fixtures, not
        # numeric policy evaluation. Their fixed sample pins/results are owned
        # by the separately approved native harness. No arbitrary helper argv.
        helpers={'parent.socket-AF_VSOCK','fork.socket-AF_VSOCK','exec.socket-AF_VSOCK',
            'network.socket-AF_VSOCK','gpu.socket-AF_VSOCK','crash.socket-AF_VSOCK','helper.socket-AF_VSOCK',
            'AArch32-audit','x86_64-audit','unknown-audit','alternate-syscall-entry',
            'setuid-helper','capability-file'}
        if name in helpers: return ctx.helper(name)
        controls={'arbitrary-executable','arbitrary-argv','arbitrary-uid','arbitrary-fd',
                  'TSYNC-error','TSYNC-unsynchronized-tid'}
        if name in controls: return ctx.bootstrap_rejection(name)
        raise RuntimeGateUnavailable('NATIVE_OPERATION_UNAVAILABLE')


class NativeProbeContext:
    """Actual operations on the already-confined native child bindings.

    `witnesses` are the trusted native harness's pinned fixed helper samples,
    foreign-role identity witnesses and receiver counter, never worker claims.
    Absence is an unavailable gate. The offline doubles intentionally cannot
    establish any of these native qualification facts.
    """
    def __init__(self,port,authority,operation,confinement=None):
        self.port,self.authority,self.operation,self.c=port,authority,operation,confinement
    def syscall(self,nr,*args): return self.port.b.syscall(nr,*args)
    def memory(self,data):
        # Provided explicitly by the trusted embedding; no dynamic path import.
        return self.authority.memory(bytearray(data))
    def close(self,fd): self.port.b.os.close(fd)
    def open_denied(self,path): return self.port.b.os.open(path,32768|524288)
    def fd_link(self,fd): return self.port.b.os.readlink('/proc/self/fd/'+str(fd))
    def fd_links(self):
        fds=self.port.b.os.listdir('/proc/self/fd')
        if len(fds)>4096: raise ProbeFailure('FD_INVENTORY_LIMIT')
        out=[]
        for fd in fds:
            try: out.append(self.fd_link(int(fd)))
            except FileNotFoundError: pass # closed observer directory FD
        return tuple(out)
    def receiver_count(self):
        value=self.authority.receiver_count(self.operation)
        if type(value) is not int or not 0<=value<=1: raise ProbeFailure('RECEIVER_WITNESS_INVALID')
        return value
    def foreign_pid(self,role):
        value=self.authority.foreign_pid(role)
        if type(value) is not int or value<=0: raise RuntimeGateUnavailable('FOREIGN_IDENTITY_UNAVAILABLE')
        return value
    def audit_inventory(self): return self.authority.audit(self.port)
    def helper(self,name):
        b=self.port.b
        samples={
            'exec.socket-AF_VSOCK':'exec-vsock','network.socket-AF_VSOCK':'chromium-network-vsock',
            'gpu.socket-AF_VSOCK':'chromium-gpu-vsock','crash.socket-AF_VSOCK':'chromium-crash-vsock',
            'helper.socket-AF_VSOCK':'exec-vsock','AArch32-audit':'aarch32-syscall',
            'x86_64-audit':'x86_64-syscall','unknown-audit':'unknown-abi',
            'alternate-syscall-entry':'alternate-entry','setuid-helper':'setuid-attempt',
            'capability-file':'capability-attempt',
        }
        if name=='parent.socket-AF_VSOCK': return self.syscall(198,40,1,0)
        if name not in samples and name!='fork.socket-AF_VSOCK': raise ProbeFailure('HELPER_DENIED')
        fd=None; marker=None; pid=None; terminal=False
        try:
            if name in samples:
                pin=self.authority.helper_pin(name)
                path='/opt/acceptance/tests/fixtures/'+samples[name]
                if (pin.path!=path or type(pin.sha256) is not str or
                    re.fullmatch('[0-9a-f]{64}',pin.sha256) is None): raise ProbeFailure('HELPER_DENIED')
                fd=b.pin_sample(path,pin.sha256)
            marker=b.os.pipe2(524288)
            pid=b.os.fork()
            if pid==0:
                try:
                    b.os.close(marker[0]); b.os.dup2(marker[1],4); b.os.set_inheritable(4,True)
                    b.os.close(marker[1])
                    if fd is None:
                        b.os.write(4,b'ATTEMPTED\n')
                        try: self.syscall(198,40,1,0)
                        except OSError as error: b.os._exit(23 if error.errno==1 else 78)
                        b.os._exit(0)
                    # Close all extra endpoints, retain only pinned CLOEXEC
                    # executable. Marker FD4 cannot carry private role results.
                    b.syscall(436,5,fd-1,0); b.syscall(436,fd+1,4294967295,0)
                    b.os.set_inheritable(fd,False)
                    b.os.execve(fd,(path,),{})
                    b.os._exit(78)
                except Exception: b.os._exit(78)
            b.os.close(marker[1]); marker=(marker[0],None)
            until=b.monotonic()+2; proof=bytearray()
            while b.monotonic()<until:
                ready,_,_=b.select([marker[0]],[],[],0)
                if ready and len(proof)<10: proof.extend(b.os.read(marker[0],10-len(proof)))
                ended,status=b.os.waitpid(pid,b.os.WNOHANG)
                if ended==pid:
                    terminal=True
                    # A child may exit between select and waitpid. Drain its
                    # now-closed marker writer before interpreting termination.
                    while len(proof)<10:
                        part=b.os.read(marker[0],10-len(proof))
                        if not part: break
                        proof.extend(part)
                    code=b.os.waitstatus_to_exitcode(status)
                    if proof!=b'ATTEMPTED\n': raise ProbeFailure('HELPER_ATTEMPT_UNPROVED')
                    if code==23: raise PermissionError(1,'HELPER_BOUNDARY_DENIED')
                    if code<0 and name in ('AArch32-audit','x86_64-audit','unknown-audit','alternate-syscall-entry'):
                        if self.authority.audit_abi_termination(name,pid,status) is not self.authority: raise ProbeFailure('ABI_ATTEMPT_UNPROVED')
                        raise PermissionError(1,'ABI_BOUNDARY_DENIED')
                    if code!=0: raise ProbeFailure('HELPER_OPERATION_FAILED')
                    return
                b.sleep(0.01)
            raise ProbeFailure('HELPER_DEADLINE')
        finally:
            if pid is not None and pid>0 and not terminal:
                # Still an unreaped DIRECT child: PID reuse is impossible.
                try: b.os.kill(pid,b.signal.SIGKILL)
                except ProcessLookupError: pass
                until=b.monotonic()+2
                while b.monotonic()<until:
                    ended,_=b.os.waitpid(pid,b.os.WNOHANG)
                    if ended==pid: terminal=True; break
                    b.sleep(0.01)
                if not terminal: raise ProbeFailure('HELPER_REAP_UNCERTAIN')
            if fd is not None: b.os.close(fd)
            if marker is not None:
                for endpoint in marker:
                    if endpoint is not None:
                        try: b.os.close(endpoint)
                        except OSError: pass
    def bootstrap_rejection(self,name):
        c=self.c
        if c is None: raise RuntimeGateUnavailable('BOOTSTRAP_PROBE_UNAVAILABLE')
        launch=self.port.launch
        config=c.RoleConfig(c.BootstrapConfig(None,launch.run_id,launch.programs),launch.fds)
        try:
            if name=='arbitrary-executable': c.prepare_role(launch.role,replace(config,argv=('/bin/sh',)))
            elif name=='arbitrary-argv': c.prepare_role(launch.role,replace(config,argv=launch.argv+('--no-sandbox',)))
            elif name=='arbitrary-uid': c.exec_role(replace(launch,uid=0),kernel=self.port)
            elif name=='arbitrary-fd': c.prepare_role(launch.role,replace(config,fds=launch.fds+(c.Descriptor(5,'pipe','command','CONTROLLER',launch.run_id),)))
            elif name in ('TSYNC-error','TSYNC-unsynchronized-tid'):
                # Actual invalid-filter syscall or independently owned native
                # thread fixture. Neither substitutes a fake success/failure
                # value into the native KernelPort. Failure must abort exec.
                port=self.port
                class FaultPort:
                    def establish_views(self,value):
                        if value!=launch.views: raise ProbeFailure('PROBE_DENIED')
                    def close_unaudited_fds(self,value):
                        if value!=launch.fds: raise ProbeFailure('PROBE_DENIED')
                    def drop_credentials(self,uid,gid):
                        if (uid,gid)!=(launch.uid,launch.uid): raise ProbeFailure('PROBE_DENIED')
                    def clear_capabilities(self): c._check(c._attestation(port.inspect()),launch,waiting=False)
                    def no_new_privs(self): c._check(c._attestation(port.inspect()),launch,waiting=False)
                    def install_seccomp(self,program,flags):
                        if name=='TSYNC-error':
                            return port.b.syscall(277,1,1,c.NativeMemory(bytearray(16)))
                        with self_context.authority.unsynchronized_thread(port):
                            result=port.install_seccomp(program,flags)
                            if type(result) is not int or result<=0: raise ProbeFailure('TSYNC_THREAD_FIXTURE_FAILED')
                            return result
                    def exec_pinned(self,*args): raise ProbeFailure('UNTRUSTED_EXEC_AFTER_TSYNC_FAILURE')
                self_context=self
                c.exec_role(launch,kernel=FaultPort())
            else: raise ProbeFailure('BOOTSTRAP_PROBE_DENIED')
        except c.ConfinementError:
            raise PermissionError(1,'BOOTSTRAP_BOUNDARY_DENIED') from None
        raise ProbeFailure('BOOTSTRAP_CONTRACT_ACCEPTED')


class NativeProbeFixtures:
    """Concrete finite subprocess transport for separately approved fixtures.

    Construct only after explicit native selector + pinned fixture approval.
    The authority supplies independently owned receiver and executable samples,
    not canned attempt dictionaries. Missing fixture callbacks fail closed.
    Every observation below is generated inside a freshly confined process.
    """
    def __init__(self,confinement,kernel,config,authority):
        if not isinstance(kernel,confinement.NativeKernelPort) or any(not callable(getattr(authority,n,None)) for n in
            ('approve_native_fixtures','receiver_count','foreign_pid','audit','helper_pin','audit_abi_termination','unsynchronized_thread','memory')):
            raise RuntimeGateUnavailable('NATIVE_FIXTURES_UNAVAILABLE')
        if authority.approve_native_fixtures(config) is not authority: raise RuntimeGateUnavailable('NATIVE_FIXTURES_UNAPPROVED')
        self.c,self.kernel,self.config,self.authority=confinement,kernel,config,authority

    def run_confined(self,role,operation,attempt):
        if role=='BOOTSTRAP': role='BROWSER' # trusted pre-exec fault probe, NEVER worker exec
        c=self.c; launch=c.prepare_role(role,c.RoleConfig(self.config,c.role_fds(role,self.config.run_id)))
        b=self.kernel.b
        root,state=launch.views.root+'/.root',launch.views.root+'/.state'
        if b.os.path.lexists(root) or b.os.path.lexists(state):
            raise RuntimeGateUnavailable('PROBE_SCOPE_ALREADY_EXISTS')
        def child(port):
            try:
                port.establish_views(launch.views); port.close_unaudited_fds(launch.fds)
                port.drop_credentials(launch.uid,launch.uid); port.clear_capabilities(); port.no_new_privs()
                if port.install_seccomp(launch.filter,1)!=0: raise ProbeFailure('TSYNC_FAILED')
                c._check(c._attestation(port.inspect()),launch,waiting=False)
                # No inherited bootstrap-ready/pinned exec FD reaches the
                # adversarial attempt. A fixed frame authenticates this pipe.
                port.b.os.write(port.ready_fd,port.digest.encode('ascii'))
                for fd in set(port.pins.values())|{port.ready_fd}: port.b.os.close(fd)
                port.pins={}; port.ready_fd=None
                port.b.os.write(4,b'WAITING\n')
                data=json.dumps(attempt(NativeProbeContext(port,self.authority,operation,c)),separators=(',',':')).encode('ascii')
                if len(data)>512: raise ProbeFailure('PROBE_RESULT_LIMIT')
                if port.b.os.write(4,struct.pack('<I',len(data))+data)!=len(data)+4: raise ProbeFailure('PROBE_RESULT_LIMIT')
                if port.b.os.read(3,4)!=b'EXIT': raise ProbeFailure('PROBE_RELEASE_DENIED')
                port.b.os._exit(0)
            except BaseException: port.b.os._exit(78)
        owned=None
        try:
            try: owned=self.kernel.spawn_waiting(launch,child)
            except c.RoleStartFailure as error:
                owned=error.owned
                raise
            length=struct.unpack('<I',self.kernel._read_exact(owned.result,4,2000))[0]
            if not 0<length<=512: raise ProbeFailure('PROBE_RESULT_LIMIT')
            result=json.loads(self.kernel._read_exact(owned.result,length,2000))
            self.kernel.b.os.write(owned.command,b'EXIT')
            if self.kernel.wait_owned(owned,2000)['status']!='EXITED': raise ProbeFailure('PROBE_REAP_UNCERTAIN')
            return result
        finally:
            if owned is not None:
                if self.kernel.stop_owned(owned,2000)['status'] not in ('STOPPED','EXITED'):
                    raise ProbeFailure('PROBE_REAP_UNCERTAIN')
                # Empty-only removal, fixed paths, after family exit. Never
                # recurse/read unknown contents or remove parent role state.
                try: b.os.unlink(root+'/dev/null')
                except FileNotFoundError: pass
                directories=[root+'/run/acceptance/'+role.lower(),root+'/run/acceptance',root+'/run',
                    root+'/dev/shm',root+'/dev',*(root+'/'+d for d in ('proc','tmp','var','etc','lib64','lib','usr','opt')),root,
                    state+'/run/acceptance/'+role.lower(),state+'/run/acceptance',state+'/run',
                    state+'/dev/shm',state+'/dev',state+'/var',state+'/tmp',state]
                for path in directories:
                    try: b.os.rmdir(path)
                    except FileNotFoundError: pass
                    except OSError: raise ProbeFailure('PROBE_SCOPE_CLEANUP_UNCERTAIN') from None


def select_native_probe(mode,*,confinement,config,runtime_identity,validate_runtime,fixture_authority):
    if mode!='bootstrap-check': raise RuntimeGateUnavailable('NATIVE_PROBE_GATE_DENIED')
    kernel=confinement.select_native_kernel(mode,runtime_identity=runtime_identity,validate_runtime=validate_runtime)
    return NativeProbePort(NativeProbeFixtures(confinement,kernel,config,fixture_authority))


if __name__ == '__main__':
    # No CLI import hook, adapter discovery, or host fallback can run an attempt.
    raise SystemExit(78)

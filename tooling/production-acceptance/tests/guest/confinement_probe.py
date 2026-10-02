"""Finite future guest probe contract; no native implementation or default.

run_case invokes only an explicitly injected trusted ProbePort. Offline doubles
may test observation validation; their output is NOT kernel/runtime evidence.
The future independently approved native harness must demonstrate each actual
attempt, denial at kernel/FD boundary, and owned receiver observation. Absence
of that harness is a failed/unavailable gate, never a skipped or mocked PASS.
"""
from collections import namedtuple
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


if __name__ == '__main__':
    # No CLI import hook, adapter discovery, or host fallback can run an attempt.
    raise SystemExit(78)

"""Separately gated future guest tests. NOT part of offline discovery commands.

A reviewed Linux guest harness must inject an actual native ProbePort as
ConfinementGuestTests.probe_port under separate VM/kernel execution approval.
Default discovery fails unavailable; no fake factory, skip, automatic syscall,
platform-dependent adapter, or caller bool creates native qualification.
"""
import unittest
from confinement_probe import run_case, RuntimeGateUnavailable


class ConfinementGuestTests(unittest.TestCase):
    probe_port = None

    def setUp(self):
        if self.probe_port is None:
            raise RuntimeGateUnavailable('NATIVE_GUEST_PROBE_PORT_UNAVAILABLE')

    def test_vsock_browser_controller_verifier_denied(self):
        run_case('vsock_browser_controller_verifier_denied',self.probe_port)

    def test_child_fork_exec_network_gpu_crash_helper_inherits(self):
        run_case('child_fork_exec_network_gpu_crash_helper_inherits',self.probe_port)

    def test_proxy_fixed_vsock_positive(self):
        run_case('proxy_fixed_vsock_positive',self.probe_port)

    def test_io_uring_setup_register_enter_and_inherited_ring_denied(self):
        run_case('io_uring_setup_register_enter_and_inherited_ring_denied',self.probe_port)

    def test_alternate_ABI_denied(self):
        run_case('alternate_ABI_denied',self.probe_port)

    def test_SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied(self):
        run_case('SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied',self.probe_port)

    def test_privilege_gain_denied(self):
        run_case('privilege_gain_denied',self.probe_port)

    def test_no_console_or_bridge_fd(self):
        run_case('no_console_or_bridge_fd',self.probe_port)

    def test_bootstrap_arbitrary_argv_denied(self):
        run_case('bootstrap_arbitrary_argv_denied',self.probe_port)

    def test_TSYNC_failure_abort(self):
        run_case('TSYNC_failure_abort',self.probe_port)

    def test_exact_fd_inventory(self):
        run_case('exact_fd_inventory',self.probe_port)


if __name__ == '__main__': unittest.main()

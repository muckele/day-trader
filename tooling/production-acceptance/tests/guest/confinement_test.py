"""Separately gated native guest tests. NOT part of offline discovery commands.

A reviewed Linux guest harness must inject an actual native ProbePort as
ConfinementGuestTests.probe_port under separate VM/kernel execution approval.
Default discovery fails unavailable; no fake factory, skip, automatic syscall,
platform-dependent adapter, or caller bool creates native qualification.
One test per catalogue case (Task 10: the theft family's real foreign targets,
AArch32 SIGSYS or observed ENOEXEC, the parent-observed inventory, and P49).
"""
import unittest
from confinement_probe import run_case, RuntimeGateUnavailable, select_native_probe, qualify_probe_epoch


class ConfinementGuestTests(unittest.TestCase):
    probe_port = None
    completed_epoch = None

    @classmethod
    def configure_composition(cls, binding, fixtures, cleanup_budget):
        """Original trusted bootstrap calls once, before any persistent role."""
        if cls.completed_epoch is not None: raise RuntimeGateUnavailable('NATIVE_PROBE_ALREADY_CONFIGURED')
        cls.completed_epoch = qualify_probe_epoch(binding, fixtures, cleanup_budget)

    def completed_case(self, name):
        if self.completed_epoch is None: raise RuntimeGateUnavailable('COMPLETED_PROBE_EPOCH_UNAVAILABLE')
        self.assertIn(name, dict(self.completed_epoch.cases))

    @classmethod
    def configure_native(cls,*,mode,confinement,config,runtime_identity,validate_runtime,fixture_authority):
        """Task10 trusted embedding, only under separate VM execution approval.
        No environment bool, automatic platform selection or fake fallback.
        """
        if cls.probe_port is not None: raise RuntimeGateUnavailable('NATIVE_PROBE_ALREADY_CONFIGURED')
        cls.probe_port=select_native_probe(mode,confinement=confinement,config=config,
            runtime_identity=runtime_identity,validate_runtime=validate_runtime,fixture_authority=fixture_authority)

    def setUp(self):
        if self.probe_port is None:
            raise RuntimeGateUnavailable('NATIVE_GUEST_PROBE_PORT_UNAVAILABLE')

    def test_vsock_browser_controller_verifier_denied(self):
        run_case('vsock_browser_controller_verifier_denied',self.probe_port)

    def test_child_fork_exec_network_gpu_crash_helper_inherits(self):
        run_case('child_fork_exec_network_gpu_crash_helper_inherits',self.probe_port)

    def test_child_fork_exec_network_gpu_crash_helper_ipv4(self):
        self.completed_case('child_fork_exec_network_gpu_crash_helper_ipv4')

    def test_child_fork_exec_network_gpu_crash_helper_ipv6(self):
        self.completed_case('child_fork_exec_network_gpu_crash_helper_ipv6')

    def test_fixed_ip_denied(self):
        self.completed_case('fixed_ip_denied')

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

    def test_browser_user_namespace_available(self):
        # P49: unshare(CLONE_NEWUSER) succeeds in a fresh BROWSER family after seccomp.
        run_case('browser_user_namespace_available',self.probe_port)


if __name__ == '__main__': unittest.main()

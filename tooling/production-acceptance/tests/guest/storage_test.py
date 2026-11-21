"""Separately gated Task 14 native guest storage qualification, one case per role (C7, E5, R8).

The final approved guest harness must inject a real per-role ``GuestStoragePort``: for each role, a filesystem and
kernel port observed inside that role's own view and running as that role's UID. Default discovery fails
unavailable: there is no host fallback, fake success, skip, platform auto-selection, VM launch, or filesystem
mutation on import.
"""
import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    'task18_guest_storage', ROOT / 'guest/storage.py')
storage = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = storage
spec.loader.exec_module(storage)


class RuntimeGateUnavailable(RuntimeError): pass


class StorageGuestTests(unittest.TestCase):
    """Actual mount/swap/UID/capacity cases, per role, supplied by the trusted bootstrap."""
    storage_port = None

    @classmethod
    def configure_native(cls, port):
        if cls.storage_port is not None:
            raise RuntimeGateUnavailable('NATIVE_STORAGE_ALREADY_CONFIGURED')
        required = ('fixture', 'assert_no_content_open', 'assert_owned_only')
        if any(not callable(getattr(port, name, None)) for name in required):
            raise RuntimeGateUnavailable('NATIVE_STORAGE_PORT_UNAVAILABLE')
        cls.storage_port = port

    def setUp(self):
        if self.storage_port is None:
            raise RuntimeGateUnavailable('NATIVE_STORAGE_PORT_UNAVAILABLE')

    def admit_case(self, role, name):
        policy, filesystem, kernel = self.storage_port.fixture(role, name)
        return storage.admit_role_storage(role, policy, filesystem, kernel), filesystem

    def role_case(self, role):
        proof, _ = self.admit_case(role, 'readonly_base_all_writable_tmpfs_no_swap')
        self.assertEqual((proof.role, proof.uid, proof.scopes), (role, storage.UIDS[role], storage.ROLE_SCOPES[role]))
        self.assertEqual(proof.scopes, tuple(item.path for item in proof.mounts))
        for name in ('unreadable_empty0600', 'wrong_owner', 'wrong_gid', 'symlink', 'hardlink', 'path_swap',
                     'privileged_port', 'another_role_uid', 'shm_on_run_device', 'shm_not_64MiB', 'host_share',
                     'disk_backed', 'run_over_256MiB', 'crash_over_1MiB', 'depth_over_64'):
            with self.subTest(role=role, case=name), self.assertRaises(storage.StorageFailure):
                self.admit_case(role, name)
        proof, _ = self.admit_case(role, 'crash_metadata_only_and_capacity_bounds')
        aggregate = storage.crash_aggregate(proof.crash_root_fd, proof=proof)
        self.assertFalse(aggregate.crash_contents_read)
        self.assertLessEqual(aggregate.logical_bytes, 1024 * 1024)
        self.assertLessEqual(aggregate.allocated_bytes, 1024 * 1024)
        self.storage_port.assert_no_content_open(role)
        proof, _ = self.admit_case(role, 'cleanup_owned_synthetic_scope')
        result = storage.remove_role_state(proof)
        self.assertTrue(result.guest_private_state_removed)
        self.assertFalse(result.host_residue_erased)
        self.storage_port.assert_owned_only(role)

    def test_controller_storage(self): self.role_case('CONTROLLER')

    def test_browser_storage(self): self.role_case('BROWSER')

    def test_verifier_storage(self): self.role_case('VERIFIER')

    def test_proxy_storage(self): self.role_case('PROXY')


if __name__ == '__main__': unittest.main()

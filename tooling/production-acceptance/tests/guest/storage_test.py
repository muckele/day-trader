"""Separately gated Task 18 native guest storage qualification.

The final approved guest harness must inject a real ``GuestStoragePort``.
Default discovery fails unavailable: there is no host fallback, fake success,
skip, platform auto-selection, VM launch, or filesystem mutation on import.
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


class NativeStorageUnavailable(RuntimeError): pass


class StorageGuestTests(unittest.TestCase):
    """Actual mount/swap/UID/capacity cases supplied by trusted bootstrap."""
    storage_port = None

    @classmethod
    def configure_native(cls, port):
        if cls.storage_port is not None:
            raise NativeStorageUnavailable('NATIVE_STORAGE_ALREADY_CONFIGURED')
        required = ('fixture', 'assert_no_content_open', 'assert_owned_only')
        if any(not callable(getattr(port, name, None)) for name in required):
            raise NativeStorageUnavailable('NATIVE_STORAGE_PORT_UNAVAILABLE')
        cls.storage_port = port

    def setUp(self):
        if self.storage_port is None:
            raise NativeStorageUnavailable('NATIVE_STORAGE_PORT_UNAVAILABLE')

    def admit_case(self, name):
        policy, filesystem, kernel = self.storage_port.fixture(name)
        return (storage.admit_storage(policy, filesystem, kernel), filesystem)

    def test_readonly_base_all_writable_tmpfs_no_swap(self):
        proof, _ = self.admit_case('readonly_base_all_writable_tmpfs_no_swap')
        self.assertEqual(proof.mutable_paths,
                         tuple(item.path for item in proof.mounts))

    def test_0700_dirs_0600_files_correct_uid(self):
        proof, _ = self.admit_case('0700_dirs_0600_files_correct_uid')
        self.assertEqual(proof.root_count, 5)

    def test_unreadable_wrong_owner_and_link_substitution_fail(self):
        for name in ('unreadable_empty0600', 'wrong_owner', 'symlink',
                     'hardlink', 'path_swap'):
            with self.subTest(name=name), self.assertRaises(storage.StorageFailure):
                self.admit_case(name)

    def test_crash_metadata_only_and_capacity_bounds(self):
        proof, _ = self.admit_case('crash_metadata_only_and_capacity_bounds')
        aggregate = storage.crash_aggregate(proof.crash_root_fd, proof=proof)
        self.assertFalse(aggregate.crash_contents_read)
        self.assertLessEqual(aggregate.logical_bytes, 1024 * 1024)
        self.assertLessEqual(aggregate.allocated_bytes, 1024 * 1024)
        self.storage_port.assert_no_content_open()

    def test_host_share_disk_backed_or_capacity_drift_fail(self):
        for name in ('host_share', 'disk_backed', 'run_over_256MiB',
                     'crash_over_1MiB'):
            with self.subTest(name=name), self.assertRaises(storage.StorageFailure):
                self.admit_case(name)

    def test_cleanup_removes_owned_scope_without_host_erasure_claim(self):
        proof, _ = self.admit_case('cleanup_owned_synthetic_scope')
        result = storage.remove_owned_state(proof)
        self.assertTrue(result.guest_private_state_removed)
        self.assertFalse(result.host_residue_erased)
        self.storage_port.assert_owned_only()


if __name__ == '__main__': unittest.main()

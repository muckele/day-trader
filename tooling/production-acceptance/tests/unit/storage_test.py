"""Synthetic Task 18 storage contract tests; no native filesystem is touched."""
import dataclasses
import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
STORAGE_PATH = ROOT / 'guest/storage.py'
storage = None
if STORAGE_PATH.exists():
    spec = importlib.util.spec_from_file_location('task18_storage', STORAGE_PATH)
    storage = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = storage
    spec.loader.exec_module(storage)


RUN_BYTES = 256 * 1024 * 1024
CRASH_BYTES = 1024 * 1024
SHM_BYTES = 64 * 1024 * 1024
ROOTS = (
    ('/run/acceptance/controller', 10001, 'RUN'),
    ('/run/acceptance/browser', 10002, 'RUN'),
    ('/run/acceptance/verifier', 10003, 'RUN'),
    ('/run/acceptance/proxy', 10004, 'RUN'),
    ('/run/acceptance/crash', 10001, 'CRASH'),
)
MUTABLE_PATHS = ('/run', '/tmp', '/var', '/dev/shm') + tuple(
    path for path, _, _ in ROOTS)


class Node:
    next_inode = 100

    def __init__(self, kind, mode, uid, *, size=0, allocated=0, nlink=1,
                 device=7, readable=True, children=None, purpose='RUN'):
        self.kind, self.mode, self.uid, self.gid = kind, mode, uid, uid
        self.size, self.allocated, self.nlink = size, allocated, nlink
        self.device, self.readable, self.purpose = device, readable, purpose
        self.children = dict(children or {})
        self.inode = Node.next_inode
        Node.next_inode += 1


class Filesystem:
    """Inert descriptor-relative filesystem with exact identity enforcement."""
    def __init__(self):
        self.roots, self.parents, self.fds = {}, {}, {}
        self.next_fd, self.closed = 10, []
        self.removed_paths, self.file_opens = [], []
        self.swap_node, self.swap_reads = None, 0
        self.root_name_override = None
        self.open_shape = 'VALID'
        self.close_failures = set()
        for path, uid, purpose in ROOTS:
            device = 8 if purpose == 'CRASH' else 7
            file_node = Node('FILE', 0o600, uid, size=4, allocated=4096,
                             purpose=purpose, device=device)
            root = Node('DIRECTORY', 0o700, uid,
                        children={'marker': file_node}, purpose=purpose,
                        device=device)
            parent = Node('DIRECTORY', 0o700, uid,
                          children={path.rsplit('/', 1)[1]: root},
                          purpose=purpose, device=device)
            self.roots[path], self.parents[path] = root, parent

    def _fd(self, node):
        value = self.next_fd
        self.next_fd += 1
        self.fds[value] = node
        return value

    def metadata(self, node, *, changed=False):
        inode = node.inode + (100000 if changed else 0)
        return storage.NodeMetadata(node.kind, node.mode, node.uid, node.gid,
                                    node.device, inode, node.nlink,
                                    node.size, node.allocated)

    def open_root(self, path):
        if path not in self.roots: raise OSError('unknown root')
        name = path.rsplit('/', 1)[1]
        if self.root_name_override is not None:
            name = self.root_name_override
            self.parents[path].children[name] = self.roots[path]
        parent_fd = self._fd(self.parents[path])
        if self.open_shape == 'BAD_SECOND':
            return parent_fd, 'invalid', name
        root_fd = self._fd(self.roots[path])
        if self.open_shape == 'SHORT':
            return parent_fd, root_fd
        return parent_fd, root_fd, name

    def stat(self, fd): return self.metadata(self.fds[fd])

    def list_names(self, fd): return tuple(self.fds[fd].children)

    def stat_child(self, fd, name):
        node = self.fds[fd].children[name]
        changed = False
        if node is self.swap_node:
            self.swap_reads += 1
            changed = self.swap_reads >= 2
        return self.metadata(node, changed=changed)

    def open_directory(self, fd, name, expected):
        node = self.fds[fd].children[name]
        if node.kind != 'DIRECTORY' or self.metadata(node) != expected:
            raise OSError('directory identity changed')
        return self._fd(node)

    def open_file(self, fd, name, expected):
        node = self.fds[fd].children[name]
        if node.purpose == 'CRASH':
            raise AssertionError('crash file content-open attempted')
        if node.kind != 'FILE' or self.metadata(node) != expected:
            raise OSError('file identity changed')
        self.file_opens.append(node.inode)
        return self._fd(node)

    def readable(self, fd): return self.fds[fd].readable

    def close(self, fd):
        if fd in self.close_failures:
            raise OSError('synthetic close failure')
        self.closed.append(fd)
        self.fds.pop(fd, None)

    def unlink(self, fd, name, expected):
        node = self.fds[fd].children[name]
        if self.metadata(node) != expected or node.kind != 'FILE':
            raise OSError('unlink identity changed')
        del self.fds[fd].children[name]
        self.removed_paths.append(('FILE', node.inode))

    def remove_directory(self, fd, name, expected):
        node = self.fds[fd].children[name]
        if self.metadata(node) != expected or node.kind != 'DIRECTORY' or node.children:
            raise OSError('directory removal denied')
        del self.fds[fd].children[name]
        self.removed_paths.append(('DIRECTORY', node.inode))

    def remove_root(self, parent_fd, name, expected):
        node = self.fds[parent_fd].children[name]
        if self.metadata(node) != expected or node.children:
            raise OSError('root removal denied')
        del self.fds[parent_fd].children[name]
        self.removed_paths.append(('ROOT', node.inode))


class Kernel:
    def __init__(self):
        mounts = []
        for path in MUTABLE_PATHS:
            capacity = (CRASH_BYTES if path == '/run/acceptance/crash'
                        else SHM_BYTES if path == '/dev/shm' else RUN_BYTES)
            device = (8 if path == '/run/acceptance/crash'
                      else 9 if path == '/dev/shm' else 7)
            mounts.append((path, 'tmpfs', device, True, capacity, 4096))
        self.values = dict(base_read_only=True, writable_disks=0,
                           active_swaps=(), zram_swaps=(), hibernation=False,
                           save_restore=False, persistent_crash=False,
                           host_shares=(), mounts=tuple(mounts))
        self.calls = 0

    def observe(self):
        self.calls += 1
        return storage.KernelStorageState(
            self.values['base_read_only'], self.values['writable_disks'],
            self.values['active_swaps'], self.values['zram_swaps'],
            self.values['hibernation'], self.values['save_restore'],
            self.values['persistent_crash'], self.values['host_shares'],
            tuple(storage.MountObservation(*row) for row in self.values['mounts']))


class StorageTests(unittest.TestCase):
    def setUp(self):
        if storage is None:
            self.fail('storage contract absent')
        self.fs, self.kernel = Filesystem(), Kernel()

    def policy(self, **changes):
        values = dict(
            policy_digest='a' * 64, base_read_only=True, writable_disks=0,
            run_state='TMPFS', guest_swap=False, zram_swap=False,
            hibernation=False, save_restore=False, persistent_crash=False,
            host_shares=False, run_tmpfs_bytes=RUN_BYTES,
            crash_tmpfs_bytes=CRASH_BYTES, shm_bytes=SHM_BYTES,
            tmpfs_inodes=4096,
            roots=tuple(storage.OwnedRoot(*row) for row in ROOTS),
            mutable_paths=MUTABLE_PATHS)
        values.update(changes)
        return storage.StoragePolicy(**values)

    def denied(self, operation):
        with self.assertRaises(storage.StorageFailure) as raised: operation()
        self.assertEqual(str(raised.exception), 'STORAGE_INVALID')

    def admit(self, policy=None):
        return storage.admit_storage(policy or self.policy(), self.fs, self.kernel)

    def test_readonly_base_all_writable_tmpfs_no_swap(self):
        proof = self.admit()
        self.assertEqual(proof.policy_digest, 'a' * 64)
        self.assertEqual(self.kernel.calls, 1)
        self.assertEqual(proof.mutable_paths, MUTABLE_PATHS)
        for field, bad in [('base_read_only', False), ('writable_disks', 1),
                           ('active_swaps', ('/swap',)), ('zram_swaps', ('zram0',)),
                           ('hibernation', True), ('save_restore', True),
                           ('persistent_crash', True)]:
            with self.subTest(field=field):
                fs, kernel = Filesystem(), Kernel(); kernel.values[field] = bad
                self.denied(lambda: storage.admit_storage(self.policy(), fs, kernel))

    def test_0700_dirs_0600_files_correct_uid(self):
        self.admit()
        for change in [('root-mode', 0o755), ('file-mode', 0o640),
                       ('root-owner', 0), ('file-owner', 0)]:
            fs, kernel = Filesystem(), Kernel()
            root = fs.roots['/run/acceptance/browser']
            if change[0] == 'root-mode': root.mode = change[1]
            if change[0] == 'file-mode': root.children['marker'].mode = change[1]
            if change[0] == 'root-owner': root.uid = root.gid = change[1]
            if change[0] == 'file-owner':
                root.children['marker'].uid = root.children['marker'].gid = change[1]
            with self.subTest(change=change[0]):
                self.denied(lambda: storage.admit_storage(self.policy(), fs, kernel))

    def test_unreadable_empty0600_wrong_owner_fail(self):
        for mutation in ('unreadable', 'empty-unreadable', 'wrong-owner'):
            fs, kernel = Filesystem(), Kernel()
            node = fs.roots['/run/acceptance/controller'].children['marker']
            if mutation == 'empty-unreadable': node.size = node.allocated = 0
            if mutation in ('unreadable', 'empty-unreadable'): node.readable = False
            else: node.uid = node.gid = 10002
            with self.subTest(mutation=mutation):
                self.denied(lambda: storage.admit_storage(self.policy(), fs, kernel))

    def test_symlink_hardlink_path_swap_fail(self):
        for mutation in ('symlink', 'hardlink', 'swap'):
            fs, kernel = Filesystem(), Kernel()
            node = fs.roots['/run/acceptance/browser'].children['marker']
            if mutation == 'symlink': node.kind = 'SYMLINK'
            if mutation == 'hardlink': node.nlink = 2
            if mutation == 'swap': fs.swap_node = node
            with self.subTest(mutation=mutation):
                self.denied(lambda: storage.admit_storage(self.policy(), fs, kernel))

    def test_proof_is_immutable_and_cleanup_scope_cannot_be_forged(self):
        proof = self.admit()
        self.assertFalse(hasattr(proof, '_filesystem'))
        with self.assertRaises(dataclasses.FrozenInstanceError):
            proof.policy_digest = 'b' * 64
        forged = dataclasses.replace(proof, policy_digest='b' * 64)
        self.assertEqual(dataclasses.asdict(storage.remove_owned_state(forged)), {
            'guest_private_state_removed': False,
            'host_residue_erased': False, 'code': 'CLEANUP_INCOMPLETE'})
        self.assertEqual(self.fs.removed_paths, [])
        self.assertTrue(storage.remove_owned_state(proof).guest_private_state_removed)

    def test_run_mounts_share_one_bounded_device_and_shm_crash_are_separate(self):
        for path, device in [('/tmp', 17), ('/dev/shm', 7),
                             ('/run/acceptance/crash', 7)]:
            fs, kernel = Filesystem(), Kernel()
            rows = list(kernel.values['mounts'])
            index = next(i for i, row in enumerate(rows) if row[0] == path)
            row = list(rows[index]); row[2] = device; rows[index] = tuple(row)
            kernel.values['mounts'] = tuple(rows)
            with self.subTest(path=path):
                self.denied(lambda: storage.admit_storage(self.policy(), fs, kernel))

    def test_nested_device_drift_and_directory_bytes_are_bounded(self):
        fs, kernel = Filesystem(), Kernel()
        fs.roots['/run/acceptance/browser'].children['marker'].device = 23
        self.denied(lambda: storage.admit_storage(self.policy(), fs, kernel))

        fs, kernel = Filesystem(), Kernel()
        crash = fs.roots['/run/acceptance/crash']
        nested = Node('DIRECTORY', 0o700, 10001, size=17, allocated=4096,
                      device=8, purpose='CRASH')
        crash.children['nested'] = nested
        proof = storage.admit_storage(self.policy(), fs, kernel)
        aggregate = storage.crash_aggregate(proof.crash_root_fd, proof=proof)
        self.assertEqual((aggregate.file_count, aggregate.directory_count,
                          aggregate.logical_bytes, aggregate.allocated_bytes),
                         (1, 1, 21, 8192))

        fs, kernel = Filesystem(), Kernel()
        fs.roots['/run/acceptance/crash'].children['nested'] = Node(
            'DIRECTORY', 0o700, 10001, size=0, allocated=CRASH_BYTES + 1,
            device=8, purpose='CRASH')
        self.denied(lambda: storage.admit_storage(self.policy(), fs, kernel))

    def test_partial_admission_closes_current_descriptors_and_binds_exact_name(self):
        fs, kernel = Filesystem(), Kernel()
        fs.roots['/run/acceptance/controller'].mode = 0o755
        self.denied(lambda: storage.admit_storage(self.policy(), fs, kernel))
        self.assertEqual(fs.fds, {})

        for shape in ('SHORT', 'BAD_SECOND'):
            fs, kernel = Filesystem(), Kernel(); fs.open_shape = shape
            with self.subTest(shape=shape):
                self.denied(lambda: storage.admit_storage(self.policy(), fs, kernel))
                self.assertEqual(fs.fds, {})

        fs, kernel = Filesystem(), Kernel(); fs.root_name_override = 'other'
        self.denied(lambda: storage.admit_storage(self.policy(), fs, kernel))
        self.assertEqual(fs.fds, {})

    def test_crash_open_content_raises_if_called(self):
        proof = self.admit()
        aggregate = storage.crash_aggregate(proof.crash_root_fd, proof=proof)
        self.assertEqual(dataclasses.asdict(aggregate), {
            'policy_digest': 'a' * 64, 'file_count': 1,
            'directory_count': 0, 'logical_bytes': 4,
            'allocated_bytes': 4096, 'crash_contents_read': False})
        crash_inode = self.fs.roots['/run/acceptance/crash'].children['marker'].inode
        self.assertNotIn(crash_inode, self.fs.file_opens)

    def test_1MiB_crash_256MiB_run_bounds(self):
        for path, value in [('/run/acceptance/crash', CRASH_BYTES + 1),
                            ('/run/acceptance/controller', RUN_BYTES + 1)]:
            fs, kernel = Filesystem(), Kernel()
            node = fs.roots[path].children['marker']; node.size = node.allocated = value
            with self.subTest(path=path):
                self.denied(lambda: storage.admit_storage(self.policy(), fs, kernel))
        for field, value in [('run_tmpfs_bytes', RUN_BYTES + 1),
                             ('crash_tmpfs_bytes', CRASH_BYTES + 1)]:
            self.denied(lambda field=field, value=value:
                        storage.admit_storage(self.policy(**{field: value}),
                                              Filesystem(), Kernel()))

    def test_host_share_or_disk_backed_path_fail(self):
        for mutation in ('host-share', 'disk', 'readonly-mutable', 'missing'):
            fs, kernel = Filesystem(), Kernel()
            if mutation == 'host-share': kernel.values['host_shares'] = ('virtiofs',)
            else:
                rows = list(kernel.values['mounts'])
                index = next(i for i, row in enumerate(rows) if row[0] == '/tmp')
                if mutation == 'disk': rows[index] = ('/tmp', 'ext4', 9, True, RUN_BYTES, 4096)
                if mutation == 'readonly-mutable': rows[index] = ('/tmp', 'tmpfs', 7, False, RUN_BYTES, 4096)
                if mutation == 'missing': rows.pop(index)
                kernel.values['mounts'] = tuple(rows)
            with self.subTest(mutation=mutation):
                self.denied(lambda: storage.admit_storage(self.policy(), fs, kernel))

    def test_deletion_owned_scope_only(self):
        outside = Node('FILE', 0o600, 501, size=99, allocated=4096)
        proof = self.admit()
        result = storage.remove_owned_state(proof)
        self.assertTrue(result.guest_private_state_removed)
        self.assertFalse(result.host_residue_erased)
        self.assertEqual(result.code, 'COMPLETE')
        self.assertEqual(outside.size, 99)
        self.assertEqual(sum(kind == 'ROOT' for kind, _ in self.fs.removed_paths), 5)
        self.assertTrue(all(not parent.children for parent in self.fs.parents.values()))
        second = storage.remove_owned_state(proof)
        self.assertEqual(dataclasses.asdict(second), {
            'guest_private_state_removed': False,
            'host_residue_erased': False, 'code': 'CLEANUP_INCOMPLETE'})

    def test_host_residue_not_claimed_erased(self):
        proof = self.admit()
        result = storage.remove_owned_state(proof)
        self.assertEqual(set(dataclasses.asdict(result)), {
            'guest_private_state_removed', 'host_residue_erased', 'code'})
        self.assertIs(result.host_residue_erased, False)
        self.assertNotIn('physical', repr(result).lower())
        self.assertNotIn('host_erased', repr(result).lower())

    def test_descriptor_close_failure_cannot_report_complete(self):
        proof = self.admit()
        proof_state_fd = proof.crash_root_fd
        self.fs.close_failures.add(proof_state_fd)
        result = storage.remove_owned_state(proof)
        self.assertFalse(result.guest_private_state_removed)
        self.assertFalse(result.host_residue_erased)
        self.assertEqual(result.code, 'CLEANUP_INCOMPLETE')


if __name__ == '__main__': unittest.main()

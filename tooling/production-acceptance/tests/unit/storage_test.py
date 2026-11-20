"""Synthetic Task 14 per-role storage contract tests (C7, E5, R8); no native filesystem is touched.

Each double is ONE role's view as that role sees it after the Task 8b pivot: '/' and the scope parents are
root-owned 0755, and the five scopes ROLE_SCOPES[role] are role-owned 0700 tmpfs roots. /tmp, /var and the role's
run directory share the bounded /run tmpfs (device 7), /dev/shm is the role's own 64 MiB tmpfs (device 9) and
/run/acceptance/crash its subdirectory of the 1 MiB crash tmpfs (device 8). The kernel port reports the UID the
port runs as (P17) and the role's own mounts.
"""
import dataclasses
import importlib.util
import pathlib
import sys
import traceback
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
UIDS = {'CONTROLLER': 10001, 'BROWSER': 10002, 'VERIFIER': 10003, 'PROXY': 10004}
RUN_DEV, CRASH_DEV, SHM_DEV = 7, 8, 9
INTERFACE = ('UIDS', 'ROLE_SCOPES', 'MAX_DEPTH', 'admit_role_storage', 'crash_aggregate', 'remove_role_state',
             'combine_crash_aggregates', 'release_role_storage', 'scope_digest', 'RoleStorageProof')


def scopes(role):
    return ('/run/acceptance/' + role.lower(), '/tmp', '/var', '/dev/shm', '/run/acceptance/crash')


def device_of(path):
    return CRASH_DEV if path == '/run/acceptance/crash' else SHM_DEV if path == '/dev/shm' else RUN_DEV


class Node:
    next_inode = 100

    def __init__(self, kind, mode, uid, *, gid=None, size=0, allocated=0, nlink=1,
                 device=RUN_DEV, readable=True, children=None, purpose='RUN', target=None):
        self.kind, self.mode, self.uid = kind, mode, uid
        self.gid = uid if gid is None else gid
        self.size, self.allocated, self.nlink = size, allocated, nlink
        self.device, self.readable, self.purpose = device, readable, purpose
        self.children = dict(children or {})
        self.target = target  # a SYMLINK's absolute target path in this view, which may not exist
        self.inode = Node.next_inode
        Node.next_inode += 1


def link(target, uid, **kwargs):
    return Node('SYMLINK', 0o777, uid, size=len(target), target=target, **kwargs)


class Filesystem:
    """One role's view (C7), descriptor-relative, with exact identity enforcement on opens only.

    unlink and remove_directory record what they remove without re-checking identity themselves, so a removal-time
    re-stat in storage is the only thing that can refuse a swapped node (Task 18 review M18-4). With shared=True the
    /run/acceptance parent also holds every other role's run root and an 'outside' sibling, each with a marker.
    With markers=False the scopes are fresh and empty, as at a role's first launch.

    The port runs as the role (P66): Linux owner bits apply to nodes the role owns, other bits to the rest. Listing
    needs r, a child lookup or open needs x, and an unlink or rmdir needs w and x on the directory. chmod(fd) is
    fchmod: EPERM unless the role owns the node. Every removal and chmod attempt is recorded in ATTEMPTS before it is
    checked. stat_child and open_directory are lstat and O_NOFOLLOW; their follow=True form, which models a path
    that follows a symlink, is offered only so that a mutant can use it.
    """
    def __init__(self, role='BROWSER', *, shared=False, markers=True):
        self.role, self.uid = role, UIDS[role]
        self.fds, self.next_fd, self.closed = {}, 10, []
        self.removed, self.file_opens, self.opened_roots = [], [], []
        self.attempts, self.chmods = [], []
        self.swap_node, self.swap_reads = None, 0
        self.root_name_override, self.open_shape = None, 'VALID'
        self.close_failures, self.stat_failure = set(), None
        self.tree = Node('DIRECTORY', 0o755, 0, device=RUN_DEV)
        for path in scopes(role):
            device = device_of(path)
            purpose = 'CRASH' if device == CRASH_DEV else 'RUN'
            children = {'marker': Node('FILE', 0o600, self.uid, size=4, allocated=4096, device=device,
                                       purpose=purpose)} if markers else {}
            self.place(path, Node('DIRECTORY', 0o700, self.uid, device=device, purpose=purpose,
                                  children=children))
        if shared:
            for other, uid in UIDS.items():
                if other != role:
                    self.place('/run/acceptance/' + other.lower(), Node(
                        'DIRECTORY', 0o700, uid, children={'marker': Node('FILE', 0o600, uid, size=4)}))
            self.place('/run/acceptance/outside', Node(
                'DIRECTORY', 0o700, 501, children={'marker': Node('FILE', 0o600, 501, size=99)}))

    def place(self, path, node):
        parent = self.tree
        parts = path.strip('/').split('/')
        for part in parts[:-1]:
            parent = parent.children.setdefault(part, Node('DIRECTORY', 0o755, 0, device=parent.device))
        parent.children[parts[-1]] = node
        return node

    def node(self, path):
        node = self.tree
        for part in path.strip('/').split('/'):
            if part: node = node.children[part]
        return node

    def everything(self, node=None):
        node = self.tree if node is None else node
        found = [node]
        for child in node.children.values():
            found.extend(self.everything(child))
        return found

    def _fd(self, node):
        value = self.next_fd
        self.next_fd += 1
        self.fds[value] = node
        return value

    def metadata(self, node, *, changed=False):
        if self.stat_failure is not None and node is self.stat_failure[0]:
            raise OSError(2, self.stat_failure[1])
        inode = node.inode + (100000 if changed else 0)
        return storage.NodeMetadata(node.kind, node.mode, node.uid, node.gid, node.device, inode, node.nlink,
                                    node.size, node.allocated)

    def open_root(self, path):
        self.opened_roots.append(path)
        parent_path, name = path.rsplit('/', 1)
        parent = self.node(parent_path or '/')
        if name not in parent.children: raise OSError(2, 'unknown root')
        if self.root_name_override is not None:
            parent.children[self.root_name_override] = parent.children[name]
            name = self.root_name_override
        parent_fd = self._fd(parent)
        if self.open_shape == 'BAD_SECOND':
            return parent_fd, 'invalid', name
        root_fd = self._fd(parent.children[name])
        if self.open_shape == 'SHORT':
            return parent_fd, root_fd
        return parent_fd, root_fd, name

    def stat(self, fd): return self.metadata(self.fds[fd])

    def need(self, node, bits):
        granted = (node.mode >> 6) & 7 if node.uid == self.uid else node.mode & 7
        if granted & bits != bits: raise PermissionError(13, 'inert permission denied')

    def resolve(self, path):
        try: return self.node(path)
        except KeyError: raise FileNotFoundError(2, 'dangling symlink') from None

    def list_names(self, fd):
        self.need(self.fds[fd], 4)
        return tuple(self.fds[fd].children)

    def stat_child(self, fd, name, follow=False):
        self.need(self.fds[fd], 1)
        node = self.fds[fd].children[name]
        if follow and node.kind == 'SYMLINK':
            return self.metadata(self.resolve(node.target))
        changed = False
        if node is self.swap_node:
            self.swap_reads += 1
            changed = self.swap_reads >= 2
        return self.metadata(node, changed=changed)

    def open_directory(self, fd, name, expected, follow=False):
        self.need(self.fds[fd], 1)
        node = self.fds[fd].children[name]
        if node.kind == 'SYMLINK':
            if not follow: raise OSError(40, 'O_NOFOLLOW: a symlink')
            node = self.resolve(node.target)
        if node.kind != 'DIRECTORY' or self.metadata(node) != expected:
            raise OSError('directory identity changed')
        return self._fd(node)

    def chmod(self, fd, mode):
        node = self.fds[fd]
        self.attempts.append(('chmod', node.inode))
        if node.uid != self.uid: raise PermissionError(1, 'inert fchmod EPERM: not the owner')
        node.mode = mode
        self.chmods.append((node.inode, mode))

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
        # unlinkat(fd, name, 0): the name itself, a symlink's link and never its target; never a directory.
        self.attempts.append(('unlink', self.fds[fd].children[name].inode))
        self.need(self.fds[fd], 3)
        if self.fds[fd].children[name].kind == 'DIRECTORY': raise IsADirectoryError(21, 'inert EISDIR')
        node = self.fds[fd].children.pop(name)
        self.removed.append(('FILE', node.inode))

    def remove_directory(self, fd, name, expected):
        self.attempts.append(('rmdir', self.fds[fd].children[name].inode))
        self.need(self.fds[fd], 3)
        node = self.fds[fd].children[name]
        if node.kind != 'DIRECTORY' or node.children:
            raise OSError('directory not empty')
        del self.fds[fd].children[name]
        self.removed.append(('DIRECTORY', node.inode))


class Kernel:
    """The role's kernel port: the UID it runs as (P17) and its own five scope mounts as seen inside its view."""
    OWN = object()

    def __init__(self, role='BROWSER', *, uid=OWN):
        self.role, self.uid_value, self.calls = role, UIDS[role] if uid is Kernel.OWN else uid, []
        mounts = []
        for path in scopes(role):
            capacity = (CRASH_BYTES if path == '/run/acceptance/crash'
                        else SHM_BYTES if path == '/dev/shm' else RUN_BYTES)
            mounts.append((path, 'tmpfs', device_of(path), True, capacity, 4096))
        self.values = dict(base_read_only=True, writable_disks=0, active_swaps=(), zram_swaps=(),
                           hibernation=False, save_restore=False, persistent_crash=False, host_shares=(),
                           mounts=tuple(mounts))

    def uid(self):
        self.calls.append('uid')
        return self.uid_value

    def observe(self):
        self.calls.append('observe')
        return storage.KernelStorageState(
            self.values['base_read_only'], self.values['writable_disks'], self.values['active_swaps'],
            self.values['zram_swaps'], self.values['hibernation'], self.values['save_restore'],
            self.values['persistent_crash'], self.values['host_shares'],
            tuple(storage.MountObservation(*row) for row in self.values['mounts']))

    def mount(self, path, **changes):
        names = ('path', 'filesystem', 'device', 'writable', 'capacity_bytes', 'inode_limit')
        rows = list(self.values['mounts'])
        index = next(i for i, row in enumerate(rows) if row[0] == path)
        row = dict(zip(names, rows[index]))
        row.update(changes)
        rows[index] = tuple(row[name] for name in names)
        self.values['mounts'] = tuple(rows)


class StorageTests(unittest.TestCase):
    def setUp(self):
        if storage is None:
            self.fail('storage contract absent')
        self.fs, self.kernel = Filesystem(), Kernel()

    def need(self, *names):
        for name in names or INTERFACE:
            self.assertTrue(hasattr(storage, name), 'Task 14 per-role storage interface absent: ' + name)

    def policy(self, **changes):
        values = dict(
            policy_digest='a' * 64, base_read_only=True, writable_disks=0,
            run_state='TMPFS', guest_swap=False, zram_swap=False,
            hibernation=False, save_restore=False, persistent_crash=False,
            host_shares=False, run_tmpfs_bytes=RUN_BYTES,
            crash_tmpfs_bytes=CRASH_BYTES, shm_bytes=SHM_BYTES,
            tmpfs_inodes=4096)
        values.update(changes)
        return storage.StoragePolicy(**values)

    def denied(self, operation):
        with self.assertRaises(storage.StorageFailure) as raised: operation()
        self.assertEqual(str(raised.exception), 'STORAGE_INVALID')
        return raised.exception

    def admit(self, role='BROWSER', fs=None, kernel=None, policy=None):
        self.need('admit_role_storage')
        return storage.admit_role_storage(role, policy or self.policy(), self.fs if fs is None else fs,
                                          self.kernel if kernel is None else kernel)

    def admit_denied(self, fs, kernel, role='BROWSER', policy=None):
        self.need('admit_role_storage')
        return self.denied(lambda: storage.admit_role_storage(role, policy or self.policy(), fs, kernel))

    def removed_inodes(self, fs=None):
        return {inode for _, inode in (fs or self.fs).removed}

    # --- C7 (E5, R8): each role admits only its own scope, as its own UID -----------------------------------------
    def test_role_admits_only_its_own_scope_as_its_uid(self):
        self.need()
        self.assertEqual(dict(storage.UIDS), UIDS)
        self.assertEqual(dict(storage.ROLE_SCOPES), {role: scopes(role) for role in UIDS})
        for role, uid in UIDS.items():
            with self.subTest(role=role):
                fs, kernel = Filesystem(role, shared=True), Kernel(role)
                proof = storage.admit_role_storage(role, self.policy(), fs, kernel)
                self.assertEqual((proof.role, proof.uid, proof.scopes), (role, uid, scopes(role)))
                # Exactly this role's five scopes are opened, in order; never another role's root or a sibling.
                self.assertEqual(fs.opened_roots, list(scopes(role)))
                self.assertEqual(kernel.calls, ['uid', 'observe'])
                identities = tuple((path, fs.node(path).device, fs.node(path).inode) for path in scopes(role))
                self.assertEqual(proof.digest, storage.scope_digest(role, uid, identities))
        # A run root owned by another role is never this role's scope.
        fs = Filesystem('BROWSER')
        fs.node('/run/acceptance/browser').uid = fs.node('/run/acceptance/browser').gid = UIDS['CONTROLLER']
        self.admit_denied(fs, Kernel('BROWSER'))
        for role in ('ROOT', 'browser', None, ('BROWSER',)):
            with self.subTest(bad_role=role):
                self.admit_denied(Filesystem(), Kernel(), role=role)

    def test_admission_refuses_wrong_uid(self):
        self.need('admit_role_storage')
        for role, uid in UIDS.items():
            for wrong in tuple(other for other in UIDS.values() if other != uid) + (0, float(uid), str(uid), None):
                with self.subTest(role=role, uid=wrong):
                    fs, kernel = Filesystem(role), Kernel(role, uid=wrong)
                    self.admit_denied(fs, kernel, role=role)
                    # The UID is checked first: nothing is observed or opened under a wrong identity.
                    self.assertEqual((kernel.calls, fs.opened_roots, fs.fds), (['uid'], [], {}))

    def test_readability_tied_to_owning_uid(self):
        self.need('admit_role_storage')
        # An empty 0600 file the role itself cannot read fails, in every scope whose content the role reads.
        for path in ('/run/acceptance/browser', '/tmp', '/var', '/dev/shm'):
            with self.subTest(unreadable=path):
                fs = Filesystem()
                marker = fs.node(path).children['marker']
                marker.readable, marker.size, marker.allocated = False, 0, 0
                self.admit_denied(fs, Kernel())
                self.assertEqual(fs.fds, {})
        # A privileged port (uid 0) would read any mode, so it can never admit a role's scope.
        fs, kernel = Filesystem(), Kernel(uid=0)
        self.admit_denied(fs, kernel)
        self.assertEqual((kernel.calls, fs.opened_roots), (['uid'], []))
        # The readability check runs on descriptors the role opened itself; crash content is never opened.
        fs = Filesystem(); self.admit(fs=fs, kernel=Kernel())
        self.assertEqual(sorted(fs.file_opens), sorted(fs.node(path).children['marker'].inode for path in (
            '/run/acceptance/browser', '/tmp', '/var', '/dev/shm')))

    def test_task8_view_layout_admits(self):
        self.need('admit_role_storage')
        # Task 18 review P18-A: seen from outside the view, /run/acceptance/<role> held the root-owned .root and
        # admission always failed. Inside the role's own view (Task 8b pivot) the five scopes are the role-owned
        # binds and tmpfs roots under root-owned parents: a fresh launch is ADMITTED.
        for role in UIDS:
            with self.subTest(role=role):
                fs = Filesystem(role, markers=False)
                for directory in ('opt', 'usr', 'lib', 'lib64', 'etc', 'proc'):
                    fs.place('/' + directory, Node('DIRECTORY', 0o755, 0, device=254))
                fs.place('/dev/null', Node('OTHER', 0o666, 0, device=5))
                proof = storage.admit_role_storage(role, self.policy(), fs, Kernel(role))
                self.assertEqual(proof.scopes, scopes(role))
        # The outside-the-view layout (a root-owned .root inside the run root) still fails.
        fs = Filesystem()
        fs.node('/run/acceptance/browser').children['.root'] = Node('DIRECTORY', 0o755, 0)
        self.admit_denied(fs, Kernel())

    def test_role_visible_dev_shm_bound_is_64MiB_tmpfs(self):
        self.need('admit_role_storage')
        proof = self.admit()
        self.assertEqual([(m.path, m.capacity_bytes) for m in proof.mounts if m.path == '/dev/shm'],
                         [('/dev/shm', SHM_BYTES)])
        for name, changes in (('bind on the run device', dict(device=RUN_DEV)),
                              ('shares the crash device', dict(device=CRASH_DEV)),
                              ('64 MiB + 1', dict(capacity_bytes=SHM_BYTES + 1)),
                              ('64 MiB - 1', dict(capacity_bytes=SHM_BYTES - 1)),
                              ('run size', dict(capacity_bytes=RUN_BYTES)),
                              ('not tmpfs', dict(filesystem='ext4')),
                              ('read-only', dict(writable=False)),
                              ('no inode limit', dict(inode_limit=0))):
            with self.subTest(shm=name):
                fs, kernel = Filesystem(), Kernel()
                kernel.mount('/dev/shm', **changes)
                if 'device' in changes:
                    for node in fs.everything(fs.node('/dev/shm')): node.device = changes['device']
                self.admit_denied(fs, kernel)
        for name, edit in (('missing row', lambda rows: [r for r in rows if r[0] != '/dev/shm']),
                           ('duplicate row', lambda rows: rows + [next(r for r in rows if r[0] == '/dev/shm')])):
            with self.subTest(shm=name):
                fs, kernel = Filesystem(), Kernel()
                kernel.values['mounts'] = tuple(edit(list(kernel.values['mounts'])))
                self.admit_denied(fs, kernel)
        # C7 fixes the role tmpfs mount data (size, mode, uid, gid; no nr_inodes), so /dev/shm keeps the kernel's
        # default inode limit; the run and crash tmpfs inode limits stay exactly the policy's.
        kernel = Kernel(); kernel.mount('/dev/shm', inode_limit=524288)
        self.admit(fs=Filesystem(), kernel=kernel)
        for path in ('/tmp', '/run/acceptance/crash'):
            with self.subTest(inode_limit=path):
                kernel = Kernel(); kernel.mount(path, inode_limit=524288)
                self.admit_denied(Filesystem(), kernel)
        # Content is bounded by the role tmpfs size.
        fs = Filesystem(); marker = fs.node('/dev/shm').children['marker']
        marker.size = marker.allocated = SHM_BYTES + 1
        self.admit_denied(fs, Kernel())

    def test_crash_scope_reachable_per_role_and_aggregated_by_metadata(self):
        self.need('admit_role_storage', 'crash_aggregate', 'combine_crash_aggregates')
        aggregates = []
        for role in UIDS:
            with self.subTest(role=role):
                fs, kernel = Filesystem(role), Kernel(role)
                fs.node('/run/acceptance/crash').children['nested'] = Node(
                    'DIRECTORY', 0o700, UIDS[role], size=17, allocated=4096, device=CRASH_DEV, purpose='CRASH')
                proof = storage.admit_role_storage(role, self.policy(), fs, kernel)
                aggregate = storage.crash_aggregate(proof.crash_root_fd, proof=proof)
                self.assertEqual(dataclasses.asdict(aggregate), {
                    'policy_digest': 'a' * 64, 'file_count': 1, 'directory_count': 1, 'logical_bytes': 21,
                    'allocated_bytes': 8192, 'crash_contents_read': False})
                self.assertNotIn(fs.node('/run/acceptance/crash').children['marker'].inode, fs.file_opens)
                self.denied(lambda: storage.crash_aggregate(proof.crash_root_fd + 1000, proof=proof))
                aggregates.append(aggregate)
        total = storage.combine_crash_aggregates(tuple(aggregates))
        self.assertEqual(dataclasses.asdict(total), {
            'policy_digest': 'a' * 64, 'file_count': 4, 'directory_count': 4, 'logical_bytes': 84,
            'allocated_bytes': 32768, 'crash_contents_read': False})
        one = aggregates[0]
        for name, value in (('three', tuple(aggregates[:3])), ('five', tuple(aggregates) + (one,)),
                            ('a list', list(aggregates)),
                            ('another policy', tuple(aggregates[:3]) + (dataclasses.replace(one, policy_digest='b' * 64),)),
                            ('contents read', tuple(aggregates[:3]) + (dataclasses.replace(one, crash_contents_read=True),)),
                            ('not an aggregate', tuple(aggregates[:3]) + (dataclasses.asdict(one),)),
                            ('boolean count', tuple(aggregates[:3]) + (dataclasses.replace(one, file_count=True),)),
                            ('negative bytes', tuple(aggregates[:3]) + (dataclasses.replace(one, logical_bytes=-1),)),
                            ('over the shared 1 MiB crash tmpfs',
                             tuple(dataclasses.replace(a, allocated_bytes=CRASH_BYTES // 4 + 1) for a in aggregates))):
            with self.subTest(combine=name):
                self.denied(lambda value=value: storage.combine_crash_aggregates(value))

    def test_deletion_owned_scope_only(self):
        self.need('admit_role_storage', 'remove_role_state')
        # Task 18 review T18-I3: one shared /run/acceptance parent holds every role's run root and an outside
        # sibling; after admission a device-drifted child and a symlink to the outside marker are planted in scope
        # and a file beside them. P66: the symlink itself is removed, never its target; the drifted subtree stays.
        fs, kernel = Filesystem('BROWSER', shared=True), Kernel('BROWSER')
        proof = self.admit(fs=fs, kernel=kernel)
        acceptance = fs.node('/run/acceptance')
        planted = acceptance.children['planted'] = Node('FILE', 0o600, UIDS['BROWSER'], size=3)
        kept = Node('FILE', 0o600, UIDS['BROWSER'], size=5, device=23)
        drifted = fs.node('/tmp').children['drifted'] = Node(
            'DIRECTORY', 0o700, UIDS['BROWSER'], device=23, children={'kept': kept})
        target = acceptance.children['outside'].children['marker']
        symlink = fs.node('/var').children['link'] = link('/run/acceptance/outside/marker', UIDS['BROWSER'])
        scope_nodes = {node.inode for path in scopes('BROWSER') for node in fs.everything(fs.node(path))}
        outside = [node for node in fs.everything() if node.inode not in scope_nodes]
        result = storage.remove_role_state(proof)
        self.assertEqual(dataclasses.asdict(result), {
            'guest_private_state_removed': False, 'host_residue_erased': False, 'code': 'CLEANUP_INCOMPLETE'})
        # Every node outside the role's five scopes survives, and so does the drifted subtree.
        survivors = {node.inode for node in fs.everything()}
        self.assertEqual([node.inode for node in outside if node.inode not in survivors], [])
        for node in (planted, drifted, kept, target, acceptance.children['outside'],
                     acceptance.children['controller'].children['marker']):
            self.assertIn(node.inode, survivors)
        self.assertEqual((target.size, target.mode), (99, 0o600))
        self.assertNotIn(symlink.inode, survivors)
        self.assertLessEqual(self.removed_inodes(fs), scope_nodes - {drifted.inode, kept.inode})
        # Nothing outside the scopes, nor the drifted subtree, is ever even attempted (removal or chmod).
        self.assertEqual([attempt for attempt in fs.attempts
                          if attempt[1] not in scope_nodes or attempt[1] in (drifted.inode, kept.inode)], [])
        # Scope roots are the role's mount points: never removed, identity unchanged.
        for path in scopes('BROWSER'):
            self.assertIn(fs.node(path).inode, survivors)
        # One-use: a second cleanup removes nothing more and reports incomplete.
        before = list(fs.removed)
        self.assertEqual(dataclasses.asdict(storage.remove_role_state(proof)), {
            'guest_private_state_removed': False, 'host_residue_erased': False, 'code': 'CLEANUP_INCOMPLETE'})
        self.assertEqual(fs.removed, before)

    def test_gid_mismatch_fails(self):
        self.need('admit_role_storage')
        # Task 18 review M18-3: the gid alone differs; the uid is the role's.
        for name, pick in (('file', lambda fs: fs.node('/tmp').children['marker']),
                           ('nested directory', lambda fs: fs.node('/var').children.setdefault(
                               'nested', Node('DIRECTORY', 0o700, UIDS['BROWSER']))),
                           ('scope root', lambda fs: fs.node('/dev/shm')),
                           ('crash file', lambda fs: fs.node('/run/acceptance/crash').children['marker'])):
            with self.subTest(node=name):
                fs = Filesystem()
                node = pick(fs); node.gid = UIDS['VERIFIER']
                self.admit_denied(fs, Kernel())

    def test_removal_time_swap_fails(self):
        self.need('admit_role_storage', 'remove_role_state')
        # Task 18 review M18-4: the node is swapped between its pre-removal and removal-time stats.
        fs = Filesystem(); proof = self.admit(fs=fs, kernel=Kernel())
        target = fs.node('/tmp').children['marker']
        fs.swap_node = target
        result = storage.remove_role_state(proof)
        self.assertEqual(result.code, 'CLEANUP_INCOMPLETE')
        self.assertFalse(result.guest_private_state_removed)
        self.assertNotIn(target.inode, self.removed_inodes(fs))
        self.assertIs(fs.node('/tmp').children.get('marker'), target)
        # Every other scope is still cleaned (best effort across scope roots).
        for path in ('/run/acceptance/browser', '/var', '/dev/shm', '/run/acceptance/crash'):
            self.assertEqual(fs.node(path).children, {}, path)
        # A directory swapped at removal time is refused the same way.
        fs = Filesystem()
        nested = fs.node('/var').children['nested'] = Node('DIRECTORY', 0o700, UIDS['BROWSER'])
        proof = self.admit(fs=fs, kernel=Kernel())
        fs.swap_node = nested
        self.assertEqual(storage.remove_role_state(proof).code, 'CLEANUP_INCOMPLETE')
        self.assertNotIn(nested.inode, self.removed_inodes(fs))

    def test_depth_bound(self):
        self.need('MAX_DEPTH', 'admit_role_storage', 'remove_role_state')
        self.assertEqual(storage.MAX_DEPTH, 64)
        def chain(depth):
            fs = Filesystem(); parent = fs.node('/tmp')
            for _ in range(depth):
                parent.children['d'] = Node('DIRECTORY', 0o700, UIDS['BROWSER'])
                parent = parent.children['d']
            return fs
        fs = chain(64)
        proof = self.admit(fs=fs, kernel=Kernel())
        self.assertEqual(storage.remove_role_state(proof).code, 'COMPLETE')
        self.assertEqual(fs.node('/tmp').children, {})
        self.admit_denied(chain(65), Kernel())

    def test_failure_traceback_has_no_names(self):
        self.need('admit_role_storage', 'crash_aggregate')
        # Task 18 review T18-M1: a failure never chains the native exception that names a private path or file.
        secret = 'private-crash-name-7f3a'
        def raising_open(fs):
            def open_root(path): raise OSError(2, secret)
            fs.open_root = open_root
        def bad_crash_mode(fs):
            fs.node('/run/acceptance/crash').children[secret] = Node(
                'FILE', 0o644, UIDS['BROWSER'], device=CRASH_DEV, purpose='CRASH')
        def bad_name(fs):
            fs.node('/tmp').children['a/' + secret] = Node('FILE', 0o600, UIDS['BROWSER'])
        def raising_stat(fs):
            fs.stat_failure = (fs.node('/var').children['marker'], secret)
        for name, setup in (('open', raising_open), ('crash mode', bad_crash_mode), ('name', bad_name),
                            ('stat', raising_stat)):
            with self.subTest(failure=name):
                fs = Filesystem(); setup(fs)
                error = self.admit_denied(fs, Kernel())
                self.assertIsNone(error.__context__)
                self.assertIsNone(error.__cause__)
                self.assertNotIn(secret, ''.join(traceback.format_exception(error)))
        fs = Filesystem(); proof = self.admit(fs=fs, kernel=Kernel())
        fs.stat_failure = (fs.node('/run/acceptance/crash'), secret)
        error = self.denied(lambda: storage.crash_aggregate(proof.crash_root_fd, proof=proof))
        self.assertIsNone(error.__context__)
        self.assertNotIn(secret, ''.join(traceback.format_exception(error)))

    def test_cleanup_continues_across_roots(self):
        self.need('admit_role_storage', 'remove_role_state')
        # Task 18 review T18-M2: an entry cleanup must leave (P66: another UID's file) planted in the first scope
        # after admission leaves that scope incomplete; every later scope is still cleaned and the result stays
        # incomplete.
        fs = Filesystem(); proof = self.admit(fs=fs, kernel=Kernel())
        loose = fs.node('/run/acceptance/browser').children['loose'] = Node('FILE', 0o600, UIDS['CONTROLLER'])
        result = storage.remove_role_state(proof)
        self.assertEqual(dataclasses.asdict(result), {
            'guest_private_state_removed': False, 'host_residue_erased': False, 'code': 'CLEANUP_INCOMPLETE'})
        self.assertNotIn(loose.inode, self.removed_inodes(fs))
        for path in ('/tmp', '/var', '/dev/shm', '/run/acceptance/crash'):
            self.assertEqual(fs.node(path).children, {}, path)

    # --- P66: post-run cleanup removes what the role created, without admission strictness --------------------------
    @staticmethod
    def plant_profile(fs, uid):
        """Chromium-like profile content the role created after launch: Singleton* symlinks pointing outside every
        scope (to a file, to a directory, and dangling), a Unix socket and a FIFO (kind OTHER), a 0500 directory
        holding a 0000 file and 0644 files, directories nested a few levels deep, and a socket directory in /tmp.
        Returns the role-owned directory outside the scopes that the links point into."""
        elsewhere = fs.place('/run/acceptance/elsewhere', Node('DIRECTORY', 0o700, uid, children={
            'lock-target': Node('FILE', 0o600, uid, size=12),
            'socket-dir': Node('DIRECTORY', 0o700, uid, children={'SingletonSocket': Node('OTHER', 0o755, uid)})}))
        fs.node('/run/acceptance/browser').children.update({
            'SingletonLock': link('/run/acceptance/elsewhere/lock-target', uid),
            'SingletonSocket': link('/run/acceptance/elsewhere/socket-dir', uid),
            'SingletonCookie': link('/run/acceptance/elsewhere/missing', uid),
            'socket': Node('OTHER', 0o755, uid), 'fifo': Node('OTHER', 0o644, uid),
            'Default': Node('DIRECTORY', 0o500, uid, children={
                'Preferences': Node('FILE', 0o644, uid, size=300), 'Lock': Node('FILE', 0o000, uid),
                'Cache': Node('DIRECTORY', 0o700, uid, children={
                    'Cache_Data': Node('DIRECTORY', 0o755, uid, children={
                        'index': Node('FILE', 0o600, uid, size=24), 'data_0': Node('FILE', 0o644, uid, size=8192),
                        'Code Cache': Node('DIRECTORY', 0o700, uid, children={
                            'js': Node('FILE', 0o600, uid, size=5)})})})})})
        fs.node('/tmp').children['.org.chromium.Chromium.Ab12Cd'] = Node(
            'DIRECTORY', 0o700, uid, children={'SingletonSocket': Node('OTHER', 0o755, uid)})
        return elsewhere

    @staticmethod
    def snapshot(nodes):
        return {node.inode: (node.kind, node.mode, node.uid, node.size, tuple(sorted(node.children)), node.target)
                for node in nodes}

    def test_cleanup_removes_chromium_profile_content_without_following_links(self):
        self.need('verify_role_scopes', 'remove_role_state')
        uid = UIDS['BROWSER']
        for when in ('planted after a pre-exec admission', 'present at the cleanup verification'):
            with self.subTest(content=when):
                fs = Filesystem('BROWSER', shared=True)
                if when.startswith('planted'):
                    proof = self.admit(fs=fs, kernel=Kernel()); elsewhere = self.plant_profile(fs, uid)
                else:
                    elsewhere = self.plant_profile(fs, uid)
                    proof = storage.verify_role_scopes('BROWSER', self.policy(), fs, Kernel())
                scope_nodes = {node.inode for path in scopes('BROWSER') for node in fs.everything(fs.node(path))}
                outside = [node for node in fs.everything() if node.inode not in scope_nodes]
                before = self.snapshot(outside)
                default = fs.node('/run/acceptance/browser').children['Default']
                opened = list(fs.file_opens)
                result = storage.remove_role_state(proof)
                self.assertEqual(dataclasses.asdict(result), {
                    'guest_private_state_removed': True, 'host_residue_erased': False, 'code': 'COMPLETE'})
                for path in scopes('BROWSER'):
                    self.assertEqual(fs.node(path).children, {}, path)
                # Nothing outside the scopes changed: the link targets (a file, a directory and its socket) included.
                self.assertEqual(self.snapshot(outside), before)
                self.assertEqual(sorted(elsewhere.children), ['lock-target', 'socket-dir'])
                self.assertEqual(sorted(elsewhere.children['socket-dir'].children), ['SingletonSocket'])
                self.assertEqual([a for a in fs.attempts if a[1] not in scope_nodes], [])
                # Only the role's own 0500 directory was made u+rwx, through its descriptor; no content was opened.
                self.assertEqual(fs.chmods, [(default.inode, 0o700)])
                self.assertEqual(fs.file_opens, opened)

    def test_cleanup_leaves_foreign_owned_device_crossing_and_too_deep_entries(self):
        self.need('admit_role_storage', 'remove_role_state')
        uid = UIDS['BROWSER']
        fs = Filesystem(); proof = self.admit(fs=fs, kernel=Kernel())
        var = fs.node('/var')
        foreign_file = var.children['root-owned'] = Node('FILE', 0o644, 0, size=7)
        foreign_dir = var.children['foreign-dir'] = Node('DIRECTORY', 0o500, 0, children={'x': Node('FILE', 0o600, 0)})
        crossed = fs.node('/tmp').children['mnt'] = Node('DIRECTORY', 0o500, uid, device=23, children={
            'inside': Node('FILE', 0o600, uid, device=23)})
        chain = parent = fs.node('/dev/shm')
        for _ in range(storage.MAX_DEPTH + 1):
            parent.children['d'] = Node('DIRECTORY', 0o700, uid, device=SHM_DEV)
            parent = parent.children['d']
        deepest = parent
        left = [foreign_file, foreign_dir, foreign_dir.children['x'], crossed, crossed.children['inside']]
        before = self.snapshot(left)
        result = storage.remove_role_state(proof)
        self.assertEqual(dataclasses.asdict(result), {
            'guest_private_state_removed': False, 'host_residue_erased': False, 'code': 'CLEANUP_INCOMPLETE'})
        # Left exactly as found: never removed, never chmod'ed, never even attempted.
        self.assertEqual(self.snapshot(left), before)
        self.assertEqual([a for a in fs.attempts if a[1] in {node.inode for node in left}], [])
        self.assertEqual(fs.chmods, [])
        self.assertIn('root-owned', var.children); self.assertIn('foreign-dir', var.children)
        self.assertIn('mnt', fs.node('/tmp').children)
        # The directory past MAX_DEPTH stays, so its ancestors stay too; nothing below the bound was skipped.
        self.assertIs(fs.everything(chain)[-1], deepest)
        self.assertEqual(len(fs.everything(chain)), storage.MAX_DEPTH + 2)
        # Everything else in those scopes, and every other scope, is removed.
        for path in ('/var', '/tmp', '/dev/shm'):
            self.assertNotIn('marker', fs.node(path).children, path)
        for path in ('/run/acceptance/browser', '/run/acceptance/crash'):
            self.assertEqual(fs.node(path).children, {}, path)

    def test_cleanup_verification_checks_roots_as_admitted_and_admission_stays_strict(self):
        self.need('verify_role_scopes', 'admit_role_storage', 'remove_role_state')
        uid = UIDS['BROWSER']
        fs = Filesystem(); self.plant_profile(fs, uid)
        self.admit_denied(fs, Kernel())          # pre-exec admission is exactly as strict as before
        fs = Filesystem(); self.plant_profile(fs, uid)
        proof = storage.verify_role_scopes('BROWSER', self.policy(), fs, Kernel())
        self.assertEqual(proof.digest, storage.scope_digest('BROWSER', uid, tuple(
            (path, fs.node(path).device, fs.node(path).inode) for path in scopes('BROWSER'))))
        def device(fs, kernel):
            kernel.mount('/var', device=23)
        def shm_on_run(fs, kernel):
            kernel.mount('/dev/shm', device=RUN_DEV)
            for node in fs.everything(fs.node('/dev/shm')): node.device = RUN_DEV
        for name, change, port in (
                ('root mode 0755', lambda fs, k: setattr(fs.node('/tmp'), 'mode', 0o755), None),
                ('root owned by another role', lambda fs, k: setattr(fs.node('/var'), 'uid', UIDS['CONTROLLER']), None),
                ('root gid', lambda fs, k: setattr(fs.node('/var'), 'gid', UIDS['VERIFIER']), None),
                ('root not on its mount device', device, None),
                ('/dev/shm on the run device', shm_on_run, None),
                ('privileged port', None, Kernel(uid=0)),
                ('another role port', None, Kernel(uid=UIDS['PROXY']))):
            with self.subTest(verify=name):
                fs, kernel = Filesystem(), port or Kernel()
                self.plant_profile(fs, uid)
                if change: change(fs, kernel)
                self.denied(lambda: storage.verify_role_scopes('BROWSER', self.policy(), fs, kernel))
        # A root changed after verification leaves that scope untouched and incomplete; the others are cleaned.
        fs = Filesystem(); proof = storage.verify_role_scopes('BROWSER', self.policy(), fs, Kernel())
        fs.node('/var').mode = 0o755
        self.assertEqual(storage.remove_role_state(proof).code, 'CLEANUP_INCOMPLETE')
        self.assertIn('marker', fs.node('/var').children)
        self.assertEqual(fs.node('/tmp').children, {})

    def test_cleanup_crash_aggregate_is_metadata_only_without_admission_strictness(self):
        self.need('verify_role_scopes', 'crash_aggregate')
        uid = UIDS['BROWSER']
        fs = Filesystem(); crash = fs.node('/run/acceptance/crash')
        pending = Node('DIRECTORY', 0o500, uid, size=40, allocated=4096, device=CRASH_DEV, purpose='CRASH', children={
            'a.dmp': Node('FILE', 0o600, uid, size=10, allocated=4096, device=CRASH_DEV, purpose='CRASH')})
        crash.children.update({
            'report.dmp': Node('FILE', 0o644, uid, size=100, allocated=4096, device=CRASH_DEV, purpose='CRASH'),
            'pending': pending,
            'latest': link('/run/acceptance/browser/marker', uid, device=CRASH_DEV, purpose='CRASH'),
            'foreign': Node('FILE', 0o600, 0, size=5, allocated=4096, device=CRASH_DEV, purpose='CRASH')})
        self.admit_denied(fs, Kernel())          # the pre-exec admission still refuses this content
        opened = list(fs.file_opens)
        proof = storage.verify_role_scopes('BROWSER', self.policy(), fs, Kernel())
        aggregate = storage.crash_aggregate(proof.crash_root_fd, proof=proof)
        # marker, report.dmp, a.dmp and the link (its own 30 bytes); pending; never the foreign file.
        self.assertEqual(dataclasses.asdict(aggregate), {
            'policy_digest': 'a' * 64, 'file_count': 4, 'directory_count': 1, 'logical_bytes': 4 + 100 + 10 + 30 + 40,
            'allocated_bytes': 4096 * 4, 'crash_contents_read': False})
        self.assertEqual(fs.file_opens, opened)  # verification and the aggregate open no file at all
        self.assertEqual(fs.chmods, [(pending.inode, 0o700)])
        self.assertEqual(fs.node('/run/acceptance/browser').children['marker'].size, 4)

    # --- retained Task 18 contract, per role ----------------------------------------------------------------------
    def test_readonly_base_all_writable_tmpfs_no_swap(self):
        proof = self.admit()
        self.assertEqual(proof.policy_digest, 'a' * 64)
        self.assertEqual(self.kernel.calls, ['uid', 'observe'])
        self.assertEqual(tuple(m.path for m in proof.mounts), scopes('BROWSER'))
        for field, bad in [('base_read_only', False), ('writable_disks', 1),
                           ('active_swaps', ('/swap',)), ('zram_swaps', ('zram0',)),
                           ('hibernation', True), ('save_restore', True),
                           ('persistent_crash', True)]:
            with self.subTest(field=field):
                fs, kernel = Filesystem(), Kernel(); kernel.values[field] = bad
                self.admit_denied(fs, kernel)

    def test_0700_dirs_0600_files_correct_uid(self):
        self.admit()
        for change in [('root-mode', 0o755), ('file-mode', 0o640),
                       ('root-owner', 0), ('file-owner', 0)]:
            fs, kernel = Filesystem(), Kernel()
            root = fs.node('/run/acceptance/browser')
            if change[0] == 'root-mode': root.mode = change[1]
            if change[0] == 'file-mode': root.children['marker'].mode = change[1]
            if change[0] == 'root-owner': root.uid = root.gid = change[1]
            if change[0] == 'file-owner':
                root.children['marker'].uid = root.children['marker'].gid = change[1]
            with self.subTest(change=change[0]):
                self.admit_denied(fs, kernel)

    def test_unreadable_empty0600_wrong_owner_fail(self):
        for mutation in ('unreadable', 'empty-unreadable', 'wrong-owner'):
            fs, kernel = Filesystem(), Kernel()
            node = fs.node('/run/acceptance/browser').children['marker']
            if mutation == 'empty-unreadable': node.size = node.allocated = 0
            if mutation in ('unreadable', 'empty-unreadable'): node.readable = False
            else: node.uid = node.gid = UIDS['CONTROLLER']
            with self.subTest(mutation=mutation):
                self.admit_denied(fs, kernel)

    def test_symlink_hardlink_path_swap_fail(self):
        for mutation in ('symlink', 'hardlink', 'swap'):
            fs, kernel = Filesystem(), Kernel()
            node = fs.node('/tmp').children['marker']
            if mutation == 'symlink': node.kind = 'SYMLINK'
            if mutation == 'hardlink': node.nlink = 2
            if mutation == 'swap': fs.swap_node = node
            with self.subTest(mutation=mutation):
                self.admit_denied(fs, kernel)

    def test_proof_is_immutable_and_cleanup_scope_cannot_be_forged(self):
        proof = self.admit()
        self.assertFalse(hasattr(proof, '_filesystem'))
        with self.assertRaises(dataclasses.FrozenInstanceError):
            proof.policy_digest = 'b' * 64
        for field, value in (('policy_digest', 'b' * 64), ('role', 'CONTROLLER'), ('uid', 10001),
                             ('scopes', scopes('CONTROLLER')), ('digest', bytes(32))):
            with self.subTest(forged=field):
                forged = dataclasses.replace(proof, **{field: value})
                self.assertEqual(dataclasses.asdict(storage.remove_role_state(forged)), {
                    'guest_private_state_removed': False,
                    'host_residue_erased': False, 'code': 'CLEANUP_INCOMPLETE'})
        self.assertEqual(self.fs.removed, [])
        self.assertTrue(storage.remove_role_state(proof).guest_private_state_removed)

    def test_run_mounts_share_one_bounded_device_and_shm_crash_are_separate(self):
        for path, device in [('/tmp', 17), ('/var', 17), ('/dev/shm', RUN_DEV),
                             ('/run/acceptance/crash', RUN_DEV), ('/run/acceptance/crash', SHM_DEV)]:
            fs, kernel = Filesystem(), Kernel()
            kernel.mount(path, device=device)
            for node in fs.everything(fs.node(path)): node.device = device
            with self.subTest(path=path, device=device):
                self.admit_denied(fs, kernel)

    def test_nested_device_drift_and_directory_bytes_are_bounded(self):
        fs, kernel = Filesystem(), Kernel()
        fs.node('/tmp').children['marker'].device = 23
        self.admit_denied(fs, kernel)

        fs, kernel = Filesystem(), Kernel()
        crash = fs.node('/run/acceptance/crash')
        crash.children['nested'] = Node('DIRECTORY', 0o700, UIDS['BROWSER'], size=17, allocated=4096,
                                        device=CRASH_DEV, purpose='CRASH')
        proof = self.admit(fs=fs, kernel=kernel)
        aggregate = storage.crash_aggregate(proof.crash_root_fd, proof=proof)
        self.assertEqual((aggregate.file_count, aggregate.directory_count,
                          aggregate.logical_bytes, aggregate.allocated_bytes), (1, 1, 21, 8192))

        fs, kernel = Filesystem(), Kernel()
        fs.node('/run/acceptance/crash').children['nested'] = Node(
            'DIRECTORY', 0o700, UIDS['BROWSER'], size=0, allocated=CRASH_BYTES + 1,
            device=CRASH_DEV, purpose='CRASH')
        self.admit_denied(fs, kernel)

    def test_partial_admission_closes_current_descriptors_and_binds_exact_name(self):
        fs, kernel = Filesystem(), Kernel()
        fs.node('/var').mode = 0o755
        self.admit_denied(fs, kernel)
        self.assertEqual(fs.fds, {})

        for shape in ('SHORT', 'BAD_SECOND'):
            fs, kernel = Filesystem(), Kernel(); fs.open_shape = shape
            with self.subTest(shape=shape):
                self.admit_denied(fs, kernel)
                self.assertEqual(fs.fds, {})

        fs, kernel = Filesystem(), Kernel(); fs.root_name_override = 'other'
        self.admit_denied(fs, kernel)
        self.assertEqual(fs.fds, {})

    def test_crash_open_content_raises_if_called(self):
        proof = self.admit()
        aggregate = storage.crash_aggregate(proof.crash_root_fd, proof=proof)
        self.assertEqual(dataclasses.asdict(aggregate), {
            'policy_digest': 'a' * 64, 'file_count': 1,
            'directory_count': 0, 'logical_bytes': 4,
            'allocated_bytes': 4096, 'crash_contents_read': False})
        crash_inode = self.fs.node('/run/acceptance/crash').children['marker'].inode
        self.assertNotIn(crash_inode, self.fs.file_opens)

    def test_1MiB_crash_256MiB_run_bounds(self):
        for path, value in [('/run/acceptance/crash', CRASH_BYTES + 1),
                            ('/run/acceptance/browser', RUN_BYTES + 1)]:
            fs, kernel = Filesystem(), Kernel()
            node = fs.node(path).children['marker']; node.size = node.allocated = value
            with self.subTest(path=path):
                self.admit_denied(fs, kernel)
        # The three run scopes share one 256 MiB tmpfs: each under the bound alone, over it together.
        fs, kernel = Filesystem(), Kernel()
        for path in ('/run/acceptance/browser', '/tmp', '/var'):
            node = fs.node(path).children['marker']; node.size = node.allocated = RUN_BYTES // 3 + 1
        self.admit_denied(fs, kernel)
        for field, value in [('run_tmpfs_bytes', RUN_BYTES + 1),
                             ('crash_tmpfs_bytes', CRASH_BYTES + 1),
                             ('shm_bytes', SHM_BYTES + 1)]:
            with self.subTest(field=field):
                self.admit_denied(Filesystem(), Kernel(), policy=self.policy(**{field: value}))

    def test_host_share_or_disk_backed_path_fail(self):
        for mutation in ('host-share', 'disk', 'readonly-mutable', 'missing'):
            fs, kernel = Filesystem(), Kernel()
            if mutation == 'host-share': kernel.values['host_shares'] = ('virtiofs',)
            if mutation == 'disk': kernel.mount('/tmp', filesystem='ext4')
            if mutation == 'readonly-mutable': kernel.mount('/tmp', writable=False)
            if mutation == 'missing':
                kernel.values['mounts'] = tuple(r for r in kernel.values['mounts'] if r[0] != '/tmp')
            with self.subTest(mutation=mutation):
                self.admit_denied(fs, kernel)

    def test_host_residue_not_claimed_erased(self):
        proof = self.admit()
        result = storage.remove_role_state(proof)
        self.assertEqual(set(dataclasses.asdict(result)), {
            'guest_private_state_removed', 'host_residue_erased', 'code'})
        self.assertIs(result.host_residue_erased, False)
        self.assertNotIn('physical', repr(result).lower())
        self.assertNotIn('host_erased', repr(result).lower())

    def test_descriptor_close_failure_cannot_report_complete(self):
        proof = self.admit()
        self.fs.close_failures.add(proof.crash_root_fd)
        result = storage.remove_role_state(proof)
        self.assertFalse(result.guest_private_state_removed)
        self.assertFalse(result.host_residue_erased)
        self.assertEqual(result.code, 'CLEANUP_INCOMPLETE')

    def test_complete_cleanup_removes_every_scope_child_and_keeps_scope_roots(self):
        self.need('admit_role_storage', 'remove_role_state')
        proof = self.admit()
        result = storage.remove_role_state(proof)
        self.assertEqual(dataclasses.asdict(result), {
            'guest_private_state_removed': True, 'host_residue_erased': False, 'code': 'COMPLETE'})
        for path in scopes('BROWSER'):
            self.assertEqual(self.fs.node(path).children, {}, path)
        self.assertEqual(self.fs.fds, {})

    def test_release_closes_every_descriptor_and_retires_the_proof(self):
        self.need('admit_role_storage', 'release_role_storage', 'remove_role_state')
        # The pre-exec helper keeps only the digest: every descriptor admission opened is closed before exec.
        proof = self.admit()
        self.assertIs(storage.release_role_storage(proof), True)
        self.assertEqual(self.fs.fds, {})
        self.assertEqual(self.fs.removed, [])
        self.assertEqual(storage.remove_role_state(proof).code, 'CLEANUP_INCOMPLETE')
        self.assertIs(storage.release_role_storage(proof), False)
        fs = Filesystem(); proof = self.admit(fs=fs, kernel=Kernel())
        fs.close_failures.add(proof.crash_root_fd)
        self.assertIs(storage.release_role_storage(proof), False)

    def test_scope_digest_is_fixed_32_bytes_bound_to_role_uid_and_identities(self):
        self.need('scope_digest')
        # P17: the ready frame's fixed 32 bytes. Vector: SHA-256 over the domain and the canonical record.
        import hashlib, json
        identities = tuple((path, device_of(path), 1000 + index) for index, path in enumerate(scopes('PROXY')))
        record = json.dumps({'role': 'PROXY', 'scopes': [list(row) for row in identities], 'uid': 10004},
                            sort_keys=True, separators=(',', ':')).encode('ascii')
        expected = hashlib.sha256(b'acceptance:role-storage-scopes:v1\0' + record).digest()
        self.assertEqual(storage.scope_digest('PROXY', 10004, identities), expected)
        self.assertEqual(len(expected), 32)
        for name, args in (('wrong uid', ('PROXY', 10003, identities)),
                           ('unknown role', ('ROOT', 10004, identities)),
                           ('reordered', ('PROXY', 10004, identities[1:] + identities[:1])),
                           ('another role scope', ('BROWSER', 10002, identities)),
                           ('short', ('PROXY', 10004, identities[:4])),
                           ('list', ('PROXY', 10004, list(identities))),
                           ('boolean device', ('PROXY', 10004, ((identities[0][0], True, 1),) + identities[1:])),
                           ('zero inode', ('PROXY', 10004, ((identities[0][0], 7, 0),) + identities[1:]))):
            with self.subTest(digest=name):
                self.denied(lambda args=args: storage.scope_digest(*args))


if __name__ == '__main__': unittest.main()

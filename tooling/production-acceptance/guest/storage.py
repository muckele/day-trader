"""Fail-closed storage policy over caller-injected, descriptor-relative ports.

Importing this module performs no I/O. There is intentionally no native port,
host fallback, filesystem discovery, or automatic cleanup adapter.
"""
from dataclasses import dataclass, field
import re
import threading


RUN_BYTES = 256 * 1024 * 1024
CRASH_BYTES = 1024 * 1024
SHM_BYTES = 64 * 1024 * 1024
MAX_SAFE_INTEGER = 9007199254740991
ROOT_ROWS = (
    ('/run/acceptance/controller', 10001, 'RUN'),
    ('/run/acceptance/browser', 10002, 'RUN'),
    ('/run/acceptance/verifier', 10003, 'RUN'),
    ('/run/acceptance/proxy', 10004, 'RUN'),
    ('/run/acceptance/crash', 10001, 'CRASH'),
)
MUTABLE_PATHS = ('/run', '/tmp', '/var', '/dev/shm') + tuple(
    row[0] for row in ROOT_ROWS)
_HEX64 = re.compile(r'[0-9a-f]{64}')
_PROOF_STATES = {}
_PROOF_STATES_LOCK = threading.Lock()


class StorageFailure(ValueError):
    """Finite failure code that cannot include a private path or filename."""


def _fail():
    raise StorageFailure('STORAGE_INVALID')


@dataclass(frozen=True)
class NodeMetadata:
    kind: str
    mode: int
    uid: int
    gid: int
    device: int
    inode: int
    link_count: int
    logical_bytes: int
    allocated_bytes: int


@dataclass(frozen=True)
class MountObservation:
    path: str
    filesystem: str
    device: int
    writable: bool
    capacity_bytes: int
    inode_limit: int


@dataclass(frozen=True)
class KernelStorageState:
    base_read_only: bool
    writable_disks: int
    active_swaps: tuple
    zram_swaps: tuple
    hibernation: bool
    save_restore: bool
    persistent_crash: bool
    host_shares: tuple
    mounts: tuple


@dataclass(frozen=True)
class OwnedRoot:
    path: str
    uid: int
    purpose: str


@dataclass(frozen=True)
class StoragePolicy:
    policy_digest: str
    base_read_only: bool
    writable_disks: int
    run_state: str
    guest_swap: bool
    zram_swap: bool
    hibernation: bool
    save_restore: bool
    persistent_crash: bool
    host_shares: bool
    run_tmpfs_bytes: int
    crash_tmpfs_bytes: int
    shm_bytes: int
    tmpfs_inodes: int
    roots: tuple
    mutable_paths: tuple


@dataclass(frozen=True)
class CrashAggregate:
    policy_digest: str
    file_count: int
    directory_count: int
    logical_bytes: int
    allocated_bytes: int
    crash_contents_read: bool = False


@dataclass(frozen=True)
class CleanupResult:
    guest_private_state_removed: bool
    host_residue_erased: bool
    code: str


@dataclass(frozen=True)
class _RootBinding:
    spec: OwnedRoot
    parent_fd: int = field(repr=False)
    root_fd: int = field(repr=False)
    name: str = field(repr=False)
    identity: NodeMetadata = field(repr=False)


@dataclass(frozen=True, slots=True)
class StorageProof:
    policy_digest: str
    mutable_paths: tuple
    mounts: tuple
    root_count: int
    crash_root_fd: int = field(repr=False)
    _identity: object = field(repr=False, compare=False)


@dataclass
class _ProofState:
    policy_digest: str
    mutable_paths: tuple
    mounts: tuple
    root_count: int
    crash_root_fd: int
    filesystem: object = field(repr=False)
    bindings: tuple = field(repr=False)
    run_limit: int
    crash_limit: int
    inode_limit: int
    used: bool = False
    lock: object = field(default_factory=threading.Lock, repr=False)


@dataclass
class _Totals:
    files: int = 0
    directories: int = 0
    logical: int = 0
    allocated: int = 0
    inodes: int = 1

    def add(self, other):
        self.files += other.files
        self.directories += other.directories
        self.logical += other.logical
        self.allocated += other.allocated
        self.inodes += other.inodes
        return self


def _plain_integer(value, lower=0, upper=MAX_SAFE_INTEGER):
    return type(value) is int and lower <= value <= upper


def _metadata(value):
    if (type(value) is not NodeMetadata
            or value.kind not in ('DIRECTORY', 'FILE', 'SYMLINK', 'OTHER')
            or not _plain_integer(value.mode, 0, 0o7777)
            or not _plain_integer(value.uid)
            or not _plain_integer(value.gid)
            or not _plain_integer(value.device)
            or not _plain_integer(value.inode, 1)
            or not _plain_integer(value.link_count, 1)
            or not _plain_integer(value.logical_bytes)
            or not _plain_integer(value.allocated_bytes)):
        _fail()
    return value


def _same_identity(before, after):
    return (before.kind, before.mode, before.uid, before.gid,
            before.device, before.inode) == (
            after.kind, after.mode, after.uid, after.gid,
            after.device, after.inode)


def _validate_node(value, uid, kind):
    value = _metadata(value)
    if (value.kind != kind or value.uid != uid or value.gid != uid
            or value.mode != (0o700 if kind == 'DIRECTORY' else 0o600)):
        _fail()
    if kind == 'FILE' and value.link_count != 1:
        _fail()
    return value


def _name(value):
    if (type(value) is not str or not value or len(value) > 255
            or value in ('.', '..') or '/' in value or '\x00' in value):
        _fail()
    return value


def _check_totals(totals, byte_limit, inode_limit):
    if (totals.logical > byte_limit or totals.allocated > byte_limit
            or totals.inodes > inode_limit):
        _fail()


def _policy(value):
    expected_roots = tuple(OwnedRoot(*row) for row in ROOT_ROWS)
    if (type(value) is not StoragePolicy
            or type(value.policy_digest) is not str
            or _HEX64.fullmatch(value.policy_digest) is None
            or value.base_read_only is not True
            or value.writable_disks != 0 or type(value.writable_disks) is not int
            or value.run_state != 'TMPFS'
            or any(getattr(value, name) is not False for name in (
                'guest_swap', 'zram_swap', 'hibernation', 'save_restore',
                'persistent_crash', 'host_shares'))
            or value.run_tmpfs_bytes != RUN_BYTES
            or type(value.run_tmpfs_bytes) is not int
            or value.crash_tmpfs_bytes != CRASH_BYTES
            or type(value.crash_tmpfs_bytes) is not int
            or value.shm_bytes != SHM_BYTES or type(value.shm_bytes) is not int
            or not _plain_integer(value.tmpfs_inodes, 1024, 65536)
            or type(value.roots) is not tuple or value.roots != expected_roots
            or type(value.mutable_paths) is not tuple
            or value.mutable_paths != MUTABLE_PATHS):
        _fail()
    return value


def _kernel(value, policy):
    if (type(value) is not KernelStorageState
            or value.base_read_only is not True
            or value.writable_disks != 0 or type(value.writable_disks) is not int
            or type(value.active_swaps) is not tuple or value.active_swaps
            or type(value.zram_swaps) is not tuple or value.zram_swaps
            or value.hibernation is not False
            or value.save_restore is not False
            or value.persistent_crash is not False
            or type(value.host_shares) is not tuple or value.host_shares
            or type(value.mounts) is not tuple
            or len(value.mounts) != len(policy.mutable_paths)):
        _fail()
    mounts = {}
    for mount in value.mounts:
        if (type(mount) is not MountObservation or mount.path in mounts
                or mount.path not in policy.mutable_paths
                or mount.filesystem != 'tmpfs' or mount.writable is not True
                or not _plain_integer(mount.device)
                or not _plain_integer(mount.capacity_bytes, 1)
                or mount.inode_limit != policy.tmpfs_inodes
                or type(mount.inode_limit) is not int):
            _fail()
        expected_capacity = (policy.crash_tmpfs_bytes
                             if mount.path == '/run/acceptance/crash'
                             else policy.shm_bytes if mount.path == '/dev/shm'
                             else policy.run_tmpfs_bytes)
        if mount.capacity_bytes != expected_capacity:
            _fail()
        mounts[mount.path] = mount
    if set(mounts) != set(policy.mutable_paths):
        _fail()
    run_paths = tuple(path for path in policy.mutable_paths
                      if path not in ('/dev/shm', '/run/acceptance/crash'))
    run_devices = {mounts[path].device for path in run_paths}
    crash_device = mounts['/run/acceptance/crash'].device
    shm_device = mounts['/dev/shm'].device
    if (len(run_devices) != 1 or crash_device in run_devices
            or shm_device in run_devices or shm_device == crash_device):
        _fail()
    return tuple(mounts[path] for path in policy.mutable_paths)


def _inventory(filesystem, directory_fd, uid, purpose, expected_device,
               byte_limit, inode_limit):
    totals = _Totals()
    names = filesystem.list_names(directory_fd)
    if type(names) is not tuple or len(names) > inode_limit:
        _fail()
    if len(set(names)) != len(names):
        _fail()
    for raw_name in names:
        name = _name(raw_name)
        before = _metadata(filesystem.stat_child(directory_fd, name))
        if before.device != expected_device:
            _fail()
        if before.kind == 'FILE':
            _validate_node(before, uid, 'FILE')
            if purpose == 'RUN':
                descriptor = filesystem.open_file(directory_fd, name, before)
                try:
                    opened = _validate_node(filesystem.stat(descriptor), uid, 'FILE')
                    if (not _same_identity(before, opened)
                            or filesystem.readable(descriptor) is not True):
                        _fail()
                finally:
                    filesystem.close(descriptor)
            after = _validate_node(filesystem.stat_child(directory_fd, name), uid, 'FILE')
            if not _same_identity(before, after):
                _fail()
            totals.files += 1
            totals.inodes += 1
            totals.logical += after.logical_bytes
            totals.allocated += after.allocated_bytes
        elif before.kind == 'DIRECTORY':
            _validate_node(before, uid, 'DIRECTORY')
            descriptor = filesystem.open_directory(directory_fd, name, before)
            try:
                opened = _validate_node(filesystem.stat(descriptor), uid, 'DIRECTORY')
                if not _same_identity(before, opened):
                    _fail()
                child = _inventory(filesystem, descriptor, uid, purpose,
                                   expected_device, byte_limit, inode_limit)
            finally:
                filesystem.close(descriptor)
            after = _validate_node(filesystem.stat_child(directory_fd, name), uid,
                                   'DIRECTORY')
            if not _same_identity(before, after):
                _fail()
            totals.directories += 1
            totals.logical += after.logical_bytes
            totals.allocated += after.allocated_bytes
            totals.add(child)
        else:
            _fail()
        _check_totals(totals, byte_limit, inode_limit)
    return totals


def _binding_inventory(binding, filesystem, run_limit, crash_limit, inode_limit):
    root_before = _validate_node(filesystem.stat(binding.root_fd),
                                 binding.spec.uid, 'DIRECTORY')
    parent_before = _validate_node(
        filesystem.stat_child(binding.parent_fd, binding.name),
        binding.spec.uid, 'DIRECTORY')
    if (not _same_identity(binding.identity, root_before)
            or not _same_identity(root_before, parent_before)):
        _fail()
    limit = crash_limit if binding.spec.purpose == 'CRASH' else run_limit
    totals = _inventory(filesystem, binding.root_fd, binding.spec.uid,
                        binding.spec.purpose, binding.identity.device,
                        limit, inode_limit)
    root_after = _validate_node(filesystem.stat(binding.root_fd),
                                binding.spec.uid, 'DIRECTORY')
    parent_after = _validate_node(
        filesystem.stat_child(binding.parent_fd, binding.name),
        binding.spec.uid, 'DIRECTORY')
    if (not _same_identity(root_before, root_after)
            or not _same_identity(root_after, parent_after)):
        _fail()
    _check_totals(totals, limit, inode_limit)
    return totals


def _close_binding(filesystem, binding):
    return _close_descriptors(filesystem, (binding.root_fd, binding.parent_fd))


def _close_descriptors(filesystem, descriptors):
    complete = True
    seen = set()
    for descriptor in descriptors:
        if descriptor in seen:
            continue
        seen.add(descriptor)
        try:
            filesystem.close(descriptor)
        except Exception:
            complete = False
    return complete


def _discard_opened(filesystem, descriptors):
    _close_descriptors(filesystem, reversed(descriptors))


def _register_proof(state):
    identity = object()
    with _PROOF_STATES_LOCK:
        _PROOF_STATES[identity] = state
    return StorageProof(state.policy_digest, state.mutable_paths, state.mounts,
                        state.root_count, state.crash_root_fd, identity)


def _state_for(value):
    if type(value) is not StorageProof:
        _fail()
    with _PROOF_STATES_LOCK:
        state = _PROOF_STATES.get(value._identity)
    if (type(state) is not _ProofState
            or (value.policy_digest, value.mutable_paths, value.mounts,
                value.root_count, value.crash_root_fd) !=
               (state.policy_digest, state.mutable_paths, state.mounts,
                state.root_count, state.crash_root_fd)):
        _fail()
    return state


def _retire_state(proof):
    with _PROOF_STATES_LOCK:
        _PROOF_STATES.pop(proof._identity, None)


def _claim_cleanup(proof):
    state = _state_for(proof)
    with state.lock:
        if state.used:
            return None
        state.used = True
        return state


def admit_storage(manifest, filesystem, kernel_port):
    """Admit exact immutable policy and retain only proven owned root handles."""
    bindings = []
    opened_descriptors = []
    try:
        policy = _policy(manifest)
        mounts = _kernel(kernel_port.observe(), policy)
        mount_by_path = {item.path: item for item in mounts}
        run_totals = _Totals(inodes=0)
        crash_totals = None
        for root in policy.roots:
            opened = filesystem.open_root(root.path)
            if type(opened) is tuple:
                opened_descriptors.extend(
                    descriptor for descriptor in opened[:2]
                    if type(descriptor) is int)
            if type(opened) is not tuple or len(opened) != 3:
                _fail()
            parent_fd, root_fd, name = opened
            if (type(parent_fd) is not int or type(root_fd) is not int
                    or parent_fd == root_fd):
                _fail()
            name = _name(name)
            if name != root.path.rsplit('/', 1)[1]:
                _fail()
            identity = _validate_node(filesystem.stat(root_fd), root.uid,
                                      'DIRECTORY')
            parent_identity = _validate_node(
                filesystem.stat_child(parent_fd, name), root.uid, 'DIRECTORY')
            if (identity.device != mount_by_path[root.path].device
                    or not _same_identity(identity, parent_identity)):
                _fail()
            binding = _RootBinding(root, parent_fd, root_fd, name, identity)
            bindings.append(binding)
            totals = _binding_inventory(
                binding, filesystem, policy.run_tmpfs_bytes,
                policy.crash_tmpfs_bytes, policy.tmpfs_inodes)
            if root.purpose == 'CRASH':
                crash_totals = totals
            else:
                run_totals.add(totals)
                _check_totals(run_totals, policy.run_tmpfs_bytes,
                              policy.tmpfs_inodes)
        if crash_totals is None:
            _fail()
        crash_binding = next(item for item in bindings
                             if item.spec.purpose == 'CRASH')
        return _register_proof(_ProofState(
            policy.policy_digest, policy.mutable_paths, mounts, len(bindings),
            crash_binding.root_fd, filesystem, tuple(bindings),
            policy.run_tmpfs_bytes, policy.crash_tmpfs_bytes,
            policy.tmpfs_inodes))
    except StorageFailure:
        _discard_opened(filesystem, opened_descriptors)
        raise
    except Exception:
        _discard_opened(filesystem, opened_descriptors)
        _fail()


def _proof(value):
    state = _state_for(value)
    if (type(state.bindings) is not tuple or len(state.bindings) != 5
            or state.root_count != 5 or state.mutable_paths != MUTABLE_PATHS
            or state.run_limit != RUN_BYTES or state.crash_limit != CRASH_BYTES
            or not _plain_integer(state.inode_limit, 1024, 65536)):
        _fail()
    return state


def crash_aggregate(root_fd: int, *, proof):
    """Return bounded crash metadata without opening a crash file."""
    try:
        state = _proof(proof)
        with state.lock:
            if (type(root_fd) is not int or root_fd != state.crash_root_fd
                    or state.used):
                _fail()
            binding = next(item for item in state.bindings
                           if item.spec.purpose == 'CRASH')
            totals = _binding_inventory(
                binding, state.filesystem, state.run_limit,
                state.crash_limit, state.inode_limit)
            return CrashAggregate(state.policy_digest, totals.files,
                                  totals.directories, totals.logical,
                                  totals.allocated, False)
    except StorageFailure:
        raise
    except Exception:
        _fail()


def _remove_children(filesystem, directory_fd, uid, purpose, expected_device,
                     byte_limit, inode_limit):
    totals = _Totals()
    names = filesystem.list_names(directory_fd)
    if (type(names) is not tuple or len(names) > inode_limit
            or len(set(names)) != len(names)):
        _fail()
    for raw_name in names:
        name = _name(raw_name)
        before = _metadata(filesystem.stat_child(directory_fd, name))
        if before.device != expected_device:
            _fail()
        if before.kind == 'FILE':
            _validate_node(before, uid, 'FILE')
            if purpose == 'RUN':
                descriptor = filesystem.open_file(directory_fd, name, before)
                try:
                    opened = _validate_node(filesystem.stat(descriptor), uid, 'FILE')
                    if (not _same_identity(before, opened)
                            or filesystem.readable(descriptor) is not True):
                        _fail()
                finally:
                    filesystem.close(descriptor)
            after = _validate_node(filesystem.stat_child(directory_fd, name), uid, 'FILE')
            if not _same_identity(before, after):
                _fail()
            totals.files += 1
            totals.inodes += 1
            totals.logical += after.logical_bytes
            totals.allocated += after.allocated_bytes
            _check_totals(totals, byte_limit, inode_limit)
            filesystem.unlink(directory_fd, name, after)
        elif before.kind == 'DIRECTORY':
            _validate_node(before, uid, 'DIRECTORY')
            descriptor = filesystem.open_directory(directory_fd, name, before)
            try:
                opened = _validate_node(filesystem.stat(descriptor), uid, 'DIRECTORY')
                if not _same_identity(before, opened):
                    _fail()
                child = _remove_children(filesystem, descriptor, uid, purpose,
                                         expected_device, byte_limit,
                                         inode_limit)
            finally:
                filesystem.close(descriptor)
            after = _validate_node(filesystem.stat_child(directory_fd, name), uid,
                                   'DIRECTORY')
            if not _same_identity(before, after):
                _fail()
            totals.directories += 1
            totals.logical += after.logical_bytes
            totals.allocated += after.allocated_bytes
            totals.add(child)
            _check_totals(totals, byte_limit, inode_limit)
            filesystem.remove_directory(directory_fd, name, after)
        else:
            _fail()
    return totals


def remove_owned_state(proof):
    """Remove only sealed descriptor-retained roots; never claim host erasure."""
    try:
        state = _claim_cleanup(proof)
    except Exception:
        return CleanupResult(False, False, 'CLEANUP_INCOMPLETE')
    if state is None:
        return CleanupResult(False, False, 'CLEANUP_INCOMPLETE')
    filesystem = state.filesystem
    complete = False
    try:
        for binding in state.bindings:
            root_before = _validate_node(filesystem.stat(binding.root_fd),
                                         binding.spec.uid, 'DIRECTORY')
            parent_before = _validate_node(
                filesystem.stat_child(binding.parent_fd, binding.name),
                binding.spec.uid, 'DIRECTORY')
            if (not _same_identity(binding.identity, root_before)
                    or not _same_identity(root_before, parent_before)):
                _fail()
            limit = (state.crash_limit if binding.spec.purpose == 'CRASH'
                     else state.run_limit)
            _remove_children(filesystem, binding.root_fd, binding.spec.uid,
                             binding.spec.purpose, binding.identity.device,
                             limit, state.inode_limit)
            current = _validate_node(
                filesystem.stat_child(binding.parent_fd, binding.name),
                binding.spec.uid, 'DIRECTORY')
            if not _same_identity(binding.identity, current):
                _fail()
            filesystem.remove_root(binding.parent_fd, binding.name, current)
        complete = True
    except Exception:
        complete = False
    finally:
        close_results = tuple(_close_binding(filesystem, binding)
                              for binding in state.bindings)
        close_complete = all(close_results)
        complete = complete and close_complete
        _retire_state(proof)
    return CleanupResult(complete, False,
                         'COMPLETE' if complete else 'CLEANUP_INCOMPLETE')

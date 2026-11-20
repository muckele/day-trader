"""Per-role private storage (C7, E5, R8) over caller-injected, descriptor-relative ports.

Each role admits, inventories and cleans only its own five scopes, ROLE_SCOPES[role], as seen inside its own view
and as its own UID: the per-role pre-exec helper admits before exec, and a fixed confined cleanup child removes
(guest/confinement.py). /tmp, /var and the role's run directory share the bounded /run tmpfs; /dev/shm is the role's
own 64 MiB tmpfs; /run/acceptance/crash is the role's directory of the 1 MiB crash tmpfs, read as metadata only.
The bootstrap only sums the four roles' metadata aggregates.

Importing this module performs no I/O. There is intentionally no native port, host fallback, filesystem discovery,
or automatic cleanup adapter: a trusted embedding injects the filesystem and kernel ports. The role list is this
module's own (P17); it never imports confinement.
"""
from dataclasses import dataclass, field
import hashlib
import json
import re
import threading
from types import MappingProxyType


RUN_BYTES = 256 * 1024 * 1024
CRASH_BYTES = 1024 * 1024
SHM_BYTES = 64 * 1024 * 1024
MAX_SAFE_INTEGER = 9007199254740991
# Directories nested below a scope root, at most (T18-M3): an explicit bound, never RecursionError.
MAX_DEPTH = 64
UIDS = MappingProxyType({'CONTROLLER': 10001, 'BROWSER': 10002, 'VERIFIER': 10003, 'PROXY': 10004})
# Paths as seen inside each role's own view (C7).
ROLE_SCOPES = MappingProxyType({
    role: ('/run/acceptance/' + role.lower(), '/tmp', '/var', '/dev/shm', '/run/acceptance/crash')
    for role in UIDS})
_SHM_SCOPE = '/dev/shm'
_CRASH_SCOPE = '/run/acceptance/crash'
_DIGEST_DOMAIN = b'acceptance:role-storage-scopes:v1\0'
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
    """The appliance's storage facts and the role's own five scope mounts, as the role's kernel port reports them."""
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
class _ScopeBinding:
    path: str
    purpose: str
    parent_fd: int = field(repr=False)
    root_fd: int = field(repr=False)
    name: str = field(repr=False)
    identity: NodeMetadata = field(repr=False)


@dataclass(frozen=True, slots=True)
class RoleStorageProof:
    """One role's admission. digest is the fixed 32 bytes the ready frame carries (P17)."""
    role: str
    uid: int
    policy_digest: str
    scopes: tuple
    mounts: tuple
    crash_root_fd: int = field(repr=False)
    digest: bytes = field(repr=False)
    _identity: object = field(repr=False, compare=False)


@dataclass
class _ProofState:
    role: str
    uid: int
    policy_digest: str
    scopes: tuple
    mounts: tuple
    crash_root_fd: int
    digest: bytes
    filesystem: object = field(repr=False)
    bindings: tuple = field(repr=False)
    limits: dict = field(repr=False)
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


def _purpose(path):
    return 'CRASH' if path == _CRASH_SCOPE else 'SHM' if path == _SHM_SCOPE else 'RUN'


def _policy(value):
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
            or not _plain_integer(value.tmpfs_inodes, 1024, 65536)):
        _fail()
    return value


def _kernel(value, policy, scopes):
    """The appliance facts, then exactly the role's five scope mounts, each once, in ROLE_SCOPES order."""
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
            or len(value.mounts) != len(scopes)):
        _fail()
    mounts = {}
    for mount in value.mounts:
        if (type(mount) is not MountObservation or mount.path in mounts
                or mount.path not in scopes
                or mount.filesystem != 'tmpfs' or mount.writable is not True
                or not _plain_integer(mount.device)
                or not _plain_integer(mount.capacity_bytes, 1)
                or not _plain_integer(mount.inode_limit, 1)):
            _fail()
        purpose = _purpose(mount.path)
        expected_capacity = (policy.crash_tmpfs_bytes if purpose == 'CRASH'
                             else policy.shm_bytes if purpose == 'SHM'
                             else policy.run_tmpfs_bytes)
        # C7 fixes the role tmpfs mount data (size, mode, uid, gid; no nr_inodes), so /dev/shm keeps the
        # kernel's default inode limit; its size bounds it, and every traversal stays bounded by tmpfs_inodes.
        if (mount.capacity_bytes != expected_capacity
                or (purpose != 'SHM' and mount.inode_limit != policy.tmpfs_inodes)):
            _fail()
        mounts[mount.path] = mount
    if set(mounts) != set(scopes):
        _fail()
    run_devices = {mounts[path].device for path in scopes if _purpose(path) == 'RUN'}
    crash_device = mounts[_CRASH_SCOPE].device
    shm_device = mounts[_SHM_SCOPE].device
    if (len(run_devices) != 1 or crash_device in run_devices
            or shm_device in run_devices or shm_device == crash_device):
        _fail()
    return tuple(mounts[path] for path in scopes)


def _inventory(filesystem, directory_fd, uid, purpose, expected_device,
               byte_limit, inode_limit, depth):
    """Bounded metadata walk as the role. RUN and SHM files are opened by the role itself and must be readable;
    CRASH content is never opened."""
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
            if purpose != 'CRASH':
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
            if depth + 1 > MAX_DEPTH:
                _fail()
            descriptor = filesystem.open_directory(directory_fd, name, before)
            try:
                opened = _validate_node(filesystem.stat(descriptor), uid, 'DIRECTORY')
                if not _same_identity(before, opened):
                    _fail()
                child = _inventory(filesystem, descriptor, uid, purpose,
                                   expected_device, byte_limit, inode_limit, depth + 1)
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


def _root_unchanged(filesystem, binding, uid):
    root = _validate_node(filesystem.stat(binding.root_fd), uid, 'DIRECTORY')
    child = _validate_node(filesystem.stat_child(binding.parent_fd, binding.name), uid, 'DIRECTORY')
    if not _same_identity(binding.identity, root) or not _same_identity(root, child):
        _fail()


def _binding_inventory(binding, filesystem, uid, limits, inode_limit):
    _root_unchanged(filesystem, binding, uid)
    limit = limits[binding.purpose]
    totals = _inventory(filesystem, binding.root_fd, uid, binding.purpose,
                        binding.identity.device, limit, inode_limit, 0)
    _root_unchanged(filesystem, binding, uid)
    _check_totals(totals, limit, inode_limit)
    return totals


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


def _close_bindings(filesystem, bindings):
    results = [_close_descriptors(filesystem, (binding.root_fd, binding.parent_fd))
               for binding in bindings]
    return all(results)


def scope_digest(role, uid, identities):
    """P17: the fixed 32-byte binding of one role's five scope roots, (path, device, inode) in ROLE_SCOPES order.

    The pre-exec helper and the cleanup child send it from their admission proof; a probe family, which admits
    nothing, sends the same binding of its own view. The bootstrap recomputes it from /proc/<child>/root.
    """
    if (type(role) is not str or role not in UIDS or type(uid) is not int or uid != UIDS[role]
            or type(identities) is not tuple or len(identities) != len(ROLE_SCOPES[role])):
        _fail()
    rows = []
    for path, row in zip(ROLE_SCOPES[role], identities):
        if (type(row) is not tuple or len(row) != 3 or row[0] != path
                or not _plain_integer(row[1]) or not _plain_integer(row[2], 1)):
            _fail()
        rows.append([path, row[1], row[2]])
    record = json.dumps({'role': role, 'scopes': rows, 'uid': uid},
                        sort_keys=True, separators=(',', ':')).encode('ascii')
    return hashlib.sha256(_DIGEST_DOMAIN + record).digest()


def _open_scope(filesystem, path, uid, mount, opened):
    value = filesystem.open_root(path)
    if type(value) is tuple:
        opened.extend(descriptor for descriptor in value[:2] if type(descriptor) is int)
    if type(value) is not tuple or len(value) != 3:
        _fail()
    parent_fd, root_fd, name = value
    if (type(parent_fd) is not int or type(root_fd) is not int
            or parent_fd == root_fd):
        _fail()
    name = _name(name)
    if name != path.rsplit('/', 1)[1]:
        _fail()
    identity = _validate_node(filesystem.stat(root_fd), uid, 'DIRECTORY')
    child = _validate_node(filesystem.stat_child(parent_fd, name), uid, 'DIRECTORY')
    if identity.device != mount.device or not _same_identity(identity, child):
        _fail()
    return _ScopeBinding(path, _purpose(path), parent_fd, root_fd, name, identity)


def _admit(role, policy, filesystem, kernel_port, opened):
    if type(role) is not str or role not in UIDS:
        _fail()
    uid = UIDS[role]
    # The port must run as exactly this role (P17): a privileged port could read any mode.
    observed = kernel_port.uid()
    if type(observed) is not int or observed != uid:
        _fail()
    policy = _policy(policy)
    scopes = ROLE_SCOPES[role]
    mounts = _kernel(kernel_port.observe(), policy, scopes)
    limits = {'RUN': policy.run_tmpfs_bytes, 'SHM': policy.shm_bytes, 'CRASH': policy.crash_tmpfs_bytes}
    run_totals = _Totals(inodes=0)
    bindings = []
    for path, mount in zip(scopes, mounts):
        binding = _open_scope(filesystem, path, uid, mount, opened)
        bindings.append(binding)
        totals = _binding_inventory(binding, filesystem, uid, limits, policy.tmpfs_inodes)
        if binding.purpose == 'RUN':
            run_totals.add(totals)
            _check_totals(run_totals, policy.run_tmpfs_bytes, policy.tmpfs_inodes)
    digest = scope_digest(role, uid, tuple((b.path, b.identity.device, b.identity.inode) for b in bindings))
    crash_fd = next(b.root_fd for b in bindings if b.purpose == 'CRASH')
    state = _ProofState(role, uid, policy.policy_digest, scopes, mounts, crash_fd, digest, filesystem,
                        tuple(bindings), limits, policy.tmpfs_inodes)
    identity = object()
    with _PROOF_STATES_LOCK:
        _PROOF_STATES[identity] = state
    return RoleStorageProof(role, uid, policy.policy_digest, scopes, mounts, crash_fd, digest, identity)


def admit_role_storage(role, policy, filesystem, kernel_port):
    """C7 (E5, R8): admit exactly ROLE_SCOPES[role], as UIDS[role], inside the role's own view.

    STORAGE_INVALID unless kernel_port.uid() is the role's UID. Every failure closes the descriptors opened so
    far and is raised outside any handler, so no native exception (nor a name it holds) is chained (T18-M1).
    """
    opened = []
    proof = None
    try:
        proof = _admit(role, policy, filesystem, kernel_port, opened)
    except Exception:
        pass
    if proof is None:
        _close_descriptors(filesystem, reversed(opened))
        _fail()
    return proof


def _state_for(value):
    if type(value) is not RoleStorageProof:
        _fail()
    with _PROOF_STATES_LOCK:
        state = _PROOF_STATES.get(value._identity)
    if (type(state) is not _ProofState
            or (value.role, value.uid, value.policy_digest, value.scopes, value.mounts,
                value.crash_root_fd, value.digest) !=
               (state.role, state.uid, state.policy_digest, state.scopes, state.mounts,
                state.crash_root_fd, state.digest)
            or type(state.bindings) is not tuple or len(state.bindings) != len(ROLE_SCOPES[state.role])
            or state.scopes != ROLE_SCOPES[state.role] or state.uid != UIDS[state.role]
            or state.limits != {'RUN': RUN_BYTES, 'SHM': SHM_BYTES, 'CRASH': CRASH_BYTES}
            or not _plain_integer(state.inode_limit, 1024, 65536)):
        _fail()
    return state


def _claim(proof):
    """The proof's one use (removal or release); None when it was used, forged or retired."""
    try:
        state = _state_for(proof)
    except Exception:
        return None
    with state.lock:
        if state.used:
            return None
        state.used = True
        return state


def _retire(proof):
    with _PROOF_STATES_LOCK:
        _PROOF_STATES.pop(proof._identity, None)


def crash_aggregate(root_fd: int, *, proof):
    """Return bounded crash metadata of the proof's own role without opening a crash file."""
    aggregate = None
    try:
        state = _state_for(proof)
        with state.lock:
            if (type(root_fd) is int and root_fd == state.crash_root_fd and not state.used):
                binding = next(item for item in state.bindings if item.purpose == 'CRASH')
                totals = _binding_inventory(binding, state.filesystem, state.uid, state.limits,
                                            state.inode_limit)
                aggregate = CrashAggregate(state.policy_digest, totals.files, totals.directories,
                                           totals.logical, totals.allocated, False)
    except Exception:
        aggregate = None
    if aggregate is None:
        _fail()
    return aggregate


def combine_crash_aggregates(aggregates):
    """The bootstrap's sum of exactly the four roles' crash aggregates: metadata only, one policy, one 1 MiB tmpfs."""
    if type(aggregates) is not tuple or len(aggregates) != len(UIDS):
        _fail()
    for value in aggregates:
        if (type(value) is not CrashAggregate or type(value.policy_digest) is not str
                or _HEX64.fullmatch(value.policy_digest) is None
                or value.policy_digest != aggregates[0].policy_digest
                or value.crash_contents_read is not False
                or not all(_plain_integer(getattr(value, name)) for name in (
                    'file_count', 'directory_count', 'logical_bytes', 'allocated_bytes'))):
            _fail()
    total = CrashAggregate(aggregates[0].policy_digest,
                           *(sum(getattr(value, name) for value in aggregates) for name in (
                               'file_count', 'directory_count', 'logical_bytes', 'allocated_bytes')), False)
    if total.logical_bytes > CRASH_BYTES or total.allocated_bytes > CRASH_BYTES:
        _fail()
    return total


def _remove_children(filesystem, directory_fd, uid, purpose, expected_device,
                     byte_limit, inode_limit, depth, totals):
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
            if purpose != 'CRASH':
                descriptor = filesystem.open_file(directory_fd, name, before)
                try:
                    opened = _validate_node(filesystem.stat(descriptor), uid, 'FILE')
                    if (not _same_identity(before, opened)
                            or filesystem.readable(descriptor) is not True):
                        _fail()
                finally:
                    filesystem.close(descriptor)
            # Removal-time re-stat (T18-M3, M18-4): the node unlinked is the node just checked.
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
            if depth + 1 > MAX_DEPTH:
                _fail()
            descriptor = filesystem.open_directory(directory_fd, name, before)
            try:
                opened = _validate_node(filesystem.stat(descriptor), uid, 'DIRECTORY')
                if not _same_identity(before, opened):
                    _fail()
                _remove_children(filesystem, descriptor, uid, purpose, expected_device,
                                 byte_limit, inode_limit, depth + 1, totals)
            finally:
                filesystem.close(descriptor)
            after = _validate_node(filesystem.stat_child(directory_fd, name), uid,
                                   'DIRECTORY')
            if not _same_identity(before, after):
                _fail()
            totals.directories += 1
            totals.logical += after.logical_bytes
            totals.allocated += after.allocated_bytes
            _check_totals(totals, byte_limit, inode_limit)
            filesystem.remove_directory(directory_fd, name, after)
        else:
            _fail()


def _remove_scope(state, binding):
    """Remove one scope's children; the scope root is the role's mount point and stays. False on any refusal."""
    try:
        _root_unchanged(state.filesystem, binding, state.uid)
        _remove_children(state.filesystem, binding.root_fd, state.uid, binding.purpose,
                         binding.identity.device, state.limits[binding.purpose], state.inode_limit, 0, _Totals())
        _root_unchanged(state.filesystem, binding, state.uid)
        return True
    except Exception:
        return False


def remove_role_state(proof):
    """Remove only the proof's own role's scope contents; never claim host erasure.

    Best effort across every scope root (T18-M2): a refused node stops only its own scope, and any refusal or
    descriptor close failure makes the one-use result incomplete (sticky).
    """
    state = _claim(proof)
    if state is None:
        return CleanupResult(False, False, 'CLEANUP_INCOMPLETE')
    complete = True
    for binding in state.bindings:
        if not _remove_scope(state, binding):
            complete = False
    if not _close_bindings(state.filesystem, state.bindings):
        complete = False
    _retire(proof)
    return CleanupResult(complete, False, 'COMPLETE' if complete else 'CLEANUP_INCOMPLETE')


def release_role_storage(proof):
    """The pre-exec helper keeps only proof.digest: close every admitted descriptor and retire the proof.

    True only when this was the proof's one use and every descriptor closed.
    """
    state = _claim(proof)
    if state is None:
        return False
    closed = _close_bindings(state.filesystem, state.bindings)
    _retire(proof)
    return closed

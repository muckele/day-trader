"""Finite topology admission over injected observations; no native default.

This module neither reads proc/sys/net nor opens sockets. A separately approved
guest adapter must construct the typed snapshot from owned native observations.
"""
from dataclasses import asdict, dataclass
import hashlib
import json
import re


class TopologyError(ValueError):
    """Finite admission failure without raw kernel or role data."""


def _fail(code):
    raise TopologyError(code)


@dataclass(frozen=True)
class Listener:
    namespace: str
    transport: str
    address: str
    port: int
    uid: int


@dataclass(frozen=True)
class RoleInventory:
    role: str
    uid: int
    gids: tuple
    groups: tuple
    capabilities: tuple
    no_new_privs: int
    seccomp: int
    fds: tuple
    waiting: bool
    filter_digest: str


@dataclass(frozen=True)
class ProbeResult:
    identifier: str
    attempted: bool
    outcome: str
    owned_receiver_count: int


@dataclass(frozen=True)
class TopologyPolicy:
    run_id: str
    manifest_identity: str
    expires_at: int
    host_devices: tuple
    role_uids: tuple
    probe_ids: tuple


@dataclass(frozen=True)
class TopologySnapshot:
    run_id: str
    manifest_identity: str
    observed_at: int
    expires_at: int
    host_devices: tuple
    interfaces: tuple
    routes: tuple
    dns_servers: tuple
    listeners: tuple
    abstract_unix: tuple
    roles: tuple
    probes: tuple


@dataclass(frozen=True)
class AdmissionProof:
    run_id: str
    manifest_identity: str
    role_inventory_digest: str
    device_inventory_digest: str
    snapshot_digest: str
    expires_at: int


_RUN = re.compile(r'[0-9a-f]{32}')
_DIGEST = re.compile(r'[0-9a-f]{64}')
_ROLES = ('BROWSER', 'CONTROLLER', 'PROXY', 'VERIFIER')
_PROXY = Listener('GUEST', 'TCP', '127.0.0.1', 3128, 10004)


def _plain_integer(value, lower, upper):
    return type(value) is int and lower <= value <= upper


def _canonical_digest(value):
    wire = json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=True).encode('ascii')
    return hashlib.sha256(wire).hexdigest()


def _records(values):
    return [asdict(value) for value in values]


def _check_policy(expected):
    if (type(expected) is not TopologyPolicy
            or type(expected.run_id) is not str
            or _RUN.fullmatch(expected.run_id) is None
            or type(expected.manifest_identity) is not str
            or _DIGEST.fullmatch(expected.manifest_identity) is None
            or not _plain_integer(expected.expires_at, 1, 9007199254740991)
            or type(expected.host_devices) is not tuple
            or not expected.host_devices
            or any(type(item) is not str or not item for item in expected.host_devices)
            or len(set(expected.host_devices)) != len(expected.host_devices)
            or type(expected.role_uids) is not tuple
            or tuple(name for name, _ in expected.role_uids) != _ROLES
            or any(not _plain_integer(uid, 1, 2**32 - 1)
                   for _, uid in expected.role_uids)
            or len({uid for _, uid in expected.role_uids}) != len(_ROLES)
            or type(expected.probe_ids) is not tuple
            or not expected.probe_ids
            or tuple(sorted(set(expected.probe_ids))) != expected.probe_ids):
        _fail('POLICY_DENIED')


def _check_role(value, expected_uid):
    if (type(value) is not RoleInventory or value.uid != expected_uid
            or value.gids != (expected_uid,) or value.groups != ()
            or type(value.capabilities) is not tuple
            or len(value.capabilities) != 5
            or any(item != () for item in value.capabilities)
            or value.no_new_privs != 1 or value.seccomp != 2
            or value.fds != (0, 1, 2, 3, 4) or value.waiting is not True
            or type(value.filter_digest) is not str
            or _DIGEST.fullmatch(value.filter_digest) is None):
        _fail('ROLE_DENIED')


def _check_probe(value):
    if type(value) is not ProbeResult or value.attempted is not True:
        _fail('PROBE_DENIED')
    positive = value.identifier == 'PROXY_VSOCK_CONTROL'
    expected = ('ALLOWED', 1) if positive else ('DENIED', 0)
    if (value.outcome, value.owned_receiver_count) != expected:
        _fail('PROBE_DENIED')


def admit_topology(snapshot, expected):
    """Bind a complete exact observation to one run or fail closed."""
    _check_policy(expected)
    if type(snapshot) is not TopologySnapshot:
        _fail('SNAPSHOT_DENIED')
    if (snapshot.run_id != expected.run_id
            or snapshot.manifest_identity != expected.manifest_identity
            or snapshot.expires_at != expected.expires_at
            or not _plain_integer(snapshot.observed_at, 0,
                                  expected.expires_at - 1)):
        _fail('BINDING_DENIED')
    if (snapshot.host_devices != expected.host_devices
            or snapshot.interfaces != ('lo',)
            or snapshot.routes != () or snapshot.dns_servers != ()):
        _fail('TOPOLOGY_DENIED')
    if snapshot.listeners != (_PROXY,):
        _fail('LISTENER_DENIED')
    if snapshot.abstract_unix != ():
        _fail('ABSTRACT_UNIX_DENIED')
    if (type(snapshot.roles) is not tuple
            or tuple(item.role for item in snapshot.roles) != _ROLES):
        _fail('ROLE_DENIED')
    expected_uids = dict(expected.role_uids)
    for item in snapshot.roles:
        _check_role(item, expected_uids[item.role])
    if (type(snapshot.probes) is not tuple
            or tuple(item.identifier for item in snapshot.probes)
            != expected.probe_ids):
        _fail('PROBE_DENIED')
    for item in snapshot.probes:
        _check_probe(item)

    roles = _records(snapshot.roles)
    devices = {
        'hostDevices': snapshot.host_devices,
        'interfaces': snapshot.interfaces,
        'routes': snapshot.routes,
        'dnsServers': snapshot.dns_servers,
        'listeners': _records(snapshot.listeners),
        'abstractUnix': snapshot.abstract_unix,
    }
    stable = {
        'runId': snapshot.run_id,
        'manifestIdentity': snapshot.manifest_identity,
        'expiresAt': snapshot.expires_at,
        'devices': devices,
        'roles': roles,
        'probes': _records(snapshot.probes),
    }
    return AdmissionProof(
        run_id=snapshot.run_id,
        manifest_identity=snapshot.manifest_identity,
        role_inventory_digest=_canonical_digest(roles),
        device_inventory_digest=_canonical_digest(devices),
        snapshot_digest=_canonical_digest(stable),
        expires_at=snapshot.expires_at,
    )


class TopologyGate:
    """One admission followed by continuous exact observation; failure latches."""
    def __init__(self, expected):
        _check_policy(expected)
        self._expected = expected
        self._proof = None
        self._failed = False

    def admit(self, snapshot):
        if self._failed:
            _fail('TOPOLOGY_FAILED')
        if self._proof is not None:
            _fail('TOPOLOGY_FAILED')
        self._proof = admit_topology(snapshot, self._expected)
        return self._proof

    def observe(self, snapshot):
        if self._failed:
            _fail('TOPOLOGY_FAILED')
        if self._proof is None:
            self._failed = True
            _fail('TOPOLOGY_FAILED')
        try:
            current = admit_topology(snapshot, self._expected)
        except TopologyError:
            self._failed = True
            _fail('TOPOLOGY_DRIFT')
        if current != self._proof:
            self._failed = True
            _fail('TOPOLOGY_DRIFT')
        return self._proof

"""Bounded Task 10 topology admission and explicitly selected native adapter.

Import is inert. Native bindings are only constructed by ``select_native_topology``
for the pinned guest platform; this module never selects or executes them itself.
"""
from dataclasses import dataclass, field
import hashlib
import hmac
import importlib.util
import json
import os
import pathlib
import re
import sys
import threading
import asyncio
import inspect
import struct


class TopologyError(ValueError):
    """Finite public failure without raw observation data."""


class ActivationFailure(RuntimeError):
    """Typed failure that never drops the pre-effect cleanup transaction."""
    def __init__(self, code, cleanup):
        super().__init__(code)
        self.cleanup = cleanup


def _fail(code):
    raise TopologyError(code)


def _dependency(filename, name):
    target = pathlib.Path(__file__).with_name(filename).resolve()
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, target)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_CONFINEMENT = _dependency('confinement.py', '_acceptance_topology_confinement')
_PROXY = _dependency('proxy.py', '_acceptance_topology_proxy')
_RUN = re.compile(r'[0-9a-f]{32}')
_DIGEST = re.compile(r'[0-9a-f]{64}')
_MAX = 9007199254740991
_MAX_OBSERVATION_SKEW = 1

HOST_DEVICES = (
    'LINUX_BOOT', 'VIRTIO_BLOCK_READ_ONLY', 'VIRTIO_ENTROPY',
    'VIRTIO_SERIAL_PRIVATE_PIPE', 'VIRTIO_VSOCK_CID2_PORT4050',
)
ROLE_UIDS = tuple(_CONFINEMENT.UIDS.items())
FIXED_PROBE_IDS = (
    'BROWSER_FD_DONOR', 'BROWSER_HELPER_IPV4', 'BROWSER_HELPER_IPV6',
    'BROWSER_IO_URING', 'BROWSER_IPV4_TCP', 'BROWSER_IPV6_TCP',
    'BROWSER_UDP', 'BROWSER_VSOCK', 'CONTROLLER_DNS_TCP',
    'CONTROLLER_DNS_UDP', 'PROXY_VSOCK_CONTROL', 'VERIFIER_IPV4_TCP',
)
NATIVE_OBSERVATION_PATHS = (
    '/proc/net/dev', '/proc/net/route', '/proc/net/ipv6_route',
    '/etc/resolv.conf', '/proc/net/tcp', '/proc/net/tcp6',
    '/proc/net/udp', '/proc/net/udp6', '/proc/net/unix',
)
TASK8_PROBE_CASES = {
    'BROWSER_FD_DONOR': 'SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied',
    'BROWSER_HELPER_IPV4': 'child_fork_exec_network_gpu_crash_helper_inherits',
    'BROWSER_HELPER_IPV6': 'child_fork_exec_network_gpu_crash_helper_inherits',
    'BROWSER_IO_URING': 'io_uring_setup_register_enter_and_inherited_ring_denied',
    'BROWSER_VSOCK': 'vsock_browser_controller_verifier_denied',
    'PROXY_VSOCK_CONTROL': 'proxy_fixed_vsock_positive',
}


def _integer(value, lower=0, upper=_MAX):
    return type(value) is int and lower <= value <= upper


def _ascii(value, limit):
    return type(value) is str and value.isascii() and 0 < len(value) <= limit


def _digest(value):
    return type(value) is str and _DIGEST.fullmatch(value) is not None


def _sample(value):
    return (type(value) is tuple and len(value) == 2
            and _integer(value[0]) and _integer(value[1]))


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=True).encode('ascii')


def _keys(value, names):
    return type(value) is dict and set(value) == set(names)


def _wire_shape(value, depth=0):
    if depth > 12:
        return False
    if type(value) is dict:
        return (len(value) <= 128 and all(type(key) is str and _ascii(key, 64)
                and _wire_shape(item, depth + 1) for key, item in value.items()))
    if type(value) is list:
        return len(value) <= 256 and all(_wire_shape(item, depth + 1) for item in value)
    if type(value) is str:
        return value.isascii() and len(value) <= 4096
    if type(value) is int:
        return -_MAX <= value <= _MAX
    return type(value) is bool or value is None


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail('HANDOFF_DENIED')
        result[key] = value
    return result


def _json_integer(value):
    parsed = int(value, 10)
    if not -_MAX <= parsed <= _MAX:
        _fail('HANDOFF_DENIED')
    return parsed


def _json_forbidden(_value):
    _fail('HANDOFF_DENIED')


@dataclass(frozen=True)
class Listener:
    namespace: str
    transport: str
    address: str
    port: int
    uid: int


@dataclass(frozen=True)
class ProbeResult:
    identifier: str
    attempted: bool
    outcome: str
    owned_receiver_count: int


@dataclass(frozen=True)
class ProxyRuntime:
    run_id: str
    manifest_identity: str
    config_identity: str
    expires_at: int
    listen_address: str
    listen_port: int
    host_cid: int
    service_port: int
    uid: int


@dataclass(frozen=True)
class TopologySnapshot:
    sequence: int
    observed_wall: int
    observed_monotonic: int
    run_id: str
    manifest_identity: str
    config_identity: str
    host_devices: tuple
    interfaces: tuple
    routes: tuple
    dns_servers: tuple
    listeners: tuple
    abstract_unix: tuple
    role_handoffs: tuple
    probes: tuple
    proxy_runtime: ProxyRuntime


_AUTHORITY_SEAL = object()


@dataclass(frozen=True)
class TopologyAuthority:
    run_id: str
    manifest_identity: str
    config_identity: str
    expires_at: int
    capability: bytes = field(repr=False)
    role_launches: tuple = field(repr=False)
    proxy_policy: object = field(repr=False)
    clock: object = field(repr=False)
    appliance_recheck: object = field(repr=False)
    host_devices: tuple = HOST_DEVICES
    role_uids: tuple = ROLE_UIDS
    probe_ids: tuple = FIXED_PROBE_IDS
    _seal: object = field(default=None, repr=False, compare=False)


@dataclass(frozen=True)
class AdmissionProof:
    run_id: str
    manifest_identity: str
    config_identity: str
    role_inventory_digest: str
    device_inventory_digest: str
    topology_digest: str
    expires_at: int
    sequence: int
    canonical: str
    handoff: str


def _launches_valid(launches, run_id):
    if type(launches) is not tuple or len(launches) != len(ROLE_UIDS):
        return False
    for launch, (role, uid) in zip(launches, ROLE_UIDS):
        if (type(launch) is not _CONFINEMENT.RoleLaunch
                or getattr(launch, '_seal', None) is not _CONFINEMENT._SEAL
                or launch.role != role or launch.uid != uid
                or launch.run_id != run_id):
            return False
        try:
            expected = _CONFINEMENT.prepare_role(
                role, _CONFINEMENT.RoleConfig(
                    _CONFINEMENT.BootstrapConfig(object(), run_id, launch.programs),
                    _CONFINEMENT.role_fds(role, run_id)))
        except Exception:
            return False
        if launch != expected:
            return False
    return True


def qualify_topology_authority(*, run_id, manifest_identity, config_identity,
                               expires_at, capability, role_launches,
                               proxy_policy, clock, appliance_recheck):
    """Create fixed policy only from accepted Task 8/9 and run authority."""
    binding = getattr(proxy_policy, 'binding', None)
    if (type(run_id) is not str or _RUN.fullmatch(run_id) is None
            or not _digest(manifest_identity) or not _digest(config_identity)
            or not _integer(expires_at, 1) or type(capability) is not bytes
            or len(capability) != 32 or not _launches_valid(role_launches, run_id)
            or type(proxy_policy) is not _PROXY.NativeAdmissionPolicy
            or getattr(proxy_policy, '_seal', None) is not _PROXY._NATIVE_ADMISSION_SEAL
            or type(binding) is not _PROXY.RunBinding
            or binding.run_id != run_id or binding.manifest_identity != manifest_identity
            or binding.config_identity != config_identity or binding.expires_at != expires_at
            or not hmac.compare_digest(binding.capability, capability)
            or tuple(item[0] for item in proxy_policy.destinations)
                != ('FRONTEND', 'BACKEND')
            or not callable(getattr(clock, 'sample', None))
            or not callable(appliance_recheck)):
        _fail('AUTHORITY_DENIED')
    return TopologyAuthority(run_id, manifest_identity, config_identity,
                             expires_at, capability, role_launches, proxy_policy,
                             clock, appliance_recheck, _seal=_AUTHORITY_SEAL)


def _authority(value):
    if (type(value) is not TopologyAuthority
            or value._seal is not _AUTHORITY_SEAL
            or value.host_devices != HOST_DEVICES
            or value.role_uids != ROLE_UIDS
            or value.probe_ids != FIXED_PROBE_IDS
            or not _launches_valid(value.role_launches, value.run_id)):
        _fail('AUTHORITY_DENIED')


def _descriptor(value):
    if (type(value) is not _CONFINEMENT.Descriptor
            or not _integer(value.fd, 0, 1024)
            or not _ascii(value.kind, 32) or not _ascii(value.purpose, 32)
            or not _ascii(value.peer, 32) or value.run_id is None):
        _fail('ROLE_DENIED')
    return {'fd': value.fd, 'kind': value.kind, 'peer': value.peer,
            'purpose': value.purpose, 'runId': value.run_id}


def _program(value):
    if (type(value) is not _CONFINEMENT.ProgramPin
            or not _ascii(value.path, 256) or not _digest(value.sha256)):
        _fail('ROLE_DENIED')
    return {'path': value.path, 'sha256': value.sha256}


def _views(value):
    boolean_names = ('console', 'separate_pid', 'separate_mount',
                     'initial_user_namespace', 'controlling_tty',
                     'read_only_base', 'private_tmpfs',
                     'no_external_ip_interface', 'no_fd_donor')
    if (type(value) is not _CONFINEMENT.RoleViews
            or not _ascii(value.role, 32) or not _ascii(value.root, 256)
            or type(value.visible_roles) is not tuple
            or any(not _ascii(item, 32) for item in value.visible_roles)
            or not _integer(value.private_mode, 0, 0o7777)
            or type(value.device_nodes) is not tuple
            or any(not _ascii(item, 128) for item in value.device_nodes)
            or any(type(getattr(value, name)) is not bool for name in boolean_names)):
        _fail('ROLE_DENIED')
    return {
        'role': value.role, 'root': value.root,
        'visibleRoles': list(value.visible_roles), 'privateMode': value.private_mode,
        'console': value.console, 'separatePid': value.separate_pid,
        'separateMount': value.separate_mount,
        'initialUserNamespace': value.initial_user_namespace,
        'controllingTty': value.controlling_tty,
        'readOnlyBase': value.read_only_base,
        'deviceNodes': list(value.device_nodes), 'privateTmpfs': value.private_tmpfs,
        'noExternalIpInterface': value.no_external_ip_interface,
        'noFdDonor': value.no_fd_donor,
    }


def _role(handoff, expected):
    if (type(handoff) is not _CONFINEMENT.RoleHandoff
            or type(handoff.launch) is not _CONFINEMENT.RoleLaunch
            or handoff.launch != expected
            or getattr(handoff.launch, '_seal', None) is not _CONFINEMENT._SEAL
            or getattr(expected, '_seal', None) is not _CONFINEMENT._SEAL
            or type(handoff.attestation) is not _CONFINEMENT.RoleAttestation):
        _fail('ROLE_DENIED')
    value = handoff.attestation
    numeric_vectors = (value.uids, value.gids, value.groups, value.capabilities)
    if (not _integer(value.pid, 1, 2**31 - 1)
            or value.run_id != expected.run_id or value.role != expected.role
            or any(type(vector) is not tuple
                   or any(not _integer(item, 0, 2**32 - 1) for item in vector)
                   for vector in numeric_vectors)
            or value.uids != (expected.uid,) * 3
            or value.gids != (expected.uid,) * 3 or value.groups != ()
            or value.capabilities != (0,) * 5
            or type(value.no_new_privs) is not int or value.no_new_privs != 1
            or type(value.seccomp) is not int or value.seccomp != 2
            or type(value.waiting) is not bool or value.waiting is not True
            or value.filter_digest != hashlib.sha256(
                _CONFINEMENT.filter_bytes(expected.filter)).hexdigest()
            or type(value.fds) is not tuple or value.fds != expected.fds
            or value.views != expected.views or value.programs != expected.programs
            or getattr(handoff, '_kernel', None) is None
            or getattr(handoff, '_owned', None) is None):
        _fail('ROLE_DENIED')
    owned = handoff._owned
    if (getattr(owned, 'pid', None) != value.pid
            or getattr(owned, 'run_id', None) != value.run_id
            or getattr(owned, 'role', None) != value.role
            or getattr(owned, 'identity', None) is None
            or getattr(owned, 'command', None) is None
            or getattr(owned, 'result', None) is None
            or _CONFINEMENT._endpoint_key(owned.command)
                == _CONFINEMENT._endpoint_key(owned.result)):
        _fail('ROLE_DENIED')
    return {
        'pid': value.pid, 'runId': value.run_id, 'role': value.role,
        'uids': list(value.uids), 'gids': list(value.gids),
        'groups': list(value.groups), 'capabilities': list(value.capabilities),
        'noNewPrivs': value.no_new_privs, 'seccomp': value.seccomp,
        'filterDigest': value.filter_digest,
        'fds': [_descriptor(item) for item in value.fds],
        'views': _views(value.views), 'waiting': value.waiting,
        'programs': [_program(item) for item in value.programs],
    }


def _listener(value):
    if (type(value) is not Listener or value.namespace not in ('GUEST', 'HOST')
            or value.transport not in ('TCP', 'UDP')
            or not _ascii(value.address, 64) or not _integer(value.port, 1, 65535)
            or not _integer(value.uid, 1, 2**32 - 1)):
        _fail('LISTENER_DENIED')
    return {'namespace': value.namespace, 'transport': value.transport,
            'address': value.address, 'port': value.port, 'uid': value.uid}


def _probe(value, identifier):
    if (type(value) is not ProbeResult or value.identifier != identifier
            or type(value.attempted) is not bool or value.attempted is not True
            or type(value.outcome) is not str
            or not _integer(value.owned_receiver_count, 0, 1)):
        _fail('PROBE_DENIED')
    positive = identifier == 'PROXY_VSOCK_CONTROL'
    if ((value.outcome, value.owned_receiver_count)
            != (('ALLOWED', 1) if positive else ('DENIED', 0))):
        _fail('PROBE_DENIED')
    return {'attempted': True, 'identifier': identifier,
            'outcome': value.outcome,
            'ownedReceiverCount': value.owned_receiver_count}


def _strings(values, *, empty=False, limit=256):
    if (type(values) is not tuple or (not empty and not values)
            or any(not _ascii(item, limit) for item in values)
            or len(set(values)) != len(values)):
        _fail('TOPOLOGY_DENIED')
    return list(values)


def _payload(snapshot, expected, before, after):
    _authority(expected)
    if type(snapshot) is not TopologySnapshot:
        _fail('SNAPSHOT_DENIED')
    if (not _sample(before) or not _sample(after)
            or after[0] < before[0] or after[1] < before[1]
            or not _integer(snapshot.sequence, 1)
            or not _integer(snapshot.observed_wall)
            or not _integer(snapshot.observed_monotonic)
            or not before[0] <= snapshot.observed_wall <= after[0]
            or not before[1] <= snapshot.observed_monotonic <= after[1]
            or after[0] - snapshot.observed_wall > _MAX_OBSERVATION_SKEW
            or after[1] - snapshot.observed_monotonic > _MAX_OBSERVATION_SKEW
            or after[0] >= expected.expires_at
            or type(snapshot.run_id) is not str
            or type(snapshot.manifest_identity) is not str
            or type(snapshot.config_identity) is not str
            or snapshot.run_id != expected.run_id
            or snapshot.manifest_identity != expected.manifest_identity
            or snapshot.config_identity != expected.config_identity):
        _fail('BINDING_DENIED')
    if snapshot.host_devices != HOST_DEVICES:
        _fail('DEVICE_DENIED')
    interfaces = _strings(snapshot.interfaces)
    routes = _strings(snapshot.routes, empty=True)
    dns = _strings(snapshot.dns_servers, empty=True)
    abstract = _strings(snapshot.abstract_unix, empty=True)
    if snapshot.interfaces != ('lo',) or snapshot.routes or snapshot.dns_servers or snapshot.abstract_unix:
        _fail('TOPOLOGY_DENIED')
    if type(snapshot.listeners) is not tuple:
        _fail('LISTENER_DENIED')
    listeners = [_listener(item) for item in snapshot.listeners]
    exact_listener = Listener('GUEST', 'TCP', '127.0.0.1', 3128, 10004)
    if snapshot.listeners != (exact_listener,):
        _fail('LISTENER_DENIED')
    if type(snapshot.role_handoffs) is not tuple or len(snapshot.role_handoffs) != 4:
        _fail('ROLE_DENIED')
    roles = [_role(item, launch) for item, launch
             in zip(snapshot.role_handoffs, expected.role_launches)]
    owned = [item._owned for item in snapshot.role_handoffs]
    identities = [id(item.identity) for item in owned]
    endpoints = [key for item in owned for key in (
        _CONFINEMENT._endpoint_key(item.command),
        _CONFINEMENT._endpoint_key(item.result))]
    if (len({item['pid'] for item in roles}) != len(roles)
            or len({id(item) for item in owned}) != len(owned)
            or len(set(identities)) != len(identities)
            or len(set(endpoints)) != len(endpoints)
            or len({id(item) for item in snapshot.role_handoffs}) != len(roles)
            or len({id(item.launch) for item in snapshot.role_handoffs}) != len(roles)):
        _fail('ROLE_DENIED')
    if type(snapshot.probes) is not tuple or len(snapshot.probes) != len(FIXED_PROBE_IDS):
        _fail('PROBE_DENIED')
    probes = [_probe(item, identifier)
              for item, identifier in zip(snapshot.probes, FIXED_PROBE_IDS)]
    runtime = snapshot.proxy_runtime
    if (type(runtime) is not ProxyRuntime
            or type(runtime.run_id) is not str
            or type(runtime.manifest_identity) is not str
            or type(runtime.config_identity) is not str
            or not _integer(runtime.expires_at, 1)
            or type(runtime.listen_address) is not str
            or not _integer(runtime.listen_port, 1, 65535)
            or not _integer(runtime.host_cid, 1, 2**32 - 1)
            or not _integer(runtime.service_port, 1, 65535)
            or not _integer(runtime.uid, 1, 2**32 - 1)
            or runtime != ProxyRuntime(expected.run_id, expected.manifest_identity,
                                       expected.config_identity, expected.expires_at,
                                       '127.0.0.1', 3128, 2, 4050, 10004)):
        _fail('PROXY_DENIED')
    devices = {'abstractUnix': abstract, 'dnsServers': dns,
               'hostDevices': list(snapshot.host_devices),
               'interfaces': interfaces, 'listeners': listeners, 'routes': routes}
    return {
        'configIdentity': expected.config_identity, 'devices': devices,
        'expiresAt': expected.expires_at, 'manifestIdentity': expected.manifest_identity,
        'observedMonotonic': snapshot.observed_monotonic,
        'observedWall': snapshot.observed_wall,
        'probes': probes,
        'proxy': {'configIdentity': runtime.config_identity, 'expiresAt': runtime.expires_at,
                  'hostCid': runtime.host_cid, 'listenAddress': runtime.listen_address,
                  'listenPort': runtime.listen_port,
                  'manifestIdentity': runtime.manifest_identity,
                  'runId': runtime.run_id, 'servicePort': runtime.service_port,
                  'uid': runtime.uid},
        'roles': roles, 'runId': expected.run_id, 'sequence': snapshot.sequence,
    }


def _validate_payload(payload, expected):
    """Strict common wire schema and semantic policy used by both producer/consumer."""
    top = ('configIdentity', 'devices', 'expiresAt', 'manifestIdentity',
           'observedMonotonic', 'observedWall', 'probes', 'proxy', 'roles',
           'runId', 'sequence')
    if (not _keys(payload, top) or not _wire_shape(payload)
            or payload['runId'] != expected.run_id
            or payload['manifestIdentity'] != expected.manifest_identity
            or payload['configIdentity'] != expected.config_identity
            or type(payload['expiresAt']) is not int
            or payload['expiresAt'] != expected.expires_at
            or not _integer(payload['observedWall'])
            or not _integer(payload['observedMonotonic'])
            or not _integer(payload['sequence'], 1)
            or payload['observedWall'] >= expected.expires_at):
        _fail('HANDOFF_DENIED')
    devices = payload['devices']
    listener_rows = devices.get('listeners') if type(devices) is dict else None
    if (not _keys(devices, ('abstractUnix', 'dnsServers', 'hostDevices',
                            'interfaces', 'listeners', 'routes'))
            or devices['hostDevices'] != list(HOST_DEVICES)
            or devices['interfaces'] != ['lo'] or devices['routes'] != []
            or devices['dnsServers'] != [] or devices['abstractUnix'] != []
            or devices['listeners'] != [{
                'namespace': 'GUEST', 'transport': 'TCP',
                'address': '127.0.0.1', 'port': 3128, 'uid': 10004}]):
        _fail('HANDOFF_DENIED')
    listener = listener_rows[0]
    if (type(listener['port']) is not int or type(listener['uid']) is not int
            or any(type(listener[name]) is not str
                   for name in ('namespace', 'transport', 'address'))):
        _fail('HANDOFF_DENIED')
    roles = payload['roles']
    if type(roles) is not list or len(roles) != len(expected.role_launches):
        _fail('HANDOFF_DENIED')
    role_keys = ('capabilities', 'fds', 'filterDigest', 'gids', 'groups',
                 'noNewPrivs', 'pid', 'programs', 'role', 'runId', 'seccomp',
                 'uids', 'views', 'waiting')
    pids = []
    for row, launch in zip(roles, expected.role_launches):
        expected_views = _views(launch.views)
        expected_fds = [_descriptor(item) for item in launch.fds]
        expected_programs = [_program(item) for item in launch.programs]
        if (not _keys(row, role_keys) or not _integer(row['pid'], 1, 2**31 - 1)
                or row['runId'] != expected.run_id or row['role'] != launch.role
                or type(row['uids']) is not list
                or any(type(item) is not int for item in row['uids'])
                or type(row['gids']) is not list
                or any(type(item) is not int for item in row['gids'])
                or type(row['groups']) is not list
                or any(type(item) is not int for item in row['groups'])
                or type(row['capabilities']) is not list
                or any(type(item) is not int for item in row['capabilities'])
                or row['uids'] != [launch.uid] * 3
                or row['gids'] != [launch.uid] * 3 or row['groups'] != []
                or row['capabilities'] != [0] * 5
                or type(row['noNewPrivs']) is not int or row['noNewPrivs'] != 1
                or type(row['seccomp']) is not int or row['seccomp'] != 2
                or type(row['waiting']) is not bool or row['waiting'] is not True
                or row['filterDigest'] != hashlib.sha256(
                    _CONFINEMENT.filter_bytes(launch.filter)).hexdigest()
                or type(row['fds']) is not list or row['fds'] != expected_fds
                or type(row['views']) is not dict or row['views'] != expected_views
                or row['programs'] != expected_programs):
            _fail('HANDOFF_DENIED')
        for descriptor in row['fds']:
            if (not _keys(descriptor, ('fd', 'kind', 'peer', 'purpose', 'runId'))
                    or type(descriptor['fd']) is not int
                    or any(type(descriptor[name]) is not str
                           for name in ('kind', 'peer', 'purpose', 'runId'))):
                _fail('HANDOFF_DENIED')
        views = row['views']
        bool_views = ('console', 'separatePid', 'separateMount',
                      'initialUserNamespace', 'controllingTty', 'readOnlyBase',
                      'privateTmpfs', 'noExternalIpInterface', 'noFdDonor')
        if (type(views.get('privateMode')) is not int
                or any(type(views.get(name)) is not bool for name in bool_views)
                or type(views.get('visibleRoles')) is not list
                or type(views.get('deviceNodes')) is not list
                or any(type(item) is not str for item in
                       views['visibleRoles'] + views['deviceNodes'])):
            _fail('HANDOFF_DENIED')
        if (type(row['programs']) is not list
                or any(not _keys(pin, ('path', 'sha256'))
                       or type(pin['path']) is not str or type(pin['sha256']) is not str
                       for pin in row['programs'])):
            _fail('HANDOFF_DENIED')
        pids.append(row['pid'])
    if len(set(pids)) != len(pids):
        _fail('HANDOFF_DENIED')
    probes = payload['probes']
    if type(probes) is not list or len(probes) != len(FIXED_PROBE_IDS):
        _fail('HANDOFF_DENIED')
    for row, identifier in zip(probes, FIXED_PROBE_IDS):
        positive = identifier == 'PROXY_VSOCK_CONTROL'
        if (not _keys(row, ('attempted', 'identifier', 'outcome',
                            'ownedReceiverCount'))
                or row['identifier'] != identifier
                or type(row['attempted']) is not bool or row['attempted'] is not True
                or row['outcome'] != ('ALLOWED' if positive else 'DENIED')
                or type(row['ownedReceiverCount']) is not int
                or row['ownedReceiverCount'] != (1 if positive else 0)):
            _fail('HANDOFF_DENIED')
    proxy = payload['proxy']
    expected_proxy = {
        'configIdentity': expected.config_identity, 'expiresAt': expected.expires_at,
        'hostCid': 2, 'listenAddress': '127.0.0.1', 'listenPort': 3128,
        'manifestIdentity': expected.manifest_identity, 'runId': expected.run_id,
        'servicePort': 4050, 'uid': 10004,
    }
    if (not _keys(proxy, expected_proxy) or proxy != expected_proxy
            or any(type(proxy[name]) is not int for name in
                   ('expiresAt', 'hostCid', 'listenPort', 'servicePort', 'uid'))
            or any(type(proxy[name]) is not str for name in
                   ('configIdentity', 'listenAddress', 'manifestIdentity', 'runId'))):
        _fail('HANDOFF_DENIED')
    return payload


def admit_topology(snapshot, expected, before, after):
    """Revalidate complete Task8/9 evidence and authenticate a canonical handoff."""
    try:
        payload = _payload(snapshot, expected, before, after)
        _validate_payload(payload, expected)
        canonical = _canonical(payload)
        roles = _canonical(payload['roles'])
        devices = _canonical(payload['devices'])
        stable = dict(payload)
        stable.pop('sequence'); stable.pop('observedWall'); stable.pop('observedMonotonic')
        topology_digest = hashlib.sha256(_canonical(stable)).hexdigest()
        mac = hmac.new(expected.capability, canonical, hashlib.sha256).hexdigest()
        wire = _canonical({'mac': mac, 'payload': payload, 'version': 1}).decode('ascii')
        return AdmissionProof(
            expected.run_id, expected.manifest_identity, expected.config_identity,
            hashlib.sha256(roles).hexdigest(), hashlib.sha256(devices).hexdigest(),
            topology_digest, expected.expires_at, snapshot.sequence,
            canonical.decode('ascii'), wire)
    except TopologyError:
        raise
    except Exception:
        _fail('SNAPSHOT_DENIED')


def verify_handoff(wire, expected):
    """Verify the capability MAC, canonical bytes and complete independent policy."""
    _authority(expected)
    try:
        if type(wire) is not str or len(wire) > 131072 or not wire.isascii():
            _fail('HANDOFF_DENIED')
        envelope = json.loads(wire, object_pairs_hook=_json_object,
                              parse_int=_json_integer, parse_float=_json_forbidden,
                              parse_constant=_json_forbidden)
        if (type(envelope) is not dict or set(envelope) != {'mac', 'payload', 'version'}
                or type(envelope['version']) is not int or envelope['version'] != 1
                or type(envelope['mac']) is not str
                or _DIGEST.fullmatch(envelope['mac']) is None
                or type(envelope['payload']) is not dict
                or _canonical(envelope).decode('ascii') != wire):
            _fail('HANDOFF_DENIED')
        payload = envelope['payload']
        calculated = hmac.new(expected.capability, _canonical(payload), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calculated, envelope['mac']):
            _fail('HANDOFF_DENIED')
        return _validate_payload(payload, expected)
    except TopologyError:
        raise
    except Exception:
        _fail('HANDOFF_DENIED')


class TopologyGate:
    """Terminal, resampling admission gate with a Task8 one-use activation."""
    def __init__(self, expected, adapter, supervisor=None):
        _authority(expected)
        if not callable(getattr(adapter, 'capture', None)):
            _fail('ADAPTER_DENIED')
        if supervisor is not None and not callable(getattr(supervisor, 'begin', None)):
            _fail('ADAPTER_DENIED')
        self._expected, self._adapter, self._supervisor = expected, adapter, supervisor
        self._proof, self._snapshot = None, None
        self._failed, self._activated, self._sequence = False, False, 0
        self._last_clock, self._deadline = None, None
        self._lock = threading.RLock()
        self._generation, self._reservation = 0, None
        self._supervision = None
        self._owners, self._retired = [], set()
        self._snapshot_cleanup = False
        self.cleanup_uncertain = False

    def _clock(self):
        try:
            value = self._expected.clock.sample()
        except Exception:
            _fail('CLOCK_DENIED')
        with self._lock:
            previous = self._last_clock
        if (not _sample(value) or (previous is not None
                and (value[0] < previous[0] or value[1] < previous[1]))):
            _fail('CLOCK_DENIED')
        with self._lock:
            if self._last_clock is not previous:
                _fail('CLOCK_DENIED')
            self._last_clock = value
            if self._deadline is None:
                timeout = self._expected.proxy_policy.run_timeout_ms
                if not _integer(timeout, 1):
                    _fail('CLOCK_DENIED')
                self._deadline = value[1] + timeout
            deadline = self._deadline
        if value[0] >= self._expected.expires_at or value[1] >= deadline:
            _fail('TOPOLOGY_EXPIRED')
        return value

    def _reserve(self, *, initial):
        invalid = False
        with self._lock:
            if (self._failed or self._reservation is not None
                    or (initial and self._proof is not None)
                    or (not initial and self._proof is None)):
                invalid = True
            else:
                token = (self._generation, object())
                self._reservation = token
                sequence = self._sequence + 1
        if invalid:
            self._latch()
            _fail('TOPOLOGY_FAILED')
        return token, sequence

    def _retain(self, owner):
        if not callable(getattr(owner, 'stop_owned', None)):
            _fail('ADAPTER_DENIED')
        with self._lock:
            if all(item is not owner for item in self._owners):
                self._owners.append(owner)
            failed = self._failed
        if failed:
            self._cleanup()
            _fail('TOPOLOGY_DRIFT')

    def _cleanup(self):
        with self._lock:
            pending = [item for item in self._owners if id(item) not in self._retired]
            self._retired.update(id(item) for item in pending)
        for owner in reversed(pending):
            try:
                result = owner.stop_owned(120000)
                if (not hasattr(result, 'get') or result.get('status') not in ('STOPPED', 'EXITED')
                        or result.get('run_id', result.get('runId')) != self._expected.run_id):
                    raise ValueError('EXIT_DENIED')
            except Exception:
                self.cleanup_uncertain = True
        if self.cleanup_uncertain:
            _fail('CLEANUP_UNCERTAIN')

    def _latch(self):
        with self._lock:
            self._failed = True
            self._generation += 1
            self._reservation = None
            snapshot = self._snapshot if not self._snapshot_cleanup else None
            self._snapshot_cleanup = True
        try:
            self._cleanup()
        except TopologyError:
            self.cleanup_uncertain = True
        if snapshot is not None and callable(getattr(self._adapter, 'cleanup', None)):
            try: self._adapter.cleanup(snapshot)
            except Exception: self.cleanup_uncertain = True
        if self.cleanup_uncertain: _fail('CLEANUP_UNCERTAIN')

    def _attempt(self, *, initial):
        token, sequence = self._reserve(initial=initial)
        snapshot = None
        try:
            before = self._clock()
            self._expected.appliance_recheck()
            before = self._clock()
            snapshot = self._adapter.capture(sequence, self._expected)
            after = self._clock()
            self._expected.appliance_recheck()
            final = self._clock()
            proof = admit_topology(snapshot, self._expected, before, after)
            final = self._clock()
            if proof.sequence != sequence:
                _fail('SEQUENCE_DENIED')
            if final[0] >= self._expected.expires_at:
                _fail('TOPOLOGY_EXPIRED')
            with self._lock:
                if (self._failed or self._reservation is not token
                        or self._generation != token[0]):
                    _fail('TOPOLOGY_DRIFT')
                if self._proof is not None and (
                        proof.topology_digest != self._proof.topology_digest
                        or proof.role_inventory_digest != self._proof.role_inventory_digest
                        or proof.device_inventory_digest != self._proof.device_inventory_digest):
                    _fail('TOPOLOGY_DRIFT')
                self._sequence, self._proof, self._snapshot = sequence, proof, snapshot
                if not initial:
                    self._reservation = None
            return proof
        except Exception as error:
            self._latch()
            if snapshot is not None and callable(getattr(self._adapter, 'cleanup', None)):
                try:
                    self._adapter.cleanup(snapshot)
                except Exception:
                    _fail('CLEANUP_UNCERTAIN')
            if isinstance(error, TopologyError):
                raise
            _fail('OBSERVATION_DENIED')

    def admit(self):
        proof = self._attempt(initial=True)
        if self._supervisor is None:
            with self._lock:
                if self._failed: _fail('TOPOLOGY_DRIFT')
                self._reservation = None
            return proof
        handle = None
        try:
            handle = self._supervisor.begin(proof.handoff, self.topology_drifted)
            self._retain(handle)
            if not callable(getattr(handle, 'stop_owned', None)):
                _fail('ADAPTER_DENIED')
            with self._lock:
                if self._failed or self._supervision is not None:
                    _fail('TOPOLOGY_DRIFT')
                self._supervision = handle
            self._expected.appliance_recheck()
            self._clock()
            with self._lock:
                if self._failed: _fail('TOPOLOGY_DRIFT')
                self._reservation = None
            return proof
        except Exception as error:
            self._latch()
            if isinstance(error, TopologyError): raise
            _fail('OBSERVATION_DENIED')

    def require_current(self):
        return self._attempt(initial=False)

    def activate_browser(self, activation):
        proof = self.require_current()
        with self._lock:
            if self._failed or self._activated:
                self._failed = True
                self._generation += 1
                _fail('ACTIVATION_DENIED')
            self._activated = True
            token = self._generation
            browser = next(item for item in self._snapshot.role_handoffs
                           if item.launch.role == 'BROWSER')
        handle = None
        try:
            self._expected.appliance_recheck()
            self._clock()
            handle = activation.prepare(browser, proof)
            self._retain(handle)
            def authorize():
                self._expected.appliance_recheck()
                self._clock()
                with self._lock:
                    if self._failed or self._generation != token:
                        _fail('ACTIVATION_DENIED')
            handle.activate(authorize)
            with self._lock:
                invalid = self._failed or self._generation != token
            if invalid:
                _fail('ACTIVATION_DENIED')
            return handle
        except Exception as error:
            if isinstance(error, ActivationFailure):
                self._retain(error.cleanup)
            self._latch()
            _fail('ACTIVATION_DENIED')

    def topology_drifted(self):
        self._latch()


_NATIVE_SEAL = object()


def _text_lines(raw):
    try:
        return raw.decode('ascii').splitlines()
    except Exception:
        _fail('OBSERVATION_DENIED')


def _interfaces(raw):
    lines = _text_lines(raw)
    if len(lines) < 2 or 'Inter-|' not in lines[0] or 'face' not in lines[1]:
        _fail('OBSERVATION_DENIED')
    result = []
    for line in lines[2:]:
        if not line.strip():
            continue
        if ':' not in line:
            _fail('OBSERVATION_DENIED')
        name, counters = line.split(':', 1)
        name = name.strip()
        fields = counters.split()
        if not _ascii(name, 15) or len(fields) < 16 or any(
                not field.isdecimal() for field in fields):
            _fail('OBSERVATION_DENIED')
        result.append(name)
    if not result or len(set(result)) != len(result):
        _fail('OBSERVATION_DENIED')
    return tuple(result)


def _routes4(raw):
    lines = [line for line in _text_lines(raw) if line.strip()]
    if not lines or lines[0].split()[:4] != ['Iface', 'Destination', 'Gateway', 'Flags']:
        _fail('OBSERVATION_DENIED')
    result = []
    for line in lines[1:]:
        fields = line.split()
        if (len(fields) != 11 or not _ascii(fields[0], 15)
                or any(re.fullmatch(r'[0-9A-Fa-f]{8}', fields[index]) is None
                       for index in (1, 2, 7))
                or re.fullmatch(r'[0-9A-Fa-f]{4,8}', fields[3]) is None
                or any(not fields[index].isdecimal() for index in (4, 5, 6, 8, 9, 10))):
            _fail('OBSERVATION_DENIED')
        result.append('v4:' + ':'.join(fields[:4]))
    return tuple(result)


def _routes6(raw):
    result = []
    for line in _text_lines(raw):
        if not line.strip():
            continue
        fields = line.split()
        if (len(fields) != 10
                or any(re.fullmatch(r'[0-9A-Fa-f]{32}', fields[index]) is None
                       for index in (0, 2, 4))
                or any(re.fullmatch(r'[0-9A-Fa-f]{2,8}', fields[index]) is None
                       for index in (1, 3, 5, 6, 7, 8))
                or not _ascii(fields[9], 15)):
            _fail('OBSERVATION_DENIED')
        result.append('v6:' + ':'.join(fields))
    return tuple(result)


def _dns(raw):
    result = []
    for line in _text_lines(raw):
        content = re.split(r'[#;]', line, maxsplit=1)[0].strip()
        if not content:
            continue
        fields = content.split()
        if len(fields) != 2 or fields[0] != 'nameserver' or not _ascii(fields[1], 64):
            _fail('OBSERVATION_DENIED')
        result.append(fields[1])
    return tuple(result)


def _ipv4(hexadecimal):
    if re.fullmatch(r'[0-9A-Fa-f]{8}', hexadecimal) is None:
        _fail('OBSERVATION_DENIED')
    octets = bytes.fromhex(hexadecimal)
    return '.'.join(str(item) for item in reversed(octets))


def _ipv6(hexadecimal):
    if re.fullmatch(r'[0-9A-Fa-f]{32}', hexadecimal) is None:
        _fail('OBSERVATION_DENIED')
    if hexadecimal.upper() == '0000000000000000FFFF00000100007F':
        return '127.0.0.1'
    if hexadecimal == '0' * 31 + '1':
        return '::1'
    return hexadecimal.upper()


def _network_rows(raw, transport, version):
    lines = [line for line in _text_lines(raw) if line.strip()]
    header = ['sl', 'local_address', 'rem_address', 'st', 'tx_queue', 'rx_queue',
              'tr', 'tm->when', 'retrnsmt', 'uid', 'timeout', 'inode']
    ipv6_header = list(header); ipv6_header[2] = 'remote_address'
    accepted_headers = [header]
    if version == 6: accepted_headers.append(ipv6_header)
    if transport == 'UDP': accepted_headers.extend([row + ['ref', 'pointer', 'drops'] for row in accepted_headers[:]])
    if not lines or lines[0].split() not in accepted_headers:
        _fail('OBSERVATION_DENIED')
    listeners = []
    for line in lines[1:]:
        fields = line.split()
        if len(fields) != 17 or re.fullmatch(r'[0-9]+:', fields[0]) is None:
            _fail('OBSERVATION_DENIED')
        try:
            local_hex, local_port = fields[1].split(':')
            remote_hex, remote_port = fields[2].split(':')
            state = fields[3].upper()
            port = int(local_port, 16); remote = int(remote_port, 16)
            uid = int(fields[7], 10)
        except Exception:
            _fail('OBSERVATION_DENIED')
        if (re.fullmatch(r'[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8}', fields[4]) is None
                or re.fullmatch(r'[0-9A-Fa-f]{2}:[0-9A-Fa-f]{8}', fields[5]) is None
                or re.fullmatch(r'[0-9A-Fa-f]{8}', fields[6]) is None
                or any(re.fullmatch(r'[0-9]+', fields[index]) is None
                       for index in (7, 8, 9, 10, 12, 13, 14, 15))
                or re.fullmatch(r'[0-9A-Fa-f]{8,16}', fields[11]) is None
                or re.fullmatch(r'-?[0-9]+', fields[16]) is None):
            _fail('OBSERVATION_DENIED')
        if (re.fullmatch(r'[0-9A-Fa-f]{4}', local_port) is None
                or re.fullmatch(r'[0-9A-Fa-f]{4}', remote_port) is None
                or re.fullmatch(r'[0-9A-Fa-f]{2}', fields[3]) is None
                or any(not _integer(int(fields[index])) for index in (8, 9, 10, 12, 13, 14, 15))
                or not -1 <= int(fields[16]) <= _MAX
                or not _integer(uid, 0, 2**32 - 1)):
            _fail('OBSERVATION_DENIED')
        decode = _ipv4 if version == 4 else _ipv6
        local_address, remote_address = decode(local_hex), decode(remote_hex)
        if not _integer(port, 0, 65535) or not _integer(remote, 0, 65535) or not _integer(uid):
            _fail('OBSERVATION_DENIED')
        if transport == 'TCP' and state == '0A':
            if remote != 0 or remote_hex != '0' * (8 if version == 4 else 32):
                _fail('OBSERVATION_DENIED')
            listeners.append(Listener('GUEST', 'TCP', local_address, port, uid))
        elif transport == 'TCP' and state == '01':
            approved = (
                (local_address == '127.0.0.1' and uid == 10002 and remote_address == '127.0.0.1' and remote == 3128),
                (local_address == '127.0.0.1' and uid == 10004 and port == 3128 and remote_address == '127.0.0.1'),
            )
            if not any(approved):
                _fail('OBSERVATION_DENIED')
        elif transport == 'UDP':
            _fail('OBSERVATION_DENIED')
        else:
            _fail('OBSERVATION_DENIED')
    return tuple(listeners)


def _abstract(raw):
    lines = [line for line in _text_lines(raw) if line.strip()]
    if not lines or lines[0].split() != ['Num', 'RefCount', 'Protocol', 'Flags', 'Type', 'St', 'Inode', 'Path']:
        _fail('OBSERVATION_DENIED')
    result = []
    for line in lines[1:]:
        fields = line.split()
        if (len(fields) not in (7, 8)
                or re.fullmatch(r'[0-9A-Fa-f]+:', fields[0]) is None
                or any(re.fullmatch(r'[0-9A-Fa-f]{8}', fields[index]) is None
                       for index in (1, 2, 3))
                or re.fullmatch(r'[0-9A-Fa-f]{4}', fields[4]) is None
                or re.fullmatch(r'[0-9A-Fa-f]{2}', fields[5]) is None
                or not fields[6].isdecimal()):
            _fail('OBSERVATION_DENIED')
        if (int(fields[2], 16) != 0 or int(fields[3], 16) not in (0, 65536)
                or int(fields[4], 16) not in (1, 2, 5)
                or int(fields[5], 16) not in (1, 2, 3, 4)
                or not _integer(int(fields[6]))):
            _fail('OBSERVATION_DENIED')
        if len(fields) == 8:
            path = fields[7]
            if not _ascii(path, 256):
                _fail('OBSERVATION_DENIED')
            result.append(('ABSTRACT:' if path.startswith('@') else 'PATH:') + path)
        else:
            result.append('UNIX:' + ':'.join(fields[3:7]))
    return tuple(result)


@dataclass(frozen=True)
class NativeTopologyBindings:
    observation_port: object = field(repr=False)
    role_source: object = field(repr=False)
    host_device_source: object = field(repr=False)
    probe_source: object = field(repr=False)
    proxy_source: object = field(repr=False)
    _seal: object = field(repr=False)
    _unresolved: list = field(default_factory=list, repr=False, compare=False)

    def _read(self, path):
        owner = None
        primary = None
        data = None
        try:
            owner = self.observation_port.open_owned(
                path, os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0))
            if (owner is None or not callable(getattr(owner, 'read', None))
                    or not callable(getattr(owner, 'close', None))
                    or not callable(getattr(owner, 'cleanup', None))):
                _fail('OBSERVATION_DENIED')
            chunks, size = [], 0
            for _ in range(1025):
                chunk = owner.read(min(4096, 65537 - size))
                if type(chunk) is not bytes:
                    _fail('OBSERVATION_DENIED')
                if not chunk:
                    break
                size += len(chunk)
                if size > 65536:
                    _fail('OBSERVATION_DENIED')
                chunks.append(chunk)
            else:
                _fail('OBSERVATION_DENIED')
            data = b''.join(chunks)
        except Exception as error:
            primary = error
        finally:
            if owner is not None:
                try:
                    owner.close()
                except Exception:
                    self._unresolved.append(owner)
                    primary = TopologyError('OBSERVATION_DENIED')
        if isinstance(primary, TopologyError):
            raise primary
        if primary is not None or data is None:
            _fail('OBSERVATION_DENIED')
        return data

    def cleanup_unresolved(self):
        pending, self._unresolved[:] = tuple(self._unresolved), []
        uncertain = False
        for owner in pending:
            try:
                owner.cleanup()
            except Exception:
                uncertain = True
                self._unresolved.append(owner)
        if uncertain:
            _fail('CLEANUP_UNCERTAIN')

    def cleanup(self, snapshot):
        if type(snapshot) is not TopologySnapshot:
            _fail('CLEANUP_UNCERTAIN')
        self.role_source.cleanup_owned(snapshot.role_handoffs)

    def capture(self, sequence, authority):
        if self._seal is not _NATIVE_SEAL:
            _fail('ADAPTER_DENIED')
        raw = tuple(self._read(path) for path in NATIVE_OBSERVATION_PATHS)
        roles = None
        try:
            interfaces = _interfaces(raw[0])
            routes = _routes4(raw[1]) + _routes6(raw[2])
            dns = _dns(raw[3])
            listeners = (_network_rows(raw[4], 'TCP', 4)
                         + _network_rows(raw[5], 'TCP', 6)
                         + _network_rows(raw[6], 'UDP', 4)
                         + _network_rows(raw[7], 'UDP', 6))
            abstract = _abstract(raw[8])
            roles = self.role_source.collect(authority)
            sample = authority.clock.sample()
            if not _sample(sample): _fail('CLOCK_DENIED')
            return TopologySnapshot(
                sequence, sample[0], sample[1], authority.run_id,
                authority.manifest_identity, authority.config_identity,
                self.host_device_source.observe(authority), interfaces, routes, dns,
                tuple(listeners), abstract, roles,
                tuple(self.probe_source.execute(identifier)
                      for identifier in FIXED_PROBE_IDS),
                self.proxy_source.observe(authority.proxy_policy))
        except TopologyError:
            if roles is not None:
                try: self.role_source.cleanup_owned(roles)
                except Exception: _fail('CLEANUP_UNCERTAIN')
            raise
        except Exception:
            if roles is not None:
                try: self.role_source.cleanup_owned(roles)
                except Exception: _fail('CLEANUP_UNCERTAIN')
            _fail('OBSERVATION_DENIED')


def select_native_topology(observation_port, role_source, host_device_source,
                           probe_source, proxy_source, platform_name, machine):
    """Explicit source selection; performs no observation or probe."""
    if (platform_name != 'linux' or machine != 'aarch64'
            or not callable(getattr(observation_port, 'open_owned', None))
            or not callable(getattr(role_source, 'collect', None))
            or not callable(getattr(host_device_source, 'observe', None))
            or not callable(getattr(probe_source, 'execute', None))
            or not callable(getattr(proxy_source, 'observe', None))):
        _fail('ADAPTER_DENIED')
    return NativeTopologyBindings(observation_port, role_source, host_device_source,
                                  probe_source, proxy_source, _NATIVE_SEAL)


_COMPOSITION_SEAL = object()


@dataclass(frozen=True)
class Task8ProbeSource:
    module: object = field(repr=False)
    port: object = field(repr=False)
    native: object = field(repr=False)
    _seal: object = field(repr=False)

    def execute(self, identifier):
        if self._seal is not _COMPOSITION_SEAL or identifier not in FIXED_PROBE_IDS:
            _fail('PROBE_DENIED')
        case = TASK8_PROBE_CASES.get(identifier)
        if case is not None and type(self.native) is not Task10NativeAttempts:
            try:
                self.module.run_case(case, self.port)
            except Exception:
                _fail('PROBE_DENIED')
        try:
            result = self.native.execute_native(identifier)
        except Exception:
            _fail('PROBE_DENIED')
        _probe(result, identifier)
        return result


def select_task8_probe_source(module, port, native, platform_name, machine):
    """Explicitly bind accepted Task8 NativeProbePort to exact Task10 probes."""
    required = {
        'vsock_browser_controller_verifier_denied',
        'child_fork_exec_network_gpu_crash_helper_inherits',
        'proxy_fixed_vsock_positive',
        'io_uring_setup_register_enter_and_inherited_ring_denied',
        'SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied',
    }
    if (platform_name != 'linux' or machine != 'aarch64'
            or type(port) is not getattr(module, 'NativeProbePort', None)
            or not callable(getattr(module, 'run_case', None))
            or not required.issubset(set(getattr(module, 'PROBES', ())))
            or not callable(getattr(native, 'execute_native', None))):
        _fail('PROBE_DENIED')
    return Task8ProbeSource(module, port, native, _COMPOSITION_SEAL)


class Task10NativeAttempts:
    """Fixed attempts using Task8's confined subprocess/receiver boundary.

    Only IP operations have a source implementation here. The accepted Task8
    native catalogue supplies vsock, FD and ring operations. Its descendant
    helper catalogue has no IPv4/IPv6 helper, so those remain unavailable.
    """
    _ip = {
        'BROWSER_IPV4_TCP': ('BROWSER', 2, 1, 443),
        'BROWSER_IPV6_TCP': ('BROWSER', 10, 1, 443),
        'BROWSER_UDP': ('BROWSER', 2, 2, 443),
        'CONTROLLER_DNS_TCP': ('CONTROLLER', 2, 1, 53),
        'CONTROLLER_DNS_UDP': ('CONTROLLER', 2, 2, 53),
        'VERIFIER_IPV4_TCP': ('VERIFIER', 2, 1, 443),
    }
    def __init__(self, module, port):
        if (type(port) is not getattr(module, 'NativeProbePort', None)
                or not callable(getattr(port.fixtures, 'run_confined', None))):
            _fail('PROBE_DENIED')
        self.module, self.port = module, port

    def execute_native(self, identifier):
        if identifier in ('BROWSER_HELPER_IPV4', 'BROWSER_HELPER_IPV6'):
            _fail('NATIVE_HELPER_UNAVAILABLE')
        if identifier not in self._ip:
            case = self.module.PROBES.get(TASK8_PROBE_CASES.get(identifier))
            if case is None: _fail('PROBE_DENIED')
            rows = self.module.run_case(TASK8_PROBE_CASES[identifier], self.port)
            positive = identifier == 'PROXY_VSOCK_CONTROL'
            if (type(rows) is not tuple or not rows
                    or any(not _keys(row, ('operation','attempted','denied','receiver_count'))
                           or type(row['attempted']) is not bool or not row['attempted']
                           or type(row['denied']) is not bool or row['denied'] == positive
                           or type(row['receiver_count']) is not int
                           or row['receiver_count'] != int(positive) for row in rows)):
                _fail('PROBE_DENIED')
            return ProbeResult(identifier, True, 'ALLOWED' if positive else 'DENIED', int(positive))
        role, family, kind, port = self._ip[identifier]
        def attempt(context):
            fd, denied = None, False
            try:
                fd = context.syscall(198, family, kind, 0)
                # Fixed documentation-only numeric destinations, never DNS.
                address = (struct.pack('<H', 2) + struct.pack('>H', port)
                           + bytes((192, 0, 2, 1)) + bytes(8)) if family == 2 else (
                           struct.pack('<H', 10) + struct.pack('>H', port) + bytes(4)
                           + bytes.fromhex('20010db8000000000000000000000001') + bytes(4))
                if kind == 1:
                    context.syscall(203, fd, address, len(address))
                    context.syscall(64, fd, b'TASK10', 6)
                else:
                    context.syscall(206, fd, b'TASK10', 6, 0, address, len(address))
            except OSError as error:
                if error.errno not in (1, 13, 101, 113):
                    _fail('PROBE_DENIED')
                denied = True
            finally:
                if fd is not None: context.close(fd)
            return {'attempted': True, 'denied': denied,
                    'receiver_count': context.receiver_count()}
        row = self.port.fixtures.run_confined(role, identifier, attempt)
        if (not _keys(row, ('attempted','denied','receiver_count'))
                or type(row['attempted']) is not bool or row['attempted'] is not True
                or type(row['denied']) is not bool or row['denied'] is not True
                or type(row['receiver_count']) is not int or row['receiver_count'] != 0):
            _fail('PROBE_DENIED')
        return ProbeResult(identifier, True, 'DENIED', 0)


@dataclass(frozen=True)
class Task8RoleSource:
    bridge: object = field(repr=False)
    _seal: object = field(repr=False)
    def collect(self, authority):
        if self._seal is not _COMPOSITION_SEAL:
            _fail('ROLE_DENIED')
        try:
            value = self.bridge.collectOwned(authority.role_launches)
        except Exception:
            _fail('ROLE_DENIED')
        if type(value) is not tuple:
            _fail('ROLE_DENIED')
        return value
    def cleanup_owned(self, handoffs):
        try:
            self.bridge.cleanupOwned(handoffs)
        except Exception:
            _fail('CLEANUP_UNCERTAIN')


class Task8Collection:
    """Retain the accepted start_roles collection and its original provenance.

    This implements collection/cleanup only. The accepted waiting-child native
    kernel has no activation surface; no new command is introduced here.
    """
    def __init__(self, config):
        if type(config) is not _CONFINEMENT.BootstrapConfig:
            _fail('ROLE_DENIED')
        self.config, self.handoffs, self.provenance = config, None, None
        self.retired = False

    def collectOwned(self, launches):
        if self.retired: _fail('ROLE_DENIED')
        if self.handoffs is None:
            values = _CONFINEMENT.start_roles(self.config)
            self.handoffs = tuple(values[role] for role, _ in ROLE_UIDS)
            self.provenance = tuple((_CONFINEMENT._ownership_facts(h._owned),
                                    getattr(h._owned, 'identity', h._owned),
                                    h._owned.command, h._owned.result)
                                   for h in self.handoffs)
        try:
            if len(launches) != len(self.handoffs): _fail('ROLE_DENIED')
            for handoff, launch, provenance in zip(self.handoffs, launches, self.provenance):
                if (handoff.launch != launch
                        or _CONFINEMENT._ownership_facts(handoff._owned) != provenance[0]):
                    _fail('ROLE_DENIED')
                _CONFINEMENT._check(_CONFINEMENT.inspect_role(handoff.attestation.pid,
                                    kernel=handoff._kernel), launch, waiting=True)
            return self.handoffs
        except Exception:
            self.cleanupOwned(self.handoffs)
            _fail('ROLE_DENIED')

    def cleanupOwned(self, handoffs):
        if handoffs is not self.handoffs: _fail('CLEANUP_UNCERTAIN')
        if self.retired: return
        self.retired = True
        uncertain = False
        for handoff in reversed(self.handoffs):
            try:
                if handoff.stop_owned(120000)['status'] not in ('STOPPED', 'EXITED'):
                    uncertain = True
            except Exception: uncertain = True
        if uncertain: _fail('CLEANUP_UNCERTAIN')


@dataclass(frozen=True)
class Task8RoleActivation:
    bridge: object = field(repr=False)
    grant: object = field(repr=False)
    _seal: object = field(repr=False)
    def prepare(self, handoff, proof):
        if self._seal is not _COMPOSITION_SEAL or handoff.launch.role != 'BROWSER':
            _fail('ACTIVATION_DENIED')
        return Task10RoleTransaction(self.bridge, self.grant, handoff)


@dataclass(frozen=True)
class OwnedRoleHandle:
    value: object = field(repr=False)
    run_id: str
    def stop_owned(self, deadline):
        return self._exit(self.value.stopOwned, deadline)
    def wait_exit(self, deadline):
        return self._exit(self.value.waitExit, deadline)
    def _exit(self, operation, deadline):
        if not _integer(deadline, 1, 1200000):
            _fail('CLEANUP_UNCERTAIN')
        value = _await_role(operation(deadline))
        if (not _keys(value, ('status', 'runId')) or value['runId'] != self.run_id
                or value['status'] not in ('STOPPED', 'EXITED')):
            _fail('CLEANUP_UNCERTAIN')
        return {'status': value['status'], 'run_id': self.run_id}


def _await_role(value):
    if not inspect.isawaitable(value):
        _fail('ACTIVATION_DENIED')
    async def consume(): return await value
    return asyncio.run(consume())


class Task10RoleTransaction:
    """Task10 ownership adapter for the unchanged async Task8 RolePort API.

    The embedding must supply the already-audited RolePort. There is no native
    JS/Python construction or new activation protocol in this module.
    """
    def __init__(self, port, grant, handoff):
        self.port, self.grant, self.handoff = port, grant, handoff
        self.owner, self.used = None, False
    def activate(self, authorize):
        if self.used: _fail('ACTIVATION_DENIED')
        self.used = True
        authorize()
        try:
            value = _await_role(self.port.activateOnce(self.grant))
            if any(not callable(getattr(value, name, None)) for name in ('stopOwned', 'waitExit')):
                _fail('ACTIVATION_DENIED')
            self.owner = OwnedRoleHandle(value, self.handoff.launch.run_id)
        except Exception as error:
            cleanup = getattr(error, 'cleanup', None)
            if cleanup is not None:
                self.owner = OwnedRoleHandle(cleanup, self.handoff.launch.run_id)
            raise ActivationFailure('ACTIVATION_DENIED', self) from None
    def stop_owned(self, deadline):
        if self.owner is not None:
            return self.owner.stop_owned(deadline)
        return self.handoff.stop_owned(deadline)


def select_task8_roles(bridge, grant):
    """Bind the accepted RolePort bridge; no role process is started here."""
    if (not callable(getattr(bridge, 'collectOwned', None))
            or not callable(getattr(bridge, 'cleanupOwned', None))
            or not callable(getattr(bridge, 'activateOnce', None))
            or grant is None):
        _fail('ROLE_DENIED')
    return (Task8RoleSource(bridge, _COMPOSITION_SEAL),
            Task8RoleActivation(bridge, grant, _COMPOSITION_SEAL))


@dataclass(frozen=True)
class Task9ProxySource:
    observer: object = field(repr=False)
    policy: object = field(repr=False)
    _seal: object = field(repr=False)
    def observe(self, policy):
        if (self._seal is not _COMPOSITION_SEAL or policy is not self.policy
                or type(policy) is not _PROXY.NativeAdmissionPolicy
                or getattr(policy, '_seal', None) is not _PROXY._NATIVE_ADMISSION_SEAL):
            _fail('PROXY_DENIED')
        try:
            return self.observer.observeAccepted(policy)
        except Exception:
            _fail('PROXY_DENIED')


def select_task9_proxy_source(observer, policy):
    if (type(policy) is not _PROXY.NativeAdmissionPolicy
            or getattr(policy, '_seal', None) is not _PROXY._NATIVE_ADMISSION_SEAL
            or not callable(getattr(observer, 'observeAccepted', None))):
        _fail('PROXY_DENIED')
    return Task9ProxySource(observer, policy, _COMPOSITION_SEAL)


class Task9RuntimeObserver:
    """Observe the retained Task9 listener/transport; never construct either."""
    def __init__(self, config, sockets, transport):
        if (type(config) is not _PROXY.ProxyConfig
                or type(sockets) is not _PROXY.NativeSockets
                or type(transport) is not _PROXY.NativeVsockTransport
                or type(sockets.listener) is not _PROXY.NativeListener):
            _fail('PROXY_DENIED')
        self.config, self.sockets, self.transport = config, sockets, transport
        self.listener, self.endpoint = sockets.listener, sockets.listener.socket

    def observeAccepted(self, policy):
        _PROXY._admit_native_config(self.config, policy)
        if (self.sockets.listener is not self.listener or self.listener.socket is not self.endpoint
                or self.sockets.closed or self.sockets.closing or self.sockets.stopped
                or self.sockets.listener_closed or self.listener.closed
                or self.listener.closing or self.listener.socket_closed
                or self.listener.endpoint != ('127.0.0.1', 3128)
                or self.endpoint.getsockname() != ('127.0.0.1', 3128)
                or not _PROXY._same_binding(self.transport.binding, policy.binding)
                or (self.transport.host_cid, self.transport.service) != (2, 4050)
                or policy.handoff_validator('PROXY', 10004, 3, 4) is not True):
            _fail('PROXY_DENIED')
        self.transport.check()
        binding = policy.binding
        return ProxyRuntime(binding.run_id, binding.manifest_identity,
                            binding.config_identity, binding.expires_at,
                            '127.0.0.1', 3128, 2, 4050, 10004)


@dataclass(frozen=True)
class NativeTopologySupervisor:
    monitor: object = field(repr=False)
    _seal: object = field(repr=False)
    def begin(self, handoff, on_drift):
        if self._seal is not _COMPOSITION_SEAL:
            _fail('ADAPTER_DENIED')
        try:
            handle = self.monitor.beginOwned(handoff, on_drift)
        except Exception:
            _fail('OBSERVATION_DENIED')
        if not callable(getattr(handle, 'stop_owned', None)):
            _fail('ADAPTER_DENIED')
        return handle


def select_native_supervisor(monitor, platform_name, machine):
    if (platform_name != 'linux' or machine != 'aarch64'
            or not callable(getattr(monitor, 'beginOwned', None))):
        _fail('ADAPTER_DENIED')
    return NativeTopologySupervisor(monitor, _COMPOSITION_SEAL)


class ServiceCreationMonitor:
    """Owned finite service-event boundary; every change invalidates admission.

    The signed/native embedding must supply an independently owned source for
    these kernel/service events. No event source is constructed by default.
    """
    EVENTS = ('DEVICE', 'NIC', 'ROUTE', 'DNS', 'LISTENER', 'UNIX', 'ROLE')
    def __init__(self, event_source, run_id):
        if (not callable(getattr(event_source, 'subscribe_fixed', None))
                or type(run_id) is not str or _RUN.fullmatch(run_id) is None):
            _fail('ADAPTER_DENIED')
        self.source, self.run_id, self.used = event_source, run_id, False

    def beginOwned(self, handoff, on_drift):
        if self.used: _fail('ADAPTER_DENIED')
        self.used = True
        # Subscribe only to the fixed creation/change catalogue. A malformed
        # event also invalidates; no event can confer additional authority.
        owner = self.source.subscribe_fixed(self.EVENTS, lambda event: on_drift())
        if not callable(getattr(owner, 'stop_owned', None)):
            _fail('CLEANUP_UNCERTAIN')
        return owner


def compose_task10(*, mode, expected, observations, collection, host_devices,
                   probe_module, probe_port, proxy_runtime, service_events,
                   platform_name, machine):
    """Explicit composition from existing owned/injected boundaries only.

    Returns an unstarted gate. Missing native Task8 activation/IP-helper/event
    construction remains unavailable; this API does not supply or execute it.
    """
    if mode != 'bootstrap-check': _fail('ADAPTER_DENIED')
    _authority(expected)
    if type(collection) is not Task8Collection:
        _fail('ROLE_DENIED')
    roles = Task8RoleSource(collection, _COMPOSITION_SEAL)
    attempts = Task10NativeAttempts(probe_module, probe_port)
    probes = select_task8_probe_source(probe_module, probe_port, attempts, platform_name, machine)
    proxy = select_task9_proxy_source(proxy_runtime, expected.proxy_policy)
    supervisor = select_native_supervisor(ServiceCreationMonitor(service_events, expected.run_id),
                                          platform_name, machine)
    adapter = select_native_topology(observations, roles, host_devices, probes, proxy,
                                     platform_name, machine)
    return TopologyGate(expected, adapter, supervisor)

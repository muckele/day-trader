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


class TopologyError(ValueError):
    """Finite public failure without raw observation data."""


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
            or getattr(owned, 'role', None) != value.role):
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


def admit_topology(snapshot, expected, before, after):
    """Revalidate complete Task8/9 evidence and authenticate a canonical handoff."""
    try:
        payload = _payload(snapshot, expected, before, after)
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
        envelope = json.loads(wire)
        if (type(envelope) is not dict or set(envelope) != {'mac', 'payload', 'version'}
                or envelope['version'] != 1 or type(envelope['mac']) is not str
                or _DIGEST.fullmatch(envelope['mac']) is None
                or type(envelope['payload']) is not dict
                or _canonical(envelope).decode('ascii') != wire):
            _fail('HANDOFF_DENIED')
        payload = envelope['payload']
        calculated = hmac.new(expected.capability, _canonical(payload), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calculated, envelope['mac']):
            _fail('HANDOFF_DENIED')
        if (payload.get('runId') != expected.run_id
                or payload.get('manifestIdentity') != expected.manifest_identity
                or payload.get('configIdentity') != expected.config_identity
                or payload.get('expiresAt') != expected.expires_at
                or payload.get('devices', {}).get('hostDevices') != list(HOST_DEVICES)
                or payload.get('devices', {}).get('interfaces') != ['lo']
                or payload.get('devices', {}).get('routes') != []
                or payload.get('devices', {}).get('dnsServers') != []
                or payload.get('devices', {}).get('abstractUnix') != []
                or [item.get('role') for item in payload.get('roles', [])]
                    != [item[0] for item in ROLE_UIDS]
                or [item.get('identifier') for item in payload.get('probes', [])]
                    != list(FIXED_PROBE_IDS)):
            _fail('HANDOFF_DENIED')
        return payload
    except TopologyError:
        raise
    except Exception:
        _fail('HANDOFF_DENIED')


class TopologyGate:
    """Terminal, resampling admission gate with a Task8 one-use activation."""
    def __init__(self, expected, adapter):
        _authority(expected)
        if not callable(getattr(adapter, 'capture', None)):
            _fail('ADAPTER_DENIED')
        self._expected, self._adapter = expected, adapter
        self._proof, self._snapshot = None, None
        self._failed, self._activated, self._sequence = False, False, 0
        self._last_clock = None

    def _clock(self):
        try:
            value = self._expected.clock.sample()
        except Exception:
            _fail('CLOCK_DENIED')
        if (not _sample(value) or (self._last_clock is not None
                and (value[0] < self._last_clock[0] or value[1] < self._last_clock[1]))):
            _fail('CLOCK_DENIED')
        self._last_clock = value
        if value[0] >= self._expected.expires_at:
            _fail('TOPOLOGY_EXPIRED')
        return value

    def _attempt(self):
        try:
            before = self._clock()
            self._expected.appliance_recheck()
            sequence = self._sequence + 1
            snapshot = self._adapter.capture(sequence, self._expected)
            after = self._clock()
            self._expected.appliance_recheck()
            proof = admit_topology(snapshot, self._expected, before, after)
            if proof.sequence != sequence:
                _fail('SEQUENCE_DENIED')
            if self._proof is not None and (
                    proof.topology_digest != self._proof.topology_digest
                    or proof.role_inventory_digest != self._proof.role_inventory_digest
                    or proof.device_inventory_digest != self._proof.device_inventory_digest):
                _fail('TOPOLOGY_DRIFT')
            self._sequence, self._proof, self._snapshot = sequence, proof, snapshot
            return proof
        except Exception as error:
            self._failed = True
            if isinstance(error, TopologyError):
                raise
            _fail('OBSERVATION_DENIED')

    def admit(self):
        if self._failed or self._proof is not None:
            _fail('TOPOLOGY_FAILED')
        return self._attempt()

    def require_current(self):
        if self._failed or self._proof is None:
            _fail('TOPOLOGY_FAILED')
        return self._attempt()

    def activate_browser(self, activation):
        if self._activated:
            _fail('ACTIVATION_DENIED')
        proof = self.require_current()
        try:
            browser = next(item for item in self._snapshot.role_handoffs
                           if item.launch.role == 'BROWSER')
            activation.activate(browser, proof)
            self._activated = True
        except Exception:
            self._failed = True
            _fail('ACTIVATION_DENIED')

    def topology_drifted(self):
        self._failed = True


_NATIVE_SEAL = object()


@dataclass(frozen=True)
class NativeTopologyBindings:
    os_port: object = field(repr=False)
    role_provider: object = field(repr=False)
    host_device_provider: object = field(repr=False)
    probe_port: object = field(repr=False)
    proxy_provider: object = field(repr=False)
    _seal: object = field(repr=False)

    def _read(self, path):
        fd = None
        try:
            fd = self.os_port.open(path, os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0))
            if not _integer(fd, 0, 2**31 - 1):
                _fail('OBSERVATION_DENIED')
            data = self.os_port.read(fd, 65537)
            if type(data) is not bytes or len(data) > 65536:
                _fail('OBSERVATION_DENIED')
            return data
        except TopologyError:
            raise
        except Exception:
            _fail('OBSERVATION_DENIED')
        finally:
            if fd is not None:
                try: self.os_port.close(fd)
                except Exception: _fail('OBSERVATION_DENIED')

    def capture(self, sequence, authority):
        if self._seal is not _NATIVE_SEAL:
            _fail('ADAPTER_DENIED')
        raw = tuple(self._read(path) for path in NATIVE_OBSERVATION_PATHS)
        try:
            def lines(value):
                return tuple(line.strip() for line in value.decode('ascii').splitlines()
                             if line.strip())
            interfaces = tuple(line.split(':', 1)[0].strip()
                               for line in lines(raw[0]) if ':' in line)
            routes = tuple(line for block in raw[1:3] for line in lines(block)
                           if not line.startswith('Iface'))
            dns = tuple(line.split()[1] for line in lines(raw[3])
                        if line.startswith('nameserver ') and len(line.split()) == 2)
            listeners = []
            for transport, block in zip(('TCP', 'TCP', 'UDP', 'UDP'), raw[4:8]):
                for line in lines(block):
                    fields = line.split()
                    if not fields or fields[0] == 'sl' or len(fields) < 8:
                        continue
                    address, port = fields[1].split(':')
                    decoded = '127.0.0.1' if address == '0100007F' else address
                    listeners.append(Listener('GUEST', transport, decoded,
                                              int(port, 16), int(fields[7], 10)))
            abstract = tuple(line.split()[-1] for line in lines(raw[8])
                             if line.split()[-1].startswith('@'))
            sample = authority.clock.sample()
            if not _sample(sample): _fail('CLOCK_DENIED')
            return TopologySnapshot(
                sequence, sample[0], sample[1], authority.run_id,
                authority.manifest_identity, authority.config_identity,
                self.host_device_provider(), interfaces, routes, dns,
                tuple(listeners),
                abstract, self.role_provider(),
                tuple(self.probe_port(identifier) for identifier in FIXED_PROBE_IDS),
                self.proxy_provider())
        except TopologyError:
            raise
        except Exception:
            _fail('OBSERVATION_DENIED')


def select_native_topology(os_port, role_provider, host_device_provider,
                           probe_port, proxy_provider, platform_name, machine):
    """Explicit source selection; performs no observation or probe."""
    if (platform_name != 'linux' or machine != 'aarch64'
            or not all(callable(getattr(os_port, name, None))
                       for name in ('open', 'read', 'close'))
            or not all(callable(value) for value in
                       (role_provider, host_device_provider, probe_port, proxy_provider))):
        _fail('ADAPTER_DENIED')
    return NativeTopologyBindings(os_port, role_provider, host_device_provider,
                                  probe_port, proxy_provider, _NATIVE_SEAL)

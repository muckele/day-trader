"""Offline source/data checks, with independent literal ABI and policy oracles.

No guest module, generator, publisher code, compiler, native socket or syscall is
imported/executed. Missing retained inputs are errors, never skipped evidence.
"""
import copy
import hashlib
import json
from pathlib import Path
import re
import struct
import tarfile
import unittest

ROOT = Path(__file__).resolve().parents[4]
REFERENCE = ROOT / 'tooling/production-acceptance/appliance/bootstrap-event-reference.json'
BUNDLE = Path('/Users/Matt/day-trader-references/m4-linux-aarch64-offline-repair-20261002T181543Z')
COVERAGE_V2 = ROOT / 'tooling/production-acceptance/appliance/abi-coverage-v2.json'
ARCHIVE_SHA = 'c969dea4e8bb6be991bbf7c010ba0e0a5643a3a8d8fb0a2aaa053406f1e965f3'
LOST_PARENT_COVERAGE_SHA = '7c8714c95a67d8a2e6c1b4c8b8481525a61976c81dfe2037c251add071ac9898'
COVERAGE_V2_SHA = 'bf1085ded397981173b04041a9c52781318c48fb085c83a3526753697c5c4af4'
MANIFEST_SHA = 'bb5fb8c47a329b8792f85a957d5674690b8aac59580a604fa405855e745e49d5'
ARM_SHA = '5862a326f202ed68e21e27b35716481ff610825484d2a088191759b76fddcc03'

# Literal values transcribed independently from the reviewed declarations. They
# do not come from the JSON record, a production module or the derivation script.
GROUPS = {
    'include/uapi/linux/audit.h': {
        'AUDIT_GET': 1000, 'AUDIT_SET': 1001, 'AUDIT_ADD_RULE': 1011,
        'AUDIT_DEL_RULE': 1012, 'AUDIT_LIST_RULES': 1013,
        'AUDIT_SYSCALL': 1300, 'AUDIT_PATH': 1302, 'AUDIT_CONFIG_CHANGE': 1305,
        'AUDIT_SOCKADDR': 1306, 'AUDIT_CWD': 1307, 'AUDIT_EXECVE': 1309,
        'AUDIT_EOE': 1320, 'AUDIT_PROCTITLE': 1327,
        'AUDIT_FILTER_EXIT': 4, 'AUDIT_ALWAYS': 2, 'AUDIT_MAX_FIELDS': 64,
        'AUDIT_BITMASK_SIZE': 64, 'AUDIT_ARCH': 11, 'AUDIT_EQUAL': 1073741824,
        'AUDIT_ARCH_AARCH64': 3221225655, 'AUDIT_FAIL_SILENT': 0,
        'AUDIT_STATUS_ENABLED': 1, 'AUDIT_STATUS_FAILURE': 2,
        'AUDIT_STATUS_PID': 4, 'AUDIT_STATUS_RATE_LIMIT': 8,
        'AUDIT_STATUS_BACKLOG_LIMIT': 16,
    },
    'include/uapi/linux/netlink.h': {
        'NETLINK_ROUTE': 0, 'NETLINK_AUDIT': 9, 'NETLINK_KOBJECT_UEVENT': 15,
        'NLM_F_REQUEST': 1, 'NLM_F_MULTI': 2, 'NLM_F_ACK': 4,
        'NLM_F_DUMP_INTR': 16, 'NLMSG_NOOP': 1, 'NLMSG_ERROR': 2,
        'NLMSG_DONE': 3, 'NLMSG_OVERRUN': 4, 'NLMSG_ALIGNTO': 4,
        'NLMSG_HDRLEN': 16,
    },
    'include/uapi/linux/rtnetlink.h': {
        'RTM_NEWLINK': 16, 'RTM_DELLINK': 17, 'RTM_NEWADDR': 20,
        'RTM_DELADDR': 21, 'RTM_NEWROUTE': 24, 'RTM_DELROUTE': 25,
        'RTMGRP_LINK': 1, 'RTMGRP_IPV4_IFADDR': 16, 'RTMGRP_IPV4_ROUTE': 64,
        'RTMGRP_IPV6_IFADDR': 256, 'RTMGRP_IPV6_ROUTE': 1024, 'RTA_ALIGNTO': 4,
    },
    'include/uapi/linux/inotify.h': {
        'IN_MODIFY': 2, 'IN_ATTRIB': 4, 'IN_CLOSE_WRITE': 8,
        'IN_MOVED_FROM': 64, 'IN_MOVED_TO': 128, 'IN_CREATE': 256,
        'IN_DELETE': 512, 'IN_DELETE_SELF': 1024, 'IN_MOVE_SELF': 2048,
        'IN_UNMOUNT': 8192, 'IN_Q_OVERFLOW': 16384, 'IN_IGNORED': 32768,
        'IN_ONLYDIR': 16777216, 'IN_DONT_FOLLOW': 33554432,
        'IN_MASK_CREATE': 268435456, 'IN_ISDIR': 1073741824,
        'IN_CLOEXEC': 524288, 'IN_NONBLOCK': 2048,
    },
    'include/uapi/linux/capability.h': {'CAP_AUDIT_CONTROL': 30},
    'include/uapi/asm-generic/unistd.h': {
        '__NR_inotify_init1': 26, '__NR_inotify_add_watch': 27,
        '__NR_inotify_rm_watch': 28, '__NR_mknodat': 33, '__NR_umount2': 39,
        '__NR_mount': 40, '__NR_pivot_root': 41, '__NR_chroot': 51,
        '__NR_exit': 93, '__NR_exit_group': 94, '__NR_unshare': 97,
        '__NR_bind': 200, '__NR_listen': 201, '__NR_clone': 220,
        '__NR_execve': 221, '__NR_setns': 268, '__NR_execveat': 281,
        '__NR_clone3': 435,
    },
}
CONSTANTS = {name: (path, value, 32, name not in {
    'AUDIT_ARCH_AARCH64', 'NLMSG_ALIGNTO', 'RTA_ALIGNTO'})
    for path, values in GROUPS.items() for name, value in values.items()}

# name, byte offset, byte size, byte alignment. Width is total sizeof in bits;
# aggregate signed=false is a schema convention, not field signedness.
LAYOUTS = {
    'audit_status': ('include/uapi/linux/audit.h', 44, [
        ('mask', 0, 4, 4), ('enabled', 4, 4, 4), ('failure', 8, 4, 4),
        ('pid', 12, 4, 4), ('rate_limit', 16, 4, 4), ('backlog_limit', 20, 4, 4),
        ('lost', 24, 4, 4), ('backlog', 28, 4, 4), ('version', 32, 4, 4),
        ('feature_bitmap', 32, 4, 4), ('backlog_wait_time', 36, 4, 4),
        ('backlog_wait_time_actual', 40, 4, 4)]),
    'audit_rule_data': ('include/uapi/linux/audit.h', 1040, [
        ('flags', 0, 4, 4), ('action', 4, 4, 4), ('field_count', 8, 4, 4),
        ('mask', 12, 256, 4), ('fields', 268, 256, 4), ('values', 524, 256, 4),
        ('fieldflags', 780, 256, 4), ('buflen', 1036, 4, 4), ('buf', 1040, 0, 1)]),
    'sockaddr_nl': ('include/uapi/linux/netlink.h', 12, [
        ('nl_family', 0, 2, 2), ('nl_pad', 2, 2, 2), ('nl_pid', 4, 4, 4),
        ('nl_groups', 8, 4, 4)]),
    'nlmsghdr': ('include/uapi/linux/netlink.h', 16, [
        ('nlmsg_len', 0, 4, 4), ('nlmsg_type', 4, 2, 2), ('nlmsg_flags', 6, 2, 2),
        ('nlmsg_seq', 8, 4, 4), ('nlmsg_pid', 12, 4, 4)]),
    'nlmsgerr': ('include/uapi/linux/netlink.h', 20, [
        ('error', 0, 4, 4), ('msg', 4, 16, 4)]),
    'rtattr': ('include/uapi/linux/rtnetlink.h', 4, [
        ('rta_len', 0, 2, 2), ('rta_type', 2, 2, 2)]),
    'ifinfomsg': ('include/uapi/linux/rtnetlink.h', 16, [
        ('ifi_family', 0, 1, 1), ('__ifi_pad', 1, 1, 1), ('ifi_type', 2, 2, 2),
        ('ifi_index', 4, 4, 4), ('ifi_flags', 8, 4, 4), ('ifi_change', 12, 4, 4)]),
    'rtmsg': ('include/uapi/linux/rtnetlink.h', 12, [
        ('rtm_family', 0, 1, 1), ('rtm_dst_len', 1, 1, 1), ('rtm_src_len', 2, 1, 1),
        ('rtm_tos', 3, 1, 1), ('rtm_table', 4, 1, 1), ('rtm_protocol', 5, 1, 1),
        ('rtm_scope', 6, 1, 1), ('rtm_type', 7, 1, 1), ('rtm_flags', 8, 4, 4)]),
    'ifaddrmsg': ('include/uapi/linux/if_addr.h', 8, [
        ('ifa_family', 0, 1, 1), ('ifa_prefixlen', 1, 1, 1), ('ifa_flags', 2, 1, 1),
        ('ifa_scope', 3, 1, 1), ('ifa_index', 4, 4, 4)]),
    'inotify_event': ('include/uapi/linux/inotify.h', 16, [
        ('wd', 0, 4, 4), ('mask', 4, 4, 4), ('cookie', 8, 4, 4),
        ('len', 12, 4, 4), ('name', 16, 0, 1)]),
}
SEMANTICS = {
    'AUDIT_RULE_ENUMERATION': ('UNAVAILABLE', ['AUDIT_LIST_RULES', 'NLMSG_DONE',
        'AUDIT_FILTER_EXIT', 'AUDIT_ALWAYS', 'AUDIT_ARCH', 'AUDIT_EQUAL',
        '16', '65536', '100ms', 'allocation', 'unused', 'demultiplex']),
    'AUDIT_HEALTH': ('SUPPORTED', ['AUDIT_GET', 'receiver', 'enabled=1',
        'failure=0', 'rate_limit=0', 'backlog_limit=256', 'lost', 'rules', 'audit=1']),
    'AUDIT_DELIVERY': ('UNAVAILABLE', ['audit_queue', 'audit_hold_queue',
        'audit_retry_queue', 'EOE', 'serial', 'backlog', 'EAGAIN']),
    'ROUTE_NOTIFICATION': ('SUPPORTED', ['RTM_NEWLINK', 'RTM_DELLINK',
        'RTM_NEWADDR', 'RTM_DELADDR', 'RTM_NEWROUTE', 'RTM_DELROUTE', 'namespace']),
    'ROUTE_DELIVERY': ('UNAVAILABLE', ['nlmsg_seq', '0', 'ENOBUFS', 'MSG_TRUNC']),
    'UEVENT_NOTIFICATION': ('SUPPORTED', ['uevent_suppress', 'filter', 'SEQNUM',
        'before', 'namespace', 'ENOBUFS', 'CAP_SYS_ADMIN']),
    'INOTIFY_NOTIFICATION': ('SUPPORTED', ['coalesc', 'IN_Q_OVERFLOW',
        'IN_IGNORED', 'inode', 'watch', 'cookie', 'EAGAIN']),
    'COMBINED_EFFECT_FENCE': ('UNAVAILABLE', ['NETLINK_AUDIT', 'NETLINK_ROUTE',
        'NETLINK_KOBJECT_UEVENT', 'inotify', 'NATIVE_EVENT_BARRIER_UNAVAILABLE',
        'NATIVE_EFFECT_FENCE_UNAVAILABLE', 'PollSelector']),
}
# These independent source ranges guard against plausible but irrelevant citations.
REQUIRED_SPANS = {
    'AUDIT_RULE_ENUMERATION': [('kernel/auditfilter.c', 634, 701),
        ('kernel/auditfilter.c', 1079, 1105), ('kernel/auditfilter.c', 1172, 1204),
        ('kernel/audit.c', 937, 960), ('kernel/audit.c', 1426, 1428)],
    'AUDIT_HEALTH': [('kernel/audit.c', 1235, 1253),
        ('kernel/audit.c', 1053, 1072), ('kernel/audit.c', 1730, 1756),
        ('init/Kconfig', 458, 474)],
    'AUDIT_DELIVERY': [('kernel/audit.c', 576, 638), ('kernel/audit.c', 865, 893),
        ('kernel/audit.c', 1813, 1844), ('kernel/auditsc.c', 1804, 1819)],
    'ROUTE_NOTIFICATION': [('net/core/rtnetlink.c', 4061, 4125),
        ('net/ipv4/fib_semantics.c', 513, 548), ('net/ipv4/devinet.c', 1926, 1957),
        ('net/ipv6/route.c', 6153, 6182), ('net/ipv6/addrconf.c', 5550, 5579)],
    'ROUTE_DELIVERY': [('net/netlink/af_netlink.c', 350, 359),
        ('net/netlink/af_netlink.c', 1411, 1423), ('net/netlink/af_netlink.c', 1959, 1985)],
    'UEVENT_NOTIFICATION': [('lib/kobject_uevent.c', 495, 523),
        ('lib/kobject_uevent.c', 586, 595), ('lib/kobject_uevent.c', 309, 416),
        ('lib/kobject_uevent.c', 682, 749), ('lib/kobject_uevent.c', 33, 48)],
    'INOTIFY_NOTIFICATION': [('fs/notify/inotify/inotify_fsnotify.c', 31, 57),
        ('fs/notify/notification.c', 69, 130), ('fs/notify/inotify/inotify_user.c', 518, 564),
        ('fs/notify/inotify/inotify_user.c', 729, 819)],
    'COMBINED_EFFECT_FENCE': [('kernel/audit.c', 865, 893),
        ('lib/kobject_uevent.c', 495, 509), ('fs/notify/notification.c', 69, 130)],
}
DEPENDENCIES = {
    'include/uapi/linux/' + name + '.h'
    for name in 'types posix_types stddef elf-em socket if_link'.split()
} | {'include/uapi/asm-generic/' + name + '.h'
     for name in 'types int-ll64 posix_types bitsperlong socket'.split()} | {
    'arch/arm64/include/uapi/asm/unistd.h', 'arch/arm64/include/uapi/asm/bitsperlong.h',
    'arch/arm64/include/uapi/asm/posix_types.h', 'arch/arm64/include/uapi/asm/Kbuild',
    'include/uapi/asm-generic/Kbuild', 'fs/notify/inotify/Kconfig',
    'net/core/dev.c', 'net/ipv4/fib_frontend.c', 'fs/notify/group.c',
}
MEMBERS = {'linux-6.8/' + path for path in (
    set(GROUPS) | {row[0] for row in LAYOUTS.values()} | DEPENDENCIES |
    {path for spans in REQUIRED_SPANS.values() for path, _, _ in spans})}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate field')
        result[key] = value
    return result

class BootstrapReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Fixed allowlist independent of the record under test. No extractall,
        # arbitrary member access, reference writes or native execution.
        with (BUNDLE / 'linux-6.8.tar.xz').open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != ARCHIVE_SHA:
                raise ValueError('retained archive mismatch')
        if digest((BUNDLE / 'manifest.json').read_bytes()) != MANIFEST_SHA:
            raise ValueError('retained manifest mismatch')
        if digest(COVERAGE_V2.read_bytes()) != COVERAGE_V2_SHA:
            raise ValueError('committed coverage v2 mismatch')
        cls.members = {}
        with tarfile.open(BUNDLE / 'linux-6.8.tar.xz', 'r|xz') as archive:
            for member in archive:
                if member.name not in MEMBERS:
                    continue
                if not member.isfile() or not 0 < member.size < 1048576 or member.name in cls.members:
                    raise ValueError('invalid retained member')
                data = archive.extractfile(member).read(1048576)
                if len(data) != member.size or b'\0' in data:
                    raise ValueError('invalid member bytes')
                cls.members[member.name] = data
        if set(cls.members) != MEMBERS or sum(map(len, cls.members.values())) > 8388608:
            raise ValueError('missing or oversized retained members')
        cls.members['aapcs64.rst'] = (BUNDLE / 'aapcs64.rst').read_bytes()
        if digest(cls.members['aapcs64.rst']) != ARM_SHA:
            raise ValueError('retained ABI mismatch')

    def test_v1_lost_parent_coverage_is_recorded_and_superseded(self):
        self.assertEqual(self.reference['parentCoverageSHA256'], LOST_PARENT_COVERAGE_SHA)
        data = COVERAGE_V2.read_bytes()
        self.assertEqual(digest(data), COVERAGE_V2_SHA)
        v2 = json.loads(data, object_pairs_hook=unique_pairs)
        self.assertEqual(v2['supersedesLostCoverageSHA256'], LOST_PARENT_COVERAGE_SHA)

    def setUp(self):
        self.reference = json.loads(REFERENCE.read_bytes(), object_pairs_hook=unique_pairs)

    def citation(self, row):
        self.assertIs(type(row['firstLine']), int)
        self.assertIs(type(row['lastLine']), int)
        self.assertIn(row['memberPath'], self.members)
        data = self.members[row['memberPath']]
        lines = data.decode().splitlines()
        self.assertEqual(row['memberSHA256'], digest(data))
        self.assertTrue(1 <= row['firstLine'] <= row['lastLine'] <= len(lines))
        return '\n'.join(lines[row['firstLine'] - 1:row['lastLine']])

    def validate(self, ref):
        self.assertEqual(set(ref), {'version', 'sourceArchiveSHA256', 'parentCoverageSHA256', 'records', 'semantics'})
        self.assertIs(type(ref['version']), int)
        self.assertEqual(ref['version'], 1)
        self.assertEqual(ref['sourceArchiveSHA256'], ARCHIVE_SHA)
        self.assertEqual(ref['parentCoverageSHA256'], LOST_PARENT_COVERAGE_SHA)
        self.assertEqual([r['id'] for r in ref['records']], sorted(set(CONSTANTS) | set(LAYOUTS)))
        for row in ref['records']:
            self.assertEqual(set(row), {'id', 'memberPath', 'memberSHA256', 'firstLine', 'lastLine', 'declaration', 'value', 'width', 'signed'})
            self.assertIs(type(row['width']), int)
            self.assertIs(type(row['signed']), bool)
            declaration = self.citation(row)
            self.assertEqual(row['declaration'], declaration)
            name = row['id']
            self.assertRegex(declaration, r'\b' + re.escape(name) + r'\b')
            if name in CONSTANTS:
                path, value, width, signed = CONSTANTS[name]
                self.assertIs(type(row['value']), int)
                self.assertEqual((row['value'], row['width'], row['signed']), (value, width, signed))
                self.assertGreaterEqual(value, -(1 << (width - 1)) if signed else 0)
                self.assertLess(value, 1 << (width - 1 if signed else width))
            else:
                path, size, fields = LAYOUTS[name]
                self.assertEqual(row['width'], size * 8)
                self.assertIs(row['signed'], False)
                self.assertEqual(row['value'], [dict(zip(('name', 'offset', 'size', 'alignment'), f)) for f in fields])
                for field in row['value']:
                    for key in ('offset', 'size', 'alignment'):
                        self.assertIs(type(field[key]), int)
                    self.assertRegex(declaration, r'\b' + re.escape(field['name']) + r'\b')
                self.assertTrue(declaration.startswith('struct ' + name + ' {'))
                self.assertTrue(declaration.endswith('};'))
            self.assertEqual(row['memberPath'], 'linux-6.8/' + path)
        self.assertEqual([r['id'] for r in ref['semantics']], sorted(SEMANTICS))
        for row in ref['semantics']:
            self.assertEqual(set(row), {'id', 'status', 'claim', 'evidence', 'limits'})
            status, words = SEMANTICS[row['id']]
            self.assertEqual(row['status'], status)
            self.assertTrue(row['claim'].isascii() and 0 < len(row['claim']) <= 4096)
            for word in words:
                self.assertIn(word, row['claim'])
            self.assertTrue(1 <= len(row['limits']) <= 16)
            for limit in row['limits']:
                self.assertTrue(limit.isascii() and 0 < len(limit) <= 256)
            self.assertTrue(1 <= len(row['evidence']) <= 32)
            spans = set()
            for evidence in row['evidence']:
                self.assertEqual(set(evidence), {'memberPath', 'memberSHA256', 'firstLine', 'lastLine'})
                self.citation(evidence)
                spans.add((evidence['memberPath'], evidence['firstLine'], evidence['lastLine']))
            self.assertEqual(len(spans), len(row['evidence']))
            for path, first, last in REQUIRED_SPANS[row['id']]:
                self.assertIn(('linux-6.8/' + path, first, last), spans)

    def test_v1_event_reference_matches_retained_archive(self):
        self.validate(self.reference)
        manifest = json.loads((BUNDLE / 'manifest.json').read_bytes())
        self.assertEqual(manifest['target'], {'architecture': 'AArch64', 'byteOrder': 'little', 'dataModel': 'LP64', 'os': 'Linux'})
        self.assertEqual({r['value'] for r in self.reference['records'] if r['id'].startswith('NETLINK_')}, {0, 9, 15})

    def test_v1_event_constants_have_independent_width_oracles(self):
        self.validate(self.reference)
        rows = {r['id']: r for r in self.reference['records']}
        self.assertEqual(rows['AUDIT_ARCH_AARCH64']['value'], 2**31 + 2**30 + 183)
        self.assertIs(rows['AUDIT_ARCH_AARCH64']['signed'], False)
        self.assertNotIn('__NR_fork', rows)
        self.assertNotIn('__NR_vfork', rows)
        native = [33, 39, 40, 41, 51, 93, 94, 97, 200, 201, 220, 221, 268, 281, 435]
        words = [0] * 64
        for nr in native:
            words[nr // 32] |= 2 ** (nr % 32)
        self.assertEqual([(i, word) for i, word in enumerate(words) if word],
                         [(1, 525186), (2, 1610612736), (3, 2), (6, 805307136), (8, 33558528), (13, 524288)])

    def test_v1_event_layouts_match_aarch64_declarations(self):
        self.validate(self.reference)
        # '<' specifies Linux little-endian standard widths, never host ABI.
        self.assertEqual(struct.calcsize('<IHHII'), 16)
        self.assertEqual(struct.calcsize('<iIII'), 16)
        self.assertEqual(struct.calcsize('<III64I64I64I64II'), 1040)
        self.assertEqual(struct.calcsize('<11I'), 44)
        header = struct.pack('<IHHII', 16, 3, 2, 7, 0)
        self.assertEqual(header.hex(), '10000000030002000700000000000000')

    def test_v1_event_reference_missing_or_changed_record_denied(self):
        self.validate(self.reference)
        mutations = []
        for i, row in enumerate(self.reference['records']):
            for key, value in [('width', True), ('memberSHA256', '0' * 64), ('firstLine', 0), ('declaration', 'unrelated')]:
                changed = copy.deepcopy(self.reference)
                changed['records'][i][key] = value
                mutations.append(changed)
            changed = copy.deepcopy(self.reference)
            del changed['records'][i]
            mutations.append(changed)
            changed = copy.deepcopy(self.reference)
            if row['id'] in CONSTANTS:
                changed['records'][i]['value'] += 1
            else:
                changed['records'][i]['value'][0]['offset'] += 1
            mutations.append(changed)
        for i in range(len(self.reference['semantics'])):
            for key, value in [('evidence', []), ('claim', ''), ('status', 'SUPPORTED' if self.reference['semantics'][i]['status'] == 'UNAVAILABLE' else 'UNAVAILABLE')]:
                changed = copy.deepcopy(self.reference)
                changed['semantics'][i][key] = value
                mutations.append(changed)
        for changed in mutations:
            with self.assertRaises(AssertionError):
                self.validate(changed)

    def test_v1_event_semantics_cover_rules_queues_and_source_limits(self):
        self.validate(self.reference)
        # Healthy status contains no rules. This literal payload cannot replace
        # an independently enumerated audit_rule_data reply.
        healthy = struct.pack('<11I', 0, 1, 0, 321, 0, 256, 0, 0, 127, 60000, 0)
        self.assertEqual(len(healthy), 44)
        self.assertEqual(struct.unpack('<11I', healthy)[7], 0)
        semantics = {r['id']: r for r in self.reference['semantics']}
        self.assertEqual(semantics['AUDIT_DELIVERY']['status'], 'UNAVAILABLE')
        for name in ('AUDIT_RULE_ENUMERATION', 'AUDIT_HEALTH', 'UEVENT_NOTIFICATION', 'INOTIFY_NOTIFICATION'):
            changed = copy.deepcopy(self.reference)
            next(r for r in changed['semantics'] if r['id'] == name)['evidence'] = []
            with self.assertRaises(AssertionError):
                self.validate(changed)

    def test_v1_unsupported_drain_fence_stays_unavailable(self):
        self.validate(self.reference)
        for name in ('AUDIT_RULE_ENUMERATION', 'AUDIT_DELIVERY', 'ROUTE_DELIVERY', 'COMBINED_EFFECT_FENCE'):
            self.assertEqual(next(r for r in self.reference['semantics'] if r['id'] == name)['status'], 'UNAVAILABLE')

    def test_v1_done_does_not_certify_allocation_complete_rule_list(self):
        self.validate(self.reference)
        # A receiver can see exactly its expected rule and matching DONE even
        # though allocation failed for an extra installed rule. Literal reply
        # headers have kernel sender 0, matching seq=7 and MULTI=2.
        rule = [0] * 260
        rule[:3] = [4, 2, 1]
        for nr in [33, 39, 40, 41, 51, 93, 94, 97, 200, 201, 220, 221, 268, 281, 435]:
            rule[3 + nr // 32] |= 1 << (nr % 32)
        rule[67], rule[131], rule[195] = 11, 3221225655, 1073741824
        replies = struct.pack('<IHHII260I', 1056, 1013, 2, 7, 0, *rule) + struct.pack('<IHHII', 16, 3, 2, 7, 0)
        self.assertEqual(len(replies), 1072)
        self.assertEqual(struct.unpack_from('<IHHII', replies, 1056), (16, 3, 2, 7, 0))
        source = self.members['linux-6.8/kernel/auditfilter.c'].decode().splitlines()
        listing = '\n'.join(source[1078:1105])
        self.assertIn('if (unlikely(!data))\n\t\t\t\tbreak;', listing)
        self.assertIn('if (skb)\n\t\t\t\tskb_queue_tail(q, skb);', listing)
        self.assertIn('audit_make_reply(seq, AUDIT_LIST_RULES, 1, 1, NULL, 0)', listing)
        row = next(r for r in self.reference['semantics'] if r['id'] == 'AUDIT_RULE_ENUMERATION')
        self.assertEqual(row['status'], 'UNAVAILABLE')
        self.assertIn('NLMSG_DONE', row['claim'])
        self.assertIn('allocation', row['claim'])

    def test_v1_event_implementation_preserves_unavailable_native_constructor(self):
        """The consumer must expose the reviewed blocker, never upgrade this record."""
        self.validate(self.reference)
        source = (ROOT / 'tooling/production-acceptance/guest/topology.py').read_text()
        self.assertIn('class LinuxBootstrapEventSource', source)
        self.assertIn('NATIVE_EVENT_BARRIER_UNAVAILABLE', source)
        self.assertIn('def select_native_bootstrap_event_source', source)
        for semantic in ('AUDIT_RULE_ENUMERATION', 'AUDIT_DELIVERY',
                         'ROUTE_DELIVERY', 'COMBINED_EFFECT_FENCE'):
            self.assertIn(semantic, source)

if __name__ == '__main__':
    unittest.main()

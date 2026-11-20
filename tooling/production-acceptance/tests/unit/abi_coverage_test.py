"""DeriverTests use synthetic in-memory tar.xz fixtures only.

CoverageTests stream the pinned, retained Linux 6.8 archive through the deriver (never extracted). A missing or
changed archive is a test error, never a skip. ORACLES come from the independently transcribed abi_oracles.py.
"""
import ast
import hashlib
import importlib.util
import io
import json
import re
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('derive_abi_coverage', ROOT / 'appliance/derive_abi_coverage.py')
d = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = d
spec.loader.exec_module(d)

LOST = '7c8714c95a67d8a2e6c1b4c8b8481525a61976c81dfe2037c251add071ac9898'
HDR = 'include/uapi/linux/x.h'

ARCHIVE = Path('/Users/Matt/day-trader-references/m4-linux-aarch64-offline-repair-20261002T181543Z/linux-6.8.tar.xz')
ARCHIVE_SHA = 'c969dea4e8bb6be991bbf7c010ba0e0a5643a3a8d8fb0a2aaa053406f1e965f3'
INVENTORY = ROOT / 'appliance/abi-inventory.json'
COVERAGE_V2 = ROOT / 'appliance/abi-coverage-v2.json'
COVERAGE_V2_SHA = '9a26cde78f7ff6e1e96e43c3c5040e8431e697c27e5f4f1a9d9262754c6bf768'
EVENT_REFERENCE = ROOT / 'appliance/bootstrap-event-reference.json'
EVENT_REFERENCE_SHA = 'a2e1be5762976e07f270c6646ce5e4d94c48efcc2c78dacaf29ed3e32471be7d'
ORACLES_PATH = Path(__file__).resolve().parent / 'abi_oracles.py'


def load_oracles():
    """ORACLES: dict[str, int], transcribed by hand from the header text by a separate agent that never saw the deriver
    or the coverage. That agent was given each id's memberPath and conditions from the inventory, so the oracles
    independently check the values, not the choice of header or branch; that choice was checked separately by the
    task and final reviewers."""
    oracle_spec = importlib.util.spec_from_file_location('abi_oracles', ORACLES_PATH)
    module = importlib.util.module_from_spec(oracle_spec)
    oracle_spec.loader.exec_module(module)
    return module.ORACLES


def make_tar(members):
    """members: list of (name, text); duplicates allowed."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:xz') as t:
        for name, text in members:
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def entry(id, member=HDR, kind='define', conditions=(), width=32, signed=False, **extra):
    e = {'id': id, 'memberPath': member, 'kind': kind, 'conditions': list(conditions), 'width': width, 'signed': signed}
    e.update(extra)
    return e


class DeriverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def run_derive(self, members, entries):
        data = make_tar(members)
        path = self.dir / 'a.tar.xz'
        path.write_bytes(data)
        sha = hashlib.sha256(data).hexdigest()
        return d.derive(path, {'version': 1, 'entries': entries}, archive_sha256=sha), path, sha

    def code(self, members, entries, sha=None):
        data = make_tar(members)
        path = self.dir / 'b.tar.xz'
        path.write_bytes(data)
        with self.assertRaises(d.AbiCoverageError) as cm:
            d.derive(path, {'version': 1, 'entries': entries}, archive_sha256=sha or hashlib.sha256(data).hexdigest())
        return cm.exception.code

    def test_define_and_enum_values_with_line_spans(self):
        text = '/* c */\n#define A 3\n#define B (A << 2)\nenum { C = 7 };\n'
        out, _, sha = self.run_derive([(HDR, text)], [entry('A'), entry('B'), entry('C', kind='enum')])
        self.assertEqual(out['sourceArchiveSHA256'], sha)
        self.assertEqual(out['supersedesLostCoverageSHA256'], LOST)
        self.assertEqual(out['derivedBy'], 'tooling/production-acceptance/appliance/derive_abi_coverage.py')
        r = {x['id']: x for x in out['records']}
        self.assertEqual([x['id'] for x in out['records']], ['A', 'B', 'C'])
        self.assertEqual((r['A']['value'], r['B']['value'], r['C']['value']), (3, 12, 7))
        self.assertEqual((r['A']['firstLine'], r['A']['lastLine'], r['A']['declaration']), (2, 2, '#define A 3'))
        self.assertEqual((r['B']['firstLine'], r['B']['declaration']), (3, '#define B (A << 2)'))
        self.assertEqual((r['C']['firstLine'], r['C']['lastLine'], r['C']['declaration']), (4, 4, 'enum { C = 7 };'))
        self.assertEqual(r['A']['memberSHA256'], hashlib.sha256(text.encode()).hexdigest())
        self.assertEqual(set(r['A']), {'id', 'memberPath', 'memberSHA256', 'firstLine', 'lastLine', 'declaration', 'conditions', 'value', 'width', 'signed'})

    def test_expression_evaluator_suffixes_and_rejections(self):
        text = ('#define H 0x80000000U\n#define S (1UL << 3)\n#define BB _BITUL(31)\n#define X 1024\n#define Y (X + 6)\n'
                '#define O 010\n#define N (-1 & 0xff)\n#define CAST ((int)1)\n#define SZ sizeof(int)\n')
        ents = [entry(n) for n in ('H', 'S', 'BB', 'X', 'Y', 'O')] + [entry('N', signed=True)]
        out, _, _ = self.run_derive([(HDR, text)], ents)
        r = {x['id']: x['value'] for x in out['records']}
        self.assertEqual(r, {'H': 2147483648, 'S': 8, 'BB': 2147483648, 'X': 1024, 'Y': 1030, 'O': 8, 'N': 255})
        self.assertEqual(self.code([(HDR, text)], [entry('CAST')]), 'EXPRESSION_UNSUPPORTED')
        self.assertEqual(self.code([(HDR, text)], [entry('SZ')]), 'EXPRESSION_UNSUPPORTED')

    def test_conditional_definitions_require_pinned_condition(self):
        text = '#if W == 64\n#define F 1\n#else\n#define F 2\n#endif\n'
        for conds, value in ((['#if W == 64'], 1), (['#else'], 2)):
            out, _, _ = self.run_derive([(HDR, text)], [entry('F', conditions=conds)])
            self.assertEqual(out['records'][0]['value'], value)
            self.assertEqual(out['records'][0]['conditions'], conds)
        self.assertEqual(self.code([(HDR, text)], [entry('F')]), 'SYMBOL_AMBIGUOUS')
        self.assertEqual(self.code([(HDR, text)], [entry('F', conditions=['#ifdef Q'])]), 'SYMBOL_MISSING')

    def test_include_guard_counts_as_condition(self):
        text = '#ifndef _G_H\n#define _G_H\n#define F 5\n#endif\n'
        out, _, _ = self.run_derive([(HDR, text)], [entry('F', conditions=['#ifndef _G_H'])])
        self.assertEqual(out['records'][0]['value'], 5)
        self.assertEqual(self.code([(HDR, text)], [entry('F')]), 'SYMBOL_MISSING')

    def test_cross_member_reference_only_via_inventory(self):
        a = '#define Z (EM_X | 0x40000000)\n#define W2 (NOT_INV + 1)\n'
        b = '#define EM_X 183\n#define NOT_INV 4\n'
        ents = [entry('Z', member='a.h'), entry('EM_X', member='b.h')]
        out, _, _ = self.run_derive([('a.h', a), ('b.h', b)], ents)
        self.assertEqual({x['id']: x['value'] for x in out['records']}, {'Z': 0x40000000 | 183, 'EM_X': 183})
        self.assertEqual(self.code([('a.h', a), ('b.h', b)], [entry('W2', member='a.h')]), 'SYMBOL_MISSING')

    def test_layout_offsets_and_size(self):
        text = 'struct s {\n\tint nr;\n\t__u32 arch;\n\t__u64 ip;\n\t__u64 args[6];\n};\n'
        ents = [entry(f'S.{f}', kind='layout', struct='s', field=f, width=32) for f in ('nr', 'arch', 'ip', 'args')]
        ents.append(entry('S.size', kind='layout', struct='s', field=None, width=32))
        out, _, _ = self.run_derive([(HDR, text)], ents)
        r = {x['id']: x for x in out['records']}
        self.assertEqual([r[k]['value'] for k in ('S.nr', 'S.arch', 'S.ip', 'S.args', 'S.size')], [0, 4, 8, 16, 64])
        self.assertEqual((r['S.size']['firstLine'], r['S.size']['lastLine']), (1, 6))
        self.assertEqual(r['S.size']['declaration'], text.rstrip('\n'))
        bad = 'struct s {\n\tchar *p;\n};\n'
        self.assertEqual(self.code([(HDR, bad)], [entry('S.size', kind='layout', struct='s', field=None)]), 'LAYOUT_UNSUPPORTED')

    def test_archive_member_missing_duplicate_or_changed_denied(self):
        text = '#define A 1\n'
        self.assertEqual(self.code([(HDR, text)], [entry('A')], sha='0' * 64), 'ARCHIVE_MISMATCH')
        # hash is checked before the tar is opened: a wrong-hash archive that would be MEMBER_DUPLICATE is ARCHIVE_MISMATCH
        self.assertEqual(self.code([(HDR, text), (HDR, text)], [entry('A')], sha='0' * 64), 'ARCHIVE_MISMATCH')
        self.assertEqual(self.code([(HDR, text)], [entry('A', member='nope.h')]), 'MEMBER_MISSING')
        self.assertEqual(self.code([(HDR, text), (HDR, text)], [entry('A')]), 'MEMBER_DUPLICATE')
        self.assertEqual(self.code([(HDR, text)], [{'id': 'A'}]), 'INVENTORY_INVALID')

    def test_symbol_absent_from_named_member_denied(self):
        self.assertEqual(self.code([(HDR, '#define A 1\n'), ('other.h', '#define B 2\n')], [entry('B')]), 'SYMBOL_MISSING')

    def test_output_is_canonical_and_cli_refuses_existing_output(self):
        text = '#define A 3\n'
        out, path, sha = self.run_derive([(HDR, text)], [entry('A')])
        inv = self.dir / 'inv.json'
        inv.write_text(json.dumps({'version': 1, 'entries': [entry('A')]}))
        dest = self.dir / 'out.json'
        cmd = [sys.executable, '-B', str(ROOT / 'appliance/derive_abi_coverage.py'), '--archive', str(path), '--archive-sha256', sha, '--inventory', str(inv), '--output', str(dest)]
        self.assertEqual(subprocess.run(cmd, capture_output=True).returncode, 0)
        self.assertEqual(dest.read_bytes(), (json.dumps(out, sort_keys=True, indent=2, ensure_ascii=True) + '\n').encode())
        second = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(second.returncode, 2)
        bad = subprocess.run(cmd[:6] + ['0' * 64] + cmd[7:-1] + [str(self.dir / 'o2.json')], capture_output=True, text=True)
        self.assertEqual((bad.returncode, bad.stdout.strip()), (2, 'ARCHIVE_MISMATCH'))
        self.assertFalse((self.dir / 'o2.json').exists())

    def test_ul_and_bitul_macros(self):
        out, _, _ = self.run_derive([(HDR, '#define U _UL(5)\n#define B _BITUL(5)\n')], [entry('U'), entry('B')])
        self.assertEqual({x['id']: x['value'] for x in out['records']}, {'B': 32, 'U': 5})

    def test_fail_closed_arithmetic(self):
        text = ('#define NOT (~0U)\n#define WRAP (0xFFFFFFFFU << 4)\n#define NEG (-1)\n#define BIG (1UL << 40)\n'
                '#define LONGS (0xFFFFFFFFUL << 4)\n#define OVER (0xFFFFFFFFUL + 1)\n')
        self.assertEqual(self.code([(HDR, text)], [entry('NOT', signed=True, width=64)]), 'EXPRESSION_UNSUPPORTED')
        self.assertEqual(self.code([(HDR, text)], [entry('WRAP', width=64)]), 'EXPRESSION_UNSUPPORTED')
        self.assertEqual(self.code([(HDR, text)], [entry('NEG')]), 'EXPRESSION_UNSUPPORTED')
        self.assertEqual(self.code([(HDR, text)], [entry('OVER')]), 'EXPRESSION_UNSUPPORTED')
        out, _, _ = self.run_derive([(HDR, text)], [entry('NEG', signed=True), entry('BIG', width=64), entry('LONGS', width=64)])
        self.assertEqual({x['id']: x['value'] for x in out['records']}, {'NEG': -1, 'BIG': 1 << 40, 'LONGS': 0xFFFFFFFF << 4})

    def test_packed_or_aligned_struct_denied(self):
        ent = [entry('S.size', kind='layout', struct='s', field=None)]
        for text in ('struct s {\n\t__u8 a;\n\t__u32 b;\n} __attribute__((packed));\n',
                     'struct s {\n\t__u8 a;\n} __aligned(8);\n',
                     'struct s {\n\t__u8 a __attribute__((aligned(8)));\n};\n',
                     'struct s {\n\t__u8 a;\n} __packed;\n'):
            self.assertEqual(self.code([(HDR, text)], ent), 'LAYOUT_UNSUPPORTED', text)
        out, _, _ = self.run_derive([(HDR, 'struct s {\n\t__u8 a;\n} sv;\n')], ent)
        self.assertEqual(out['records'][0]['value'], 1)


class CoverageTests(unittest.TestCase):
    """The committed coverage v2 is a new derivation from the retained archive; it never claims to be the lost file."""

    def committed(self):
        return json.loads(COVERAGE_V2.read_bytes())

    def test_committed_coverage_reproduces_from_retained_archive(self):
        derived = d.derive(ARCHIVE, json.loads(INVENTORY.read_text()), archive_sha256=ARCHIVE_SHA)
        canonical = (json.dumps(derived, sort_keys=True, indent=2, ensure_ascii=True) + '\n').encode()
        committed = COVERAGE_V2.read_bytes()
        self.assertEqual(canonical, committed)
        self.assertEqual(hashlib.sha256(committed).hexdigest(), COVERAGE_V2_SHA)
        self.assertEqual(derived['sourceArchiveSHA256'], ARCHIVE_SHA)

    def test_coverage_values_match_independent_oracles(self):
        oracles = load_oracles()
        self.assertEqual({r['id']: r['value'] for r in self.committed()['records']}, oracles)

    def test_coverage_supersedes_lost_coverage_without_claiming_it(self):
        self.assertEqual(self.committed()['supersedesLostCoverageSHA256'], LOST)
        self.assertRegex(COVERAGE_V2_SHA, '^[0-9a-f]{64}$')
        self.assertNotEqual(COVERAGE_V2_SHA, LOST)
        self.assertNotEqual(hashlib.sha256(COVERAGE_V2.read_bytes()).hexdigest(), LOST)

    def test_event_reference_unchanged(self):
        self.assertEqual(hashlib.sha256(EVENT_REFERENCE.read_bytes()).hexdigest(), EVENT_REFERENCE_SHA)

    def test_coverage_event_values_equal_event_reference_records(self):
        """Task 11: every id in both coverage v2 and the committed Task 2 event reference has one value; the ids this
        task binds are all among them, and the R13 route kinds equal their reference records too."""
        raw = EVENT_REFERENCE.read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), EVENT_REFERENCE_SHA)
        reference = {r['id']: r['value'] for r in json.loads(raw)['records']}
        coverage = {r['id']: r['value'] for r in self.committed()['records']}
        both = set(reference) & set(coverage)
        self.assertEqual(sorted(EVENT_LITERAL_IDS - both), [])
        for ident in sorted(both):
            self.assertEqual(coverage[ident], reference[ident], ident)
        for name in ('RTM_DELLINK', 'RTM_DELADDR', 'RTM_DELROUTE', 'NLMSG_HDRLEN'):
            self.assertNotIn(name, coverage)
            self.assertEqual(R13_LITERALS[name][0], reference[name], name)


GUEST = ROOT / 'guest'
# Task 10 (Option A I1): the guest probe catalogue is swept with the guest modules' syscall and flag tables.
PROBE_FILE = 'confinement_probe.py'
PROBE_PATH = ROOT / 'tests/guest' / PROBE_FILE
_conf_spec = importlib.util.spec_from_file_location('abi_coverage_confinement', GUEST / 'confinement.py')
confinement = importlib.util.module_from_spec(_conf_spec)
sys.modules[_conf_spec.name] = confinement
_conf_spec.loader.exec_module(confinement)

# Base deny list in program order (24 inventoried symbols).
DENY_ORDER = tuple('__NR_' + n for n in (
    'io_uring_setup io_uring_enter io_uring_register ptrace process_vm_readv process_vm_writev pidfd_getfd pidfd_open '
    'capset setregid setgid setreuid setuid setresuid setresgid setfsuid setfsgid setgroups setns mknodat umount2 mount '
    'pivot_root chroot').split())
# E1 (contract C6, ruling R1): exactly these eleven leave the BROWSER deny list, for Chromium's namespace sandbox.
BROWSER_SANDBOX_SYMBOLS = frozenset('__NR_' + n for n in (
    'chroot capset setuid setgid setreuid setregid setresuid setresgid setfsuid setfsgid setgroups').split())
# Per-role deny list in program order: BROWSER 13 symbols (R1 keeps mount umount2 pivot_root setns mknodat pidfd_open),
# every other role the 24 unchanged.
DENY_SYMBOLS_BY_ROLE = {
    'CONTROLLER': DENY_ORDER,
    'BROWSER': tuple('__NR_' + n for n in (
        'io_uring_setup io_uring_enter io_uring_register ptrace process_vm_readv process_vm_writev pidfd_getfd '
        'pidfd_open setns mknodat umount2 mount pivot_root').split()),
    'VERIFIER': DENY_ORDER,
    'PROXY': DENY_ORDER,
}
# seccomp(2) filter flags each role may pass, in program order (C6). Each entry names the POLICY_LITERALS or coverage v2
# symbols whose OR is the compared value. No NEW_LISTENER, LOG or TSYNC_ESRCH for any role.
_BASE_FLAGS = (('SECCOMP_NO_FLAGS',), ('SECCOMP_FILTER_FLAG_TSYNC',))
SECCOMP_FLAG_NAMES_BY_ROLE = {
    'CONTROLLER': _BASE_FLAGS,
    'BROWSER': _BASE_FLAGS + (('SECCOMP_FILTER_FLAG_SPEC_ALLOW',),
                              ('SECCOMP_FILTER_FLAG_TSYNC', 'SECCOMP_FILTER_FLAG_SPEC_ALLOW')),
    'VERIFIER': _BASE_FLAGS,
    'PROXY': _BASE_FLAGS,
}
# socket(2) protocol values each role's AF_INET/AF_INET6 branch compares, in program order (Task 8c, C6). Each entry
# names the POLICY_LITERALS or coverage v2 symbols whose OR is the compared value. BROWSER compares IPPROTO_TCP (true
# branch: SOCK_STREAM only), then requires the default 0; every other role requires the default 0 only.
_DEFAULT_PROTOCOL = (('PROTOCOL_DEFAULT',),)
IP_PROTOCOL_NAMES_BY_ROLE = {
    'CONTROLLER': _DEFAULT_PROTOCOL,
    'BROWSER': (('IPPROTO_TCP',),) + _DEFAULT_PROTOCOL,
    'VERIFIER': _DEFAULT_PROTOCOL,
    'PROXY': _DEFAULT_PROTOCOL,
}
# Flag combinations the brief tests as denied (C6), each the OR of the named symbols: LOG, NEW_LISTENER,
# NEW_LISTENER|TSYNC, NEW_LISTENER|SPEC_ALLOW, NEW_LISTENER|SPEC_ALLOW|TSYNC, TSYNC_ESRCH. For roles other than BROWSER
# SPEC_ALLOW and TSYNC|SPEC_ALLOW are denied too.
SECCOMP_DENIED_FLAG_NAMES = (
    ('SECCOMP_FILTER_FLAG_LOG',),
    ('SECCOMP_FILTER_FLAG_NEW_LISTENER',),
    ('SECCOMP_FILTER_FLAG_NEW_LISTENER', 'SECCOMP_FILTER_FLAG_TSYNC'),
    ('SECCOMP_FILTER_FLAG_NEW_LISTENER', 'SECCOMP_FILTER_FLAG_SPEC_ALLOW'),
    ('SECCOMP_FILTER_FLAG_NEW_LISTENER', 'SECCOMP_FILTER_FLAG_SPEC_ALLOW', 'SECCOMP_FILTER_FLAG_TSYNC'),
    ('SECCOMP_FILTER_FLAG_TSYNC_ESRCH',),
)
# guest/confinement.py module constants (Task 8), each element bound to its named symbol in source order.
# BASE_DENY_SYSCALLS is DENY_ORDER; BROWSER_SANDBOX_SYSCALLS lists the eleven in this order.
BROWSER_SANDBOX_ORDER = tuple('__NR_' + n for n in (
    'chroot capset setregid setgid setreuid setuid setresuid setresgid setfsuid setfsgid setgroups').split())
# sha256(filter_bytes(build_filter(role))). E1 and Task 8c leave CONTROLLER, VERIFIER and PROXY byte-identical; the
# BROWSER digest was recomputed in Task 8c Step 3 from the E1 program plus the IPPROTO_TCP admission (101 instructions).
ROLE_FILTER_DIGESTS = {
    'CONTROLLER': '294f083482eb1caa13cd40ddb98489acd0712b2bd1a6e1d634622a24ed18d7b3',
    'BROWSER': '42216444e1ccb8b7c6af75b7f1b7d59c4f4ac72eb653a890c65b570d62cf25cc',
    'VERIFIER': '294f083482eb1caa13cd40ddb98489acd0712b2bd1a6e1d634622a24ed18d7b3',
    'PROXY': '01e3ec748fdbadb0a0ac195855506cc19680fcc5aa3c6289d2c15e15ec981d7d',
}
# Task 8c (C6, owner decision 2026-11-20): superseded BROWSER programs. Task 8's (96 instructions) denied
# socket(AF_INET/AF_INET6, SOCK_STREAM, IPPROTO_TCP), so Chromium could never reach the guest CONNECT proxy.
RETIRED_BROWSER_FILTER_DIGESTS = frozenset({
    'f84ca34690734a6a45871af34bfddf5941e4a2c8af2f1916eb10a248b74bb049',
})

# syscall symbol -> files whose native syscall(...) call sites invoke it (R6). Direct call sites only: the rest of the
# BPF deny list appears in the filter but is not called. Task 10 adds the probe catalogue's attempts (PROBE_FILE).
SYSCALL_SITES = {
    '__NR_capset': frozenset({'confinement.py', PROBE_FILE}),
    '__NR_chroot': frozenset({PROBE_FILE}),
    '__NR_close_range': frozenset({'confinement.py', PROBE_FILE}),
    '__NR_connect': frozenset({PROBE_FILE}),
    '__NR_fcntl': frozenset({'confinement.py'}),
    '__NR_io_uring_enter': frozenset({PROBE_FILE}),
    '__NR_io_uring_register': frozenset({PROBE_FILE}),
    '__NR_io_uring_setup': frozenset({PROBE_FILE}),
    '__NR_mount': frozenset({'confinement.py'}),
    '__NR_pidfd_getfd': frozenset({PROBE_FILE}),
    '__NR_pidfd_open': frozenset({PROBE_FILE}),
    '__NR_pivot_root': frozenset({'confinement.py'}),
    '__NR_prctl': frozenset({'confinement.py'}),
    '__NR_process_vm_readv': frozenset({PROBE_FILE}),
    '__NR_process_vm_writev': frozenset({PROBE_FILE}),
    '__NR_ptrace': frozenset({PROBE_FILE}),
    '__NR_recvmsg': frozenset({PROBE_FILE}),
    '__NR_seccomp': frozenset({'confinement.py', PROBE_FILE}),
    '__NR_sendto': frozenset({PROBE_FILE}),
    '__NR_setgroups': frozenset({'confinement.py'}),
    '__NR_setresgid': frozenset({'confinement.py'}),
    '__NR_setresuid': frozenset({'confinement.py', PROBE_FILE}),
    '__NR_socket': frozenset({PROBE_FILE}),
    '__NR_socketpair': frozenset({PROBE_FILE}),
    '__NR_umount2': frozenset({'confinement.py'}),
    '__NR_unshare': frozenset({'confinement.py', PROBE_FILE}),
    '__NR_write': frozenset({PROBE_FILE}),
}
# The syscalls the probe catalogue attempts (Task 10): exactly these, each at sites bound in SITE_ARGS.
PROBE_SYSCALLS = frozenset(name for name, files in SYSCALL_SITES.items() if PROBE_FILE in files)

# syscall symbol -> argument index (after the number; equals seccomp args[i]) -> covered symbols whose values the
# literal at that index (or the filter comparison on args[i] low word) may take. Used both by the native call sites
# and, as an upper bound, by the BPF filter.
_PRCTL_OPTIONS = frozenset({'PR_SET_KEEPCAPS', 'PR_SET_SECUREBITS', 'PR_SET_NO_NEW_PRIVS', 'PR_SET_DUMPABLE',
                            'PR_CAP_AMBIENT', 'PR_SET_SECCOMP', 'PR_CAPBSET_DROP'})
# Argument 2 (Task 8c, C6): IPPROTO_TCP, the only named protocol symbol any filter compares (BROWSER's AF_INET/AF_INET6
# SOCK_STREAM admission). This upper bound has no role dimension and is shared by socket and socketpair, which reach the
# same filter branch; per-role exactness is IP_PROTOCOL_NAMES_BY_ROLE (test_ip_protocol_compares_match_named_symbols)
# and the exact expected program. No native call site names it.
_SOCKET_ARGS = {0: frozenset({'AF_UNIX', 'AF_INET', 'AF_INET6', 'AF_VSOCK'}),
                1: frozenset({'SOCK_STREAM', 'SOCK_DGRAM', 'SOCK_SEQPACKET'}),
                2: frozenset({'IPPROTO_TCP'})}
ARG_SYMBOLS = {
    '__NR_fcntl': {1: frozenset({'F_DUPFD_CLOEXEC'})},
    '__NR_mount': {3: frozenset({'MS_PRIVATE', 'MS_REC', 'MS_BIND', 'MS_REMOUNT', 'MS_RDONLY', 'MS_NOSUID', 'MS_NODEV',
                                 'MS_NOEXEC'})},
    '__NR_prctl': {0: _PRCTL_OPTIONS,
                   1: frozenset({'SUID_DUMP_DISABLE', 'PR_CAP_AMBIENT_RAISE', 'PR_CAP_AMBIENT_CLEAR_ALL',
                                 'SECCOMP_MODE_FILTER'})},
    '__NR_seccomp': {0: frozenset({'SECCOMP_SET_MODE_FILTER'}),
                     1: frozenset({'SECCOMP_FILTER_FLAG_TSYNC', 'SECCOMP_FILTER_FLAG_SPEC_ALLOW'})},
    '__NR_umount2': {1: frozenset({'MNT_DETACH'})},
    # CLONE_NEWUSER: the P49 probe's unshare; no filter compares unshare's argument (R2).
    '__NR_unshare': {0: frozenset({'CLONE_NEWNS', 'CLONE_NEWPID', 'CLONE_NEWIPC', 'CLONE_NEWUSER'})},
    '__NR_socket': _SOCKET_ARGS,
    '__NR_socketpair': _SOCKET_ARGS,
    # Task 10 theft probes (T8-01, Option A m4): the ptrace requests and recvmsg's flags; neither is compared by any
    # filter (ptrace jumps straight to the deny return, recvmsg is not filtered).
    '__NR_ptrace': {0: frozenset({'PTRACE_ATTACH', 'PTRACE_SEIZE'})},
    '__NR_recvmsg': {2: frozenset({'MSG_CMSG_CLOEXEC'})},
}
# The only OR combinations of ARG_SYMBOLS a filter comparison on args[i] low word may take, each listed by name
# (C6: BROWSER's TSYNC|SPEC_ALLOW). Any other combination stays unadmitted.
ARG_COMBINATIONS = {
    '__NR_seccomp': {1: (frozenset({'SECCOMP_FILTER_FLAG_TSYNC', 'SECCOMP_FILTER_FLAG_SPEC_ALLOW'}),)},
}
# Literals that are policy choices, not ABI values: name -> (value, one-line justification). Each genuine use is named
# at its own site (SITE_ARGS / the expected filter program); there is no catch-all "any policy value" acceptance.
POLICY_LITERALS = {
    'NR_HIGH_BITS_MASK': (0xc0000000, 'syscall-number high-bit mask: numbers with bits 30-31 set (x32-style/negative) are killed; no AArch64 header constant'),
    'NR_MASKED_CLEAN': (0, 'expected result of the nr high-bit mask: no high bits set'),
    'HIGH_WORD_ZERO': (0, 'every constrained scalar argument must have a zero upper 32-bit word'),
    'PROTOCOL_DEFAULT': (0, 'socket protocol default scalar 0, the only protocol every role may name; all other values '
                            'fail closed, except BROWSER\'s IPPROTO_TCP for AF_INET/AF_INET6 SOCK_STREAM (Task 8c, C6), '
                            'which is a coverage symbol, not this policy scalar'),
    'SECCOMP_NO_FLAGS': (0, 'seccomp(2) flags value meaning no flags'),
    'NNP_ENABLE': (1, 'PR_SET_NO_NEW_PRIVS arg is the boolean 1; the kernel tests it literally'),
    'FD_FLOOR': (64, 'lowest descriptor for F_DUPFD_CLOEXEC, above the audited FD0..4'),
    'CLOSE_RANGE_MAX': (4294967295, 'close_range upper bound ~0U meaning all remaining descriptors; unsigned-int maximum'),
    'CLOSE_RANGE_NO_FLAGS': (0, 'close_range flags: none'),
    'EMPTY_GROUP_LIST': (0, 'setgroups(0, NULL): empty supplementary-group list'),
    'UNUSED_ARG': (0, 'unused trailing prctl argument must be zero; no symbol exists'),
    'CAPSET_HEADER_PID': (0, 'capset header pid 0 means the calling thread'),
    'LOWER_BOUND_ZERO': (0, 'lower bound of the jt/jf range and of the program length'),
    'BPF_JUMP_BASE': (-1, 'classic-BPF jumps are relative to the next instruction: jt = target - index - 1'),
    'CLOSE_RANGE_INCLUSIVE_END': (1, 'close_range(first, fd-1): the upper bound is inclusive, so fd-1 keeps the retained fd open'),
    'VSOCK_SERVICE_PORT': (4050, 'fixed host broker vsock service port; a deployment choice, no header constant'),
    'UNIX_FLAGS_NONE': (0, '/proc/net/unix Flags column of a socket that is not listening: no flag bits set'),
    'OPTIONAL_CLOEXEC_ABSENT': (0, 'getattr(os, "O_CLOEXEC", 0) fallback contributes no flag bit when Python lacks the name'),
}
POLICY_VALUES = frozenset(v for v, _ in POLICY_LITERALS.values())
# Code literals that are Linux ABI values the deriver cannot derive (ruling R13), named so that a site can account for
# them exactly. Recording the code value here is not a claim that it is correct; it stays known uncovered surface.
R13_LITERALS = {
    'CAPSET_DATA_BYTES': (24, 'R13: _LINUX_CAPABILITY_U32S_3 x sizeof(struct __user_cap_data_struct); the struct '
                              'sits behind a typedef pointer declarator the deriver refuses, so only the count factor '
                              'is covered'),
    'TCP_LISTEN': (10, 'R13 (P34): linux-6.8/include/net/tcp_states.h:22 TCP_LISTEN is the 10th enumerator counted '
                       'from TCP_ESTABLISHED = 1 at :13; an implicit enumerator the deriver refuses with '
                       'SYMBOL_MISSING, the same route as the SS_* socket states'),
    'SOCKETPAIR_SV_BYTES': (8, 'R13 (Task 10): socketpair(2) fills int sv[2], two 4-byte ints on LP64; the probe passes '
                               'that buffer'),
    'SOCK_FPROG_BYTES': (16, 'R13 (Task 10): linux-6.8/include/uapi/linux/filter.h:31-34 struct sock_fprog {unsigned '
                             'short len; struct sock_filter *filter;} on LP64: 2 bytes, 6 padding, an 8-byte pointer; '
                             'the probe passes it empty'),
    # Task 11 (P57, the P34 route): implicit enumerators the deriver refuses (SYMBOL_MISSING as enum,
    # EXPRESSION_UNSUPPORTED as their self-referencing #define). Each equals its committed event reference record
    # (CoverageTests), and the Task 11 oracle transcriber confirmed each value independently (reported, not appended).
    'RTM_DELLINK': (17, 'R13 (P57): linux-6.8/include/uapi/linux/rtnetlink.h:30 RTM_DELLINK is the implicit '
                        'enumerator after RTM_NEWLINK = 16 at :28'),
    'RTM_DELADDR': (21, 'R13 (P57): linux-6.8/include/uapi/linux/rtnetlink.h:39 RTM_DELADDR is the implicit '
                        'enumerator after RTM_NEWADDR = 20 at :37'),
    'RTM_DELROUTE': (25, 'R13 (P57): linux-6.8/include/uapi/linux/rtnetlink.h:46 RTM_DELROUTE is the implicit '
                         'enumerator after RTM_NEWROUTE = 24 at :44'),
    # Task 11 fix round 1 (P62): a layout value the deriver does not evaluate (sizeof); it also equals the committed
    # event reference record NLMSG_HDRLEN (CoverageTests).
    'NLMSG_HDRLEN': (16, 'R13 (P62): linux-6.8/include/uapi/linux/netlink.h:100 NLMSG_HDRLEN is '
                         'NLMSG_ALIGN(sizeof(struct nlmsghdr)); struct nlmsghdr at :52-58 is __u32, __u16, __u16, '
                         '__u32, __u32 (16 bytes, already a multiple of NLMSG_ALIGNTO 4 at :98)'),
    # Task 18 F3 (P85): kernel behaviour, not a header value. The AUDIT_STATUS_* OR (AUDIT_STATUS_MASK below) is an
    # AUDIT_SET request mask only; the GET reply never carries it.
    'AUDIT_GET_REPLY_MASK': (0, 'R13 (P85): linux-6.8/kernel/audit.c:1236-1251 AUDIT_GET memsets struct audit_status '
                                '(:1238) and sets enabled, failure, pid, rate_limit, backlog_limit, lost, backlog, '
                                'feature_bitmap and both wait fields (:1239-1250), never mask, before audit_send_reply '
                                '(:1251): the reply mask word is always 0'),
}
# Task 10: literals of the guest probe catalogue that are probe choices, not ABI values. They are named only at
# PROBE_FILE syscall sites and struct calls (never by build_filter, so POLICY_VALUES is unchanged).
PROBE_POLICY_LITERALS = {
    'NULL_POINTER': (0, 'a NULL user pointer or address argument that the refused call never dereferences'),
    'NO_FLAGS': (0, 'a flags or options argument with no bit set'),
    'ZERO_ARG': (0, 'a zero count, opcode or length argument of a call that must be refused before it reads it'),
    'INVALID_FD': (-1, 'no descriptor: io_uring_register and io_uring_enter on -1 reach the seccomp check first'),
    'IO_URING_ENTRIES': (1, 'io_uring_setup asks for one ring entry; the call must be refused before any ring exists'),
    'FOREIGN_COMMAND_FD': (3, "the foreign role process's inherited FD3 command pipe, the descriptor pidfd_getfd "
                              'would steal'),
    'ROOT_ID': (0, 'uid 0: setresuid(0, 0, 0) asks for root in the real, effective and saved ids'),
    'ONE_IOVEC': (1, 'process_vm_readv, process_vm_writev and recvmsg pass exactly one iovec'),
    'FIRST_UNAUDITED_FD': (5, 'the first descriptor above the audited FD0..4, where the helper close_range starts'),
    'CLOSE_RANGE_PAST_RETAINED': (1, 'close_range(fd + 1, ...): the second range starts just after the retained '
                                     'pinned descriptor'),
    'SVM_RESERVED': (0, 'struct sockaddr_vm svm_reserved1 is zero'),
    'NO_FLOW_LABEL': (0, 'struct sockaddr_in6 sin6_flowinfo is zero'),
    'NO_SCOPE': (0, 'struct sockaddr_in6 sin6_scope_id is zero: no link-local scope'),
    'CAP_BIT0': (1, 'capability bit 0 (CAP_CHOWN) in the first effective and permitted words: one capability the role '
                    'does not hold'),
    'NO_CAPABILITIES': (0, 'an empty capability word'),
    'POINTER_SLOT': (0, 'a pointer field the NativeMemory pointer map relocates at the call; the packed value is a '
                        'placeholder'),
    'IOV_BYTES': (8, 'eight bytes in each process_vm iovec: a non-empty transfer, since a zero total returns 0 before '
                     'the pid is resolved'),
    'REMOTE_IOV_BASE': (4096, 'a non-null remote address; the ptrace access check precedes any use of it'),
    'ONE_BYTE': (1, 'a one-byte data buffer, enough to carry one SCM_RIGHTS message'),
    'ZERO_OFFSET': (0, 'the first control message starts at offset 0 of the control buffer'),
}

# Exact per-site bindings for native syscall(...) calls: (file, enclosing qualname, ordinal in source order among the
# syscall calls with a literal number in that function) -> (nr symbol, {arg index: expected}[, {arg index: names}]).
# expected is a frozenset of covered symbols whose values OR to exactly the literal (a single symbol means equality),
# or a str naming a POLICY_LITERALS entry. Every int-literal argument must be listed and no other. The optional third
# element names, in source order, the int constants nested inside a non-literal argument (coverage symbol,
# POLICY_LITERALS or R13_LITERALS name); an argument absent from it may hold no int constant at all (R15).
def _s(*names):
    return frozenset(names)

_PRCTL_ZERO = {2: 'UNUSED_ARG', 3: 'UNUSED_ARG', 4: 'UNUSED_ARG'}
_VSOCK_STREAM = {0: _s('AF_VSOCK'), 1: _s('SOCK_STREAM'), 2: 'PROTOCOL_DEFAULT'}
SITE_ARGS = {
    ('confinement.py', 'LinuxBindings.pin_programs', 0): ('__NR_fcntl', {1: _s('F_DUPFD_CLOEXEC'), 2: 'FD_FLOOR'}),
    ('confinement.py', 'LinuxBindings.pin_sample', 0): ('__NR_fcntl', {1: _s('F_DUPFD_CLOEXEC'), 2: 'FD_FLOOR'}),
    ('confinement.py', 'NativeChildPort.establish_views', 0): ('__NR_mount', {3: _s('MS_PRIVATE', 'MS_REC')}),
    ('confinement.py', 'NativeChildPort.establish_views', 1): ('__NR_mount', {3: _s('MS_BIND')}),
    ('confinement.py', 'NativeChildPort.establish_views', 2): ('__NR_mount', {3: _s('MS_BIND')}),
    ('confinement.py', 'NativeChildPort.establish_views', 3): ('__NR_mount', {3: _s('MS_BIND', 'MS_REMOUNT', 'MS_RDONLY')}),
    ('confinement.py', 'NativeChildPort.establish_views', 4): ('__NR_mount', {3: _s('MS_BIND')}),
    # Task 14 (C7, P50, P14): the role's own /dev/shm tmpfs, then the bind of its crash directory; the rows after
    # them are renumbered by two (the /dev/null bind was 5, pivot_root 6, umount2 7, the proc mount 8).
    ('confinement.py', 'NativeChildPort.establish_views', 5): ('__NR_mount', {3: _s('MS_NOSUID', 'MS_NODEV', 'MS_NOEXEC')}),
    ('confinement.py', 'NativeChildPort.establish_views', 6): ('__NR_mount', {3: _s('MS_BIND')}),
    ('confinement.py', 'NativeChildPort.establish_views', 7): ('__NR_mount', {3: _s('MS_BIND')}),
    ('confinement.py', 'NativeChildPort.establish_views', 8): ('__NR_pivot_root', {}),
    ('confinement.py', 'NativeChildPort.establish_views', 9): ('__NR_umount2', {1: _s('MNT_DETACH')}),
    ('confinement.py', 'NativeChildPort.establish_views', 10): ('__NR_mount', {3: _s('MS_NOSUID', 'MS_NODEV', 'MS_NOEXEC')}),
    ('confinement.py', 'NativeChildPort.close_unaudited_fds', 0): ('__NR_close_range', {2: 'CLOSE_RANGE_NO_FLAGS'},
                                                                   {1: ('CLOSE_RANGE_INCLUSIVE_END',)}),
    ('confinement.py', 'NativeChildPort.close_unaudited_fds', 1): ('__NR_close_range', {1: 'CLOSE_RANGE_MAX', 2: 'CLOSE_RANGE_NO_FLAGS'}),
    ('confinement.py', 'NativeChildPort.drop_credentials', 0): ('__NR_setgroups', {0: 'EMPTY_GROUP_LIST', 1: 'EMPTY_GROUP_LIST'}),
    ('confinement.py', 'NativeChildPort.drop_credentials', 1): ('__NR_prctl', {0: _s('PR_CAP_AMBIENT'), 1: _s('PR_CAP_AMBIENT_CLEAR_ALL'), **_PRCTL_ZERO}),
    ('confinement.py', 'NativeChildPort.drop_credentials', 2): ('__NR_prctl', {0: _s('PR_CAPBSET_DROP'), **_PRCTL_ZERO}),
    ('confinement.py', 'NativeChildPort.drop_credentials', 3): ('__NR_setresgid', {}),
    ('confinement.py', 'NativeChildPort.drop_credentials', 4): ('__NR_setresuid', {}),
    ('confinement.py', 'NativeChildPort.clear_capabilities', 0): ('__NR_capset', {}, {
        0: ('_LINUX_CAPABILITY_VERSION_3', 'CAPSET_HEADER_PID'), 1: ('CAPSET_DATA_BYTES',)}),
    ('confinement.py', 'NativeChildPort.no_new_privs', 0): ('__NR_prctl', {0: _s('PR_SET_NO_NEW_PRIVS'), 1: 'NNP_ENABLE', **_PRCTL_ZERO}),
    ('confinement.py', 'NativeChildPort.install_seccomp', 0): ('__NR_seccomp', {0: _s('SECCOMP_SET_MODE_FILTER')}),
    ('confinement.py', '_KernelPortCore.spawn_waiting', 0): ('__NR_unshare', {0: _s('CLONE_NEWNS', 'CLONE_NEWPID', 'CLONE_NEWIPC')}),
    # tests/guest/confinement_probe.py (Task 10, Option A I1): every probe attempt, site by site.
    (PROBE_FILE, 'NativeProbePort._operation', 0): ('__NR_socket', _VSOCK_STREAM),
    (PROBE_FILE, 'NativeProbePort._operation', 1): ('__NR_socketpair', _VSOCK_STREAM, {3: ('SOCKETPAIR_SV_BYTES',)}),
    (PROBE_FILE, 'NativeProbePort._operation', 2): ('__NR_io_uring_setup', {0: 'IO_URING_ENTRIES', 1: 'NULL_POINTER'}),
    (PROBE_FILE, 'NativeProbePort._operation', 3): ('__NR_io_uring_register', {
        0: 'INVALID_FD', 1: 'ZERO_ARG', 2: 'NULL_POINTER', 3: 'ZERO_ARG'}),
    (PROBE_FILE, 'NativeProbePort._operation', 4): ('__NR_io_uring_enter', {
        0: 'INVALID_FD', 1: 'ZERO_ARG', 2: 'ZERO_ARG', 3: 'NO_FLAGS', 4: 'NULL_POINTER', 5: 'ZERO_ARG'}),
    (PROBE_FILE, 'NativeProbePort._operation', 5): ('__NR_socket', _VSOCK_STREAM),
    (PROBE_FILE, 'NativeProbePort._operation', 6): ('__NR_connect', {}),
    (PROBE_FILE, 'NativeProbePort._operation', 7): ('__NR_write', {}),
    (PROBE_FILE, 'NativeProbePort._operation', 8): ('__NR_pidfd_open', {1: 'NO_FLAGS'}),
    (PROBE_FILE, 'NativeProbePort._operation', 9): ('__NR_pidfd_getfd', {1: 'FOREIGN_COMMAND_FD', 2: 'NO_FLAGS'}),
    (PROBE_FILE, 'NativeProbePort._operation', 10): ('__NR_ptrace', {0: _s('PTRACE_ATTACH'), 2: 'NULL_POINTER',
                                                                     3: 'NULL_POINTER'}),
    (PROBE_FILE, 'NativeProbePort._operation', 11): ('__NR_ptrace', {0: _s('PTRACE_SEIZE'), 2: 'NULL_POINTER',
                                                                     3: 'NO_FLAGS'}),
    (PROBE_FILE, 'NativeProbePort._operation', 12): ('__NR_setresuid', {0: 'ROOT_ID', 1: 'ROOT_ID', 2: 'ROOT_ID'}),
    (PROBE_FILE, 'NativeProbePort._operation', 13): ('__NR_capset', {}),
    (PROBE_FILE, 'NativeProbePort._operation', 14): ('__NR_chroot', {}),
    (PROBE_FILE, 'NativeProbePort._operation', 15): ('__NR_unshare', {0: _s('CLONE_NEWUSER')}),
    (PROBE_FILE, 'NativeProbeContext.cross_memory', 0): ('__NR_process_vm_readv', {2: 'ONE_IOVEC', 4: 'ONE_IOVEC',
                                                                                  5: 'NO_FLAGS'}),
    (PROBE_FILE, 'NativeProbeContext.cross_memory', 1): ('__NR_process_vm_writev', {2: 'ONE_IOVEC', 4: 'ONE_IOVEC',
                                                                                   5: 'NO_FLAGS'}),
    (PROBE_FILE, 'NativeProbeContext.receive_rights', 0): ('__NR_recvmsg', {2: _s('MSG_CMSG_CLOEXEC')}),
    (PROBE_FILE, 'NativeProbeContext.connect_unix', 0): ('__NR_socket', {0: _s('AF_UNIX'), 1: _s('SOCK_STREAM'),
                                                                         2: 'PROTOCOL_DEFAULT'}),
    (PROBE_FILE, 'NativeProbeContext.connect_unix', 1): ('__NR_connect', {}),
    (PROBE_FILE, 'NativeProbeContext.network_attempt', 0): ('__NR_socket', {2: 'PROTOCOL_DEFAULT'}, {
        0: ('AF_INET', 'AF_INET6'), 1: ('SOCK_STREAM', 'SOCK_DGRAM')}),
    (PROBE_FILE, 'NativeProbeContext.network_attempt', 1): ('__NR_connect', {}),
    (PROBE_FILE, 'NativeProbeContext.network_attempt', 2): ('__NR_write', {}),
    (PROBE_FILE, 'NativeProbeContext.network_attempt', 3): ('__NR_sendto', {3: 'NO_FLAGS'}),
    (PROBE_FILE, 'NativeProbeContext._helper', 0): ('__NR_socket', _VSOCK_STREAM),
    (PROBE_FILE, 'NativeProbeContext._helper', 1): ('__NR_socket', _VSOCK_STREAM),
    (PROBE_FILE, 'NativeProbeContext._helper', 2): ('__NR_close_range', {0: 'FIRST_UNAUDITED_FD', 2: 'CLOSE_RANGE_NO_FLAGS'},
                                                    {1: ('CLOSE_RANGE_INCLUSIVE_END',)}),
    (PROBE_FILE, 'NativeProbeContext._helper', 3): ('__NR_close_range', {1: 'CLOSE_RANGE_MAX', 2: 'CLOSE_RANGE_NO_FLAGS'},
                                                    {0: ('CLOSE_RANGE_PAST_RETAINED',)}),
    (PROBE_FILE, 'NativeProbeContext.bootstrap_rejection.FaultPort.install_seccomp', 0): ('__NR_seccomp', {
        0: _s('SECCOMP_SET_MODE_FILTER'), 1: _s('SECCOMP_FILTER_FLAG_TSYNC')}, {2: ('SOCK_FPROG_BYTES',)}),
}
# SYSCALL_SITES is derived from the per-site table (nr symbol -> files); the test also checks it against the AST.

# Ruling R14: the rest of the guest Python modules. Every table below is exact: the code sites it describes must be
# exactly the ones the test finds, located by file, enclosing qualname and ordinal, never by line number.
GUEST_MODULES = ('confinement.py', 'intake.py', 'protocol.py', 'proxy.py', 'storage.py', 'topology.py')

# Syscalls the audit rule watches, in the order of topology.py _fixed_audit_rule and of the _audit_record check.
AUDITED_SYSCALLS = tuple('__NR_' + n for n in (
    'mknodat umount2 mount pivot_root chroot exit exit_group unshare bind listen clone execve setns execveat '
    'clone3').split())
_CLONE = ('__NR_clone', '__NR_clone3')

# name -> (file, enclosing qualname, compared expressions, [(operator, names)]): in source order, every comparison in
# that function whose left operand is one of the expressions, against an int literal or a tuple of int literals.
# names resolve through coverage v2 or POLICY_LITERALS; each comparator must equal the resolved tuple exactly.
COMPARE_SITES = {
    # Task 11 (P18, P58): no EXIT phase; process exit (exit_group), clone and exec in that source order.
    'transition': ('topology.py', 'BootstrapEventOwner._accept_browser_transition', ('number',), [
        ('Eq', ('__NR_exit_group',)),                        # root exit_group terminal, family exit_group removes
        ('In', _CLONE),                                      # CLONE phase and family clones
        ('In', ('__NR_execve', '__NR_execveat')),            # EXEC phase and family re-exec
    ]),
    'audit_syscalls': ('topology.py', 'BootstrapEventOwner._audit_record',
                       ("group['syscalls'][0]['number']", "syscall['number']", 'number'), [
        ('Eq', ('__NR_bind',)),
        ('NotEq', ('__NR_bind',)),
        ('Eq', ('__NR_exit',)),                              # P58: a thread's exit adds no event
        ('In', ('__NR_exit_group', '__NR_clone', '__NR_execve', '__NR_execveat', '__NR_clone3')),
        ('Eq', ('__NR_mknodat',)),
        ('Eq', ('__NR_bind',)),
        ('In', ('__NR_bind', '__NR_listen')),
        # Task 18 F4 (P86(b'), P88): an install group's one SYSCALL is the event owner's sendto(2).
        ('Eq', ('__NR_sendto',)),
        ('NotEq', ('__NR_sendto',)),
        ('In', ('__NR_exit', '__NR_exit_group')),            # Task 11: exit records carry no success=/exit=
        ('In', _CLONE),
        ('NotIn', _CLONE),
        ('NotIn', AUDITED_SYSCALLS),
    ]),
    # Task 11 (CB-I3): netlink message kinds, each by its named symbol.
    'event_health_kinds': ('topology.py', 'BootstrapEventOwner._verify_health_and_rules', ('kind',), [
        ('NotEq', ('AUDIT_GET',)),
        ('Eq', ('NLMSG_DONE',)),
        ('Eq', ('AUDIT_LIST_RULES',)),
    ]),
    'event_audit_kinds': ('topology.py', 'BootstrapEventOwner._audit_record', ('kind',), [
        # Task 18 F4 (P86 a, c and the after-install clause of b): ANOM_ABEND is always terminal, the boot
        # AUDIT_KERNEL record is accepted once before install completes, and any CONFIG_CHANGE after install is
        # terminal.
        ('Eq', ('AUDIT_ANOM_ABEND',)),
        ('Eq', ('AUDIT_KERNEL',)),
        ('Eq', ('AUDIT_CONFIG_CHANGE',)),
        ('Eq', ('AUDIT_EOE',)),
        ('NotIn', ('AUDIT_SYSCALL', 'AUDIT_PATH', 'AUDIT_CONFIG_CHANGE', 'AUDIT_SOCKADDR', 'AUDIT_CWD',
                   'AUDIT_EXECVE', 'AUDIT_PROCTITLE')),
        ('In', ('AUDIT_SYSCALL', 'AUDIT_PATH', 'AUDIT_EXECVE')),
        ('Eq', ('AUDIT_SYSCALL',)),
        ('Eq', ('AUDIT_PATH',)),
        ('Eq', ('AUDIT_EXECVE',)),
        ('Eq', ('AUDIT_SOCKADDR',)),
        # Task 18 F4 (P86(b')): install-group CONFIG_CHANGE bodies and the PROCTITLE count.
        ('Eq', ('AUDIT_CONFIG_CHANGE',)),
        ('Eq', ('AUDIT_PROCTITLE',)),
    ]),
    'event_route_kinds': ('topology.py', 'BootstrapEventOwner._record', ('kind',), [
        ('NotIn', ('RTM_NEWLINK', 'RTM_DELLINK', 'RTM_NEWADDR', 'RTM_DELADDR', 'RTM_NEWROUTE', 'RTM_DELROUTE')),
    ]),
    'audit_families': ('topology.py', 'BootstrapEventOwner._audit_record', ("group['sockaddrs'][0]", 'family'), [
        ('Eq', ('AF_UNIX',)),
        ('NotIn', ('AF_UNIX', 'AF_INET', 'AF_INET6')),
    ]),
    'unix_flags': ('topology.py', '_abstract', ('int(fields[3], 16)',), [
        ('NotIn', ('UNIX_FLAGS_NONE', '__SO_ACCEPTCON')),
    ]),
    'unix_types': ('topology.py', '_abstract', ('int(fields[4], 16)',), [
        ('NotIn', ('SOCK_STREAM', 'SOCK_DGRAM', 'SOCK_SEQPACKET')),
    ]),
    'name_max': ('storage.py', '_name', ('len(value)',), [
        ('Gt', ('NAME_MAX',)),
    ]),
}

# Task 11 (CB-I3, Option A I2/R17 C3): topology.py event constants whose OR elements, in source order, are exactly
# these symbols.
EVENT_MASK_CONSTANTS = {
    '_ROUTE_GROUPS': ('RTMGRP_LINK', 'RTMGRP_IPV4_IFADDR', 'RTMGRP_IPV4_ROUTE', 'RTMGRP_IPV6_IFADDR',
                      'RTMGRP_IPV6_ROUTE'),
    '_INOTIFY_MASK': ('IN_MODIFY', 'IN_ATTRIB', 'IN_CLOSE_WRITE', 'IN_MOVED_FROM', 'IN_MOVED_TO', 'IN_CREATE',
                      'IN_DELETE', 'IN_DELETE_SELF', 'IN_MOVE_SELF', 'IN_UNMOUNT', 'IN_Q_OVERFLOW', 'IN_IGNORED',
                      'IN_DONT_FOLLOW', 'IN_MASK_CREATE'),
    # Task 18 F4 (P85, P86(b')): the install's AUDIT_SET request mask, the real site of the AUDIT_STATUS_* OR (31).
    '_AUDIT_SET_MASK': ('AUDIT_STATUS_ENABLED', 'AUDIT_STATUS_FAILURE', 'AUDIT_STATUS_PID', 'AUDIT_STATUS_RATE_LIMIT',
                        'AUDIT_STATUS_BACKLOG_LIMIT'),
}
# Task 18 F4 (P86(b')): _AUDIT_SET_CHANGES names one status field per _AUDIT_SET_MASK bit, in bit order; each field's
# AUDIT_STATUS_* bit is 1 << its position (the bit _install_config_bodies tests), the order audit_receive_msg logs them.
AUDIT_SET_CHANGE_FIELDS = (('AUDIT_STATUS_ENABLED', 'audit_enabled'), ('AUDIT_STATUS_FAILURE', 'audit_failure'),
                           ('AUDIT_STATUS_PID', 'audit_pid'), ('AUDIT_STATUS_RATE_LIMIT', 'audit_rate_limit'),
                           ('AUDIT_STATUS_BACKLOG_LIMIT', 'audit_backlog_limit'))
# The fixed audit rule (_fixed_audit_rule): struct.pack arguments 1..3, then the one rule field.
AUDIT_RULE_HEADER = ('AUDIT_FILTER_EXIT', 'AUDIT_ALWAYS')       # flags, action; field_count is the one field below
AUDIT_RULE_FIELD = ('AUDIT_ARCH', 'AUDIT_ARCH_AARCH64', 'AUDIT_EQUAL')  # fields[0], values[0], operators[0]
AUDIT_RULE_ARRAYS = ('AUDIT_BITMASK_SIZE', 'AUDIT_MAX_FIELDS', 'AUDIT_MAX_FIELDS', 'AUDIT_MAX_FIELDS')
AUDIT_STATUS_MASK = ('AUDIT_STATUS_ENABLED', 'AUDIT_STATUS_FAILURE', 'AUDIT_STATUS_PID', 'AUDIT_STATUS_RATE_LIMIT',
                     'AUDIT_STATUS_BACKLOG_LIMIT')
INOTIFY_OVERFLOW_BITS = ('IN_Q_OVERFLOW', 'IN_IGNORED', 'IN_UNMOUNT')
AUDIT_EVENT_FLAGS = ('NLM_F_DUMP_INTR', 'NLM_F_ACK')
# Every id this task binds, all present in both coverage v2 and the event reference.
EVENT_LITERAL_IDS = frozenset(
    AUDIT_RULE_HEADER + AUDIT_RULE_FIELD + AUDIT_RULE_ARRAYS + AUDIT_STATUS_MASK + INOTIFY_OVERFLOW_BITS
    + AUDIT_EVENT_FLAGS + EVENT_MASK_CONSTANTS['_ROUTE_GROUPS'] + EVENT_MASK_CONSTANTS['_INOTIFY_MASK']
    + ('AUDIT_GET', 'AUDIT_LIST_RULES', 'AUDIT_SYSCALL', 'AUDIT_PATH', 'AUDIT_CONFIG_CHANGE', 'AUDIT_SOCKADDR',
       'AUDIT_CWD', 'AUDIT_EXECVE', 'AUDIT_EOE', 'AUDIT_PROCTITLE', 'RTM_NEWLINK', 'RTM_NEWADDR', 'RTM_NEWROUTE',
       'NLM_F_MULTI', 'NLMSG_DONE', 'NLMSG_ERROR'))
# E-1b (P45, task-8b brief): module constants -> symbols, and every comparison in _admit_browser_sandbox in source
# order as (left, operator, comparator). chroot/unshare are unpacked once from _SANDBOX_ADMITTED_SYSCALLS.
SANDBOX_ADMISSION_CONSTANTS = {
    '_SANDBOX_ADMITTED_SYSCALLS': ('__NR_chroot', '__NR_unshare'),
    '_SANDBOX_UNSHARE_FLAGS': ('CLONE_NEWUSER',),
}
SANDBOX_ADMISSION_COMPARES = [
    ('transition', 'IsNot', 'None'),
    ("transition['phase']", 'Eq', "'ACTIVE'"),
    ("syscall['role']", 'Eq', "'BROWSER'"),
    ("syscall['pid']", 'NotEq', "transition['root']"),
    ("syscall['success']", 'Is', 'True'),
    ("syscall['exit']", 'Eq', '0'),
    ("syscall['number']", 'Eq', 'chroot'),
    ("syscall['number']", 'Eq', 'unshare'),
    ("syscall['argument0']", 'Eq', '_SANDBOX_UNSHARE_FLAGS'),
]

# open()/open_owned()/pipe2() calls whose flags argument holds an int constant: (file, qualname, callee, ordinal) -> a
# frozenset of disjoint flag symbols whose OR equals the literal flags exactly, or a tuple naming the int constants
# nested in a non-literal flags expression. The mode argument (POSIX permission bits) is not an ABI flag.
_FLAG_ARG = {'open': 1, 'open_owned': 1, 'pipe2': 0}
OPEN_FLAG_SITES = {
    ('confinement.py', 'LinuxBindings.read_file', 'open', 0): _s('O_CLOEXEC', 'O_NOFOLLOW'),
    ('confinement.py', 'LinuxBindings.pin_programs', 'open', 0): _s('O_CLOEXEC', 'O_NOFOLLOW'),
    ('confinement.py', 'LinuxBindings.pin_sample', 'open', 0): _s('O_CLOEXEC', 'O_NOFOLLOW'),
    ('confinement.py', 'NativeChildPort.establish_views', 'open', 0): _s('O_CREAT', 'O_EXCL', 'O_CLOEXEC', 'O_NOFOLLOW'),
    ('confinement.py', '_KernelPortCore.spawn_waiting', 'pipe2', 0): _s('O_CLOEXEC'),
    ('confinement.py', '_KernelPortCore.spawn_waiting', 'open', 0): _s('O_RDWR', 'O_CLOEXEC', 'O_NOFOLLOW'),
    ('topology.py', 'NativeTopologyBindings._read', 'open_owned', 0): ('OPTIONAL_CLOEXEC_ABSENT',),
    # Task 10 (T8-12): the console probes open each node for writing as well as for reading.
    (PROBE_FILE, 'NativeProbeContext.open_denied', 'open', 0): _s('O_WRONLY', 'O_NOFOLLOW', 'O_CLOEXEC'),
    (PROBE_FILE, 'NativeProbeContext.open_denied', 'open', 1): _s('O_NOFOLLOW', 'O_CLOEXEC'),
    # P52: the console reopen follows the /proc magic link, so these two carry no O_NOFOLLOW.
    (PROBE_FILE, 'NativeProbeContext.open_following', 'open', 0): _s('O_WRONLY', 'O_CLOEXEC'),
    (PROBE_FILE, 'NativeProbeContext.open_following', 'open', 1): _s('O_CLOEXEC'),
    (PROBE_FILE, 'NativeProbeContext._helper', 'pipe2', 0): _s('O_CLOEXEC'),
    (PROBE_FILE, 'NativeProbeContext._helper', 'pipe2', 1): _s('O_CLOEXEC'),
}

# AF_VSOCK host CID literals: (file, qualname) -> count. A CID literal is the element right before the policy service
# port in a tuple, list or call, the value paired with a 'hostCID'/'hostCid' key, or the value bound to _HOST_CID.
VSOCK_CID_SITES = {
    ('proxy.py', '<module>'): 1,
    ('proxy.py', 'ProxyRuntimeOwner._check'): 1,
    ('proxy.py', '_observation_record'): 1,
    ('proxy.py', 'NativeVsockTransport.__init__'): 1,
    ('proxy.py', 'NativeVsockTransport.open'): 2,
    ('proxy.py', '_inherited_entry'): 1,
    ('topology.py', '_payload'): 1,
    ('topology.py', '_validate_payload'): 1,
    ('topology.py', 'Task9RuntimeObserver.observeAccepted'): 1,
}

# Attested seccomp mode comparisons (/proc/<pid>/status "Seccomp:"): (file, qualname) -> count.
SECCOMP_MODE_SITES = {
    ('confinement.py', '_check'): 1,
    # Task 16c (P14): each BROWSER family member's status row Seccomp must be exactly SECCOMP_MODE_FILTER.
    ('confinement.py', '_family_member_status'): 1,
    ('topology.py', '_role'): 1,
    ('topology.py', '_validate_payload'): 1,
}

# Interface-name length bounds _ascii(name, IFNAMSIZ - 1) (IFNAMSIZ counts the terminating NUL): qualname -> count.
IFNAME_BOUND_SITES = {'_interfaces': 1, '_routes4': 1, '_routes6': 1}

# Task 4 (T10-2, Option A R17 C4): Linux ABI values in topology.py's procfs parsers, each bound once at module level
# (constant name -> coverage id, or the R13_LITERALS name TCP_LISTEN, ruling P34). The kernel-default IPv6 row flags
# and the TCP state comparisons use these names only.
TOPOLOGY_ABI_CONSTANTS = {
    '_RTF_UP': 'RTF_UP', '_RTF_GATEWAY': 'RTF_GATEWAY', '_RTF_REJECT': 'RTF_REJECT',
    '_RTF_NONEXTHOP': 'RTF_NONEXTHOP', '_RTF_LOCAL': 'RTF_LOCAL',
    '_TCP_ESTABLISHED': 'TCP_ESTABLISHED', '_TCP_LISTEN': 'TCP_LISTEN',
}
# _KERNEL_DEFAULT_IPV6_ROWS, in order (fib6 null entry, ::1/128 local route): the flag constants whose OR is the
# printed flags column (field index 7 of each shape).
KERNEL_IPV6_ROW_FLAGS = (('_RTF_NONEXTHOP', '_RTF_REJECT'), ('_RTF_LOCAL', '_RTF_NONEXTHOP', '_RTF_UP'))
KERNEL_IPV6_FLAGS_FIELD = 7

# Task 10 (Option A I1): the errno, signal and ancillary values tests/guest/confinement_probe.py compares or raises,
# each bound once at module level: constant name -> coverage v2 id.
PROBE_ABI_CONSTANTS = {
    '_EPERM': 'EPERM', '_ENOENT': 'ENOENT', '_ENOEXEC': 'ENOEXEC', '_EACCES': 'EACCES', '_ENOTSOCK': 'ENOTSOCK',
    '_ECONNREFUSED': 'ECONNREFUSED', '_SIGSYS': 'SIGSYS', '_SOL_SOCKET': 'SOL_SOCKET', '_SCM_RIGHTS': 'SCM_RIGHTS',
}
# The accepted denial errno sets, in order; none holds EBADF (T8-01). _denial_errnos returns exactly these, in order.
PROBE_DENIAL_SETS = {
    '_KERNEL_DENIAL': ('_EPERM', '_EACCES'),
    '_CREDENTIAL_DENIAL': ('_EPERM',),
    '_ABSENT_OR_DENIED': ('_EPERM', '_EACCES', '_ENOENT'),
    '_UNIX_REFUSED': ('_EPERM', '_EACCES', '_ENOENT', '_ECONNREFUSED'),
    # P52: exactly the 6.8 refusals of a /proc fd magic link to a non-owner or an invisible pid; never EPERM or ELOOP.
    '_PROC_FD_REFUSED': ('_EACCES', '_ENOENT'),
}
PROBE_DENIAL_RETURNS = ('_CREDENTIAL_DENIAL', '_PROC_FD_REFUSED', '_ABSENT_OR_DENIED', '_UNIX_REFUSED',
                        '_KERNEL_DENIAL')
# Every comparison in the probe whose left operand is an errno, the helper's exit code or signal, or a control
# message's (level, kind): qualname -> [(left, operator, comparator)] in source order. Exit codes 0, 23 and 24 are this
# module's own child protocol; the only signal is SIGSYS (T8-02).
PROBE_ABI_COMPARES = {
    'NativeProbePort._denial': [('error.errno', 'NotIn', '_denial_errnos(name)')],
    'NativeProbeContext.receive_rights': [('(level, kind)', 'NotEq', '(_SOL_SOCKET, _SCM_RIGHTS)')],
    'NativeProbeContext.inherited_endpoint_not_socket': [('error.errno', 'NotEq', '_ENOTSOCK')],
    'NativeProbeContext._helper': [('error.errno', 'Eq', '_EPERM'), ('error.errno', 'Eq', '_ENOEXEC'),
                                   ('code', 'Eq', '24'), ('-code', 'NotEq', '_SIGSYS'), ('code', 'Eq', '23'),
                                   ('code', 'NotEq', '0')],
}
# Every errno the probe raises itself: (qualname, exception, errno argument, text) in source order.
PROBE_ERRNO_RAISES = (
    ('NativeProbePort._operation', 'PermissionError', '_EPERM', 'FD_INVENTORY_BOUNDARY'),
    ('NativeProbePort._operation', 'PermissionError', '_EPERM', 'FD_INVENTORY_BOUNDARY'),
    ('NativeProbeContext.family_only_processes', 'PermissionError', '_EPERM', 'FAMILY_ONLY'),
    ('NativeProbeContext._helper', '_HelperBoundaryDenied', '_ENOEXEC', 'AARCH32_EXEC_UNAVAILABLE'),
    ('NativeProbeContext._helper', '_HelperBoundaryDenied', '_EPERM', 'SECCOMP_ARCH_KILL'),
    ('NativeProbeContext._helper', '_HelperBoundaryDenied', '_EPERM', 'SECCOMP_KILL'),
    ('NativeProbeContext._helper', '_HelperBoundaryDenied', '_EPERM', 'HELPER_EXIT'),
    ('NativeProbeContext.bootstrap_rejection', 'PermissionError', '_EPERM', 'BOOTSTRAP_BOUNDARY_DENIED'),
)
# R13 layout literals of the probe (Task 10): module constant -> (literal, bytes for a struct format or None for an
# offset or size, one-line justification citing the pinned archive). The deriver refuses pointer-bearing structs, so
# these stay known uncovered surface, accepted by review; derived facts are checked in test_layout_literals_are_justified.
LAYOUT_LITERALS = {
    '_IOVEC': ('<QQ', 16, 'linux-6.8/include/uapi/linux/uio.h:17-21 struct iovec {void __user *iov_base; '
                          '__kernel_size_t iov_len;}: two LP64 8-byte words'),
    '_USER_MSGHDR': ('<Qi4xQQQQI4x', 56, 'linux-6.8/include/linux/socket.h:82-90 struct user_msghdr: msg_name pointer, '
                                         'int msg_namelen and 4 padding bytes, msg_iov pointer, size_t msg_iovlen, '
                                         'msg_control pointer, size_t msg_controllen, unsigned int msg_flags and 4 '
                                         'tail padding bytes (LP64 alignment 8)'),
    '_CMSGHDR': ('<Qii', 16, 'linux-6.8/include/linux/socket.h:104-108 struct cmsghdr {__kernel_size_t cmsg_len; '
                             'int cmsg_level; int cmsg_type;}'),
    '_SCM_FD': ('<i', 4, 'linux-6.8/include/linux/socket.h:177 SCM_RIGHTS carries an array of int descriptors'),
    '_SOCKADDR_UN': ('<H108s', 110, 'linux-6.8/include/uapi/linux/un.h:7-12 UNIX_PATH_MAX 108; struct sockaddr_un '
                                    '{__kernel_sa_family_t sun_family; char sun_path[UNIX_PATH_MAX];}, the family an '
                                    'unsigned short (include/uapi/linux/socket.h:10)'),
    '_SOCKADDR_VM': ('<HHIIB3x', 16, 'linux-6.8/include/uapi/linux/vm_sockets.h:178-190 struct sockaddr_vm: '
                                     'svm_family, svm_reserved1, svm_port, svm_cid, svm_flags, then zero padding to '
                                     'sizeof(struct sockaddr) 16'),
    '_SOCKADDR_IN': ('<H2s4s8x', 16, 'linux-6.8/include/uapi/linux/in.h:255-264 struct sockaddr_in: host-order '
                                     'sin_family, __be16 sin_port as two network-order bytes, struct in_addr (:92-94), '
                                     'zero pad to __SOCK_SIZE__ 16'),
    '_SOCKADDR_IN6': ('<H2sI16sI', 28, 'linux-6.8/include/uapi/linux/in6.h:50-56 struct sockaddr_in6: sin6_family, '
                                       '__be16 sin6_port as two network-order bytes, __be32 sin6_flowinfo (zero), '
                                       'struct in6_addr of 16 bytes (:33-40), __u32 sin6_scope_id (zero)'),
    '_CAPSET_HEADER': ('<II', 8, 'linux-6.8/include/uapi/linux/capability.h:39-42 struct __user_cap_header_struct '
                                 '{__u32 version; int pid;}'),
    '_CAPSET_DATA': ('<6I', 24, 'linux-6.8/include/uapi/linux/capability.h:44-48 struct __user_cap_data_struct {__u32 '
                                'effective, permitted, inheritable;} times _LINUX_CAPABILITY_U32S_3 (2, :37)'),
    '_MSG_IOV': (16, None, 'linux-6.8/include/linux/socket.h:85 offsetof(struct user_msghdr, msg_iov): after the '
                           '8-byte msg_name and the 4-byte msg_namelen padded to 8'),
    '_MSG_CONTROL': (32, None, 'linux-6.8/include/linux/socket.h:87 offsetof(struct user_msghdr, msg_control): after '
                               'msg_iov and the 8-byte msg_iovlen'),
    '_CMSG_ONE_FD': (24, None, 'linux-6.8/include/linux/socket.h:118,124 CMSG_SPACE(sizeof(int)): sizeof(struct '
                               'cmsghdr) + CMSG_ALIGN(4), CMSG_ALIGN rounding up to sizeof(long) 8'),
    '_SUN_PATH_OFFSET': (2, None, 'linux-6.8/include/uapi/linux/un.h:10 offsetof(struct sockaddr_un, sun_path): after '
                                  'the 2-byte sun_family'),
    '_SUN_PATH_BYTES': (108, None, 'linux-6.8/include/uapi/linux/un.h:7 UNIX_PATH_MAX 108, the size of sun_path'),
}
# Struct formats of the probe that are its own protocol, not Linux ABI.
PROTOCOL_LITERALS = {
    '_FRAME_LENGTH': ('<I', 4, "the probe's own little-endian length prefix of its child-result and helper-target "
                               'frames, not Linux ABI'),
}
# Every struct.* call in the probe: (qualname, ordinal among struct calls there) -> (format constant, {argument index
# after the format: name}) for each argument that is an int literal. Names resolve through coverage v2,
# POLICY_LITERALS or PROBE_POLICY_LITERALS; non-literal arguments carry values computed at run time.
PROBE_PACK_VALUES = {
    ('_sockaddr_vm', 0): ('_SOCKADDR_VM', {0: 'AF_VSOCK', 1: 'SVM_RESERVED', 2: 'VSOCK_SERVICE_PORT',
                                           3: 'VMADDR_CID_HOST', 4: 'NO_FLAGS'}),
    ('_unix_address', 0): ('_SOCKADDR_UN', {0: 'AF_UNIX'}),
    ('ReceiverBinding.address_bytes', 0): ('_SOCKADDR_IN', {0: 'AF_INET'}),
    ('ReceiverBinding.address_bytes', 1): ('_SOCKADDR_IN6', {0: 'AF_INET6', 2: 'NO_FLOW_LABEL', 4: 'NO_SCOPE'}),
    ('NativeProbePort._operation', 0): ('_CAPSET_HEADER', {0: '_LINUX_CAPABILITY_VERSION_3', 1: 'CAPSET_HEADER_PID'}),
    ('NativeProbePort._operation', 1): ('_CAPSET_DATA', {0: 'CAP_BIT0', 1: 'CAP_BIT0', 2: 'NO_CAPABILITIES',
                                                         3: 'NO_CAPABILITIES', 4: 'NO_CAPABILITIES',
                                                         5: 'NO_CAPABILITIES'}),
    ('NativeProbeContext.cross_memory', 0): ('_IOVEC', {0: 'POINTER_SLOT', 1: 'IOV_BYTES'}),
    ('NativeProbeContext.cross_memory', 1): ('_IOVEC', {0: 'REMOTE_IOV_BASE', 1: 'IOV_BYTES'}),
    ('NativeProbeContext.receive_rights', 0): ('_IOVEC', {0: 'POINTER_SLOT', 1: 'ONE_BYTE'}),
    ('NativeProbeContext.receive_rights', 1): ('_USER_MSGHDR', {0: 'NULL_POINTER', 1: 'ZERO_ARG', 2: 'POINTER_SLOT',
                                                                3: 'ONE_IOVEC', 4: 'POINTER_SLOT', 6: 'NO_FLAGS'}),
    ('NativeProbeContext.receive_rights', 2): ('_USER_MSGHDR', {}),
    ('NativeProbeContext.receive_rights', 3): ('_CMSGHDR', {}),
    ('NativeProbeContext.receive_rights', 4): ('_CMSGHDR', {1: 'ZERO_OFFSET'}),
    ('NativeProbeContext.receive_rights', 5): ('_SCM_FD', {}),
    ('NativeProbeContext.receive_rights', 6): ('_SCM_FD', {}),
    ('NativeProbeContext._helper', 0): ('_FRAME_LENGTH', {}),
    ('_ProbeFixturesCore.run_confined.child', 0): ('_FRAME_LENGTH', {}),
    ('_ProbeFixturesCore.run_confined.child', 1): ('_FRAME_LENGTH', {}),
    ('_ProbeFixturesCore.run_confined.child', 2): ('_FRAME_LENGTH', {}),
    ('_ProbeFixturesCore.run_confined', 0): ('_FRAME_LENGTH', {}),
}


def _coverage():
    data = json.loads(COVERAGE_V2.read_bytes())
    return data, {r['id']: r['value'] for r in data['records']}


def _scoped_nodes(tree):
    """[(qualname, node)] for every node; qualname is the innermost enclosing class/function path, '<module>' at top."""
    out = []

    def visit(node, stack):
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            stack = stack + [node.name]
        out.append(('.'.join(stack) or '<module>', node))
        for child in ast.iter_child_nodes(node):
            visit(child, stack)
    visit(tree, [])
    return out


def _source_order(nodes):
    return sorted(nodes, key=lambda n: (n.lineno, n.col_offset))


def _int_constants(node):
    """Every int constant in NODE's subtree, in source order."""
    return [n.value for n in _source_order(n for n in ast.walk(node)
                                           if isinstance(n, ast.Constant) and type(n.value) is int)]


def _eval_int(node):
    """Int literal, negated int literal, or OR of those, else None (R15: unary minus is folded, never skipped)."""
    if isinstance(node, ast.Constant) and type(node.value) is int:
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        value = _eval_int(node.operand)
        return None if value is None else -value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        left, right = _eval_int(node.left), _eval_int(node.right)
        return None if left is None or right is None else left | right
    return None


def _syscall_calls(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            name = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else None
            if name == 'syscall':
                yield node


def _function(tree, name):
    return next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name)


class CodeBindingTests(unittest.TestCase):
    """Binds the Linux ABI literals of the guest Python modules (confinement.py, proxy.py, storage.py, topology.py;
    intake.py and protocol.py carry none) and of the guest probe catalogue tests/guest/confinement_probe.py (Task 10)
    to the committed coverage v2, or to an explicit POLICY_LITERALS (probe: PROBE_POLICY_LITERALS) entry.
    bootstrap_reference_test checks the committed event reference JSON against the Linux headers. Task 11 binds the
    event-constant literals of guest/topology.py here (test_topology_event_literals_match_named_symbols: every audit
    rule word, _ROUTE_GROUPS, _INOTIFY_MASK, the route, audit and netlink kinds and flags, the status mask, the
    overflow bits and the 'c00000b7' arch text), and CoverageTests checks every id shared with the event reference
    has the same value. Syscall numbers are bound here (ruling R14).

    Known uncovered ABI surface (ruling R13), deliberately NOT derived here: the capset structs (only divisibility of
    bytearray(24) by _LINUX_CAPABILITY_U32S_3 is checked; the 12-byte element size is not derivable), struct
    sock_fprog, the struct layouts of tests/guest/confinement_probe.py (iovec, user_msghdr, cmsghdr, sockaddr_un,
    sockaddr_vm, sockaddr_in, sockaddr_in6 and the capset header and data: recorded with a justification each in
    LAYOUT_LITERALS, Task 10), the LP64 data model (sizeof long/pointer, 64-bit syscall registers),
    socket_state SS_* values (implicit enumerators; TCP_LISTEN and RTM_DELLINK/RTM_DELADDR/RTM_DELROUTE likewise,
    bound only through R13_LITERALS, ruling P34; NLMSG_HDRLEN, a sizeof, likewise, ruling P62),
    and kernel text formats and behaviour (procfs field positions and number bases, the audit record text, inotify
    watch descriptor numbering, syscall success return values).
    """

    @classmethod
    def setUpClass(cls):
        cls.cov, cls.V = _coverage()
        V = cls.V
        cls.nr_by_value = {v: k for k, v in V.items() if k.startswith('__NR_')}
        assert len(cls.nr_by_value) == sum(1 for k in V if k.startswith('__NR_'))
        cls.trees = {name: ast.parse((GUEST / name).read_text()) for name in ('confinement.py', 'topology.py')}
        cls.trees[PROBE_FILE] = ast.parse(PROBE_PATH.read_text())
        cls.scoped = {name: _scoped_nodes(ast.parse((GUEST / name).read_text())) for name in GUEST_MODULES}
        cls.scoped[PROBE_FILE] = _scoped_nodes(cls.trees[PROBE_FILE])
        decl = next(r['declaration'] for r in cls.cov['records'] if r['id'] == 'seccomp_data.args')
        cls.args_count = int(re.search(r'args\[(\d+)\]', decl).group(1))
        cls.stride = (V['seccomp_data.sizeof'] - V['seccomp_data.args']) // cls.args_count
        cls.word = V['seccomp_data.arch'] - V['seccomp_data.nr']
        cls.op_ld = V['BPF_LD'] | V['BPF_W'] | V['BPF_ABS']
        cls.op_ret = V['BPF_RET'] | V['BPF_K']
        cls.op_jeq = V['BPF_JMP'] | V['BPF_JEQ'] | V['BPF_K']
        cls.op_and = V['BPF_ALU'] | V['BPF_AND'] | V['BPF_K']
        cls.sock_mask = ~(V['SOCK_CLOEXEC'] | V['SOCK_NONBLOCK']) & 0xffffffff
        cls.rets = {V['SECCOMP_RET_KILL_PROCESS'], V['SECCOMP_RET_ALLOW'], V['SECCOMP_RET_ERRNO'] | V['EPERM']}
        cls.offsets = {V['seccomp_data.nr'], V['seccomp_data.arch']}
        for i in range(cls.args_count):
            for w in (0, cls.word):
                cls.offsets.add(V['seccomp_data.args'] + i * cls.stride + w)

    def values(self, symbols):
        return {self.V[s] for s in symbols}

    def resolve(self, name):
        """Value of a POLICY_LITERALS, R13_LITERALS or coverage v2 name; a name missing from all three fails."""
        if name in POLICY_LITERALS:
            return POLICY_LITERALS[name][0]
        if name in R13_LITERALS:
            return R13_LITERALS[name][0]
        self.assertTrue(name in self.V, f'{name}: symbol absent from coverage v2')
        return self.V[name]

    def covered(self, name):
        """The coverage v2 value of NAME, which must be a coverage symbol (never a policy or R13 name)."""
        self.assertIn(name, self.V, f'{name}: symbol absent from coverage v2')
        return self.V[name]

    def resolve_at(self, key, name):
        """resolve(NAME), or a PROBE_POLICY_LITERALS value, which only a PROBE_FILE site may name."""
        if name in PROBE_POLICY_LITERALS:
            self.assertEqual(key[0], PROBE_FILE, (key, name, 'probe policy literal outside the probe'))
            return PROBE_POLICY_LITERALS[name][0]
        return self.resolve(name)

    def policy_at(self, key, name):
        """A POLICY_LITERALS value, or at a PROBE_FILE site a PROBE_POLICY_LITERALS value; nothing else."""
        if name in POLICY_LITERALS:
            return POLICY_LITERALS[name][0]
        self.assertIn(name, PROBE_POLICY_LITERALS, (key, name))
        return self.resolve_at(key, name)

    def nodes(self, fname, qual, kind):
        """Nodes of type KIND whose innermost enclosing qualname in FNAME is QUAL, in source order."""
        return _source_order(n for q, n in self.scoped[fname] if q == qual and isinstance(n, kind))

    def compares(self, fname, qual, lefts):
        """[(operator, comparator)] in source order for every Compare in QUAL whose left operand unparses to one of
        LEFTS. comparator is the folded tuple of ints, or None when it is not an int literal or tuple of them."""
        out = []
        for node in self.nodes(fname, qual, ast.Compare):
            if ast.unparse(node.left) not in lefts:
                continue
            self.assertEqual(len(node.ops), 1, (fname, qual, ast.unparse(node)))
            comparator = node.comparators[0]
            elements = comparator.elts if isinstance(comparator, ast.Tuple) else [comparator]
            folded = tuple(_eval_int(e) for e in elements)
            out.append((type(node.ops[0]).__name__, None if None in folded else folded))
        return out

    # --- layout-derived facts -------------------------------------------------------------------------------------
    def test_seccomp_data_layout_derivations(self):
        V = self.V
        self.assertEqual(self.args_count, 6)
        self.assertEqual((V['seccomp_data.sizeof'] - V['seccomp_data.args']) % self.args_count, 0)
        self.assertEqual(self.stride, 8)
        self.assertEqual(self.stride, 2 * self.word)
        # confinement.py: len(args)>6 in NativeBindings.syscall
        counts = [c.comparators[0].value for c in ast.walk(self.trees['confinement.py']) if isinstance(c, ast.Compare)
                  and isinstance(c.left, ast.Call) and isinstance(c.left.func, ast.Name) and c.left.func.id == 'len'
                  and isinstance(c.left.args[0], ast.Name) and c.left.args[0].id == 'args'
                  and isinstance(c.ops[0], ast.Gt)]
        self.assertEqual(counts, [self.args_count])

    def test_sock_filter_layout_matches_pack_format_and_jump_bounds(self):
        V = self.V
        code_sz, jt_sz = V['sock_filter.jt'] - V['sock_filter.code'], V['sock_filter.jf'] - V['sock_filter.jt']
        jf_sz, k_sz = V['sock_filter.k'] - V['sock_filter.jf'], V['sock_filter.sizeof'] - V['sock_filter.k']
        self.assertEqual((code_sz, jt_sz, jf_sz, k_sz), (2, 1, 1, 4))
        # filter_bytes packs '<HBBI' (u16 code, u8 jt, u8 jf, u32 k); prove it lands fields at the covered offsets.
        raw = confinement.filter_bytes(((0xAAAA, 0xBB, 0xCC, 0xDDEEFF11),))
        self.assertEqual(len(raw), V['sock_filter.sizeof'])
        self.assertEqual(int.from_bytes(raw[V['sock_filter.code']:V['sock_filter.jt']], 'little'), 0xAAAA)
        self.assertEqual(raw[V['sock_filter.jt']], 0xBB)
        self.assertEqual(raw[V['sock_filter.jf']], 0xCC)
        self.assertEqual(int.from_bytes(raw[V['sock_filter.k']:], 'little'), 0xDDEEFF11)
        # the 0 <= jt <= 255 check in build_filter: 255 is the u8 maximum derived from the jt/jf field width.
        fn = _function(self.trees['confinement.py'], 'build_filter')
        bounds = [n for n in ast.walk(fn) if isinstance(n, ast.Compare) and len(n.ops) == 2]
        self.assertEqual(len(bounds), 2)
        for n in bounds:
            lo, hi = n.left.value, n.comparators[1].value
            self.assertEqual(lo, POLICY_LITERALS['LOWER_BOUND_ZERO'][0])
            self.assertEqual(hi, 2 ** (8 * jt_sz) - 1)
            self.assertEqual(hi, 2 ** (8 * jf_sz) - 1)
        for ins in confinement.build_filter('PROXY'):
            self.assertLessEqual(ins[1], 2 ** (8 * jt_sz) - 1)
            self.assertLessEqual(ins[2], 2 ** (8 * jf_sz) - 1)

    def test_program_length_bounds_use_bpf_maxinsns(self):
        tree = self.trees['confinement.py']
        for fname in ('build_filter', 'install_seccomp'):
            ints = [c.value for n in ast.walk(_function(tree, fname)) if isinstance(n, ast.Compare)
                    for c in [n.left] + n.comparators if isinstance(c, ast.Constant) and type(c.value) is int]
            big = [v for v in ints if v > 255]
            self.assertEqual(big, [self.V['BPF_MAXINSNS']], fname)
        install = _function(tree, 'install_seccomp')
        flag_cmp = [n.comparators[0].value for n in ast.walk(install) if isinstance(n, ast.Compare)
                    and isinstance(n.left, ast.Name) and n.left.id == 'flags']
        self.assertEqual(flag_cmp, [self.V['SECCOMP_FILTER_FLAG_TSYNC']])
        self.assertEqual(self.V['BPF_MAXINSNS'], 4096)

    # --- build_filter ---------------------------------------------------------------------------------------------
    def programs(self):
        self.assertEqual(set(confinement.UIDS), {'CONTROLLER', 'BROWSER', 'VERIFIER', 'PROXY'})
        return {role: confinement.build_filter(role) for role in confinement.UIDS}

    def test_filter_opcodes_and_returns_are_covered(self):
        ops = {self.op_ld, self.op_ret, self.op_jeq, self.op_and}
        for role, program in self.programs().items():
            for i, (code, jt, jf, k) in enumerate(program):
                self.assertIn(code, ops, (role, i))
                if code == self.op_ret:
                    self.assertIn(k, self.rets, (role, i))
                    self.assertEqual((jt, jf), (0, 0))
                if code in (self.op_ld, self.op_and):
                    self.assertEqual((jt, jf), (0, 0))
            self.assertEqual(program[-1][0], self.op_ret)

    def walk(self, program):
        """Yield (index, instruction, loaded_offset, masked)."""
        offset, masked = None, False
        for i, ins in enumerate(program):
            yield i, ins, offset, masked
            if ins[0] == self.op_ld:
                offset, masked = ins[3], False
            elif ins[0] == self.op_and:
                masked = True

    def test_filter_comparisons_are_covered_per_loaded_field(self):
        V = self.V
        nr_values = set(self.nr_by_value)
        zero, high_zero = POLICY_LITERALS['NR_MASKED_CLEAN'][0], POLICY_LITERALS['HIGH_WORD_ZERO'][0]
        arg_low = {}
        for i in range(self.args_count):
            arg_low[V['seccomp_data.args'] + i * self.stride] = i
        arg_high = {V['seccomp_data.args'] + i * self.stride + self.word for i in range(self.args_count)}
        for role, program in self.programs().items():
            for i, (code, jt, jf, k), offset, masked in self.walk(program):
                where = (role, i)
                if code == self.op_ld:
                    self.assertIn(k, self.offsets, where)
                elif code == self.op_and:
                    if offset == V['seccomp_data.nr']:
                        self.assertEqual(k, POLICY_LITERALS['NR_HIGH_BITS_MASK'][0], where)
                    else:
                        self.assertIn(offset, arg_low, where)
                        self.assertEqual(k, self.sock_mask, where)
                elif code == self.op_jeq:
                    if offset == V['seccomp_data.arch']:
                        self.assertEqual(k, V['AUDIT_ARCH_AARCH64'], where)
                    elif offset == V['seccomp_data.nr'] and masked:
                        self.assertEqual(k, zero, where)
                    elif offset == V['seccomp_data.nr']:
                        self.assertIn(k, nr_values, where)
                    elif offset in arg_high:
                        self.assertEqual(k, high_zero, where)
                    else:
                        self.assertIn(offset, arg_low, where)
                        self.assertIn(k, self.arg_allowed(program, i, arg_low[offset], masked), where)

    def reach(self, program, start):
        seen, todo = set(), [start]
        while todo:
            i = todo.pop()
            if i in seen:
                continue
            seen.add(i)
            code, jt, jf, _ = program[i]
            if code == self.op_ret:
                continue
            todo.extend([i + 1 + jt, i + 1 + jf] if code == self.op_jeq else [i + 1])
        return seen

    def arg_allowed(self, program, index, arg_index, masked):
        """Values a comparison on args[arg_index] may take: ARG_SYMBOLS of every syscall whose filter branch reaches it,
        each named ARG_COMBINATIONS OR for that syscall argument, plus the named flag/protocol/NNP policy scalars.
        (Secondary check; the exact program comparison is authoritative.)"""
        allowed = {POLICY_LITERALS[n][0] for n in ('PROTOCOL_DEFAULT', 'SECCOMP_NO_FLAGS', 'NNP_ENABLE')}
        owners = 0
        for j, (code, jt, jf, k), offset, m in self.walk(program):
            if code == self.op_jeq and offset == self.V['seccomp_data.nr'] and not m and jt and j + 1 + jt != len(program) - 1:
                if index in self.reach(program, j + 1 + jt):
                    owners += 1
                    sym = self.nr_by_value[k]
                    allowed |= self.values(ARG_SYMBOLS.get(sym, {}).get(arg_index, ()))
                    for names in ARG_COMBINATIONS.get(sym, {}).get(arg_index, ()):
                        self.assertLessEqual(names, ARG_SYMBOLS[sym][arg_index], (sym, arg_index))
                        combined = 0
                        for value in self.values(names):
                            combined |= value
                        allowed.add(combined)
        self.assertGreater(owners, 0, ('compare unreachable from any syscall branch', index))
        return allowed

    def expected_program(self, role):
        """Symbolic classic-BPF program for ROLE, resolved only from coverage values and named policy literals,
        assembled independently of guest/confinement.py."""
        V, P = self.V, {k: v for k, (v, _) in POLICY_LITERALS.items()}
        NR, ARCH = V['seccomp_data.nr'], V['seccomp_data.arch']
        lo = lambda i: V['seccomp_data.args'] + i * self.stride
        hi = lambda i: lo(i) + self.word
        nrv = lambda name: V['__NR_' + name]
        ALLOW, KILL, ERR = V['SECCOMP_RET_ALLOW'], V['SECCOMP_RET_KILL_PROCESS'], V['SECCOMP_RET_ERRNO'] | V['EPERM']
        code, labels, jumps = [], {}, []
        ld = lambda off: code.append((self.op_ld, 0, 0, off))
        ret = lambda k: code.append((self.op_ret, 0, 0, k))
        mask = lambda k: code.append((self.op_and, 0, 0, k))
        lab = lambda n: labels.__setitem__(n, len(code))

        def eq(k, yes=None, no=None):
            jumps.append((len(code), yes, no))
            code.append((self.op_jeq, 0, 0, k))
        req = lambda k: eq(k, no='deny')
        ld(ARCH); eq(V['AUDIT_ARCH_AARCH64'], yes='native'); ret(KILL)
        lab('native'); ld(NR); mask(P['NR_HIGH_BITS_MASK']); eq(P['NR_MASKED_CLEAN'], yes='syscall'); ret(KILL)
        lab('syscall'); ld(NR)
        for sym in DENY_SYMBOLS_BY_ROLE[role]:
            eq(V[sym], yes='deny')
        eq(nrv('socket'), yes='socket'); eq(nrv('socketpair'), yes='socket'); eq(nrv('prctl'), yes='prctl')
        eq(nrv('seccomp'), yes='seccomp'); ret(ALLOW)
        lab('prctl'); ld(hi(0)); req(P['HIGH_WORD_ZERO']); ld(lo(0))
        for name in ('PR_SET_KEEPCAPS', 'PR_SET_SECUREBITS'):
            eq(V[name], yes='deny')
        eq(V['PR_SET_NO_NEW_PRIVS'], yes='nnp'); eq(V['PR_SET_DUMPABLE'], yes='dumpable')
        eq(V['PR_CAP_AMBIENT'], yes='ambient'); eq(V['PR_SET_SECCOMP'], yes='inner'); ret(ALLOW)
        lab('nnp'); ld(hi(1)); req(P['HIGH_WORD_ZERO']); ld(lo(1)); req(P['NNP_ENABLE']); ret(ALLOW)
        lab('dumpable'); ld(hi(1)); req(P['HIGH_WORD_ZERO']); ld(lo(1)); req(V['SUID_DUMP_DISABLE']); ret(ALLOW)
        lab('ambient'); ld(hi(1)); req(P['HIGH_WORD_ZERO']); ld(lo(1)); eq(V['PR_CAP_AMBIENT_RAISE'], yes='deny'); ret(ALLOW)
        lab('inner'); ld(hi(1)); req(P['HIGH_WORD_ZERO']); ld(lo(1)); req(V['SECCOMP_MODE_FILTER']); ret(ALLOW)
        lab('seccomp'); ld(hi(0)); req(P['HIGH_WORD_ZERO']); ld(lo(0)); req(V['SECCOMP_SET_MODE_FILTER'])
        ld(hi(1)); req(P['HIGH_WORD_ZERO']); ld(lo(1))
        for names in SECCOMP_FLAG_NAMES_BY_ROLE[role]:
            flags = 0
            for name in names:
                flags |= self.resolve(name)
            eq(flags, yes='allow')
        ret(ERR)
        lab('socket')
        for i in range(3):
            ld(hi(i)); req(P['HIGH_WORD_ZERO'])
        ld(lo(0)); eq(V['AF_UNIX'], yes='unix'); eq(V['AF_INET'], yes='ip'); eq(V['AF_INET6'], yes='ip')
        if role == 'PROXY':
            eq(V['AF_VSOCK'], yes='vsock')
        ret(ERR)
        lab('unix'); ld(lo(2)); req(P['PROTOCOL_DEFAULT']); ld(lo(1)); mask(self.sock_mask)
        for name in ('SOCK_STREAM', 'SOCK_DGRAM', 'SOCK_SEQPACKET'):
            eq(V[name], yes='allow')
        ret(ERR)
        # Task 8c (C6, owner decision 2026-11-20): BROWSER alone may also name IPPROTO_TCP, and only for SOCK_STREAM.
        lab('ip'); ld(lo(2))
        if role == 'BROWSER':
            eq(V['IPPROTO_TCP'], yes='ip-tcp')
        req(P['PROTOCOL_DEFAULT']); ld(lo(1)); mask(self.sock_mask)
        eq(V['SOCK_STREAM'], yes='allow'); eq(V['SOCK_DGRAM'], yes='allow'); ret(ERR)
        if role == 'BROWSER':
            lab('ip-tcp'); ld(lo(1)); mask(self.sock_mask); eq(V['SOCK_STREAM'], yes='allow'); ret(ERR)
        if role == 'PROXY':
            lab('vsock'); ld(NR); req(nrv('socket')); ld(lo(1)); mask(self.sock_mask); req(V['SOCK_STREAM'])
            ld(lo(2)); req(P['PROTOCOL_DEFAULT'])
        lab('allow'); ret(ALLOW)
        lab('deny'); ret(ERR)
        for index, yes, no in jumps:
            ins = code[index]
            jt = labels[yes] - index + P['BPF_JUMP_BASE'] if yes is not None else 0
            jf = labels[no] - index + P['BPF_JUMP_BASE'] if no is not None else 0
            code[index] = (ins[0], jt, jf, ins[3])
        return tuple(code)

    def test_filter_equals_symbolic_expected_program_per_role(self):
        for role, program in self.programs().items():
            expected = self.expected_program(role)
            self.assertEqual(len(program), len(expected), role)
            for i, (got, want) in enumerate(zip(program, expected)):
                self.assertEqual(got, want, (role, i))

    def test_filter_deny_list_matches_named_syscalls(self):
        """24 named symbols for CONTROLLER, VERIFIER and PROXY; for BROWSER the 13 left after exactly the eleven C6
        sandbox symbols are removed, in base order. The program's deny jumps are those symbols, in that order."""
        self.assertEqual(set(DENY_SYMBOLS_BY_ROLE), set(confinement.UIDS))
        self.assertEqual((len(DENY_ORDER), len(set(DENY_ORDER))), (24, 24))
        self.assertEqual(len(BROWSER_SANDBOX_SYMBOLS), 11)
        self.assertLessEqual(BROWSER_SANDBOX_SYMBOLS, set(DENY_ORDER))
        for role, symbols in DENY_SYMBOLS_BY_ROLE.items():
            if role == 'BROWSER':
                self.assertEqual(len(symbols), 13)
                self.assertEqual(symbols, tuple(s for s in DENY_ORDER if s not in BROWSER_SANDBOX_SYMBOLS))
            else:
                self.assertEqual(symbols, DENY_ORDER, role)
        for role, program in self.programs().items():
            deny = len(program) - 1
            self.assertEqual(program[deny][3], self.V['SECCOMP_RET_ERRNO'] | self.V['EPERM'])
            got = [k for i, (code, jt, jf, k), off, masked in self.walk(program)
                   if code == self.op_jeq and off == self.V['seccomp_data.nr'] and not masked and jt and i + 1 + jt == deny]
            self.assertEqual(got, [self.V[s] for s in DENY_SYMBOLS_BY_ROLE[role]], role)

    def test_role_filter_digests_pinned(self):
        """sha256(filter_bytes(build_filter(role))) per role: E1 leaves CONTROLLER, VERIFIER and PROXY byte-identical
        and gives BROWSER its own program. VMHost.swift's role table pins the same four digests."""
        digests = {role: hashlib.sha256(confinement.filter_bytes(program)).hexdigest()
                   for role, program in self.programs().items()}
        for role in ('CONTROLLER', 'VERIFIER', 'PROXY'):
            self.assertEqual(digests[role], ROLE_FILTER_DIGESTS[role], role)
        self.assertNotIn(digests['BROWSER'], {digests[role] for role in ('CONTROLLER', 'VERIFIER', 'PROXY')})
        self.assertEqual(set(ROLE_FILTER_DIGESTS), set(confinement.UIDS))
        # Task 8c: no superseded BROWSER program is produced or pinned.
        self.assertNotIn(digests['BROWSER'], RETIRED_BROWSER_FILTER_DIGESTS)
        self.assertNotIn(ROLE_FILTER_DIGESTS['BROWSER'], RETIRED_BROWSER_FILTER_DIGESTS)
        self.assertEqual(digests['BROWSER'], ROLE_FILTER_DIGESTS['BROWSER'])

    def module_constant(self, name):
        """The value node of the single module-level assignment to NAME in guest/confinement.py."""
        found = [n.value for n in self.nodes('confinement.py', '<module>', ast.Assign)
                 if [ast.unparse(t) for t in n.targets] == [name]]
        self.assertEqual(len(found), 1, name)
        return found[0]

    def or_names(self, names):
        """OR of the POLICY_LITERALS, R13_LITERALS or coverage v2 values of NAMES."""
        value = 0
        for name in names:
            value |= self.resolve(name)
        return value

    def seccomp_flag_compares(self, program):
        """In program order, k of every comparison on the seccomp(2) flags word (args[1] low word) inside the seccomp
        dispatch branch that jumps to the ALLOW return."""
        V = self.V
        starts = [j + 1 + jt for j, (code, jt, jf, k), off, m in self.walk(program)
                  if code == self.op_jeq and off == V['seccomp_data.nr'] and not m and jt and k == V['__NR_seccomp']]
        self.assertEqual(len(starts), 1)
        branch = self.reach(program, starts[0])
        flags_word = V['seccomp_data.args'] + self.stride
        got = []
        for i, (code, jt, jf, k), off, m in self.walk(program):
            if i in branch and code == self.op_jeq and off == flags_word and not m and jt:
                self.assertEqual(program[i + 1 + jt], (self.op_ret, 0, 0, V['SECCOMP_RET_ALLOW']), i)
                got.append(k)
        return got

    def test_module_filter_constants_match_named_symbols(self):
        """guest/confinement.py BASE_DENY_SYSCALLS (24, in order), BROWSER_SANDBOX_SYSCALLS (11, in order),
        SECCOMP_FLAGS_BY_ROLE (per role) and BROWSER_TCP_PROTOCOL (Task 8c): one assertion per element, each against
        its named symbol or named OR."""
        base = self.module_constant('BASE_DENY_SYSCALLS')
        self.assertIsInstance(base, ast.Tuple)
        self.assertEqual(len(base.elts), len(DENY_ORDER))
        for index, (node, name) in enumerate(zip(base.elts, DENY_ORDER)):
            self.assertEqual(_eval_int(node), self.resolve(name), (index, name))
        sandbox = self.module_constant('BROWSER_SANDBOX_SYSCALLS')
        self.assertIsInstance(sandbox, ast.Tuple)
        self.assertEqual(set(BROWSER_SANDBOX_ORDER), BROWSER_SANDBOX_SYMBOLS)
        self.assertEqual(len(sandbox.elts), len(BROWSER_SANDBOX_ORDER))
        for index, (node, name) in enumerate(zip(sandbox.elts, BROWSER_SANDBOX_ORDER)):
            self.assertEqual(_eval_int(node), self.resolve(name), (index, name))
        flags = self.module_constant('SECCOMP_FLAGS_BY_ROLE')
        self.assertIsInstance(flags, ast.Call)
        self.assertEqual((ast.unparse(flags.func), len(flags.args), flags.keywords), ('MappingProxyType', 1, []))
        table = flags.args[0]
        self.assertIsInstance(table, ast.Dict)
        roles = [key.value if isinstance(key, ast.Constant) else None for key in table.keys]
        self.assertEqual(roles, list(confinement.UIDS))
        for role, value in zip(roles, table.values):
            self.assertIsInstance(value, ast.Tuple, role)
            names = SECCOMP_FLAG_NAMES_BY_ROLE[role]
            self.assertEqual(len(value.elts), len(names), role)
            for index, (node, combination) in enumerate(zip(value.elts, names)):
                self.assertEqual(_eval_int(node), self.or_names(combination), (role, index, combination))
        # Task 8c (C6): the BROWSER stream protocol literal is the coverage symbol IPPROTO_TCP (never a policy name).
        tcp = self.module_constant('BROWSER_TCP_PROTOCOL')
        self.assertEqual(_eval_int(tcp), self.covered('IPPROTO_TCP'))
        # The runtime objects are exactly the bound literals.
        self.assertEqual(confinement.BASE_DENY_SYSCALLS, tuple(_eval_int(n) for n in base.elts))
        self.assertEqual(confinement.BROWSER_SANDBOX_SYSCALLS, tuple(_eval_int(n) for n in sandbox.elts))
        self.assertEqual(dict(confinement.SECCOMP_FLAGS_BY_ROLE),
                         {role: tuple(_eval_int(n) for n in value.elts) for role, value in zip(roles, table.values)})
        self.assertEqual(confinement.BROWSER_TCP_PROTOCOL, _eval_int(tcp))

    def test_seccomp_flag_sets_match_named_symbols(self):
        """C6: each role's seccomp(2) flag comparisons, in program order, are exactly its named set; BROWSER's is
        {0, TSYNC, SPEC_ALLOW, TSYNC|SPEC_ALLOW} built from the two named symbols. One assertion per allowed value and
        one per brief-tested denied value (plus SPEC_ALLOW and TSYNC|SPEC_ALLOW for the other roles)."""
        tsync, spec = self.resolve('SECCOMP_FILTER_FLAG_TSYNC'), self.resolve('SECCOMP_FILTER_FLAG_SPEC_ALLOW')
        programs = self.programs()
        browser = self.seccomp_flag_compares(programs['BROWSER'])
        browser_set = (self.resolve('SECCOMP_NO_FLAGS'), tsync, spec, tsync | spec)
        self.assertEqual(len(browser), len(browser_set))
        for index, value in enumerate(browser_set):
            self.assertEqual(browser[index], value, ('BROWSER', index))
        for role, program in programs.items():
            got = self.seccomp_flag_compares(program)
            want = [self.or_names(names) for names in SECCOMP_FLAG_NAMES_BY_ROLE[role]]
            self.assertEqual(len(got), len(want), role)
            for index, value in enumerate(want):
                self.assertEqual(got[index], value, (role, index))
            denied = [self.or_names(names) for names in SECCOMP_DENIED_FLAG_NAMES]
            if role != 'BROWSER':
                denied += [spec, tsync | spec]
            for value in denied:
                self.assertNotIn(value, got, (role, value))

    def ip_protocol_compares(self, program):
        """In program order, (index, jt, jf, k) of every comparison on socket's protocol word (args[2] low word) reachable
        from the AF_INET/AF_INET6 dispatch inside the socket branch. AF_INET and AF_INET6 must share one target."""
        V = self.V
        starts = [j + 1 + jt for j, (code, jt, jf, k), off, m in self.walk(program)
                  if code == self.op_jeq and off == V['seccomp_data.nr'] and not m and jt and k == V['__NR_socket']]
        self.assertEqual(len(starts), 1)
        socket_branch = self.reach(program, starts[0])
        family_word = V['seccomp_data.args']
        targets = {j + 1 + jt for j, (code, jt, jf, k), off, m in self.walk(program)
                   if j in socket_branch and code == self.op_jeq and off == family_word and not m and jt
                   and k in (V['AF_INET'], V['AF_INET6'])}
        self.assertEqual(len(targets), 1)
        branch = self.reach(program, targets.pop())
        protocol_word = V['seccomp_data.args'] + 2 * self.stride
        return [(i, jt, jf, k) for i, (code, jt, jf, k), off, m in self.walk(program)
                if i in branch and code == self.op_jeq and off == protocol_word and not m]

    def test_ip_protocol_compares_match_named_symbols(self):
        """Task 8c (C6, owner decision 2026-11-20): per role, the protocol comparisons of the AF_INET/AF_INET6 branch,
        in program order, are exactly IP_PROTOCOL_NAMES_BY_ROLE (one assertion per value): BROWSER IPPROTO_TCP then the
        default 0, every other role the default 0 only. The default comparison is a require (false branch EPERM).
        BROWSER's IPPROTO_TCP true branch is exactly: load the type word, mask SOCK_NONBLOCK|SOCK_CLOEXEC, compare
        SOCK_STREAM to the ALLOW return, else EPERM. IPPROTO_UDP is compared by no role. ARG_SYMBOLS (role-free) admits
        IPPROTO_TCP for every role's filter; this test is what keeps it BROWSER's alone."""
        V = self.V
        allow = (self.op_ret, 0, 0, V['SECCOMP_RET_ALLOW'])
        eperm = (self.op_ret, 0, 0, V['SECCOMP_RET_ERRNO'] | V['EPERM'])
        tcp, udp, default = self.covered('IPPROTO_TCP'), self.covered('IPPROTO_UDP'), self.resolve('PROTOCOL_DEFAULT')
        self.assertEqual(set(IP_PROTOCOL_NAMES_BY_ROLE), set(confinement.UIDS))
        for role, program in self.programs().items():
            got = self.ip_protocol_compares(program)
            want = [self.or_names(names) for names in IP_PROTOCOL_NAMES_BY_ROLE[role]]
            self.assertEqual(len(got), len(want), role)
            for index, value in enumerate(want):
                self.assertEqual(got[index][3], value, (role, index))
            self.assertNotIn(udp, [k for _, _, _, k in got], role)
            for i, jt, jf, k in got:
                if k == default:
                    self.assertEqual((jt, program[i + 1 + jf]), (0, eperm), (role, i))
                    continue
                self.assertEqual((role, k), ('BROWSER', tcp), i)
                self.assertEqual(jf, 0, (role, i))
                t = i + 1 + jt
                self.assertEqual(program[t], (self.op_ld, 0, 0, V['seccomp_data.args'] + self.stride), (role, t))
                self.assertEqual(program[t + 1], (self.op_and, 0, 0, self.sock_mask), (role, t + 1))
                code, jt2, jf2, k2 = program[t + 2]
                self.assertEqual((code, jf2, k2), (self.op_jeq, 0, self.covered('SOCK_STREAM')), (role, t + 2))
                self.assertEqual(program[t + 3 + jt2], allow, (role, t + 2))
                self.assertEqual(program[t + 3], eperm, (role, t + 3))

    def test_filter_dispatch_numbers_are_the_expected_syscalls(self):
        allowed_dispatch = {'__NR_socket', '__NR_socketpair', '__NR_prctl', '__NR_seccomp'}
        for role, program in self.programs().items():
            deny = len(program) - 1
            got = {self.nr_by_value[k] for i, (code, jt, jf, k), off, masked in self.walk(program)
                   if code == self.op_jeq and off == self.V['seccomp_data.nr'] and not masked and jt and i + 1 + jt != deny}
            self.assertEqual(got, allowed_dispatch | ({'__NR_socket'} if role == 'PROXY' else set()), role)

    # --- native call sites ----------------------------------------------------------------------------------------
    def sites(self):
        for fname, tree in self.trees.items():
            for call in _syscall_calls(tree):
                yield fname, call

    def test_syscall_sites_use_covered_numbers(self):
        used = {}
        opaque = []
        for fname, call in self.sites():
            first = call.args[0] if call.args else None
            if isinstance(first, ast.Constant) and type(first.value) is int:
                self.assertIn(first.value, self.nr_by_value, (fname, call.lineno))
                used.setdefault(self.nr_by_value[first.value], set()).add(fname)
            else:
                opaque.append((fname, ast.unparse(call.func)))
        # the non-literal sites are the libc trampoline and the probe context's trampoline, which receive the number
        # as a parameter
        self.assertEqual(opaque, [('confinement.py', 'self._libc.syscall'), (PROBE_FILE, 'self.port.b.syscall')])
        self.assertEqual({k: frozenset(v) for k, v in used.items()}, SYSCALL_SITES)

    def site_table(self):
        """(file, qualname, ordinal) -> (call node, nr symbol), over calls whose number is an int literal."""
        found = {}
        for fname, tree in self.trees.items():
            per_func = {}

            def visit(node, stack):
                if isinstance(node, (ast.ClassDef, ast.FunctionDef)):
                    stack = stack + [node.name]
                if isinstance(node, ast.Call) and node in all_calls:
                    first = node.args[0] if node.args else None
                    if isinstance(first, ast.Constant) and type(first.value) is int:
                        per_func.setdefault('.'.join(stack), []).append(node)
                for child in ast.iter_child_nodes(node):
                    visit(child, stack)
            all_calls = set(_syscall_calls(tree))
            visit(tree, [])
            for qual, calls in per_func.items():
                for n, call in enumerate(sorted(calls, key=lambda c: (c.lineno, c.col_offset))):
                    # An uncovered number fails here as an assertion, never as a KeyError (Task 10).
                    self.assertIn(call.args[0].value, self.nr_by_value, (fname, qual, n, call.lineno))
                    found[(fname, qual, n)] = (call, self.nr_by_value[call.args[0].value])
        return found

    def test_per_site_table_keys_and_numbers_match_the_code_exactly(self):
        found = self.site_table()
        self.assertEqual(set(found), set(SITE_ARGS))
        for key, (call, sym) in found.items():
            self.assertEqual(sym, SITE_ARGS[key][0], key)
        derived = {}
        for (fname, _, _), (nr, *_) in SITE_ARGS.items():
            derived.setdefault(nr, set()).add(fname)
        self.assertEqual({k: frozenset(v) for k, v in derived.items()}, SYSCALL_SITES)

    def test_syscall_flag_arguments_decompose_into_covered_symbols(self):
        checked = 0
        for key, (call, sym) in self.site_table().items():
            expected = SITE_ARGS[key][1]
            literal = {i: _eval_int(n) for i, n in enumerate(call.args[1:]) if _eval_int(n) is not None}
            self.assertEqual(set(literal), set(expected), (key, 'literal arguments differ from table'))
            for idx, want in expected.items():
                where = (key, sym, idx, literal[idx])
                if isinstance(want, str):
                    self.assertEqual(literal[idx], self.policy_at(key, want), where)
                else:
                    acc = 0
                    for name in sorted(want):
                        self.assertEqual(acc & self.covered(name), 0, where)  # flag symbols are disjoint bits
                        acc |= self.covered(name)
                    self.assertEqual(literal[idx], acc, where)
                    self.assertLessEqual(want, ARG_SYMBOLS.get(sym, {}).get(idx, frozenset()), where)
                checked += 1
        # every int-literal argument at every site (Task 10: 58 at probe sites; Task 14: +2, the role tmpfs and the
        # crash bind flags)
        self.assertEqual(checked, 93)

    def test_role_shm_tmpfs_mount_site_decomposes_into_existing_symbols(self):
        """Task 14 (C7, P14): the role's /dev/shm tmpfs mount is one exact establish_views site whose flags are the
        existing MS_NOSUID|MS_NODEV|MS_NOEXEC inventory symbols and whose source, target, type and data carry no
        int constant; the crash bind after it is a plain MS_BIND. No inventory id is added."""
        found = self.site_table()
        tmpfs = sorted(key for key, (call, _) in found.items()
                       if key[:2] == ('confinement.py', 'NativeChildPort.establish_views')
                       and isinstance(call.args[1], ast.Constant) and call.args[1].value == b'tmpfs')
        self.assertEqual(tmpfs, [('confinement.py', 'NativeChildPort.establish_views', 5)])
        call = found[tmpfs[0]][0]
        self.assertEqual(SITE_ARGS[tmpfs[0]], ('__NR_mount', {3: _s('MS_NOSUID', 'MS_NODEV', 'MS_NOEXEC')}))
        self.assertEqual(len(call.args), 6)
        self.assertEqual(_eval_int(call.args[4]), self.covered('MS_NOSUID') | self.covered('MS_NODEV')
                         | self.covered('MS_NOEXEC'))
        self.assertEqual([_int_constants(arg) for arg in call.args[1:4] + call.args[5:]], [[], [], [], []])
        self.assertEqual(SITE_ARGS[('confinement.py', 'NativeChildPort.establish_views', 6)],
                         ('__NR_mount', {3: _s('MS_BIND')}))
        inventory = {entry['id'] for entry in json.loads(INVENTORY.read_bytes())['entries']}
        self.assertLessEqual({'MS_NOSUID', 'MS_NODEV', 'MS_NOEXEC', 'MS_BIND'}, inventory)

    def test_capability_literals_are_covered(self):
        tree = self.trees['confinement.py']
        loops = [n for n in ast.walk(_function(tree, 'drop_credentials')) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'range']
        self.assertEqual([c.args[0].value for c in loops], [self.V['CAP_LAST_CAP'] + 1])
        clear = _function(tree, 'clear_capabilities')
        pack = next(n for n in ast.walk(clear) if isinstance(n, ast.Call) and ast.unparse(n.func) == 'struct.pack')
        self.assertEqual(pack.args[0].value, '<II')
        self.assertEqual(pack.args[1].value, self.V['_LINUX_CAPABILITY_VERSION_3'])
        self.assertEqual(pack.args[2].value, POLICY_LITERALS['CAPSET_HEADER_PID'][0])
        sizes = [n.args[0].value for n in ast.walk(clear) if isinstance(n, ast.Call) and ast.unparse(n.func) == 'bytearray'
                 and isinstance(n.args[0], ast.Constant)]
        # only the data-struct count factor is covered (R13 leaves the 12-byte element size uncovered)
        self.assertEqual(len(sizes), 1)
        self.assertEqual(sizes[0] % self.V['_LINUX_CAPABILITY_U32S_3'], 0)

    # --- R15: argument subtrees of native call sites -------------------------------------------------------------
    def test_site_argument_subtrees_have_no_unlisted_int_constants(self):
        """Every int constant anywhere in a native site's arguments is accounted for by SITE_ARGS: a listed literal
        argument must fold whole (its value is checked by the decomposition test); any other argument may carry only
        the int constants its optional third-element entry names, in source order. No keyword arguments."""
        nested_total = 0
        for key, (call, sym) in self.site_table().items():
            literal_args = SITE_ARGS[key][1]
            nested = SITE_ARGS[key][2] if len(SITE_ARGS[key]) > 2 else {}
            self.assertEqual(call.keywords, [], key)
            self.assertFalse(set(nested) & set(literal_args), key)
            self.assertLessEqual(set(nested), set(range(len(call.args) - 1)), key)
            for idx, arg in enumerate(call.args[1:]):
                if idx in literal_args:
                    self.assertIsNotNone(_eval_int(arg), (key, idx, ast.unparse(arg)))
                    continue
                want = [self.resolve_at(key, name) for name in nested.get(idx, ())]
                self.assertEqual(_int_constants(arg), want, (key, idx, ast.unparse(arg)))
                nested_total += len(want)
        self.assertEqual(nested_total, 12)  # Task 10: 8 at probe sites

    # --- R14: the rest of the guest modules -----------------------------------------------------------------------
    def check_compare_site(self, name):
        fname, qual, lefts, want = COMPARE_SITES[name]
        got = self.compares(fname, qual, lefts)
        self.assertEqual(got, [(op, tuple(self.resolve(n) for n in names)) for op, names in want], name)

    def test_topology_audit_syscall_numbers_match_named_symbols(self):
        """_accept_browser_transition (Task 11): process exit (exit_group, P58), clones (clone, clone3) and execs
        (execve, execveat), each exact and in source order; there is no EXIT phase."""
        self.check_compare_site('transition')

    def test_topology_audit_record_syscall_numbers_match_named_symbols(self):
        self.check_compare_site('audit_syscalls')

    def test_topology_audit_sockaddr_families_match_named_symbols(self):
        self.check_compare_site('audit_families')

    def test_topology_unix_table_flags_and_types_match_named_symbols(self):
        """/proc/net/unix in _abstract: Flags (column 3) and Type (column 4) are bound; Protocol (2) and St (5) are
        R13 (kernel print format; socket_state enumerators have implicit values). No other column is compared."""
        self.check_compare_site('unix_flags')
        self.check_compare_site('unix_types')
        columns = set()
        for node in self.nodes('topology.py', '_abstract', ast.Compare):
            match = re.fullmatch(r'int\(fields\[(\d+)\], 16\)', ast.unparse(node.left))
            if match:
                columns.add(int(match.group(1)))
        self.assertEqual(columns, {2, 3, 4, 5})

    def test_storage_name_bound_matches_named_symbol(self):
        self.check_compare_site('name_max')

    def test_topology_audit_rule_syscall_list_matches_named_symbols(self):
        fn = self.nodes('topology.py', '_fixed_audit_rule', ast.FunctionDef)
        self.assertEqual(len(fn), 1)
        loops = [n for n in ast.walk(fn[0]) if isinstance(n, ast.For)]
        self.assertEqual(len(loops), 1)
        self.assertIsInstance(loops[0].iter, ast.Tuple)
        got = tuple(_eval_int(e) for e in loops[0].iter.elts)
        self.assertEqual(got, tuple(self.resolve(n) for n in AUDITED_SYSCALLS))
        # the rule's arch value: values[0] in `fields[0], values[0], operators[0] = ...`
        assigns = [n for n in ast.walk(fn[0]) if isinstance(n, ast.Assign)
                   and ast.unparse(n.targets[0]) == '(fields[0], values[0], operators[0])']
        self.assertEqual(len(assigns), 1)
        self.assertIsInstance(assigns[0].value, ast.Tuple)
        self.assertEqual(len(assigns[0].value.elts), 3)
        self.assertEqual(_eval_int(assigns[0].value.elts[1]), self.resolve('AUDIT_ARCH_AARCH64'))

    def module_assign(self, name):
        found = [n for n in self.nodes('topology.py', '<module>', ast.Assign)
                 if [ast.unparse(t) for t in n.targets] == [name]]
        self.assertEqual(len(found), 1, name)
        return found[0].value

    def or_elements(self, node):
        """The int constants OR-ed in NODE, in source order; NODE must be a pure OR of int literals."""
        self.assertIsNotNone(_eval_int(node), ast.unparse(node))
        return _int_constants(node)

    def test_topology_event_literals_match_named_symbols(self):
        """Task 11 (CB-I3, Option A I2/R17 C3/C4): one assertion per event literal in topology.py."""
        # The fixed audit rule: header words, the one rule field, the array sizes and the pack layout.
        fn = self.nodes('topology.py', '_fixed_audit_rule', ast.FunctionDef)
        self.assertEqual(len(fn), 1)
        packs = [n for n in ast.walk(fn[0]) if isinstance(n, ast.Call) and ast.unparse(n.func) == 'struct.pack']
        self.assertEqual(len(packs), 1)
        layout = packs[0].args[0].value
        for index, name in enumerate(AUDIT_RULE_HEADER, 1):
            self.assertEqual(_eval_int(packs[0].args[index]), self.covered(name), name)
        assigns = [n for n in ast.walk(fn[0]) if isinstance(n, ast.Assign)
                   and ast.unparse(n.targets[0]) == '(fields[0], values[0], operators[0])']
        self.assertEqual(len(assigns), 1)
        self.assertEqual(_eval_int(packs[0].args[3]), len(assigns))  # field_count: the one field set below
        for element, name in zip(assigns[0].value.elts, AUDIT_RULE_FIELD, strict=True):
            self.assertEqual(_eval_int(element), self.covered(name), name)
        sizes = [_eval_int(n.right) for n in ast.walk(fn[0]) if isinstance(n, ast.BinOp)
                 and isinstance(n.op, ast.Mult) and ast.unparse(n.left) == '[0]']
        self.assertEqual(sizes, [self.covered(name) for name in AUDIT_RULE_ARRAYS])
        self.assertEqual(layout, '<III%dI%dI%dI%dII' % tuple(self.covered(n) for n in AUDIT_RULE_ARRAYS))
        # Every mask word: run the isolated rule builder and compare each word with the covered syscall numbers.
        namespace = {'struct': struct}
        exec(compile(ast.Module([fn[0]], []), 'topology._fixed_audit_rule', 'exec'), namespace)
        rule = namespace['_fixed_audit_rule']()
        words = struct.unpack(layout, rule)
        width = self.covered('AUDIT_BITMASK_SIZE')
        mask = [0] * width
        for name in AUDITED_SYSCALLS:
            mask[self.covered(name) // 32] |= 1 << (self.covered(name) % 32)
        for index in range(width):
            self.assertEqual(words[3 + index], mask[index], 'mask word %d' % index)
        self.assertEqual(words[:3], (self.covered('AUDIT_FILTER_EXIT'), self.covered('AUDIT_ALWAYS'), 1))
        # Subscribed route groups and the inotify watch mask: each OR element, in order.
        for name, symbols in EVENT_MASK_CONSTANTS.items():
            self.assertEqual(self.or_elements(self.module_assign(name)), [self.covered(s) for s in symbols], name)
        # Route kinds, audit kinds and the netlink reply kinds.
        for site in ('event_route_kinds', 'event_audit_kinds', 'event_health_kinds'):
            self.check_compare_site(site)
        # Task 18 F3 (P85): the AUDIT_GET reply mask word is the kernel's 0 (AUDIT_GET_REPLY_MASK, cited), bound at its
        # own site and never the AUDIT_SET request mask (the AUDIT_STATUS_MASK OR, 31).
        status = self.compares('topology.py', 'BootstrapEventOwner._verify_health_and_rules', ('status[0]',))
        self.assertEqual(status, [('NotEq', (self.resolve('AUDIT_GET_REPLY_MASK'),))])
        self.assertNotEqual(self.resolve('AUDIT_GET_REPLY_MASK'), self.or_names(AUDIT_STATUS_MASK))
        self.assertNotIn(self.or_names(AUDIT_STATUS_MASK), _int_constants(
            self.nodes('topology.py', 'BootstrapEventOwner._verify_health_and_rules', ast.FunctionDef)[0]))
        # Overflow bits and the watch mask test in _record's inotify branch.
        masks = [n.right for n in self.nodes('topology.py', 'BootstrapEventOwner._record', ast.BinOp)
                 if isinstance(n.op, ast.BitAnd) and ast.unparse(n.left) == 'mask']
        self.assertEqual([ast.unparse(m) for m in masks][1:], ['_INOTIFY_MASK'])
        self.assertEqual(self.or_elements(masks[0]), [self.covered(n) for n in INOTIFY_OVERFLOW_BITS])
        # Netlink flags: an audit event carries neither DUMP_INTR nor ACK; rule enumeration replies are MULTI.
        flags = [n.right for n in self.nodes('topology.py', 'BootstrapEventOwner._audit_record', ast.BinOp)
                 if isinstance(n.op, ast.BitAnd) and ast.unparse(n.left) == 'flags']
        self.assertEqual(len(flags), 1)
        self.assertEqual(self.or_elements(flags[0]), [self.covered(n) for n in AUDIT_EVENT_FLAGS])
        multi = self.covered('NLM_F_MULTI')
        health = self.compares('topology.py', 'BootstrapEventOwner._verify_health_and_rules', ('flags', 'flags & 2'))
        self.assertEqual(health, [('NotEq', (0,)), ('NotIn', (0, multi)), ('NotEq', (multi,))])
        multi_masks = [_eval_int(n.right) for n in self.nodes('topology.py',
                       'BootstrapEventOwner._verify_health_and_rules', ast.BinOp)
                       if isinstance(n.op, ast.BitAnd) and ast.unparse(n.left) == 'flags']
        self.assertEqual(multi_masks, [multi])
        # P62: the netlink header length is one named constant; the framing helpers spell no 16.
        self.assertEqual(_eval_int(self.module_assign('_NLMSG_HDRLEN')), self.resolve('NLMSG_HDRLEN'))
        for qual in ('_event_nlmsg', '_event_header', '_parse_event_nlmsg'):
            fn = self.nodes('topology.py', qual, ast.FunctionDef)
            self.assertEqual(len(fn), 1, qual)
            self.assertNotIn(self.resolve('NLMSG_HDRLEN'), _int_constants(fn[0]), qual)
            self.assertIn('_NLMSG_HDRLEN', {n.id for n in ast.walk(fn[0]) if isinstance(n, ast.Name)}, qual)
        # R17 C4: the record arch is the kernel's lowercase %x of AUDIT_ARCH_AARCH64.
        arch = [n for n in self.nodes('topology.py', 'BootstrapEventOwner._audit_record', ast.Compare)
                if ast.unparse(n.left) == "fields.get('arch')"]
        self.assertEqual(len(arch), 1)
        text = arch[0].comparators[0].value
        self.assertEqual(int(text, 16), self.covered('AUDIT_ARCH_AARCH64'))
        self.assertEqual(text, format(self.covered('AUDIT_ARCH_AARCH64'), 'x'))

    def test_topology_install_audit_set_fields_follow_the_status_bits(self):
        """Task 18 F4 (P86(b')): each _AUDIT_SET_CHANGES field, at position i, is the field whose AUDIT_STATUS_* bit
        is 1 << i, so the install's expected CONFIG_CHANGE bodies follow the mask bit by bit."""
        changes = ast.literal_eval(self.module_assign('_AUDIT_SET_CHANGES'))
        self.assertEqual([name for name, _, _ in changes], [field for _, field in AUDIT_SET_CHANGE_FIELDS])
        for position, (symbol, field) in enumerate(AUDIT_SET_CHANGE_FIELDS):
            self.assertEqual(self.covered(symbol), 1 << position, (symbol, field))
        self.assertEqual(self.or_elements(self.module_assign('_AUDIT_SET_MASK')),
                         [self.covered(symbol) for symbol, _ in AUDIT_SET_CHANGE_FIELDS])

    def test_topology_sandbox_admission_constants_match_named_symbols(self):
        """E-1b (P45): _SANDBOX_ADMITTED_SYSCALLS and _SANDBOX_UNSHARE_FLAGS bind to __NR_chroot, __NR_unshare and
        CLONE_NEWUSER; _admit_browser_sandbox compares exactly SANDBOX_ADMISSION_COMPARES, unpacks the syscall pair
        once and holds no other int literal (exit 0 is the success return, R13 behaviour)."""
        for name, symbols in SANDBOX_ADMISSION_CONSTANTS.items():
            node = self.module_assign(name)
            elements = node.elts if isinstance(node, ast.Tuple) else [node]
            self.assertEqual([_eval_int(e) for e in elements], [self.covered(s) for s in symbols], name)
        qual = 'BootstrapEventOwner._admit_browser_sandbox'
        got = [(ast.unparse(n.left), type(n.ops[0]).__name__, ast.unparse(n.comparators[0]))
               for n in self.nodes('topology.py', qual, ast.Compare)]
        self.assertEqual(got, SANDBOX_ADMISSION_COMPARES)
        unpacks = [ast.unparse(n) for n in self.nodes('topology.py', qual, ast.Assign)
                   if ast.unparse(n.value) == '_SANDBOX_ADMITTED_SYSCALLS']
        self.assertEqual(unpacks, ['chroot, unshare = _SANDBOX_ADMITTED_SYSCALLS'])
        self.assertEqual(_int_constants(self.nodes('topology.py', qual, ast.FunctionDef)[0]), [0])

    def test_confinement_seccomp_install_flags_match_named_symbol(self):
        """exec_role: kernel.install_seccomp(launch.filter, <flags>) passes exactly SECCOMP_FILTER_FLAG_TSYNC."""
        calls = [n for n in self.nodes('confinement.py', 'exec_role', ast.Call)
                 if isinstance(n.func, ast.Attribute) and n.func.attr == 'install_seccomp']
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0].args), 2)
        self.assertEqual(_eval_int(calls[0].args[1]), self.resolve('SECCOMP_FILTER_FLAG_TSYNC'))

    def test_open_flag_literals_match_named_symbols(self):
        found = {}
        for fname in GUEST_MODULES + (PROBE_FILE,):
            per = {}
            for qual, node in self.scoped[fname]:
                if not isinstance(node, ast.Call):
                    continue
                f = node.func
                callee = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else None
                index = _FLAG_ARG.get(callee)
                if index is None or len(node.args) <= index or not _int_constants(node.args[index]):
                    continue
                per.setdefault((qual, callee), []).append(node)
            for (qual, callee), calls in per.items():
                for n, call in enumerate(_source_order(calls)):
                    found[(fname, qual, callee, n)] = call.args[_FLAG_ARG[callee]]
        self.assertEqual(set(found), set(OPEN_FLAG_SITES))
        for key, flags in found.items():
            want = OPEN_FLAG_SITES[key]
            if isinstance(want, tuple):
                self.assertIsNone(_eval_int(flags), key)
                self.assertEqual(_int_constants(flags), [self.resolve(n) for n in want], key)
                continue
            acc = 0
            for name in sorted(want):
                self.assertEqual(acc & self.resolve(name), 0, (key, name))  # disjoint flag bits
                acc |= self.resolve(name)
            self.assertEqual(_eval_int(flags), acc, key)

    def test_fdinfo_access_mode_literals_match_named_symbols(self):
        """_native_observe reads each pipe end's /proc fdinfo flags: flags & O_ACCMODE must be O_RDONLY for the
        command fd and O_WRONLY for the result fd."""
        masks = [_eval_int(n.right) for n in self.nodes('confinement.py', '_native_observe', ast.BinOp)
                 if isinstance(n.op, ast.BitAnd) and ast.unparse(n.left) == 'flags']
        self.assertEqual(masks, [self.resolve('O_ACCMODE')])
        loops = [n for n in self.nodes('confinement.py', '_native_observe', ast.For)
                 if ast.unparse(n.target) == '(fd, direction)']
        self.assertEqual(len(loops), 1)
        self.assertIsInstance(loops[0].iter, ast.Tuple)
        directions = [_eval_int(pair.elts[1]) for pair in loops[0].iter.elts]
        self.assertEqual(directions, [self.resolve('O_RDONLY'), self.resolve('O_WRONLY')])
        checks = [ast.unparse(n) for n in self.nodes('confinement.py', '_native_observe', ast.Compare)
                  if ast.unparse(n.comparators[0]) == 'direction']
        self.assertEqual(len(checks), 1)

    def test_proxy_nonblocking_flag_literals_match_named_symbol(self):
        """finalize_nonblocking: the one permitted fdinfo flags change is exactly O_NONBLOCK."""
        qual = '_RuntimeDescriptors.finalize_nonblocking'
        ors = [n.right for n in self.nodes('proxy.py', qual, ast.BinOp) if isinstance(n.op, ast.BitOr)]
        ors += [n.value for n in self.nodes('proxy.py', qual, ast.AugAssign) if isinstance(n.op, ast.BitOr)]
        self.assertEqual([_eval_int(n) for n in ors], [self.resolve('O_NONBLOCK')] * 2)

    def test_vsock_host_cid_literals_match_named_symbol(self):
        port = POLICY_LITERALS['VSOCK_SERVICE_PORT'][0]
        found = {}
        for fname in GUEST_MODULES:
            for qual, node in self.scoped[fname]:
                cids = []
                if isinstance(node, (ast.Tuple, ast.List, ast.Call)):
                    seq = node.args if isinstance(node, ast.Call) else node.elts
                    for before, item in zip(seq, seq[1:]):
                        if _eval_int(item) == port and not (isinstance(before, ast.Constant) and type(before.value) is str):
                            cids.append(before)
                    if (isinstance(node, ast.Tuple) and len(seq) == 2 and isinstance(seq[0], ast.Constant)
                            and seq[0].value in ('hostCID', 'hostCid') and _int_constants(seq[1])):
                        cids.append(seq[1])
                elif isinstance(node, ast.Dict):  # a keyed value counts when it holds an int constant
                    cids += [v for k, v in zip(node.keys, node.values) if isinstance(k, ast.Constant)
                             and k.value in ('hostCID', 'hostCid') and _int_constants(v)]
                elif isinstance(node, ast.Assign) and [ast.unparse(t) for t in node.targets] == ['_HOST_CID']:
                    cids.append(node.value)
                for cid in cids:
                    found.setdefault((fname, qual), []).append(_eval_int(cid))
        self.assertEqual({k: len(v) for k, v in found.items()}, VSOCK_CID_SITES)
        for key, values in found.items():
            self.assertEqual(values, [self.resolve('VMADDR_CID_HOST')] * len(values), key)

    def test_seccomp_mode_attestation_literals_match_named_symbol(self):
        found = {}
        for fname in GUEST_MODULES:
            for qual, node in self.scoped[fname]:
                if isinstance(node, ast.Compare) and re.fullmatch(r".*(\.seccomp|\['seccomp'\])", ast.unparse(node.left)):
                    self.assertEqual(len(node.ops), 1)
                    found.setdefault((fname, qual), []).append((type(node.ops[0]).__name__, _eval_int(node.comparators[0])))
        self.assertEqual({k: len(v) for k, v in found.items()}, SECCOMP_MODE_SITES)
        for key, values in found.items():
            self.assertEqual(values, [('NotEq', self.resolve('SECCOMP_MODE_FILTER'))] * len(values), key)

    def test_interface_name_bounds_match_named_symbol(self):
        found = {}
        for qual, node in self.scoped['topology.py']:
            if qual in IFNAME_BOUND_SITES and isinstance(node, ast.Call) and ast.unparse(node.func) == '_ascii':
                found.setdefault(qual, []).append(_eval_int(node.args[1]))
        self.assertEqual({k: len(v) for k, v in found.items()}, IFNAME_BOUND_SITES)
        for qual, values in found.items():
            self.assertEqual(values, [self.resolve('IFNAMSIZ') - 1] * len(values), qual)

    def test_topology_route_flag_and_tcp_state_literals_match_named_symbols(self):
        """One assertion per site: each module-level constant, each kernel-default IPv6 shape's flags, the RTF_GATEWAY
        printer check in _routes6, and the two TCP state comparisons in _network_rows (no hex-string state literal)."""
        module = self.nodes('topology.py', '<module>', ast.Assign)
        bound = {}
        for node in module:
            targets = [ast.unparse(t) for t in node.targets]
            if len(targets) == 1 and targets[0] in TOPOLOGY_ABI_CONSTANTS:
                bound.setdefault(targets[0], []).append(node.value)
        self.assertEqual(set(bound), set(TOPOLOGY_ABI_CONSTANTS))
        for name, values in sorted(bound.items()):
            self.assertEqual([_eval_int(v) for v in values], [self.resolve(TOPOLOGY_ABI_CONSTANTS[name])], name)
        shapes = [n.value for n in module if [ast.unparse(t) for t in n.targets] == ['_KERNEL_DEFAULT_IPV6_ROWS']]
        self.assertEqual(len(shapes), 1)
        self.assertIsInstance(shapes[0], ast.Tuple)
        self.assertEqual(len(shapes[0].elts), len(KERNEL_IPV6_ROW_FLAGS))
        for index, (shape, names) in enumerate(zip(shapes[0].elts, KERNEL_IPV6_ROW_FLAGS)):
            self.assertIsInstance(shape, ast.Tuple, index)
            flags = shape.elts[KERNEL_IPV6_FLAGS_FIELD]
            self.assertEqual((_int_constants(flags), sorted(n.id for n in ast.walk(flags) if isinstance(n, ast.Name))),
                             ([], list(names)), index)
        gateway = [ast.unparse(n) for n in self.nodes('topology.py', '_routes6', ast.BinOp)
                   if isinstance(n.op, ast.BitAnd)]
        self.assertEqual(gateway, ['flags & _RTF_GATEWAY'])
        states = [(type(n.ops[0]).__name__, ast.unparse(n.comparators[0]))
                  for n in self.nodes('topology.py', '_network_rows', ast.Compare) if ast.unparse(n.left) == 'state']
        self.assertEqual(states, [('Eq', '_TCP_LISTEN'), ('Eq', '_TCP_ESTABLISHED')])
        texts = [n.value for n in self.nodes('topology.py', '_network_rows', ast.Constant) if type(n.value) is str]
        self.assertEqual([t for t in texts if re.fullmatch(r'[0-9A-Fa-f]{2}', t)], [])

    def test_policy_literals_are_justified(self):
        for name, (value, reason) in {**POLICY_LITERALS, **R13_LITERALS, **PROBE_POLICY_LITERALS}.items():
            self.assertIs(type(value), int, name)
            self.assertGreater(len(reason), 20, name)
        self.assertFalse(set(POLICY_LITERALS) & set(R13_LITERALS))
        self.assertFalse(set(PROBE_POLICY_LITERALS) & (set(POLICY_LITERALS) | set(R13_LITERALS)))
        self.assertFalse((set(POLICY_LITERALS) | set(R13_LITERALS) | set(PROBE_POLICY_LITERALS)) & set(self.V))

    def test_build_filter_int_constants_are_classified(self):
        V = self.V
        classified = set(V.values()) | POLICY_VALUES | {self.sock_mask, self.op_ld, self.op_ret, self.op_jeq, self.op_and,
                                                        V['SECCOMP_RET_ERRNO'] | V['EPERM'], 255}
        classified |= set(self.offsets)
        stray = [n.value for n in ast.walk(_function(self.trees['confinement.py'], 'build_filter'))
                 if isinstance(n, ast.Constant) and type(n.value) is int and n.value not in classified]
        self.assertEqual(stray, [])

    # --- Task 10: the guest probe catalogue (Option A I1) --------------------------------------------------------------
    def probe_module_values(self):
        """name -> value node of every single-target module-level assignment in the probe; a name bound twice fails."""
        found = {}
        for node in self.nodes(PROBE_FILE, '<module>', ast.Assign):
            if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                self.assertNotIn(node.targets[0].id, found, node.targets[0].id)
                found[node.targets[0].id] = node.value
        return found

    def test_probe_syscall_sites_use_covered_numbers(self):
        """Every syscall(...) site of tests/guest/confinement_probe.py uses a covered number and is a SITE_ARGS row;
        the only non-literal site is the probe context's own trampoline. Option A mutants D (ptrace 117 -> 41) and E
        (recvmsg -> sendmsg) change a bound site."""
        used, opaque = set(), []
        for call in _syscall_calls(self.trees[PROBE_FILE]):
            first = call.args[0] if call.args else None
            if isinstance(first, ast.Constant) and type(first.value) is int:
                self.assertIn(first.value, self.nr_by_value, (PROBE_FILE, call.lineno, first.value))
                used.add(self.nr_by_value[first.value])
            else:
                opaque.append(ast.unparse(call.func))
        self.assertEqual(opaque, ['self.port.b.syscall'])
        self.assertEqual(used, PROBE_SYSCALLS)
        self.assertEqual(len(PROBE_SYSCALLS), 20)
        found = {key: sym for key, (call, sym) in self.site_table().items() if key[0] == PROBE_FILE}
        rows = {key: row[0] for key, row in SITE_ARGS.items() if key[0] == PROBE_FILE}
        self.assertEqual(set(found), set(rows))
        for key, sym in rows.items():
            self.assertEqual(found.get(key), sym, key)
        # The theft family's own sites (T8-01): one each, never folded into another number.
        theft = {sym: [key for key, value in rows.items() if value == sym]
                 for sym in ('__NR_ptrace', '__NR_recvmsg', '__NR_pidfd_open', '__NR_pidfd_getfd', '__NR_process_vm_readv',
                             '__NR_process_vm_writev', '__NR_chroot', '__NR_unshare')}
        self.assertEqual({sym: len(keys) for sym, keys in theft.items()},
                         {'__NR_ptrace': 2, '__NR_recvmsg': 1, '__NR_pidfd_open': 1, '__NR_pidfd_getfd': 1,
                          '__NR_process_vm_readv': 1, '__NR_process_vm_writev': 1, '__NR_chroot': 1, '__NR_unshare': 1})

    def test_probe_errno_signal_and_flag_literals_match_named_symbols(self):
        """The probe's errno, signal and ancillary constants are each bound to their coverage v2 symbol; every accepted
        denial set is named and holds no EBADF (T8-01); every errno, exit-code, signal and (level, kind) comparison and
        every errno the probe raises is exactly as listed, with no integer errno or signal literal; the ptrace
        requests, recvmsg flags and the user-namespace flag are their named symbols, one assertion per site."""
        values = self.probe_module_values()
        for name, symbol in PROBE_ABI_CONSTANTS.items():
            with self.subTest(constant=name):
                self.assertIn(name, values)
                self.assertEqual(_eval_int(values[name]), self.covered(symbol), (name, symbol))
        ebadf = self.covered('EBADF')
        for name, members in PROBE_DENIAL_SETS.items():
            with self.subTest(denial_set=name):
                self.assertIn(name, values)
                self.assertIsInstance(values[name], ast.Tuple)
                self.assertEqual([ast.unparse(e) for e in values[name].elts], list(members))
                resolved = [self.covered(PROBE_ABI_CONSTANTS[member]) for member in members]
                self.assertNotIn(ebadf, resolved, name)
        returns = [ast.unparse(n.value) for n in self.nodes(PROBE_FILE, '_denial_errnos', ast.Return)]
        self.assertEqual(returns, list(PROBE_DENIAL_RETURNS))
        tracked = {'code', '-code', '(level, kind)'}
        found = {}
        for qual, node in self.scoped[PROBE_FILE]:
            if isinstance(node, ast.Compare):
                left = ast.unparse(node.left)
                if left in tracked or 'errno' in left:
                    self.assertEqual(len(node.ops), 1, (qual, ast.unparse(node)))
                    found.setdefault(qual, []).append(node)
        got = {qual: [(ast.unparse(n.left), type(n.ops[0]).__name__, ast.unparse(n.comparators[0]))
                      for n in _source_order(nodes)] for qual, nodes in found.items()}
        self.assertEqual(got, PROBE_ABI_COMPARES)
        raised = []
        for qual, node in self.scoped[PROBE_FILE]:
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.args
                    and (node.func.id.endswith('Error') or node.func.id == '_HelperBoundaryDenied')
                    and node.func.id not in ('ProbeFailure', 'RuntimeGateUnavailable', 'AttributeError', 'TypeError')):
                raised.append((qual, node))
        rows = tuple((qual, node.func.id, ast.unparse(node.args[0]),
                      node.args[1].value if len(node.args) > 1 and isinstance(node.args[1], ast.Constant) else None)
                     for qual, node in sorted(raised, key=lambda pair: (pair[1].lineno, pair[1].col_offset)))
        self.assertEqual(rows, PROBE_ERRNO_RAISES)
        for qual, kind, errno, text in PROBE_ERRNO_RAISES:
            self.assertIn(errno, PROBE_ABI_CONSTANTS, (qual, kind, text))
        sites = self.site_table()
        for key, symbol, index in (((PROBE_FILE, 'NativeProbePort._operation', 10), 'PTRACE_ATTACH', 0),
                                   ((PROBE_FILE, 'NativeProbePort._operation', 11), 'PTRACE_SEIZE', 0),
                                   ((PROBE_FILE, 'NativeProbeContext.receive_rights', 0), 'MSG_CMSG_CLOEXEC', 2),
                                   ((PROBE_FILE, 'NativeProbePort._operation', 15), 'CLONE_NEWUSER', 0)):
            with self.subTest(site=key, symbol=symbol):
                self.assertIn(key, sites)
                self.assertEqual(_eval_int(sites[key][0].args[1 + index]), self.covered(symbol))
        self.assertNotEqual(self.covered('PTRACE_ATTACH'), 0)
        self.assertNotEqual(self.covered('PTRACE_SEIZE'), 0)

    def test_layout_literals_are_justified(self):
        """R13 layout literals of the probe: each module constant is exactly its LAYOUT_LITERALS (or protocol) literal,
        justified from the pinned archive and consistent with the derived layout facts; every struct call names one
        of these formats and binds each of its int-literal arguments."""
        values = self.probe_module_values()
        tables = {**LAYOUT_LITERALS, **PROTOCOL_LITERALS}
        self.assertFalse(set(LAYOUT_LITERALS) & set(PROTOCOL_LITERALS))
        for name, (literal, size, reason) in tables.items():
            with self.subTest(layout=name):
                self.assertIn(name, values)
                self.assertIsInstance(values.get(name), ast.Constant)
                self.assertEqual(values[name].value, literal)
                self.assertGreater(len(reason), 40, name)
                if name in LAYOUT_LITERALS:
                    self.assertRegex(reason, r'linux-6\.8/[A-Za-z0-9_/.-]+\.h:\d+')
                if type(literal) is str:
                    self.assertEqual(struct.calcsize(literal), size, name)
                else:
                    self.assertIsNone(size, name)
        formats = {name for name, node in values.items() if isinstance(node, ast.Constant) and type(node.value) is str
                   and re.fullmatch(r'[<>=!@][0-9A-Za-z]+', node.value)}
        self.assertEqual(formats, {name for name, (literal, *_) in tables.items() if type(literal) is str})
        layout = {name: literal for name, (literal, *_) in tables.items()}
        # Derived facts: offsets and sizes follow from the formats and the covered capability count.
        long_bytes = struct.calcsize('<q')
        self.assertEqual(layout['_MSG_IOV'], struct.calcsize('<Qi4x'))
        self.assertEqual(layout['_MSG_CONTROL'], struct.calcsize('<Qi4xQQ'))
        self.assertEqual(layout['_USER_MSGHDR'][:len('<Qi4xQQ')], '<Qi4xQQ')
        self.assertEqual(layout['_CMSG_ONE_FD'], struct.calcsize(layout['_CMSGHDR'])
                         + -(-struct.calcsize(layout['_SCM_FD']) // long_bytes) * long_bytes)
        self.assertEqual(layout['_SUN_PATH_OFFSET'], struct.calcsize('<H'))
        self.assertEqual(layout['_SUN_PATH_BYTES'], struct.calcsize(layout['_SOCKADDR_UN']) - layout['_SUN_PATH_OFFSET'])
        self.assertEqual(struct.calcsize(layout['_CAPSET_DATA']), R13_LITERALS['CAPSET_DATA_BYTES'][0])
        self.assertEqual(struct.calcsize(layout['_CAPSET_DATA']), 3 * 4 * self.covered('_LINUX_CAPABILITY_U32S_3'))
        for name in ('_SOCKADDR_VM', '_SOCKADDR_IN'):
            self.assertEqual(struct.calcsize(layout[name]), 16, name)  # sizeof(struct sockaddr), in.h:255
        # Every struct.* call: a named format, and each int-literal argument named exactly.
        calls = {}
        for qual, node in self.scoped[PROBE_FILE]:
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and isinstance(node.func.value, ast.Name) and node.func.value.id == 'struct'):
                calls.setdefault(qual, []).append(node)
        found = {(qual, n): call for qual, nodes in calls.items() for n, call in enumerate(_source_order(nodes))}
        self.assertEqual(set(found), set(PROBE_PACK_VALUES))
        for key, call in found.items():
            fmt, named = PROBE_PACK_VALUES[key]
            with self.subTest(struct_call=key):
                self.assertIsInstance(call.args[0], ast.Name)
                self.assertEqual(call.args[0].id, fmt)
                self.assertIn(fmt, tables)
                literal = {i: _eval_int(a) for i, a in enumerate(call.args[1:]) if _eval_int(a) is not None}
                self.assertEqual(set(literal), set(named))
                for index, name in named.items():
                    self.assertEqual(literal[index], self.resolve_at((PROBE_FILE,) + key, name), (key, index, name))


if __name__ == '__main__':
    unittest.main()

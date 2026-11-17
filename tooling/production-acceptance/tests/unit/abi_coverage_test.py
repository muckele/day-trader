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
COVERAGE_V2_SHA = '271e5d7ae4621f81b058f9b29d656207bb12a77b3ecced94723b5bef0a651f84'
EVENT_REFERENCE = ROOT / 'appliance/bootstrap-event-reference.json'
EVENT_REFERENCE_SHA = 'a2e1be5762976e07f270c6646ce5e4d94c48efcc2c78dacaf29ed3e32471be7d'
ORACLES_PATH = Path(__file__).resolve().parent / 'abi_oracles.py'


def load_oracles():
    """ORACLES: dict[str, int], transcribed from header text by an agent independent of the deriver and inventory."""
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


GUEST = ROOT / 'guest'
_conf_spec = importlib.util.spec_from_file_location('abi_coverage_confinement', GUEST / 'confinement.py')
confinement = importlib.util.module_from_spec(_conf_spec)
sys.modules[_conf_spec.name] = confinement
_conf_spec.loader.exec_module(confinement)

# Deny list in program order (24 inventoried symbols).
DENY_ORDER = tuple('__NR_' + n for n in (
    'io_uring_setup io_uring_enter io_uring_register ptrace process_vm_readv process_vm_writev pidfd_getfd pidfd_open '
    'capset setregid setgid setreuid setuid setresuid setresgid setfsuid setfsgid setgroups setns mknodat umount2 mount '
    'pivot_root chroot').split())
DENY_SYMBOLS = frozenset(DENY_ORDER)

# syscall symbol -> files whose native syscall(...) call sites invoke it (R6). Direct call sites only: the BPF deny list
# and socketpair appear in the filter but are not called.
SYSCALL_SITES = {
    '__NR_capset': frozenset({'confinement.py'}),
    '__NR_close_range': frozenset({'confinement.py'}),
    '__NR_connect': frozenset({'topology.py'}),
    '__NR_fcntl': frozenset({'confinement.py'}),
    '__NR_mount': frozenset({'confinement.py'}),
    '__NR_prctl': frozenset({'confinement.py'}),
    '__NR_seccomp': frozenset({'confinement.py'}),
    '__NR_sendto': frozenset({'topology.py'}),
    '__NR_setgroups': frozenset({'confinement.py'}),
    '__NR_setresgid': frozenset({'confinement.py'}),
    '__NR_setresuid': frozenset({'confinement.py'}),
    '__NR_socket': frozenset({'topology.py'}),
    '__NR_unshare': frozenset({'confinement.py'}),
    '__NR_write': frozenset({'topology.py'}),
}

# syscall symbol -> argument index (after the number; equals seccomp args[i]) -> covered symbols whose values the
# literal at that index (or the filter comparison on args[i] low word) may take. Used both by the native call sites
# and, as an upper bound, by the BPF filter.
_PRCTL_OPTIONS = frozenset({'PR_SET_KEEPCAPS', 'PR_SET_SECUREBITS', 'PR_SET_NO_NEW_PRIVS', 'PR_SET_DUMPABLE',
                            'PR_CAP_AMBIENT', 'PR_SET_SECCOMP', 'PR_CAPBSET_DROP'})
_SOCKET_ARGS = {0: frozenset({'AF_UNIX', 'AF_INET', 'AF_INET6', 'AF_VSOCK'}),
                1: frozenset({'SOCK_STREAM', 'SOCK_DGRAM', 'SOCK_SEQPACKET'})}
ARG_SYMBOLS = {
    '__NR_fcntl': {1: frozenset({'F_DUPFD_CLOEXEC'})},
    '__NR_mount': {3: frozenset({'MS_PRIVATE', 'MS_REC', 'MS_BIND', 'MS_REMOUNT', 'MS_RDONLY', 'MS_NOSUID', 'MS_NODEV',
                                 'MS_NOEXEC'})},
    '__NR_prctl': {0: _PRCTL_OPTIONS,
                   1: frozenset({'SUID_DUMP_DISABLE', 'PR_CAP_AMBIENT_RAISE', 'PR_CAP_AMBIENT_CLEAR_ALL',
                                 'SECCOMP_MODE_FILTER'})},
    '__NR_seccomp': {0: frozenset({'SECCOMP_SET_MODE_FILTER'}), 1: frozenset({'SECCOMP_FILTER_FLAG_TSYNC'})},
    '__NR_unshare': {0: frozenset({'CLONE_NEWNS', 'CLONE_NEWPID', 'CLONE_NEWIPC'})},
    '__NR_socket': _SOCKET_ARGS,
    '__NR_socketpair': _SOCKET_ARGS,
}
# Literals that are policy choices, not ABI values: name -> (value, one-line justification). Each genuine use is named
# at its own site (SITE_ARGS / the expected filter program); there is no catch-all "any policy value" acceptance.
POLICY_LITERALS = {
    'NR_HIGH_BITS_MASK': (0xc0000000, 'syscall-number high-bit mask: numbers with bits 30-31 set (x32-style/negative) are killed; no AArch64 header constant'),
    'NR_MASKED_CLEAN': (0, 'expected result of the nr high-bit mask: no high bits set'),
    'HIGH_WORD_ZERO': (0, 'every constrained scalar argument must have a zero upper 32-bit word'),
    'PROTOCOL_DEFAULT': (0, 'socket protocol fails closed to the default scalar 0; no IPPROTO_* constant is consumed'),
    'SECCOMP_NO_FLAGS': (0, 'seccomp(2) flags value meaning no flags'),
    'NNP_ENABLE': (1, 'PR_SET_NO_NEW_PRIVS arg is the boolean 1; the kernel tests it literally'),
    'FD_FLOOR': (64, 'lowest descriptor for F_DUPFD_CLOEXEC, above the audited FD0..4'),
    'CLOSE_RANGE_MAX': (4294967295, 'close_range upper bound ~0U meaning all remaining descriptors; unsigned-int maximum'),
    'CLOSE_RANGE_NO_FLAGS': (0, 'close_range flags: none'),
    'EMPTY_GROUP_LIST': (0, 'setgroups(0, NULL): empty supplementary-group list'),
    'UNUSED_ARG': (0, 'unused trailing prctl argument must be zero; no symbol exists'),
    'PROBE_PAYLOAD_LEN': (6, 'length of the fixed probe payload b"TASK10"'),
    'SENDTO_NO_FLAGS': (0, 'sendto flags value meaning no flags'),
    'CAPSET_HEADER_PID': (0, 'capset header pid 0 means the calling thread'),
    'LOWER_BOUND_ZERO': (0, 'lower bound of the jt/jf range and of the program length'),
    'BPF_JUMP_BASE': (-1, 'classic-BPF jumps are relative to the next instruction: jt = target - index - 1'),
}
POLICY_VALUES = frozenset(v for v, _ in POLICY_LITERALS.values())

# Exact per-site bindings for native syscall(...) calls: (file, enclosing qualname, ordinal in source order among the
# syscall calls with a literal number in that function) -> (nr symbol, {arg index: expected}). expected is a frozenset
# of covered symbols whose values OR to exactly the literal (a single symbol means equality), or a str naming a
# POLICY_LITERALS entry. Every int-literal argument must be listed and no other.
def _s(*names):
    return frozenset(names)

_PRCTL_ZERO = {2: 'UNUSED_ARG', 3: 'UNUSED_ARG', 4: 'UNUSED_ARG'}
SITE_ARGS = {
    ('confinement.py', 'LinuxBindings.pin_programs', 0): ('__NR_fcntl', {1: _s('F_DUPFD_CLOEXEC'), 2: 'FD_FLOOR'}),
    ('confinement.py', 'LinuxBindings.pin_sample', 0): ('__NR_fcntl', {1: _s('F_DUPFD_CLOEXEC'), 2: 'FD_FLOOR'}),
    ('confinement.py', 'NativeChildPort.establish_views', 0): ('__NR_mount', {3: _s('MS_PRIVATE', 'MS_REC')}),
    ('confinement.py', 'NativeChildPort.establish_views', 1): ('__NR_mount', {3: _s('MS_BIND')}),
    ('confinement.py', 'NativeChildPort.establish_views', 2): ('__NR_mount', {3: _s('MS_BIND', 'MS_REMOUNT', 'MS_RDONLY')}),
    ('confinement.py', 'NativeChildPort.establish_views', 3): ('__NR_mount', {3: _s('MS_BIND')}),
    ('confinement.py', 'NativeChildPort.establish_views', 4): ('__NR_mount', {3: _s('MS_BIND')}),
    ('confinement.py', 'NativeChildPort.establish_views', 5): ('__NR_mount', {3: _s('MS_NOSUID', 'MS_NODEV', 'MS_NOEXEC')}),
    ('confinement.py', 'NativeChildPort.close_unaudited_fds', 0): ('__NR_close_range', {2: 'CLOSE_RANGE_NO_FLAGS'}),
    ('confinement.py', 'NativeChildPort.close_unaudited_fds', 1): ('__NR_close_range', {1: 'CLOSE_RANGE_MAX', 2: 'CLOSE_RANGE_NO_FLAGS'}),
    ('confinement.py', 'NativeChildPort.drop_credentials', 0): ('__NR_setgroups', {0: 'EMPTY_GROUP_LIST', 1: 'EMPTY_GROUP_LIST'}),
    ('confinement.py', 'NativeChildPort.drop_credentials', 1): ('__NR_prctl', {0: _s('PR_CAP_AMBIENT'), 1: _s('PR_CAP_AMBIENT_CLEAR_ALL'), **_PRCTL_ZERO}),
    ('confinement.py', 'NativeChildPort.drop_credentials', 2): ('__NR_prctl', {0: _s('PR_CAPBSET_DROP'), **_PRCTL_ZERO}),
    ('confinement.py', 'NativeChildPort.drop_credentials', 3): ('__NR_setresgid', {}),
    ('confinement.py', 'NativeChildPort.drop_credentials', 4): ('__NR_setresuid', {}),
    ('confinement.py', 'NativeChildPort.clear_capabilities', 0): ('__NR_capset', {}),
    ('confinement.py', 'NativeChildPort.no_new_privs', 0): ('__NR_prctl', {0: _s('PR_SET_NO_NEW_PRIVS'), 1: 'NNP_ENABLE', **_PRCTL_ZERO}),
    ('confinement.py', 'NativeChildPort.install_seccomp', 0): ('__NR_seccomp', {0: _s('SECCOMP_SET_MODE_FILTER')}),
    ('confinement.py', 'NativeKernelPort.spawn_waiting', 0): ('__NR_unshare', {0: _s('CLONE_NEWNS', 'CLONE_NEWPID', 'CLONE_NEWIPC')}),
    ('topology.py', 'Task10NativeAttempts.execute_native.attempt', 0): ('__NR_socket', {2: 'PROTOCOL_DEFAULT'}),
    ('topology.py', 'Task10NativeAttempts.execute_native.attempt', 1): ('__NR_connect', {}),
    ('topology.py', 'Task10NativeAttempts.execute_native.attempt', 2): ('__NR_write', {2: 'PROBE_PAYLOAD_LEN'}),
    ('topology.py', 'Task10NativeAttempts.execute_native.attempt', 3): ('__NR_sendto', {2: 'PROBE_PAYLOAD_LEN', 3: 'SENDTO_NO_FLAGS'}),
}
# SYSCALL_SITES is derived from the per-site table (nr symbol -> files); the test also checks it against the AST.


def _coverage():
    data = json.loads(COVERAGE_V2.read_bytes())
    return data, {r['id']: r['value'] for r in data['records']}


def _eval_int(node):
    """Int literal or OR of int literals, else None."""
    if isinstance(node, ast.Constant) and type(node.value) is int:
        return node.value
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
    """Binds every ABI literal in guest/confinement.py (build_filter, native syscall sites) and guest/topology.py
    (the socket probe sites) to the committed coverage v2, or to an explicit POLICY_LITERALS entry.

    Known uncovered ABI surface (ruling R13), deliberately NOT tested here: capset struct sizes (the factor 12 in
    bytearray(24); the count factor 2 is covered by _LINUX_CAPABILITY_U32S_3), struct sock_fprog, sockaddr_in and
    sockaddr_in6, O_NOFOLLOW, and the errno set outside topology.py:2987-2997.
    """

    @classmethod
    def setUpClass(cls):
        cls.cov, cls.V = _coverage()
        V = cls.V
        cls.nr_by_value = {v: k for k, v in V.items() if k.startswith('__NR_')}
        assert len(cls.nr_by_value) == sum(1 for k in V if k.startswith('__NR_'))
        cls.trees = {name: ast.parse((GUEST / name).read_text()) for name in ('confinement.py', 'topology.py')}
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
        plus the named flag/protocol/NNP policy scalars. (Secondary check; the exact program comparison is authoritative.)"""
        allowed = {POLICY_LITERALS[n][0] for n in ('PROTOCOL_DEFAULT', 'SECCOMP_NO_FLAGS', 'NNP_ENABLE')}
        owners = 0
        for j, (code, jt, jf, k), offset, m in self.walk(program):
            if code == self.op_jeq and offset == self.V['seccomp_data.nr'] and not m and jt and j + 1 + jt != len(program) - 1:
                if index in self.reach(program, j + 1 + jt):
                    owners += 1
                    sym = self.nr_by_value[k]
                    allowed |= self.values(ARG_SYMBOLS.get(sym, {}).get(arg_index, ()))
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
        for sym in DENY_ORDER:
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
        ld(hi(1)); req(P['HIGH_WORD_ZERO']); ld(lo(1)); eq(P['SECCOMP_NO_FLAGS'], yes='allow')
        eq(V['SECCOMP_FILTER_FLAG_TSYNC'], yes='allow'); ret(ERR)
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
        lab('ip'); ld(lo(2)); req(P['PROTOCOL_DEFAULT']); ld(lo(1)); mask(self.sock_mask)
        eq(V['SOCK_STREAM'], yes='allow'); eq(V['SOCK_DGRAM'], yes='allow'); ret(ERR)
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
        expected = {self.V[s] for s in DENY_SYMBOLS}
        self.assertEqual(len(DENY_SYMBOLS), 24)
        for role, program in self.programs().items():
            deny = len(program) - 1
            self.assertEqual(program[deny][3], self.V['SECCOMP_RET_ERRNO'] | self.V['EPERM'])
            got = {k for i, (code, jt, jf, k), off, masked in self.walk(program)
                   if code == self.op_jeq and off == self.V['seccomp_data.nr'] and not masked and jt and i + 1 + jt == deny}
            self.assertEqual(got, expected, role)

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
        # the single non-literal site is the libc trampoline that receives the number as a parameter
        self.assertEqual(opaque, [('confinement.py', 'self._libc.syscall')])
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
                    found[(fname, qual, n)] = (call, self.nr_by_value[call.args[0].value])
        return found

    def test_per_site_table_keys_and_numbers_match_the_code_exactly(self):
        found = self.site_table()
        self.assertEqual(set(found), set(SITE_ARGS))
        for key, (call, sym) in found.items():
            self.assertEqual(sym, SITE_ARGS[key][0], key)
        derived = {}
        for (fname, _, _), (nr, _) in SITE_ARGS.items():
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
                    self.assertEqual(literal[idx], POLICY_LITERALS[want][0], where)
                else:
                    acc = 0
                    for name in sorted(want):
                        self.assertEqual(acc & self.V[name], 0, where)  # flag symbols are disjoint bits
                        acc |= self.V[name]
                    self.assertEqual(literal[idx], acc, where)
                    self.assertLessEqual(want, ARG_SYMBOLS[sym][idx], where)
                checked += 1
        self.assertEqual(checked, 35)  # every int-literal argument at every site

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

    def test_topology_probe_literals_are_covered(self):
        tree = self.trees['topology.py']
        fn = next(f for f in ast.walk(tree) if isinstance(f, ast.FunctionDef) and any(
            isinstance(c.args[0], ast.Constant) and c.args[0].value == self.V['__NR_socket'] for c in _syscall_calls(f)))
        packs = [n.args[1].value for n in ast.walk(fn) if isinstance(n, ast.Call) and ast.unparse(n.func) == 'struct.pack'
                 and n.args[0].value == '<H' and isinstance(n.args[1], ast.Constant)]
        self.assertEqual(sorted(packs), sorted([self.V['AF_INET'], self.V['AF_INET6']]))
        cmps = {n.left.id: n.comparators[0].value for n in ast.walk(fn) if isinstance(n, ast.Compare)
                and isinstance(n.left, ast.Name) and n.left.id in ('family', 'kind') and isinstance(n.ops[0], ast.Eq)}
        self.assertEqual(cmps, {'family': self.V['AF_INET'], 'kind': self.V['SOCK_STREAM']})

    def test_policy_literals_are_justified(self):
        for name, (value, reason) in POLICY_LITERALS.items():
            self.assertIs(type(value), int, name)
            self.assertGreater(len(reason), 20, name)

    def test_build_filter_int_constants_are_classified(self):
        V = self.V
        classified = set(V.values()) | POLICY_VALUES | {self.sock_mask, self.op_ld, self.op_ret, self.op_jeq, self.op_and,
                                                        V['SECCOMP_RET_ERRNO'] | V['EPERM'], 255}
        classified |= set(self.offsets)
        stray = [n.value for n in ast.walk(_function(self.trees['confinement.py'], 'build_filter'))
                 if isinstance(n, ast.Constant) and type(n.value) is int and n.value not in classified]
        self.assertEqual(stray, [])


if __name__ == '__main__':
    unittest.main()

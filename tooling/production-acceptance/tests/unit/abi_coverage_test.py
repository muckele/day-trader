"""DeriverTests use synthetic in-memory tar.xz fixtures only.

CoverageTests stream the pinned, retained Linux 6.8 archive through the deriver (never extracted). A missing or
changed archive is a test error, never a skip. ORACLES come from the independently transcribed abi_oracles.py.
"""
import hashlib
import importlib.util
import io
import json
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


if __name__ == '__main__':
    unittest.main()

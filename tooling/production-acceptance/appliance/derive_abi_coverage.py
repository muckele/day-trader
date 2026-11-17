"""Offline Linux ABI coverage deriver: streams named headers out of a retained tar.xz, never extracts."""
import argparse
import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path

DERIVED_BY = 'tooling/production-acceptance/appliance/derive_abi_coverage.py'
LOST_COVERAGE_SHA256 = '7c8714c95a67d8a2e6c1b4c8b8481525a61976c81dfe2037c251add071ac9898'
MAX_MEMBER_BYTES = 1 << 20
MAX_DEPTH = 16
CODES = ('ARCHIVE_MISMATCH', 'MEMBER_MISSING', 'MEMBER_DUPLICATE', 'SYMBOL_MISSING', 'SYMBOL_AMBIGUOUS',
         'EXPRESSION_UNSUPPORTED', 'LAYOUT_UNSUPPORTED', 'INVENTORY_INVALID')
SCALARS = {'__u8': 1, '__u16': 2, '__u32': 4, '__u64': 8, '__s32': 4, 'int': 4}  # natural alignment == size (AAPCS64)
C_WORDS = {'sizeof', 'int', 'long', 'short', 'char', 'unsigned', 'signed', 'void', 'struct', 'union', 'enum',
           'float', 'double', 'typeof', '__u8', '__u16', '__u32', '__u64', '__s32', '__s64', '__s8', '__s16'}


class AbiCoverageError(Exception):
    def __init__(self, code):
        assert code in CODES
        super().__init__(code)
        self.code = code


def _fail(code):
    raise AbiCoverageError(code)


# ---------------------------------------------------------------- member parsing
def _logical_lines(text):
    """Yield (first, last, raw_text, code_text): backslash continuations joined, comments blanked."""
    raw = text.split('\n')
    if raw and raw[-1] == '':
        raw.pop()
    out, i, in_comment = [], 0, False
    while i < len(raw):
        first, parts = i + 1, [raw[i]]
        while parts[-1].endswith('\\') and i + 1 < len(raw):
            i += 1
            parts.append(raw[i])
        code, joined, k = [], '\n'.join(parts), 0
        joined_code = ' '.join(p[:-1] if p.endswith('\\') else p for p in parts)
        while k < len(joined_code):
            if in_comment:
                end = joined_code.find('*/', k)
                if end < 0:
                    k = len(joined_code)
                else:
                    in_comment, k = False, end + 2
                    code.append(' ')
            elif joined_code.startswith('/*', k):
                in_comment, k = True, k + 2
            elif joined_code.startswith('//', k):
                break
            else:
                code.append(joined_code[k])
                k += 1
        out.append((first, i + 1, joined, ''.join(code).strip()))
        i += 1
    return out


def parse_member(text):
    """Return {'defs': [...], 'structs': [...]}; each carries the preprocessor condition stack at its start."""
    defs, structs, stack = [], [], []
    lines, i, enum_open = _logical_lines(text), 0, False
    while i < len(lines):
        first, last, raw, code = lines[i]
        i += 1
        if code.startswith('#'):
            d = re.match(r'#\s*(\w+)', code)
            word = d.group(1) if d else ''
            if word in ('if', 'ifdef', 'ifndef'):
                stack.append(code)
            elif word in ('else', 'elif'):
                if not stack:
                    _fail('EXPRESSION_UNSUPPORTED')
                stack[-1] = code
            elif word == 'endif':
                if not stack:
                    _fail('EXPRESSION_UNSUPPORTED')
                stack.pop()
            elif word == 'define':
                m = re.match(r'#\s*define\s+([A-Za-z_]\w*)(?!\()\s+(.+)$', code)
                if m:
                    defs.append(dict(kind='define', name=m.group(1), expr=m.group(2), first=first, last=last,
                                     decl=raw, stack=tuple(stack)))
            continue
        sm = re.match(r'struct\s+(\w+)\s*\{(.*)$', code)
        if sm:
            body, s_first, s_last, s_raw, s_stack = sm.group(2), first, last, [raw], tuple(stack)
            while '}' not in body and i < len(lines):
                _, s_last, r2, c2 = lines[i]
                i += 1
                body += ' ' + c2
                s_raw.append(r2)
            structs.append(dict(name=sm.group(1), body=body.split('}')[0], first=s_first, last=s_last,
                                decl='\n'.join(s_raw), stack=s_stack))
            continue
        if re.search(r'\benum\b[^;{]*\{', code) or enum_open:
            enum_open = True
            body = code.split('{', 1)[1] if '{' in code else code
            if '}' in body:
                body, enum_open = body.split('}')[0], False
            for item in body.split(','):
                em = re.match(r'\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$', item)
                if em:
                    defs.append(dict(kind='enum', name=em.group(1), expr=em.group(2), first=first, last=last,
                                     decl=raw, stack=tuple(stack)))
    return {'defs': defs, 'structs': structs}


# ---------------------------------------------------------------- expression evaluator
_TOKEN = re.compile(r'\s*(?:(0[xX][0-9a-fA-F]+|[0-9]+)([uUlL]*)|([A-Za-z_]\w*)|(<<|>>|[-+~|&^()]))')
_SUFFIX = re.compile(r'(?:[uU](?:ll|LL|[lL])?|(?:ll|LL|[lL])[uU]?)?')


def _tokenize(expr):
    toks, pos = [], 0
    while pos < len(expr) and expr[pos:].strip():
        m = _TOKEN.match(expr, pos)
        if not m:
            _fail('EXPRESSION_UNSUPPORTED')
        pos = m.end()
        if m.group(1) is not None:
            num, suf = m.group(1), m.group(2)
            if not _SUFFIX.fullmatch(suf):
                _fail('EXPRESSION_UNSUPPORTED')
            if num[:2] in ('0x', '0X'):
                val = int(num, 16)
            elif len(num) > 1 and num[0] == '0':
                if not re.fullmatch('[0-7]+', num):
                    _fail('EXPRESSION_UNSUPPORTED')
                val = int(num, 8)
            else:
                val = int(num)
            toks.append(('num', val))
        elif m.group(3) is not None:
            toks.append(('id', m.group(3)))
        else:
            toks.append(('op', m.group(4)))
    return toks


_PREC = {'|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5}


class _Parser:
    def __init__(self, toks, lookup):
        self.t, self.p, self.lookup = toks, 0, lookup

    def peek(self):
        return self.t[self.p] if self.p < len(self.t) else (None, None)

    def take(self):
        tok = self.peek()
        self.p += 1
        return tok

    def expect(self, op):
        if self.take() != ('op', op):
            _fail('EXPRESSION_UNSUPPORTED')

    def parse(self):
        v = self.binary(1)
        if self.p != len(self.t):
            _fail('EXPRESSION_UNSUPPORTED')
        return v

    def binary(self, min_prec):
        left = self.unary()
        while True:
            kind, op = self.peek()
            prec = _PREC.get(op) if kind == 'op' else None
            if prec is None or prec < min_prec:
                return left
            self.take()
            right = self.binary(prec + 1)
            if op in ('<<', '>>') and not 0 <= right < 128:
                _fail('EXPRESSION_UNSUPPORTED')
            left = {'|': lambda: left | right, '^': lambda: left ^ right, '&': lambda: left & right,
                    '+': lambda: left + right, '-': lambda: left - right, '<<': lambda: left << right,
                    '>>': lambda: left >> right}[op]()

    def unary(self):
        kind, val = self.take()
        if kind == 'num':
            return val
        if kind == 'op' and val in '-~' and val:
            v = self.unary()
            return -v if val == '-' else ~v
        if kind == 'op' and val == '(':
            v = self.binary(1)
            self.expect(')')
            return v
        if kind == 'id':
            if val in C_WORDS:
                _fail('EXPRESSION_UNSUPPORTED')
            if val in ('_BITUL', '_UL'):
                self.expect('(')
                n = self.binary(1)
                self.expect(')')
                if not 0 <= n < 64:
                    _fail('EXPRESSION_UNSUPPORTED')
                return 1 << n
            if self.peek() == ('op', '('):
                _fail('EXPRESSION_UNSUPPORTED')
            return self.lookup(val)
        _fail('EXPRESSION_UNSUPPORTED')


# ---------------------------------------------------------------- archive and derivation
def _read_members(archive, wanted):
    sha = hashlib.sha256()
    with open(archive, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            sha.update(chunk)
    found = {}
    try:
        with tarfile.open(archive, 'r|xz') as tar:
            for info in tar:
                if info.name not in wanted:
                    continue
                if info.name in found:
                    _fail('MEMBER_DUPLICATE')
                if not info.isreg() or info.size > MAX_MEMBER_BYTES:
                    _fail('ARCHIVE_MISMATCH')
                data = tar.extractfile(info).read(MAX_MEMBER_BYTES + 1)
                if len(data) > MAX_MEMBER_BYTES or b'\0' in data:
                    _fail('ARCHIVE_MISMATCH')
                found[info.name] = data
    except (tarfile.TarError, EOFError, OSError):
        _fail('ARCHIVE_MISMATCH')
    return sha.hexdigest(), found


def _check_inventory(inv):
    base = {'id', 'memberPath', 'kind', 'conditions', 'width', 'signed'}
    if not isinstance(inv, dict) or set(inv) != {'version', 'entries'} or inv['version'] != 1 \
            or not isinstance(inv['entries'], list):
        _fail('INVENTORY_INVALID')
    ids = set()
    for e in inv['entries']:
        if not isinstance(e, dict) or e.get('kind') not in ('define', 'enum', 'layout'):
            _fail('INVENTORY_INVALID')
        if set(e) != base | ({'struct', 'field'} if e['kind'] == 'layout' else set()):
            _fail('INVENTORY_INVALID')
        if not (isinstance(e['id'], str) and isinstance(e['memberPath'], str) and e['id'] not in ids
                and isinstance(e['conditions'], list) and all(isinstance(c, str) for c in e['conditions'])
                and e['width'] in (16, 32, 64) and isinstance(e['signed'], bool)):
            _fail('INVENTORY_INVALID')
        if e['kind'] == 'layout' and not (isinstance(e['struct'], str) and (e['field'] is None or isinstance(e['field'], str))):
            _fail('INVENTORY_INVALID')
        ids.add(e['id'])


def _pick(candidates, conditions):
    hits = [c for c in candidates if list(c['stack']) == conditions]
    if len(hits) > 1:
        _fail('SYMBOL_AMBIGUOUS')
    if not hits:
        # An unpinned lookup that faces several conditional alternatives is ambiguous, not absent.
        _fail('SYMBOL_AMBIGUOUS' if not conditions and len(candidates) > 1 else 'SYMBOL_MISSING')
    return hits[0]


def _layout(struct, field):
    offset, align, fields = 0, 1, {}
    for decl in (d.strip() for d in struct['body'].split(';')):
        if not decl:
            continue
        m = re.fullmatch(r'(\w+)\s+([A-Za-z_]\w*)\s*(?:\[\s*([^\]]+?)\s*\])?', decl)
        if not m or m.group(1) not in SCALARS:
            _fail('LAYOUT_UNSUPPORTED')
        size = SCALARS[m.group(1)]
        count = 1
        if m.group(3) is not None:
            try:
                count = _Parser(_tokenize(m.group(3)), lambda n: _fail('LAYOUT_UNSUPPORTED')).parse()
            except AbiCoverageError:
                _fail('LAYOUT_UNSUPPORTED')
            if count <= 0:
                _fail('LAYOUT_UNSUPPORTED')
        offset = -(-offset // size) * size
        fields[m.group(2)] = offset
        offset += size * count
        align = max(align, size)
    return fields, -(-offset // align) * align


def derive(archive, inventory, *, archive_sha256):
    _check_inventory(inventory)
    entries = inventory['entries']
    digest, raw = _read_members(Path(archive), {e['memberPath'] for e in entries})
    if digest != archive_sha256:
        _fail('ARCHIVE_MISMATCH')
    parsed, hashes = {}, {}
    for e in entries:
        if e['memberPath'] not in raw:
            _fail('MEMBER_MISSING')
    for name, data in raw.items():
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            _fail('ARCHIVE_MISMATCH')
        parsed[name], hashes[name] = parse_member(text), hashlib.sha256(data).hexdigest()
    by_id = {e['id']: e for e in entries}

    def find_def(entry):
        cands = [x for x in parsed[entry['memberPath']]['defs'] if x['name'] == entry['id'] and x['kind'] == entry['kind']]
        return _pick(cands, entry['conditions'])

    def value_of(d, member, depth):
        if depth > MAX_DEPTH:
            _fail('EXPRESSION_UNSUPPORTED')

        def lookup(name):
            same = [x for x in parsed[member]['defs'] if x['name'] == name]
            if len(same) == 1:
                return value_of(same[0], member, depth + 1)
            inv = by_id.get(name)
            if inv is not None and inv['kind'] != 'layout' and (not same or inv['memberPath'] == member):
                return value_of(_pick([x for x in parsed[inv['memberPath']]['defs'] if x['name'] == name and x['kind'] == inv['kind']],
                                      inv['conditions']), inv['memberPath'], depth + 1)
            _fail('SYMBOL_AMBIGUOUS' if same else 'SYMBOL_MISSING')
        return _Parser(_tokenize(d['expr']), lookup).parse()

    records = []
    for e in entries:
        member = e['memberPath']
        if e['kind'] == 'layout':
            cands = [s for s in parsed[member]['structs'] if s['name'] == e['struct']]
            src = _pick(cands, e['conditions'])
            fields, size = _layout(src, e['field'])
            if e['field'] is None:
                value = size
            elif e['field'] in fields:
                value = fields[e['field']]
            else:
                _fail('SYMBOL_MISSING')
            first, last, decl = src['first'], src['last'], src['decl']
        else:
            src = find_def(e)
            value = value_of(src, member, 0)
            first, last, decl = src['first'], src['last'], src['decl']
        lo, hi = (-(1 << (e['width'] - 1)), (1 << (e['width'] - 1)) - 1) if e['signed'] else (0, (1 << e['width']) - 1)
        if not lo <= value <= hi:
            _fail('INVENTORY_INVALID')
        records.append({'id': e['id'], 'memberPath': member, 'memberSHA256': hashes[member], 'firstLine': first,
                        'lastLine': last, 'declaration': decl, 'conditions': list(e['conditions']), 'value': value,
                        'width': e['width'], 'signed': e['signed']})
    records.sort(key=lambda r: r['id'])
    return {'version': 1, 'sourceArchiveSHA256': archive_sha256, 'supersedesLostCoverageSHA256': LOST_COVERAGE_SHA256,
            'derivedBy': DERIVED_BY, 'records': records}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--archive', required=True)
    ap.add_argument('--inventory', required=True)
    ap.add_argument('--output', required=True)
    args = ap.parse_args(argv)
    try:
        try:
            inventory = json.loads(Path(args.inventory).read_text())
        except (OSError, ValueError):
            _fail('INVENTORY_INVALID')
        try:
            sha = hashlib.sha256(Path(args.archive).read_bytes()).hexdigest()
        except OSError:
            _fail('ARCHIVE_MISMATCH')
        out = derive(Path(args.archive), inventory, archive_sha256=sha)
        try:
            with open(args.output, 'x') as f:
                f.write(json.dumps(out, sort_keys=True, indent=2, ensure_ascii=True) + '\n')
        except OSError:
            _fail('INVENTORY_INVALID')  # closed code set: existing/unwritable output is refused
    except AbiCoverageError as e:
        print(e.code)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())

"""Strict offline acceptance wire codec. Receipt timestamps are Unix milliseconds."""
import json
import pathlib
import re

class InvalidFrame(ValueError):
    pass

_SCHEMA = json.loads((pathlib.Path(__file__).resolve().parents[1] / 'contracts/schema.json').read_text())

def _invalid():
    raise InvalidFrame('INVALID_FRAME')

def _pairs(items):
    result = {}
    for key, value in items:
        if key in result: _invalid()
        result[key] = value
    return result

def _integer(token):
    if token == '-0': _invalid()
    value = int(token)
    if abs(value) > 9007199254740991: _invalid()
    return value

def _depth(text):
    # Bound nesting before the standard parser allocates recursive containers.
    depth = 0; quoted = False; escaped = False
    for c in text:
        if quoted:
            if escaped: escaped = False
            elif c == '\\': escaped = True
            elif c == '"': quoted = False
        elif c == '"': quoted = True
        elif c in '[{':
            depth += 1
            if depth > _SCHEMA['maxDepth']: _invalid()
        elif c in ']}': depth -= 1

def _check(value, rule, depth=0):
    if depth > 16: _invalid()
    if 'ref' in rule: return _check(value, _SCHEMA['definitions'][rule['ref']], depth+1)
    kind = rule['type']
    if kind == 'object':
        if type(value) is not dict or value.keys() != rule['fields'].keys(): _invalid()
        for key, field in rule['fields'].items(): _check(value[key], field, depth+1)
    elif kind == 'array':
        if type(value) is not list or not rule['min'] <= len(value) <= rule['max']: _invalid()
        for item in value: _check(item, rule['item'], depth+1)
    elif kind == 'union':
        if type(value) is not dict or type(value.get(rule['tag'])) is not str or value[rule['tag']] not in rule['variants']: _invalid()
        _check(value, rule['variants'][value[rule['tag']]], depth+1)
    elif kind == 'enum':
        if not any(type(v) is type(value) and v == value for v in rule['values']): _invalid()
    elif kind == 'string':
        if type(value) is not str or len(value) > rule['max'] or re.fullmatch(rule['pattern'], value) is None: _invalid()
    elif kind == 'integer':
        if type(value) is not int or not rule['min'] <= value <= rule['max']: _invalid()
    elif kind == 'boolean':
        if type(value) is not bool: _invalid()
    else: _invalid()

def _validate(frame, kind):
    _check(frame, _SCHEMA['frames'][kind]['schema'])
    p = frame['payload']
    if kind == 'CONTROL' and p['event'] not in _SCHEMA['phaseEvents'][p['phase']]: _invalid()
    if 'issuedAt' in p and p['expiresAt'] <= p['issuedAt']: _invalid()
    def unique(items):
        if len(set(items)) != len(items): _invalid()
    if kind == 'RELEASE_RECEIPT':
        if p['origins']['FRONTEND'] == p['origins']['BACKEND']: _invalid()
        unique(p['expectedInstances'])
    if kind == 'RESTART_RECEIPT':
        unique([x['id'] for x in p['preInstances']]); unique([x['id'] for x in p['postInstances']])
    if kind == 'ASSET_MANIFEST': unique([x['path'] for x in p['entries']])
    if kind == 'LEDGER_RECEIPT':
        for key in ('PAPER', 'stock'):
            a = p[key]; charged = a['historicalCharged'] + a['unresolved'] + a['fullRunReserved']
            if charged > a['ceiling'] or a['remaining'] != a['ceiling'] - charged: _invalid()

def decode_frame(data, kind):
    try:
        if type(data) is not bytes or kind not in _SCHEMA['frames'] or len(data) > _SCHEMA['frames'][kind]['maxBytes']: _invalid()
        text = data.decode('utf-8', errors='strict'); _depth(text)
        frame = json.loads(text, object_pairs_hook=_pairs, parse_int=_integer, parse_float=lambda _: _invalid(), parse_constant=lambda _: _invalid())
        _validate(frame, kind)
        return frame
    except (ValueError, TypeError, KeyError, RecursionError, OverflowError):
        _invalid()

def canonical_bytes(frame):
    try:
        kind = frame['kind']; _validate(frame, kind)
        result = json.dumps(frame, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
        if len(result) > _SCHEMA['frames'][kind]['maxBytes']: _invalid()
        return result
    except (ValueError, TypeError, KeyError, RecursionError, OverflowError): _invalid()

class PublicRunBudget:
    def __init__(self): self._used_bytes = 0
    @property
    def used_bytes(self): return self._used_bytes
    def append(self, frame):
        if type(frame) is not dict or frame.get('kind') != 'PUBLIC_RECORD': _invalid()
        size = len(canonical_bytes(frame))
        if size > _SCHEMA['publicRunMaxBytes'] - self._used_bytes: _invalid()
        self._used_bytes += size

"""Read-only ELF evidence helper; no execution of inspected binaries.

Usage: python3 inspect-elf.py frontend /private/tmp/day-trader-hardened-frontend.tar
       python3 inspect-elf.py backend /private/tmp/day-trader-hardened-node
"""
import bisect
import hashlib
import json
from pathlib import Path
import struct
import sys
import tarfile

OUT = Path(__file__).resolve().parent


def parse(data):
    assert data[:6] == b'\x7fELF\x02\x01', 'Expected little-endian ELF64'
    header = struct.unpack_from('<16sHHIQQQIHHHHHH', data)
    sections = [struct.unpack_from('<IIQQQQIIQQ', data, header[6] + i * header[11])
                for i in range(header[12])]

    def string(blob, offset):
        return blob[offset:blob.find(b'\0', offset)].decode(errors='replace')

    symbol_tables, symbols, needed = [], [], []
    for section in sections:
        if section[1] not in (2, 6, 11):
            continue
        strings_section = sections[section[6]]
        strings = data[strings_section[4]:strings_section[4] + strings_section[5]]
        if section[1] == 6:
            for offset in range(section[4], section[4] + section[5], section[9]):
                tag, value = struct.unpack_from('<qQ', data, offset)
                if tag == 1:
                    needed.append(string(strings, value))
            continue
        table = '.symtab' if section[1] == 2 else '.dynsym'
        symbol_tables.append({'name': table, 'entries': section[5] // section[9]})
        for offset in range(section[4], section[4] + section[5], section[9]):
            name, info, other, index, address, size = struct.unpack_from('<IBBHQQ', data, offset)
            symbols.append({'table': table, 'name': string(strings, name),
                            'binding': info >> 4, 'type': info & 15,
                            'visibility': other & 3, 'section': index,
                            'address': address, 'size': size})
    return header, sections, symbol_tables, symbols, needed


def frontend(archive):
    files, links = {}, {}
    with tarfile.open(archive) as outer:
        manifest = json.load(outer.extractfile('manifest.json'))[0]
        config_data = outer.extractfile(manifest['Config']).read()
        config = json.loads(config_data)
        for layer, diff in zip(manifest['Layers'], config['rootfs']['diff_ids']):
            with tarfile.open(fileobj=outer.extractfile(layer)) as inner:
                for member in inner:
                    name = member.name.removeprefix('./').lstrip('/')
                    parent, _, base = name.rpartition('/')
                    if base.startswith('.wh.'):
                        target = parent + '/' + base[4:]
                        if base == '.wh..wh..opq':
                            for old in list(files):
                                if old.startswith(parent + '/'):
                                    del files[old]
                        else:
                            files.pop(target, None)
                            links.pop(target, None)
                        continue
                    if member.isfile():
                        data = inner.extractfile(member).read()
                        files[name] = (data, diff)
                        links.pop(name, None)
                    elif member.issym() or member.islnk():
                        files.pop(name, None)
                        links[name] = member.linkname
    records = []
    for name, (data, diff) in sorted(files.items()):
        if not data.startswith(b'\x7fELF'):
            continue
        header, sections, tables, symbols, needed = parse(data)
        imports = [s['name'] for s in symbols if s['table'] == '.dynsym' and s['section'] == 0]
        gzip = [s for s in symbols if s['name'].startswith('gz')]
        records.append({'path': name, 'layer': diff, 'sha256': hashlib.sha256(data).hexdigest(),
                        'machine': header[2], 'symbolTables': tables, 'needed': needed,
                        'gzipSymbols': gzip, 'gzipImports': [n for n in imports if n.startswith('gz')],
                        'zlibStreamImports': [n for n in imports if n.startswith(('deflate', 'inflate'))],
                        'dynamicLoadingImports': [n for n in imports if n in ('dlopen', 'dlsym')]})
    return {'imageId': 'sha256:' + hashlib.sha256(config_data).hexdigest(),
            'method': 'Final layer-overlay regular-file inventory with whiteout processing; parse every ELF64 file dynamic/full symbol table and DT_NEEDED records. Symlinks are inventoried separately; no program is run.',
            'elfFiles': records, 'links': links,
            'gzipImporters': [r['path'] for r in records if r['gzipImports']],
            'nginxConfiguration': {n: data.decode(errors='replace') for n, (data, _) in files.items()
                                   if n.startswith('etc/nginx/') and n.endswith('.conf')}}


def backend(binary):
    data = Path(binary).read_bytes()
    header, sections, tables, symbols, needed = parse(data)
    funcs = sorted((s['address'], s['size'], s['name']) for s in symbols
                   if s['table'] == '.symtab' and s['type'] == 2 and s['section'] and s['size'])
    starts = [s[0] for s in funcs]
    targets = {address: name for address, size, name in funcs if name.startswith('gz')}
    calls = []
    assert header[2] == 183, 'Direct-call decoder requires AArch64'
    for section in sections:
        if not section[2] & 4 or section[1] != 1:
            continue
        for offset in range(0, section[5] - 3, 4):
            instruction = struct.unpack_from('<I', data, section[4] + offset)[0]
            if instruction & 0x7c000000 != 0x14000000:
                continue
            immediate = instruction & 0x3ffffff
            if immediate & (1 << 25):
                immediate -= 1 << 26
            address = section[3] + offset
            destination = address + immediate * 4
            if destination not in targets:
                continue
            index = bisect.bisect_right(starts, address) - 1
            caller = funcs[index][2] if index >= 0 and address < funcs[index][0] + funcs[index][1] else 'unresolved'
            calls.append({'address': hex(address), 'caller': caller, 'callee': targets[destination],
                          'instruction': 'BL' if instruction & 0x80000000 else 'B'})
    return {'sha256': hashlib.sha256(data).hexdigest(), 'symbolTables': tables,
            'gzipSymbols': [s for s in symbols if s['name'].startswith('gz')],
            'directBranches': calls, 'nonGzipCallers': [c for c in calls if not c['caller'].startswith('gz')],
            'limitation': 'Direct AArch64 B/BL only; indirect calls/function pointers are not resolved.'}


if __name__ == '__main__':
    kind, source = sys.argv[1:]
    result = {'frontend': frontend, 'backend': backend}[kind](source)
    destination = OUT / (kind + '-elf-review.json')
    destination.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'output': str(destination), 'imageId': result.get('imageId'),
                      'elfFiles': len(result.get('elfFiles', [])),
                      'gzipImporters': result.get('gzipImporters'),
                      'nonGzipCallers': result.get('nonGzipCallers')}))

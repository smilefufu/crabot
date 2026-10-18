"""Read legacy package records with the bundled interpreter; never import old code."""
import base64
import csv
import email.parser
import hashlib
import io
import json
import os
import pathlib
import sys


def digest(file):
    with open(file, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def reference(file):
    return file.is_symlink() or file.is_junction()


def regular_text(file):
    if reference(file) or not file.is_file() or file.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('Unsupported package record')
    return file.read_text(encoding='utf-8')


def inspect(data, target_version, directory='agent-venv'):
    parent = pathlib.Path(data).resolve()
    root = parent / directory
    if not root.resolve().is_relative_to(parent):
        raise ValueError('Environment outside data directory')
    report = dict(schema_version=1, observation_only=True, status='absent', packages=[])
    if reference(root):
        raise ValueError('Unsupported legacy environment')
    if not root.exists():
        return report
    if not root.is_dir():
        raise ValueError('Unsupported legacy environment')
    root = root.resolve()
    cfg = regular_text(root / 'pyvenv.cfg')
    fields = dict(line.split('=', 1) for line in cfg.splitlines() if '=' in line)
    fields = {key.strip(): value.strip() for key, value in fields.items()}
    version = fields.get('version_info', fields.get('version', ''))
    parts = version.split('.')
    if len(parts) < 2 or not all(part.isdecimal() for part in parts[:2]):
        raise ValueError('Unknown legacy Python version')
    site = root / ('Lib/site-packages' if os.name == 'nt' else 'lib/python' + '.'.join(parts[:2]) + '/site-packages')
    if reference(site) or not site.is_dir() or site.resolve() != site:
        raise ValueError('Unsupported package directory')
    fingerprint = hashlib.sha256(cfg.encode())
    covered = set()
    for folder in sorted(site.iterdir()):
        if not folder.name.endswith('.dist-info'):
            continue
        if reference(folder) or not folder.is_dir():
            raise ValueError('Unsupported package metadata directory')
        metadata = regular_text(folder / 'METADATA')
        headers = email.parser.Parser().parsestr(metadata, headersonly=True)
        name, package_version = headers.get('Name'), headers.get('Version')
        if not name or not package_version or any(char in name + package_version for char in '\r\n'):
            raise ValueError('Unknown package identity')
        item = dict(name=name, version=package_version, has_file_record=False, has_source_record=False,
                    modified_files=0, missing_files=0, unverified_files=0, references=0)
        fingerprint.update(folder.name.encode()); fingerprint.update(metadata.encode())
        source = folder / 'direct_url.json'
        if source.exists() or reference(source):
            source_text = regular_text(source)
            json.loads(source_text)
            fingerprint.update(source_text.encode())
            item['has_source_record'] = True  # Never expose a URL or embedded credential.
        record = folder / 'RECORD'
        if record.exists() or reference(record):
            text = regular_text(record)
            fingerprint.update(text.encode()); item['has_file_record'] = True
            for row in csv.reader(io.StringIO(text)):
                if len(row) != 3:
                    raise ValueError('Invalid package file record')
                target = pathlib.Path(os.path.abspath(site / row[0]))
                real = target.resolve()
                if not real.is_relative_to(root) or real != target:
                    item['references'] += 1
                    continue
                covered.add(target)
                if not target.is_file():
                    if target.suffix != '.pyc':
                        item['missing_files'] += 1
                    continue
                if not row[1]:
                    if target != record and target.suffix != '.pyc':
                        item['unverified_files'] += 1
                    continue
                algorithm, separator, wanted = row[1].partition('=')
                if not separator or algorithm not in ('sha256', 'sha384', 'sha512'):
                    item['unverified_files'] += 1
                    continue
                before = target.stat()
                with target.open('rb') as stream:
                    actual = hashlib.file_digest(stream, algorithm).digest()
                after = target.stat()
                fingerprint.update(str(target.relative_to(root)).encode()); fingerprint.update(actual)
                if base64.urlsafe_b64encode(actual).decode().rstrip('=') != wanted.rstrip('=') or (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
                    item['modified_files'] += 1
        report['packages'].append(item)
        if len(report['packages']) > 4096:
            raise ValueError('Too many package records')
    unrecorded = []
    references = special = 0
    for directory, dirs, files in os.walk(site, followlinks=False):
        dirs.sort(); files.sort()
        linked = {name for name in dirs if reference(pathlib.Path(directory, name))}
        references += len(linked)
        dirs[:] = [name for name in dirs if name not in linked]
        for name in files:
            file = pathlib.Path(directory, name)
            if reference(file):
                references += 1
            elif not file.is_file():
                special += 1
            elif file.suffix != '.pyc' and file not in covered:
                record = dict(path=file.relative_to(site).as_posix(), size=file.stat().st_size, sha256=digest(file))
                unrecorded.append(record)
                if len(unrecorded) > 4096:
                    raise ValueError('Too many unrecorded files')
                fingerprint.update(str(file.relative_to(root)).encode()); fingerprint.update(record['sha256'].encode())
    report.update(status='observed', python_version=version, target_python_version=target_version,
                  same_python_minor=parts[:2] == target_version.split('.')[:2], unrecorded_site_files=len(unrecorded), unrecorded_files=unrecorded,
                  site_references=references, special_site_files=special, fingerprint=fingerprint.hexdigest())
    return report


try:
    print(json.dumps(inspect(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'agent-venv'), ensure_ascii=False))
except Exception:
    # Source filenames, package URLs, local configuration and contents stay private.
    print('CRABOT_LEGACY_PYTHON_INSPECTION_FAILED', file=sys.stderr)
    sys.exit(1)

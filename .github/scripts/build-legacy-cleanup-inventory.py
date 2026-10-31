"""Build old compiled-program byte facts from the already pinned release archives.
CI-only preparation. No archive is extracted or executed, and users never download
old packages during admission/cleanup. Runtimes, dependencies and entry shims stay.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile

assert os.environ.get('GITHUB_ACTIONS') == 'true'
assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
archives = json.loads(Path('.github/scripts/fixtures/legacy-desktop-archives.json').read_text())
result = {'schema_version': 1, 'releases': {}}


def program_path(name):
    parts = PurePosixPath(name).parts
    if len(parts) < 4 or any(part in ('..', 'node_modules', '.venv') for part in parts):
        return None
    relative = parts[1:]
    if not relative[0].startswith('crabot-') or relative[1] != 'dist':
        return None
    return '/'.join(relative)


def fact(stream, size, mode=None):
    digest = hashlib.sha256()
    actual = 0
    while chunk := stream.read(1024 * 1024):
        actual += len(chunk)
        digest.update(chunk)
    assert actual == size
    return {'size': size, 'sha256': digest.hexdigest(), **({'mode': mode & 0o777} if mode is not None else {})}


with tempfile.TemporaryDirectory(prefix='crabot-legacy-program-facts-', dir=os.environ['RUNNER_TEMP']) as temporary:
    for version, platforms in archives.items():
        result['releases'][version] = {}
        for platform, (size, expected) in platforms.items():
            assert shutil.disk_usage(temporary).free > size + 1024 ** 3
            suffix = '.zip' if platform.startswith('windows-') else '.tar.gz'
            archive = Path(temporary) / ('archive' + suffix)
            url = f'https://github.com/smilefufu/crabot/releases/download/{version}/crabot-{version}-{platform}{suffix}'
            digest = hashlib.sha256()
            actual = 0
            with urllib.request.urlopen(url, timeout=120) as response, archive.open('xb') as output:
                while chunk := response.read(1024 * 1024):
                    actual += len(chunk)
                    assert actual <= size
                    digest.update(chunk)
                    output.write(chunk)
            assert actual == size and digest.hexdigest() == expected
            files = {}
            if suffix == '.zip':
                with zipfile.ZipFile(archive) as package:
                    for entry in package.infolist():
                        name = program_path(entry.filename)
                        if name and not entry.is_dir() and (entry.external_attr >> 16) & 0o170000 != 0o120000:
                            assert name not in files
                            with package.open(entry) as stream:
                                files[name] = fact(stream, entry.file_size)
            else:
                with tarfile.open(archive, 'r|gz') as package:
                    for entry in package:
                        name = program_path(entry.name)
                        if name and entry.isfile():
                            assert name not in files
                            with package.extractfile(entry) as stream:
                                files[name] = fact(stream, entry.size, entry.mode)
            assert files and 'crabot-core/dist/main.js' in files
            result['releases'][version][platform.replace('windows-', 'win32-')] = {'archive_sha256': expected, 'files': dict(sorted(files.items()))}
            print(json.dumps({'version': version, 'platform': platform, 'compiled_files': len(files), 'bytes': sum(item['size'] for item in files.values()), 'archive_sha256': expected}), flush=True)
            archive.unlink()
output = Path('.desktop-build/legacy-cleanup-files.json.gz')
output.parent.mkdir(exist_ok=True)
output.write_bytes(gzip.compress((json.dumps(result, separators=(',', ':'), ensure_ascii=False) + '\n').encode(), mtime=0))
print(json.dumps({'output': str(output), 'bytes': output.stat().st_size, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}), flush=True)

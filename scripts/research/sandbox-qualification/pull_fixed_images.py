"""Pinned public arm64 images; no Docker calls or layer-tar extraction.
Usage: python3 pull_fixed_images.py --root TASK_ROOT [--image execd|egress|python]."""
import argparse
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import signal
import tarfile
import urllib.parse
import urllib.request

IMAGES = {
    'execd': ('opensandbox/execd', 'sha256:49b717e2c43b242f80bcd350403186ee8ec8a28576b2cb45471b015d5120f28f'),
    'egress': ('opensandbox/egress', 'sha256:2741d5fb796ab859a855e99b5255e740e3562fbaaa2a6d85428e2ed6d3eb19e3'),
    'python': ('library/python', 'sha256:c61cffc3bacb94ed026ff8b45d5114b7693dd0420baca0a1ace0e3d0ce9035fd'),
}
META = 4 * 1024 * 1024
MANIFESTS = ('application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json')
CONFIGS = ('application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json')
GZIP = ('application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.docker.image.rootfs.diff.tar.gzip')
PLAIN = ('application/vnd.oci.image.layer.v1.tar', 'application/vnd.docker.image.rootfs.diff.tar')

class ValidationError(ValueError): pass

def require(condition, message):
    if not condition:
        raise ValidationError(message)

def hexdigest(value):
    require(isinstance(value, str) and value.startswith('sha256:') and len(value) == 71 and all(c in '0123456789abcdef' for c in value[7:]), 'invalid sha256 descriptor')
    return value[7:]

def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

class HTTPSOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        require(urllib.parse.urlsplit(url).scheme == 'https', 'non-HTTPS redirect refused')
        return super().redirect_request(request, response, code, message, headers, url)

def request(url, token=None):
    require(urllib.parse.urlsplit(url).scheme == 'https', 'HTTPS required')
    req = urllib.request.Request(url, headers={'Accept': ', '.join(MANIFESTS), 'Accept-Encoding': 'identity'})
    if token:
        req.add_unredirected_header('Authorization', 'Bearer ' + token)
    return urllib.request.build_opener(HTTPSOnly()).open(req, timeout=60)

class Store:
    def __init__(self, root):
        self.path = root.resolve(strict=True) / 'downloads/fixed-images'
        self.path.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(self.path.resolve() == self.path and self.path.stat().st_uid == os.getuid() and not self.path.stat().st_mode & 0o077, 'cache must be private, owned and non-symlink')
        self.used = [0, 0, 0]
        for path in self.path.iterdir():
            require(not path.is_symlink() and path.is_file() and path.stat().st_uid == os.getuid(), 'unsafe cache entry')
            self.used[1 if path.suffix == '.layer' else 2 if path.suffix == '.tar' else 0] += path.stat().st_size
        self.lock = (self.path / '.lock').open('a')
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.reserve(0, 0)

    def reserve(self, kind, size):
        self.used[kind] += size
        require(all(n <= limit for n, limit in zip(self.used, [1 << 30, 2 << 30, 3 << 30])), 'compressed/expanded/archive hard byte limit exceeded')
        require(shutil.disk_usage(self.path).free >= 30 << 30, 'host disk reserve below 30 GiB')

    def copy(self, source, digest, suffix, kind, size=None):
        target = self.path / (hexdigest(digest) + suffix)
        if target.exists():
            require(sha(target) == digest[7:] and (size is None or target.stat().st_size == size), 'cached blob integrity mismatch')
            return target
        partial = target.with_name(target.name + '.part')
        try:
            count = 0
            with partial.open('xb') as output:
                while chunk := source.read(1024 * 1024):
                    count += len(chunk)
                    require(size is None or count <= size, 'descriptor size exceeded')
                    self.reserve(kind, len(chunk))
                    output.write(chunk)
            require((size is None or count == size) and sha(partial) == digest[7:], 'blob sha256/size mismatch')
            partial.chmod(0o400)
            partial.replace(target)
            return target
        finally:
            partial.unlink(missing_ok=True)

def metadata(store, url, token=None):
    with request(url, token) as response:
        raw = response.read(META + 1)
    store.reserve(0, len(raw))
    require(len(raw) <= META, 'metadata exceeds 4 MiB')
    return raw

def pull(store, name, repo, digest):
    query = urllib.parse.urlencode({'service': 'registry.docker.io', 'scope': 'repository:' + repo + ':pull'})
    token = json.loads(metadata(store, 'https://auth.docker.io/token?' + query))['token']
    base = 'https://registry-1.docker.io/v2/' + repo
    raw = metadata(store, base + '/manifests/' + digest, token)
    require(hashlib.sha256(raw).hexdigest() == hexdigest(digest), 'manifest raw sha256 mismatch')
    manifest = json.loads(raw)
    require(manifest.get('schemaVersion') == 2 and manifest.get('mediaType') in MANIFESTS, 'unsupported manifest media type')
    config = manifest['config']
    require(config.get('mediaType') in CONFIGS and 0 < config['size'] <= META, 'unsupported/oversized config')
    def blob(descriptor):
        require(not descriptor.get('urls') and isinstance(descriptor['size'], int) and descriptor['size'] >= 0, 'unsupported blob descriptor')
        if (store.path / (hexdigest(descriptor['digest']) + '.blob')).exists():
            return store.copy(io.BytesIO(), descriptor['digest'], '.blob', 0, descriptor['size'])
        with request(base + '/blobs/' + descriptor['digest'], token) as response:
            return store.copy(response, descriptor['digest'], '.blob', 0, descriptor['size'])
    config_path = blob(config)
    info = json.loads(config_path.read_bytes())
    require(info.get('os') == 'linux' and info.get('architecture') == 'arm64', 'config is not linux/arm64')
    diffs = info['rootfs']['diff_ids']
    require(info['rootfs'].get('type') == 'layers' and len(diffs) == len(manifest['layers']) <= 128, 'invalid rootfs/layer list')
    layers = []
    for descriptor, diff in zip(manifest['layers'], diffs):
        require(descriptor.get('mediaType') in GZIP + PLAIN, 'unsupported layer media type')
        compressed = blob(descriptor)
        with compressed.open('rb') as source:
            reader = gzip.GzipFile(fileobj=source) if descriptor['mediaType'] in GZIP else source
            with reader:
                layers.append(store.copy(reader, diff, '.layer', 1))
    tag = 'crabot-qualification/' + name + ':fixed-arm64'
    entry = {'Config': hexdigest(config['digest']) + '.json', 'RepoTags': [tag], 'Layers': [hexdigest(d) + '/layer.tar' for d in diffs]}
    files = dict(zip(entry['Layers'], layers))
    files[entry['Config']] = config_path
    payload = json.dumps([entry], separators=(',', ':')).encode()
    total = sum(512 + ((p.stat().st_size + 511) // 512) * 512 for p in files.values()) + 512 + ((len(payload) + 511) // 512) * 512
    store.reserve(2, ((total + 1024 + 10239) // 10240) * 10240)
    archive = store.path / (name + '-arm64.tar')
    partial = archive.with_name(archive.name + '.part')
    try:
        with tarfile.open(partial, 'x', format=tarfile.USTAR_FORMAT) as output:
            for filename, path in files.items():
                header = tarfile.TarInfo(filename); header.size = path.stat().st_size; header.mode = 0o644
                with path.open('rb') as source: output.addfile(header, source)
            header = tarfile.TarInfo('manifest.json'); header.size = len(payload); header.mode = 0o644
            output.addfile(header, io.BytesIO(payload))
        partial.replace(archive)
    finally:
        partial.unlink(missing_ok=True)
    return {'source_manifest': digest, 'source_ref': repo + '@' + digest, 'config_id': config['digest'], 'diff_ids': diffs, 'local_tag': tag, 'archive': str(archive), 'archive_sha256': sha(archive)}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--image', choices=tuple(IMAGES), action='append')
    args = parser.parse_args()
    def expired(*_): raise TimeoutError('whole-run timeout')
    signal.signal(signal.SIGALRM, expired); signal.alarm(1200)
    store = Store(args.root)
    with store.lock:
        result = {name: pull(store, name, *IMAGES[name]) for name in dict.fromkeys(args.image or IMAGES)}
        (store.path / 'provenance.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('fixed image preparation failed: ' + (str(error) if isinstance(error, ValidationError) else type(error).__name__), file=__import__('sys').stderr)
        raise SystemExit(1)

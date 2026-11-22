import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import urllib.request

import pull_fixed_images as images


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


class FixedImageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='fixed-image-test-')
        self.addCleanup(self.directory.cleanup)
        self.disk = patch.object(images.shutil, 'disk_usage', return_value=SimpleNamespace(free=100 << 30))
        self.disk.start()
        self.addCleanup(self.disk.stop)
        self.store = images.Store(Path(self.directory.name))
        self.addCleanup(self.store.lock.close)
        # Deliberately not a valid tar: layer contents must remain opaque.
        self.layer = b'opaque layer bytes, never parsed or extracted'
        self.compressed = gzip.compress(self.layer, mtime=0)
        self.calls = []
        self.refresh()
        self.network = patch.object(images, 'request', side_effect=self.request)
        self.network_mock = self.network.start()
        self.addCleanup(self.network.stop)

    def refresh(self, diff=None, media=None):
        self.config = json.dumps({'architecture': 'arm64', 'os': 'linux', 'config': {},
                                  'rootfs': {'type': 'layers', 'diff_ids': [diff or digest(self.layer)]}}).encode()
        self.manifest = json.dumps({'schemaVersion': 2, 'mediaType': images.MANIFESTS[0],
                                   'config': {'mediaType': images.CONFIGS[0], 'digest': digest(self.config), 'size': len(self.config)},
                                   'layers': [{'mediaType': media or images.GZIP[0], 'digest': digest(self.compressed), 'size': len(self.compressed)}]}).encode()

    def request(self, url, token=None):
        self.calls.append(url)
        if '/token?' in url:
            return io.BytesIO(b'{"token":"synthetic-do-not-log"}')
        if '/manifests/' in url:
            return io.BytesIO(self.manifest)
        if url.endswith(digest(self.config)):
            return io.BytesIO(self.config)
        if url.endswith(digest(self.compressed)):
            return io.BytesIO(self.compressed)
        self.fail('unexpected fake registry request')

    def pull(self, manifest_digest=None):
        return images.pull(self.store, 'execd', 'fixture/public', manifest_digest or digest(self.manifest))

    def test_opaque_archive_provenance_and_verified_cache(self):
        result = self.pull()
        self.assertEqual(result['source_manifest'], digest(self.manifest))
        self.assertEqual(result['config_id'], digest(self.config))
        self.assertNotEqual(result['source_manifest'], result['config_id'])
        self.assertEqual(result['diff_ids'], [digest(self.layer)])
        with tarfile.open(result['archive']) as archive:
            entry = json.load(archive.extractfile('manifest.json'))[0]
            self.assertEqual(entry['Config'], digest(self.config)[7:] + '.json')
            self.assertEqual(entry['RepoTags'], ['crabot-qualification/execd:fixed-arm64'])
            self.assertEqual(archive.extractfile(entry['Config']).read(), self.config)
            self.assertEqual(archive.extractfile(entry['Layers'][0]).read(), self.layer)
        self.assertNotIn('synthetic-do-not-log', json.dumps(result))
        before = [url for url in self.calls if '/blobs/' in url]
        self.pull()
        self.assertEqual([url for url in self.calls if '/blobs/' in url], before)

    def test_wrong_raw_manifest_digest_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'manifest raw sha256'):
            self.pull('sha256:' + '0' * 64)
        self.assertFalse(any('/blobs/' in url for url in self.calls))

    def test_same_size_corrupted_blob_is_rejected(self):
        original = self.request
        def corrupt(url, token=None):
            if url.endswith(digest(self.compressed)):
                return io.BytesIO(self.compressed[:-1] + bytes([self.compressed[-1] ^ 1]))
            return original(url, token)
        self.network_mock.side_effect = corrupt
        with self.assertRaisesRegex(ValueError, 'blob sha256/size'):
            self.pull()
        self.assertFalse((self.store.path / (digest(self.compressed)[7:] + '.blob')).exists())
        self.assertFalse(list(self.store.path.glob('*.part')))

    def test_wrong_uncompressed_diff_id_is_rejected(self):
        self.refresh(diff='sha256:' + '0' * 64)
        with self.assertRaisesRegex(ValueError, 'blob sha256/size'):
            self.pull()
        self.assertFalse(list(self.store.path.glob('*.layer')))

    def test_download_and_expansion_limits_prevent_writes(self):
        for kind, suffix, cap in [(0, '.blob', 1 << 30), (1, '.layer', 2 << 30)]:
            with self.subTest(kind=kind):
                self.store.used[kind] = cap - 2
                with self.assertRaisesRegex(ValueError, 'hard byte limit'):
                    self.store.copy(io.BytesIO(b'abcd'), digest(b'abcd'), suffix, kind, 4)
                self.assertFalse((self.store.path / (digest(b'abcd')[7:] + suffix)).exists())
                self.assertFalse(list(self.store.path.glob('*.part')))
                self.store.used[kind] = 0

    def test_unsupported_layer_media_is_rejected(self):
        self.refresh(media='application/vnd.oci.image.layer.v1.tar+zstd')
        with self.assertRaisesRegex(ValueError, 'unsupported layer media type'):
            self.pull()

    def test_https_only_and_bearer_not_forwarded(self):
        handler = images.HTTPSOnly()
        request = urllib.request.Request('https://registry.example/blob')
        request.add_unredirected_header('Authorization', 'Bearer synthetic-do-not-log')
        with self.assertRaisesRegex(ValueError, 'non-HTTPS'):
            handler.redirect_request(request, None, 302, '', {}, 'http://cdn.example/blob')
        redirected = handler.redirect_request(request, None, 302, '', {}, 'https://cdn.example/blob')
        self.assertFalse(redirected.has_header('Authorization'))


if __name__ == '__main__':
    unittest.main()

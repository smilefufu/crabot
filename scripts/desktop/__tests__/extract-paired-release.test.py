"""Finite stdlib fixtures; no downloaded program is imported or executed."""
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('paired_extract', Path(__file__).parent.parent / 'extract-paired-release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='crabot-archive-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.output = self.root / 'empty'
        self.output.mkdir(mode=0o700)

    def archive(self, entries, kind='zip'):
        file = self.root / ('payload.zip' if kind == 'zip' else 'payload.tar.gz')
        if kind == 'zip':
            with zipfile.ZipFile(file, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                for name, data, mode in entries:
                    info = zipfile.ZipInfo(name.replace('\x00', '!'))
                    info.create_system = 3
                    info.external_attr = mode << 16
                    archive.writestr(info, data)
        else:
            with tarfile.open(file, 'w:gz') as archive:
                for name, data, mode in entries:
                    info = tarfile.TarInfo(name)
                    info.mode = stat.S_IMODE(mode)
                    if stat.S_ISLNK(mode):
                        info.type = tarfile.SYMTYPE
                        info.linkname = data.decode()
                        archive.addfile(info)
                    elif stat.S_ISDIR(mode):
                        info.type = tarfile.DIRTYPE
                        archive.addfile(info)
                    else:
                        info.size = len(data)
                        archive.addfile(info, io.BytesIO(data))
        if kind == 'zip' and any('\x00' in name for name, _, _ in entries):
            file.write_bytes(file.read_bytes().replace(b'core/value!hidden', b'core/value\x00hidden'))
        return file

    def extract(self, entries, kind='zip'):
        file = self.archive(entries, kind)
        return module.extract(file, self.output, file.stat().st_size, hashlib.sha256(file.read_bytes()).hexdigest())

    def base(self):
        return [('desktop-payload.json', b'{}\n', stat.S_IFREG | 0o644),
                ('core/cli.mjs', b'throw new Error("never execute")', stat.S_IFREG | 0o755),
                ('gui/resources/value', b'bytes', stat.S_IFREG | 0o444)]

    def test_zip_and_tar_keep_program_bytes_and_modes_without_execution(self):
        for kind in ['zip', 'tar']:
            with self.subTest(kind=kind):
                self.extract(self.base(), kind)
                self.assertEqual((self.output / 'gui/resources/value').read_bytes(), b'bytes')
                self.assertEqual((self.output / 'core/cli.mjs').read_bytes(), self.base()[1][1])
                if os.name != 'nt':
                    self.assertEqual(stat.S_IMODE((self.output / 'gui/resources/value').stat().st_mode), 0o444)
                    self.assertEqual(stat.S_IMODE((self.output / 'core/cli.mjs').stat().st_mode), 0o755)
                import shutil
                shutil.rmtree(self.output)
                self.output.mkdir(mode=0o700)

    def test_rejects_paths_duplicates_and_writing_through_links_before_any_file(self):
        for name in ['../escape', '/escape', 'core/../escape', 'core/./value', 'core//value',
                     'core\\escape', 'unexpected/value', 'core/value\x00hidden', 'core/value\nsecret', 'core/cli.mjs']:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    self.extract(self.base() + [(name, b'bad', stat.S_IFREG | 0o600)])
                self.assertEqual(list(self.output.iterdir()), [])
        for target in ['../../outside', '/outside', '../gui/resources/value']:
            with self.assertRaises(ValueError):
                self.extract(self.base() + [('core/link', target.encode(), stat.S_IFLNK | 0o777)])
            self.assertEqual(list(self.output.iterdir()), [])
        with self.assertRaises(ValueError):
            self.extract(self.base() + [('core/link', b'sub', stat.S_IFLNK | 0o777),
                                       ('core/link/file', b'bad', stat.S_IFREG | 0o600)])
        self.assertEqual(list(self.output.iterdir()), [])

    @unittest.skipIf(os.name == 'nt', 'Windows paired payloads materialize links')
    def test_relative_component_links_are_created_last(self):
        self.extract(self.base() + [('core/current', b'cli.mjs', stat.S_IFLNK | 0o777)], 'tar')
        self.assertTrue((self.output / 'core/current').is_symlink())
        self.assertEqual((self.output / 'core/current').read_bytes(), self.base()[1][1])

    def test_no_special_files_nonempty_target_or_missing_manifest(self):
        with self.assertRaises(ValueError):
            self.extract(self.base() + [('core/fifo', b'', stat.S_IFIFO | 0o600)])
        with self.assertRaises(ValueError):
            self.extract(self.base()[1:])
        (self.output / 'keep').write_text('user file')
        with self.assertRaises(ValueError):
            self.extract(self.base())
        self.assertEqual((self.output / 'keep').read_text(), 'user file')

    def test_size_digest_disk_and_archive_identity_before_writes(self):
        file = self.archive(self.base())
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        for size, sha in [(file.stat().st_size + 1, digest), (file.stat().st_size, '0' * 64)]:
            with self.assertRaises(ValueError):
                module.extract(file, self.output, size, sha)
        with patch.object(module.shutil, 'disk_usage', return_value=type('Space', (), {'free': 1})()):
            with self.assertRaises(OSError) as failure:
                module.extract(file, self.output, file.stat().st_size, digest)
            self.assertEqual(failure.exception.errno, 28)
        self.assertEqual(list(self.output.iterdir()), [])
        if os.name != 'nt':
            link = self.root / 'link.zip'
            link.symlink_to(file)
            with self.assertRaises(ValueError):
                module.extract(link, self.output, file.stat().st_size, digest)

    def test_crc_failure_and_cli_diagnostics_are_closed(self):
        file = self.archive(self.base())
        data = bytearray(file.read_bytes())
        start = data.index(self.base()[1][1])
        data[start] ^= 1
        file.write_bytes(data)
        with self.assertRaises(zipfile.BadZipFile):
            module.extract(file, self.output, len(data), hashlib.sha256(data).hexdigest())
        import subprocess
        result = subprocess.run([sys.executable, '-I', '-B', str(Path(module.__file__)),
                                 str(self.root / 'private-secret.zip'), str(self.output), '1', 'a' * 64],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr, 'CRABOT_DESKTOP_RELEASE_INTEGRITY\n')

    def test_hardlinks_are_rejected(self):
        file = self.root / 'hard.tar.gz'
        with tarfile.open(file, 'w:gz') as archive:
            info = tarfile.TarInfo('core/alias')
            info.type = tarfile.LNKTYPE
            info.linkname = 'core/file'
            archive.addfile(info)
        with self.assertRaises(ValueError):
            module.extract(file, self.output, file.stat().st_size, hashlib.sha256(file.read_bytes()).hexdigest())
        self.assertEqual(list(self.output.iterdir()), [])


if __name__ == '__main__':
    unittest.main()

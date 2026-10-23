"""Current trusted interpreter only; extract program bytes, never execute them."""
import errno
import hashlib
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import stat
import sys
import tarfile
import unicodedata
import zipfile

RESERVE = 512 * 1024 * 1024
CHUNK = 1024 * 1024


def require(condition):
    if not condition:
        raise ValueError('CRABOT_DESKTOP_RELEASE_INTEGRITY')


def identity(value):
    return tuple(getattr(value, key) for key in
                 ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def entry_name(value, directory=False):
    require(isinstance(value, str) and 0 < len(value) <= 4096)
    require('\\' not in value and not any(ord(char) < 32 or ord(char) == 127 for char in value))
    name = value[:-1] if directory and value.endswith('/') else value
    parts = name.split('/')
    require(all(part and part not in ('.', '..') for part in parts))
    require(name == 'desktop-payload.json' or parts[0] in ('core', 'gui'))
    require(name != 'desktop-payload.json' or not directory)
    require(len(parts) > 1 or directory or name == 'desktop-payload.json')
    if os.name == 'nt':
        for part in parts:
            require(not re.search(r'[<>:"|?*]', part) and not part.endswith((' ', '.')))
            require(not re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part, re.I))
    return name


def entries(archive, zipped):
    result, names = [], {}
    for item in archive.infolist() if zipped else archive:
        require(len(result) < 250000)
        if zipped:
            require(not item.flag_bits & 1 and item.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED))
            mode = item.external_attr >> 16
            kind = stat.S_IFMT(mode)
            directory = item.is_dir()
            require(kind in (0, stat.S_IFDIR, stat.S_IFREG, stat.S_IFLNK))
            require(not directory or kind in (0, stat.S_IFDIR))
            require(kind != stat.S_IFDIR or directory)
            name = entry_name(item.orig_filename, directory)
            link = kind == stat.S_IFLNK
            require(not link or item.file_size <= 4096 and os.name != 'nt')
            target = archive.read(item).decode('utf-8') if link else None
            mode = stat.S_IMODE(mode) & 0o777 if kind else (0o755 if directory else 0o644)
        else:
            directory, link = item.isdir(), item.issym()
            require(directory or link or item.isreg())  # No hardlinks, devices, FIFOs or sparse files.
            require(not item.sparse and not (link and os.name == 'nt'))
            name, target, mode = entry_name(item.name, directory), item.linkname if link else None, item.mode & 0o777
        size = item.file_size if zipped else item.size
        require(isinstance(size, int) and size >= 0 and (not directory or size == 0))
        folded = unicodedata.normalize('NFC', name).casefold() if os.name == 'nt' or sys.platform == 'darwin' else name
        require(folded not in names)
        if directory:
            names[folded] = 'directory'
        elif link:
            names[folded] = 'link'
        else:
            names[folded] = 'file'
        if link:
            require(0 < len(target) <= 4096 and '\\' not in target and not any(ord(char) < 32 or ord(char) == 127 for char in target))
            require(not PurePosixPath(target).is_absolute())
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
            require(resolved.split('/')[0] == name.split('/')[0])
        result.append((name, directory, target, size, mode, item))
    require(names.get('desktop-payload.json') == 'file')
    for name in names:
        for parent in PurePosixPath(name).parents:
            require(str(parent) == '.' or names.get(str(parent), 'directory') == 'directory')
    return result


def extract(file, destination, size, sha256):
    file, destination = Path(file), Path(destination)
    require(destination.is_absolute() and file.is_absolute())
    root = destination.lstat()
    require(stat.S_ISDIR(root.st_mode) and not stat.S_ISLNK(root.st_mode))
    require(destination.resolve() == destination and not any(destination.iterdir()))
    if os.name != 'nt':
        require(root.st_uid == os.getuid() and stat.S_IMODE(root.st_mode) == 0o700)
    before = file.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size == size)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0)
    with os.fdopen(os.open(file, flags), 'rb') as source:
        require(identity(os.fstat(source.fileno())) == identity(before))
        digest = hashlib.sha256()
        while data := source.read(CHUNK):
            digest.update(data)
        require(digest.hexdigest() == sha256 and identity(os.fstat(source.fileno())) == identity(before))
        source.seek(0)
        zipped = file.name.endswith('.zip')
        require(zipped or file.name.endswith('.tar.gz'))
        with zipfile.ZipFile(source) if zipped else tarfile.open(fileobj=source, mode='r:gz') as archive:
            listing = entries(archive, zipped)
            needed = sum(((size + 4095) // 4096 + len(PurePosixPath(name).parts)) * 4096
                         for name, _, _, size, _, _ in listing)
            if shutil.disk_usage(destination).free < needed + RESERVE:
                raise OSError(errno.ENOSPC, 'CRABOT_UPDATE_SPACE')
            directories = {}
            for name, directory, target, length, mode, item in listing:
                output = destination / name
                output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if directory:
                    output.mkdir(exist_ok=True, mode=0o700)
                    directories[output] = mode
                elif target is None:
                    if shutil.disk_usage(destination).free < length + RESERVE:
                        raise OSError(errno.ENOSPC, 'CRABOT_UPDATE_SPACE')
                    reader = archive.open(item) if zipped else archive.extractfile(item)
                    with reader, output.open('xb') as writer:
                        remaining = length
                        while remaining:
                            data = reader.read(min(CHUNK, remaining))
                            require(data)
                            writer.write(data)
                            remaining -= len(data)
                        require(not reader.read(1))
                    if os.name != 'nt':
                        output.chmod(mode)
            # No archive-controlled link can be used as a write destination.
            for name, _, target, _, _, _ in listing:
                if target is not None:
                    (destination / name).symlink_to(target)
            if os.name != 'nt':
                for directory in sorted(directories, key=lambda value: len(value.parts), reverse=True):
                    directory.chmod(directories[directory])
        require(identity(os.fstat(source.fileno())) == identity(before) and identity(file.lstat()) == identity(before))
    require(identity(destination.lstat())[:4] == identity(root)[:4])


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 5 and re.fullmatch('[a-f0-9]{64}', sys.argv[4]))
        extract(Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
    except Exception as error:
        # Neither member names nor interpreter traceback enter user diagnostics.
        code = 'CRABOT_UPDATE_SPACE' if isinstance(error, OSError) and error.errno == errno.ENOSPC else 'CRABOT_DESKTOP_RELEASE_INTEGRITY'
        sys.stderr.write(code + '\n')
        sys.exit(1)

"""Build host only: archive a verified payload without following program links."""
import os
from pathlib import Path
import shutil
import stat
import sys
import tarfile
import zipfile


def archive_payload(source, output):
    source, output = Path(source), Path(output)
    if not source.is_absolute() or not output.is_absolute() or set(os.listdir(source)) != {'desktop-payload.json', 'gui', 'core'}:
        raise ValueError('Invalid payload roots')
    entries = []

    def walk(file):
        mode = file.lstat().st_mode
        if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
            raise ValueError('Unsupported payload member')
        entries.append(file)
        if stat.S_ISDIR(mode):
            for child in sorted(file.iterdir()):
                walk(child)

    for child in sorted(source.iterdir()):
        walk(child)
    with output.open('xb') as writer:
        zipped = output.name.endswith('.zip')
        if not zipped and not output.name.endswith('.tar.gz'):
            raise ValueError('Unsupported payload format')
        with zipfile.ZipFile(writer, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) if zipped else tarfile.open(fileobj=writer, mode='w:gz') as archive:
            for file in entries:
                info = file.lstat()
                name, directory, link = file.relative_to(source).as_posix(), stat.S_ISDIR(info.st_mode), stat.S_ISLNK(info.st_mode)
                if zipped:
                    member = zipfile.ZipInfo(name + '/' if directory else name)
                    member.create_system = 3
                    member.external_attr = info.st_mode << 16
                    member.compress_type = zipfile.ZIP_DEFLATED
                    if directory or link:
                        archive.writestr(member, os.readlink(file).encode('utf-8') if link else b'')
                    else:
                        with file.open('rb') as reader, archive.open(member, 'w', force_zip64=True) as destination:
                            shutil.copyfileobj(reader, destination, 1024 * 1024)
                else:
                    # Materialize every regular-file inode, including hardlink
                    # aliases. The consumer deliberately rejects tar hardlinks.
                    member = tarfile.TarInfo(name)
                    member.mode = info.st_mode & 0o777
                    if directory:
                        member.type = tarfile.DIRTYPE
                        archive.addfile(member)
                    elif link:
                        member.type = tarfile.SYMTYPE
                        member.linkname = os.readlink(file)
                        archive.addfile(member)
                    else:
                        member.size = info.st_size
                        with file.open('rb') as reader:
                            archive.addfile(member, reader)
        writer.flush()
        os.fsync(writer.fileno())


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('Invalid archive arguments')
        archive_payload(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception:
        sys.stderr.write('CRABOT_DESKTOP_RELEASE_ARCHIVE_FAILED\n')
        sys.exit(1)

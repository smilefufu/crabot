"""Keep hardlinks, but normalize CI ownership and shared resource permissions."""
from pathlib import Path
import sys
import tarfile

source = Path(sys.argv[1])

def permissions(info):
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    info.mode = 0o755 if info.isdir() or info.mode & 0o111 else 0o644
    return info

with tarfile.open(str(source) + ".tar.gz", "w:gz") as archive:
    archive.add(source, arcname=source.name, filter=permissions)

"""Long-term v2 file path strategy."""
import os
from pathlib import Path
from typing import List, Tuple, Literal

Status = Literal["inbox", "confirmed", "trash"]
MemType = Literal["fact", "lesson", "concept"]

VALID_STATUS = {"inbox", "confirmed", "trash"}
VALID_TYPE = {"fact", "lesson", "concept"}


def entry_path(data_root: str, status: str, type_: str, mem_id: str) -> str:
    if status not in VALID_STATUS:
        raise ValueError(f"invalid status: {status}")
    if type_ not in VALID_TYPE:
        raise ValueError(f"invalid type: {type_}")
    return os.path.join(data_root, status, type_, f"{mem_id}.md")


def ensure_dirs(data_root: str) -> None:
    for s in VALID_STATUS:
        for t in VALID_TYPE:
            Path(os.path.join(data_root, s, t)).mkdir(parents=True, exist_ok=True)


def scan_dir(data_root: str, status: str, type_: str) -> List[str]:
    if status not in VALID_STATUS or type_ not in VALID_TYPE:
        raise ValueError("invalid status/type")
    d = Path(os.path.join(data_root, status, type_))
    if not d.exists():
        return []
    return [str(p) for p in d.iterdir() if p.suffix == ".md"]


def status_of_path(data_root: str, path: str) -> Tuple[str, str]:
    rel = os.path.relpath(path, data_root).split(os.sep)
    if len(rel) < 3:
        raise ValueError(f"path not within data_root structure: {path}")
    status, type_ = rel[0], rel[1]
    if status not in VALID_STATUS or type_ not in VALID_TYPE:
        raise ValueError(f"unrecognized status/type in path: {path}")
    return status, type_

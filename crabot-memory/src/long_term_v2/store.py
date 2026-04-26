"""File-based storage for long_term v2."""
import os
import shutil
from typing import List, Tuple
from src.long_term_v2.schema import MemoryEntry
from src.long_term_v2.markdown_io import dump_entry, load_entry
from src.long_term_v2.paths import (
    entry_path, ensure_dirs, scan_dir, VALID_STATUS, VALID_TYPE,
)


class MemoryStore:
    def __init__(self, data_root: str):
        self.data_root = data_root
        ensure_dirs(data_root)

    def write(self, entry: MemoryEntry, status: str) -> None:
        path = entry_path(self.data_root, status, entry.frontmatter.type, entry.frontmatter.id)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(dump_entry(entry))

    def read(self, status: str, type_: str, mem_id: str) -> MemoryEntry:
        path = entry_path(self.data_root, status, type_, mem_id)
        if not os.path.exists(path):
            raise FileNotFoundError(path)
        with open(path, "r", encoding="utf-8") as f:
            return load_entry(f.read())

    def _versions_dir(self, status: str, type_: str, mem_id: str) -> str:
        # 版本旁路（spec §9.2）：data_root/<status>/<type>/<id>.versions/v<n>.md
        return os.path.join(self.data_root, status, type_, f"{mem_id}.versions")

    def _version_path(self, status: str, type_: str, mem_id: str, version: int) -> str:
        return os.path.join(self._versions_dir(status, type_, mem_id), f"v{version}.md")

    def archive_version(self, status: str, entry: MemoryEntry) -> None:
        """把当前 entry 旁路保存到 versions 目录，作为旧版本快照。"""
        fm = entry.frontmatter
        vdir = self._versions_dir(status, fm.type, fm.id)
        os.makedirs(vdir, exist_ok=True)
        vpath = self._version_path(status, fm.type, fm.id, fm.version)
        with open(vpath, "w", encoding="utf-8") as f:
            f.write(dump_entry(entry))

    def read_version(self, status: str, type_: str, mem_id: str, version: int) -> MemoryEntry:
        vpath = self._version_path(status, type_, mem_id, version)
        with open(vpath, "r", encoding="utf-8") as f:
            return load_entry(f.read())

    def list_versions(self, status: str, type_: str, mem_id: str) -> List[int]:
        vdir = self._versions_dir(status, type_, mem_id)
        if not os.path.isdir(vdir):
            return []
        out: List[int] = []
        for name in os.listdir(vdir):
            if name.startswith("v") and name.endswith(".md"):
                try:
                    out.append(int(name[1:-3]))
                except ValueError:
                    continue
        return sorted(out)

    def move(self, mem_id: str, type_: str, from_status: str, to_status: str) -> None:
        src = entry_path(self.data_root, from_status, type_, mem_id)
        dst = entry_path(self.data_root, to_status, type_, mem_id)
        if not os.path.exists(src):
            raise FileNotFoundError(src)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
        # versions 目录跟随主文件迁移，保证 trash/restore 不丢历史
        src_vdir = self._versions_dir(from_status, type_, mem_id)
        if os.path.isdir(src_vdir):
            dst_vdir = self._versions_dir(to_status, type_, mem_id)
            shutil.rmtree(dst_vdir, ignore_errors=True)
            shutil.move(src_vdir, dst_vdir)

    def delete_to_trash(self, type_: str, mem_id: str, from_status: str) -> None:
        self.move(mem_id, type_, from_status=from_status, to_status="trash")

    def restore_from_trash(self, type_: str, mem_id: str) -> None:
        """从 trash/<type>/<id>.md 移到 inbox/<type>/<id>.md。"""
        self.move(mem_id, type_, from_status="trash", to_status="inbox")

    def purge(self, status: str, type_: str, mem_id: str) -> None:
        """物理删除指定条目 + 其版本历史（不可恢复，maintenance 用于清理 trash）。"""
        p = entry_path(self.data_root, status, type_, mem_id)
        try:
            os.remove(p)
        except FileNotFoundError:
            pass
        shutil.rmtree(self._versions_dir(status, type_, mem_id), ignore_errors=True)

    def list_all(self) -> List[Tuple[str, str, str, str]]:
        out = []
        for status in sorted(VALID_STATUS):
            for type_ in sorted(VALID_TYPE):
                for path in scan_dir(self.data_root, status, type_):
                    mem_id = os.path.splitext(os.path.basename(path))[0]
                    out.append((status, type_, mem_id, path))
        return out

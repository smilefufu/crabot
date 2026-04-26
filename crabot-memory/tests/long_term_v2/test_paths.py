"""Paths 单元测试。"""
import os
import pytest
from pathlib import Path
from src.long_term_v2.paths import entry_path, ensure_dirs, scan_dir, status_of_path


def test_entry_path_inbox_fact(tmp_path):
    p = entry_path(str(tmp_path), "inbox", "fact", "mem-l-abc")
    assert p == os.path.join(str(tmp_path), "inbox", "fact", "mem-l-abc.md")


def test_entry_path_confirmed_lesson(tmp_path):
    p = entry_path(str(tmp_path), "confirmed", "lesson", "mem-l-xyz")
    assert "confirmed/lesson/mem-l-xyz.md" in p


def test_entry_path_rejects_invalid_status(tmp_path):
    with pytest.raises(ValueError):
        entry_path(str(tmp_path), "weird", "fact", "id")


def test_entry_path_rejects_invalid_type(tmp_path):
    with pytest.raises(ValueError):
        entry_path(str(tmp_path), "inbox", "weird", "id")


def test_ensure_dirs_creates_full_tree(tmp_path):
    ensure_dirs(str(tmp_path))
    for status in ["inbox", "confirmed", "trash"]:
        for typ in ["fact", "lesson", "concept"]:
            assert (tmp_path / status / typ).is_dir()


def test_scan_dir_lists_md_files(tmp_path):
    ensure_dirs(str(tmp_path))
    (tmp_path / "inbox" / "fact" / "mem-l-1.md").write_text("x")
    (tmp_path / "inbox" / "fact" / "mem-l-2.md").write_text("y")
    (tmp_path / "inbox" / "fact" / "ignored.txt").write_text("nope")
    files = sorted(scan_dir(str(tmp_path), "inbox", "fact"))
    assert files == [
        os.path.join(str(tmp_path), "inbox", "fact", "mem-l-1.md"),
        os.path.join(str(tmp_path), "inbox", "fact", "mem-l-2.md"),
    ]


def test_status_of_path_recognizes_each(tmp_path):
    ensure_dirs(str(tmp_path))
    p = entry_path(str(tmp_path), "confirmed", "fact", "mem-l-x")
    assert status_of_path(str(tmp_path), p) == ("confirmed", "fact")

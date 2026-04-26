"""MemoryStore 测试。"""
import pytest
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors,
)
from src.long_term_v2.store import MemoryStore


def make_entry(mem_id: str, type_: str = "fact", maturity: str = "observed", brief="X"):
    return MemoryEntry(
        frontmatter=MemoryFrontmatter(
            id=mem_id,
            type=type_,
            maturity=maturity,
            brief=brief,
            author="user",
            source_ref=SourceRef(type="manual"),
            source_trust=5,
            content_confidence=5,
            importance_factors=ImportanceFactors(
                proximity=0.5, surprisal=0.5,
                entity_priority=0.5, unambiguity=0.5,
            ),
            event_time="2026-04-23T10:00:00Z",
            ingestion_time="2026-04-23T10:01:00Z",
        ),
        body="content",
    )


def test_write_then_read(tmp_path):
    s = MemoryStore(str(tmp_path))
    e = make_entry("mem-l-1")
    s.write(e, status="inbox")
    e2 = s.read("inbox", "fact", "mem-l-1")
    assert e2.frontmatter.id == "mem-l-1"
    assert e2.body == "content"


def test_read_missing_raises(tmp_path):
    s = MemoryStore(str(tmp_path))
    with pytest.raises(FileNotFoundError):
        s.read("inbox", "fact", "nope")


def test_move_inbox_to_confirmed(tmp_path):
    s = MemoryStore(str(tmp_path))
    e = make_entry("mem-l-2", type_="fact", maturity="observed")
    s.write(e, status="inbox")
    s.move("mem-l-2", "fact", from_status="inbox", to_status="confirmed")
    with pytest.raises(FileNotFoundError):
        s.read("inbox", "fact", "mem-l-2")
    assert s.read("confirmed", "fact", "mem-l-2").frontmatter.id == "mem-l-2"


def test_delete_to_trash(tmp_path):
    s = MemoryStore(str(tmp_path))
    e = make_entry("mem-l-3", type_="lesson", maturity="case")
    s.write(e, status="confirmed")
    s.delete_to_trash("lesson", "mem-l-3", from_status="confirmed")
    assert s.read("trash", "lesson", "mem-l-3").frontmatter.id == "mem-l-3"


def test_list_all_returns_all_files_with_status_and_type(tmp_path):
    s = MemoryStore(str(tmp_path))
    s.write(make_entry("mem-l-a", "fact", "observed"), status="inbox")
    s.write(make_entry("mem-l-b", "lesson", "case"), status="confirmed")
    s.write(make_entry("mem-l-c", "concept", "draft"), status="inbox")
    items = sorted(s.list_all())
    assert len(items) == 3
    statuses = {(it[0], it[1], it[2]) for it in items}
    assert ("inbox", "fact", "mem-l-a") in statuses
    assert ("confirmed", "lesson", "mem-l-b") in statuses
    assert ("inbox", "concept", "mem-l-c") in statuses


def test_write_overwrites(tmp_path):
    s = MemoryStore(str(tmp_path))
    e1 = make_entry("mem-l-x", brief="v1")
    s.write(e1, status="inbox")
    e2 = make_entry("mem-l-x", brief="v2-new")
    s.write(e2, status="inbox")
    e3 = s.read("inbox", "fact", "mem-l-x")
    assert e3.frontmatter.brief == "v2-new"


def test_restore_from_trash_moves_to_inbox(tmp_path):
    s = MemoryStore(str(tmp_path))
    e = make_entry("mem-l-restore", type_="fact", maturity="observed")
    s.write(e, status="confirmed")
    s.delete_to_trash("fact", "mem-l-restore", from_status="confirmed")
    # Sanity: entry now in trash
    assert s.read("trash", "fact", "mem-l-restore").frontmatter.id == "mem-l-restore"
    # Restore
    s.restore_from_trash("fact", "mem-l-restore")
    with pytest.raises(FileNotFoundError):
        s.read("trash", "fact", "mem-l-restore")
    assert s.read("inbox", "fact", "mem-l-restore").frontmatter.id == "mem-l-restore"


def test_restore_from_trash_missing_raises(tmp_path):
    s = MemoryStore(str(tmp_path))
    with pytest.raises(FileNotFoundError):
        s.restore_from_trash("fact", "nope")

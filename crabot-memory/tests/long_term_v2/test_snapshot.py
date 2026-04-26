"""Confirmed 快照（用于 Agent prompt prefix cache 保护）。"""
import pytest
from src.long_term_v2.snapshot import build_confirmed_snapshot
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors,
)
from src.long_term_v2.paths import entry_path


def _write(store, index, mid, type_, brief, status="confirmed"):
    fm = MemoryFrontmatter(
        id=mid, type=type_,
        maturity={"fact": "confirmed", "lesson": "rule", "concept": "established"}[type_],
        brief=brief, author="system",
        source_ref=SourceRef(type="manual"),
        source_trust=3, content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-23T00:00:00Z",
        ingestion_time="2026-04-23T00:00:00Z",
    )
    e = MemoryEntry(frontmatter=fm, body=f"body of {mid}")
    store.write(e, status=status)
    index.upsert(e, path=entry_path(store.data_root, status, type_, mid), status=status)


def test_snapshot_groups_by_type(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _write(store, index, "f1", "fact", "事实1")
    _write(store, index, "f2", "fact", "事实2")
    _write(store, index, "l1", "lesson", "经验1")
    _write(store, index, "c1", "concept", "概念1")
    snapshot = build_confirmed_snapshot(store, index)
    assert snapshot["snapshot_id"]
    assert snapshot["generated_at"]
    by_type = snapshot["by_type"]
    assert len(by_type["fact"]) == 2
    assert len(by_type["lesson"]) == 1
    assert len(by_type["concept"]) == 1


def test_snapshot_excludes_inbox_and_trash(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _write(store, index, "f1", "fact", "事实1", status="confirmed")
    _write(store, index, "f2", "fact", "事实2", status="inbox")
    _write(store, index, "f3", "fact", "事实3", status="trash")
    snap = build_confirmed_snapshot(store, index)
    ids = [b["id"] for b in snap["by_type"]["fact"]]
    assert ids == ["f1"]



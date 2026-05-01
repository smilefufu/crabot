"""SqliteIndex 单元测试。"""
import pytest
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, EntityRef,
)
from src.long_term_v2.sqlite_index import SqliteIndex


def make_entry(mem_id, entities=None, tags=None):
    return MemoryEntry(
        frontmatter=MemoryFrontmatter(
            id=mem_id,
            type="fact",
            maturity="observed",
            brief=f"brief of {mem_id}",
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
            entities=entities or [],
            tags=tags or [],
        ),
        body="body of " + mem_id,
    )


def test_upsert_then_find_by_entity(tmp_path):
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    e = make_entry("mem-l-1", entities=[EntityRef(type="friend", id="zhang3", name="张三")])
    idx.upsert(e, path="/tmp/x.md", status="confirmed")
    assert idx.find_by_entity("zhang3") == ["mem-l-1"]


def test_upsert_then_find_by_tag(tmp_path):
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    e = make_entry("mem-l-1", tags=["#scope:macos", "#project:crabot"])
    idx.upsert(e, path="/tmp/x.md", status="confirmed")
    assert "mem-l-1" in idx.find_by_tag("#scope:macos")
    assert "mem-l-1" in idx.find_by_tag("#project:crabot")


def test_delete_removes_entries(tmp_path):
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    e = make_entry(
        "mem-l-1",
        entities=[EntityRef(type="friend", id="zhang3", name="张三")],
        tags=["#x"],
    )
    idx.upsert(e, path="/tmp/x.md", status="confirmed")
    idx.delete("mem-l-1")
    assert idx.find_by_entity("zhang3") == []
    assert idx.find_by_tag("#x") == []


def test_upsert_replaces_old_entities(tmp_path):
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    e1 = make_entry("mem-l-1", entities=[EntityRef(type="friend", id="a", name="A")])
    idx.upsert(e1, path="/tmp/x.md", status="confirmed")
    e2 = make_entry("mem-l-1", entities=[EntityRef(type="friend", id="b", name="B")])
    idx.upsert(e2, path="/tmp/x.md", status="confirmed")
    assert idx.find_by_entity("a") == []
    assert idx.find_by_entity("b") == ["mem-l-1"]


def test_iter_brief_for_bm25_returns_all(tmp_path):
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    idx.upsert(make_entry("mem-l-1"), path="/tmp/a.md", status="confirmed")
    idx.upsert(make_entry("mem-l-2"), path="/tmp/b.md", status="inbox")
    rows = list(idx.iter_brief_for_bm25())
    ids = sorted(r[0] for r in rows)
    assert ids == ["mem-l-1", "mem-l-2"]


def _make_typed_entry(mem_id, type_="fact", maturity=None, tags=None,
                      ingestion_time="2026-04-23T10:01:00Z"):
    if maturity is None:
        maturity = {"fact": "observed", "lesson": "case", "concept": "draft"}[type_]
    return MemoryEntry(
        frontmatter=MemoryFrontmatter(
            id=mem_id,
            type=type_,
            maturity=maturity,
            brief=f"brief of {mem_id}",
            author="user",
            source_ref=SourceRef(type="manual"),
            source_trust=5,
            content_confidence=5,
            importance_factors=ImportanceFactors(
                proximity=0.5, surprisal=0.5,
                entity_priority=0.5, unambiguity=0.5,
            ),
            event_time="2026-04-23T10:00:00Z",
            ingestion_time=ingestion_time,
            tags=tags or [],
        ),
        body="body of " + mem_id,
    )


def test_list_entries_no_filters_returns_all(tmp_path):
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    idx.upsert(_make_typed_entry("mem-l-1", type_="fact"), path="/tmp/a.md", status="inbox")
    idx.upsert(_make_typed_entry("mem-l-2", type_="lesson"), path="/tmp/b.md", status="confirmed")
    rows = idx.list_entries()
    ids = sorted(r["id"] for r in rows)
    assert ids == ["mem-l-1", "mem-l-2"]


def test_list_entries_filters_by_type(tmp_path):
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    idx.upsert(_make_typed_entry("mem-l-1", type_="fact"), path="/tmp/a.md", status="inbox")
    idx.upsert(_make_typed_entry("mem-l-2", type_="lesson"), path="/tmp/b.md", status="confirmed")
    rows = idx.list_entries(type_="fact")
    assert [r["id"] for r in rows] == ["mem-l-1"]


def test_list_entries_filters_by_status(tmp_path):
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    idx.upsert(_make_typed_entry("mem-l-1", type_="fact"), path="/tmp/a.md", status="inbox")
    idx.upsert(_make_typed_entry("mem-l-2", type_="fact"), path="/tmp/b.md", status="confirmed")
    rows = idx.list_entries(status="inbox")
    assert [r["id"] for r in rows] == ["mem-l-1"]


def test_list_entries_filters_by_tags(tmp_path):
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    idx.upsert(_make_typed_entry("mem-l-1", tags=["#x"]), path="/tmp/a.md", status="inbox")
    idx.upsert(_make_typed_entry("mem-l-2", tags=["#y"]), path="/tmp/b.md", status="inbox")
    rows = idx.list_entries(tags=["#x"])
    assert [r["id"] for r in rows] == ["mem-l-1"]


def test_list_entries_pagination(tmp_path):
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    for i in range(5):
        idx.upsert(
            _make_typed_entry(
                f"mem-l-{i}",
                ingestion_time=f"2026-04-23T10:0{i}:00Z",
            ),
            path=f"/tmp/{i}.md",
            status="inbox",
        )
    page1 = idx.list_entries(limit=2, offset=0)
    page2 = idx.list_entries(limit=2, offset=2)
    assert len(page1) == 2
    assert len(page2) == 2
    page1_ids = {r["id"] for r in page1}
    page2_ids = {r["id"] for r in page2}
    assert page1_ids.isdisjoint(page2_ids)


def test_list_entries_sort_ingestion_time_desc(tmp_path):
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    idx.upsert(
        _make_typed_entry("mem-l-old", ingestion_time="2026-04-01T00:00:00Z"),
        path="/tmp/a.md", status="inbox",
    )
    idx.upsert(
        _make_typed_entry("mem-l-new", ingestion_time="2026-04-23T00:00:00Z"),
        path="/tmp/b.md", status="inbox",
    )
    rows = idx.list_entries(sort="ingestion_time_desc")
    assert [r["id"] for r in rows] == ["mem-l-new", "mem-l-old"]
    rows_asc = idx.list_entries(sort="ingestion_time_asc")
    assert [r["id"] for r in rows_asc] == ["mem-l-old", "mem-l-new"]


def test_extend_observation_window_adds_days(tmp_path):
    from src.long_term_v2.sqlite_index import SqliteIndex
    from src.long_term_v2.schema import (
        MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, Observation,
    )
    from src.long_term_v2.paths import entry_path
    from src.long_term_v2.store import MemoryStore

    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    fm = MemoryFrontmatter(
        id="mem-l-1", type="lesson", maturity="rule",
        brief="b", author="agent:w1",
        source_ref=SourceRef(type="reflection"),
        source_trust=3, content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-01T00:00:00Z",
        ingestion_time="2026-04-01T00:00:00Z",
        observation=Observation(
            started_at="2026-04-01T00:00:00Z",
            window_days=7,
            outcome="pending",
        ),
    )
    e = MemoryEntry(frontmatter=fm, body="")
    store.write(e, status="confirmed")
    index.upsert(e, path=entry_path(store.data_root, "confirmed", "lesson", "mem-l-1"), status="confirmed")

    index.extend_observation_window("mem-l-1", days=7)
    row = index.get_row("mem-l-1")
    assert row["observation_window_days"] == 14

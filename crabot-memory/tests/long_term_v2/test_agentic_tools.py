"""Agentic fallback tools: grep / list_recent / find_by_entity / find_by_tag / get_cases_about."""
import pytest
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors,
    EntityRef, LessonMeta,
)
from src.long_term_v2.agentic_tools import AgenticTools
from src.long_term_v2.paths import entry_path


def _entry(mem_id, type_, maturity, brief, body, event_time, entities=None, tags=None,
           lesson_meta=None):
    return MemoryEntry(
        frontmatter=MemoryFrontmatter(
            id=mem_id, type=type_, maturity=maturity,
            brief=brief, author="user",
            source_ref=SourceRef(type="manual"),
            source_trust=5, content_confidence=5,
            importance_factors=ImportanceFactors(
                proximity=0.5, surprisal=0.5,
                entity_priority=0.5, unambiguity=0.5,
            ),
            entities=entities or [],
            tags=tags or [],
            event_time=event_time,
            ingestion_time=event_time,
            lesson_meta=lesson_meta,
        ),
        body=body,
    )


@pytest.fixture
def tools(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    return AgenticTools(store=store, index=idx), store, idx


def _persist(store, idx, entry):
    store.write(entry, status="confirmed")
    path = entry_path(store.data_root, "confirmed", entry.frontmatter.type, entry.frontmatter.id)
    idx.upsert(entry, path=path, status="confirmed")


def test_grep_memory_substring(tools):
    t, store, idx = tools
    _persist(store, idx, _entry("m1", "fact", "confirmed",
                                "张三微信", "wxid_test123",
                                "2026-04-01T10:00:00Z"))
    _persist(store, idx, _entry("m2", "fact", "confirmed",
                                "饮食偏好", "tomato hater",
                                "2026-04-01T10:00:00Z"))
    out = t.grep_memory("wxid", type_=None, limit=10)
    ids = [r["id"] for r in out]
    assert ids == ["m1"]


def test_grep_memory_filtered_by_type(tools):
    t, store, idx = tools
    _persist(store, idx, _entry("a", "fact", "confirmed", "alpha", "shared",
                                "2026-04-01T10:00:00Z"))
    _persist(store, idx, _entry("b", "lesson", "case", "beta", "shared",
                                "2026-04-01T10:00:00Z"))
    ids = [r["id"] for r in t.grep_memory("shared", type_="fact", limit=10)]
    assert ids == ["a"]


def test_list_recent_orders_by_event_time_desc(tools):
    t, store, idx = tools
    _persist(store, idx, _entry("a", "fact", "confirmed", "old", "x",
                                "2026-01-01T10:00:00Z"))
    _persist(store, idx, _entry("b", "fact", "confirmed", "new", "y",
                                "2026-04-01T10:00:00Z"))
    ids = [r["id"] for r in t.list_recent(window_days=365, type_=None, limit=10)]
    assert ids == ["b", "a"]


def test_find_by_entity_returns_brief(tools):
    t, store, idx = tools
    _persist(store, idx, _entry(
        "m1", "fact", "confirmed", "张三微信", "wxid",
        "2026-04-01T10:00:00Z",
        entities=[EntityRef(type="friend", id="z3", name="张三")],
    ))
    out = t.find_by_entity_brief("z3")
    assert out == [{"id": "m1", "brief": "张三微信", "type": "fact"}]


def test_find_by_tag_returns_brief(tools):
    t, store, idx = tools
    _persist(store, idx, _entry(
        "m1", "fact", "confirmed", "macOS 终端", "x",
        "2026-04-01T10:00:00Z", tags=["#scope:macos"],
    ))
    out = t.find_by_tag_brief("#scope:macos")
    assert out == [{"id": "m1", "brief": "macOS 终端", "type": "fact"}]


def test_get_cases_about_filters_lesson_case(tools):
    t, store, idx = tools
    _persist(store, idx, _entry(
        "g1", "lesson", "rule", "scenario 抽象", "x",
        "2026-04-01T10:00:00Z",
        lesson_meta=LessonMeta(scenario="发表情", outcome="success"),
    ))
    _persist(store, idx, _entry(
        "c1", "lesson", "case", "飞书发表情", "x",
        "2026-04-01T10:00:00Z",
        lesson_meta=LessonMeta(scenario="飞书发表情", outcome="success"),
    ))
    out = t.get_cases_about("飞书发表情")
    assert [r["id"] for r in out] == ["c1"]

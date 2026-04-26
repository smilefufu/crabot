"""Bi-temporal range queries against SqliteIndex."""
import pytest
from datetime import datetime, timedelta, timezone
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors,
)
from src.long_term_v2.bi_temporal import parse_relative_window, to_iso_z


def _make_entry(mem_id: str, event_time: str, ingestion_time: str) -> MemoryEntry:
    fm = MemoryFrontmatter(
        id=mem_id,
        type="fact",
        maturity="confirmed",
        brief=f"brief-{mem_id}",
        author="user",
        source_ref=SourceRef(type="manual"),
        source_trust=5,
        content_confidence=5,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5,
            entity_priority=0.5, unambiguity=0.5,
        ),
        event_time=event_time,
        ingestion_time=ingestion_time,
    )
    return MemoryEntry(frontmatter=fm, body=f"body-{mem_id}")


@pytest.fixture
def idx(tmp_path):
    return SqliteIndex(str(tmp_path / "idx.db"))


def test_find_by_time_range_event_time(idx):
    idx.upsert(_make_entry("a", "2026-01-01T10:00:00Z", "2026-04-01T10:00:00Z"),
               path="/x/a.md", status="confirmed")
    idx.upsert(_make_entry("b", "2026-02-15T10:00:00Z", "2026-04-01T10:00:00Z"),
               path="/x/b.md", status="confirmed")
    idx.upsert(_make_entry("c", "2026-03-30T10:00:00Z", "2026-04-01T10:00:00Z"),
               path="/x/c.md", status="confirmed")

    out = idx.find_by_time_range(
        field="event_time",
        start="2026-02-01T00:00:00Z",
        end="2026-03-01T00:00:00Z",
        limit=10,
    )
    assert out == ["b"]


def test_find_by_time_range_ingestion_time(idx):
    idx.upsert(_make_entry("a", "2026-01-01T10:00:00Z", "2026-04-10T10:00:00Z"),
               path="/x/a.md", status="confirmed")
    idx.upsert(_make_entry("b", "2026-01-01T10:00:00Z", "2026-04-20T10:00:00Z"),
               path="/x/b.md", status="confirmed")
    out = idx.find_by_time_range(
        field="ingestion_time",
        start="2026-04-15T00:00:00Z",
        end="2026-04-25T00:00:00Z",
        limit=10,
    )
    assert out == ["b"]


def test_find_by_time_range_limit(idx):
    for i in range(5):
        idx.upsert(
            _make_entry(f"m{i}", f"2026-02-{i+1:02d}T10:00:00Z", "2026-04-01T10:00:00Z"),
            path=f"/x/m{i}.md", status="confirmed",
        )
    out = idx.find_by_time_range(
        field="event_time",
        start="2026-02-01T00:00:00Z",
        end="2026-03-01T00:00:00Z",
        limit=2,
    )
    assert len(out) == 2


def test_find_by_time_range_invalid_field(idx):
    with pytest.raises(ValueError, match="invalid field"):
        idx.find_by_time_range("brief", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", 10)


# --- bi_temporal module tests ---


def _fixed_now():
    return datetime(2026, 4, 23, 12, 0, 0, tzinfo=timezone.utc)


def test_parse_today():
    out = parse_relative_window("今天", now=_fixed_now())
    assert out == ("2026-04-23T00:00:00Z", "2026-04-24T00:00:00Z")


def test_parse_yesterday_english():
    out = parse_relative_window("yesterday", now=_fixed_now())
    assert out == ("2026-04-22T00:00:00Z", "2026-04-23T00:00:00Z")


def test_parse_last_week():
    out = parse_relative_window("上周", now=_fixed_now())
    assert out is not None
    start, end = out
    assert start < end


def test_parse_unknown_expression_returns_none():
    assert parse_relative_window("某天", now=_fixed_now()) is None
    assert parse_relative_window("", now=_fixed_now()) is None


def test_to_iso_z_replaces_offset():
    dt = datetime(2026, 4, 23, 12, 0, 0, tzinfo=timezone.utc)
    assert to_iso_z(dt) == "2026-04-23T12:00:00Z"


def test_to_iso_z_converts_to_utc():
    tz = timezone(timedelta(hours=8))
    dt = datetime(2026, 4, 23, 20, 0, 0, tzinfo=tz)
    assert to_iso_z(dt) == "2026-04-23T12:00:00Z"

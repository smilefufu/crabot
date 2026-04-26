"""Phase 3 SqliteIndex 扩展。"""
import pytest
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, Observation,
)


def _make_entry(mid="mem-l-1", type_="lesson", maturity="case") -> MemoryEntry:
    fm = MemoryFrontmatter(
        id=mid, type=type_, maturity=maturity,
        brief="b", author="system",
        source_ref=SourceRef(type="manual"),
        source_trust=3, content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-23T00:00:00Z",
        ingestion_time="2026-04-23T00:00:00Z",
    )
    return MemoryEntry(frontmatter=fm, body="body")


def test_evolution_mode_kv(tmp_path):
    idx = SqliteIndex(str(tmp_path / "x.db"))
    assert idx.get_evolution_mode() == ("balanced", None, None)  # default
    idx.set_evolution_mode("harden", "新摄入大量 case")
    mode, reason, ts = idx.get_evolution_mode()
    assert mode == "harden"
    assert reason == "新摄入大量 case"
    assert ts is not None


def test_scan_expired_observation(tmp_path):
    idx = SqliteIndex(str(tmp_path / "x.db"))
    fm = MemoryFrontmatter(
        id="m1", type="fact", maturity="confirmed",
        brief="b", author="system",
        source_ref=SourceRef(type="manual"),
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
    idx.upsert(MemoryEntry(frontmatter=fm, body=""), path=str(tmp_path / "m1.md"), status="confirmed")

    # 当前时间 2026-04-23 → 已过期 15 天
    expired = idx.scan_expired_observation(now_iso="2026-04-23T00:00:00Z")
    assert len(expired) == 1
    assert expired[0]["id"] == "m1"


def test_bump_use_count(tmp_path):
    idx = SqliteIndex(str(tmp_path / "x.db"))
    idx.upsert(_make_entry("m1", type_="lesson", maturity="case"),
               path=str(tmp_path / "m1.md"), status="confirmed")
    idx.bump_use_count("m1", now_iso="2026-04-23T00:00:00Z")
    row = idx.get_row("m1")
    assert row["use_count"] >= 1
    assert row["last_validated_at"] == "2026-04-23T00:00:00Z"

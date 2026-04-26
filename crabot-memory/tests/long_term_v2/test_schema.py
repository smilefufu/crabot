"""Schema 单元测试。"""
import pytest
from datetime import datetime
from src.long_term_v2.schema import (
    MemoryFrontmatter, MemoryEntry, SourceRef,
    ImportanceFactors, LessonMeta, Observation, EntityRef,
)


def test_frontmatter_minimum_fact():
    fm = MemoryFrontmatter(
        id="mem-l-abc123",
        type="fact",
        maturity="observed",
        brief="张三的微信是 wxid_xx",
        author="agent:agent-1",
        source_ref=SourceRef(type="conversation"),
        source_trust=4,
        content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.3,
            entity_priority=0.7, unambiguity=0.9,
        ),
        event_time="2026-04-23T10:00:00Z",
        ingestion_time="2026-04-23T10:01:00Z",
    )
    assert fm.type == "fact"
    assert fm.maturity == "observed"
    assert fm.lesson_meta is None
    assert fm.observation is None
    assert fm.version == 1


def test_frontmatter_lesson_with_meta():
    fm = MemoryFrontmatter(
        id="mem-l-lesson1",
        type="lesson",
        maturity="case",
        brief="飞书发表情用 emoji_id",
        author="agent:agent-1",
        source_ref=SourceRef(type="reflection", task_id="task-1"),
        source_trust=5,
        content_confidence=4,
        importance_factors=ImportanceFactors(
            proximity=0.6, surprisal=0.5,
            entity_priority=0.4, unambiguity=0.8,
        ),
        event_time="2026-04-23T10:00:00Z",
        ingestion_time="2026-04-23T10:01:00Z",
        lesson_meta=LessonMeta(
            scenario="飞书发图",
            outcome="success",
            use_count=3,
        ),
    )
    assert fm.lesson_meta.outcome == "success"
    assert fm.lesson_meta.use_count == 3
    assert fm.lesson_meta.source_cases == []


def test_brief_max_length():
    with pytest.raises(ValueError, match="brief"):
        MemoryFrontmatter(
            id="mem-l-too-long",
            type="fact",
            maturity="observed",
            brief="a" * 81,  # 超过 80
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
        )


def test_invalid_maturity_for_type():
    """fact 不应有 case maturity。"""
    with pytest.raises(ValueError, match="maturity.*fact"):
        MemoryFrontmatter(
            id="mem-l-x",
            type="fact",
            maturity="case",  # 错配
            brief="x",
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
        )


def test_memory_entry_round_trip_data():
    fm = MemoryFrontmatter(
        id="mem-l-xy",
        type="concept",
        maturity="draft",
        brief="Crabot Agent v2 用 query()",
        author="user",
        source_ref=SourceRef(type="manual"),
        source_trust=5,
        content_confidence=4,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5,
            entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-23T10:00:00Z",
        ingestion_time="2026-04-23T10:01:00Z",
    )
    entry = MemoryEntry(frontmatter=fm, body="Detailed body here.")
    assert entry.frontmatter.id == "mem-l-xy"
    assert entry.body == "Detailed body here."


def test_importance_factors_bounds():
    with pytest.raises(ValueError):
        ImportanceFactors(
            proximity=1.5, surprisal=0.5,
            entity_priority=0.5, unambiguity=0.5,
        )

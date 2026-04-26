"""Phase 3 schema 增量校验。"""
from src.long_term_v2.schema import (
    MemoryFrontmatter, SourceRef, ImportanceFactors, Observation,
    default_maturity_fresh,
)


def _base_kwargs(type_: str = "lesson") -> dict:
    return dict(
        id="mem-l-x",
        type=type_,
        maturity=default_maturity_fresh(type_),
        brief="x",
        author="system",
        source_ref=SourceRef(type="manual"),
        source_trust=3,
        content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-23T00:00:00Z",
        ingestion_time="2026-04-23T00:00:00Z",
    )


def test_observation_extras_optional():
    s = Observation(
        started_at="2026-04-23T00:00:00Z",
        window_days=7,
        outcome="pending",
    )
    assert s.last_seen_at is None
    assert s.stale_check_count == 0


def test_observation_extras_present():
    s = Observation(
        started_at="2026-04-23T00:00:00Z",
        window_days=7,
        outcome="pending",
        last_seen_at="2026-04-25T00:00:00Z",
        stale_check_count=2,
    )
    assert s.last_seen_at == "2026-04-25T00:00:00Z"
    assert s.stale_check_count == 2

"""Evolution mode persistence + case→rule auto-synthesis.

Per spec §6.4 (2026-04-24 revision), the synthesis of a general "rule" lesson
from ≥3 same-scenario "case" lessons happens automatically into
confirmed/lesson/<rule_id>.md with maturity=rule and an observation window.
No proposal review step.

"""
from .schema import (
    MemoryEntry,
    MemoryFrontmatter,
    SourceRef,
    ImportanceFactors,
    LessonMeta,
    Observation,
    new_memory_id,
    utc_now_iso_z,
)
from .paths import entry_path
from .sqlite_index import SqliteIndex


VALID_MODES = frozenset({"balanced", "innovate", "harden", "repair-only"})

# spec §6.4: 自动 case→rule 合成要求至少 3 条同 scenario 的 case 作为依据。
MIN_SOURCE_CASES = 3


def get_evolution_mode(index: SqliteIndex) -> dict:
    mode, reason, ts = index.get_evolution_mode()
    return {"mode": mode, "reason": reason, "last_changed_at": ts}


def set_evolution_mode(index: SqliteIndex, *, mode: str, reason: str | None) -> dict:
    if mode not in VALID_MODES:
        raise ValueError(f"Invalid evolution mode: {mode}. Allowed: {sorted(VALID_MODES)}")
    index.set_evolution_mode(mode, reason)
    return get_evolution_mode(index)


def synthesize_rule(
    *,
    store,
    index: SqliteIndex,
    source_cases: list[str],
    brief: str,
    content: str,
    scenario: str | None = None,
    source_trust: int = 4,
    content_confidence: int = 4,
    window_days: int = 7,
) -> str:
    """Create a new rule entry in confirmed/lesson/ with an observation window.

    Returns the new rule's id.
    """
    if len(source_cases) < MIN_SOURCE_CASES:
        raise ValueError(
            f"case→rule 合成要求至少 {MIN_SOURCE_CASES} 条 source_cases，"
            f"实际仅 {len(source_cases)} 条（spec §6.4）。"
        )

    now_iso = utc_now_iso_z()
    rule_id = new_memory_id()
    fm = MemoryFrontmatter(
        id=rule_id,
        type="lesson",
        maturity="rule",
        brief=brief,
        author="agent:reflection",
        source_ref=SourceRef(type="reflection"),
        source_trust=source_trust,
        content_confidence=content_confidence,
        importance_factors=ImportanceFactors(
            proximity=0.7, surprisal=0.6, entity_priority=0.6, unambiguity=0.8,
        ),
        event_time=now_iso,
        ingestion_time=now_iso,
        lesson_meta=LessonMeta(
            scenario=scenario if scenario is not None else "",
            outcome="success",
            source_cases=list(source_cases),
        ),
        observation=Observation(
            started_at=now_iso,
            window_days=window_days,
            outcome="pending",
        ),
    )
    entry = MemoryEntry(frontmatter=fm, body=content)
    store.write(entry, status="confirmed")
    index.upsert(
        entry,
        path=entry_path(store.data_root, "confirmed", "lesson", rule_id),
        status="confirmed",
    )
    return rule_id

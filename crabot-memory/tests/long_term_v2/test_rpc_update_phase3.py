"""Phase 3 update_long_term 扩展（不引入 LLM）。"""
import pytest
from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, LessonMeta,
)
from src.long_term_v2.paths import entry_path


def _seed(tmp_path, type_="fact", maturity="confirmed"):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    fm = MemoryFrontmatter(
        id="m1", type=type_, maturity=maturity,
        brief="b", author="system",
        source_ref=SourceRef(type="manual"),
        source_trust=3, content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-23T00:00:00Z",
        ingestion_time="2026-04-23T00:00:00Z",
        lesson_meta=LessonMeta(scenario="x", outcome="success") if type_ == "lesson" else None,
    )
    e = MemoryEntry(frontmatter=fm, body="body")
    store.write(e, status="confirmed")
    index.upsert(e, path=entry_path(store.data_root, "confirmed", type_, "m1"), status="confirmed")
    rpc = LongTermV2Rpc(store=store, index=index)
    return rpc, store, index


@pytest.mark.asyncio
async def test_increment_content_confidence(tmp_path):
    rpc, store, index = _seed(tmp_path, type_="fact")
    out = await rpc.update_long_term({
        "id": "m1",
        "patch": {"content_confidence_increment": 1},
    })
    assert out["status"] == "ok"
    entry = store.read("confirmed", "fact", "m1")
    assert entry.frontmatter.content_confidence == 4


@pytest.mark.asyncio
async def test_increment_does_not_exceed_5(tmp_path):
    rpc, store, index = _seed(tmp_path, type_="fact")
    for _ in range(5):
        await rpc.update_long_term({"id": "m1", "patch": {"content_confidence_increment": 1}})
    entry = store.read("confirmed", "fact", "m1")
    assert entry.frontmatter.content_confidence == 5


@pytest.mark.asyncio
async def test_bump_lesson_use_count(tmp_path):
    rpc, store, index = _seed(tmp_path, type_="lesson", maturity="rule")
    out = await rpc.update_long_term({
        "id": "m1",
        "patch": {"use_count_increment": 1, "validated_at": "2026-04-23T12:00:00Z"},
    })
    assert out["status"] == "ok"
    entry = store.read("confirmed", "lesson", "m1")
    assert entry.frontmatter.lesson_meta.use_count >= 1
    assert entry.frontmatter.lesson_meta.last_validated_at == "2026-04-23T12:00:00Z"


@pytest.mark.asyncio
async def test_mark_observation_outcome_pass(tmp_path):
    from src.long_term_v2.schema import Observation
    rpc, store, index = _seed(tmp_path, type_="fact")
    # 先注入 observation
    entry = store.read("confirmed", "fact", "m1")
    new_fm = entry.frontmatter.model_copy(update={
        "observation": Observation(
            started_at="2026-04-23T00:00:00Z",
            window_days=7,
            outcome="pending",
        ),
    })
    new_entry = entry.model_copy(update={"frontmatter": new_fm})
    store.write(new_entry, status="confirmed")
    index.upsert(new_entry, path=entry_path(store.data_root, "confirmed", "fact", "m1"), status="confirmed")

    out = await rpc.update_long_term({
        "id": "m1",
        "patch": {"observation_outcome": "pass"},
    })
    assert out["status"] == "ok"
    entry = store.read("confirmed", "fact", "m1")
    assert entry.frontmatter.observation.outcome == "pass"


@pytest.mark.asyncio
async def test_update_lesson_brief_preserves_use_count(tmp_path):
    """Regression: editing brief/tags must not wipe LessonMeta.use_count or last_validated_at."""
    rpc, store, index = _seed(tmp_path, type_="lesson", maturity="rule")
    # Bump use_count first
    await rpc.update_long_term({
        "id": "m1",
        "patch": {"use_count_increment": 5, "validated_at": "2026-04-20T12:00:00Z"},
    })
    before = store.read("confirmed", "lesson", "m1")
    assert before.frontmatter.lesson_meta.use_count == 5
    assert before.frontmatter.lesson_meta.last_validated_at == "2026-04-20T12:00:00Z"

    # Now edit only brief — use_count and last_validated_at must survive
    out = await rpc.update_long_term({
        "id": "m1",
        "patch": {"brief": "updated brief"},
    })
    assert out["status"] == "ok"
    after = store.read("confirmed", "lesson", "m1")
    assert after.frontmatter.brief == "updated brief"
    assert after.frontmatter.lesson_meta.use_count == 5, "use_count was reset by unrelated update"
    assert after.frontmatter.lesson_meta.last_validated_at == "2026-04-20T12:00:00Z", \
        "last_validated_at was reset by unrelated update"


@pytest.mark.asyncio
async def test_update_lesson_tags_preserves_lesson_meta(tmp_path):
    """Same regression for tags update path."""
    rpc, store, index = _seed(tmp_path, type_="lesson", maturity="rule")
    await rpc.update_long_term({
        "id": "m1",
        "patch": {"use_count_increment": 3},
    })
    out = await rpc.update_long_term({
        "id": "m1",
        "patch": {"tags": ["new-tag"], "entities": []},
    })
    assert out["status"] == "ok"
    after = store.read("confirmed", "lesson", "m1")
    assert after.frontmatter.tags == ["new-tag"]
    assert after.frontmatter.lesson_meta.use_count == 3, "use_count lost on tags update"
    assert after.frontmatter.lesson_meta.scenario == "x", "scenario lost on tags update"

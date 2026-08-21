"""Memory v2 lifecycle regression coverage for the 2026-08-20 contract."""
import pytest

from src.long_term_v2.maintenance import MaintenanceConfig, run_maintenance
from src.long_term_v2.lifecycle import move_entry
from src.long_term_v2.paths import entry_path
from src.long_term_v2.recall_pipeline import RecallPipeline
from src.long_term_v2.reranker import FallbackReranker
from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.schema import (
    EntityRef,
    ImportanceFactors,
    LessonMeta,
    MemoryEntry,
    MemoryFrontmatter,
    Observation,
    SourceRef,
)
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.store import MemoryStore


def _rpc(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "index.db"))
    return LongTermV2Rpc(store=store, index=index), store, index


def _frontmatter(mem_id, *, type_="fact", maturity="observed", ingestion_time="2026-08-20T00:00:00Z", **extra):
    base = {
        "id": mem_id,
        "type": type_,
        "maturity": maturity,
        "brief": mem_id,
        "author": "test",
        "source_ref": SourceRef(type="manual"),
        "source_trust": 3,
        "content_confidence": 3,
        "importance_factors": ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        "event_time": ingestion_time,
        "ingestion_time": ingestion_time,
    }
    base.update(extra)
    return MemoryFrontmatter(**base)


def _persist(store, index, mem_id, *, status, type_="fact", body="needle", **extra):
    entry = MemoryEntry(frontmatter=_frontmatter(mem_id, type_=type_, **extra), body=body)
    store.write(entry, status=status)
    index.upsert(entry, entry_path(store.data_root, status, type_, mem_id), status)
    return entry


@pytest.mark.asyncio
async def test_promote_inbox_entry_is_the_only_normal_status_transition(tmp_path):
    rpc, store, index = _rpc(tmp_path)
    captured = await rpc.quick_capture({"type": "lesson", "brief": "case", "content": "body"})
    mem_id = captured["id"]
    inbox_entry = store.read("inbox", "lesson", mem_id)
    assert inbox_entry.frontmatter.inbox_entered_at is not None

    promoted = await rpc.promote_inbox_entry({"id": mem_id})
    assert promoted == {"id": mem_id, "status": "ok"}
    confirmed = store.read("confirmed", "lesson", mem_id)
    assert confirmed.frontmatter.inbox_entered_at is None
    assert index.locate(mem_id)["status"] == "confirmed"
    assert await rpc.promote_inbox_entry({"id": mem_id}) == promoted

    await rpc.delete_memory({"id": mem_id})
    rejected = await rpc.promote_inbox_entry({"id": mem_id})
    assert rejected["error"] == "INVALID_STATE"


@pytest.mark.asyncio
async def test_trash_and_restore_reset_lifecycle_timestamps(tmp_path):
    rpc, store, _ = _rpc(tmp_path)
    written = await rpc.quick_capture({"type": "fact", "brief": "candidate", "content": "body"})
    mem_id = written["id"]

    await rpc.delete_memory({"id": mem_id, "now_iso": "2026-08-20T03:00:00Z"})
    trashed = store.read("trash", "fact", mem_id)
    assert trashed.frontmatter.trashed_at == "2026-08-20T03:00:00Z"
    assert trashed.frontmatter.inbox_entered_at is None

    await rpc.restore_memory({"id": mem_id, "now_iso": "2026-08-20T04:00:00Z"})
    restored = store.read("confirmed", "fact", mem_id)
    assert restored.frontmatter.trashed_at is None
    assert restored.frontmatter.inbox_entered_at is None


def test_move_entry_restores_source_when_target_update_cannot_be_indexed(tmp_path, monkeypatch):
    _, store, index = _rpc(tmp_path)
    entry = _persist(
        store, index, "restore-original", status="confirmed",
        observation=Observation(started_at="2026-08-20T00:00:00Z", outcome="pending"),
    )
    original_upsert = index.upsert

    def fail_trash_upsert(entry, path, status):
        if status == "trash":
            raise RuntimeError("index unavailable")
        original_upsert(entry, path, status)

    monkeypatch.setattr(index, "upsert", fail_trash_upsert)
    failed_observation = entry.frontmatter.observation.model_copy(
        update={"outcome": "fail"}
    )
    with pytest.raises(RuntimeError, match="index unavailable"):
        move_entry(
            store,
            index,
            entry,
            from_status="confirmed",
            to_status="trash",
            now_iso="2026-08-21T00:00:00Z",
            target_frontmatter_updates={"observation": failed_observation},
        )

    restored = store.read("confirmed", "fact", "restore-original")
    assert restored.frontmatter.observation.outcome == "pending"
    assert index.locate("restore-original")["status"] == "confirmed"


@pytest.mark.asyncio
async def test_historical_inbox_preview_and_confirmed_batches_are_bounded_and_resumable(tmp_path):
    rpc, store, index = _rpc(tmp_path)
    for n in range(201):
        _persist(
            store, index, f"historical-{n:03}", status="inbox",
            ingestion_time="2020-01-01T00:00:00Z",
        )
    _persist(
        store, index, "new-format", status="inbox",
        ingestion_time="2026-08-20T00:00:00Z",
        inbox_entered_at="2026-08-20T00:00:00Z",
    )

    preview = await rpc.preview_historical_inbox({"now_iso": "2026-08-20T00:00:00Z"})
    assert preview["estimated_move_count"] == 201
    assert preview["by_type"] == {"fact": 201, "lesson": 0, "concept": 0}
    assert preview["by_age"]["over_365_days"] == 201

    unconfirmed = await rpc.migrate_historical_inbox_batch({"now_iso": "2026-08-20T03:00:00Z"})
    assert unconfirmed == {"error": "CONFIRMATION_REQUIRED"}
    assert index.locate("historical-000")["status"] == "inbox"

    first = await rpc.migrate_historical_inbox_batch({
        "confirmed": True,
        "now_iso": "2026-08-20T03:00:00Z",
    })
    assert first["batch_size"] == 200
    assert first["moved"] == 200
    assert first["remaining"] == 1
    assert first["failed"] == []
    assert store.read("trash", "fact", "historical-000").frontmatter.trashed_at == "2026-08-20T03:00:00Z"
    assert index.locate("new-format")["status"] == "inbox"

    second = await rpc.migrate_historical_inbox_batch({
        "confirmed": True,
        "now_iso": "2026-08-20T04:00:00Z",
    })
    assert second["moved"] == 1
    assert second["remaining"] == 0


@pytest.mark.asyncio
async def test_historical_inbox_batch_skips_missing_files_and_reports_them(tmp_path):
    rpc, store, index = _rpc(tmp_path)
    _persist(
        store, index, "readable", status="inbox",
        ingestion_time="2020-01-01T00:00:00Z",
    )
    missing = MemoryEntry(
        frontmatter=_frontmatter("missing-file", ingestion_time="2020-01-02T00:00:00Z"),
        body="missing",
    )
    index.upsert(
        missing,
        entry_path(store.data_root, "inbox", "fact", "missing-file"),
        "inbox",
    )
    missing_rule = MemoryEntry(
        frontmatter=_frontmatter(
            "missing-rule", type_="lesson", maturity="rule",
            lesson_meta=LessonMeta(source_cases=["unreadable-evidence"]),
        ),
        body="missing rule",
    )
    index.upsert(
        missing_rule,
        entry_path(store.data_root, "confirmed", "lesson", "missing-rule"),
        "confirmed",
    )

    preview = await rpc.preview_historical_inbox({"now_iso": "2026-08-20T00:00:00Z"})
    assert preview["estimated_move_count"] == 1

    batch = await rpc.migrate_historical_inbox_batch({
        "confirmed": True,
        "now_iso": "2026-08-20T03:00:00Z",
    })
    assert batch["moved"] == 1
    assert batch["remaining"] == 0
    assert [failure["id"] for failure in batch["failed"]] == ["missing-file"]
    assert index.locate("readable")["status"] == "trash"

    retry = await rpc.migrate_historical_inbox_batch({"confirmed": True})
    assert retry["moved"] == 0
    assert retry["remaining"] == 0
    assert [failure["id"] for failure in retry["failed"]] == ["missing-file"]


@pytest.mark.asyncio
async def test_historical_inbox_migration_preserves_confirmed_rule_evidence(tmp_path):
    rpc, store, index = _rpc(tmp_path)
    _persist(
        store, index, "protected-case", status="inbox",
        ingestion_time="2020-01-01T00:00:00Z",
    )
    _persist(
        store, index, "unrelated-case", status="inbox",
        ingestion_time="2020-01-02T00:00:00Z",
    )
    _persist(
        store, index, "rule", status="confirmed", type_="lesson", maturity="rule",
        lesson_meta=LessonMeta(source_cases=["protected-case"]),
    )

    preview = await rpc.preview_historical_inbox({"now_iso": "2026-08-20T00:00:00Z"})
    assert preview["estimated_move_count"] == 1
    assert preview["by_type"] == {"fact": 1, "lesson": 0, "concept": 0}

    batch = await rpc.migrate_historical_inbox_batch({
        "confirmed": True,
        "now_iso": "2026-08-20T03:00:00Z",
    })
    assert batch["moved"] == 1
    assert batch["remaining"] == 0
    assert index.locate("protected-case")["status"] == "inbox"
    assert index.locate("unrelated-case")["status"] == "trash"


@pytest.mark.asyncio
async def test_historical_inbox_migration_preserves_legacy_terminal_maturity(tmp_path):
    rpc, store, index = _rpc(tmp_path)
    for mem_id, type_, maturity in [
        ("confirmed-fact", "fact", "confirmed"),
        ("rule-lesson", "lesson", "rule"),
        ("established-concept", "concept", "established"),
    ]:
        _persist(
            store, index, mem_id, status="inbox", type_=type_, maturity=maturity,
            ingestion_time="2020-01-01T00:00:00Z",
        )
    _persist(
        store, index, "ordinary-candidate", status="inbox",
        ingestion_time="2020-01-02T00:00:00Z",
    )

    preview = await rpc.preview_historical_inbox({"now_iso": "2026-08-20T00:00:00Z"})
    assert preview["estimated_move_count"] == 1
    assert preview["by_type"] == {"fact": 1, "lesson": 0, "concept": 0}

    batch = await rpc.migrate_historical_inbox_batch({
        "confirmed": True,
        "now_iso": "2026-08-20T03:00:00Z",
    })
    assert batch["moved"] == 1
    assert batch["remaining"] == 0
    for mem_id in ("confirmed-fact", "rule-lesson", "established-concept"):
        assert index.locate(mem_id)["status"] == "inbox"
    assert index.locate("ordinary-candidate")["status"] == "trash"


def test_inbox_expiry_skips_historical_inbox_and_uses_new_timestamp(tmp_path):
    _, store, index = _rpc(tmp_path)
    _persist(store, index, "historical", status="inbox", ingestion_time="2020-01-01T00:00:00Z")
    _persist(
        store, index, "expired", status="inbox", ingestion_time="2026-08-20T00:00:00Z",
        inbox_entered_at="2026-08-20T00:00:00Z",
    )

    report = run_maintenance(
        store, index, scope="inbox_expiry",
        config=MaintenanceConfig(now_iso="2026-08-21T07:00:00Z"),
    )
    assert report["inbox_expiry"] == {"trashed": 1}
    assert index.locate("historical")["status"] == "inbox"
    assert index.locate("expired")["status"] == "trash"
    assert store.read("trash", "fact", "expired").frontmatter.trashed_at == "2026-08-21T07:00:00Z"


def test_trash_cleanup_uses_trashed_at_and_keeps_legacy_fallback(tmp_path):
    _, store, index = _rpc(tmp_path)
    _persist(
        store, index, "recently-trashed", status="trash", ingestion_time="2020-01-01T00:00:00Z",
        trashed_at="2026-08-20T00:00:00Z",
    )
    _persist(store, index, "legacy-trash", status="trash", ingestion_time="2020-01-01T00:00:00Z")

    report = run_maintenance(
        store, index, scope="trash_cleanup",
        config=MaintenanceConfig(now_iso="2026-08-21T00:00:00Z"),
    )
    assert report["trash_cleanup"] == {"deleted": 1}
    assert index.locate("recently-trashed") is not None
    assert index.locate("legacy-trash") is None


@pytest.mark.asyncio
async def test_recall_filters_status_before_each_candidate_path(tmp_path):
    _, store, index = _rpc(tmp_path)
    _persist(
        store, index, "confirmed", status="confirmed", body="unrelated",
        maturity="confirmed", entities=[EntityRef(type="project", id="p1", name="project")], tags=["topic"],
    )
    _persist(
        store, index, "inbox", status="inbox", body="needle",
        entities=[EntityRef(type="project", id="p1", name="project")], tags=["topic"],
        inbox_entered_at="2026-08-20T00:00:00Z",
    )
    pipe = RecallPipeline(store=store, index=index, reranker=FallbackReranker())

    default = await pipe.recall("needle", 10, filters={"entities": ["p1"], "tags": ["topic"]})
    assert [item["id"] for item in default] == ["confirmed"]

    inbox = await pipe.recall("needle", 10, filters={"status": "inbox", "entities": ["p1"], "tags": ["topic"]})
    assert [item["id"] for item in inbox] == ["inbox"]

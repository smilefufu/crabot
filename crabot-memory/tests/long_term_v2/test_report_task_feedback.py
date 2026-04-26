"""Phase A: report_task_feedback RPC 测试。"""
import pytest
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.rpc import LongTermV2Rpc


def _seed_lesson(idx, mem_id):
    idx.conn.execute(
        "INSERT INTO memories (id, status, type, brief, body, event_time, ingestion_time, path, "
        "observation_pass_count, observation_fail_count) "
        "VALUES (?, 'confirmed', 'lesson', 'b', 'body', '2026-04-25T00:00:00Z', "
        "'2026-04-25T00:00:00Z', '/tmp/x.md', 0, 0)",
        (mem_id,),
    )
    idx.conn.commit()


@pytest.mark.asyncio
async def test_report_task_feedback_pass_increments_pass_count(tmp_path):
    store = MemoryStore(data_root=str(tmp_path))
    idx = SqliteIndex(str(tmp_path / "memories.db"))
    rpc = LongTermV2Rpc(store=store, index=idx, embedder=None)
    _seed_lesson(idx, "mem_l_1")
    idx.record_lesson_task_usage("task_a", "mem_l_1", now_iso="2026-04-25T10:00:00Z")

    result = await rpc.report_task_feedback({
        "task_id": "task_a",
        "attitude": "pass",
    })

    assert result["updated_count"] == 1
    assert result["lesson_ids"] == ["mem_l_1"]
    assert result["weight"] == 1
    row = idx.conn.execute(
        "SELECT observation_pass_count, observation_fail_count FROM memories WHERE id = ?",
        ("mem_l_1",),
    ).fetchone()
    assert row["observation_pass_count"] == 1
    assert row["observation_fail_count"] == 0


@pytest.mark.asyncio
async def test_report_task_feedback_strong_pass_weighted_2(tmp_path):
    store = MemoryStore(data_root=str(tmp_path))
    idx = SqliteIndex(str(tmp_path / "memories.db"))
    rpc = LongTermV2Rpc(store=store, index=idx, embedder=None)
    _seed_lesson(idx, "mem_l_1")
    idx.record_lesson_task_usage("task_a", "mem_l_1", now_iso="2026-04-25T10:00:00Z")

    result = await rpc.report_task_feedback({
        "task_id": "task_a",
        "attitude": "strong_pass",
    })

    assert result["weight"] == 2
    row = idx.conn.execute(
        "SELECT observation_pass_count FROM memories WHERE id = ?", ("mem_l_1",)
    ).fetchone()
    assert row["observation_pass_count"] == 2


@pytest.mark.asyncio
async def test_report_task_feedback_strong_fail_weighted_2(tmp_path):
    store = MemoryStore(data_root=str(tmp_path))
    idx = SqliteIndex(str(tmp_path / "memories.db"))
    rpc = LongTermV2Rpc(store=store, index=idx, embedder=None)
    _seed_lesson(idx, "mem_l_1")
    idx.record_lesson_task_usage("task_a", "mem_l_1", now_iso="2026-04-25T10:00:00Z")

    result = await rpc.report_task_feedback({
        "task_id": "task_a",
        "attitude": "strong_fail",
    })

    assert result["weight"] == 2
    row = idx.conn.execute(
        "SELECT observation_fail_count FROM memories WHERE id = ?", ("mem_l_1",)
    ).fetchone()
    assert row["observation_fail_count"] == 2


@pytest.mark.asyncio
async def test_report_task_feedback_no_lessons_returns_zero(tmp_path):
    store = MemoryStore(data_root=str(tmp_path))
    idx = SqliteIndex(str(tmp_path / "memories.db"))
    rpc = LongTermV2Rpc(store=store, index=idx, embedder=None)
    result = await rpc.report_task_feedback({
        "task_id": "nonexistent_task",
        "attitude": "pass",
    })
    assert result["updated_count"] == 0
    assert result["lesson_ids"] == []


@pytest.mark.asyncio
async def test_report_task_feedback_multiple_lessons(tmp_path):
    store = MemoryStore(data_root=str(tmp_path))
    idx = SqliteIndex(str(tmp_path / "memories.db"))
    rpc = LongTermV2Rpc(store=store, index=idx, embedder=None)
    _seed_lesson(idx, "mem_l_1")
    _seed_lesson(idx, "mem_l_2")
    idx.record_lesson_task_usage("task_a", "mem_l_1", now_iso="2026-04-25T10:00:00Z")
    idx.record_lesson_task_usage("task_a", "mem_l_2", now_iso="2026-04-25T10:01:00Z")

    result = await rpc.report_task_feedback({
        "task_id": "task_a",
        "attitude": "fail",
    })

    assert result["updated_count"] == 2
    assert sorted(result["lesson_ids"]) == ["mem_l_1", "mem_l_2"]
    for mid in ("mem_l_1", "mem_l_2"):
        row = idx.conn.execute(
            "SELECT observation_fail_count FROM memories WHERE id = ?", (mid,)
        ).fetchone()
        assert row["observation_fail_count"] == 1


@pytest.mark.asyncio
async def test_report_task_feedback_rejects_invalid_attitude(tmp_path):
    store = MemoryStore(data_root=str(tmp_path))
    idx = SqliteIndex(str(tmp_path / "memories.db"))
    rpc = LongTermV2Rpc(store=store, index=idx, embedder=None)
    with pytest.raises(ValueError, match="invalid attitude"):
        await rpc.report_task_feedback({
            "task_id": "task_a",
            "attitude": "maybe",
        })

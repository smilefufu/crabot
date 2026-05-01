"""Phase A: lesson_task_usage 表 + observation 投票计数列 schema 测试。"""
import sqlite3
from unittest.mock import AsyncMock

import pytest

from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.store import MemoryStore


def test_lesson_task_usage_table_created(tmp_path):
    db = tmp_path / "test.db"
    SqliteIndex(str(db))
    conn = sqlite3.connect(str(db))
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='lesson_task_usage'"
    )
    assert cur.fetchone() is not None


def test_lesson_task_usage_columns(tmp_path):
    db = tmp_path / "test.db"
    SqliteIndex(str(db))
    conn = sqlite3.connect(str(db))
    cur = conn.execute("PRAGMA table_info(lesson_task_usage)")
    cols = {row[1]: row[2] for row in cur.fetchall()}
    assert cols == {"task_id": "TEXT", "lesson_id": "TEXT", "bumped_at": "TEXT"}


def test_lesson_task_usage_index_exists(tmp_path):
    db = tmp_path / "test.db"
    SqliteIndex(str(db))
    conn = sqlite3.connect(str(db))
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_lesson_task_usage_task'"
    )
    assert cur.fetchone() is not None


def test_observation_voting_columns_added(tmp_path):
    db = tmp_path / "test.db"
    SqliteIndex(str(db))
    conn = sqlite3.connect(str(db))
    cur = conn.execute("PRAGMA table_info(memories)")
    cols = {row[1] for row in cur.fetchall()}
    assert "observation_pass_count" in cols
    assert "observation_fail_count" in cols


def test_observation_voting_columns_default_zero(tmp_path):
    """新插入的 memory 行的 pass_count / fail_count 默认应该是 0（不是 NULL）。"""
    db = tmp_path / "test.db"
    idx = SqliteIndex(str(db))
    idx.conn.execute(
        "INSERT INTO memories (id, status, type, brief, body, event_time, ingestion_time, path) "
        "VALUES ('m1', 'inbox', 'lesson', 'b', 'body', '2026-04-25T00:00:00Z', '2026-04-25T00:00:00Z', '/tmp/x.md')"
    )
    idx.conn.commit()
    row = idx.conn.execute(
        "SELECT observation_pass_count, observation_fail_count FROM memories WHERE id = 'm1'"
    ).fetchone()
    assert row["observation_pass_count"] == 0
    assert row["observation_fail_count"] == 0


def test_record_lesson_task_usage_inserts_row(tmp_path):
    db = tmp_path / "test.db"
    idx = SqliteIndex(str(db))
    idx.record_lesson_task_usage("task_a", "mem_l_1", now_iso="2026-04-25T10:00:00Z")
    rows = list(idx.conn.execute(
        "SELECT task_id, lesson_id, bumped_at FROM lesson_task_usage"
    ).fetchall())
    assert len(rows) == 1
    assert rows[0]["task_id"] == "task_a"
    assert rows[0]["lesson_id"] == "mem_l_1"
    assert rows[0]["bumped_at"] == "2026-04-25T10:00:00Z"


def test_record_lesson_task_usage_dedupes(tmp_path):
    db = tmp_path / "test.db"
    idx = SqliteIndex(str(db))
    idx.record_lesson_task_usage("task_a", "mem_l_1", now_iso="2026-04-25T10:00:00Z")
    idx.record_lesson_task_usage("task_a", "mem_l_1", now_iso="2026-04-25T11:00:00Z")
    rows = list(idx.conn.execute("SELECT * FROM lesson_task_usage").fetchall())
    assert len(rows) == 1, "second insert should be ignored by PRIMARY KEY"


def test_find_lessons_used_in_task_returns_ids(tmp_path):
    db = tmp_path / "test.db"
    idx = SqliteIndex(str(db))
    idx.record_lesson_task_usage("task_a", "mem_l_1", now_iso="2026-04-25T10:00:00Z")
    idx.record_lesson_task_usage("task_a", "mem_l_2", now_iso="2026-04-25T10:01:00Z")
    idx.record_lesson_task_usage("task_b", "mem_l_3", now_iso="2026-04-25T10:02:00Z")
    found = idx.find_lessons_used_in_task("task_a")
    assert sorted(found) == ["mem_l_1", "mem_l_2"]


def test_find_lessons_used_in_task_returns_empty_when_no_usage(tmp_path):
    db = tmp_path / "test.db"
    idx = SqliteIndex(str(db))
    assert idx.find_lessons_used_in_task("nonexistent") == []


def _seed_memory(idx, mem_id):
    """辅助：插入一条最小可用的 memories 行供 bump_observation_counter 更新。"""
    idx.conn.execute(
        "INSERT INTO memories (id, status, type, brief, body, event_time, ingestion_time, path) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (mem_id, "confirmed", "lesson", "brief", "body",
         "2026-04-25T00:00:00Z", "2026-04-25T00:00:00Z", "/tmp/x.md"),
    )
    idx.conn.commit()


def test_bump_observation_counter_pass(tmp_path):
    db = tmp_path / "test.db"
    idx = SqliteIndex(str(db))
    _seed_memory(idx, "mem_l_1")
    idx.bump_observation_counter("mem_l_1", column="observation_pass_count", delta=2)
    row = idx.conn.execute(
        "SELECT observation_pass_count, observation_fail_count FROM memories WHERE id = ?",
        ("mem_l_1",),
    ).fetchone()
    assert row["observation_pass_count"] == 2
    assert row["observation_fail_count"] == 0


def test_bump_observation_counter_fail_accumulates(tmp_path):
    db = tmp_path / "test.db"
    idx = SqliteIndex(str(db))
    _seed_memory(idx, "mem_l_1")
    idx.bump_observation_counter("mem_l_1", column="observation_fail_count", delta=1)
    idx.bump_observation_counter("mem_l_1", column="observation_fail_count", delta=2)
    row = idx.conn.execute(
        "SELECT observation_pass_count, observation_fail_count FROM memories WHERE id = ?",
        ("mem_l_1",),
    ).fetchone()
    assert row["observation_pass_count"] == 0
    assert row["observation_fail_count"] == 3


def test_bump_observation_counter_rejects_invalid_column(tmp_path):
    db = tmp_path / "test.db"
    idx = SqliteIndex(str(db))
    _seed_memory(idx, "mem_l_1")
    with pytest.raises(ValueError, match="invalid column"):
        idx.bump_observation_counter("mem_l_1", column="DROP TABLE memories", delta=1)


@pytest.mark.asyncio
async def test_search_long_term_records_task_usage(tmp_path, monkeypatch):
    """search_long_term 收到 task_id 时，给每条 lesson 命中写 lesson_task_usage 行。"""
    store = MemoryStore(data_root=str(tmp_path))
    idx = SqliteIndex(str(tmp_path / "memories.db"))
    rpc = LongTermV2Rpc(store=store, index=idx)

    # 用 AsyncMock 替换 pipeline.recall，绕开 embedding/索引初始化
    rpc.pipeline.recall = AsyncMock(return_value=[
        {"id": "mem_l_42", "type": "lesson", "status": "confirmed", "brief": "test"},
        {"id": "mem_l_99", "type": "lesson", "status": "confirmed", "brief": "test2"},
        {"id": "mem_f_1",  "type": "fact",   "status": "confirmed", "brief": "fact"},  # 非 lesson 不写
    ])

    # 同时给 sqlite 插入对应 row 让 bump_use_count 不会因找不到行而失败
    for mid in ("mem_l_42", "mem_l_99", "mem_f_1"):
        idx.conn.execute(
            "INSERT INTO memories (id, status, type, brief, body, event_time, ingestion_time, path) "
            "VALUES (?, 'confirmed', ?, 'b', '', '2026-04-25T00:00:00Z', '2026-04-25T00:00:00Z', '/tmp/x.md')",
            (mid, "lesson" if mid != "mem_f_1" else "fact"),
        )
    idx.conn.commit()

    await rpc.search_long_term({"query": "dev.sh", "k": 5, "task_id": "task_xyz"})

    # 查 lesson_task_usage 表 — 应该有 2 行（fact 不计）
    found = idx.find_lessons_used_in_task("task_xyz")
    assert sorted(found) == ["mem_l_42", "mem_l_99"]


@pytest.mark.asyncio
async def test_search_long_term_skips_task_usage_when_no_task_id(tmp_path):
    """没有 task_id 参数时，不写 lesson_task_usage 表。"""
    store = MemoryStore(data_root=str(tmp_path))
    idx = SqliteIndex(str(tmp_path / "memories.db"))
    rpc = LongTermV2Rpc(store=store, index=idx)
    rpc.pipeline.recall = AsyncMock(return_value=[
        {"id": "mem_l_1", "type": "lesson", "status": "confirmed", "brief": "x"},
    ])
    idx.conn.execute(
        "INSERT INTO memories (id, status, type, brief, body, event_time, ingestion_time, path) "
        "VALUES ('mem_l_1', 'confirmed', 'lesson', 'b', '', '2026-04-25T00:00:00Z', '2026-04-25T00:00:00Z', '/tmp/x.md')"
    )
    idx.conn.commit()

    await rpc.search_long_term({"query": "test", "k": 5})

    rows = list(idx.conn.execute("SELECT * FROM lesson_task_usage").fetchall())
    assert rows == [], "no task_id → no lesson_task_usage row"

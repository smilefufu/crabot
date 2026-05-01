"""T18: search_long_term 命中 lesson 时自动 bump use_count（TDD 验证）。

仅对 type='lesson' 起作用；fact/concept 命中后 use_count 不变。
bump 失败不影响 search 主流程（try/except 保护）。
"""
import pytest
from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, LessonMeta,
)
from src.long_term_v2.paths import entry_path


def _make_rpc(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    return LongTermV2Rpc(store=store, index=index), store, index


_TYPE_DEFAULT_MATURITY = {
    "fact": "confirmed",
    "lesson": "case",
    "concept": "established",
}

_TYPE_DEFAULT_STATUS = {
    "fact": "confirmed",
    "lesson": "inbox",
    "concept": "confirmed",
}


def _write_confirmed(store, index, mem_type: str, brief: str, mem_id: str = None):
    """Write a memory entry so BM25 can retrieve it (iter_brief_for_bm25 reads all statuses)."""
    from src.long_term_v2.schema import new_memory_id
    mid = mem_id or new_memory_id()
    maturity = _TYPE_DEFAULT_MATURITY[mem_type]
    status = _TYPE_DEFAULT_STATUS[mem_type]
    lesson_meta = LessonMeta() if mem_type == "lesson" else None
    fm = MemoryFrontmatter(
        id=mid,
        type=mem_type,
        maturity=maturity,
        brief=brief,
        author="user",
        source_ref=SourceRef(type="manual"),
        source_trust=5,
        content_confidence=5,
        importance_factors=ImportanceFactors(
            proximity=0.7, surprisal=0.5,
            entity_priority=0.5, unambiguity=0.7,
        ),
        entities=[],
        tags=[],
        event_time="2026-04-01T00:00:00Z",
        ingestion_time="2026-04-01T00:00:00Z",
        lesson_meta=lesson_meta,
    )
    entry = MemoryEntry(frontmatter=fm, body=f"Content for {brief}")
    store.write(entry, status=status)
    path = entry_path(store.data_root, status, mem_type, mid)
    index.upsert(entry, path=path, status=status)
    return mid


def _get_use_count(index: SqliteIndex, mem_id: str) -> int:
    cur = index.conn.cursor()
    cur.execute("SELECT use_count FROM memories WHERE id = ?", (mem_id,))
    row = cur.fetchone()
    assert row is not None, f"Memory {mem_id} not found in index"
    return row[0]


@pytest.mark.asyncio
async def test_lesson_hit_bumps_use_count(tmp_path):
    """search_long_term 命中 lesson 时，use_count 应 +1。"""
    rpc, store, index = _make_rpc(tmp_path)

    lesson_id = _write_confirmed(
        store, index,
        mem_type="lesson",
        brief="macOS 终端中文输入用 pbcopy 最稳",
    )

    initial_count = _get_use_count(index, lesson_id)
    assert initial_count == 0, "新写入的 lesson 初始 use_count 应为 0"

    result = await rpc.search_long_term({
        "query": "macOS 终端中文输入",
        "k": 10,
    })
    assert "results" in result

    # BM25 应能召回这条 lesson
    hit_ids = [r["id"] for r in result["results"]]
    assert lesson_id in hit_ids, f"lesson 未被召回，results={result['results']}"

    after_count = _get_use_count(index, lesson_id)
    assert after_count == initial_count + 1, (
        f"use_count 应从 {initial_count} 增到 {initial_count + 1}，实际为 {after_count}"
    )


@pytest.mark.asyncio
async def test_fact_hit_does_not_bump_use_count(tmp_path):
    """search_long_term 命中 fact 时，use_count 不应改变（fact 语义不同）。"""
    rpc, store, index = _make_rpc(tmp_path)

    fact_id = _write_confirmed(
        store, index,
        mem_type="fact",
        brief="Python 的 GIL 在 3.12 版本开始可选关闭",
    )

    initial_count = _get_use_count(index, fact_id)
    assert initial_count == 0

    result = await rpc.search_long_term({
        "query": "Python GIL",
        "k": 10,
    })

    hit_ids = [r["id"] for r in result["results"]]
    assert fact_id in hit_ids, f"fact 未被召回，results={result['results']}"

    after_count = _get_use_count(index, fact_id)
    assert after_count == initial_count, (
        f"fact 的 use_count 不应改变，期望 {initial_count}，实际 {after_count}"
    )


@pytest.mark.asyncio
async def test_concept_hit_does_not_bump_use_count(tmp_path):
    """search_long_term 命中 concept 时，use_count 不应改变。"""
    rpc, store, index = _make_rpc(tmp_path)

    concept_id = _write_confirmed(
        store, index,
        mem_type="concept",
        brief="幂等性：同一操作执行多次结果不变",
    )

    initial_count = _get_use_count(index, concept_id)
    assert initial_count == 0

    result = await rpc.search_long_term({
        "query": "幂等性操作",
        "k": 10,
    })

    hit_ids = [r["id"] for r in result["results"]]
    assert concept_id in hit_ids, f"concept 未被召回，results={result['results']}"

    after_count = _get_use_count(index, concept_id)
    assert after_count == initial_count, (
        f"concept 的 use_count 不应改变，期望 {initial_count}，实际 {after_count}"
    )


@pytest.mark.asyncio
async def test_multiple_lesson_hits_each_bumped(tmp_path):
    """多条 lesson 命中时，每条各自 +1。"""
    rpc, store, index = _make_rpc(tmp_path)

    lesson_id1 = _write_confirmed(
        store, index,
        mem_type="lesson",
        brief="Git rebase 前先备份分支避免丢失",
    )
    lesson_id2 = _write_confirmed(
        store, index,
        mem_type="lesson",
        brief="Git merge 后记得删除临时分支",
    )

    result = await rpc.search_long_term({
        "query": "Git 分支管理最佳实践",
        "k": 10,
    })

    hit_ids = [r["id"] for r in result["results"]]

    # 命中的 lesson 每条都应被 bump
    for lid in [lesson_id1, lesson_id2]:
        if lid in hit_ids:
            count = _get_use_count(index, lid)
            assert count == 1, f"命中的 lesson {lid} 应 use_count=1，实际 {count}"

    # 至少一条被召回（BM25 必能找到 Git 关键词）
    assert lesson_id1 in hit_ids or lesson_id2 in hit_ids, (
        "至少一条 lesson 应被 BM25 召回"
    )


@pytest.mark.asyncio
async def test_bump_failure_does_not_break_search(tmp_path):
    """即使 bump 内部出错，search 主流程不受影响，仍返回结果。"""
    rpc, store, index = _make_rpc(tmp_path)

    lesson_id = _write_confirmed(
        store, index,
        mem_type="lesson",
        brief="异常容忍：bump 失败不应阻塞主流程",
    )

    # 关闭 SQLite 连接来模拟 bump 失败
    original_bump = index.bump_use_count

    def failing_bump(mem_id, now_iso):
        raise RuntimeError("Simulated DB failure")

    index.bump_use_count = failing_bump

    # search 不应抛出异常
    result = await rpc.search_long_term({
        "query": "异常容忍 bump",
        "k": 10,
    })
    assert "results" in result, "bump 失败时 search 应仍返回 results"

    # 恢复原方法
    index.bump_use_count = original_bump

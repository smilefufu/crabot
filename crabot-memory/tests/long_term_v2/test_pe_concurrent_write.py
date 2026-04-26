"""并发 PE 写入去重 / 一致性（TX.1）。

Memory 层本身不做语义去重（PE-Gated 由 Agent 端负责，spec §6.3）。
这里验证 *并发同 brief 写入* 下 SQLite 索引与磁盘 store 不会损坏：
  - 不会出现重复 id
  - 两条都能独立 read 回来
  - 索引行数与文件数严格一致
"""
import asyncio
import pytest

from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from tests.long_term_v2.test_pe_gated_write_e2e import FakeEmbedder


def _build_rpc(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    rpc = LongTermV2Rpc(store=store, index=index, embedder=FakeEmbedder())
    return rpc, store, index


def _payload(brief: str, content: str, et: str):
    return {
        "type": "fact",
        "brief": brief,
        "content": content,
        "source_ref": {"type": "manual"},
        "source_trust": 3, "content_confidence": 3,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": et,
        "status": "confirmed",
    }


@pytest.mark.asyncio
async def test_concurrent_same_brief_writes_produce_distinct_ids_no_corruption(tmp_path):
    """gather 两个相同 brief 的写入：结果是两条不同 id 的 confirmed entry，索引一致。"""
    rpc, store, index = _build_rpc(tmp_path)

    results = await asyncio.gather(
        rpc.write_long_term(_payload("张三的微信", "张三微信 v1", "2026-04-23T10:00:00Z")),
        rpc.write_long_term(_payload("张三的微信", "张三微信 v2", "2026-04-23T10:00:01Z")),
    )

    ids = [r["id"] for r in results]
    assert len(ids) == 2
    assert ids[0] != ids[1], f"concurrent writes must produce distinct ids, got {ids}"

    # 两条都能独立 read 回来
    e1 = store.read("confirmed", "fact", ids[0])
    e2 = store.read("confirmed", "fact", ids[1])
    assert e1.frontmatter.brief == "张三的微信"
    assert e2.frontmatter.brief == "张三的微信"
    assert e1.body != e2.body  # 内容不同

    # 索引计数 == 2
    rows = index.conn.execute(
        "SELECT count(*) FROM memories WHERE status='confirmed' AND type='fact'"
    ).fetchone()
    assert rows[0] == 2, f"index should track exactly 2 entries, got {rows[0]}"

    # locate 都能查到
    assert index.locate(ids[0]) is not None
    assert index.locate(ids[1]) is not None


@pytest.mark.asyncio
async def test_concurrent_burst_10_writes_index_remains_consistent(tmp_path):
    """10 条 gather 写入 → 索引行数 == 10，且全部 ids 互不相同。"""
    rpc, store, index = _build_rpc(tmp_path)

    payloads = [
        _payload(f"brief-{i}", f"content-{i}", f"2026-04-23T10:{i:02d}:00Z")
        for i in range(10)
    ]
    results = await asyncio.gather(*[rpc.write_long_term(p) for p in payloads])
    ids = [r["id"] for r in results]

    assert len(set(ids)) == 10, f"burst writes must produce 10 distinct ids, got {len(set(ids))} unique"

    rows = index.conn.execute(
        "SELECT count(*) FROM memories WHERE status='confirmed' AND type='fact'"
    ).fetchone()
    assert rows[0] == 10

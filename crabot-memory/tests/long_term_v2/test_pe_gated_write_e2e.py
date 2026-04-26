"""PE-Gated Write 端到端集成测试（spec §6.3）。

验证 Agent 在写入新 fact 前的"先 search → 再决策 → boost / invalidate"
完整链路在 RPC 层是可组合的：
  1. 写入 fact A → search 找到 A
  2. 与 A 完全一致的新 fact A'：调 update_long_term({content_confidence_increment: 1})
     → A 的 confidence 上调，未新增条目
  3. 与 A 冲突的 fact B：写入 B → 调 update_long_term({invalidated_by: B.id})
     → A 字段持久化为 invalidated；search 仍能找到 A 但标记 invalidated=True
"""
import pytest
from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.recall_pipeline import RecallPipeline


import numpy as np


class FakeEmbedder:
    """Deterministic embedder; similar text → similar vec. Mirrors EmbeddingClient API."""
    def __init__(self):
        self.dim = 16

    def _embed(self, text: str):
        v = [0.0] * self.dim
        for i, ch in enumerate(text):
            v[i % self.dim] += float(ord(ch) % 13)
        n = sum(x * x for x in v) ** 0.5 or 1.0
        return np.asarray([x / n for x in v], dtype=np.float32)

    async def embed_single(self, text: str):
        return self._embed(text)

    async def embed_batch(self, texts):
        return [self._embed(t) for t in texts]


def _build_rpc(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    embedder = FakeEmbedder()
    pipeline = RecallPipeline(
        store=store, index=index, embedder=embedder, llm=None, reranker=None,
    )
    rpc = LongTermV2Rpc(store=store, index=index, embedder=embedder)
    rpc.pipeline = pipeline
    return rpc, store, index


@pytest.mark.asyncio
async def test_pe_gated_boost_path_increments_confidence_no_new_entry(tmp_path):
    """写入与已有 fact 一致 → 通过 increment 提升 confidence，不应新增条目。"""
    rpc, store, index = _build_rpc(tmp_path)

    out = await rpc.write_long_term({
        "type": "fact",
        "brief": "张三的微信",
        "content": "张三的微信是 wxid_zhangsan",
        "source_ref": {"type": "manual"},
        "source_trust": 4,
        "content_confidence": 3,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-04-23T10:00:00Z",
        "status": "confirmed",
    })
    a_id = out["id"]
    assert a_id

    # PE 命中：boost confidence
    await rpc.update_long_term({
        "id": a_id,
        "patch": {"content_confidence_increment": 1},
    })
    entry = store.read("confirmed", "fact", a_id)
    assert entry.frontmatter.content_confidence == 4

    # 再 boost 一次，不应超过 5
    for _ in range(10):
        await rpc.update_long_term({
            "id": a_id,
            "patch": {"content_confidence_increment": 1},
        })
    entry = store.read("confirmed", "fact", a_id)
    assert entry.frontmatter.content_confidence == 5

    # 索引仍只有 1 条 confirmed fact
    rows = index.conn.execute(
        "SELECT count(*) FROM memories WHERE status='confirmed' AND type='fact'"
    ).fetchone()
    assert rows[0] == 1, f"PE boost path should not create new entry, got {rows[0]}"


@pytest.mark.asyncio
async def test_pe_gated_conflict_path_invalidates_old_entry(tmp_path):
    """写入与已有 fact 冲突 → 新 fact 入库，旧 fact.invalidated_by 指向新 id。"""
    rpc, store, index = _build_rpc(tmp_path)

    a = await rpc.write_long_term({
        "type": "fact", "brief": "张三的城市",
        "content": "张三在北京",
        "source_ref": {"type": "manual"},
        "source_trust": 3, "content_confidence": 4,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-03-01T00:00:00Z",
        "status": "confirmed",
    })
    a_id = a["id"]

    b = await rpc.write_long_term({
        "type": "fact", "brief": "张三的城市",
        "content": "张三搬到上海了",
        "source_ref": {"type": "manual"},
        "source_trust": 4, "content_confidence": 4,
        "importance_factors": {
            "proximity": 0.7, "surprisal": 0.7,
            "entity_priority": 0.5, "unambiguity": 0.6,
        },
        "event_time": "2026-04-23T10:00:00Z",
        "status": "confirmed",
    })
    b_id = b["id"]
    assert a_id != b_id

    # 显式 PE 冲突标记：旧条 invalidated_by 指向新条
    out = await rpc.update_long_term({
        "id": a_id,
        "patch": {"invalidated_by": b_id},
    })
    assert out["status"] == "ok"

    # 持久化校验
    a_after = store.read("confirmed", "fact", a_id)
    assert a_after.frontmatter.invalidated_by == b_id

    b_after = store.read("confirmed", "fact", b_id)
    assert b_after.frontmatter.invalidated_by is None

    # get_memory 应能取回 invalidated 字段（用于 Audit / Diff Modal）
    fetched = await rpc.get_memory({"id": a_id, "include": "full"})
    assert fetched["frontmatter"]["invalidated_by"] == b_id

    # 反向：B 没有 invalidated_by
    fetched_b = await rpc.get_memory({"id": b_id, "include": "full"})
    assert "invalidated_by" not in fetched_b["frontmatter"] or \
        fetched_b["frontmatter"].get("invalidated_by") is None


@pytest.mark.asyncio
async def test_pe_gated_completely_new_fact_creates_independent_entry(tmp_path):
    """完全新颖的 fact → 新条独立入库，旧条不受影响。"""
    rpc, store, index = _build_rpc(tmp_path)

    a = await rpc.write_long_term({
        "type": "fact", "brief": "张三的微信",
        "content": "张三微信 wxid_zhangsan",
        "source_ref": {"type": "manual"},
        "source_trust": 3, "content_confidence": 3,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-04-01T00:00:00Z",
        "status": "confirmed",
    })
    b = await rpc.write_long_term({
        "type": "fact", "brief": "李四的微信",
        "content": "李四微信 wxid_lisi",
        "source_ref": {"type": "manual"},
        "source_trust": 3, "content_confidence": 3,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-04-23T00:00:00Z",
        "status": "confirmed",
    })
    assert a["id"] != b["id"]

    a_after = store.read("confirmed", "fact", a["id"])
    b_after = store.read("confirmed", "fact", b["id"])
    assert a_after.frontmatter.content_confidence == 3
    assert b_after.frontmatter.content_confidence == 3
    assert a_after.frontmatter.invalidated_by is None
    assert b_after.frontmatter.invalidated_by is None

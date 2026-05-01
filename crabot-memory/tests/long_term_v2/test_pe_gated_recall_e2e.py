"""PE-Gated Write × Recall 端到端闭环（spec §6.3 + §7.3 fact）。

第一轮 test_pe_gated_write_e2e.py 只验证 invalidated_by 字段写入 + get_memory 取回；
本测试串通到 RecallPipeline → apply_type_boost，验证旧条**真的不会出现在 search_long_term 候选中**。
这是 PE-Gated 的实际业务闭环。
"""
import pytest

from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.recall_pipeline import RecallPipeline


def _build_rpc(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    pipeline = RecallPipeline(
        store=store, index=index, llm=None, reranker=None,
    )
    rpc = LongTermV2Rpc(store=store, index=index)
    rpc.pipeline = pipeline
    return rpc, store, index


def _fact_payload(brief: str, content: str, event_time: str) -> dict:
    return {
        "type": "fact", "brief": brief, "content": content,
        "source_ref": {"type": "manual"},
        "source_trust": 4, "content_confidence": 4,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": event_time,
        "status": "confirmed",
    }


@pytest.mark.asyncio
async def test_invalidated_fact_not_returned_by_search(tmp_path):
    """旧 fact A 被 invalidated_by 指向新 B 后，search_long_term 候选只剩 B。"""
    rpc, store, index = _build_rpc(tmp_path)

    a = await rpc.write_long_term(
        _fact_payload("张三的城市", "张三在北京", "2026-03-01T00:00:00Z")
    )
    b = await rpc.write_long_term(
        _fact_payload("张三的城市", "张三搬到上海了", "2026-04-23T00:00:00Z")
    )

    # PE 标记冲突：A 被 B invalidate
    await rpc.update_long_term({
        "id": a["id"], "patch": {"invalidated_by": b["id"]},
    })

    # 走完整 search_long_term 链路
    out = await rpc.search_long_term({"query": "张三的城市", "k": 10})
    ids = [r["id"] for r in out["results"]]
    assert b["id"] in ids, "新条 B 应当被召回"
    assert a["id"] not in ids, "旧条 A 已被 invalidated，不应出现在搜索结果"


@pytest.mark.asyncio
async def test_invalidated_chain_only_latest_survives(tmp_path):
    """A → B → C 链：A.invalidated_by=B, B.invalidated_by=C；search 只剩 C。"""
    rpc, store, index = _build_rpc(tmp_path)

    a = await rpc.write_long_term(
        _fact_payload("项目 X 截止日", "2026-04 截止", "2026-01-01T00:00:00Z")
    )
    b = await rpc.write_long_term(
        _fact_payload("项目 X 截止日", "2026-05 截止", "2026-02-01T00:00:00Z")
    )
    c = await rpc.write_long_term(
        _fact_payload("项目 X 截止日", "2026-06 截止", "2026-04-23T00:00:00Z")
    )

    await rpc.update_long_term({"id": a["id"], "patch": {"invalidated_by": b["id"]}})
    await rpc.update_long_term({"id": b["id"], "patch": {"invalidated_by": c["id"]}})

    out = await rpc.search_long_term({"query": "项目 X 截止日", "k": 10})
    ids = [r["id"] for r in out["results"]]
    assert ids == [c["id"]] or (c["id"] in ids and a["id"] not in ids and b["id"] not in ids)


@pytest.mark.asyncio
async def test_non_invalidated_fact_still_returned(tmp_path):
    """对照组：未被 invalidate 的 fact 正常出现在搜索结果中。"""
    rpc, store, index = _build_rpc(tmp_path)
    a = await rpc.write_long_term(
        _fact_payload("李四电话", "13800000000", "2026-04-23T00:00:00Z")
    )
    out = await rpc.search_long_term({"query": "李四电话", "k": 5})
    ids = [r["id"] for r in out["results"]]
    assert a["id"] in ids

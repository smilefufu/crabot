# tests/long_term_v2/test_phase3_integration.py
"""端到端：写入 → quick_capture → run_maintenance → snapshot 全链路。"""
import pytest
from src.module import MemoryModule
from src.config import MemoryConfig


def _module(tmp_path) -> MemoryModule:
    cfg = MemoryConfig()
    cfg.storage.data_dir = str(tmp_path)
    mod = MemoryModule(cfg)
    # Disable embedder so tests don't need a live embedding API.
    mod._lt_v2_rpc.embedder = None
    mod._lt_v2_rpc.pipeline.embedder = None
    return mod


@pytest.mark.asyncio
async def test_full_self_learning_flow_skeleton(tmp_path):
    mod = _module(tmp_path)

    # 1. quick_capture 一批 fact + lesson 到 inbox
    captured_ids = []
    for i in range(3):
        out = await mod._dispatch("quick_capture", {
            "type": "fact", "brief": f"事实 {i}", "content": f"内容 {i}",
            "source_ref": {"type": "conversation", "task_id": f"t{i}"},
            "entities": [], "tags": [],
            "importance_factors": {"proximity": 0.7, "surprisal": 0.5,
                                   "entity_priority": 0.5, "unambiguity": 0.7},
        })
        # _dispatch returns the inner result dict directly (no data wrapper)
        captured_ids.append(out["id"])

    # 2. 用 update_memory (v2 路由到 update_long_term) 把第一条人工晋升 confirmed maturity
    #    注意: update_long_term 只更新 frontmatter 字段，不移动 status 目录;
    #    "update_long_term" 在 dispatch 中注册为 "update_memory"。
    await mod._dispatch("update_memory", {
        "id": captured_ids[0],
        "patch": {"maturity": "confirmed"},
    })

    # 3. 写入一条直接进入 confirmed 状态的 fact（bypassing inbox），
    #    使 get_confirmed_snapshot 能找到它。
    #    iter_all_confirmed_briefs 过滤 status='confirmed'（目录/行状态），
    #    而不是 frontmatter 中的 maturity 字段。
    confirmed_out = await mod._lt_v2_rpc.write_long_term({
        "type": "fact",
        "brief": "直接确认的事实",
        "content": "这是一条已确认的事实内容",
        "source_ref": {"type": "manual"},
        "entities": [], "tags": [],
        "importance_factors": {"proximity": 0.8, "surprisal": 0.6,
                               "entity_priority": 0.5, "unambiguity": 0.9},
        "source_trust": 4,
        "content_confidence": 4,
        "event_time": "2026-04-24T00:00:00Z",
        "status": "confirmed",
    })
    confirmed_id = confirmed_out["id"]

    # 4. snapshot 应包含至少 1 条 confirmed status 的 fact
    snap = await mod._dispatch("get_confirmed_snapshot", {})
    assert "snapshot_id" in snap
    fact_briefs = snap["by_type"]["fact"]
    assert any(b["id"] == confirmed_id for b in fact_briefs)

    # 5. 跑 run_maintenance（不应出错）
    rep = await mod._dispatch("run_maintenance", {"scope": "all"})
    assert "report" in rep

    # 6. 设置 evolution mode 后取出
    await mod._dispatch("set_evolution_mode", {"mode": "harden", "reason": "test"})
    info = await mod._dispatch("get_evolution_mode", {})
    assert info["mode"] == "harden"

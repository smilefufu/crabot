"""RPC handler tests (v3: no embedder)."""
from datetime import datetime, timedelta, timezone

import pytest
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.rpc import LongTermV2Rpc


@pytest.fixture
def rpc(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    return LongTermV2Rpc(store=store, index=idx)


@pytest.mark.asyncio
async def test_write_long_term_basic(rpc):
    res = await rpc.write_long_term({
        "type": "fact",
        "brief": "张三的微信号",
        "content": "wxid_test123",
        "author": "user",
        "source_ref": {"type": "manual"},
        "source_trust": 5,
        "content_confidence": 5,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-04-23T10:00:00Z",
    })
    assert res["status"] == "ok"
    assert res["id"].startswith("mem-l-")


@pytest.mark.asyncio
async def test_write_long_term_assigns_id_when_absent(rpc):
    res = await rpc.write_long_term({
        "type": "fact",
        "brief": "noid",
        "content": "x",
        "author": "user",
        "source_ref": {"type": "manual"},
        "source_trust": 5,
        "content_confidence": 5,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-04-23T10:00:00Z",
    })
    assert res["id"]


@pytest.mark.asyncio
async def test_write_long_term_uses_provided_id(rpc):
    res = await rpc.write_long_term({
        "id": "mem-l-explicit",
        "type": "fact",
        "brief": "withid",
        "content": "x",
        "author": "user",
        "source_ref": {"type": "manual"},
        "source_trust": 5,
        "content_confidence": 5,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-04-23T10:00:00Z",
    })
    assert res["id"] == "mem-l-explicit"


@pytest.mark.asyncio
async def test_write_long_term_indexes_entities_and_tags(rpc):
    res = await rpc.write_long_term({
        "type": "fact",
        "brief": "with-entity",
        "content": "x",
        "author": "user",
        "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-04-23T10:00:00Z",
        "entities": [{"type": "friend", "id": "z3", "name": "张三"}],
        "tags": ["#scope:macos"],
    })
    assert "z3" in [r[0] for r in [(rpc.index.find_by_entity("z3"),)]] or rpc.index.find_by_entity("z3") == [res["id"]]
    assert rpc.index.find_by_tag("#scope:macos") == [res["id"]]


@pytest.mark.asyncio
async def test_search_long_term_returns_relevant_results(rpc):
    await rpc.write_long_term({
        "type": "fact",
        "brief": "张三的微信",
        "content": "wxid 是 abc123",
        "author": "user",
        "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-04-23T10:00:00Z",
        "status": "confirmed",
    })
    res = await rpc.search_long_term({"query": "张三 微信", "k": 5})
    assert len(res["results"]) >= 1
    assert any("张三" in r["brief"] for r in res["results"])


@pytest.mark.asyncio
async def test_search_long_term_default_brief_only(rpc):
    await rpc.write_long_term({
        "type": "fact",
        "brief": "test brief",
        "content": "long body content here",
        "author": "user",
        "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-04-23T10:00:00Z",
        "status": "confirmed",
    })
    res = await rpc.search_long_term({"query": "test", "k": 1})
    assert res["results"][0].get("body") is None
    res2 = await rpc.search_long_term({"query": "test", "k": 1, "include": "full"})
    assert res2["results"][0]["body"] == "long body content here"


@pytest.mark.asyncio
async def test_search_long_term_filters_by_type(rpc):
    await rpc.write_long_term({
        "type": "lesson",
        "brief": "飞书发表情",
        "content": "用 emoji_id",
        "author": "user",
        "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-04-23T10:00:00Z",
    })
    await rpc.write_long_term({
        "type": "fact",
        "brief": "张三微信",
        "content": "wxid",
        "author": "user",
        "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-04-23T10:00:00Z",
    })
    res = await rpc.search_long_term({"query": "飞书", "k": 5, "filters": {"type": "lesson"}})
    assert all(r["type"] == "lesson" for r in res["results"])


@pytest.mark.asyncio
async def test_get_memory_returns_brief_by_default(rpc):
    w = await rpc.write_long_term({
        "type": "fact", "brief": "B", "content": "BODY",
        "author": "u", "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {"proximity":0.5,"surprisal":0.5,"entity_priority":0.5,"unambiguity":0.5},
        "event_time": "2026-04-23T10:00:00Z",
    })
    g = await rpc.get_memory({"id": w["id"]})
    assert g["brief"] == "B"
    assert "body" not in g

    g2 = await rpc.get_memory({"id": w["id"], "include": "full"})
    assert g2["body"] == "BODY"


@pytest.mark.asyncio
async def test_delete_memory_moves_to_trash(rpc):
    w = await rpc.write_long_term({
        "type": "fact", "brief": "x", "content": "y",
        "author": "u", "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {"proximity":0.5,"surprisal":0.5,"entity_priority":0.5,"unambiguity":0.5},
        "event_time": "2026-04-23T10:00:00Z",
    })
    res = await rpc.delete_memory({"id": w["id"]})
    assert res["status"] == "ok"
    g = await rpc.get_memory({"id": w["id"]})
    assert g["status"] == "trash"


@pytest.mark.asyncio
async def test_update_long_term_bumps_version(rpc):
    w = await rpc.write_long_term({
        "type": "fact", "brief": "old", "content": "x",
        "author": "u", "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {"proximity":0.5,"surprisal":0.5,"entity_priority":0.5,"unambiguity":0.5},
        "event_time": "2026-04-23T10:00:00Z",
    })
    upd = await rpc.update_long_term({
        "id": w["id"],
        "patch": {"brief": "new"},
    })
    assert upd["version"] == 2
    g = await rpc.get_memory({"id": w["id"], "include": "full"})
    assert g["brief"] == "new"
    assert g["frontmatter"]["version"] == 2


@pytest.mark.asyncio
async def test_grep_memory_rpc(rpc):
    await rpc.write_long_term({
        "type": "fact", "brief": "张三微信", "content": "wxid_zhangsan",
        "author": "u", "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {"proximity":0.5,"surprisal":0.5,"entity_priority":0.5,"unambiguity":0.5},
        "event_time": "2026-04-23T10:00:00Z",
    })
    res = await rpc.grep_memory({"pattern": "wxid"})
    assert any("微信" in r["brief"] for r in res["results"])


@pytest.mark.asyncio
async def test_list_recent_rpc(rpc):
    await rpc.write_long_term({
        "type": "fact", "brief": "今天发生", "content": "x",
        "author": "u", "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {"proximity":0.5,"surprisal":0.5,"entity_priority":0.5,"unambiguity":0.5},
        # list_recent 按 now - window_days 过滤 event_time，硬编码日期会随时间流逝
        # 掉出窗口（本测试曾因此在写入约一个月后开始失败）
        "event_time": (datetime.now(timezone.utc) - timedelta(days=1))
            .isoformat().replace("+00:00", "Z"),
    })
    res = await rpc.list_recent({"window_days": 30})
    assert len(res["results"]) >= 1


@pytest.mark.asyncio
async def test_find_by_entity_rpc(rpc):
    await rpc.write_long_term({
        "type": "fact", "brief": "with-entity", "content": "x",
        "author": "u", "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {"proximity":0.5,"surprisal":0.5,"entity_priority":0.5,"unambiguity":0.5},
        "event_time": "2026-04-23T10:00:00Z",
        "entities": [{"type": "friend", "id": "z3", "name": "张三"}],
    })
    res = await rpc.find_by_entity({"entity_id": "z3"})
    assert len(res["results"]) >= 1


@pytest.mark.asyncio
async def test_find_by_tag_rpc(rpc):
    await rpc.write_long_term({
        "type": "fact", "brief": "tagged", "content": "x",
        "author": "u", "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {"proximity":0.5,"surprisal":0.5,"entity_priority":0.5,"unambiguity":0.5},
        "event_time": "2026-04-23T10:00:00Z",
        "tags": ["#scope:macos"],
    })
    res = await rpc.find_by_tag({"tag": "#scope:macos"})
    assert len(res["results"]) >= 1


@pytest.mark.asyncio
async def test_get_cases_about_rpc(rpc):
    await rpc.write_long_term({
        "type": "lesson", "brief": "飞书发表情", "content": "use emoji_id",
        "maturity": "case",
        "author": "u", "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {"proximity":0.5,"surprisal":0.5,"entity_priority":0.5,"unambiguity":0.5},
        "event_time": "2026-04-23T10:00:00Z",
    })
    res = await rpc.get_cases_about({"scenario": "飞书"})
    assert len(res["results"]) >= 1


@pytest.mark.asyncio
async def test_write_long_term_rejects_brief_over_80_chars(rpc):
    """spec §5.3 frontmatter brief ≤ 80 字；正常 RPC 路径不应静默截断，应直接 ValidationError。"""
    from pydantic import ValidationError
    long_brief = "测" * 81  # 81 字符
    with pytest.raises(ValidationError):
        await rpc.write_long_term({
            "type": "fact",
            "brief": long_brief,
            "content": "any",
            "author": "user",
            "source_ref": {"type": "manual"},
            "source_trust": 5, "content_confidence": 5,
            "importance_factors": {
                "proximity": 0.5, "surprisal": 0.5,
                "entity_priority": 0.5, "unambiguity": 0.5,
            },
            "event_time": "2026-04-23T10:00:00Z",
        })


@pytest.mark.asyncio
async def test_write_long_term_accepts_brief_at_boundary_80(rpc):
    """边界：恰好 80 字符应当通过。"""
    brief_80 = "测" * 80
    res = await rpc.write_long_term({
        "type": "fact",
        "brief": brief_80,
        "content": "x",
        "author": "user",
        "source_ref": {"type": "manual"},
        "source_trust": 5, "content_confidence": 5,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-04-23T10:00:00Z",
    })
    assert res["status"] == "ok"


# ============================================================================
# quick_capture 项目实体信号默认抬：fact + (entities 非空 or tags ≥ 2)
# → entity_priority=0.7, content_confidence=4
# 让 memory-curate 的"项目实体单独通道"能命中，避免高价值项目 fact 永远卡 inbox
# ============================================================================

async def _read_fact(rpc, mem_id):
    """快捷读：quick_capture 后 entry 应在 inbox/fact/。"""
    return rpc.store.read("inbox", "fact", mem_id)


@pytest.mark.asyncio
async def test_quick_capture_fact_with_entities_boosts(rpc):
    """fact + entities 非空 → entity_priority 抬到 0.7、confidence 抬到 4。"""
    res = await rpc.quick_capture({
        "type": "fact",
        "brief": "quant-signal Futu OpenD 运行在 home-m2u",
        "content": "...",
        "author": "agent",
        "entities": [{"id": "quant-signal", "type": "project", "name": "quant-signal"}],
    })
    assert res["status"] == "ok"
    fm = (await _read_fact(rpc, res["id"])).frontmatter
    assert fm.importance_factors.entity_priority == 0.7
    assert fm.content_confidence == 4


@pytest.mark.asyncio
async def test_quick_capture_fact_with_two_tags_boosts(rpc):
    """fact + tags 数量 ≥ 2 → 同样抬。tags 是 LLM 给项目/实体 fact 最常用的信号载体。"""
    res = await rpc.quick_capture({
        "type": "fact",
        "brief": "非 crypto 数据走 Futu OpenD",
        "content": "...",
        "author": "agent",
        "tags": ["quant-signal", "futu-opend"],
    })
    assert res["status"] == "ok"
    fm = (await _read_fact(rpc, res["id"])).frontmatter
    assert fm.importance_factors.entity_priority == 0.7
    assert fm.content_confidence == 4


@pytest.mark.asyncio
async def test_quick_capture_fact_with_single_tag_does_not_boost(rpc):
    """fact + 仅 1 个 tag → 不抬。单 tag 不算具名实体信号。"""
    res = await rpc.quick_capture({
        "type": "fact",
        "brief": "x",
        "content": "...",
        "author": "agent",
        "tags": ["random"],
    })
    fm = (await _read_fact(rpc, res["id"])).frontmatter
    assert fm.importance_factors.entity_priority == 0.5
    assert fm.content_confidence == 3


@pytest.mark.asyncio
async def test_quick_capture_lesson_with_two_tags_does_not_boost(rpc):
    """lesson + tags ≥ 2 → 仍不抬。lesson 不享受单条晋升通道（case→rule 才是出路）。"""
    res = await rpc.quick_capture({
        "type": "lesson",
        "brief": "x",
        "content": "...",
        "author": "agent",
        "tags": ["a", "b"],
        "lesson_meta": {"scenario": "s", "outcome": "success"},
    })
    fm = rpc.store.read("inbox", "lesson", res["id"]).frontmatter
    assert fm.importance_factors.entity_priority == 0.5
    assert fm.content_confidence == 3


@pytest.mark.asyncio
async def test_quick_capture_respects_explicit_entity_priority(rpc):
    """LLM 显式传 entity_priority=0.3 时，不被默认抬覆盖。"""
    res = await rpc.quick_capture({
        "type": "fact",
        "brief": "x",
        "content": "...",
        "author": "agent",
        "tags": ["a", "b"],
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.3,
            "unambiguity": 0.5,
        },
    })
    fm = (await _read_fact(rpc, res["id"])).frontmatter
    assert fm.importance_factors.entity_priority == 0.3, "LLM 显式值不应被默认覆盖"


@pytest.mark.asyncio
async def test_quick_capture_respects_explicit_content_confidence(rpc):
    """LLM 显式传 content_confidence=2 时，不被默认 4 覆盖。"""
    res = await rpc.quick_capture({
        "type": "fact",
        "brief": "x",
        "content": "...",
        "author": "agent",
        "tags": ["a", "b"],
        "content_confidence": 2,
    })
    fm = (await _read_fact(rpc, res["id"])).frontmatter
    assert fm.content_confidence == 2


@pytest.mark.asyncio
async def test_quick_capture_partial_importance_factors_merged(rpc):
    """LLM 只传部分 importance_factors 字段时，与默认值合并，不丢字段。"""
    res = await rpc.quick_capture({
        "type": "fact",
        "brief": "x",
        "content": "...",
        "author": "agent",
        "tags": ["a", "b"],
        "importance_factors": {"surprisal": 0.9},  # 只传 surprisal
    })
    fm = (await _read_fact(rpc, res["id"])).frontmatter
    assert fm.importance_factors.surprisal == 0.9, "LLM 传的 surprisal 保留"
    assert fm.importance_factors.entity_priority == 0.7, "LLM 未传的字段走 boost 默认"


@pytest.mark.asyncio
async def test_quick_capture_boosts_when_explicit_default_value(rpc):
    """LLM 显式传完整 importance_factors 但 entity_priority 仍是 0.5 时，仍触发抬。

    这是 store_memory MCP 工具的常态：importanceToFactors(importance) 总会生成
    {proximity:0.5, surprisal:<importance/10>, entity_priority:0.5, unambiguity:0.5}，
    即便 LLM 没主动表达，也总有 entity_priority=0.5 这个"形式上的显式值"。
    如果不抬，store_memory 路径下的 fact 永远 entity_priority=0.5，永远过不了项目实体通道。
    """
    res = await rpc.quick_capture({
        "type": "fact",
        "brief": "x",
        "content": "...",
        "author": "agent",
        "tags": ["quant-signal", "futu"],
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5,  # ← store_memory 自动填的默认值
            "unambiguity": 0.5,
        },
    })
    fm = (await _read_fact(rpc, res["id"])).frontmatter
    assert fm.importance_factors.entity_priority == 0.7, \
        "形式上的默认 0.5 应被识别为'未表达'并抬到 0.7"


@pytest.mark.asyncio
async def test_quick_capture_preserves_low_entity_priority(rpc):
    """LLM 显式传 entity_priority < 0.5（如 0.3）时是主动表达"很弱"，不抬。"""
    res = await rpc.quick_capture({
        "type": "fact",
        "brief": "x",
        "content": "...",
        "author": "agent",
        "tags": ["a", "b"],
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.3,
            "unambiguity": 0.5,
        },
    })
    fm = (await _read_fact(rpc, res["id"])).frontmatter
    assert fm.importance_factors.entity_priority == 0.3


@pytest.mark.asyncio
async def test_quick_capture_preserves_high_entity_priority(rpc):
    """LLM 显式传 entity_priority > 0.5（如 0.8）时是主动表达"很强"，也不动。"""
    res = await rpc.quick_capture({
        "type": "fact",
        "brief": "x",
        "content": "...",
        "author": "agent",
        "tags": ["a", "b"],
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.8,
            "unambiguity": 0.5,
        },
    })
    fm = (await _read_fact(rpc, res["id"])).frontmatter
    assert fm.importance_factors.entity_priority == 0.8

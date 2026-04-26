"""RPC handler tests with fake embedder."""
import pytest
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.rpc import LongTermV2Rpc


class FakeEmbedder:
    async def embed_single(self, text):
        # deterministic fake: hash → 8-d vector
        import hashlib
        h = hashlib.sha256(text.encode()).digest()
        return [b / 255.0 for b in h[:8]]


@pytest.fixture
def rpc(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    return LongTermV2Rpc(store=store, index=idx, embedder=FakeEmbedder())


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
        "event_time": "2026-04-23T10:00:00Z",
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

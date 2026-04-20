"""
Memory 模块基础测试
"""
import pytest
import asyncio
import shutil
import tempfile
from datetime import datetime
from unittest.mock import AsyncMock

from src.types import (
    WriteShortTermParams,
    MemorySource,
    SearchShortTermParams,
    WriteLongTermParams,
)
from src.config import MemoryConfig, load_config
from src.module import MemoryModule


@pytest.fixture
async def memory_module():
    """创建测试用的 Memory 模块（每个测试独立 tmp 目录）"""
    config = load_config("config.yaml")
    config.port = 19999
    tmp_dir = tempfile.mkdtemp(prefix="crabot-memory-test-")
    config.storage.data_dir = tmp_dir

    module = MemoryModule(config)
    module.embedding_client.dimension = 8
    module.embedding_client._dimension_probed = True

    async def _embed_single(text: str):
        return [0.0] * 8

    async def _extract_keywords(text: str):
        return ["kw1", "kw2"] if text else []

    async def _generate_l0_l1(content: str):
        return {
            "abstract": content[:256],
            "overview": content[:4000],
        }

    async def _judge_dedup(new_content: str, existing_content: str):
        action = "SKIP" if new_content == existing_content else "CREATE"
        return {"action": action, "reason": "same content" if action == "SKIP" else ""}

    async def _merge_contents(content_a: str, content_b: str):
        return content_a

    async def _compress_short_term(batch_data):
        return [f"压缩: {batch_data[0]['content']}"] if batch_data else []

    async def _noop_run_compression():
        return None

    async def _delete_short_term_by_ids(ids):
        if not ids:
            return

        def _delete():
            table = module.vector_store.db.open_table("short_term_memory")
            where = "id IN (" + ", ".join(f"'{entry_id}'" for entry_id in ids) + ")"
            table.delete(where)
            module.vector_store.short_term_table = table

        await asyncio.get_running_loop().run_in_executor(None, _delete)

    async def _rotate_short_term(before_time):
        def _delete():
            table = module.vector_store.db.open_table("short_term_memory")
            where = f"event_time < '{before_time}'"
            table.delete(where)
            module.vector_store.short_term_table = table

        await asyncio.get_running_loop().run_in_executor(None, _delete)

    module.vector_store.embedding_client.embed_single = _embed_single
    module.llm_client.extract_keywords = _extract_keywords
    module.llm_client.generate_l0_l1 = _generate_l0_l1
    module.llm_client.judge_dedup = _judge_dedup
    module.llm_client.merge_contents = _merge_contents
    module.llm_client.compress_short_term = _compress_short_term
    module._run_compression = _noop_run_compression
    module.vector_store.delete_short_term_by_ids = _delete_short_term_by_ids
    module.vector_store.rotate_short_term = _rotate_short_term

    yield module

    module.vector_store.close()
    module.sqlite_store.close()
    module.scene_profile_store.close()
    shutil.rmtree(tmp_dir, ignore_errors=True)


@pytest.mark.asyncio
async def test_write_short_term(memory_module):
    """测试写入短期记忆"""
    params = WriteShortTermParams(
        content="测试事件：用户张三请求部署 v1.0.0",
        source=MemorySource(
            type="conversation",
            session_id="test-session",
        ),
        persons=["张三"],
        entities=["v1.0.0"],
        topic="部署",
    )

    result = await memory_module._write_short_term(params.model_dump())

    assert result["memory"]["id"].startswith("mem-s-")
    assert result["memory"]["content"] == params.content
    assert "张三" in result["memory"]["persons"]


@pytest.mark.asyncio
async def test_search_short_term(memory_module):
    """测试检索短期记忆"""
    # 先写入一条记忆
    write_params = WriteShortTermParams(
        content="测试事件：用户李四请求查看日志",
        source=MemorySource(type="conversation"),
        persons=["李四"],
        topic="日志",
    )
    await memory_module._write_short_term(write_params.model_dump())

    # 检索
    search_params = SearchShortTermParams(
        query="日志",
        limit=10,
    )
    result = await memory_module._search_short_term(search_params.model_dump())

    assert len(result["results"]) > 0


@pytest.mark.asyncio
async def test_write_long_term(memory_module):
    """测试写入长期记忆"""
    params = WriteLongTermParams(
        content="用户张三偏好使用 TypeScript 进行开发，认为类型安全很重要。",
        source=MemorySource(type="reflection"),
        importance=7,
        tags=["preference", "technology"],
    )

    result = await memory_module._write_long_term(params.model_dump())

    assert result["action"] == "created"
    assert result["memory"]["id"].startswith("mem-l-")
    assert result["memory"]["importance"] == 7


@pytest.mark.asyncio
async def test_health(memory_module):
    """测试健康检查"""
    result = await memory_module._health({})

    assert result["status"] == "healthy"
    assert "short_term_count" in result["details"]
    assert "long_term_count" in result["details"]


@pytest.mark.asyncio
async def test_reflection_watermark(memory_module):
    """测试反思水位"""
    # 获取初始水位
    result = await memory_module._get_reflection_watermark({})
    assert result["last_reflected_at"] is None

    # 更新水位
    timestamp = datetime.utcnow().isoformat() + "Z"
    update_result = await memory_module._update_reflection_watermark({
        "last_reflected_at": timestamp
    })
    assert update_result["last_reflected_at"] == timestamp

    # 再次获取
    result = await memory_module._get_reflection_watermark({})
    assert result["last_reflected_at"] == timestamp


@pytest.mark.asyncio
async def test_get_stats(memory_module):
    """测试获取统计信息"""
    result = await memory_module._get_stats({})

    assert "short_term" in result
    assert "long_term" in result
    assert "entry_count" in result["short_term"]
    assert "entry_count" in result["long_term"]


@pytest.mark.asyncio
async def test_scopes_filtering(memory_module):
    """测试 scopes 权限过滤"""
    await memory_module._write_short_term(WriteShortTermParams(
        content="scope-a 的私有信息",
        source=MemorySource(type="conversation"),
        visibility="internal",
        scopes=["scope-a"],
    ).model_dump())

    await memory_module._write_short_term(WriteShortTermParams(
        content="scope-b 的私有信息",
        source=MemorySource(type="conversation"),
        visibility="internal",
        scopes=["scope-b"],
    ).model_dump())

    result = await memory_module._search_short_term(SearchShortTermParams(
        query="私有信息",
        min_visibility="internal",
        accessible_scopes=["scope-a"],
        limit=10,
    ).model_dump())

    contents = [r["content"] for r in result["results"]]
    assert any("scope-a" in c for c in contents)
    assert not any("scope-b" in c for c in contents)


@pytest.mark.asyncio
async def test_update_memory(memory_module):
    """测试更新长期记忆"""
    write_result = await memory_module._write_long_term(WriteLongTermParams(
        content="张三偏好 Python",
        source=MemorySource(type="reflection"),
        importance=5,
        tags=["preference"],
    ).model_dump())
    memory_id = write_result["memory"]["id"]

    from src.types import UpdateMemoryParams
    update_result = await memory_module._update_memory(UpdateMemoryParams(
        memory_id=memory_id,
        content="张三偏好 TypeScript，不再使用 Python",
        importance=8,
        revision_reason="用户纠正了语言偏好",
    ).model_dump())

    assert update_result["memory"]["content"] == "张三偏好 TypeScript，不再使用 Python"
    assert update_result["memory"]["importance"] == 8
    assert update_result["version"] == 2

    get_result = await memory_module._get_memory({
        "memory_id": memory_id,
        "include_revisions": True,
    })
    assert len(get_result["revisions"]) == 1
    assert get_result["revisions"][0]["reason"] == "用户纠正了语言偏好"


@pytest.mark.asyncio
async def test_dedup_skip_duplicate(memory_module):
    """测试去重：完全重复的内容应该 SKIP"""
    params = WriteLongTermParams(
        content="张三是前端开发工程师，擅长 React 和 TypeScript",
        source=MemorySource(type="reflection"),
        tags=["role"],
    )
    r1 = await memory_module._write_long_term(params.model_dump())
    assert r1["action"] == "created"

    r2 = await memory_module._write_long_term(params.model_dump())
    assert r2["action"] in ("skipped", "updated", "merged")


@pytest.mark.asyncio
async def test_time_range_filter(memory_module):
    """测试时间范围过滤"""
    await memory_module._write_short_term(WriteShortTermParams(
        content="早期事件",
        source=MemorySource(type="conversation"),
        event_time="2026-01-01T00:00:00Z",
    ).model_dump())
    await memory_module._write_short_term(WriteShortTermParams(
        content="近期事件",
        source=MemorySource(type="conversation"),
        event_time="2026-04-01T00:00:00Z",
    ).model_dump())

    result = await memory_module._search_short_term(SearchShortTermParams(
        limit=10,
        time_range={"start": "2026-03-01T00:00:00Z"},
    ).model_dump())

    contents = [r["content"] for r in result["results"]]
    assert any("近期" in c for c in contents)
    assert not any("早期" in c for c in contents)


@pytest.mark.asyncio
async def test_batch_write_short_term(memory_module):
    """测试批量写入短期记忆"""
    result = await memory_module._batch_write_short_term({
        "entries": [
            {"content": "批量事件1", "source": {"type": "conversation"}},
            {"content": "批量事件2", "source": {"type": "conversation"}},
            {"content": "批量事件3", "source": {"type": "conversation"}},
        ]
    })
    assert result["success_count"] == 3
    assert result["failure_count"] == 0
    assert len(result["memories"]) == 3


@pytest.mark.asyncio
async def test_batch_write_long_term(memory_module):
    """测试批量写入长期记忆"""
    result = await memory_module._batch_write_long_term({
        "entries": [
            {"content": "张三喜欢 Python", "source": {"type": "reflection"}, "tags": ["pref"]},
            {"content": "李四擅长 Go 语言", "source": {"type": "reflection"}, "tags": ["skill"]},
        ]
    })
    assert result["success_count"] == 2
    assert result["failure_count"] == 0


@pytest.mark.asyncio
async def test_short_term_compression(memory_module):
    """测试短期记忆压缩"""
    memory_module.config.compression.compression_threshold = 3
    memory_module.config.compression.retention_window_days = 0
    memory_module.config.compression.window_size = 5

    for i in range(5):
        await memory_module._write_short_term(WriteShortTermParams(
            content=f"事件 {i}: 用户请求操作 {i}",
            source=MemorySource(type="conversation"),
            event_time=f"2026-01-0{i+1}T00:00:00Z",
        ).model_dump())

    count_before_compress = memory_module.vector_store.get_short_term_count()

    result = await memory_module.short_term.compress(memory_module.config.compression)
    assert result["compressed_count"] > 0

    count_after = memory_module.vector_store.get_short_term_count()
    # 压缩将多条合并为更少条目，总数应减少
    assert count_after < count_before_compress


@pytest.mark.asyncio
async def test_export_import_roundtrip(memory_module):
    """测试导出后导入还原"""
    await memory_module._write_short_term(WriteShortTermParams(
        content="导出测试短期记忆",
        source=MemorySource(type="conversation"),
    ).model_dump())
    await memory_module._write_long_term(WriteLongTermParams(
        content="导出测试长期记忆",
        source=MemorySource(type="reflection"),
        tags=["export-test"],
    ).model_dump())

    export_result = await memory_module._export_memories({})
    assert export_result["version"] == "1.0"
    assert len(export_result["short_term"]) >= 1
    assert len(export_result["long_term"]) >= 1

    import_result = await memory_module._import_memories({
        "mode": "replace",
        "data": export_result,
    })
    assert import_result["short_term_count"] >= 1
    assert import_result["long_term_count"] >= 1


@pytest.mark.asyncio
async def test_upsert_and_get_scene_profile(memory_module):
    params = {
        "scene": {"type": "group_session", "channel_id": "c1", "session_id": "s1"},
        "label": "开发组群",
        "content": "群职责: x",
        "created_at": "2026-04-17T00:00:00Z",
        "updated_at": "2026-04-17T00:00:00Z",
    }
    await memory_module._upsert_scene_profile(params)
    got = await memory_module._get_scene_profile(
        {"scene": {"type": "group_session", "channel_id": "c1", "session_id": "s1"}})
    assert got["profile"]["label"] == "开发组群"
    assert got["profile"]["content"] == "群职责: x"
    assert "abstract" in got["profile"]
    assert "overview" in got["profile"]


@pytest.mark.asyncio
async def test_get_scene_profile_none(memory_module):
    got = await memory_module._get_scene_profile(
        {"scene": {"type": "group_session", "channel_id": "x", "session_id": "y"}})
    assert got["profile"] is None


@pytest.mark.asyncio
async def test_upsert_scene_profile_generates_l0_l1_when_missing(memory_module, monkeypatch):
    monkeypatch.setattr(
        memory_module.llm_client,
        "generate_l0_l1",
        AsyncMock(return_value={"abstract": "自动摘要", "overview": "自动概览"}),
    )
    result = await memory_module._upsert_scene_profile({
        "scene": {"type": "global"},
        "label": "global",
        "content": "只有正文",
    })
    assert result["profile"]["abstract"] == "自动摘要"
    assert result["profile"]["overview"] == "自动概览"
    assert result["profile"]["content"] == "只有正文"
    memory_module.llm_client.generate_l0_l1.assert_awaited_once_with("只有正文")


@pytest.mark.asyncio
async def test_upsert_scene_profile_requires_llm_config_for_generated_summaries(memory_module):
    memory_module.config.llm.api_key = ""
    memory_module.config.llm.base_url = ""
    memory_module.config.llm.model = ""

    with pytest.raises(ValueError, match="Memory module not configured"):
        await memory_module._upsert_scene_profile({
            "scene": {"type": "global"},
            "label": "global",
            "content": "只有正文",
        })


@pytest.mark.asyncio
async def test_dispatch_rejects_patch_scene_profile(memory_module):
    with pytest.raises(ValueError, match="Method not found"):
        await memory_module._dispatch("patch_scene_profile", {})


@pytest.mark.asyncio
async def test_list_scene_profiles(memory_module):
    await memory_module._upsert_scene_profile({
        "scene": {"type": "friend", "friend_id": "f1"}, "label": "张三",
        "abstract": "张三摘要", "overview": "张三概览", "content": "张三内容",
        "created_at": "2026-04-17T00:00:00Z", "updated_at": "2026-04-17T00:00:00Z",
    })
    got = await memory_module._list_scene_profiles({"scene_type": "friend"})
    assert len(got["profiles"]) == 1
    assert got["profiles"][0]["content"] == "张三内容"


@pytest.mark.asyncio
async def test_upsert_scene_profile_preserves_created_at_on_update(memory_module):
    scene = {"type": "friend", "friend_id": "f4"}
    first = await memory_module._upsert_scene_profile({
        "scene": scene,
        "label": "x",
        "abstract": "x 摘要",
        "overview": "x 概览",
        "content": "内容一",
        "created_at": "2026-04-17T00:00:00Z",
        "updated_at": "2026-04-17T00:00:00Z",
    })
    second = await memory_module._upsert_scene_profile({
        "scene": scene,
        "label": "x2",
        "abstract": "x2 摘要",
        "overview": "x2 概览",
        "content": "内容二",
        "updated_at": "2026-04-18T00:00:00Z",
    })
    assert first["profile"]["created_at"] == "2026-04-17T00:00:00Z"
    assert second["profile"]["created_at"] == "2026-04-17T00:00:00Z"


@pytest.mark.asyncio
async def test_upsert_scene_profile_rejects_blank_content(memory_module):
    with pytest.raises(ValueError, match="content"):
        await memory_module._upsert_scene_profile({
            "scene": {"type": "friend", "friend_id": "f-blank"},
            "label": "blank",
            "abstract": "摘要",
            "overview": "概览",
            "content": "   ",
            "updated_at": "2026-04-18T00:00:00Z",
        })


@pytest.mark.asyncio
async def test_delete_scene_profile(memory_module):
    scene = {"type": "friend", "friend_id": "f2"}
    await memory_module._upsert_scene_profile({
        "scene": scene, "label": "x", "abstract": "x 摘要", "overview": "x 概览", "content": "x",
        "created_at": "2026-04-17T00:00:00Z", "updated_at": "2026-04-17T00:00:00Z",
    })
    out = await memory_module._delete_scene_profile({"scene": scene})
    assert out["deleted"] is True


@pytest.mark.asyncio
async def test_get_scene_profile_only_public_raises(memory_module):
    scene = {"type": "friend", "friend_id": "f3"}
    await memory_module._upsert_scene_profile({
        "scene": scene, "label": "x",
        "abstract": "x 摘要", "overview": "x 概览",
        "content": "职务: p\n私密: s",
        "created_at": "2026-04-17T00:00:00Z", "updated_at": "2026-04-17T00:00:00Z",
    })
    with pytest.raises(ValueError, match="only_public"):
        await memory_module._get_scene_profile({"scene": scene, "only_public": True})


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

"""
Memory 模块基础测试
"""
import pytest
import asyncio
from datetime import datetime

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
    """创建测试用的 Memory 模块"""
    # 加载配置文件（包含 ollama 配置）
    config = load_config("config.yaml")
    config.port = 19999  # 测试端口
    # 使用临时目录进行测试
    config.storage.data_dir = "/tmp/crabot-memory-test"

    module = MemoryModule(config)
    # 不启动 HTTP 服务器，直接测试内部方法
    yield module

    # 清理
    module.vector_store.close()
    module.sqlite_store.close()


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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

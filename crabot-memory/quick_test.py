#!/usr/bin/env python3
"""
Memory 模块快速测试脚本
测试基本的写入和检索功能
"""
import asyncio
import sys
from pathlib import Path

# 添加模块路径
sys.path.insert(0, str(Path(__file__).parent))

from src.module import MemoryModule
from src.config import MemoryConfig
from src.types import WriteShortTermParams, MemorySource, SearchShortTermParams
import tempfile
from datetime import datetime


async def quick_test():
    """快速功能测试"""
    print("=== Memory Module Quick Test ===\n")

    # 创建模块
    config = MemoryConfig(port=19999)
    config.storage.data_dir = tempfile.mkdtemp()
    config.llm.api_key = 'test-key'
    config.embedding.api_key = 'test-key'

    module = MemoryModule(config)
    print("✓ Module created\n")

    # 测试 1: 健康检查
    print("1. Health check...")
    health = await module._health({})
    print(f"   Status: {health['status']}")
    print(f"   ✓ Passed\n")

    # 测试 2: 写入短期记忆
    print("2. Writing short-term memory...")
    write_params = WriteShortTermParams(
        content="测试事件：用户张三请求部署 v1.0.0 到生产环境",
        source=MemorySource(
            type="conversation",
            session_id="test-session-001"
        ),
        persons=["张三"],
        entities=["v1.0.0", "生产环境"],
        topic="部署",
        visibility="internal"
    )

    result = await module._write_short_term(write_params.model_dump())
    memory_id = result['memory']['id']
    print(f"   Memory ID: {memory_id}")
    print(f"   Content: {result['memory']['content']}")
    print(f"   Keywords: {result['memory']['keywords']}")
    print(f"   ✓ Passed\n")

    # 测试 3: 检索短期记忆
    print("3. Searching short-term memory...")
    search_params = SearchShortTermParams(
        query="部署",
        limit=10,
        min_visibility="internal"
    )

    search_result = await module._search_short_term(search_params.model_dump())
    print(f"   Found {len(search_result['results'])} results")
    if search_result['results']:
        first = search_result['results'][0]
        print(f"   First result: {first['content'][:50]}...")
    print(f"   ✓ Passed\n")

    # 测试 4: 统计信息
    print("4. Getting statistics...")
    stats = await module._get_stats({})
    print(f"   Short-term entries: {stats['short_term']['entry_count']}")
    print(f"   Long-term entries: {stats['long_term']['entry_count']}")
    print(f"   ✓ Passed\n")

    # 测试 5: 反思水位
    print("5. Testing reflection watermark...")
    timestamp = datetime.utcnow().isoformat() + "Z"
    await module._update_reflection_watermark({"last_reflected_at": timestamp})
    watermark = await module._get_reflection_watermark({})
    print(f"   Watermark: {watermark['last_reflected_at']}")
    print(f"   ✓ Passed\n")

    # 清理
    module.vector_store.close()
    module.sqlite_store.close()

    print("=== All tests passed! ===")


if __name__ == "__main__":
    asyncio.run(quick_test())

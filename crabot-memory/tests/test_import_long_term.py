"""
Memory 模块 import_long_term RPC 测试
"""
import pytest
import shutil
import tempfile
from src.long_term_v2.markdown_io import dump_entry
from src.config import load_config
from src.module import MemoryModule


@pytest.fixture
async def memory_module():
    """创建测试用的 Memory 模块（每个测试独立 tmp 目录）"""
    config = load_config("config.yaml")
    config.port = 19999
    tmp_dir = tempfile.mkdtemp(prefix="crabot-memory-test-")
    config.storage.data_dir = tmp_dir

    module = MemoryModule(config)

    async def _extract_keywords(text: str):
        return ["kw1", "kw2"] if text else []

    async def _judge_dedup(new_content: str, existing_content: str):
        action = "SKIP" if new_content == existing_content else "CREATE"
        return {"action": action, "reason": "same content" if action == "SKIP" else ""}

    async def _merge_contents(content_a: str, content_b: str):
        return content_a

    async def _compress_short_term(batch_data):
        return [f"压缩: {batch_data[0]['content']}"] if batch_data else []

    async def _noop_run_compression():
        return None

    module.llm_client.extract_keywords = _extract_keywords
    module.llm_client.judge_dedup = _judge_dedup
    module.llm_client.merge_contents = _merge_contents
    module.llm_client.compress_short_term = _compress_short_term
    module._run_compression = _noop_run_compression

    yield module

    module.short_term_store.close()
    module.sqlite_store.close()
    module.scene_profile_store.close()
    shutil.rmtree(tmp_dir, ignore_errors=True)


async def _seed_and_get_markdown(memory_module):
    """用 write_long_term 种一条记忆，返回 (id, markdown)。"""
    res = await memory_module._dispatch("write_long_term", {"access_context": {"actor_kind": "admin", "memory_enabled": True}, "visibility": "internal", "scopes": [],
        "type": "fact",
        "brief": "测试事实",
        "content": "用于导入测试的长期记忆内容。",
        "author": "user",
        "source_ref": {"type": "reflection"},
        "source_trust": 5,
        "content_confidence": 5,
        "importance_factors": {"proximity": 0.5, "surprisal": 0.5, "entity_priority": 0.5, "unambiguity": 0.5},
        "event_time": "2026-04-23T10:00:00Z",
        "tags": ["#test"],
    })
    mem_id = res["id"]
    # write_long_term 默认 status='inbox'
    entry = memory_module._lt_v2_store.read("inbox", "fact", mem_id)
    return mem_id, dump_entry(entry)


@pytest.mark.asyncio
async def test_import_long_term_imported(memory_module):
    seed_id, md = await _seed_and_get_markdown(memory_module)
    md_new = md.replace(seed_id, "mem-l-imported-x")  # 换成新 id
    res = await memory_module._dispatch("import_long_term", {"access_context": {"actor_kind": "admin", "memory_enabled": True},
        "entries": [{"status": "confirmed", "markdown": md_new}], "mode": "merge",
    })
    assert res["imported"] == 1
    # 新 id 可读
    ids = {row[2] for row in memory_module._lt_v2_store.list_all()}
    assert "mem-l-imported-x" in ids


@pytest.mark.asyncio
async def test_import_long_term_merge_skips_existing(memory_module):
    seed_id, md = await _seed_and_get_markdown(memory_module)
    # seed_id 已存在（inbox），merge 模式应 skip
    res = await memory_module._dispatch("import_long_term", {"access_context": {"actor_kind": "admin", "memory_enabled": True},
        "entries": [{"status": "confirmed", "markdown": md}], "mode": "merge",
    })
    assert res["skipped"] == 1
    assert res["imported"] == 0


@pytest.mark.asyncio
async def test_import_long_term_replace_overwrites(memory_module):
    seed_id, md = await _seed_and_get_markdown(memory_module)
    res = await memory_module._dispatch("import_long_term", {"access_context": {"actor_kind": "admin", "memory_enabled": True},
        "entries": [{"status": "confirmed", "markdown": md}], "mode": "replace",
    })
    assert res["overwritten"] == 1

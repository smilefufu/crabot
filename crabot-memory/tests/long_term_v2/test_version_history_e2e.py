"""版本历史端到端（spec §9.2 / §10.1）。

覆盖：
  - update_long_term 把旧 entry 归档到 versions 旁路 + push 到 prev_version_ids
  - 多次 update 后 prev_version_ids 顺序：最新的旧版本在前
  - get_entry_version 取回任一旧版本的 body / frontmatter
  - 版本号不存在时返回 error
  - delete_to_trash / restore_from_trash 不丢历史（versions 跟随 status 迁移）
  - purge 清理主文件 + versions 目录
"""
import pytest

from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors,
)
from src.long_term_v2.paths import entry_path


def _seed_fact(store, index, mid="m1", body="原始 body", brief="原始 brief"):
    fm = MemoryFrontmatter(
        id=mid, type="fact", maturity="confirmed",
        brief=brief, author="system",
        source_ref=SourceRef(type="manual"),
        source_trust=3, content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-01T00:00:00Z",
        ingestion_time="2026-04-01T00:00:00Z",
        version=1,
        prev_version_ids=[],
    )
    e = MemoryEntry(frontmatter=fm, body=body)
    store.write(e, status="confirmed")
    index.upsert(e, path=entry_path(store.data_root, "confirmed", "fact", mid), status="confirmed")
    return mid


@pytest.mark.asyncio
async def test_update_archives_old_version_and_fills_prev_version_ids(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    mem_id = _seed_fact(store, index, body="v1 body", brief="v1 brief")

    rpc = LongTermV2Rpc(store=store, index=index, embedder=None)
    await rpc.update_long_term({"id": mem_id, "patch": {"brief": "v2 brief", "body": "v2 body"}})
    await rpc.update_long_term({"id": mem_id, "patch": {"brief": "v3 brief", "body": "v3 body"}})

    out = await rpc.get_memory({"id": mem_id, "include": "full"})
    fm = out["frontmatter"]
    assert fm["version"] == 3
    # 最新的旧版本在前：v2 → v1
    assert fm["prev_version_ids"] == [f"{mem_id}#v2", f"{mem_id}#v1"]
    # 主文件是当前最新版
    assert out["body"] == "v3 body"
    assert fm["brief"] == "v3 brief"


@pytest.mark.asyncio
async def test_get_entry_version_returns_archived_body_and_frontmatter(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    mem_id = _seed_fact(store, index, body="v1 body", brief="v1 brief")
    rpc = LongTermV2Rpc(store=store, index=index, embedder=None)
    await rpc.update_long_term({"id": mem_id, "patch": {"brief": "v2 brief", "body": "v2 body"}})
    await rpc.update_long_term({"id": mem_id, "patch": {"brief": "v3 brief", "body": "v3 body"}})

    v1 = await rpc.get_entry_version({"id": mem_id, "version": 1})
    assert v1["body"] == "v1 body"
    assert v1["frontmatter"]["brief"] == "v1 brief"
    assert v1["frontmatter"]["version"] == 1

    v2 = await rpc.get_entry_version({"id": mem_id, "version": 2})
    assert v2["body"] == "v2 body"
    assert v2["frontmatter"]["brief"] == "v2 brief"
    assert v2["frontmatter"]["version"] == 2


@pytest.mark.asyncio
async def test_get_entry_version_missing_version_returns_error(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    mem_id = _seed_fact(store, index)
    rpc = LongTermV2Rpc(store=store, index=index, embedder=None)
    out = await rpc.get_entry_version({"id": mem_id, "version": 99})
    assert out.get("error") == "version not found"


@pytest.mark.asyncio
async def test_get_entry_version_unknown_id_returns_error(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    rpc = LongTermV2Rpc(store=store, index=index, embedder=None)
    out = await rpc.get_entry_version({"id": "no-such-id", "version": 1})
    assert out.get("error") == "not found"


@pytest.mark.asyncio
async def test_versions_survive_trash_and_restore(tmp_path):
    """delete_to_trash / restore_from_trash 应同时迁移 versions 旁路目录。"""
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    mem_id = _seed_fact(store, index, body="v1 body")
    rpc = LongTermV2Rpc(store=store, index=index, embedder=None)
    await rpc.update_long_term({"id": mem_id, "patch": {"body": "v2 body"}})

    # 进 trash
    await rpc.delete_memory({"id": mem_id})
    # versions 文件夹应跟着搬到 trash 路径下
    out_in_trash = await rpc.get_entry_version({"id": mem_id, "version": 1})
    assert out_in_trash["body"] == "v1 body"

    # 再 restore
    await rpc.restore_memory({"id": mem_id})
    out_after_restore = await rpc.get_entry_version({"id": mem_id, "version": 1})
    assert out_after_restore["body"] == "v1 body"


def test_purge_removes_versions_dir(tmp_path):
    """purge 应同时清理主文件 + versions 旁路。"""
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    mem_id = _seed_fact(store, index)
    # 手工归档一份 v1
    entry = store.read("confirmed", "fact", mem_id)
    store.archive_version("confirmed", entry)
    assert store.list_versions("confirmed", "fact", mem_id) == [1]

    store.purge("confirmed", "fact", mem_id)
    assert store.list_versions("confirmed", "fact", mem_id) == []

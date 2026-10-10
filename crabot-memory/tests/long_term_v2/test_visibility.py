import json
from unittest.mock import AsyncMock

import pytest

from src.core.short_term import ShortTermMemory
from src.config import CompressionConfig
from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.storage.short_term_store import ShortTermStore
from src.types import MemorySource, ShortTermMemoryEntry
from src.access import MemoryAccessError


ORDINARY = {"actor_kind": "conversation", "memory_enabled": True}
MASTER = {"actor_kind": "master_private", "memory_enabled": True}
ADMIN = {"actor_kind": "admin", "memory_enabled": True}


@pytest.fixture
def rpc(tmp_path):
    index = SqliteIndex(str(tmp_path / "index.db"))
    result = LongTermV2Rpc(MemoryStore(str(tmp_path / "long_term")), index)
    yield result
    index.close()


async def write(rpc, mid, visibility="internal", scopes=None, type_="fact"):
    await rpc.write_long_term({
        "id": mid, "type": type_, "brief": f"shared topic {mid}", "content": f"body {mid}",
        "source_ref": {"type": "manual"}, "source_trust": 5, "content_confidence": 5,
        "importance_factors": dict.fromkeys(["proximity", "surprisal", "entity_priority", "unambiguity"], 0.5),
        "event_time": "2026-10-10T00:00:00Z", "status": "confirmed",
        "visibility": visibility, "scopes": scopes or [], "access_context": MASTER,
        **({"lesson_meta": {"scenario": "shared scenario"}} if type_ == "lesson" else {}),
    })


@pytest.mark.asyncio
async def test_write_persists_visibility_and_cross_scene_internal_is_readable(rpc):
    await write(rpc, "private", "private", ["A"])
    await write(rpc, "internal-A", scopes=["A"])
    await write(rpc, "internal-B", scopes=["B"])
    assert rpc.store.read("confirmed", "fact", "private").frontmatter.model_dump()["visibility"] == "private"
    private = await rpc.get_memory({"id": "private", "include": "full", "access_context": ORDINARY})
    assert private == {"error": "not found"}
    result = await rpc.list_entries({"status": "confirmed", "access_context": ORDINARY})
    assert {r["id"] for r in result["items"]} == {"internal-A", "internal-B"}


@pytest.mark.asyncio
async def test_missing_legacy_markers_remain_shared_but_invalid_existing_visibility_is_denied(rpc):
    from pathlib import Path
    await write(rpc, "legacy")
    file = Path(rpc.index.get_row("legacy")["path"])
    text = file.read_text().replace("visibility: internal\n", "").replace("scopes: []\n", "")
    file.write_text(text)
    assert (await rpc.get_memory({"id": "legacy", "include": "full", "access_context": ORDINARY}))["body"] == "body legacy"
    file.write_text(text.replace("id: legacy\n", "id: legacy\nvisibility: invalid\n"))
    assert await rpc.get_memory({"id": "legacy", "include": "full", "access_context": ORDINARY}) == {"error": "not found"}


@pytest.mark.asyncio
async def test_private_never_enters_reranker_or_candidate_budget(rpc):
    for i in range(60):
        await write(rpc, f"private-{i}", "private", type_="lesson")
    await write(rpc, "shared", scopes=["other-project"])
    captured = []

    async def rerank(query, docs, top_n):
        captured.extend(docs)
        return [(i, 1.0) for i in range(min(top_n, len(docs)))]

    rpc.pipeline.reranker.rerank_async = rerank
    results = await rpc.search_long_term({"query": "shared topic", "k": 5, "include": "full", "access_context": ORDINARY})
    assert [r["id"] for r in results["results"]] == ["shared"]
    assert captured == ["shared topic shared"]
    assert rpc.index.get_row("private-0")["use_count"] == 0


@pytest.mark.asyncio
async def test_case_rule_preserves_cross_scope_union(rpc):
    for i, scope in enumerate(["A", "B", "C"]):
        await write(rpc, f"case-{i}", scopes=[scope], type_="lesson")
    result = await rpc.promote_to_rule({"source_cases": [f"case-{i}" for i in range(3)], "brief": "shared rule", "content": "rule body", "access_context": ORDINARY})
    rule = rpc.store.read("confirmed", "lesson", result["id"])
    assert rule.frontmatter.visibility == "internal"
    assert set(rule.frontmatter.scopes) == {"A", "B", "C"}


@pytest.mark.asyncio
async def test_short_internal_query_excludes_private_and_keeps_public(tmp_path):
    store = ShortTermStore(str(tmp_path / "short.db"))
    try:
        for vis in ["private", "internal", "public"]:
            await store.add_short_term(ShortTermMemoryEntry(id=vis, content="topic", event_time="2026-10-10T00:00:00Z", source=MemorySource(type="system"), visibility=vis, scopes=[vis]))
        rows = await store.search_short_term(min_visibility="internal")
        assert {r.id for r in rows} == {"internal", "public"}
    finally:
        store.close()


@pytest.mark.asyncio
async def test_version_and_reference_cannot_expose_private_after_admin_relabels_current(rpc):
    await write(rpc, "secret", "private")
    await write(rpc, "shared")
    await rpc.update_long_term({"id": "shared", "patch": {"links": [{"target": "secret", "relation": "refines"}]}, "access_context": ADMIN})
    result = await rpc.get_memory({"id": "shared", "include": "full", "access_context": ORDINARY})
    assert result["frontmatter"]["links"] == []
    await rpc.update_long_term({"id": "secret", "patch": {"visibility": "internal", "brief": "public replacement", "body": "replacement"}, "access_context": ADMIN})
    assert (await rpc.get_memory({"id": "secret", "include": "full", "access_context": ORDINARY}))["body"] == "replacement"
    assert await rpc.get_entry_version({"id": "secret", "version": 1, "access_context": ORDINARY}) == {"error": "not found"}
    assert (await rpc.get_entry_version({"id": "secret", "version": 1, "access_context": MASTER}))["body"] == "body secret"


@pytest.mark.asyncio
async def test_private_ids_cannot_be_modified_overwritten_or_used_as_rule_source(rpc):
    await write(rpc, "secret", "private", type_="lesson")
    for mid in ["one", "two"]:
        await write(rpc, mid, type_="lesson")
    assert await rpc.update_long_term({"id": "secret", "patch": {"visibility": "internal"}, "access_context": ORDINARY}) == {"error": "not found"}
    assert await rpc.delete_memory({"id": "secret", "access_context": ORDINARY}) == {"error": "not found"}
    with pytest.raises(MemoryAccessError):
        await rpc.promote_to_rule({"source_cases": ["secret", "one", "two"], "brief": "rule", "content": "rule", "access_context": ORDINARY})
    with pytest.raises(ValueError, match="visibility"):
        await rpc.promote_to_rule({"source_cases": ["secret", "one", "two"], "brief": "rule", "content": "rule", "access_context": MASTER})
    assert await rpc.write_long_term({"id": "secret", "access_context": ORDINARY}) == {"error": "not found"}
    assert rpc.store.read("confirmed", "lesson", "secret").frontmatter.visibility == "private"


@pytest.mark.asyncio
async def test_explicit_scope_filter_precedes_limit_and_index_disagreement_denies_body(rpc):
    await write(rpc, "A", scopes=["A"])
    for i in range(5):
        await write(rpc, f"B-{i}", scopes=["B"])
    result = await rpc.list_entries({"access_context": ORDINARY, "accessible_scopes": ["A"], "limit": 1})
    assert [r["id"] for r in result["items"]] == ["A"]
    rpc.index.conn.execute("UPDATE memories SET visibility='private' WHERE id='A'")
    rpc.index.conn.commit()
    assert await rpc.get_memory({"id": "A", "access_context": MASTER}) == {"error": "not found"}


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["insert", "delete", "empty_llm"])
async def test_compression_failure_keeps_originals(tmp_path, monkeypatch, failure):
    store = ShortTermStore(str(tmp_path / "short.db"))
    llm = AsyncMock()
    llm.compress_short_term.return_value = [] if failure == "empty_llm" else ["result"]
    try:
        await store.add_short_term(ShortTermMemoryEntry(id="original", content="original", event_time="2020-01-01T00:00:00Z", source=MemorySource(type="system"), visibility="internal", scopes=["A"]))
        if failure == "insert":
            monkeypatch.setattr(store, "_insert_entry", lambda _: (_ for _ in ()).throw(RuntimeError("injected")))
        elif failure == "delete":
            store._conn.execute("CREATE TRIGGER fail_delete BEFORE DELETE ON short_term_memory BEGIN SELECT RAISE(ABORT, 'injected'); END")
            store._conn.commit()
        with pytest.raises(Exception):
            await ShortTermMemory(store, llm).compress(CompressionConfig())
        rows = await store.get_all_short_term_rows()
        assert [row["id"] for row in rows] == ["original"]
        assert rows[0]["content"] == "original"
    finally:
        store.close()


@pytest.mark.asyncio
async def test_compression_never_batches_private_with_internal(tmp_path):
    store = ShortTermStore(str(tmp_path / "short.db"))
    llm = AsyncMock()
    llm.compress_short_term.return_value = ["result"]
    try:
        for visibility in ["internal", "private"]:
            await store.add_short_term(ShortTermMemoryEntry(content=visibility, event_time="2020-01-01T00:00:00Z", source=MemorySource(type="system"), visibility=visibility, scopes=[visibility]))
        await ShortTermMemory(store, llm).compress(CompressionConfig())
        assert [[r["content"] for r in call.args[0]] for call in llm.compress_short_term.call_args_list] == [["private"], ["internal"]]
        assert {row["visibility"] for row in await store.get_all_short_term_rows()} == {"private", "internal"}
    finally:
        store.close()


@pytest.mark.asyncio
async def test_compression_decodes_json_and_unions_different_scopes(tmp_path):
    store = ShortTermStore(str(tmp_path / "short.db"))
    llm = AsyncMock()
    llm.compress_short_term.return_value = ["shared compressed fact"]
    try:
        for scope in ["project-A", "project-B"]:
            await store.add_short_term(ShortTermMemoryEntry(content=scope, event_time="2020-01-01T00:00:00Z", source=MemorySource(type="system"), visibility="internal", scopes=[scope]))
        await ShortTermMemory(store, llm).compress(CompressionConfig())
        rows = await store.get_all_short_term_rows()
        assert len(rows) == 1
        assert set(json.loads(rows[0]["scopes"])) == {"project-A", "project-B"}
        assert len(llm.compress_short_term.call_args.args[0]) == 2
    finally:
        store.close()

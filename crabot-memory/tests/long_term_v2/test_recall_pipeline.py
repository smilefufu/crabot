"""End-to-end recall pipeline tests (v3: 4-path, no embedding)."""
import json
import pytest

from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, EntityRef,
)
from src.long_term_v2.recall_pipeline import RecallPipeline
from src.long_term_v2.reranker import FallbackReranker
from src.long_term_v2.paths import entry_path


class StubLLM:
    """Always returns {} so preprocess and chain-of-note are pass-through."""
    async def chat_completion(self, messages, **kwargs):
        return "{}"


def _persist(store, idx, mem_id, brief, body, event_time, type_="fact",
             entities=None, tags=None):
    fm = MemoryFrontmatter(
        id=mem_id, type=type_, maturity="confirmed",
        brief=brief, author="user",
        source_ref=SourceRef(type="manual"),
        source_trust=5, content_confidence=5,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5,
            entity_priority=0.5, unambiguity=0.5,
        ),
        entities=entities or [],
        tags=tags or [],
        event_time=event_time, ingestion_time=event_time,
    )
    entry = MemoryEntry(frontmatter=fm, body=body)
    store.write(entry, status="confirmed")
    path = entry_path(store.data_root, "confirmed", type_, mem_id)
    idx.upsert(entry, path=path, status="confirmed")


@pytest.fixture
async def pipeline(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    # v3: 不再用 embedding；4 路召回里 sparse 路径靠 brief/body 字面匹配
    for mid, brief, body, et, ents in [
        ("m1", "张三微信", "wxid_zhangsan", "2026-04-20T10:00:00Z",
         [EntityRef(type="friend", id="z3", name="张三")]),
        ("m2", "李四电话", "13800000000", "2026-04-19T10:00:00Z",
         [EntityRef(type="friend", id="l4", name="李四")]),
        ("m3", "项目 A 截止", "2026-06-30 deadline", "2026-04-18T10:00:00Z", []),
    ]:
        _persist(store, idx, mid, brief, body, et, entities=ents)
    pipe = RecallPipeline(
        store=store, index=idx,
        llm=StubLLM(), reranker=FallbackReranker(),
    )
    return pipe


@pytest.mark.asyncio
async def test_pipeline_returns_results(pipeline):
    pipe = pipeline
    out = await pipe.recall(query="张三 微信", k=3, filters={})
    assert len(out) >= 1
    assert any("张三" in r["brief"] for r in out)


@pytest.mark.asyncio
async def test_pipeline_entity_filter_routes_through_entity_path(pipeline):
    pipe = pipeline
    out = await pipe.recall(query="联系方式", k=5, filters={"entities": ["z3"]})
    ids = [r["id"] for r in out]
    assert "m1" in ids


@pytest.mark.asyncio
async def test_pipeline_respects_top_k(pipeline):
    pipe = pipeline
    out = await pipe.recall(query="information", k=2, filters={})
    assert len(out) <= 2


@pytest.mark.asyncio
async def test_pipeline_result_includes_paths_and_score(pipeline):
    pipe = pipeline
    out = await pipe.recall(query="张三", k=3, filters={})
    if out:
        assert "score" in out[0]
        assert "paths" in out[0]
        assert isinstance(out[0]["paths"], list)


@pytest.mark.asyncio
async def test_pipeline_returns_empty_when_no_data(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    pipe = RecallPipeline(
        store=store, index=idx,
        llm=StubLLM(), reranker=FallbackReranker(),
    )
    out = await pipe.recall(query="anything", k=5, filters={})
    assert out == []


@pytest.mark.asyncio
async def test_pipeline_skips_chain_of_note_below_threshold(pipeline, monkeypatch):
    """cand_count < threshold (8) → chain_of_note must not be called.

    Lost-in-middle 在 K<8 时不显著，跑 LLM 是浪费。fixture 只有 3 条数据，
    天然落在阈值之下。
    """
    from src.long_term_v2 import recall_pipeline as rp

    called = {"n": 0}

    async def fake_cot(*args, **kwargs):
        called["n"] += 1
        return list(args[1]) if len(args) > 1 else []

    monkeypatch.setattr(rp, "chain_of_note", fake_cot)
    await pipeline.recall(query="张三 微信", k=3, filters={})
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_pipeline_invokes_chain_of_note_at_threshold(pipeline, monkeypatch):
    """cand_count ≥ threshold → chain_of_note must run. 用降低阈值模拟达标场景。"""
    from src.long_term_v2 import recall_pipeline as rp

    called = {"n": 0}

    async def fake_cot(query, docs, llm):
        called["n"] += 1
        return docs

    monkeypatch.setattr(rp, "chain_of_note", fake_cot)
    monkeypatch.setattr(rp, "_COT_MIN_CANDIDATES", 1)
    await pipeline.recall(query="张三 微信", k=3, filters={})
    assert called["n"] == 1

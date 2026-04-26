"""End-to-end 6-step recall pipeline with fakes."""
import json
import hashlib
import pytest

from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, EntityRef,
)
from src.long_term_v2.recall_pipeline import RecallPipeline
from src.long_term_v2.reranker import FallbackReranker
from src.long_term_v2.paths import entry_path


class FakeEmbedder:
    async def embed_single(self, text):
        h = hashlib.sha256(text.encode()).digest()
        return [b / 255.0 for b in h[:8]]


class StubLLM:
    """Always returns {} so preprocess and chain-of-note are pass-through."""
    async def chat_completion(self, messages, **kwargs):
        return "{}"


def _persist(store, idx, mem_id, brief, body, event_time, type_="fact",
             entities=None, tags=None, embedder_vec=None):
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
    if embedder_vec is not None:
        idx.upsert_embedding(mem_id, "content", embedder_vec)


@pytest.fixture
async def pipeline(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    embedder = FakeEmbedder()
    # Persist with deterministic embeddings (sha-derived)
    for mid, brief, body, et, ents in [
        ("m1", "张三微信", "wxid_zhangsan", "2026-04-20T10:00:00Z",
         [EntityRef(type="friend", id="z3", name="张三")]),
        ("m2", "李四电话", "13800000000", "2026-04-19T10:00:00Z",
         [EntityRef(type="friend", id="l4", name="李四")]),
        ("m3", "项目 A 截止", "2026-06-30 deadline", "2026-04-18T10:00:00Z", []),
    ]:
        vec = await embedder.embed_single(body)
        _persist(store, idx, mid, brief, body, et, entities=ents, embedder_vec=vec)
    pipe = RecallPipeline(
        store=store, index=idx, embedder=embedder,
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
        store=store, index=idx, embedder=FakeEmbedder(),
        llm=StubLLM(), reranker=FallbackReranker(),
    )
    out = await pipe.recall(query="anything", k=5, filters={})
    assert out == []

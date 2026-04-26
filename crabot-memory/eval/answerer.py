"""Two answerer implementations: v1 (legacy) and v2 (recall pipeline)."""
from typing import Any, List

from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.recall_pipeline import RecallPipeline
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, EntityRef,
    new_memory_id, default_maturity_fresh,
)
from src.long_term_v2.paths import entry_path
from src.long_term_v2.embedder import texts_for_entry, embed_text_async
from eval.sample_loader import EvalSample


async def _setup_memories(store, index, embedder, mems: List[dict]) -> None:
    for m in mems:
        type_ = m["type"]
        fm = MemoryFrontmatter(
            id=new_memory_id(),
            type=type_,
            maturity=default_maturity_fresh(type_),
            brief=m["brief"],
            author="system",
            source_ref=SourceRef(type="manual"),
            source_trust=5, content_confidence=5,
            importance_factors=ImportanceFactors(
                proximity=0.5, surprisal=0.5,
                entity_priority=0.5, unambiguity=0.5,
            ),
            entities=[EntityRef(**e) for e in m.get("entities", [])],
            tags=m.get("tags", []),
            event_time=m["event_time"],
            ingestion_time=m["event_time"],
        )
        entry = MemoryEntry(frontmatter=fm, body=m["content"])
        store.write(entry, status="confirmed")
        path = entry_path(store.data_root, "confirmed", type_, fm.id)
        index.upsert(entry, path=path, status="confirmed")
        for field, text in texts_for_entry(entry).items():
            if not text:
                continue
            vec = await embed_text_async(text, embedder)
            index.upsert_embedding(fm.id, field, vec)


class V2Answerer:
    """Builds a fresh memory store per sample, indexes setup_memories, runs recall pipeline."""

    def __init__(self, embedder, llm=None, reranker=None, tmp_root: str = None):
        from tempfile import mkdtemp
        self.embedder = embedder
        self.llm = llm
        self.reranker = reranker
        self.tmp_root = tmp_root or mkdtemp(prefix="eval-v2-")

    async def answer(self, query: str, sample: EvalSample) -> str:
        import os
        slot = os.path.join(self.tmp_root, sample.id)
        store = MemoryStore(os.path.join(slot, "long_term"))
        index = SqliteIndex(os.path.join(slot, "idx.db"))
        try:
            await _setup_memories(store, index, self.embedder, sample.setup_memories)
            pipeline = RecallPipeline(
                store=store, index=index, embedder=self.embedder,
                llm=self.llm, reranker=self.reranker,
            )
            results = await pipeline.recall(query=query, k=3, filters={})
        finally:
            index.close()
        if not results:
            return "我没有这个信息"
        return results[0]["brief"]


class V1Answerer:
    """Stub baseline: dense-only single recall over the same setup_memories.

    Mirrors the pre-Phase-2 path: cosine similarity over `content` field, top-1.
    """

    def __init__(self, embedder, tmp_root: str = None):
        from tempfile import mkdtemp
        self.embedder = embedder
        self.tmp_root = tmp_root or mkdtemp(prefix="eval-v1-")

    async def answer(self, query: str, sample: EvalSample) -> str:
        import os
        slot = os.path.join(self.tmp_root, sample.id)
        store = MemoryStore(os.path.join(slot, "long_term"))
        index = SqliteIndex(os.path.join(slot, "idx.db"))
        try:
            await _setup_memories(store, index, self.embedder, sample.setup_memories)
            qv = await embed_text_async(query, self.embedder)
            scored = index.cosine_topk(qv, k=1, field="content")
            if not scored:
                return "我没有这个信息"
            mid, _ = scored[0]
            loc = index.locate(mid)
            if not loc:
                return "我没有这个信息"
            status, type_, _ = loc
            entry = store.read(status, type_, mid)
            return entry.frontmatter.brief
        finally:
            index.close()

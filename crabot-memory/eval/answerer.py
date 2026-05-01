"""V2/V3 answerer: builds a fresh memory store per sample, runs recall pipeline.

v3：embedding 子系统已移除，dense path 已删。V1Answerer（dense-only baseline）也一并删除——
没有 dense path 后它跟 V2Answerer 等价。eval framework 只保留 V2/V3 路径。
"""
from typing import List

from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.recall_pipeline import RecallPipeline
from src.long_term_v2.schema import (
    EntityRef,
    ImportanceFactors,
    MemoryEntry,
    MemoryFrontmatter,
    SourceRef,
    default_maturity_fresh,
    new_memory_id,
)
from src.long_term_v2.paths import entry_path
from eval.sample_loader import EvalSample


def _setup_memories(store, index, mems: List[dict]) -> None:
    for m in mems:
        type_ = m["type"]
        fm = MemoryFrontmatter(
            id=new_memory_id(),
            type=type_,
            maturity=default_maturity_fresh(type_),
            brief=m["brief"],
            author="system",
            source_ref=SourceRef(type="manual"),
            source_trust=5,
            content_confidence=5,
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


class V2Answerer:
    """Per-sample memory store + 4-path recall pipeline."""

    def __init__(self, llm=None, reranker=None, tmp_root: str = None):
        from tempfile import mkdtemp
        self.llm = llm
        self.reranker = reranker
        self.tmp_root = tmp_root or mkdtemp(prefix="eval-v2-")

    async def answer(self, query: str, sample: EvalSample) -> str:
        import os
        slot = os.path.join(self.tmp_root, sample.id)
        store = MemoryStore(os.path.join(slot, "long_term"))
        index = SqliteIndex(os.path.join(slot, "idx.db"))
        try:
            _setup_memories(store, index, sample.setup_memories)
            pipeline = RecallPipeline(
                store=store, index=index,
                llm=self.llm, reranker=self.reranker,
            )
            results = await pipeline.recall(query=query, k=3, filters={})
        finally:
            index.close()
        if not results:
            return "我没有这个信息"
        return results[0]["brief"]

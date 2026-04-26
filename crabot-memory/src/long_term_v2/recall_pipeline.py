"""6-step recall pipeline orchestrator (Memory v2 spec §7.2)."""
import asyncio
import logging
from typing import Any, Dict, List, Optional

from rank_bm25 import BM25Okapi

from src.long_term_v2.query_preprocess import preprocess_query
from src.long_term_v2.embedder import embed_text_async
from src.long_term_v2.rrf import rrf_fuse
from src.long_term_v2.reranker import rerank, FallbackReranker
from src.long_term_v2.chain_of_note import chain_of_note
from src.long_term_v2.type_boost import apply_type_boost

logger = logging.getLogger(__name__)


def _tokenize(text: str) -> list:
    out = []
    buf = []
    for ch in text:
        if ch.isascii() and ch.isalnum():
            buf.append(ch.lower())
        else:
            if buf:
                out.append("".join(buf))
                buf = []
            if not ch.isspace():
                out.append(ch)
    if buf:
        out.append("".join(buf))
    return out


class RecallPipeline:
    def __init__(self, store, index, embedder, llm=None, reranker=None):
        self.store = store
        self.index = index
        self.embedder = embedder
        self.llm = llm
        self.reranker = reranker or FallbackReranker()

    async def recall(
        self, query: str, k: int, filters: Optional[Dict[str, Any]] = None,
        recent_entities: Optional[List[dict]] = None,
    ) -> List[Dict[str, Any]]:
        filters = filters or {}

        # ─── Step 0: pre-process ───
        pq = await preprocess_query(query, recent_entities=recent_entities, llm=self.llm)
        canonical = pq.canonical
        embed_text = pq.hyde_doc or canonical

        # ─── Step 1: 5-pathway recall in parallel ───
        dense_task = self._dense_path(embed_text, top=50)
        sparse_task = self._sparse_path(canonical, top=50)
        bi_temporal_ids = self._bi_temporal_path(pq.time_window, top=30) if pq.time_window else []
        entity_ids = self._entity_path(filters.get("entities") or [], top=20)
        tag_ids = self._tag_path(filters.get("tags") or [], top=20)
        dense_ids, sparse_ids = await asyncio.gather(dense_task, sparse_task)

        ranked_paths = {
            "dense": dense_ids,
            "sparse": sparse_ids,
            "entity": entity_ids,
            "tag": tag_ids,
            "bi_temporal": bi_temporal_ids,
        }

        # ─── Step 2: RRF fusion ───
        fused = rrf_fuse(ranked_paths, k=60, top=50)
        if not fused:
            return []

        # ─── enrich with metadata for boost + rerank ───
        candidates = self._enrich(fused, in_time_window_ids=set(bi_temporal_ids))

        # type-differentiated boost (cheap, before rerank)
        candidates = apply_type_boost(candidates)
        candidates = candidates[:20]  # rerank a bounded slice

        # ─── Step 3: cross-encoder rerank ───
        docs = [c["brief"] for c in candidates]
        reranked = await rerank(canonical, docs, top_n=10, client=self.reranker)
        rerank_score_by_brief = {brief: s for brief, s in reranked}
        candidates = [c for c in candidates if c["brief"] in rerank_score_by_brief]
        for c in candidates:
            c["rerank_score"] = rerank_score_by_brief[c["brief"]]
        candidates.sort(key=lambda c: c["rerank_score"], reverse=True)

        # ─── Step 4: Chain-of-Note ───
        if self.llm is not None:
            candidates = await chain_of_note(canonical, candidates, llm=self.llm)

        # type filter applied after chain-of-note (Phase 1 parity)
        type_filter = filters.get("type")
        if type_filter:
            candidates = [c for c in candidates if c["type"] == type_filter]

        return candidates[:k]

    # ─── path helpers ───
    async def _dense_path(self, text: str, top: int) -> List[str]:
        if self.embedder is None:
            return []
        try:
            qv = await embed_text_async(text, self.embedder)
        except Exception as e:  # noqa: BLE001
            logger.warning("dense embedding failed: %s", e)
            return []
        scored = self.index.cosine_topk(qv, k=top, field="content")
        return [mid for mid, _ in scored]

    async def _sparse_path(self, text: str, top: int) -> List[str]:
        rows = list(self.index.iter_brief_for_bm25())
        if not rows:
            return []
        corpus = [_tokenize(r[3] + " " + r[4]) for r in rows]
        bm25 = BM25Okapi(corpus)
        scores = bm25.get_scores(_tokenize(text))
        scored = sorted(
            ((rows[i][0], float(scores[i])) for i in range(len(rows))),
            key=lambda x: x[1],
            reverse=True,
        )[:top]
        return [mid for mid, _ in scored]

    def _bi_temporal_path(self, window, top: int) -> List[str]:
        if not window:
            return []
        start, end = window
        return self.index.find_by_time_range("event_time", start, end, limit=top)

    def _entity_path(self, entity_ids, top: int) -> List[str]:
        seen, out = set(), []
        for eid in entity_ids:
            for mid in self.index.find_by_entity(eid):
                if mid in seen:
                    continue
                seen.add(mid)
                out.append(mid)
                if len(out) >= top:
                    return out
        return out

    def _tag_path(self, tags, top: int) -> List[str]:
        seen, out = set(), []
        for t in tags:
            for mid in self.index.find_by_tag(t):
                if mid in seen:
                    continue
                seen.add(mid)
                out.append(mid)
                if len(out) >= top:
                    return out
        return out

    def _enrich(self, fused, in_time_window_ids: set) -> List[Dict[str, Any]]:
        out = []
        for mid, fused_score, paths in fused:
            loc = self.index.locate(mid)
            if not loc:
                continue
            status, type_, _ = loc
            entry = self.store.read(status, type_, mid)
            fm = entry.frontmatter
            out.append({
                "id": mid,
                "type": type_,
                "status": status,
                "brief": fm.brief,
                "score": fused_score,
                "paths": sorted(paths),
                "in_time_window": mid in in_time_window_ids,
                "invalidated": fm.invalidated_by is not None,
                "use_count": (fm.lesson_meta.use_count if fm.lesson_meta else 0),
                "outcome": (fm.lesson_meta.outcome if fm.lesson_meta else None),
            })
        return out

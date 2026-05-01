"""Recall pipeline orchestrator (Memory v3 — 4-path).

v3 改动：删除 dense embedding 路径。剩余 4 路：sparse / entity / tag / bi_temporal。
背景：5.2% 独有命中集中在指令性短 query 上，这类 query 不该走语义检索；
主题性 query 在 4 路上召回充分（90% 重叠率）。详见
crabot-docs/superpowers/specs/2026-04-30-remove-embedding-design.md。
"""
import logging
import time
from typing import Any, Dict, List, Optional

from rank_bm25 import BM25Okapi

from src.long_term_v2.query_preprocess import preprocess_query
from src.long_term_v2.rrf import rrf_fuse
from src.long_term_v2.reranker import rerank, FallbackReranker
from src.long_term_v2.chain_of_note import chain_of_note
from src.long_term_v2.type_boost import apply_type_boost

logger = logging.getLogger(__name__)

# Chain-of-Note 触发阈值：candidates 数量 ≥ 此值才跑同步 LLM 重排。
# Lost-in-middle 论文显著塌陷在 K≥20，工程经验 K≥10 起能感知；阈值偏保守取 8。
# 低于阈值时 step3 rerank 已排好序，直接返回。
_COT_MIN_CANDIDATES = 8


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
    def __init__(self, store, index, llm=None, reranker=None):
        self.store = store
        self.index = index
        self.llm = llm
        self.reranker = reranker or FallbackReranker()

    async def recall(
        self, query: str, k: int, filters: Optional[Dict[str, Any]] = None,
        recent_entities: Optional[List[dict]] = None,
    ) -> List[Dict[str, Any]]:
        filters = filters or {}
        timings: Dict[str, float] = {}
        t_start = time.perf_counter()

        # ─── Step 0: pre-process ───
        t0 = time.perf_counter()
        pq = await preprocess_query(query, recent_entities=recent_entities, llm=self.llm)
        timings["step0_preprocess_ms"] = (time.perf_counter() - t0) * 1000
        canonical = pq.canonical

        # ─── Step 1: 4-pathway recall ───
        t1 = time.perf_counter()
        sparse_ids = await self._timed("sparse", self._sparse_path(canonical, top=50), timings)
        bi_temporal_ids = self._bi_temporal_path(pq.time_window, top=30) if pq.time_window else []
        entity_ids = self._entity_path(filters.get("entities") or [], top=20)
        tag_ids = self._tag_path(filters.get("tags") or [], top=20)
        timings["step1_total_ms"] = (time.perf_counter() - t1) * 1000

        ranked_paths = {
            "sparse": sparse_ids,
            "entity": entity_ids,
            "tag": tag_ids,
            "bi_temporal": bi_temporal_ids,
        }

        # ─── Step 2: RRF fusion ───
        t2 = time.perf_counter()
        fused = rrf_fuse(ranked_paths, k=60, top=50)
        timings["step2_rrf_ms"] = (time.perf_counter() - t2) * 1000
        if not fused:
            timings["total_ms"] = (time.perf_counter() - t_start) * 1000
            logger.info("recall_pipeline timings (empty): %s", timings)
            return []

        # ─── enrich with metadata for boost + rerank ───
        t_enrich = time.perf_counter()
        candidates = self._enrich(fused, in_time_window_ids=set(bi_temporal_ids))
        candidates = apply_type_boost(candidates)
        candidates = candidates[:20]  # rerank a bounded slice
        timings["enrich_boost_ms"] = (time.perf_counter() - t_enrich) * 1000

        # ─── Step 3: cross-encoder rerank ───
        t3 = time.perf_counter()
        docs = [c["brief"] for c in candidates]
        reranked = await rerank(canonical, docs, top_n=10, client=self.reranker)
        timings["step3_rerank_ms"] = (time.perf_counter() - t3) * 1000
        rerank_score_by_brief = {brief: s for brief, s in reranked}
        candidates = [c for c in candidates if c["brief"] in rerank_score_by_brief]
        for c in candidates:
            c["rerank_score"] = rerank_score_by_brief[c["brief"]]
        candidates.sort(key=lambda c: c["rerank_score"], reverse=True)

        # ─── Step 4: Chain-of-Note ───
        # 仅当 candidates 数量达到 lost-in-middle 风险阈值时才跑（同步 LLM 调用代价高）。
        # 论文里显著塌陷在 K≥20，工程经验 K≥10 起能感知；阈值偏保守取 8。
        # 低于阈值时 candidates 已按 step3 cross-encoder 分数排好序，直接返回。
        t4 = time.perf_counter()
        cand_n = len(candidates)
        if self.llm is not None and cand_n >= _COT_MIN_CANDIDATES:
            candidates = await chain_of_note(canonical, candidates, llm=self.llm)
            logger.info(
                "chain_of_note triggered (cand=%d ≥ %d threshold)", cand_n, _COT_MIN_CANDIDATES,
            )
        else:
            if self.llm is not None:
                logger.info(
                    "chain_of_note skipped (cand=%d < %d threshold)", cand_n, _COT_MIN_CANDIDATES,
                )
        timings["step4_chain_of_note_ms"] = (time.perf_counter() - t4) * 1000

        # type filter applied after chain-of-note (Phase 1 parity)
        type_filter = filters.get("type")
        if type_filter:
            candidates = [c for c in candidates if c["type"] == type_filter]

        timings["total_ms"] = (time.perf_counter() - t_start) * 1000
        logger.info(
            "recall_pipeline timings: total=%.0fms step0=%.0fms step1=%.0fms(sparse=%.0fms) step2=%.0fms step3_rerank=%.0fms step4_cot=%.0fms cand_count=%d",
            timings["total_ms"], timings["step0_preprocess_ms"], timings["step1_total_ms"],
            timings.get("sparse_ms", 0),
            timings["step2_rrf_ms"], timings["step3_rerank_ms"], timings["step4_chain_of_note_ms"],
            len(candidates),
        )

        return candidates[:k]

    async def _timed(self, label: str, coro, timings: Dict[str, float]):
        t = time.perf_counter()
        try:
            return await coro
        finally:
            timings[f"{label}_ms"] = (time.perf_counter() - t) * 1000

    # ─── path helpers ───
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

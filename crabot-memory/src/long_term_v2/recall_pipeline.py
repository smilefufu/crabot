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

# 跟随 invalidated_by 链的最大跳数，防环/防失控。
_MAX_INVALIDATION_HOPS = 8
# 召回默认剔除的衰退态 maturity。
_OUTDATED_MATURITY = frozenset({"stale", "retired"})

# 图扩展（默认关）：单次召回最多纳入的扩展邻居数。
_EXPAND_MAX = 5
# 扩展节点相对种子的分数降权。
_EXPAND_DECAY = 0.6


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
        recent_entities: Optional[List[dict]] = None, include_outdated: bool = False,
        enable_graph_expansion: bool = False,
    ) -> List[Dict[str, Any]]:
        filters = filters or {}
        status_filter = filters.get("status") or "confirmed"
        timings: Dict[str, float] = {}
        t_start = time.perf_counter()

        # ─── Step 0: pre-process ───
        t0 = time.perf_counter()
        pq = await preprocess_query(query, recent_entities=recent_entities, llm=self.llm)
        timings["step0_preprocess_ms"] = (time.perf_counter() - t0) * 1000
        canonical = pq.canonical

        # ─── Step 1: 4-pathway recall ───
        t1 = time.perf_counter()
        sparse_ids = await self._timed(
            "sparse", self._sparse_path(canonical, top=50, status=status_filter), timings,
        )
        bi_temporal_ids = (
            self._bi_temporal_path(pq.time_window, top=30, status=status_filter)
            if pq.time_window else []
        )
        entity_ids = self._entity_path(filters.get("entities") or [], top=20, status=status_filter)
        tag_ids = self._tag_path(filters.get("tags") or [], top=20, status=status_filter)
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
        candidates = self._enrich(
            fused, in_time_window_ids=set(bi_temporal_ids), required_status=status_filter,
        )
        candidates = self._apply_outdated_policy(
            candidates, include_outdated, required_status=status_filter,
        )
        if enable_graph_expansion:
            candidates = self._expand_graph(candidates, required_status=status_filter)
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
    async def _sparse_path(self, text: str, top: int, status: str) -> List[str]:
        rows = list(self.index.iter_brief_for_bm25(status=status))
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

    def _bi_temporal_path(self, window, top: int, status: str) -> List[str]:
        if not window:
            return []
        start, end = window
        return self.index.find_by_time_range("event_time", start, end, limit=top, status=status)

    def _entity_path(self, entity_ids, top: int, status: str) -> List[str]:
        seen, out = set(), []
        for eid in entity_ids:
            for mid in self.index.find_by_entity(eid, status=status):
                if mid in seen:
                    continue
                seen.add(mid)
                out.append(mid)
                if len(out) >= top:
                    return out
        return out

    def _tag_path(self, tags, top: int, status: str) -> List[str]:
        seen, out = set(), []
        for t in tags:
            for mid in self.index.find_by_tag(t, status=status):
                if mid in seen:
                    continue
                seen.add(mid)
                out.append(mid)
                if len(out) >= top:
                    return out
        return out

    def _enrich(self, fused, in_time_window_ids: set, required_status: str | None = None) -> List[Dict[str, Any]]:
        out = []
        for mid, fused_score, paths in fused:
            loc = self.index.locate(mid)
            if not loc:
                continue
            status, type_, _ = loc
            if required_status is not None and status != required_status:
                continue
            entry = self.store.read(status, type_, mid)
            out.append(self._enrich_one(
                mid, status, type_, entry, score=fused_score,
                paths=sorted(paths), in_time_window=mid in in_time_window_ids,
            ))
        return out

    def _enrich_one(self, mid, status, type_, entry, *, score,
                    paths=None, in_time_window=False) -> Dict[str, Any]:
        fm = entry.frontmatter
        return {
            "id": mid,
            "type": type_,
            "status": status,
            "maturity": fm.maturity,
            "brief": fm.brief,
            "score": score,
            "paths": paths if paths is not None else [],
            "in_time_window": in_time_window,
            "invalidated": fm.invalidated_by is not None,
            "invalidated_by": fm.invalidated_by,
            "use_count": (fm.lesson_meta.use_count if fm.lesson_meta else 0),
            "outcome": (fm.lesson_meta.outcome if fm.lesson_meta else None),
        }

    def _resolve_live(self, mem_id, _depth: int = 0, _seen=None, required_status: str | None = None):
        """沿 invalidated_by 跟随到最新的、非 trash、未被取代的条目。
        返回 (status, type_, entry)；若链断/进 trash/不存在/成环则 None。"""
        _seen = _seen if _seen is not None else set()
        if mem_id in _seen or _depth > _MAX_INVALIDATION_HOPS:
            return None
        _seen.add(mem_id)
        loc = self.index.locate(mem_id)
        if not loc:
            return None
        status, type_, _ = loc
        if status == "trash" or (required_status is not None and status != required_status):
            return None
        entry = self.store.read(status, type_, mem_id)
        nxt = entry.frontmatter.invalidated_by
        if nxt:
            return self._resolve_live(nxt, _depth + 1, _seen, required_status)
        if entry.frontmatter.maturity in _OUTDATED_MATURITY:
            return None
        return (status, type_, entry)

    def _apply_outdated_policy(self, candidates, include_outdated: bool, required_status: str | None = None):
        """剔除 stale/retired；把被 invalidated_by 取代的条目替换为 successor。
        include_outdated=True 时原样返回（反思清理流程用）。"""
        if include_outdated:
            return candidates
        present = {c["id"] for c in candidates}
        out, added = [], set()
        for c in candidates:
            if c.get("maturity") in _OUTDATED_MATURITY:
                continue
            inv = c.get("invalidated_by")
            if inv:
                live = self._resolve_live(inv, required_status=required_status)
                if live is None:
                    continue  # successor 已消失 → 不泄露被取代条目
                status, type_, entry = live
                sid = entry.frontmatter.id
                if sid in added or (sid in present and sid != c["id"]):
                    continue  # successor 已在结果/候选里 → 去重，丢旧
                c = self._enrich_one(sid, status, type_, entry, score=c["score"])
            if c["id"] in added:
                continue
            added.add(c["id"])
            out.append(c)
        return out

    def _expand_graph(self, candidates, required_status: str | None = None):
        """沿 links 扩展种子的 1 跳邻居，纳入候选池（降权、标 expanded/via_relation）。
        默认仅由 recall(enable_graph_expansion=True) 调用。"""
        present = {c["id"] for c in candidates}
        added = list(candidates)
        budget = _EXPAND_MAX
        for seed in candidates:
            if budget <= 0:
                break
            for link in self.index.find_links_from(seed["id"]):
                if budget <= 0:
                    break
                tid = link["target"]
                if tid in present:
                    continue
                loc = self.index.locate(tid)
                if not loc:
                    continue
                status, type_, _ = loc
                if status == "trash" or (required_status is not None and status != required_status):
                    continue
                entry = self.store.read(status, type_, tid)
                enriched = self._enrich_one(
                    tid, status, type_, entry,
                    score=seed["score"] * _EXPAND_DECAY,
                )
                enriched["expanded"] = True
                enriched["via_relation"] = link["relation"]
                present.add(tid)
                added.append(enriched)
                budget -= 1
        return added

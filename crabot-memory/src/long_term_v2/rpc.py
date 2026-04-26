"""Long-term v2 RPC handlers."""
import asyncio
from datetime import datetime, timezone

from src.long_term_v2.maintenance import run_maintenance as _run_maintenance, MaintenanceConfig
from src.long_term_v2.snapshot import build_confirmed_snapshot
from src.long_term_v2.evolution import (
    get_evolution_mode as _get_mode, set_evolution_mode as _set_mode,
    synthesize_rule as _synthesize_rule,
)
from src.long_term_v2.schema import (
    MemoryEntry,
    MemoryFrontmatter,
    SourceRef,
    ImportanceFactors,
    EntityRef,
    LessonMeta,
    default_maturity_fresh,
    new_memory_id,
    utc_now_iso_z,
)
from src.long_term_v2.embedder import texts_for_entry, embed_text_async
from src.long_term_v2.paths import entry_path
from src.long_term_v2.recall_pipeline import RecallPipeline
from src.long_term_v2.agentic_tools import AgenticTools


_UPDATABLE_FIELDS = frozenset({
    "brief", "tags", "entities", "maturity",
    "importance_factors", "invalidated_by", "lesson_meta", "observation",
})


class LongTermV2Rpc:
    def __init__(self, store, index, embedder, llm=None, reranker=None):
        self.store = store
        self.index = index
        self.embedder = embedder
        self.pipeline = RecallPipeline(
            store=store, index=index, embedder=embedder,
            llm=llm, reranker=reranker,
        )
        self.tools = AgenticTools(store=store, index=index)

    async def write_long_term(self, params: dict) -> dict:
        mem_id = params.get("id") or new_memory_id()
        entities = [EntityRef(**e) for e in params.get("entities", [])]
        lesson_meta_raw = params.get("lesson_meta")
        lesson_meta = LessonMeta(**lesson_meta_raw) if lesson_meta_raw else None
        fm = MemoryFrontmatter(
            id=mem_id,
            type=params["type"],
            maturity=params.get("maturity") or default_maturity_fresh(params["type"]),
            brief=params["brief"],
            author=params.get("author", "system"),
            source_ref=SourceRef(**params["source_ref"]),
            source_trust=int(params["source_trust"]),
            content_confidence=int(params["content_confidence"]),
            importance_factors=ImportanceFactors(**params["importance_factors"]),
            entities=entities,
            tags=params.get("tags", []),
            event_time=params["event_time"],
            ingestion_time=utc_now_iso_z(),
            lesson_meta=lesson_meta,
        )
        entry = MemoryEntry(frontmatter=fm, body=params.get("content", ""))
        status = params.get("status", "inbox")
        self.store.write(entry, status=status)
        path = entry_path(self.store.data_root, status, fm.type, fm.id)
        self.index.upsert(entry, path=path, status=status)
        if self.embedder is not None:
            fields = [(f, t) for f, t in texts_for_entry(entry).items() if t]
            vecs = await asyncio.gather(
                *(embed_text_async(t, self.embedder) for _, t in fields)
            )
            for (field, _), vec in zip(fields, vecs):
                self.index.upsert_embedding(mem_id, field, vec)
        return {"id": mem_id, "status": "ok"}

    async def search_long_term(self, params: dict) -> dict:
        query = params["query"]
        k = int(params.get("k", 10))
        filters = params.get("filters", {}) or {}
        include = params.get("include", "brief")
        recent_entities = params.get("recent_entities") or []
        task_id = params.get("task_id")  # NEW: 召回所属 task，反馈链路用

        results = await self.pipeline.recall(
            query=query, k=k, filters=filters, recent_entities=recent_entities,
        )

        # Phase 3 T18: bump use_count for lesson hits only.
        # fact/concept use_count semantics differ — do not bump them.
        # Phase A (2026-04-25): 同时记录 lesson_task_usage（feedback 反向查询用）
        # Failures must not disrupt the search response.
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        for r in results:
            if r.get("type") == "lesson":
                try:
                    self.index.bump_use_count(r["id"], now_iso=now_iso)
                    if task_id:
                        self.index.record_lesson_task_usage(task_id, r["id"], now_iso=now_iso)
                except Exception:
                    pass

        if include == "full":
            for r in results:
                entry = self.store.read(r["status"], r["type"], r["id"])
                r["body"] = entry.body
                r["frontmatter"] = entry.frontmatter.model_dump(exclude_none=True, mode="json")

        return {"results": results}

    async def get_memory(self, params: dict) -> dict:
        mem_id = params["id"]
        include = params.get("include", "brief")
        loc = self.index.locate(mem_id)
        if not loc:
            return {"error": "not found"}
        status, type_, _ = loc
        entry = self.store.read(status, type_, mem_id)
        out = {
            "id": mem_id,
            "type": type_,
            "status": status,
            "brief": entry.frontmatter.brief,
        }
        if include == "full":
            out["body"] = entry.body
            out["frontmatter"] = entry.frontmatter.model_dump(exclude_none=True, mode="json")
        return out

    async def delete_memory(self, params: dict) -> dict:
        mem_id = params["id"]
        loc = self.index.locate(mem_id)
        if not loc:
            return {"error": "not found"}
        status, type_, _ = loc
        if status != "trash":
            self.store.delete_to_trash(type_, mem_id, from_status=status)
            new_path = entry_path(self.store.data_root, "trash", type_, mem_id)
            entry = self.store.read("trash", type_, mem_id)
            self.index.upsert(entry, path=new_path, status="trash")
        return {"status": "ok"}

    async def update_long_term(self, params: dict) -> dict:
        mem_id = params["id"]
        patch = params.get("patch") or {}
        loc = self.index.locate(mem_id)
        if not loc:
            return {"error": "not found"}
        status, type_, _ = loc
        entry = self.store.read(status, type_, mem_id)

        fm_updates: dict = {}

        # ---- 既有字段（Phase 1 逻辑） ----
        for k in _UPDATABLE_FIELDS:
            if k in patch:
                fm_updates[k] = patch[k]

        # ---- Phase 3 新增 patch 操作 ----
        if "content_confidence_increment" in patch:
            delta = int(patch["content_confidence_increment"])
            new_val = min(5, max(1, entry.frontmatter.content_confidence + delta))
            fm_updates["content_confidence"] = new_val

        if "use_count_increment" in patch:
            if entry.frontmatter.type != "lesson":
                raise ValueError(
                    f"use_count_increment only valid for lesson (got {entry.frontmatter.type})"
                )
            delta = int(patch["use_count_increment"])
            lm = entry.frontmatter.lesson_meta or LessonMeta()
            new_meta = lm.model_copy(update={
                "use_count": lm.use_count + delta,
                **({"last_validated_at": patch["validated_at"]} if "validated_at" in patch else {}),
            })
            fm_updates["lesson_meta"] = new_meta

        if "observation_outcome" in patch and entry.frontmatter.observation is not None:
            outcome = patch["observation_outcome"]
            assert outcome in ("pass", "fail", "pending")
            new_obs = entry.frontmatter.observation.model_copy(update={"outcome": outcome})
            fm_updates["observation"] = new_obs

        old_version = entry.frontmatter.version
        fm_updates["version"] = old_version + 1
        fm_updates["prev_version_ids"] = [
            f"{mem_id}#v{old_version}",
            *(entry.frontmatter.prev_version_ids or []),
        ]

        new_fm = entry.frontmatter.model_copy(update=fm_updates)
        # Re-validate via round-trip so cross-field constraints still fire.
        new_fm = MemoryFrontmatter.model_validate(new_fm.model_dump(exclude_none=True, mode="json"))

        # 归档旧版本到旁路（spec §9.2：版本对比需要旧 body 可达）
        self.store.archive_version(status, entry)

        body = patch["body"] if "body" in patch else entry.body
        new_entry = entry.model_copy(update={"frontmatter": new_fm, "body": body})
        self.store.write(new_entry, status=status)
        path = entry_path(self.store.data_root, status, type_, mem_id)
        self.index.upsert(new_entry, path=path, status=status)
        return {"id": mem_id, "version": new_fm.version, "status": "ok"}

    async def get_entry_version(self, params: dict) -> dict:
        """取回指定 entry 的某个旧版本快照（spec §9.2 / §10.1）。

        参数：{"id": "<mem_id>", "version": <int>}
        返回：{"id", "version", "body", "frontmatter"} 或 {"error"}
        """
        mem_id = params["id"]
        version = int(params["version"])
        loc = self.index.locate(mem_id)
        if not loc:
            return {"error": "not found"}
        status, type_, _ = loc
        try:
            entry = self.store.read_version(status, type_, mem_id, version)
        except FileNotFoundError:
            return {"error": "version not found"}
        return {
            "id": mem_id,
            "version": version,
            "body": entry.body,
            "frontmatter": entry.frontmatter.model_dump(exclude_none=True, mode="json"),
        }

    async def grep_memory(self, params: dict) -> dict:
        results = self.tools.grep_memory(
            pattern=params["pattern"],
            type_=params.get("type"),
            limit=int(params.get("limit", 20)),
        )
        return {"results": results}

    async def list_recent(self, params: dict) -> dict:
        results = self.tools.list_recent(
            window_days=int(params.get("window_days", 7)),
            type_=params.get("type"),
            limit=int(params.get("limit", 20)),
        )
        return {"results": results}

    async def find_by_entity(self, params: dict) -> dict:
        results = self.tools.find_by_entity_brief(params["entity_id"])
        return {"results": results}

    async def find_by_tag(self, params: dict) -> dict:
        results = self.tools.find_by_tag_brief(params["tag"])
        return {"results": results}

    async def get_cases_about(self, params: dict) -> dict:
        results = self.tools.get_cases_about(params["scenario"])
        return {"results": results}

    async def quick_capture(self, params: dict) -> dict:
        """Task 完成后 Agent 抽取的 case 候选写入 inbox（fire-and-forget 友好）。

        与 write_long_term 的区别：给反思场景常用的字段填默认值，让 Agent 一次调用
        只传 type/brief/content/tags 就能落盘。
        """
        defaults = {
            "source_trust": 3,
            "content_confidence": 3,
            "event_time": utc_now_iso_z(),
            "source_ref": {"type": "reflection"},
            "importance_factors": {
                "proximity": 0.5, "surprisal": 0.5,
                "entity_priority": 0.5, "unambiguity": 0.5,
            },
        }
        capture_params: dict = {**defaults, **params}
        capture_params["status"] = "inbox"
        capture_params["maturity"] = params.get("maturity")  # default_maturity_fresh 兜底
        return await self.write_long_term(capture_params)

    async def run_maintenance(self, params: dict) -> dict:
        scope = params.get("scope", "all")
        now_iso = params.get("now_iso") or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        cfg = MaintenanceConfig(
            now_iso=now_iso,
            stale_idle_days=int(params.get("stale_idle_days", 180)),
            trash_retention_days=int(params.get("trash_retention_days", 30)),
        )
        report = _run_maintenance(self.store, self.index, scope=scope, config=cfg)
        return {"report": report}

    async def trigger_consolidation(self, params: dict) -> dict:
        """兜底接口；正常路径由 Admin schedule 触发反思 skill。"""
        return {"status": "deferred_to_schedule", "mode": params.get("mode", "deep")}

    async def get_evolution_mode(self, params: dict) -> dict:
        return _get_mode(self.index)

    async def set_evolution_mode(self, params: dict) -> dict:
        return _set_mode(self.index, mode=params["mode"], reason=params.get("reason"))

    async def promote_to_rule(self, params: dict) -> dict:
        """Case→Rule 自动晋升 RPC（spec §6.4 / §10.1）。

        反思 SKILL 在凑齐 ≥3 条同 scenario case 后调本接口，把 LLM 抽象出的
        rule 文本直接写入 confirmed/lesson/，maturity=rule，进 7 天观察期。
        无人工 confirm 步骤（v2-ui spec §12.1 修订）。

        params:
          source_cases: list[str]      ≥3 条来源 case 的 id
          brief: str                   rule 召回标题
          content: str                 rule 完整正文（scenario / 适用条件 / 推荐做法 / 反例）
          scenario: str?               场景描述
          source_trust: int?           1-5，默认 4
          content_confidence: int?     1-5，默认 4
          observation_window_days: int?  默认 7

        returns: { id: str, status: "ok" }
        """
        rule_id = _synthesize_rule(
            store=self.store,
            index=self.index,
            source_cases=list(params["source_cases"]),
            brief=params["brief"],
            content=params["content"],
            scenario=params.get("scenario"),
            source_trust=int(params.get("source_trust", 4)),
            content_confidence=int(params.get("content_confidence", 4)),
            window_days=int(params.get("observation_window_days", 7)),
        )
        return {"id": rule_id, "status": "ok"}

    async def get_observation_pending(self, params: dict) -> dict:
        """Return all entries currently inside the observation window (UI 「观察期」 tab).

        Per spec §6.2 / v2-ui §6.2: 列出所有 observation.outcome = pending 的条目，
        含已过期未结算和未到期仍在观察的；按 started_at 倒序。

        UI 字段对齐：返回 {items: [...]}，每行带
        {id, type, brief, observation_started_at, observation_window_days,
         observation_outcome, observation_pass_count, observation_fail_count}。
        UI 也会读 promoted_at 作为兼容字段名（同义于 observation_started_at）。
        """
        rows = self.index.list_active_observation()
        items = [
            {
                "id": r["id"],
                "type": r["type"],
                "brief": r["brief"],
                "observation_started_at": r["observation_started_at"],
                # alias for UI that historically used `promoted_at`
                "promoted_at": r["observation_started_at"],
                "observation_window_days": int(r["observation_window_days"] or 7),
                "observation_outcome": r.get("observation_outcome") or "pending",
                # alias for UI that historically used `validation_outcome`
                "validation_outcome": r.get("observation_outcome") or "pending",
                "observation_pass_count": r.get("observation_pass_count", 0),
                "observation_fail_count": r.get("observation_fail_count", 0),
            }
            for r in rows
        ]
        return {"items": items}

    async def mark_observation_pass(self, params: dict) -> dict:
        mem_id = params["id"]
        row = self.index.get_row(mem_id)
        if row is None:
            raise ValueError(f"Entry not found: {mem_id}")
        entry = self.store.read(row["status"], row["type"], mem_id)
        if entry.frontmatter.observation is None:
            raise ValueError(f"Entry has no observation window: {mem_id}")
        new_obs = entry.frontmatter.observation.model_copy(update={"outcome": "pass"})
        new_fm = entry.frontmatter.model_copy(update={"observation": new_obs})
        new_entry = entry.model_copy(update={"frontmatter": new_fm})
        self.store.write(new_entry, status=row["status"])
        self.index.mark_observation_outcome(mem_id, "pass")
        return {"id": mem_id, "status": "ok"}

    async def extend_observation_window(self, params: dict) -> dict:
        mem_id = params["id"]
        days = int(params.get("days", 7))
        if days <= 0:
            raise ValueError("days must be positive")
        row = self.index.get_row(mem_id)
        if row is None:
            raise ValueError(f"Entry not found: {mem_id}")
        entry = self.store.read(row["status"], row["type"], mem_id)
        if entry.frontmatter.observation is None:
            raise ValueError(f"Entry has no observation window: {mem_id}")
        current = entry.frontmatter.observation.window_days or 0
        new_total = current + days
        new_obs = entry.frontmatter.observation.model_copy(
            update={"window_days": new_total}
        )
        new_fm = entry.frontmatter.model_copy(update={"observation": new_obs})
        new_entry = entry.model_copy(update={"frontmatter": new_fm})
        self.store.write(new_entry, status=row["status"])
        self.index.extend_observation_window(mem_id, days=days)
        return {"id": mem_id, "new_window_days": new_total}

    async def get_confirmed_snapshot(self, params: dict) -> dict:
        return build_confirmed_snapshot(self.store, self.index)

    async def bump_lesson_use(self, params: dict) -> dict:
        return await self.update_long_term({
            "id": params["id"],
            "patch": {
                "use_count_increment": 1,
                "validated_at": params.get("validated_at") or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
        })

    async def report_task_feedback(self, params: dict) -> dict:
        """Phase A (2026-04-25): Front Handler 在用户明确表态时调用。

        给该 task 期间召回引用过的 lesson 累加 observation_pass_count / observation_fail_count
        （按 attitude 强度加权 1 或 2）。

        求准策略 — 不确定时 Front Handler 不会调本接口。
        锚定 task_id 由 Front Handler 代码层根据工具语义自动绑定。

        Spec: 2026-04-25-self-learning-feedback-signal-design.md §8.4
        """
        task_id = params["task_id"]
        attitude = params["attitude"]

        if attitude not in ("strong_pass", "pass", "fail", "strong_fail"):
            raise ValueError(f"invalid attitude: {attitude}")

        weight = 2 if attitude.startswith("strong_") else 1
        is_pass = attitude.endswith("pass")
        column = "observation_pass_count" if is_pass else "observation_fail_count"

        lesson_ids = self.index.find_lessons_used_in_task(task_id)
        for lid in lesson_ids:
            self.index.bump_observation_counter(lid, column=column, delta=weight)

        return {
            "updated_count": len(lesson_ids),
            "lesson_ids": lesson_ids,
            "attitude": attitude,
            "weight": weight,
        }

    async def list_entries(self, params: dict) -> dict:
        """列出 entries（按 type/status/author/tags 过滤，分页）。

        author 过滤在 RPC 层做（frontmatter 没进 sqlite 索引）。
        """
        type_ = params.get("type")
        status = params.get("status")
        author = params.get("author")
        tags = params.get("tags") or []
        limit = int(params.get("limit", 100))
        offset = int(params.get("offset", 0))
        sort = params.get("sort", "ingestion_time_desc")

        rows = self.index.list_entries(
            type_=type_, status=status,
            tags=tags, limit=limit, offset=offset, sort=sort,
        )
        items: list[dict] = []
        for r in rows:
            try:
                entry = self.store.read(r["status"], r["type"], r["id"])
            except FileNotFoundError:
                continue
            if author and entry.frontmatter.author != author:
                continue
            items.append({
                "id": r["id"],
                "type": r["type"],
                "status": r["status"],
                "brief": entry.frontmatter.brief,
                "frontmatter": entry.frontmatter.model_dump(exclude_none=True, mode="json"),
            })
        return {"items": items, "total": len(items)}

    async def keyword_search(self, params: dict) -> dict:
        query = (params.get("query") or "").strip()
        if not query:
            return {"items": []}
        type_ = params.get("type")
        status = params.get("status", "confirmed")
        if status == "all":
            status = None
        limit = int(params.get("limit", 50))
        rows = self.index.keyword_search(query, type_=type_, status=status, limit=limit)
        return {"items": rows}

    async def restore_memory(self, params: dict) -> dict:
        """从 trash 恢复到 inbox。"""
        mem_id = params["id"]
        loc = self.index.locate(mem_id)
        if not loc:
            return {"error": "not found"}
        status = loc["status"] if hasattr(loc, "keys") else loc[0]
        type_ = loc["type"] if hasattr(loc, "keys") else loc[1]
        if status != "trash":
            return {"error": "not in trash"}
        self.store.restore_from_trash(type_, mem_id)
        new_path = entry_path(self.store.data_root, "inbox", type_, mem_id)
        entry = self.store.read("inbox", type_, mem_id)
        self.index.upsert(entry, path=new_path, status="inbox")
        return {"id": mem_id, "status": "ok"}

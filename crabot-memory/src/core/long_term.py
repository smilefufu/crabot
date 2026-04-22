"""
长期记忆核心逻辑（简化版）
"""
import asyncio
import json
import logging
from typing import Optional, List, Dict, Any
from datetime import datetime

from ..types import (
    BrowseLongTermParams,
    BrowseLongTermResult,
    EntityRef,
    LongTermMemoryEntry,
    LongTermL0Entry,
    LongTermL1Entry,
    MemorySource,
    UpdateMemoryParams,
    WriteLongTermParams,
    SearchLongTermParams,
    SearchLongTermResultItem,
)
from ..storage.vector_store import VectorStore
from ..utils.llm_client import LLMClient

logger = logging.getLogger(__name__)


class LongTermMemory:
    """长期记忆管理"""

    def __init__(
        self,
        vector_store: VectorStore,
        llm_client: LLMClient,
        sqlite_store=None,
        dedup_config=None,
    ):
        self.vector_store = vector_store
        self.llm_client = llm_client
        self.sqlite_store = sqlite_store
        self.dedup_config = dedup_config

    async def write(self, params: WriteLongTermParams) -> Dict[str, Any]:
        """写入长期记忆，含去重逻辑"""
        async def gen_summaries():
            try:
                return await self.llm_client.generate_l0_l1(params.content)
            except Exception as e:
                logger.warning("Failed to generate L0/L1: %s", e)
                return {"abstract": params.content[:200], "overview": params.content[:2000]}

        async def gen_keywords():
            try:
                return await self.llm_client.extract_keywords(params.content)
            except Exception as e:
                logger.warning("Failed to extract keywords: %s", e)
                return []

        summaries, keywords = await asyncio.gather(gen_summaries(), gen_keywords())
        abstract = summaries["abstract"]
        overview = summaries["overview"]

        try:
            vector = await self.vector_store.embedding_client.embed_single(abstract)
        except Exception as e:
            logger.error("Failed to generate embedding: %s", e)
            raise

        visibility = params.visibility or "public"
        dedup_action = await self._check_dedup(
            vector=vector,
            visibility=visibility,
            new_content=params.content,
            new_tags=params.tags or [],
        )

        if dedup_action is not None:
            action_type = dedup_action["action"]
            existing_row = dedup_action["row"]
            existing_id = existing_row["id"]

            if action_type == "SKIP":
                existing_entry = self._row_to_entry(existing_row)
                logger.info("Long-term memory dedup SKIP: %s", existing_id)
                return {
                    "action": "skipped",
                    "memory": existing_entry,
                    "merged_from": None,
                }

            if action_type == "UPDATE":
                update_params = UpdateMemoryParams(
                    memory_id=existing_id,
                    content=params.content,
                    importance=params.importance,
                    tags=params.tags,
                    revision_reason=f"dedup update: {dedup_action.get('reason', '')}",
                )
                result = await self.update(update_params)
                logger.info("Long-term memory dedup UPDATE: %s", existing_id)
                return {
                    "action": "updated",
                    "memory": result["memory"],
                    "merged_from": None,
                }

            if action_type == "MERGE":
                merged_content = await self.llm_client.merge_contents(
                    params.content, existing_row["content"]
                )
                update_params = UpdateMemoryParams(
                    memory_id=existing_id,
                    content=merged_content,
                    importance=params.importance,
                    tags=params.tags,
                    revision_reason=f"dedup merge: {dedup_action.get('reason', '')}",
                )
                result = await self.update(update_params)
                logger.info("Long-term memory dedup MERGE: %s", existing_id)
                return {
                    "action": "merged",
                    "memory": result["memory"],
                    "merged_from": [existing_id],
                }

        entry = LongTermMemoryEntry(
            abstract=abstract,
            overview=overview,
            content=params.content,
            entities=params.entities or [],
            importance=params.importance or 5,
            keywords=keywords,
            tags=params.tags or [],
            source=params.source,
            metadata=params.metadata,
            read_count=0,
            version=1,
            visibility=visibility,
            scopes=params.scopes or [],
        )

        await self.vector_store.add_long_term(entry, vector=vector)
        logger.info("Long-term memory written: %s", entry.id)

        return {
            "action": "created",
            "memory": entry,
            "merged_from": None,
        }

    async def _check_dedup(
        self,
        vector: List[float],
        visibility: str,
        new_content: str,
        new_tags: List[str],
    ) -> Optional[Dict[str, Any]]:
        """检查去重候选，返回 None 表示无候选（应 CREATE）"""
        if self.dedup_config is None:
            return None

        threshold = self.dedup_config.similarity_threshold
        max_candidates = self.dedup_config.max_candidates

        try:
            candidates = await self.vector_store.search_similar_long_term(
                vector=vector,
                visibility=visibility,
                limit=max_candidates,
            )
        except Exception as e:
            logger.warning("Dedup search failed, falling back to CREATE: %s", e)
            return None

        if not candidates:
            return None

        for row in candidates:
            distance = row.get("_distance", float("inf"))
            similarity = 1.0 / (1.0 + distance)
            if similarity < threshold:
                continue

            row_tags = list(row.get("tags") or [])
            if new_tags and row_tags:
                overlap = set(new_tags) & set(row_tags)
                if not overlap:
                    continue

            try:
                judgment = await self.llm_client.judge_dedup(
                    new_content=new_content,
                    existing_content=row["content"],
                )
            except Exception as e:
                logger.warning("Dedup judge failed: %s", e)
                continue

            action = judgment.get("action", "CREATE").upper()
            if action in ("SKIP", "UPDATE", "MERGE"):
                return {
                    "action": action,
                    "row": row,
                    "reason": judgment.get("reason", ""),
                }

        return None

    @staticmethod
    def _row_to_entry(row: Dict[str, Any]) -> LongTermMemoryEntry:
        """从 LanceDB 行数据重建 LongTermMemoryEntry"""
        entities_data = json.loads(row["entities_json"]) if row.get("entities_json") else []
        source_data = json.loads(row["source_json"])
        metadata_data = json.loads(row["metadata_json"]) if row.get("metadata_json") else None

        return LongTermMemoryEntry(
            id=row["id"],
            abstract=row["abstract"],
            overview=row["overview"],
            content=row["content"],
            entities=[EntityRef(**e) for e in entities_data],
            importance=row["importance"],
            keywords=list(row.get("keywords") or []),
            tags=list(row.get("tags") or []),
            source=MemorySource(**source_data),
            metadata=metadata_data,
            read_count=row["read_count"],
            version=row["version"],
            visibility=row["visibility"],
            scopes=list(row.get("scopes") or []),
            created_at=row.get("created_at"),
            updated_at=row.get("updated_at"),
        )

    @staticmethod
    def _row_to_search_result(row: Dict[str, Any], detail: str) -> SearchLongTermResultItem:
        if detail == "L0":
            memory = LongTermL0Entry(
                id=row["id"],
                abstract=row["abstract"],
                importance=row["importance"],
                tags=list(row.get("tags") or []),
                visibility=row["visibility"],
                created_at=row["created_at"],
            )
        elif detail == "L1":
            source_data = json.loads(row["source_json"])
            entities_data = json.loads(row["entities_json"]) if row.get("entities_json") else []
            memory = LongTermL1Entry(
                id=row["id"],
                abstract=row["abstract"],
                importance=row["importance"],
                tags=list(row.get("tags") or []),
                visibility=row["visibility"],
                created_at=row["created_at"],
                overview=row["overview"],
                entities=[EntityRef(**e) for e in entities_data],
                keywords=list(row.get("keywords") or []),
                source=MemorySource(**source_data),
                scopes=list(row.get("scopes") or []),
            )
        else:
            entities_data = json.loads(row["entities_json"]) if row.get("entities_json") else []
            source_data = json.loads(row["source_json"])
            metadata_data = json.loads(row["metadata_json"]) if row.get("metadata_json") else None
            memory = LongTermMemoryEntry(
                id=row["id"],
                abstract=row["abstract"],
                overview=row["overview"],
                content=row["content"],
                entities=[EntityRef(**e) for e in entities_data],
                importance=row["importance"],
                keywords=list(row.get("keywords") or []),
                tags=list(row.get("tags") or []),
                source=MemorySource(**source_data),
                metadata=metadata_data,
                read_count=row["read_count"],
                version=row["version"],
                visibility=row["visibility"],
                scopes=list(row.get("scopes") or []),
                created_at=row.get("created_at"),
                updated_at=row.get("updated_at"),
            )

        relevance = 0.9
        return SearchLongTermResultItem(memory=memory, relevance=relevance)

    async def search(self, params: SearchLongTermParams) -> List[SearchLongTermResultItem]:
        """检索长期记忆"""
        f = params.filter
        rows = await self.vector_store.search_long_term(
            query=params.query,
            limit=params.limit,
            min_visibility=params.min_visibility or "public",
            entity_id=f.entity_id if f else None,
            entity_type=f.entity_type if f else None,
            tags=f.tags if f else None,
            importance_min=f.importance_min if f else None,
            accessible_scopes=params.accessible_scopes,
        )
        return [self._row_to_search_result(row, params.detail) for row in rows]

    async def browse_recent(self, params: BrowseLongTermParams) -> BrowseLongTermResult:
        """按时间倒序浏览长期记忆"""
        f = params.filter
        rows = await self.vector_store.browse_long_term(
            limit=params.limit,
            min_visibility=params.min_visibility or "public",
            entity_id=f.entity_id if f else None,
            entity_type=f.entity_type if f else None,
            tags=f.tags if f else None,
            importance_min=f.importance_min if f else None,
            accessible_scopes=params.accessible_scopes,
        )
        return BrowseLongTermResult(
            results=[self._row_to_search_result(row, params.detail) for row in rows]
        )

    async def update(self, params) -> Dict[str, Any]:
        """更新长期记忆"""
        result = await self.vector_store.get_by_id(params.memory_id)
        if result is None:
            raise ValueError(f"Memory not found: {params.memory_id}")
        if result["type"] != "long":
            raise ValueError(f"Not a long-term memory: {params.memory_id}")

        row = result["row"]
        old_content = row["content"]
        old_version = row["version"]

        if self.sqlite_store:
            self.sqlite_store.add_revision(params.memory_id, old_version, old_content, params.revision_reason)

        new_content = params.content if params.content is not None else old_content
        new_entities = params.entities if params.entities is not None else [EntityRef(**e) for e in json.loads(row["entities_json"])]
        new_importance = params.importance if params.importance is not None else row["importance"]
        new_tags = params.tags if params.tags is not None else list(row.get("tags") or [])

        vector = None
        if params.content is not None and params.content != old_content:
            summaries = await self.llm_client.generate_l0_l1(new_content)
            abstract = summaries["abstract"]
            overview = summaries["overview"]
            vector = await self.vector_store.embedding_client.embed_single(abstract)
        else:
            abstract = row["abstract"]
            overview = row["overview"]

        source_data = json.loads(row["source_json"])
        metadata_data = json.loads(row["metadata_json"]) if row["metadata_json"] else None

        entry = LongTermMemoryEntry(
            id=params.memory_id,
            abstract=abstract,
            overview=overview,
            content=new_content,
            entities=new_entities,
            importance=new_importance,
            keywords=list(row.get("keywords") or []),
            tags=new_tags,
            source=MemorySource(**source_data),
            metadata=metadata_data,
            read_count=row["read_count"],
            version=old_version + 1,
            visibility=row["visibility"],
            scopes=list(row.get("scopes") or []),
            created_at=row["created_at"],
        )

        await self.vector_store.update_long_term(params.memory_id, entry, vector=vector)
        logger.info("Long-term memory updated: %s v%d", entry.id, entry.version)

        return {
            "memory": entry,
            "version": entry.version,
        }

    async def get_stats(self) -> dict:
        """获取长期记忆统计"""
        count = self.vector_store.get_long_term_count()
        return {
            "entry_count": count,
            "total_tokens": count * 500,
            "latest_entry_at": None,
            "earliest_entry_at": None,
        }

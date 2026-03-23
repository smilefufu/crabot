"""
长期记忆核心逻辑（简化版）
"""
import logging
from typing import Optional, List, Dict, Any
from datetime import datetime

from ..types import (
    LongTermMemoryEntry,
    LongTermL0Entry,
    LongTermL1Entry,
    WriteLongTermParams,
    SearchLongTermParams,
    SearchLongTermResultItem,
    EntityRef,
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
    ):
        self.vector_store = vector_store
        self.llm_client = llm_client

    async def write(self, params: WriteLongTermParams) -> Dict[str, Any]:
        """写入长期记忆，含去重逻辑"""
        # 简化实现：暂不做去重，直接创建
        # TODO: 实现完整的去重/合并逻辑

        # 生成 L0 和 L1
        try:
            summaries = await self.llm_client.generate_l0_l1(params.content)
            abstract = summaries["abstract"]
            overview = summaries["overview"]
        except Exception as e:
            logger.warning("Failed to generate L0/L1: %s", e)
            abstract = params.content[:200]
            overview = params.content[:2000]

        # 提取关键词
        try:
            keywords = await self.llm_client.extract_keywords(params.content)
        except Exception as e:
            logger.warning("Failed to extract keywords: %s", e)
            keywords = []

        # 创建条目
        entry = LongTermMemoryEntry(
            category=params.category,
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
            visibility=params.visibility or "public",
            scopes=params.scopes or [],
        )

        # 存储
        await self.vector_store.add_long_term(entry)
        logger.info("Long-term memory written: %s", entry.id)

        return {
            "action": "created",
            "memory": entry,
            "merged_from": None,
        }

    async def search(self, params: SearchLongTermParams) -> List[SearchLongTermResultItem]:
        """检索长期记忆"""
        import json
        f = params.filter
        rows = await self.vector_store.search_long_term(
            query=params.query,
            limit=params.limit,
            category=f.category if f else None,
            min_visibility=params.min_visibility or "public",
            entity_id=f.entity_id if f else None,
            entity_type=f.entity_type if f else None,
            tags=f.tags if f else None,
            importance_min=f.importance_min if f else None,
        )

        results = []
        for row in rows:
            # 根据 detail 级别构造返回对象
            if params.detail == "L0":
                memory = LongTermL0Entry(
                    id=row["id"],
                    abstract=row["abstract"],
                    importance=row["importance"],
                    tags=list(row["tags"] or []),
                    category=row["category"],
                    visibility=row["visibility"],
                    created_at=row["created_at"],
                )
            elif params.detail == "L1":
                from ..types import MemorySource
                source_data = json.loads(row["source_json"])
                entities_data = json.loads(row["entities_json"])
                memory = LongTermL1Entry(
                    id=row["id"],
                    abstract=row["abstract"],
                    importance=row["importance"],
                    tags=list(row["tags"] or []),
                    category=row["category"],
                    visibility=row["visibility"],
                    created_at=row["created_at"],
                    overview=row["overview"],
                    entities=[EntityRef(**e) for e in entities_data],
                    keywords=list(row["keywords"] or []),
                    source=MemorySource(**source_data),
                    scopes=list(row["scopes"] or []),
                )
            else:  # L2
                from ..types import MemorySource
                source_data = json.loads(row["source_json"])
                entities_data = json.loads(row["entities_json"])
                metadata_data = json.loads(row["metadata_json"]) if row["metadata_json"] else None
                memory = LongTermMemoryEntry(
                    id=row["id"],
                    category=row["category"],
                    abstract=row["abstract"],
                    overview=row["overview"],
                    content=row["content"],
                    entities=[EntityRef(**e) for e in entities_data],
                    importance=row["importance"],
                    keywords=list(row["keywords"] or []),
                    tags=list(row["tags"] or []),
                    source=MemorySource(**source_data),
                    metadata=metadata_data,
                    read_count=row["read_count"],
                    version=row["version"],
                    visibility=row["visibility"],
                    scopes=list(row["scopes"] or []),
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                )

            # 计算相关性（简化：使用距离的倒数）
            relevance = 0.9  # 简化实现
            results.append(SearchLongTermResultItem(memory=memory, relevance=relevance))

        return results

    async def get_stats(self) -> dict:
        """获取长期记忆统计"""
        count = self.vector_store.get_long_term_count()
        # TODO: 实现更详细的统计
        return {
            "entry_count": count,
            "by_category": {},
            "total_tokens": count * 500,  # 粗略估算
            "latest_entry_at": None,
            "earliest_entry_at": None,
        }

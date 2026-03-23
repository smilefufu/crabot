"""
短期记忆核心逻辑
"""
import logging
from typing import Optional, List
from datetime import datetime

from ..types import (
    ShortTermMemoryEntry,
    WriteShortTermParams,
    SearchShortTermParams,
)
from ..storage.vector_store import VectorStore
from ..utils.llm_client import LLMClient

logger = logging.getLogger(__name__)


class ShortTermMemory:
    """短期记忆管理"""

    def __init__(
        self,
        vector_store: VectorStore,
        llm_client: LLMClient,
    ):
        self.vector_store = vector_store
        self.llm_client = llm_client

    async def write(self, params: WriteShortTermParams) -> ShortTermMemoryEntry:
        """写入短期记忆"""
        # 自动提取关键词（如果未提供）
        keywords = params.keywords
        if not keywords:
            try:
                keywords = await self.llm_client.extract_keywords(params.content)
            except Exception as e:
                logger.warning("Failed to extract keywords: %s", e)
                keywords = []

        # 使用当前时间作为 event_time（如果未提供）
        event_time = params.event_time or datetime.utcnow().isoformat() + "Z"

        # 创建条目
        entry = ShortTermMemoryEntry(
            content=params.content,
            keywords=keywords,
            event_time=event_time,
            persons=params.persons or [],
            entities=params.entities or [],
            topic=params.topic,
            source=params.source,
            refs=params.refs,
            compressed=False,
            visibility=params.visibility or "public",
            scopes=params.scopes or [],
        )

        # 存储
        await self.vector_store.add_short_term(entry)
        logger.info("Short-term memory written: %s", entry.id)
        return entry

    async def search(self, params: SearchShortTermParams) -> List[ShortTermMemoryEntry]:
        """检索短期记忆"""
        f = params.filter
        results = await self.vector_store.search_short_term(
            query=params.query,
            limit=params.limit,
            min_visibility=params.min_visibility or "public",
            accessible_scopes=params.accessible_scopes,
            filter_refs=f.refs if f else None,
            filter_persons=f.persons if f else None,
            filter_entities=f.entities if f else None,
            filter_topic=f.topic if f else None,
            sort_by=params.sort_by,
        )
        return results

    async def get_stats(self) -> dict:
        """获取短期记忆统计"""
        count = self.vector_store.get_short_term_count()
        # TODO: 实现更详细的统计（压缩数、token 数、时间范围等）
        return {
            "entry_count": count,
            "compressed_count": 0,
            "total_tokens": count * 100,  # 粗略估算
            "latest_entry_at": None,
            "earliest_entry_at": None,
        }

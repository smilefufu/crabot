"""
短期记忆核心逻辑
"""
import logging
from typing import Optional, List, Dict, Any
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
            time_range=params.time_range.model_dump() if params.time_range else None,
            filter_persons=f.persons if f else None,
            filter_entities=f.entities if f else None,
            filter_topic=f.topic if f else None,
            sort_by=params.sort_by,
        )
        return results

    async def compress(self, config) -> Dict[str, Any]:
        """执行短期记忆压缩"""
        from datetime import datetime, timedelta

        cutoff = (datetime.utcnow() - timedelta(days=config.retention_window_days)).isoformat() + "Z"
        window_size = config.window_size
        compressed_count = 0

        for vis in ["private", "internal", "public"]:
            old_entries = await self.vector_store.query_old_short_term(
                before_time=cutoff, visibility=vis, compressed=False, limit=500,
            )
            if not old_entries:
                continue

            for i in range(0, len(old_entries), window_size):
                batch = old_entries[i:i + window_size]
                batch_data = [
                    {"content": r["content"], "event_time": r["event_time"],
                     "persons": list(r.get("persons") or []),
                     "entities": list(r.get("entities") or []),
                     "topic": r.get("topic", "")}
                    for r in batch
                ]

                compressed_facts = await self.llm_client.compress_short_term(batch_data)

                all_scopes: set = set()
                for r in batch:
                    all_scopes.update(r.get("scopes") or [])

                old_ids = [r["id"] for r in batch]
                await self.vector_store.delete_by_ids("short", old_ids)

                for fact in compressed_facts:
                    from ..types import ShortTermMemoryEntry, MemorySource
                    entry = ShortTermMemoryEntry(
                        content=fact,
                        event_time=batch[0]["event_time"],
                        source=MemorySource(type="system"),
                        compressed=True,
                        visibility=vis,
                        scopes=list(all_scopes),
                    )
                    await self.vector_store.add_short_term(entry)
                    compressed_count += 1

        return {"compressed_count": compressed_count}

    async def rotate(self, config) -> Dict[str, Any]:
        """删除超过最大保留天数的短期记忆"""
        from datetime import datetime, timedelta

        cutoff = (datetime.utcnow() - timedelta(days=config.max_retention_days)).isoformat() + "Z"
        await self.vector_store.rotate_short_term(cutoff)
        return {"rotated_before": cutoff}

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

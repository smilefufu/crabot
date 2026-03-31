"""
向量存储 - 基于 LanceDB
提取并简化自 SimpleMem vector_store.py
"""
import logging
from typing import List, Optional, Dict, Any
from pathlib import Path

import lancedb
import pyarrow as pa

from ..types import ShortTermMemoryEntry, LongTermMemoryEntry, Visibility
from ..utils.embedding import EmbeddingClient

logger = logging.getLogger(__name__)


class VectorStore:
    """向量存储，支持短期和长期记忆"""

    def __init__(
        self,
        db_path: str,
        embedding_client: EmbeddingClient,
    ):
        self.db_path = db_path
        self.embedding_client = embedding_client
        Path(db_path).mkdir(parents=True, exist_ok=True)
        self.db = lancedb.connect(db_path)
        self.short_term_table = None
        self.long_term_table = None
        self._init_tables()

    def _init_tables(self):
        """初始化表结构"""
        # 短期记忆表
        short_schema = pa.schema([
            pa.field("id", pa.string()),
            pa.field("content", pa.string()),
            pa.field("keywords", pa.list_(pa.string())),
            pa.field("event_time", pa.string()),
            pa.field("persons", pa.list_(pa.string())),
            pa.field("entities", pa.list_(pa.string())),
            pa.field("topic", pa.string()),
            pa.field("source_type", pa.string()),
            pa.field("source_json", pa.string()),
            pa.field("refs_json", pa.string()),
            pa.field("compressed", pa.bool_()),
            pa.field("visibility", pa.string()),
            pa.field("scopes", pa.list_(pa.string())),
            pa.field("created_at", pa.string()),
            pa.field("vector", pa.list_(pa.float32(), self.embedding_client.dimension)),
        ])

        if "short_term_memory" not in self.db.table_names():
            self.short_term_table = self.db.create_table("short_term_memory", schema=short_schema)
        else:
            self.short_term_table = self.db.open_table("short_term_memory")

        # 长期记忆表
        long_schema = pa.schema([
            pa.field("id", pa.string()),
            pa.field("abstract", pa.string()),
            pa.field("overview", pa.string()),
            pa.field("content", pa.string()),
            pa.field("entities_json", pa.string()),
            pa.field("importance", pa.int32()),
            pa.field("keywords", pa.list_(pa.string())),
            pa.field("tags", pa.list_(pa.string())),
            pa.field("source_json", pa.string()),
            pa.field("metadata_json", pa.string()),
            pa.field("read_count", pa.int32()),
            pa.field("version", pa.int32()),
            pa.field("visibility", pa.string()),
            pa.field("scopes", pa.list_(pa.string())),
            pa.field("created_at", pa.string()),
            pa.field("updated_at", pa.string()),
            pa.field("vector", pa.list_(pa.float32(), self.embedding_client.dimension)),
        ])

        if "long_term_memory" not in self.db.table_names():
            self.long_term_table = self.db.create_table("long_term_memory", schema=long_schema)
        else:
            self.long_term_table = self.db.open_table("long_term_memory")

    async def add_short_term(self, entry: ShortTermMemoryEntry):
        """添加短期记忆"""
        import json
        vector = await self.embedding_client.embed_single(entry.content)
        data = {
            "id": entry.id,
            "content": entry.content,
            "keywords": entry.keywords,
            "event_time": entry.event_time,
            "persons": entry.persons,
            "entities": entry.entities,
            "topic": entry.topic or "",
            "source_type": entry.source.type,
            "source_json": entry.source.model_dump_json(),
            "refs_json": json.dumps(entry.refs or {}),
            "compressed": entry.compressed,
            "visibility": entry.visibility,
            "scopes": entry.scopes,
            "created_at": entry.created_at,
            "vector": vector,
        }
        self.short_term_table.add([data])

    async def search_short_term(
        self,
        query: Optional[str] = None,
        limit: int = 20,
        min_visibility: Visibility = "public",
        accessible_scopes: Optional[List[str]] = None,
        filter_refs: Optional[Dict[str, str]] = None,
        time_range: Optional[Dict[str, Optional[str]]] = None,
        filter_persons: Optional[List[str]] = None,
        filter_entities: Optional[List[str]] = None,
        filter_topic: Optional[str] = None,
        sort_by: str = "event_time",
    ) -> List[ShortTermMemoryEntry]:
        """检索短期记忆"""
        import json
        from ..types import MemorySource

        if self.short_term_table.count_rows() == 0:
            return []

        # 构建权限过滤条件
        filters = []
        vis_order = {"private": 3, "internal": 2, "public": 1}
        min_level = vis_order.get(min_visibility, 1)
        if min_level >= 2:
            filters.append("visibility IN ('private', 'internal')")
        elif min_level >= 1:
            filters.append("visibility IN ('private', 'internal', 'public')")

        # 添加 refs 过滤（通过 JSON 字段匹配）
        if filter_refs:
            for key, value in filter_refs.items():
                # LanceDB 不支持直接 JSON 查询，需要全表扫描后过滤
                # 暂时标记需要后处理
                pass

        if accessible_scopes:
            # 简化：仅检查 scopes 非空且有交集
            pass  # LanceDB 的 array 过滤较复杂，暂时跳过

        where_clause = " AND ".join(filters) if filters else None

        if query:
            vector = await self.embedding_client.embed_single(query)
            results = self.short_term_table.search(vector).limit(limit * 2)  # 多取一些用于后过滤
            if where_clause:
                results = results.where(where_clause, prefilter=True)
            rows = results.to_list()
        else:
            # 无查询，按时间排序返回
            query_builder = self.short_term_table.search()
            if where_clause:
                query_builder = query_builder.where(where_clause, prefilter=True)
            rows = query_builder.limit(limit * 2).to_list()

        entries = []
        for row in rows:
            try:
                source_data = json.loads(row["source_json"])
                refs_data = json.loads(row["refs_json"]) if row["refs_json"] else None

                # 后过滤：refs 匹配
                if filter_refs and refs_data:
                    match = all(refs_data.get(k) == v for k, v in filter_refs.items())
                    if not match:
                        continue

                # 后过滤：persons 匹配
                if filter_persons:
                    if not any(p in (row["persons"] or []) for p in filter_persons):
                        continue

                # 后过滤：entities 匹配
                if filter_entities:
                    if not any(e in (row["entities"] or []) for e in filter_entities):
                        continue

                # 后过滤：topic 匹配
                if filter_topic and row["topic"] != filter_topic:
                    continue

                entry = ShortTermMemoryEntry(
                    id=row["id"],
                    content=row["content"],
                    keywords=list(row["keywords"] or []),
                    event_time=row["event_time"],
                    persons=list(row["persons"] or []),
                    entities=list(row["entities"] or []),
                    topic=row["topic"] or None,
                    source=MemorySource(**source_data),
                    refs=refs_data,
                    compressed=row["compressed"],
                    visibility=row["visibility"],
                    scopes=list(row["scopes"] or []),
                    created_at=row["created_at"],
                )
                entries.append(entry)

                if len(entries) >= limit:
                    break
            except Exception as e:
                logger.warning("Failed to parse short term entry: %s", e)

        # 排序
        if sort_by == "event_time":
            entries.sort(key=lambda e: e.event_time, reverse=True)

        return entries[:limit]

    async def add_long_term(self, entry: LongTermMemoryEntry):
        """添加长期记忆"""
        import json
        vector = await self.embedding_client.embed_single(entry.content)
        data = {
            "id": entry.id,
            "abstract": entry.abstract,
            "overview": entry.overview,
            "content": entry.content,
            "entities_json": json.dumps([e.model_dump() for e in entry.entities]),
            "importance": entry.importance,
            "keywords": entry.keywords,
            "tags": entry.tags,
            "source_json": entry.source.model_dump_json(),
            "metadata_json": json.dumps(entry.metadata or {}),
            "read_count": entry.read_count,
            "version": entry.version,
            "visibility": entry.visibility,
            "scopes": entry.scopes,
            "created_at": entry.created_at,
            "updated_at": entry.updated_at,
            "vector": vector,
        }
        self.long_term_table.add([data])

    async def search_long_term(
        self,
        query: str,
        limit: int = 10,
        min_visibility: Visibility = "public",
        entity_id: Optional[str] = None,
        entity_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
        importance_min: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """检索长期记忆，返回原始行数据"""
        if self.long_term_table.count_rows() == 0:
            return []

        vector = await self.embedding_client.embed_single(query)
        results = self.long_term_table.search(vector).limit(limit * 2)  # 多取用于后过滤

        # 添加可索引的过滤条件
        filters = []
        vis_order = {"private": 3, "internal": 2, "public": 1}
        min_level = vis_order.get(min_visibility, 1)
        if min_level >= 2:
            filters.append("visibility IN ('private', 'internal')")
        elif min_level >= 1:
            filters.append("visibility IN ('private', 'internal', 'public')")

        if filters:
            where_clause = " AND ".join(filters)
            results = results.where(where_clause, prefilter=True)

        rows = results.to_list()

        # 后过滤：importance 和 entity_id（需要解析 JSON）
        if importance_min is not None or entity_id is not None or entity_type is not None or tags is not None:
            import json
            filtered_rows = []
            for row in rows:
                if importance_min is not None and row.get("importance", 0) < importance_min:
                    continue
                if tags:
                    row_tags = list(row.get("tags") or [])
                    if not any(t in row_tags for t in tags):
                        continue
                if entity_id is not None or entity_type is not None:
                    entities_json = row.get("entities_json", "[]")
                    try:
                        entities = json.loads(entities_json)
                    except Exception:
                        entities = []
                    match = False
                    for e in entities:
                        if entity_id and e.get("id") == entity_id:
                            match = True
                            break
                        if entity_type and e.get("type") == entity_type:
                            match = True
                            break
                    if not match and (entity_id or entity_type):
                        continue
                filtered_rows.append(row)
            rows = filtered_rows

        return rows[:limit]

    async def get_by_id(self, memory_id: str) -> Optional[Dict[str, Any]]:
        """根据 ID 获取记忆（先查短期，再查长期）"""
        if self.short_term_table.count_rows() > 0:
            results = (
                self.short_term_table.search()
                .where(f"id = '{memory_id}'", prefilter=True)
                .limit(1)
                .to_list()
            )
            if results:
                return {"type": "short", "row": results[0]}

        if self.long_term_table.count_rows() > 0:
            results = (
                self.long_term_table.search()
                .where(f"id = '{memory_id}'", prefilter=True)
                .limit(1)
                .to_list()
            )
            if results:
                return {"type": "long", "row": results[0]}

        return None

    async def delete_by_id(self, memory_id: str) -> bool:
        """根据 ID 删除记忆"""
        if self.short_term_table.count_rows() > 0:
            results = (
                self.short_term_table.search()
                .where(f"id = '{memory_id}'", prefilter=True)
                .limit(1)
                .to_list()
            )
            if results:
                self.short_term_table.delete(f"id = '{memory_id}'")
                return True

        if self.long_term_table.count_rows() > 0:
            results = (
                self.long_term_table.search()
                .where(f"id = '{memory_id}'", prefilter=True)
                .limit(1)
                .to_list()
            )
            if results:
                self.long_term_table.delete(f"id = '{memory_id}'")
                return True

        return False

    def get_short_term_count(self) -> int:
        """获取短期记忆数量"""
        return self.short_term_table.count_rows()

    def get_long_term_count(self) -> int:
        """获取长期记忆数量"""
        return self.long_term_table.count_rows()

    def close(self):
        """关闭连接"""
        pass  # LanceDB 无需显式关闭

"""
向量存储 - 基于 LanceDB
提取并简化自 SimpleMem vector_store.py
"""
import asyncio
import json
import logging
from typing import List, Optional, Dict, Any
from pathlib import Path

import lancedb
import pyarrow as pa

from ..types import ShortTermMemoryEntry, LongTermMemoryEntry, MemorySource, Visibility
from ..utils.embedding import EmbeddingClient

logger = logging.getLogger(__name__)


def _run_sync(fn):
    """将同步函数包装到 executor 中运行，避免阻塞事件循环"""
    return asyncio.get_running_loop().run_in_executor(None, fn)


def _build_visibility_filter(min_visibility: Visibility) -> Optional[str]:
    """构建 visibility WHERE 子句"""
    vis_order = {"private": 3, "internal": 2, "public": 1}
    min_level = vis_order.get(min_visibility, 1)
    if min_level >= 2:
        return "visibility IN ('private', 'internal')"
    elif min_level >= 1:
        return "visibility IN ('private', 'internal', 'public')"
    return None


def _build_scopes_filter(accessible_scopes: Optional[List[str]]) -> Optional[str]:
    """构建 scopes WHERE 子句"""
    if not accessible_scopes:
        return None
    scope_conditions = [f"array_has(scopes, '{s}')" for s in accessible_scopes]
    return f"({' OR '.join(scope_conditions)})"


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
        self._tables_initialized = False

    async def ensure_tables(self):
        """确保表已初始化（需要在维度已知后调用）"""
        if self._tables_initialized:
            return
        if self.embedding_client.dimension is None:
            await self.embedding_client.probe_dimension()
        self._init_tables()
        self._tables_initialized = True

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

        self.short_term_table = self._open_or_create("short_term_memory", short_schema)

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

        self.long_term_table = self._open_or_create("long_term_memory", long_schema)

    def _open_or_create(self, table_name: str, schema: pa.Schema):
        """打开已有表或创建新表，维度不匹配时自动重建"""
        if table_name not in self.db.table_names():
            return self.db.create_table(table_name, schema=schema)

        table = self.db.open_table(table_name)
        existing_dim = self._get_vector_dim(table.schema)
        expected_dim = self.embedding_client.dimension
        if existing_dim is not None and existing_dim != expected_dim:
            row_count = table.count_rows()
            if row_count == 0:
                logger.warning(
                    "Table '%s' vector dimension mismatch (existing=%d, expected=%d), "
                    "recreating empty table", table_name, existing_dim, expected_dim,
                )
                self.db.drop_table(table_name)
                return self.db.create_table(table_name, schema=schema)
            else:
                logger.error(
                    "Table '%s' vector dimension mismatch (existing=%d, expected=%d) "
                    "with %d rows. Cannot auto-migrate. Please re-embed or reset the table.",
                    table_name, existing_dim, expected_dim, row_count,
                )
        return table

    @staticmethod
    def _get_vector_dim(schema: pa.Schema) -> Optional[int]:
        """从 schema 中提取 vector 字段的固定维度"""
        idx = schema.get_field_index("vector")
        if idx < 0:
            return None
        field_type = schema.field(idx).type
        if isinstance(field_type, pa.FixedSizeListType):
            return field_type.list_size
        return None

    async def add_short_term(self, entry: ShortTermMemoryEntry, vector: Optional[List[float]] = None):
        """添加短期记忆。可传入预计算的 vector 跳过 embedding 调用"""
        await self.ensure_tables()
        if vector is None:
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
        await _run_sync(lambda: self.short_term_table.add([data]))

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
        await self.ensure_tables()

        filters = []
        vis_filter = _build_visibility_filter(min_visibility)
        if vis_filter:
            filters.append(vis_filter)
        scopes_filter = _build_scopes_filter(accessible_scopes)
        if scopes_filter:
            filters.append(scopes_filter)

        # 时间范围过滤
        if time_range:
            if time_range.get("start"):
                filters.append(f"event_time >= '{time_range['start']}'")
            if time_range.get("end"):
                filters.append(f"event_time <= '{time_range['end']}'")

        where_clause = " AND ".join(filters) if filters else None

        if query:
            vector = await self.embedding_client.embed_single(query)
            def _do_search():
                r = self.short_term_table.search(vector).limit(limit * 2)
                if where_clause:
                    r = r.where(where_clause, prefilter=True)
                return r.to_list()
            rows = await _run_sync(_do_search)
        else:
            def _do_scan():
                r = self.short_term_table.search()
                if where_clause:
                    r = r.where(where_clause, prefilter=True)
                return r.limit(limit * 2).to_list()
            rows = await _run_sync(_do_scan)

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

    async def add_long_term(self, entry: LongTermMemoryEntry, vector: Optional[List[float]] = None):
        """添加长期记忆。可传入预计算的 vector 跳过 embedding 调用"""
        await self.ensure_tables()
        if vector is None:
            vector = await self.embedding_client.embed_single(entry.abstract)
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
        await _run_sync(lambda: self.long_term_table.add([data]))

    async def search_similar_long_term(
        self,
        vector: List[float],
        visibility: str,
        limit: int = 3,
    ) -> List[Dict[str, Any]]:
        """按向量相似度搜索同 visibility 的长期记忆，返回含 _distance 的行"""
        await self.ensure_tables()
        where = f"visibility = '{visibility}'"

        def _do_search():
            return (
                self.long_term_table.search(vector)
                .where(where, prefilter=True)
                .limit(limit)
                .to_list()
            )

        return await _run_sync(_do_search)

    async def search_long_term(
        self,
        query: str,
        limit: int = 10,
        min_visibility: Visibility = "public",
        entity_id: Optional[str] = None,
        entity_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
        importance_min: Optional[int] = None,
        accessible_scopes: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """检索长期记忆，返回原始行数据"""
        await self.ensure_tables()

        vector = await self.embedding_client.embed_single(query)

        filters = []
        vis_filter = _build_visibility_filter(min_visibility)
        if vis_filter:
            filters.append(vis_filter)
        if importance_min is not None:
            filters.append(f"importance >= {importance_min}")
        scopes_filter = _build_scopes_filter(accessible_scopes)
        if scopes_filter:
            filters.append(scopes_filter)

        where_clause = " AND ".join(filters) if filters else None

        def _do_search():
            r = self.long_term_table.search(vector).limit(limit * 2)
            if where_clause:
                r = r.where(where_clause, prefilter=True)
            return r.to_list()

        rows = await _run_sync(_do_search)

        # 后过滤：entity_id/entity_type/tags（需要解析 JSON，无法前置）
        if entity_id is not None or entity_type is not None or tags is not None:
            filtered_rows = []
            for row in rows:
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
        await self.ensure_tables()

        def _find_short():
            return (
                self.short_term_table.search()
                .where(f"id = '{memory_id}'", prefilter=True)
                .limit(1)
                .to_list()
            )

        results = await _run_sync(_find_short)
        if results:
            return {"type": "short", "row": results[0]}

        def _find_long():
            return (
                self.long_term_table.search()
                .where(f"id = '{memory_id}'", prefilter=True)
                .limit(1)
                .to_list()
            )

        results = await _run_sync(_find_long)
        if results:
            return {"type": "long", "row": results[0]}

        return None

    async def update_long_term(self, memory_id: str, entry: LongTermMemoryEntry, vector: Optional[List[float]] = None):
        """更新长期记忆：删除旧行，插入新行（LanceDB 不支持原地 update）"""
        await self.ensure_tables()
        if vector is None:
            # 保留旧 vector
            old = await self.get_by_id(memory_id)
            if old and old["type"] == "long":
                vector = old["row"].get("vector")
        await _run_sync(lambda: self.long_term_table.delete(f"id = '{memory_id}'"))
        await self.add_long_term(entry, vector=vector)

    async def delete_by_id(self, memory_id: str) -> bool:
        """根据 ID 删除记忆"""
        await self.ensure_tables()

        def _try_delete_short():
            results = (
                self.short_term_table.search()
                .where(f"id = '{memory_id}'", prefilter=True)
                .limit(1)
                .to_list()
            )
            if results:
                self.short_term_table.delete(f"id = '{memory_id}'")
                return True
            return False

        if await _run_sync(_try_delete_short):
            return True

        def _try_delete_long():
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

        if await _run_sync(_try_delete_long):
            return True

        return False

    async def query_old_short_term(
        self,
        before_time: str,
        visibility: str,
        compressed: bool = False,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """查询指定时间之前的短期记忆原始行"""
        await self.ensure_tables()
        where = f"event_time < '{before_time}' AND visibility = '{visibility}' AND compressed = {str(compressed).lower()}"
        def _do_query():
            return (
                self.short_term_table.search()
                .where(where, prefilter=True)
                .limit(limit)
                .to_list()
            )
        return await _run_sync(_do_query)

    async def delete_short_term_by_ids(self, ids: List[str]):
        """批量删除指定 ID 的短期记忆"""
        await self.ensure_tables()
        id_list = ", ".join(f"'{id}'" for id in ids)
        where = f"id IN ({id_list})"
        await _run_sync(lambda: self.short_term_table.delete(where))

    async def rotate_short_term(self, before_time: str):
        """删除指定时间之前的所有短期记忆"""
        await self.ensure_tables()
        where = f"event_time < '{before_time}'"
        await _run_sync(lambda: self.short_term_table.delete(where))

    async def get_all_short_term_rows(self) -> List[Dict[str, Any]]:
        """导出所有短期记忆行（不含 vector）"""
        await self.ensure_tables()
        def _do():
            return self.short_term_table.search().limit(100000).to_list()
        rows = await _run_sync(_do)
        for r in rows:
            r.pop("vector", None)
            r.pop("_distance", None)
        return rows

    async def get_all_long_term_rows(self) -> List[Dict[str, Any]]:
        """导出所有长期记忆行（不含 vector）"""
        await self.ensure_tables()
        def _do():
            return self.long_term_table.search().limit(100000).to_list()
        rows = await _run_sync(_do)
        for r in rows:
            r.pop("vector", None)
            r.pop("_distance", None)
        return rows

    async def clear_all(self):
        """清空所有数据（用于 replace 模式导入）"""
        await self.ensure_tables()
        def _do():
            for name in ["short_term_memory", "long_term_memory"]:
                if name in self.db.table_names():
                    self.db.drop_table(name)
        await _run_sync(_do)
        self._tables_initialized = False
        await self.ensure_tables()

    def get_short_term_count(self) -> int:
        """获取短期记忆数量"""
        if self.short_term_table is None:
            return 0
        return self.short_term_table.count_rows()

    def get_long_term_count(self) -> int:
        """获取长期记忆数量"""
        if self.long_term_table is None:
            return 0
        return self.long_term_table.count_rows()

    def close(self):
        """关闭连接"""
        pass  # LanceDB 无需显式关闭

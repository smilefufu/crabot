"""
短期记忆存储 - SQLite 实现（v3）。

替代 v2 的 LanceDB 实现：删 vector 列后 LanceDB 价值消失，统一到 sqlite3。
v2→v3 迁移见 crabot-memory/upgrade/from_v2_to_v3.py。

接口签名与 v2 VectorStore 镜像（add/search/get_by_id/delete/rotate 等），
方便上层（module.py / core/short_term.py）平滑切换。
"""
import asyncio
import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..types import MemorySource, ShortTermMemoryEntry, Visibility

logger = logging.getLogger(__name__)


def _run_sync(fn):
    """同步函数包装到 executor，避免阻塞事件循环。"""
    return asyncio.get_running_loop().run_in_executor(None, fn)


_VIS_ORDER = {"private": 3, "internal": 2, "public": 1}


def _visibility_filter_sql(min_visibility: Visibility) -> Optional[str]:
    level = _VIS_ORDER.get(min_visibility, 1)
    if level >= 2:
        return "visibility IN ('private', 'internal')"
    if level >= 1:
        return "visibility IN ('private', 'internal', 'public')"
    return None


class ShortTermStore:
    """短期记忆 SQLite 存储。"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False：所有 DB 操作通过 _run_sync 进 executor，可能跨线程
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        cur = self._conn.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS short_term_memory (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                keywords TEXT NOT NULL DEFAULT '[]',
                event_time TEXT NOT NULL,
                persons TEXT NOT NULL DEFAULT '[]',
                entities TEXT NOT NULL DEFAULT '[]',
                topic TEXT,
                source_type TEXT,
                source_json TEXT NOT NULL,
                refs_json TEXT,
                compressed INTEGER NOT NULL DEFAULT 0,
                visibility TEXT NOT NULL,
                scopes TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            )
            """
        )
        cur.execute("CREATE INDEX IF NOT EXISTS idx_st_event_time ON short_term_memory (event_time DESC)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_st_visibility ON short_term_memory (visibility)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_st_compressed ON short_term_memory (compressed)")
        self._conn.commit()

    # ---- 写入 ----

    async def add_short_term(self, entry: ShortTermMemoryEntry, vector: Optional[List[float]] = None) -> None:
        """添加短期记忆。

        ``vector`` 参数仅为兼容旧调用签名保留，不再使用。
        """
        del vector  # silence unused
        def _do():
            self._conn.execute(
                """
                INSERT OR REPLACE INTO short_term_memory (
                    id, content, keywords, event_time, persons, entities, topic,
                    source_type, source_json, refs_json, compressed, visibility,
                    scopes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry.id,
                    entry.content,
                    json.dumps(entry.keywords or [], ensure_ascii=False),
                    entry.event_time,
                    json.dumps(entry.persons or [], ensure_ascii=False),
                    json.dumps(entry.entities or [], ensure_ascii=False),
                    entry.topic or "",
                    entry.source.type,
                    entry.source.model_dump_json(),
                    json.dumps(entry.refs or {}, ensure_ascii=False),
                    1 if entry.compressed else 0,
                    entry.visibility,
                    json.dumps(entry.scopes or [], ensure_ascii=False),
                    entry.created_at,
                ),
            )
            self._conn.commit()

        await _run_sync(_do)

    # ---- 检索 ----

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
        """检索短期记忆。

        v3：query 改为 SQLite LIKE 字面匹配（不再走向量）。其他过滤（visibility / scopes /
        time_range / refs / persons / entities / topic）维持 v2 语义。
        """
        clauses: List[str] = []
        params: List[Any] = []

        vis_clause = _visibility_filter_sql(min_visibility)
        if vis_clause:
            clauses.append(vis_clause)

        if time_range:
            if time_range.get("start"):
                clauses.append("event_time >= ?")
                params.append(time_range["start"])
            if time_range.get("end"):
                clauses.append("event_time <= ?")
                params.append(time_range["end"])

        if query:
            # 字面匹配。中文 query 不依赖分词，直接子串匹配 content/topic。
            clauses.append("(content LIKE ? OR topic LIKE ?)")
            wildcard = f"%{query}%"
            params.extend([wildcard, wildcard])

        if filter_topic:
            clauses.append("topic = ?")
            params.append(filter_topic)

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        order = "ORDER BY event_time DESC" if sort_by == "event_time" else ""
        # 用 limit*2 取一波再后过滤，避免后过滤截断不足
        sql = f"SELECT * FROM short_term_memory {where} {order} LIMIT ?"
        params.append(limit * 2)

        def _do():
            return list(self._conn.execute(sql, params).fetchall())

        rows = await _run_sync(_do)

        results: List[ShortTermMemoryEntry] = []
        for row in rows:
            try:
                # 后过滤：scopes / refs / persons / entities
                scopes = json.loads(row["scopes"] or "[]")
                if accessible_scopes is not None and accessible_scopes:
                    if not any(s in scopes for s in accessible_scopes):
                        continue

                refs = json.loads(row["refs_json"] or "{}") or None
                if filter_refs and refs:
                    if not all(refs.get(k) == v for k, v in filter_refs.items()):
                        continue

                persons = json.loads(row["persons"] or "[]")
                if filter_persons:
                    if not any(p in persons for p in filter_persons):
                        continue

                entities = json.loads(row["entities"] or "[]")
                if filter_entities:
                    if not any(e in entities for e in filter_entities):
                        continue

                source_data = json.loads(row["source_json"])
                entry = ShortTermMemoryEntry(
                    id=row["id"],
                    content=row["content"],
                    keywords=json.loads(row["keywords"] or "[]"),
                    event_time=row["event_time"],
                    persons=persons,
                    entities=entities,
                    topic=row["topic"] or None,
                    source=MemorySource(**source_data),
                    refs=refs,
                    compressed=bool(row["compressed"]),
                    visibility=row["visibility"],
                    scopes=scopes,
                    created_at=row["created_at"],
                )
                results.append(entry)
                if len(results) >= limit:
                    break
            except Exception as e:  # noqa: BLE001
                logger.warning("Failed to parse short term row: %s", e)

        return results

    async def get_by_id(self, memory_id: str) -> Optional[Dict[str, Any]]:
        """根据 ID 获取短期记忆原始行。"""
        def _do():
            row = self._conn.execute(
                "SELECT * FROM short_term_memory WHERE id = ?", (memory_id,)
            ).fetchone()
            if row is None:
                return None
            return {"type": "short", "row": dict(row)}

        return await _run_sync(_do)

    async def delete_by_id(self, memory_id: str) -> bool:
        def _do():
            cur = self._conn.execute("DELETE FROM short_term_memory WHERE id = ?", (memory_id,))
            self._conn.commit()
            return cur.rowcount > 0

        return await _run_sync(_do)

    async def query_old_short_term(
        self,
        before_time: str,
        visibility: str,
        compressed: bool = False,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """查询指定时间之前的短期记忆原始行（用于压缩）。"""
        def _do():
            rows = self._conn.execute(
                """
                SELECT * FROM short_term_memory
                WHERE event_time < ? AND visibility = ? AND compressed = ?
                ORDER BY event_time
                LIMIT ?
                """,
                (before_time, visibility, 1 if compressed else 0, limit),
            ).fetchall()
            return [dict(r) for r in rows]

        return await _run_sync(_do)

    async def delete_short_term_by_ids(self, ids: List[str]) -> None:
        if not ids:
            return
        def _do():
            placeholders = ",".join("?" * len(ids))
            self._conn.execute(
                f"DELETE FROM short_term_memory WHERE id IN ({placeholders})", ids
            )
            self._conn.commit()

        await _run_sync(_do)

    async def rotate_short_term(self, before_time: str) -> None:
        def _do():
            self._conn.execute(
                "DELETE FROM short_term_memory WHERE event_time < ?", (before_time,)
            )
            self._conn.commit()

        await _run_sync(_do)

    async def get_all_short_term_rows(self) -> List[Dict[str, Any]]:
        """导出所有短期记忆行。"""
        def _do():
            rows = self._conn.execute("SELECT * FROM short_term_memory").fetchall()
            return [dict(r) for r in rows]

        return await _run_sync(_do)

    async def clear_all(self) -> None:
        def _do():
            self._conn.execute("DELETE FROM short_term_memory")
            self._conn.commit()

        await _run_sync(_do)

    def get_short_term_count(self) -> int:
        return self._conn.execute(
            "SELECT COUNT(*) FROM short_term_memory"
        ).fetchone()[0]

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:  # noqa: BLE001
            pass

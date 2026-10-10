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
import re
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..types import MemorySource, ShortTermMemoryEntry, Visibility

logger = logging.getLogger(__name__)


def _run_sync(fn):
    """同步函数包装到 executor，避免阻塞事件循环。"""
    return asyncio.get_running_loop().run_in_executor(None, fn)


# Python `\w` 在 re.UNICODE 下已覆盖字母/数字/下划线 + CJK Unified Ideographs +
# CJK 扩展 A/B、Hangul、Kana 等所有 Unicode letter，无需额外 CJK class。
_FTS_TOKEN_RE = re.compile(r'\w+', re.UNICODE)


def _escape_fts_query(query: str) -> str:
    """把任意用户 query 转成安全的 FTS5 trigram MATCH 表达式。

    策略：
    - 用 ``_FTS_TOKEN_RE``（``\\w+`` 在 re.UNICODE 下涵盖字母/数字/下划线 + 全部 Unicode
      letter，包含 CJK / Hangul / Kana 等）抽 token
    - 丢弃 <3 字符的 token（trigram 索引最小单位是 3-gram，更短的 token 永远 0 命中）
    - 每 token 用引号包成 phrase + 用 OR 连接：避免 query 里的字面词被 FTS5 当作操作符
      （如 ``NEAR``）；引号里的内容仍按 trigram 切
    - FTS5 特殊字符（"、*、:、(、)）经 token 抽取被自然丢弃

    返回空串表示无可用 token，调用方应跳过 FTS 路径。
    """
    tokens = [t for t in _FTS_TOKEN_RE.findall(query) if len(t) >= 3]
    if not tokens:
        return ""
    return " OR ".join(f'"{t}"' for t in tokens)


def _visibility_filter_sql(min_visibility: Visibility) -> str:
    return {
        "private": "m.visibility IN ('private', 'internal', 'public')",
        "internal": "m.visibility IN ('internal', 'public')",
        "public": "m.visibility = 'public'",
    }[min_visibility]


class ShortTermStore:
    """短期记忆 SQLite 存储。"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._lock = threading.RLock()
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
        # tokenize='trigram'：spec 原写 unicode61，但实测 unicode61 不切 CJK 连续字符串
        # （例如 '排行榜每日早报已发送到微信群' 整体为一 token），导致中文 query 0 命中。
        # trigram 把任意 3 字符序列入索引，CJK / 英文混合都能召回。详见
        # crabot-docs/superpowers/plans/2026-05-08-short-term-memory-fts-phase1.md Task 2。
        cur.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS short_term_fts USING fts5(
                content,
                topic,
                keywords,
                content='short_term_memory',
                content_rowid='rowid',
                tokenize='trigram'
            )
            """
        )
        cur.execute(
            """
            CREATE TRIGGER IF NOT EXISTS short_term_ai
            AFTER INSERT ON short_term_memory BEGIN
                INSERT INTO short_term_fts(rowid, content, topic, keywords)
                VALUES (new.rowid, new.content, COALESCE(new.topic, ''), new.keywords);
            END
            """
        )
        cur.execute(
            """
            CREATE TRIGGER IF NOT EXISTS short_term_ad
            AFTER DELETE ON short_term_memory BEGIN
                INSERT INTO short_term_fts(short_term_fts, rowid, content, topic, keywords)
                VALUES ('delete', old.rowid, old.content, COALESCE(old.topic, ''), old.keywords);
            END
            """
        )
        cur.execute(
            """
            CREATE TRIGGER IF NOT EXISTS short_term_au
            AFTER UPDATE ON short_term_memory BEGIN
                INSERT INTO short_term_fts(short_term_fts, rowid, content, topic, keywords)
                VALUES ('delete', old.rowid, old.content, COALESCE(old.topic, ''), old.keywords);
                INSERT INTO short_term_fts(rowid, content, topic, keywords)
                VALUES (new.rowid, new.content, COALESCE(new.topic, ''), new.keywords);
            END
            """
        )
        self._conn.commit()

    async def _run(self, fn):
        def locked():
            with self._lock:
                return fn()
        return await _run_sync(locked)

    # ---- 写入 ----

    async def add_short_term(self, entry: ShortTermMemoryEntry, vector: Optional[List[float]] = None) -> None:
        """添加短期记忆。

        ``vector`` 参数仅为兼容旧调用签名保留，不再使用。
        """
        del vector  # silence unused
        def _do():
            with self._conn:
                self._insert_entry(entry)
        await self._run(_do)

    def _insert_entry(self, entry: ShortTermMemoryEntry) -> None:
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

    async def replace_compressed(self, old_ids: List[str], entries: List[ShortTermMemoryEntry]) -> None:
        if not entries:
            raise ValueError("Compression must retain at least one fact")

        def _do():
            with self._conn:
                for entry in entries:
                    self._insert_entry(entry)
                self._conn.executemany("DELETE FROM short_term_memory WHERE id = ?", [(mid,) for mid in old_ids])
        await self._run(_do)

    # ---- 检索 ----

    async def search_short_term(
        self,
        query: Optional[str] = None,
        limit: int = 20,
        min_visibility: Visibility = "internal",
        accessible_scopes: Optional[List[str]] = None,
        filter_refs: Optional[Dict[str, str]] = None,
        time_range: Optional[Dict[str, Optional[str]]] = None,
        filter_persons: Optional[List[str]] = None,
        filter_entities: Optional[List[str]] = None,
        filter_topic: Optional[str] = None,
        sort_by: str = "event_time",
    ) -> List[ShortTermMemoryEntry]:
        """检索短期记忆。

        v3.1：query 走 FTS5 MATCH（trigram 分词），BM25 内置排序。
        - sort_by='event_time'（默认）：有 query 时按 (rank, event_time DESC)，无 query 时按 event_time DESC
        - sort_by='relevance'：纯按 BM25 rank（FTS5 中 rank ASC = 越相关越靠前）
        其他过滤（visibility / scopes / time_range / refs / persons / entities / topic）维持原语义。

        注意：FTS 索引基于 trigram tokenizer，最小匹配单位是 3 字符。
        若 query 抽词后所有 token 都 <3 字符（例如 2 字 CJK"微信"、2 字 ASCII"gh"），
        FTS 路径不生效，退化为 `event_time DESC` 全量扫描——返回会忽略 query 意图。
        调用方在该场景应拓宽 time_range 或接受退化行为。
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

        # FTS5 MATCH 分支：仅当 query 非空且能抽出 token 时生效
        fts_join = ""
        if query:
            escaped = _escape_fts_query(query)
            if escaped:
                fts_join = "JOIN short_term_fts f ON f.rowid = m.rowid"
                clauses.append("short_term_fts MATCH ?")
                params.append(escaped)

        if filter_topic:
            clauses.append("topic = ?")
            params.append(filter_topic)

        if accessible_scopes:
            clauses.append("EXISTS (SELECT 1 FROM json_each(m.scopes) s JOIN json_each(?) a ON s.value = a.value)")
            params.append(json.dumps(accessible_scopes))
        for key, value in (filter_refs or {}).items():
            clauses.append("EXISTS (SELECT 1 FROM json_each(COALESCE(m.refs_json, '{}')) r WHERE r.key = ? AND r.value = ?)")
            params.extend([key, value])
        for field, values in [("persons", filter_persons), ("entities", filter_entities)]:
            if values:
                clauses.append(f"EXISTS (SELECT 1 FROM json_each(m.{field}) r JOIN json_each(?) f ON r.value = f.value)")
                params.append(json.dumps(values))
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

        if fts_join:
            if sort_by == "relevance":
                order = "ORDER BY rank"
            else:  # event_time（默认）
                order = "ORDER BY rank, event_time DESC"
        else:
            order = "ORDER BY event_time DESC" if sort_by == "event_time" else ""

        # All explicit filters run before candidate truncation.
        sql = f"SELECT m.* FROM short_term_memory m {fts_join} {where} {order} LIMIT ?"
        params.append(limit)

        def _do():
            return list(self._conn.execute(sql, params).fetchall())

        rows = await self._run(_do)

        results: List[ShortTermMemoryEntry] = []
        for row in rows:
            try:
                scopes = json.loads(row["scopes"] or "[]")
                refs = json.loads(row["refs_json"] or "{}") or None
                persons = json.loads(row["persons"] or "[]")
                entities = json.loads(row["entities"] or "[]")
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
                logger.warning("Invalid short term metadata; row omitted")

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

        return await self._run(_do)

    async def delete_by_id(self, memory_id: str) -> bool:
        def _do():
            cur = self._conn.execute("DELETE FROM short_term_memory WHERE id = ?", (memory_id,))
            self._conn.commit()
            return cur.rowcount > 0

        return await self._run(_do)

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

        return await self._run(_do)

    async def delete_short_term_by_ids(self, ids: List[str]) -> None:
        if not ids:
            return
        def _do():
            placeholders = ",".join("?" * len(ids))
            self._conn.execute(
                f"DELETE FROM short_term_memory WHERE id IN ({placeholders})", ids
            )
            self._conn.commit()

        await self._run(_do)

    async def rotate_short_term(self, before_time: str) -> None:
        def _do():
            self._conn.execute(
                "DELETE FROM short_term_memory WHERE event_time < ?", (before_time,)
            )
            self._conn.commit()

        await self._run(_do)

    async def get_all_short_term_rows(self) -> List[Dict[str, Any]]:
        """导出所有短期记忆行。"""
        def _do():
            rows = self._conn.execute("SELECT * FROM short_term_memory").fetchall()
            return [dict(r) for r in rows]

        return await self._run(_do)

    async def clear_all(self) -> None:
        def _do():
            self._conn.execute("DELETE FROM short_term_memory")
            self._conn.commit()

        await self._run(_do)

    def get_short_term_count(self) -> int:
        with self._lock:
            return self._conn.execute(
                "SELECT COUNT(*) FROM short_term_memory"
            ).fetchone()[0]

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:  # noqa: BLE001
            pass

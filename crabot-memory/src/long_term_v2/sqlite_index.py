"""SQLite indexes for long_term v2."""
import sqlite3
import json
from datetime import datetime, timedelta, timezone
from typing import Iterator, List, Tuple
from src.long_term_v2.schema import MemoryEntry


_BASE_SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    type TEXT NOT NULL,
    brief TEXT NOT NULL,
    body TEXT NOT NULL,
    event_time TEXT NOT NULL,
    ingestion_time TEXT NOT NULL,
    path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_status_type ON memories(status, type);

CREATE TABLE IF NOT EXISTS entity_index (
    entity_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    PRIMARY KEY (entity_id, memory_id)
);

CREATE TABLE IF NOT EXISTS tag_index (
    tag TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    PRIMARY KEY (tag, memory_id)
);

CREATE TABLE IF NOT EXISTS lesson_task_usage (
    task_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    bumped_at TEXT NOT NULL,
    PRIMARY KEY (task_id, lesson_id)
);
CREATE INDEX IF NOT EXISTS idx_lesson_task_usage_task ON lesson_task_usage(task_id);
"""

_PHASE3_ADDITIVE_COLUMNS = [
    ("observation_started_at", "TEXT"),
    ("observation_window_days", "INTEGER"),
    ("observation_outcome", "TEXT"),
    ("use_count", "INTEGER NOT NULL DEFAULT 0"),
    ("last_validated_at", "TEXT"),
    ("stale_check_count", "INTEGER NOT NULL DEFAULT 0"),
    ("last_seen_at", "TEXT"),
    ("observation_pass_count", "INTEGER NOT NULL DEFAULT 0"),
    ("observation_fail_count", "INTEGER NOT NULL DEFAULT 0"),
]


class SqliteIndex:
    def __init__(self, db_path: str):
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        self.conn.executescript(_BASE_SCHEMA)
        # Phase 3 additive columns — backward-compatible ALTER TABLE
        for col, ddl in _PHASE3_ADDITIVE_COLUMNS:
            try:
                self.conn.execute(f"ALTER TABLE memories ADD COLUMN {col} {ddl}")
            except sqlite3.OperationalError:
                pass  # column already exists
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS kv_meta "
            "(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)"
        )
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def upsert(self, entry: MemoryEntry, path: str, status: str) -> None:
        fm = entry.frontmatter
        cur = self.conn.cursor()
        cur.execute("DELETE FROM entity_index WHERE memory_id = ?", (fm.id,))
        cur.execute("DELETE FROM tag_index WHERE memory_id = ?", (fm.id,))

        # Phase 3 optional fields
        observation_started_at = fm.observation.started_at if fm.observation else None
        observation_window_days = fm.observation.window_days if fm.observation else None
        observation_outcome = fm.observation.outcome if fm.observation else None
        last_seen_at = fm.observation.last_seen_at if fm.observation else None
        stale_check_count = fm.observation.stale_check_count if fm.observation else 0
        use_count = fm.lesson_meta.use_count if fm.lesson_meta else 0
        last_validated_at = fm.lesson_meta.last_validated_at if fm.lesson_meta else None

        cur.execute(
            """
            INSERT OR REPLACE INTO memories
              (id, status, type, brief, body, event_time, ingestion_time, path,
               observation_started_at, observation_window_days, observation_outcome,
               use_count, last_validated_at, stale_check_count, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                fm.id, status, fm.type, fm.brief, entry.body,
                fm.event_time, fm.ingestion_time, path,
                observation_started_at, observation_window_days, observation_outcome,
                use_count, last_validated_at, stale_check_count, last_seen_at,
            ),
        )
        for ent in fm.entities:
            cur.execute(
                "INSERT OR IGNORE INTO entity_index (entity_id, memory_id) VALUES (?, ?)",
                (ent.id, fm.id),
            )
        for tag in fm.tags:
            cur.execute(
                "INSERT OR IGNORE INTO tag_index (tag, memory_id) VALUES (?, ?)",
                (tag, fm.id),
            )
        self.conn.commit()

    def delete(self, mem_id: str) -> None:
        cur = self.conn.cursor()
        cur.execute("DELETE FROM memories WHERE id = ?", (mem_id,))
        cur.execute("DELETE FROM entity_index WHERE memory_id = ?", (mem_id,))
        cur.execute("DELETE FROM tag_index WHERE memory_id = ?", (mem_id,))
        self.conn.commit()

    def find_by_entity(self, entity_id: str) -> List[str]:
        cur = self.conn.cursor()
        cur.execute("SELECT memory_id FROM entity_index WHERE entity_id = ?", (entity_id,))
        return [row[0] for row in cur.fetchall()]

    def find_by_tag(self, tag: str) -> List[str]:
        cur = self.conn.cursor()
        cur.execute("SELECT memory_id FROM tag_index WHERE tag = ?", (tag,))
        return [row[0] for row in cur.fetchall()]

    def iter_all_confirmed_briefs(self):
        """Yield {id, type, brief, tags} for status='confirmed'."""
        cur = self.conn.execute(
            """
            SELECT m.id, m.type, m.brief,
                   GROUP_CONCAT(t.tag, '\x1f') AS tags_concat
            FROM memories m
            LEFT JOIN tag_index t ON t.memory_id = m.id
            WHERE m.status = 'confirmed'
            GROUP BY m.id
            """
        )
        for r in cur.fetchall():
            tags_concat = r["tags_concat"]
            yield {
                "id": r["id"],
                "type": r["type"],
                "brief": r["brief"],
                "tags": tags_concat.split("\x1f") if tags_concat else [],
            }

    def iter_brief_for_bm25(self) -> Iterator[Tuple[str, str, str, str, str]]:
        cur = self.conn.cursor()
        cur.execute("SELECT id, status, type, body, brief FROM memories")
        for row in cur.fetchall():
            yield row

    def iter_all_with_meta(self):
        """Yield (id, status, type, brief, body, event_time, ingestion_time, path) for every memory."""
        cur = self.conn.cursor()
        cur.execute(
            "SELECT id, status, type, brief, body, event_time, ingestion_time, path FROM memories"
        )
        for row in cur.fetchall():
            yield row

    def locate(self, mem_id: str):
        cur = self.conn.cursor()
        cur.execute("SELECT status, type, path FROM memories WHERE id = ?", (mem_id,))
        row = cur.fetchone()
        return row if row else None

    def find_by_time_range(
        self, field: str, start: str, end: str, limit: int = 50,
    ) -> list[str]:
        """Return memory_ids whose `event_time` or `ingestion_time` ∈ [start, end).

        ISO-8601 strings sort lexicographically equal to chronologically; safe to
        compare with SQLite text comparison.
        """
        if field not in {"event_time", "ingestion_time"}:
            raise ValueError(f"invalid field: {field}")
        cur = self.conn.cursor()
        cur.execute(
            f"SELECT id FROM memories WHERE {field} >= ? AND {field} < ? "
            f"ORDER BY {field} DESC LIMIT ?",
            (start, end, int(limit)),
        )
        return [row[0] for row in cur.fetchall()]

    # ── Phase 3 helpers ──────────────────────────────────────────────────────

    def bump_use_count(self, mem_id: str, now_iso: str) -> None:
        self.conn.execute(
            "UPDATE memories SET use_count = use_count + 1, last_validated_at = ?, last_seen_at = ? WHERE id = ?",
            (now_iso, now_iso, mem_id),
        )
        self.conn.commit()

    def record_lesson_task_usage(self, task_id: str, lesson_id: str, now_iso: str) -> None:
        """记录一次召回命中（lesson 被某 task 引用）。

        PRIMARY KEY 去重 — 同一 task 多次召回同一 lesson 只记一行。
        给 report_task_feedback 反向查找用。
        """
        self.conn.execute(
            "INSERT OR IGNORE INTO lesson_task_usage(task_id, lesson_id, bumped_at) "
            "VALUES (?, ?, ?)",
            (task_id, lesson_id, now_iso),
        )
        self.conn.commit()

    def find_lessons_used_in_task(self, task_id: str) -> list[str]:
        """查找该 task 期间被召回引用过的所有 lesson IDs（按 lesson_id ASC 稳定排序）。

        ORDER BY 保证 RPC report_task_feedback 返回的 lesson_ids 顺序确定，
        避免下游观察期/可观测性依赖 SQLite 隐式行序。
        """
        rows = self.conn.execute(
            "SELECT lesson_id FROM lesson_task_usage WHERE task_id = ? ORDER BY lesson_id ASC",
            (task_id,),
        ).fetchall()
        return [r["lesson_id"] for r in rows]

    def bump_observation_counter(self, mem_id: str, column: str, delta: int) -> None:
        """累加 observation_pass_count 或 observation_fail_count（按权重）。

        column 必须是白名单值，避免 SQL 注入。
        """
        if column not in ("observation_pass_count", "observation_fail_count"):
            raise ValueError(f"invalid column: {column}")
        # column 已通过白名单校验，可安全 f-string
        self.conn.execute(
            f"UPDATE memories SET {column} = {column} + ? WHERE id = ?",
            (delta, mem_id),
        )
        self.conn.commit()

    def mark_observation_outcome(self, mem_id: str, outcome: str) -> None:
        self.conn.execute(
            "UPDATE memories SET observation_outcome = ? WHERE id = ?",
            (outcome, mem_id),
        )
        self.conn.commit()

    def extend_observation_window(self, mem_id: str, days: int) -> None:
        """Add N days to entry's observation window."""
        if days <= 0:
            raise ValueError("days must be positive")
        self.conn.execute(
            "UPDATE memories SET observation_window_days = COALESCE(observation_window_days, 0) + ? WHERE id = ?",
            (days, mem_id),
        )
        self.conn.commit()

    def scan_expired_observation(self, now_iso: str) -> list[dict]:
        """Return entries whose observation window has expired (any outcome).

        Used by maintenance.observation_check to settle expired entries.
        """
        cur = self.conn.execute(
            "SELECT id, type, status, brief, path, observation_started_at, observation_window_days, "
            "observation_outcome, observation_pass_count, observation_fail_count "
            "FROM memories WHERE observation_started_at IS NOT NULL"
        )
        rows = [dict(r) for r in cur.fetchall()]
        out = []
        for r in rows:
            try:
                started = datetime.fromisoformat(r["observation_started_at"].replace("Z", "+00:00"))
                now_dt = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
                if now_dt - started >= timedelta(days=int(r["observation_window_days"] or 7)):
                    out.append(r)
            except Exception:
                pass
        return out

    def list_active_observation(self) -> list[dict]:
        """Return all entries currently inside the observation window (outcome=pending),
        regardless of whether their window has expired.

        Used by Admin UI 「观察期」 tab to let the user see all entries under observation
        and act early (mark pass / extend / delete). Distinct from scan_expired_observation
        which is for the maintenance settler.
        """
        cur = self.conn.execute(
            "SELECT id, type, status, brief, path, observation_started_at, observation_window_days, "
            "observation_outcome, observation_pass_count, observation_fail_count "
            "FROM memories WHERE observation_started_at IS NOT NULL "
            "AND (observation_outcome IS NULL OR observation_outcome = 'pending') "
            "ORDER BY observation_started_at DESC"
        )
        return [dict(r) for r in cur.fetchall()]

    def scan_stale_facts(self, idle_days: int, now_iso: str) -> list[dict]:
        """Return confirmed facts whose last_validated_at is older than idle_days."""
        cur = self.conn.execute(
            "SELECT id, type, status, brief, path, last_validated_at, ingestion_time "
            "FROM memories WHERE type = 'fact' AND status = 'confirmed'"
        )
        rows = [dict(r) for r in cur.fetchall()]
        out = []
        now_dt = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
        cutoff = now_dt - timedelta(days=idle_days)
        for r in rows:
            ref_iso = r["last_validated_at"] or r["ingestion_time"]
            if not ref_iso:
                continue
            try:
                ref_dt = datetime.fromisoformat(ref_iso.replace("Z", "+00:00"))
                if ref_dt < cutoff:
                    out.append(r)
            except Exception:
                pass
        return out

    def scan_old_trash(self, retention_days: int, now_iso: str) -> list[dict]:
        """Return trash entries older than retention_days (by ingestion_time)."""
        cur = self.conn.execute(
            "SELECT id, type, status, brief, path, ingestion_time FROM memories WHERE status = 'trash'"
        )
        rows = [dict(r) for r in cur.fetchall()]
        now_dt = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
        cutoff = now_dt - timedelta(days=retention_days)
        out = []
        for r in rows:
            try:
                ref_dt = datetime.fromisoformat(r["ingestion_time"].replace("Z", "+00:00"))
                if ref_dt < cutoff:
                    out.append(r)
            except Exception:
                pass
        return out

    def get_evolution_mode(self) -> tuple[str, str | None, str | None]:
        cur = self.conn.execute(
            "SELECT value FROM kv_meta WHERE key = 'evolution_mode'"
        ).fetchone()
        if not cur:
            return ("balanced", None, None)
        payload = json.loads(cur["value"])
        return (payload.get("mode", "balanced"), payload.get("reason"), payload.get("updated_at"))

    def set_evolution_mode(self, mode: str, reason: str | None) -> None:
        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        payload = json.dumps({"mode": mode, "reason": reason, "updated_at": now_str})
        self.conn.execute(
            "INSERT INTO kv_meta(key, value, updated_at) VALUES ('evolution_mode', ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (payload, now_str),
        )
        self.conn.commit()

    def get_row(self, mem_id: str) -> dict | None:
        cur = self.conn.execute("SELECT * FROM memories WHERE id = ?", (mem_id,)).fetchone()
        return dict(cur) if cur else None

    def count_entries(self, *, status: str | None = None) -> int:
        """Total memory count (optionally filtered by status)."""
        if status:
            cur = self.conn.execute(
                "SELECT COUNT(*) FROM memories WHERE status = ?", (status,)
            )
        else:
            cur = self.conn.execute("SELECT COUNT(*) FROM memories")
        row = cur.fetchone()
        return int(row[0]) if row else 0

    def list_entries(
        self,
        *,
        type_: str | None = None,
        status: str | None = None,
        tags: list[str] | None = None,
        limit: int = 100,
        offset: int = 0,
        sort: str = "ingestion_time_desc",
    ) -> list[dict]:
        """按 type/status/tags 过滤，按 sort 排序，分页返回。

        Note: there is no `author` column on the `memories` table. Author
        filtering must happen at the RPC layer after loading the entry's
        frontmatter.
        """
        where: list[str] = []
        params: list = []
        if type_:
            where.append("type = ?")
            params.append(type_)
        if status:
            where.append("status = ?")
            params.append(status)
        where_sql = "WHERE " + " AND ".join(where) if where else ""

        order = {
            "ingestion_time_desc": "ingestion_time DESC",
            "ingestion_time_asc": "ingestion_time ASC",
            "event_time_desc": "event_time DESC",
        }.get(sort, "ingestion_time DESC")

        cur = self.conn.execute(
            f"SELECT id, type, status FROM memories {where_sql} "
            f"ORDER BY {order} LIMIT ? OFFSET ?",
            (*params, int(limit), int(offset)),
        )
        rows = [dict(zip(["id", "type", "status"], r)) for r in cur.fetchall()]

        if tags:
            tag_ids: set[str] = set()
            for t in tags:
                tag_ids |= set(self.find_by_tag(t))
            rows = [r for r in rows if r["id"] in tag_ids]

        return rows

    def keyword_search(
        self,
        query: str,
        *,
        type_: str | None = None,
        status: str | None = "confirmed",
        limit: int = 50,
    ) -> list[dict]:
        """LIKE search on brief + body; returns rows with id/type/status/brief/body/ingestion_time."""
        clauses = ["(brief LIKE ? OR body LIKE ?)"]
        pattern = f"%{query}%"
        args: list = [pattern, pattern]
        if type_:
            clauses.append("type = ?")
            args.append(type_)
        if status is not None:
            clauses.append("status = ?")
            args.append(status)
        sql = (
            "SELECT id, type, status, brief, body, ingestion_time "
            "FROM memories WHERE " + " AND ".join(clauses)
            + " ORDER BY ingestion_time DESC LIMIT ?"
        )
        args.append(limit)
        cursor = self.conn.execute(sql, args)
        return [
            {
                "id": row["id"], "type": row["type"], "status": row["status"],
                "brief": row["brief"], "body": row["body"],
                "ingestion_time": row["ingestion_time"],
            }
            for row in cursor.fetchall()
        ]

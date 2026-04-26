"""
SQLite 元数据存储
存储反思水位、统计信息等。

注：长期记忆 v1 的修正历史（``memory_revisions`` 表）已在 Memory v2 Phase 4
移除。长期记忆现由 ``src/long_term_v2/`` 管理。
"""
import sqlite3
import json
import logging
from typing import Optional, Any
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)


class SQLiteStore:
    """SQLite 元数据存储"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.conn: Optional[sqlite3.Connection] = None
        self._init_db()

    def _init_db(self):
        """初始化数据库表"""
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row

        # 反思水位表
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS reflection_watermark (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                last_reflected_at TEXT
            )
        """)

        # 统计信息表
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS memory_stats (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)

        self.conn.commit()

    def get_reflection_watermark(self) -> Optional[str]:
        """获取反思水位"""
        cursor = self.conn.execute("SELECT last_reflected_at FROM reflection_watermark WHERE id = 1")
        row = cursor.fetchone()
        return row["last_reflected_at"] if row else None

    def update_reflection_watermark(self, timestamp: str):
        """更新反思水位"""
        self.conn.execute("""
            INSERT INTO reflection_watermark (id, last_reflected_at)
            VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET last_reflected_at = ?
        """, (timestamp, timestamp))
        self.conn.commit()

    def set_stat(self, key: str, value: Any):
        """设置统计信息"""
        updated_at = datetime.utcnow().isoformat() + "Z"
        value_json = json.dumps(value)
        self.conn.execute("""
            INSERT INTO memory_stats (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
        """, (key, value_json, updated_at, value_json, updated_at))
        self.conn.commit()

    def get_stat(self, key: str) -> Optional[Any]:
        """获取统计信息"""
        cursor = self.conn.execute("SELECT value FROM memory_stats WHERE key = ?", (key,))
        row = cursor.fetchone()
        if row:
            return json.loads(row["value"])
        return None

    def close(self):
        """关闭连接"""
        if self.conn:
            self.conn.close()

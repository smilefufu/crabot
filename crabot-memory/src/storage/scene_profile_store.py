"""SceneProfile 存储层 — 基于 SQLite，独立于 SQLiteStore 的连接."""
import json
import logging
import sqlite3
from pathlib import Path
from typing import List, Literal, Optional

from ..types import (
    SceneProfile,
    SceneIdentity,
    SceneIdentityFriend,
    SceneIdentityGroup,
    SceneIdentityGlobal,
)

logger = logging.getLogger(__name__)


class SceneProfileStore:
    def __init__(self, db_path: str):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self._init_db()

    def _init_db(self) -> None:
        self.conn.executescript("""
        CREATE TABLE IF NOT EXISTS scene_profiles (
          scene_type             TEXT NOT NULL,
          friend_id              TEXT,
          channel_id             TEXT,
          session_id             TEXT,
          label                  TEXT NOT NULL,
          abstract               TEXT,
          overview               TEXT,
          content                TEXT,
          sections_json          TEXT,
          source_memory_ids_json TEXT,
          created_at             TEXT NOT NULL,
          updated_at             TEXT NOT NULL,
          last_declared_at       TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_friend ON scene_profiles(friend_id)
          WHERE scene_type = 'friend';
        CREATE UNIQUE INDEX IF NOT EXISTS ux_group ON scene_profiles(channel_id, session_id)
          WHERE scene_type = 'group_session';
        CREATE UNIQUE INDEX IF NOT EXISTS ux_global ON scene_profiles(scene_type)
          WHERE scene_type = 'global';
        """)
        self._migrate_schema()
        self.conn.commit()

    def _migrate_schema(self) -> None:
        columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(scene_profiles)").fetchall()
        }
        for column in ("abstract", "overview", "content", "sections_json"):
            if column not in columns:
                self.conn.execute(f"ALTER TABLE scene_profiles ADD COLUMN {column} TEXT")

    # ---------- public API ----------

    def upsert(self, profile: SceneProfile) -> SceneProfile:
        existing = self.get(profile.scene)
        if existing:
            return self._update(profile)
        return self._insert(profile)

    def get(self, scene: SceneIdentity, only_public: bool = False) -> Optional[SceneProfile]:
        row = self._select_one(scene)
        if not row:
            return None
        if only_public:
            # Compatibility shim: scene profiles no longer carry section-level visibility.
            logger.warning("Scene profile only_public flag is ignored for compatibility")
        return self._row_to_profile(row)

    def list(
        self,
        scene_type: Optional[Literal["friend", "group_session", "global"]] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[SceneProfile]:
        sql = (
            "SELECT scene_type, friend_id, channel_id, session_id, label, abstract, overview, content, "
            "sections_json, source_memory_ids_json, created_at, updated_at, last_declared_at FROM scene_profiles"
        )
        params: list = []
        if scene_type:
            sql += " WHERE scene_type = ?"
            params.append(scene_type)
        sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        rows = self.conn.execute(sql, params).fetchall()
        return [self._row_to_profile(r) for r in rows]

    def delete(self, scene: SceneIdentity) -> bool:
        where, params = self._where_for_scene(scene)
        cur = self.conn.execute(f"DELETE FROM scene_profiles WHERE {where}", params)
        self.conn.commit()
        return cur.rowcount > 0

    def close(self) -> None:
        if self.conn is not None:
            self.conn.close()
            self.conn = None  # type: ignore[assignment]

    # ---------- internal ----------

    def _insert(self, profile: SceneProfile) -> SceneProfile:
        scene = profile.scene
        self.conn.execute(
            """INSERT INTO scene_profiles
               (scene_type, friend_id, channel_id, session_id, label,
                abstract, overview, content, sections_json, source_memory_ids_json,
                created_at, updated_at, last_declared_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                scene.type,
                getattr(scene, "friend_id", None),
                getattr(scene, "channel_id", None),
                getattr(scene, "session_id", None),
                profile.label,
                profile.abstract,
                profile.overview,
                profile.content,
                "[]",
                json.dumps(profile.source_memory_ids) if profile.source_memory_ids else None,
                profile.created_at,
                profile.updated_at,
                profile.last_declared_at,
            ),
        )
        self.conn.commit()
        return profile

    def _update(self, profile: SceneProfile) -> SceneProfile:
        where, params = self._where_for_scene(profile.scene)
        self.conn.execute(
            f"""UPDATE scene_profiles SET label = ?, abstract = ?, overview = ?, content = ?,
                sections_json = ?, source_memory_ids_json = ?, updated_at = ?, last_declared_at = ?
                WHERE {where}""",
            [
                profile.label,
                profile.abstract,
                profile.overview,
                profile.content,
                "[]",
                json.dumps(profile.source_memory_ids) if profile.source_memory_ids else None,
                profile.updated_at,
                profile.last_declared_at,
            ] + list(params),
        )
        self.conn.commit()
        return profile

    def _select_one(self, scene: SceneIdentity):
        where, params = self._where_for_scene(scene)
        row = self.conn.execute(
            f"SELECT scene_type, friend_id, channel_id, session_id, label, abstract, overview, content, sections_json, "
            f"source_memory_ids_json, created_at, updated_at, last_declared_at "
            f"FROM scene_profiles WHERE {where} LIMIT 1",
            params,
        ).fetchone()
        return row

    def _where_for_scene(self, scene: SceneIdentity):
        if scene.type == "friend":
            return "scene_type = 'friend' AND friend_id = ?", (scene.friend_id,)
        if scene.type == "group_session":
            return (
                "scene_type = 'group_session' AND channel_id = ? AND session_id = ?",
                (scene.channel_id, scene.session_id),
            )
        return "scene_type = 'global'", ()

    def _row_to_profile(self, row) -> SceneProfile:
        scene_type = row["scene_type"]
        if scene_type == "friend":
            scene: SceneIdentity = SceneIdentityFriend(friend_id=row["friend_id"])
        elif scene_type == "group_session":
            scene = SceneIdentityGroup(channel_id=row["channel_id"], session_id=row["session_id"])
        else:
            scene = SceneIdentityGlobal()

        legacy_sections = json.loads(row["sections_json"]) if row["sections_json"] else []
        content = row["content"] or _legacy_sections_to_content(legacy_sections)
        abstract = row["abstract"] or content[:256]
        overview = row["overview"] or content[:4000]
        src_json = row["source_memory_ids_json"]
        source_ids = json.loads(src_json) if src_json else None
        return SceneProfile(
            scene=scene,
            label=row["label"],
            abstract=abstract,
            overview=overview,
            content=content,
            source_memory_ids=source_ids,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            last_declared_at=row["last_declared_at"],
        )

def _legacy_sections_to_content(sections: list[dict]) -> str:
    lines = []
    for section in sections:
        topic = str(section.get("topic", "")).strip()
        body = str(section.get("body", "")).strip()
        if topic and body:
            lines.append(f"{topic}: {body}")
        elif topic:
            lines.append(topic)
        elif body:
            lines.append(body)
    return "\n".join(lines)

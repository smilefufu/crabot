"""SceneProfile 存储层 — 基于 SQLite，独立于 SQLiteStore 的连接。"""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Literal, Optional

from ..types import (
    SceneProfile,
    SceneProfileSection,
    SceneIdentity,
    SceneIdentityFriend,
    SceneIdentityGroup,
    SceneIdentityGlobal,
)


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
          sections_json          TEXT NOT NULL,
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
        self.conn.commit()

    # ---------- public API ----------

    def upsert(self, profile: SceneProfile) -> SceneProfile:
        existing = self.get(profile.scene)
        if existing:
            return self._update(profile)
        return self._insert(profile)

    def patch(
        self,
        scene: SceneIdentity,
        label: Optional[str],
        section: SceneProfileSection,
        merge: Literal["replace_topic", "append"],
    ) -> SceneProfile:
        current = self.get(scene)
        if current is None:
            new_profile = SceneProfile(
                scene=scene,
                label=label or self._default_label(scene),
                sections=[section],
                created_at=_now_iso(),
                updated_at=_now_iso(),
                last_declared_at=_now_iso(),
            )
            return self._insert(new_profile)

        sections = list(current.sections)
        if merge == "replace_topic":
            sections = [s for s in sections if s.topic != section.topic]
            sections.append(section)
        else:
            sections.append(section)

        return self._update(SceneProfile(
            scene=scene,
            label=label or current.label,
            sections=sections,
            source_memory_ids=current.source_memory_ids,
            created_at=current.created_at,
            updated_at=_now_iso(),
            last_declared_at=_now_iso(),
        ))

    def get(self, scene: SceneIdentity, only_public: bool = False) -> Optional[SceneProfile]:
        row = self._select_one(scene)
        if not row:
            return None
        profile = self._row_to_profile(row)
        if only_public:
            profile.sections = [s for s in profile.sections if s.visibility == "public"]
        return profile

    def list(
        self,
        scene_type: Optional[Literal["friend", "group_session", "global"]] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[SceneProfile]:
        sql = "SELECT scene_type, friend_id, channel_id, session_id, label, sections_json, " \
              "source_memory_ids_json, created_at, updated_at, last_declared_at FROM scene_profiles"
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
                sections_json, source_memory_ids_json, created_at, updated_at, last_declared_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                scene.type,
                getattr(scene, "friend_id", None),
                getattr(scene, "channel_id", None),
                getattr(scene, "session_id", None),
                profile.label,
                json.dumps([s.model_dump() for s in profile.sections], ensure_ascii=False),
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
            f"""UPDATE scene_profiles SET label = ?, sections_json = ?, source_memory_ids_json = ?,
                updated_at = ?, last_declared_at = ? WHERE {where}""",
            [
                profile.label,
                json.dumps([s.model_dump() for s in profile.sections], ensure_ascii=False),
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
            f"SELECT scene_type, friend_id, channel_id, session_id, label, sections_json, "
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
        sections = [SceneProfileSection(**s) for s in json.loads(row["sections_json"])]
        src_json = row["source_memory_ids_json"]
        source_ids = json.loads(src_json) if src_json else None
        return SceneProfile(
            scene=scene,
            label=row["label"],
            sections=sections,
            source_memory_ids=source_ids,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            last_declared_at=row["last_declared_at"],
        )

    def _default_label(self, scene: SceneIdentity) -> str:
        if scene.type == "friend":
            return f"friend:{scene.friend_id}"
        if scene.type == "group_session":
            return f"group:{scene.channel_id}:{scene.session_id}"
        return "global"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

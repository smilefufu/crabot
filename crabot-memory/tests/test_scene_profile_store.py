import os
import tempfile
import json
import sqlite3

import pytest

from src.storage.scene_profile_store import SceneProfileStore
from src.types import (
    SceneProfile,
    SceneIdentityFriend,
    SceneIdentityGroup,
    SceneIdentityGlobal,
)


@pytest.fixture
def store():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    s = SceneProfileStore(path)
    yield s
    s.close()
    os.unlink(path)


def _sample_group():
    return SceneProfile(
        scene=SceneIdentityGroup(channel_id="feishu", session_id="s1"),
        label="开发组群",
        abstract="开发组群摘要",
        overview="开发组群概览",
        content="x",
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )


def test_upsert_insert(store):
    out = store.upsert(_sample_group())
    assert out.label == "开发组群"
    got = store.get(_sample_group().scene)
    assert got and got.label == "开发组群"


def test_upsert_update(store):
    store.upsert(_sample_group())
    updated = _sample_group()
    updated.label = "新名字"
    updated.updated_at = "2026-04-18T00:00:00Z"
    store.upsert(updated)
    got = store.get(updated.scene)
    assert got.label == "新名字"


def test_get_only_public_is_compat_noop(store, caplog):
    store.upsert(_sample_group())
    with caplog.at_level("WARNING"):
        got = store.get(_sample_group().scene, only_public=True)
    assert got.abstract == "开发组群摘要"
    assert got.overview == "开发组群概览"
    assert got.content == "x"
    assert "ignored for compatibility" in caplog.text


def test_list(store):
    store.upsert(_sample_group())
    out = store.list(scene_type="group_session")
    assert len(out) == 1
    assert out[0].abstract == "开发组群摘要"


def test_delete(store):
    store.upsert(_sample_group())
    deleted = store.delete(_sample_group().scene)
    assert deleted is True
    assert store.get(_sample_group().scene) is None


def test_unique_constraint_global(store):
    g1 = SceneProfile(
        scene=SceneIdentityGlobal(),
        label="A",
        abstract="A 摘要",
        overview="A 概览",
        content="A",
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )
    g2 = SceneProfile(
        scene=SceneIdentityGlobal(),
        label="B",
        abstract="B 摘要",
        overview="B 概览",
        content="B",
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )
    store.upsert(g1)
    store.upsert(g2)
    assert len(store.list()) == 1 and store.list()[0].label == "B"


def test_legacy_sections_json_is_converted_to_content(store):
    store.conn.execute(
        """
        INSERT INTO scene_profiles
        (scene_type, friend_id, channel_id, session_id, label, sections_json,
         source_memory_ids_json, created_at, updated_at, last_declared_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "group_session",
            None,
            "feishu",
            "legacy-1",
            "旧群画像",
            json.dumps([
                {"topic": "群职责", "body": "Crabot 开发", "visibility": "private"},
                {"topic": "群规则", "body": "保持简洁", "visibility": "public"},
            ], ensure_ascii=False),
            None,
            "2026-04-17T00:00:00Z",
            "2026-04-17T00:00:00Z",
            None,
        ),
    )
    store.conn.commit()

    got = store.get(SceneIdentityGroup(channel_id="feishu", session_id="legacy-1"))
    assert got.content == "群职责: Crabot 开发\n群规则: 保持简洁"


def test_old_schema_db_writes_scene_profile_without_rebuild(tmp_path):
    db_path = tmp_path / "old_schema.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE scene_profiles (
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
        )
        """
    )
    conn.commit()
    conn.close()

    store = SceneProfileStore(str(db_path))
    profile = SceneProfile(
        scene=SceneIdentityGroup(channel_id="feishu", session_id="write-1"),
        label="写入测试",
        abstract="写入摘要",
        overview="写入概览",
        content="正文内容",
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )
    store.upsert(profile)

    got = store.get(profile.scene)
    assert got is not None
    assert got.content == "正文内容"
    row = store.conn.execute(
        "SELECT sections_json FROM scene_profiles WHERE channel_id = ? AND session_id = ?",
        ("feishu", "write-1"),
    ).fetchone()
    assert row["sections_json"] == "[]"
    store.close()

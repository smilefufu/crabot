import os
import tempfile

import pytest

from src.storage.scene_profile_store import SceneProfileStore
from src.types import (
    SceneProfile,
    SceneProfileSection,
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
        sections=[SceneProfileSection(topic="群职责", body="x", visibility="private")],
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


def test_patch_replace_topic(store):
    store.upsert(_sample_group())
    new_section = SceneProfileSection(topic="群职责", body="新版", visibility="private")
    result = store.patch(_sample_group().scene, label=None, section=new_section, merge="replace_topic")
    assert len(result.sections) == 1
    assert result.sections[0].body == "新版"


def test_patch_append(store):
    store.upsert(_sample_group())
    new_section = SceneProfileSection(topic="群职责", body="并存", visibility="private")
    result = store.patch(_sample_group().scene, label=None, section=new_section, merge="append")
    assert len(result.sections) == 2


def test_get_friend_only_public(store):
    friend_profile = SceneProfile(
        scene=SceneIdentityFriend(friend_id="f1"),
        label="张三",
        sections=[
            SceneProfileSection(topic="职务", body="产品", visibility="public"),
            SceneProfileSection(topic="私密", body="x", visibility="private"),
        ],
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )
    store.upsert(friend_profile)
    got = store.get(friend_profile.scene, only_public=True)
    assert len(got.sections) == 1 and got.sections[0].topic == "职务"


def test_list(store):
    store.upsert(_sample_group())
    out = store.list(scene_type="group_session")
    assert len(out) == 1


def test_delete(store):
    store.upsert(_sample_group())
    deleted = store.delete(_sample_group().scene)
    assert deleted is True
    assert store.get(_sample_group().scene) is None


def test_unique_constraint_global(store):
    g1 = SceneProfile(
        scene=SceneIdentityGlobal(),
        label="A",
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )
    g2 = SceneProfile(
        scene=SceneIdentityGlobal(),
        label="B",
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )
    store.upsert(g1)
    store.upsert(g2)
    assert len(store.list()) == 1 and store.list()[0].label == "B"

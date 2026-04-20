from src.types import SceneProfile, SceneIdentityGroup


def test_scene_profile_roundtrip():
    profile = SceneProfile(
        scene=SceneIdentityGroup(channel_id="feishu", session_id="s1"),
        label="开发组群",
        abstract="开发组群摘要",
        overview="开发组群概览",
        content="Crabot 开发",
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )
    data = profile.model_dump()
    assert data["scene"]["type"] == "group_session"
    assert SceneProfile(**data).label == "开发组群"
    assert SceneProfile(**data).abstract == "开发组群摘要"
    assert SceneProfile(**data).overview == "开发组群概览"
    assert SceneProfile(**data).content == "Crabot 开发"

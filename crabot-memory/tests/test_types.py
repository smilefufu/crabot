from src.types import SceneProfile, SceneProfileSection, SceneIdentityGroup


def test_scene_profile_roundtrip():
    profile = SceneProfile(
        scene=SceneIdentityGroup(channel_id="feishu", session_id="s1"),
        label="开发组群",
        sections=[SceneProfileSection(topic="群职责", body="Crabot 开发", visibility="private")],
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )
    data = profile.model_dump()
    assert data["scene"]["type"] == "group_session"
    assert SceneProfile(**data).label == "开发组群"

from unittest.mock import AsyncMock
from types import SimpleNamespace
from src.access import MemoryAccessError, access_context, authorize_method

import httpx
import pytest

from src.config import MemoryConfig
from src.module import MemoryModule


@pytest.fixture
def module(tmp_path):
    config = MemoryConfig(admin_endpoint="http://admin.test")
    config.storage.data_dir = str(tmp_path)
    result = MemoryModule(config)
    yield result
    result.short_term_store.close()
    result.sqlite_store.close()
    result.scene_profile_store.close()
    result._lt_v2_index.close()


@pytest.mark.asyncio
async def test_http_rejects_forged_source_and_context_without_bearer(module):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=module.app), base_url="http://memory.test") as client:
        for params in [{}, {"access_context": {"actor_kind": "master_private", "memory_enabled": True}}]:
            response = await client.post("/list_entries", json={"source": "crabot-agent", "params": params})
            assert response.json()["success"] is False
            assert response.json()["error"]["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_disabled_or_ordinary_global_request_never_reaches_handler(module):
    module._lt_v2_rpc.list_entries = AsyncMock()
    module._get_stats = AsyncMock()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=module.app), base_url="http://memory.test") as client:
        for method, context in [("list_entries", {"actor_kind": "conversation", "memory_enabled": False}), ("get_stats", {"actor_kind": "conversation", "memory_enabled": True})]:
            response = await client.post(f"/{method}", headers={"Authorization": "Bearer fake"}, json={"params": {"access_context": context}})
            assert response.json()["error"]["code"] == "FORBIDDEN"
    module._lt_v2_rpc.list_entries.assert_not_called()
    module._get_stats.assert_not_called()


@pytest.mark.asyncio
async def test_valid_actor_verifies_current_bearer_before_data(module, monkeypatch):
    module._verify_caller = AsyncMock()
    context = {"actor_kind": "conversation", "memory_enabled": True}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=module.app), base_url="http://memory.test") as client:
        response = await client.post("/list_entries", headers={"Authorization": "Bearer runtime-only"}, json={"params": {"access_context": context}})
    assert response.json()["success"] is True
    assert module._verify_caller.call_count == 1
    assert module._verify_caller.call_args.args[1] == "runtime-only"


@pytest.mark.asyncio
async def test_http_write_requires_visibility_and_scopes(module):
    module._verify_caller = AsyncMock()
    context = {"actor_kind": "conversation", "memory_enabled": True}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=module.app), base_url="http://memory.test") as client:
        response = await client.post("/quick_capture", headers={"Authorization": "Bearer runtime-only"}, json={"params": {"access_context": context, "type": "fact", "brief": "x", "content": "x"}})
    assert response.json()["error"]["code"] == "INVALID_PARAMS"


@pytest.mark.asyncio
@pytest.mark.parametrize("result,expected", [
    ({"success": True, "data": {"verified": True}}, None),
    ({"success": False, "error": {"code": "FORBIDDEN", "message": "remote-secret"}}, "FORBIDDEN"),
    ({"success": False, "error": {"code": "UNKNOWN", "message": "remote-secret"}}, "SERVICE_UNAVAILABLE"),
    ([], "SERVICE_UNAVAILABLE"),
])
async def test_verification_bridge_uses_header_only_and_sanitizes_errors(module, monkeypatch, result, expected):
    requests = []
    class Client:
        def __init__(self, **kwargs):
            assert kwargs["trust_env"] is False
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def post(self, url, **kwargs):
            requests.append((url, kwargs))
            return SimpleNamespace(json=lambda: result, is_success=True)
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    module.config.admin_endpoint = "http://admin-fixture"
    context = access_context({"access_context": {"actor_kind": "master_private", "memory_enabled": True}})
    if expected:
        with pytest.raises(MemoryAccessError) as error:
            await module._verify_caller(context, "header-only-bearer")
        assert error.value.code == expected
        assert "remote-secret" not in str(error.value)
        assert error.value.retryable == (expected == "SERVICE_UNAVAILABLE")
    else:
        await module._verify_caller(context, "header-only-bearer")
    _, request = requests[0]
    assert request["headers"] == {"Authorization": "Bearer header-only-bearer"}
    assert "header-only-bearer" not in str(request["json"])
    assert request["json"]["params"] == {"caller_kind": "core_agent"}


def test_actor_method_closures_and_scene_are_enforced():
    for actor, method in [("conversation", "export_memories"), ("master_private", "restore_memory"),
                          ("builtin_reflection", "import_long_term"), ("builtin_graph_rebuild", "delete_memory"),
                          ("mechanical", "get_memory")]:
        with pytest.raises(MemoryAccessError) as error:
            authorize_method(method, {"access_context": {"actor_kind": actor, "memory_enabled": True}})
        assert error.value.code == "FORBIDDEN"
    with pytest.raises(MemoryAccessError):
        authorize_method("get_scene_profile", {"scene": {"type": "friend", "friend_id": "other"},
            "access_context": {"actor_kind": "conversation", "memory_enabled": True, "scene": {"type": "friend", "friend_id": "self"}}})


@pytest.mark.asyncio
async def test_private_ordinary_memory_cannot_be_summarized_into_friend_profile(module):
    admin = {"actor_kind": "admin", "memory_enabled": True}
    await module._lt_v2_rpc.quick_capture({"id": "private", "type": "fact", "brief": "private", "content": "private",
        "visibility": "private", "scopes": [], "access_context": admin})
    scene = {"type": "friend", "friend_id": "self"}
    ordinary = {"actor_kind": "conversation", "memory_enabled": True, "scene": scene}
    payload = {"scene": scene, "label": "self", "content": "summary", "source_memory_ids": ["private"]}
    with pytest.raises(MemoryAccessError):
        await module._dispatch("upsert_scene_profile", {**payload, "access_context": ordinary})
    await module._dispatch("upsert_scene_profile", {**payload, "access_context": admin})
    assert await module._dispatch("get_scene_profile", {"scene": scene, "access_context": ordinary}) == {"profile": None}


def master_request_context():
    return {"actor_kind": "master_request", "memory_enabled": True,
        "scene": {"type": "group_session", "channel_id": "voice", "session_id": "shared"},
        "request": {"request_id": "a" * 64, "source": {
            "source_id": "11111111-1111-4111-8111-111111111111", "channel_id": "voice", "session_id": "shared", "session_type": "group",
            "platform_message_id": "synthetic-message", "platform_user_id": "speaker-a", "sender_friend_id": "actual-a"}}}


def test_master_request_requires_exact_original_group_and_does_not_change_other_actors():
    import copy
    valid = master_request_context()
    assert authorize_method("get_memory", {"access_context": valid}).actor_kind == "master_request"
    for change in [lambda c: c.pop("request"), lambda c: c["request"].update(request_id="not-a-hash"),
        lambda c: c["request"]["source"].update(sender_friend_id=None), lambda c: c["request"]["source"].update(session_type="private"),
        lambda c: c.update(scene={"type": "friend", "friend_id": "actual-a"}), lambda c: c["scene"].update(session_id="other"),
        lambda c: c["request"].update(role="master"), lambda c: c.update(actor_kind="conversation"), lambda c: c.update(actor_kind="master_private")]:
        candidate = copy.deepcopy(valid); change(candidate)
        with pytest.raises(MemoryAccessError) as error:
            access_context({"access_context": candidate})
        assert error.value.code == "INVALID_PARAMS"
    for method in ["export_memories", "restore_memory", "run_maintenance", "import_long_term", "migrate_historical_inbox_batch"]:
        with pytest.raises(MemoryAccessError) as error:
            authorize_method(method, {"access_context": valid})
        assert error.value.code == "FORBIDDEN"


@pytest.mark.asyncio
@pytest.mark.parametrize("verified,expected", [(True, None), (False, "SERVICE_UNAVAILABLE")])
async def test_master_request_needs_new_verifier_receipt_and_header_only_credential(module, monkeypatch, verified, expected):
    captured = []
    class Client:
        def __init__(self, **kwargs):
            assert kwargs["trust_env"] is False
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def post(self, url, **kwargs):
            captured.append(kwargs)
            data = {"verified": True, **({"request_verified": True} if verified else {})}
            return SimpleNamespace(json=lambda: {"success": True, "data": data}, is_success=True)
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    context = access_context({"access_context": master_request_context()})
    if expected:
        with pytest.raises(MemoryAccessError) as error:
            await module._verify_caller(context, "only-in-header")
        assert error.value.code == expected
    else:
        await module._verify_caller(context, "only-in-header")
    request = captured[0]
    assert request["json"]["params"] == {"caller_kind": "core_agent", "master_request": master_request_context()["request"]}
    assert request["headers"] == {"Authorization": "Bearer only-in-header"}
    assert "only-in-header" not in str(request["json"])


@pytest.mark.asyncio
async def test_master_request_reads_private_ordinary_data_but_ordinary_friend_remains_limited(module):
    admin = {"actor_kind": "admin", "memory_enabled": True}
    await module._lt_v2_rpc.quick_capture({"id": "request-private-fixture", "type": "fact", "brief": "fixture", "content": "synthetic private fact",
        "visibility": "private", "scopes": [], "access_context": admin})
    module._verify_caller = AsyncMock()
    ordinary = {"actor_kind": "conversation", "memory_enabled": True, "scene": master_request_context()["scene"]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=module.app), base_url="http://memory.test") as client:
        result = await client.post("/get_memory", headers={"Authorization": "Bearer synthetic-runtime"},
            json={"params": {"id": "request-private-fixture", "include": "full", "access_context": master_request_context()}})
        assert result.json()["success"] is True
        assert "synthetic private fact" in result.json()["data"]["body"]
        limited = await client.post("/get_memory", headers={"Authorization": "Bearer synthetic-runtime"},
            json={"params": {"id": "request-private-fixture", "include": "full", "access_context": ordinary}})
        assert limited.json()["error"]["code"] == "NOT_FOUND"

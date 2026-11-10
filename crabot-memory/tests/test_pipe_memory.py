from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.access import MemoryAccessError
from src.config import MemoryConfig
from src.module import MemoryModule


@pytest.fixture
def module(tmp_path):
    config = MemoryConfig(admin_endpoint="http://localhost:24001")
    config.storage.data_dir = str(tmp_path)
    rpc = SimpleNamespace(call=AsyncMock(return_value={"verified": True}), close=lambda: None)
    result = MemoryModule(config, rpc=rpc)
    yield result
    result.short_term_store.close()
    result.sqlite_store.close()
    result.scene_profile_store.close()
    result._lt_v2_index.close()


@pytest.mark.asyncio
async def test_pipe_keeps_actor_and_bearer_checks_before_records(module):
    for params in [{}, {"access_context": {"actor_kind": "master_private", "memory_enabled": True}}]:
        with pytest.raises(MemoryAccessError) as error:
            await module.handle_call("list_entries", params)
        assert error.value.code == "UNAUTHORIZED"
    module.rpc.call.assert_not_called()


@pytest.mark.asyncio
async def test_pipe_verifies_metadata_separately_and_uses_real_store(module):
    context = {"actor_kind": "master_private", "memory_enabled": True}
    result = await module.handle_call("list_entries", {"access_context": context}, "runtime-only")
    assert result["items"] == []
    args = module.rpc.call.call_args
    assert args.args == (24001, "verify_memory_access", {"caller_kind": "core_agent"})
    assert args.kwargs["authorization_bearer"] == "runtime-only"
    assert "runtime-only" not in str(args.args)


@pytest.mark.asyncio
async def test_pipe_ordinary_actor_still_cannot_use_admin_methods(module):
    with pytest.raises(MemoryAccessError) as error:
        await module.handle_call("get_stats", {"access_context": {"actor_kind": "conversation", "memory_enabled": True}}, "runtime-only")
    assert error.value.code == "FORBIDDEN"
    module.rpc.call.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure, expected", [("forbidden", "FORBIDDEN"), ("transport", "SERVICE_UNAVAILABLE"), ("receipt", "SERVICE_UNAVAILABLE")])
async def test_pipe_verifier_failure_is_closed_and_sanitized(module, failure, expected):
    from src.pipe_rpc import PipeRpcError
    if failure == "forbidden":
        module.rpc.call.side_effect = PipeRpcError("FORBIDDEN", "remote-secret")
    elif failure == "transport":
        module.rpc.call.side_effect = OSError("remote-secret")
    else:
        module.rpc.call.return_value = {"verified": False}
    with pytest.raises(MemoryAccessError) as error:
        await module.handle_call("list_entries", {"access_context": {"actor_kind": "master_private", "memory_enabled": True}}, "runtime-only")
    assert error.value.code == expected
    assert "remote-secret" not in str(error.value)
    assert error.value.retryable == (expected == "SERVICE_UNAVAILABLE")

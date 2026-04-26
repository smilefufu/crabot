"""verify module._dispatch routes phase 3 RPCs to LongTermV2Rpc."""
import pytest
from src.module import MemoryModule
from src.config import MemoryConfig


def _module(tmp_path) -> MemoryModule:
    config = MemoryConfig()
    config.storage.data_dir = str(tmp_path)
    mod = MemoryModule(config)
    # Disable embedder on the v2 RPC so tests don't need a live embedding API.
    # This matches the pattern used in test_rpc_phase3.py (embedder=None).
    mod._lt_v2_rpc.embedder = None
    mod._lt_v2_rpc.pipeline.embedder = None
    return mod


@pytest.mark.asyncio
async def test_dispatch_quick_capture(tmp_path):
    mod = _module(tmp_path)
    out = await mod._dispatch("quick_capture", {
        "type": "fact", "brief": "x", "content": "y",
        "source_ref": {"type": "manual"}, "entities": [], "tags": [],
        "importance_factors": {"proximity": 0.5, "surprisal": 0.5,
                               "entity_priority": 0.5, "unambiguity": 0.5},
    })
    assert out["status"] == "ok"


@pytest.mark.asyncio
async def test_dispatch_run_maintenance(tmp_path):
    mod = _module(tmp_path)
    out = await mod._dispatch("run_maintenance", {"scope": "all"})
    assert "report" in out


@pytest.mark.asyncio
async def test_dispatch_evolution(tmp_path):
    mod = _module(tmp_path)
    out = await mod._dispatch("get_evolution_mode", {})
    assert out["mode"] == "balanced"


@pytest.mark.asyncio
async def test_dispatch_snapshot(tmp_path):
    mod = _module(tmp_path)
    out = await mod._dispatch("get_confirmed_snapshot", {})
    assert "snapshot_id" in out

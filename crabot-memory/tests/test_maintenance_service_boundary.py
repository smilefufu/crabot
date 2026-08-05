"""Memory maintenance event-loop isolation and gate regressions."""

import asyncio
import shutil
import tempfile
import threading

import pytest
import httpx

import src.module as module_impl
from src.config import load_config
from src.module import MaintenanceInProgressError, MemoryModule, MemoryShuttingDownError


@pytest.fixture
async def memory_module():
    config = load_config("config.yaml")
    config.port = 19998
    tmp_dir = tempfile.mkdtemp(prefix="crabot-memory-maintenance-test-")
    config.storage.data_dir = tmp_dir
    config.llm.api_key = "test-key"
    config.llm.base_url = "http://localhost:11434/v1"
    config.llm.model = "test-model"

    module = MemoryModule(config)

    async def _extract_keywords(text: str):
        return ["kw"] if text else []

    module.llm_client.extract_keywords = _extract_keywords

    yield module

    if module._maintenance_task is not None:
        await asyncio.gather(asyncio.shield(module._maintenance_task), return_exceptions=True)
    if module._shutdown_task is not None:
        await asyncio.gather(asyncio.shield(module._shutdown_task), return_exceptions=True)
    module.short_term_store.close()
    module.sqlite_store.close()
    module.scene_profile_store.close()
    module._lt_v2_index.close()
    shutil.rmtree(tmp_dir, ignore_errors=True)


async def _wait_for_thread(event: threading.Event) -> None:
    for _ in range(100):
        if event.is_set():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("maintenance worker did not start")


@pytest.mark.asyncio
async def test_blocked_maintenance_keeps_allow_list_responsive(memory_module, monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def blocking_worker(_params):
        started.set()
        assert release.wait(timeout=5)
        return {"report": {"completed_at": "2026-08-04T00:00:00Z"}}

    monkeypatch.setattr(memory_module, "_run_maintenance_worker", blocking_worker)
    maintenance = asyncio.create_task(memory_module._dispatch("run_maintenance", {"scope": "all"}))
    await _wait_for_thread(started)

    heartbeat = asyncio.create_task(asyncio.sleep(0, result="alive"))
    assert await asyncio.wait_for(heartbeat, timeout=0.5) == "alive"

    health = await asyncio.wait_for(memory_module._dispatch("health", {}), timeout=0.5)
    assert health == {
        "status": "degraded",
        "details": {"maintenance_running": True},
    }
    assert (await asyncio.wait_for(memory_module._dispatch("get_status", {}), timeout=0.5))["configured"] is True

    write = await asyncio.wait_for(
        memory_module._dispatch(
            "write_short_term",
            {"content": "maintenance-safe", "source": {"type": "system"}},
        ),
        timeout=0.5,
    )
    assert write["memory"]["content"] == "maintenance-safe"
    assert (await asyncio.wait_for(
        memory_module._dispatch("search_short_term", {"query": "maintenance-safe", "limit": 5}),
        timeout=0.5,
    ))["results"]
    assert (await asyncio.wait_for(
        memory_module._dispatch(
            "batch_write_short_term",
            {"entries": [{"content": "batch-safe", "source": {"type": "system"}}]},
        ),
        timeout=0.5,
    ))["success_count"] == 1

    shutdown = await asyncio.wait_for(memory_module._dispatch("shutdown", {}), timeout=0.5)
    assert shutdown == {}

    release.set()
    await maintenance


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "method",
    [
        "run_maintenance",
        "search_long_term",
        "get_stats",
        "get_reflection_watermark",
        "get_scene_profile",
        "export_memories",
    ],
)
async def test_maintenance_gate_rejects_every_non_allow_list_rpc(memory_module, monkeypatch, method):
    started = threading.Event()
    release = threading.Event()

    def blocking_worker(_params):
        started.set()
        assert release.wait(timeout=5)
        return {"report": {"completed_at": "2026-08-04T00:00:00Z"}}

    monkeypatch.setattr(memory_module, "_run_maintenance_worker", blocking_worker)
    maintenance = asyncio.create_task(memory_module._dispatch("run_maintenance", {"scope": "all"}))
    await _wait_for_thread(started)

    with pytest.raises(MaintenanceInProgressError) as exc:
        await asyncio.wait_for(memory_module._dispatch(method, {}), timeout=0.5)
    assert exc.value.code == "MEMORY_MAINTENANCE_IN_PROGRESS"
    assert exc.value.retryable is True

    release.set()
    await maintenance


@pytest.mark.asyncio
async def test_cancelling_waiter_does_not_release_gate(memory_module, monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def blocking_worker(_params):
        started.set()
        assert release.wait(timeout=5)
        return {"report": {"completed_at": "2026-08-04T00:00:00Z"}}

    monkeypatch.setattr(memory_module, "_run_maintenance_worker", blocking_worker)
    waiter = asyncio.create_task(memory_module._dispatch("run_maintenance", {"scope": "all"}))
    await _wait_for_thread(started)

    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter

    assert memory_module._maintenance_running is True
    with pytest.raises(MaintenanceInProgressError):
        await memory_module._dispatch("run_maintenance", {"scope": "all"})

    release.set()
    assert memory_module._maintenance_task is not None
    await asyncio.shield(memory_module._maintenance_task)
    await asyncio.sleep(0)
    assert memory_module._maintenance_running is False

    monkeypatch.setattr(
        memory_module,
        "_run_maintenance_worker",
        lambda _params: {"report": {"completed_at": "2026-08-04T00:00:01Z"}},
    )
    result = await memory_module._dispatch("run_maintenance", {"scope": "all"})
    assert result["report"]["completed_at"] == "2026-08-04T00:00:01Z"


@pytest.mark.asyncio
@pytest.mark.parametrize("should_fail", [False, True])
async def test_worker_owns_and_closes_its_store_and_index(memory_module, monkeypatch, should_fail):
    created = {}

    class WorkerStore:
        def __init__(self, path):
            self.path = path
            created["store"] = self

    class WorkerIndex:
        def __init__(self, path):
            self.path = path
            self.closed = False
            created["index"] = self

        def close(self):
            self.closed = True

    def fake_run(store, index, params):
        assert store is created["store"]
        assert index is created["index"]
        assert store is not memory_module._lt_v2_store
        assert index is not memory_module._lt_v2_index
        if should_fail:
            raise RuntimeError("maintenance failed")
        return {"report": {"completed_at": "2026-08-04T00:00:00Z"}}

    monkeypatch.setattr(module_impl, "LongTermV2Store", WorkerStore)
    monkeypatch.setattr(module_impl, "LongTermV2Index", WorkerIndex)
    monkeypatch.setattr(module_impl, "run_maintenance_sync", fake_run)

    if should_fail:
        with pytest.raises(RuntimeError, match="maintenance failed"):
            await memory_module._dispatch("run_maintenance", {"scope": "all"})
    else:
        await memory_module._dispatch("run_maintenance", {"scope": "all"})

    assert created["index"].closed is True
    assert memory_module._maintenance_running is False


@pytest.mark.asyncio
async def test_pre_admitted_long_term_rpc_drains_before_worker_starts(memory_module, monkeypatch):
    rpc_admitted = asyncio.Event()
    release_rpc = asyncio.Event()
    worker_started = threading.Event()
    release_worker = threading.Event()

    async def slow_long_term(_params):
        rpc_admitted.set()
        await release_rpc.wait()
        return {"results": []}

    def worker(_params):
        worker_started.set()
        assert release_worker.wait(timeout=5)
        return {"report": {"completed_at": "2026-08-04T00:00:00Z"}}

    monkeypatch.setattr(memory_module._lt_v2_rpc, "search_long_term", slow_long_term)
    monkeypatch.setattr(memory_module, "_run_maintenance_worker", worker)

    admitted = asyncio.create_task(memory_module._dispatch("search_long_term", {"query": "q"}))
    await asyncio.wait_for(rpc_admitted.wait(), timeout=0.5)
    maintenance = asyncio.create_task(memory_module._dispatch("run_maintenance", {"scope": "all"}))
    await asyncio.sleep(0.05)

    assert memory_module._maintenance_running is True
    assert worker_started.is_set() is False
    with pytest.raises(MaintenanceInProgressError):
        await memory_module._dispatch("get_stats", {})

    release_rpc.set()
    await admitted
    await _wait_for_thread(worker_started)
    release_worker.set()
    await maintenance


@pytest.mark.asyncio
async def test_shutdown_rejects_new_maintenance_and_waits_current_worker(memory_module, monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def worker(_params):
        started.set()
        assert release.wait(timeout=5)
        return {"report": {"completed_at": "2026-08-04T00:00:00Z"}}

    monkeypatch.setattr(memory_module, "_run_maintenance_worker", worker)
    maintenance = asyncio.create_task(memory_module._dispatch("run_maintenance", {"scope": "all"}))
    await _wait_for_thread(started)
    assert await memory_module._dispatch("shutdown", {}) == {}

    with pytest.raises(MemoryShuttingDownError):
        await memory_module._dispatch("run_maintenance", {"scope": "all"})

    release.set()
    await maintenance
    assert memory_module._shutdown_task is not None
    await asyncio.wait_for(memory_module._shutdown_task, timeout=1)
    assert (await memory_module._health({}))["status"] == "unhealthy"


@pytest.mark.asyncio
async def test_http_maintenance_conflict_uses_standard_error_details(memory_module):
    memory_module._maintenance_running = True
    transport = httpx.ASGITransport(app=memory_module.app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://memory") as client:
            response = await client.post(
                "/get_stats",
                json={"id": "req-1", "params": {}},
            )
    finally:
        memory_module._maintenance_running = False

    assert response.status_code == 503
    payload = response.json()
    assert payload["success"] is False
    assert payload["error"] == {
        "code": "MEMORY_MAINTENANCE_IN_PROGRESS",
        "message": "Long-term memory maintenance is in progress",
        "details": {"retryable": True},
    }


@pytest.mark.asyncio
async def test_health_never_queries_sqlite_counts(memory_module, monkeypatch):
    monkeypatch.setattr(
        memory_module.short_term_store,
        "get_short_term_count",
        lambda: (_ for _ in ()).throw(AssertionError("short-term count queried")),
    )
    monkeypatch.setattr(
        memory_module._lt_v2_index,
        "count_entries",
        lambda: (_ for _ in ()).throw(AssertionError("long-term count queried")),
    )

    assert await memory_module._health({}) == {
        "status": "healthy",
        "details": {"maintenance_running": False},
    }

"""mark_observation_pass / extend_observation_window RPC 端到端测试。"""
import pytest
from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, Observation,
)
from src.long_term_v2.paths import entry_path


def _seed_pending_rule(store, index, mid="mem-l-g1"):
    fm = MemoryFrontmatter(
        id=mid, type="lesson", maturity="rule",
        brief="b", author="agent:reflect",
        source_ref=SourceRef(type="reflection"),
        source_trust=3, content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-01T00:00:00Z",
        ingestion_time="2026-04-01T00:00:00Z",
        observation=Observation(
            started_at="2026-04-01T00:00:00Z",
            window_days=7,
            outcome="pending",
        ),
    )
    e = MemoryEntry(frontmatter=fm, body="rule body")
    store.write(e, status="confirmed")
    index.upsert(e, path=entry_path(store.data_root, "confirmed", "lesson", mid), status="confirmed")
    return mid


def _seed_no_observation(store, index, mid="mem-f-1"):
    fm = MemoryFrontmatter(
        id=mid, type="fact", maturity="observed",
        brief="b", author="system",
        source_ref=SourceRef(type="manual"),
        source_trust=3, content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-01T00:00:00Z",
        ingestion_time="2026-04-01T00:00:00Z",
    )
    e = MemoryEntry(frontmatter=fm, body="")
    store.write(e, status="confirmed")
    index.upsert(e, path=entry_path(store.data_root, "confirmed", "fact", mid), status="confirmed")
    return mid


@pytest.mark.asyncio
async def test_mark_observation_pass_updates_both_index_and_frontmatter(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    rpc = LongTermV2Rpc(store=store, index=index)
    mid = _seed_pending_rule(store, index)
    res = await rpc.mark_observation_pass({"id": mid})
    assert res["status"] == "ok"
    assert res["id"] == mid
    row = index.get_row(mid)
    assert row["observation_outcome"] == "pass"
    reread = store.read("confirmed", "lesson", mid)
    assert reread.frontmatter.observation.outcome == "pass"


@pytest.mark.asyncio
async def test_extend_observation_window_default_7_days(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    rpc = LongTermV2Rpc(store=store, index=index)
    mid = _seed_pending_rule(store, index)
    res = await rpc.extend_observation_window({"id": mid})
    assert res["new_window_days"] == 14
    row = index.get_row(mid)
    assert row["observation_window_days"] == 14


@pytest.mark.asyncio
async def test_extend_observation_window_custom_days(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    rpc = LongTermV2Rpc(store=store, index=index)
    mid = _seed_pending_rule(store, index)
    res = await rpc.extend_observation_window({"id": mid, "days": 3})
    assert res["new_window_days"] == 10


@pytest.mark.asyncio
async def test_extend_observation_window_rejects_nonpositive_days(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    rpc = LongTermV2Rpc(store=store, index=index)
    mid = _seed_pending_rule(store, index)
    with pytest.raises(ValueError, match="positive"):
        await rpc.extend_observation_window({"id": mid, "days": 0})
    with pytest.raises(ValueError, match="positive"):
        await rpc.extend_observation_window({"id": mid, "days": -3})


@pytest.mark.asyncio
async def test_mark_observation_pass_missing_entry(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    rpc = LongTermV2Rpc(store=store, index=index)
    with pytest.raises(ValueError, match="not found"):
        await rpc.mark_observation_pass({"id": "mem-missing-1"})


@pytest.mark.asyncio
async def test_mark_observation_pass_no_observation(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    rpc = LongTermV2Rpc(store=store, index=index)
    mid = _seed_no_observation(store, index)
    with pytest.raises(ValueError, match="no observation"):
        await rpc.mark_observation_pass({"id": mid})


@pytest.mark.asyncio
async def test_extend_observation_window_missing_entry_and_no_observation(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    rpc = LongTermV2Rpc(store=store, index=index)
    with pytest.raises(ValueError, match="not found"):
        await rpc.extend_observation_window({"id": "mem-missing-2", "days": 3})
    mid = _seed_no_observation(store, index)
    with pytest.raises(ValueError, match="no observation"):
        await rpc.extend_observation_window({"id": mid, "days": 3})

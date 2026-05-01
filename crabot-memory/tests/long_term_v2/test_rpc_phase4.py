"""Phase 4 RPC tests: list_entries / restore_memory."""
import pytest
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.rpc import LongTermV2Rpc


_BASE_PARAMS = {
    "source_ref": {"type": "manual"},
    "source_trust": 5,
    "content_confidence": 5,
    "importance_factors": {
        "proximity": 0.5, "surprisal": 0.5,
        "entity_priority": 0.5, "unambiguity": 0.5,
    },
    "event_time": "2026-04-23T10:00:00Z",
}


@pytest.fixture
def rpc(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    return LongTermV2Rpc(store=store, index=idx)


def _write_payload(**overrides):
    payload = {
        "type": "fact",
        "brief": "default brief",
        "content": "default content",
        "author": "user",
        **_BASE_PARAMS,
    }
    payload.update(overrides)
    return payload


@pytest.mark.asyncio
async def test_list_entries_returns_written_entry(rpc):
    w = await rpc.write_long_term(_write_payload(brief="alpha"))
    res = await rpc.list_entries({})
    assert res["total"] == 1
    assert res["items"][0]["id"] == w["id"]
    assert res["items"][0]["brief"] == "alpha"
    assert res["items"][0]["status"] == "inbox"
    assert res["items"][0]["type"] == "fact"
    assert "frontmatter" in res["items"][0]


@pytest.mark.asyncio
async def test_list_entries_filters_by_type(rpc):
    await rpc.write_long_term(_write_payload(brief="A", type="fact"))
    await rpc.write_long_term(_write_payload(brief="B", type="lesson"))
    res = await rpc.list_entries({"type": "lesson"})
    assert res["total"] == 1
    assert res["items"][0]["type"] == "lesson"


@pytest.mark.asyncio
async def test_list_entries_filters_by_status(rpc):
    await rpc.write_long_term(_write_payload(brief="inboxed", status="inbox"))
    await rpc.write_long_term(_write_payload(brief="confirmed", status="confirmed"))
    res = await rpc.list_entries({"status": "confirmed"})
    assert res["total"] == 1
    assert res["items"][0]["brief"] == "confirmed"


@pytest.mark.asyncio
async def test_list_entries_filters_by_tags(rpc):
    await rpc.write_long_term(_write_payload(brief="taggedX", tags=["#x"]))
    await rpc.write_long_term(_write_payload(brief="taggedY", tags=["#y"]))
    res = await rpc.list_entries({"tags": ["#x"]})
    assert res["total"] == 1
    assert res["items"][0]["brief"] == "taggedX"


@pytest.mark.asyncio
async def test_list_entries_filters_by_author(rpc):
    await rpc.write_long_term(_write_payload(brief="byUser", author="user"))
    await rpc.write_long_term(_write_payload(brief="bySystem", author="system"))
    res = await rpc.list_entries({"author": "system"})
    assert res["total"] == 1
    assert res["items"][0]["brief"] == "bySystem"


@pytest.mark.asyncio
async def test_list_entries_pagination(rpc):
    for i in range(5):
        await rpc.write_long_term(_write_payload(brief=f"e{i}"))
    page1 = await rpc.list_entries({"limit": 2, "offset": 0})
    page2 = await rpc.list_entries({"limit": 2, "offset": 2})
    assert page1["total"] == 2
    assert page2["total"] == 2
    page1_ids = {it["id"] for it in page1["items"]}
    page2_ids = {it["id"] for it in page2["items"]}
    assert page1_ids.isdisjoint(page2_ids)


@pytest.mark.asyncio
async def test_restore_memory_round_trip(rpc):
    w = await rpc.write_long_term(_write_payload(brief="to-restore"))
    mem_id = w["id"]
    # Move to trash
    await rpc.delete_memory({"id": mem_id})
    g = await rpc.get_memory({"id": mem_id})
    assert g["status"] == "trash"
    # Restore
    res = await rpc.restore_memory({"id": mem_id})
    assert res["status"] == "ok"
    assert res["id"] == mem_id
    # Should be in inbox now
    g2 = await rpc.get_memory({"id": mem_id})
    assert g2["status"] == "inbox"


@pytest.mark.asyncio
async def test_restore_memory_not_found(rpc):
    res = await rpc.restore_memory({"id": "mem-l-doesnotexist"})
    assert res.get("error") == "not found"


@pytest.mark.asyncio
async def test_restore_memory_not_in_trash(rpc):
    w = await rpc.write_long_term(_write_payload(brief="not-in-trash"))
    res = await rpc.restore_memory({"id": w["id"]})
    assert res.get("error") == "not in trash"

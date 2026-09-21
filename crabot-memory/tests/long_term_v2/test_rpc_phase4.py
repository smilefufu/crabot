"""Phase 4 RPC tests: list_entries / restore_memory."""
import pytest
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.schema import MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors
from src.long_term_v2.paths import entry_path


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


def _seed_entry(rpc, mem_id, brief, *, status, ingestion_time):
    fm = MemoryFrontmatter(
        id=mem_id,
        type="fact",
        maturity="observed",
        brief=brief,
        author="user",
        source_ref=SourceRef(type="manual"),
        source_trust=5,
        content_confidence=5,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-23T10:00:00Z",
        ingestion_time=ingestion_time,
    )
    entry = MemoryEntry(frontmatter=fm, body=f"body {brief}")
    rpc.store.write(entry, status=status)
    rpc.index.upsert(
        entry,
        path=entry_path(rpc.store.data_root, status, "fact", mem_id),
        status=status,
    )


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
async def test_list_entries_filters_by_ingestion_time_window(rpc):
    _seed_entry(rpc, "mem-l-before", "before", status="inbox",
                ingestion_time="2026-04-23T09:59:59Z")
    _seed_entry(rpc, "mem-l-in-window", "in-window", status="inbox",
                ingestion_time="2026-04-23T10:30:00Z")
    _seed_entry(rpc, "mem-l-confirmed", "confirmed in window", status="confirmed",
                ingestion_time="2026-04-23T10:40:00Z")

    res = await rpc.list_entries({
        "status": "inbox",
        "ingestion_time_start": "2026-04-23T10:00:00Z",
        "ingestion_time_end": "2026-04-23T11:00:00Z",
    })

    assert res["total"] == 1
    assert res["items"][0]["brief"] == "in-window"


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
async def test_reviewable_inbox_filters_legacy_before_pagination_and_keeps_old_normal_candidates(rpc):
    for i in range(5377):
        rpc.index.conn.execute(
            "INSERT INTO memories (id,status,type,brief,body,event_time,ingestion_time,path) VALUES (?,?,?,?,?,?,?,?)",
            (f"legacy-{i}", "inbox", "fact", "legacy", "original", "2026-01-01", "2026-01-01", "unused"),
        )
    rpc.index.conn.commit()
    ids = []
    for name in ["a", "b", "c"]:
        entry = await rpc.write_long_term(_write_payload(brief=name))
        ids.append(entry["id"])
        rpc.index.conn.execute("UPDATE memories SET ingestion_time=? WHERE id=?", ("2026-01-01", entry["id"]))
    rpc.index.conn.commit()
    legacy_before = rpc.index.conn.execute("SELECT * FROM memories WHERE id LIKE 'legacy-%' ORDER BY id").fetchall()
    query = {"status": "inbox", "sort": "ingestion_time_asc", "reviewable_only": True, "limit": 2}
    first = await rpc.list_entries(query)
    second = await rpc.list_entries({**query, "offset": 2})
    assert [item["id"] for item in first["items"] + second["items"]] == sorted(ids)
    assert first["total"] == 2 and second["total"] == 1
    await rpc.delete_memory({"id": first["items"][0]["id"]})
    assert [item["id"] for item in (await rpc.list_entries(query))["items"]] == sorted(ids)[1:]
    assert rpc.index.conn.execute("SELECT * FROM memories WHERE id LIKE 'legacy-%' ORDER BY id").fetchall() == legacy_before


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [None, "confirmed", "trash"])
async def test_reviewable_inbox_requires_explicit_inbox_status(rpc, status):
    with pytest.raises(ValueError, match="reviewable_only"):
        await rpc.list_entries({"status": status, "reviewable_only": True})


@pytest.mark.asyncio
async def test_reviewable_inbox_excludes_empty_field_but_default_keeps_legacy(rpc):
    _seed_entry(rpc, "mem-l-old", "legacy", status="inbox", ingestion_time="2026-01-01")
    normal = await rpc.write_long_term(_write_payload(brief="normal"))
    rpc.index.conn.execute("UPDATE memories SET inbox_entered_at='' WHERE id=?", (normal["id"],))
    rpc.index.conn.commit()
    assert (await rpc.list_entries({"status": "inbox", "reviewable_only": True}))["items"] == []
    for extra in [{}, {"reviewable_only": False}]:
        assert (await rpc.list_entries({"status": "inbox", **extra}))["total"] == 2


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
    # Manual restore is explicit confirmation.
    g2 = await rpc.get_memory({"id": mem_id})
    assert g2["status"] == "confirmed"


@pytest.mark.asyncio
async def test_restore_memory_not_found(rpc):
    res = await rpc.restore_memory({"id": "mem-l-doesnotexist"})
    assert res.get("error") == "not found"


@pytest.mark.asyncio
async def test_restore_memory_not_in_trash(rpc):
    w = await rpc.write_long_term(_write_payload(brief="not-in-trash"))
    res = await rpc.restore_memory({"id": w["id"]})
    assert res.get("error") == "INVALID_STATE"

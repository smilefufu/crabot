"""keyword_search RPC：brief + body 的 LIKE 匹配，限 status=confirmed。"""
import pytest
from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors,
)
from src.long_term_v2.paths import entry_path


def _seed(store, index, mid, brief, body, status="confirmed", type_="fact"):
    if type_ == "fact":
        maturity = "observed"
    elif type_ == "lesson":
        maturity = "case"
    else:
        maturity = "confirmed"
    fm = MemoryFrontmatter(
        id=mid, type=type_, maturity=maturity,
        brief=brief, author="system",
        source_ref=SourceRef(type="manual"),
        source_trust=3, content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-01T00:00:00Z",
        ingestion_time="2026-04-01T00:00:00Z",
    )
    e = MemoryEntry(frontmatter=fm, body=body)
    store.write(e, status=status)
    index.upsert(e, path=entry_path(store.data_root, status, type_, mid), status=status)


@pytest.mark.asyncio
async def test_keyword_search_matches_brief(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    rpc = LongTermV2Rpc(store=store, index=index)
    _seed(store, index, "m1", brief="macOS 终端中文输入技巧", body="pbcopy + Cmd+V")
    _seed(store, index, "m2", brief="Linux 服务启动", body="systemctl start")
    r = await rpc.keyword_search({"query": "macOS"})
    ids = [x["id"] for x in r["items"]]
    assert "m1" in ids
    assert "m2" not in ids


@pytest.mark.asyncio
async def test_keyword_search_matches_body(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    rpc = LongTermV2Rpc(store=store, index=index)
    _seed(store, index, "m1", brief="终端技巧", body="pbcopy + Cmd+V")
    _seed(store, index, "m2", brief="Linux 启动", body="systemctl")
    r = await rpc.keyword_search({"query": "pbcopy"})
    ids = [x["id"] for x in r["items"]]
    assert ids == ["m1"]


@pytest.mark.asyncio
async def test_keyword_search_respects_type_filter(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    rpc = LongTermV2Rpc(store=store, index=index)
    _seed(store, index, "f1", brief="macOS 事实", body="a", type_="fact")
    _seed(store, index, "l1", brief="macOS 经验", body="b", type_="lesson")
    r = await rpc.keyword_search({"query": "macOS", "type": "fact"})
    ids = [x["id"] for x in r["items"]]
    assert ids == ["f1"]


@pytest.mark.asyncio
async def test_keyword_search_excludes_trash_by_default(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    rpc = LongTermV2Rpc(store=store, index=index)
    _seed(store, index, "good", brief="macOS ok", body="a", status="confirmed")
    _seed(store, index, "gone", brief="macOS bad", body="b", status="trash")
    r = await rpc.keyword_search({"query": "macOS"})
    ids = [x["id"] for x in r["items"]]
    assert ids == ["good"]

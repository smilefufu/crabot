"""Trash 30-day cleanup timezone boundary correctness (spec §6.5)."""
import pytest
from src.long_term_v2.maintenance import run_maintenance, MaintenanceConfig
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors,
)
from src.long_term_v2.paths import entry_path


def _seed_trash(store, index, mid, ingestion_time):
    fm = MemoryFrontmatter(
        id=mid, type="fact", maturity="confirmed",
        brief="b", author="system",
        source_ref=SourceRef(type="manual"),
        source_trust=3, content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time=ingestion_time, ingestion_time=ingestion_time,
    )
    entry = MemoryEntry(frontmatter=fm, body="")
    store.write(entry, status="trash")
    index.upsert(entry, path=entry_path(store.data_root, "trash", "fact", mid), status="trash")


def test_trash_cleanup_keeps_29_9_days_old_utc(tmp_path):
    """29.9 天前删除（UTC Z 后缀）→ 不应被清理。"""
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    # 29.9 天 = 29 天 + 21.6 小时
    _seed_trash(store, index, "t1", "2026-03-24T02:24:00Z")
    report = run_maintenance(
        store, index, scope="trash_cleanup",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z", trash_retention_days=30),
    )
    assert report["trash_cleanup"]["deleted"] == 0, "29.9 天不应被清理"
    assert index.locate("t1") is not None


def test_trash_cleanup_deletes_30_1_days_old_utc(tmp_path):
    """30.1 天前删除（UTC Z 后缀）→ 应被清理。"""
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _seed_trash(store, index, "t2", "2026-03-23T21:36:00Z")  # 30.1 天前
    report = run_maintenance(
        store, index, scope="trash_cleanup",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z", trash_retention_days=30),
    )
    assert report["trash_cleanup"]["deleted"] == 1
    assert index.locate("t2") is None


def test_trash_cleanup_handles_plus_08_offset(tmp_path):
    """+08:00 时区的 ingestion_time → 必须正确转 UTC 比较。

    +08:00 的 2026-04-01T08:00:00 == UTC 2026-04-01T00:00:00
    距 2026-04-23T00:00:00Z 是 22 天 → 不应清理（< 30 天）
    """
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _seed_trash(store, index, "t3", "2026-04-01T08:00:00+08:00")
    report = run_maintenance(
        store, index, scope="trash_cleanup",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z", trash_retention_days=30),
    )
    assert report["trash_cleanup"]["deleted"] == 0
    assert index.locate("t3") is not None


def test_trash_cleanup_handles_minus_05_offset(tmp_path):
    """-05:00 时区 → 同样必须正确转 UTC。

    -05:00 的 2026-03-23T19:00:00 == UTC 2026-03-24T00:00:00
    距 2026-04-23T00:00:00Z 正好 30 天 → 边界，cutoff 严格小于 → 不应清理
    """
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _seed_trash(store, index, "t4", "2026-03-23T19:00:00-05:00")
    report = run_maintenance(
        store, index, scope="trash_cleanup",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z", trash_retention_days=30),
    )
    # 严格小于：30 天整不删
    assert report["trash_cleanup"]["deleted"] == 0
    assert index.locate("t4") is not None


def test_trash_cleanup_mixed_timezones_only_picks_truly_old(tmp_path):
    """混合时区一起塞 → 只清理真正 ≥30 天的。"""
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _seed_trash(store, index, "old_z", "2026-01-01T00:00:00Z")              # ~113 天前 → 删
    _seed_trash(store, index, "old_plus8", "2026-01-01T08:00:00+08:00")     # 同 UTC → 删
    _seed_trash(store, index, "fresh_minus5", "2026-04-22T19:00:00-05:00")  # ~1 天前 → 留
    _seed_trash(store, index, "fresh_z", "2026-04-22T00:00:00Z")            # ~1 天前 → 留
    report = run_maintenance(
        store, index, scope="trash_cleanup",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z", trash_retention_days=30),
    )
    assert report["trash_cleanup"]["deleted"] == 2
    assert index.locate("old_z") is None
    assert index.locate("old_plus8") is None
    assert index.locate("fresh_minus5") is not None
    assert index.locate("fresh_z") is not None

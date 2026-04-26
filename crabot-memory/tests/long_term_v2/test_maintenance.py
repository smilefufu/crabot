"""维护流程：observation_check / stale_aging / trash_cleanup。"""
import pytest
from datetime import datetime, timedelta
from src.long_term_v2.maintenance import run_maintenance, MaintenanceConfig
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, Observation,
)
from src.long_term_v2.paths import entry_path


def _write(store, index, mid, type_, maturity, status, **fm_extra):
    defaults = dict(
        id=mid, type=type_, maturity=maturity,
        brief="b", author="system",
        source_ref=SourceRef(type="manual"),
        source_trust=3, content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-01T00:00:00Z",
        ingestion_time="2026-04-01T00:00:00Z",
    )
    defaults.update(fm_extra)
    fm = MemoryFrontmatter(**defaults)
    entry = MemoryEntry(frontmatter=fm, body="")
    store.write(entry, status=status)
    index.upsert(entry, path=entry_path(store.data_root, status, type_, mid), status=status)
    return entry


def test_observation_pass_keeps_confirmed(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _write(store, index, "f1", "fact", "confirmed", "confirmed",
           observation=Observation(started_at="2026-04-01T00:00:00Z", window_days=7,
                             outcome="pending"))
    # Phase A (2026-04-25): 触发 pass 分支需要净值 > 0
    index.bump_observation_counter("f1", column="observation_pass_count", delta=1)
    report = run_maintenance(
        store, index, scope="observation_check",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z"),
    )
    assert report["observation_check"]["passed"] >= 1
    # 状态保持 confirmed
    loc = index.locate("f1")
    assert loc[0] == "confirmed"


def test_observation_fail_rolls_back_to_inbox(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _write(store, index, "f2", "fact", "confirmed", "confirmed",
           observation=Observation(started_at="2026-04-01T00:00:00Z", window_days=7,
                             outcome="pending"))
    # Phase A (2026-04-25): 触发 fail 分支需要净值 < 0
    index.bump_observation_counter("f2", column="observation_fail_count", delta=1)
    report = run_maintenance(
        store, index, scope="observation_check",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z"),
    )
    assert report["observation_check"]["rolled_back"] >= 1
    loc = index.locate("f2")
    assert loc[0] == "inbox"


def test_stale_aging_marks_stale_facts(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _write(store, index, "f3", "fact", "confirmed", "confirmed",
           ingestion_time="2025-01-01T00:00:00Z")  # 老 fact
    report = run_maintenance(
        store, index, scope="stale_aging",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z", stale_idle_days=180),
    )
    assert report["stale_aging"]["marked_stale"] >= 1
    # maturity 改为 stale
    entry = store.read("confirmed", "fact", "f3")
    assert entry.frontmatter.maturity == "stale"


def test_trash_cleanup_removes_old_entries(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _write(store, index, "f4", "fact", "confirmed", "trash",
           ingestion_time="2025-01-01T00:00:00Z")
    report = run_maintenance(
        store, index, scope="trash_cleanup",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z", trash_retention_days=30),
    )
    assert report["trash_cleanup"]["deleted"] >= 1
    assert index.locate("f4") is None


def test_observation_pending_extends_observation_window(tmp_path):
    """outcome=None (pending) → 延长观察周期，stale_check_count+1，状态保持。"""
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _write(store, index, "p1", "fact", "confirmed", "confirmed",
           observation=Observation(started_at="2026-04-01T00:00:00Z", window_days=7,
                             outcome="pending", stale_check_count=0))
    report = run_maintenance(
        store, index, scope="observation_check",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z"),
    )
    assert report["observation_check"]["pending_extended"] == 1
    # 状态保持 confirmed
    loc = index.locate("p1")
    assert loc[0] == "confirmed"
    entry = store.read("confirmed", "fact", "p1")
    assert entry.frontmatter.observation.stale_check_count == 1
    # promoted_at 推进到 now，下个观察期重新计时
    assert entry.frontmatter.observation.started_at == "2026-04-23T00:00:00Z"
    # 还未到 stale 阈值
    assert entry.frontmatter.maturity != "stale"


def test_observation_pending_three_cycles_marks_stale(tmp_path):
    """连续 3 个观察周期 pending → maturity=stale。"""
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _write(store, index, "p2", "fact", "confirmed", "confirmed",
           observation=Observation(started_at="2026-04-01T00:00:00Z", window_days=7,
                             outcome="pending", stale_check_count=2))
    report = run_maintenance(
        store, index, scope="observation_check",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z"),
    )
    assert report["observation_check"]["pending_extended"] == 1
    entry = store.read("confirmed", "fact", "p2")
    assert entry.frontmatter.observation.stale_check_count == 3
    assert entry.frontmatter.maturity == "stale"


def test_observation_fail_resets_to_pending_with_needs_review_tag(tmp_path):
    """fail 分支：净值为负 → 回退 inbox 后 observation 重置为 pending，并打 needs_review tag。"""
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _write(store, index, "f5", "fact", "confirmed", "confirmed",
           observation=Observation(started_at="2026-04-01T00:00:00Z", window_days=7,
                             outcome="pending"))
    # Phase A (2026-04-25): 触发 fail 分支需要净值 < 0
    index.bump_observation_counter("f5", column="observation_fail_count", delta=1)
    run_maintenance(
        store, index, scope="observation_check",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z"),
    )
    entry = store.read("inbox", "fact", "f5")
    assert "needs_review" in entry.frontmatter.tags
    assert entry.frontmatter.observation.outcome == "pending"
    assert entry.frontmatter.observation.started_at == "2026-04-23T00:00:00Z"


def test_observation_window_not_expired_yet_skipped(tmp_path):
    """promoted_at + observation_window > now → observation_check 跳过该条。"""
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _write(store, index, "f6", "fact", "confirmed", "confirmed",
           observation=Observation(started_at="2026-04-22T00:00:00Z", window_days=7,
                             outcome="pending"))
    report = run_maintenance(
        store, index, scope="observation_check",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z"),
    )
    # 7 天还没到 → 不被扫描出来
    assert report["observation_check"]["passed"] == 0
    assert report["observation_check"]["rolled_back"] == 0
    assert report["observation_check"]["pending_extended"] == 0


def test_rule_rollback_preserves_source_cases_and_lesson_meta(tmp_path):
    """spec §6.4：rule 观察期 fail → 回滚到 inbox 时 source_cases / lesson_meta 不应丢失。"""
    from src.long_term_v2.schema import LessonMeta
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    cap_ids = ["cap-1", "cap-2", "cap-3"]
    _write(store, index, "g1", "lesson", "rule", "confirmed",
           lesson_meta=LessonMeta(scenario="飞书表情", outcome="success",
                                  source_cases=cap_ids, use_count=2),
           observation=Observation(started_at="2026-04-01T00:00:00Z",
                             window_days=7,
                             outcome="pending"))
    # Phase A (2026-04-25): 触发 fail 分支需要净值 < 0
    index.bump_observation_counter("g1", column="observation_fail_count", delta=1)
    run_maintenance(
        store, index, scope="observation_check",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z"),
    )
    # 已回滚到 inbox
    entry = store.read("inbox", "lesson", "g1")
    fm = entry.frontmatter
    # source_cases + lesson_meta 完整保留
    assert fm.lesson_meta is not None
    assert fm.lesson_meta.source_cases == cap_ids
    assert fm.lesson_meta.scenario == "飞书表情"
    assert fm.lesson_meta.use_count == 2
    # needs_review tag + observation reset 已由通用测试覆盖；这里再确认一次
    assert "needs_review" in fm.tags
    assert fm.observation.outcome == "pending"
    # 当前实现：maturity 不被强制改回 case（spec 未明文要求）。
    # 锁定行为：仍是 "rule"，与 status=inbox 组合标识"曾被晋升后回滚"。
    assert fm.maturity == "rule"


def test_run_maintenance_all_combines_reports(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    report = run_maintenance(
        store, index, scope="all",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z"),
    )
    assert "observation_check" in report
    assert "stale_aging" in report
    assert "trash_cleanup" in report

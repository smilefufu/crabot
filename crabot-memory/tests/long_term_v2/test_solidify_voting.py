"""Phase A: observation_check 投票净值判定测试。

Spec: 2026-04-25-self-learning-feedback-signal-design.md §10
"""
import pytest
from datetime import datetime, timedelta, timezone
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.maintenance import run_maintenance, MaintenanceConfig
from src.long_term_v2.schema import MemoryEntry, MemoryFrontmatter, Observation


def _now_iso(offset_days: int = 0) -> str:
    dt = datetime.now(timezone.utc) + timedelta(days=offset_days)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _make_lesson_in_observation(mem_id: str):
    """Make a lesson entry that's already 8 days into a 7-day observation window."""
    started_at= _now_iso(-8)
    return MemoryEntry(
        frontmatter=MemoryFrontmatter(
            id=mem_id,
            type="lesson",
            maturity="rule",
            brief="test rule",
            author="agent:test",
            source_ref={"type": "reflection"},
            source_trust=3,
            content_confidence=3,
            importance_factors={
                "proximity": 0.5,
                "surprisal": 0.5,
                "entity_priority": 0.5,
                "unambiguity": 0.5,
            },
            event_time=_now_iso(-10),
            ingestion_time=_now_iso(-10),
            observation=Observation(
                started_at=started_at,
                window_days=7,
                outcome="pending",
            ),
        ),
        body="lesson body",
    )


def _setup(tmp_path, mem_id="mem_l_1", pass_count=0, fail_count=0):
    store = MemoryStore(data_root=str(tmp_path))
    idx = SqliteIndex(str(tmp_path / "memories.db"))
    entry = _make_lesson_in_observation(mem_id)
    store.write(entry, status="confirmed")
    idx.upsert(entry, path=str(tmp_path / "x.md"), status="confirmed")
    # 直接 SQL 设置 pass/fail counts（绕过 RPC）
    idx.conn.execute(
        "UPDATE memories SET observation_pass_count = ?, observation_fail_count = ? WHERE id = ?",
        (pass_count, fail_count, mem_id),
    )
    idx.conn.commit()
    return store, idx


def test_observation_check_net_positive_passes(tmp_path):
    store, idx = _setup(tmp_path, pass_count=3, fail_count=1)
    cfg = MaintenanceConfig(now_iso=_now_iso())
    report = run_maintenance(store, idx, scope="observation_check", config=cfg)
    assert report["observation_check"]["passed"] == 1
    assert report["observation_check"]["rolled_back"] == 0


def test_observation_check_net_negative_rolls_back(tmp_path):
    store, idx = _setup(tmp_path, pass_count=1, fail_count=3)
    cfg = MaintenanceConfig(now_iso=_now_iso())
    report = run_maintenance(store, idx, scope="observation_check", config=cfg)
    assert report["observation_check"]["passed"] == 0
    assert report["observation_check"]["rolled_back"] == 1


def test_observation_check_net_zero_extends(tmp_path):
    """0:0 应该延期，不能默认 pass。"""
    store, idx = _setup(tmp_path, pass_count=0, fail_count=0)
    cfg = MaintenanceConfig(now_iso=_now_iso())
    report = run_maintenance(store, idx, scope="observation_check", config=cfg)
    assert report["observation_check"]["passed"] == 0
    assert report["observation_check"]["rolled_back"] == 0
    assert report["observation_check"]["pending_extended"] == 1


def test_observation_check_equal_pass_fail_extends(tmp_path):
    """2:2 净值 0 也应该延期。"""
    store, idx = _setup(tmp_path, pass_count=2, fail_count=2)
    cfg = MaintenanceConfig(now_iso=_now_iso())
    report = run_maintenance(store, idx, scope="observation_check", config=cfg)
    assert report["observation_check"]["pending_extended"] == 1


def test_observation_check_strong_pass_outweighs_fail(tmp_path):
    """1 strong_pass (+2) vs 1 fail (+1) → net +1 → pass。"""
    store, idx = _setup(tmp_path, pass_count=2, fail_count=1)
    cfg = MaintenanceConfig(now_iso=_now_iso())
    report = run_maintenance(store, idx, scope="observation_check", config=cfg)
    assert report["observation_check"]["passed"] == 1


def test_observation_check_lesson_stale_check_3_uses_retired(tmp_path):
    """spec §6.5 + schema 合法性：lesson 连续 3 周期 pending → maturity 必须改为 'retired'（不是 'stale'）。

    Pydantic v2 model_copy(update=…) 不跑 validator，写入会"成功"但下次 read 必崩。
    本测试验证：跑完 maintenance 后能 store.read 不抛 ValidationError。
    """
    store = MemoryStore(data_root=str(tmp_path))
    idx = SqliteIndex(str(tmp_path / "memories.db"))
    started_at= _now_iso(-8)
    entry = MemoryEntry(
        frontmatter=MemoryFrontmatter(
            id="lesson_x",
            type="lesson",
            maturity="rule",
            brief="test rule",
            author="agent:test",
            source_ref={"type": "reflection"},
            source_trust=3,
            content_confidence=3,
            importance_factors={
                "proximity": 0.5,
                "surprisal": 0.5,
                "entity_priority": 0.5,
                "unambiguity": 0.5,
            },
            event_time=_now_iso(-10),
            ingestion_time=_now_iso(-10),
            observation=Observation(
                started_at=started_at,
                window_days=7,
                outcome="pending",
                stale_check_count=2,  # 这次跑会变成 3
            ),
        ),
        body="lesson body",
    )
    store.write(entry, status="confirmed")
    idx.upsert(entry, path=str(tmp_path / "x.md"), status="confirmed")
    # net == 0（无 votes）→ extend 分支 → stale_check_count 从 2 → 3 → 触发 maturity 转换

    cfg = MaintenanceConfig(now_iso=_now_iso())
    run_maintenance(store, idx, scope="observation_check", config=cfg)

    # 关键断言：能正常 read 回来（如果 maturity 写成非法 "stale"，read 会 raise ValidationError）
    re_read = store.read("confirmed", "lesson", "lesson_x")
    # lesson 类型的合法终态是 "retired"
    assert re_read.frontmatter.maturity == "retired"


def test_observation_check_concept_stale_check_3_keeps_maturity(tmp_path):
    """concept 没有 stale 终态语义，stale_check_count >= 3 时 maturity 不改但打 tag。"""
    store = MemoryStore(data_root=str(tmp_path))
    idx = SqliteIndex(str(tmp_path / "memories.db"))
    started_at= _now_iso(-8)
    entry = MemoryEntry(
        frontmatter=MemoryFrontmatter(
            id="concept_x",
            type="concept",
            maturity="established",
            brief="test concept",
            author="agent:test",
            source_ref={"type": "reflection"},
            source_trust=3,
            content_confidence=3,
            importance_factors={
                "proximity": 0.5,
                "surprisal": 0.5,
                "entity_priority": 0.5,
                "unambiguity": 0.5,
            },
            event_time=_now_iso(-10),
            ingestion_time=_now_iso(-10),
            observation=Observation(
                started_at=started_at,
                window_days=7,
                outcome="pending",
                stale_check_count=2,
            ),
        ),
        body="concept body",
    )
    store.write(entry, status="confirmed")
    idx.upsert(entry, path=str(tmp_path / "x.md"), status="confirmed")

    cfg = MaintenanceConfig(now_iso=_now_iso())
    run_maintenance(store, idx, scope="observation_check", config=cfg)

    re_read = store.read("confirmed", "concept", "concept_x")
    assert re_read.frontmatter.maturity == "established"  # 不改
    assert "observation_stale" in re_read.frontmatter.tags   # 改用 tag 标记

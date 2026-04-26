"""Evolution mode get/set。"""
import pytest
from src.long_term_v2.evolution import (
    get_evolution_mode, set_evolution_mode, VALID_MODES,
)
from src.long_term_v2.sqlite_index import SqliteIndex


def test_default_mode_balanced(tmp_path):
    idx = SqliteIndex(str(tmp_path / "v2.db"))
    info = get_evolution_mode(idx)
    assert info["mode"] == "balanced"


def test_set_then_get(tmp_path):
    idx = SqliteIndex(str(tmp_path / "v2.db"))
    set_evolution_mode(idx, mode="harden", reason="刚摄入大量 case")
    info = get_evolution_mode(idx)
    assert info["mode"] == "harden"
    assert info["reason"] == "刚摄入大量 case"
    assert info["last_changed_at"] is not None


def test_reject_invalid_mode(tmp_path):
    idx = SqliteIndex(str(tmp_path / "v2.db"))
    with pytest.raises(ValueError):
        set_evolution_mode(idx, mode="not_a_mode", reason="x")


def test_valid_modes_constant():
    assert "balanced" in VALID_MODES
    assert "innovate" in VALID_MODES
    assert "harden" in VALID_MODES
    assert "repair-only" in VALID_MODES


def test_mode_switch_does_not_reset_use_count_or_last_seen(tmp_path):
    """切换 evolution mode 不应触碰任何 memories 行（use_count / last_seen_at 等）。

    Spec §6.6 — mode 是一个独立的全局状态机；判断依据（hit/use 比、撤销率）
    持久化在 memory entries 上，切换不应清掉判断依据。
    """
    from src.long_term_v2.schema import (
        MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, LessonMeta,
    )
    from src.long_term_v2.store import MemoryStore
    from src.long_term_v2.paths import entry_path

    store = MemoryStore(str(tmp_path / "lt"))
    idx = SqliteIndex(str(tmp_path / "v2.db"))

    fm = MemoryFrontmatter(
        id="m1", type="lesson", maturity="rule",
        brief="b", author="system",
        source_ref=SourceRef(type="manual"),
        source_trust=4, content_confidence=4,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-01T00:00:00Z",
        ingestion_time="2026-04-01T00:00:00Z",
        lesson_meta=LessonMeta(scenario="x", outcome="success", use_count=7,
                               last_validated_at="2026-04-22T10:00:00Z"),
    )
    e = MemoryEntry(frontmatter=fm, body="")
    store.write(e, status="confirmed")
    idx.upsert(e, path=entry_path(store.data_root, "confirmed", "lesson", "m1"), status="confirmed")
    idx.bump_use_count("m1", now_iso="2026-04-23T00:00:00Z")

    # 验证基线：use_count = 8, last_seen_at != null
    row_before = idx.conn.execute(
        "SELECT use_count, last_seen_at FROM memories WHERE id='m1'"
    ).fetchone()
    assert row_before["use_count"] == 8
    assert row_before["last_seen_at"] == "2026-04-23T00:00:00Z"

    # 切换 mode 三次（含相同 mode 自身）
    set_evolution_mode(idx, mode="innovate", reason="r1")
    set_evolution_mode(idx, mode="harden", reason="r2")
    set_evolution_mode(idx, mode="balanced", reason="r3")

    # use_count / last_seen_at 不应被任何 mode 切换触碰
    row_after = idx.conn.execute(
        "SELECT use_count, last_seen_at FROM memories WHERE id='m1'"
    ).fetchone()
    assert row_after["use_count"] == 8, "use_count was reset by mode switch"
    assert row_after["last_seen_at"] == "2026-04-23T00:00:00Z", \
        "last_seen_at was reset by mode switch"


def test_mode_switch_persists_reason_and_timestamp_independently(tmp_path):
    """每次切换都应更新 last_changed_at 与 reason，但相互不影响 memory 数据。"""
    idx = SqliteIndex(str(tmp_path / "v2.db"))
    set_evolution_mode(idx, mode="harden", reason="too many cases")
    info1 = get_evolution_mode(idx)

    set_evolution_mode(idx, mode="innovate", reason="error rate dropped")
    info2 = get_evolution_mode(idx)

    assert info1["mode"] == "harden"
    assert info2["mode"] == "innovate"
    assert info1["reason"] != info2["reason"]
    assert info2["last_changed_at"] >= info1["last_changed_at"]


# ---------- spec §6.2 Evolution mode 自动判定（follow-up，未实现）----------

def test_evolution_module_does_not_export_auto_detect_yet():
    """spec §6.2 注明 "Agent 自动判定" 是 follow-up，当前应只暴露 get/set 手动接口。

    此测试在 evolution.py 引入自动判定函数后会失败，提示实现者：
      - 同步更新 spec §6.2（去掉 follow-up 注记）
      - 把新函数补到 EXPECTED_FUNCS（明确地把它放进契约里）
    """
    from src.long_term_v2 import evolution as ev

    EXPECTED_FUNCS = frozenset({
        "get_evolution_mode",
        "set_evolution_mode",
        "synthesize_rule",
    })
    public_funcs = {
        n for n in dir(ev)
        if callable(getattr(ev, n)) and not n.startswith("_") and not n[0].isupper()
    }
    # 排除从 schema 导入的辅助函数
    imported = {"new_memory_id", "utc_now_iso_z", "entry_path"}
    public_funcs -= imported

    extras = public_funcs - EXPECTED_FUNCS
    assert not extras, (
        f"evolution.py 出现 spec §6.2 未声明的公开函数：{sorted(extras)}。"
        " 如果是 'Agent 自动判定' 实现，请同步更新 spec §6.2 并把函数加入 EXPECTED_FUNCS。"
    )


# ---------- synthesize_rule ----------

from src.long_term_v2.evolution import synthesize_rule
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, LessonMeta,
)
from src.long_term_v2.paths import entry_path


def _seed_case(store, index, mid):
    fm = MemoryFrontmatter(
        id=mid, type="lesson", maturity="case",
        brief=f"case {mid}", author="agent:w1",
        source_ref=SourceRef(type="reflection"),
        source_trust=3, content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-23T00:00:00Z",
        ingestion_time="2026-04-23T00:00:00Z",
        lesson_meta=LessonMeta(scenario="飞书表情", outcome="success"),
    )
    e = MemoryEntry(frontmatter=fm, body=f"case body {mid}")
    store.write(e, status="confirmed")
    index.upsert(e, path=entry_path(store.data_root, "confirmed", "lesson", mid), status="confirmed")


def test_synthesize_rule_writes_confirmed_with_observation(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _seed_case(store, index, "c1")
    _seed_case(store, index, "c2")
    _seed_case(store, index, "c3")

    rule_id = synthesize_rule(
        store=store, index=index,
        source_cases=["c1", "c2", "c3"],
        brief="飞书表情用 emoji_id",
        content="不要用图片 URL，直接传 emoji_id。",
        window_days=7,
    )
    assert rule_id.startswith("mem-l-")

    row = index.get_row(rule_id)
    assert row["status"] == "confirmed"
    assert row["type"] == "lesson"
    # maturity lives in frontmatter, not in the SQLite row
    assert row["observation_outcome"] == "pending"
    assert row["observation_window_days"] == 7

    entry = store.read("confirmed", "lesson", rule_id)
    assert entry.frontmatter.maturity == "rule"
    assert entry.frontmatter.lesson_meta.source_cases == ["c1", "c2", "c3"]


def test_synthesize_rule_rejects_empty_cases(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    # spec §6.4：至少 3 条 source_cases
    with pytest.raises(ValueError, match="至少 3 条"):
        synthesize_rule(
            store=store, index=index,
            source_cases=[],
            brief="x", content="y",
        )


def test_synthesize_rule_rejects_one_case(tmp_path):
    """spec §6.4：1 条 case 不足以晋升 rule，应拒绝。"""
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _seed_case(store, index, "c1")
    with pytest.raises(ValueError, match="至少 3 条"):
        synthesize_rule(
            store=store, index=index,
            source_cases=["c1"],
            brief="x", content="y",
        )


def test_synthesize_rule_rejects_two_cases(tmp_path):
    """spec §6.4：2 条 case 仍不足，边界值前一刻应拒绝。"""
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _seed_case(store, index, "c1")
    _seed_case(store, index, "c2")
    with pytest.raises(ValueError, match="至少 3 条"):
        synthesize_rule(
            store=store, index=index,
            source_cases=["c1", "c2"],
            brief="x", content="y",
        )


def test_synthesize_rule_accepts_exactly_three_cases(tmp_path):
    """spec §6.4 边界值 3 条 case：刚好通过。"""
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    _seed_case(store, index, "c1")
    _seed_case(store, index, "c2")
    _seed_case(store, index, "c3")
    rule_id = synthesize_rule(
        store=store, index=index,
        source_cases=["c1", "c2", "c3"],
        brief="边界测试",
        content="3 条 case 应通过门槛。",
    )
    assert rule_id
    entry = store.read("confirmed", "lesson", rule_id)
    assert entry.frontmatter.maturity == "rule"
    assert len(entry.frontmatter.lesson_meta.source_cases) == 3

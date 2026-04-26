"""Phase 3 新 RPC：quick_capture / run_maintenance / evolution / observation 等。"""
import pytest
from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex


def _make_rpc(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    return LongTermV2Rpc(store=store, index=index, embedder=None), store, index


@pytest.mark.asyncio
async def test_quick_capture_writes_inbox(tmp_path):
    rpc, store, index = _make_rpc(tmp_path)
    out = await rpc.quick_capture({
        "type": "lesson",
        "brief": "macOS 终端中文输入用 pbcopy",
        "content": "详细内容...",
        "source_ref": {"type": "conversation", "task_id": "t1"},
        "entities": [],
        "tags": ["macos"],
        "importance_factors": {"proximity": 0.7, "surprisal": 0.8,
                               "entity_priority": 0.5, "unambiguity": 0.7},
    })
    assert out["status"] == "ok"
    loc = index.locate(out["id"])
    assert loc[0] == "inbox"


@pytest.mark.asyncio
async def test_run_maintenance_rpc(tmp_path):
    rpc, store, index = _make_rpc(tmp_path)
    out = await rpc.run_maintenance({"scope": "all", "now_iso": "2026-04-23T00:00:00Z"})
    assert "report" in out
    assert "observation_check" in out["report"]


@pytest.mark.asyncio
async def test_get_set_evolution_mode(tmp_path):
    rpc, store, index = _make_rpc(tmp_path)
    info = await rpc.get_evolution_mode({})
    assert info["mode"] == "balanced"
    out = await rpc.set_evolution_mode({"mode": "innovate", "reason": "稳定期"})
    assert out["mode"] == "innovate"


@pytest.mark.asyncio
async def test_get_observation_pending(tmp_path):
    rpc, store, index = _make_rpc(tmp_path)
    out = await rpc.get_observation_pending({})
    assert "items" in out
    assert isinstance(out["items"], list)


@pytest.mark.asyncio
async def test_get_confirmed_snapshot(tmp_path):
    rpc, store, index = _make_rpc(tmp_path)
    out = await rpc.get_confirmed_snapshot({})
    assert "snapshot_id" in out
    assert "by_type" in out


@pytest.mark.asyncio
async def test_bump_lesson_use_count_rpc(tmp_path):
    """bump_lesson_use 是 update_long_term 的语义糖（专用 RPC）。"""
    rpc, store, index = _make_rpc(tmp_path)
    # 先 quick_capture 一条 lesson
    cap = await rpc.quick_capture({
        "type": "lesson", "brief": "x", "content": "y",
        "source_ref": {"type": "manual"}, "entities": [], "tags": [],
        "importance_factors": {"proximity": 0.5, "surprisal": 0.5,
                               "entity_priority": 0.5, "unambiguity": 0.5},
    })
    out = await rpc.bump_lesson_use({"id": cap["id"], "validated_at": "2026-04-23T12:00:00Z"})
    assert out["status"] == "ok"


@pytest.mark.asyncio
async def test_trigger_consolidation_returns_acknowledged(tmp_path):
    """memory 不真跑反思，只回传 ack（实际反思由 Admin schedule 触发）。"""
    rpc, store, index = _make_rpc(tmp_path)
    out = await rpc.trigger_consolidation({"mode": "quick"})
    assert out["status"] == "deferred_to_schedule"


# ============================================================================
# promote_to_rule RPC（spec §10.1 / §6.4：Case→Rule 自动晋升）
# ============================================================================

async def _capture_case(rpc, brief: str) -> str:
    out = await rpc.quick_capture({
        "type": "lesson",
        "brief": brief,
        "content": f"case body for {brief}",
        "source_ref": {"type": "reflection"},
        "entities": [],
        "tags": [],
        "importance_factors": {"proximity": 0.5, "surprisal": 0.5,
                               "entity_priority": 0.5, "unambiguity": 0.5},
        "lesson_meta": {"scenario": "macos_input", "outcome": "success"},
    })
    return out["id"]


@pytest.mark.asyncio
async def test_promote_to_rule_writes_confirmed_lesson_with_observation(tmp_path):
    """promote_to_rule 调通后 rule 直接落 confirmed/lesson/，maturity=rule，observation=7 天。"""
    rpc, store, index = _make_rpc(tmp_path)
    source_cases = [
        await _capture_case(rpc, f"macOS 中文输入坑 {i}") for i in range(3)
    ]

    out = await rpc.promote_to_rule({
        "source_cases": source_cases,
        "brief": "macOS 终端中文输入必须 pbcopy + Cmd+V",
        "content": "scenario: macos_input\n适用条件: ...\n推荐做法: pbcopy 剪贴板\n反例: 直接 type",
        "scenario": "macos_input",
    })
    assert out["status"] == "ok"

    loc = index.locate(out["id"])
    assert loc is not None
    assert loc[0] == "confirmed"
    assert loc[1] == "lesson"

    entry = store.read("confirmed", "lesson", out["id"])
    assert entry.frontmatter.maturity == "rule"
    assert entry.frontmatter.observation is not None
    assert entry.frontmatter.observation.window_days == 7
    assert entry.frontmatter.observation.outcome == "pending"
    assert entry.frontmatter.lesson_meta.source_cases == source_cases


@pytest.mark.asyncio
async def test_promote_to_rule_rejects_below_threshold(tmp_path):
    """凑不齐 3 条 case 直接报错（spec §6.4 门槛）。"""
    rpc, store, index = _make_rpc(tmp_path)
    source_cases = [
        await _capture_case(rpc, f"x {i}") for i in range(2)
    ]
    with pytest.raises(ValueError, match=r"至少 3 条"):
        await rpc.promote_to_rule({
            "source_cases": source_cases,
            "brief": "x",
            "content": "y",
        })


@pytest.mark.asyncio
async def test_promote_to_rule_appears_in_observation_pending(tmp_path):
    """新 rule 必须立即出现在观察期面板（Admin UI 直接消费），无需等观察期到期。"""
    rpc, store, index = _make_rpc(tmp_path)
    source_cases = [
        await _capture_case(rpc, f"y {i}") for i in range(3)
    ]
    promoted = await rpc.promote_to_rule({
        "source_cases": source_cases,
        "brief": "test rule",
        "content": "test rule body",
        "scenario": "test",
    })
    pending = await rpc.get_observation_pending({})
    pending_ids = [row["id"] for row in pending["items"]]
    assert promoted["id"] in pending_ids
    # UI 直接消费的字段必须齐全
    item = next(row for row in pending["items"] if row["id"] == promoted["id"])
    assert item["observation_window_days"] == 7
    assert item["validation_outcome"] == "pending"
    assert "promoted_at" in item

"""Case→Rule 自动晋升端到端（spec §6.4 修订后）。

verifies:
  - synthesize_rule 把 ≥3 source_cases 抽象成 rule
  - 落盘到 confirmed/lesson/<rule_id>.md
  - frontmatter: maturity=rule, lesson_meta.source_cases 完整保留
  - observation 自动启动：promoted_at / observation_window_days / outcome=pending
  - 索引 status='confirmed', type='lesson'
  - get_memory(include='full') 能取回 rule 内容与 source_cases
"""
import pytest

from src.long_term_v2.evolution import synthesize_rule
from src.long_term_v2.rpc import LongTermV2Rpc
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex


def _build(tmp_path):
    store = MemoryStore(str(tmp_path / "lt"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    return store, index


def _seed_case(store, index, mid: str, brief: str, body: str) -> str:
    """直接写一条 lesson case (status=inbox, maturity=case) 充当原始素材。"""
    from src.long_term_v2.schema import (
        MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, LessonMeta,
    )
    from src.long_term_v2.paths import entry_path

    fm = MemoryFrontmatter(
        id=mid, type="lesson", maturity="case",
        brief=brief, author="agent:capture",
        source_ref=SourceRef(type="reflection"),
        source_trust=3, content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-20T10:00:00Z",
        ingestion_time="2026-04-20T10:00:00Z",
        lesson_meta=LessonMeta(scenario="飞书发表情", outcome="success"),
    )
    entry = MemoryEntry(frontmatter=fm, body=body)
    store.write(entry, status="inbox")
    index.upsert(entry, path=entry_path(store.data_root, "inbox", "lesson", mid),
                 status="inbox")
    return mid


@pytest.mark.asyncio
async def test_synthesize_rule_lands_in_confirmed_with_observation(tmp_path):
    store, index = _build(tmp_path)
    cap_ids = [_seed_case(store, index, f"cap-{i}", f"飞书 emoji 经验 {i}",
                              f"用 emoji_id-{i}，不要用图片") for i in range(3)]

    rule_id = synthesize_rule(
        store=store, index=index,
        source_cases=cap_ids,
        brief="飞书表情用 emoji_id 不用图片",
        content="飞书发表情统一用 emoji_id；图片 URL 在飞书侧不能渲染。",
        scenario="飞书发表情",
        window_days=7,
    )
    assert rule_id

    # 索引侧：确实是 confirmed/lesson
    loc = index.locate(rule_id)
    assert loc is not None
    status = loc["status"] if hasattr(loc, "keys") else loc[0]
    type_ = loc["type"] if hasattr(loc, "keys") else loc[1]
    assert status == "confirmed"
    assert type_ == "lesson"

    # 文件侧：内容 + 关键 frontmatter
    entry = store.read("confirmed", "lesson", rule_id)
    fm = entry.frontmatter
    assert fm.maturity == "rule"
    assert fm.brief == "飞书表情用 emoji_id 不用图片"
    assert fm.lesson_meta is not None
    assert sorted(fm.lesson_meta.source_cases) == sorted(cap_ids)
    assert fm.lesson_meta.outcome == "success"

    # observation 自动启动
    assert fm.observation is not None
    assert fm.observation.window_days == 7
    assert fm.observation.outcome == "pending"
    assert fm.observation.started_at  # 非空


@pytest.mark.asyncio
async def test_rule_retrievable_via_get_memory(tmp_path):
    """走 RPC 层：get_memory(include='full') 应返回 source_cases。"""
    store, index = _build(tmp_path)
    cap_ids = [_seed_case(store, index, f"cap-{i}", f"经验 {i}", f"内容 {i}")
               for i in range(3)]
    rule_id = synthesize_rule(
        store=store, index=index, source_cases=cap_ids,
        brief="抽象出的 rule", content="rule body",
        scenario="测试场景",
    )
    rpc = LongTermV2Rpc(store=store, index=index, embedder=None)
    out = await rpc.get_memory({"id": rule_id, "include": "full"})
    fm = out["frontmatter"]
    assert fm["maturity"] == "rule"
    assert fm["lesson_meta"]["source_cases"] == cap_ids
    assert fm["observation"]["outcome"] == "pending"


@pytest.mark.asyncio
async def test_rule_appears_in_observation_pending(tmp_path):
    """新 rule 的 observation 窗口未到期前应立即出现在 get_observation_pending（spec §6.2 / §10.1）。

    UI 「观察期」 tab 列出所有处于观察中（含未到期）的 entries，让运营提早干预。
    """
    store, index = _build(tmp_path)
    cap_ids = [_seed_case(store, index, f"cap-{i}", f"b{i}", f"x{i}") for i in range(3)]
    rule_id = synthesize_rule(
        store=store, index=index, source_cases=cap_ids,
        brief="g", content="b", scenario="s",
        window_days=7,
    )
    rpc = LongTermV2Rpc(store=store, index=index, embedder=None)
    # 不传 now_iso，新 rule 当下就应该出现（未到期也算 pending）
    out = await rpc.get_observation_pending({})
    pending_ids = [r["id"] for r in out["items"]]
    assert rule_id in pending_ids

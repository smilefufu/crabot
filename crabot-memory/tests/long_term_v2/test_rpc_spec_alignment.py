"""Spec §10 ↔ rpc.py 静态对齐。

锁定 LongTermV2Rpc 暴露的 RPC 方法集合，避免：
  - 后续偷偷新增 RPC 但未在 spec §10 登记（漂移）
  - 后续删除 RPC 而 spec 未同步（spec 烂尾）

注：如果有意增删 RPC，请同步更新 spec §10.1 与本文件的 EXPECTED 集合。
"""
import inspect
from src.long_term_v2.rpc import LongTermV2Rpc


# Spec §10.1 (新增) ∪ §10.3 (保留) — 必须在 LongTermV2Rpc 上以 async 方法呈现。
# §10.3 中 export_memories / import_memories / *_reflection_watermark 走 v1 module.py 通道，
# 不在 v2 LongTermV2Rpc 上；本断言只锁定属于 v2 RPC 类的方法。
EXPECTED_V2_RPC_METHODS = frozenset({
    # §10.3 保留
    "write_long_term",
    "update_long_term",
    "delete_memory",
    "get_memory",
    # §10.1 新增
    "quick_capture",
    "run_maintenance",
    "trigger_consolidation",
    "get_evolution_mode",
    "set_evolution_mode",
    "promote_to_rule",
    "get_observation_pending",
    "mark_observation_pass",
    "extend_observation_window",
    "bump_lesson_use",
    "report_task_feedback",
    "search_long_term",
    "grep_memory",
    "list_recent",
    "find_by_entity",
    "find_by_tag",
    "get_cases_about",
    "list_entries",
    "keyword_search",
    "restore_memory",
    "get_confirmed_snapshot",
    "get_entry_version",
})


def _public_async_methods(cls) -> set[str]:
    out: set[str] = set()
    for name, member in inspect.getmembers(cls, predicate=inspect.iscoroutinefunction):
        if name.startswith("_"):
            continue
        out.add(name)
    return out


def test_rpc_method_set_matches_spec():
    actual = _public_async_methods(LongTermV2Rpc)
    missing = EXPECTED_V2_RPC_METHODS - actual
    extra = actual - EXPECTED_V2_RPC_METHODS
    assert not missing, (
        f"spec §10 列出但 rpc.py 缺失：{sorted(missing)}。"
        " 要么补实现，要么修订 spec 并更新 EXPECTED_V2_RPC_METHODS。"
    )
    assert not extra, (
        f"rpc.py 出现 spec §10 未登记的 RPC：{sorted(extra)}。"
        " 请同步更新 spec §10 和 EXPECTED_V2_RPC_METHODS。"
    )


def test_module_dispatcher_exposes_all_v2_rpcs():
    """module.py 的 _dispatch handlers 必须把每个 LongTermV2Rpc public method 暴露出去。

    防御真实漏掉的场景：rpc.py 加了某方法但忘了在 module.py 注册，
    单元测试全过、e2e 才暴露 'Method not found'。
    """
    import re
    from pathlib import Path

    module_src = (Path(__file__).parent.parent.parent / "src" / "module.py").read_text("utf-8")
    referenced = set(re.findall(r"self\._lt_v2_rpc\.(\w+)", module_src))
    actual = _public_async_methods(LongTermV2Rpc)
    missing = actual - referenced
    assert not missing, (
        f"LongTermV2Rpc 上有 {sorted(missing)} 但 module.py _dispatch 未注册，"
        " 跨进程调用会 'Method not found'。"
    )

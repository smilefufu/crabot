"""Memory v2 maintenance (passive — invoked by Admin schedule).

无 LLM 调用、无后台线程；只做机械的状态推进。
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from .store import MemoryStore
from .sqlite_index import SqliteIndex
from .paths import entry_path
from .lifecycle import move_entry


@dataclass
class MaintenanceConfig:
    now_iso: str
    stale_idle_days: int = 180
    trash_retention_days: int = 30
    inbox_max_age_hours: int = 30


Scope = Literal["observation_check", "stale_aging", "trash_cleanup", "link_gc", "inbox_expiry", "all"]


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _observation_check(store: MemoryStore, index: SqliteIndex, cfg: MaintenanceConfig) -> dict:
    """到期判定 — Phase A (2026-04-25)：按 pass_count - fail_count 净值。

    Spec: 2026-04-25-self-learning-feedback-signal-design.md §10
    - net > 0  → pass（标记 observation.outcome="pass"，状态保持）
    - net < 0  → rollback（回退 inbox + needs_review tag）
    - net == 0 → 延长一个观察周期（stale_check_count + 1，3 次后转 stale）

    备注：spec 文本写"升 maturity stable"，但 schema 中各类型的 maturity 字面量
    （fact=observed/confirmed/stale, lesson=case/rule/retired,
    concept=draft/established）并不包含 "stable"。这里采取保守策略：仅在
    observation.outcome 上标 "pass"，保留原 maturity 不动；这样既符合
    schema 约束，也保留了 spec "通过观察期" 的语义。
    """
    expired = index.scan_expired_observation(now_iso=cfg.now_iso)
    passed = trashed = pending = 0
    for r in expired:
        pass_count = int(r.get("observation_pass_count") or 0)
        fail_count = int(r.get("observation_fail_count") or 0)
        net = pass_count - fail_count

        if net > 0:
            # pass — 标 observation.outcome=pass，状态保持
            entry = store.read(r["status"], r["type"], r["id"])
            new_obs = entry.frontmatter.observation.model_copy(
                update={"outcome": "pass"}
            ) if entry.frontmatter.observation else None
            new_fm = entry.frontmatter.model_copy(update={"observation": new_obs})
            new_entry = entry.model_copy(update={"frontmatter": new_fm})
            store.write(new_entry, status=r["status"])
            index.upsert(new_entry,
                         path=entry_path(store.data_root, r["status"], r["type"], r["id"]),
                         status=r["status"])
            index.mark_observation_outcome(r["id"], "pass")
            passed += 1
            continue

        if net < 0:
            entry = store.read(r["status"], r["type"], r["id"])
            move_entry(
                store, index, entry,
                from_status=r["status"], to_status="trash", now_iso=cfg.now_iso,
            )
            trashed += 1
            continue

        # net == 0 — 延长一个观察周期，stale_check_count + 1
        entry = store.read(r["status"], r["type"], r["id"])
        obs = entry.frontmatter.observation
        if obs is None:
            continue
        new_obs = obs.model_copy(update={
            "started_at": cfg.now_iso,
            "stale_check_count": obs.stale_check_count + 1,
        })
        new_fm = entry.frontmatter.model_copy(update={"observation": new_obs})
        if new_obs.stale_check_count >= 3:
            # spec §6.5: 连续 3 周期未被引用 → 标记终态。
            # Maturity 字面量按 type 区分（schema 约束）：
            # - fact: stale（合法终态）
            # - lesson: retired（合法终态）
            # - concept: 无对应终态字面量，改用 observation_stale tag 标记
            mtype = entry.frontmatter.type
            if mtype == "fact":
                new_fm = new_fm.model_copy(update={"maturity": "stale"})
            elif mtype == "lesson":
                new_fm = new_fm.model_copy(update={"maturity": "retired"})
            else:  # concept
                tags = list(new_fm.tags or [])
                if "observation_stale" not in tags:
                    tags.append("observation_stale")
                new_fm = new_fm.model_copy(update={"tags": tags})
        new_entry = entry.model_copy(update={"frontmatter": new_fm})
        store.write(new_entry, status=r["status"])
        index.upsert(new_entry,
                     path=entry_path(store.data_root, r["status"], r["type"], r["id"]),
                     status=r["status"])
        pending += 1

    return {
        "passed": passed,
        # 保留旧字段，避免消费旧 maintenance report 的调用方立刻中断。
        "rolled_back": trashed,
        "trashed": trashed,
        "pending_extended": pending,
    }


def _stale_aging(store: MemoryStore, index: SqliteIndex, cfg: MaintenanceConfig) -> dict:
    rows = index.scan_stale_facts(idle_days=cfg.stale_idle_days, now_iso=cfg.now_iso)
    marked = 0
    for r in rows:
        entry = store.read(r["status"], r["type"], r["id"])
        if entry.frontmatter.maturity == "stale":
            continue
        new_fm = entry.frontmatter.model_copy(update={"maturity": "stale"})
        new_entry = entry.model_copy(update={"frontmatter": new_fm})
        store.write(new_entry, status=r["status"])
        index.upsert(new_entry,
                     path=entry_path(store.data_root, r["status"], r["type"], r["id"]),
                     status=r["status"])
        marked += 1
    return {"marked_stale": marked}


def _trash_cleanup(store: MemoryStore, index: SqliteIndex, cfg: MaintenanceConfig) -> dict:
    rows = index.scan_old_trash(retention_days=cfg.trash_retention_days, now_iso=cfg.now_iso)
    deleted = 0
    for r in rows:
        store.purge("trash", r["type"], r["id"])
        index.delete(r["id"])
        deleted += 1
    return {"deleted": deleted}


def _inbox_expiry(store: MemoryStore, index: SqliteIndex, cfg: MaintenanceConfig) -> dict:
    trashed = 0
    for row in index.scan_expired_inbox(
        max_age_hours=cfg.inbox_max_age_hours,
        now_iso=cfg.now_iso,
    ):
        entry = store.read(row["status"], row["type"], row["id"])
        move_entry(
            store, index, entry,
            from_status="inbox", to_status="trash", now_iso=cfg.now_iso,
        )
        trashed += 1
    return {"trashed": trashed}


def _link_gc(store: MemoryStore, index: SqliteIndex, cfg: MaintenanceConfig) -> dict:
    """链接清理（P2）：删死链 + 重定向被取代链接。

    对每个有出链的源，逐条 link 解析 target：
    - target 在 index 中不存在（已 purge）→ 删该 link
    - target 在 trash → 删该 link
    - target.invalidated_by 指向 successor → 若 successor 可达则把 link 的 target
      改为 successor（保留 relation，沿一跳）；不可达则删该 link
    有变更则把新 links 落盘 + 重建 index。
    """
    changed = 0
    for source_id in index.all_link_sources():
        loc = index.locate(source_id)
        if loc is None:
            continue
        status, type_, _ = loc[0], loc[1], loc[2]
        entry = store.read(status, type_, source_id)
        new_links = []
        mutated = False
        for link in entry.frontmatter.links:
            target_loc = index.locate(link.target)
            # 死链：target 已不存在
            if target_loc is None:
                mutated = True
                continue
            target_status = target_loc[0]
            # target 在 trash → 删
            if target_status == "trash":
                mutated = True
                continue
            target_entry = store.read(target_status, target_loc[1], link.target)
            successor = target_entry.frontmatter.invalidated_by
            if successor:
                # 被取代：沿一跳重定向到 successor（若可达），否则删
                if index.locate(successor) is not None:
                    new_links.append(link.model_copy(update={"target": successor}))
                mutated = True
                continue
            new_links.append(link)

        if mutated:
            new_fm = entry.frontmatter.model_copy(update={"links": new_links})
            new_entry = entry.model_copy(update={"frontmatter": new_fm})
            store.write(new_entry, status=status)
            index.upsert(
                new_entry,
                path=entry_path(store.data_root, status, type_, source_id),
                status=status,
            )
            changed += 1

    return {"changed": changed}


def run_maintenance(store: MemoryStore, index: SqliteIndex, scope: Scope, config: MaintenanceConfig) -> dict:
    report: dict = {}
    if scope in ("observation_check", "all"):
        report["observation_check"] = _observation_check(store, index, config)
    if scope in ("stale_aging", "all"):
        report["stale_aging"] = _stale_aging(store, index, config)
    if scope in ("trash_cleanup", "all"):
        report["trash_cleanup"] = _trash_cleanup(store, index, config)
    if scope in ("link_gc", "all"):
        report["link_gc"] = _link_gc(store, index, config)
    if scope in ("inbox_expiry", "all"):
        report["inbox_expiry"] = _inbox_expiry(store, index, config)
    report["completed_at"] = _now()
    return report

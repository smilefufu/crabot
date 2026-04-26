"""Memory v2 maintenance (passive — invoked by Admin schedule).

无 LLM 调用、无后台线程；只做机械的状态推进。
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from .store import MemoryStore
from .sqlite_index import SqliteIndex
from .paths import entry_path


@dataclass
class MaintenanceConfig:
    now_iso: str
    stale_idle_days: int = 180
    trash_retention_days: int = 30


Scope = Literal["observation_check", "stale_aging", "trash_cleanup", "all"]


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
    passed = rolled_back = pending = 0
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
            store.move(r["id"], r["type"], from_status=r["status"], to_status="inbox")
            new_path = entry_path(store.data_root, "inbox", r["type"], r["id"])
            new_obs = entry.frontmatter.observation.model_copy(
                update={"outcome": "pending", "started_at": cfg.now_iso}
            ) if entry.frontmatter.observation else None
            new_fm = entry.frontmatter.model_copy(update={
                "observation": new_obs,
                "tags": list(set([*entry.frontmatter.tags, "needs_review"])),
            })
            new_entry = entry.model_copy(update={"frontmatter": new_fm})
            store.write(new_entry, status="inbox")
            index.upsert(new_entry, path=new_path, status="inbox")
            rolled_back += 1
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

    return {"passed": passed, "rolled_back": rolled_back, "pending_extended": pending}


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


def run_maintenance(store: MemoryStore, index: SqliteIndex, scope: Scope, config: MaintenanceConfig) -> dict:
    report: dict = {}
    if scope in ("observation_check", "all"):
        report["observation_check"] = _observation_check(store, index, config)
    if scope in ("stale_aging", "all"):
        report["stale_aging"] = _stale_aging(store, index, config)
    if scope in ("trash_cleanup", "all"):
        report["trash_cleanup"] = _trash_cleanup(store, index, config)
    report["completed_at"] = _now()
    return report

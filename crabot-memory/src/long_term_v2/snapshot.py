"""Confirmed memory snapshot 序列化（按 type 分块，供 Agent prompt 注入）。"""
from datetime import datetime, timezone
from .store import MemoryStore
from .sqlite_index import SqliteIndex


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_confirmed_snapshot(store: MemoryStore, index: SqliteIndex) -> dict:
    """返回 {snapshot_id, generated_at, by_type: {fact: [...], lesson: [...], concept: [...]}}。"""
    rows = list(index.iter_all_confirmed_briefs())
    by_type: dict[str, list[dict]] = {"fact": [], "lesson": [], "concept": []}
    for r in rows:
        type_ = r["type"]
        if type_ not in by_type:
            continue
        by_type[type_].append({
            "id": r["id"],
            "brief": r["brief"],
            "tags": r.get("tags") or [],
        })
    snapshot_id = f"snap-{_now()}"
    return {
        "snapshot_id": snapshot_id,
        "generated_at": _now(),
        "by_type": by_type,
    }

"""crabot-memory v1 → v2 migration.

Usage: uv run python crabot-memory/upgrade/from_v1_to_v2.py --data-dir=<path>
"""
import os
import sys
import json
import argparse
import traceback
from typing import List, Tuple, Any

# 将项目根加入 sys.path 以便 import src.*
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors,
    EntityRef, LessonMeta,
    default_maturity_migrated, new_memory_id,
)
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.paths import entry_path


_LESSON_TAGS = {"lesson", "task_experience"}


def infer_type(record: dict, default: str = "concept") -> str:
    tags = set(record.get("tags") or [])
    if tags & _LESSON_TAGS:
        return "lesson"
    if record.get("entities"):
        return "fact"
    return default


def _truncate_brief(text: str, warnings: List[str]) -> str:
    if len(text) > 80:
        warnings.append(f"brief truncated (>{len(text)} chars)")
        return text[:80]
    return text


def _check_overview(overview: str, content: str, warnings: List[str]) -> None:
    if overview and content and len(overview) > len(content) / 2:
        warnings.append("overview length > content/2, discarded")


def _coerce_dict_field(record: dict, key: str, warnings: List[str], default: Any) -> Any:
    """Read v1 field that may be either a native dict/list or a *_json string."""
    if key in record and record[key] is not None:
        return record[key]
    json_key = f"{key}_json"
    raw = record.get(json_key)
    if raw is None or raw == "":
        return default
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError) as e:
        warnings.append(f"failed to parse {json_key}: {e}")
        return default


def migrate_record(old: dict) -> Tuple[MemoryEntry, List[str]]:
    warnings: List[str] = []

    entities_raw = _coerce_dict_field(old, "entities", warnings, default=[])
    source = _coerce_dict_field(old, "source", warnings, default={})
    # Reify so downstream type inference sees normalized fields.
    old_view = dict(old)
    old_view["entities"] = entities_raw
    old_view["source"] = source

    type_ = infer_type(old_view)
    maturity = default_maturity_migrated(type_)

    brief = _truncate_brief(old.get("abstract") or "", warnings)
    if not brief:
        brief = "(no brief)"

    _check_overview(old.get("overview") or "", old.get("content") or "", warnings)

    importance = int(old.get("importance") or 5)
    proximity = max(0.0, min(1.0, importance / 10.0))

    entities = []
    for e in entities_raw:
        if isinstance(e, dict) and "type" in e and "id" in e and "name" in e:
            entities.append(EntityRef(type=e["type"], id=e["id"], name=e["name"]))

    lesson_meta = None
    if type_ == "lesson":
        lesson_meta = LessonMeta(
            scenario=old.get("abstract") or "",
            outcome="success",
            use_count=int(old.get("read_count") or 0),
        )
    fm = MemoryFrontmatter(
        id=old.get("id") or new_memory_id(),
        type=type_,
        maturity=maturity,
        brief=brief,
        author=source.get("author") or "system",
        source_ref=SourceRef(
            type=source.get("type", "system"),
            task_id=source.get("task_id"),
            session_id=source.get("session_id"),
            channel_id=source.get("channel_id"),
        ),
        source_trust=4,
        content_confidence=4,
        importance_factors=ImportanceFactors(
            proximity=proximity, surprisal=0.5,
            entity_priority=0.5, unambiguity=0.5,
        ),
        entities=entities,
        tags=list(old.get("tags") or []),
        event_time=old.get("created_at") or "1970-01-01T00:00:00Z",
        ingestion_time=old.get("updated_at") or old.get("created_at") or "1970-01-01T00:00:00Z",
        lesson_meta=lesson_meta,
        version=int(old.get("version") or 1),
    )
    return MemoryEntry(frontmatter=fm, body=old.get("content") or ""), warnings


def _read_old_records(data_dir: str) -> List[dict]:
    """读 LanceDB long_term_memory 表为 list of dicts。"""
    lance_path = os.path.join(data_dir, "lancedb")
    if not os.path.exists(lance_path):
        return []
    try:
        import lancedb
    except ImportError:
        print("ERROR: lancedb not installed; cannot migrate v1 data", file=sys.stderr)
        sys.exit(2)
    db = lancedb.connect(lance_path)
    try:
        table = db.open_table("long_term_memory")
    except (FileNotFoundError, ValueError):
        return []
    return table.to_arrow().to_pylist()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    args = ap.parse_args()

    data_dir = args.data_dir
    old_records = _read_old_records(data_dir)

    if not old_records:
        print(f"No v1 records found in {data_dir}/lancedb. Nothing to migrate.")
        return

    print(f"Migrating {len(old_records)} entries (v1 → v2) ...")

    store = MemoryStore(os.path.join(data_dir, "long_term"))
    index = SqliteIndex(os.path.join(data_dir, "long_term_v2.db"))

    migrated = 0
    discarded = 0
    total_warnings = 0

    for rec in old_records:
        try:
            entry, warnings = migrate_record(rec)
            for w in warnings:
                print(f"WARN {entry.frontmatter.id}: {w}", file=sys.stderr)
                total_warnings += 1
            # confirmed status (旧库已经过反思)
            store.write(entry, status="confirmed")
            path = entry_path(store.data_root, "confirmed", entry.frontmatter.type, entry.frontmatter.id)
            index.upsert(entry, path=path, status="confirmed")
            migrated += 1
        except Exception as e:
            discarded += 1
            print(f"ERROR migrating record id={rec.get('id', '?')}: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    print(f"Done: {migrated} migrated, {discarded} discarded, {total_warnings} warnings.")


if __name__ == "__main__":
    main()

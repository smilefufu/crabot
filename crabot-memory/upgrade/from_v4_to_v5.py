"""v4 → v5: explicit long-term visibility, with a verified complete backup.

No LLM calls. The upgrade framework advances SCHEMA_VERSION after success.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import uuid

import yaml


def require_stopped(data_dir: Path) -> None:
    pid_file = data_dir.parent / "mm.pid"
    if not pid_file.exists():
        return
    try:
        pid = int(pid_file.read_text().strip())
    except ValueError:
        raise RuntimeError("Invalid MM pid file; verify MM is stopped") from None
    if pid <= 0:
        raise RuntimeError("Invalid MM pid file; verify MM is stopped")
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return
    except PermissionError:
        pass
    raise RuntimeError("MM must be stopped before Memory upgrade")


def hashes(root: Path) -> dict[str, str]:
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*")) if p.is_file()}


def inspect(data_dir: Path):
    report = {"files": 0, "missing_visibility": 0, "invalid_visibility": 0, "missing_scopes": 0, "invalid_scopes": 0}
    changes = []
    markers = {}
    for file in sorted((data_dir / "long_term").rglob("*.md")):
        text = file.read_text(encoding="utf-8")
        if not text.startswith("---\n") or "\n---\n" not in text[4:]:
            raise RuntimeError("Damaged Memory frontmatter; repair before upgrade")
        raw_yaml, body = text[4:].split("\n---\n", 1)
        raw = yaml.safe_load(raw_yaml)
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
            raise RuntimeError("Damaged Memory frontmatter; repair before upgrade")
        report["files"] += 1
        additions = []
        if "visibility" not in raw:
            report["missing_visibility"] += 1
            raw["visibility"] = "internal"
            additions.append("visibility: internal")
        elif not isinstance(raw["visibility"], str) or raw["visibility"] not in {"private", "internal", "public"}:
            report["invalid_visibility"] += 1
        if "scopes" not in raw:
            report["missing_scopes"] += 1
            raw["scopes"] = []
            additions.append("scopes: []")
        elif not isinstance(raw["scopes"], list) or any(not isinstance(s, str) or not s.strip() for s in raw["scopes"]):
            report["invalid_scopes"] += 1
        # Append only absent fields; keep existing YAML, versions and body intact.
        if additions:
            changes.append((file, "---\n" + raw_yaml + "\n" + "\n".join(additions) + "\n---\n" + body))
        if not any(part.endswith(".versions") for part in file.relative_to(data_dir).parts):
            visibility = raw["visibility"] if isinstance(raw["visibility"], str) else json.dumps(raw["visibility"])
            markers[raw["id"]] = (visibility, json.dumps(raw["scopes"], ensure_ascii=False))
    short_db = data_dir / "short_term.db"
    report["invalid_short_scopes"] = 0
    if short_db.exists():
        # MM is stopped; immutable read avoids creating SQLite journal/shm files.
        conn = sqlite3.connect(short_db.as_uri() + "?mode=ro&immutable=1", uri=True)
        try:
            if conn.execute("SELECT 1 FROM sqlite_master WHERE name='short_term_memory'").fetchone():
                for (scopes,) in conn.execute("SELECT scopes FROM short_term_memory"):
                    try:
                        decoded = json.loads(scopes)
                        valid = isinstance(decoded, list) and all(isinstance(s, str) for s in decoded)
                    except (TypeError, ValueError):
                        valid = False
                    report["invalid_short_scopes"] += int(not valid)
        finally:
            conn.close()
    return report, changes, markers


def migrate(data_dir: Path, *, dry_run: bool = False) -> dict:
    data_dir = data_dir.resolve()
    if not data_dir.is_dir():
        raise RuntimeError("Memory data directory does not exist")
    require_stopped(data_dir)
    report, changes, markers = inspect(data_dir)
    if dry_run:
        return report
    before = hashes(data_dir)
    backup = data_dir.with_name(data_dir.name + ".v4.backup-" + uuid.uuid4().hex)
    shutil.copytree(data_dir, backup)
    if hashes(backup) != before or hashes(data_dir) != before:
        raise RuntimeError("Memory backup verification failed; no upgrade writes performed")
    try:
        for file, text in changes:
            temp = file.with_suffix(".upgrade.tmp")
            temp.write_text(text, encoding="utf-8")
            temp.replace(file)
        db = data_dir / "long_term_v2.db"
        if db.exists():
            with sqlite3.connect(db) as conn:
                columns = {r[1] for r in conn.execute("PRAGMA table_info(memories)")}
                if columns:
                    if "visibility" not in columns:
                        conn.execute("ALTER TABLE memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'internal'")
                    if "scopes" not in columns:
                        conn.execute("ALTER TABLE memories ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]'")
                    # Preserve counters, task usage, observation state and kv_meta.
                    conn.executemany("UPDATE memories SET visibility=?, scopes=? WHERE id=?",
                                     [(v, scopes, mid) for mid, (v, scopes) in markers.items()])
    except Exception:
        # Restore files and DBs together; the framework keeps its old marker.
        for child in data_dir.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
        shutil.copytree(backup, data_dir, dirs_exist_ok=True)
        raise
    return {**report, "backup": str(backup)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(migrate(args.data_dir, dry_run=args.dry_run)))
        return 0
    except Exception:
        # Do not print raw YAML/Pydantic errors, which can contain memory text.
        print("Memory v4 to v5 upgrade failed; data marker was not advanced")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Standalone scripts use the same Node scope/backup transaction as formal upgrades."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def require_context(data_dir: Path) -> dict:
    filename = os.environ.get("CRABOT_MIGRATION_PLAN")
    if not filename:
        raise RuntimeError("Use the scoped migration entry before writing Memory data")
    raw = Path(filename).read_bytes()
    if hashlib.sha256(raw).hexdigest() != os.environ.get("CRABOT_MIGRATION_PLAN_SHA256"):
        raise RuntimeError("Migration context verification failed")
    plan = json.loads(raw)
    if Path(plan["description"]["data_root"]).resolve() / "memory" != data_dir.resolve():
        raise RuntimeError("Migration data ownership mismatch")
    state = json.loads(Path(filename).with_name("state.json").read_text())
    if state.get("phase") != "running" or state.get("plan_sha256") != hashlib.sha256(raw).hexdigest():
        raise RuntimeError("Migration backup is not active")
    # The active common owner already verified this one backup before entering the chain.
    # Standalone writes delegate to that owner rather than rehashing it for every step.
    return plan


def standalone(data_dir: Path, from_version: int, to_version: int) -> dict:
    module = Path(__file__).resolve().parents[1]
    child = subprocess.run([
        "node", str(module.parent / "scripts/execute-scoped-migration.mjs"),
        f"--module={module}", f"--data={data_dir.resolve()}",
        f"--from=v{from_version}", f"--to=v{to_version}", f"--python={sys.executable}",
    ], capture_output=True, text=True)
    if child.returncode:
        raise RuntimeError("Scoped Memory upgrade failed; recovery materials preserved")
    result = json.loads(child.stdout.strip().splitlines()[-1])
    return {**(result.get("report") or {}), "backup": result["backupPath"]}


def enter(data_dir: Path, from_version: int, to_version: int):
    if not os.environ.get("CRABOT_MIGRATION_PLAN"):
        return standalone(data_dir, from_version, to_version)
    require_context(data_dir)
    return None

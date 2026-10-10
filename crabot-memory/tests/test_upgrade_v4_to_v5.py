import importlib.util
import os
from pathlib import Path
import sqlite3

import pytest

spec = importlib.util.spec_from_file_location("upgrade_v5", Path(__file__).parents[1] / "upgrade/from_v4_to_v5.py")
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


@pytest.fixture
def data(tmp_path):
    root = tmp_path / "memory"
    folder = root / "long_term/confirmed/fact"
    folder.mkdir(parents=True)
    (root / "SCHEMA_VERSION").write_text("v4\n")
    (folder / "legacy.md").write_text("---\nid: legacy\nbrief: original\n---\nbody unchanged\n")
    versions = folder / "legacy.versions"
    versions.mkdir()
    (versions / "v1.md").write_text("---\nid: legacy\n---\nold body\n")
    (folder / "private.md").write_text("---\nid: private\nvisibility: private\nscopes: [A]\n---\nprivate body\n")
    with sqlite3.connect(root / "long_term_v2.db") as conn:
        conn.execute("CREATE TABLE memories(id TEXT PRIMARY KEY, use_count INTEGER, observation_pass_count INTEGER)")
        conn.execute("INSERT INTO memories VALUES('legacy',17,4)")
        conn.execute("INSERT INTO memories VALUES('private',21,6)")
        conn.execute("CREATE TABLE lesson_task_usage(task_id TEXT, lesson_id TEXT)")
        conn.execute("INSERT INTO lesson_task_usage VALUES('task','legacy')")
        conn.execute("CREATE TABLE kv_meta(key TEXT, value TEXT)")
        conn.execute("INSERT INTO kv_meta VALUES('evolution_mode','aggressive')")
    with sqlite3.connect(root / "metadata.db") as conn:
        conn.execute("CREATE TABLE watermarks(value TEXT)")
        conn.execute("INSERT INTO watermarks VALUES('watermark')")
    with sqlite3.connect(root / "short_term.db") as conn:
        conn.execute("CREATE TABLE short_term_memory(scopes TEXT)")
        conn.execute("INSERT INTO short_term_memory VALUES('[\"p\", \"r\", \"o\"]')")
    return root


def test_dry_run_is_read_only_including_invalid_labels(data):
    (data / "long_term/confirmed/fact/invalid.md").write_text("---\nid: invalid\nvisibility: invalid\nscopes: wrong\n---\nsecret\n")
    before = upgrade.hashes(data)
    report = upgrade.migrate(data, dry_run=True)
    assert report["missing_visibility"] == 2
    assert report["invalid_visibility"] == report["invalid_scopes"] == 1
    assert upgrade.hashes(data) == before
    assert list(data.parent.glob("memory.v4.backup-*")) == []


def test_upgrade_backs_up_every_file_and_preserves_durable_state_on_repeat(data):
    before = upgrade.hashes(data)
    report = upgrade.migrate(data)
    assert upgrade.hashes(Path(report["backup"])) == before
    for _ in range(2):
        upgrade.migrate(data)
        with sqlite3.connect(data / "long_term_v2.db") as conn:
            assert conn.execute("SELECT id,use_count,observation_pass_count,visibility,scopes FROM memories ORDER BY id").fetchall() == [
                ("legacy", 17, 4, "internal", "[]"), ("private", 21, 6, "private", '["A"]')]
            assert conn.execute("SELECT * FROM lesson_task_usage").fetchall() == [("task", "legacy")]
            assert conn.execute("SELECT * FROM kv_meta").fetchall() == [("evolution_mode", "aggressive")]
        assert (data / "long_term/confirmed/fact/legacy.md").read_text().endswith("body unchanged\n")
        assert (data / "long_term/confirmed/fact/legacy.versions/v1.md").read_text().endswith("old body\n")
        assert (data / "SCHEMA_VERSION").read_text() == "v4\n"  # framework owns advancement
        assert upgrade.hashes(data)["metadata.db"] == before["metadata.db"]
        assert upgrade.hashes(data)["short_term.db"] == before["short_term.db"]


def test_backup_failure_and_running_mm_do_not_change_any_data(data, monkeypatch):
    before = upgrade.hashes(data)
    monkeypatch.setattr(upgrade.shutil, "copytree", lambda *a, **k: (_ for _ in ()).throw(OSError("fixture failure")))
    with pytest.raises(OSError):
        upgrade.migrate(data)
    assert upgrade.hashes(data) == before
    (data.parent / "mm.pid").write_text(str(os.getpid()))
    with pytest.raises(RuntimeError, match="stopped"):
        upgrade.migrate(data)
    assert upgrade.hashes(data) == before


def test_partial_upgrade_failure_restores_matching_files_and_databases(data, monkeypatch):
    before = upgrade.hashes(data)
    connect = upgrade.sqlite3.connect
    monkeypatch.setattr(upgrade.sqlite3, "connect", lambda *a, **k: connect(*a, **k) if k.get("uri") else (_ for _ in ()).throw(OSError("index failure")))
    with pytest.raises(OSError):
        upgrade.migrate(data)
    assert upgrade.hashes(data) == before

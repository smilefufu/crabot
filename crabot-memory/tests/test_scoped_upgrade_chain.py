import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

HOME = Path(__file__).resolve().parents[2]


def run_node(code):
    result = subprocess.run(["node", "--input-type=module", "-e", code], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    return result.stdout


@pytest.mark.parametrize("version", range(5))
def test_supported_chain_uses_one_backup_and_preserves_unrelated_data(tmp_path, version):
    memory = tmp_path / "memory"
    memory.mkdir()
    if version:
        (memory / "SCHEMA_VERSION").write_text(f"v{version}\n")
    (memory / "metadata.db").write_bytes(b"UNRELATED METADATA")
    folder = memory / "long_term/confirmed/fact"
    folder.mkdir(parents=True)
    (folder / "old.md").write_text("---\nid: old\n---\nOriginal body\n")
    with sqlite3.connect(memory / "long_term_v2.db") as connection:
        connection.execute("CREATE TABLE memories(id TEXT PRIMARY KEY, use_count INTEGER)")
        connection.execute("INSERT INTO memories VALUES('old',42)")
        connection.execute("CREATE TABLE embeddings(id TEXT)")
    with sqlite3.connect(memory / "short_term.db") as connection:
        connection.execute("CREATE TABLE short_term_memory(id TEXT, content TEXT, topic TEXT, keywords TEXT, scopes TEXT)")
        connection.execute("INSERT INTO short_term_memory VALUES('one','你好 Crabot hello','test','word','[]')")
    admin = tmp_path / "admin"
    (admin / "module-configs").mkdir(parents=True)
    (admin / "global-config.json").write_text(json.dumps({"default_embedding_provider_id": "old", "keep": "unchanged"}))
    (admin / "module-configs/memory-one.json").write_text(json.dumps({"config": {"CRABOT_EMBEDDING_KEY": "old", "KEEP": "unchanged"}}))
    argv = ["node", str(HOME / "scripts/execute-scoped-migration.mjs"), f"--module={HOME / 'crabot-memory'}", f"--data={memory}", f"--from=v{version}", "--to=v5", f"--python={sys.executable}"]
    migrated = subprocess.run(argv, capture_output=True, text=True)
    assert migrated.returncode == 0, migrated.stderr
    # Direct scripts still leave the version marker to the formal upgrade/start entry.
    assert (memory / "SCHEMA_VERSION").read_text() == f"v{version}\n" if version else not (memory / "SCHEMA_VERSION").exists()
    code = f"""
      import {{ runMigrations }} from {json.dumps((HOME / 'scripts/upgrade-lib/migrate.mjs').as_uri())};
      const result = await runMigrations({json.dumps(str(HOME))}, {json.dumps(str(tmp_path))}, () => {{ throw new Error('already converted: must not rerun scripts'); }}, {{ info() {{}} }});
      if (!result.ok) throw new Error('formal completion failed');
    """
    run_node(code)
    assert (memory / "SCHEMA_VERSION").read_text() == "v5\n"
    assert len(list((tmp_path / ".upgrade-migrations").iterdir())) == 1
    assert list(tmp_path.glob("memory*backup*")) == []
    assert (memory / "metadata.db").read_bytes() == b"UNRELATED METADATA"
    assert (folder / "old.md").read_text().endswith("Original body\n")
    with sqlite3.connect(memory / "long_term_v2.db") as connection:
        assert connection.execute("SELECT use_count,visibility,scopes FROM memories").fetchone() == (42, "internal", "[]")
        if version <= 2:
            assert connection.execute("SELECT name FROM sqlite_master WHERE name='embeddings'").fetchone() is None
    if version <= 2:
        assert json.loads((admin / "global-config.json").read_text()) == {"keep": "unchanged"}
        assert json.loads((admin / "module-configs/memory-one.json").read_text()) == {"config": {"KEEP": "unchanged"}}
    if version <= 3:
        with sqlite3.connect(memory / "short_term.db") as connection:
            assert connection.execute("SELECT content FROM short_term_fts WHERE short_term_fts MATCH 'hello'").fetchone() == ("你好 Crabot hello",)


def test_uncheckpointed_wal_is_preserved_in_scoped_backup(tmp_path):
    memory = tmp_path / "memory"
    memory.mkdir()
    (memory / "SCHEMA_VERSION").write_text("v4\n")
    # Simulate a stopped writer after a crash, retaining committed WAL pages.
    source = """
import sqlite3, os, sys
from pathlib import Path
root = Path(sys.argv[1])
for name, statement in [('long_term_v2.db', 'CREATE TABLE memories(id TEXT PRIMARY KEY, use_count INTEGER)'), ('short_term.db', 'CREATE TABLE short_term_memory(scopes TEXT)')]:
    conn = sqlite3.connect(root / name)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute(statement)
    if name.startswith('long'): conn.execute("INSERT INTO memories VALUES('wal',81)")
    else: conn.execute("INSERT INTO short_term_memory VALUES('[]')")
    conn.commit()
os._exit(0)
"""
    subprocess.run([sys.executable, "-c", source, str(memory)], check=True)
    argv = ["node", str(HOME / "scripts/execute-scoped-migration.mjs"), f"--module={HOME / 'crabot-memory'}", f"--data={memory}", "--from=v4", "--to=v5", f"--python={sys.executable}"]
    result = subprocess.run(argv, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    backup = Path(json.loads(result.stdout.splitlines()[-1])["backupPath"]) / "memory"
    assert (backup / "long_term_v2.db-wal").is_file()
    with sqlite3.connect(memory / "long_term_v2.db") as connection:
        assert connection.execute("SELECT use_count,visibility FROM memories WHERE id='wal'").fetchone() == (81, "internal")

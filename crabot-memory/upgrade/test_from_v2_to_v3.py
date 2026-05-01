"""crabot-memory v2 → v3 升级脚本单元测试。"""
import json
import sqlite3
from pathlib import Path

import pytest

from upgrade.from_v2_to_v3 import (
    clean_admin_embedding_refs,
    deprecate_lancedb,
    drop_long_term_embeddings,
    migrate,
)


def test_deprecate_lancedb_renames_existing(tmp_path):
    data_dir = tmp_path / "memory"
    (data_dir / "lancedb").mkdir(parents=True)
    (data_dir / "lancedb" / "marker.txt").write_text("hello")

    log = []
    deprecate_lancedb(data_dir, log)

    assert not (data_dir / "lancedb").exists()
    deprecated = list(data_dir.glob("lancedb.deprecated.*"))
    assert len(deprecated) == 1
    assert (deprecated[0] / "marker.txt").read_text() == "hello"
    assert any("renamed" in line for line in log)


def test_deprecate_lancedb_skips_when_absent(tmp_path):
    data_dir = tmp_path / "memory"
    data_dir.mkdir(parents=True)

    log = []
    deprecate_lancedb(data_dir, log)

    assert any("not present" in line for line in log)


def test_drop_long_term_embeddings_drops_table(tmp_path):
    data_dir = tmp_path / "memory"
    data_dir.mkdir(parents=True)
    db_path = data_dir / "long_term_v2.db"

    with sqlite3.connect(str(db_path)) as conn:
        conn.execute("CREATE TABLE embeddings (id TEXT, field TEXT, vec BLOB)")
        conn.execute("CREATE TABLE other (id TEXT)")
        conn.execute("INSERT INTO embeddings VALUES ('m1', 'content', X'00')")
        conn.commit()

    log = []
    drop_long_term_embeddings(data_dir, log)

    with sqlite3.connect(str(db_path)) as conn:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    assert "embeddings" not in tables
    assert "other" in tables  # 未指定的表保留
    assert any("dropped" in line for line in log)


def test_drop_long_term_embeddings_skips_when_no_embeddings_table(tmp_path):
    data_dir = tmp_path / "memory"
    data_dir.mkdir(parents=True)
    db_path = data_dir / "long_term_v2.db"
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute("CREATE TABLE other (id TEXT)")
        conn.commit()

    log = []
    drop_long_term_embeddings(data_dir, log)

    assert any("no embedding tables" in line for line in log)


def test_clean_admin_embedding_refs_strips_env_vars(tmp_path):
    admin_dir = tmp_path / "admin"
    cfg_dir = admin_dir / "module-configs"
    cfg_dir.mkdir(parents=True)

    cfg_path = cfg_dir / "memory-default.json"
    cfg_path.write_text(json.dumps({
        "module_id": "memory-default",
        "config": {
            "CRABOT_LLM_MODEL": "glm-5",
            "CRABOT_LLM_API_KEY": "sk-xxx",
            "CRABOT_EMBEDDING_BASE_URL": "http://localhost:11434/v1",
            "CRABOT_EMBEDDING_MODEL": "qwen3-embedding:0.6b",
            "CRABOT_EMBEDDING_API_KEY": "ollama",
            "CRABOT_EMBEDDING_DIMENSION": "1024",
        },
    }, indent=2))

    log = []
    clean_admin_embedding_refs(admin_dir, log)

    cleaned = json.loads(cfg_path.read_text())["config"]
    assert "CRABOT_LLM_MODEL" in cleaned
    assert "CRABOT_LLM_API_KEY" in cleaned
    assert all(not k.startswith("CRABOT_EMBEDDING_") for k in cleaned)
    assert any("memory-default.json" in line for line in log)


def test_clean_admin_embedding_refs_strips_global_config(tmp_path):
    admin_dir = tmp_path / "admin"
    admin_dir.mkdir(parents=True)

    global_cfg = admin_dir / "global-config.json"
    global_cfg.write_text(json.dumps({
        "default_llm_provider_id": "p1",
        "default_llm_model_id": "m1",
        "default_embedding_provider_id": "p2",
        "default_embedding_model_id": "m2",
    }, indent=2))

    log = []
    clean_admin_embedding_refs(admin_dir, log)

    cleaned = json.loads(global_cfg.read_text())
    assert "default_llm_provider_id" in cleaned
    assert "default_embedding_provider_id" not in cleaned
    assert "default_embedding_model_id" not in cleaned


def test_clean_admin_embedding_refs_skips_missing_dir(tmp_path):
    admin_dir = tmp_path / "admin-not-here"

    log = []
    clean_admin_embedding_refs(admin_dir, log)

    assert any("not present" in line for line in log)


def test_migrate_end_to_end(tmp_path):
    """完整流程：lancedb 改名 + 删 embeddings 表 + 清 admin 配置 + 写日志。"""
    # 准备 v2 数据布局：data/memory/ + data/admin/
    data = tmp_path / "data"
    memory_dir = data / "memory"
    admin_dir = data / "admin"
    (memory_dir / "lancedb").mkdir(parents=True)
    (admin_dir / "module-configs").mkdir(parents=True)

    # 长期记忆 db with embeddings
    with sqlite3.connect(str(memory_dir / "long_term_v2.db")) as conn:
        conn.execute("CREATE TABLE embeddings (id TEXT)")
        conn.execute("CREATE TABLE entries (id TEXT)")
        conn.commit()

    (admin_dir / "module-configs" / "memory-default.json").write_text(json.dumps({
        "config": {"CRABOT_LLM_MODEL": "glm", "CRABOT_EMBEDDING_API_KEY": "x"},
    }))
    (admin_dir / "global-config.json").write_text(json.dumps({
        "default_llm_provider_id": "p",
        "default_embedding_provider_id": "p",
    }))

    migrate(memory_dir)

    # 验证 lancedb 改名
    assert not (memory_dir / "lancedb").exists()
    assert any(memory_dir.glob("lancedb.deprecated.*"))

    # 验证 embeddings 表被删
    with sqlite3.connect(str(memory_dir / "long_term_v2.db")) as conn:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "embeddings" not in tables
    assert "entries" in tables

    # 验证 admin 配置被清
    cfg = json.loads((admin_dir / "module-configs" / "memory-default.json").read_text())
    assert "CRABOT_EMBEDDING_API_KEY" not in cfg["config"]
    assert "CRABOT_LLM_MODEL" in cfg["config"]

    global_cfg = json.loads((admin_dir / "global-config.json").read_text())
    assert "default_embedding_provider_id" not in global_cfg
    assert "default_llm_provider_id" in global_cfg

    # 验证日志
    log_path = memory_dir / "upgrade-v2-to-v3.log"
    assert log_path.exists()
    content = log_path.read_text()
    assert "v2 → v3 migration started" in content
    assert "completed" in content

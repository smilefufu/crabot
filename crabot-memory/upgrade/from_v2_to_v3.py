"""crabot-memory v2 → v3: 移除 embedding 子系统。

操作：
1. 弃用旧 LanceDB short_term：data/memory/lancedb/ → lancedb.deprecated.{ts}/
2. drop long_term_v2.db 的 embeddings 表 + VACUUM（如存在）
3. 清洗 admin 配置里的 embedding 引用：
   - data/admin/module-configs/memory-*.json 删 CRABOT_EMBEDDING_*
   - data/admin/global-config.json 删 default_embedding_*、provider_id
4. 升级日志写到 data/memory/upgrade-v2-to-v3.log

注：项目初期阶段，老 short_term 流水账数据可丢失（不做数据迁移）；data/memory/long_term/
下的 markdown 条目本身完整保留（只丢失向量索引）。

Usage: uv run python crabot-memory/upgrade/from_v2_to_v3.py --data-dir=<path>
"""
import argparse
import json
import os
import sqlite3
import sys
import traceback
from datetime import datetime
from pathlib import Path
from typing import List


def _now_ts() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def deprecate_lancedb(data_dir: Path, log: List[str]) -> None:
    lancedb_dir = data_dir / "lancedb"
    if not lancedb_dir.exists():
        log.append("short_term/lancedb: not present, skipped")
        return
    deprecated = data_dir / f"lancedb.deprecated.{_now_ts()}"
    lancedb_dir.rename(deprecated)
    log.append(f"short_term/lancedb: renamed to {deprecated.name}")


def drop_long_term_embeddings(data_dir: Path, log: List[str]) -> None:
    lt_db = data_dir / "long_term_v2.db"
    if not lt_db.exists():
        log.append("long_term_v2.db: not present, skipped")
        return
    with sqlite3.connect(str(lt_db)) as conn:
        existing = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        dropped: List[str] = []
        for tbl in ("embeddings",):
            if tbl in existing:
                conn.execute(f"DROP TABLE {tbl}")
                dropped.append(tbl)
        conn.commit()
        if dropped:
            conn.execute("VACUUM")
    if dropped:
        log.append(f"long_term_v2.db: dropped {dropped} + VACUUM")
    else:
        log.append("long_term_v2.db: no embedding tables found")


def clean_admin_embedding_refs(admin_dir: Path, log: List[str]) -> None:
    if not admin_dir.exists():
        log.append(f"admin dir not present at {admin_dir}, skipped")
        return

    cleaned = 0
    # module-configs/memory-*.json：删 CRABOT_EMBEDDING_* env vars
    cfg_dir = admin_dir / "module-configs"
    if cfg_dir.exists():
        for cfg_path in cfg_dir.glob("memory-*.json"):
            try:
                data = json.loads(cfg_path.read_text(encoding="utf-8"))
                config = data.get("config", {})
                before_keys = set(config.keys())
                cleaned_config = {
                    k: v for k, v in config.items()
                    if not k.startswith("CRABOT_EMBEDDING_")
                }
                if len(cleaned_config) < len(before_keys):
                    data["config"] = cleaned_config
                    cfg_path.write_text(
                        json.dumps(data, indent=2, ensure_ascii=False),
                        encoding="utf-8",
                    )
                    removed = before_keys - set(cleaned_config.keys())
                    cleaned += len(removed)
                    log.append(f"admin/{cfg_path.name}: removed {sorted(removed)}")
            except Exception as e:  # noqa: BLE001
                log.append(f"admin/{cfg_path.name}: failed to clean: {e}")

    # global-config.json：删 default_embedding_*
    global_cfg = admin_dir / "global-config.json"
    if global_cfg.exists():
        try:
            data = json.loads(global_cfg.read_text(encoding="utf-8"))
            removed_keys = [k for k in list(data.keys()) if k.startswith("default_embedding_")]
            for k in removed_keys:
                del data[k]
            if removed_keys:
                global_cfg.write_text(
                    json.dumps(data, indent=2, ensure_ascii=False),
                    encoding="utf-8",
                )
                cleaned += len(removed_keys)
                log.append(f"admin/global-config.json: removed {removed_keys}")
        except Exception as e:  # noqa: BLE001
            log.append(f"admin/global-config.json: failed to clean: {e}")

    log.append(f"admin: total {cleaned} embedding refs cleaned")


def migrate(data_dir: Path) -> None:
    log: List[str] = [f"=== v2 → v3 migration started at {datetime.now().isoformat()} ==="]

    # data_dir 期望是 .../data/memory/
    # admin 数据目录在 .../data/admin/
    admin_dir = data_dir.parent / "admin"

    deprecate_lancedb(data_dir, log)
    drop_long_term_embeddings(data_dir, log)
    clean_admin_embedding_refs(admin_dir, log)

    log.append(f"=== completed at {datetime.now().isoformat()} ===")
    log_path = data_dir / "upgrade-v2-to-v3.log"
    log_path.write_text("\n".join(log) + "\n", encoding="utf-8")
    print("\n".join(log))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True, help="memory data dir, e.g. data/memory")
    args = parser.parse_args()
    data_dir = Path(args.data_dir).resolve()
    if not data_dir.exists():
        print(f"ERROR: data dir not found: {data_dir}", file=sys.stderr)
        return 1
    try:
        migrate(data_dir)
        return 0
    except Exception:
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())

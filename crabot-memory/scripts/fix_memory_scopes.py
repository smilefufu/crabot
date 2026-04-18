"""
回填历史数据：群聊来源的记忆如果 scopes 为空，把 [session_id] 写回。

用法：
    # 从 crabot-memory 目录执行
    uv run scripts/fix_memory_scopes.py --dry-run
    uv run scripts/fix_memory_scopes.py --apply

环境变量：
    DATA_DIR  数据目录根（默认 ../data），脚本会读取 <DATA_DIR>/memory/lancedb
"""
import argparse
import json
import os
import sys
from pathlib import Path

import lancedb


def process_table(table, apply: bool) -> int:
    rows = table.to_arrow().to_pylist()
    patched = 0
    for row in rows:
        scopes = list(row.get("scopes") or [])
        if scopes:
            continue
        source_json = row.get("source_json")
        if not source_json:
            continue
        try:
            source = json.loads(source_json)
        except json.JSONDecodeError:
            continue
        session_id = source.get("session_id")
        channel_id = source.get("channel_id")
        if not session_id or not channel_id:
            continue
        memory_id = row.get("id")
        print(f"  {memory_id}: scopes ← [{session_id!r}]")
        if apply:
            escaped_id = str(memory_id).replace("'", "''")
            table.update(
                where=f"id = '{escaped_id}'",
                values={"scopes": [session_id]},
            )
        patched += 1
    return patched


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true", help="只预览，不写入")
    group.add_argument("--apply", action="store_true", help="实际执行")
    args = parser.parse_args()

    apply = args.apply
    data_dir = Path(os.environ.get("DATA_DIR", "../data")).resolve()
    db_path = data_dir / "memory" / "lancedb"
    if not db_path.exists():
        print(f"LanceDB 路径不存在: {db_path}", file=sys.stderr)
        return 1

    db = lancedb.connect(str(db_path))
    table_names = db.table_names()
    print(f"LanceDB 目录: {db_path}")
    print(f"可用表: {table_names}\n")

    total = 0
    for name in ("long_term_memory", "short_term_memory"):
        if name not in table_names:
            continue
        print(f"[{name}]")
        table = db.open_table(name)
        patched = process_table(table, apply=apply)
        print(f"  命中 {patched} 条\n")
        total += patched

    print(f"总计：{total} 条{'已修复' if apply else '候选'}")
    if not apply:
        print("这是 dry-run；传 --apply 执行真实更新")
    return 0


if __name__ == "__main__":
    sys.exit(main())

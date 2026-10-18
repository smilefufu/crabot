"""crabot-memory v3 → v4: 短期记忆 FTS5 召回升级。

操作：
1. 由共同迁移事务核验本次实际写入范围的备份
2. 在原库 DROP（若存在）+ 重建 FTS5 虚拟表 + 3 个 trigger（trigram tokenizer）
3. INSERT INTO short_term_fts(short_term_fts) VALUES('rebuild') 全量重建索引
4. 写 SCHEMA_VERSION 到 v4

幂等：脚本反复跑安全 —— DROP IF EXISTS 后重建。
回滚（手工）：drop FTS 虚拟表 + trigger，SCHEMA_VERSION 回 v3，应用层 git revert。

Tokenizer 选 trigram 而非 unicode61：unicode61 不切 CJK 连续字符串，导致中文 query 0 命中。
详见 crabot-docs/superpowers/specs/2026-05-08-short-term-memory-sop-and-fts-design.md §3.3。

Usage: uv run python crabot-memory/upgrade/from_v3_to_v4.py --data-dir=<path>
"""
import argparse
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import List, Optional


sys.path.insert(0, str(Path(__file__).resolve().parent))
from scoped_upgrade import enter, require_context


def build_fts_index(db_path: Path, log: List[str]) -> None:
    if not db_path.exists():
        log.append("short_term.db: not present, skipping FTS build")
        return

    # isolation_level=None 关闭 sqlite3 模块的隐式 transaction 管理，
    # 由我们显式控制 BEGIN/COMMIT/ROLLBACK，确保 DDL + rebuild 是原子的。
    conn = sqlite3.connect(str(db_path), isolation_level=None)
    try:
        cur = conn.cursor()
        cur.execute("BEGIN")
        try:
            # 幂等：先 drop 现有的 FTS 表 + trigger 再重建
            cur.execute("DROP TRIGGER IF EXISTS short_term_ai")
            cur.execute("DROP TRIGGER IF EXISTS short_term_ad")
            cur.execute("DROP TRIGGER IF EXISTS short_term_au")
            cur.execute("DROP TABLE IF EXISTS short_term_fts")

            cur.execute("""
                CREATE VIRTUAL TABLE short_term_fts USING fts5(
                    content,
                    topic,
                    keywords,
                    content='short_term_memory',
                    content_rowid='rowid',
                    tokenize='trigram'
                )
            """)
            cur.execute("""
                CREATE TRIGGER short_term_ai
                AFTER INSERT ON short_term_memory BEGIN
                    INSERT INTO short_term_fts(rowid, content, topic, keywords)
                    VALUES (new.rowid, new.content, COALESCE(new.topic, ''), new.keywords);
                END
            """)
            cur.execute("""
                CREATE TRIGGER short_term_ad
                AFTER DELETE ON short_term_memory BEGIN
                    INSERT INTO short_term_fts(short_term_fts, rowid, content, topic, keywords)
                    VALUES ('delete', old.rowid, old.content, COALESCE(old.topic, ''), old.keywords);
                END
            """)
            cur.execute("""
                CREATE TRIGGER short_term_au
                AFTER UPDATE ON short_term_memory BEGIN
                    INSERT INTO short_term_fts(short_term_fts, rowid, content, topic, keywords)
                    VALUES ('delete', old.rowid, old.content, COALESCE(old.topic, ''), old.keywords);
                    INSERT INTO short_term_fts(rowid, content, topic, keywords)
                    VALUES (new.rowid, new.content, COALESCE(new.topic, ''), new.keywords);
                END
            """)
            cur.execute("INSERT INTO short_term_fts(short_term_fts) VALUES('rebuild')")
            cur.execute("COMMIT")
        except Exception:
            # rebuild / DDL 中途失败：回滚以避免留下"空 FTS + 活 trigger"残骸
            cur.execute("ROLLBACK")
            raise
        count = cur.execute("SELECT COUNT(*) FROM short_term_fts").fetchone()[0]
        log.append(f"short_term.db: FTS rebuild done, {count} rows indexed")
    finally:
        conn.close()


def migrate(data_dir: Path) -> List[str]:
    """v3 → v4 迁移。

    SCHEMA_VERSION 由 upgrade framework (`scripts/upgrade-lib/migrate.mjs`) 在脚本
    成功返回后回写，本脚本不重复处理。
    """
    log: List[str] = []
    log.append(f"=== v3 → v4 migration started at {datetime.now().isoformat()} ===")
    db = data_dir / "short_term.db"
    require_context(data_dir)
    build_fts_index(db, log)
    log.append(f"=== v3 → v4 migration completed at {datetime.now().isoformat()} ===")

    log_file = data_dir / "upgrade-v3-to-v4.log"
    log_file.write_text("\n".join(log) + "\n", encoding="utf-8")
    return log


def main() -> int:
    parser = argparse.ArgumentParser(description="crabot-memory v3 → v4 upgrade")
    parser.add_argument("--data-dir", required=True, help="memory data directory")
    args = parser.parse_args()

    data_dir = Path(args.data_dir).resolve()
    if not data_dir.exists():
        print(f"data dir not found: {data_dir}", file=sys.stderr)
        return 1

    try:
        result = enter(data_dir, 3, 4)
        if result is not None:
            return 0
        log = migrate(data_dir)
        for line in log:
            print(line)
        return 0
    except Exception:
        # migrate 抛异常时，best-effort 把失败信息追加到 log 文件
        # 否则 operator 失去主要调试信息（migrate 内部成功步骤已经写过部分 log，
        # 这里只追加 traceback，不重复写完整 log）
        import traceback
        log_file = data_dir / "upgrade-v3-to-v4.log"
        try:
            with log_file.open("a", encoding="utf-8") as f:
                f.write(f"\n=== upgrade FAILED at {datetime.now().isoformat()} ===\n")
                traceback.print_exc(file=f)
        except Exception:
            pass  # 日志写不出也不要再嵌套异常
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

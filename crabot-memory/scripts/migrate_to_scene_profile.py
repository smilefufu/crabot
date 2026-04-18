"""
长期记忆迁移到场景画像（半自动）。

两阶段：
  1) dry-run 模式：扫描 long-term，按启发式分类，产出 migration-plan.md
  2) --apply 模式：只执行 "delete"（黑名单回收）；"move_to_scene" 需人工处理
     （推荐通过 Admin UI 或 Worker 对话触发 set_scene_anchor，避免误伤）

用法：
  # 从 crabot-memory 目录执行
  uv run scripts/migrate_to_scene_profile.py --dry-run --plan ../migration-plan.md
  # 人工审阅并编辑 plan 后：
  uv run scripts/migrate_to_scene_profile.py --apply --plan ../migration-plan.md

环境：
  DATA_DIR        数据目录根（默认 ../data）
  MEMORY_PORT     Memory 模块 RPC 端口（默认从 <DATA_DIR>/port-allocations.json 读取）
"""
import argparse
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import lancedb


SCENE_RULE_PATTERNS = [
    re.compile(r"规则"),
    re.compile(r"职责"),
    re.compile(r"禁止"),
    re.compile(r"必须"),
    re.compile(r"不允许"),
    re.compile(r"以后"),
    re.compile(r"本群|本对话|这个群"),
]

BLACKLIST_PATTERNS = [
    re.compile(r"今天|昨天|本周|本月|刚刚"),
    re.compile(r"\d+\s*%"),
    re.compile(r"commit\s+[a-f0-9]{7,}"),
    re.compile(r"fix.*bug.*(已|成功)"),
    re.compile(r"排行榜|榜单"),
]


def classify(row: dict) -> str:
    content = row.get("content") or ""
    tags = row.get("tags_json") or "[]"
    try:
        tag_list = json.loads(tags)
    except json.JSONDecodeError:
        tag_list = []
    text = content + " " + " ".join(tag_list)

    source_json = row.get("source_json") or "{}"
    try:
        source = json.loads(source_json)
    except json.JSONDecodeError:
        source = {}
    has_session = bool(source.get("session_id") or source.get("channel_id"))

    if any(p.search(text) for p in BLACKLIST_PATTERNS):
        return "delete"
    if any(p.search(text) for p in SCENE_RULE_PATTERNS) and has_session:
        return "move_to_scene"
    return "keep"


def load_memory_port(data_dir: Path) -> Optional[int]:
    if "MEMORY_PORT" in os.environ:
        return int(os.environ["MEMORY_PORT"])
    path = data_dir / "port-allocations.json"
    if not path.exists():
        return None
    items = json.loads(path.read_text())
    for item in items:
        if "memory" in item.get("module_id", "").lower():
            return int(item["port"])
    return None


def rpc_call(port: int, method: str, params: dict) -> dict:
    body = json.dumps(
        {
            "id": f"migrate-{datetime.now(timezone.utc).isoformat()}",
            "source": "migrate_to_scene_profile",
            "method": method,
            "params": params,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"http://localhost:{port}/{method}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def render_plan(buckets: dict, plan_path: Path) -> None:
    lines = [
        "# Memory → SceneProfile 迁移计划",
        "",
        "- **delete 行**：`--apply` 会调用 `delete_memory` 回收这些条目。保留 `[x]` 表示执行，改为 `[ ]` 跳过。",
        "- **move_to_scene 行**：脚本不自动搬迁，请通过 Admin UI 或让 Worker 调用 `set_scene_anchor` 完成。",
        "- **keep 行**：仅做参考，`--apply` 不会动它们。",
        "",
    ]
    for bucket_name, rows in buckets.items():
        lines.append(f"## {bucket_name}（{len(rows)} 条）")
        lines.append("")
        for r in rows:
            abstract = (r.get("abstract") or r.get("content") or "").splitlines()[0][:120]
            source_json = r.get("source_json") or "{}"
            lines.append(f"- [x] `{r['id']}` — {abstract}")
            lines.append(f"      source: {source_json}")
        lines.append("")
    plan_path.write_text("\n".join(lines), encoding="utf-8")


def parse_plan_actions(plan_path: Path) -> list:
    text = plan_path.read_text()
    active = None
    actions = []
    for line in text.splitlines():
        m = re.match(r"##\s+(\S+)", line)
        if m:
            active = m.group(1)
            continue
        if not active:
            continue
        m = re.match(r"-\s+\[([ xX])\]\s+`([^`]+)`", line)
        if m and m.group(1).lower() == "x":
            actions.append((active, m.group(2)))
    return actions


def do_apply(actions: list, memory_port: int) -> None:
    for bucket, memory_id in actions:
        if bucket == "delete":
            print(f"delete_memory({memory_id})")
            rpc_call(memory_port, "delete_memory", {"memory_id": memory_id})
        elif bucket == "move_to_scene":
            print(f"SKIP move_to_scene({memory_id}) — 请手工处理")
        else:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true")
    group.add_argument("--apply", action="store_true")
    parser.add_argument("--plan", required=True, help="plan markdown 路径")
    args = parser.parse_args()

    data_dir = Path(os.environ.get("DATA_DIR", "../data")).resolve()
    plan_path = Path(args.plan).resolve()

    if args.dry_run:
        db_path = data_dir / "memory" / "lancedb"
        if not db_path.exists():
            print(f"LanceDB 路径不存在: {db_path}", file=sys.stderr)
            return 1
        db = lancedb.connect(str(db_path))
        if "long_term_memory" not in db.table_names():
            print("未找到 long_term_memory 表", file=sys.stderr)
            return 1
        rows = db.open_table("long_term_memory").to_arrow().to_pylist()
        buckets = {"delete": [], "move_to_scene": [], "keep": []}
        for r in rows:
            buckets[classify(r)].append(r)
        render_plan(buckets, plan_path)
        total = sum(len(v) for v in buckets.values())
        print(f"共 {total} 条，分类：")
        for k, v in buckets.items():
            print(f"  {k}: {len(v)}")
        print(f"plan 已写入 {plan_path}")
        print("人工审阅并编辑 checkbox 后，再运行 --apply")
        return 0

    if args.apply:
        if not plan_path.exists():
            print(f"plan 不存在: {plan_path}", file=sys.stderr)
            return 1
        memory_port = load_memory_port(data_dir)
        if memory_port is None:
            print("未能确定 Memory 端口，请设置 MEMORY_PORT env", file=sys.stderr)
            return 1
        actions = parse_plan_actions(plan_path)
        if not actions:
            print("plan 中没有 checked 的动作")
            return 0
        print(f"从 plan 读取 {len(actions)} 个 checked 动作，Memory 端口 {memory_port}")
        do_apply(actions, memory_port)
        print("完成")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())

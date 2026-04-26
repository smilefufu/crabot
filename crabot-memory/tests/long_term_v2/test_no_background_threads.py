"""验证 long_term_v2 模块源码不含后台调度（spec §6.0.4）。"""
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent.parent / "src" / "long_term_v2"


def test_no_create_task_loops():
    forbidden = ["asyncio.create_task", "schedule.every", "Cron(", "BackgroundScheduler"]
    for path in SRC.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for token in forbidden:
            assert token not in text, f"Forbidden background pattern '{token}' found in {path}"


def test_no_threading_module():
    for path in SRC.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "import threading" not in text, f"threading found in {path}"
        assert "from threading" not in text, f"threading import found in {path}"

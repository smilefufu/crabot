"""Crabot stdio entry. Upstream tool schemas and responses remain unchanged."""
import asyncio
import functools
import inspect
import json
import os
from pathlib import Path
import signal
import site
import sys
import tempfile

RUNTIME = Path(__file__).resolve().parent
sys.path.insert(0, str(RUNTIME / "packages"))
if sys.platform == "win32":
    site.addsitedir(str(RUNTIME / "packages"))  # 加载锁定 pywin32 的相对路径与 DLL bootstrap。
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(RUNTIME / "browsers")


def enforce_headless(method):
    signature = inspect.signature(method)

    @functools.wraps(method)
    async def guarded(*args, **kwargs):
        parameters = signature.bind(*args, **kwargs)
        # 显式 CDP 由远端拥有浏览器生命周期，保持上游语义。
        if not parameters.arguments.get("cdp_url"):
            if parameters.arguments.get("headless") is False:
                from mcp.server.mcpserver.exceptions import ToolError
                raise ToolError("This Crabot instance has no desktop; local Scrapling browsers require headless=true")
            parameters.arguments["headless"] = True
        return await method(*parameters.args, **parameters.kwargs)

    return guarded


async def serve():
    from scrapling.core.ai import ScraplingMCPServer
    from anyio import move_on_after
    manifest = json.loads((RUNTIME / "ready.json").read_text())
    os.environ["PLAYWRIGHT_NODEJS_PATH"] = str(RUNTIME / manifest["node"])
    if sys.platform == "linux":
        os.environ["FONTCONFIG_FILE"] = str(RUNTIME / "fonts.conf")
    upstream = ScraplingMCPServer(executable_path=str(RUNTIME / manifest["browser"]))
    headless = os.environ.get("CRABOT_SCRAPLING_SYSTEM") == "1" or (
        sys.platform == "linux" and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    )
    if headless:
        for name in ("open_session", "fetch", "bulk_fetch", "stealthy_fetch", "bulk_stealthy_fetch"):
            setattr(upstream, name, enforce_headless(getattr(upstream, name)))
    server = upstream._build_server("127.0.0.1", 8000)
    running = asyncio.current_task()
    previous = signal.signal(signal.SIGTERM, lambda *_: running.cancel())
    try:
        await server.run_stdio_async()
    finally:
        # shield 防止取消截断清理；只关闭本进程创建的 session。
        with move_on_after(10, shield=True):
            for session_id in list(upstream._sessions):
                try:
                    await upstream.close_session(session_id)
                except Exception as exc:
                    print(f"Scrapling session cleanup failed: {exc}", file=sys.stderr)
        signal.signal(signal.SIGTERM, previous)


def main():
    data_dir = os.environ.get("CRABOT_SCRAPLING_DATA_DIR")
    if not data_dir:
        raise RuntimeError("CRABOT_SCRAPLING_DATA_DIR must identify the instance's private data directory")
    private = Path(data_dir) / "scrapling"
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    # 每个 MCP 进程自己的临时目录，不能清理其它 worker/用户。
    with tempfile.TemporaryDirectory(prefix="mcp-", dir=private) as temporary:
        os.environ["TMPDIR"] = temporary
        os.environ["TEMP"] = temporary
        os.environ["TMP"] = temporary
        os.environ["XDG_CACHE_HOME"] = str(private / "cache")
        tempfile.tempdir = temporary
        try:
            asyncio.run(serve())
        except asyncio.CancelledError:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Scrapling startup failed: {exc}", file=sys.stderr)
        sys.exit(1)

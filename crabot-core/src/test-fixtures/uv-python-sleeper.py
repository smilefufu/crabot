#!/usr/bin/env python3
"""Real uv -> python process-tree fixture for Module Manager tests."""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

pid_file = Path(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else "sleep"
port = int(sys.argv[3]) if len(sys.argv) > 3 else 0
ignore_term = mode == "ignore-term"

if ignore_term:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
else:
    signal.signal(signal.SIGTERM, lambda _signum, _frame: os._exit(0))


def write_info(shutdown_called: bool = False) -> None:
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(
        json.dumps({
            "pid": os.getpid(),
            "ppid": os.getppid(),
            "pgid": os.getpgid(0),
            "marker": os.getenv("TEST_MARKER"),
            "shutdown_called": shutdown_called,
        }),
        encoding="utf-8",
    )


write_info()

if mode == "exit-zero":
    time.sleep(0.05)
    sys.exit(0)

if mode in {"http", "http-hang", "http-drip"}:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - stdlib handler name
            length = int(self.headers.get("Content-Length", "0"))
            if length:
                self.rfile.read(length)
            if self.path == "/shutdown":
                write_info(shutdown_called=True)
                if mode == "http-hang":
                    while True:
                        time.sleep(1)
                if mode == "http-drip":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    while True:
                        self.wfile.write(b" ")
                        self.wfile.flush()
                        time.sleep(0.02)
                body = json.dumps({"success": True, "data": {}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()
                threading.Thread(target=server.shutdown, daemon=True).start()
                return
            body = json.dumps({"success": True, "data": {"status": "healthy"}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("localhost", port), Handler)
    server.serve_forever()
    server.server_close()
    sys.exit(0)

while True:
    time.sleep(0.1)

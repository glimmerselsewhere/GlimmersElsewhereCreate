#!/usr/bin/env python3
"""Local web tool: one sentence -> one playable little world.

Serves:
  /                 the create page (index.html)
  /api/generate     POST {sentence, planOnly, api:{base,key,model,imageBase,imageKey,imageModel}}
  /worlds/...       generated worlds (each one has its own playable index.html)
  /app/ /vendor/ /i18n/...  the bundled player

Your API settings live in the browser (localStorage) and are only passed to the
generator for the run you start. Nothing is written to this machine.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PIPELINE = ROOT / "tools" / "generate_world.py"

HOST = os.environ.get("GLIMMERS_CREATE_HOST", "127.0.0.1")
PORT = int(os.environ.get("GLIMMERS_CREATE_PORT", "8096"))
MAX_BODY_BYTES = 64 * 1024

lock = threading.Lock()
busy = False

API_ENV = (
    ("base", "GLIMMERS_LLM_BASE"),
    ("key", "GLIMMERS_LLM_KEY"),
    ("model", "GLIMMERS_LLM_MODEL"),
    ("imageBase", "GLIMMERS_IMAGE_BASE"),
    ("imageKey", "GLIMMERS_IMAGE_KEY"),
    ("imageModel", "GLIMMERS_IMAGE_MODEL"),
)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):  # keep the console quiet; we print our own lines
        pass

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        global busy
        if self.path != "/api/generate":
            self.send_json({"error": "not found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY_BYTES:
            self.send_json({"error": "请求体过大"}, 413)
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self.send_json({"error": "bad request"}, 400)
            return
        sentence = str(body.get("sentence", "")).strip()
        if not sentence or len(sentence) > 200:
            self.send_json({"error": "请输入一句话（不超过 200 字）"}, 400)
            return
        api = body.get("api") or {}
        env = dict(os.environ)
        for field, env_name in API_ENV:
            value = str(api.get(field) or "").strip()
            if value:
                env[env_name] = value
        env["GLIMMERS_PLAY_BASE"] = f"http://{HOST}:{PORT}"

        with lock:
            if busy:
                self.send_json({"error": "已有任务在生成中，请稍后再试"}, 429)
                return
            busy = True
        try:
            command = [sys.executable, str(PIPELINE), "--sentence", sentence]
            if body.get("planOnly"):
                command.append("--plan-only")
            workers = int(body.get("workers") or 0)
            if workers > 0:
                command += ["--workers", str(workers)]
            started = time.time()
            result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=3600, env=env)
            log = (result.stdout or "") + (result.stderr or "")
            elapsed = round(time.time() - started, 1)
            match = re.search(r"^RESULT (\{.*\})$", log, flags=re.M)
            if not match:
                self.send_json({"error": "生成失败", "log": log[-4000:]}, 500)
                return
            payload = json.loads(match.group(1))
            if not payload.get("ok", True):
                self.send_json({"error": payload.get("error") or "生成失败", "log": log[-4000:]}, 500)
                return
            payload["seconds"] = elapsed
            payload["log"] = log[-4000:]
            self.send_json(payload)
        except subprocess.TimeoutExpired:
            self.send_json({"error": "超时（1 小时）"}, 504)
        finally:
            with lock:
                busy = False


def main() -> int:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"create entry: http://{HOST}:{PORT}/")
    print("  type your own API endpoint + key on the page; nothing is stored on this machine.")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

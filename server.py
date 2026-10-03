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
CONFIG_PATH = ROOT / "config.json"

HOST = os.environ.get("GLIMMERS_CREATE_HOST", "127.0.0.1")
PORT = int(os.environ.get("GLIMMERS_CREATE_PORT", "8096"))
MAX_BODY_BYTES = 64 * 1024

MESSAGES = {
    "en": {
        "too_large": "Request body too large",
        "sentence": "Please write one sentence (max 200 characters).",
        "no_key": "No API key yet: copy config.example.json to config.json, or type one on the page.",
        "busy": "Another generation is already running — please wait a moment.",
        "timeout": "Timed out (1 hour).",
        "failed": "Generation failed.",
    },
    "zh": {
        "too_large": "请求体过大",
        "sentence": "请输入一句话（不超过 200 字）",
        "no_key": "还没有 API Key：把 config.example.json 复制成 config.json 填好，或在页面的输入框里填一个。",
        "busy": "已有任务在生成中，请稍后再试",
        "timeout": "超时（1 小时）",
        "failed": "生成失败",
    },
}

lock = threading.Lock()
busy = False
progress_lock = threading.Lock()
progress = {"running": False, "started": 0.0, "lines": []}
MAX_LINES = 400

API_ENV = (
    ("base", "GLIMMERS_LLM_BASE"),
    ("key", "GLIMMERS_LLM_KEY"),
    ("model", "GLIMMERS_LLM_MODEL"),
    ("imageBase", "GLIMMERS_IMAGE_BASE"),
    ("imageKey", "GLIMMERS_IMAGE_KEY"),
    ("imageModel", "GLIMMERS_IMAGE_MODEL"),
    ("imageExtra", "GLIMMERS_IMAGE_EXTRA"),
)


def load_config() -> dict:
    """Local config.json (gitignored). Never served over HTTP, never logged."""
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def config_digest() -> dict:
    cfg = load_config()
    llm = cfg.get("llm") or {}
    image = cfg.get("image") or {}
    return {
        "llm": {
            "base": str(llm.get("base") or "").strip(),
            "model": str(llm.get("model") or "").strip(),
            "hasKey": bool(str(llm.get("key") or "").strip()),
        },
        "image": {
            "base": str(image.get("base") or "").strip(),
            "model": str(image.get("model") or "").strip(),
            "hasKey": bool(str(image.get("key") or "").strip()),
        },
    }


def reset_progress() -> None:
    with progress_lock:
        progress["running"] = True
        progress["started"] = time.time()
        progress["lines"] = []


def scrub_paths(text: str) -> str:
    """Never leak absolute paths (or the local username) through progress / logs."""
    text = text.replace(str(ROOT) + os.sep, "")
    text = text.replace(str(ROOT), ".")
    return re.sub(r"/Users/[^/\s:]+", "~", text)


def append_log(line: str) -> None:
    with progress_lock:
        progress["lines"].append(scrub_paths(line.rstrip("\n")))
        if len(progress["lines"]) > MAX_LINES:
            del progress["lines"][:-MAX_LINES]


def read_worker(proc: subprocess.Popen) -> None:
    for line in proc.stdout or []:
        append_log(line)
    proc.wait()


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

    def end_headers(self):
        # Local tool: never let the browser keep a stale page / stale JS.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/config":
            self.send_json(config_digest())
            return
        if path == "/api/progress":
            with progress_lock:
                seconds = round(time.time() - progress["started"], 1) if progress["running"] else 0
                self.send_json({"running": progress["running"], "seconds": seconds, "lines": list(progress["lines"][-60:])})
            return
        if path in ("/config.json", "/config.local.json") or path.endswith("/config.json"):
            # The key file is local-only: never expose it through the web page.
            self.send_json({"error": "config.json 只在本机使用，不通过网页提供"}, 403)
            return
        super().do_GET()

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
            self.send_json({"error": MESSAGES["en"]["too_large"]}, 413)
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self.send_json({"error": "bad request"}, 400)
            return
        lang = str(body.get("lang") or "en").strip().lower()
        m = MESSAGES.get(lang, MESSAGES["en"])
        sentence = str(body.get("sentence", "")).strip()
        if not sentence or len(sentence) > 200:
            self.send_json({"error": m["sentence"]}, 400)
            return
        api = body.get("api") or {}
        cfg = load_config()
        llm_cfg = cfg.get("llm") or {}
        image_cfg = cfg.get("image") or {}
        fallback = {
            "base": llm_cfg.get("base"),
            "key": llm_cfg.get("key"),
            "model": llm_cfg.get("model"),
            "imageBase": image_cfg.get("base"),
            "imageKey": image_cfg.get("key"),
            "imageModel": image_cfg.get("model"),
            "imageExtra": json.dumps(image_cfg.get("extra"), ensure_ascii=False) if image_cfg.get("extra") else "",
        }
        env = dict(os.environ)
        for field, env_name in API_ENV:
            raw = api.get(field)
            if isinstance(raw, dict):
                raw = json.dumps(raw, ensure_ascii=False)
            value = str(raw or "").strip() or str(fallback.get(field) or "").strip()
            if value:
                env[env_name] = value
        if not env.get("GLIMMERS_LLM_KEY"):
            self.send_json({"error": m["no_key"]}, 400)
            return
        env["GLIMMERS_PLAY_BASE"] = f"http://{HOST}:{PORT}"

        with lock:
            if busy or progress["running"]:
                self.send_json({"error": m["busy"]}, 429)
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
            reset_progress()
            env["PYTHONUNBUFFERED"] = "1"
            command.insert(1, "-u")
            proc = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=env)
            threading.Thread(target=read_worker, args=(proc,), daemon=True).start()
            try:
                proc.wait(timeout=3600)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                self.send_json({"error": m["timeout"]}, 504)
                return
            with progress_lock:
                log = "\n".join(progress["lines"]) + "\n"
            elapsed = round(time.time() - started, 1)
            match = re.search(r"^RESULT (\{.*\})$", log, flags=re.M)
            if not match:
                self.send_json({"error": m["failed"], "log": log[-4000:]}, 500)
                return
            payload = json.loads(match.group(1))
            if not payload.get("ok", True):
                self.send_json({"error": payload.get("error") or m["failed"], "log": log[-4000:]}, 500)
                return
            payload["seconds"] = elapsed
            payload["log"] = log[-4000:]
            self.send_json(payload)
        finally:
            with progress_lock:
                progress["running"] = False
            with lock:
                busy = False


def main() -> int:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"create entry: http://{HOST}:{PORT}/")
    digest = config_digest()
    if digest["llm"]["hasKey"]:
        print(f"  config.json loaded: {digest['llm']['base'] or '(default base)'} · model {digest['llm']['model'] or '(default)'}")
    else:
        print("  no config.json yet: copy config.example.json to config.json, or type the key on the page.")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

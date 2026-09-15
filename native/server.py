"""Authenticated loopback bridge. No cookies, remote API signing, or TLS bypass."""
import argparse
import hmac
import json
import os
import re
import secrets
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from engine import Engine

VERSION = "0.7.1"
PROTOCOL = 2


def instance_lock(root):
    root.mkdir(parents=True, exist_ok=True)
    handle = open(root / "engine.lock", "a+b")
    handle.seek(0)
    if not handle.read(1):
        handle.write(b"0")
        handle.flush()
    handle.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise SystemExit("此数据目录已有引擎运行，请勿重复启动。")
    return handle


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=str(Path(__file__).resolve().parents[1] / "data"))
    parser.add_argument("--port", type=int, default=47653)
    parser.add_argument("--workers", type=int, default=3)
    args = parser.parse_args()
    root = Path(args.data).resolve()
    lock = instance_lock(root)
    secret_file = root / "pairing-token.txt"
    if not secret_file.exists():
        secret_file.write_text(secrets.token_urlsafe(32), encoding="utf-8")
        try:
            secret_file.chmod(0o600)
        except OSError:
            pass
    token = secret_file.read_text(encoding="utf-8").strip()
    if len(token) < 32:
        raise SystemExit("配对令牌文件损坏；关闭程序后删除 pairing-token.txt 再启动。")
    authority = f"127.0.0.1:{args.port}"
    engine = None

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"
        server_version = "ArtworkArchive/0.7"

        def log_message(self, *_):
            pass  # Never log tokens or signed image query strings.

        def client_origin(self):
            """Origin can be absent on extension GETs. A header identifies the client,
            but ONLY the bearer token authenticates it; the header is not a secret."""
            origin = self.headers.get("Origin")
            declared = self.headers.get("X-Archive-Extension", "")
            if origin is not None:
                if not re.fullmatch(r"chrome-extension://[a-p]{32}", origin):
                    return None
                if declared and origin != "chrome-extension://" + declared:
                    return None
                return origin
            if re.fullmatch(r"[a-p]{32}", declared):
                return "chrome-extension://" + declared
            return None

        def origin_ok(self, pairing=False):
            origin = self.client_origin()
            return bool(origin and (pairing or origin in engine.meta("origins", [])))

        def send_json(self, code, data):
            raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            if self.headers.get("Origin") and self.origin_ok(pairing=self.path in ("/v1/pair", "/v1/health")):
                self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
                self.send_header("Vary", "Origin")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Archive-Version", VERSION)
            self.end_headers()
            self.wfile.write(raw)

        def do_OPTIONS(self):
            if self.headers.get("Host") != authority or not self.headers.get("Origin") or not self.origin_ok(pairing=self.path in ("/v1/pair", "/v1/health")):
                return self.send_json(403, {"error": "不允许的来源"})
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Archive-Extension")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def do_GET(self):
            self.handle_api()

        def do_POST(self):
            self.handle_api()

        def handle_api(self):
            self.connection.settimeout(10)
            path = urlsplit(self.path).path
            if self.headers.get("Host") != authority:
                return self.send_json(403, {"error": "Host 被拒绝", "code": "HOST_DENIED"})
            # This public health probe reveals no token, task data, origin list or disk path.
            if path == "/v1/health" and self.command == "GET":
                return self.send_json(200, {"service": "artwork-archive-hybrid", "version": VERSION, "protocol": PROTOCOL})
            if not self.client_origin():
                return self.send_json(403, {"error": "请求来源不匹配，或缺少扩展标识；请重新加载 0.7.1 扩展", "code": "CLIENT_ORIGIN_DENIED"})
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode("utf-8"), ("Bearer " + token).encode("utf-8")):
                return self.send_json(401, {"error": "配对令牌错误，请复制当前本机窗口显示的完整令牌", "code": "TOKEN_INVALID"})
            if not self.origin_ok(pairing=path == "/v1/pair"):
                return self.send_json(403, {"error": "此扩展尚未配对，请输入令牌重新连接", "code": "NOT_PAIRED"})
            try:
                payload = {}
                if self.command == "POST":
                    size = int(self.headers.get("Content-Length", "0"))
                    if not 0 <= size <= 2 * 1024 * 1024 or self.headers.get_content_type() != "application/json":
                        raise ValueError("请求需要不超过 2 MiB 的 JSON")
                    payload = json.loads(self.rfile.read(size) or b"{}")
                    if not isinstance(payload, dict):
                        raise ValueError("请求必须为 JSON 对象")
                if self.command == "GET":
                    if path == "/v1/state":
                        result = engine.snapshot()
                    elif path == "/v1/next":
                        result = engine.next_browser()
                    else:
                        return self.send_json(404, {"error": "接口不存在"})
                elif path == "/v1/pair":
                    origins = engine.meta("origins", [])
                    origin = self.client_origin()
                    if origin not in origins:
                        origins.append(origin)
                        engine.set_meta("origins", origins)
                    result = {"ok": True, "version": VERSION, "protocol": PROTOCOL, "root": str(root)}
                elif path == "/v1/jobs":
                    result = engine.create_job(payload)
                elif path == "/v1/parsed":
                    result = engine.parsed(payload)
                elif path == "/v1/work-failed":
                    engine.fail_work(payload)
                    result = {"ok": True}
                elif path == "/v1/heartbeat":
                    engine.set_meta("collector", {"at": time.time(), "message": str(payload.get("message", "浏览器已连接"))[:300]})
                    result = {"ok": True}
                elif path == "/v1/hold":
                    engine.set_hold(payload.get("code", "AUTH"), payload.get("reason", "请检查官网"), payload.get("until", 0))
                    result = {"ok": True}
                elif path == "/v1/clear-hold":
                    if payload.get("confirmed") is not True:
                        raise ValueError("需要人工确认官网访问状态")
                    engine.clear_hold()
                    result = {"ok": True}
                else:
                    match = re.fullmatch(r"/v1/jobs/([a-f0-9]{32})/(discovery|control|export)", path)
                    if not match:
                        return self.send_json(404, {"error": "接口不存在"})
                    jid, operation = match.groups()
                    if operation == "discovery":
                        result = engine.discovery(jid, payload)
                    elif operation == "control":
                        engine.control(jid, payload.get("action"))
                        result = {"ok": True}
                    else:
                        result = engine.export(jid, payload.get("kind", "zip"))
                self.send_json(200, result or {"ok": True})
            except (ValueError, KeyError, TypeError, OverflowError) as exc:
                self.send_json(400, {"error": str(exc)[:500]})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                print(f"接口异常：{type(exc).__name__}", flush=True)
                self.send_json(500, {"error": "本地引擎错误，请检查控制台及数据目录空间"})

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        lock.close()
        raise SystemExit(f"端口 {args.port} 无法监听：{exc}")
    engine = Engine(root, workers=args.workers)
    print("\n画页存档 · Hybrid 0.7.1 连接修复版", flush=True)
    print(f"本机地址：http://{authority}\n数据目录：{root}", flush=True)
    print(f"连接自检：http://{authority}/v1/health （应显示 version 0.7.1）", flush=True)
    print(f"\n请将以下配对令牌粘贴到 Chrome 扩展控制台：\n\n{token}\n", flush=True)
    print("令牌仅供本机使用，请勿截图公开。保持此窗口运行；Ctrl+C 安全退出。", flush=True)
    def shutdown(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGINT, shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, shutdown)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        engine.close()
        server.server_close()
        lock.close()


if __name__ == "__main__":
    main()

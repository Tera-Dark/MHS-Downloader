"""Artwork Archive Hybrid: local, durable engine. Original MIT implementation."""
from __future__ import annotations

import hashlib
import json
import os
import random
import re
import sqlite3
import threading
import time
import uuid
import warnings
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

import requests
from PIL import Image

HOSTS = {"www.mihuashi.com", "image-assets.mihuashi.com"}
MAX_BYTES = 128 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 32_000_000


def site_url(value, profile=False):
    u = urlsplit(str(value))
    pattern = r"/(users/[^/]+|profiles/\d+)/?" if profile else r"/artworks/\d+/?"
    if u.scheme != "https" or u.hostname != "www.mihuashi.com" or u.port not in (None, 443) or u.username or u.password or not re.fullmatch(pattern, u.path):
        raise ValueError("不是受支持的米画师公开页面地址")
    return "https://www.mihuashi.com" + u.path.rstrip("/")


def asset_url(value):
    u = urlsplit(str(value))
    if u.scheme != "https" or u.hostname not in HOSTS or u.port not in (None, 443) or u.username or u.password or len(str(value)) > 4096:
        raise ValueError("图片 URL 不在 HTTPS 米画师域名白名单内")
    return str(value)


def resume_plan(status, headers, offset, validator=None):
    """Return (append, total); never append a full 200 response to a partial file."""
    if headers.get("Content-Encoding", "identity").lower() not in ("identity", ""):
        raise ValueError("续传要求未压缩的实体内容")
    length = headers.get("Content-Length")
    length = int(length) if length is not None else None
    if length is not None and length < 0:
        raise ValueError("无效 Content-Length")
    if status == 206:
        match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", headers.get("Content-Range", ""))
        if not match:
            raise ValueError("缺少有效 Content-Range")
        start, end, total = map(int, match.groups())
        if start != offset or end < start or end >= total or (length is not None and length != end - start + 1):
            raise ValueError("续传区间与本地偏移不一致")
        # We request the entire tail, not a multipart or capped subrange.
        if end != total - 1:
            raise ValueError("服务器未返回完整剩余区间")
        received = headers.get("ETag") or headers.get("Last-Modified")
        if validator and received != validator:
            raise ValueError("续传实体标识已改变或缺失")
        return True, total
    if status == 200:
        return False, length
    raise ValueError("不支持的图片响应状态")


class Interrupted(Exception):
    pass


class Engine:
    def __init__(self, root, workers=3, start=True):
        self.root = Path(root).resolve()
        for name in ("", "parts", "images", "exports"):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        self.path = self.root / "archive.sqlite3"
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.pack_lock = threading.Lock()
        self.threads = []
        self.workers = max(1, min(4, workers))
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs(
                    id TEXT PRIMARY KEY,source TEXT NOT NULL,mode TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'active',scan_state TEXT NOT NULL DEFAULT 'pending',
                    cursor TEXT NOT NULL DEFAULT '{}',expected INTEGER,reason TEXT NOT NULL DEFAULT '',
                    consent_at REAL NOT NULL,created REAL NOT NULL,updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS works(
                    job TEXT NOT NULL,url TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,next_at REAL NOT NULL DEFAULT 0,
                    title TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY(job,url));
                CREATE TABLE IF NOT EXISTS files(
                    id TEXT PRIMARY KEY,job TEXT NOT NULL,work TEXT NOT NULL,ordinal INTEGER NOT NULL,
                    url TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,
                    next_at REAL NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0,total INTEGER,
                    validator TEXT,path TEXT,sha256 TEXT,error TEXT NOT NULL DEFAULT '',
                    observed_width INTEGER,observed_height INTEGER,mime TEXT,
                    UNIQUE(job,work,ordinal));
                CREATE INDEX IF NOT EXISTS files_due ON files(state,next_at);
                CREATE INDEX IF NOT EXISTS works_due ON works(job,state,next_at);
                CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,job TEXT,state TEXT,path TEXT,error TEXT,created REAL);
            ''')
            db.execute("UPDATE files SET state='retry',next_at=0 WHERE state='downloading'")
            db.execute("UPDATE exports SET state='failed',error='程序退出，已完成图片保留，可重新导出' WHERE state='packing'")
        if start:
            for i in range(self.workers):
                thread = threading.Thread(target=self.worker, name=f"download-{i}", daemon=True)
                thread.start()
                self.threads.append(thread)

    def db(self):
        class Connection(sqlite3.Connection):
            def __exit__(self, *args):
                try:
                    return super().__exit__(*args)
                finally:
                    self.close()
        db = sqlite3.connect(self.path, timeout=15, factory=Connection)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA busy_timeout=15000")
        return db

    def meta(self, key, default=None):
        with self.db() as db:
            row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_meta(self, key, value):
        with self.db() as db:
            db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, json.dumps(value)))

    def create_job(self, payload):
        source = str(payload.get("source", ""))
        profile = not bool(re.search(r"/artworks/\d+/?$", source))
        source = site_url(source, profile)
        mode = payload.get("mode", "download")
        if mode not in ("download", "links"):
            raise ValueError("无效任务模式")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT id FROM jobs WHERE source=? AND mode=? AND state IN ('active','paused','blocked') ORDER BY created DESC LIMIT 1", (source, mode)).fetchone()
            if previous:
                return {"id": previous[0], "existing": True}
            jid, now = uuid.uuid4().hex, time.time()
            db.execute("INSERT INTO jobs(id,source,mode,scan_state,consent_at,created,updated) VALUES(?,?,?,?,?,?,?)", (jid, source, mode, "pending" if profile else "finished", 0, now, now))
            if not profile:
                db.execute("INSERT INTO works(job,url) VALUES(?,?)", (jid, source))
        self.wake.set()
        return {"id": jid}

    def snapshot(self):
        with self.db() as db:
            jobs = [dict(r) for r in db.execute("SELECT * FROM jobs ORDER BY created DESC LIMIT 100")]
            for j in jobs:
                j.pop("cursor", None)
                j["works"] = {r[0]: r[1] for r in db.execute("SELECT state,COUNT(*) FROM works WHERE job=? GROUP BY state", (j["id"],))}
                j["files"] = {r[0]: r[1] for r in db.execute("SELECT state,COUNT(*) FROM files WHERE job=? GROUP BY state", (j["id"],))}
                n = db.execute("SELECT SUM(bytes),SUM(COALESCE(total,bytes)) FROM files WHERE job=?", (j["id"],)).fetchone()
                j["bytes"], j["total_bytes"] = n[0] or 0, n[1] or 0
                j["settled"] = j["scan_state"] in ("finished", "partial") and not any(j["works"].get(s) for s in ("pending", "retry")) and not any(j["files"].get(s) for s in ("queued", "retry", "downloading"))
            errors = [dict(r) for r in db.execute("SELECT job,work AS url,state,error FROM files WHERE error!='' ORDER BY rowid DESC LIMIT 30")]
            errors += [dict(r) for r in db.execute("SELECT job,url,state,error FROM works WHERE error!='' ORDER BY rowid DESC LIMIT 30")]
            exports = [dict(r) for r in db.execute("SELECT * FROM exports ORDER BY created DESC LIMIT 30")]
        return {"version": "0.7.1-hybrid-preview", "jobs": jobs, "errors": errors, "exports": exports,
                "hold": self.meta("hold"), "collector": self.meta("collector"), "workers": self.workers,
                "root": str(self.root)}

    def next_browser(self):
        hold = self.meta("hold")
        if hold:
            return {"hold": hold}
        now = time.time()
        with self.db() as db:
            # Separate candidates enable alternating discovery and details without starving either.
            scan = db.execute("SELECT * FROM jobs WHERE state='active' AND scan_state IN ('pending','running') ORDER BY created LIMIT 1").fetchone()
            work = db.execute("SELECT w.*,j.mode,j.source FROM works w JOIN jobs j ON j.id=w.job WHERE j.state='active' AND w.state IN ('pending','retry') AND w.next_at<=? ORDER BY w.rowid LIMIT 1", (now,)).fetchone()
        return {"scan": dict(scan) if scan else None, "work": dict(work) if work else None}

    def discovery(self, jid, payload):
        raw_links = payload.get("links", [])
        if not isinstance(raw_links, list) or len(raw_links) > 5000:
            raise ValueError("单次发现列表不能超过 5000 条")
        links = [site_url(x) for x in raw_links]
        cursor = payload.get("cursor", {})
        if len(json.dumps(cursor)) > 1024 * 1024:
            raise ValueError("扫描检查点过大")
        state = payload.get("state", "running")
        if state not in ("running", "finished", "partial"):
            raise ValueError("无效扫描状态")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM jobs WHERE id=?", (jid,)).fetchone():
                raise ValueError("任务不存在")
            count = db.execute("SELECT COUNT(*) FROM works WHERE job=?", (jid,)).fetchone()[0]
            for link in links:
                if count >= 5000:
                    state = "partial"
                    break
                count += db.execute("INSERT OR IGNORE INTO works(job,url) VALUES(?,?)", (jid, link)).rowcount
            expected = payload.get("expected")
            if expected is not None and (not isinstance(expected, int) or not 0 <= expected <= 1000000):
                raise ValueError("无效作品数量")
            db.execute("UPDATE jobs SET cursor=?,scan_state=?,expected=COALESCE(?,expected),reason=?,updated=? WHERE id=?", (json.dumps(cursor), state, expected, str(payload.get("reason", ""))[:500], time.time(), jid))
        return {"count": count}

    def parsed(self, payload):
        jid, url = payload["job"], site_url(payload["url"])
        images = payload.get("images", [])
        if not 1 <= len(images) <= 30:
            raise ValueError("详情页没有有效图片，或图片数量超过 30")
        for im in images:
            asset_url(im["url"])
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            job = db.execute("SELECT mode FROM jobs WHERE id=?", (jid,)).fetchone()
            work = db.execute("SELECT state FROM works WHERE job=? AND url=?", (jid, url)).fetchone()
            if not job or not work:
                raise ValueError("详情不属于已登记任务")
            if work[0] == "ready":
                return {"duplicate": True}
            for i, im in enumerate(images, 1):
                fid = hashlib.sha256(f"{jid}:{url}:{i}".encode()).hexdigest()
                db.execute("INSERT OR IGNORE INTO files(id,job,work,ordinal,url,state,observed_width,observed_height) VALUES(?,?,?,?,?,?,?,?)", (fid, jid, url, i, im["url"], "queued" if job[0] == "download" else "link", int(im.get("width", 0)), int(im.get("height", 0))))
            db.execute("UPDATE works SET state='ready',title=?,error='' WHERE job=? AND url=?", (str(payload.get("title", ""))[:500], jid, url))
        self.wake.set()
        return {"ok": True}

    def fail_work(self, payload):
        with self.db() as db:
            row = db.execute("SELECT attempts FROM works WHERE job=? AND url=?", (payload["job"], payload["url"])).fetchone()
            if not row:
                return
            n = row[0] + 1
            db.execute("UPDATE works SET state=?,attempts=?,next_at=?,error=? WHERE job=? AND url=?", ("retry" if n < 3 else "failed", n, time.time() + min(60, 5 * 2**n), str(payload.get("error", "解析失败"))[:500], payload["job"], payload["url"]))

    def control(self, jid, action):
        with self.db() as db:
            if not db.execute("SELECT 1 FROM jobs WHERE id=?", (jid,)).fetchone():
                raise ValueError("任务不存在")
            if action in ("pause", "resume"):
                db.execute("UPDATE jobs SET state=?,updated=? WHERE id=?", ("paused" if action == "pause" else "active", time.time(), jid))
            elif action == "retry":
                db.execute("UPDATE works SET state='pending',attempts=0,next_at=0,error='' WHERE job=? AND state IN ('failed','blocked')", (jid,))
                db.execute("UPDATE files SET state='queued',attempts=0,next_at=0,error='' WHERE job=? AND state IN ('failed','blocked')", (jid,))
                db.execute("UPDATE jobs SET state='active' WHERE id=?", (jid,))
            elif action == "refresh-links":
                db.execute("UPDATE works SET state='pending',attempts=0,next_at=0,error='' WHERE job=? AND url IN (SELECT work FROM files WHERE job=? AND state IN ('failed','blocked'))", (jid, jid))
                db.execute("DELETE FROM files WHERE job=? AND state IN ('failed','blocked')", (jid,))
                db.execute("UPDATE jobs SET state='active' WHERE id=?", (jid,))
            elif action == "rescan":
                source = db.execute("SELECT source FROM jobs WHERE id=?", (jid,)).fetchone()[0]
                site_url(source, True)
                db.execute("UPDATE jobs SET scan_state='pending',cursor='{}',reason='',state='active' WHERE id=?", (jid,))
            else:
                raise ValueError("无效操作")
        self.wake.set()

    def set_hold(self, code, reason, until=0):
        current = self.meta("hold") or {}
        self.set_meta("hold", {"code": str(code), "reason": str(reason)[:500], "until": max(float(until), float(current.get("until", 0))), "at": time.time()})

    def clear_hold(self):
        hold = self.meta("hold")
        if hold and hold.get("until", 0) > time.time():
            raise ValueError("尚在服务器指定的冷却时间内")
        self.set_meta("hold", None)
        self.wake.set()

    def claim(self):
        if self.meta("hold"):
            return None
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT f.* FROM files f JOIN jobs j ON j.id=f.job WHERE j.state='active' AND f.state IN ('queued','retry') AND f.next_at<=? ORDER BY f.rowid LIMIT 1", (time.time(),)).fetchone()
            if row:
                db.execute("UPDATE files SET state='downloading',attempts=attempts+1,error='' WHERE id=?", (row["id"],))
                return dict(row)

    def update_file(self, fid, **values):
        assert set(values) <= {"state", "bytes", "total", "validator", "path", "sha256", "error", "next_at", "mime"}
        with self.db() as db:
            db.execute("UPDATE files SET " + ",".join(f"{k}=?" for k in values) + " WHERE id=?", (*values.values(), fid))

    def active(self, jid):
        if self.stop.is_set() or self.meta("hold"):
            return False
        with self.db() as db:
            r = db.execute("SELECT state FROM jobs WHERE id=?", (jid,)).fetchone()
            return bool(r and r[0] == "active")

    def worker(self):
        session = requests.Session()
        session.trust_env = False  # Do not silently forward through ambient proxies or netrc credentials.
        session.headers.update({"User-Agent": "ArtworkArchiveHybrid/0.7", "Accept-Encoding": "identity", "Referer": "https://www.mihuashi.com/"})
        try:
            while not self.stop.is_set():
                try:
                    row = self.claim()
                    if not row:
                        self.wake.wait(1)
                        self.wake.clear()
                        continue
                    try:
                        self.download(session, row)
                    except Interrupted:
                        self.update_file(row["id"], state="retry", next_at=time.time() + 1)
                    except (requests.RequestException, OSError) as exc:
                        n = row["attempts"] + 1
                        self.update_file(row["id"], state="retry" if n < 4 else "failed", error=f"网络或文件系统错误：{type(exc).__name__}", next_at=time.time() + min(120, 2**n * 2) + random.uniform(0, 2))
                    except Exception as exc:
                        self.update_file(row["id"], state="failed", error=str(exc)[:500])
                except Exception as exc:
                    # Keep other workers alive on temporary storage errors; report the failure.
                    print(f"下载引擎错误：{type(exc).__name__}: {exc}", flush=True)
                    self.stop.wait(3)
        finally:
            session.close()

    def download(self, session, row):
        fid, url = row["id"], asset_url(row["url"])
        # Reuse an identical observed URL only when the previously saved content still verifies.
        with self.db() as db:
            cached = db.execute("SELECT * FROM files WHERE url=? AND state='complete' AND id!=? AND sha256 IS NOT NULL LIMIT 1", (url, fid)).fetchone()
        if cached and cached["path"]:
            path = self.root / cached["path"]
            try:
                with open(path, "rb") as handle:
                    valid = hashlib.file_digest(handle, "sha256").hexdigest() == cached["sha256"]
                if valid:
                    self.update_file(fid, state="complete", bytes=cached["bytes"], total=cached["bytes"], path=cached["path"], sha256=cached["sha256"], mime=cached["mime"], error="")
                    return
            except OSError:
                pass
        part = self.root / "parts" / (fid + ".part")
        offset = part.stat().st_size if part.exists() else 0
        validator = row["validator"]
        # No entity validator means resuming could concatenate two different images.
        if offset and not validator:
            part.unlink()
            offset = 0
        headers = {"Range": f"bytes={offset}-", "If-Range": validator} if offset else {}
        if not self.active(row["job"]):
            raise Interrupted()
        # Manual, allowlisted redirects; do not send credentials or Range to other domains.
        response = None
        for _ in range(4):
            response = session.get(url, headers=headers, stream=True, timeout=(10, 20), allow_redirects=False)
            if response.status_code not in (301, 302, 303, 307, 308):
                break
            from urllib.parse import urljoin
            location = response.headers.get("Location", "")
            response.close()
            url = asset_url(urljoin(url, location))
        else:
            raise ValueError("图片重定向过多")
        with response:
            status = response.status_code
            if status == 429:
                retry = response.headers.get("Retry-After", "60")
                try:
                    until = time.time() + max(60, int(retry))
                except ValueError:
                    from email.utils import parsedate_to_datetime
                    try:
                        until = max(time.time() + 60, parsedate_to_datetime(retry).timestamp())
                    except (ValueError, TypeError, OverflowError):
                        until = time.time() + 60
                self.set_hold("429", "图片服务器限流；冷却后检查官网，再手动继续", until)
                raise Interrupted()
            if status in (401, 403):
                self.update_file(fid, state="blocked", error=f"HTTP {status}：链接失效或需要浏览器授权；不重复请求、不绕过访问限制")
                return
            if status == 404:
                self.update_file(fid, state="failed", error="HTTP 404：图片不存在")
                return
            if status == 416:
                part.unlink(missing_ok=True)
                self.update_file(fid, state="retry" if row["attempts"] < 3 else "failed", bytes=0, validator=None, next_at=time.time() + 3, error="Range 不可满足，清除不匹配暂存")
                return
            response.raise_for_status()
            try:
                append, total = resume_plan(status, response.headers, offset, validator if offset else None)
            except ValueError:
                part.unlink(missing_ok=True)
                self.update_file(fid, bytes=0, validator=None)
                raise
            if total is not None and total > MAX_BYTES:
                raise ValueError("单张图片超过 128 MiB 上限")
            mime = response.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if mime not in ("image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"):
                raise ValueError("响应不是受支持的图片 MIME 类型")
            tag = response.headers.get("ETag")
            new_validator = tag if tag and not tag.startswith("W/") else response.headers.get("Last-Modified")
            # Clear stale bytes before recording the new entity validator (crash-safe order).
            if not append:
                with open(part, "wb") as output:
                    output.flush()
                    os.fsync(output.fileno())
                offset = 0
            self.update_file(fid, bytes=offset, total=total, validator=new_validator, mime=mime)
            count, last_write = offset, time.monotonic()
            with open(part, "ab" if append else "wb") as output:
                for chunk in response.iter_content(256 * 1024):
                    if not self.active(row["job"]):
                        output.flush()
                        os.fsync(output.fileno())
                        self.update_file(fid, bytes=count)
                        raise Interrupted()
                    if not chunk:
                        continue
                    count += len(chunk)
                    if count > MAX_BYTES or (total is not None and count > total):
                        raise ValueError("响应字节数超过声明长度或安全上限")
                    output.write(chunk)
                    if time.monotonic() - last_write >= 1:
                        output.flush()
                        os.fsync(output.fileno())
                        self.update_file(fid, bytes=count)
                        last_write = time.monotonic()
                output.flush()
                os.fsync(output.fileno())
            if total is not None and count != total:
                raise requests.ConnectionError("响应提前结束")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(part) as image:
                fmt = image.format
                if image.width > 16384 or image.height > 16384 or image.width * image.height > 32_000_000:
                    raise ValueError("图片尺寸超过解码安全上限")
                image.verify()
            with Image.open(part) as image:
                image.load()
        extension = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif", "AVIF": "avif"}.get(fmt)
        if not extension:
            raise ValueError("图片实际格式不受支持")
        actual_mime = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "GIF": "image/gif", "AVIF": "image/avif"}[fmt]
        if actual_mime != mime:
            raise ValueError("图片 MIME 与文件实际格式不一致")
        with open(part, "rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        dest = self.root / "images" / f"{digest}.{extension}"
        os.replace(part, dest)  # Same volume, atomic; identical content shares one pathname.
        self.update_file(fid, state="complete", bytes=count, total=count, sha256=digest, path=str(dest.relative_to(self.root)), error="")

    def export(self, jid, kind="zip"):
        if kind not in ("zip", "links"):
            raise ValueError("不支持的导出格式")
        if not self.pack_lock.acquire(blocking=False):
            raise ValueError("已有导出任务正在执行")
        eid = uuid.uuid4().hex
        try:
            with self.db() as db:
                if not db.execute("SELECT 1 FROM jobs WHERE id=?", (jid,)).fetchone():
                    raise ValueError("任务不存在")
                db.execute("INSERT INTO exports VALUES(?,?, 'packing',NULL,'',?)", (eid, jid, time.time()))
            thread = threading.Thread(target=self.pack, args=(eid, jid, kind), daemon=True)
            thread.start()
            self.threads.append(thread)
        except Exception:
            self.pack_lock.release()
            raise
        return {"id": eid}

    def pack(self, eid, jid, kind):
        part = self.root / "exports" / f"{eid}.tmp"
        try:
            with self.db() as db:
                job = dict(db.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone())
                files = [dict(r) for r in db.execute("SELECT * FROM files WHERE job=? ORDER BY work,ordinal", (jid,))]
                works = [dict(r) for r in db.execute("SELECT * FROM works WHERE job=?", (jid,))]
            dest = self.root / "exports" / f"archive_{jid[:8]}_{eid[:8]}.{'zip' if kind == 'zip' else 'txt'}"
            if kind == "links":
                part.write_text("\n".join(dict.fromkeys(f["url"] for f in files)) + "\n", encoding="utf-8")
            else:
                with zipfile.ZipFile(part, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                    for f in files:
                        if self.stop.is_set():
                            raise Interrupted("程序正在停止")
                        if f["state"] != "complete":
                            continue
                        path = self.root / f["path"]
                        if not path.is_file():
                            raise ValueError("已完成图片文件缺失，请检查数据目录")
                        archive.write(path, f"{f['work'].rsplit('/', 1)[-1]}/{f['ordinal']:03d}{path.suffix}")
                    archive.writestr("manifest.json", json.dumps({"job": job, "works": works, "files": files, "exported_at": time.time(), "note": "快照导出，非完成保证；detail_display 不代表原始上传文件。consent_at=0 表示未收集许可确认，不代表获得许可"}, ensure_ascii=False, indent=2))
            os.replace(part, dest)
            with self.db() as db:
                db.execute("UPDATE exports SET state='complete',path=? WHERE id=?", (str(dest), eid))
        except Exception as exc:
            part.unlink(missing_ok=True)
            with self.db() as db:
                db.execute("UPDATE exports SET state='failed',error=? WHERE id=?", (str(exc)[:500], eid))
        finally:
            self.pack_lock.release()

    def close(self):
        self.stop.set()
        self.wake.set()
        for thread in self.threads:
            thread.join(timeout=25)

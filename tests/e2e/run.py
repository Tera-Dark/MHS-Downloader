"""Local-only browser regression suite (Linux + OpenSSL).
All simulated website domains resolve to a temporary local HTTPS fixture.
Test certificates and DNS flags are not part of the extension release.
No credentials or real artist images are used. Output: artifacts/browser-tests/.
"""

from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import ssl, threading, subprocess, io, json, hashlib, shutil, traceback, os, time, tempfile
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright, expect
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[2]
DEV = ROOT / "artifacts/browser-tests"
DEV.mkdir(parents=True, exist_ok=True)
TEMP = tempfile.TemporaryDirectory(prefix="artwork-archive-e2e-")
TMP = Path(TEMP.name)
EXT = Path(os.environ.get("AA_EXT", str(ROOT / "extension")))
cert = TMP / "c.pem"
key = TMP / "k.pem"
subprocess.run(
    [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        str(key),
        "-out",
        str(cert),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
    ],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    check=True,
)
requests = []


def png(n, small=False):
    if n == 202:
        n = 201
    im = Image.new(
        "RGB",
        (300, 300) if small else (1000, 1000),
        (
            "#dde8d0"
            if n == 201
            else "#e3d9cf" if n == 203 else "#d3e0e8" if n == 204 else "#e6d5e2"
        ),
    )
    d = ImageDraw.Draw(im)
    if not small:
        d.rounded_rectangle((50, 50, 950, 950), radius=35, outline="#7b907d", width=3)
        d.text((95, 95), "STUDIES OF A QUIET COAST", fill="#315b43", font_size=28)
        d.ellipse((590, 210, 790, 410), fill="#efc784")
        d.polygon(
            [(85, 630), (285, 350), (500, 590), (690, 470), (915, 650)], fill="#87a594"
        )
        d.polygon(
            [(85, 720), (380, 500), (605, 660), (780, 600), (915, 735)], fill="#456f63"
        )
        d.rectangle((85, 730, 915, 865), fill="#aac4bc")
        for yy in [760, 800, 840]:
            d.line((140, yy, 840, yy), fill="#dbe9d7", width=4)
        d.polygon([(480, 812), (525, 812), (512, 832), (493, 832)], fill="#315b43")
        d.polygon([(504, 745), (504, 803), (463, 803)], fill="#f8f1d5")
        d.text((95, 890), "LOCAL DEMO / " + str(n), fill="#315b43", font_size=21)
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


PNGS = {n: png(n) for n in [201, 202, 203, 204, 205, 206, 301]}
THUMB = png(0, True)
large_bytes = io.BytesIO()
Image.new("RGB", (6000, 4000), "#aac4bc").save(large_bytes, "JPEG", quality=92)
LARGE_JPEG = large_bytes.getvalue()


class Server(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        requests.append(self.path)
        if self.path == "/large-image.jpg":
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(LARGE_JPEG)))
            self.end_headers()
            self.wfile.write(LARGE_JPEG)
            return
        if (
            self.path.startswith("/art")
            and self.path.endswith(".png")
            and self.headers.get("Sec-Fetch-Dest") == "empty"
        ):
            time.sleep(1.5)
        status = 200
        mime = "text/html; charset=utf-8"
        body = b""
        if self.path == "/redirect-image":
            self.send_response(302)
            self.send_header(
                "Location", "https://image-assets.mihuashi.com/never-follow.png"
            )
            self.end_headers()
            return
        if self.path == "/users/ScrollGallery":
            body = """<!doctype html><meta charset="utf-8"><title>Scroll fixture</title><style>body{margin:30px;font:16px sans-serif}#cards{display:grid;grid-template-columns:repeat(3,280px);gap:20px}img{width:280px;height:280px}</style><h1>Public DOM link fixture</h1><p>精选作品 36</p><div id="cards"></div><script>let n=0;function more(){for(let i=0;i<6&&n<36;i++){n++;document.getElementById('cards').insertAdjacentHTML('beforeend',`<a href="/artworks/${8000+n}"><img src="https://image-assets.mihuashi.com/thumb${8000+n}.png!artwork.square"></a>`)}}more();more();addEventListener('scroll',()=>{if(scrollY+innerHeight>=document.documentElement.scrollHeight-80)more()});</script>""".encode()
        elif self.path in [
            "/users/ReplaceGallery",
            "/users/HistoryErrorGallery",
            "/users/BlockedCardGallery",
        ]:
            if self.path.endswith("ReplaceGallery"):
                # Realistic SPA replaceState plus full-document location.replace: neither adds history.
                clicks = [
                    (
                        201,
                        "history.replaceState({}, '', '/artworks/201'); document.body.innerHTML='Detail fixture'",
                    ),
                    (203, "location.replace('/artworks/203')"),
                ]
            elif self.path.endswith("BlockedCardGallery"):
                clicks = [(401, "location.href='/artworks/401'")]
            else:
                clicks = [(201, "location.href='/artworks/201'")]
            cards = "".join(
                f'<div class="user-artwork"><div class="user-artwork__image" onclick="{click}"><img width="280" height="280" src="https://image-assets.mihuashi.com/thumb{n}.png!artwork.square"></div></div>'
                for n, click in clicks
            )
            body = f'<!doctype html><meta charset="utf-8"><title>Navigation fixture 的主页</title><h1>精选作品 {len(clicks)}</h1>{cards}'.encode()
        elif self.path.startswith("/users/"):
            body = """<!doctype html><meta charset="utf-8"><title>演示画师 的主页 - 米画师</title><style>body{font:16px sans-serif}#cards{display:grid;grid-template-columns:300px 300px;gap:30px}img{width:280px;height:280px}.tail{height:900px}</style><h1>本地模拟画师主页 · 非实站</h1><p>精选作品 5</p><div id="cards"><a href="/artworks/201"><img src="https://image-assets.mihuashi.com/thumb201.png!artwork.square"></a><div class="user-artwork"><div class="user-artwork__image" onclick="location.href='/artworks/202'"><img src="https://image-assets.mihuashi.com/thumb202.png!artwork.square"></div></div><div class="user-artwork"><div class="user-artwork__image" onclick="window.open('/artworks/203','_blank')"><img src="https://image-assets.mihuashi.com/thumb203.png!artwork.square"></div></div></div><div class="tail"></div><script>let added=false;window.addEventListener('scroll',()=>{if(!added&&scrollY>350){added=true;setTimeout(()=>{document.getElementById('cards').insertAdjacentHTML('beforeend','<a href="/artworks/204"><img src="https://image-assets.mihuashi.com/thumb204.png!artwork.square"></a><div data-artwork-id="205"><img src="https://image-assets.mihuashi.com/thumb205.png!artwork.square"></div>')},450)}});</script>""".encode()
        elif self.path.startswith("/artworks/403"):
            status = 403
            body = b"<html>Denied fixture</html>"
        elif self.path.startswith("/artworks/429"):
            status = 429
            body = b"<html>Busy fixture</html>"
        elif self.path.startswith("/artworks/401"):
            body = '<html><meta charset="utf-8">请先登录，登录后查看</html>'.encode()
        elif self.path.startswith("/artworks/501"):
            body = (
                b"<html><body>Fixture has no image; used for pause test</body></html>"
            )
        elif self.path.startswith("/artworks/"):
            n = int(self.path.split("/")[-1])
            main = f'<img src="https://image-assets.mihuashi.com/art{n}.png" style="width:500px;height:500px">'
            extra = (
                '<img src="https://image-assets.mihuashi.com/art206.png" style="width:500px;height:500px">'
                if n == 203
                else ""
            )
            body = f'<html><meta charset="utf-8"><title>本地模拟详情页</title><body><h1>本地模拟详情页</h1>{main}{extra}<img class="avatar" src="https://image-assets.mihuashi.com/art201.png" style="width:160px;height:160px"><img src="https://image-assets.mihuashi.com/thumb0.png!artwork.square"></body></html>'.encode()
        elif "/thumb" in self.path:
            mime = "image/png"
            body = THUMB
        elif "/art" in self.path and self.path.endswith(".png"):
            mime = "image/png"
            n = int(self.path.split("art")[-1].split(".")[0])
            body = PNGS.get(n, PNGS[301])
        else:
            status = 204
        self.send_response(status)
        if status == 429:
            self.send_header("Retry-After", "120")
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)


server = ThreadingHTTPServer(("127.0.0.1", 0), Server)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
server.socket = ctx.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_port
report = {
    "version": json.loads((EXT / "manifest.json").read_text())["version"],
    "source": str(EXT),
    "environment": "Linux Chromium; all website domains mapped to local HTTPS fixtures",
    "tests": [],
}


def ok(s):
    report["tests"].append(s)
    print("PASS", s, flush=True)


profile = TMP / "profile"
shutil.rmtree(profile, ignore_errors=True)
(profile / "Default").mkdir(parents=True)
(profile / "Default" / "Preferences").write_text(
    json.dumps(
        {
            "download": {
                "default_directory": str(TMP / "native-downloads"),
                "prompt_for_download": False,
            }
        }
    )
)
try:
    with sync_playwright() as p:
        c = p.chromium.launch_persistent_context(
            str(profile),
            channel="chromium",
            headless=True,
            ignore_default_args=["--disable-popup-blocking"],
            args=[
                "--no-sandbox",
                "--ignore-certificate-errors",
                "--no-proxy-server",
                f"--host-resolver-rules=MAP www.mihuashi.com 127.0.0.1:{port}, MAP image-assets.mihuashi.com 127.0.0.1:{port}",
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
            ],
            accept_downloads=True,
            downloads_path=str(TMP / "downloads"),
            viewport={"width": 1440, "height": 1100},
        )
        c.on(
            "requestfailed",
            lambda r: print("REQUEST FAILED", r.url, r.failure, flush=True),
        )
        sw = (
            c.service_workers[0]
            if c.service_workers
            else c.wait_for_event("serviceworker", timeout=15000)
        )
        eid = sw.url.split("/")[2]
        page = c.new_page()
        errors = []
        c.on("page", lambda tab: tab.on("pageerror", lambda e: errors.append(str(e))))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        page.goto(f"chrome-extension://{eid}/manager.html")
        expect(page.locator("#stateLabel")).to_contain_text("待操作", timeout=15000)
        ok("Fresh-profile load without tabs permission")
        expect(page.locator("#preview")).to_be_hidden()
        expect(page.locator("#start")).to_be_disabled()
        ok("Empty preview is hidden and empty-queue download action is disabled")
        expect(page.locator("#welcome")).to_be_visible()
        assert page.locator("body").get_attribute("data-view") == "simple"
        ok("Beginner view and first-run guidance are the default")
        page.locator("#preset").select_option("gentle")
        assert page.locator("#interval").input_value() == "5"
        assert page.locator("#concurrency").input_value() == "1"
        page.locator("#preset").select_option("recommended")
        ok("Speed presets update bounded settings without advanced input")
        page.locator("#quickInput").fill(
            "分享：https://www.mihuashi.com/users/TestGallery"
        )
        expect(page.locator("#inputHint")).to_contain_text("主页")
        page.locator("#quickAction").click()
        expect(page.locator("#errorTitle")).to_contain_text("使用范围")
        assert not requests
        ok("Plain-language authorization gate without network requests")
        page.locator("#authorized").check()
        page.locator("#quickAction").click()
        expect(page.locator(".task")).to_have_count(5, timeout=55000)
        expect(page.locator("#preset")).to_be_enabled(timeout=10000)
        page.locator("#queueSearch").fill("202")
        expect(page.locator(".task")).to_have_count(1)
        page.locator(".task-check").check()
        expect(page.locator("#start")).to_contain_text("所选 1")
        page.locator("#clearSelection").click()
        page.locator("#queueSearch").fill("")
        expect(page.locator(".task")).to_have_count(5)
        ok("Search and explicit task selection work")
        page.locator("[data-filter=done]").click()
        expect(page.locator(".task")).to_have_count(0)
        page.locator("[data-filter=all]").click()
        expect(page.locator(".task")).to_have_count(5)
        ok("Queue status filters work")
        page.locator("#dismissWelcome").click()
        page.locator("#advancedToggle").click()
        page.locator("#interval").fill("1")
        page.locator("#interval").blur()
        ok("Advanced settings are optional and first-run guidance can be dismissed")
        data = page.evaluate(
            "async () => ({stateV2:{tasks:await App.store.read('tasks'),logs:await App.store.read('meta','logs'),scans:await App.store.read('meta','scans'),archives:await App.store.read('meta','archives'),settings:await App.store.read('meta','settings'),ui:await App.store.read('meta','ui'),recovery:await App.store.read('meta','recovery')}}).stateV2"
        )
        assert len(data["tasks"]) == 5, data
        assert data["scans"][-1]["status"] == "finished", data["scans"][-1]
        assert {t["id"] for t in data["tasks"]} == {"201", "202", "203", "204", "205"}
        ok(
            "Profile scan: direct links, same-tab clicks, window.open capture, lazy scroll, data-artwork-id; 5/5 collected"
        )
        assert len(c.pages) <= 3
        ok("Popup URL capture does not require disabling browser popup blocking")
        page.evaluate(
            "() => {\n  window.maxDownloadJobs = 0;\n  window.jobWatch = setInterval(() => window.maxDownloadJobs = Math.max(window.maxDownloadJobs, App.transfer.jobs.size), 10);\n}"
        )
        page.locator("#start").click()
        expect(page.locator(".task.done")).to_have_count(5, timeout=60000)
        expect(page.locator("#preset")).to_be_enabled(timeout=10000)
        maximum = page.evaluate("window.maxDownloadJobs")
        assert maximum <= 2 and maximum >= 1, maximum
        ok(
            "Download pipeline stayed within configured concurrency; observed maximum "
            + str(maximum)
        )
        data = page.evaluate(
            "async () => ({stateV2:{tasks:await App.store.read('tasks'),logs:await App.store.read('meta','logs'),scans:await App.store.read('meta','scans'),archives:await App.store.read('meta','archives'),settings:await App.store.read('meta','settings'),ui:await App.store.read('meta','ui'),recovery:await App.store.read('meta','recovery')}}).stateV2"
        )
        archives = [a for a in data["archives"] if a["status"] == "complete"]
        assert len(archives) == 1, data
        downloads = page.evaluate(
            "id => chrome.downloads.search({\n  id\n})", archives[0]["download_id"]
        )
        path = Path(downloads[0]["filename"])
        assert path.exists()
        with ZipFile(path) as z:
            assert z.testzip() is None
            m = json.loads(z.read("manifest.json"))
            images = m["images"]
            assert len(images) == 6, len(images)
            names = [n for n in z.namelist() if n != "manifest.json"]
            assert len(names) == 5, names
            for f in images:
                b = z.read(f["zip_member"])
                assert hashlib.sha256(b).hexdigest() == f["sha256"]
                assert Image.open(io.BytesIO(b)).size == (1000, 1000)
        ok(
            "Pipelined ZIP download: 5 works / 6 image records / 5 unique files; CRC, actual dimensions and SHA-256 verified"
        )
        assert not page.locator("#saveBuffer").is_enabled()
        ok("ZIP buffers cleared only after browser save completion")
        page.screenshot(path=str(DEV / "dashboard-verified.png"), full_page=True)
        page.locator("#advancedToggle").click()
        page.set_viewport_size({"width": 1280, "height": 900})
        page.evaluate("window.scrollTo(0, 0)")
        expect(page.locator("#toast")).to_be_hidden(timeout=7000)
        page.screenshot(path=str(DEV / "workbench.png"), full_page=True)
        page.locator(".task").first.get_by_role(
            "button", name="预览", exact=True
        ).click()
        expect(page.locator(".image-card")).to_have_count(1, timeout=15000)
        expect(page.locator("#preset")).to_be_enabled()
        page.locator("#preview").scroll_into_view_if_needed()
        page.screenshot(path=str(DEV / "preview.png"))
        page.get_by_role("button", name="只保存这一张", exact=True).click()
        expect(page.locator(".task.done")).to_have_count(5, timeout=15000)
        expect(page.locator("#preset")).to_be_enabled()
        page.set_viewport_size({"width": 1440, "height": 1100})
        page.locator("#advancedToggle").click()
        info = c.new_page()
        info.goto(f"chrome-extension://{eid}/help.html")
        expect(info.locator("h1")).to_contain_text("画页存档")
        info.goto(f"chrome-extension://{eid}/privacy.html")
        expect(info.locator("h1")).to_contain_text("隐私")
        info.close()
        ok("Packaged help and privacy pages load")
        page.locator("#export").click()
        expect(page.locator("#logs")).to_contain_text("已导出任务")
        ok("Task/source export request")
        page.reload()
        expect(page.locator(".task.done")).to_have_count(5)
        assert not page.locator("#authorized").is_checked()
        expect(page.locator("#welcome")).to_be_hidden()
        ok(
            "Persisted records, hidden welcome preference and per-session authorization reset"
        )
        page.locator("#urls").fill("https://www.mihuashi.com/artworks/301")
        page.locator("#add").click()
        expect(page.locator(".task")).to_have_count(6)
        page.locator("#authorized").check()
        page.locator("#mode").select_option("native")
        page.locator("#start").click()
        expect(page.locator(".task.done")).to_have_count(6, timeout=30000)
        expect(page.locator("#preset")).to_be_enabled()
        ok("Native download mode also completes")

        # Lower the in-memory threshold in this harness only, to exercise volume boundaries cheaply.
        def seed(ids, mode="zip"):
            fixture = [
                {
                    "id": str(n),
                    "url": f"https://www.mihuashi.com/artworks/{n}",
                    "artist": "Demo",
                    "status": "queued",
                    "files": [],
                }
                for n in ids
            ]
            page.evaluate(
                "async ([tasks, mode]) => {\n  await chrome.storage.local.remove('accessHold');\n  const x = ({stateV2:{tasks:await App.store.read('tasks'),logs:await App.store.read('meta','logs'),scans:await App.store.read('meta','scans'),archives:await App.store.read('meta','archives'),settings:await App.store.read('meta','settings'),ui:await App.store.read('meta','ui'),recovery:await App.store.read('meta','recovery')}});\n  x.stateV2.tasks = tasks;\n  x.stateV2.archives = [];\n  x.stateV2.settings.mode = mode;\n  for(const [k,value] of Object.entries(x.stateV2)) {if(k==='settings'){for(const name of App.configKeys)if(value?.[name]!==undefined)App.$(name).value=value[name];}else App.state[k]=value;}await App.api.persist();\n}",
                [fixture, mode],
            )
            page.reload()
            expect(page.locator("#stateLabel")).to_contain_text("待操作", timeout=15000)
            expect(page.locator(".task")).to_have_count(len(ids))
            page.locator("#authorized").check()

        seed([201, 204])
        page.locator("#start").click()
        expect(page.locator("#stateLabel")).to_contain_text("正在处理")
        page.evaluate("App.run.C.volumeMB = 0.001")
        expect(page.locator(".task.done")).to_have_count(2, timeout=30000)
        expect(page.locator("#preset")).to_be_enabled()
        state = page.evaluate(
            "async () => ({stateV2:{tasks:await App.store.read('tasks'),logs:await App.store.read('meta','logs'),scans:await App.store.read('meta','scans'),archives:await App.store.read('meta','archives'),settings:await App.store.read('meta','settings'),ui:await App.store.read('meta','ui'),recovery:await App.store.read('meta','recovery')}}).stateV2"
        )
        assert (
            len([a for a in state["archives"] if a["status"] == "complete"]) == 2
        ), state
        for a in state["archives"]:
            ds = page.evaluate(
                "id => chrome.downloads.search({\n  id\n})", a["download_id"]
            )
            with ZipFile(ds[0]["filename"]) as z:
                assert z.testzip() is None and "manifest.json" in z.namelist()
        ok(
            "ZIP split boundary: two saved volumes, valid manifests and CRC (small threshold injected only by test)"
        )
        seed([201, 501])
        page.locator("#start").click()
        expect(page.locator("#memoryHint")).to_contain_text("1 条来源", timeout=15000)
        page.locator("#pause").click()
        expect(page.locator("#preset")).to_be_enabled(timeout=6000)
        expect(page.locator("#saveBuffer")).to_be_enabled()
        page.locator("#authorized").uncheck()
        before_buffer_save = len(requests)
        page.locator("#saveBuffer").click()
        expect(page.locator("#preset")).to_be_enabled(timeout=15000)
        expect(page.locator(".task.done")).to_have_count(1)
        assert "0 条来源" in page.locator("#memoryHint").inner_text()
        assert len(requests) == before_buffer_save
        ok(
            "Stop retains acquired ZIP data; offline buffer save needs no fresh consent or website requests"
        )
        legacy = {
            "version": "0.1.1",
            "tasks": [
                {
                    "id": "987",
                    "url": "https://www.mihuashi.com/artworks/987",
                    "status": "done",
                    "files": [
                        {
                            "image_url": "https://image-assets.mihuashi.com/imported.png",
                            "status": "complete",
                            "sha256": None,
                        }
                    ],
                }
            ],
        }
        before = len(requests)
        page.locator("#importFile").set_input_files(
            {
                "name": "legacy.json",
                "mimeType": "application/json",
                "buffer": json.dumps(legacy).encode(),
            }
        )
        expect(page.locator(".task")).to_have_count(3)
        assert len(requests) == before
        ok("Legacy 0.1.1 source JSON import restores records without network requests")
        for code in [403, 429, 401]:
            fixture = [
                {
                    "id": str(code),
                    "url": f"https://www.mihuashi.com/artworks/{code}",
                    "artist": "Demo",
                    "status": "queued",
                    "files": [],
                }
            ]
            page.evaluate(
                "async tasks => {\n  await chrome.storage.local.remove(\"accessHold\");\n  const x = ({stateV2:{tasks:await App.store.read('tasks'),logs:await App.store.read('meta','logs'),scans:await App.store.read('meta','scans'),archives:await App.store.read('meta','archives'),settings:await App.store.read('meta','settings'),ui:await App.store.read('meta','ui'),recovery:await App.store.read('meta','recovery')}});\n  x.stateV2.tasks = tasks;\n  for(const [k,value] of Object.entries(x.stateV2)) {if(k==='settings'){for(const name of App.configKeys)if(value?.[name]!==undefined)App.$(name).value=value[name];}else App.state[k]=value;}await App.api.persist();\n}",
                fixture,
            )
            page.reload()
            expect(page.locator(".task")).to_have_count(1)
            page.locator("#authorized").check()
            page.locator("#start").click()
            expect(page.locator(".task.error")).to_have_count(1, timeout=12000)
            expect(page.locator("#preset")).to_be_enabled(timeout=5000)
            text = page.locator("#errorDetail").text_content()
            assert str(code) in text if code != 401 else "登录" in text, text
            ok("HTTP " + str(code) + " stop" if code != 401 else "Login prompt stop")
        page.evaluate(
            "async () => {\n  await chrome.storage.local.remove('accessHold');\n  const x = ({stateV2:{tasks:await App.store.read('tasks'),logs:await App.store.read('meta','logs'),scans:await App.store.read('meta','scans'),archives:await App.store.read('meta','archives'),settings:await App.store.read('meta','settings'),ui:await App.store.read('meta','ui'),recovery:await App.store.read('meta','recovery')}});\n  x.stateV2.tasks = [];\n  x.stateV2.settings.maxWorks = 2;\n  for(const [k,value] of Object.entries(x.stateV2)) {if(k==='settings'){for(const name of App.configKeys)if(value?.[name]!==undefined)App.$(name).value=value[name];}else App.state[k]=value;}await App.api.persist();\n}"
        )
        page.reload()
        expect(page.locator(".task")).to_have_count(0)
        page.locator("#authorized").check()
        page.locator("#scan").click()
        expect(page.locator("#scan")).to_be_enabled(timeout=25000)
        partial = page.evaluate(
            "async () => ({stateV2:{tasks:await App.store.read('tasks'),logs:await App.store.read('meta','logs'),scans:await App.store.read('meta','scans'),archives:await App.store.read('meta','archives'),settings:await App.store.read('meta','settings'),ui:await App.store.read('meta','ui'),recovery:await App.store.read('meta','recovery')}}).stateV2.scans.at(-1)"
        )
        assert (
            partial["status"] == "partial"
            and len(partial["found"]) == 2
            and partial["expected"] == 5
        ), partial
        ok("Scan cap is reported as partial, not all works completed")
        page.locator("#diagnostics").click()
        expect(page.locator("#diagnosticDialog")).to_be_visible()
        diagnostics = json.loads(page.locator("#diagnosticText").input_value())
        encoded = json.dumps(diagnostics)
        assert (
            "mihuashi.com" not in encoded
            and "演示画师" not in encoded
            and "TestGallery" not in encoded
        )
        assert diagnostics["version"] == report["version"]
        page.locator("#closeDiagnostics").click()
        ok("User-visible diagnostic preview excludes links and artist data")
        # Create a large local queue: pagination and search must expose items beyond the old 250-row cap.
        big = [
            {
                "id": str(7000 + i),
                "url": f"https://www.mihuashi.com/artworks/{7000+i}",
                "artist": "Local demo",
                "status": "queued",
                "files": [],
            }
            for i in range(61)
        ]
        page.evaluate(
            "async tasks => {\n  const x = ({stateV2:{tasks:await App.store.read('tasks'),logs:await App.store.read('meta','logs'),scans:await App.store.read('meta','scans'),archives:await App.store.read('meta','archives'),settings:await App.store.read('meta','settings'),ui:await App.store.read('meta','ui'),recovery:await App.store.read('meta','recovery')}});\n  x.stateV2.tasks = tasks;\n  for(const [k,value] of Object.entries(x.stateV2)) {if(k==='settings'){for(const name of App.configKeys)if(value?.[name]!==undefined)App.$(name).value=value[name];}else App.state[k]=value;}await App.api.persist();\n}",
            big,
        )
        page.reload()
        expect(page.locator(".task")).to_have_count(25)
        page.locator("#nextPage").click()
        expect(page.locator("#pageLabel")).to_contain_text("2 / 3")
        page.locator("#nextPage").click()
        expect(page.locator(".task")).to_have_count(11)
        page.locator("#queueSearch").fill("7060")
        expect(page.locator(".task")).to_have_count(1)
        ok("Pagination and search cover the complete queue")
        # A user chooses exactly one of two works. The other work must remain queued and unrequested.
        seed([201, 301])
        page.locator(".task").first.locator(".task-check").check()
        before_paths = len(requests)
        page.locator("#start").click()
        expect(page.locator(".task.done")).to_have_count(1, timeout=20000)
        expect(page.locator("#preset")).to_be_enabled()
        expect(page.locator(".task.queued")).to_have_count(1)
        assert "/artworks/301" not in requests[before_paths:]
        ok("Selected-only download does not request unselected work")
        # Regression for the user's report: empty dropdown must never become tab ID zero.
        page.locator("#sourceDetails").evaluate("el => el.open = true")
        page.locator("#siteTabs").select_option("")
        page.evaluate(
            "() => {\n  window.savedTabsGet = chrome.tabs.get;\n  window.zeroTabCalls = 0;\n  chrome.tabs.get = async id => {\n    if (id === 0) window.zeroTabCalls++;\n    return window.savedTabsGet(id);\n  };\n}"
        )
        page.locator("#useTab").click()
        expect(page.locator("#errorTitle")).to_contain_text("请先选择有效的官网页面")
        assert page.evaluate("window.zeroTabCalls") == 0
        expect(page.locator("#logs")).to_contain_text("下拉框")
        page.evaluate("() => {\n  chrome.tabs.get = window.savedTabsGet;\n}")
        ok("Empty page selection does not request tab ID zero")

        def clean_scan(name):
            page.evaluate(
                "async () => {\n  await chrome.storage.local.remove('accessHold');\n  const x = ({stateV2:{tasks:await App.store.read('tasks'),logs:await App.store.read('meta','logs'),scans:await App.store.read('meta','scans'),archives:await App.store.read('meta','archives'),settings:await App.store.read('meta','settings'),ui:await App.store.read('meta','ui'),recovery:await App.store.read('meta','recovery')}});\n  x.stateV2.tasks = [];\n  x.stateV2.scans = [];\n  x.stateV2.logs = [];\n  x.stateV2.settings.maxWorks = 500;\n  for(const [k,value] of Object.entries(x.stateV2)) {if(k==='settings'){for(const name of App.configKeys)if(value?.[name]!==undefined)App.$(name).value=value[name];}else App.state[k]=value;}await App.api.persist();\n}"
            )
            page.reload()
            expect(page.locator("#stateLabel")).to_contain_text("待操作", timeout=15000)
            page.locator("#authorized").check()
            page.locator("#preset").select_option("faster")
            page.locator("#quickInput").fill("https://www.mihuashi.com/users/" + name)

        def scan_record():
            return page.evaluate(
                "async () => ({stateV2:{tasks:await App.store.read('tasks'),logs:await App.store.read('meta','logs'),scans:await App.store.read('meta','scans'),archives:await App.store.read('meta','archives'),settings:await App.store.read('meta','settings'),ui:await App.store.read('meta','ui'),recovery:await App.store.read('meta','recovery')}}).stateV2.scans.at(-1)"
            )

        clean_scan("ReplaceGallery")
        page.locator("#quickInput").fill("")
        website = c.new_page()
        website.goto("https://www.mihuashi.com/users/ReplaceGallery")
        website.locator("#artwork-archive-float #launcher").click()
        # Explicit workbench entry preserves the previous foreground workflow.
        website.locator("#artwork-archive-float #open").click()
        # Opening the workbench does not populate a URL; collect through the profile action below.
        page.locator("#quickInput").fill(
            "https://www.mihuashi.com/users/ReplaceGallery"
        )
        expect(page.locator("#quickInput")).to_have_value(
            "https://www.mihuashi.com/users/ReplaceGallery"
        )
        expect(page.locator(".task")).to_have_count(0)
        ok("Floating panel offers explicit workbench entry without starting a scan")
        page.locator("#quickAction").click()
        expect(page.locator(".task")).to_have_count(2, timeout=30000)
        expect(page.locator("#preset")).to_be_enabled(timeout=30000)
        rec = scan_record()
        assert rec["status"] == "finished" and len(rec["found"]) == 2, rec
        assert not any(
            x in page.locator("#logs").inner_text() for x in ["要求登录", "已保留 0 件"]
        )
        ok(
            "SPA replaceState and location.replace cards return to original profile and collect all works"
        )
        website.close()

        clean_scan("HistoryErrorGallery")
        page.evaluate(
            "() => {\n  chrome.tabs.goBack = async () => {\n    throw Error('Cannot find a next_page in history.');\n  };\n}"
        )
        before = requests.count("/users/HistoryErrorGallery")
        page.locator("#quickAction").click()
        expect(page.locator(".task")).to_have_count(1, timeout=20000)
        expect(page.locator("#preset")).to_be_enabled(timeout=20000)
        rec = scan_record()
        assert rec["status"] == "finished" and len(rec["found"]) == 1, rec
        assert requests.count("/users/HistoryErrorGallery") - before == 2
        ok(
            "Exact missing-history API error recovers original profile once and completes scan"
        )

        clean_scan("HistoryErrorGallery")
        page.evaluate(
            "() => {\n  chrome.tabs.goBack = async () => {\n    throw Error('Fixture unsupported navigation failure');\n  };\n}"
        )
        page.locator("#quickAction").click()
        expect(page.locator("#statusText")).to_contain_text(
            "Fixture unsupported navigation failure", timeout=20000
        )
        expect(page.locator("#preset")).to_be_enabled()
        rec = scan_record()
        assert rec["status"] == "stopped" and len(rec["found"]) == 1, rec
        expect(page.locator(".task.queued")).to_have_count(1)
        assert "已保留 1 件" in page.locator("#scanProgress").inner_text()
        ok(
            "Discovered work is persisted before returning; a failed return never loses the link"
        )

        clean_scan("BlockedCardGallery")
        before = requests.count("/users/BlockedCardGallery")
        page.locator("#quickAction").click()
        expect(page.locator("#statusText")).to_contain_text(
            "网站要求人工处理", timeout=20000
        )
        expect(page.locator("#preset")).to_be_enabled()
        assert scan_record()["status"] == "stopped"
        assert requests.count("/users/BlockedCardGallery") - before == 1
        ok(
            "Login dialog reached by a card stops scan; navigation recovery does not bypass it"
        )
        clean_scan("ScrollGallery")
        website = c.new_page()
        website.goto("https://www.mihuashi.com/users/ScrollGallery")
        website.bring_to_front()
        floating = website.locator("#artwork-archive-float")
        floating.locator("#launcher").click()
        expect(floating.locator("#collect")).to_be_disabled()
        ok("Floating background start requires fresh explicit consent")
        original_y = website.evaluate("window.scrollY")
        original_url = website.url
        active_id = page.evaluate(
            "async () => (await chrome.tabs.query({\n  active: true,\n  currentWindow: true\n}))[0].id"
        )
        before = len(requests)
        floating.locator("#consent").check()
        floating.locator("#collect").click()
        expect(floating.locator("#progress")).to_contain_text(
            "本轮已完成", timeout=60000
        )
        assert (
            website.url == original_url
            and website.evaluate("window.scrollY") == original_y
        )
        assert (
            page.evaluate(
                "async () => (await chrome.tabs.query({\n  active: true,\n  currentWindow: true\n}))[0].id"
            )
            == active_id
        )
        assert not any(path.startswith("/artworks/") for path in requests[before:])
        assert (
            scan_record()["status"] == "finished" and len(scan_record()["found"]) == 36
        )
        expect(floating.locator("#consent")).not_to_be_checked()
        ok(
            "Background scroll collects 36 lazy-loaded direct links without opening details or changing foreground tab/scroll"
        )
        website.screenshot(path=str(DEV / "floating-panel.png"))
        floating.locator("#close").click()
        box = floating.locator("#launcher").bounding_box()
        website.mouse.move(box["x"] + 24, box["y"] + 24)
        website.mouse.down()
        website.mouse.move(box["x"] - 150, box["y"] + 90, steps=8)
        website.mouse.up()
        saved_x = floating.bounding_box()["x"]
        website.reload()
        expect(floating.locator("#launcher")).to_be_visible()
        assert abs(floating.bounding_box()["x"] - saved_x) < 3
        ok("Floating control drag position persists after reload")
        floating.locator("#launcher").click()
        floating.locator("#reset").click()
        assert floating.bounding_box()["x"] > saved_x + 80
        floating.locator("#hide").click()
        expect(floating).to_be_hidden()
        ok("Floating control can reset position and hide for the current page")
        website.close()

        clean_scan("ScrollGallery")
        website = c.new_page()
        website.goto("https://www.mihuashi.com/users/ScrollGallery")
        website.bring_to_front()
        floating = website.locator("#artwork-archive-float")
        floating.locator("#launcher").click()
        floating.locator("#consent").check()
        floating.locator("#collect").click()
        expect(floating.locator("#stop")).to_be_enabled(timeout=15000)
        floating.locator("#stop").click()
        expect(floating.locator("#message")).to_contain_text(
            "已请求停止", timeout=10000
        )
        expect(floating.locator("#progress")).to_contain_text("已停止", timeout=15000)
        expect(page.locator("#preset")).to_be_enabled()
        ok(
            "Floating stop cancels background scan and leaves the foreground page unchanged"
        )
        website.close()

        clean_scan("ScrollGallery")
        page.evaluate("() => {\n  document.getElementById('maxWorks').value = '2';\n}")
        website = c.new_page()
        website.goto("https://www.mihuashi.com/users/ScrollGallery")
        website.set_viewport_size({"width": 375, "height": 667})
        floating = website.locator("#artwork-archive-float")
        floating.locator("#launcher").click()
        box = floating.locator("#panel").bounding_box()
        assert box["x"] >= 0 and box["x"] + box["width"] <= 375
        assert box["y"] >= 0 and box["y"] + box["height"] <= 667
        ok("Floating panel remains inside a narrow 375 by 667 viewport")
        floating.locator("#consent").check()
        before = len(requests)
        floating.locator("#download").click()
        expect(floating.locator("#progress")).to_contain_text("部分完成", timeout=20000)
        assert scan_record()["status"] == "partial" and len(scan_record()["found"]) == 2
        expect(page.locator(".task.done")).to_have_count(0)
        assert not any(path.startswith("/artworks/") for path in requests[before:])
        ok(
            "Background collect-and-download never downloads partial results without workbench confirmation"
        )
        website.close()

        # Cold launch: no workbench exists. Create it inactive, download ZIP in background.
        clean_scan("HistoryErrorGallery")
        page.close()
        website = c.new_page()
        website.goto("https://www.mihuashi.com/users/HistoryErrorGallery")
        website.bring_to_front()
        floating = website.locator("#artwork-archive-float")
        floating.locator("#launcher").click()
        floating.locator("#consent").check()
        floating.locator("#download").click()
        expect(floating.locator("#progress")).to_contain_text(
            "本轮已完成", timeout=60000
        )
        page = next(
            p for p in c.pages if p.url == f"chrome-extension://{eid}/manager.html"
        )
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        assert (
            page.evaluate(
                "async () => (await chrome.tabs.query({\n  active: true,\n  currentWindow: true\n}))[0].url"
            )
            == website.url
        )
        expect(page.locator(".task.done")).to_have_count(1)
        assert page.locator("#mode").input_value() == "zip"
        ok(
            "Cold background launch creates an inactive workbench and downloads ZIP without foreground navigation"
        )
        page.locator("#exportLinks").evaluate("el => el.closest('details').open = true")
        with page.expect_download() as link_download:
            page.locator("#exportLinks").click()
        text = Path(link_download.value.path()).read_text()
        assert (
            "https://image-assets.mihuashi.com/art201.png" in text
            and "artwork.square" not in text
        )
        ok(
            "Image direct-link TXT export contains resolved detail URL, not thumbnail URL"
        )
        website.close()
        clean_scan("HistoryErrorGallery")
        website = c.new_page()
        website.goto("https://www.mihuashi.com/users/HistoryErrorGallery")
        website.bring_to_front()
        floating = website.locator("#artwork-archive-float")
        floating.locator("#launcher").click()
        floating.locator("#consent").check()
        floating.locator("summary").click()
        before_downloads = page.evaluate(
            "async () => (await chrome.downloads.search({})).length"
        )
        floating.locator("#links").click()
        expect(floating.locator("#progress")).to_contain_text(
            "本轮已完成", timeout=40000
        )
        expect(page.locator(".task.ready")).to_have_count(1)
        assert (
            page.evaluate("async () => (await chrome.downloads.search({})).length")
            == before_downloads
        )
        assert (
            page.evaluate("App.state.tasks[0].candidates[0].url")
            == "https://image-assets.mihuashi.com/art201.png"
        )
        assert (
            page.evaluate(
                "async () => (await chrome.tabs.query({\n  active: true,\n  currentWindow: true\n}))[0].url"
            )
            == website.url
        )
        ok(
            "Background link-only mode resolves detail image URLs without submitting image downloads"
        )
        website.close()
        # Audit regression: retry protection survives reload and never auto-resumes.
        seed([429])
        page.locator("#start").click()
        expect(page.locator(".task.error")).to_have_count(1, timeout=15000)
        expect(page.locator("#preset")).to_be_enabled()
        hold = page.evaluate(
            "async () => (await chrome.storage.local.get('accessHold')).accessHold"
        )
        assert hold["code"] == "429" and hold["until"] - hold["at"] >= 119000
        before = len(requests)
        page.reload()
        expect(page.locator("#accessPanel")).to_be_visible()
        expect(page.locator("#ackAccess")).to_be_disabled()
        expect(page.locator("#start")).to_be_disabled()
        assert len(requests) == before
        ok(
            "HTTP 429 Retry-After hold survives workbench reload with no automatic requests"
        )
        # Advance only the fixture's saved deadline; no timer shortening exists in the release UI.
        page.evaluate(
            "async () => {\n  const x = await chrome.storage.local.get('accessHold');\n  x.accessHold.until = Date.now() - 1;\n  await chrome.storage.local.set(x);\n}"
        )
        expect(page.locator("#ackAccess")).to_be_enabled()
        page.locator("#ackAccess").click()
        expect(page.locator("#accessPanel")).to_be_hidden()
        assert len(requests) == before
        ok("Explicit release of an expired hold never automatically resumes collection")

        seed([])
        imported = {
            "tasks": [
                None,
                {
                    "url": "https://www.mihuashi.com/artworks/201",
                    "status": "ready",
                    "files": [],
                    "observedAt": "PLACEHOLDER",
                    "candidates": [
                        {
                            "url": "https://image-assets.mihuashi.com/art201.png",
                            "width": 1000,
                            "height": 1000,
                            "kind": "detail_display",
                        }
                    ],
                },
                {
                    "url": "https://www.mihuashi.com/artworks/999",
                    "status": "done",
                    "files": [],
                },
            ]
        }
        imported["tasks"][1]["observedAt"] = page.evaluate("new Date().toISOString()")
        before = len(requests)
        page.evaluate(
            "async value => await App.api.importFile(new File([JSON.stringify(value)], 'audit.json', {\n  type: 'application/json'\n}))",
            imported,
        )
        expect(page.locator(".task")).to_have_count(2)
        expect(page.locator(".task.ready")).to_have_count(1)
        expect(page.locator(".task.done")).to_have_count(0)
        assert len(requests) == before
        ok(
            "Import skips null entries, preserves detail candidates, and rejects empty success claims without requests"
        )
        before = requests.count("/artworks/201")
        page.evaluate(
            "async () => await App.api.previewOne(App.state.tasks.find(t => t.id === '201'))"
        )
        assert requests.count("/artworks/201") == before
        expect(page.locator("#preview img")).to_have_count(1)
        ok("Fresh resolved candidates are reused without re-opening the detail page")

        # Recovery may never cancel a different download with a recycled ID.
        result = page.evaluate(
            "async () => {\n  const search = chrome.downloads.search,\n    cancel = chrome.downloads.cancel;\n  const saved = JSON.parse(JSON.stringify(App.state));\n  const cancelled = [];\n  try {\n    chrome.downloads.search = async () => [{\n      id: 700,\n      url: 'https://unrelated.invalid/x',\n      state: 'in_progress',\n      filename: '/tmp/private.png'\n    }];\n    chrome.downloads.cancel = async id => {\n      cancelled.push(id);\n    };\n    App.state.archives = [{\n      status: 'pending',\n      download_id: 700,\n      download_url: 'blob:expected',\n      record_ids: [],\n      filename: 'Archive.zip'\n    }];\n    App.state.tasks = [{\n      id: '201',\n      url: 'https://www.mihuashi.com/artworks/201',\n      status: 'downloading',\n      files: [{\n        status: 'pending',\n        location: 'native',\n        download_id: 700,\n        image_url: 'https://image-assets.mihuashi.com/art201.png',\n        relative_filename: 'art201.png'\n      }]\n    }];\n    await App.api.reconcile();\n    return {\n      cancelled,\n      archive: App.state.archives[0].status,\n      file: App.state.tasks[0].files[0].status\n    };\n  } finally {\n    chrome.downloads.search = search;\n    chrome.downloads.cancel = cancel;\n    App.state = App.store.attach(saved);\n    App.api.render();\n  }\n}"
        )
        assert result == {
            "cancelled": [],
            "archive": "uncertain",
            "file": "uncertain",
        }, result
        ok(
            "Recovery does not confirm or cancel unrelated downloads with a matching numeric ID"
        )

        seed([201])
        before = len(requests)
        page.evaluate(
            "async () => await App.api.operate(async () => {\n  await App.api.fetchImage({\n    url: 'https://image-assets.mihuashi.com/redirect-image'\n  });\n})"
        )
        assert (
            "/redirect-image" in requests[before:]
            and "/never-follow.png" not in requests[before:]
        )
        ok("ZIP image fetch rejects redirects before following them")

        seed([201])
        page.evaluate(
            "() => {window.realTransaction=App.store.db.transaction.bind(App.store.db);App.store.db.transaction=(names,mode)=>{const tx=window.realTransaction(names,mode);if(mode==='readwrite')queueMicrotask(()=>tx.abort());return tx;};}"
        )
        before = len(requests)
        page.locator("#start").click()
        expect(page.locator("#storageWarning")).to_be_visible()
        expect(page.locator("#preset")).to_be_enabled()
        expect(page.locator("#export")).to_be_enabled()
        assert len(requests) == before
        with page.expect_download():
            page.locator("#export").click()
        page.evaluate(
            "async () => {App.store.db.transaction=window.realTransaction;await App.api.persist();}"
        )
        expect(page.locator("#storageWarning")).to_be_hidden()
        ok(
            "Storage failure is visible, does not leave controls busy, and keeps emergency backup available"
        )

        seed([])
        before_state = page.evaluate("JSON.stringify(App.state)")
        duplicate = c.new_page()
        with duplicate.expect_event("close"):
            duplicate.goto(
                f"chrome-extension://{eid}/manager.html", wait_until="commit"
            )
        assert page.evaluate("JSON.stringify(App.state)") == before_state
        locks = page.evaluate(
            "async () => (await navigator.locks.query()).held.map(x => x.name)"
        )
        assert locks.count("artwork-archive-workbench") == 1
        ok(
            "Lifetime workbench lock prevents a duplicate document from initializing or overwriting state"
        )
        hits = page.evaluate(
            "async () => {\n  let hits = 0;\n  await Promise.all([App.api.operate(async () => {\n    hits++;\n    await App.delay(100);\n  }), App.api.operate(async () => {\n    hits++;\n  })]);\n  return hits;\n}"
        )
        assert hits == 1
        ok(
            "Simultaneous operation clicks are serialized before asynchronous access checks"
        )

        # A user navigates the former workbench tab elsewhere. Do not hijack that tab.
        former = page
        former.goto("https://www.mihuashi.com/users/HistoryErrorGallery")
        former.locator("#artwork-archive-float #launcher").click()
        with c.expect_page() as opened:
            former.locator("#artwork-archive-float #open").click()
        page = opened.value
        page.wait_for_url(f"chrome-extension://{eid}/manager.html")
        expect(page.locator("#stateLabel")).to_contain_text("待操作", timeout=15000)
        assert former.url.endswith("/users/HistoryErrorGallery")
        ok(
            "Stale workbench registration creates a new workbench without hijacking the user's reused tab"
        )
        seed([])
        page.on("dialog", lambda d: d.accept())
        page.evaluate(
            "async () => {\n  const search = chrome.downloads.search,\n    cancel = chrome.downloads.cancel;\n  try {\n    chrome.downloads.search = async () => [{\n      id: 991,\n      state: 'interrupted',\n      error: 'SERVER_FORBIDDEN'\n    }];\n    chrome.downloads.cancel = async () => {};\n    await App.api.operate(async () => App.api.waitDownload(991, true));\n  } finally {\n    chrome.downloads.search = search;\n    chrome.downloads.cancel = cancel;\n  }\n}"
        )
        assert (
            page.evaluate(
                "async () => (await chrome.storage.local.get('accessHold')).accessHold.code"
            )
            == "NATIVE_RESTRICTED"
        )
        ok(
            "Native download permission-denial errors also require explicit release of an access hold"
        )
        page.evaluate("async () => await chrome.storage.local.remove('accessHold')")
        # Corrupted top-level schema must not be replaced with an empty successful state.
        original_state = page.evaluate(
            "async () => ({stateV2:{tasks:await App.store.read('tasks'),logs:await App.store.read('meta','logs'),scans:await App.store.read('meta','scans'),archives:await App.store.read('meta','archives'),settings:await App.store.read('meta','settings'),ui:await App.store.read('meta','ui'),recovery:await App.store.read('meta','recovery')}}).stateV2"
        )
        broken = {"logs": "not-an-array", "sentinel": "KEEP_ORIGINAL"}
        page.evaluate(
            "async value => App.store.transaction(['meta'],'readwrite',tx=>{tx.objectStore('meta').put(value.logs,'logs');tx.objectStore('meta').put(value.sentinel,'sentinel');})",
            broken,
        )
        page.reload()
        expect(page.locator("#rawBackupPanel")).to_be_visible()
        expect(page.locator("#quickAction")).to_be_disabled()
        assert (
            page.evaluate("async () => await App.store.read('meta','logs')")
            == broken["logs"]
        )
        with page.expect_download() as recovery:
            page.locator("#rawBackup").click()
        backup = json.loads(Path(recovery.value.path()).read_text())["indexedDB"][
            "meta"
        ]
        assert (
            backup["logs"] == broken["logs"]
            and backup["sentinel"] == broken["sentinel"]
        )
        page.evaluate(
            "async value => App.store.transaction(['meta'],'readwrite',tx=>{tx.objectStore('meta').put(value.logs,'logs');tx.objectStore('meta').delete('sentinel');})",
            original_state,
        )
        page.reload()
        expect(page.locator("#stateLabel")).to_contain_text("待操作", timeout=15000)
        ok(
            "Invalid stored schema remains untouched and can be exported for recovery without initialization"
        )

        # v0.6: durable binary staging, submission journals, suspension and large queues.
        def reopen_workbench():
            global page
            page.close()
            page = c.new_page()
            page.on("dialog", lambda d: d.accept())
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"chrome-extension://{eid}/manager.html")
            expect(page.locator("#stateLabel")).to_contain_text("待操作", timeout=15000)

        def stage_one():
            seed([201])
            page.evaluate(
                """async () => App.api.operate(async () => {
              const t=App.state.tasks[0]; const images=await App.api.readTask(t);
              await App.api.saveTask(t,images);
            })"""
            )
            assert page.evaluate("App.transfer.packRecords.length") == 1
            expect(page.locator("#preset")).to_be_enabled()

        stage_one()
        before = len(requests)
        page.evaluate(
            "async () => App.store.putChunk('orphan',0,new Blob(['incomplete']))"
        )
        reopen_workbench()
        assert len(requests) == before
        assert page.evaluate("App.transfer.packRecords.length") == 1
        assert page.evaluate("async () => (await App.store.read('chunks')).length") == 0
        assert page.evaluate("async () => (await App.store.read('images')).length") == 1
        assert not page.locator("#authorized").is_checked()
        with page.expect_download() as saved:
            page.locator("#saveBuffer").click()
        expect(page.locator(".task.done")).to_have_count(1)
        with ZipFile(saved.value.path()) as z:
            assert z.testzip() is None
            manifest = json.loads(z.read("manifest.json"))
            assert (
                hashlib.sha256(z.read(manifest["images"][0]["zip_member"])).hexdigest()
                == hashlib.sha256(PNGS[201]).hexdigest()
            )
        assert len(requests) == before
        assert page.evaluate("async () => (await App.store.read('images')).length") == 0
        ok(
            "Close/reopen restores committed image bytes; orphan chunks are removed; offline save verifies hash and releases staging"
        )

        # Real download succeeds while its API promise never returns its ID to the workbench.
        c.new_cdp_session(page).send(
            "Browser.setDownloadBehavior",
            {"behavior": "default", "eventsEnabled": True},
        )
        for native in [False, True]:
            if native:
                seed([201], "native")
                page.evaluate(
                    """async () => {const t=App.state.tasks[0]; await App.api.operate(async()=>App.api.readTask(t));} """
                )
            else:
                stage_one()
            page.evaluate(
                """() => {const real=chrome.downloads.download;
              chrome.downloads.download=async options=>{const id=await real(options);while((await chrome.downloads.search({id}))[0]?.state!=='complete')await App.delay(50); window.gapReached=true; return new Promise(()=>{});};
            }"""
            )
            page.locator("#start" if native else "#saveBuffer").click()
            assert page.evaluate(
                "async () => {for(let i=0;i<200;i++){if(window.gapReached)return true;await App.delay(50);}return false;}"
            )
            expect(page.locator("#stateLabel")).to_contain_text("正在处理")
            before = len(requests)
            reopen_workbench()
            assert len(requests) == before
            expect(page.locator(".task.done")).to_have_count(1)
            assert not page.evaluate("App.api.uncertainDownloads()")
            assert page.evaluate("App.transfer.packRecords.length") == 0
            ok(
                ("Native" if native else "ZIP")
                + " API-success/ID-persistence gap recovers by strict journal ownership without another download"
            )

        c.new_cdp_session(page).send(
            "Browser.setDownloadBehavior",
            {
                "behavior": "allowAndName",
                "downloadPath": str(TMP / "downloads"),
                "eventsEnabled": True,
            },
        )

        # Missing browser history is ambiguous, never permission for automatic duplicate saves.
        stage_one()
        page.evaluate(
            """async () => {App.state.archives.push({status:'requesting',filename:'Archive_absent_uuid.zip',download_url:'blob:missing',requested_at:new Date().toISOString(),record_ids:App.transfer.packRecords.map(f=>f.record_id)});await App.api.persist();}"""
        )
        before = len(requests)
        reopen_workbench()
        expect(page.locator("#recoveryWarning")).to_be_visible()
        page.evaluate("async () => App.api.operate(App.api.flushPack,true)")
        assert page.evaluate("App.transfer.packRecords.length") == 1
        assert len(requests) == before
        page.locator("#resolveDownloads").click()
        expect(page.locator("#recoveryWarning")).to_be_hidden()
        assert len(requests) == before
        with page.expect_download():
            page.locator("#saveBuffer").click()
        expect(page.locator(".task.done")).to_have_count(1)
        ok(
            "Missing download history retains staging and blocks repeats until explicit directory-check/retry confirmation"
        )

        stage_one()
        before = len(requests)
        page.evaluate(
            """async () => App.api.operate(async()=>{
          App.lifecycle.lastWall-=120000;
          await App.api.guard();
          await fetch('https://image-assets.mihuashi.com/never-follow.png');
        },true)"""
        )
        assert len(requests) == before
        assert (
            page.evaluate("App.run.stop")
            and page.evaluate("App.transfer.packRecords.length") == 1
        )
        assert page.evaluate(
            "async () => (await App.store.read('meta','recovery')).message.includes('90 秒')"
        )
        expect(page.locator("#preset")).to_be_enabled()
        page.locator("#discardBuffer").click()
        expect(page.locator("#bufferActions")).to_be_hidden()
        assert page.evaluate("async () => (await App.store.read('images')).length") == 0
        ok(
            "Injected 120-second scheduling gap stops before another request; durable staging survives and explicit discard deletes it"
        )

        # Abort the transaction containing both image data and its source record.
        seed([201])
        atomic = page.evaluate(
            """async () => {
          let result;
          await App.api.operate(async()=>{
            const t=App.state.tasks[0],images=await App.api.readTask(t),data=await App.api.fetchImage(images[0]);
            const real=App.store.db.transaction.bind(App.store.db);
            App.store.db.transaction=(names,mode)=>{const tx=real(names,mode);if(mode==='readwrite' && names.includes('images'))queueMicrotask(()=>tx.abort());return tx;};
            try {await App.api.stageImage(t,images[0],data);} catch(e){result=e.message;}
            finally {App.store.db.transaction=real;}
          });
          return {error:result,images:(await App.store.read('images')).length,staged:(await App.store.read('tasks')).flatMap(t=>t.files).filter(f=>f.status==='staged').length};
        }"""
        )
        assert (
            atomic["error"] and atomic["images"] == 0 and atomic["staged"] == 0
        ), atomic
        ok(
            "Aborted image/source transaction leaves neither a recoverable-image claim nor an orphan committed image"
        )

        # Header bomb must fail before the worker calls createImageBitmap.
        bomb = page.evaluate(
            """async () => {
          const worker=new Worker('image-worker.js'), b=new Uint8Array(24);b.set([137,80,78,71,13,10,26,10]);b.set([73,72,68,82],12);
          const v=new DataView(b.buffer);v.setUint32(16,100000);v.setUint32(20,100000);
          return new Promise(resolve=>{worker.onmessage=({data})=>{worker.terminate();resolve(data);};worker.postMessage({id:'bomb',blob:new Blob([b]),mime:'image/png'});});
        }"""
        )
        assert "3200" in bomb["error"], bomb
        ok("Worker rejects a 100000 by 100000 image header before attempting decode")

        seed([])
        before = len(requests)
        perf = page.evaluate(
            """async () => {
          await App.run.saveChain;
          const start=performance.now();
          for(let i=0;i<5000;i++)App.api.addTask('https://www.mihuashi.com/artworks/'+(100000+i));
          await App.api.persist();
          const seeded=performance.now();
          const writes=App.store.stats.taskWrites;
          App.state.tasks[2499].status='error';App.state.tasks[2499].error='large-queue-test';
          await App.api.persist();
          const delta=App.store.stats.taskWrites-writes;
          const updated=performance.now();App.api.render();await App.delay(0);
          const render=performance.now()-updated;
          return {seedMs:seeded-start,updateMs:updated-seeded,renderMs:render,taskWrites:delta,rows:document.querySelectorAll('.task').length,stored:(await App.store.read('tasks')).length,legacy:(await chrome.storage.local.get('stateV2')).stateV2 || null};
        }"""
        )
        assert (
            perf["taskWrites"] == 1
            and perf["stored"] == 5000
            and perf["rows"] <= 80
            and perf["legacy"] is None
        ), perf
        assert (
            perf["seedMs"] < 10000
            and perf["updateMs"] < 2000
            and perf["renderMs"] < 2000
        ), perf
        assert len(requests) == before
        report["largeQueue"] = perf
        page.locator("#queueSearch").fill("102499")
        expect(page.locator(".task")).to_have_count(1)
        page.locator("#queueSearch").fill("")
        ok(
            "5000-task real IndexedDB run writes exactly one task for a one-task edit, renders only a page, and has no legacy whole-state copy"
        )

        seed([201])
        large = page.evaluate(
            """async () => {
          let result;
          await App.api.operate(async()=>{
            const data=await App.api.fetchImage({url:'https://image-assets.mihuashi.com/large-image.jpg'});
            const worker=App.images.worker,send=worker.postMessage.bind(worker);let active=0,peak=0;
            const setter=Object.getOwnPropertyDescriptor(Worker.prototype,'onmessage').set;
            Object.defineProperty(worker,'onmessage',{configurable:true,set(handler){setter.call(worker,event=>{active--;handler(event);});}});
            worker.postMessage=value=>{active++;peak=Math.max(peak,active);send(value);};
            const checks=await Promise.all([App.images.inspect(data.blob,data.mime),App.images.inspect(data.blob,data.mime)]);
            result={width:data.width,height:data.height,sha256:data.sha256,peak,checks:checks.map(x=>x.sha256)};
            await App.store.dropInput(data.input);
          });
          return result;
        }"""
        )
        digest = hashlib.sha256(LARGE_JPEG).hexdigest()
        assert large == {
            "width": 6000,
            "height": 4000,
            "sha256": digest,
            "peak": 1,
            "checks": [digest, digest],
        }, large
        ok(
            "24-megapixel JPEG validates without re-encoding; concurrent inspection requests are serialized to one worker job"
        )

        # Overlapping commit snapshots must not clear a newer mutation's dirty version.
        overlap = page.evaluate(
            """async () => {const t=App.state.tasks[0];t.error='older';const first=App.api.persist();t.error='newer';const second=App.api.persist();await Promise.all([first,second]);return (await App.store.read('tasks',t.url)).error;}"""
        )
        assert overlap == "newer"
        ok("Overlapping incremental commits preserve the newest task mutation")

        seed([])
        stopped = page.evaluate(
            """async () => {
          const original=App.store.clearInputs.bind(App.store);let hits=0;
          App.store.clearInputs=async()=>{await App.delay(80);await original();};
          const operation=App.api.operate(async()=>hits++);
          await App.delay(10);App.$('pause').click();
          await operation;App.store.clearInputs=original;
          return {hits,busy:App.run.busy,starting:App.run.operationStarting};
        }"""
        )
        assert stopped == {"hits": 0, "busy": False, "starting": False}, stopped
        ok(
            "Stop during asynchronous operation preparation is honored before any task starts"
        )

        # Legacy migration commits before removing old data; abort leaves the old copy exportable.
        seed([])
        legacy = {
            "tasks": [
                {
                    "id": "201",
                    "url": "https://www.mihuashi.com/artworks/201",
                    "files": [],
                    "status": "queued",
                }
            ],
            "logs": [],
            "scans": [],
            "archives": [],
            "settings": {"mode": "zip"},
        }
        page.evaluate(
            """async value=>{await App.run.saveChain;App.store.db.close();await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase('artwork-archive-v3');r.onsuccess=resolve;r.onerror=reject;});await chrome.storage.local.set({stateV2:value});}""",
            legacy,
        )
        page.add_init_script(
            """const real=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(names,mode){const tx=real.call(this,names,mode);if(mode==='readwrite')queueMicrotask(()=>tx.abort());return tx;};"""
        )
        page.reload()
        expect(page.locator("#rawBackupPanel")).to_be_visible()
        assert (
            page.evaluate(
                "async () => (await chrome.storage.local.get('stateV2')).stateV2"
            )
            == legacy
        )
        reopen_workbench()  # New document, without the page-specific injected abort hook.
        assert page.evaluate("async () => (await App.store.read('tasks')).length") == 1
        assert (
            page.evaluate(
                "async () => (await chrome.storage.local.get('stateV2')).stateV2 || null"
            )
            is None
        )
        ok(
            "Interrupted legacy migration retains its original; a new workbench commits migration once before deleting the old whole-state copy"
        )

        assert not errors, errors
        ok("No uncaught workbench errors")
        report["browser"] = c.browser.version
        c.close()
except Exception as e:
    report["failure"] = str(e)
    report["traceback"] = traceback.format_exc()
    print(report["traceback"], flush=True)
    print("SERVER REQUESTS", requests, flush=True)
finally:
    server.shutdown()
    server.server_close()
    TEMP.cleanup()
    (DEV / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
if "failure" in report:
    raise SystemExit(1)

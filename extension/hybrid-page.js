(() => {
  if (document.getElementById("artwork-archive-hybrid")) return;
  const host = document.createElement("div");
  host.id = "artwork-archive-hybrid";
  host.style.cssText =
    "position:fixed;right:18px;bottom:22px;z-index:2147483646;color-scheme:light";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>:host{font:13px/1.7 system-ui,sans-serif;color:#284c3b}*{box-sizing:border-box}[hidden]{display:none!important}button,input{font:inherit}button{cursor:pointer;border:1px solid #cfdcc7;background:#fffef6;color:#315b43;border-radius:10px;padding:10px 14px}button:hover{background:#eaf1e2}button:disabled{opacity:.5;cursor:wait}button:focus-visible,input:focus-visible{outline:2px solid #df9a61;outline-offset:3px}#launcher{background:#315b43;color:#fff;padding:12px 17px;box-shadow:0 5px 22px #183b3226;border:0}#panel{position:fixed;right:16px;bottom:80px;width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 105px);max-height:calc(100dvh - 105px);overflow-y:auto;overscroll-behavior:contain;background:#fffef6;border:1px solid #d3ddc8;border-radius:17px;padding:21px;box-shadow:0 10px 40px #19372a22}.head{display:flex;align-items:center;justify-content:space-between}strong{font-size:18px}.head button{border:0;padding:2px 8px}p{font-size:12px;color:#73876c;margin:13px 0}label{display:flex;gap:8px;background:#edf2e5;padding:12px;border-radius:9px;margin:14px 0;font-size:12px}input{accent-color:#315b43}.actions{display:grid;gap:8px}.primary{background:#315b43;color:white}.primary:hover{background:#254935}#message{color:#8b653d;overflow-wrap:anywhere}small{letter-spacing:2px;font-size:9px;color:#8b9a80}</style><button id="launcher" aria-expanded="false">▧ 画页存档</button><section id="panel" hidden aria-label="本机归档任务"><div class="head"><strong>画页存档</strong><button id="close" aria-label="收起">×</button></div><small>HYBRID 0.7.1 · LOCAL FIRST</small><p>页面交给浏览器解析，图片交给本机引擎。可以关闭此面板和控制台，不必等在这里。</p><p>请尊重作品许可与站点规则。</p><div class="actions"><button id="download" class="primary">收集并下载到本机</button><button id="links">只解析图片直链</button><button id="open">打开任务控制台 ↗</button></div><p id="message" role="status"></p><p>需要先运行 Windows 本机程序并配对。Chrome 关闭后解析等待重连，已提交的下载继续执行；ZIP 在控制台按需导出。</p></section>`;
  document.documentElement.append(host);
  const $ = (id) => root.getElementById(id);
  let pending = false,
    lastPath = "";
  function open(value) {
    $("panel").hidden = !value;
    $("launcher").setAttribute("aria-expanded", String(value));
  }
  $("launcher").onclick = () => open($("panel").hidden);
  $("close").onclick = () => open(false);
  function sync() {
    const valid = /^\/(artworks\/\d+|users\/[^/]+|profiles\/\d+)\/?$/.test(
      location.pathname,
    );
    host.style.display = valid ? "block" : "none";
    if (lastPath !== location.pathname) {
      lastPath = location.pathname;
      $("message").textContent = "";
    }
    for (const id of ["download", "links"]) $(id).disabled = pending;
  }
  async function send(type, mode) {
    pending = true;
    sync();
    try {
      const result = await chrome.runtime.sendMessage({
        type,
        mode,
      });
      if (!result?.ok) throw Error(result?.error || "扩展未响应");
      if (type === "HYBRID_ADD")
        $("message").textContent = result.data.existing
          ? "此页面已有任务。请到控制台查看或继续。"
          : "已加入本机持久队列。关闭此面板不会中断任务。";
    } catch (e) {
      $("message").textContent = e.message;
    } finally {
      pending = false;
      sync();
    }
  }
  $("download").onclick = () => send("HYBRID_ADD", "download");
  $("links").onclick = () => send("HYBRID_ADD", "links");
  $("open").onclick = () => send("HYBRID_OPEN");
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      open(false);
      $("launcher").focus();
    }
  });
  sync();
  setInterval(sync, 1500);
})();

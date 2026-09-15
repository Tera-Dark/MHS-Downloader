"use strict";
const $ = (id) => document.getElementById(id);
let refreshing = false,
  connected = false,
  pairBusy = false,
  connectionEpoch = 0;
const labels = {
  active: "运行中",
  paused: "已暂停",
  blocked: "待检查",
  pending: "等待采集",
  running: "采集中",
  finished: "扫描结束",
  partial: "部分收集",
  complete: "已完成",
  failed: "失败",
  packing: "打包中",
  retry: "等待重试",
  downloading: "下载中",
  link: "已解析直链",
};
const count = (record) =>
  Object.values(record || {}).reduce((a, b) => a + b, 0);
const bytes = (value) =>
  value >= 1073741824
    ? (value / 1073741824).toFixed(2) + " GiB"
    : (value / 1048576).toFixed(1) + " MiB";
function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function error(text) {
  $("error").textContent = text;
  $("error").hidden = !text;
}
function feedback(id, text, kind = "") {
  const el = $(id);
  el.textContent = text;
  el.className = "feedback " + kind;
}
async function send(type, args = {}) {
  if (!globalThis.chrome?.runtime?.id)
    throw Error(
      "请在 chrome://extensions 中加载扩展，再点击扩展图标打开控制台，不要直接双击 HTML",
    );
  let timer;
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage({ type: "HYBRID_" + type, ...args }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                "扩展 30 秒内未响应。请在 chrome://extensions 重新加载扩展，并关闭旧控制台后重新打开",
              ),
            ),
          30000,
        );
      }),
    ]);
    if (!response?.ok) {
      const e = Error(response?.error || "扩展没有响应，请重新加载扩展");
      e.code = response?.code;
      throw e;
    }
    return response.data;
  } finally {
    clearTimeout(timer);
  }
}
async function action(button, fn) {
  if (!button || button.dataset.pending) return;
  const label = button.textContent;
  button.disabled = true;
  button.dataset.pending = "true";
  button.textContent = "处理中…";
  error("");
  try {
    await fn();
  } catch (e) {
    error(e.message);
  } finally {
    button.disabled = false;
    delete button.dataset.pending;
    button.textContent = label;
    await refresh();
  }
}
function control(job, title, act) {
  const b = node("button", title);
  b.dataset.key = job.id + ":" + act;
  b.addEventListener("click", () =>
    action(b, async () => {
      if (
        act === "rescan" &&
        !confirm(
          "从主页重新扫描，已有作品按 ID 去重，不会清空下载记录。继续吗？",
        )
      )
        return;
      await send("CONTROL", { id: job.id, action: act });
    }),
  );
  return b;
}
function renderJob(j) {
  const box = node("article", undefined, "job"),
    top = node("div", undefined, "job-top"),
    identity = node("div");
  const link = node("a", j.source);
  link.href = j.source;
  link.target = "_blank";
  link.rel = "noreferrer";
  const title = node("div", undefined, "job-title");
  title.append(link);
  identity.append(
    title,
    node(
      "div",
      j.id.slice(0, 8) + " · " + (j.mode === "links" ? "仅直链" : "图片归档"),
      "job-id",
    ),
  );
  const issues =
    j.scan_state === "partial" ||
    j.works.failed ||
    j.files.failed ||
    j.files.blocked;
  const status =
    j.state === "paused"
      ? "已暂停"
      : j.settled
        ? issues
          ? "结束 · 有待处理项"
          : j.mode === "links"
            ? "直链解析结束"
            : "本轮已完成"
        : labels[j.state];
  top.append(
    identity,
    node("span", status, "status" + (issues ? " warn" : "")),
  );
  box.append(top);
  const total = count(j.files),
    done = j.files.complete || 0;
  const progress = node("div", undefined, "progress"),
    bar = node("i");
  bar.style.width =
    (total
      ? Math.round(
          ((j.mode === "links" ? j.files.link || 0 : done) / total) * 100,
        )
      : 0) + "%";
  progress.append(bar);
  box.append(progress);
  box.append(
    node(
      "div",
      `扫描：${labels[j.scan_state]} · 已发现 ${count(j.works)}${j.expected !== null ? " / 页面标示 " + j.expected : ""} 件 · 已解析 ${j.works.ready || 0} 件 · 已保存 ${done}/${total} 张 · ${bytes(j.bytes)}`,
      "job-counts",
    ),
  );
  if (j.reason) box.append(node("p", j.reason, "reason"));
  const actions = node("div", undefined, "job-actions");
  actions.append(
    control(
      j,
      j.state === "paused" ? "继续任务" : "暂停任务",
      j.state === "paused" ? "resume" : "pause",
    ),
  );
  if (issues) actions.append(control(j, "重试失败项", "retry"));
  if (j.files.blocked || j.files.failed)
    actions.append(control(j, "重新解析失败图片链接", "refresh-links"));
  if (
    !/\/artworks\//.test(j.source) &&
    ["partial", "finished"].includes(j.scan_state)
  )
    actions.append(
      control(
        j,
        j.scan_state === "partial" ? "重新扫描补齐" : "增量扫描新作品",
        "rescan",
      ),
    );
  for (const [kind, text] of [
    ["zip", "导出已完成图片 ZIP"],
    ["links", "导出图片直链 TXT"],
  ]) {
    if (kind === "zip" && j.mode === "links") continue;
    const button = node("button", text);
    button.dataset.key = j.id + ":export-" + kind;
    button.disabled = kind === "zip" ? !done : !total;
    button.addEventListener("click", () =>
      action(button, () => send("EXPORT", { id: j.id, kind })),
    );
    actions.append(button);
  }
  box.append(actions);
  return box;
}
async function refresh() {
  if (refreshing || pairBusy) return;
  refreshing = true;
  const epoch = connectionEpoch;
  try {
    const data = await send("STATE");
    if (epoch !== connectionEpoch || pairBusy) return;
    $("connectionError").hidden = true;
    $("connection").textContent =
      "● 本机引擎已连接 · " + data.workers + " 路下载";
    if (!connected) {
      $("pairBody").hidden = true;
      connected = true;
      feedback("pairMessage", "✓ 本机引擎已连接，可以添加任务", "success");
    }
    $("rootPath").textContent = "本地数据目录：" + data.root;
    const recent = data.collector && Date.now() / 1000 - data.collector.at < 90;
    $("browser").textContent =
      (recent
        ? "● 浏览器采集器已连接"
        : "◌ 浏览器采集器暂未响应；已提交的下载仍由本机程序执行") +
      (data.browserStatus?.error ? " · " + data.browserStatus.error : "");
    $("mWorks").textContent = data.jobs.reduce((n, j) => n + count(j.works), 0);
    $("mParsed").textContent = data.jobs.reduce(
      (n, j) => n + (j.works.ready || 0),
      0,
    );
    $("mFiles").textContent = data.jobs.reduce(
      (n, j) => n + (j.files.complete || 0),
      0,
    );
    $("mBytes").textContent = bytes(data.jobs.reduce((n, j) => n + j.bytes, 0));
    if (!$("jobs").querySelector("[data-pending]")) {
      const focusKey = $("jobs").contains(document.activeElement)
        ? document.activeElement.dataset.key
        : null;
      $("jobs").replaceChildren(
        ...(data.jobs.length
          ? data.jobs.map(renderJob)
          : [
              node(
                "div",
                "还没有任务。粘贴一个主页链接，从这里开始。",
                "empty",
              ),
            ]),
      );
      if (focusKey) {
        const buttons = [...$("jobs").querySelectorAll("button")];
        (
          buttons.find((b) => b.dataset.key === focusKey) ||
          buttons.find((b) =>
            b.dataset.key?.startsWith(focusKey.split(":")[0] + ":"),
          )
        )?.focus({ preventScroll: true });
      }
    }
    $("hold").hidden = !data.hold;
    if (data.hold) {
      $("holdTitle").textContent = "访问暂停 · " + data.hold.code;
      $("holdReason").textContent =
        data.hold.reason +
        (data.hold.until
          ? " · 最早可恢复：" +
            new Date(data.hold.until * 1000).toLocaleString()
          : "");
      $("clearHold").disabled = data.hold.until > Date.now() / 1000;
    }
    $("exports").replaceChildren(
      ...(data.exports.length
        ? data.exports.map((x) => {
            const el = node(
              "div",
              `${x.job.slice(0, 8)} · ${labels[x.state] || x.state}`,
              "item",
            );
            el.append(
              node("code", x.path || x.error || "后台打包中，控制台可以关闭"),
            );
            return el;
          })
        : [node("p", "暂无导出。图片先保存到本机，按需打包 ZIP。")]),
    );
    $("errors").replaceChildren(
      ...(data.errors.length
        ? data.errors.slice(0, 12).map((x) => {
            const el = node("div", x.error, "item");
            el.append(node("code", x.url));
            return el;
          })
        : [node("p", "没有待处理错误。")]),
    );
  } catch (e) {
    if (epoch !== connectionEpoch || pairBusy) return;
    connected = false;
    $("connectionError").textContent =
      e.message + (e.code ? " [" + e.code + "]" : "");
    $("connectionError").hidden = false;
    $("connection").textContent = "◌ 未连接本机引擎";
    if (!connected) $("pairBody").hidden = false;
    $("browser").textContent = e.message;
  } finally {
    refreshing = false;
  }
}
$("pairForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (pairBusy) return;
  pairBusy = true;
  ++connectionEpoch;
  const button = e.submitter || $("pairButton");
  button.disabled = true;
  button.textContent = "正在连接…";
  $("diagnose").disabled = true;
  $("connection").textContent = "◌ 正在连接本机引擎…";
  $("connectionError").hidden = true;
  error("");
  feedback("pairMessage", "正在检查服务、验证令牌并读取任务状态…");
  try {
    const result = await send("PAIR", { token: $("token").value });
    connected = true;
    $("token").value = "";
    $("pairBody").hidden = true;
    $("connection").textContent =
      "● 本机引擎已连接 · " + result.state.workers + " 路下载";
    $("rootPath").textContent = "本地数据目录：" + result.root;
    feedback(
      "pairMessage",
      "✓ 连接成功 · 本机 " +
        result.version +
        " · 令牌和状态读取均通过，可以添加任务",
      "success",
    );
  } catch (err) {
    connected = false;
    $("connection").textContent = "◌ 连接失败";
    $("pairBody").hidden = false;
    feedback(
      "pairMessage",
      "连接失败：" + err.message + (err.code ? " [" + err.code + "]" : ""),
      "failure",
    );
  } finally {
    pairBusy = false;
    button.disabled = false;
    button.textContent = "连接本机";
    $("diagnose").disabled = false;
    if (connected) await refresh();
  }
});
$("createForm").addEventListener("submit", (e) => {
  e.preventDefault();
  action(
    e.submitter || $("createForm").querySelector("button[type=submit]"),
    async () => {
      feedback("taskMessage", "正在提交任务…");
      try {
        const result = await send("CREATE", {
          source: $("source").value.trim(),
          mode: $("mode").value,
        });
        feedback(
          "taskMessage",
          result.existing
            ? "✓ 此页面已有任务：" + result.id.slice(0, 8) + "，请查看下方队列"
            : "✓ 任务已加入本机队列：" + result.id.slice(0, 8),
          "success",
        );
        $("source").value = "";
      } catch (err) {
        feedback("taskMessage", "添加失败：" + err.message, "failure");
        throw err;
      }
    },
  );
});
$("diagnose").addEventListener("click", (e) =>
  action(e.target, async () => {
    feedback("pairMessage", "正在检查 127.0.0.1:47653…");
    try {
      const result = await send("DIAGNOSE");
      feedback(
        "pairMessage",
        "✓ 本机服务在线，版本 " +
          result.version +
          "。这仅验证服务可达；仍需输入令牌完成配对",
        "success",
      );
    } catch (err) {
      feedback("pairMessage", "自检失败：" + err.message, "failure");
      throw err;
    }
  }),
);
$("togglePair").addEventListener("click", () => {
  $("pairBody").hidden = !$("pairBody").hidden;
});
$("refresh").addEventListener("click", refresh);
$("clearHold").addEventListener("click", (e) =>
  action(e.target, async () => {
    if (
      confirm(
        "已在官网检查登录、验证及访问状态？解除暂停后会恢复尚未完成的任务，不会绕过验证。",
      )
    )
      await send("CLEAR_HOLD", { confirmed: true });
  }),
);
refresh();
setInterval(refresh, 3000);

"use strict";
importScripts("core-policy.js", "scanner.js");
const BASE = "http://127.0.0.1:47653/v1";
const HOME = chrome.runtime.getURL("hybrid.html");
let busy = false,
  timer = null,
  lastBeat = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function failure(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
async function request(path, body, token) {
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 8000);
  try {
    const headers = { "X-Archive-Extension": chrome.runtime.id };
    if (token) headers.Authorization = "Bearer " + token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(BASE + path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      credentials: "omit",
      cache: "no-store",
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw failure(
        "BAD_RESPONSE",
        "47653 端口没有返回本程序的 JSON 数据；请检查是否被其他程序占用",
      );
    }
    if (!response.ok)
      throw failure(
        result.code || "HTTP_" + response.status,
        result.error || "本机程序响应异常（HTTP " + response.status + "）",
      );
    return result;
  } catch (e) {
    if (e.name === "AbortError" || e instanceof TypeError)
      throw failure(
        "ENGINE_OFFLINE",
        "无法连接 127.0.0.1:47653。请保持 START-WINDOWS.bat 窗口运行；若已运行，检查 Chrome 本地网络权限或安全软件的回环连接拦截",
      );
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
async function api(path, body, tokenOverride) {
  const token =
    tokenOverride ||
    (await chrome.storage.local.get("hybridToken")).hybridToken;
  if (!token)
    throw failure(
      "NOT_CONFIGURED",
      "尚未配对。启动本机程序后粘贴令牌，点击“连接本机”",
    );
  return request(path, body, token);
}
async function checkService() {
  let health;
  try {
    health = await request("/health");
  } catch (e) {
    if (e.code === "ENGINE_OFFLINE") throw e;
    throw failure(
      "ENGINE_VERSION",
      "本机接口不兼容，可能仍运行着 0.7.0。请退出旧 Python 窗口，覆盖修复包后重新启动",
    );
  }
  if (health.service !== "artwork-archive-hybrid" || health.protocol !== 2)
    throw failure(
      "ENGINE_VERSION",
      "本机服务版本与扩展不匹配。请同时更新 native 和 extension，并重启本机程序",
    );
  return health;
}
function schedule(ms = 2500) {
  clearTimeout(timer);
  timer = setTimeout(() => tick().catch(console.error), ms);
}
async function remember(slots) {
  await chrome.storage.session.set({ hybridSlots: slots });
}
async function openConsole() {
  const tabs = await chrome.tabs.query({ url: HOME });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else await chrome.tabs.create({ url: HOME });
}
async function tabSlot(slots, name) {
  let slot = slots[name];
  if (slot) {
    try {
      await chrome.tabs.get(slot.id);
      return slot;
    } catch {
      delete slots[name];
    }
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  slot = slots[name] = { id: tab.id, target: "", since: Date.now() };
  await remember(slots);
  return slot;
}
async function allowNavigation() {
  const { hybridNavAt = 0 } = await chrome.storage.session.get("hybridNavAt");
  if (Date.now() < hybridNavAt + 2000) return false;
  await chrome.storage.session.set({ hybridNavAt: Date.now() });
  return true;
}
async function ready(slots, name, url) {
  const slot = await tabSlot(slots, name);
  if (slot.target !== url) {
    if (!(await allowNavigation())) return null;
    Object.assign(slot, { target: url, since: Date.now() });
    await remember(slots); // Persist intent before navigation.
    await chrome.tabs.update(slot.id, { url, active: false });
    return null;
  }
  const tab = await chrome.tabs.get(slot.id);
  if (tab.discarded) {
    slot.since = Date.now();
    await remember(slots);
    await chrome.tabs.reload(slot.id);
    return null;
  }
  // Replay navigation after termination between persisting intent and issuing tabs.update.
  if (tab.url === "about:blank" && !tab.pendingUrl) {
    await chrome.tabs.update(slot.id, { url, active: false });
    return null;
  }
  if (Date.now() - slot.since > 45000 && tab.status !== "complete")
    throw Error("页面加载超过 45 秒");
  if (tab.status !== "complete") return null;
  const normalized = ArchivePolicy.siteURL(
    tab.url,
    /\/artworks\//.test(url) ? "artwork" : "profile",
  );
  if (normalized !== url) {
    await hold("NAVIGATION", "任务页离开预期页面，请检查登录、验证或重定向");
    throw Error("任务页离开预期地址，已暂停");
  }
  return slot;
}
async function dom(tabId, op, args = {}) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageTask,
    args: [{ op, ...args }],
  });
  const value = result[0]?.result;
  if (!value) throw Error("无法读取页面，请检查扩展站点权限");
  if (value.blocked) {
    await hold("AUTH", "官网提示：" + value.blocked);
    throw Error("登录或验证待人工处理");
  }
  return value;
}
async function hold(code, reason, until = 0) {
  const value = { code, reason, until };
  await chrome.storage.local.set({ hybridPendingHold: value });
  await api("/hold", value);
  await chrome.storage.local.remove("hybridPendingHold");
}
async function checkpoint(job, c, links = [], state = "running", reason = "") {
  return api("/jobs/" + job.id + "/discovery", {
    cursor: c,
    links,
    state,
    reason,
    expected: c.expected ?? null,
  });
}
async function scan(job, slots) {
  const c = JSON.parse(job.cursor || "{}");
  c.seen ||= [];
  c.found ||= [];
  c.unresolved ||= [];
  const found = new Set(c.found);
  const originalFound = new Set(c.found);
  const seen = new Set(c.seen);
  let slot = await tabSlot(slots, "profile");
  const add = (url) => {
    url = ArchivePolicy.siteURL(url);
    if (url) found.add(url);
  };
  // Returning to the list is also journalled: termination after saving the URL but
  // before goBack must not turn a known detail page into an unexpected redirect.
  if (c.returning) {
    const tab = await chrome.tabs.get(slot.id);
    if (tab.status !== "complete") return;
    if (ArchivePolicy.siteURL(tab.url, "profile") === job.source) {
      c.returning = false;
      c.restoreAttempts = 0;
      await checkpoint(job, c);
      return;
    }
    if (tab.url === "about:blank") {
      await ready(slots, "profile", job.source);
      return;
    }
    if (!ArchivePolicy.siteURL(tab.url)) {
      await hold("NAVIGATION", "恢复列表时遇到未知页面，请检查任务标签页");
      return;
    }
    if (!(await allowNavigation())) return;
    try {
      await chrome.tabs.goBack(slot.id);
    } catch {
      await chrome.tabs.update(slot.id, { url: job.source, active: false });
    }
    slot.target = job.source;
    slot.since = Date.now();
    await remember(slots);
    return;
  }
  // Opaque click is journalled first. Restarting the worker does not re-click blindly.
  if (c.click) {
    let tab = await chrome.tabs.get(slot.id);
    const children = (await chrome.tabs.query({})).filter(
      (t) => t.openerTabId === slot.id && !c.click.knownTabs.includes(t.id),
    );
    const child = children.find((t) =>
      ArchivePolicy.siteURL(t.url || t.pendingUrl),
    );
    const link =
      ArchivePolicy.siteURL(tab.url) ||
      ArchivePolicy.siteURL(child?.url || child?.pendingUrl);
    if (!link && Date.now() - c.click.at < 6500) return;
    if (!link && tab.url !== job.source && tab.url !== "about:blank") {
      await hold("NAVIGATION", "卡片点击后跳转到未知页面，请检查任务标签页");
      return;
    }
    if (tab.url !== job.source && !(await allowNavigation())) return;
    if (link) {
      add(link);
      c.found = [...found];
      await checkpoint(job, c, [link]);
      const detailTab = child || tab;
      if (detailTab.status === "complete") {
        const parsed = await dom(detailTab.id, "detail");
        if (parsed.images?.length)
          await api("/parsed", {
            job: job.id,
            url: link,
            title: parsed.title,
            images: parsed.images,
          });
      }
    } else c.unresolved.push(c.click.key);
    seen.add(c.click.key);
    c.seen = [...seen];
    c.y = c.click.y;
    c.click = null;
    c.found = [...found];
    c.restoreAttempts = 0;
    c.returning = tab.url !== job.source;
    await checkpoint(job, c, link ? [link] : []);
    if (child) await chrome.tabs.remove(child.id);
    if (tab.url !== job.source) {
      try {
        await chrome.tabs.goBack(slot.id);
      } catch {
        await chrome.tabs.update(slot.id, { url: job.source, active: false });
      }
      slot.since = Date.now();
      slot.target = job.source;
      await remember(slots);
    }
    return;
  }
  slot = await ready(slots, "profile", job.source);
  if (!slot) return;
  let snap = await dom(slot.id, "profile");
  if (c.y && snap.y < c.y - 8) {
    await dom(slot.id, "restore", { y: c.y });
    c.restoreAttempts = (c.restoreAttempts || 0) + 1;
    if (c.restoreAttempts > 60) {
      await checkpoint(
        job,
        c,
        [],
        "partial",
        "列表滚动位置无法恢复；已收集作品继续下载，可重新扫描补齐",
      );
    } else await checkpoint(job, c);
    return;
  }
  c.restoreAttempts = 0;
  if (snap.expected !== null) c.expected = snap.expected;
  const before = found.size;
  snap.links.forEach(add);
  snap.cards.forEach((card) => {
    if (card.url) {
      add(card.url);
      seen.add(card.key);
    }
  });
  c.found = [...found];
  c.seen = [...seen];
  c.y = snap.y;
  c.rounds = (c.rounds || 0) + 1;
  const save = await checkpoint(
    job,
    c,
    [...found].filter(
      (url) => !JSON.parse(job.cursor || "{}").found?.includes(url),
    ),
  );
  if (save.count >= 5000 || c.rounds >= 3000) {
    await checkpoint(
      job,
      c,
      [],
      "partial",
      "达到安全扫描上限；已确认的作品继续下载",
    );
    return;
  }
  if (c.expected != null && c.expected > 0 && found.size >= c.expected) {
    await checkpoint(
      job,
      c,
      [],
      "finished",
      "已达到页面标示作品数；以实际已解析记录为准",
    );
    return;
  }
  const opaque = snap.cards.find((card) => !card.url && !seen.has(card.key));
  if (opaque) {
    c.click = {
      key: opaque.key,
      y: snap.y,
      at: Date.now(),
      knownTabs: (await chrome.tabs.query({})).map((t) => t.id),
    };
    await checkpoint(job, c);
    const result = await chrome.scripting.executeScript({
      target: { tabId: slot.id },
      world: "MAIN",
      func: clickProfileCard,
      args: [opaque.key],
    });
    const click = result[0]?.result;
    if (click?.captured) {
      add(click.captured);
      c.found = [...found];
      c.seen.push(opaque.key);
      c.click = null;
      await checkpoint(job, c, [click.captured]);
    }
    return;
  }
  const signature = snap.cards.map((x) => x.key).join("|");
  c.quiet =
    snap.bottom && before === found.size && signature === c.lastSignature
      ? (c.quiet || 0) + 1
      : 0;
  c.lastSignature = signature;
  if (c.quiet >= 5) {
    const incomplete =
      c.unresolved.length || (c.expected != null && found.size < c.expected);
    await checkpoint(
      job,
      c,
      [],
      incomplete ? "partial" : "finished",
      incomplete
        ? "列表暂时没有新增，但数量不齐或存在无法解析的卡片；可重新扫描补齐"
        : "连续 5 次到底且没有新卡片；未将页面总数当作完成的唯一依据",
    );
    return;
  }
  const scroll = await dom(slot.id, "scroll");
  c.y = scroll.y;
  await checkpoint(job, c);
}
async function parseWork(work, slots) {
  try {
    const slot = await ready(slots, "detail", work.url);
    if (!slot) return;
    const page = await dom(slot.id, "detail");
    if (!page.images?.length) {
      if (Date.now() - slot.since < 45000) return;
      throw Error("45 秒内未找到符合条件的详情展示图");
    }
    await api("/parsed", {
      job: work.job,
      url: work.url,
      title: page.title,
      images: page.images,
    });
    slot.target = ""; // Retry of the same URL must start a fresh deadline.
    await remember(slots);
  } catch (e) {
    // Authorization and engine-offline errors are not disposable per-work failures.
    if (/本机程序|配对|登录|验证|已暂停|访问保护/.test(e.message)) throw e;
    await api("/work-failed", {
      job: work.job,
      url: work.url,
      error: e.message,
    });
    if (slots.detail) slots.detail.target = "";
    await remember(slots);
  }
}
async function tick() {
  if (busy) return;
  busy = true;
  let nextDelay = 2500;
  try {
    const config = await chrome.storage.local.get([
      "hybridToken",
      "hybridPendingHold",
    ]);
    if (!config.hybridToken) {
      nextDelay = 30000;
      return;
    }
    if (config.hybridPendingHold) {
      await api("/hold", config.hybridPendingHold);
      await chrome.storage.local.remove("hybridPendingHold");
    }
    if (Date.now() - lastBeat > 15000) {
      await api("/heartbeat", {
        message: "浏览器采集器已连接；关闭控制台不停止采集",
      });
      lastBeat = Date.now();
    }
    const next = await api("/next");
    if (next.hold) {
      nextDelay = 10000;
      return;
    }
    const saved = await chrome.storage.session.get([
      "hybridSlots",
      "hybridTurn",
    ]);
    const slots = saved.hybridSlots || {};
    if (!next.scan && !next.work) {
      nextDelay = 10000;
      return;
    }
    const doScan = next.scan && (!next.work || !saved.hybridTurn);
    await chrome.storage.session.set({ hybridTurn: doScan });
    if (doScan) {
      try {
        await scan(next.scan, slots);
      } catch (e) {
        if (/本机程序|配对|登录|验证|已暂停|访问保护/.test(e.message)) throw e;
        const cursor = JSON.parse(next.scan.cursor || "{}");
        // Do not overwrite a newer checkpoint on failure; fetch the latest before marking partial.
        const fresh = await api("/next");
        if (fresh.scan?.id === next.scan.id)
          await checkpoint(
            next.scan,
            JSON.parse(fresh.scan.cursor || "{}"),
            [],
            "partial",
            "扫描中断：" + e.message,
          );
        else if (!fresh.hold) console.warn("扫描状态已改变", cursor.rounds);
      }
    } else await parseWork(next.work, slots);
    await chrome.storage.local.set({
      hybridStatus: { at: Date.now(), error: "" },
    });
  } catch (e) {
    nextDelay = 10000;
    await chrome.storage.local.set({
      hybridStatus: { at: Date.now(), error: e.message },
    });
  } finally {
    busy = false;
    schedule(nextDelay);
  }
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg?.type?.startsWith("HYBRID_")) return;
  (async () => {
    if (sender.id !== chrome.runtime.id) throw Error("消息来源不受信任");
    const ownUI = sender.url?.split(/[?#]/)[0] === HOME;
    const site = /^https:\/\/www\.mihuashi\.com\//.test(sender.tab?.url || "");
    if (msg.type === "HYBRID_OPEN" && (site || ownUI)) {
      await openConsole();
      return { ok: true };
    }
    if (msg.type === "HYBRID_ADD" && site) {
      const current = sender.tab.url;
      const source =
        ArchivePolicy.siteURL(current) ||
        ArchivePolicy.siteURL(current, "profile");
      if (!source) throw Error("请在画师主页或作品详情页操作");
      const result = await api("/jobs", {
        source,
        mode: msg.mode === "links" ? "links" : "download",
      });
      schedule(50);
      return result;
    }
    if (!ownUI) throw Error("请从扩展控制台操作");
    if (msg.type === "HYBRID_DIAGNOSE") return checkService();
    if (msg.type === "HYBRID_PAIR") {
      const token = String(msg.token || "").trim();
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
        throw failure(
          "TOKEN_FORMAT",
          "令牌格式不正确，请只复制本机窗口中那一整行令牌，不要包含引号或提示文字",
        );
      await checkService();
      const result = await api("/pair", {}, token);
      const state = await api("/state", undefined, token);
      await chrome.storage.local.set({ hybridToken: token });
      schedule(50);
      return { ...result, state };
    }
    if (msg.type === "HYBRID_STATE") {
      const status = (await chrome.storage.local.get("hybridStatus"))
        .hybridStatus;
      return { ...(await api("/state")), browserStatus: status };
    }
    if (msg.type === "HYBRID_CREATE") {
      const result = await api("/jobs", {
        source: msg.source,
        mode: msg.mode,
      });
      schedule(50);
      return result;
    }
    if (msg.type === "HYBRID_CONTROL" && /^[a-f0-9]{32}$/.test(msg.id)) {
      const result = await api("/jobs/" + msg.id + "/control", {
        action: msg.action,
      });
      if (["resume", "rescan", "retry", "refresh-links"].includes(msg.action)) {
        const saved = await chrome.storage.session.get("hybridSlots");
        const slots = saved.hybridSlots || {};
        for (const slot of Object.values(slots)) slot.since = Date.now();
        await remember(slots);
      }
      schedule(50);
      return result;
    }
    if (msg.type === "HYBRID_EXPORT" && /^[a-f0-9]{32}$/.test(msg.id))
      return api("/jobs/" + msg.id + "/export", { kind: msg.kind });
    if (msg.type === "HYBRID_CLEAR_HOLD") {
      await chrome.storage.local.remove("hybridPendingHold");
      const result = await api("/clear-hold", {
        confirmed: msg.confirmed === true,
      });
      const saved = await chrome.storage.session.get("hybridSlots");
      for (const slot of Object.values(saved.hybridSlots || {}))
        slot.since = Date.now();
      await remember(saved.hybridSlots || {});
      schedule(50);
      return result;
    }
    throw Error("未知操作");
  })()
    .then((data) => reply({ ok: true, data }))
    .catch((e) =>
      reply({
        ok: false,
        error: e.message,
        code: e.code || "OPERATION_FAILED",
      }),
    );
  return true;
});
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (
      !(
        details.statusCode === 429 ||
        (details.type === "main_frame" &&
          [401, 403].includes(details.statusCode))
      )
    )
      return;
    chrome.storage.session
      .get("hybridSlots")
      .then(async ({ hybridSlots = {} }) => {
        if (!Object.values(hybridSlots).some((s) => s.id === details.tabId))
          return;
        const retry = details.responseHeaders?.find(
          (h) => h.name.toLowerCase() === "retry-after",
        )?.value;
        const until =
          details.statusCode === 429
            ? ArchivePolicy.retryUntil(retry) / 1000
            : 0;
        await hold(
          String(details.statusCode),
          "任务页面返回 HTTP " + details.statusCode + "，请检查官网后继续",
          until,
        );
      })
      .catch(console.error);
  },
  {
    urls: ["https://www.mihuashi.com/*", "https://image-assets.mihuashi.com/*"],
  },
  ["responseHeaders"],
);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.status === "complete") schedule(500);
});
chrome.tabs.onRemoved.addListener(() => schedule(1500));
chrome.action.onClicked.addListener(() => openConsole().catch(console.error));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "hybrid-recover") tick().catch(console.error);
});
async function setup() {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  await chrome.alarms.create("hybrid-recover", { periodInMinutes: 1 });
  schedule(100);
}
chrome.runtime.onStartup.addListener(() => setup().catch(console.error));
chrome.runtime.onInstalled.addListener(() => setup().catch(console.error));
setup().catch(console.error);

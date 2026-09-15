const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ext = path.resolve(__dirname, "../extension");
function harness() {
  const stores = { local: { hybridToken: "test-token" }, session: {} };
  const tabs = new Map();
  const events = [];
  const requests = [];
  const listeners = {};
  const storage = (name) => ({
    async get(keys) {
      if (typeof keys === "string") keys = [keys];
      return Object.fromEntries(
        keys.map((k) => [k, structuredClone(stores[name][k])]),
      );
    },
    async set(values) {
      Object.assign(stores[name], structuredClone(values));
    },
    async remove(keys) {
      for (const k of typeof keys === "string" ? [keys] : keys)
        delete stores[name][k];
    },
    async setAccessLevel() {},
  });
  let nextId = 1;
  const fixtures = {
    profile: {
      pageURL: "https://www.mihuashi.com/users/test",
      cards: [],
      links: [],
      expected: null,
      y: 0,
      bottom: false,
    },
    detail: { images: [] },
  };
  const chrome = {
    storage: { local: storage("local"), session: storage("session") },
    runtime: {
      id: "a".repeat(32),
      getURL: (x) => "chrome-extension://" + "a".repeat(32) + "/" + x,
      onMessage: { addListener: (f) => (listeners.message = f) },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    alarms: { async create() {}, onAlarm: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
    windows: { async update() {} },
    webRequest: { onHeadersReceived: { addListener() {} } },
    tabs: {
      async create(options) {
        const t = { id: nextId++, status: "complete", ...options };
        tabs.set(t.id, t);
        return { ...t };
      },
      async get(id) {
        if (!tabs.has(id)) throw Error("No tab");
        return { ...tabs.get(id) };
      },
      async update(id, options) {
        if (options.url) events.push(["navigate", options.url]);
        Object.assign(tabs.get(id), options);
        return { ...tabs.get(id) };
      },
      async query() {
        return [...tabs.values()].map((t) => ({ ...t }));
      },
      async remove(id) {
        tabs.delete(id);
      },
      async goBack(id) {
        events.push(["back"]);
        tabs.get(id).url = fixtures.profile.pageURL;
      },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    scripting: {
      async executeScript(options) {
        const name = options.func.name;
        events.push(["script", name, options.args]);
        if (name === "clickProfileCard")
          return [{ result: fixtures.click || { clicked: false } }];
        const op = options.args[0].op;
        return [{ result: fixtures[op] || fixtures.profile }];
      },
    },
  };
  const context = vm.createContext({
    chrome,
    console,
    URL,
    Date,
    Set,
    Map,
    AbortController,
    structuredClone,
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    async fetch(url, options) {
      const body = options.body ? JSON.parse(options.body) : undefined;
      const route = url.replace("http://127.0.0.1:47653/v1", "");
      requests.push([route, body]);
      events.push(["api", route, body]);
      return {
        ok: true,
        async json() {
          return route.endsWith("/discovery")
            ? { count: body.links.length }
            : {};
        },
      };
    },
  });
  context.importScripts = (...files) => {
    for (const file of files)
      vm.runInContext(fs.readFileSync(path.join(ext, file), "utf8"), context);
  };
  vm.runInContext(
    fs.readFileSync(path.join(ext, "hybrid-worker.js"), "utf8"),
    context,
  );
  const functions = vm.runInContext(
    "({ready,scan,parseWork,allowNavigation})",
    context,
  );
  return {
    functions,
    stores,
    tabs,
    events,
    requests,
    fixtures,
    listeners,
    chrome,
  };
}
const source = "https://www.mihuashi.com/users/test",
  work = "https://www.mihuashi.com/artworks/123";
async function prepare(h, name, url, since = Date.now()) {
  const tab = await h.chrome.tabs.create({ url });
  return { [name]: { id: tab.id, target: url, since } };
}
test("navigation intent is saved independently of the control panel", async () => {
  const h = harness(),
    slots = {};
  await h.functions.ready(slots, "detail", work);
  assert.equal(h.stores.session.hybridSlots.detail.target, work);
  assert.equal(h.events.filter((x) => x[0] === "navigate").length, 1);
});
test("replays an intent if service worker stopped before navigation", async () => {
  const h = harness(),
    slots = await prepare(h, "detail", "about:blank");
  slots.detail.target = work;
  await h.functions.ready(slots, "detail", work);
  assert.equal(h.tabs.get(slots.detail.id).url, work);
});
test("global page navigation rate is at least two seconds", async () => {
  const h = harness();
  assert.equal(await h.functions.allowNavigation(), true);
  assert.equal(await h.functions.allowNavigation(), false);
});
test("direct links checkpoint into native queue before scan ends", async () => {
  const h = harness(),
    slots = await prepare(h, "profile", source);
  h.fixtures.profile.links = [work];
  h.fixtures.scroll = { y: 600 };
  await h.functions.scan({ id: "1".repeat(32), source, cursor: "{}" }, slots);
  const discoveries = h.requests.filter((x) => x[0].endsWith("/discovery"));
  assert.ok(discoveries.some((x) => x[1].links.includes(work)));
  assert.ok(discoveries.every((x) => x[1].state === "running"));
});
test("opaque card intent is durable before click and captured URL is queued", async () => {
  const h = harness(),
    slots = await prepare(h, "profile", source);
  h.fixtures.profile.cards = [{ key: "image-key", url: null }];
  h.fixtures.click = { clicked: true, captured: work };
  await h.functions.scan({ id: "1".repeat(32), source, cursor: "{}" }, slots);
  const intent = h.events.findIndex(
    (x) => x[0] === "api" && x[2]?.cursor?.click,
  );
  const click = h.events.findIndex(
    (x) => x[0] === "script" && x[1] === "clickProfileCard",
  );
  assert.ok(intent >= 0 && intent < click);
  assert.ok(h.requests.some((x) => x[1]?.links?.includes(work)));
  assert.equal(h.requests.at(-1)[1].cursor.click, null);
});
test("recovery of a navigated card also reuses its already loaded detail", async () => {
  const h = harness(),
    slots = await prepare(h, "profile", work);
  slots.profile.target = source;
  h.fixtures.detail = {
    title: "test",
    images: [
      {
        url: "https://image-assets.mihuashi.com/test.png",
        width: 800,
        height: 800,
      },
    ],
  };
  await h.functions.scan(
    {
      id: "1".repeat(32),
      source,
      cursor: JSON.stringify({
        click: { key: "k", y: 300, at: Date.now() - 10000, knownTabs: [] },
      }),
    },
    slots,
  );
  assert.ok(h.requests.some((x) => x[0] === "/parsed" && x[1].url === work));
  assert.ok(h.events.some((x) => x[0] === "back"));
});
test("individual parse timeout is reported without a global hold", async () => {
  const h = harness(),
    slots = await prepare(h, "detail", work, Date.now() - 50000);
  await h.functions.parseWork({ job: "1".repeat(32), url: work }, slots);
  assert.ok(h.requests.some((x) => x[0] === "/work-failed"));
  assert.ok(!h.requests.some((x) => x[0] === "/hold"));
});
test("page verification halts rather than retrying around it", async () => {
  const h = harness(),
    slots = await prepare(h, "detail", work);
  h.fixtures.detail = { blocked: "请完成验证" };
  await assert.rejects(
    h.functions.parseWork({ job: "1".repeat(32), url: work }, slots),
    /人工/,
  );
  assert.ok(h.requests.some((x) => x[0] === "/hold"));
  assert.ok(!h.requests.some((x) => x[0] === "/work-failed"));
});
test("website sender cannot invoke privileged pairing", async () => {
  const h = harness();
  const result = await new Promise((resolve) =>
    h.listeners.message(
      { type: "HYBRID_PAIR", token: "x".repeat(50) },
      { id: "a".repeat(32), url: source, tab: { url: source } },
      resolve,
    ),
  );
  assert.equal(result.ok, false);
  assert.ok(!h.requests.some((x) => x[0] === "/pair"));
});

test("restart after URL commit replays a journalled return to the list", async () => {
  const h = harness(),
    slots = await prepare(h, "profile", work);
  slots.profile.target = source;
  await h.functions.scan(
    {
      id: "1".repeat(32),
      source,
      cursor: JSON.stringify({ returning: true, y: 300, found: [work] }),
    },
    slots,
  );
  assert.ok(h.events.some((x) => x[0] === "back"));
  assert.ok(!h.requests.some((x) => x[0] === "/hold"));
});

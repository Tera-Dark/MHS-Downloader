importScripts('core-policy.js');
const HOME = chrome.runtime.getURL('manager.html');
let launchBusy = false;
let opening = null;
async function managerTab() {
  const { managerTab: id } = await chrome.storage.session.get('managerTab');
  if (Number.isInteger(id)) {
    try {
      const tab = await chrome.tabs.get(id);
      let response;
      try {
        response = await chrome.runtime.sendMessage({ type: 'CONTROL_READY', target: id });
      } catch {}
      if (response?.present || tab.status === 'loading') return tab;
      await chrome.storage.session.remove('managerTab');
    } catch {
      await chrome.storage.session.remove('managerTab');
    }
  }
  return null;
}
async function openManager(focus = true) {
  if (!opening)
    opening = (async () => {
      let tab = await managerTab();
      if (!tab) {
        tab = await chrome.tabs.create({ url: HOME, active: false });
        await chrome.storage.session.set({ managerTab: tab.id });
      }
      return tab;
    })();
  let tab;
  try {
    tab = await opening;
  } finally {
    opening = null;
  }
  if (focus) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return tab;
}
chrome.action.onClicked.addListener(() => openManager().catch(console.error));
chrome.tabs.onRemoved.addListener((id) => {
  chrome.storage.session
    .get('managerTab')
    .then((data) => {
      if (data.managerTab === id) return chrome.storage.session.remove('managerTab');
    })
    .catch(console.error);
  chrome.storage.local
    .get('runView')
    .then(({ runView }) => {
      if (runView?.owner === id)
        return chrome.storage.local.set({ runView: { ...runView, busy: false, phase: 'closed' } });
    })
    .catch(console.error);
});
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!['ADD_PAGE', 'OPEN_MANAGER', 'START_PROFILE', 'STOP_RUN'].includes(msg?.type)) return;
  (async () => {
    const u = new URL(sender.tab?.url || '');
    if (
      sender.id !== chrome.runtime.id ||
      u.protocol !== 'https:' ||
      u.hostname !== 'www.mihuashi.com' ||
      !/^\/(artworks\/\d+|users\/[^/]+|profiles\/\d+)\/?$/.test(u.pathname)
    )
      throw Error('请在官网主页或作品页操作');
    if (msg.type === 'OPEN_MANAGER') {
      await openManager();
      return { ok: true };
    }
    if (msg.type === 'STOP_RUN') {
      const tab = await managerTab();
      if (!tab) throw Error('工作台已关闭，没有运行中的任务');
      return chrome.runtime.sendMessage({ type: 'CONTROL_STOP', target: tab.id });
    }
    if (msg.type === 'START_PROFILE') {
      if (!/^\/(users\/[^/]+|profiles\/\d+)\/?$/.test(u.pathname))
        throw Error('请在画师主页启动批量收集');
      if ((await chrome.storage.local.get('accessHold')).accessHold)
        throw Error('访问保护暂停中，请打开工作台检查并解除暂停');
      if (msg.consent !== true) throw Error('请先确认作品获取及使用许可');
      if (launchBusy) throw Error('任务正在启动，请稍等');
      launchBusy = true;
      try {
        const tab = await openManager(false);
        let ready = false;
        for (let i = 0; i < 50; i++) {
          try {
            ready = (await chrome.runtime.sendMessage({ type: 'CONTROL_READY', target: tab.id }))
              ?.ready;
          } catch {}
          if (ready) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!ready) throw Error('工作台未就绪，请打开工作台检查；没有启动采集');
        return await chrome.runtime.sendMessage({
          type: 'CONTROL_START',
          target: tab.id,
          profile: u.origin + u.pathname,
          download: msg.download === true,
          links: msg.links === true && msg.download !== true,
        });
      } finally {
        launchBusy = false;
      }
    }
    const { inboxV2 = [] } = await chrome.storage.local.get('inboxV2');
    const value = {
      url: u.origin + u.pathname,
      kind: u.pathname.startsWith('/artworks/') ? 'artwork' : 'profile',
    };
    if (!inboxV2.some((x) => x.url === value.url)) inboxV2.push(value);
    await chrome.storage.local.set({ inboxV2 });
    await openManager();
    return { ok: true };
  })()
    .then((result) => reply(result || { ok: true }))
    .catch((e) => reply({ error: e.message }));
  return true;
});
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || ![401, 403, 429].includes(d.statusCode)) return;
    chrome.storage.session
      .get('monitoredTab')
      .then(({ monitoredTab }) => {
        if (monitoredTab !== d.tabId) return;
        const u = new URL(d.url);
        const header = d.responseHeaders?.find(
          (h) => h.name.toLowerCase() === 'retry-after',
        )?.value;
        const hold = {
          code: String(d.statusCode),
          at: Date.now(),
          until: d.statusCode === 429 ? ArchivePolicy.retryUntil(header) : 0,
        };
        // A quota failure in persistent storage must never prevent the immediate stop signal.
        const stopWrite = chrome.storage.session.set({
          stopSignal: {
            at: Date.now(),
            tabId: d.tabId,
            status: d.statusCode,
            url: u.origin + u.pathname,
            message: `任务页返回 HTTP ${d.statusCode}；停止本轮，不自动重试。`,
          },
        });
        const holdWrite = chrome.storage.local.get('accessHold').then((data) => {
          hold.until = Math.max(hold.until, data.accessHold?.until || 0);
          return chrome.storage.local.set({ accessHold: hold });
        });
        return Promise.all([stopWrite, holdWrite]);
      })
      .catch(console.error);
  },
  { urls: ['https://www.mihuashi.com/*', 'https://image-assets.mihuashi.com/*'] },
  ['responseHeaders'],
);

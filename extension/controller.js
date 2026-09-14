globalThis.ArchiveController = function (ctx) {
  ctx.$('add').onclick = () =>
    ctx.api.addText(ctx.$('urls').value).catch((e) => ctx.api.log(e.message, true));
  ctx.$('scan').onclick = () => ctx.api.scanAndMaybeDownload(false);
  ctx.$('scanRun').onclick = () => ctx.api.scanAndMaybeDownload(true);
  ctx.$('start').onclick = () => ctx.api.operate(ctx.api.downloadQueue);
  ctx.$('pause').onclick = () => {
    ctx.run.stop = true;
    ctx.api.abortFetches();
    ctx.api.status('正在停止调度。已验证图片将保留在本地暂存，可手动保存。');
  };
  ctx.$('saveBuffer').onclick = () =>
    ctx.api.operate(async () => {
      await ctx.api.flushPack();
      ctx.api.status('缓冲 ZIP 已保存');
    }, true);
  ctx.$('discardBuffer').onclick = async () => {
    if (!confirm('永久删除本地暂存中尚未保存的图片？已保存文件不受影响。')) return;
    if (ctx.api.uncertainDownloads()) {
      ctx.api.status('请先核对未确认下载');
      return;
    }
    ctx.transfer.pack = new ZipVolume();
    ctx.transfer.packRecords = [];
    for (const t of ctx.state.tasks) {
      t.files = t.files.filter((f) => f.status !== 'staged');
      if (t.status === 'staged') {
        t.status = 'queued';
        t.error = '';
      }
    }
    await ctx.api.persist();
    await ctx.api.collectStaging();
    ctx.api.render();
  };
  ctx.$('resolveDownloads').onclick = () =>
    ctx.api.resolveDownloads().catch((e) => ctx.ui?.showError(e));
  ctx.$('export').onclick = () => ctx.api.exportState().catch((e) => ctx.api.log(e.message, true));
  ctx.$('importButton').onclick = () => ctx.$('importFile').click();
  ctx.$('importFile').onchange = async () => {
    try {
      if (ctx.$('importFile').files[0]) await ctx.api.importFile(ctx.$('importFile').files[0]);
    } catch (e) {
      ctx.api.log(e.message, true);
    }
    ctx.$('importFile').value = '';
  };
  ctx.$('refreshTabs').onclick = ctx.api.refreshTabs;
  ctx.$('useTab').onclick = async () => {
    try {
      const selected = ctx.$('siteTabs').value;
      if (!/^\d+$/.test(selected))
        throw Error('请先从下拉框选择已打开的官网页面，再点“使用所选页面”');
      let t;
      try {
        t = await chrome.tabs.get(Number(selected));
      } catch {
        await ctx.api.refreshTabs();
        throw Error('所选网页已关闭或失效。请刷新页面列表后重新选择');
      }
      const p = ArchivePolicy.siteURL(t.url, 'profile');
      if (p) {
        ctx.$('profile').value = p;
        ctx.$('quickInput').value = p;
        ctx.ui?.quickHint();
        await ctx.api.persist();
      } else if (ArchivePolicy.siteURL(t.url)) await ctx.api.addText(t.url);
      else throw Error('请选择画师主页或作品详情页');
    } catch (e) {
      ctx.api.log(e.message, true);
      ctx.ui?.showError(e);
    }
  };
  ctx.$('resetErrors').onclick = async () => {
    if (ctx.transfer.packRecords.length || ctx.api.uncertainDownloads()) {
      ctx.api.log('请先保存或丢弃 ZIP 缓冲', true);
      return;
    }
    if (!confirm('确认已检查官网访问状态？此操作不会立即发起请求。')) return;
    for (const t of ctx.state.tasks)
      if (t.status !== 'done') {
        t.status = 'queued';
        t.error = '';
        t.candidates = [];
        t.observedAt = null;
        t.files = t.files.filter((f) => f.status === 'complete');
      }
    await ctx.api.persist();
    ctx.api.render();
  };
  ctx.$('clear').onclick = async () => {
    if (ctx.transfer.packRecords.length || ctx.api.uncertainDownloads()) {
      ctx.api.log('请先保存或丢弃 ZIP 缓冲', true);
      return;
    }
    if (confirm('先导出记录。清空会丢失去重依据，但不删除已下载文件。')) {
      ctx.state.tasks = [];
      ctx.state.scans = [];
      ctx.state.archives = [];
      ctx.$('preview').replaceChildren();
      await ctx.api.persist();
      ctx.api.render();
    }
  };
  ctx.$('clearLog').onclick = () => {
    ctx.state.logs = [];
    ctx.api.renderLogs();
    ctx.api.persist();
  };
  ctx.$('help').onclick = () =>
    chrome.tabs.create({
      url: chrome.runtime.getURL('help.html'),
    });
  for (const k of ctx.configKeys) ctx.$(k).onchange = () => ctx.api.persist();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.accessHold) {
      ctx.run.accessHold = changes.accessHold.newValue || null;
      ctx.api.renderAccess();
    }
    if (area === 'local' && (changes.inboxV2 || changes.inbox)) ctx.api.consumeInbox();
    if (area === 'session' && changes.stopSignal?.newValue && ctx.run.busy) {
      const e = Error(changes.stopSignal.newValue.message);
      ctx.run.fatal = e;
      ctx.api.abortFetches();
      ctx.api.status(e.message);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (ctx.run.busy || ctx.run.storageFault) {
      e.preventDefault();
      e.returnValue = '工作台关闭会停止任务；仅已提交本地数据库的图片可恢复';
    }
  });
  (async () => {
    await navigator.locks.request(
      'artwork-archive-workbench',
      {
        ifAvailable: true,
      },
      async (lock) => {
        if (!lock) {
          ctx.api.status('已有工作台正在使用，请从扩展图标打开现有工作台');
          window.close();
          return;
        }
        const self = await chrome.tabs.getCurrent();
        const { managerTab: existing } = await chrome.storage.session.get('managerTab');
        if (Number.isInteger(existing) && existing !== self?.id) {
          try {
            const response = await chrome.runtime.sendMessage({
              type: 'CONTROL_READY',
              target: existing,
            });
            if (response?.ready) {
              window.close();
              return;
            }
          } catch {}
        }
        ctx.run.managerTabId = self?.id ?? null;
        if (ctx.run.managerTabId !== null)
          await chrome.storage.session.set({
            managerTab: ctx.run.managerTabId,
          });
        const stored = await chrome.storage.local.get(['stateV2', 'tasks', 'settings', 'logs']);
        let legacy = stored.stateV2;
        if (!legacy && stored.tasks)
          legacy = {
            tasks: stored.tasks.map(ArchivePolicy.normalizeTask).filter(Boolean),
            logs: stored.logs || [],
            scans: [],
            archives: [],
            settings: {
              ...stored.settings,
              interval: 2,
              concurrency: 2,
              mode: 'zip',
              selection: 'all',
              maxWorks: 500,
              volumeMB: 128,
            },
          };
        ctx.state = await ctx.store.load(legacy);
        await ctx.store.clearInputs();
        ctx.run.stateLoaded = true;
        ctx.state.tasks = ctx.state.tasks || [];
        ctx.state.scans = ctx.state.scans || [];
        ctx.state.archives = ctx.state.archives || [];
        ctx.state.logs = ctx.state.logs || [];
        for (const t of ctx.state.tasks) t.files = t.files || [];
        for (const k of ctx.configKeys)
          if (ctx.state.settings?.[k] !== undefined) ctx.$(k).value = ctx.state.settings[k];
        await chrome.storage.session.remove(['monitoredTab', 'stopSignal']);
        await ctx.api.reconcile();
        ctx.state.ui = ctx.state.ui || {
          advanced: false,
          welcomeDismissed: false,
        };
        await ctx.api.persist();
        ctx.run.accessHold = (await chrome.storage.local.get('accessHold')).accessHold || null;
        ctx.run.initialized = true;
        if (ctx.transfer.packRecords.length)
          ctx.api.status(
            `已恢复 ${ctx.transfer.packRecords.length} 条本地图片暂存，可直接保存 ZIP；没有自动请求网站。`,
          );
        else if (ctx.state.recovery?.message)
          ctx.api.status('上轮任务已中断；没有自动继续。请检查未完成任务后再操作。');
        ctx.api.render();
        ctx.api.renderLogs();
        await ctx.api.refreshTabs();
        await ctx.api.consumeInbox();
        await new Promise(() => {}); // Released by the browser when this document closes.
      },
    );
  })().catch((e) => {
    ctx.run.stateLoaded = false;
    ctx.$('rawBackupPanel').hidden = false;
    ctx.api.status('初始化失败：' + e.message);
    ctx.api.log(e.message, true);
    ctx.ui?.showError(e);
  });

  // Only the extension service worker can launch a confirmed background command.
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab || msg?.target !== ctx.run.managerTabId)
      return;
    if (msg.type === 'CONTROL_READY') {
      reply({
        ready: ctx.run.initialized,
        present: true,
      });
      return;
    }
    if (msg.type === 'CONTROL_STOP') {
      ctx.run.stop = true;
      ctx.api.abortFetches();
      ctx.api.status('已收到停止请求，正在收尾');
      reply({
        ok: true,
      });
      return;
    }
    if (msg.type !== 'CONTROL_START') return;
    if (
      !ctx.run.initialized ||
      ctx.run.busy ||
      ctx.run.remoteStarting ||
      ctx.run.operationStarting
    ) {
      reply({
        error: '工作台正在处理任务，请先等待或停止本轮',
      });
      return;
    }
    if (ctx.transfer.packRecords.length || ctx.api.uncertainDownloads()) {
      reply({
        error: '工作台有未保存的 ZIP 缓冲，请先打开工作台处理',
      });
      return;
    }
    const profile = ArchivePolicy.siteURL(msg.profile, 'profile');
    if (!profile) {
      reply({
        error: '主页地址无效',
      });
      return;
    }
    ctx.run.remoteStarting = true;
    ctx.$('authorized').checked = true;
    ctx.$('profile').value = profile;
    ctx.$('quickInput').value = profile;
    ctx.$('artist').value = '';
    if (msg.download === true) ctx.$('mode').value = 'zip';
    ctx.ui?.quickHint();
    reply({
      ok: true,
      limit: ctx.api.config().maxWorks,
      interval: ctx.api.config().interval,
    });
    ctx.api.scanAndMaybeDownload(msg.download === true, true, msg.links === true).finally(() => {
      ctx.run.remoteStarting = false;
      ctx.$('authorized').checked = false;
      ctx.api.render();
    });
  });
  ctx.$('exportLinks').onclick = async () => {
    if (!ctx.run.initialized || ctx.run.busy) return;
    const links = ArchiveUI.imageLinks(ctx.state.tasks);
    if (!links.length) {
      ctx.api.status(
        '还没有详情图直链。收集主页得到的是作品页面链接，请先预览或下载作品以解析图片。',
      );
      return;
    }
    const blob = new Blob([links.join('\n') + '\n'], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url,
        filename: ctx.api.config().folder + '/image-links-' + Date.now() + '.txt',
        saveAs: false,
      });
      ctx.api.status(
        `已导出 ${links.length} 条已解析图片直链；未解析作品不包含在内。链接可能过期或限制外部下载。`,
      );
    } catch (e) {
      ctx.ui?.showError(e);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  };
  ctx.$('prepareLinks').onclick = () => ctx.api.operate(() => ctx.api.prepareImageLinks());
  ctx.$('ackAccess').onclick = async () => {
    const current = (await chrome.storage.local.get('accessHold')).accessHold;
    if (ctx.run.busy || current?.until > Date.now()) return;
    if (!confirm('确认已在官网检查访问状态？解除后仍需手动开始，不会自动重试。')) return;
    await chrome.storage.local.remove('accessHold');
    ctx.run.accessHold = null;
    ctx.api.renderAccess();
    ctx.api.status('已解除保护暂停。失败任务请检查后重置，再手动开始。');
  };
  setInterval(ctx.api.renderAccess, 1000);
  ctx.$('rawBackup').onclick = async () => {
    try {
      const data = await ctx.store.rawBackup();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], {
          type: 'application/json',
        }),
      );
      try {
        await chrome.downloads.download({
          url,
          filename: 'Archive_recovery_' + Date.now() + '.json',
          saveAs: false,
        });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch (e) {
      ctx.api.status('恢复副本保存失败：' + e.message);
    }
  };
};

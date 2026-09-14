// Explicit context-injected service; no mutable workbench globals.
globalThis.ArchiveServices ||= {};
ArchiveServices['run-service'] = function (ctx) {
  function persist(extra = null) {
    if (!ctx.run.stateLoaded) return Promise.resolve();
    const settings = ctx.api.config();
    if (JSON.stringify(settings) !== JSON.stringify(ctx.state.settings))
      ctx.state.settings = settings;
    ctx.run.saveChain = ctx.store.commit(extra);
    return ctx.run.saveChain
      .then(() => {
        ctx.run.storageFault = false;
        ctx.$('storageWarning').hidden = true;
      })
      .catch((e) => {
        ctx.run.storageFault = true;
        ctx.$('storageWarning').hidden = false;
        ctx.$('storageWarning').textContent =
          '本地记录保存失败，当前修改可能只在内存中。请先导出备份，清理空间后再操作；不要直接关闭工作台。';
        throw e;
      });
  }
  async function holdAccess(code, retryAfter) {
    const hold = {
      code,
      at: Date.now(),
      until: code === '429' ? ArchivePolicy.retryUntil(retryAfter) : 0,
    };
    const data = await chrome.storage.local.get('accessHold');
    if (data.accessHold?.until > hold.until) hold.until = data.accessHold.until;
    ctx.run.accessHold = hold;
    await chrome.storage.local.set({
      accessHold: hold,
    });
    ctx.api.renderAccess();
  }
  function log(message, error = false) {
    ctx.state.logs.push({
      at: new Date().toISOString(),
      message,
      error,
    });
    ctx.state.logs = ctx.state.logs.slice(-160);
    ctx.api.renderLogs();
    persist().catch(console.error);
  }
  function abortFetches() {
    for (const c of ctx.transfer.controllers) c.abort();
  }
  async function guard() {
    ctx.lifecycle.check();
    if (ctx.run.stop) throw ctx.run.fatal || new ctx.Paused();
    if (ctx.run.fatal) throw ctx.run.fatal;
    const { monitoredTab, stopSignal } = await chrome.storage.session.get([
      'monitoredTab',
      'stopSignal',
    ]);
    if (stopSignal && stopSignal.tabId === monitoredTab)
      throw Error(stopSignal.message + ' ' + stopSignal.url);
  }
  async function sleep(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await guard();
      await ctx.delay(Math.max(0, Math.min(200, until - Date.now())));
    }
  }
  async function begin(allowBuffer = false) {
    if (!ctx.run.initialized) throw Error('工作台正在加载记录，请稍等');
    if (!ctx.$('authorized').checked && !allowBuffer) throw Error('请先确认作品获取与使用许可');
    if (ctx.transfer.packRecords.length && !allowBuffer)
      throw Error('有未保存的 ZIP 缓冲，请先保存或丢弃');
    if (ctx.run.storageFault && !allowBuffer)
      throw Error('本地记录未保存，请先导出备份并处理存储空间');
    ctx.run.accessHold = (await chrome.storage.local.get('accessHold')).accessHold || null;
    if (ctx.run.accessHold && !allowBuffer) {
      ctx.api.renderAccess();
      throw Error('访问保护暂停中，请先在工作台解除暂停');
    }
    if (ctx.api.uncertainDownloads()) throw Error('请先核对未确认下载，避免重复保存');
    await ctx.store.clearInputs();
    if (ctx.run.stop) throw new ctx.Paused();
    ctx.lifecycle.start();
    ctx.state.recovery = null;
    ctx.run.busy = true;
    ctx.run.runPhase = 'working';
    ctx.run.fatal = null;
    ctx.run.C = ctx.api.config();
    ctx.run.runStamp = new Date()
      .toISOString()
      .replace(/[-:.]/g, '')
      .replace('T', '_')
      .slice(0, 15);
    ctx.transfer.volumeNo = 0;
    await chrome.storage.session.remove(['monitoredTab', 'stopSignal']);
    ctx.transfer.hashIndex = new Map();
    ctx.transfer.urlIndex = new Map();
    for (const t of ctx.state.tasks)
      for (const f of t.files)
        if (f.status === 'complete') {
          if (f.sha256) ctx.transfer.hashIndex.set(f.sha256, f);
          ctx.transfer.urlIndex.set(f.image_url, f);
        }
    ctx.api.render();
  }
  async function operate(fn, allowBuffer = false) {
    if (ctx.run.busy || ctx.run.operationStarting) return;
    ctx.run.stop = false;
    ctx.run.operationStarting = true;
    ctx.api.render();
    try {
      await begin(allowBuffer);
      await fn();
    } catch (e) {
      ctx.api.status(e.message);
      log(e.message, true);
      ctx.ui?.showError(e);
      ctx.run.fatal = e;
      ctx.run.runPhase = 'error';
      abortFetches();
    } finally {
      if (ctx.run.busy) {
        await Promise.allSettled([...ctx.transfer.jobs]);
        await ctx.transfer.packLock.catch(() => {});
        ctx.lifecycle.finish();
        ctx.run.busy = false;
        ctx.run.runPhase = ctx.run.stop
          ? 'paused'
          : ctx.run.fatal
            ? 'error'
            : ctx.run.runPhase === 'partial'
              ? 'partial'
              : 'complete';
        await chrome.storage.session.remove('monitoredTab');
        try {
          await persist();
        } catch (e) {
          ctx.ui?.showError(e);
        }
        ctx.api.render();
        if (!ctx.run.storageFault) {
          try {
            await ctx.api.consumeInbox();
          } catch (e) {
            ctx.ui?.showError(e);
          }
        }
      }
      ctx.lifecycle.finish();
      ctx.run.operationStarting = false;
      ctx.api.render();
    }
  }
  return { persist, holdAccess, log, abortFetches, guard, sleep, begin, operate };
};

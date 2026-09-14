// Explicit context-injected service; no mutable workbench globals.
globalThis.ArchiveServices ||= {};
ArchiveServices['view-service'] = function (ctx) {
  let lastPublished = '';
  let rendering = false;
  function config() {
    return {
      profile: ctx.$('profile').value.trim(),
      artist: ctx.$('artist').value.trim(),
      mode: ctx.$('mode').value,
      selection: ctx.$('selection').value,
      interval: Math.max(1, Math.min(120, Number(ctx.$('interval').value) || 2)),
      concurrency: Math.max(1, Math.min(3, Number(ctx.$('concurrency').value) || 2)),
      maxWorks: Math.max(1, Math.min(1000, Number(ctx.$('maxWorks').value) || 500)),
      volumeMB: Math.max(64, Math.min(256, Number(ctx.$('volumeMB').value) || 128)),
      folder: ctx.api.safeName(ctx.$('folder').value || '画页存档'),
      note: ctx.$('note').value.trim(),
    };
  }
  function renderAccess() {
    ctx.$('accessPanel').hidden = !ctx.run.accessHold;
    if (!ctx.run.accessHold) return;
    const seconds = Math.max(0, Math.ceil((ctx.run.accessHold.until - Date.now()) / 1000));
    ctx.$('accessText').textContent =
      `网站访问已暂停（${ctx.run.accessHold.code}）。` +
      (seconds
        ? `至少还需等待 ${seconds} 秒，再到官网检查。`
        : '请先在官网检查，再明确解除暂停；不会自动继续请求。');
    ctx.$('ackAccess').disabled = ctx.run.busy || ctx.run.operationStarting || seconds > 0;
  }
  function status(message) {
    ctx.$('statusText').textContent = message;
  }
  function renderLogs() {
    ctx.$('logCount').textContent = `（${ctx.state.logs.length} 条）`;
    ctx.$('logs').replaceChildren();
    for (const x of ctx.state.logs.slice().reverse()) {
      const e = document.createElement('div');
      e.className = 'log' + (x.error ? ' error' : '');
      const t = document.createElement('time');
      t.textContent = new Date(x.at).toLocaleTimeString();
      e.append(t, document.createTextNode(x.message));
      ctx.$('logs').append(e);
    }
  }
  function publishRunView() {
    if (!ctx.run.initialized || ctx.run.managerTabId === null) return;
    const scan = ctx.state.scans.at(-1);
    const view = {
      owner: ctx.run.managerTabId,
      busy: ctx.run.busy || ctx.run.operationStarting,
      phase: ctx.run.runPhase,
      collected: scan?.found?.length || 0,
      total: scan?.expected ?? null,
      completed: ctx.state.tasks.filter((t) => t.status === 'done').length,
    };
    const signature = JSON.stringify(view);
    if (signature === lastPublished) return;
    lastPublished = signature;
    ctx.run.viewChain = ctx.run.viewChain
      .catch(() => {})
      .then(() =>
        chrome.storage.local.set({
          runView: view,
        }),
      )
      .catch(() => {});
  }
  function render() {
    if (rendering) return;
    rendering = true;
    queueMicrotask(() => {
      rendering = false;
      renderNow();
    });
  }
  function renderNow() {
    publishRunView();
    renderAccess();
    ctx.$('recoveryWarning').hidden = !ctx.api.uncertainDownloads();
    ctx.$('resolveDownloads').disabled = ctx.run.busy || ctx.run.operationStarting;
    ctx.$('stateLabel').textContent = !ctx.run.initialized
      ? '正在加载记录'
      : ctx.run.busy
        ? '正在处理'
        : ctx.run.operationStarting
          ? '正在准备'
          : {
              complete: '本轮已完成',
              partial: '部分结果待确认',
              error: '已停止，请检查',
              paused: '已暂停',
            }[ctx.run.runPhase] || '待操作';
    ctx
      .$('countDone')
      .replaceChildren(
        document.createTextNode(ctx.state.tasks.filter((t) => t.status === 'done').length + ' '),
      );
    const n = document.createElement('small');
    n.textContent = '/ ' + ctx.state.tasks.length;
    ctx.$('countDone').append(n);
    ctx.$('queueCount').textContent = ctx.state.tasks.length + ' 件作品';
    for (const id of [
      'start',
      'scan',
      'scanRun',
      'add',
      'useTab',
      'importButton',
      'resetErrors',
      'clear',
      'authorized',
      ...ctx.configKeys,
    ])
      ctx.$(id).disabled = ctx.run.busy || ctx.run.operationStarting || !ctx.run.initialized;
    ctx.$('pause').disabled = !(ctx.run.busy || ctx.run.operationStarting);
    document
      .querySelectorAll('.save-image')
      .forEach((b) => (b.disabled = ctx.run.busy || ctx.run.operationStarting));
    ctx.$('saveBuffer').disabled =
      ctx.run.busy || ctx.run.operationStarting || !ctx.transfer.packRecords.length;
    ctx.$('discardBuffer').disabled =
      ctx.run.busy || ctx.run.operationStarting || !ctx.transfer.packRecords.length;
    ctx.$('memoryHint').textContent =
      `本地图片暂存（关闭后可恢复）：${(ctx.transfer.pack.bytes / 1048576).toFixed(1)} MB · ${ctx.transfer.packRecords.length} 条来源`;
    ctx.$('queueHint').textContent =
      `下载任务 ${ctx.transfer.jobs.size} · ${ctx.state.tasks.filter((t) => t.status === 'queued' || t.status === 'ready').length} 件待处理`;
    ctx.ui?.onRender();
    if (ctx.run.accessHold)
      for (const id of ['start', 'scan', 'scanRun', 'prepareLinks', 'quickAction'])
        ctx.$(id).disabled = true;
  }
  function previewImages(t) {
    ctx.$('preview').replaceChildren();
    ctx.$('previewHint').textContent =
      `作品 ${t.id} · ${t.candidates?.length || 0} 张候选。人工核对是否有误选；预览会加载网站图片。`;
    for (const [i, img] of (t.candidates || []).entries()) {
      const card = document.createElement('div');
      card.className = 'image-card';
      const image = document.createElement('img');
      image.src = img.url;
      image.loading = 'lazy';
      image.alt = '详情候选 ' + (i + 1);
      const area = document.createElement('div');
      const text = document.createElement('p');
      text.textContent = `${img.width} × ${img.height} · 详情展示图`;
      const b = document.createElement('button');
      b.className = 'save-image wide';
      b.textContent = '只保存这一张';
      b.disabled = ctx.run.busy || ctx.run.operationStarting;
      b.onclick = () =>
        ctx.api.operate(async () => {
          t.expected = [img.url];
          await ctx.api.saveTask(t, [img]);
          await ctx.api.flushPack();
        });
      area.append(text, b);
      card.append(image, area);
      ctx.$('preview').append(card);
    }
    if (document.visibilityState === 'visible')
      ctx.$('preview').closest('section')?.scrollIntoView({
        block: 'start',
      });
  }
  async function refreshTabs() {
    const old = ctx.$('siteTabs').value;
    const tabs = await chrome.tabs.query({
      url: 'https://www.mihuashi.com/*',
    });
    ctx.$('siteTabs').replaceChildren(new Option('选择已打开的官网页面', ''));
    for (const t of tabs)
      if (ArchivePolicy.siteURL(t.url, 'profile') || ArchivePolicy.siteURL(t.url))
        ctx.$('siteTabs').add(new Option((t.title || t.url).slice(0, 70), String(t.id)));
    ctx.$('siteTabs').value = old;
  }
  return {
    config,
    renderAccess,
    status,
    renderLogs,
    publishRunView,
    render,
    previewImages,
    refreshTabs,
  };
};

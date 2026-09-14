// Explicit context-injected service; no mutable workbench globals.
globalThis.ArchiveServices ||= {};
ArchiveServices['task-service'] = function (ctx) {
  function safeName(s) {
    let n =
      String(s)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .slice(0, 70)
        .replace(/[. ]+$/g, '') || '未命名';
    return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(n) ? '_' + n : n;
  }
  function taskDone(t) {
    return (
      t.expected?.length > 0 &&
      t.expected.every((u) => t.files.some((f) => f.image_url === u && f.status === 'complete'))
    );
  }
  function refreshTask(t) {
    if (taskDone(t)) {
      t.status = 'done';
      t.error = '';
    } else if (t.files.some((f) => f.status === 'staged') && !t.error) t.status = 'staged';
  }
  function addTask(url, extra = {}) {
    url = ArchivePolicy.siteURL(url);
    if (!url) return null;
    let t = ctx.store.findTask(url);
    if (t) return t;
    if (ctx.state.tasks.length >= 5000) throw Error('本地任务已达 5000 条，请先导出整理');
    t = {
      id: url.split('/').pop(),
      url,
      artist: extra.artist || ctx.api.config().artist,
      profile: extra.profile || null,
      status: 'queued',
      files: [],
      createdAt: new Date().toISOString(),
    };
    ctx.state.tasks.push(t);
    return ctx.state.tasks.at(-1);
  }
  async function addText(text) {
    const before = ctx.state.tasks.length;
    for (const raw of String(text).match(/https:\/\/www\.mihuashi\.com\/artworks\/\d+/g) || [])
      addTask(raw);
    ctx.api.log(`新增 ${ctx.state.tasks.length - before} 件作品；重复详情链接已跳过。`);
    await ctx.api.persist();
    ctx.api.render();
  }
  async function readTask(t) {
    if (ArchivePolicy.reusable(t)) {
      ctx.api.log('复用刚解析的详情候选：' + t.id);
      return t.candidates;
    }
    t.status = 'reading';
    t.error = '';
    ctx.api.render();
    await ctx.api.persist();
    ctx.api.status('读取作品 ' + t.id);
    const id = await ctx.api.tabFor(t.url);
    const r = await ctx.api.waitLoaded(id, t.url);
    t.candidates = r.images;
    t.pageTitle = r.title;
    t.observedAt = new Date().toISOString();
    t.status = 'ready';
    await ctx.api.persist();
    ctx.api.render();
    return r.images;
  }
  async function previewOne(t) {
    await ctx.api.operate(async () => {
      try {
        await readTask(t);
        ctx.api.previewImages(t);
        ctx.api.log('预览已就绪：' + t.id);
        ctx.api.status('请核对图片与尺寸，再保存。');
      } catch (e) {
        t.status = 'error';
        t.error = e.message;
        throw e;
      }
    });
  }
  async function prepareImageLinks(scope = null) {
    ctx.run.runPhase = 'links';
    const tasks = ctx.state.tasks
      .filter(
        (t) =>
          ['queued', 'ready'].includes(t.status) &&
          (scope ? scope.has(t.url) : !ctx.ui?.selection.size || ctx.ui.selection.has(t.id)),
      )
      .slice(0, ctx.run.C.maxWorks);
    if (!tasks.length) throw Error('没有待解析作品；失败项请检查后手动重置');
    for (const t of tasks) {
      await ctx.api.guard();
      try {
        if (!t.candidates?.length) await readTask(t);
      } catch (e) {
        t.status = 'error';
        t.error = e.message;
        await ctx.api.persist();
        ctx.api.render();
        throw e;
      }
    }
    ctx.api.status(
      `已解析 ${tasks.length} 件作品的图片地址；没有保存图片文件。请展开直链下载工具，导出已解析直链 TXT。`,
    );
    ctx.api.log('本轮图片直链解析完成；未提交图片文件下载');
  }
  async function importFile(file) {
    if (file.size > 10 * 1024 * 1024) throw Error('导入文件请小于 10 MB');
    const text = await file.text();
    if (!file.name.toLowerCase().endsWith('.json')) return addText(text);
    const value = JSON.parse(text);
    const tasks = value?.tasks || value?.state?.tasks;
    if (!Array.isArray(tasks)) throw Error('JSON 需要含 tasks 数组（支持旧版来源清单）');
    if (!confirm('导入会恢复成功记录并据此跳过图片；工具无法确认旧文件仍在电脑中。继续吗？'))
      return;
    if (tasks.length > 5000) throw Error('导入超过 5000 件，请先拆分备份');
    const imported = tasks.map((raw) => ArchivePolicy.normalizeTask(raw)).filter(Boolean);
    const newURLs = new Set(imported.filter((t) => !ctx.store.findTask(t.url)).map((t) => t.url));
    if (ctx.state.tasks.length + newURLs.size > 5000)
      throw Error('合并后超过 5000 件，请先导出整理');
    let count = 0;
    for (const t of imported) {
      const current = ctx.store.findTask(t.url);
      if (current) {
        for (const f of t.files)
          if (!current.files.some((x) => x.image_url === f.image_url && x.status === 'complete'))
            current.files.push(f);
        if (t.candidates.length && !current.candidates?.length) {
          current.candidates = t.candidates;
          current.observedAt = t.observedAt;
          if (current.status === 'queued') current.status = 'ready';
        }
        refreshTask(current);
      } else {
        ctx.state.tasks.push(t);
        count++;
      }
    }
    ctx.api.log(
      `导入 ${count} 件新任务；已合并成功记录，跳过 ${tasks.length - imported.length} 条无效记录`,
    );
    await ctx.api.persist();
    ctx.api.render();
  }
  async function exportState() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            tool: '画页存档',
            version: ctx.version,
            exported_at: new Date().toISOString(),
            terminology: 'detail_display is not a verified original source',
            ...ctx.state,
          },
          null,
          2,
        ),
      ],
      {
        type: 'application/json',
      },
    );
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url,
        filename: `${ctx.api.config().folder}/Archive_tasks_${Date.now()}.json`,
        saveAs: false,
        conflictAction: 'uniquify',
      });
      ctx.api.log('已导出任务和来源；扫描失败原因也包含在清单中');
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }
  async function consumeInbox() {
    if (!ctx.run.initialized || ctx.run.busy || ctx.run.inboxBusy) return;
    ctx.run.inboxBusy = true;
    try {
      const { inboxV2 = [], inbox = [] } = await chrome.storage.local.get(['inboxV2', 'inbox']);
      for (const x of inboxV2) {
        if (x.kind === 'profile') {
          ctx.$('profile').value = x.url;
          ctx.$('quickInput').value = x.url;
        } else addTask(x.url);
      }
      for (const u of inbox) addTask(u);
      if (inboxV2.length || inbox.length) {
        await chrome.storage.local.set({
          inboxV2: [],
          inbox: [],
        });
        await ctx.api.persist();
        ctx.api.render();
      }
    } finally {
      ctx.run.inboxBusy = false;
      ctx.ui?.quickHint();
    }
  }
  return {
    safeName,
    taskDone,
    refreshTask,
    addTask,
    addText,
    readTask,
    previewOne,
    prepareImageLinks,
    importFile,
    exportState,
    consumeInbox,
  };
};

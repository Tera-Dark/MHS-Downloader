globalThis.ArchiveWorkbenchUI = function (ctx) {
  const ui = ArchiveUI;
  let filter = 'all',
    query = '',
    page = 0,
    pageSize = 25,
    visible = [],
    started = 0,
    wasBusy = false,
    toastTimer;
  const selection = new Set();
  function toast(message) {
    ctx.$('toast').textContent = message;
    ctx.$('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (ctx.$('toast').hidden = true), 4200);
  }
  function quickHint() {
    const parsed = ui.parseInput(ctx.$('quickInput').value);
    ctx.$('inputHint').textContent =
      parsed.profiles.length > 1
        ? '发现多个画师主页，请一次处理一个主页。'
        : parsed.profiles.length
          ? `已识别画师主页${parsed.artworks.length ? '，并附有 ' + parsed.artworks.length + ' 条作品链接' : ''}。`
          : parsed.artworks.length
            ? `已识别 ${parsed.artworks.length} 条作品链接。`
            : '粘贴主页、作品链接或分享文字。Ctrl / ⌘ + Enter 开始收集。';
    ctx.$('quickAction').textContent = parsed.profiles.length
      ? '收集这个主页的作品'
      : parsed.artworks.length
        ? '将作品加入队列'
        : '识别并收集作品';
  }
  function showError(error) {
    const text = String(error?.message || error || '');
    const info = ui.classifyError(text);
    ctx.$('errorPanel').hidden = false;
    ctx.$('errorPanel').dataset.code = info.code;
    ctx.$('errorTitle').textContent = info.title;
    ctx.$('errorAdvice').textContent = info.advice;
    ctx.$('errorDetail').textContent = text;
    if (info.code === 'CONSENT') {
      ctx.$('authorized').scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      });
      ctx.$('authorized').focus();
    } else
      ctx.$('errorPanel').scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
  }
  function setAdvanced(value) {
    if (!ctx.run.initialized) return;
    ctx.state.ui = ctx.state.ui || {};
    ctx.state.ui.advanced = !!value;
    document.body.dataset.view = value ? 'advanced' : 'simple';
    ctx.$('advancedToggle').textContent = value ? '收起高级设置' : '显示高级设置';
    ctx.$('advancedToggle').setAttribute('aria-expanded', String(!!value));
    ctx.api.persist().catch(showError);
  }
  function updatePreset() {
    const c = ctx.api.config();
    ctx.$('preset').value = ui.presetFor(c);
    ctx.$('presetHint').textContent =
      `每次打开页面至少间隔 ${c.interval} 秒 · 最多 ${c.concurrency} 个下载任务 · ZIP 每 ${c.volumeMB} MB 左右分卷。`;
    ctx.$('preset').disabled = ctx.run.busy || ctx.run.operationStarting || !ctx.run.initialized;
  }
  function applyPreset(name) {
    if (ctx.run.busy || ctx.run.operationStarting) return;
    const p = ui.PRESETS[name];
    if (!p) {
      setAdvanced(true);
      return;
    }
    for (const key of ['interval', 'concurrency', 'volumeMB']) ctx.$(key).value = p[key];
    updatePreset();
    ctx.api.persist().catch(showError);
    toast('已应用“' + p.label + '”；未修改作品范围和图片质量。');
  }
  async function quickAction() {
    if (ctx.run.busy || ctx.run.operationStarting || !ctx.run.initialized) return;
    const p = ui.parseInput(ctx.$('quickInput').value);
    if (!p.profiles.length && !p.artworks.length) {
      showError('没有识别到米画师主页或作品链接。请粘贴完整分享链接。');
      ctx.$('quickInput').focus();
      return;
    }
    if (p.profiles.length > 1) {
      showError('请一次整理一个画师主页；可以同时加入多条作品链接。');
      return;
    }
    if (!ctx.$('authorized').checked) {
      showError('请先确认本次作品获取与使用许可');
      return;
    }
    try {
      if (p.artworks.length) await ctx.api.addText(p.artworks.join('\n'));
      if (p.profiles.length) {
        ctx.$('profile').value = p.profiles[0];
        await ctx.api.persist();
        await ctx.api.scanAndMaybeDownload(ctx.$('autoDownload').checked);
      } else if (ctx.$('autoDownload').checked) {
        await ctx.api.operate(() => ctx.api.downloadQueue(new Set(p.artworks)));
      } else {
        ctx.api.status(`已加入或合并 ${p.artworks.length} 条作品链接。可先预览，再点击下载。`);
        toast('作品已加入队列');
      }
    } catch (e) {
      showError(e);
    }
  }
  let queueSignature = '';
  let filterRevision = -1,
    filteredCounts = {};
  function renderQueue() {
    const signature = JSON.stringify([
      ctx.store.taskRevision,
      ctx.run.busy || ctx.run.operationStarting,
      ctx.run.initialized,
      !!ctx.run.accessHold,
      filter,
      query,
      page,
      [...selection],
    ]);
    if (signature === queueSignature) return;
    queueSignature = signature;
    if (filterRevision !== ctx.store.taskRevision) {
      filterRevision = ctx.store.taskRevision;
      filteredCounts = Object.fromEntries(
        ['all', 'pending', 'done', 'attention'].map((k) => [
          k,
          ui.filterTasks(ctx.state.tasks, k).length,
        ]),
      );
    }
    const pending = (t) => ['queued', 'ready'].includes(t.status);
    for (const id of selection)
      if (!pending(ctx.store.findTask('https://www.mihuashi.com/artworks/' + id) || {}))
        selection.delete(id);
    const list = ui.filterTasks(ctx.state.tasks, filter, query),
      slice = ui.paginate(list, page, pageSize);
    page = slice.page;
    visible = slice.items;
    for (const b of document.querySelectorAll('[data-filter]')) {
      const names = {
        all: '全部',
        pending: '待处理',
        done: '已完成',
        attention: '需检查',
      };
      b.textContent = names[b.dataset.filter] + ' ' + filteredCounts[b.dataset.filter];
      b.setAttribute('aria-pressed', String(filter === b.dataset.filter));
    }
    ctx.$('selectionHint').textContent = selection.size
      ? `已选 ${selection.size} 件（可能包含其他页）`
      : '未选择：下载时处理所有待处理项';
    ctx.$('start').textContent = selection.size
      ? `下载所选 ${selection.size} 件`
      : '下载待处理作品';
    ctx.$('start').disabled =
      ctx.run.busy ||
      ctx.run.operationStarting ||
      !ctx.run.initialized ||
      !ctx.state.tasks.some((t) => pending(t) && (!selection.size || selection.has(t.id)));
    ctx.$('pageLabel').textContent = `${slice.page + 1} / ${slice.pages} 页 · ${slice.total} 件`;
    ctx.$('previousPage').disabled = page === 0;
    ctx.$('nextPage').disabled = page >= slice.pages - 1;
    ctx.$('selectPage').disabled =
      ctx.run.busy || ctx.run.operationStarting || !ctx.run.initialized || !visible.some(pending);
    ctx.$('clearSelection').disabled = ctx.run.busy || ctx.run.operationStarting || !selection.size;
    const root = ctx.$('queue');
    root.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = ctx.state.tasks.length
        ? '当前筛选下没有作品。试试清空搜索或切换“全部”。'
        : '队列还是空的。粘贴一个画师主页，就不用逐个复制作品链接。';
      if (!ctx.state.tasks.length) {
        const b = document.createElement('button');
        b.textContent = '去粘贴链接';
        b.onclick = () => ctx.$('quickInput').focus();
        empty.append(b);
      }
      root.append(empty);
    }
    for (const [i, t] of visible.entries()) {
      const row = document.createElement('div');
      row.className = 'task ' + t.status;
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'task-check';
      check.setAttribute('aria-label', '选择作品 ' + t.id);
      check.checked = selection.has(t.id);
      check.disabled = ctx.run.busy || ctx.run.operationStarting || !pending(t);
      check.onchange = () => {
        if (check.checked) selection.add(t.id);
        else selection.delete(t.id);
        renderQueue();
      };
      const number = document.createElement('span');
      number.className = 'number';
      number.textContent = String(page * pageSize + i + 1).padStart(2, '0');
      const main = document.createElement('div');
      main.className = 'task-main';
      const title = document.createElement('div');
      title.className = 'task-title';
      title.textContent = `作品 ${t.id} · ${ctx.labels[t.status] || t.status}`;
      const info = document.createElement('small');
      info.textContent = t.error
        ? ui.classifyError(t.error).title
        : `${t.artist || '画师名称未填写'} · 已保存 ${t.files.filter((f) => f.status === 'complete').length} 张`;
      main.append(title, info);
      const actions = document.createElement('div');
      actions.className = 'task-actions';
      const open = document.createElement('button');
      open.textContent = '官网';
      open.onclick = () =>
        chrome.tabs.create({
          url: t.url,
        });
      const preview = document.createElement('button');
      preview.textContent = '预览';
      preview.disabled = ctx.run.busy || ctx.run.operationStarting || !!ctx.run.accessHold;
      preview.onclick = () => ctx.api.previewOne(t);
      actions.append(open, preview);
      if (t.status === 'error') {
        const reset = document.createElement('button');
        reset.textContent = '重置';
        reset.disabled = ctx.run.busy || ctx.run.operationStarting;
        reset.onclick = async () => {
          if (ctx.transfer.packRecords.length || ctx.api.uncertainDownloads()) {
            showError('请先保存或丢弃 ZIP 缓冲');
            return;
          }
          t.files = t.files.filter((f) => f.status === 'complete');
          t.status = 'queued';
          t.error = '';
          t.candidates = [];
          t.observedAt = null;
          await ctx.api.persist();
          ctx.api.render();
          toast('任务已重置；点击下载后才会再次请求。');
        };
        actions.append(reset);
        const details = document.createElement('button');
        details.textContent = '原因';
        details.onclick = () => showError(t.error);
        actions.append(details);
      }
      const remove = document.createElement('button');
      remove.textContent = '移除';
      remove.disabled = ctx.run.busy || ctx.run.operationStarting;
      remove.setAttribute('aria-label', '移除作品 ' + t.id + ' 的任务记录');
      remove.onclick = async () => {
        if (ctx.transfer.packRecords.length || ctx.api.uncertainDownloads()) {
          showError('请先保存或丢弃 ZIP 缓冲');
          return;
        }
        if (
          !confirm(
            `只移除作品 ${t.id} 的任务记录，不删除已下载文件；这会丢失该记录的去重依据。继续吗？`,
          )
        )
          return;
        ctx.state.tasks = ctx.state.tasks.filter((x) => x !== t);
        selection.delete(t.id);
        await ctx.api.persist();
        ctx.api.render();
      };
      actions.append(remove);
      row.append(check, number, main, actions);
      root.append(row);
    }
  }
  function onRender() {
    for (const id of [
      'advancedToggle',
      'dismissWelcome',
      'export',
      'diagnostics',
      'errorDiagnostics',
      'clearLog',
    ])
      ctx.$(id).disabled = !ctx.run.initialized;
    ctx.$('exportLinks').disabled =
      ctx.run.busy || ctx.run.operationStarting || !ctx.run.initialized;
    ctx.$('prepareLinks').disabled =
      ctx.run.busy || ctx.run.operationStarting || !ctx.run.initialized || !!ctx.run.accessHold;
    renderQueue();
    updatePreset();
    ctx.$('quickAction').disabled =
      ctx.run.busy || ctx.run.operationStarting || !ctx.run.initialized || !!ctx.run.accessHold;
    ctx.$('quickInput').disabled =
      ctx.run.busy || ctx.run.operationStarting || !ctx.run.initialized;
    ctx.$('autoDownload').disabled =
      ctx.run.busy || ctx.run.operationStarting || !ctx.run.initialized;
    ctx.$('gentlePreset').disabled =
      ctx.run.busy || ctx.run.operationStarting || !ctx.run.initialized;
    ctx.$('workProgress').max = Math.max(1, ctx.state.tasks.length);
    ctx.$('workProgress').value = ctx.state.tasks.filter((t) => t.status === 'done').length;
    ctx.$('bufferActions').hidden = !ctx.transfer.packRecords.length;
    ctx.$('logCount').textContent = `（${ctx.state.logs.length} 条）`;
    if (ctx.state.ui) {
      document.body.dataset.view = ctx.state.ui.advanced ? 'advanced' : 'simple';
      ctx.$('advancedToggle').textContent = ctx.state.ui.advanced ? '收起高级设置' : '显示高级设置';
      ctx.$('advancedToggle').setAttribute('aria-expanded', String(!!ctx.state.ui.advanced));
      ctx.$('welcome').hidden = !!ctx.state.ui.welcomeDismissed;
    }
    if ((ctx.run.busy || ctx.run.operationStarting) && !wasBusy) {
      started = Date.now();
      ctx.$('errorPanel').hidden = true;
    }
    if (
      !(ctx.run.busy || ctx.run.operationStarting) &&
      wasBusy &&
      /本轮完成/.test(ctx.$('statusText').textContent)
    )
      toast('本轮完成，可打开下载文件夹查看。');
    wasBusy = ctx.run.busy || ctx.run.operationStarting;
  }
  async function openFolder() {
    try {
      await chrome.downloads.showDefaultFolder();
    } catch {
      showError('无法打开下载文件夹。请在浏览器下载列表中手动打开。');
    }
  }
  async function showLatest() {
    const records = [
      ...ctx.state.archives.filter((x) => x.status === 'complete'),
      ...ctx.state.tasks.flatMap((t) => t.files.filter((f) => f.status === 'complete')),
    ]
      .filter((r) => Number.isInteger(r.download_id))
      .sort((a, b) => b.download_id - a.download_id);
    for (const record of records.slice(0, 20)) {
      try {
        const [d] = await chrome.downloads.search({
          id: record.download_id,
        });
        if (!d || d.state !== 'complete' || d.exists === false) continue;
        const basename = d.filename.split(/[\\/]/).pop();
        if (ArchivePolicy.downloadMatches(d, record, chrome.runtime.id)) {
          await chrome.downloads.show(d.id);
          return;
        }
      } catch {}
    }
    toast('没有找到可定位的本机记录，正在打开下载文件夹。');
    await openFolder();
  }
  function openDiagnostics() {
    const data = ui.diagnostics(ctx.state, ctx.version, navigator.userAgent);
    ctx.$('diagnosticText').value = JSON.stringify(data, null, 2);
    ctx.$('diagnosticHint').textContent = '可复制或保存；不会自动上传。';
    if (!ctx.$('diagnosticDialog').open) ctx.$('diagnosticDialog').showModal();
  }
  ctx.$('quickInput').oninput = quickHint;
  ctx.$('quickInput').onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      quickAction();
    }
  };
  ctx.$('quickAction').onclick = quickAction;
  ctx.$('advancedToggle').onclick = () => setAdvanced(document.body.dataset.view !== 'advanced');
  ctx.$('dismissWelcome').onclick = () => {
    if (!ctx.run.initialized) return;
    ctx.state.ui = ctx.state.ui || {};
    ctx.state.ui.welcomeDismissed = true;
    ctx.$('welcome').hidden = true;
    ctx.api.persist().catch(showError);
  };
  ctx.$('preset').onchange = () => applyPreset(ctx.$('preset').value);
  ctx.$('gentlePreset').onclick = () => applyPreset('gentle');
  for (const id of ['interval', 'concurrency', 'volumeMB'])
    ctx.$(id).addEventListener('change', updatePreset);
  for (const button of document.querySelectorAll('[data-filter]'))
    button.onclick = () => {
      filter = button.dataset.filter;
      page = 0;
      renderQueue();
    };
  ctx.$('queueSearch').oninput = () => {
    query = ctx.$('queueSearch').value;
    page = 0;
    renderQueue();
  };
  ctx.$('previousPage').onclick = () => {
    page--;
    renderQueue();
  };
  ctx.$('nextPage').onclick = () => {
    page++;
    renderQueue();
  };
  ctx.$('pageSize').onchange = () => {
    pageSize = Number(ctx.$('pageSize').value);
    page = 0;
    renderQueue();
  };
  ctx.$('selectPage').onclick = () => {
    for (const t of visible) if (['queued', 'ready'].includes(t.status)) selection.add(t.id);
    renderQueue();
  };
  ctx.$('clearSelection').onclick = () => {
    selection.clear();
    renderQueue();
  };
  ctx.$('openFolder').onclick = openFolder;
  ctx.$('showLatest').onclick = showLatest;
  ctx.$('openTaskPage').onclick = async () => {
    try {
      if (ctx.run.ownedTab) {
        await chrome.tabs.update(ctx.run.ownedTab, {
          active: true,
        });
        return;
      }
    } catch {}
    const url =
      ArchivePolicy.siteURL(ctx.$('profile').value, 'profile') ||
      ctx.state.tasks.find((t) => t.status === 'error')?.url ||
      'https://www.mihuashi.com/';
    await chrome.tabs.create({
      url,
    });
  };
  ctx.$('dismissError').onclick = () => (ctx.$('errorPanel').hidden = true);
  ctx.$('diagnostics').onclick = openDiagnostics;
  ctx.$('errorDiagnostics').onclick = openDiagnostics;
  ctx.$('closeDiagnostics').onclick = () => ctx.$('diagnosticDialog').close();
  ctx.$('copyDiagnostics').onclick = async () => {
    try {
      await navigator.clipboard.writeText(ctx.$('diagnosticText').value);
      ctx.$('diagnosticHint').textContent = '已复制。发布前请再检查一次内容。';
    } catch {
      ctx.$('diagnosticText').focus();
      ctx.$('diagnosticText').select();
      ctx.$('diagnosticHint').textContent = '浏览器未允许直接复制，已选中文字，请按 Ctrl / ⌘ + C。';
    }
  };
  ctx.$('saveDiagnostics').onclick = async () => {
    const blob = new Blob([ctx.$('diagnosticText').value], {
        type: 'application/json',
      }),
      url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url,
        filename: `ArtworkArchive-diagnostics-${Date.now()}.json`,
        saveAs: false,
      });
      ctx.$('diagnosticHint').textContent = '已交给浏览器保存；没有上传。';
    } catch (e) {
      ctx.$('diagnosticHint').textContent = '保存失败：' + e.message;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  };
  ctx.ui = {
    selection,
    renderQueue,
    onRender,
    showError,
    quickHint,
    toast,
    quickAction,
  };
  setInterval(() => {
    if (!started) return;
    const secs = Math.floor((Date.now() - started) / 1000);
    ctx.$('elapsed').textContent =
      (ctx.run.busy || ctx.run.operationStarting ? '本轮已运行 ' : '本轮用时 ') +
      Math.floor(secs / 60) +
      ' 分 ' +
      (secs % 60) +
      ' 秒';
    if (!(ctx.run.busy || ctx.run.operationStarting)) started = 0;
  }, 1000);
  quickHint();
  ctx.api.render();
};

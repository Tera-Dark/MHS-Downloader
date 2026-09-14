// Owns startup reconciliation and durable staging recovery; never initiates a download.
globalThis.ArchiveServices ||= {};
ArchiveServices['recovery-service'] = function (ctx) {
  async function restorePack() {
    ctx.transfer.pack = new ZipVolume();
    ctx.transfer.packRecords = [];
    const added = new Set(),
      cached = new Map();
    for (const t of ctx.state.tasks)
      for (const f of t.files)
        if (f.status === 'staged') {
          if (!cached.has(f.sha256)) cached.set(f.sha256, await ctx.store.read('images', f.sha256));
          const data = cached.get(f.sha256);
          if (!data?.blob) {
            f.status = 'interrupted';
            t.status = 'error';
            t.error = '暂存图片缺失，请检查后手动重置';
            continue;
          }
          if (!added.has(f.zip_member)) {
            ctx.transfer.pack.add(f.zip_member, data.blob, data.crc32);
            added.add(f.zip_member);
          }
          ctx.transfer.packRecords.push(f);
          ctx.transfer.hashIndex.set(f.sha256, f);
        }
  }
  function uncertainDownloads() {
    return (
      ctx.state.archives.some((a) => ['requesting', 'pending', 'uncertain'].includes(a.status)) ||
      ctx.state.tasks.some((t) =>
        t.files.some(
          (f) =>
            f.location === 'native' && ['requesting', 'pending', 'uncertain'].includes(f.status),
        ),
      )
    );
  }
  async function collectStaging() {
    await ctx.store.collectImages(
      new Set(
        ctx.state.tasks.flatMap((t) =>
          t.files.filter((f) => f.status === 'staged').map((f) => f.sha256),
        ),
      ),
    );
  }
  async function findJournal(record) {
    if (record.imported) return null;
    let candidates = [];
    try {
      if (Number.isInteger(record.download_id))
        candidates = await chrome.downloads.search({
          id: record.download_id,
        });
      else if (record.requested_at)
        candidates = await chrome.downloads.search({
          startedAfter: new Date(Date.parse(record.requested_at) - 5000).toISOString(),
          limit: 1000,
        });
    } catch {
      return null;
    }
    const found = candidates.filter((d) =>
      ArchivePolicy.journalMatches(d, record, chrome.runtime.id),
    );
    return found.length === 1 ? found[0] : null;
  }
  async function reconcile() {
    for (const a of ctx.state.archives.filter((a) =>
      ['requesting', 'pending', 'uncertain'].includes(a.status),
    )) {
      const d = await findJournal(a);
      if (d?.state === 'complete' && d.exists !== false) {
        a.download_id = d.id;
        a.status = 'complete';
        a.saved_basename = d.filename.split(/[\\/]/).pop();
        for (const t of ctx.state.tasks)
          for (const f of t.files)
            if (a.record_ids.includes(f.record_id))
              Object.assign(f, {
                status: 'complete',
                archive_filename: a.filename,
                download_url: a.download_url,
                saved_basename: a.saved_basename,
                download_id: d.id,
                downloaded_at: d.endTime,
              });
      } else if (d?.state === 'interrupted') a.status = 'interrupted';
      else a.status = 'uncertain'; // Never cancel, confirm or repeat an unowned or ambiguous download.
    }
    for (const t of ctx.state.tasks) {
      for (const f of t.files.filter(
        (f) => f.location === 'native' && ['requesting', 'pending', 'uncertain'].includes(f.status),
      )) {
        const d = await findJournal(f);
        if (d?.state === 'complete' && d.exists !== false && d.mime?.startsWith('image/'))
          Object.assign(f, {
            status: 'complete',
            download_id: d.id,
            bytes: d.fileSize,
            mime: d.mime,
            saved_basename: d.filename.split(/[\\/]/).pop(),
            downloaded_at: d.endTime,
          });
        else f.status = d?.state === 'interrupted' ? 'interrupted' : 'uncertain';
      }
      if (['reading', 'downloading', 'staged'].includes(t.status)) {
        t.status = 'error';
        t.error =
          '上次工作已中断。已验证图片保留在本地暂存，请先保存；未完成任务需手动重置后继续。';
      }
      ctx.api.refreshTask(t);
    }
    await restorePack();
    await ctx.api.persist();
    await collectStaging();
  }
  async function resolveDownloads() {
    if (ctx.run.busy) return;
    await reconcile();
    if (uncertainDownloads()) {
      if (
        !confirm(
          '有下载历史缺失、归属无法确认或仍在下载的项目。请先到浏览器下载列表和保存目录核对；如仍在进行请先等待或手动取消。确认后允许再次保存这些未确认项，可能产生重复文件。是否已检查并允许重试？',
        )
      ) {
        ctx.api.render();
        return;
      }
      for (const a of ctx.state.archives)
        if (['requesting', 'pending', 'uncertain'].includes(a.status)) {
          a.status = 'interrupted';
          a.manual_retry_at = new Date().toISOString();
        }
      for (const t of ctx.state.tasks)
        for (const f of t.files)
          if (f.location === 'native' && ['requesting', 'pending', 'uncertain'].includes(f.status))
            f.status = 'interrupted';
      await ctx.api.persist();
    }
    ctx.api.status(
      '下载结果已核对；没有自动发起下载。暂存图片可点击保存，未完成任务请检查后重置。',
    );
    ctx.api.render();
  }
  return {
    restorePack,
    uncertainDownloads,
    collectStaging,
    findJournal,
    reconcile,
    resolveDownloads,
  };
};

// Explicit context-injected service; no mutable workbench globals.
globalThis.ArchiveServices ||= {};
ArchiveServices['download-service'] = function (ctx) {
  ctx.transfer = {
    pack: new ZipVolume(),
    packRecords: [],
    packLock: Promise.resolve(),
    jobs: new Set(),
    controllers: new Set(),
    hashIndex: new Map(),
    urlIndex: new Map(),
    volumeNo: 0,
  };
  function recordBase(t, img) {
    return {
      record_id: crypto.randomUUID(),
      artwork_id: t.id,
      artwork_url: t.url,
      profile_url: t.profile,
      artist_label: t.artist || ctx.run.C.artist || '未填写',
      image_url: img.url,
      kind: 'detail_display',
      observed_width: img.width,
      observed_height: img.height,
      observed_at: t.observedAt,
      authorization_note: ctx.run.C.note,
      authorization_basis: 'user_confirmation',
      sha256: null,
      status: 'pending',
    };
  }
  function previousURL(url) {
    return ctx.transfer.urlIndex.get(url) || null;
  }
  function extFor(url) {
    return (
      new URL(url).pathname.match(/\.(jpe?g|png|webp|avif|gif)(?:!|$)/i)?.[1]?.toLowerCase() ||
      'img'
    );
  }
  function imageName(t, img, extension) {
    return `${ctx.api.safeName(t.artist || ctx.run.C.artist || '未填写')}/${t.id}_${String((t.candidates || []).findIndex((x) => x.url === img.url) + 1).padStart(2, '0')}_${img.width}x${img.height}.${extension}`;
  }
  async function removeDownload(id) {
    try {
      await chrome.downloads.removeFile(id);
    } catch {}
    try {
      await chrome.downloads.erase({
        id,
      });
    } catch {}
  }
  async function waitDownload(id, isImage = false) {
    const end = Date.now() + 180000;
    try {
      while (Date.now() < end) {
        await ctx.api.guard();
        const [d] = await chrome.downloads.search({
          id,
        });
        if (!d) throw Error('下载记录丢失');
        if (d.state === 'interrupted') {
          if (isImage && ['SERVER_FORBIDDEN', 'SERVER_UNAUTHORIZED'].includes(d.error))
            await ctx.api.holdAccess('NATIVE_RESTRICTED');
          throw Error('下载中断：' + (d.error || '未知错误'));
        }
        if (d.state === 'complete') {
          if (isImage && !d.mime?.startsWith('image/')) {
            await removeDownload(id);
            throw Error('下载响应不是图片，已尝试删除异常文件');
          }
          return d;
        }
        await ctx.api.sleep(250);
      }
      throw Error('下载超过 180 秒，请检查浏览器');
    } catch (e) {
      try {
        await chrome.downloads.cancel(id);
      } catch {}
      throw e;
    }
  }
  async function nativeImage(t, img) {
    if (!ArchivePolicy.imageURL(img.url)) throw Error('不支持的图片地址');
    let rec = recordBase(t, img);
    rec.location = 'native';
    rec.relative_filename = `${ctx.run.C.folder}/${imageName(t, img, extFor(img.url)).replace(/([^/]+)$/, rec.record_id.slice(0, 12) + '_$1')}`;
    rec.requested_at = new Date().toISOString();
    rec.status = 'requesting';
    t.files.push(rec);
    rec = t.files.at(-1);
    await ctx.api.persist(); // Write-ahead journal: survives API success before its ID can be saved.
    await ctx.api.guard();
    const id = await chrome.downloads.download({
      url: img.url,
      filename: rec.relative_filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    rec.download_id = id;
    rec.status = 'pending';
    await ctx.api.persist();
    const d = await waitDownload(id, true);
    Object.assign(rec, {
      status: 'complete',
      bytes: d.fileSize,
      mime: d.mime,
      saved_basename: d.filename.split(/[\\/]/).pop(),
      downloaded_at: new Date().toISOString(),
    });
    await ctx.api.persist();
    ctx.transfer.urlIndex.set(rec.image_url, rec);
    ctx.api.log(`已保存作品 ${t.id} 的图片 · 原生下载`);
  }
  async function fetchImage(img) {
    if (!ArchivePolicy.imageURL(img.url)) throw Error('不支持的图片地址');
    const ctl = new AbortController();
    ctx.transfer.controllers.add(ctl);
    const timer = setTimeout(() => ctl.abort(), 45000);
    let input,
      keepInput = false;
    try {
      await ctx.api.guard();
      const r = await fetch(img.url, {
        credentials: 'omit',
        signal: ctl.signal,
        cache: 'default',
        redirect: 'error',
      });
      if ([401, 403, 429].includes(r.status))
        await ctx.api.holdAccess(String(r.status), r.headers.get('Retry-After'));
      if (!r.ok)
        throw Error(
          `图片直连返回 HTTP ${r.status}，停止本轮。若需官网会话，请人工检查后选择原生模式，不会自动切换重试。`,
        );
      if (!['www.mihuashi.com', 'image-assets.mihuashi.com'].includes(new URL(r.url).hostname))
        throw Error('图片重定向到未声明域名');
      const mime = (r.headers.get('content-type') || '').split(';')[0];
      if (!mime.startsWith('image/')) throw Error('图片直连响应不是图片');
      const maximum = 40 * 1024 * 1024;
      if (Number(r.headers.get('content-length')) > maximum) throw Error('单张图片超过 40 MB 上限');
      const reader = r.body.getReader();
      input = crypto.randomUUID();
      let total = 0,
        index = 0,
        filled = 0;
      const chunk = new Uint8Array(1048576);
      while (true) {
        await ctx.api.guard();
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maximum) {
          await reader.cancel();
          throw Error('单张图片超过 40 MB 上限');
        }
        // One fixed-size assembly buffer per fetch; backpressure at each durable chunk.
        for (let offset = 0; offset < value.length; ) {
          const n = Math.min(chunk.length - filled, value.length - offset);
          chunk.set(value.subarray(offset, offset + n), filled);
          filled += n;
          offset += n;
          if (filled === chunk.length) {
            await ctx.store.putChunk(input, index++, new Blob([chunk]));
            filled = 0;
          }
        }
      }
      if (filled) await ctx.store.putChunk(input, index++, new Blob([chunk.subarray(0, filled)]));
      const blob = await ctx.store.inputBlob(input, mime);
      const checked = await ctx.images.inspect(blob, mime);
      await ctx.api.guard();
      keepInput = true;
      return {
        input,
        blob,
        bytes: blob.size,
        mime,
        ...checked,
      };
    } catch (e) {
      if (e.name === 'AbortError')
        throw ctx.run.stop
          ? new ctx.Paused()
          : ctx.run.fatal || Error('图片请求已取消或超过 45 秒');
      throw e;
    } finally {
      clearTimeout(timer);
      ctl.abort();
      ctx.transfer.controllers.delete(ctl);
      if (input && !keepInput) await ctx.store.dropInput(input).catch(() => {});
    }
  }
  function locked(fn) {
    const p = ctx.transfer.packLock.catch(() => {}).then(fn);
    ctx.transfer.packLock = p;
    return p;
  }
  async function stageImage(t, img, data) {
    return locked(async () => {
      await ctx.api.guard();
      let known = ctx.transfer.hashIndex.get(data.sha256);
      let rec = recordBase(t, img);
      Object.assign(rec, {
        sha256: data.sha256,
        bytes: data.bytes,
        mime: data.mime,
        width: data.width,
        height: data.height,
        location: 'zip',
      });
      if (known?.status === 'complete') {
        Object.assign(rec, {
          status: 'complete',
          archive_filename: known.archive_filename,
          download_url: known.download_url,
          saved_basename: known.saved_basename,
          zip_member: known.zip_member,
          download_id: known.download_id,
          duplicate_of: known.record_id,
          downloaded_at: known.downloaded_at,
        });
        t.files.push(rec);
        ctx.api.log(`作品 ${t.id} 图片内容重复，复用已保存文件`);
        await ctx.api.persist();
        await ctx.store.dropInput(data.input);
        return;
      }
      if (
        !known &&
        ctx.transfer.pack.bytes + data.bytes > ctx.run.C.volumeMB * 1048576 &&
        ctx.transfer.packRecords.length
      ) {
        await flushLocked();
        known = ctx.transfer.hashIndex.get(data.sha256);
      }
      const extension =
        {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
          'image/gif': 'gif',
          'image/avif': 'avif',
        }[data.mime] || extFor(img.url);
      if (known) {
        rec.zip_member = known.zip_member;
        rec.duplicate_of = known.record_id;
      } else {
        rec.zip_member = imageName(
          t,
          {
            ...img,
            width: data.width,
            height: data.height,
          },
          extension,
        ).replace(/\/([^/]+)$/, (_, name) => '/' + data.sha256.slice(0, 10) + '_' + name);
        ctx.transfer.pack.add(rec.zip_member, data.blob, data.crc32);
        ctx.transfer.hashIndex.set(data.sha256, rec);
      }
      rec.status = 'staged';
      t.files.push(rec);
      rec = t.files.at(-1);
      ctx.transfer.hashIndex.set(data.sha256, rec);
      ctx.transfer.packRecords.push(rec);
      try {
        await ctx.images.commit(data, ctx.api.persist);
      } catch (e) {
        t.files = t.files.filter((f) => f.record_id !== rec.record_id);
        ctx.transfer.packRecords = ctx.transfer.packRecords.filter(
          (f) => f.record_id !== rec.record_id,
        );
        await ctx.api.restorePack();
        throw e;
      }
      ctx.api.render();
    });
  }
  async function flushLocked() {
    if (!ctx.transfer.packRecords.length) return;
    if (ctx.api.uncertainDownloads())
      throw Error('有保存结果未确认的下载，请先核对下载目录并处理恢复提示，避免重复保存');
    await ctx.api.guard();
    const batch = ctx.transfer.packRecords.slice(),
      volume = ctx.transfer.pack;
    const filename = `${ctx.run.C.folder}/Archive_${ctx.run.runStamp}_${String(++ctx.transfer.volumeNo).padStart(3, '0')}_${crypto.randomUUID().slice(0, 12)}.zip`;
    volume.add(
      'manifest.json',
      new TextEncoder().encode(
        JSON.stringify(
          {
            tool: '画页存档',
            version: ctx.version,
            created_at: new Date().toISOString(),
            note: 'included indicates ZIP membership, not browser save completion; detail_display is not a verified original source',
            images: batch.map((r) => ({
              ...r,
              status: 'included',
              archive_filename: filename,
            })),
          },
          null,
          2,
        ),
      ),
    );
    const url = URL.createObjectURL(volume.blob());
    let pending;
    try {
      ctx.state.archives.push({
        download_url: url,
        filename,
        record_ids: batch.map((r) => r.record_id),
        status: 'requesting',
        requested_at: new Date().toISOString(),
      });
      pending = ctx.state.archives.at(-1);
      await ctx.api.persist();
      await ctx.api.guard();
      const id = await chrome.downloads.download({
        url,
        filename,
        saveAs: false,
        conflictAction: 'uniquify',
      });
      pending.download_id = id;
      pending.status = 'pending';
      await ctx.api.persist();
      const d = await waitDownload(id);
      pending.status = 'complete';
      pending.saved_basename = d.filename.split(/[\\/]/).pop();
      pending.bytes = d.fileSize;
      for (const r of batch)
        Object.assign(r, {
          status: 'complete',
          archive_filename: filename,
          download_url: url,
          saved_basename: pending.saved_basename,
          download_id: id,
          downloaded_at: new Date().toISOString(),
        });
      for (const r of batch) ctx.transfer.urlIndex.set(r.image_url, r);
      for (const t of ctx.state.tasks) ctx.api.refreshTask(t);
      await ctx.api.persist(); // Do not release durable images until success records are durable too.
      ctx.transfer.pack = new ZipVolume();
      ctx.transfer.packRecords = [];
      await ctx.api.collectStaging();
      ctx.api.render();
      ctx.api.log(`ZIP 已保存：${pending.saved_basename} · ${batch.length} 条图片来源`);
    } catch (e) {
      if (pending) pending.status = 'uncertain';
      for (const r of batch) r.status = 'staged';
      if (volume.entries.at(-1)?.name === 'manifest.json') {
        volume.bytes -= volume.entries.at(-1).bytes.length;
        volume.entries.pop();
      }
      throw e;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function flushPack() {
    return locked(flushLocked);
  }
  async function saveTask(t, images) {
    t.status = 'downloading';
    t.error = '';
    t.expected = images.map((x) => x.url);
    ctx.api.render();
    await ctx.api.persist();
    for (const img of images) {
      await ctx.api.guard();
      const prev = previousURL(img.url);
      if (prev) {
        if (!t.files.some((f) => f.image_url === img.url && f.status === 'complete'))
          t.files.push({
            ...prev,
            ...recordBase(t, img),
            status: 'complete',
            sha256: prev.sha256,
            location: prev.location,
            zip_member: prev.zip_member,
            archive_filename: prev.archive_filename,
            relative_filename: prev.relative_filename,
            saved_basename: prev.saved_basename,
            download_id: prev.download_id,
            bytes: prev.bytes,
            mime: prev.mime,
            duplicate_of: prev.record_id,
          });
        ctx.api.log('跳过已有成功图片 URL：' + t.id);
        continue;
      }
      if (ctx.run.C.mode === 'native') await nativeImage(t, img);
      else {
        const data = await fetchImage(img);
        try {
          await stageImage(t, img, data);
        } finally {
          await ctx.store.dropInput(data.input).catch(() => {});
        }
      }
    }
    ctx.api.refreshTask(t);
    await ctx.api.persist();
    ctx.api.render();
  }
  function schedule(t, images) {
    let job;
    job = (async () => {
      try {
        await saveTask(t, images);
      } catch (e) {
        t.status = 'error';
        t.error = e.message;
        if (!ctx.run.fatal) ctx.run.fatal = e;
        ctx.api.abortFetches();
        ctx.api.log(`作品 ${t.id} 停止：${e.message}`, true);
      } finally {
        ctx.transfer.jobs.delete(job);
        await ctx.api.persist();
        ctx.api.render();
      }
    })();
    ctx.transfer.jobs.add(job);
    ctx.api.render();
    return job;
  }
  async function downloadQueue(scope = null) {
    if (ctx.api.uncertainDownloads()) throw Error('请先核对未确认下载，避免重复保存');
    ctx.run.runPhase = 'download';
    ctx.api.publishRunView();
    const selected = ctx.state.tasks
      .filter(
        (t) =>
          ['queued', 'ready'].includes(t.status) &&
          (scope ? scope.has(t.url) : !ctx.ui?.selection.size || ctx.ui.selection.has(t.id)),
      )
      .slice(0, ctx.run.C.maxWorks);
    if (!selected.length) throw Error('没有待处理任务；失败项请检查后手动重置');
    ctx.api.log(
      `本轮 ${selected.length} 件 · 页面间隔至少 ${ctx.run.C.interval}s · 下载并发 ${ctx.run.C.concurrency} · ${ctx.run.C.mode === 'zip' ? '分卷 ZIP' : '原生保存'}`,
    );
    for (const t of selected) {
      await ctx.api.guard();
      while (ctx.transfer.jobs.size >= ctx.run.C.concurrency) {
        await Promise.race(ctx.transfer.jobs);
        await ctx.api.guard();
      }
      try {
        const candidates = await ctx.api.readTask(t);
        const images = ctx.run.C.selection === 'largest' ? candidates.slice(0, 1) : candidates;
        schedule(t, images);
      } catch (e) {
        t.status = 'error';
        t.error = e.message;
        throw e;
      }
    }
    await Promise.all([...ctx.transfer.jobs]);
    await ctx.api.guard();
    await flushPack();
    ctx.api.status('本轮完成。文件已提交浏览器并确认下载完成；建议导出来源清单。');
    ctx.api.log('本轮下载完成');
  }
  return {
    recordBase,
    previousURL,
    extFor,
    imageName,
    removeDownload,
    waitDownload,
    nativeImage,
    fetchImage,
    locked,
    stageImage,
    flushLocked,
    flushPack,
    saveTask,
    schedule,
    downloadQueue,
  };
};

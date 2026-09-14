// Explicit context-injected service; no mutable workbench globals.
globalThis.ArchiveServices ||= {};
ArchiveServices['scan-service'] = function (ctx) {
  async function scanProfile() {
    const url = ArchivePolicy.siteURL(ctx.run.C.profile, 'profile');
    if (!url) throw Error('请输入有效的 /users/画师名 或 /profiles/数字ID 主页链接');
    const tabId = await ctx.api.tabFor(url);
    const first = await ctx.api.waitLoaded(tabId, url, 'profile');
    let author = ctx.run.C.artist || first.title.replace(/\s*的主页.*$/, '').trim();
    if (!author || (author === first.title && !first.title.includes('的主页')))
      author = ctx.run.C.artist || '未填写';
    if (!ctx.run.C.artist) {
      ctx.run.C.artist = author;
      ctx.$('artist').value = author;
    }
    const seen = new Set(),
      found = new Set(),
      unresolved = [];
    let stable = 0,
      rounds = 0,
      expected = first.expected,
      reason = '达到扫描轮次上限',
      lastCount = 0;
    let discovery = {
      profile_url: url,
      artist: author,
      started_at: new Date().toISOString(),
      status: 'running',
      found: [],
      unresolved: [],
      expected,
    };
    ctx.state.scans.push(discovery);
    ctx.state.scans = ctx.state.scans.slice(-40);
    discovery = ctx.state.scans.at(-1);
    function add(url) {
      if (found.size >= ctx.run.C.maxWorks) return;
      const normalized = ArchivePolicy.siteURL(url);
      if (!normalized) return;
      const task = ctx.api.addTask(normalized, {
        artist: author,
        profile: ctx.run.C.profile,
      });
      if (task) found.add(normalized);
    }
    try {
      // Pass 1: collect all links exposed by scrolling before clicking any opaque card.
      ctx.run.runPhase = 'scroll';
      const harvested = new Set();
      let quiet = 0;
      for (let pass = 0; pass < 300; pass++) {
        await ctx.api.guard();
        const snap = await ctx.api.dom(tabId, {
          op: 'profile',
        });
        if (ArchivePolicy.siteURL(snap.pageURL, 'profile') !== url)
          throw Error('滚动收集时页面离开主页，已停止');
        expected = snap.expected ?? expected;
        const previous = harvested.size;
        for (const direct of snap.links) add(direct);
        for (const card of snap.cards) {
          harvested.add(card.key);
          if (card.url) add(card.url);
        }
        discovery.found = [...found];
        discovery.expected = expected;
        discovery.cards_seen = harvested.size;
        await ctx.api.persist();
        ctx.$('scanProgress').textContent =
          `后台滚动收集：已见 ${harvested.size} 张卡片 · 已取得 ${found.size} 条作品链接`;
        ctx.api.status(ctx.$('scanProgress').textContent);
        ctx.api.render();
        if (
          found.size >= ctx.run.C.maxWorks ||
          harvested.size >= ctx.run.C.maxWorks ||
          (expected !== null && harvested.size >= expected)
        )
          break;
        quiet = snap.bottom && previous === harvested.size ? quiet + 1 : 0;
        if (quiet >= 3) break;
        await ctx.api.dom(tabId, {
          op: 'scroll',
        });
        await ctx.api.sleep(Math.max(1000, ctx.run.C.interval * 1000));
      }
      // Missing URLs still require ordinary card navigation; never turn thumbnails into originals.
      if (found.size < ctx.run.C.maxWorks && !(expected !== null && found.size >= expected)) {
        await ctx.api.dom(tabId, {
          op: 'restore',
          y: 0,
        });
        await ctx.api.sleep(350);
      }
      ctx.run.runPhase = 'resolve';
      for (; rounds < 300; rounds++) {
        if (found.size >= ctx.run.C.maxWorks || (expected !== null && found.size >= expected)) {
          reason =
            found.size >= ctx.run.C.maxWorks ? '达到本轮作品上限' : '已达到页面标示的作品数量';
          break;
        }
        await ctx.api.guard();
        const snap = await ctx.api.dom(tabId, {
          op: 'profile',
        });
        if (ArchivePolicy.siteURL(snap.pageURL, 'profile') !== url)
          throw Error('扫描页已离开画师主页，请手动检查');
        expected = snap.expected ?? expected;
        for (const direct of snap.links) add(direct);
        let failures = 0;
        for (const card of snap.cards) {
          if (found.size >= ctx.run.C.maxWorks) break;
          if (seen.has(card.key)) continue;
          seen.add(card.key);
          if (card.url) {
            add(card.url);
            failures = 0;
            continue;
          }
          ctx.api.status(`扫描主页：已找到 ${found.size} 件，正在解析无链接卡片`);
          const resolved = await ctx.api.resolveCard(tabId, card.key, url, async (workURL) => {
            add(workURL);
            discovery.found = [...found];
            await ctx.api.persist();
            ctx.api.render();
          });
          if (resolved) {
            add(resolved);
            failures = 0;
          } else {
            unresolved.push({
              key: card.key,
              reason: '普通点击未取得详情 URL；可能是弹窗被阻止、特殊卡片或列表已变化',
            });
            failures++;
          }
          ctx.$('scanProgress').textContent =
            `已发现 ${found.size} 件 · 无法解析 ${unresolved.length} 张卡片${expected !== null ? ' · 页面标示 ' + expected + ' 件' : ''}`;
          ctx.api.render();
          if (failures >= 3) {
            reason = '连续 3 张无链接卡片无法解析，停止以避免反复点击';
            break;
          }
        }
        discovery.found = [...found];
        discovery.unresolved = unresolved;
        discovery.expected = expected;
        await ctx.api.persist();
        ctx.api.render();
        ctx.$('scanProgress').textContent =
          `已发现 ${found.size} 件 · 无法解析 ${unresolved.length} 张卡片${expected !== null ? ' · 页面标示 ' + expected + ' 件' : ''}`;
        if (found.size >= ctx.run.C.maxWorks) {
          reason = '达到本轮作品上限';
          break;
        }
        if (failures >= 3) break;
        if (expected !== null && found.size >= expected && unresolved.length === 0) {
          reason = '已达到页面标示的作品数量';
          break;
        }
        const scroll = await ctx.api.dom(tabId, {
          op: 'scroll',
        });
        await ctx.api.sleep(1000);
        const after = await ctx.api.dom(tabId, {
          op: 'profile',
        });
        if (
          after.bottom &&
          after.cards.length === lastCount &&
          after.cards.every((x) => seen.has(x.key)) &&
          after.links.every((u) => found.has(u))
        )
          stable++;
        else stable = 0;
        lastCount = after.cards.length;
        if (stable >= 3) {
          reason = '连续 3 次到底且未发现新作品';
          break;
        }
      }
      discovery.status =
        unresolved.length ||
        (expected !== null && found.size < expected) ||
        (found.size >= ctx.run.C.maxWorks && !(expected !== null && found.size >= expected)) ||
        rounds >= 300
          ? 'partial'
          : 'finished';
      discovery.stop_reason = reason;
      discovery.ended_at = new Date().toISOString();
      discovery.expected = expected;
      discovery.found = [...found];
      discovery.unresolved = unresolved;
      const summary = `扫描${discovery.status === 'partial' ? '部分完成' : '结束'}：发现 ${found.size} 件${expected !== null ? ' / 页面标示 ' + expected + ' 件' : ''}；${reason}。无法解析 ${unresolved.length} 张卡片。`;
      ctx.$('scanProgress').textContent = summary;
      ctx.api.status(summary);
      ctx.api.log(summary, discovery.status === 'partial');
      await ctx.api.persist();
      return discovery;
    } catch (e) {
      discovery.status = 'stopped';
      discovery.stop_reason = e.message;
      discovery.found = [...found];
      discovery.unresolved = unresolved;
      discovery.ended_at = new Date().toISOString();
      ctx.$('scanProgress').textContent = `已保留 ${found.size} 件；扫描停止：${e.message}`;
      await ctx.api.persist();
      throw e;
    }
  }
  async function scanAndMaybeDownload(run, background = false, links = false) {
    await ctx.api.operate(async () => {
      const result = await scanProfile();
      if (result.status === 'partial') ctx.run.runPhase = 'partial';
      if (run || links) {
        if (background && result.status === 'partial') {
          ctx.api.status('仅收集到部分结果，已保留队列；请打开工作台核对后再下载。');
          return;
        }
        if (!result.found.length) throw Error('未发现可下载的作品');
        if (
          result.status === 'partial' &&
          !confirm(
            `扫描仅部分完成：${result.stop_reason}。现在下载已找到的 ${result.found.length} 件吗？`,
          )
        ) {
          ctx.api.status('已保留扫描结果，未开始下载');
          return;
        }
        if (links) await ctx.api.prepareImageLinks(new Set(result.found));
        else await ctx.api.downloadQueue(new Set(result.found));
      }
    });
  }
  return { scanProfile, scanAndMaybeDownload };
};

// Explicit context-injected service; no mutable workbench globals.
globalThis.ArchiveServices ||= {};
ArchiveServices['navigation-service'] = function (ctx) {
  async function dom(tabId, args = {}) {
    const r = await chrome.scripting.executeScript({
      target: {
        tabId,
      },
      func: pageTask,
      args: [args],
    });
    if (!r[0]?.result) throw Error('无法读取页面，请检查扩展站点权限');
    const result = r[0].result;
    if (result.blocked) {
      await ctx.api.holdAccess('AUTH');
      throw Error('网站要求人工处理：' + result.blocked);
    }
    return result;
  }
  async function tabFor(url) {
    if (ctx.run.ownedTab) {
      try {
        await chrome.tabs.get(ctx.run.ownedTab);
      } catch {
        ctx.run.ownedTab = null;
      }
    }
    if (!ctx.run.ownedTab) {
      const t = await chrome.tabs.create({
        url: 'about:blank',
        active: false,
      });
      ctx.run.ownedTab = t.id;
    }
    await chrome.storage.session.set({
      monitoredTab: ctx.run.ownedTab,
    });
    const t = await chrome.tabs.get(ctx.run.ownedTab);
    if (t.url !== url) {
      await ctx.api.sleep(
        Math.max(0, ctx.run.lastNavigate + ctx.run.C.interval * 1000 - Date.now()),
      );
      await ctx.api.guard();
      ctx.run.lastNavigate = Date.now();
      await chrome.tabs.update(ctx.run.ownedTab, {
        url,
        active: false,
      });
    }
    return ctx.run.ownedTab;
  }
  async function waitLoaded(tabId, url, op = 'detail', timeout = 25000) {
    const started = Date.now(),
      end = started + timeout;
    let last;
    while (Date.now() < end) {
      await ctx.api.guard();
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') {
        if (t.url?.startsWith('about:')) {
          if (Date.now() - started > 1200)
            throw new ctx.NavigationMismatch('任务页仍为空白，未到达预期地址');
          await ctx.api.sleep(150);
          continue;
        }
        try {
          last = await dom(tabId, {
            op,
          });
        } catch (e) {
          if (
            /Frame.*removed|frame.*removed|Execution context.*destroyed|Frame.*not found/i.test(
              e.message,
            )
          ) {
            await ctx.api.sleep(150);
            continue;
          }
          throw e;
        }
        await ctx.api.guard();
        if (
          last.pageURL === url ||
          ArchivePolicy.siteURL(last.pageURL, op === 'profile' ? 'profile' : 'artwork') === url
        ) {
          if (op === 'profile' && (last.cards.length || last.links.length || last.expected === 0))
            return last;
          if (op === 'detail' && last.images.length) {
            await ctx.api.sleep(250);
            const stable = await dom(tabId, {
              op,
            });
            if (stable.images?.length) return stable;
          }
        } else if (
          t.url &&
          !t.url.startsWith('about:') &&
          Date.now() - started > 1200 &&
          t.pendingUrl !== url
        )
          throw new ctx.NavigationMismatch(
            '页面没有到达预期地址，已停止，请检查任务网页：' + t.url,
          );
      }
      await ctx.api.sleep(300);
    }
    throw Error(
      op === 'profile'
        ? '25 秒内没有找到可扫描的作品列表。请确认主页可正常显示。'
        : '25 秒内未找到合格的详情展示图。请手动打开大图或检查页面结构。',
    );
  }
  async function restoreProfile(tabId, profileURL, y) {
    await ctx.api.guard();
    // A detail page can have a login dialog without an HTTP error. Do not navigate around it.
    await dom(tabId, {
      op: 'profile',
    });
    try {
      await ctx.api.sleep(
        Math.max(0, ctx.run.lastNavigate + ctx.run.C.interval * 1000 - Date.now()),
      );
      await ctx.api.guard();
      ctx.run.lastNavigate = Date.now();
      await chrome.tabs.goBack(tabId);
      await waitLoaded(tabId, profileURL, 'profile');
    } catch (e) {
      await ctx.api.guard();
      const missingHistory = /Cannot find.*(?:page|history)|no.*(?:previous|back).*history/i.test(
        e.message,
      );
      if (!(e instanceof ctx.NavigationMismatch) && !missingHistory) throw e;
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url?.startsWith('about:')) {
        // Unknown redirects must stop. Only recover from a known public work/profile page.
        if (!ArchivePolicy.siteURL(tab.url) && !ArchivePolicy.siteURL(tab.url, 'profile')) throw e;
        await dom(tabId, {
          op: 'profile',
        });
      }
      await ctx.api.sleep(
        Math.max(0, ctx.run.lastNavigate + ctx.run.C.interval * 1000 - Date.now()),
      );
      await ctx.api.guard();
      ctx.api.log('浏览器后退未恢复主页；将按原主页地址恢复一次。已找到的链接已保留。');
      ctx.run.lastNavigate = Date.now();
      await chrome.tabs.update(tabId, {
        url: profileURL,
        active: false,
      });
      await waitLoaded(tabId, profileURL, 'profile');
    }
    // A full reload may initially contain only the first batch. Replay scrolling, boundedly.
    let snap;
    for (let attempt = 0; attempt < 30; attempt++) {
      await ctx.api.guard();
      await dom(tabId, {
        op: 'restore',
        y,
      });
      await ctx.api.sleep(350);
      snap = await dom(tabId, {
        op: 'profile',
      });
      if (ArchivePolicy.siteURL(snap.pageURL, 'profile') !== profileURL)
        throw new ctx.NavigationMismatch('恢复列表时页面再次离开主页；已保留链接，请检查任务网页');
      if (snap.y >= y - 5) return;
    }
    throw Error('主页已恢复，但滚动位置未能恢复。已保留找到的链接；请检查列表后手动继续。');
  }
  async function resolveCard(tabId, key, profileURL, remember = async () => {}) {
    await ctx.api.sleep(Math.max(0, ctx.run.lastNavigate + ctx.run.C.interval * 1000 - Date.now()));
    await ctx.api.guard();
    ctx.run.lastNavigate = Date.now();
    const known = new Set((await chrome.tabs.query({})).map((t) => t.id));
    let click;
    try {
      const r = await chrome.scripting.executeScript({
        target: {
          tabId,
        },
        world: 'MAIN',
        func: clickProfileCard,
        args: [key],
      });
      click = r[0]?.result || {
        clicked: true,
        y: 0,
      };
    } catch (e) {
      if (
        !/Frame.*removed|frame.*removed|Execution context.*destroyed|Frame.*not found/i.test(
          e.message,
        )
      )
        throw e;
      click = {
        clicked: true,
        y: 0,
      };
    }
    if (!click.clicked) return null;
    if (click.captured) {
      await remember(click.captured);
      return click.captured;
    }
    const end = Date.now() + 5000;
    let result = null,
      moved = false,
      spawned = null;
    while (Date.now() < end) {
      await ctx.api.guard();
      const self = await chrome.tabs.get(tabId);
      result = ArchivePolicy.siteURL(self.url);
      if (result && self.status === 'complete') {
        moved = true;
        break;
      }
      if (self.status !== 'complete') {
        await ctx.api.sleep(150);
        continue;
      }
      const child = (await chrome.tabs.query({})).find(
        (t) =>
          !known.has(t.id) &&
          t.openerTabId === tabId &&
          ArchivePolicy.siteURL(t.url || t.pendingUrl),
      );
      if (child) {
        result = ArchivePolicy.siteURL(child.url || child.pendingUrl);
        spawned = child.id;
        break;
      }
      let current;
      try {
        current = await dom(tabId, {
          op: 'profile',
        });
      } catch (e) {
        if (
          /Frame.*removed|frame.*removed|Execution context.*destroyed|Frame.*not found/i.test(
            e.message,
          )
        ) {
          await ctx.api.sleep(150);
          continue;
        }
        throw e;
      }
      if (current.pageURL !== profileURL && ArchivePolicy.siteURL(current.pageURL)) {
        result = ArchivePolicy.siteURL(current.pageURL);
        moved = true;
        break;
      }
      await ctx.api.sleep(200);
    }
    if (result) await remember(result);
    if (spawned) {
      await chrome.tabs.remove(spawned);
    }
    if (moved) {
      await restoreProfile(tabId, profileURL, click.y);
    }
    return result;
  }
  return { dom, tabFor, waitLoaded, restoreProfile, resolveCard };
};

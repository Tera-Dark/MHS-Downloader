(() => {
  if (document.getElementById('artwork-archive-float')) return;
  const host = document.createElement('div');
  host.id = 'artwork-archive-float';
  host.style.cssText =
    'position:fixed;right:18px;top:150px;z-index:2147483646;width:48px;color-scheme:light';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{font:13px/1.6 system-ui,sans-serif;color:#244637;text-align:left}
    *{box-sizing:border-box}button{font:inherit;cursor:pointer;border:1px solid #cedcc4;border-radius:9px;padding:8px 10px;background:#fffef8;color:#315b43}button:hover{background:#edf3e6}button:focus-visible,input:focus-visible{outline:3px solid #e8b17d;outline-offset:2px}button:disabled{opacity:.5;cursor:default}
    #launcher{width:48px;height:48px;padding:9px;background:#315b43;color:white;border-radius:16px;box-shadow:0 3px 14px #18352733;touch-action:none}svg{width:27px;height:27px;display:block}
    #badge{position:absolute;right:-4px;top:-5px;min-width:17px;border-radius:9px;background:#eeb27c;color:#254736;font-size:10px;padding:0 3px;pointer-events:none}
    #panel{position:absolute;right:0;top:56px;width:min(310px,calc(100vw - 24px));background:#faf9f1;border:1px solid #d7dfce;border-radius:16px;padding:15px;box-shadow:0 10px 35px #132f2929;max-height:calc(100vh - 90px);overflow:auto}
    [hidden]{display:none!important}.head{display:flex;gap:8px;align-items:center}.head strong{flex:1;font-size:15px}#drag{touch-action:none;cursor:move;padding:3px 8px;color:#70886b}.head button{padding:3px 8px}p{margin:9px 0;color:#647b60;font-size:12px}.actions{display:grid;gap:7px}.primary{background:#315b43;color:white}.primary:hover{background:#244637}.row{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}.row button{flex:1;font-size:12px}label{display:flex;gap:8px;font-size:12px;padding:9px;background:#edf2e5;border-radius:8px;margin:10px 0}input{margin-top:4px;accent-color:#315b43}#progress{padding:9px;background:#e6efde;border-radius:8px;white-space:pre-line}#message{color:#765130;overflow-wrap:anywhere}#reset,#hide{border:0;background:transparent;text-decoration:underline;padding:3px}
  </style>
  <button id="launcher" aria-label="画页存档：打开收集面板，可拖动" title="画页存档 · 点击展开，拖动移位" aria-expanded="false"><svg viewBox="0 0 32 32" aria-hidden="true"><rect x="7" y="3" width="20" height="22" rx="3" fill="#e0eacf"/><path d="M9 18l6-7 5 5 4-3 2 8H9" fill="#72997b"/><circle cx="22" cy="9" r="3" fill="#edb07b"/><path d="M3 20h10l3 3h13v6H3z" fill="#fff9e6"/></svg></button><span id="badge" hidden></span>
  <section id="panel" aria-label="画页存档收集面板" hidden>
    <div class="head"><span id="drag" title="拖动移动面板">⠿</span><strong>画页存档</strong><button id="close" aria-label="收起面板">×</button></div>
    <p id="description"></p><div id="progress" role="status">未运行任务</div>
    <div id="profileActions"><label><input id="consent" type="checkbox"><span>已确认该画师作品的获取方式与本次使用获得许可。</span></label><div class="actions"><button id="collect" class="primary">后台收集作品链接</button><button id="download">后台收集并下载 ZIP</button></div><details><summary>只要图片直链？</summary><button id="links">后台收集并解析直链</button><p>只解析地址，不保存图片文件；完成后到工作台导出 TXT。</p></details><p>不滚动或跳转你当前的页面。任务页会在后台打开，请勿关闭工作台或任务页。沿用工作台速度与作品上限；部分结果需到工作台确认，不会直接下载。</p></div>
    <button id="add" class="primary" hidden>添加此作品到工作台</button>
    <p id="message" role="status"></p><div class="row"><button id="open">打开工作台</button><button id="stop" disabled>停止本轮</button></div>
    <div class="row"><button id="reset">重置位置</button><button id="hide">本页隐藏</button></div>
  </section>`;
  const $ = (id) => root.getElementById(id);
  let opened = false,
    hidden = false,
    pending = false,
    view = {},
    hold = null,
    position = null,
    lastPath = '',
    dragged = false;
  const phases = {
    idle: '未运行任务',
    working: '正在准备',
    scroll: '后台滚动收集',
    resolve: '解析无链接卡片',
    download: '后台下载',
    links: '后台解析图片直链',
    complete: '本轮已完成',
    partial: '部分完成，请到工作台核对',
    error: '任务已停止，请到工作台查看原因',
    paused: '已停止，已保存内容保留',
    closed: '工作台已关闭，任务未继续',
  };
  function place() {
    const x = position ? position.x * innerWidth : innerWidth - 66;
    const y = position ? position.y * innerHeight : 150;
    host.style.right = 'auto';
    host.style.left = Math.max(8, Math.min(innerWidth - 56, x)) + 'px';
    host.style.top = Math.max(8, Math.min(innerHeight - (opened ? 110 : 56), y)) + 'px';
    const panelWidth = Math.min(310, innerWidth - 24);
    const left = parseFloat(host.style.left),
      top = parseFloat(host.style.top);
    const panelLeft = Math.max(8, Math.min(innerWidth - panelWidth - 8, left + 48 - panelWidth));
    $('panel').style.right = 'auto';
    $('panel').style.left = panelLeft - left + 'px';
    const height = $('panel').getBoundingClientRect().height || Math.min(520, innerHeight - 90);
    const panelTop = Math.max(8, Math.min(innerHeight - height - 8, top + 56));
    $('panel').style.top = panelTop - top + 'px';
  }
  function setOpen(value, restoreFocus = false) {
    opened = value;
    $('panel').hidden = !value;
    $('launcher').setAttribute('aria-expanded', String(value));
    place();
    if (!value && restoreFocus) $('launcher').focus({ preventScroll: true });
  }
  function update() {
    const profile = /^\/(users\/[^/]+|profiles\/\d+)\/?$/.test(location.pathname);
    const art = /^\/artworks\/\d+\/?$/.test(location.pathname);
    host.style.display = !hidden && (profile || art) ? 'block' : 'none';
    if (lastPath !== location.pathname) {
      $('consent').checked = false;
      $('message').textContent = '';
      lastPath = location.pathname;
    }
    $('profileActions').hidden = !profile;
    $('add').hidden = !art;
    $('description').textContent = profile
      ? '在后台整理此画师的公开作品，你可以继续浏览。'
      : '将当前详情页加入队列，再在工作台预览或下载。';
    $('progress').textContent =
      (phases[view.phase] || '未运行任务') +
      (view.busy || view.collected
        ? `\n已收集 ${view.collected || 0}${Number.isFinite(view.total) ? ' / ' + view.total : ''} 件 · 队列已下载 ${view.completed || 0} 件`
        : '');
    $('badge').hidden = !view.busy;
    $('badge').textContent = view.collected || '…';
    for (const id of ['collect', 'download', 'links'])
      $(id).disabled = pending || view.busy || !!hold || !$('consent').checked;
    $('stop').disabled = pending || !view.busy;
    if (hold)
      $('progress').textContent =
        '访问保护暂停（' + hold.code + '）。请到工作台查看等待时间并人工确认。';
  }
  async function send(type, extra = {}) {
    pending = true;
    update();
    try {
      const result = await chrome.runtime.sendMessage({ type, ...extra });
      if (!result?.ok) throw Error(result?.error || '工作台没有响应，请打开工作台检查');
      $('message').textContent =
        type === 'START_PROFILE'
          ? `已启动后台任务：本轮上限 ${result.limit || 500} 件，页面间隔 ${result.interval || 2} 秒。可收起面板继续浏览。`
          : type === 'STOP_RUN'
            ? '已请求停止，正在收尾。'
            : '已打开工作台。';
      if (type === 'START_PROFILE') $('consent').checked = false;
    } catch (e) {
      $('message').textContent = /context invalidated|Receiving end/i.test(e.message)
        ? '扩展已更新，请刷新当前网页。'
        : e.message;
    } finally {
      pending = false;
      update();
    }
  }
  $('launcher').onclick = () => {
    if (!dragged) setOpen(!opened);
  };
  $('close').onclick = () => setOpen(false, true);
  $('consent').onchange = update;
  $('collect').onclick = (e) => {
    if (e.isTrusted && $('consent').checked) send('START_PROFILE', { consent: true });
  };
  $('download').onclick = (e) => {
    if (e.isTrusted && $('consent').checked)
      send('START_PROFILE', { consent: true, download: true });
  };
  $('links').onclick = (e) => {
    if (e.isTrusted && $('consent').checked) send('START_PROFILE', { consent: true, links: true });
  };
  $('add').onclick = () => send('ADD_PAGE');
  $('open').onclick = () => send('OPEN_MANAGER');
  $('stop').onclick = () => send('STOP_RUN');
  $('hide').onclick = () => {
    hidden = true;
    update();
  };
  $('reset').onclick = () => {
    position = null;
    chrome.storage.local.remove('overlayPosition').catch(() => {});
    place();
  };
  for (const el of [$('launcher'), $('drag')]) {
    let start = null;
    el.onpointerdown = (e) => {
      if (e.button !== 0) return;
      start = {
        x: e.clientX,
        y: e.clientY,
        left: host.getBoundingClientRect().left,
        top: host.getBoundingClientRect().top,
      };
      dragged = false;
      el.setPointerCapture(e.pointerId);
    };
    el.onpointermove = (e) => {
      if (!start) return;
      const dx = e.clientX - start.x,
        dy = e.clientY - start.y;
      if (!dragged && Math.hypot(dx, dy) < 6) return;
      dragged = true;
      position = {
        x: Math.max(8, Math.min(innerWidth - 56, start.left + dx)) / innerWidth,
        y: Math.max(8, Math.min(innerHeight - 56, start.top + dy)) / innerHeight,
      };
      place();
    };
    el.onpointerup = () => {
      start = null;
      if (dragged) chrome.storage.local.set({ overlayPosition: position }).catch(() => {});
      setTimeout(() => {
        dragged = false;
      }, 0);
    };
    el.onpointercancel = () => {
      start = null;
      dragged = false;
    };
  }
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false, true);
  });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (opened && !e.composedPath().includes(host)) setOpen(false);
    },
    true,
  );
  window.addEventListener('resize', place);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.accessHold) {
      hold = changes.accessHold.newValue || null;
      update();
    }
    if (area === 'local' && changes.runView) {
      view = changes.runView.newValue || {};
      update();
    }
  });
  chrome.storage.local
    .get(['overlayPosition', 'runView', 'accessHold'])
    .then((data) => {
      const p = data.overlayPosition;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y))
        position = { x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) };
      view = data.runView || {};
      hold = data.accessHold || null;
      place();
      update();
    })
    .catch(() => {});
  document.documentElement.append(host);
  place();
  update();
  setInterval(update, 1500);
})();

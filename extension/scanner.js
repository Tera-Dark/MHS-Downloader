// Serialized into the site's isolated world: DOM only, no API requests or hidden app state.
function pageTask(args = {}) {
  const visible = (e) => {
    const r = e.getBoundingClientRect(),
      s = getComputedStyle(e);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.display !== 'none' &&
      s.visibility !== 'hidden' &&
      s.opacity !== '0'
    );
  };
  const art = (s) => {
    try {
      const u = new URL(s, location.href);
      return u.hostname === 'www.mihuashi.com' && /^\/artworks\/\d+\/?$/.test(u.pathname)
        ? u.origin + u.pathname.replace(/\/$/, '')
        : null;
    } catch {
      return null;
    }
  };
  const body = document.body?.innerText || '';
  const terms = [
    '请完成验证',
    '请先完成验证',
    '拖动滑块',
    '安全验证',
    '访问过于频繁',
    '操作过于频繁',
    '访问受限',
    '登录后查看',
    '登录后可查看',
    '请先登录',
  ];
  let blocked = terms.find((x) => body.includes(x)) || '';
  const dialogs = [
    ...document.querySelectorAll('[role="dialog"],.el-dialog,.mhs-dialog,.modal'),
  ].filter(visible);
  if (dialogs.some((e) => /验证码|手机登录|扫码登录|短信登录/.test(e.innerText)))
    blocked = blocked || '登录或验证弹窗';
  const base = { pageURL: location.href, title: document.title, blocked };
  if (blocked) return base;
  function thumbKey(im) {
    try {
      const u = new URL(im.currentSrc || im.src);
      return u.origin + u.pathname;
    } catch {
      return im.src || '';
    }
  }
  function cardImages() {
    return [...document.images].filter(
      (im) =>
        visible(im) &&
        (/!artwork\.square/.test(im.currentSrc || im.src) ||
          im.closest('.user-artwork__image,.user-artwork,[data-artwork-id]')),
    );
  }
  function scroller() {
    const im = cardImages()[0];
    let e = im?.parentElement;
    while (e && e !== document.body) {
      const s = getComputedStyle(e);
      if (/auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 50) return e;
      e = e.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  if (args.op === 'scroll') {
    const el = scroller();
    el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.max(400, el.clientHeight * 0.85));
    return {
      ...base,
      y: el.scrollTop,
      height: el.scrollHeight,
      viewport: el.clientHeight,
      bottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 5,
    };
  }
  if (args.op === 'restore') {
    const el = scroller();
    el.scrollTop = args.y || 0;
    return { ...base, y: el.scrollTop };
  }
  if (args.op === 'click') {
    const im = cardImages().find((im) => thumbKey(im) === args.key);
    if (!im) return { ...base, clicked: false };
    im.scrollIntoView({ block: 'center' });
    const el = scroller();
    const y = el.scrollTop;
    im.click();
    return { ...base, clicked: true, y };
  }
  if (args.op === 'profile') {
    const cards = [],
      seen = new Set();
    for (const im of cardImages()) {
      const key = thumbKey(im);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const container =
        im.closest('.user-artwork,[data-artwork-id],a') ||
        im.parentElement?.parentElement ||
        im.parentElement;
      let href = art(im.closest('a')?.href);
      if (!href)
        for (const a of container?.querySelectorAll('a[href]') || []) {
          href = art(a.href);
          if (href) break;
        }
      if (!href && container) {
        for (const attr of ['data-artwork-url', 'data-work-url']) {
          href = art(container.getAttribute(attr));
          if (href) break;
        }
        const id = container.getAttribute('data-artwork-id');
        if (!href && /^\d+$/.test(id || '')) href = location.origin + '/artworks/' + id;
      }
      cards.push({ key, url: href, thumb: im.currentSrc || im.src });
    }
    const links = [
      ...new Set(
        [...document.querySelectorAll('a[href]')]
          .filter(visible)
          .map((a) => art(a.href))
          .filter(Boolean),
      ),
    ];
    const el = scroller(),
      m = body.match(/精选作品\s*(\d+)/);
    return {
      ...base,
      cards,
      links,
      expected: m ? Number(m[1]) : null,
      y: el.scrollTop,
      height: el.scrollHeight,
      viewport: el.clientHeight,
      bottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 5,
    };
  }
  const candidates = new Map();
  for (const im of document.images) {
    if (!visible(im) || !im.complete) continue;
    const r = im.getBoundingClientRect(),
      w = im.naturalWidth,
      h = im.naturalHeight;
    if (w < 400 || h < 400 || w * h < 360000 || w * h > 64000000 || r.width < 150 || r.height < 150)
      continue;
    if (
      /avatar|badge|logo|qrcode|二维码|头像/i.test(
        [im.className, im.alt, im.parentElement?.className].join(' '),
      )
    )
      continue;
    const src = im.currentSrc || im.src;
    let u;
    try {
      u = new URL(src);
    } catch {
      continue;
    }
    if (
      u.protocol !== 'https:' ||
      !['image-assets.mihuashi.com', 'www.mihuashi.com'].includes(u.hostname)
    )
      continue;
    if (/!artwork\.square|!avatar\.|\/misc\//.test(src)) continue;
    const auxiliary = !!im.closest(
      'aside,footer,[class*="recommend"],[class*="related"],[class*="suggest"]',
    );
    if (auxiliary) continue;
    candidates.set(u.href, {
      url: u.href,
      width: w,
      height: h,
      kind: 'detail_display',
      alt: (im.alt || '').slice(0, 100),
    });
  }
  return {
    ...base,
    images: [...candidates.values()]
      .sort((a, b) => b.width * b.height - a.width * a.height)
      .slice(0, 30),
  };
}
// A narrowly scoped navigation capture: some cards synchronously call window.open.
// Record that public artwork URL instead of opening a popup. Restore immediately.
// No app internals, credentials or network response bodies are read.
function clickProfileCard(key) {
  const im = [...document.images].find((x) => {
    try {
      const u = new URL(x.currentSrc || x.src);
      return u.origin + u.pathname === key;
    } catch {
      return false;
    }
  });
  if (!im) return { clicked: false };
  im.scrollIntoView({ block: 'center' });
  let el = im.parentElement;
  while (el && el !== document.body) {
    const s = getComputedStyle(el);
    if (/auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 50) break;
    el = el.parentElement;
  }
  el = el && el !== document.body ? el : document.scrollingElement || document.documentElement;
  const y = el.scrollTop,
    original = window.open;
  let captured = null,
    installed = false;
  const wrapper = function (url, ...args) {
    try {
      const u = new URL(url, location.href);
      if (u.hostname === 'www.mihuashi.com' && /^\/artworks\/\d+\/?$/.test(u.pathname)) {
        captured = u.origin + u.pathname.replace(/\/$/, '');
        return null;
      }
    } catch {}
    return original.call(window, url, ...args);
  };
  try {
    try {
      window.open = wrapper;
      installed = window.open === wrapper;
    } catch {}
    im.click();
  } finally {
    if (installed && window.open === wrapper) window.open = original;
  }
  return { clicked: true, y, captured };
}

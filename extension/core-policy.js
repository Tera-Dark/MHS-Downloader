// Pure boundary rules; shared by the collector and tests.
(function (root) {
  function siteURL(value, kind = 'artwork') {
    try {
      const u = new URL(value);
      const path =
        kind === 'profile' ? /^\/(users\/[^/]+|profiles\/\d+)\/?$/ : /^\/artworks\/\d+\/?$/;
      return u.protocol === 'https:' &&
        u.hostname === 'www.mihuashi.com' &&
        !u.port &&
        !u.username &&
        !u.password &&
        path.test(u.pathname)
        ? u.origin + u.pathname.replace(/\/$/, '')
        : null;
    } catch {
      return null;
    }
  }
  function imageURL(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        !u.port &&
        ['www.mihuashi.com', 'image-assets.mihuashi.com'].includes(u.hostname) &&
        !/!artwork\.square|!avatar\./.test(u.href)
        ? u.href
        : null;
    } catch {
      return null;
    }
  }
  function retryUntil(value, now = Date.now()) {
    const text = String(value || '').trim();
    const seconds = /^\d+$/.test(text) ? Number(text) : NaN;
    const until = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(text);
    // Never shorten a server-specified valid delay; invalid/missing values use at least 60 seconds.
    return Number.isFinite(until) ? Math.max(now + 60000, until) : now + 60000;
  }
  root.ArchivePolicy = {siteURL,imageURL,retryUntil};
})(globalThis);

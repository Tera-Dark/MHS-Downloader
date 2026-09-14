// Pure boundary rules; shared by the workbench, service worker and tests.
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
  function downloadMatches(download, record, extensionId) {
    if (record.imported || !download || download.id !== record.download_id) return false;
    if (download.byExtensionId && download.byExtensionId !== extensionId) return false;
    if (record.download_url) return download.url === record.download_url;
    // Native recovery requires both origin URL and the expected filename (including uniquify suffix).
    if (
      record.location !== 'native' ||
      !imageURL(record.image_url) ||
      download.url !== record.image_url
    )
      return false;
    const base = String(record.saved_basename || record.relative_filename || '')
      .split(/[\\/]/)
      .pop();
    const actual = String(download.filename || '')
      .split(/[\\/]/)
      .pop();
    if (!base) return false;
    if (actual === base) return true;
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dot = escaped.lastIndexOf('\\.');
    return (
      dot > 0 &&
      new RegExp('^' + escaped.slice(0, dot) + ' \\(\\d+\\)' + escaped.slice(dot) + '$').test(
        actual,
      )
    );
  }
  function journalMatches(d, r, extensionId) {
    if (!r.requested_at) return downloadMatches(d, r, extensionId); // Older records still require ID and URL ownership.
    if (
      r.imported ||
      !d ||
      d.byExtensionId !== extensionId ||
      (Number.isInteger(r.download_id) && d.id !== r.download_id)
    )
      return false;
    const at = Date.parse(d.startTime),
      requested = Date.parse(r.requested_at);
    if (
      !Number.isFinite(at) ||
      !Number.isFinite(requested) ||
      at < requested - 5000 ||
      at > requested + 180000
    )
      return false;
    const expected = r.download_url || (r.location === 'native' && imageURL(r.image_url));
    if (!expected || d.url !== expected) return false;
    const base = String(r.filename || r.relative_filename || '')
      .split(/[\\/]/)
      .pop();
    const actual = String(d.filename || '')
      .split(/[\\/]/)
      .pop();
    if (!base) return false;
    if (base === actual) return true;
    const dot = base.lastIndexOf('.');
    return (
      dot > 0 &&
      actual.startsWith(base.slice(0, dot) + ' (') &&
      actual.endsWith(base.slice(dot)) &&
      /^ \(\d+\)$/.test(actual.slice(dot, actual.length - base.slice(dot).length))
    );
  }
  function normalizeTask(raw, uuid = () => crypto.randomUUID()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const url = siteURL(raw.url || raw.artwork_url);
    if (!url) return null;
    const files = (Array.isArray(raw.files) ? raw.files : [])
      .filter((f) => f && f.status === 'complete' && imageURL(f.image_url))
      .slice(0, 300)
      .map((f) => ({
        ...f,
        imported: true,
        record_id: typeof f.record_id === 'string' ? f.record_id : uuid(),
        location: f.location === 'zip' ? 'zip' : 'native',
      }));
    const candidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
      .filter(
        (c) =>
          c &&
          c.kind === 'detail_display' &&
          imageURL(c.url) &&
          Number.isFinite(c.width) &&
          Number.isFinite(c.height) &&
          c.width >= 400 &&
          c.height >= 400 &&
          c.width * c.height >= 360000 &&
          c.width * c.height <= 64000000,
      )
      .slice(0, 30)
      .map((c) => ({
        url: imageURL(c.url),
        kind: 'detail_display',
        width: c.width,
        height: c.height,
      }));
    const expected = (Array.isArray(raw.expected) ? raw.expected : [])
      .filter(imageURL)
      .slice(0, 300);
    const done =
      raw.status === 'done' &&
      files.length > 0 &&
      (!expected.length || expected.every((url) => files.some((f) => f.image_url === url)));
    return {
      id: url.split('/').pop(),
      url,
      artist: String(raw.artist || '').slice(0, 80),
      profile: siteURL(raw.profile || raw.profile_url, 'profile'),
      status: done ? 'done' : candidates.length ? 'ready' : 'queued',
      files,
      candidates,
      expected,
      observedAt: typeof raw.observedAt === 'string' ? raw.observedAt : undefined,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    };
  }
  function reusable(task, now = Date.now()) {
    const at = Date.parse(task.observedAt);
    return (
      task.status === 'ready' &&
      at <= now &&
      now - at < 600000 &&
      task.candidates?.length > 0 &&
      task.candidates.every((c) => c.kind === 'detail_display' && imageURL(c.url))
    );
  }
  root.ArchivePolicy = {
    journalMatches,
    siteURL,
    imageURL,
    retryUntil,
    downloadMatches,
    normalizeTask,
    reusable,
  };
})(globalThis);

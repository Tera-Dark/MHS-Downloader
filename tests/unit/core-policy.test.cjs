const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = { URL, Date };
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(require('node:path').join(__dirname, '../../extension/core-policy.js'), 'utf8'),
  context,
);
const P = context.ArchivePolicy;
test('central URL rules reject credentials, ports and thumbnails', () => {
  assert.equal(P.siteURL('https://u:p@www.mihuashi.com/artworks/1'), null);
  assert.equal(P.imageURL('https://image-assets.mihuashi.com:444/a.png'), null);
  assert.equal(P.imageURL('https://image-assets.mihuashi.com/a.png!artwork.square'), null);
  assert.equal(
    P.siteURL('https://www.mihuashi.com/artworks/1?x=1'),
    'https://www.mihuashi.com/artworks/1',
  );
});
test('Retry-After accepts seconds and HTTP dates, never schedules an automatic retry', () => {
  const now = Date.UTC(2026, 8, 14);
  assert.equal(P.retryUntil('120', now), now + 120000);
  assert.equal(P.retryUntil(new Date(now + 180000).toUTCString(), now), now + 180000);
  for (const invalid of ['', '-5', 'bad', '0'])
    assert.equal(P.retryUntil(invalid, now), now + 60000);
});
test('download ID alone cannot confirm or cancel an unrelated download', () => {
  const d = {
    id: 7,
    url: 'blob:extension/other',
    filename: '/tmp/archive.zip',
    byExtensionId: 'ours',
  };
  assert.equal(P.downloadMatches(d, { download_id: 7, filename: 'archive.zip' }, 'ours'), false);
  assert.equal(
    P.downloadMatches(d, { download_id: 7, download_url: 'blob:extension/ours' }, 'ours'),
    false,
  );
  assert.equal(P.downloadMatches(d, { download_id: 7, download_url: d.url }, 'ours'), true);
  assert.equal(
    P.downloadMatches(d, { download_id: 7, download_url: d.url, imported: true }, 'ours'),
    false,
  );
  assert.equal(
    P.downloadMatches(
      { ...d, byExtensionId: 'another' },
      { download_id: 7, download_url: d.url },
      'ours',
    ),
    false,
  );
});
test('native recovery also matches original URL and filename including browser uniquify', () => {
  const r = {
    download_id: 4,
    location: 'native',
    image_url: 'https://image-assets.mihuashi.com/a.png',
    relative_filename: 'folder/a.png',
  };
  assert.equal(
    P.downloadMatches({ id: 4, url: r.image_url, filename: '/tmp/a (1).png' }, r, 'ours'),
    true,
  );
  assert.equal(
    P.downloadMatches({ id: 4, url: r.image_url, filename: '/tmp/private.png' }, r, 'ours'),
    false,
  );
});
test('import normalizes malformed entries and preserves valid resolved candidates', () => {
  assert.equal(P.normalizeTask(null), null);
  assert.equal(P.normalizeTask('bad'), null);
  const raw = {
    url: 'https://www.mihuashi.com/artworks/12',
    status: 'done',
    files: [null],
    candidates: [
      {
        kind: 'detail_display',
        url: 'https://image-assets.mihuashi.com/a.png',
        width: 1000,
        height: 1000,
      },
      null,
    ],
  };
  const t = P.normalizeTask(raw, () => 'uuid');
  assert.equal(t.status, 'ready');
  assert.equal(t.candidates.length, 1);
  assert.equal(t.files.length, 0);
  assert.equal(P.normalizeTask({ ...raw, candidates: [] }, () => 'uuid').status, 'queued');
});
test('reuse only freshly observed ready candidates and reject future or expired observations', () => {
  const now = Date.now();
  const t = {
    status: 'ready',
    observedAt: new Date(now - 1000).toISOString(),
    candidates: [{ kind: 'detail_display', url: 'https://image-assets.mihuashi.com/a.png' }],
  };
  assert.equal(P.reusable(t, now), true);
  assert.equal(P.reusable({ ...t, observedAt: new Date(now - 600001).toISOString() }, now), false);
  assert.equal(P.reusable({ ...t, observedAt: new Date(now + 1000).toISOString() }, now), false);
});

test('write-ahead journal recovers an ID gap only with extension, URL, UUID filename and time ownership', () => {
  const r = {
    download_url: 'blob:unique',
    filename: 'Folder/Archive_uuid.zip',
    requested_at: '2026-09-14T10:00:00Z',
  };
  const d = {
    id: 42,
    byExtensionId: 'self',
    url: 'blob:unique',
    filename: '/downloads/Folder/Archive_uuid.zip',
    startTime: '2026-09-14T10:00:01Z',
  };
  assert.equal(P.journalMatches(d, r, 'self'), true);
  for (const patch of [
    { byExtensionId: undefined },
    { byExtensionId: 'foreign' },
    { url: 'blob:other' },
    { filename: '/downloads/other.zip' },
    { startTime: '2026-09-14T11:00:00Z' },
  ])
    assert.equal(P.journalMatches({ ...d, ...patch }, r, 'self'), false);
  assert.equal(P.journalMatches(d, { ...r, imported: true }, 'self'), false);
  assert.equal(P.journalMatches(d, { ...r, download_id: 99 }, 'self'), false);
  assert.equal(
    P.journalMatches({ ...d, filename: '/downloads/Archive_uuid (1).zip' }, r, 'self'),
    true,
  );
});

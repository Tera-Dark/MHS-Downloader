const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ctx = { URL };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../extension/ui-model.js'), 'utf8'), ctx);
const U = ctx.ArchiveUI;
const plain = (x) => JSON.parse(JSON.stringify(x));
test('recognizes pasted share text and removes duplicate artwork links', () => {
  const parsed = plain(
    U.parseInput(
      '分享 [https://www.mihuashi.com/artworks/123](https://www.mihuashi.com/artworks/123)\n mihuashi.com/artworks/456',
    ),
  );
  assert.deepEqual(parsed, {
    profiles: [],
    artworks: ['https://www.mihuashi.com/artworks/123', 'https://www.mihuashi.com/artworks/456'],
  });
});
test('normalizes profiles, HTTPS, Unicode and tracking queries', () => {
  const parsed = plain(U.parseInput('http://mihuashi.com/users/测试画师?source=share'));
  assert.deepEqual(parsed.profiles, [
    'https://www.mihuashi.com/users/%E6%B5%8B%E8%AF%95%E7%94%BB%E5%B8%88',
  ]);
  assert.deepEqual(plain(U.parseInput('https://www.mihuashi.com/profiles/42/')).profiles, [
    'https://www.mihuashi.com/profiles/42',
  ]);
});
test('does not turn unrelated or credential-bearing hosts into official links', () => {
  for (const input of [
    'https://evil-mihuashi.com/users/abc',
    'https://user@www.mihuashi.com/artworks/1',
    'https://www.mihuashi.com.evil.test/artworks/1',
    'javascript:alert(1)',
    'https://www.mihuashi.com:8443/users/a',
  ])
    assert.equal(
      U.parseInput(input).artworks.length + U.parseInput(input).profiles.length,
      0,
      input,
    );
});
test('presets map to exact settings without changing scope or filenames', () => {
  assert.equal(U.presetFor({ interval: 2, concurrency: 2, volumeMB: 128 }), 'recommended');
  assert.equal(U.presetFor({ interval: 5, concurrency: 1, volumeMB: 64 }), 'gentle');
  assert.equal(U.presetFor({ interval: 1, concurrency: 3, volumeMB: 128 }), 'faster');
  assert.equal(U.presetFor({ interval: 7, concurrency: 2, volumeMB: 128 }), 'custom');
  for (const preset of Object.values(U.PRESETS))
    assert.deepEqual(
      Object.keys(preset).sort(),
      ['concurrency', 'interval', 'label', 'volumeMB'].sort(),
    );
});
test('classifies actual HTTP restrictions without mistaking artwork IDs for status codes', () => {
  assert.equal(U.classifyError('任务页返回 HTTP 403').code, 'HTTP_403');
  assert.equal(U.classifyError('图片直连返回 HTTP 429').code, 'HTTP_429');
  assert.equal(U.classifyError('HTTP 401').code, 'AUTH');
  assert.equal(U.classifyError('作品 35401121 未找到大图').code, 'NO_IMAGE');
  assert.equal(U.classifyError('已手动停止本轮').code, 'PAUSED');
});
test('filters and paginates every task, not only the first 250', () => {
  const tasks = Array.from({ length: 311 }, (_, i) => ({
    id: String(i),
    artist: i === 310 ? 'Find me' : 'Demo',
    status: i % 2 ? 'done' : 'queued',
    url: `https://www.mihuashi.com/artworks/${i}`,
  }));
  assert.equal(U.filterTasks(tasks, 'done').length, 155);
  assert.equal(U.filterTasks(tasks, 'all', 'find me')[0].id, '310');
  const last = U.paginate(tasks, 999, 25);
  assert.equal(last.page, 12);
  assert.equal(last.items.at(-1).id, '310');
  assert.equal(last.pages, 13);
  assert.equal(U.paginate([], 0, 25).pages, 1);
  assert.equal(U.paginate(tasks, -1, 50).page, 0);
});
test('diagnostics exclude private input, URLs, paths and full errors', () => {
  const state = {
    tasks: [
      {
        id: '98765',
        artist: 'PRIVATE_ARTIST',
        url: 'https://private.invalid/artworks/98765',
        files: [{ image_url: 'https://secret.invalid/a.png', local_path: 'C:\\Private\\file.png' }],
        status: 'error',
      },
    ],
    settings: {
      artist: 'PRIVATE_ARTIST',
      profile: 'https://private.invalid',
      note: 'SECRET_NOTE',
      folder: 'PRIVATE_FOLDER',
      mode: 'zip',
      interval: 2,
      concurrency: 2,
      volumeMB: 128,
    },
    logs: [{ error: true, message: 'HTTP 403 https://private.invalid PRIVATE_ARTIST SECRET_NOTE' }],
    scans: [{ profile_url: 'https://private.invalid' }],
  };
  const serialized = JSON.stringify(
    U.diagnostics(state, '0.3.0', 'Mozilla Windows Chrome/150.0.0.0'),
  );
  for (const secret of [
    'PRIVATE_ARTIST',
    '98765',
    'private.invalid',
    'secret.invalid',
    'SECRET_NOTE',
    'PRIVATE_FOLDER',
    'C:\\Private',
  ])
    assert(!serialized.includes(secret), secret);
  assert(serialized.includes('HTTP_403'));
  assert(serialized.includes('Windows'));
  assert.equal(
    U.diagnostics(
      { settings: { mode: 'https://secret.invalid', interval: { secret: 'secret' } } },
      '0.3.0',
    ).settings.mode,
    'unknown',
  );
});

test('navigation failures are not reported as login failures', () => {
  assert.equal(U.classifyError('页面没有到达预期地址，已停止').code, 'NAVIGATION');
  assert.equal(U.classifyError('请先从下拉框选择已打开的官网页面').code, 'PAGE_SELECTION');
  assert.equal(U.classifyError('网站要求人工处理：请先登录').code, 'AUTH');
  assert.equal(U.classifyError('HTTP 403；未到达预期地址').code, 'HTTP_403');
});

test('exports only deduplicated allowed detail image URLs, never thumbnails or foreign hosts', () => {
  const url = 'https://image-assets.mihuashi.com/detail.png';
  const links = U.imageLinks([
    {
      candidates: [
        { kind: 'detail_display', url },
        { kind: 'thumbnail', url: 'https://image-assets.mihuashi.com/thumb.png' },
      ],
      files: [
        { image_url: url },
        { image_url: 'https://evil.example/private.png' },
        { image_url: 'https://image-assets.mihuashi.com/a.png!artwork.square' },
        { image_url: 'https://name:password@image-assets.mihuashi.com/a.png' },
      ],
    },
  ]);
  assert.deepEqual(plain(links), [url]);
});

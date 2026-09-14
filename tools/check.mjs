import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ext = resolve(root, 'extension');
const manifest = JSON.parse(readFileSync(resolve(ext, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
assert.equal(manifest.version, pkg.version, 'Package and manifest versions must match');
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(
  [...manifest.permissions].sort(),
  ['downloads', 'scripting', 'storage', 'webRequest'].sort(),
  'Unexpected permission change requires an explicit reviewed test update',
);
assert.deepEqual(
  [...manifest.host_permissions].sort(),
  ['https://www.mihuashi.com/*', 'https://image-assets.mihuashi.com/*'].sort(),
);
for (const name of [
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((x) => x.js),
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  'manager.html',
  'core-policy.js',
  'qol.js',
  'ui-model.js',
  'zip.js',
  'state-store.js',
  'image-service.js',
  'image-codec.js',
  'image-worker.js',
  'lifecycle.js',
  'recovery-service.js',
  'controller.js',
  'scanner.js',
  'help.html',
  'privacy.html',
])
  assert(existsSync(resolve(ext, name)), `Missing ${name}`);
for (const file of readdirSync(ext).filter((f) => f.endsWith('.js'))) {
  const run = spawnSync(process.execPath, ['--check', resolve(ext, file)], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${file}: ${run.stderr}`);
}
for (const file of readdirSync(ext).filter((f) => f.endsWith('.html'))) {
  const text = readFileSync(resolve(ext, file), 'utf8');
  for (const m of text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) {
    assert(!/^https?:/.test(m[1]), 'Remote script prohibited');
    assert(existsSync(resolve(ext, m[1])), `Missing script ${m[1]}`);
  }
  assert(!/<\w+\b[^>]*\son(?:click|load|error)\s*=/i.test(text), 'Inline event handler prohibited');
}
for (const [size, file] of Object.entries(manifest.icons)) {
  const bytes = readFileSync(resolve(ext, file));
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.readUInt32BE(16), Number(size));
  assert.equal(bytes.readUInt32BE(20), Number(size));
}
const scripts = readdirSync(ext)
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(resolve(ext, f), 'utf8'))
  .join('\n');
assert(!/\beval\s*\(|new\s+Function\s*\(/.test(scripts), 'Dynamic code evaluation prohibited');
assert(
  !/ignore-certificate-errors|host-resolver-rules|127\.0\.0\.1|localhost:/.test(scripts),
  'Test routing/config must never enter the release',
);
console.log(
  `Checks passed: v${manifest.version}, manifest, references, permissions, syntax, icons and release boundaries.`,
);

const managerHTML = readFileSync(resolve(ext, 'manager.html'), 'utf8');
const elementIds = new Set([...managerHTML.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
for (const file of readdirSync(ext).filter(
  (f) => f.endsWith('-service.js') || ['manager.js', 'controller.js', 'qol.js'].includes(f),
)) {
  const code = readFileSync(resolve(ext, file), 'utf8');
  for (const match of code.matchAll(/\$\(['"]([\w-]+)['"]\)/g))
    assert(elementIds.has(match[1]), `Missing workbench element ${match[1]} referenced by ${file}`);
}

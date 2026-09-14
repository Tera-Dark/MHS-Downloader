const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ctx = { Blob, TextEncoder, Uint8Array, Uint32Array, DataView };
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '../../extension/zip.js'), 'utf8') +
    '\nglobalThis.Subject=ZipVolume;',
  ctx,
);
const Z = ctx.Subject;
test('CRC-32 matches the standard test vector', () =>
  assert.equal(Z.crc(new TextEncoder().encode('123456789')), 0xcbf43926));
test('rejects path traversal, absolute names and duplicate entries', () => {
  for (const name of ['../x', 'a/../x', '/x', 'a\\b', 'C:/x', 'a//b', ''])
    assert.throws(() => new Z().add(name, new Uint8Array(1)));
  const z = new Z();
  z.add('safe/image.png', new Uint8Array(1));
  assert.throws(() => z.add('safe/image.png', new Uint8Array(1)));
});
test('writes STORE records with UTF-8 names, correct sizes and central directory', async () => {
  const z = new Z(),
    data = new TextEncoder().encode('image fixture'),
    name = '演示画师/test.png';
  z.add(name, data);
  const bytes = new Uint8Array(await z.blob().arrayBuffer()),
    view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x800);
  assert.equal(view.getUint16(8, true), 0);
  assert.equal(view.getUint32(18, true), data.length);
  const nameLength = view.getUint16(26, true);
  assert.equal(new TextDecoder().decode(bytes.slice(30, 30 + nameLength)), name);
  const central = 30 + nameLength + data.length;
  assert.equal(view.getUint32(central, true), 0x02014b50);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 1);
  assert.equal(view.getUint32(end + 16, true), central);
});
test('empty archive has a valid end record', async () => {
  const bytes = await new Z().blob().arrayBuffer();
  assert.equal(bytes.byteLength, 22);
  assert.equal(new DataView(bytes).getUint32(0, true), 0x06054b50);
});

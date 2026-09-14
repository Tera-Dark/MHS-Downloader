const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { createHash, randomBytes } = require('node:crypto');
const ctx = { Uint32Array, Uint8Array, DataView };
vm.createContext(ctx);
vm.runInContext(readFileSync('extension/image-codec.js', 'utf8'), ctx);
const { Hash, dimensions } = ctx.ArchiveCodec;
test('incremental SHA256 matches Node for padding boundaries and multi-megabyte chunks', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000, 4 * 1048576 + 17]) {
    const input = randomBytes(n),
      h = new Hash();
    for (let i = 0; i < n; i += 113) h.update(input.subarray(i, i + 113));
    assert.equal(h.finish().sha256, createHash('sha256').update(input).digest('hex'));
  }
});
test('incremental CRC32 matches the standard vector across chunks', () => {
  const h = new Hash();
  h.update(Buffer.from('1234'));
  h.update(Buffer.from('56789'));
  assert.equal(h.finish().crc32, 0xcbf43926);
});
function png(w, h) {
  const b = Buffer.alloc(24);
  b.set([137, 80, 78, 71, 13, 10, 26, 10]);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
test('header dimensions reject oversized, mismatched and unsupported formats before decoding', () => {
  assert.equal(dimensions(png(1000, 1000), 'image/png').width, 1000);
  assert.throws(() => dimensions(png(100000, 100000), 'image/png'), /3200/);
  assert.throws(() => dimensions(png(8000, 8000), 'image/png'), /3200/);
  assert.throws(() => dimensions(png(1000, 1000), 'image/jpeg'), /预检/);
  assert.throws(() => dimensions(Buffer.alloc(100), 'image/avif'), /预检/);
});
test('JPEG and WebP header parsing uses unsigned dimensions', () => {
  const j = Buffer.from([255, 216, 255, 192, 0, 8, 8, 3, 232, 7, 208, 3]);
  assert.equal(dimensions(j, 'image/jpeg').width, 2000);
  const w = Buffer.alloc(30);
  w.write('RIFF');
  w.write('WEBP', 8);
  w.write('VP8X', 12);
  w.writeUIntLE(999, 24, 3);
  w.writeUIntLE(599, 27, 3);
  assert.equal(dimensions(w, 'image/webp').height, 600);
});

// Bounded header inspection and incremental SHA-256/CRC32. Shared with tests.
(function (root) {
  const K = Uint32Array.from([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  class Hash {
    constructor() {
      this.h = Uint32Array.from([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
      ]);
      this.buffer = new Uint8Array(64);
      this.used = 0;
      this.length = 0;
      this.w = new Uint32Array(64);
      this.crc = 0xffffffff;
    }
    block(b) {
      const w = this.w,
        v = new DataView(b.buffer, b.byteOffset, 64);
      for (let i = 0; i < 16; i++) w[i] = v.getUint32(i * 4);
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15],
          y = w[i - 2];
        w[i] =
          (w[i - 16] +
            (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) +
            w[i - 7] +
            (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))) >>>
          0;
      }
      let [a, bv, c, d, e, f, g, h] = this.h;
      for (let i = 0; i < 64; i++) {
        const t1 =
          (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 =
          ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & bv) ^ (a & c) ^ (bv & c))) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = bv;
        bv = a;
        a = (t1 + t2) >>> 0;
      }
      [a, bv, c, d, e, f, g, h].forEach((n, i) => (this.h[i] = (this.h[i] + n) >>> 0));
    }
    update(bytes) {
      this.length += bytes.length;
      for (const x of bytes) this.crc = table[(this.crc ^ x) & 255] ^ (this.crc >>> 8);
      let i = 0;
      while (i < bytes.length) {
        const n = Math.min(64 - this.used, bytes.length - i);
        this.buffer.set(bytes.subarray(i, i + n), this.used);
        this.used += n;
        i += n;
        if (this.used === 64) {
          this.block(this.buffer);
          this.used = 0;
        }
      }
    }
    finish() {
      const bits = this.length * 8;
      this.buffer[this.used++] = 0x80;
      if (this.used > 56) {
        this.buffer.fill(0, this.used);
        this.block(this.buffer);
        this.used = 0;
      }
      this.buffer.fill(0, this.used);
      const v = new DataView(this.buffer.buffer);
      v.setUint32(56, Math.floor(bits / 4294967296));
      v.setUint32(60, bits >>> 0);
      this.block(this.buffer);
      return {
        sha256: Array.from(this.h, (n) => n.toString(16).padStart(8, '0')).join(''),
        crc32: (this.crc ^ 0xffffffff) >>> 0,
      };
    }
  }
  const table = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function dimensions(b, mime) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const ascii = (a, z) => String.fromCharCode(...b.subarray(a, z));
    let width = 0,
      height = 0,
      actual = '';
    if (b.length >= 24 && ascii(1, 4) === 'PNG' && b[0] === 137 && ascii(12, 16) === 'IHDR') {
      width = v.getUint32(16);
      height = v.getUint32(20);
      actual = 'image/png';
    } else if (b.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
      width = v.getUint16(6, true);
      height = v.getUint16(8, true);
      actual = 'image/gif';
    } else if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
      actual = 'image/webp';
      const tag = ascii(12, 16);
      if (tag === 'VP8X') {
        width = 1 + b[24] + (b[25] << 8) + (b[26] << 16);
        height = 1 + b[27] + (b[28] << 8) + (b[29] << 16);
      } else if (tag === 'VP8 ' && b[23] === 157 && b[24] === 1 && b[25] === 42) {
        width = v.getUint16(26, true) & 16383;
        height = v.getUint16(28, true) & 16383;
      } else if (tag === 'VP8L' && b[20] === 47) {
        width = 1 + b[21] + ((b[22] & 63) << 8);
        height = 1 + (b[22] >>> 6) + (b[23] << 2) + ((b[24] & 15) << 10);
      }
    } else if (b.length >= 4 && b[0] === 255 && b[1] === 216) {
      actual = 'image/jpeg';
      let i = 2;
      while (i + 4 <= b.length) {
        if (b[i++] !== 255) break;
        while (b[i] === 255) i++;
        const marker = b[i++];
        if (marker === 218 || marker === 217) break;
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
        const size = v.getUint16(i);
        if (size < 2 || i + size > b.length) break;
        if (
          [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
          size >= 8
        ) {
          height = v.getUint16(i + 3);
          width = v.getUint16(i + 5);
          break;
        }
        i += size;
      }
    }
    if (!width || !height || actual !== mime)
      throw Error(
        '无法安全预检图片格式/尺寸（ZIP 支持 JPEG、PNG、WebP、GIF）；可人工检查后选择原生下载',
      );
    if (width > 16384 || height > 16384 || width * height > 32000000)
      throw Error('图片头声明尺寸超过安全上限（3200 万像素 / 单边 16384），未进行解码');
    return { width, height };
  }
  root.ArchiveCodec = { Hash, dimensions };
})(globalThis);

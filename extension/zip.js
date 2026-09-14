// ZIP STORE writer (no compression/re-encoding). No third-party runtime dependencies.
// Volumes are bounded by the UI; ZIP64 is intentionally unsupported.
class ZipVolume {
  constructor() {
    this.entries = [];
    this.bytes = 0;
  }
  add(name, bytes, checksum) {
    if (
      typeof name !== 'string' ||
      !name ||
      /[\\:\x00]/.test(name) ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw Error('ZIP 文件名必须是安全的相对路径');
    if (this.entries.some((e) => e.name === name)) throw Error('ZIP 内不允许重复文件名');
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof Blob)) bytes = new Uint8Array(bytes);
    if (bytes instanceof Blob && !Number.isInteger(checksum))
      throw Error('Blob ZIP entry requires a verified CRC32');
    this.entries.push({ name, bytes, checksum });
    this.bytes += bytes.size ?? bytes.byteLength;
  }
  blob() {
    const enc = new TextEncoder(),
      parts = [],
      central = [];
    let offset = 0,
      centralSize = 0;
    const now = new Date(),
      dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
      dosDate =
        ((Math.max(1980, now.getFullYear()) - 1980) << 9) |
        ((now.getMonth() + 1) << 5) |
        now.getDate();
    for (const { name, bytes, checksum } of this.entries) {
      const n = enc.encode(name),
        crc = checksum ?? ZipVolume.crc(bytes),
        size = bytes.size ?? bytes.length,
        h = new Uint8Array(30),
        v = new DataView(h.buffer);
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 0x800, true);
      v.setUint16(10, dosTime, true);
      v.setUint16(12, dosDate, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, size, true);
      v.setUint32(22, size, true);
      v.setUint16(26, n.length, true);
      parts.push(h, n, bytes);
      const c = new Uint8Array(46),
        d = new DataView(c.buffer);
      d.setUint32(0, 0x02014b50, true);
      d.setUint16(4, 20, true);
      d.setUint16(6, 20, true);
      d.setUint16(8, 0x800, true);
      d.setUint16(12, dosTime, true);
      d.setUint16(14, dosDate, true);
      d.setUint32(16, crc, true);
      d.setUint32(20, size, true);
      d.setUint32(24, size, true);
      d.setUint16(28, n.length, true);
      d.setUint32(42, offset, true);
      central.push(c, n);
      centralSize += 46 + n.length;
      offset += 30 + n.length + size;
    }
    if (offset + centralSize > 0xffffffff || this.entries.length > 65535)
      throw Error('ZIP 超出格式限制，请减小分卷大小');
    const end = new Uint8Array(22),
      e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, this.entries.length, true);
    e.setUint16(10, this.entries.length, true);
    e.setUint32(12, centralSize, true);
    e.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }
  static crc(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++)
      crc = ZipVolume.table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
}
ZipVolume.table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

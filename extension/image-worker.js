'use strict';
importScripts('image-codec.js');
// One worker per workbench; jobs are serialized by the owning service.
self.onmessage = async ({ data: { id, blob, mime } }) => {
  try {
    const size = ArchiveCodec.dimensions(
      new Uint8Array(await blob.slice(0, 1048576).arrayBuffer()),
      mime,
    );
    const bitmap = await createImageBitmap(blob, {
      resizeWidth: Math.min(size.width, 256),
      resizeHeight: Math.min(size.height, 256),
      resizeQuality: 'low',
    });
    bitmap.close();
    const hash = new ArchiveCodec.Hash();
    for (let i = 0; i < blob.size; i += 262144)
      hash.update(new Uint8Array(await blob.slice(i, i + 262144).arrayBuffer()));
    self.postMessage({ id, result: { ...size, ...hash.finish() } });
  } catch (e) {
    self.postMessage({ id, error: e.message });
  }
};

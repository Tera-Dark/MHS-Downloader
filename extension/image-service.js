// Owns decode lifetime, temporary download chunks and the verified-image commit.
class ArchiveImageService {
  constructor(store) {
    this.store = store;
    this.chain = Promise.resolve();
    this.worker = null;
  }
  inspect(blob, mime) {
    const job = this.chain
      .catch(() => {})
      .then(
        () =>
          new Promise((resolve, reject) => {
            const worker = (this.worker ||= new Worker('image-worker.js'));
            const id = crypto.randomUUID();
            const done = () => clearTimeout(timer);
            const timer = setTimeout(() => {
              worker.terminate();
              this.worker = null;
              reject(Error('图片验证超时，已终止解码线程'));
            }, 30000);
            worker.onmessage = ({ data }) => {
              if (data.id !== id) return;
              done();
              data.error ? reject(Error(data.error)) : resolve(data.result);
            };
            worker.onerror = () => {
              done();
              worker.terminate();
              this.worker = null;
              reject(Error('图片验证线程失败'));
            };
            worker.postMessage({ id, blob, mime });
          }),
      );
    this.chain = job;
    return job;
  }
  async commit(data, persist) {
    await persist((tx) => {
      tx.objectStore('images').put(
        {
          blob: data.blob,
          mime: data.mime,
          width: data.width,
          height: data.height,
          crc32: data.crc32,
        },
        data.sha256,
      );
      tx.objectStore('chunks').delete(
        IDBKeyRange.bound([data.input, 0], [data.input, Number.MAX_SAFE_INTEGER]),
      );
    });
  }
}

// IndexedDB owns durable state. Only changed tasks and metadata keys are cloned/written.
// A successful transaction is the durability boundary; no local-storage shadow copy.
class ArchiveStateStore {
  constructor() {
    this.dirty = new Map();
    this.removed = new Map();
    this.revision = 0;
    this.taskRevision = 0;
    this.queue = Promise.resolve();
    this.cache = new WeakMap();
    this.raw = new WeakMap();
    this.byURL = new Map();
    this.stats = { commits: 0, taskWrites: 0, metaWrites: 0 };
  }
  unwrap(value) {
    return this.raw.get(value) || value;
  }
  clean(value) {
    if (this.raw.has(value)) return this.raw.get(value);
    if (value && typeof value === 'object' && !(value instanceof Blob)) {
      for (const k of Object.keys(value)) value[k] = this.clean(value[k]);
    }
    return value;
  }
  mark(key) {
    this.dirty.set(key, ++this.revision);
    if (key.startsWith('task:')) this.taskRevision++;
  }
  wrap(value, key) {
    if (!value || typeof value !== 'object') return value;
    value = this.unwrap(value);
    if (this.cache.has(value)) return this.cache.get(value);
    const self = this;
    const proxy = new Proxy(value, {
      get(o, k) {
        return self.wrap(o[k], key);
      },
      set(o, k, v) {
        v = self.clean(v);
        if (o[k] !== v) {
          o[k] = v;
          self.mark(key);
        }
        return true;
      },
      deleteProperty(o, k) {
        delete o[k];
        self.mark(key);
        return true;
      },
    });
    this.cache.set(value, proxy);
    this.raw.set(proxy, value);
    return proxy;
  }
  attach(data) {
    this.taskRevision++;
    this.data = data;
    this.nextOrder =
      Math.max(
        -1,
        ...data.tasks.map((t) => (Number.isFinite(t.queue_order) ? t.queue_order : -1)),
      ) + 1;
    this.byURL = new Map(data.tasks.map((t) => [t.url, t]));
    const self = this;
    function taskArray(list) {
      list = self.unwrap(list);
      return new Proxy(list, {
        get(o, k) {
          const v = o[k];
          return /^\d+$/.test(String(k)) && v ? self.wrap(v, 'task:' + v.url) : v;
        },
        set(o, k, value) {
          value = self.clean(value);
          if (k === 'length') {
            for (const t of o.slice(Number(value)))
              if (t) {
                self.removed.set(t.url, ++self.revision);
                self.byURL.delete(t.url);
              }
          } else if (/^\d+$/.test(String(k))) {
            const old = o[k];
            if (old && old.url !== value?.url) {
              self.removed.set(old.url, ++self.revision);
              self.byURL.delete(old.url);
            }
            if (value) {
              if (!Number.isFinite(value.queue_order)) value.queue_order = self.nextOrder++;
              self.byURL.set(value.url, value);
              self.removed.delete(value.url);
              self.mark('task:' + value.url);
            }
          }
          o[k] = value;
          return true;
        },
      });
    }
    this.tasks = taskArray(data.tasks);
    this.state = new Proxy(data, {
      get(o, k) {
        return k === 'tasks' ? self.tasks : self.wrap(o[k], 'meta:' + String(k));
      },
      set(o, k, v) {
        if (k === 'tasks') {
          self.taskRevision++;
          v = Array.from(v, (x) => self.unwrap(x));
          const urls = new Set(v.map((t) => t.url));
          for (const t of o.tasks) if (!urls.has(t.url)) self.removed.set(t.url, ++self.revision);
          for (const t of v) {
            self.mark('task:' + t.url);
            self.removed.delete(t.url);
          }
          self.byURL = new Map(v.map((t) => [t.url, t]));
          o.tasks = v;
          self.tasks = taskArray(v);
        } else {
          o[k] = self.clean(v);
          self.mark('meta:' + String(k));
        }
        return true;
      },
    });
    return this.state;
  }
  findTask(url) {
    return this.wrap(this.byURL.get(url), 'task:' + url);
  }
  async open() {
    this.db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('artwork-archive-v3', 1);
      r.onupgradeneeded = () => {
        for (const n of ['tasks', 'meta', 'chunks', 'images']) r.result.createObjectStore(n);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(Error('本地数据库升级被旧工作台阻塞，请关闭其他工作台'));
    });
    this.db.onversionchange = () => this.db.close();
    return this;
  }
  transaction(names, mode, action) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(
        names,
        mode,
        mode === 'readwrite' ? { durability: 'strict' } : undefined,
      );
      let result;
      tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result);
      tx.onabort = tx.onerror = () => reject(tx.error || Error('本地数据库事务已中止'));
      try {
        result = action(tx);
      } catch (e) {
        tx.abort();
        reject(e);
      }
    });
  }
  async read(name, key) {
    return this.transaction([name], 'readonly', (tx) => {
      const r = key === undefined ? tx.objectStore(name).getAll() : tx.objectStore(name).get(key);
      return () => r.result;
    });
  }
  validate(data) {
    if (
      !data ||
      !['tasks', 'logs', 'scans', 'archives'].every((k) => Array.isArray(data[k])) ||
      data.tasks.length > 5000 ||
      data.tasks.some((t) => !t || !ArchivePolicy.siteURL(t.url) || !Array.isArray(t.files)) ||
      new Set(data.tasks.map((t) => t.url)).size !== data.tasks.length
    )
      throw Error('本地记录结构异常，已停止初始化，未覆盖原记录');
  }
  async load(legacy) {
    await this.open();
    let data;
    const schema = await this.read('meta', '_schema');
    if (schema !== undefined && schema !== 3) throw Error('本地数据库版本无法识别，未覆盖记录');
    if (schema === 3) {
      const values = await this.transaction(['meta', 'tasks'], 'readonly', (tx) => {
        const keys = tx.objectStore('meta').getAllKeys(),
          vals = tx.objectStore('meta').getAll(),
          tasks = tx.objectStore('tasks').getAll();
        return () => ({
          ...Object.fromEntries(keys.result.map((k, i) => [k, vals.result[i]])),
          tasks: tasks.result,
        });
      });
      delete values._schema;
      data = values;
      data.tasks.sort((a, b) => (a.queue_order ?? 0) - (b.queue_order ?? 0));
    } else {
      data = legacy || { tasks: [], logs: [], scans: [], archives: [], settings: {} };
      this.validate(data);
      data.tasks.forEach((t, i) => (t.queue_order = i));
      await this.transaction(['tasks', 'meta'], 'readwrite', (tx) => {
        for (const t of data.tasks) tx.objectStore('tasks').put(t, t.url);
        for (const [k, v] of Object.entries(data))
          if (k !== 'tasks') tx.objectStore('meta').put(v, k);
        tx.objectStore('meta').put(3, '_schema');
      });
      // Remove old state only after the migration transaction has committed.
      await chrome.storage.local.remove(['stateV2', 'tasks', 'settings', 'logs']);
    }
    this.validate(data);
    return this.attach(data);
  }
  commit(extra = null) {
    // Snapshot at invocation, not when the queued transaction eventually runs.
    const dirty = new Map(this.dirty),
      removed = new Map(this.removed),
      writes = [];
    for (const [key] of dirty) {
      const task = key.startsWith('task:');
      const id = key.slice(5);
      const value = task ? this.byURL.get(id) : this.data[id];
      if (value !== undefined) writes.push([task ? 'tasks' : 'meta', id, structuredClone(value)]);
    }
    const p = this.queue
      .catch(() => {})
      .then(async () => {
        if (!writes.length && !removed.size && !extra) return;
        await this.transaction(
          ['tasks', 'meta', ...(extra ? ['images', 'chunks'] : [])],
          'readwrite',
          (tx) => {
            for (const url of removed.keys()) tx.objectStore('tasks').delete(url);
            for (const [store, id, value] of writes) tx.objectStore(store).put(value, id);
            if (extra) extra(tx);
          },
        );
        this.stats.commits++;
        this.stats.taskWrites += writes.filter((w) => w[0] === 'tasks').length;
        this.stats.metaWrites += writes.filter((w) => w[0] === 'meta').length;
        for (const [key, v] of dirty) if (this.dirty.get(key) === v) this.dirty.delete(key);
        for (const [key, v] of removed) if (this.removed.get(key) === v) this.removed.delete(key);
      });
    this.queue = p;
    return p;
  }
  async putChunk(id, index, blob) {
    await this.transaction(['chunks'], 'readwrite', (tx) =>
      tx.objectStore('chunks').put(blob, [id, index]),
    );
  }
  async inputBlob(id, mime) {
    const parts = await this.transaction(['chunks'], 'readonly', (tx) => {
      const r = tx
        .objectStore('chunks')
        .getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
      return () => r.result;
    });
    return new Blob(parts, { type: mime });
  }
  async clearInputs() {
    await this.transaction(['chunks'], 'readwrite', (tx) => tx.objectStore('chunks').clear());
  }
  async dropInput(id) {
    await this.transaction(['chunks'], 'readwrite', (tx) =>
      tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])),
    );
  }
  async collectImages(keep) {
    await this.transaction(['images'], 'readwrite', (tx) => {
      const r = tx.objectStore('images').openKeyCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (c) {
          if (!keep.has(c.key)) tx.objectStore('images').delete(c.key);
          c.continue();
        }
      };
    });
  }
  async rawBackup() {
    return {
      legacy: await chrome.storage.local.get(['stateV2', 'tasks', 'settings', 'logs']),
      indexedDB: this.db
        ? {
            tasks: await this.read('tasks'),
            meta: await this.transaction(['meta'], 'readonly', (tx) => {
              const k = tx.objectStore('meta').getAllKeys(),
                v = tx.objectStore('meta').getAll();
              return () => Object.fromEntries(k.result.map((key, i) => [key, v.result[i]]));
            }),
          }
        : null,
    };
  }
}

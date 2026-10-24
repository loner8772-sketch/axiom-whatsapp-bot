import fs from 'node:fs/promises';
import path from 'node:path';

/** JSON file store (local dev / tests). One file per key, atomic writes. */
export class FileStore {
  constructor(dir) { this.dir = dir; this.kind = 'file'; }
  async init() { await fs.mkdir(this.dir, { recursive: true }); }
  #p(key) { return path.join(this.dir, `${encodeURIComponent(key)}.json`); }
  async get(key, fallback = null) {
    try { return JSON.parse(await fs.readFile(this.#p(key), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  }
  async set(key, value) {
    const p = this.#p(key);
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(tmp, p);
  }
  async del(key) { await fs.rm(this.#p(key), { force: true }); }
  async clear(prefix) {
    for (const f of await fs.readdir(this.dir)) {
      if (!f.endsWith('.json')) continue;
      if (decodeURIComponent(f.slice(0, -5)).startsWith(prefix)) await fs.rm(path.join(this.dir, f), { force: true });
    }
  }
  async close() {}
}

/** MongoDB Atlas store (production: survives host restarts). */
export class MongoStore {
  constructor(uri, dbName = 'axiom') { this.uri = uri; this.dbName = dbName; this.kind = 'mongodb'; }
  async init() {
    const { MongoClient } = await import('mongodb');
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 15000, maxPoolSize: 5 });
    await this.client.connect();
    this.coll = this.client.db(this.dbName).collection('kv');
  }
  async #retry(fn) {
    let last;
    for (let i = 0; i < 3; i++) {
      try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
    }
    throw last;
  }
  async get(key, fallback = null) {
    const doc = await this.#retry(() => this.coll.findOne({ _id: key }));
    return doc ? JSON.parse(doc.json) : fallback;
  }
  async set(key, value) {
    await this.#retry(() => this.coll.replaceOne({ _id: key }, { _id: key, json: JSON.stringify(value) }, { upsert: true }));
  }
  async del(key) { await this.#retry(() => this.coll.deleteOne({ _id: key })); }
  async clear(prefix) {
    const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await this.#retry(() => this.coll.deleteMany({ _id: { $regex: `^${esc}` } }));
  }
  async close() { await this.client?.close(); }
}

export async function createStore(config) {
  const store = config.mongoUri ? new MongoStore(config.mongoUri, config.mongoDb) : new FileStore(config.dataDir);
  await store.init();
  return store;
}

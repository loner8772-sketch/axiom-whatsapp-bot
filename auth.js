/**
 * Baileys auth state persisted in any store (Mongo/File).
 * Baileys helpers are injected so this module stays testable without Baileys.
 */
export async function useStoreAuthState(store, { BufferJSON, initAuthCreds, proto }) {
  const ser = (v) => JSON.stringify(v, BufferJSON.replacer);
  const de = (s) => JSON.parse(s, BufferJSON.reviver);
  const raw = await store.get('auth:creds');
  const creds = raw ? de(raw) : initAuthCreds();

  const keys = {
    get: async (type, ids) => {
      const out = {};
      await Promise.all(ids.map(async (id) => {
        const r = await store.get(`auth:${type}:${id}`);
        if (!r) return;
        let v = de(r);
        if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
        out[id] = v;
      }));
      return out;
    },
    set: async (data) => {
      const jobs = [];
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type])) {
          const v = data[type][id];
          const k = `auth:${type}:${id}`;
          jobs.push(v ? store.set(k, ser(v)) : store.del(k));
        }
      }
      await Promise.all(jobs);
    },
  };
  return { state: { creds, keys }, saveCreds: () => store.set('auth:creds', ser(creds)) };
}

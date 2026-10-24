const DEFAULT_CHAT = () => ({ antilink: false, autoreply: { on: false, rules: [], default: '' } });

export class Settings {
  constructor(store, { debounceMs = 400 } = {}) {
    this.store = store;
    this.debounceMs = debounceMs;
    this.data = { restricted: [], chats: {}, warnings: {} };
    this.timer = null;
    this.dirty = false;
  }
  async load() {
    const saved = await this.store.get('settings');
    if (saved) this.data = { restricted: [], chats: {}, warnings: {}, ...saved };
  }
  #touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, this.debounceMs);
    this.timer.unref?.();
  }
  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    try { await this.store.set('settings', this.data); } catch (e) { this.dirty = true; throw e; }
  }

  /** Read-only view; does not create an entry. */
  peekChat(jid) { return this.data.chats[jid] ?? DEFAULT_CHAT(); }
  getChat(jid) {
    const c = (this.data.chats[jid] ??= DEFAULT_CHAT());
    c.autoreply ??= { on: false, rules: [], default: '' };
    return c;
  }
  setAntilink(jid, on) { this.getChat(jid).antilink = !!on; this.#touch(); }
  setAutoreply(jid, on) { this.getChat(jid).autoreply.on = !!on; this.#touch(); }
  addRule(jid, keyword, reply) {
    const ar = this.getChat(jid).autoreply;
    const k = keyword.trim().toLowerCase();
    ar.rules = ar.rules.filter((r) => r.k !== k);
    ar.rules.push({ k, r: reply.trim() });
    this.#touch();
  }
  delRule(jid, keyword) {
    const ar = this.getChat(jid).autoreply;
    const k = keyword.trim().toLowerCase();
    const before = ar.rules.length;
    ar.rules = ar.rules.filter((r) => r.k !== k);
    this.#touch();
    return ar.rules.length < before;
  }
  setDefaultReply(jid, text) { this.getChat(jid).autoreply.default = text.trim(); this.#touch(); }
  clearAutoreply(jid) { this.getChat(jid).autoreply = { on: false, rules: [], default: '' }; this.#touch(); }

  isRestricted(key) { return this.data.restricted.includes(key); }
  restrict(key) { if (!this.isRestricted(key)) { this.data.restricted.push(key); this.#touch(); } }
  unrestrict(key) {
    const before = this.data.restricted.length;
    this.data.restricted = this.data.restricted.filter((k) => k !== key);
    this.#touch();
    return this.data.restricted.length < before;
  }

  getWarnings(chat, key) { return this.data.warnings[chat]?.[key] ?? 0; }
  addWarning(chat, key) {
    const w = (this.data.warnings[chat] ??= {});
    w[key] = (w[key] ?? 0) + 1;
    this.#touch();
    return w[key];
  }
  resetWarnings(chat, key) {
    if (this.data.warnings[chat]) delete this.data.warnings[chat][key];
    this.#touch();
  }
  summary() {
    const chats = Object.values(this.data.chats);
    return {
      restricted: this.data.restricted.length,
      antilinkChats: chats.filter((c) => c.antilink).length,
      autoreplyChats: chats.filter((c) => c.autoreply?.on).length,
    };
  }
}

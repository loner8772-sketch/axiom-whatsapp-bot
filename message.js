const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];

export function unwrap(m) {
  let cur = m;
  for (let i = 0; i < 5 && cur; i++) {
    const k = WRAPPERS.find((w) => cur[w]?.message);
    if (!k) break;
    cur = cur[k].message;
  }
  return cur || null;
}

export function extractText(m) {
  const u = unwrap(m);
  if (!u) return '';
  return u.conversation ?? u.extendedTextMessage?.text ?? u.imageMessage?.caption ?? u.videoMessage?.caption ?? u.documentMessage?.caption ?? '';
}

export function getContextInfo(m) {
  const u = unwrap(m);
  if (!u) return null;
  for (const k of Object.keys(u)) if (u[k]?.contextInfo) return u[k].contextInfo;
  return null;
}

export function mediaOf(m) {
  const u = unwrap(m);
  for (const type of ['imageMessage', 'videoMessage', 'audioMessage']) if (u?.[type]) return { type, node: u[type] };
  return null;
}

export function isViewOnce(m) {
  if (!m) return false;
  if (m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension) return true;
  const u = unwrap(m);
  return !!(u?.imageMessage?.viewOnce || u?.videoMessage?.viewOnce || u?.audioMessage?.viewOnce);
}

/** Short-lived, in-memory reference to view-once messages (never downloaded until an authorised .vv). */
export class ViewOnceCache {
  constructor({ max = 50, ttlMs = 30 * 60 * 1000, now = () => Date.now() } = {}) {
    this.max = max; this.ttlMs = ttlMs; this.now = now; this.map = new Map();
  }
  put(id, entry) {
    this.map.set(id, { ...entry, at: this.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  get(id) {
    const e = this.map.get(id);
    if (!e) return null;
    if (this.now() - e.at > this.ttlMs) { this.map.delete(id); return null; }
    return e;
  }
}

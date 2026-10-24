export const digits = (s = '') => String(s).replace(/\D/g, '');
export const server = (jid = '') => { const i = String(jid).indexOf('@'); return i < 0 ? '' : String(jid).slice(i + 1); };
export const userPart = (jid = '') => String(jid).split('@')[0].split(':')[0];
export const isGroupJid = (j) => String(j || '').endsWith('@g.us');
export const toUserJid = (n) => `${digits(n)}@s.whatsapp.net`;

/** Identity = every id a person might appear under (phone JID and/or LID). */
export function identity(...jids) {
  const ids = new Set();
  let pn = null;
  let first = null;
  for (const j of jids) {
    if (!j || typeof j !== 'string') continue;
    const u = userPart(j);
    if (!u) continue;
    ids.add(u);
    if (first === null) first = u;
    if (pn === null && server(j) === 's.whatsapp.net') pn = u;
  }
  return { key: pn ?? first ?? '', ids };
}

export function overlaps(a, b) {
  for (const x of a.ids) if (b.ids.has(x)) return true;
  return false;
}

export const participantIdentity = (p) => identity(p?.id, p?.phoneNumber, p?.lid, p?.jid);
export const findParticipant = (meta, ident) =>
  (meta?.participants || []).find((p) => overlaps(participantIdentity(p), ident)) ?? null;
export const isAdminParticipant = (p) => p?.admin === 'admin' || p?.admin === 'superadmin';

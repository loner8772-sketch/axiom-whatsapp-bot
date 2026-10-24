import { identity, overlaps, findParticipant, isAdminParticipant, toUserJid } from './jid.js';
import { parseCommand, splitMessage } from './text.js';
import { extractText, getContextInfo, isViewOnce, mediaOf, ViewOnceCache } from './message.js';
import { containsLink } from './links.js';
import { findCommand, applyWarning } from './commands.js';
import { RateLimiter } from './ai.js';

export class BoundedSet {
  constructor(max = 1000) { this.max = max; this.set = new Set(); }
  add(v) { if (!v) return; this.set.add(v); if (this.set.size > this.max) this.set.delete(this.set.values().next().value); }
  has(v) { return this.set.has(v); }
}

/** Everything the handlers share. `selfIdent` is a function because the bot's id is known only after connecting. */
export function createDeps({ config, settings, ai, health, store, log, selfIdent, download }) {
  return {
    config, settings, ai, health, store, log,
    selfIdent: selfIdent ?? (() => identity()),
    download: download ?? (async () => { throw new Error('download unavailable'); }),
    ownerIdent: identity(toUserJid(config.ownerNumber)),
    viewCache: new ViewOnceCache(),
    sentIds: new BoundedSet(1000),
    seen: new BoundedSet(2000),
    groupCache: new Map(),
    arCooldown: new Map(),
    aiLimiter: new RateLimiter({ windowMs: 10 * 60 * 1000, max: 8 }),
    aiGlobal: new RateLimiter({ windowMs: 60 * 1000, max: 20 }),
  };
}

const MAX_AGE_SEC = 60;

export async function handleMessage(deps, sock, msg, type = 'notify') {
  const { config, settings, log, health } = deps;
  const key = msg?.key;
  if (!key || !msg.message) return;
  const chat = key.remoteJid;
  if (!chat || chat === 'status@broadcast' || chat.endsWith('@newsletter') || chat.endsWith('@broadcast')) return;
  const keys = Object.keys(msg.message);
  if (msg.message.protocolMessage || (keys.length === 1 && keys[0] === 'senderKeyDistributionMessage')) return;
  if (type === 'append' && !key.fromMe) return;
  if (deps.sentIds.has(key.id) || deps.seen.has(key.id)) return;
  deps.seen.add(key.id);
  const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0);
  if (ts && Date.now() / 1000 - ts > MAX_AGE_SEC) return;

  health.noteMessage();
  const isGroup = chat.endsWith('@g.us');
  const self = deps.selfIdent();
  const sender = key.fromMe ? self : isGroup ? identity(key.participant, key.participantAlt) : identity(chat, key.remoteJidAlt);
  const isOwner = !!key.fromMe || overlaps(sender, deps.ownerIdent) || overlaps(sender, self);

  if (!isOwner && ([...sender.ids].some((i) => settings.isRestricted(i)) || settings.isRestricted(sender.key))) return;

  if (isViewOnce(msg.message) && mediaOf(msg.message)) deps.viewCache.put(key.id, { msg, sender, fromMe: !!key.fromMe });

  const text = extractText(msg.message);
  const contextInfo = getContextInfo(msg.message);

  const getGroup = async () => {
    if (!isGroup) return null;
    const c = deps.groupCache.get(chat);
    if (c && Date.now() - c.at < 60000) return c.meta;
    const meta = await sock.groupMetadata(chat);
    deps.groupCache.set(chat, { meta, at: Date.now() });
    return meta;
  };
  const ctx = {
    deps, sock, msg, chat, isGroup, text, contextInfo, sender, isOwner, getGroup,
    args: [], rest: '',
    isSenderAdmin: async () => isAdminParticipant(findParticipant(await getGroup(), sender)),
    isBotAdmin: async () => isAdminParticipant(findParticipant(await getGroup(), deps.selfIdent())),
    reply: async (t, mentions = []) => {
      let last;
      for (const part of splitMessage(t)) {
        last = await sock.sendMessage(chat, mentions.length ? { text: part, mentions } : { text: part }, { quoted: msg });
        deps.sentIds.add(last?.key?.id);
      }
      return last;
    },
  };

  try {
    if (isGroup && (await antilink(ctx))) return;

    const parsed = parseCommand(text, config.prefix);
    if (parsed) {
      const cmd = findCommand(parsed.name);
      if (!cmd) return;
      ctx.args = parsed.args; ctx.rest = parsed.rest;
      if (cmd.ownerOnly && !isOwner) return void (await ctx.reply('🔒 Owner only command.'));
      if (cmd.groupOnly && !isGroup) return void (await ctx.reply('👥 This command works in groups only.'));
      if (isGroup && (cmd.adminOnly || cmd.botAdmin)) {
        try { await getGroup(); } catch (e) { log.warn('group metadata failed', e); return void (await ctx.reply('⚠️ I could not read the group info. Try again in a moment.')); }
        if (cmd.adminOnly && !isOwner && !(await ctx.isSenderAdmin())) return void (await ctx.reply('🔒 Only group admins can use this command.'));
        if (cmd.botAdmin && !(await ctx.isBotAdmin())) return void (await ctx.reply('⚠️ Make me a group admin first, then try again.'));
      }
      await cmd.run(ctx);
      return;
    }
    await autoreply(ctx);
  } catch (e) {
    log.error(`handler error in ${chat}`, e);
    try { await ctx.reply('⚠️ Something went wrong. Please try again.'); } catch { /* nothing more to do */ }
  }
}

async function antilink(ctx) {
  const { deps, sock, msg, chat, sender } = ctx;
  if (ctx.isOwner || !deps.settings.peekChat(chat).antilink || !containsLink(ctx.text)) return false;
  let meta;
  try { meta = await ctx.getGroup(); } catch { return false; }
  const p = findParticipant(meta, sender);
  if (isAdminParticipant(p)) return false;
  if (!(await ctx.isBotAdmin())) return false;
  try { await sock.sendMessage(chat, { delete: msg.key }); } catch (e) { deps.log.warn('antilink delete failed', e); return false; }
  const jid = p?.id ?? msg.key.participant;
  const t = { jid, ident: identity(p?.id, p?.phoneNumber, p?.lid, msg.key.participant, msg.key.participantAlt), participant: p };
  await applyWarning(ctx, t, 'Links are not allowed here');
  return true;
}

async function autoreply(ctx) {
  const { deps, chat, msg } = ctx;
  if (msg.key.fromMe || !ctx.text) return;
  const ar = deps.settings.peekChat(chat).autoreply;
  if (!ar?.on) return;
  const t = ctx.text.toLowerCase();
  const now = Date.now();
  const hit = ar.rules.find((r) => t.includes(r.k));
  if (hit) {
    const ck = `${chat}|${hit.k}`;
    if (now - (deps.arCooldown.get(ck) ?? 0) < 10000) return;
    deps.arCooldown.set(ck, now);
    await ctx.reply(hit.r);
  } else if (!ctx.isGroup && ar.default) {
    const ck = `${chat}|default|${ctx.sender.key}`;
    if (now - (deps.arCooldown.get(ck) ?? 0) < 3600000) return;
    deps.arCooldown.set(ck, now);
    await ctx.reply(ar.default);
  }
  if (deps.arCooldown.size > 2000) deps.arCooldown.delete(deps.arCooldown.keys().next().value);
}

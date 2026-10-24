import { digits, identity, overlaps, findParticipant, participantIdentity, isAdminParticipant, toUserJid, userPart } from './jid.js';
import { formatUptime } from './text.js';
import { extractText, mediaOf } from './message.js';
import { parseAiArgs, parseStudy, STUDY_SUBJECTS, AiError } from './ai.js';
import { containsLink } from './links.js';
import { searchMusic, searchFullTrack } from './music.js';

const isOwnerIdent = (deps, ident) => overlaps(ident, deps.ownerIdent) || overlaps(ident, deps.selfIdent());

/** Who is the command about? mention > replied-to user > number in args > the private chat partner. */
export function resolveTarget(ctx) {
  const ci = ctx.contextInfo;
  if (ci?.mentionedJid?.[0]) return ci.mentionedJid[0];
  if (ci?.participant && ci?.stanzaId) return ci.participant;
  const num = ctx.args.map((a) => digits(a)).find((d) => d.length >= 7 && d.length <= 15);
  if (num) return toUserJid(num);
  if (!ctx.isGroup && /@(s\.whatsapp\.net|lid)$/.test(ctx.chat)) return ctx.chat;
  return null;
}

async function targetInfo(ctx) {
  const jid = resolveTarget(ctx);
  if (!jid) return null;
  const meta = ctx.isGroup ? await ctx.getGroup() : null;
  const p = meta ? findParticipant(meta, identity(jid)) : null;
  return { jid: p?.id ?? jid, ident: identity(p?.id, p?.phoneNumber, p?.lid, jid), participant: p };
}

async function removeFromGroup(ctx, t) {
  const res = await ctx.sock.groupParticipantsUpdate(ctx.chat, [t.jid], 'remove');
  ctx.deps.groupCache?.delete(ctx.chat);
  const status = String(res?.[0]?.status ?? '200');
  return status === '200';
}

const TARGET_HELP = 'Reply to the person, @mention them, or type their number.';

async function runAi(ctx, mode, question) {
  const { deps } = ctx;
  const quoted = ctx.contextInfo?.quotedMessage ? extractText(ctx.contextInfo.quotedMessage) : '';
  const full = [question, quoted && `Quoted message:\n${quoted}`].filter(Boolean).join('\n\n');
  if (!full.trim()) return false;
  const now = Date.now();
  const g = deps.aiGlobal.hit('all', now);
  if (!g.ok) { await ctx.reply('⏳ I am getting a lot of AI requests. Try again in a minute.'); return true; }
  if (!ctx.isOwner) {
    const l = deps.aiLimiter.hit(ctx.sender.key, now);
    if (!l.ok) { await ctx.reply(`⏳ Slow down a bit. Try again in ${Math.ceil(l.retryAfterMs / 1000)}s.`); return true; }
  }
  try { await ctx.sock.sendPresenceUpdate?.('composing', ctx.chat); } catch { /* optional */ }
  try {
    const out = await deps.ai.ask({ mode, question: full, chatId: ctx.chat });
    await ctx.reply(out.text);
  } catch (e) {
    deps.log.warn('ai failed', e);
    await ctx.reply(e instanceof AiError ? '⚠️ The AI service is unavailable right now. Please try again shortly.' : '⚠️ Could not get an AI answer.');
  }
  return true;
}

const MENU = (p, name) => `╭─『 *${name}* 』
│ Prefix: *${p}*
│
│ *General*
│ ${p}menu ${p}help ${p}ping ${p}awake
│ ${p}status ${p}owner
│
│ *AI*
│ ${p}ai ${p}study ${p}script
│
│ *Group*
│ ${p}tagall ${p}warn ${p}warnings
│ ${p}remove ${p}antilink
│
│ *Owner*
│ ${p}block ${p}unblock ${p}autoreply
│
│ *Media*
│ ${p}play ${p}vv
╰ Type *${p}help <command>* for details`;

export const COMMANDS = [
  { name: 'menu', desc: 'Show all commands', usage: 'menu',
    run: (ctx) => ctx.reply(MENU(ctx.deps.config.prefix, ctx.deps.config.botName)) },

  { name: 'help', desc: 'Help for a command', usage: 'help [command]',
    run: async (ctx) => {
      const p = ctx.deps.config.prefix;
      const want = (ctx.args[0] || '').replace(p, '').toLowerCase();
      if (!want) return ctx.reply(`*${ctx.deps.config.botName} help*\nUse *${p}menu* for the command list or *${p}help <command>* for details.\nAI tip: reply to any message with *${p}ai explain this*.`);
      const c = findCommand(want);
      if (!c) return ctx.reply(`Unknown command "${want}". Try ${p}menu`);
      const flags = [c.ownerOnly && 'owner only', c.groupOnly && 'groups only', c.adminOnly && 'group admins', c.botAdmin && 'bot must be admin'].filter(Boolean).join(', ');
      return ctx.reply(`*${p}${c.name}* - ${c.desc}\nUsage: ${p}${c.usage}${flags ? `\nRequires: ${flags}` : ''}${c.extra ? `\n${c.extra}` : ''}`);
    } },

  { name: 'ping', desc: 'Check response speed', usage: 'ping',
    run: async (ctx) => {
      const t0 = Date.now();
      const sent = await ctx.reply('🏓 Pong!');
      const ms = Date.now() - t0;
      try { await ctx.sock.sendMessage(ctx.chat, { text: `🏓 Pong! ${ms}ms`, edit: sent?.key }); } catch { /* edit optional */ }
    } },

  { name: 'awake', desc: 'Is the bot online?', usage: 'awake',
    run: (ctx) => ctx.reply(`✅ ${ctx.deps.config.botName} is awake.\nUptime: ${formatUptime(ctx.deps.health.snapshot().uptimeSec)}`) },

  { name: 'status', desc: 'Bot health and settings summary', usage: 'status',
    run: (ctx) => {
      const { health, settings, ai, store, config } = ctx.deps;
      const h = health.snapshot();
      const s = settings.summary();
      const mem = Math.round(process.memoryUsage().rss / 1048576);
      return ctx.reply(`*${config.botName} status*
Connection: ${h.state} (${h.healthy ? 'healthy' : 'unhealthy'})
Uptime: ${formatUptime(h.uptimeSec)}
Reconnects: ${h.reconnects}
Memory: ${mem} MB
Storage: ${store?.kind ?? 'n/a'}
AI: ${ai.providerName}
Restricted users: ${s.restricted}
Antilink chats: ${s.antilinkChats}
Autoreply chats: ${s.autoreplyChats}
Node: ${process.version}`);
    } },

  { name: 'owner', desc: 'Contact the owner', usage: 'owner',
    run: async (ctx) => {
      const n = ctx.deps.config.ownerNumber;
      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${ctx.deps.config.botName} Owner\nTEL;type=CELL;waid=${n}:+${n}\nEND:VCARD`;
      try {
        const sent = await ctx.sock.sendMessage(ctx.chat, { contacts: { displayName: 'Owner', contacts: [{ vcard }] } }, { quoted: ctx.msg });
        ctx.deps.sentIds.add(sent?.key?.id);
      } catch { /* fall through to text */ }
      return ctx.reply(`👤 Owner: wa.me/${n}`);
    } },

  { name: 'ai', desc: 'Ask the AI (general, study, dropshipping, content, NovaDash)', usage: 'ai [novadash|dropship|content|study] <question>',
    extra: 'Reply to a message with .ai to include it as context.',
    run: async (ctx) => {
      const { mode, question } = parseAiArgs(ctx.args);
      if (!(await runAi(ctx, mode, question))) return ctx.reply(`Ask me something, e.g. *${ctx.deps.config.prefix}ai give 5 TikTok hooks for NovaDash*`);
    } },

  { name: 'study', desc: 'Nigerian school subject tutor', usage: 'study [subject:] <question>',
    extra: `Subjects: ${STUDY_SUBJECTS.join(', ')}. Example: .study chemistry: what is a mole`,
    run: async (ctx) => {
      if (ctx.args[0]?.toLowerCase() === 'subjects') return ctx.reply(`*Subjects*\n${STUDY_SUBJECTS.map((s) => `• ${s}`).join('\n')}`);
      const { subject, question } = parseStudy(ctx.rest);
      const q = subject ? `Subject: ${subject}\nQuestion: ${question}` : question;
      if (!(await runAi(ctx, 'study', q))) return ctx.reply('Usage: *.study <subject>: <question>* (or *.study subjects*)');
    } },

  { name: 'script', desc: 'Short video script (TikTok/Reels/Status)', usage: 'script <topic>',
    run: async (ctx) => {
      if (!(await runAi(ctx, 'script', ctx.rest ? `Topic: ${ctx.rest}` : ''))) return ctx.reply('Usage: *.script <topic>*, e.g. *.script NovaDash dashboard template demo*');
    } },

  { name: 'block', desc: 'Block a user (WhatsApp + bot restriction)', usage: 'block [reply|@mention|number]', ownerOnly: true,
    run: async (ctx) => {
      const jid = resolveTarget(ctx);
      if (!jid) return ctx.reply(`Who should I block? ${TARGET_HELP}`);
      const ident = identity(jid);
      if (isOwnerIdent(ctx.deps, ident)) return ctx.reply('🚫 I will not block the owner.');
      ctx.deps.settings.restrict(ident.key);
      try {
        await ctx.sock.updateBlockStatus(jid, 'block');
        return ctx.reply(`⛔ Blocked ${ident.key}.`);
      } catch (e) {
        ctx.deps.log.warn('block failed', e);
        return ctx.reply(`⚠️ WhatsApp block failed, but ${ident.key} is now restricted from using the bot.`);
      }
    } },

  { name: 'unblock', desc: 'Unblock a user', usage: 'unblock [reply|@mention|number]', ownerOnly: true,
    run: async (ctx) => {
      const jid = resolveTarget(ctx);
      if (!jid) return ctx.reply(`Who should I unblock? ${TARGET_HELP}`);
      const ident = identity(jid);
      const was = ctx.deps.settings.unrestrict(ident.key);
      try {
        await ctx.sock.updateBlockStatus(jid, 'unblock');
        return ctx.reply(`✅ Unblocked ${ident.key}.`);
      } catch (e) {
        ctx.deps.log.warn('unblock failed', e);
        return ctx.reply(was ? `⚠️ Removed bot restriction for ${ident.key}, but WhatsApp unblock failed.` : `⚠️ WhatsApp unblock failed for ${ident.key}.`);
      }
    } },

  { name: 'remove', desc: 'Remove a member from the group', usage: 'remove [reply|@mention|number]', groupOnly: true, adminOnly: true, botAdmin: true,
    run: async (ctx) => {
      const t = await targetInfo(ctx);
      if (!t) return ctx.reply(`Who should I remove? ${TARGET_HELP}`);
      if (!t.participant) return ctx.reply('⚠️ That person is not in this group.');
      if (isOwnerIdent(ctx.deps, t.ident)) return ctx.reply('🚫 I cannot remove the owner or myself.');
      if (isAdminParticipant(t.participant)) return ctx.reply('🚫 That person is an admin. Demote them first.');
      return ctx.reply((await removeFromGroup(ctx, t)) ? `👋 Removed @${userPart(t.jid)}.` : '⚠️ WhatsApp refused to remove that member.', [t.jid]);
    } },

  { name: 'tagall', desc: 'Mention every member', usage: 'tagall [message]', groupOnly: true, adminOnly: true,
    run: async (ctx) => {
      const meta = await ctx.getGroup();
      const ids = meta.participants.map((p) => p.id);
      const body = `📢 *${ctx.rest || 'Attention everyone'}*\n\n${ids.map((j) => `@${userPart(j)}`).join(' ')}`;
      return ctx.reply(body, ids);
    } },

  { name: 'warn', desc: 'Warn a member (auto-remove at the limit)', usage: 'warn [reply|@mention|number] [reason]', groupOnly: true, adminOnly: true,
    run: async (ctx) => {
      const t = await targetInfo(ctx);
      if (!t) return ctx.reply(`Who should I warn? ${TARGET_HELP}`);
      if (!t.participant) return ctx.reply('⚠️ That person is not in this group.');
      if (isOwnerIdent(ctx.deps, t.ident) || isAdminParticipant(t.participant)) return ctx.reply('🚫 I cannot warn admins or the owner.');
      return applyWarning(ctx, t, 'Warned by an admin');
    } },

  { name: 'warnings', desc: 'Show (or reset) warnings', usage: 'warnings [reply|@mention] | warnings reset [reply|@mention]', groupOnly: true,
    run: async (ctx) => {
      const reset = ['reset', 'clear'].includes(ctx.args[0]?.toLowerCase());
      if (reset && !(ctx.isOwner || (await ctx.isSenderAdmin()))) return ctx.reply('🔒 Only admins can reset warnings.');
      const jid = resolveTarget(ctx);
      const ident = jid ? identity(jid) : ctx.sender;
      const meta = await ctx.getGroup();
      const p = findParticipant(meta, ident);
      const key = p ? identity(p.id, p.phoneNumber, p.lid, jid).key : ident.key;
      if (reset) {
        ctx.deps.settings.resetWarnings(ctx.chat, key);
        return ctx.reply(`✅ Warnings cleared for @${userPart(jid ?? ctx.msg.key.participant)}.`, jid ? [jid] : []);
      }
      const n = ctx.deps.settings.getWarnings(ctx.chat, key);
      return ctx.reply(`⚠️ @${userPart(jid ?? ctx.msg.key.participant ?? key)} has ${n}/${ctx.deps.config.maxWarnings} warnings.`, jid ? [jid] : []);
    } },

  { name: 'antilink', desc: 'Delete links from non-admins', usage: 'antilink on|off|status', groupOnly: true, adminOnly: true,
    extra: 'The bot must be a group admin to delete messages. Offenders get a warning.',
    run: async (ctx) => {
      const a = (ctx.args[0] || 'status').toLowerCase();
      const cs = ctx.deps.settings.getChat(ctx.chat);
      if (a === 'on') {
        ctx.deps.settings.setAntilink(ctx.chat, true);
        const botAdmin = await ctx.isBotAdmin();
        return ctx.reply(`🔗 Antilink *ON*.${botAdmin ? '' : '\n⚠️ Make me a group admin, otherwise I cannot delete links.'}`);
      }
      if (a === 'off') { ctx.deps.settings.setAntilink(ctx.chat, false); return ctx.reply('🔗 Antilink *OFF*.'); }
      return ctx.reply(`🔗 Antilink is *${cs.antilink ? 'ON' : 'OFF'}*. Use .antilink on|off`);
    } },

  { name: 'autoreply', desc: 'Keyword auto-replies for this chat', usage: 'autoreply on|off|add <keyword> | <reply>|del <keyword>|default <text>|list|clear', ownerOnly: true,
    extra: 'Example: .autoreply add price | NovaDash costs what is on my Selar page.',
    run: async (ctx) => {
      const s = ctx.deps.settings;
      const sub = (ctx.args[0] || 'list').toLowerCase();
      const tail = ctx.rest.slice(ctx.args[0]?.length ?? 0).trim();
      const ar = s.getChat(ctx.chat).autoreply;
      if (sub === 'on') { s.setAutoreply(ctx.chat, true); return ctx.reply(`💬 Autoreply *ON* (${ar.rules.length} rules).${ar.rules.length || ar.default ? '' : '\nAdd one: .autoreply add hello | Hi! I will reply soon.'}`); }
      if (sub === 'off') { s.setAutoreply(ctx.chat, false); return ctx.reply('💬 Autoreply *OFF*.'); }
      if (sub === 'add') {
        const [k, ...r] = tail.split('|');
        if (!k?.trim() || !r.join('|').trim()) return ctx.reply('Usage: *.autoreply add <keyword> | <reply>*');
        s.addRule(ctx.chat, k, r.join('|'));
        return ctx.reply(`✅ Rule saved for "${k.trim().toLowerCase()}".`);
      }
      if (sub === 'del') return ctx.reply(tail && s.delRule(ctx.chat, tail) ? '🗑️ Rule removed.' : 'No such rule.');
      if (sub === 'default') {
        if (!tail) return ctx.reply('Usage: *.autoreply default <text>* (private chats only, once per hour per person)');
        s.setDefaultReply(ctx.chat, tail);
        return ctx.reply('✅ Default reply saved.');
      }
      if (sub === 'clear') { s.clearAutoreply(ctx.chat); return ctx.reply('🧹 Autoreply cleared for this chat.'); }
      const rules = ar.rules.map((r) => `• ${r.k} → ${r.r}`).join('\n') || '(no rules)';
      return ctx.reply(`💬 Autoreply is *${ar.on ? 'ON' : 'OFF'}*\n${rules}${ar.default ? `\nDefault: ${ar.default}` : ''}`);
    } },

  { name: 'play', desc: 'Find a song: cover photo + audio', usage: 'play <song name or artist>',
    extra: 'Full tracks come from Jamendo (artist-shared music) when available; otherwise a 30s official preview. Copyrighted songs are not downloaded.',
    run: async (ctx) => {
      if (!ctx.rest) return ctx.reply('Usage: *.play <song or artist>*, e.g. *.play burna boy last last*');
      if (!ctx.isOwner) {
        const l = ctx.deps.playLimiter.hit(ctx.sender.key);
        if (!l.ok) return ctx.reply(`⏳ Try again in ${Math.ceil(l.retryAfterMs / 1000)}s.`);
      }
      const send = async (content) => { const m = await ctx.sock.sendMessage(ctx.chat, content, { quoted: ctx.msg }); ctx.deps.sentIds.add(m?.key?.id); };
      let full = null;
      try { full = await searchFullTrack(ctx.rest, ctx.deps.config.jamendoClientId, ctx.deps.fetchImpl); } catch (e) { ctx.deps.log.warn('full track search failed', e); }
      if (full) {
        const cap = `🎵 *${full.title}*\n👤 ${full.artist}${full.album ? `\n💿 ${full.album}` : ''}\n_Full track, shared by the artist (Jamendo)_`;
        try {
          if (full.cover) await send({ image: { url: full.cover }, caption: cap }); else await ctx.reply(cap);
          await send({ audio: { url: full.audio }, mimetype: 'audio/mpeg', ptt: false });
          return;
        } catch (e) { ctx.deps.log.warn('full track send failed', e); }
      }
      let song;
      try { song = await searchMusic(ctx.rest, ctx.deps.fetchImpl); } catch (e) {
        ctx.deps.log.warn('music search failed', e);
        return ctx.reply('⚠️ Music search is unavailable right now. Try again shortly.');
      }
      if (!song) return ctx.reply(`😕 No results for "${ctx.rest}".`);
      const caption = `🎵 *${song.title}*\n👤 ${song.artist}${song.album ? `\n💿 ${song.album}` : ''}\n_30s preview only: the full song is not available from free legal sources._`;
      try {
        if (song.cover) await send({ image: { url: song.cover }, caption }); else await ctx.reply(caption);
        if (song.preview) await send({ audio: { url: song.preview }, mimetype: 'audio/mp4', ptt: false });
        else await ctx.reply('No audio preview is available for this track.');
      } catch (e) {
        ctx.deps.log.warn('play send failed', e);
        await ctx.reply(`${caption}\n\n⚠️ Could not attach the media.`);
      }
    } },

  { name: 'vv', desc: 'Re-send a view-once media as normal media (consent-based)', usage: 'vv (reply to the view-once)',
    extra: 'Privacy rule: works only on view-once media the sender themselves asks to keep (they reply .vv to their own) or media the owner sent. I never unlock other people\'s view-once media.',
    run: async (ctx) => {
      const id = ctx.contextInfo?.stanzaId;
      if (!id) return ctx.reply('Reply to a view-once message with *.vv*.');
      const entry = ctx.deps.viewCache.get(id);
      if (!entry) return ctx.reply('I cannot access that one. I only keep view-once messages I received while online for 30 minutes, and only to help the sender keep their own media.');
      const allowed = entry.fromMe || overlaps(entry.sender, ctx.sender);
      if (!allowed) return ctx.reply('🔒 View-once is a privacy choice by the sender. I only convert it when the sender asks (they reply *.vv* to their own message).');
      const media = mediaOf(entry.msg.message);
      if (!media) return ctx.reply('That message has no media.');
      let buf;
      try { buf = await ctx.deps.download(entry.msg); } catch (e) {
        ctx.deps.log.warn('vv download failed', e);
        return ctx.reply('⚠️ The media has expired or could not be downloaded.');
      }
      if (!buf?.length || buf.length > 25 * 1024 * 1024) return ctx.reply('⚠️ Media is empty or too large (max 25 MB).');
      const caption = media.node.caption || undefined;
      const content = media.type === 'imageMessage' ? { image: buf, caption }
        : media.type === 'videoMessage' ? { video: buf, caption }
        : { audio: buf, mimetype: media.node.mimetype || 'audio/mp4', ptt: !!media.node.ptt };
      const sent = await ctx.sock.sendMessage(ctx.chat, content, { quoted: ctx.msg });
      ctx.deps.sentIds.add(sent?.key?.id);
    } },
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
export const findCommand = (name) => BY_NAME.get(name);

/** Shared by .warn and antilink. Removes at the limit when the bot is admin. */
export async function applyWarning(ctx, t, reason) {
  const { settings, config } = ctx.deps;
  const n = settings.addWarning(ctx.chat, t.ident.key);
  const at = `@${userPart(t.jid)} warning ${n}/${config.maxWarnings}. ${reason}.`;
  if (n < config.maxWarnings) return ctx.reply(`⚠️ ${at}`, [t.jid]);
  if (await ctx.isBotAdmin()) {
    const ok = await removeFromGroup(ctx, t).catch(() => false);
    if (ok) { settings.resetWarnings(ctx.chat, t.ident.key); return ctx.reply(`🚨 ${at}\nLimit reached, removed from the group.`, [t.jid]); }
  }
  return ctx.reply(`🚨 ${at}\nLimit reached, but I could not remove them (I need to be a group admin).`, [t.jid]);
}

export { containsLink };

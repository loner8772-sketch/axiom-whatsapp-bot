import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { FileStore } from './store.js';
import { Settings } from './settings.js';
import { Health } from './health.js';
import { createDeps, handleMessage } from './handler.js';
import { identity } from './jid.js';

export const OWNER = '2348011111111';
export const BOT = '2348000000000';
export const ADMIN = '2348022222222';
export const USER = '2348033333333';
export const USER2 = '2348044444444';
export const GROUP = '120363000000000000@g.us';
export const pn = (n) => `${n}@s.whatsapp.net`;

export function makeSock({ participants, failRemove = false, failBlock = false } = {}) {
  const sent = [];
  const calls = { remove: [], block: [] };
  const sock = {
    user: { id: `${BOT}:3@s.whatsapp.net` },
    sent, calls,
    sendMessage: async (jid, content, opts) => { const key = { id: `BOT${sent.length}`, remoteJid: jid, fromMe: true }; sent.push({ jid, content, opts, key }); return { key }; },
    sendPresenceUpdate: async () => {},
    groupMetadata: async () => ({ id: GROUP, participants: participants ?? [
      { id: pn(OWNER) }, { id: pn(BOT), admin: 'admin' }, { id: pn(ADMIN), admin: 'admin' }, { id: pn(USER) }, { id: pn(USER2) } ] }),
    groupParticipantsUpdate: async (g, ids, action) => { calls.remove.push({ g, ids, action }); return [{ status: failRemove ? '403' : '200', jid: ids[0] }]; },
    updateBlockStatus: async (jid, a) => { if (failBlock) throw new Error('nope'); calls.block.push({ jid, a }); },
  };
  return sock;
}

export async function makeEnv({ ai, participants, sockOpts, env = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-'));
  const store = new FileStore(dir); await store.init();
  const settings = new Settings(store, { debounceMs: 5 }); await settings.load();
  const config = loadConfig({ OWNER_NUMBER: OWNER, ...env });
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const fakeAi = ai ?? { providerName: 'fake', ask: async ({ mode, question }) => ({ text: `AI[${mode}]: ${question}`, provider: 'fake' }) };
  const sock = makeSock({ participants, ...sockOpts });
  const health = new Health(); health.set('open');
  const deps = createDeps({ config, settings, ai: fakeAi, health, store, log, selfIdent: () => identity(sock.user.id), download: async () => Buffer.from('media') });
  let n = 0;
  const send = (text, { from = USER, group = true, quoted, mentions, fromMe = false, extra } = {}) => {
    const key = { id: `M${++n}${Math.random().toString(36).slice(2, 6)}`, remoteJid: group ? GROUP : pn(from), fromMe, ...(group && !fromMe ? { participant: pn(from) } : {}) };
    const ci = { ...(quoted ? { stanzaId: quoted.id, participant: pn(quoted.from), quotedMessage: quoted.message } : {}), ...(mentions ? { mentionedJid: mentions.map(pn) } : {}) };
    const message = extra ?? { extendedTextMessage: { text, ...(Object.keys(ci).length ? { contextInfo: ci } : {}) } };
    return handleMessage(deps, sock, { key, message, messageTimestamp: Math.floor(Date.now() / 1000) });
  };
  const last = () => sock.sent.at(-1);
  const texts = () => sock.sent.map((s) => s.content.text).filter(Boolean);
  return { dir, store, settings, config, deps, sock, send, last, texts, cleanup: async () => { await settings.flush().catch(() => {}); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); } };
}

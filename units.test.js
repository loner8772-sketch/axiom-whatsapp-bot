import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { digits, userPart, identity, overlaps, findParticipant, isAdminParticipant, toUserJid } from './jid.js';
import { parseCommand, splitMessage, formatUptime } from './text.js';
import { containsLink } from './links.js';
import { loadConfig } from './config.js';
import { redact, createLogger } from './log.js';
import { FileStore } from './store.js';
import { Settings } from './settings.js';
import { Health } from './health.js';
import { useStoreAuthState } from './auth.js';
import { unwrap, extractText, isViewOnce, ViewOnceCache } from './message.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'axiom-u-'));

test('jid helpers', () => {
  assert.equal(digits('+234 801-234-5678'), '2348012345678');
  assert.equal(userPart('2348012345678:12@s.whatsapp.net'), '2348012345678');
  assert.equal(toUserJid('+234 80'), '23480@s.whatsapp.net');
  const a = identity('111@lid', '2348012345678@s.whatsapp.net');
  assert.equal(a.key, '2348012345678');
  assert.ok(overlaps(a, identity('111@lid')));
  assert.ok(!overlaps(a, identity('999@lid')));
  const meta = { participants: [{ id: '111@lid', phoneNumber: '2348012345678@s.whatsapp.net', admin: 'superadmin' }] };
  const p = findParticipant(meta, identity('2348012345678@s.whatsapp.net'));
  assert.ok(isAdminParticipant(p));
  assert.equal(findParticipant(meta, identity('5@lid')), null);
});

test('parseCommand', () => {
  assert.deepEqual(parseCommand('.ping', '.'), { name: 'ping', rest: '', args: [] });
  assert.deepEqual(parseCommand('.AI  hello   world', '.'), { name: 'ai', rest: 'hello   world', args: ['hello', 'world'] });
  assert.equal(parseCommand('...', '.'), null);
  assert.equal(parseCommand('hello', '.'), null);
  assert.equal(parseCommand('. ', '.'), null);
  assert.equal(parseCommand('..oops', '.'), null);
});

test('splitMessage and formatUptime', () => {
  const long = ('word '.repeat(1500)).trim();
  const parts = splitMessage(long, 1000);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 1000));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long);
  assert.deepEqual(splitMessage('short'), ['short']);
  assert.equal(formatUptime(90061), '1d 1h 1m 1s');
  assert.equal(formatUptime(5), '5s');
});

test('containsLink', () => {
  for (const t of ['https://example.com/x', 'join chat.whatsapp.com/AbC123', 'visit www.site.ng', 'go to google.com now', 'wa.me/2348012345678', 'bit.ly/abc is not caught but t.me/x is', 'selar.co/71nu']) {
    assert.ok(containsLink(t), t);
  }
  for (const t of ['hello there', 'I scored 3.5 in maths', 'mail me at john@gmail.com', 'e.g. this one', 'Node.js is fine', 'end.Next sentence']) {
    assert.ok(!containsLink(t), t);
  }
});

test('config validation and defaults', () => {
  assert.throws(() => loadConfig({}), /OWNER_NUMBER/);
  const c = loadConfig({ OWNER_NUMBER: '+234 801 111 1111', MAX_WARNINGS: '99', RENDER_EXTERNAL_URL: 'https://x.onrender.com/' });
  assert.equal(c.ownerNumber, '2348011111111');
  assert.equal(c.maxWarnings, 10);
  assert.equal(c.prefix, '.');
  assert.equal(c.selfPingUrl, 'https://x.onrender.com');
  assert.equal(c.pairingNumber, '2348011111111');
});

test('logger redacts secrets', () => {
  assert.ok(!redact('failed mongodb+srv://u:pw@c.mongodb.net/db').includes('pw'));
  assert.ok(!redact('key=AIzaSyA1234567890123456789012345').includes('AIza'));
  assert.ok(!redact('token=abc123').includes('abc123'));
  const lines = []; const log = createLogger('warn', { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) });
  log.info('hidden'); log.warn('shown');
  assert.equal(lines.length, 1);
});

test('FileStore persists, deletes and clears by prefix', async () => {
  const dir = await tmp(); const s = new FileStore(dir); await s.init();
  await s.set('a:1', { x: 1 }); await s.set('a:2/3', 'two'); await s.set('b', [1]);
  assert.deepEqual(await s.get('a:1'), { x: 1 });
  assert.equal(await s.get('missing', 'fb'), 'fb');
  await s.clear('a:');
  assert.equal(await s.get('a:1'), null);
  assert.equal(await s.get('a:2/3'), null);
  assert.deepEqual(await s.get('b'), [1]);
  await s.del('b'); assert.equal(await s.get('b'), null);
  await fs.rm(dir, { recursive: true });
});

test('Settings persist across restarts', async () => {
  const dir = await tmp(); const store = new FileStore(dir); await store.init();
  const a = new Settings(store, { debounceMs: 5 }); await a.load();
  a.setAntilink('g1', true); a.setAutoreply('g1', true); a.addRule('g1', 'Price', 'See Selar'); a.setDefaultReply('g1', 'Hi');
  a.restrict('234'); assert.equal(a.addWarning('g1', 'u'), 1); assert.equal(a.addWarning('g1', 'u'), 2);
  await a.flush();
  const b = new Settings(store); await b.load();
  assert.equal(b.getChat('g1').antilink, true);
  assert.deepEqual(b.getChat('g1').autoreply.rules, [{ k: 'price', r: 'See Selar' }]);
  assert.equal(b.getChat('g1').autoreply.default, 'Hi');
  assert.ok(b.isRestricted('234'));
  assert.equal(b.getWarnings('g1', 'u'), 2);
  b.resetWarnings('g1', 'u'); assert.equal(b.getWarnings('g1', 'u'), 0);
  assert.ok(b.unrestrict('234')); assert.ok(!b.unrestrict('234'));
  assert.ok(b.delRule('g1', 'PRICE')); assert.ok(!b.delRule('g1', 'price'));
  assert.equal(b.peekChat('never').antilink, false);
  assert.equal(b.data.chats.never, undefined);
  await fs.rm(dir, { recursive: true });
});

test('Health states', () => {
  let t = 0; const h = new Health(() => t);
  assert.ok(h.isHealthy()); t = 6 * 60 * 1000; assert.ok(!h.isHealthy());
  h.set('open'); assert.ok(h.isHealthy());
  h.set('logged_out'); assert.ok(!h.isHealthy());
  h.noteReconnect(); h.noteError(new Error('boom')); assert.equal(h.snapshot().reconnects, 1);
});

test('auth state round-trips through a store', async () => {
  const dir = await tmp(); const store = new FileStore(dir); await store.init();
  const lib = { BufferJSON: { replacer: (k, v) => (v?.type === 'Buffer' ? v : Buffer.isBuffer(v) ? { type: 'Buffer', data: [...v] } : v), reviver: (k, v) => (v?.type === 'Buffer' ? Buffer.from(v.data) : v) },
    initAuthCreds: () => ({ fresh: true }), proto: { Message: { AppStateSyncKeyData: { fromObject: (x) => ({ wrapped: x }) } } } };
  const one = await useStoreAuthState(store, lib);
  assert.deepEqual(one.state.creds, { fresh: true });
  one.state.creds.registered = true; await one.saveCreds();
  await one.state.keys.set({ 'pre-key': { 1: { k: 'v' }, 2: { k: 'w' } }, 'app-state-sync-key': { A: { z: 1 } } });
  const two = await useStoreAuthState(store, lib);
  assert.equal(two.state.creds.registered, true);
  assert.deepEqual(await two.state.keys.get('pre-key', ['1', '2', '3']), { 1: { k: 'v' }, 2: { k: 'w' } });
  assert.deepEqual((await two.state.keys.get('app-state-sync-key', ['A'])).A, { wrapped: { z: 1 } });
  await two.state.keys.set({ 'pre-key': { 1: null } });
  assert.deepEqual(await two.state.keys.get('pre-key', ['1']), {});
  await store.clear('auth:'); assert.equal(await store.get('auth:creds'), null);
  await fs.rm(dir, { recursive: true });
});

test('message helpers', () => {
  const vo = { viewOnceMessageV2: { message: { imageMessage: { caption: 'hi', viewOnce: true } } } };
  assert.ok(isViewOnce(vo)); assert.equal(extractText(vo), 'hi');
  assert.ok(unwrap({ ephemeralMessage: { message: { conversation: 'x' } } }).conversation === 'x');
  assert.ok(!isViewOnce({ conversation: 'x' }));
  let t = 0; const c = new ViewOnceCache({ max: 2, ttlMs: 100, now: () => t });
  c.put('a', { n: 1 }); c.put('b', { n: 2 }); c.put('c', { n: 3 });
  assert.equal(c.get('a'), null); assert.ok(c.get('c')); t = 500; assert.equal(c.get('c'), null);
});

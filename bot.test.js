import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bot } from './bot.js';
import { makeEnv, USER, pn } from './helpers.js';

function fakeLib() {
  const socks = [];
  return {
    socks,
    makeWASocket: (cfg) => {
      const ee = new EventEmitter();
      const sock = { ev: { on: (n, f) => ee.on(n, f), emit: (n, x) => ee.emit(n, x) }, cfg, sent: [], ended: false,
        user: { id: '2348000000000:1@s.whatsapp.net' }, authState: { creds: { registered: false } },
        requestPairingCode: async () => 'ABCD1234', end() { this.ended = true; },
        sendMessage: async (j, c) => { sock.sent.push({ j, c }); return { key: { id: `S${sock.sent.length}` } }; },
        sendPresenceUpdate: async () => {}, updateMediaMessage() {}, groupMetadata: async () => ({ participants: [] }) };
      socks.push(sock); return sock;
    },
    makeCacheableSignalKeyStore: (k) => k, fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    Browsers: { ubuntu: () => ['Ubuntu', 'Chrome', '1'] },
    BufferJSON: { replacer: (k, v) => v, reviver: (k, v) => v }, initAuthCreds: () => ({ registered: false }),
    proto: { Message: { AppStateSyncKeyData: { fromObject: (x) => x } } }, downloadMediaMessage: async () => Buffer.from('x'),
  };
}
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, max = 3000) { for (let i = 0; i < max; i++) { if (await fn()) return; await tick(); } throw new Error('condition not reached'); }
const closeWith = (sock, code) => sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });

async function setup() {
  const env = await makeEnv();
  const lib = fakeLib();
  const bot = new Bot({ config: env.config, store: env.store, settings: env.settings, ai: env.deps.ai, health: env.deps.health, log: env.deps.log, lib });
  env.deps.health.set('starting');
  await bot.start();
  return { env, lib, bot };
}

test('pairing code is requested once, exposed, and cleared once connected', async () => {
  const { env, lib, bot } = await setup();
  const sock = lib.socks[0];
  assert.equal(env.deps.health.state, 'connecting');
  sock.ev.emit('connection.update', { qr: 'x' }); sock.ev.emit('connection.update', { qr: 'y' }); await tick();
  assert.equal(bot.pairing.code, 'ABCD-1234');
  sock.ev.emit('connection.update', { connection: 'open' }); await tick();
  assert.equal(env.deps.health.state, 'open'); assert.equal(bot.pairing, null);
  await bot.stop(); await env.cleanup();
});

test('messages flow from the socket into command handlers', async () => {
  const { env, lib, bot } = await setup();
  const sock = lib.socks[0];
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'Z1', remoteJid: pn(USER) }, message: { conversation: '.awake' }, messageTimestamp: Math.floor(Date.now() / 1000) }] });
  await tick(); await tick();
  assert.match(sock.sent.at(-1).c.text, /awake/);
  await bot.stop(); await env.cleanup();
});

test('transient close reconnects with backoff and a fresh socket; stale sockets are ignored', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { env, lib, bot } = await setup();
    const first = lib.socks[0];
    closeWith(first, 428); await tick();
    assert.equal(env.deps.health.state, 'closed'); assert.equal(lib.socks.length, 1);
    mock.timers.tick(3000); await until(() => lib.socks.length === 2);
    assert.ok(first.ended); assert.equal(env.deps.health.reconnects, 1);
    first.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'STALE', remoteJid: pn(USER) }, message: { conversation: '.awake' }, messageTimestamp: Math.floor(Date.now() / 1000) }] });
    await tick(); assert.equal(first.sent.length, 0);
    await bot.stop(); await env.cleanup();
  } finally { mock.timers.reset(); }
});

test('restartRequired (515) reconnects immediately; connectionReplaced (440) waits 60s', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { env, lib, bot } = await setup();
    closeWith(lib.socks[0], 515); await tick();
    mock.timers.tick(600); await until(() => lib.socks.length === 2);
    closeWith(lib.socks[1], 440); await tick();
    mock.timers.tick(30000); for (let i = 0; i < 50; i++) await tick(); assert.equal(lib.socks.length, 2);
    mock.timers.tick(31000); await until(() => lib.socks.length === 3);
    await bot.stop(); await env.cleanup();
  } finally { mock.timers.reset(); }
});

test('logged out (401) clears the saved session and starts a fresh pairing', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { env, lib, bot } = await setup();
    await env.store.set('auth:creds', 'old'); await env.store.set('settings', { keep: true });
    closeWith(lib.socks[0], 401);
    await until(async () => (await env.store.get('auth:creds')) === null);
    assert.equal(env.deps.health.state, 'logged_out'); assert.ok(!env.deps.health.isHealthy());
    assert.deepEqual(await env.store.get('settings'), { keep: true });
    mock.timers.tick(10500); await until(() => lib.socks.length === 2);
    await bot.stop(); await env.cleanup();
  } finally { mock.timers.reset(); }
});

test('connect failure (e.g. database hiccup) is retried, not fatal', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const env = await makeEnv(); const lib = fakeLib();
    let fails = 1; const realGet = env.store.get.bind(env.store);
    env.store.get = async (k, f) => { if (fails-- > 0) throw new Error('db down'); return realGet(k, f); };
    const bot = new Bot({ config: env.config, store: env.store, settings: env.settings, ai: env.deps.ai, health: env.deps.health, log: env.deps.log, lib });
    await bot.start();
    assert.equal(lib.socks.length, 0); assert.ok(env.deps.health.lastError.includes('db down'));
    mock.timers.tick(3000); await until(() => lib.socks.length === 1);
    await bot.stop(); await env.cleanup();
  } finally { mock.timers.reset(); }
});

import { useStoreAuthState } from './auth.js';
import { createDeps, handleMessage } from './handler.js';
import { identity } from './jid.js';

async function loadLib() {
  const mod = await import('@whiskeysockets/baileys');
  const lib = { ...(mod.default && typeof mod.default === 'object' ? mod.default : {}), ...mod };
  lib.makeWASocket = typeof mod.makeWASocket === 'function' ? mod.makeWASocket : typeof mod.default === 'function' ? mod.default : lib.default?.default ?? lib.makeWASocket;
  return lib;
}

const LOGGED_OUT = 401;
const CONNECTION_REPLACED = 440;
const RESTART_REQUIRED = 515;

export class Bot {
  constructor({ config, store, settings, ai, health, log, lib }) {
    Object.assign(this, { config, store, settings, ai, health, log });
    this.injectedLib = lib;
    // Minimal pino-compatible logger for Baileys: silent, except errors shown at LOG_LEVEL=debug.
    const noop = () => {};
    const stub = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, fatal: noop, error: (...a) => log.debug('baileys', ...a) };
    stub.child = () => stub;
    this.plog = stub;
    this.gen = 0;
    this.sock = null;
    this.timer = null;
    this.attempt = 0;
    this.stopping = false;
    this.pairing = null;
    this.pairingRequested = false;
  }

  async start() {
    this.lib = this.injectedLib ?? (await loadLib());
    this.deps = createDeps({
      config: this.config, settings: this.settings, ai: this.ai, health: this.health, store: this.store, log: this.log,
      selfIdent: () => identity(this.sock?.user?.id, this.sock?.user?.lid),
      download: (m) => this.lib.downloadMediaMessage(m, 'buffer', {}, { logger: this.plog, reuploadRequest: this.sock.updateMediaMessage }),
    });
    this.watchdog = setInterval(() => this.#watch(), 30000);
    this.watchdog.unref?.();
    await this.#connectSafe();
  }

  #watch() {
    const { state } = this.health;
    if (this.stopping || state === 'open' || state === 'logged_out') return;
    const age = this.health.stateAgeMs();
    if (age > 15 * 60 * 1000) { this.log.error('Stuck without a connection for 15 min; exiting so the host restarts me.'); process.exit(1); }
    if (age > 3 * 60 * 1000 && !this.timer) { this.log.warn('Connection stalled; forcing reconnect.'); this.#schedule(0); }
  }

  async #connectSafe() {
    try { await this.connect(); } catch (e) { this.log.error('connect failed', e); this.health.noteError(e); this.health.set('closed'); this.#schedule(); }
  }

  async connect() {
    if (this.stopping) return;
    clearTimeout(this.timer); this.timer = null;
    const gen = ++this.gen;
    try { this.sock?.end?.(undefined); } catch { /* old socket already dead */ }
    this.health.set('connecting');
    const lib = this.lib;
    let version;
    try { ({ version } = await lib.fetchLatestBaileysVersion()); } catch (e) { this.log.warn('could not fetch latest WA version; using library default'); }
    const { state, saveCreds } = await useStoreAuthState(this.store, lib);
    const sock = lib.makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: lib.makeCacheableSignalKeyStore(state.keys, this.plog) },
      logger: this.plog,
      browser: lib.Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000,
      getMessage: async () => undefined,
    });
    this.sock = sock;
    this.pairingRequested = false;

    sock.ev.on('creds.update', async () => { try { await saveCreds(); } catch (e) { this.log.error('saving credentials failed', e); } });
    sock.ev.on('connection.update', (u) => this.#onConnection(gen, sock, u).catch((e) => this.log.error('connection handler error', e)));
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (gen !== this.gen) return;
      for (const m of messages) handleMessage(this.deps, sock, m, type).catch((e) => this.log.error('message error', e));
    });
    sock.ev.on('group-participants.update', (ev) => this.deps.groupCache.delete(ev.id));
    sock.ev.on('groups.update', (evs) => evs.forEach((g) => this.deps.groupCache.delete(g.id)));
  }

  async #requestPairing(sock) {
    try {
      const raw = await sock.requestPairingCode(this.config.pairingNumber);
      const code = String(raw).match(/.{1,4}/g)?.join('-') ?? String(raw);
      this.pairing = { code, at: Date.now() };
      this.log.info(`PAIRING CODE: ${code}  (WhatsApp > Linked devices > Link with phone number)`);
    } catch (e) { this.log.error('pairing code request failed', e); }
  }

  async #onConnection(gen, sock, u) {
    if (gen !== this.gen) return;
    const { connection, lastDisconnect, qr } = u;
    if (qr && !sock.authState?.creds?.registered && !this.pairingRequested) {
      this.pairingRequested = true;
      await this.#requestPairing(sock);
    }
    if (connection === 'open') {
      this.health.set('open'); this.attempt = 0; this.pairing = null;
      this.log.info('WhatsApp connection open');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      this.health.noteError(lastDisconnect?.error);
      this.log.warn(`connection closed (code ${code ?? 'n/a'})`);
      if (code === LOGGED_OUT) {
        this.health.set('logged_out');
        await this.store.clear('auth:').catch((e) => this.log.error('could not clear old session', e));
        this.log.warn('Logged out from WhatsApp. Session cleared; a new pairing code will be generated.');
        this.#schedule(10000, false);
      } else if (code === CONNECTION_REPLACED) {
        this.health.set('closed');
        this.log.warn('Session opened somewhere else (is another copy of the bot running?). Waiting 60s.');
        this.#schedule(60000, false);
      } else if (code === RESTART_REQUIRED) {
        this.health.set('connecting');
        this.#schedule(500, false);
      } else {
        this.health.set('closed');
        this.#schedule();
      }
    }
  }

  #schedule(ms, backoff = true) {
    if (this.stopping || this.timer) return;
    let delay = ms;
    if (delay === undefined || backoff) {
      delay = ms ?? Math.min(60000, 1000 * 2 ** this.attempt) + Math.floor(Math.random() * 1000);
      this.attempt += 1;
    }
    this.health.noteReconnect();
    this.timer = setTimeout(() => { this.timer = null; this.#connectSafe(); }, delay);
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.watchdog);
    clearTimeout(this.timer);
    try { this.sock?.end?.(undefined); } catch { /* ignore */ }
  }
}

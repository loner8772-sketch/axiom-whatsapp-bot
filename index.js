import http from 'node:http';
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createStore } from './store.js';
import { Settings } from './settings.js';
import { Health } from './health.js';
import { AiClient } from './ai.js';
import { Bot } from './bot.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const tokenOk = (given, wanted) => !!wanted && crypto.timingSafeEqual(sha(given), sha(wanted));

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const health = new Health();
  let bot = null;

  // HTTP first, so the host sees an open port immediately.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(health.isHealthy() ? 200 : 503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(health.snapshot()));
    }
    if (url.pathname === '/pair') {
      if (!tokenOk(url.searchParams.get('token') || '', config.adminToken)) { res.writeHead(404); return res.end('Not found'); }
      const p = bot?.pairing;
      const body = health.state === 'open' ? 'Already linked. Nothing to do.'
        : p ? `Pairing code: ${p.code}\nWhatsApp > Settings > Linked devices > Link a device > Link with phone number instead.\n(refreshes every 10s)`
        : 'No code yet. This page refreshes every 10s...';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(`<!doctype html><meta name=viewport content="width=device-width"><meta http-equiv=refresh content=10><body style="font:20px sans-serif;padding:24px;white-space:pre-wrap">${body}</body>`);
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`${config.botName} is running`);
  });
  server.listen(config.port, '0.0.0.0', () => log.info(`HTTP listening on :${config.port}`));

  const store = await createStore(config);
  log.info(`storage: ${store.kind}${store.kind === 'file' ? ' (NOT persistent on free hosts; set MONGODB_URI)' : ''}`);
  const settings = new Settings(store);
  await settings.load();
  const ai = new AiClient({ geminiKey: config.geminiKey, geminiModel: config.geminiModel, novadashNotes: config.novadashNotes });
  bot = new Bot({ config, store, settings, ai, health, log });
  await bot.start();

  if (config.selfPingUrl) {
    const t = setInterval(() => fetch(`${config.selfPingUrl}/health`).catch(() => {}), 4 * 60 * 1000);
    t.unref?.();
  }

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return; closing = true;
    log.info(`${sig} received, shutting down`);
    await bot.stop();
    await settings.flush().catch(() => {});
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
  process.on('uncaughtException', async (e) => {
    log.error('uncaughtException', e);
    await settings.flush().catch(() => {});
    process.exit(1); // host restarts the process
  });
}

main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exit(1); });

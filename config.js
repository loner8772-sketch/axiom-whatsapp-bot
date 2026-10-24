import { digits } from './jid.js';

export function loadConfig(env = process.env) {
  const ownerNumber = digits(env.OWNER_NUMBER || '');
  if (ownerNumber.length < 7 || ownerNumber.length > 15) {
    throw new Error('OWNER_NUMBER is required: digits only with country code, e.g. 2348012345678');
  }
  const prefix = (env.PREFIX || '.').trim() || '.';
  const maxWarnings = Math.min(Math.max(parseInt(env.MAX_WARNINGS || '3', 10) || 3, 1), 10);
  const selfPing = env.SELF_PING_URL || env.RENDER_EXTERNAL_URL || '';
  return Object.freeze({
    botName: env.BOT_NAME || 'AXIOM BOT',
    ownerNumber,
    prefix,
    maxWarnings,
    port: parseInt(env.PORT || '3000', 10) || 3000,
    mongoUri: env.MONGODB_URI || '',
    mongoDb: env.MONGODB_DB || 'axiom',
    dataDir: env.DATA_DIR || './data',
    adminToken: env.ADMIN_TOKEN || '',
    pairingNumber: digits(env.PAIRING_NUMBER || '') || ownerNumber,
    geminiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-2.5-flash',
    jamendoClientId: env.JAMENDO_CLIENT_ID || '',
    novadashNotes: env.NOVADASH_NOTES || '',
    selfPingUrl: selfPing.replace(/\/+$/, ''),
    logLevel: env.LOG_LEVEL || 'info',
  });
}

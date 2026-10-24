import test from 'node:test';
import assert from 'node:assert/strict';
import { AiClient, AiError, RateLimiter, detectMode, parseAiArgs, parseStudy, systemPrompt } from './ai.js';

const ok = (body, json = true) => async () => ({ ok: true, status: 200, json: async () => body, text: async () => (json ? JSON.stringify(body) : body) });
const fail = (status) => async () => ({ ok: false, status });
const gemini = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });

test('detectMode routes questions', () => {
  assert.equal(detectMode('write a post for NovaDash'), 'novadash');
  assert.equal(detectMode('explain WAEC physics motion'), 'study');
  assert.equal(detectMode('find a winning product from a dropship supplier'), 'dropship');
  assert.equal(detectMode('give me a tiktok hook'), 'content');
  assert.equal(detectMode('what is the capital of Ghana'), 'general');
});

test('parseAiArgs / parseStudy', () => {
  assert.deepEqual(parseAiArgs(['dropship', 'phone', 'stands']), { mode: 'dropship', question: 'phone stands' });
  assert.deepEqual(parseAiArgs(['novadash']), { mode: 'novadash', question: 'novadash' });
  assert.deepEqual(parseStudy('chemistry: what is a mole'), { subject: 'Chemistry', question: 'what is a mole' });
  assert.deepEqual(parseStudy('digital tech - wk3 spreadsheets'), { subject: 'Digital Technologies', question: 'wk3 spreadsheets' });
  assert.deepEqual(parseStudy('what is a mole'), { subject: null, question: 'what is a mole' });
  assert.deepEqual(parseStudy('random: thing'), { subject: null, question: 'random: thing' });
});

test('system prompts include NovaDash facts and notes, never invent', () => {
  const p = systemPrompt('novadash', 'Price is on Selar');
  assert.match(p, /selar\.com\/71nu167m7o/); assert.match(p, /Price is on Selar/); assert.match(p, /no backend/i);
  assert.match(systemPrompt('study'), /WAEC/);
});

test('RateLimiter windowing', () => {
  const r = new RateLimiter({ windowMs: 1000, max: 2 });
  assert.ok(r.hit('a', 0).ok); assert.ok(r.hit('a', 10).ok);
  const x = r.hit('a', 20); assert.ok(!x.ok); assert.equal(x.retryAfterMs, 980);
  assert.ok(r.hit('b', 20).ok); assert.ok(r.hit('a', 1001).ok);
});

test('Gemini success keeps short history', async () => {
  const calls = [];
  const ai = new AiClient({ geminiKey: 'k', fetchImpl: async (u, o) => { calls.push({ u, o }); return ok(gemini('hello'))(); } });
  const r = await ai.ask({ mode: 'general', question: 'hi', chatId: 'c' });
  assert.deepEqual(r, { text: 'hello', provider: 'gemini' });
  assert.equal(calls[0].o.headers['x-goog-api-key'], 'k');
  assert.ok(!calls[0].u.includes('k=') && !calls[0].u.includes('key='));
  await ai.ask({ mode: 'general', question: 'again', chatId: 'c' });
  assert.equal(JSON.parse(calls[1].o.body).contents.length, 3);
});

test('falls back to Pollinations when Gemini fails', async () => {
  const ai = new AiClient({ geminiKey: 'k', fetchImpl: async (u) => (u.includes('googleapis') ? fail(429)() : ok('fallback answer', false)()) });
  assert.deepEqual(await ai.ask({ question: 'x' }), { text: 'fallback answer', provider: 'pollinations' });
});

test('keyless mode uses Pollinations only', async () => {
  const urls = [];
  const ai = new AiClient({ fetchImpl: async (u) => { urls.push(u); return ok('ok', false)(); } });
  await ai.ask({ question: 'x' });
  assert.deepEqual(urls, ['https://text.pollinations.ai/']);
});

test('all providers failing throws AiError; blank question rejected; timeout handled', async () => {
  const ai = new AiClient({ geminiKey: 'k', fetchImpl: fail(500) });
  await assert.rejects(ai.ask({ question: 'x' }), AiError);
  await assert.rejects(ai.ask({ question: '   ' }), AiError);
  const slow = new AiClient({ timeoutMs: 20, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))) });
  await assert.rejects(slow.ask({ question: 'x' }), /timeout/);
});

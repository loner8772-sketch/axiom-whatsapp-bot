import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, OWNER, ADMIN, USER, USER2, BOT, GROUP, pn } from './helpers.js';
import { AiError } from './ai.js';

const withEnv = (opts, fn) => async () => { const e = await makeEnv(opts); try { await fn(e); } finally { await e.cleanup(); } };

test('.menu lists every required command', withEnv({}, async (e) => {
  await e.send('.menu');
  const t = e.last().content.text;
  for (const c of ['menu', 'help', 'ping', 'awake', 'status', 'ai', 'study', 'script', 'block', 'unblock', 'remove', 'tagall', 'vv', 'warn', 'warnings', 'antilink', 'autoreply', 'owner']) assert.ok(t.includes(`.${c}`), c);
}));

test('.help, .ping, .awake, .status, .owner', withEnv({}, async (e) => {
  await e.send('.help'); assert.match(e.last().content.text, /menu/);
  await e.send('.help remove'); assert.match(e.last().content.text, /group admins/);
  await e.send('.help nonsense'); assert.match(e.last().content.text, /Unknown command/);
  await e.send('.ping'); assert.match(e.sock.sent.at(-2).content.text, /Pong/); assert.ok(e.last().content.edit);
  await e.send('.awake'); assert.match(e.last().content.text, /awake/);
  await e.send('.status'); assert.match(e.last().content.text, /Connection: open[\s\S]*Storage: file[\s\S]*AI: fake/);
  await e.send('.owner'); assert.ok(e.sock.sent.some((s) => s.content.contacts)); assert.match(e.last().content.text, new RegExp(OWNER));
}));

test('unknown commands and plain chat are ignored', withEnv({}, async (e) => {
  await e.send('.doesnotexist'); await e.send('hello everyone'); await e.send('...');
  assert.equal(e.sock.sent.length, 0);
}));

test('own bot messages and duplicates are not re-processed', withEnv({}, async (e) => {
  const msg = { key: { id: 'DUP1', remoteJid: GROUP, participant: pn(USER) }, message: { conversation: '.awake' }, messageTimestamp: Math.floor(Date.now() / 1000) };
  const { handleMessage } = await import('./handler.js');
  await handleMessage(e.deps, e.sock, msg); await handleMessage(e.deps, e.sock, msg);
  assert.equal(e.sock.sent.length, 1);
  e.deps.sentIds.add('BOTX');
  await handleMessage(e.deps, e.sock, { key: { id: 'BOTX', remoteJid: GROUP, fromMe: true }, message: { conversation: '.awake' }, messageTimestamp: Math.floor(Date.now() / 1000) });
  assert.equal(e.sock.sent.length, 1);
  await handleMessage(e.deps, e.sock, { key: { id: 'OLD1', remoteJid: GROUP, participant: pn(USER) }, message: { conversation: '.awake' }, messageTimestamp: 1000 });
  assert.equal(e.sock.sent.length, 1);
}));

test('.ai / .study / .script call the AI with the right mode and handle limits and failures', withEnv({}, async (e) => {
  await e.send('.ai what is 2+2'); assert.equal(e.last().content.text, 'AI[general]: what is 2+2');
  await e.send('.ai novadash write a tweet'); assert.equal(e.last().content.text, 'AI[novadash]: write a tweet');
  await e.send('.study physics: define velocity'); assert.match(e.last().content.text, /AI\[study\]: Subject: Physics\nQuestion: define velocity/);
  await e.send('.study subjects'); assert.match(e.last().content.text, /Technical Drawing/);
  await e.send('.script NovaDash demo'); assert.match(e.last().content.text, /AI\[script\]: Topic: NovaDash demo/);
  await e.send('.ai'); assert.match(e.last().content.text, /Ask me something/);
  await e.send('.ai explain this', { quoted: { id: 'Q1', from: USER2, message: { conversation: 'photosynthesis' } } });
  assert.match(e.last().content.text, /Quoted message:\nphotosynthesis/);
}));

test('AI rate limit applies to members, not the owner; failures are friendly', withEnv({}, async (e) => {
  for (let i = 0; i < 8; i++) await e.send(`.ai q${i}`);
  await e.send('.ai one more'); assert.match(e.last().content.text, /Slow down/);
  await e.send('.ai owner question', { from: OWNER }); assert.match(e.last().content.text, /AI\[general\]/);
}));

test('AI failure message does not leak internals', withEnv({ ai: { providerName: 'x', ask: async () => { throw new AiError('gemini:HTTP 500 key=SECRET'); } } }, async (e) => {
  await e.send('.ai hi');
  assert.match(e.last().content.text, /unavailable/); assert.ok(!e.last().content.text.includes('SECRET'));
}));

test('.block/.unblock are owner-only and restrict users', withEnv({}, async (e) => {
  await e.send('.block ' + USER2, { from: USER }); assert.match(e.last().content.text, /Owner only/);
  await e.send('.block ' + USER2, { from: OWNER });
  assert.match(e.last().content.text, /Blocked/); assert.deepEqual(e.sock.calls.block[0], { jid: pn(USER2), a: 'block' });
  assert.ok(e.settings.isRestricted(USER2));
  const before = e.sock.sent.length;
  await e.send('.ping', { from: USER2 }); assert.equal(e.sock.sent.length, before);
  await e.send('.unblock ' + USER2, { from: OWNER }); assert.match(e.last().content.text, /Unblocked/);
  assert.ok(!e.settings.isRestricted(USER2));
  await e.send('.block ' + OWNER, { from: OWNER }); assert.match(e.last().content.text, /will not block the owner/);
  await e.send('.block', { from: OWNER }); assert.match(e.last().content.text, /Who should I block/);
}));

test('.block in a private chat targets that user; WhatsApp failure still restricts', withEnv({ sockOpts: { failBlock: true } }, async (e) => {
  await e.send('.block', { from: USER, group: false, fromMe: false }); assert.match(e.last().content.text, /Owner only/);
  const { handleMessage } = await import('./handler.js');
  await handleMessage(e.deps, e.sock, { key: { id: 'PM1', remoteJid: pn(USER), fromMe: true }, message: { conversation: '.block' }, messageTimestamp: Math.floor(Date.now() / 1000) });
  assert.match(e.last().content.text, /WhatsApp block failed, but .* restricted/);
  assert.ok(e.settings.isRestricted(USER));
}));

test('.remove permissions and behaviour', withEnv({}, async (e) => {
  await e.send('.remove ' + USER2, { from: USER }); assert.match(e.last().content.text, /Only group admins/);
  await e.send('.remove', { from: ADMIN }); assert.match(e.last().content.text, /Who should I remove/);
  await e.send('.remove ' + ADMIN, { from: ADMIN }); assert.match(e.last().content.text, /admin/);
  await e.send('.remove ' + OWNER, { from: ADMIN }); assert.match(e.last().content.text, /cannot remove the owner/);
  await e.send('.remove 2349999999999', { from: ADMIN }); assert.match(e.last().content.text, /not in this group/);
  await e.send('.remove', { from: ADMIN, quoted: { id: 'Q', from: USER2, message: { conversation: 'x' } } });
  assert.deepEqual(e.sock.calls.remove.at(-1), { g: GROUP, ids: [pn(USER2)], action: 'remove' });
  assert.match(e.last().content.text, /Removed/);
}));

test('.remove needs bot admin and reports WhatsApp refusal; group-only guard', async () => {
  const noBotAdmin = [{ id: pn(OWNER) }, { id: pn(BOT) }, { id: pn(ADMIN), admin: 'admin' }, { id: pn(USER) }];
  const e = await makeEnv({ participants: noBotAdmin });
  await e.send('.remove ' + USER, { from: ADMIN }); assert.match(e.last().content.text, /Make me a group admin/);
  assert.equal(e.sock.calls.remove.length, 0);
  await e.send('.remove ' + USER, { group: false, from: OWNER, fromMe: false }); assert.match(e.last().content.text, /groups only|Owner/);
  await e.cleanup();
  const f = await makeEnv({ sockOpts: { failRemove: true } });
  await f.send('.remove ' + USER, { from: ADMIN }); assert.match(f.last().content.text, /refused/);
  await f.cleanup();
});

test('.tagall mentions everyone, admin only', withEnv({}, async (e) => {
  await e.send('.tagall', { from: USER }); assert.match(e.last().content.text, /Only group admins/);
  await e.send('.tagall Meeting at 5', { from: ADMIN });
  assert.match(e.last().content.text, /Meeting at 5/); assert.equal(e.last().content.mentions.length, 5);
  assert.match(e.last().content.text, new RegExp(`@${USER2}`));
}));

test('.warn escalates to removal; .warnings shows and resets', withEnv({}, async (e) => {
  await e.send('.warn ' + USER, { from: USER2 }); assert.match(e.last().content.text, /Only group admins/);
  await e.send('.warn ' + ADMIN, { from: ADMIN }); assert.match(e.last().content.text, /cannot warn admins/);
  await e.send('.warn ' + USER, { from: ADMIN }); assert.match(e.last().content.text, /warning 1\/3/);
  await e.send('.warnings ' + USER, { from: USER2 }); assert.match(e.last().content.text, /has 1\/3/);
  await e.send('.warn ' + USER, { from: ADMIN }); assert.match(e.last().content.text, /warning 2\/3/);
  await e.send('.warnings reset ' + USER, { from: USER2 }); assert.match(e.last().content.text, /Only admins can reset/);
  await e.send('.warn ' + USER, { from: ADMIN });
  assert.match(e.last().content.text, /warning 3\/3[\s\S]*removed/);
  assert.equal(e.sock.calls.remove.length, 1);
  assert.equal(e.settings.getWarnings(GROUP, USER), 0);
  await e.send('.warn ' + USER2, { from: ADMIN }); await e.send('.warnings reset ' + USER2, { from: ADMIN });
  assert.equal(e.settings.getWarnings(GROUP, USER2), 0);
  await e.send('.warnings', { from: USER2 }); assert.match(e.last().content.text, /has 0\/3/);
}));

test('.warn at limit without bot admin explains instead of failing silently', async () => {
  const p = [{ id: pn(OWNER) }, { id: pn(BOT) }, { id: pn(ADMIN), admin: 'admin' }, { id: pn(USER) }];
  const e = await makeEnv({ participants: p, env: { MAX_WARNINGS: '1' } });
  await e.send('.warn ' + USER, { from: ADMIN });
  assert.match(e.last().content.text, /could not remove them/);
  await e.cleanup();
});

test('.antilink toggles and enforces', withEnv({}, async (e) => {
  await e.send('.antilink on', { from: USER }); assert.match(e.last().content.text, /Only group admins/);
  await e.send('https://spam.com', { from: USER2 }); assert.equal(e.sock.sent.length, 1);
  await e.send('.antilink on', { from: ADMIN }); assert.match(e.last().content.text, /ON/);
  await e.send('.antilink status', { from: ADMIN }); assert.match(e.last().content.text, /ON/);
  const n = e.sock.sent.length;
  await e.send('check https://spam.com now', { from: USER2 });
  assert.ok(e.sock.sent[n].content.delete); assert.match(e.last().content.text, /warning 1\/3[\s\S]*Links are not allowed/);
  const m = e.sock.sent.length;
  await e.send('my site google.com', { from: ADMIN }); assert.equal(e.sock.sent.length, m);
  await e.send('see https://ok.com', { from: OWNER }); assert.equal(e.sock.sent.length, m);
  await e.send('no link here', { from: USER2 }); assert.equal(e.sock.sent.length, m);
  await e.send('.antilink off', { from: ADMIN }); await e.send('https://spam.com', { from: USER2 });
  assert.equal(e.sock.sent.length, m + 1);
}));

test('.antilink does nothing destructive when bot is not admin', async () => {
  const e = await makeEnv({ participants: [{ id: pn(OWNER) }, { id: pn(BOT) }, { id: pn(ADMIN), admin: 'admin' }, { id: pn(USER) }] });
  await e.send('.antilink on', { from: ADMIN }); assert.match(e.last().content.text, /Make me a group admin/);
  const n = e.sock.sent.length; await e.send('https://x.com', { from: USER }); assert.equal(e.sock.sent.length, n);
  await e.cleanup();
});

test('.autoreply is owner-only and replies to keywords with cooldown; default only in private', withEnv({}, async (e) => {
  await e.send('.autoreply on', { from: ADMIN }); assert.match(e.last().content.text, /Owner only/);
  await e.send('.autoreply on', { from: OWNER }); assert.match(e.last().content.text, /ON/);
  await e.send('.autoreply add price | It is on my Selar page', { from: OWNER }); assert.match(e.last().content.text, /Rule saved/);
  await e.send('.autoreply add bad', { from: OWNER }); assert.match(e.last().content.text, /Usage/);
  await e.send('what is the PRICE?', { from: USER }); assert.equal(e.last().content.text, 'It is on my Selar page');
  const n = e.sock.sent.length; await e.send('price again', { from: USER2 }); assert.equal(e.sock.sent.length, n);
  await e.send('.autoreply list', { from: OWNER }); assert.match(e.last().content.text, /price → It is on my Selar page/);
  await e.send('.autoreply del price', { from: OWNER }); assert.match(e.last().content.text, /removed/);
  await e.send('.autoreply default Hi, owner will reply soon', { from: OWNER }); assert.match(e.last().content.text, /Default reply saved/);
  const m = e.sock.sent.length; await e.send('hello', { from: USER }); assert.equal(e.sock.sent.length, m);
  await e.send('.autoreply clear', { from: OWNER }); assert.match(e.last().content.text, /cleared/);
}));

test('autoreply default works in private chats once per hour', withEnv({}, async (e) => {
  const { handleMessage } = await import('./handler.js');
  const own = (text, id) => handleMessage(e.deps, e.sock, { key: { id, remoteJid: pn(USER), fromMe: true }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) });
  await own('.autoreply default Hi, I will reply soon', 'A1'); await own('.autoreply on', 'A2');
  // owner's chat with USER is the DM jid; settings are per chat jid
  const them = (text, id) => handleMessage(e.deps, e.sock, { key: { id, remoteJid: pn(USER), fromMe: false }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) });
  await them('hello', 'B1'); assert.equal(e.last().content.text, 'Hi, I will reply soon');
  const n = e.sock.sent.length; await them('hello?', 'B2'); assert.equal(e.sock.sent.length, n);
}));

const vo = (from, id = 'VO1', fromMe = false) => ({ id, from, fromMe, message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'secret', viewOnce: true, mimetype: 'image/jpeg' } } } } });

test('.vv: sender can keep their own view-once; others cannot unlock it; owner cannot override', withEnv({}, async (e) => {
  const v = vo(USER);
  await e.send('', { from: USER, extra: v.message }); // arrives and is cached by reference only
  await e.send('.vv', { from: USER2, quoted: { id: 'MISSING', from: USER, message: v.message } }); assert.match(e.last().content.text, /cannot access/);
  const key = e.sock.sent.length;
  // re-send with a known id so cache lookup works
  const { handleMessage } = await import('./handler.js');
  await handleMessage(e.deps, e.sock, { key: { id: 'VO9', remoteJid: GROUP, participant: pn(USER) }, message: v.message, messageTimestamp: Math.floor(Date.now() / 1000) });
  const quoted = { id: 'VO9', from: USER, message: v.message };
  await e.send('.vv', { from: USER2, quoted }); assert.match(e.last().content.text, /privacy choice/);
  await e.send('.vv', { from: OWNER, quoted }); assert.match(e.last().content.text, /privacy choice/);
  assert.equal(e.sock.sent.filter((s) => s.content.image).length, 0);
  await e.send('.vv', { from: USER, quoted });
  assert.ok(Buffer.isBuffer(e.last().content.image)); assert.equal(e.last().content.caption, 'secret');
  await e.send('.vv', { from: USER }); assert.match(e.last().content.text, /Reply to a view-once/);
}));

test('.vv: owner can keep their own view-once; media failures are friendly', withEnv({}, async (e) => {
  const { handleMessage } = await import('./handler.js');
  const v = vo(OWNER);
  await handleMessage(e.deps, e.sock, { key: { id: 'OWN1', remoteJid: GROUP, fromMe: true }, message: v.message, messageTimestamp: Math.floor(Date.now() / 1000) });
  await e.send('.vv', { from: OWNER, quoted: { id: 'OWN1', from: OWNER, message: v.message } });
  assert.ok(e.last().content.image);
  e.deps.download = async () => { throw new Error('expired'); };
  await e.send('.vv', { from: OWNER, quoted: { id: 'OWN1', from: OWNER, message: v.message } });
  assert.match(e.last().content.text, /expired or could not/);
}));

test('a command that throws gets a friendly error, not a crash', withEnv({ ai: { providerName: 'x', ask: async () => { throw new TypeError('bug'); } } }, async (e) => {
  await e.send('.ai hi'); assert.match(e.last().content.text, /Could not get an AI answer|went wrong/);
  e.sock.groupMetadata = async () => { throw new Error('boom'); };
  await e.send('.tagall', { from: ADMIN }); assert.match(e.last().content.text, /could not read the group info/);
}));

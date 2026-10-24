export class AiError extends Error {}

const BASE = 'You are AXIOM, an assistant inside WhatsApp. Be accurate and concise (under about 250 words unless asked for more). Use plain text with WhatsApp formatting only (*bold*, _italic_, short lines, simple lists); no markdown headers or tables. If you are unsure, say so. Never invent facts, statistics, prices, links or testimonials. If the user writes in Nigerian Pidgin, reply in Pidgin.';

const SUBJECTS = ['Mathematics', 'Technical Drawing', 'Civic Education', 'Digital Technologies', 'English Language', 'Chemistry', 'Economics', 'Geography', 'Biology', 'Physics', 'Food and Nutrition'];
export const STUDY_SUBJECTS = SUBJECTS;

export function systemPrompt(mode, novadashNotes = '') {
  switch (mode) {
    case 'study':
      return `${BASE}\nYou are a patient Nigerian secondary-school tutor (JSS/SS level, aligned with WAEC, NECO and JAMB). Explain step by step in simple language, give one short worked example, then end with a 1-2 question quick check. Use Nigerian examples where natural. If the exact school scheme of work is unclear, say the student should confirm with class notes.`;
    case 'dropship':
      return `${BASE}\nYou are a dropshipping research assistant for a beginner in Nigeria/Africa with very little capital. Cover product selection criteria, realistic margins after delivery and payment fees, supplier vetting, delivery times, returns, and low-cost testing via organic content. You cannot browse live data: label any numbers as rough estimates to verify, never promise profits, and warn about scams and fake suppliers.`;
    case 'content':
      return `${BASE}\nYou are a social-media content strategist for a Nigerian audience. Give strong hooks, captions, post ideas and calls to action that are specific and ready to post. Keep claims honest.`;
    case 'script':
      return `${BASE}\nWrite a short-form video script (TikTok/Reels/WhatsApp Status), default about 30 seconds. Format: *Hook* (first 3 seconds), *Body* (3-5 short beats with on-screen text ideas), *CTA*. Keep it natural for a Nigerian audience and easy to film on a phone.`;
    case 'novadash':
      return `${BASE}\nYou help the owner sell NovaDash: a premium SaaS-style HTML5 dashboard template (frontend only) sold on Selar at https://selar.com/71nu167m7o. Write honest, persuasive copy, ideas and replies to buyer questions. Use ONLY facts given here or by the user. Do not invent features, prices, discounts, testimonials, sales numbers or backend capabilities; if a fact is missing, ask for it. NovaDash has no backend.${novadashNotes ? `\nExtra facts from the owner: ${novadashNotes}` : ''}`;
    default:
      return BASE;
  }
}

export function detectMode(q) {
  const s = String(q || '').toLowerCase();
  if (/novadash|selar|dashboard template/.test(s)) return 'novadash';
  if (/\b(waec|neco|jamb|ss[123]|jss[123]|mathematics|maths|physics|chemistry|biology|economics|geography|civic education|technical drawing|food and nutrition|english language|digital technolog)/.test(s)) return 'study';
  if (/dropship|supplier|aliexpress|cj dropshipping|product research|winning product/.test(s)) return 'dropship';
  if (/caption|hook|tiktok|reel|status post|content idea|post idea|thumbnail/.test(s)) return 'content';
  return 'general';
}

const AI_PREFIXES = { novadash: 'novadash', dropship: 'dropship', research: 'dropship', content: 'content', study: 'study', general: 'general' };
/** ".ai novadash write a post" -> {mode:'novadash', question:'write a post'} */
export function parseAiArgs(args) {
  const first = (args[0] || '').toLowerCase();
  if (AI_PREFIXES[first] && args.length > 1) return { mode: AI_PREFIXES[first], question: args.slice(1).join(' ') };
  const question = args.join(' ');
  return { mode: detectMode(question), question };
}

/** ".study chemistry: what is a mole" or ".study what is a mole" */
export function parseStudy(rest) {
  const m = String(rest || '').match(/^([A-Za-z ]{3,30}?)\s*[:\-]\s*([\s\S]+)$/);
  if (m) {
    const want = m[1].trim().toLowerCase();
    const hit = SUBJECTS.find((s) => s.toLowerCase() === want || s.toLowerCase().startsWith(want) || (want.length >= 4 && s.toLowerCase().includes(want)));
    if (hit) return { subject: hit, question: m[2].trim() };
  }
  return { subject: null, question: String(rest || '').trim() };
}

export class RateLimiter {
  constructor({ windowMs, max }) { this.windowMs = windowMs; this.max = max; this.hits = new Map(); }
  hit(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterMs: this.windowMs - (now - arr[0]) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 2000) this.hits.delete(this.hits.keys().next().value);
    return { ok: true, retryAfterMs: 0 };
  }
}

export class AiClient {
  constructor({ geminiKey = '', geminiModel = 'gemini-2.5-flash', fetchImpl = globalThis.fetch, timeoutMs = 25000, novadashNotes = '', now = () => Date.now() } = {}) {
    Object.assign(this, { geminiKey, geminiModel, fetchImpl, timeoutMs, novadashNotes, now });
    this.history = new Map();
  }
  get providerName() { return this.geminiKey ? 'Gemini (free key) + Pollinations fallback' : 'Pollinations (keyless fallback)'; }

  async #post(url, body, headers = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
      if (!res.ok) throw new AiError(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (e.name === 'AbortError') throw new AiError('timeout');
      throw e;
    } finally { clearTimeout(t); }
  }

  async #gemini(system, hist, question) {
    const contents = [...hist.map((h) => ({ role: h.role, parts: [{ text: h.text }] })), { role: 'user', parts: [{ text: question }] }];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.geminiModel)}:generateContent`;
    const res = await this.#post(url, { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: 1000, temperature: 0.6 } }, { 'x-goog-api-key': this.geminiKey });
    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!text) throw new AiError(data?.promptFeedback?.blockReason ? 'blocked' : 'empty');
    return text;
  }

  async #pollinations(system, hist, question) {
    const messages = [{ role: 'system', content: system }, ...hist.map((h) => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.text })), { role: 'user', content: question }];
    const res = await this.#post('https://text.pollinations.ai/', { messages, model: 'openai', private: true });
    const text = (await res.text()).trim();
    if (!text) throw new AiError('empty');
    return text;
  }

  async ask({ mode = 'general', question, chatId = 'global' }) {
    const q = String(question || '').trim().slice(0, 4000);
    if (!q) throw new AiError('empty question');
    const system = systemPrompt(mode, this.novadashNotes);
    const hkey = `${chatId}:${mode}`;
    const h = this.history.get(hkey);
    const hist = h && this.now() - h.at < 30 * 60 * 1000 ? h.items : [];
    const errors = [];
    let text = '';
    let provider = '';
    if (this.geminiKey) {
      try { text = await this.#gemini(system, hist, q); provider = 'gemini'; } catch (e) { errors.push(`gemini:${e.message}`); }
    }
    if (!text) {
      try { text = await this.#pollinations(system, hist, q); provider = 'pollinations'; } catch (e) { errors.push(`pollinations:${e.message}`); }
    }
    if (!text) throw new AiError(`AI unavailable (${errors.join('; ')})`);
    this.history.set(hkey, { at: this.now(), items: [...hist, { role: 'user', text: q }, { role: 'model', text }].slice(-6) });
    if (this.history.size > 200) this.history.delete(this.history.keys().next().value);
    return { text, provider };
  }
}

// Vercel Serverless Function: /api/chat
// The API key lives in environment variables and is never sent to the browser.

const BASE_URL = (process.env.API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, '');
const MODEL = process.env.MODEL || 'gemini-2.5-flash';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 'You are a friendly, helpful assistant. Reply in the same language the user writes in.';

const TZ = 'America/Los_Angeles';                                   // California time
const PER_IP_LIMIT = parseInt(process.env.PER_IP_LIMIT || '20', 10); // messages per IP per window
const WINDOW_MS = 60 * 60 * 1000;                                   // 1 hour
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '500', 10);  // total messages per California day
const MAX_MESSAGES = 30;
const MAX_CHARS = 8000;
const MAX_IMAGES_PER_MSG = 4;
const MAX_IMAGES_TOTAL = 8;
const MAX_IMG_CHARS = 1800000; // ~1.3 MB per image after base64
const IMG_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;

// ---- Time helpers (California time) ----
const fmtTime = d => new Date(d).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const fmtFull = d => new Date(d).toLocaleString('en-US', { timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const californiaDay = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD

// ---- Best-effort rate limiting (in-memory, resets when the serverless instance restarts) ----
const hits = new Map();
let dayKey = californiaDay(), dayCount = 0;

function checkLimits(ip) {
  const today = californiaDay();
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  if (dayCount >= DAILY_LIMIT) {
    return { ok: false, code: 'daily_limit', message: 'The bot has reached its daily message limit. It resets at midnight California time (Pacific Time). Please come back then!' };
  }
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= PER_IP_LIMIT) {
    const retryAt = recent[0] + WINDOW_MS;
    return { ok: false, code: 'ip_limit', message: `You've sent a lot of messages. Please try again after ${fmtTime(retryAt)} (California time).` };
  }
  recent.push(now);
  hits.set(ip, recent);
  dayCount++;
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < WINDOW_MS)) hits.delete(k);
  return { ok: true };
}

const fail = (res, status, code, message) => res.status(status).json({ code, error: message });

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'method', 'Method not allowed.');
  }
  if (!process.env.API_KEY) {
    return fail(res, 500, 'no_key', 'The bot is not set up yet. Please let the site owner know.');
  }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch { return fail(res, 400, 'bad_request', 'Invalid request.'); }

  const clean = m => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    if (typeof m.content === 'string') return { role: m.role, content: m.content.slice(0, MAX_CHARS) };
    if (m.role === 'user' && Array.isArray(m.content)) {
      const parts = []; let imgs = 0;
      for (const p of m.content) {
        if (p && p.type === 'text' && typeof p.text === 'string') parts.push({ type: 'text', text: p.text.slice(0, MAX_CHARS) });
        else if (p && p.type === 'image_url' && typeof p.image_url?.url === 'string') {
          const u = p.image_url.url;
          if (imgs < MAX_IMAGES_PER_MSG && u.length <= MAX_IMG_CHARS && IMG_RE.test(u)) { imgs++; parts.push({ type: 'image_url', image_url: { url: u } }); }
        }
      }
      return parts.length ? { role: m.role, content: parts } : null;
    }
    return null;
  };
  const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-MAX_MESSAGES).map(clean).filter(Boolean);
  let imgTotal = 0; // keep only the newest images
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!Array.isArray(messages[i].content)) continue;
    messages[i].content = messages[i].content.filter(p => p.type !== 'image_url' || ++imgTotal <= MAX_IMAGES_TOTAL);
    if (!messages[i].content.length) messages[i].content = '[image omitted]';
  }

  if (!messages.length) return fail(res, 400, 'empty', 'Please type a message first.');

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const limit = checkLimits(ip);
  if (!limit.ok) return fail(res, 429, limit.code, limit.message);

  const system = `${SYSTEM_PROMPT}\n\nCurrent date and time in California (Pacific Time): ${fmtFull(Date.now())}. Use California time for any time or date questions unless the user asks for another time zone.`;

  try {
    const upstream = await fetch(BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.API_KEY },
      body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'system', content: system }, ...messages] }),
    });

    if (!upstream.ok) {
      console.error('Upstream error', upstream.status, await upstream.text().catch(() => ''));
      if (upstream.status === 429) return fail(res, 429, 'busy', 'The bot is very busy right now. Please try again in a few minutes. (If this keeps happening, the free daily quota may be used up. It resets at midnight California time.)');
      if (upstream.status === 401 || upstream.status === 403) return fail(res, 502, 'auth', "The bot's API key isn't working. Please let the site owner know.");
      if (upstream.status === 400) return fail(res, 502, 'bad_input', "The AI couldn't process that message. If you attached images, try fewer or smaller ones.");
      if (upstream.status === 404) return fail(res, 502, 'model', "The AI model couldn't be found. Please let the site owner know.");
      return fail(res, 502, 'upstream', 'The AI service is having trouble right now. Please try again shortly.');
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (e) {
    console.error('Server error', e);
    if (!res.headersSent) return fail(res, 500, 'server', 'Something went wrong on the server. Please try again.');
    res.end();
  }
};

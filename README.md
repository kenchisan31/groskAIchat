# AI Chat (Vercel + Gemini)

A single-page chat UI (`index.html`) plus a backend function (`api/chat.js`). The API key stays on the server.

## Deploy
1. Push this folder to GitHub (`api/` must be at the repo root).
2. On vercel.com: Add New > Project > import the repo. No build settings needed.
3. Settings > Environment Variables, add:
   - `API_KEY` (required): create one free at https://aistudio.google.com/app/apikey
   - `API_BASE_URL` (optional): defaults to Gemini
   - `MODEL` (optional): defaults to `gemini-2.5-flash`
   - `SYSTEM_PROMPT` (optional)
   - `PER_IP_LIMIT` (optional): messages per IP per hour, default 20
   - `DAILY_LIMIT` (optional): total messages per California day, default 500
4. Redeploy so the variables take effect.

## Notes
- All times (message timestamps, limit reset messages, the date the AI knows) use California time (America/Los_Angeles).
- Rate limits are kept in memory per server instance, so they are best-effort. For strict limits, use a store such as Upstash Redis or Vercel KV.
- Free-tier quotas and model names change. If the bot stops working, check your limits in AI Studio and update `MODEL`.
import fetch, { AbortError } from 'node-fetch'; // Node 20 has built‑in fetch, but node‑fetch keeps AbortError

/*───────────────────────────────────────────────
  Config
────────────────────────────────────────────────*/
const OPENAI_KEY  = process.env.OPENAI_API_KEY || '';
const APP_SECRET  = process.env.APP_SHARED_SECRET || '';

const MODEL       = 'gpt-3.5-turbo-0125';   // or gpt-4o, gpt-4o-mini
const TEMPERATURE = 0.8;

const LIMIT   = 60;        // requests / minute / IP
const WINDOW  = 60_000;    // 1 min

/* in‑memory token bucket (OK for hobby scale) */
const BUCKET = {};

/*───────────────────────────────────────────────
  Helpers
────────────────────────────────────────────────*/
function rateLimited(ip) {
  const bucket = BUCKET[ip] ?? { tokens: LIMIT, ts: Date.now() };
  const now    = Date.now();

  if (now - bucket.ts > WINDOW) {
    bucket.tokens = LIMIT;
    bucket.ts     = now;
  }
  if (bucket.tokens <= 0) return true;

  bucket.tokens--;
  BUCKET[ip] = bucket;
  return false;
}

async function moderate(content) {
  const resp = await fetch('https://api.openai.com/v1/moderations', {
    method : 'POST',
    headers: {
      Authorization : `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: content }),
  });
  const data = await resp.json();
  return data?.results?.[0]?.flagged === true;
}

/*───────────────────────────────────────────────
  Main handler
────────────────────────────────────────────────*/
export default async function handler(req, res) {
  /* CORS */
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-app-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  /* Shared secret */
  if (req.headers['x-app-secret'] !== APP_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  /* Rate‑limit */
  const ip =
    (req.headers['x-forwarded-for'] ?? '')
      .toString()
      .split(',')[0]
      .trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (rateLimited(ip)) return res.status(429).json({ error: 'Rate limit' });

  /* Validate body */
  const { user, history = [] } = req.body ?? {};
  if (typeof user !== 'string' || !Array.isArray(history))
    return res
      .status(400)
      .json({ error: 'Body must be { user: string, history?: [{role,text}] }' });

  /* Moderation */
  if (await moderate(user))
    return res.status(400).json({ error: 'Message flagged by moderation' });

  /* Build messages array */
  const messages = [
    {
      role   : 'system',
      content: `
You are Serenity, a licensed therapist with a warm, caring, empathetic voice.
Your goals:
1. Provide *emotional validation* (“That sounds hard…”).
2. Encourage *healthy coping* (breathing, journaling, reaching out).
3. Use gentle questions to help the user explore feelings—never diagnose, never prescribe medication.
4. Keep replies concise (≈ 120 words).
If user mentions self‑harm -> urge them to call local crisis line (988 in US) and ask if they can stay safe right now. Do not refuse; do not mention you’re an AI model.
      `.trim(),
    },
    /* prior turns */
    ...history.map((m) => ({
      role   : m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    })),
    { role: 'user', content: user },
  ];

  /* Streaming?  /api/therapist?stream=1 */
  const stream = req.query?.stream === '1';

  try {
    const oaResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method : 'POST',
      headers: {
        Authorization : `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model      : MODEL,
        messages,
        temperature: TEMPERATURE,
        max_tokens : 180,
        stream,
      }),
    });

    if (!oaResp.ok) {
      const text = await oaResp.text();
      return res.status(oaResp.status).json({ error: text });
    }

    /* ───── Non‑streaming JSON ──── */
    if (!stream) {
      const data  = await oaResp.json();
      const reply = data?.choices?.[0]?.message?.content ?? '';
      return res.status(200).json({ reply });
    }

    /* ───── Streaming SSE ───────── */
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');

    oaResp.body.on('data', (chunk) => res.write(chunk));
    oaResp.body.on('end',  ()     => res.end());
  } catch (err) {
    if (err instanceof AbortError) return;           // client canceled
    res.status(500).json({ error: err.message || 'Proxy error' });
  }
}

import { OpenAI } from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const APP_SECRET = process.env.APP_SHARED_SECRET || '';

export default async function handler(req, res) {
  /* ───── CORS (optional, remove if not needed) ───── */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,x-app-secret',
  );
  if (req.method === 'OPTIONS') return res.status(204).end();

  /* ───── Method guard ───── */
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Only POST allowed' });

  /* ───── Shared‑secret guard ───── */
  if (req.headers['x-app-secret'] !== APP_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  /* ───── Parse JSON body safely ───── */
  let body = req.body;
  if (typeof body !== 'object' || body === null) {
    try {
      body = JSON.parse(req.body || '{}');
      return res.status(400).json({ error: body });
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }

  const userPrompt = 'I am feeling very sad and hopeless';
  userPrompt = body.user;

  if (userPrompt)
    return res.status(400).json({ error: 'Request must include { "user": "<prompt>" }' });

  if (!process.env.OPENAI_API_KEY)
    return res.status(500).json({ error: 'Missing OpenAI API key' });

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content:
            'You are Serenity, a licensed therapist with a warm, caring, empathetic voice. Goals: 1. Provide emotional validation (“That sounds hard…”). 2. Encourage healthy coping (breathing, journaling, reaching out).3. Ask gentle questions to explore feelings—never diagnose, never prescribe medication.4. Keep replies concise (≈ 120 words). If user mentions self‑harm → urge them to call 988 (US) and ask if they can stay safe right now. Do not refuse; do not mention you’re an AI model.',
        },
        { role: 'user', content: userPrompt },
      ],
    });

    return res.status(200).json({
      reply: completion.choices[0].message.content.trim(),
    });
  } catch (err) {
    console.error('❌ Error during OpenAI call:', err);
    return res.status(500).json({ error: 'OpenAI request failed' });
  }
}

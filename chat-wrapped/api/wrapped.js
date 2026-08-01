// Serverless proxy for the hosted version (Vercel / Netlify function style).
// Keeps the API key server-side and is where you enforce payment + rate limits.
//
// Local dev: `node server.mjs` mounts this same handler at POST /api/wrapped.

import { SYSTEM, TOOL, userPrompt, DEFAULT_MODEL } from '../ai.js';

const ALLOWED_MODELS = new Set(['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001']);
const MAX_BODY_BYTES = 300 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > MAX_BODY_BYTES) {
      res.status(413).json({ error: 'Payload too large.' });
      return;
    }
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: 'Invalid JSON body.' });
      return;
    }
  }

  const { payload, tone = 'balanced', model = DEFAULT_MODEL } = body || {};
  if (!payload || typeof payload !== 'object' || !payload.totals) {
    res.status(400).json({ error: 'Missing stats payload.' });
    return;
  }

  const chosenModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;

  // TODO before launch: verify a paid session / credit here, and rate-limit by IP.

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: chosenModel,
        max_tokens: 2000,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content: userPrompt(payload, tone) }],
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.error('Anthropic error', upstream.status, detail.slice(0, 500));
      res.status(502).json({ error: `Writer upstream failed (${upstream.status}).` });
      return;
    }

    const data = await upstream.json();
    const block = (data.content || []).find((c) => c.type === 'tool_use');
    if (!block) {
      res.status(502).json({ error: 'Writer returned no copy.' });
      return;
    }
    res.status(200).json(block.input);
  } catch (err) {
    console.error('wrapped handler failed', err);
    res.status(500).json({ error: 'Unexpected server error.' });
  }
}

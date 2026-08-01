// The writer endpoint. This is the only paid call in the app — the stats deck
// is generated client-side and stays free forever.
//
// Order matters: rate limit, then take payment, then call the model, and refund
// the credit if the model call fails.

import { SYSTEM, TOOL, userPrompt, DEFAULT_MODEL } from '../ai.js';
import { spend, refund, balance, rateLimit } from '../credits.js';
import { FREE_REPORTS } from '../pricing.js';

const ALLOWED_MODELS = new Set(['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5']);
const MAX_BODY_BYTES = 300 * 1024;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

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

  const { payload, tone = 'balanced', model = DEFAULT_MODEL, key = null } = body || {};
  if (!payload || typeof payload !== 'object' || !payload.totals) {
    res.status(400).json({ error: 'Missing stats payload.' });
    return;
  }

  const ip = clientIp(req);

  // Paid callers get a generous ceiling; it exists to bound a leaked key, not
  // to ration buyers. Anonymous callers get the free allowance and nothing more.
  const limit = key
    ? rateLimit(`paid:${ip}`, { max: 120, windowMs: 3600_000 })
    : rateLimit(`free:${ip}`, { max: FREE_REPORTS, windowMs: 24 * 3600_000 });

  if (!limit.ok) {
    if (key) {
      res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    } else {
      res.status(402).json({
        error: 'Free report used. Buy credits to generate more.',
        needsPayment: true,
      });
    }
    return;
  }

  let spentKey = null;
  if (key) {
    const remaining = await spend(key);
    if (remaining === null) {
      res.status(402).json({
        error: 'That key has no credits left.',
        needsPayment: true,
      });
      return;
    }
    spentKey = key;
  }

  const chosenModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;

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
      await refund(spentKey);
      res.status(502).json({ error: `Writer upstream failed (${upstream.status}).` });
      return;
    }

    const data = await upstream.json();
    const block = (data.content || []).find((c) => c.type === 'tool_use');
    if (!block) {
      await refund(spentKey);
      res.status(502).json({ error: 'Writer returned no copy.' });
      return;
    }

    res.status(200).json({
      ...block.input,
      credits: spentKey ? await balance(spentKey) : null,
    });
  } catch (err) {
    console.error('wrapped handler failed', err);
    await refund(spentKey);
    res.status(500).json({ error: 'Unexpected server error.' });
  }
}

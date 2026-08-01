// The writing layer. Stats are computed locally; only the aggregate payload
// (plus a small message sample) is sent for the comedy pass.

export const DEFAULT_MODEL = 'claude-sonnet-5';

const SYSTEM = `You write the copy for "Chat Wrapped" — a Spotify-Wrapped-style recap of a private group chat.

Voice: dry, observational, affectionate roast. Think a friend who has read the whole chat and is mildly concerned. Short sentences. Specific over generic. Land the joke and stop.

Hard rules:
- Punch at habits, not at people. No comments on appearance, health, relationships, money, religion, politics, or anything that reads as cruel rather than funny.
- Never invent statistics. Only use numbers present in the data given to you.
- Reference actual recurring topics and in-jokes you can see in the sample. Specificity is the entire product.
- Use first names only, exactly as they appear in the data.
- No emoji in your copy unless quoting one that is in the data.
- Every line must be under 140 characters. Most should be under 90.`;

const TOOL = {
  name: 'wrapped_copy',
  description: 'Return the finished copy for the Chat Wrapped deck.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Opening title for the deck, max 40 chars. May use a \\n line break.',
      },
      lines: {
        type: 'object',
        description:
          'Copy keyed by card id. Supply any of: intro, total, leaderboard, yapper, clock, nightowl, emoji, words, replies, comedian, planner, silence, busiest.',
        additionalProperties: { type: 'string' },
      },
      awards: {
        type: 'array',
        description: '3 to 5 bespoke awards invented from the data.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Award name, max 28 chars.' },
            person: { type: 'string', description: 'First name of the winner.' },
            stat: { type: 'string', description: 'Short supporting stat from the data.' },
            line: { type: 'string', description: 'The joke. Max 120 chars.' },
          },
          required: ['title', 'person', 'stat', 'line'],
        },
      },
      verdict: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Closing verdict headline, max 44 chars.' },
          body: { type: 'string', description: 'Two sentences max, warm landing.' },
        },
        required: ['title', 'body'],
      },
    },
    required: ['title', 'lines', 'awards', 'verdict'],
  },
};

function userPrompt(payload, tone) {
  const toneNote =
    tone === 'gentle'
      ? 'Keep it warm and fond. Tease lightly.'
      : tone === 'brutal'
        ? 'Go harder. Still never cruel, but do not soften the observations.'
        : 'Balanced: funny first, fond underneath.';

  return `${toneNote}

Here is the chat data. Aggregates are exact; the sample is a spread of real messages so you can find the running jokes.

${JSON.stringify(payload, null, 1)}

Write the deck copy. Invent 3-5 awards that only make sense for THIS group — the more specific, the better.`;
}

/** Call the hosted proxy first; fall back to a user-supplied key. */
export async function generateCopy(payload, { apiKey, tone = 'balanced', model = DEFAULT_MODEL } = {}) {
  if (!apiKey) return callProxy(payload, tone, model);
  return callAnthropic(payload, tone, model, apiKey);
}

async function callProxy(payload, tone, model) {
  const res = await fetch('/api/wrapped', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload, tone, model }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Writer service failed (${res.status}). ${detail.slice(0, 200)}`);
  }
  return res.json();
}

async function callAnthropic(payload, tone, model, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: userPrompt(payload, tone) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = `Anthropic API error ${res.status}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.error && parsed.error.message) msg += `: ${parsed.error.message}`;
    } catch {
      if (body) msg += `: ${body.slice(0, 200)}`;
    }
    throw new Error(msg);
  }

  const data = await res.json();
  const block = (data.content || []).find((c) => c.type === 'tool_use');
  if (!block) throw new Error('The writer returned no copy. Try again.');
  return block.input;
}

export { SYSTEM, TOOL, userPrompt };

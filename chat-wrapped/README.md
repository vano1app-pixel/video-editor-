# Chat Wrapped

Upload a WhatsApp export, get a Spotify-Wrapped-style recap of your group chat: leaderboard,
awards, roast, shareable cards.

The chat is parsed **in the browser**. Raw message text never gets uploaded — only aggregate
counts and a small sample go to the writer model.

## Run it

```bash
cd chat-wrapped
ANTHROPIC_API_KEY=sk-ant-... node server.mjs
# http://localhost:5173
```

No dependencies, no build step. Everything is plain ES modules.

Without a server key, paste your own key into the field on the page — it stays in `localStorage`
and goes straight to Anthropic. Without any key at all you still get the full stats deck, just
without the written jokes.

## Files

| File | What it does |
| --- | --- |
| `parser.js` | WhatsApp (iOS + Android) and Discord JSON → messages. Handles D/M vs M/D, multi-line messages, media markers, system notices. |
| `stats.js` | All the counting: leaderboard, reply times, night owls, emoji, word frequency, silences. Also builds the compact AI payload. |
| `deck.js` | Stats → ordered story cards with palettes. Works with or without AI copy. |
| `ai.js` | The writer. Forced tool-use so the copy always comes back structured. |
| `app.js` | Upload, window selection, the story player, PNG export. |
| `api/wrapped.js` | Serverless handler for the hosted version. Where payment + rate limiting go. |
| `server.mjs` | Dev server: static files + the API handler. |

## Why windows instead of "Wrapped"

Spotify Wrapped happens once a year. That's a bad business — one purchase, then eleven months of
nothing, competing with Spotify's own moment in December.

So the window is a control: **7 days / 30 days / 1 year / all time**. Same code, three products:

- **Weekly Awards** — the habit. Someone in the group posts it every Sunday.
- **Monthly Wrapped** — the recurring purchase.
- **All-Time Legends** — the big one, for anniversaries and group milestones.

It also fixes the "our chat doesn't go back far" problem: 7 days of history is enough.

## Known limits

- **Disappearing messages** wipe history for everyone. Nothing can recover that — the app detects a
  thin export and says so.
- **Cleared chats** only affect that person's export. Any other member's export still has the
  history.
- Reply-time stats need ≥5 replies from a person before that person is ranked.
- Ambiguous dates (`8/1/2026`) are resolved by checking which reading keeps the export
  chronological; locale only breaks a true tie.

## Before charging money

1. **Payment.** Add a checkout to `api/wrapped.js` — verify a paid session before calling the model.
   Free tier = stats deck, paid = awards + roast. The paywall lands right after the preview, at peak
   excitement.
2. **Rate limit** `api/wrapped.js` by IP. Right now anyone can drain your key.
3. **Privacy page.** State plainly: parsed locally, sample sent for writing, nothing stored, no
   training. Then actually do that. One Reddit comment about privacy kills this whole category.
4. **Abuse.** The system prompt already blocks cruelty, but log refusals and spot-check output.

## Cost per report

One report ≈ 8k input + 1.5k output tokens on Sonnet. At consumer prices that's fractions of a cent
— the economics work at €5, and they work at €1.

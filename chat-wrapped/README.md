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

To exercise the paywall too:

```bash
ANTHROPIC_API_KEY=sk-ant-... \
STRIPE_SECRET_KEY=sk_test_... \
STRIPE_WEBHOOK_SECRET=whsec_... \
PUBLIC_ORIGIN=http://localhost:5173 \
node server.mjs

# in another shell, so Stripe can reach the webhook:
stripe listen --forward-to localhost:5173/api/stripe-webhook
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
| `pricing.js` | Cost model and bundle prices, with the margin maths. `node pricing.js` prints the table. |
| `credits.js` | Credit ledger + IP rate limiter. Keys are stored hashed. |
| `api/wrapped.js` | The paid writer call: rate limit → spend a credit → call the model → refund on failure. |
| `api/checkout.js` | Creates a Stripe Checkout session. |
| `api/stripe-webhook.js` | Verifies the signature and grants credits. The only place credits are minted. |
| `api/claim.js` | Hands the minted key to the buyer after redirect; also reports a balance. |
| `server.mjs` | Dev server: static files + all four API handlers. |

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

## Why it costs what it costs

Measured on a real 2,400-message export: **~3,200 input + ~1,000 output tokens** per report. On
Claude Sonnet 5 at list price ($3 / $15 per million) that is **€0.025** of model cost. On Haiku 4.5
it is €0.008.

So the model is not what sets the price — **Stripe's fixed 25c fee is**. A 12c charge loses money
before the model is even called. That one constraint produces the bundles:

| Pack | Price | Per report | Stripe takes | Model cost | **Margin per report** |
| --- | --- | --- | --- | --- | --- |
| 1 report | €0.50 | €0.50 | €0.26 | €0.025 | €0.218 |
| **10 reports** | **€1.50** | **€0.15** | €0.27 | €0.246 | **€0.098** |
| 50 reports | €5.00 | €0.10 | €0.33 | €1.230 | €0.069 |

The 10-pack is the answer to "as cheap as possible, cost plus 10c": €1.50 nets **9.8c per report**
after both the model and the payment processor. The single is priced high on purpose — the fixed fee
makes cheap one-offs impossible, and it subsidises the pack.

`node pricing.js` re-prints this table after any change to `pricing.js`.

## How the paywall works

- **Free:** the full stats deck, generated in the browser, always. Plus one AI-written report per IP
  per day.
- **Paid:** credits buy the written awards and the roast.
- **No accounts.** A purchase mints an opaque `cw_…` key that lives in the buyer's browser. Keys are
  stored hashed, so a leaked store file hands out nothing usable.
- The paywall opens **after** the deck is on screen — the preview is the pitch.
- Credits are spent before the model call and **refunded** if it fails.

## The credit store

`credits.js` picks its backend from the environment:

| Backend | When | Use for |
| --- | --- | --- |
| **supabase** | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set | Anything that takes real money |
| **file** | neither is set | Local development on one machine |

**Serverless deployments must use Supabase.** Vercel and Netlify functions get a fresh, empty disk
per invocation, so a file-backed ledger loses every purchase the moment the function that wrote it
shuts down — the customer pays, the webhook writes credits, and the next request sees an empty
store.

### Setting it up

```bash
# 1. Apply the migration (once)
#    Supabase dashboard → SQL Editor → paste supabase/001_credits.sql → Run
#    or: supabase db execute --file supabase/001_credits.sql

# 2. Grab the service role key
#    Dashboard → Project Settings → API → service_role  (secret — server only)

# 3. Point the app at it
export SUPABASE_URL=https://<project-ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service role key>

# 4. Prove it works before trusting it with money
node supabase/verify.mjs
```

`verify.mjs` checks the things that actually cost money if they're wrong: that 20 concurrent spends
against 10 credits yield exactly 10 successes, that a retried Stripe webhook can't grant twice, that
an over-spend returns null instead of going negative, and that a refund returns exactly one credit.

### Why it's built this way

- **Spending is a single atomic `UPDATE … WHERE credits > 0`** inside `cw_spend_credit`, so two
  concurrent requests can never both take the last credit. This is the specific race the JSON file
  store loses.
- **Granting is idempotent per checkout.** Stripe retries webhooks on any non-2xx; without the
  `cw_checkouts` guard a retry would grant a second time.
- **RLS is enabled with no policies**, so the anon and publishable keys can read nothing. Only the
  service role key works, and it must never reach the browser.
- Keys are stored **hashed**; the plaintext key exists only in the buyer's browser.

## Still to do before you take real money

1. **Stripe account** — business details and bank account, then real `STRIPE_SECRET_KEY` and
   `STRIPE_WEBHOOK_SECRET`. This is the long pole; verification is not instant.
2. **Privacy policy and terms pages.** Stripe requires them, and the privacy page is also your
   defence on Reddit. State plainly: parsed locally, sample sent for writing, nothing stored, no
   training. Then actually do that.
3. **A stated refund policy.**
4. **Error alerting.** Failures currently go to `console.error` and nobody reads it.
5. **Abuse.** The system prompt blocks cruelty, but log refusals and spot-check output.

The Telegram bot's message store is deliberately **not** migrated — the bot runs as one long-lived
process with a real disk, so JSONL is the right shape there. The serverless problem is specific to
the web API.

## Telegram bot

```bash
TELEGRAM_BOT_TOKEN=... ANTHROPIC_API_KEY=sk-ant-... node bot/bot.js
```

**Setup in @BotFather, once:** `/newbot` to get a token, then
**`/setprivacy` → Disable**. This is not optional — with privacy mode on (the default) a bot only
receives messages that start with a command, so there is nothing to recap. Then add the bot to a
group.

Commands: `/wrapped [month|year|all]`, `/stats`, `/weekly on|off`, `/privacy`, `/forgetme`,
`/stopdata`.

| File | What it does |
| --- | --- |
| `bot/bot.js` | Long-poll loop, commands, weekly schedule, pruning |
| `bot/telegram.js` | Bot API client + 4096-char message splitting |
| `bot/store.js` | Per-chat JSONL store, retention, per-user deletion |
| `bot/render.js` | Deck → Telegram HTML |

The bot normalises Telegram messages into the same shape `parser.js` produces, so `stats.js` and
`deck.js` are shared with the web app unchanged — a new award appears in both at once.

**Telegram gives bots no access to history from before they joined.** The bot records forward from
the moment it's added, which is why `/weekly` matters more here than `/wrapped all`: it turns the
recap into a habit rather than a one-off.

**Privacy is load-bearing here**, because unlike the web app this stores other people's messages
server-side. What's implemented: it announces itself on join, stores only timestamp + display name +
text + a media flag (no user IDs, usernames, or reply chains), keeps first-name-plus-initial rather
than full names, deletes after `TELEGRAM_RETENTION_DAYS` (default 400), and honours `/forgetme` per
person and `/stopdata` per group. Don't weaken any of that — it's the difference between a bot
people add and a bot people report.

| Env var | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | Required |
| `ANTHROPIC_API_KEY` | — | Omit for stats-only reports |
| `TELEGRAM_STORE` | `./.data/telegram` | Message store |
| `TELEGRAM_RETENTION_DAYS` | `400` | Auto-delete window |
| `TELEGRAM_DAILY_AI_LIMIT` | `5` | AI reports per group per day |
| `TELEGRAM_WEEKLY_DAY` / `_HOUR` | `0` / `18` | When weekly posts fire (server local time) |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Override for tests or a self-hosted Bot API |

## On getting chats in more easily

There is no easier WhatsApp path than the 4-tap export, and the "connect your number" ideas are
worse than they sound:

- **WhatsApp Cloud API** only sees messages sent to *your* business number after you connect it. No
  history, no group reading. Wrong tool.
- **Unofficial libraries** (whatsapp-web.js, Baileys) link as a companion device and *can* read group
  history — but they violate WhatsApp's terms, get numbers banned, and would put other people's
  messages on your server, which destroys the privacy story this product is built on.
- **Snapchat** has no API for reading chats, and its messages delete by design. Dead end.

The genuinely easier route is a different platform: **Discord and Telegram have real, legal bot
APIs**. A Discord bot can backfill full channel history; a Telegram bot sees everything from when it
joins. That turns the upload into an install and makes weekly recaps automatic — the parser already
accepts Discord JSON exports (`parseDiscordJson`), so the stats layer needs no changes.

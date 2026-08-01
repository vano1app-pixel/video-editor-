# EditAi — Setup

Getting from a fresh clone to editing your first video. Budget about 10 minutes.

---

## Step 1 — Get your Anthropic key (required)

This is EditAi's brain. It reads your video's transcript, asks you questions, and
decides where the cuts go. **Without this key the app runs but can't plan edits.**

1. Go to **https://console.anthropic.com**
2. Sign up or log in.
3. Click **Billing** in the left sidebar → **Add payment method**, then buy credits.
   The minimum is **$5**, and that goes a long way — see the cost table below.
   *You must have credits. A brand-new account with no credits returns errors.*
4. Click **API Keys** in the left sidebar → **Create Key**.
5. Name it something like `editai`, then copy the key. It starts with `sk-ant-`.
   **Copy it now — the console shows it exactly once and never again.**
6. Paste it into your `.env` file as `ANTHROPIC_API_KEY=sk-ant-...`

---

## Step 2 — Get your OpenAI key (optional, but you want it)

This is EditAi's ears. It transcribes your video so the AI knows what was *said*,
which is what makes "cut the best moments" and burned-in captions work.

**Without it EditAi still works**, but it can only cut on scene changes and
silence — no captions, and much dumber choices about what's interesting.

1. Go to **https://platform.openai.com**
2. Sign up or log in.
3. Click your profile (top right) → **Billing** → add a payment method and buy
   credits. **$5** minimum here too.
4. Go to **API keys** (left sidebar, or https://platform.openai.com/api-keys) →
   **Create new secret key**.
5. Copy the key. It starts with `sk-`. **Again — shown once only.**
6. Paste it into `.env` as `OPENAI_API_KEY=sk-...`

> **Alternative — free, no OpenAI account:** you can self-host transcription with
> whisper.cpp instead. It's slower on CPU and needs a one-time model download,
> but it costs nothing and your audio never leaves your machine. Set
> `LOCAL_WHISPER_BIN` and `LOCAL_WHISPER_MODEL` in `.env` instead of the OpenAI
> key. See https://github.com/ggml-org/whisper.cpp

---

## Step 3 — Google Drive (optional)

Only needed if you want EditAi to scan videos straight out of your Drive instead
of dragging files in. Drag-and-drop works without any of this.

This one isn't a "buy credits and copy a key" flow — Google makes you create an
app. It's free, and takes about 5 minutes.

1. Go to **https://console.cloud.google.com**
2. Top bar → project dropdown → **New Project**. Name it `EditAi`. Create, then
   make sure it's the selected project.
3. **APIs & Services** → **Library** → search **Google Drive API** → **Enable**.
4. **APIs & Services** → **OAuth consent screen**:
   - User type **External** → Create
   - App name `EditAi`, your email for both support and developer contact → Save
   - **Scopes** → Add or remove scopes → search `drive.readonly` → tick
     `.../auth/drive.readonly` → Update → Save
   - **Test users** → Add users → **add your own Google address**. While the app
     is unpublished only test users can sign in — if you skip this, your own
     login gets rejected.
5. **APIs & Services** → **Credentials** → **Create Credentials** →
   **OAuth client ID**:
   - Application type: **Web application**
   - Name: `EditAi local`
   - **Authorized redirect URIs** → Add URI →
     `http://localhost:3000/api/drive/callback`
     *(this must match exactly — a trailing slash breaks it)*
   - Create
6. Copy the **Client ID** and **Client secret** into `.env`:
   ```
   GOOGLE_CLIENT_ID=....apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```

Restart the dev server and the "Connect Google Drive" button goes live. EditAi
requests **read-only** access and never writes to your Drive.

> Deploying somewhere other than localhost? Add that origin's callback URL to
> the same Authorized redirect URIs list and set `PUBLIC_BASE_URL` in `.env`, or
> set `GOOGLE_REDIRECT_URI` explicitly.

---

## Step 4 — Configure and run

```bash
cp .env.example .env
# open .env and paste your two keys in

npm install
npm run dev
```

Open **http://localhost:3000**, drop in a video, and tell EditAi what you want.

---

## What it costs to run

Rough real-world numbers for a **10-minute source video**:

| What | Cost |
|---|---|
| Transcription (OpenAI Whisper, $0.006/min) | ~$0.06 |
| Planning the edit (Claude Opus 5) | ~$0.05–0.10 per planning turn |
| Rendering (ffmpeg, your own CPU) | $0.00 |
| **Total per video** | **roughly 10–20¢** |

So $5 of credit on each service is somewhere around 30–50 videos. Two things
that move the number: longer videos cost proportionally more to transcribe, and
each round of clarifying questions is another planning turn. Follow-up turns in
the same conversation are cheaper than the first because the transcript is
cached.

If you want to cut the planning cost, set `PLANNER_EFFORT=medium` (or `low`) in
`.env`. It thinks less before answering — cheaper and faster, slightly less
careful about which moments to keep.

---

## Keeping the keys safe

- `.env` is already in `.gitignore` — your keys will not get committed.
- Never paste a key into a chat, an issue, or a screenshot.
- If you think a key leaked, delete it in the console and make a new one. Both
  consoles let you revoke a single key without touching the rest.
- Set a **monthly spend limit** in both consoles while you're experimenting.
  Anthropic: Billing → Limits. OpenAI: Billing → Usage limits. This is the
  single best protection against a runaway loop costing you real money.

---

## Troubleshooting

**"EditAi isn't configured with an AI key yet"**
`ANTHROPIC_API_KEY` is missing or empty in `.env`. Restart `npm run dev` after
editing `.env` — the server reads it once at boot.

**"EditAi's AI key is missing or invalid"**
The key is present but rejected. Usual causes: you copied it with a trailing
space, the key was revoked, or the account has no credits.

**Captions are off and the cuts seem random**
No transcription provider configured. The prep step will say
*"No transcription provider configured — planning from scenes only."* Add
`OPENAI_API_KEY` or set up local whisper.

**"EditAi is busy right now — try again in a moment"**
Rate limited by the API. Wait a few seconds and resend. New accounts have low
rate limits that rise automatically as you use the service.

**ffmpeg errors on render**
The app ships static ffmpeg binaries via npm, so this usually means the
postinstall didn't run. Try `npm rebuild ffmpeg-static ffprobe-static`, or
install ffmpeg system-wide and point `FFMPEG_PATH` / `FFPROBE_PATH` at it.

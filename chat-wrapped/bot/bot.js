// Chat Wrapped for Telegram.
//
//   TELEGRAM_BOT_TOKEN=... ANTHROPIC_API_KEY=sk-ant-... node bot/bot.js
//
// Setup, once, in @BotFather:
//   /newbot                     — create the bot, copy the token
//   /setprivacy → Disable       — REQUIRED. With privacy mode on (the default)
//                                 the bot only sees messages that start with a
//                                 command, so there is nothing to recap.
// Then add the bot to a group. It sees messages from that moment on; Telegram
// gives bots no access to history from before they joined.

import { Telegram, esc } from './telegram.js';
import * as store from './store.js';
import { renderDeck } from './render.js';
import { computeStats, buildAiPayload } from '../stats.js';
import { buildDeck } from '../deck.js';
import { generateCopy } from '../ai.js';
import { findMoments, assignTags } from '../moments.js';
import { windowMessages } from '../parser.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

/** AI-written reports per chat per day. Stats-only reports are unlimited. */
const DAILY_AI_LIMIT = Number(process.env.TELEGRAM_DAILY_AI_LIMIT || 5);

/** Weekly auto-post, in the server's local time. 0 = Sunday. */
const WEEKLY_DAY = Number(process.env.TELEGRAM_WEEKLY_DAY ?? 0);
const WEEKLY_HOUR = Number(process.env.TELEGRAM_WEEKLY_HOUR ?? 18);

const MIN_MESSAGES = 25;
const SCHEDULE_TICK_MS = 15 * 60 * 1000;

const WINDOWS = {
  week: { days: 7, label: 'Last 7 days' },
  month: { days: 30, label: 'Last 30 days' },
  year: { days: 365, label: 'Last year' },
  all: { days: 0, label: 'All time' },
};

const MEDIA_KEYS = [
  'photo',
  'video',
  'sticker',
  'animation',
  'voice',
  'video_note',
  'audio',
  'document',
];

const PRIVACY = `<b>What this bot stores</b>

To build a recap it keeps, for this group only:
• when a message was sent
• the sender's display name
• the message text
• whether it was a photo/sticker/voice note

It does <b>not</b> store user IDs, usernames, phone numbers, reply chains, or forwarding info, and it never reads other chats.

Data is kept for ${store.RETENTION_DAYS} days, then deleted automatically.

When you run /wrapped, aggregate counts plus a small sample of messages are sent to Anthropic to write the jokes. Nothing is used for training.

/forgetme — delete your own messages
/stopdata — delete everything for this group and stop recording`;

const HELP = `<b>Chat Wrapped</b> — awards for this group chat.

/wrapped — recap the last 7 days
/wrapped month — last 30 days
/wrapped all — everything I've seen
/stats — how much I've recorded so far
/weekly on|off — auto-post every week
/privacy — exactly what I store
/forgetme — delete your own messages
/stopdata — delete everything and stop

I can only see messages sent after I joined — Telegram gives bots no access to older history.`;

const tg = new Telegram(TOKEN);
let me = null;

/* ---------------- ingest ---------------- */

function displayName(from) {
  if (!from) return 'Someone';
  const first = (from.first_name || '').trim();
  const last = (from.last_name || '').trim();
  // First name plus a last initial — enough to tell two Seans apart, not a handle.
  if (first && last) return `${first} ${last[0]}.`;
  return first || from.username || 'Someone';
}

function isMedia(msg) {
  return MEDIA_KEYS.some((k) => msg[k] !== undefined);
}

function textOf(msg) {
  return msg.text || msg.caption || '';
}

async function ingest(msg) {
  await store.append(msg.chat.id, {
    ts: new Date(msg.date * 1000),
    author: displayName(msg.from),
    text: textOf(msg),
    isMedia: isMedia(msg),
  });
}

/* ---------------- reports ---------------- */

function parseWindow(arg = '') {
  const a = arg.trim().toLowerCase();
  if (['month', '30', 'monthly'].includes(a)) return WINDOWS.month;
  if (['year', '365', 'yearly'].includes(a)) return WINDOWS.year;
  if (['all', 'ever', 'alltime', 'all-time'].includes(a)) return WINDOWS.all;
  return WINDOWS.week;
}

/** True if this chat still has AI headroom today. Records the use if so. */
async function takeAiSlot(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  const meta = await store.getMeta(chatId);
  const used = meta.aiDate === today ? meta.aiCount || 0 : 0;
  if (used >= DAILY_AI_LIMIT) return false;
  await store.setMeta(chatId, { aiDate: today, aiCount: used + 1 });
  return true;
}

async function buildReport(chatId, windowSpec) {
  const all = await store.read(chatId);
  const slice = windowMessages(all, windowSpec.days);

  if (slice.length < MIN_MESSAGES) {
    return {
      text:
        `I've only recorded <b>${slice.length}</b> message${slice.length === 1 ? '' : 's'} for ` +
        `${esc(windowSpec.label.toLowerCase())}. Give me at least ${MIN_MESSAGES} — or try ` +
        `/wrapped all.`,
    };
  }

  const stats = computeStats(slice);
  if (!stats) return { text: 'Not enough to work with yet.' };

  const moments = findMoments(slice);
  moments.tags = assignTags(stats);

  let ai = null;
  let note = '';
  if (ANTHROPIC_KEY && (await takeAiSlot(chatId))) {
    try {
      ai = await generateCopy(buildAiPayload(stats, slice, moments), {
        apiKey: ANTHROPIC_KEY,
        tone: 'balanced',
      });
    } catch (err) {
      console.error('writer failed', err.message);
      note = '\n\n<i>(The writer was unavailable, so this one is stats only.)</i>';
    }
  } else if (ANTHROPIC_KEY) {
    note = `\n\n<i>(Daily award limit reached — stats only. Resets at midnight.)</i>`;
  }

  return { text: renderDeck(buildDeck(stats, ai, windowSpec.label, moments)) + note };
}

/* ---------------- commands ---------------- */

async function handleCommand(msg, name, arg) {
  const chatId = msg.chat.id;

  switch (name) {
    case 'start':
    case 'help':
      await tg.sendMessage(chatId, HELP);
      return;

    case 'privacy':
      await tg.sendMessage(chatId, PRIVACY);
      return;

    case 'wrapped': {
      const spec = parseWindow(arg);
      await tg.sendMessage(chatId, `Counting up ${esc(spec.label.toLowerCase())}…`);
      const report = await buildReport(chatId, spec);
      await tg.sendLong(chatId, report.text);
      return;
    }

    case 'stats': {
      const all = await store.read(chatId);
      if (!all.length) {
        await tg.sendMessage(chatId, "I haven't recorded anything here yet.");
        return;
      }
      const people = new Set(all.map((m) => m.author)).size;
      const since = all[0].ts.toLocaleDateString();
      await tg.sendMessage(
        chatId,
        `<b>${all.length.toLocaleString()}</b> messages from <b>${people}</b> people, since ${esc(
          since
        )}.\n\nRun /wrapped when you're ready.`
      );
      return;
    }

    case 'weekly': {
      const on = /^(on|yes|enable)$/i.test(arg.trim());
      const off = /^(off|no|disable|stop)$/i.test(arg.trim());
      if (!on && !off) {
        const meta = await store.getMeta(chatId);
        await tg.sendMessage(
          chatId,
          `Weekly awards are <b>${meta.weekly ? 'on' : 'off'}</b>. Use /weekly on or /weekly off.`
        );
        return;
      }
      await store.setMeta(chatId, { weekly: on });
      await tg.sendMessage(
        chatId,
        on
          ? `Weekly awards are on. I'll post every week and you can turn it off with /weekly off.`
          : `Weekly awards are off. /wrapped still works any time.`
      );
      return;
    }

    case 'forgetme': {
      const who = displayName(msg.from);
      const removed = await store.forgetAuthor(chatId, who);
      await tg.sendMessage(
        chatId,
        removed
          ? `Deleted ${removed} message${removed === 1 ? '' : 's'} from <b>${esc(who)}</b>.`
          : `I had nothing recorded for <b>${esc(who)}</b>.`
      );
      return;
    }

    case 'stopdata': {
      await store.forget(chatId);
      await tg.sendMessage(
        chatId,
        `Deleted everything I had for this group and stopped recording.\n\n` +
          `Remove me from the group to be certain, or just leave me here — I'll start fresh if you run /wrapped again.`
      );
      return;
    }

    default:
      return;
  }
}

/* ---------------- update loop ---------------- */

async function handleUpdate(update) {
  // Announce on join so nobody is recorded without being told.
  if (update.my_chat_member) {
    const status = update.my_chat_member.new_chat_member?.status;
    if (status === 'member' || status === 'administrator') {
      await tg
        .sendMessage(
          update.my_chat_member.chat.id,
          `👋 <b>Chat Wrapped</b> is now recording this group so it can build awards.\n\n` +
            `I only see messages from now on. Run /privacy to see exactly what I keep, or ` +
            `/stopdata to delete it all.\n\nTry /wrapped in a few days.`
        )
        .catch(() => {});
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.chat) return;
  if (msg.from?.is_bot) return;

  const text = textOf(msg);
  const entity = msg.entities?.[0];
  const isCommand = entity?.type === 'bot_command' && entity.offset === 0;

  if (isCommand) {
    const raw = text.slice(0, entity.length);
    const [name, at] = raw.slice(1).split('@');
    // In a group, /wrapped@OtherBot is not ours to answer.
    if (at && me?.username && at.toLowerCase() !== me.username.toLowerCase()) return;
    await handleCommand(msg, name.toLowerCase(), text.slice(entity.length).trim());
    return;
  }

  if (!text && !isMedia(msg)) return;
  await ingest(msg);
}

/* ---------------- weekly schedule ---------------- */

async function runSchedule() {
  const now = new Date();
  if (now.getDay() !== WEEKLY_DAY || now.getHours() < WEEKLY_HOUR) return;

  for (const chatId of await store.listChats()) {
    try {
      const meta = await store.getMeta(chatId);
      if (!meta.weekly) continue;
      // Six days of spacing absorbs restarts without double-posting.
      if (meta.lastWeeklyAt && Date.now() - meta.lastWeeklyAt < 6 * 86400_000) continue;

      const report = await buildReport(chatId, WINDOWS.week);
      await store.setMeta(chatId, { lastWeeklyAt: Date.now() });
      await tg.sendLong(chatId, `📅 <b>This week in here</b>\n\n${report.text}`);
    } catch (err) {
      console.error(`weekly post failed for ${chatId}:`, err.message);
    }
  }
}

async function runPrune() {
  for (const chatId of await store.listChats()) {
    const dropped = await store.prune(chatId).catch(() => 0);
    if (dropped) console.log(`pruned ${dropped} expired messages from ${chatId}`);
  }
}

/* ---------------- main ---------------- */

async function main() {
  me = await tg.getMe();
  console.log(`Chat Wrapped bot running as @${me.username}`);
  if (!ANTHROPIC_KEY) {
    console.log('No ANTHROPIC_API_KEY — reports will be stats-only.');
  }

  await tg
    .setMyCommands([
      { command: 'wrapped', description: 'Recap this group (add: month / year / all)' },
      { command: 'stats', description: "How much I've recorded" },
      { command: 'weekly', description: 'Turn weekly awards on or off' },
      { command: 'privacy', description: 'What I store' },
      { command: 'forgetme', description: 'Delete your own messages' },
      { command: 'stopdata', description: 'Delete everything for this group' },
    ])
    .catch((err) => console.error('setMyCommands failed:', err.message));

  await runPrune();
  setInterval(() => runSchedule().catch((e) => console.error(e)), SCHEDULE_TICK_MS);
  setInterval(() => runPrune().catch((e) => console.error(e)), 24 * 3600_000);

  let offset = await store.getOffset();
  let backoff = 1000;

  for (;;) {
    try {
      const updates = await tg.getUpdates(offset);
      backoff = 1000;
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (err) {
          // One bad update must never stall the queue.
          console.error('update failed:', err.message);
        }
      }
      if (updates.length) await store.setOffset(offset);
    } catch (err) {
      console.error('poll failed:', err.message);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required. Create a bot with @BotFather.');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

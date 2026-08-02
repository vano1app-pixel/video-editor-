// Per-chat message store. One JSONL file per group, append-only, pruned by age.
//
// We keep the bare minimum needed to compute stats: timestamp, display name,
// text, and whether it was media. No user IDs, no usernames, no forwarding
// metadata, no reply chains — nothing that identifies someone off-platform.
//
// Same caveat as credits.js: this is a file-backed store meant for one box.
// Move it to a database before running this at scale.

import { appendFile, readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.env.TELEGRAM_STORE || './.data/telegram';

/** Messages older than this are dropped on the next prune. */
export const RETENTION_DAYS = Number(process.env.TELEGRAM_RETENTION_DAYS || 400);

/** Hard cap per chat, so one very busy group can't fill the disk. */
const MAX_MESSAGES = 60_000;

function chatFile(chatId) {
  // chatId is a Telegram-issued integer (negative for groups) — coerce and
  // strip anything else so it can never escape the directory.
  const safe = String(chatId).replace(/[^0-9-]/g, '');
  if (!safe) throw new Error('Invalid chat id.');
  return join(ROOT, `${safe}.jsonl`);
}

function metaFile(chatId) {
  return chatFile(chatId).replace(/\.jsonl$/, '.meta.json');
}

export async function append(chatId, message) {
  await mkdir(ROOT, { recursive: true });
  const row = {
    t: message.ts instanceof Date ? message.ts.getTime() : message.ts,
    a: message.author,
    x: message.text || '',
    m: message.isMedia ? 1 : 0,
  };
  await appendFile(chatFile(chatId), JSON.stringify(row) + '\n');
}

/** Read a chat's messages back in the shape stats.js expects. */
export async function read(chatId) {
  let raw;
  try {
    raw = await readFile(chatFile(chatId), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      out.push({
        ts: new Date(r.t),
        author: r.a,
        text: r.x,
        isMedia: Boolean(r.m),
        isDeleted: false,
      });
    } catch {
      // A torn final line from an interrupted append — skip it, keep the rest.
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** Drop anything past the retention window or over the size cap. */
export async function prune(chatId) {
  const messages = await read(chatId);
  if (!messages.length) return 0;

  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  let kept = messages.filter((m) => m.ts.getTime() >= cutoff);
  if (kept.length > MAX_MESSAGES) kept = kept.slice(-MAX_MESSAGES);

  const dropped = messages.length - kept.length;
  if (!dropped) return 0;

  const body = kept
    .map((m) =>
      JSON.stringify({ t: m.ts.getTime(), a: m.author, x: m.text, m: m.isMedia ? 1 : 0 })
    )
    .join('\n');
  await writeFile(chatFile(chatId), body ? body + '\n' : '');
  return dropped;
}

/** Delete everything for a chat. Backs /forgetme and /stop. */
export async function forget(chatId) {
  for (const f of [chatFile(chatId), metaFile(chatId)]) {
    await unlink(f).catch(() => {});
  }
}

/** Remove one person's messages without touching anyone else's. */
export async function forgetAuthor(chatId, author) {
  const messages = await read(chatId);
  const kept = messages.filter((m) => m.author !== author);
  const removed = messages.length - kept.length;
  if (!removed) return 0;
  const body = kept
    .map((m) =>
      JSON.stringify({ t: m.ts.getTime(), a: m.author, x: m.text, m: m.isMedia ? 1 : 0 })
    )
    .join('\n');
  await writeFile(chatFile(chatId), body ? body + '\n' : '');
  return removed;
}

export async function getMeta(chatId) {
  try {
    return JSON.parse(await readFile(metaFile(chatId), 'utf8'));
  } catch {
    return {};
  }
}

export async function setMeta(chatId, patch) {
  await mkdir(ROOT, { recursive: true });
  const next = { ...(await getMeta(chatId)), ...patch };
  await writeFile(metaFile(chatId), JSON.stringify(next, null, 2));
  return next;
}

/** Every chat the bot currently holds data for. Drives the weekly schedule. */
export async function listChats() {
  try {
    const files = await readdir(ROOT);
    return files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => Number(f.replace(/\.jsonl$/, '')))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

/** Long-poll cursor, so a restart doesn't replay or skip updates. */
const OFFSET_FILE = () => join(ROOT, 'offset.json');

export async function getOffset() {
  try {
    return JSON.parse(await readFile(OFFSET_FILE(), 'utf8')).offset || 0;
  } catch {
    return 0;
  }
}

export async function setOffset(offset) {
  await mkdir(ROOT, { recursive: true });
  await writeFile(OFFSET_FILE(), JSON.stringify({ offset }));
}

// Credit ledger. No accounts, no passwords — a purchase mints an opaque key
// that the buyer's browser keeps. Losing the key loses the credits, which is
// the correct trade at these prices.
//
// File-backed so the dev server works with zero setup. Swap `load`/`save` for
// a real store before this sees traffic: concurrent writes to one JSON file
// will drop credits under load, and serverless functions don't share a disk.

import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const STORE = process.env.CREDIT_STORE || './.data/credits.json';

let cache = null;
let writing = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(STORE, 'utf8'));
  } catch {
    cache = { keys: {}, checkouts: {} };
  }
  return cache;
}

// Serialise writes so two concurrent spends can't clobber each other's file.
function save() {
  writing = writing.then(async () => {
    await mkdir(dirname(STORE), { recursive: true });
    await writeFile(STORE, JSON.stringify(cache, null, 2));
  });
  return writing;
}

/** Keys are stored hashed — a leaked store file shouldn't hand out working keys. */
function hash(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function mintKey() {
  return `cw_${randomBytes(18).toString('base64url')}`;
}

/** Create (or top up) a key with `reports` credits. Returns the plaintext key. */
export async function grant(reports, { checkoutId = null, key = null } = {}) {
  const db = await load();
  const plain = key || mintKey();
  const h = hash(plain);
  const row = db.keys[h] || { credits: 0, createdAt: new Date().toISOString() };
  row.credits += reports;
  row.updatedAt = new Date().toISOString();
  db.keys[h] = row;
  if (checkoutId) db.checkouts[checkoutId] = plain;
  await save();
  return plain;
}

export async function balance(key) {
  if (!key) return 0;
  const db = await load();
  return db.keys[hash(key)]?.credits || 0;
}

/**
 * Spend one credit. Returns the remaining balance, or null if the key is
 * unknown or empty — callers must treat null as "do not call the model".
 */
export async function spend(key) {
  if (!key) return null;
  const db = await load();
  const row = db.keys[hash(key)];
  if (!row || row.credits <= 0) return null;
  row.credits -= 1;
  row.updatedAt = new Date().toISOString();
  await save();
  return row.credits;
}

/** Give a credit back when the model call fails — the buyer got nothing. */
export async function refund(key) {
  if (!key) return;
  const db = await load();
  const row = db.keys[hash(key)];
  if (!row) return;
  row.credits += 1;
  await save();
}

/** Look up the key minted for a completed Stripe Checkout session. */
export async function keyForCheckout(checkoutId) {
  const db = await load();
  return db.checkouts[checkoutId] || null;
}

/** Crude fixed-window IP limiter. Process-local — fine for one box, not a fleet. */
const hits = new Map();

export function rateLimit(ip, { max = 30, windowMs = 3600_000 } = {}) {
  const now = Date.now();
  const row = hits.get(ip);
  if (!row || now > row.reset) {
    hits.set(ip, { count: 1, reset: now + windowMs });
    return { ok: true, remaining: max - 1 };
  }
  row.count++;
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  }
  return { ok: row.count <= max, remaining: Math.max(0, max - row.count) };
}

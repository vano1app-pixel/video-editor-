// Credit ledger. No accounts, no passwords — a purchase mints an opaque key
// that the buyer's browser keeps. Losing the key loses the credits, which is
// the correct trade at these prices.
//
// Two backends behind one interface:
//   supabase — used when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.
//              Required for any serverless deployment: functions get a fresh,
//              empty disk per invocation, so a file-backed ledger loses every
//              purchase the moment the function that wrote it shuts down.
//   file     — zero-setup fallback for local development and single-box hosts.
//
// Keys are stored hashed in both, so a leaked store hands out nothing usable.

import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const BACKEND = SUPABASE_URL && SUPABASE_KEY ? 'supabase' : 'file';

function hash(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function mintKey() {
  return `cw_${randomBytes(18).toString('base64url')}`;
}

/* ---------------- Supabase (PostgREST) ---------------- */

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase ${fn} failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return res.json();
}

async function select(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase select failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return res.json();
}

const sb = {
  async grant(reports, { checkoutId = null, key = null } = {}) {
    const plain = key || mintKey();
    await rpc('cw_grant_credits', {
      p_key_hash: hash(plain),
      p_reports: reports,
      p_key: plain,
      p_checkout_id: checkoutId,
    });
    return plain;
  },

  async balance(key) {
    if (!key) return 0;
    const rows = await select('cw_credits', `key_hash=eq.${hash(key)}&select=credits`);
    return rows[0]?.credits ?? 0;
  },

  async spend(key) {
    if (!key) return null;
    const remaining = await rpc('cw_spend_credit', { p_key_hash: hash(key) });
    // The function returns NULL for an unknown key or an empty balance.
    return remaining === null ? null : remaining;
  },

  async refund(key) {
    if (!key) return;
    await rpc('cw_refund_credit', { p_key_hash: hash(key) });
  },

  async keyForCheckout(checkoutId) {
    const rows = await select(
      'cw_checkouts',
      `checkout_id=eq.${encodeURIComponent(checkoutId)}&select=key`
    );
    return rows[0]?.key || null;
  },

  async rateLimit(bucket, { max = 30, windowMs = 3600_000 } = {}) {
    const count = await rpc('cw_rate_limit', {
      p_bucket: bucket,
      p_window_seconds: Math.round(windowMs / 1000),
    });
    return { ok: count <= max, remaining: Math.max(0, max - count) };
  },
};

/* ---------------- File (local dev / single box) ---------------- */

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

function save() {
  writing = writing.then(async () => {
    await mkdir(dirname(STORE), { recursive: true });
    await writeFile(STORE, JSON.stringify(cache, null, 2));
  });
  return writing;
}

const hits = new Map();

const fileStore = {
  async grant(reports, { checkoutId = null, key = null } = {}) {
    const db = await load();
    const plain = key || mintKey();
    // Stripe retries webhooks; a retry must not grant twice.
    if (checkoutId && db.checkouts[checkoutId]) return db.checkouts[checkoutId];
    const h = hash(plain);
    const row = db.keys[h] || { credits: 0, createdAt: new Date().toISOString() };
    row.credits += reports;
    row.updatedAt = new Date().toISOString();
    db.keys[h] = row;
    if (checkoutId) db.checkouts[checkoutId] = plain;
    await save();
    return plain;
  },

  async balance(key) {
    if (!key) return 0;
    const db = await load();
    return db.keys[hash(key)]?.credits || 0;
  },

  async spend(key) {
    if (!key) return null;
    const db = await load();
    const row = db.keys[hash(key)];
    if (!row || row.credits <= 0) return null;
    row.credits -= 1;
    row.updatedAt = new Date().toISOString();
    await save();
    return row.credits;
  },

  async refund(key) {
    if (!key) return;
    const db = await load();
    const row = db.keys[hash(key)];
    if (!row) return;
    row.credits += 1;
    await save();
  },

  async keyForCheckout(checkoutId) {
    const db = await load();
    return db.checkouts[checkoutId] || null;
  },

  async rateLimit(bucket, { max = 30, windowMs = 3600_000 } = {}) {
    const now = Date.now();
    const row = hits.get(bucket);
    if (!row || now > row.reset) {
      hits.set(bucket, { count: 1, reset: now + windowMs });
      return { ok: true, remaining: max - 1 };
    }
    row.count++;
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    }
    return { ok: row.count <= max, remaining: Math.max(0, max - row.count) };
  },
};

/* ---------------- Public interface ---------------- */

const backend = BACKEND === 'supabase' ? sb : fileStore;

/** Create (or top up) a key with `reports` credits. Returns the plaintext key. */
export const grant = (reports, opts) => backend.grant(reports, opts);
export const balance = (key) => backend.balance(key);

/**
 * Spend one credit. Returns the remaining balance, or null if the key is
 * unknown or empty — callers must treat null as "do not call the model".
 */
export const spend = (key) => backend.spend(key);

/** Give a credit back when the model call fails — the buyer got nothing. */
export const refund = (key) => backend.refund(key);

/** Look up the key minted for a completed Stripe Checkout session. */
export const keyForCheckout = (id) => backend.keyForCheckout(id);

/**
 * Fixed-window limiter. Async in both backends so the Supabase one can be
 * shared across instances — the file backend stays process-local, which is
 * correct for a single box and wrong for a fleet.
 */
export const rateLimit = (bucket, opts) => backend.rateLimit(bucket, opts);

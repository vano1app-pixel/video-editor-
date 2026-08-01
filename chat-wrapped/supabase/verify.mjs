// Verifies a live Supabase credit ledger end to end.
//
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service role key> \
//   node supabase/verify.mjs
//
// Checks the things that actually cost money if they are wrong: that a spend
// is atomic under concurrency, that a Stripe webhook retry cannot grant twice,
// and that a refund returns exactly what was taken.

import {
  BACKEND,
  grant,
  balance,
  spend,
  refund,
  keyForCheckout,
  rateLimit,
} from '../credits.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
};

if (BACKEND !== 'supabase') {
  console.error(
    'Not running against Supabase — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
  );
  process.exit(1);
}
console.log(`backend: ${BACKEND}\n`);

const checkoutId = `cs_verify_${Date.now()}`;

// 1. A webhook grants credits and mints a key.
const key = await grant(10, { checkoutId });
check('grant mints a key', key.startsWith('cw_'), key.slice(0, 12) + '…');
check('grant records 10 credits', (await balance(key)) === 10, String(await balance(key)));

// 2. The buyer can claim that key from the checkout id.
check('checkout maps to the key', (await keyForCheckout(checkoutId)) === key);

// 3. Stripe retries webhooks. A retry must not grant a second time.
await grant(10, { checkoutId });
check('duplicate webhook does not double-grant', (await balance(key)) === 10, String(await balance(key)));

// 4. Spending is atomic. Ten concurrent spends against ten credits must yield
//    exactly ten successes — this is the check the JSON file store fails.
const key2 = await grant(10, { checkoutId: `${checkoutId}_b` });
const results = await Promise.all(Array.from({ length: 20 }, () => spend(key2)));
const succeeded = results.filter((r) => r !== null).length;
check('20 concurrent spends against 10 credits → exactly 10 succeed', succeeded === 10, `${succeeded} succeeded`);
check('balance lands on zero', (await balance(key2)) === 0, String(await balance(key2)));

// 5. Spending an empty key is refused rather than going negative.
check('spend on empty key returns null', (await spend(key2)) === null);
check('balance never goes negative', (await balance(key2)) === 0);

// 6. An unknown key is refused.
check('unknown key returns null', (await spend('cw_definitely_not_real')) === null);

// 7. A refund returns exactly one credit.
await refund(key2);
check('refund returns one credit', (await balance(key2)) === 1, String(await balance(key2)));

// 8. Rate limiting is shared, not per-process.
const bucket = `verify:${Date.now()}`;
const hits = [];
for (let i = 0; i < 4; i++) hits.push(await rateLimit(bucket, { max: 3, windowMs: 60_000 }));
check('rate limit allows up to max', hits.slice(0, 3).every((h) => h.ok));
check('rate limit blocks past max', hits[3].ok === false);

console.log(failures ? `\n${failures} FAILURES` : '\nall checks passed');
process.exit(failures ? 1 : 0);

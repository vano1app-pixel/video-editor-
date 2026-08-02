// Stripe webhook: the only place credits are ever granted.
//
// Needs STRIPE_WEBHOOK_SECRET. Signature verification is hand-rolled to avoid
// the Stripe SDK; the scheme is documented and small.
//
// This handler MUST receive the raw request body. Any framework that parses
// JSON first changes the bytes and every signature check fails.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { grant } from '../credits.js';

const TOLERANCE_SECONDS = 300;

function verify(rawBody, header, secret) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    })
  );
  const timestamp = Number(parts.t);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) return false;

  const expected = createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');

  // v1 may repeat when secrets are being rotated; any match is valid.
  const candidates = header
    .split(',')
    .filter((kv) => kv.trim().startsWith('v1='))
    .map((kv) => kv.trim().slice(3));

  const want = Buffer.from(expected, 'utf8');
  return candidates.some((c) => {
    const got = Buffer.from(c, 'utf8');
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'Webhook secret not configured.' });
    return;
  }

  const raw = typeof req.body === 'string' ? req.body : req.rawBody;
  if (typeof raw !== 'string') {
    console.error('stripe-webhook: handler did not receive a raw body string');
    res.status(400).json({ error: 'Raw body required.' });
    return;
  }

  if (!verify(raw, req.headers['stripe-signature'], secret)) {
    res.status(400).json({ error: 'Invalid signature.' });
    return;
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    res.status(400).json({ error: 'Invalid JSON.' });
    return;
  }

  if (event.type !== 'checkout.session.completed') {
    res.status(200).json({ received: true });
    return;
  }

  const session = event.data?.object || {};
  if (session.payment_status !== 'paid') {
    res.status(200).json({ received: true, ignored: 'unpaid' });
    return;
  }

  const reports = Number(session.metadata?.reports);
  if (!Number.isInteger(reports) || reports <= 0 || reports > 1000) {
    console.error('stripe-webhook: bad reports metadata', session.metadata);
    res.status(200).json({ received: true, ignored: 'bad metadata' });
    return;
  }

  try {
    const existing = session.metadata?.key;
    await grant(reports, {
      checkoutId: session.id,
      key: existing && existing.startsWith('cw_') ? existing : null,
    });
    res.status(200).json({ received: true });
  } catch (err) {
    // 500 makes Stripe retry, which is what we want — the buyer paid.
    console.error('stripe-webhook: failed to grant credits', err);
    res.status(500).json({ error: 'Could not record purchase.' });
  }
}

// Creates a Stripe Checkout session. Raw HTTPS rather than the Stripe SDK so
// the whole app stays dependency-free.
//
// Needs STRIPE_SECRET_KEY. The matching webhook (api/stripe-webhook.js) is what
// actually grants credits — never grant them here, the redirect is spoofable.

import { PACKS, CURRENCY } from '../pricing.js';

const STRIPE_API = 'https://api.stripe.com/v1/checkout/sessions';

function form(params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));
  return body;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    res.status(500).json({ error: 'Payments are not configured on this server.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: 'Invalid JSON body.' });
      return;
    }
  }

  const pack = PACKS[body?.pack];
  if (!pack) {
    res.status(400).json({ error: 'Unknown pack.' });
    return;
  }

  const origin =
    process.env.PUBLIC_ORIGIN ||
    req.headers.origin ||
    `http://${req.headers.host || 'localhost:5173'}`;

  try {
    const upstream = await fetch(STRIPE_API, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form({
        mode: 'payment',
        'line_items[0][quantity]': 1,
        'line_items[0][price_data][currency]': CURRENCY,
        'line_items[0][price_data][unit_amount]': pack.priceCents,
        'line_items[0][price_data][product_data][name]': `Chat Wrapped — ${pack.label}`,
        // Carried through to the webhook; this is how we know what to grant.
        'metadata[pack]': pack.id,
        'metadata[reports]': pack.reports,
        // Lets an existing buyer top up the key they already have.
        ...(typeof body.key === 'string' && body.key.startsWith('cw_')
          ? { 'metadata[key]': body.key.slice(0, 64) }
          : {}),
        success_url: `${origin}/?checkout={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/`,
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      console.error('Stripe checkout failed', upstream.status, data?.error?.message);
      res.status(502).json({ error: 'Could not start checkout.' });
      return;
    }
    res.status(200).json({ url: data.url, id: data.id });
  } catch (err) {
    console.error('checkout handler failed', err);
    res.status(500).json({ error: 'Unexpected server error.' });
  }
}

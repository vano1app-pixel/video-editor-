// After Stripe redirects back with ?checkout=<session_id>, the page calls this
// to collect the credit key the webhook minted.
//
// Returns 404 while the webhook is still in flight — the client should retry a
// couple of times before telling the buyer anything is wrong.

import { keyForCheckout, balance } from '../credits.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ?key=cw_… simply reports a balance, so a returning browser can show it.
  const existing = url.searchParams.get('key');
  if (existing) {
    if (!existing.startsWith('cw_')) {
      res.status(400).json({ error: 'Bad key.' });
      return;
    }
    res.status(200).json({ key: existing, credits: await balance(existing) });
    return;
  }

  const checkoutId = url.searchParams.get('checkout');
  if (!checkoutId || !checkoutId.startsWith('cs_')) {
    res.status(400).json({ error: 'Missing checkout id.' });
    return;
  }

  const key = await keyForCheckout(checkoutId);
  if (!key) {
    res.status(404).json({ error: 'Not ready yet.' });
    return;
  }

  res.status(200).json({ key, credits: await balance(key) });
}

// Single source of truth for what a report costs and what it sells for.
// Change the numbers here, not in the handlers.

/**
 * Measured on a real 2,400-message export (see README):
 *   ~3,200 input tokens  (system + tool schema + stats payload + 70 sampled messages)
 *   ~1,000 output tokens (deck copy + 3-5 awards + verdict)
 *
 * Anthropic list prices, per million tokens:
 *   claude-sonnet-5      $3 in / $15 out   ($2 / $10 promotional through 2026-08-31)
 *   claude-haiku-4-5     $1 in / $5  out
 */
export const TOKEN_COST = {
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

const TYPICAL_INPUT_TOKENS = 3200;
const TYPICAL_OUTPUT_TOKENS = 1000;

/** Model cost of one report, in EUR cents. USD≈EUR here; the rounding swamps FX. */
export function reportCostCents(model = 'claude-sonnet-5') {
  const p = TOKEN_COST[model] || TOKEN_COST['claude-sonnet-5'];
  const usd =
    (TYPICAL_INPUT_TOKENS / 1e6) * p.in + (TYPICAL_OUTPUT_TOKENS / 1e6) * p.out;
  return usd * 100;
}

/**
 * Stripe's European card rate. The percentage is irrelevant at these prices —
 * the 25c fixed fee is what actually sets the floor, and it is why a single
 * report cannot be sold for 12c no matter how cheap the model gets.
 */
export const STRIPE_FEE = { percent: 0.015, fixedCents: 25 };

export function netAfterStripe(priceCents) {
  return priceCents * (1 - STRIPE_FEE.percent) - STRIPE_FEE.fixedCents;
}

/** Profit per report for a bundle, in cents. This is the number to tune against. */
export function marginPerReportCents(priceCents, reports, model = 'claude-sonnet-5') {
  return (netAfterStripe(priceCents) - reports * reportCostCents(model)) / reports;
}

/**
 * Bundles. `single` exists because people want to try one thing; the fixed
 * Stripe fee forces its margin up, so it also quietly subsidises `ten`.
 *
 * `ten` is the headline: €1.50 for 10 reports nets ~10c per report after both
 * the model and Stripe — the cheapest price that clears cost plus 10c.
 */
export const PACKS = {
  single: { id: 'single', priceCents: 50, reports: 1, label: '1 report' },
  ten: { id: 'ten', priceCents: 150, reports: 10, label: '10 reports' },
  fifty: { id: 'fifty', priceCents: 500, reports: 50, label: '50 reports' },
};

export const CURRENCY = 'eur';

/** Free reports per browser before the paywall. Keep it at 1: the first hit is the ad. */
export const FREE_REPORTS = 1;

/** Printable economics table — used by `node pricing.js`. */
export function table(model = 'claude-sonnet-5') {
  return Object.values(PACKS).map((p) => ({
    pack: p.label,
    price: `€${(p.priceCents / 100).toFixed(2)}`,
    perReport: `€${(p.priceCents / p.reports / 100).toFixed(3)}`,
    stripeTakes: `€${((p.priceCents - netAfterStripe(p.priceCents)) / 100).toFixed(2)}`,
    modelCost: `€${((p.reports * reportCostCents(model)) / 100).toFixed(3)}`,
    marginPerReport: `€${(marginPerReportCents(p.priceCents, p.reports, model) / 100).toFixed(3)}`,
  }));
}

// `node pricing.js` prints the table. Guarded because this module is also
// imported by the browser, where `process` does not exist.
if (
  typeof process !== 'undefined' &&
  process.argv?.[1] &&
  import.meta.url.endsWith(process.argv[1].split('/').pop())
) {
  for (const model of Object.keys(TOKEN_COST)) {
    console.log(`\n${model} — €${(reportCostCents(model) / 100).toFixed(4)} per report`);
    console.table(table(model));
  }
}

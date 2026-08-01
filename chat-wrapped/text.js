// Small text helpers shared by the stats, moments and deck layers.
// These lived in two places each; keeping one copy also keeps the standalone
// bundle free of duplicate top-level declarations.

/**
 * Matches a full emoji, including ZWJ sequences and variation selectors, so
 * "👨‍👩‍👧" counts once rather than as three separate people.
 * Only ever used with `match` / `matchAll` / `replace`, never `test` — the /g
 * flag makes `test` stateful.
 */
export const EMOJI =
  /(?:\p{Extended_Pictographic}(?:️)?(?:‍\p{Extended_Pictographic}(?:️)?)*)/gu;

/** "Tom O'Brien" → "Tom". Cards have room for one name, not two. */
export function firstName(name = '') {
  return name.split(/\s+/)[0].replace(/[^\p{L}\p{N}'’-]/gu, '') || name;
}

/** Naive pluraliser — every unit these cards use is a regular noun. */
export function plural(word, n) {
  if (n === 1 || !word) return word;
  return word.endsWith('s') ? word : `${word}s`;
}

/** Collapse whitespace and cut to length, for quoting messages on a card. */
export function truncate(text, max = 180) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// Finds quotable moments — the actual messages worth putting on a card.
//
// Everything here is heuristic and works on the transcript alone: WhatsApp
// exports carry no reactions or reply threads, so "funniest" is inferred from
// how the group responded in the seconds after a message landed.

import { EMOJI, firstName, plural } from './text.js';

const LAUGH_SIGNAL =
  /(?:\bl+o+l+\b|\bl+m+f?a+o+\b|h[ae]h[ae]h[ae]+|\ba?h+a+h+[ah]*\b|😂|🤣|💀|😭|\bdying\b|\bdead\b|\bcrying\b|\bstop\b)/iu;

// A proposal phrase alone is too loose — "anyone want anything from Centra" is
// a shop run, not a plan. Require a proposal *and* something plan-shaped to do.
const PLAN_PROPOSAL =
  /\b(?:we should|lets |let's |shall we|who's in|whos in|you free|u free|anyone (?:free|up for|coming|fancy)|how about|what about|fancy)\b/i;

const PLAN_CONTEXT =
  /\b(?:tonight|tomorrow|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|august|summer|trip|holiday|pub|pint|pints|drinks|dinner|lunch|brunch|food|cinema|match|quiz|session|party|gaff|meet|meetup|away|book|table|gig|festival)\b/i;

/** Shop runs and lifts read as proposals but are not plans. */
const NOT_A_PLAN = /\banything from\b|\ba lift\b|\bcharger\b/i;

const PLAN_YES = /\b(?:yes|yeah|yep|ye|sound|deadly|im in|i'm in|in|down|grand|👍|✅|see you|cya|perfect|great)\b/i;

const REPLY_WINDOW_MIN = 30;
const BURST_WINDOW_MIN = 15;

function quotable(m) {
  return !m.isMedia && !m.isDeleted && m.text.length >= 12 && m.text.length <= 280;
}

/**
 * Who laughed after message i, and how hard.
 *
 * Counting unique laughers alone lets a filler line win whenever someone
 * happens to laugh twenty minutes later at something else, so each laugher is
 * weighted by how fast they reacted — an instant reply is the real signal.
 */
function laughterAfter(messages, i) {
  const start = messages[i];
  const seen = new Map();
  for (let j = i + 1; j < Math.min(i + 8, messages.length); j++) {
    const m = messages[j];
    const gap = (m.ts - start.ts) / 60000;
    if (gap > REPLY_WINDOW_MIN) break;
    if (m.author === start.author) continue;
    if (!LAUGH_SIGNAL.test(m.text)) continue;
    const weight = 1 / (1 + gap / 3);
    seen.set(m.author, Math.max(seen.get(m.author) || 0, weight));
  }
  const laughers = seen.size;
  const score = [...seen.values()].reduce((a, b) => a + b, 0);
  return { laughers, score };
}

/** How many messages followed within the burst window — a proxy for "kicked off". */
function burstAfter(messages, i) {
  const start = messages[i];
  let n = 0;
  const people = new Set();
  for (let j = i + 1; j < messages.length; j++) {
    const m = messages[j];
    if ((m.ts - start.ts) / 60000 > BURST_WINDOW_MIN) break;
    n++;
    people.add(m.author);
  }
  return { count: n, people: people.size };
}

/** Word frequencies across the window, so we can spot genuinely rare words. */
function wordFrequency(messages) {
  const freq = new Map();
  for (const m of messages) {
    for (const w of m.text.toLowerCase().split(/[^\p{L}']+/u)) {
      if (w.length > 3) freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return freq;
}

/**
 * Weirdness is a blend of signals that each mean "this is not a normal message":
 * rare vocabulary, shouting, 2-5am, emoji spam, or sheer length.
 */
function weirdnessScore(m, freq, totalWords) {
  const text = m.text;
  const words = text.toLowerCase().split(/[^\p{L}']+/u).filter((w) => w.length > 3);
  if (!words.length) return 0;

  let rare = 0;
  for (const w of words) {
    const f = freq.get(w) || 1;
    if (f === 1 && w.length >= 7) rare += 1;
  }
  const rareRatio = rare / words.length;

  const letters = text.replace(/[^a-zA-Z]/g, '');
  const capsRatio = letters.length > 8 ? (text.match(/[A-Z]/g) || []).length / letters.length : 0;

  const hour = m.ts.getHours();
  const nocturnal = hour >= 2 && hour < 5 ? 1 : 0;

  const emojiCount = (text.match(EMOJI) || []).length;
  const emojiSpam = Math.min(1, emojiCount / 6);

  const longform = Math.min(1, text.length / 260);
  const shouting = capsRatio > 0.6 ? 1 : 0;
  const punctuation = /[!?]{3,}/.test(text) ? 0.6 : 0;

  return (
    rareRatio * 3 + nocturnal * 1.6 + emojiSpam * 1.2 + longform * 1.4 + shouting * 1.5 + punctuation
  );
}

/**
 * @returns {{
 *   funniest: object|null, weirdest: object|null, biggest: object|null,
 *   longest: object|null, plans: object
 * }}
 */
export function findMoments(messages) {
  const real = messages.filter((m) => !m.isDeleted);
  if (real.length < 10) {
    return { funniest: null, weirdest: null, biggest: null, longest: null, plans: emptyPlans() };
  }

  const freq = wordFrequency(real);
  const candidates = [];
  let longest = null;

  for (let i = 0; i < real.length; i++) {
    const m = real[i];
    if (!longest || (quotable(m) && m.text.length > longest.text.length)) {
      if (quotable(m)) longest = { text: m.text, author: firstName(m.author), ts: m.ts };
    }
    if (!quotable(m)) continue;

    const laughter = laughterAfter(real, i);
    const burst = burstAfter(real, i);
    candidates.push({
      text: m.text,
      author: firstName(m.author),
      ts: m.ts,
      laughers: laughter.laughers,
      laughScore: laughter.score,
      weirdScore: weirdnessScore(m, freq),
      replies: burst.count,
      people: burst.people,
    });
  }

  // Pick in order of confidence and never quote the same message twice — three
  // cards showing one line looks like a bug, because it is one.
  const used = new Set();
  const take = (pool, rank) => {
    const best = pool
      .filter((c) => !used.has(c.text))
      .sort((a, b) => rank(b) - rank(a))[0];
    if (best) used.add(best.text);
    return best || null;
  };

  const funniest = take(
    // Two laughers is the floor: one person laughing is noise.
    candidates.filter((c) => c.laughers >= 2),
    (c) => c.laughScore
  );
  const biggest = take(
    candidates.filter((c) => c.people >= 2 && c.replies >= 4),
    (c) => c.replies
  );
  const weirdest = take(candidates, (c) => c.weirdScore);

  return { funniest, weirdest, biggest, longest, plans: findPlans(real) };
}

function emptyPlans() {
  return { proposed: 0, ignored: 0, ignoredRate: 0, topProposer: null, deadest: null };
}

/**
 * A "plan" is a proposal-shaped message. It counts as ignored when fewer than
 * two other people said anything affirmative within three hours — which is a
 * fair description of how group plans actually die.
 */
export function findPlans(messages) {
  const proposals = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.isMedia || NOT_A_PLAN.test(m.text)) continue;
    // Either an explicit "we should…" or a proposal with something to do attached.
    const explicit = /\b(?:we should|shall we)\b/i.test(m.text);
    if (!explicit && !(PLAN_PROPOSAL.test(m.text) && PLAN_CONTEXT.test(m.text))) continue;

    const responders = new Set();
    for (let j = i + 1; j < messages.length; j++) {
      const n = messages[j];
      if ((n.ts - m.ts) / 3600000 > 3) break;
      if (n.author === m.author) continue;
      if (PLAN_YES.test(n.text)) responders.add(n.author);
    }
    proposals.push({
      text: m.text,
      author: firstName(m.author),
      ts: m.ts,
      responders: responders.size,
    });
  }

  if (!proposals.length) return emptyPlans();

  const ignored = proposals.filter((p) => p.responders < 2);
  const byAuthor = new Map();
  for (const p of proposals) byAuthor.set(p.author, (byAuthor.get(p.author) || 0) + 1);
  const topProposer = [...byAuthor.entries()].sort((a, b) => b[1] - a[1])[0];

  // The most enthusiastic proposal nobody answered.
  const deadest =
    ignored
      .filter((p) => p.responders === 0 && p.text.length >= 12)
      .sort((a, b) => b.text.length - a.text.length)[0] || null;

  return {
    proposed: proposals.length,
    ignored: ignored.length,
    ignoredRate: Math.round((ignored.length / proposals.length) * 100),
    topProposer: topProposer ? { name: topProposer[0], count: topProposer[1] } : null,
    deadest,
  };
}

/**
 * One title per person, no duplicates. Candidates are checked in order, so the
 * strongest signals get claimed first and everyone still ends up with something.
 */
export function assignTags(stats) {
  const sup = stats.superlatives;
  const taken = new Set();
  const tags = new Map();

  const claim = (person, tag, detail) => {
    if (!person || taken.has(person.name) || [...tags.values()].some((t) => t.tag === tag)) return;
    taken.add(person.name);
    tags.set(person.name, { tag, detail });
  };

  claim(sup.yapper, 'The Yapper', `${sup.yapper?.messages ?? 0} messages`);
  claim(sup.ghost, 'The Ghost', sup.ghost ? `replies in ${sup.ghost.medianReplyMin} min` : '');
  claim(sup.nightOwl, 'The Night Owl', `${sup.nightOwl?.nightMessages ?? 0} after midnight`);
  claim(sup.comedian, 'The Comedian', `${sup.comedian?.laughs ?? 0} laughs`);
  claim(sup.planner, 'The Planner', `${sup.planner?.planMessages ?? 0} plans`);
  claim(
    sup.fastestReplier,
    'Terminally Online',
    sup.fastestReplier ? `replies in ${sup.fastestReplier.medianReplyMin} min` : ''
  );
  claim(sup.photographer, 'The Photographer', `${sup.photographer?.media ?? 0} photos`);
  claim(sup.interrogator, 'The Interrogator', `${sup.interrogator?.questions ?? 0} questions`);
  claim(sup.starter, 'The Icebreaker', `${sup.starter?.conversationStarters ?? 0} days opened`);
  claim(sup.doubleTexter, 'The Double Texter', `${sup.doubleTexter?.doubleTexts ?? 0} double texts`);
  claim(sup.apologiser, 'Sorry About That', `${sup.apologiser?.apologies ?? 0} apologies`);

  // Anyone still unlabelled gets one derived from their own strongest habit.
  // Each needs a real threshold — "The Emoji Enthusiast, 1 emoji" is a worse
  // label than no label at all.
  const FALLBACKS = [
    { tag: 'The Emoji Enthusiast', pick: (p) => p.emojiCount, unit: 'emoji', min: 15 },
    { tag: 'The Essayist', pick: (p) => p.avgLength, unit: 'characters a message', min: 60 },
    { tag: 'The Link Dropper', pick: (p) => p.links, unit: 'link', min: 5 },
    { tag: 'The One-Word Reply', pick: (p) => 100 - p.avgLength, unit: null, min: 85 },
  ];

  for (const person of stats.people) {
    if (tags.has(person.name)) continue;
    const option = FALLBACKS.find(
      (f) =>
        f.pick(person) >= f.min && ![...tags.values()].some((t) => t.tag === f.tag)
    );
    if (option) {
      const value = Math.round(option.pick(person));
      tags.set(person.name, {
        tag: option.tag,
        detail: option.unit ? `${value} ${plural(option.unit, value)}` : `${person.messages} messages`,
      });
    } else {
      tags.set(person.name, {
        tag: 'The Regular',
        detail: `${person.messages} ${plural('message', person.messages)}`,
      });
    }
  }

  return stats.people.map((p) => ({
    name: firstName(p.name),
    messages: p.messages,
    ...(tags.get(p.name) || { tag: 'The Regular', detail: `${p.messages} messages` }),
  }));
}

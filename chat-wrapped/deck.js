// Turns a stat block into an ordered deck of story cards.
// Every card works without AI; AI copy fills the `line` slots when available.

// Each palette is a two-stop gradient plus a soft highlight, so consecutive
// cards read as one family without any two looking alike in a screenshot roll.
const PALETTES = [
  { bg: 'linear-gradient(155deg,#1DB954 0%,#0A5C2C 55%,#04381B 100%)', glow: '#7bffb0' },
  { bg: 'linear-gradient(155deg,#FF5F6D 0%,#B02EA8 55%,#5B1B7B 100%)', glow: '#ffd0e4' },
  { bg: 'linear-gradient(155deg,#FFC93C 0%,#F0576B 60%,#8E1D4E 100%)', glow: '#fff2b8' },
  { bg: 'linear-gradient(155deg,#00E1A0 0%,#0E8FC4 55%,#0A3E70 100%)', glow: '#c8fff0' },
  { bg: 'linear-gradient(155deg,#9B5DE5 0%,#3A6FE0 55%,#17255F 100%)', glow: '#e6d4ff' },
  { bg: 'linear-gradient(155deg,#F1FA6E 0%,#00C9A7 55%,#08594F 100%)', glow: '#f6ffd9' },
  { bg: 'linear-gradient(155deg,#FF9A5A 0%,#E0489F 55%,#6C1450 100%)', glow: '#ffe0ee' },
  { bg: 'linear-gradient(155deg,#42E8E0 0%,#3A5BD9 55%,#1B1F5C 100%)', glow: '#d6fbff' },
];

const HOUR_LABEL = (h) => {
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
};

const fmt = (n) => n.toLocaleString();

function firstName(name = '') {
  return name.split(/\s+/)[0].replace(/[^\p{L}\p{N}'’-]/gu, '') || name;
}

function humanDuration(minutes) {
  if (minutes < 60) return `${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * Only claim a multiplier when there is one worth claiming — a 34-vs-48-minute
 * gap rounds to "1x longer", which reads as broken.
 */
function ghostLine(fastest, ghost) {
  const ratio = ghost.medianReplyMin / Math.max(1, fastest.medianReplyMin);
  if (ratio >= 2) {
    return `${firstName(ghost.name)} takes ${Math.round(
      ratio
    )}x longer to reply. Everyone has noticed.`;
  }
  const gap = ghost.medianReplyMin - fastest.medianReplyMin;
  if (gap >= 5) {
    return `${firstName(ghost.name)} is ${replyTime(gap)} behind ${firstName(
      fastest.name
    )}. Not a huge gap, but a consistent one.`;
  }
  return `Closer than anyone would admit — ${replyTime(
    Math.max(1, gap)
  )} between the fastest and the slowest.`;
}

function replyTime(minutes) {
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round((minutes / 60) * 10) / 10} hours`;
}

function truncate(text, max = 180) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * @param stats    output of computeStats
 * @param ai       optional { title, lines: {cardId: string}, awards: [], verdict }
 * @param label    the window name, e.g. "Last 7 days"
 * @param moments  optional output of findMoments — adds the quoted cards
 */
export function buildDeck(stats, ai = null, label = 'All time', moments = null) {
  const s = stats;
  const sup = s.superlatives;
  const cards = [];
  const line = (id, fallback) => (ai && ai.lines && ai.lines[id]) || fallback;

  cards.push({
    id: 'intro',
    kind: 'intro',
    eyebrow: label,
    title: ai?.title || 'Your group chat,\nwrapped.',
    line: line(
      'intro',
      `${fmt(s.total)} messages between ${s.peopleCount} people. Let's see what you've been doing.`
    ),
  });

  cards.push({
    id: 'total',
    kind: 'bignumber',
    eyebrow: 'You sent',
    value: fmt(s.total),
    unit: s.total === 1 ? 'message' : 'messages',
    line: line(
      'total',
      `That's ${s.perDay} a day, every day, for ${s.spanDays} days. Nobody asked for this.`
    ),
  });

  if (s.people.length > 1) {
    cards.push({
      id: 'leaderboard',
      kind: 'leaderboard',
      eyebrow: 'The leaderboard',
      title: 'Who actually talks',
      rows: s.people.slice(0, 6).map((p) => ({
        name: firstName(p.name),
        value: fmt(p.messages),
        pct: Math.round(p.share * 100),
      })),
      line: line(
        'leaderboard',
        sup.yapper
          ? `${firstName(sup.yapper.name)} sent ${Math.round(
              sup.yapper.share * 100
            )}% of everything. Alone.`
          : ''
      ),
    });
  }

  if (sup.yapper) {
    cards.push({
      id: 'yapper',
      kind: 'award',
      eyebrow: 'Award',
      award: 'THE YAPPER',
      person: firstName(sup.yapper.name),
      stat: `${fmt(sup.yapper.messages)} messages`,
      line: line(
        'yapper',
        `${fmt(sup.yapper.words)} words. A short novel, in the group chat, unprompted.`
      ),
    });
  }

  cards.push({
    id: 'clock',
    kind: 'chart',
    eyebrow: 'Your rhythm',
    title: `Peak chaos: ${HOUR_LABEL(s.peakHour)}`,
    bars: s.hours,
    barLabels: s.hours.map((_, i) => (i % 6 === 0 ? HOUR_LABEL(i) : '')),
    line: line(
      'clock',
      `${HOUR_LABEL(s.peakHour)} is when this chat comes alive. Make of that what you will.`
    ),
  });

  if (sup.nightOwl && sup.nightOwl.nightMessages > 5) {
    cards.push({
      id: 'nightowl',
      kind: 'award',
      eyebrow: 'Award',
      award: 'THE NIGHT OWL',
      person: firstName(sup.nightOwl.name),
      stat: `${fmt(sup.nightOwl.nightMessages)} messages after midnight`,
      line: line('nightowl', 'Whatever is going on, we hope it gets resolved.'),
    });
  }

  if (s.topEmojis.length) {
    cards.push({
      id: 'emoji',
      kind: 'emoji',
      eyebrow: 'Your personality, ranked',
      emojis: s.topEmojis.slice(0, 6),
      line: line(
        'emoji',
        `${fmt(s.totalEmojis)} emojis. ${s.topEmojis[0].emoji} did most of the heavy lifting.`
      ),
    });
  }

  if (s.topWords.length >= 3) {
    cards.push({
      id: 'words',
      kind: 'words',
      eyebrow: 'Words you would not shut up about',
      words: s.topWords.slice(0, 8),
      line: line('words', `"${s.topWords[0].word}" — ${fmt(s.topWords[0].count)} times.`),
    });
  }

  if (sup.fastestReplier && sup.ghost && sup.fastestReplier.name !== sup.ghost.name) {
    cards.push({
      id: 'replies',
      kind: 'versus',
      eyebrow: 'Reply times',
      left: {
        label: 'FASTEST',
        name: firstName(sup.fastestReplier.name),
        value: replyTime(sup.fastestReplier.medianReplyMin),
      },
      right: {
        label: 'THE GHOST',
        name: firstName(sup.ghost.name),
        value: replyTime(sup.ghost.medianReplyMin),
      },
      line: line('replies', ghostLine(sup.fastestReplier, sup.ghost)),
    });
  }

  if (moments?.funniest) {
    cards.push({
      id: 'funniest',
      kind: 'quote',
      eyebrow: 'The funniest thing said',
      quote: truncate(moments.funniest.text),
      attribution: moments.funniest.author,
      meta: `made ${moments.funniest.laughers} ${
        moments.funniest.laughers === 1 ? 'person' : 'people'
      } laugh`,
      line: line('funniest', 'Peaked. It has been downhill since.'),
    });
  }

  if (moments?.biggest) {
    cards.push({
      id: 'biggest',
      kind: 'quote',
      eyebrow: 'The message that set it off',
      quote: truncate(moments.biggest.text),
      attribution: moments.biggest.author,
      meta: `${moments.biggest.replies} replies in 15 minutes`,
      line: line(
        'biggest',
        `${moments.biggest.people} people dropped everything to respond to this.`
      ),
    });
  }

  if (moments?.weirdest) {
    cards.push({
      id: 'weirdest',
      kind: 'quote',
      eyebrow: 'The weirdest thing said',
      quote: truncate(moments.weirdest.text),
      attribution: moments.weirdest.author,
      meta: moments.weirdest.ts.toLocaleString(undefined, {
        weekday: 'long',
        hour: 'numeric',
        minute: '2-digit',
      }),
      line: line('weirdest', 'No context was provided. None was offered afterwards.'),
    });
  }

  if (moments?.plans?.proposed >= 3) {
    const p = moments.plans;
    cards.push({
      id: 'plans',
      kind: 'plans',
      eyebrow: 'Plans',
      proposed: p.proposed,
      ignored: p.ignored,
      ignoredRate: p.ignoredRate,
      proposer: p.topProposer,
      deadest: p.deadest ? truncate(p.deadest.text, 120) : null,
      deadestAuthor: p.deadest?.author || null,
      line: line(
        'plans',
        `${p.ignoredRate}% of plans proposed here got fewer than two takers.`
      ),
    });
  }

  if (sup.comedian && sup.comedian.laughs > 3) {
    cards.push({
      id: 'comedian',
      kind: 'award',
      eyebrow: 'Award',
      award: 'LOUDEST LAUGHER',
      person: firstName(sup.comedian.name),
      stat: `${fmt(sup.comedian.laughs)} laughs`,
      line: line('comedian', 'Statistically, not all of these were genuine.'),
    });
  }

  if (sup.planner && sup.planner.planMessages > 3) {
    cards.push({
      id: 'planner',
      kind: 'award',
      eyebrow: 'Award',
      award: 'THE PLAN STARTER',
      person: firstName(sup.planner.name),
      stat: `${fmt(sup.planner.planMessages)} plans proposed`,
      line: line('planner', 'Number of these that actually happened: unclear. Probably low.'),
    });
  }

  if (s.quietStretch.minutes > 180 && s.quietStretch.from) {
    cards.push({
      id: 'silence',
      kind: 'bignumber',
      eyebrow: 'Longest silence',
      value: humanDuration(s.quietStretch.minutes),
      unit: 'of absolutely nothing',
      line: line(
        'silence',
        `Starting ${s.quietStretch.from.toLocaleDateString()}. We assume everyone was fine.`
      ),
    });
  }

  if (s.busiestDay.count > 0) {
    cards.push({
      id: 'busiest',
      kind: 'bignumber',
      eyebrow: 'Your busiest day',
      value: fmt(s.busiestDay.count),
      unit: `messages on ${new Date(s.busiestDay.date).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'long',
      })}`,
      line: line('busiest', 'Something happened that day. You know what it was.'),
    });
  }

  const awards = (ai && ai.awards) || [];
  for (const [i, a] of awards.entries()) {
    if (!a || !a.title || !a.person) continue;
    cards.push({
      id: `ai-award-${i}`,
      kind: 'award',
      eyebrow: 'Award',
      award: a.title.toUpperCase(),
      person: firstName(a.person),
      stat: a.stat || '',
      line: a.line || '',
    });
  }

  if (moments?.tags?.length > 1) {
    cards.push({
      id: 'tags',
      kind: 'tags',
      eyebrow: 'Everyone, labelled',
      title: 'Your official titles',
      rows: moments.tags,
      line: line('tags', 'Screenshot this one. Argue about it later.'),
    });
  }

  cards.push({
    id: 'verdict',
    kind: 'verdict',
    eyebrow: 'The verdict',
    title: (ai && ai.verdict && ai.verdict.title) || 'This group chat is a lot',
    line: line(
      'verdict',
      (ai && ai.verdict && ai.verdict.body) ||
        `${fmt(s.total)} messages, ${fmt(s.totalEmojis)} emojis and ${fmt(
          s.totalLaughs
        )} laughs later, you are all still here. That counts for something.`
    ),
  });

  cards.push({
    id: 'share',
    kind: 'share',
    eyebrow: label,
    title: 'Share it',
    stats: [
      { k: 'Messages', v: fmt(s.total) },
      { k: 'People', v: fmt(s.peopleCount) },
      { k: 'Days', v: fmt(s.spanDays) },
      { k: 'Top yapper', v: sup.yapper ? firstName(sup.yapper.name) : '—' },
    ],
    line: 'Paste this into the group. Watch it kick off.',
  });

  return cards.map((c, i) => ({ ...c, palette: PALETTES[i % PALETTES.length], index: i }));
}

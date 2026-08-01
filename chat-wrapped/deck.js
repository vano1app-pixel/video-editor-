// Turns a stat block into an ordered deck of story cards.
// Every card works without AI; AI copy fills the `line` slots when available.

const PALETTES = [
  { bg: 'linear-gradient(160deg,#1DB954 0%,#0b6b31 100%)', ink: '#03180c', accent: '#ffffff' },
  { bg: 'linear-gradient(160deg,#FF6B6B 0%,#8E2DE2 100%)', ink: '#2a0033', accent: '#fff3b0' },
  { bg: 'linear-gradient(160deg,#FFD166 0%,#EF476F 100%)', ink: '#3d0a1c', accent: '#22143a' },
  { bg: 'linear-gradient(160deg,#06D6A0 0%,#118AB2 100%)', ink: '#02272f', accent: '#fff6d6' },
  { bg: 'linear-gradient(160deg,#845EC2 0%,#2C73D2 100%)', ink: '#0d0730', accent: '#ffd6ff' },
  { bg: 'linear-gradient(160deg,#F9F871 0%,#00C9A7 100%)', ink: '#0a2b26', accent: '#123a2f' },
  { bg: 'linear-gradient(160deg,#FF9671 0%,#D65DB1 100%)', ink: '#38062c', accent: '#fff0f6' },
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

function replyTime(minutes) {
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round((minutes / 60) * 10) / 10} hours`;
}

/**
 * @param stats  output of computeStats
 * @param ai     optional { title, lines: {cardId: string}, awards: [], verdict }
 * @param label  the window name, e.g. "Last 7 days"
 */
export function buildDeck(stats, ai = null, label = 'All time') {
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
      line: line(
        'replies',
        `${firstName(sup.ghost.name)} takes ${Math.round(
          sup.ghost.medianReplyMin / Math.max(1, sup.fastestReplier.medianReplyMin)
        )}x longer to reply. Everyone has noticed.`
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

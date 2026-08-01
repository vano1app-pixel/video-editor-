// All the number-crunching. Pure functions over parsed messages, no network.

const STOPWORDS = new Set(
  `a an the and or but if then than that this these those i im i'm you your youre you're he she it we they me him her us them my mine our ours their theirs is am are was were be been being do does did doing have has had having will would shall should can could may might must not no nor so as at by for from in into of off on onto out over to up with about after again all also any because before both during each few more most other own same some such only very just how what when where which who whom why yeah yea yes ok okay oh ah eh um uh lol lmao haha hahaha hah k kk ye ya na nah bruh bro dude man like get got go going gone know think really actually still even back one two dont don't cant can't didnt didn't im ill i'll ive i've thats that's whats what's its it's u ur r n y idk omg wtf tbh rn ngl fr`
    .split(/\s+/)
);

const LAUGH = /\b(?:l+o+l+|l+m+f?a+o+|h[ae]h[ae]h[ae]+|a?h+a+h+[ah]*|😂|🤣|💀)\b|😂|🤣|💀/giu;
const LINK = /https?:\/\/\S+/gi;
const QUESTION = /\?/;
const EMOJI =
  /(?:\p{Extended_Pictographic}(?:️)?(?:‍\p{Extended_Pictographic}(?:️)?)*)/gu;

const PLAN_WORDS =
  /\b(?:tomorrow|tonight|weekend|saturday|sunday|friday|later|meet|meetup|plan|plans|book|booking|pub|drinks|dinner|lunch|brunch|trip|holiday|session|we should|lets|let's|shall we|you free|u free|who's in|whos in)\b/i;

const APOLOGY = /\b(?:sorry|my bad|apologies|oops|whoops|forgot)\b/i;

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function topN(map, n = 5) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function emptyPerson(name) {
  return {
    name,
    messages: 0,
    words: 0,
    chars: 0,
    media: 0,
    links: 0,
    questions: 0,
    laughs: 0,
    emojiCount: 0,
    deleted: 0,
    nightMessages: 0,
    conversationStarters: 0,
    planMessages: 0,
    apologies: 0,
    doubleTexts: 0,
    longestMessage: '',
    replyGaps: [],
    emojis: new Map(),
    words_: new Map(),
    hours: new Array(24).fill(0),
  };
}

/**
 * Build the full stat block. `messages` must be chronological.
 */
export function computeStats(messages) {
  const real = messages.filter((m) => !m.isDeleted);
  if (!real.length) return null;

  const people = new Map();
  const perDay = new Map();
  const perMonth = new Map();
  const hours = new Array(24).fill(0);
  const weekdays = new Array(7).fill(0);
  const emojisAll = new Map();
  const wordsAll = new Map();

  let prev = null;
  let lastDay = null;

  for (const m of real) {
    if (!people.has(m.author)) people.set(m.author, emptyPerson(m.author));
    const p = people.get(m.author);
    const body = m.isMedia ? '' : m.text;

    p.messages++;
    p.chars += body.length;
    const hour = m.ts.getHours();
    p.hours[hour]++;
    hours[hour]++;
    weekdays[m.ts.getDay()]++;

    if (hour >= 0 && hour < 5) p.nightMessages++;
    if (m.isMedia) p.media++;
    if (m.isDeleted) p.deleted++;
    if (QUESTION.test(body)) p.questions++;
    if (PLAN_WORDS.test(body)) p.planMessages++;
    if (APOLOGY.test(body)) p.apologies++;

    const links = body.match(LINK);
    if (links) p.links += links.length;

    const laughs = body.match(LAUGH);
    if (laughs) p.laughs += laughs.length;

    for (const e of body.matchAll(EMOJI)) {
      const ch = e[0];
      p.emojiCount++;
      p.emojis.set(ch, (p.emojis.get(ch) || 0) + 1);
      emojisAll.set(ch, (emojisAll.get(ch) || 0) + 1);
    }

    const tokens = body
      .toLowerCase()
      .replace(LINK, ' ')
      .replace(EMOJI, ' ')
      .split(/[^\p{L}\p{N}']+/u)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));
    p.words += tokens.length;
    for (const w of tokens) {
      p.words_.set(w, (p.words_.get(w) || 0) + 1);
      wordsAll.set(w, (wordsAll.get(w) || 0) + 1);
    }

    if (body.length > p.longestMessage.length) p.longestMessage = body;

    const dk = dayKey(m.ts);
    perDay.set(dk, (perDay.get(dk) || 0) + 1);
    const mk = `${m.ts.getFullYear()}-${String(m.ts.getMonth() + 1).padStart(2, '0')}`;
    perMonth.set(mk, (perMonth.get(mk) || 0) + 1);

    if (dk !== lastDay) {
      p.conversationStarters++;
      lastDay = dk;
    }

    if (prev) {
      const gapMin = (m.ts - prev.ts) / 60000;
      if (prev.author !== m.author && gapMin >= 0 && gapMin < 720) {
        p.replyGaps.push(gapMin);
      } else if (prev.author === m.author && gapMin > 30) {
        p.doubleTexts++;
      }
    }
    prev = m;
  }

  const total = real.length;
  const start = real[0].ts;
  const end = real[real.length - 1].ts;
  const spanDays = Math.max(1, Math.round((end - start) / 86400000) + 1);

  const roster = [...people.values()].map((p) => ({
    name: p.name,
    messages: p.messages,
    share: p.messages / total,
    words: p.words,
    avgLength: p.messages ? Math.round(p.chars / p.messages) : 0,
    media: p.media,
    links: p.links,
    questions: p.questions,
    laughs: p.laughs,
    emojiCount: p.emojiCount,
    nightMessages: p.nightMessages,
    conversationStarters: p.conversationStarters,
    planMessages: p.planMessages,
    apologies: p.apologies,
    doubleTexts: p.doubleTexts,
    medianReplyMin: Math.round(median(p.replyGaps)),
    replyCount: p.replyGaps.length,
    topEmojis: topN(p.emojis, 3).map(([e, c]) => ({ emoji: e, count: c })),
    topWords: topN(p.words_, 5).map(([w, c]) => ({ word: w, count: c })),
    longestMessage: p.longestMessage.slice(0, 400),
    peakHour: p.hours.indexOf(Math.max(...p.hours)),
  }));

  roster.sort((a, b) => b.messages - a.messages);

  const busiestDay = topN(perDay, 1)[0] || ['', 0];
  const quietStretch = longestSilence(real);

  // Only rank repliers with enough samples to mean anything.
  const repliers = roster.filter((p) => p.replyCount >= 5);
  const fastest = repliers.length
    ? [...repliers].sort((a, b) => a.medianReplyMin - b.medianReplyMin)[0]
    : null;
  const slowest = repliers.length
    ? [...repliers].sort((a, b) => b.medianReplyMin - a.medianReplyMin)[0]
    : null;

  const pick = (key) =>
    roster.length ? [...roster].sort((a, b) => b[key] - a[key])[0] : null;

  return {
    total,
    people: roster,
    peopleCount: roster.length,
    start,
    end,
    spanDays,
    perDay: Math.round((total / spanDays) * 10) / 10,
    activeDays: perDay.size,
    hours,
    weekdays,
    perMonth: [...perMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    busiestDay: { date: busiestDay[0], count: busiestDay[1] },
    topEmojis: topN(emojisAll, 8).map(([e, c]) => ({ emoji: e, count: c })),
    topWords: topN(wordsAll, 12).map(([w, c]) => ({ word: w, count: c })),
    totalEmojis: [...emojisAll.values()].reduce((a, b) => a + b, 0),
    totalLaughs: roster.reduce((a, p) => a + p.laughs, 0),
    totalMedia: roster.reduce((a, p) => a + p.media, 0),
    peakHour: hours.indexOf(Math.max(...hours)),
    quietStretch,
    superlatives: {
      yapper: roster[0] || null,
      nightOwl: pick('nightMessages'),
      comedian: pick('laughs'),
      photographer: pick('media'),
      interrogator: pick('questions'),
      planner: pick('planMessages'),
      starter: pick('conversationStarters'),
      doubleTexter: pick('doubleTexts'),
      apologiser: pick('apologies'),
      fastestReplier: fastest,
      ghost: slowest,
    },
  };
}

function longestSilence(messages) {
  let best = { minutes: 0, from: null, to: null };
  for (let i = 1; i < messages.length; i++) {
    const gap = (messages[i].ts - messages[i - 1].ts) / 60000;
    if (gap > best.minutes) {
      best = { minutes: Math.round(gap), from: messages[i - 1].ts, to: messages[i].ts };
    }
  }
  return best;
}

/**
 * A compact, privacy-conscious payload for the writer model: aggregate numbers
 * plus a sample of real messages so the copy can reference actual jokes.
 */
export function buildAiPayload(stats, messages, moments = null, sampleSize = 70) {
  const candidates = messages.filter(
    (m) => !m.isMedia && !m.isDeleted && m.text.length > 12 && m.text.length < 300
  );
  const sample = [];
  if (candidates.length) {
    const step = Math.max(1, Math.floor(candidates.length / sampleSize));
    for (let i = 0; i < candidates.length && sample.length < sampleSize; i += step) {
      sample.push({ from: candidates[i].author, text: candidates[i].text });
    }
  }

  return {
    window: {
      from: stats.start.toISOString().slice(0, 10),
      to: stats.end.toISOString().slice(0, 10),
      days: stats.spanDays,
    },
    totals: {
      messages: stats.total,
      people: stats.peopleCount,
      perDay: stats.perDay,
      emojis: stats.totalEmojis,
      laughs: stats.totalLaughs,
      media: stats.totalMedia,
      peakHour: stats.peakHour,
    },
    topWords: stats.topWords.slice(0, 10),
    topEmojis: stats.topEmojis.slice(0, 6),
    people: stats.people.slice(0, 12).map((p) => ({
      name: p.name,
      messages: p.messages,
      sharePct: Math.round(p.share * 100),
      avgLength: p.avgLength,
      questions: p.questions,
      laughs: p.laughs,
      media: p.media,
      nightMessages: p.nightMessages,
      planMessages: p.planMessages,
      doubleTexts: p.doubleTexts,
      medianReplyMin: p.medianReplyMin,
      topEmojis: p.topEmojis.map((e) => e.emoji),
      topWords: p.topWords.map((w) => w.word),
    })),
    // The specific moments the deck will quote, so the copy can react to the
    // same messages the reader is looking at instead of talking past them.
    moments: moments
      ? {
          funniest: moments.funniest && {
            text: moments.funniest.text,
            from: moments.funniest.author,
            laughers: moments.funniest.laughers,
          },
          weirdest: moments.weirdest && {
            text: moments.weirdest.text,
            from: moments.weirdest.author,
          },
          biggest: moments.biggest && {
            text: moments.biggest.text,
            from: moments.biggest.author,
            replies: moments.biggest.replies,
          },
          plans: moments.plans && {
            proposed: moments.plans.proposed,
            ignored: moments.plans.ignored,
            ignoredRate: moments.plans.ignoredRate,
            topProposer: moments.plans.topProposer,
            deadest: moments.plans.deadest?.text,
          },
          tags: moments.tags,
        }
      : undefined,
    sample,
  };
}

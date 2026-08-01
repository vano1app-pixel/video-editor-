// WhatsApp / Discord chat export parsing. Runs entirely in the browser —
// the raw chat text never leaves the device.

// Invisible junk WhatsApp sprinkles through exports (LTR marks, narrow nbsp).
const INVISIBLE = /[‎‏‪-‮⁦-⁩]/g;
const NARROW_NBSP = / | /g;

// [01/08/2026, 21:57:03] Author: text   (iOS)
const IOS_LINE =
  /^\[(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*([AaPp]\.?[Mm]\.?)?\]\s*([^:]{1,80}?):\s?([\s\S]*)$/;

// 01/08/2026, 21:57 - Author: text     (Android)
const ANDROID_LINE =
  /^(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*([AaPp]\.?[Mm]\.?)?\s*[-–]\s*([^:]{1,80}?):\s?([\s\S]*)$/;

// Same shapes but with no "Author:" — these are system notices
// ("Messages are end-to-end encrypted", "X joined using this group's invite link").
const IOS_SYSTEM =
  /^\[(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*([AaPp]\.?[Mm]\.?)?\]\s*([\s\S]*)$/;
const ANDROID_SYSTEM =
  /^(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*([AaPp]\.?[Mm]\.?)?\s*[-–]\s*([\s\S]*)$/;

const MEDIA_MARKERS = [
  'image omitted',
  'video omitted',
  'sticker omitted',
  'audio omitted',
  'gif omitted',
  'document omitted',
  'media omitted',
  'contact card omitted',
  '<media omitted>',
  '<attached:',
];

const DELETED_MARKERS = [
  'this message was deleted',
  'you deleted this message',
  'message deleted',
];

function ordinal(parts, monthFirst) {
  const [a, b, c] = parts;
  if (a > 31) return a * 10000 + b * 100 + c; // already year-first
  let year = c;
  if (year < 100) year += year < 70 ? 2000 : 1900;
  const month = monthFirst ? a : b;
  const day = monthFirst ? b : a;
  return year * 10000 + month * 100 + day;
}

/** Count places where a reading of the dates goes backwards in time. */
function regressions(dateParts, monthFirst) {
  let bad = 0;
  let prev = -Infinity;
  for (const parts of dateParts) {
    const v = ordinal(parts, monthFirst);
    if (v < prev) bad++;
    prev = v;
  }
  return bad;
}

/**
 * Decide whether a run of dates is D/M/Y or M/D/Y. A component above 12 is
 * unambiguously a day. Failing that, exports are chronological, so the correct
 * reading is whichever one doesn't travel backwards through time. If both are
 * clean (a chat inside one ambiguous month) we fall back to `preferMonthFirst`,
 * which the caller derives from the user's locale.
 */
function detectMonthFirst(rawDates, preferMonthFirst = false) {
  const parts = [];
  for (const d of rawDates) {
    const p = d.split(/[./-]/).map(Number);
    if (p.length < 3 || p.some(Number.isNaN)) continue;
    if (p[0] > 12 && p[0] <= 31) return false; // first slot is a day → day-first
    if (p[1] > 12) return true; // second slot is a day → month-first
    parts.push(p);
  }
  if (parts.length < 3) return preferMonthFirst;

  const dayFirstBad = regressions(parts, false);
  const monthFirstBad = regressions(parts, true);
  if (dayFirstBad !== monthFirstBad) return monthFirstBad < dayFirstBad;
  return preferMonthFirst;
}

function buildDate(rawDate, rawTime, meridiem, monthFirst) {
  const dp = rawDate.split(/[./-]/).map((n) => parseInt(n, 10));
  if (dp.length < 3 || dp.some(Number.isNaN)) return null;

  let year, month, day;
  if (dp[0] > 31) {
    // ISO-ish: 2026-08-01
    [year, month, day] = dp;
  } else if (monthFirst) {
    [month, day, year] = dp;
  } else {
    [day, month, year] = dp;
  }
  if (year < 100) year += year < 70 ? 2000 : 1900;

  const tp = rawTime.split(':').map((n) => parseInt(n, 10));
  let hour = tp[0] || 0;
  const minute = tp[1] || 0;
  const second = tp[2] || 0;

  if (meridiem) {
    const isPm = /p/i.test(meridiem);
    if (isPm && hour < 12) hour += 12;
    if (!isPm && hour === 12) hour = 0;
  }

  const dt = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function classify(text) {
  const lower = text.toLowerCase().trim();
  const isMedia = MEDIA_MARKERS.some((m) => lower.includes(m));
  const isDeleted = DELETED_MARKERS.some((m) => lower.includes(m));
  return { isMedia, isDeleted };
}

/**
 * Parse a WhatsApp .txt export into messages.
 * Returns { messages, authors, systemCount, format }.
 */
export function parseWhatsApp(raw, { preferMonthFirst = false } = {}) {
  const text = raw.replace(INVISIBLE, '').replace(NARROW_NBSP, ' ');
  const lines = text.split(/\r?\n/);

  // First pass: collect raw date strings so we can settle D/M vs M/D once.
  const rawDates = [];
  for (const line of lines) {
    const m = IOS_LINE.exec(line) || ANDROID_LINE.exec(line);
    if (m) rawDates.push(m[1]);
    if (rawDates.length > 2000) break;
  }
  const monthFirst = detectMonthFirst(rawDates, preferMonthFirst);

  const messages = [];
  let systemCount = 0;
  let format = null;
  let current = null;

  const push = () => {
    if (!current) return;
    current.text = current.text.trim();
    const { isMedia, isDeleted } = classify(current.text);
    current.isMedia = isMedia;
    current.isDeleted = isDeleted;
    messages.push(current);
    current = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      if (current) current.text += '\n';
      continue;
    }

    const ios = IOS_LINE.exec(line);
    const android = ios ? null : ANDROID_LINE.exec(line);
    const m = ios || android;

    if (m) {
      push();
      format = format || (ios ? 'ios' : 'android');
      const ts = buildDate(m[1], m[2], m[3], monthFirst);
      if (!ts) continue;
      current = { ts, author: m[4].trim(), text: m[5] || '' };
      continue;
    }

    // A dated line with no author is a system notice — count it, don't keep it.
    if (IOS_SYSTEM.test(line) || ANDROID_SYSTEM.test(line)) {
      push();
      systemCount++;
      continue;
    }

    // Continuation of a multi-line message.
    if (current) current.text += '\n' + line;
  }
  push();

  const authors = [...new Set(messages.map((m) => m.author))];
  return { messages, authors, systemCount, format: format || 'unknown' };
}

/** Discord "Export Kit" style CSV/JSON is a stretch goal; JSON is easy to add. */
export function parseDiscordJson(raw) {
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : data.messages || [];
  const messages = list
    .map((m) => ({
      ts: new Date(m.timestamp || m.date),
      author: (m.author && (m.author.nickname || m.author.name)) || m.author || 'Unknown',
      text: m.content || '',
      isMedia: Boolean(m.attachments && m.attachments.length),
      isDeleted: false,
    }))
    .filter((m) => !Number.isNaN(m.ts.getTime()));
  const authors = [...new Set(messages.map((m) => m.author))];
  return { messages, authors, systemCount: 0, format: 'discord' };
}

export function parseChat(raw, filename = '', opts = {}) {
  const trimmed = raw.trimStart();
  // A WhatsApp iOS export also starts with "[", so only treat it as JSON when
  // it actually parses as JSON.
  if (filename.endsWith('.json') || trimmed.startsWith('{')) {
    try {
      return parseDiscordJson(raw);
    } catch {
      /* fall through to WhatsApp */
    }
  }
  return parseWhatsApp(raw, opts);
}

/** Restrict messages to a trailing window: 7 / 30 / 365 days, or 0 for everything. */
export function windowMessages(messages, days) {
  if (!days || !messages.length) return messages;
  const end = messages[messages.length - 1].ts.getTime();
  const cutoff = end - days * 24 * 60 * 60 * 1000;
  return messages.filter((m) => m.ts.getTime() >= cutoff);
}

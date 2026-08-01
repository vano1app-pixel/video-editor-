import type {
  CaptionStyle,
  Clip,
  Transcript,
  TranscriptSegment,
  Word,
} from "@/lib/types";

/**
 * ASS subtitle generator.
 *
 * The renderer burns the result in with ffmpeg's `ass` filter (libass). This
 * module owns the mapping from the SOURCE timeline (where the transcript
 * lives) to the OUTPUT timeline (the concatenation of kept clips, each
 * possibly sped up), and the serialisation of caption events into a complete
 * .ass document.
 */

// ---------------------------------------------------------------------------
// Timeline mapping
// ---------------------------------------------------------------------------

export interface OutputTimelineEntry {
  sourceStart: number;
  sourceEnd: number;
  outStart: number;
  outEnd: number;
  speed: number;
}

const MIN_SPEED = 0.5;
const MAX_SPEED = 4;

function clampSpeed(speed: number | undefined): number {
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) {
    return 1;
  }
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

function finiteOrZero(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute the cumulative output start/end of every clip. One entry per clip,
 * in render order. A clip's output duration is its source duration divided by
 * its (clamped) speed factor; degenerate clips contribute zero duration but
 * keep their slot so indexes line up with the input array.
 */
export function buildOutputTimeline(clips: Clip[]): OutputTimelineEntry[] {
  const entries: OutputTimelineEntry[] = [];
  let cursor = 0;

  for (const clip of clips) {
    const sourceStart = finiteOrZero(clip.sourceStart);
    const sourceEnd = finiteOrZero(clip.sourceEnd);
    const speed = clampSpeed(clip.speedFactor);
    const sourceDuration = Math.max(0, sourceEnd - sourceStart);
    const outStart = cursor;
    const outEnd = outStart + sourceDuration / speed;

    entries.push({ sourceStart, sourceEnd, outStart, outEnd, speed });
    cursor = outEnd;
  }

  return entries;
}

/**
 * Map a second on the SOURCE timeline into the OUTPUT timeline.
 * Returns null when the time falls inside a removed span (no clip keeps it).
 * Per-clip speed is honoured: outTime = outStart + (srcTime - sourceStart) / speed.
 */
export function mapSourceToOutputTime(
  clips: Clip[],
  sourceTime: number,
): number | null {
  if (!Number.isFinite(sourceTime)) return null;
  const timeline = buildOutputTimeline(clips);

  for (const entry of timeline) {
    if (entry.sourceEnd <= entry.sourceStart) continue; // zero-length clip
    if (sourceTime >= entry.sourceStart && sourceTime <= entry.sourceEnd) {
      return entry.outStart + (sourceTime - entry.sourceStart) / entry.speed;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Word collection
// ---------------------------------------------------------------------------

interface MappedWord {
  text: string;
  outStart: number;
  outEnd: number;
  /** Index of the clip this word landed in — lines never cross clips. */
  clipIndex: number;
}

function isUsableWord(w: Word): boolean {
  return (
    typeof w.text === "string" &&
    w.text.trim().length > 0 &&
    Number.isFinite(w.start) &&
    Number.isFinite(w.end) &&
    w.end >= w.start
  );
}

/** Evenly interpolate word timings across a segment that carries no words. */
function interpolateSegmentWords(segment: TranscriptSegment): Word[] {
  const tokens = segment.text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  const start = finiteOrZero(segment.start);
  const end = Math.max(start, finiteOrZero(segment.end));
  const duration = end - start;
  const slice = duration / tokens.length;

  return tokens.map((text, i) => ({
    text,
    start: start + i * slice,
    end: start + (i + 1) * slice,
  }));
}

/**
 * Gather words in time order. Prefers the transcript's flattened word list;
 * falls back to per-segment words, interpolating evenly across any segment
 * whose word array is empty.
 */
function collectWords(transcript: Transcript): Word[] {
  const flattened = (transcript.words ?? []).filter(isUsableWord);
  if (flattened.length > 0) {
    return [...flattened].sort((a, b) => a.start - b.start);
  }

  const collected: Word[] = [];
  for (const segment of transcript.segments ?? []) {
    const segmentWords = (segment.words ?? []).filter(isUsableWord);
    if (segmentWords.length > 0) {
      collected.push(...segmentWords);
    } else {
      collected.push(...interpolateSegmentWords(segment));
    }
  }
  return collected.sort((a, b) => a.start - b.start);
}

/**
 * Map every word through the clip timeline. Words wholly inside removed spans
 * are dropped; words straddling a clip edge are clamped to the clip they
 * mostly belong to.
 */
function mapWords(words: Word[], timeline: OutputTimelineEntry[]): MappedWord[] {
  const mapped: MappedWord[] = [];

  for (const word of words) {
    const mid = (word.start + word.end) / 2;

    let clipIndex = -1;
    // Prefer the clip containing the word's midpoint …
    for (let i = 0; i < timeline.length; i++) {
      const e = timeline[i];
      if (e.sourceEnd <= e.sourceStart) continue;
      if (mid >= e.sourceStart && mid <= e.sourceEnd) {
        clipIndex = i;
        break;
      }
    }
    // … otherwise any clip the word overlaps at all.
    if (clipIndex < 0) {
      for (let i = 0; i < timeline.length; i++) {
        const e = timeline[i];
        if (e.sourceEnd <= e.sourceStart) continue;
        if (word.end > e.sourceStart && word.start < e.sourceEnd) {
          clipIndex = i;
          break;
        }
      }
    }
    if (clipIndex < 0) continue; // the word was cut

    const entry = timeline[clipIndex];
    const srcStart = Math.min(
      Math.max(word.start, entry.sourceStart),
      entry.sourceEnd,
    );
    const srcEnd = Math.min(
      Math.max(word.end, entry.sourceStart),
      entry.sourceEnd,
    );

    const outStart = entry.outStart + (srcStart - entry.sourceStart) / entry.speed;
    const outEnd = entry.outStart + (srcEnd - entry.sourceStart) / entry.speed;
    if (outEnd < outStart) continue;

    mapped.push({ text: word.text.trim(), outStart, outEnd, clipIndex });
  }

  mapped.sort((a, b) => a.outStart - b.outStart || a.clipIndex - b.clipIndex);
  return mapped;
}

// ---------------------------------------------------------------------------
// Line grouping
// ---------------------------------------------------------------------------

/** A pause this long inside one clip still forces a new caption line. */
const MAX_INTRA_LINE_GAP_SEC = 1.5;

function groupIntoLines(
  words: MappedWord[],
  maxWordsPerLine: number,
): MappedWord[][] {
  const lines: MappedWord[][] = [];
  let current: MappedWord[] = [];

  for (const word of words) {
    if (current.length > 0) {
      const last = current[current.length - 1];
      const crossesClip = word.clipIndex !== last.clipIndex;
      const full = current.length >= maxWordsPerLine;
      const longGap = word.outStart - last.outEnd > MAX_INTRA_LINE_GAP_SEC;
      if (crossesClip || full || longGap) {
        lines.push(current);
        current = [];
      }
    }
    current.push(word);
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

// ---------------------------------------------------------------------------
// ASS serialisation helpers
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** H:MM:SS.CC — centisecond precision, hours unpadded, never negative. */
function formatAssTime(seconds: number): string {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(totalCs / 360_000);
  const m = Math.floor((totalCs % 360_000) / 6_000);
  const s = Math.floor((totalCs % 6_000) / 100);
  const cs = totalCs % 100;
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

/**
 * Convert "#RRGGBB" to ASS "&HAABBGGRR" (alpha 00 = opaque).
 * Tolerates "#RGB" shorthand and missing "#"; falls back to white.
 */
function hexToAss(hex: string, alpha = "00"): string {
  let clean = (hex ?? "").trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    clean = clean
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    clean = "FFFFFF";
  }
  const rr = clean.slice(0, 2).toUpperCase();
  const gg = clean.slice(2, 4).toUpperCase();
  const bb = clean.slice(4, 6).toUpperCase();
  return `&H${alpha}${bb}${gg}${rr}`;
}

/**
 * Neutralise anything a transcript could use to break out of the event text:
 * newlines become spaces, braces become parens (no override-tag injection),
 * and backslashes become slashes (no \N / \h escapes).
 */
function escapeAssText(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\\/g, "/");
}

/** Commas delimit Style fields; strip them from the font name. */
function sanitizeFontName(font: string): string {
  const clean = (font ?? "").replace(/[,\r\n]/g, " ").trim();
  return clean.length > 0 ? clean : "Arial";
}

function alignmentFor(position: CaptionStyle["position"]): number {
  switch (position) {
    case "top":
      return 8;
    case "center":
      return 5;
    case "bottom":
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

const BLOCK_HANG_SEC = 0.15;
const MIN_EVENT_DURATION_SEC = 0.01;

interface CaptionEvent {
  start: number;
  end: number;
  /** End of the last word — the hang tail may be trimmed back to this. */
  contentEnd: number;
  words: MappedWord[];
}

/**
 * Trim/nudge so events never overlap: first give back any hang tail on the
 * earlier event, then push the later event's start forward if needed.
 */
function resolveOverlaps(events: CaptionEvent[]): CaptionEvent[] {
  const sorted = [...events].sort((a, b) => a.start - b.start);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.end <= cur.start) continue;

    // Shrink the previous event's hang first — never below its spoken content.
    prev.end = Math.max(Math.min(prev.end, cur.start), prev.contentEnd);
    // Whatever overlap remains, nudge the later start.
    if (prev.end > cur.start) {
      cur.start = prev.end;
    }
  }

  return sorted.filter((e) => e.end - e.start >= MIN_EVENT_DURATION_SEC);
}

function transformCase(text: string, uppercase: boolean): string {
  return uppercase ? text.toUpperCase() : text;
}

/** Plain line text for block/minimal presets. */
function blockText(event: CaptionEvent, uppercase: boolean): string {
  return event.words
    .map((w) => escapeAssText(transformCase(w.text, uppercase)))
    .join(" ");
}

/**
 * Karaoke line: one \k tag per word, duration in centiseconds from the word's
 * mapped output duration. Gaps between words (and any nudged start) become
 * empty \k delays so the highlight stays in sync with speech.
 */
function karaokeText(event: CaptionEvent, uppercase: boolean): string {
  const parts: string[] = [];
  let cursor = event.start;

  for (let i = 0; i < event.words.length; i++) {
    const word = event.words[i];

    const gap = word.outStart - cursor;
    if (gap >= 0.01) {
      parts.push(`{\\k${Math.round(gap * 100)}}`);
      cursor = word.outStart;
    }

    const effectiveStart = Math.max(word.outStart, cursor);
    const k = Math.max(0, Math.round((word.outEnd - effectiveStart) * 100));
    const text = escapeAssText(transformCase(word.text, uppercase));
    const trailingSpace = i < event.words.length - 1 ? " " : "";
    parts.push(`{\\k${k}}${text}${trailingSpace}`);

    cursor = Math.max(effectiveStart, word.outEnd);
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build a complete .ass document for the plan, or "" when captions are
 * disabled (or nothing survives the cut) so the renderer can skip the filter.
 */
export function buildAssSubtitles(opts: {
  transcript: Transcript;
  clips: Clip[];
  style: CaptionStyle;
  outputWidth: number;
  outputHeight: number;
}): string {
  const { transcript, clips, style, outputWidth, outputHeight } = opts;

  if (!style.enabled || style.preset === "none") return "";

  const width = Math.max(1, Math.round(finiteOrZero(outputWidth) || 1920));
  const height = Math.max(1, Math.round(finiteOrZero(outputHeight) || 1080));

  // --- effective style per preset -----------------------------------------
  const isMinimal = style.preset === "minimal";
  const isKaraoke = style.preset === "karaoke";

  const rawMaxWords =
    Number.isFinite(style.maxWordsPerLine) && style.maxWordsPerLine >= 1
      ? Math.floor(style.maxWordsPerLine)
      : 6;
  const maxWordsPerLine = isMinimal
    ? Math.min(4, rawMaxWords)
    : Math.min(16, rawMaxWords);

  const uppercase = isMinimal ? false : style.uppercase;

  const fontSizePct =
    Number.isFinite(style.fontSizePct) && style.fontSizePct > 0
      ? style.fontSizePct
      : 4.5;
  const fontScale = isMinimal ? 0.8 : 1;
  const fontSize = Math.max(1, Math.round((height * fontSizePct * fontScale) / 100));

  // Karaoke fills FROM SecondaryColour TO PrimaryColour: the highlight colour
  // must be Primary and the resting colour Secondary.
  const primaryColour = isKaraoke
    ? hexToAss(style.highlightColor)
    : hexToAss(style.primaryColor);
  const secondaryColour = isKaraoke
    ? hexToAss(style.primaryColor)
    : hexToAss(style.highlightColor);
  const outlineColour = hexToAss(style.outlineColor);
  const backColour = "&H00000000";

  const alignment = alignmentFor(style.position);
  const marginV = Math.round(height * 0.06);
  const marginH = Math.round(width * 0.04);
  const fontName = sanitizeFontName(style.fontFamily);

  // --- events ---------------------------------------------------------------
  const timeline = buildOutputTimeline(clips);
  const words = mapWords(collectWords(transcript), timeline);
  const lines = groupIntoLines(words, maxWordsPerLine);

  const rawEvents: CaptionEvent[] = [];
  for (const line of lines) {
    const first = line[0];
    const last = line[line.length - 1];
    const contentEnd = last.outEnd;
    const hang = isKaraoke ? 0 : BLOCK_HANG_SEC;
    const event: CaptionEvent = {
      start: first.outStart,
      end: contentEnd + hang,
      contentEnd,
      words: line,
    };
    if (event.end - event.start < MIN_EVENT_DURATION_SEC) continue;
    rawEvents.push(event);
  }

  const events = resolveOverlaps(rawEvents);
  if (events.length === 0) return "";

  const dialogueLines = events.map((event) => {
    const text = isKaraoke
      ? karaokeText(event, uppercase)
      : blockText(event, uppercase);
    const start = formatAssTime(event.start);
    const end = formatAssTime(event.end);
    return `Dialogue: 0,${start},${end},EditAi,,0,0,0,,${text}`;
  });

  // --- document ---------------------------------------------------------------
  const header = [
    "[Script Info]",
    "; Generated by EditAi",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: EditAi,${fontName},${fontSize},${primaryColour},${secondaryColour},${outlineColour},${backColour},1,0,0,0,100,100,0,0,1,2,0,${alignment},${marginH},${marginH},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  return [...header, ...dialogueLines].join("\n") + "\n";
}

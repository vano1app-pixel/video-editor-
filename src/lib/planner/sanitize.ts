/**
 * Turns the planner's raw JSON into an EditPlan the renderer can trust.
 *
 * The model is asked for a well-formed plan, but nothing downstream may assume
 * it got one. Everything here is defensive: parse permissively with zod, then
 * enforce every invariant in plain code. `sanitizePlan` never throws and always
 * returns a renderable plan — if the model produced no usable clips we
 * synthesize one from the analysis.
 */

import { z } from "zod";

import { RENDER_DEFAULTS } from "@/lib/config";
import { DEFAULT_FILLER_WORDS, LENGTH_PRESETS } from "@/lib/types";
import type {
  Analysis,
  AspectRatio,
  Brief,
  CaptionPreset,
  CaptionStyle,
  Clip,
  EditPlan,
  FillerRemovalSpec,
  LengthPreset,
  MediaInfo,
  MusicSpec,
  SilenceRange,
  SilenceRemovalSpec,
  TransitionSpec,
  TransitionType,
  ZoomEffect,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LENGTH_PRESET_KEYS: readonly LengthPreset[] = ["short", "medium", "long"];
const ASPECT_RATIOS: readonly AspectRatio[] = ["16:9", "9:16", "1:1", "4:5", "source"];
const CAPTION_PRESETS: readonly CaptionPreset[] = ["karaoke", "block", "minimal", "none"];
const CAPTION_POSITIONS: readonly CaptionStyle["position"][] = ["top", "center", "bottom"];
const TRANSITION_TYPES: readonly TransitionType[] = ["cut", "fade", "dissolve", "whip"];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Anything shorter than this is a frame-accurate accident, not an edit. */
const MIN_CLIP_SEC = 0.15;
/** Two clips this close together are the same clip. */
const MERGE_EPSILON = 1e-6;

const MAX_CLIPS = 60;
const MAX_ZOOMS = 20;
const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 600;
const MAX_REASON_CHARS = 200;

const DEFAULT_CAPTIONS: CaptionStyle = {
  enabled: true,
  preset: "karaoke",
  fontFamily: "Inter",
  fontSizePct: 5.5,
  primaryColor: "#FFFFFF",
  highlightColor: "#FFD400",
  outlineColor: "#000000",
  position: "bottom",
  maxWordsPerLine: 4,
  uppercase: false,
};

const DEFAULT_REMOVE_SILENCE: SilenceRemovalSpec = {
  enabled: true,
  thresholdDb: -34,
  minSilenceSec: 0.6,
  paddingSec: 0.12,
};

const DEFAULT_MUSIC: MusicSpec = {
  enabled: false,
  trackId: null,
  url: null,
  volumeDb: -18,
  duckDb: -10,
  fadeInSec: 1,
  fadeOutSec: 1.5,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fin(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Even, at least 16px — ffmpeg's h264 encoder rejects odd/tiny dimensions. */
function evenDim(n: number): number {
  return Math.max(16, 2 * Math.round(n / 2));
}

function trimmedOrUndefined(value: string | null, maxChars: number): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars).trimEnd() : trimmed;
}

function pickColor(value: string | null, fallback: string): string {
  if (value === null) return fallback;
  const trimmed = value.trim();
  return HEX_COLOR.test(trimmed) ? trimmed.toUpperCase() : fallback;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  if (value === null) return fallback;
  const trimmed = value.trim();
  return (allowed as readonly string[]).includes(trimmed) ? (trimmed as T) : fallback;
}

// ---------------------------------------------------------------------------
// Permissive zod shapes
//
// Every leaf carries `.catch()` so a wrong type, a null, or a missing key
// degrades to a sentinel instead of failing the parse. Real validation happens
// below, in code.
// ---------------------------------------------------------------------------

const rawNumber = z.number().finite().nullable().catch(null);
const rawString = z.string().nullable().catch(null);
const rawBool = z.boolean().nullable().catch(null);
const rawList = z.array(z.unknown()).catch([]);

const rawClipSchema = z.object({
  sourceStart: rawNumber,
  sourceEnd: rawNumber,
  reason: rawString,
  speedFactor: rawNumber,
});

const rawZoomSchema = z.object({
  start: rawNumber,
  end: rawNumber,
  fromScale: rawNumber,
  toScale: rawNumber,
  focusX: rawNumber,
  focusY: rawNumber,
});

const rawTransitionSchema = z.object({
  atClipIndex: rawNumber,
  type: rawString,
  durationSec: rawNumber,
});

const rawCaptionsSchema = z
  .object({
    enabled: rawBool,
    preset: rawString,
    fontFamily: rawString,
    fontSizePct: rawNumber,
    primaryColor: rawString,
    highlightColor: rawString,
    outlineColor: rawString,
    position: rawString,
    maxWordsPerLine: rawNumber,
    uppercase: rawBool,
  })
  .nullable()
  .catch(null);

const rawMusicSchema = z
  .object({
    enabled: rawBool,
    trackId: rawString,
    url: rawString,
    volumeDb: rawNumber,
    duckDb: rawNumber,
    fadeInSec: rawNumber,
    fadeOutSec: rawNumber,
  })
  .nullable()
  .catch(null);

const rawRemoveSilenceSchema = z
  .object({
    enabled: rawBool,
    thresholdDb: rawNumber,
    minSilenceSec: rawNumber,
    paddingSec: rawNumber,
  })
  .nullable()
  .catch(null);

const rawRemoveFillersSchema = z
  .object({
    enabled: rawBool,
    words: rawList,
  })
  .nullable()
  .catch(null);

const EMPTY_RAW_PLAN = {
  lengthPreset: null,
  targetDurationSec: null,
  aspectRatio: null,
  clips: [] as unknown[],
  captions: null,
  zooms: [] as unknown[],
  transitions: [] as unknown[],
  transitionStyle: null,
  music: null,
  removeSilence: null,
  removeFillers: null,
  title: null,
  summary: null,
};

const rawPlanSchema = z
  .object({
    lengthPreset: rawString,
    targetDurationSec: rawNumber,
    aspectRatio: rawString,
    clips: rawList,
    captions: rawCaptionsSchema,
    zooms: rawList,
    transitions: rawList,
    transitionStyle: rawString,
    music: rawMusicSchema,
    removeSilence: rawRemoveSilenceSchema,
    removeFillers: rawRemoveFillersSchema,
    title: rawString,
    summary: rawString,
  })
  .catch(EMPTY_RAW_PLAN);

// ---------------------------------------------------------------------------
// Resolution
//
// Deliberately duplicated from renderer.computeOutputSize instead of imported:
// the renderer imports the planner's types, and importing back would create a
// module cycle. Keep the two in sync.
// ---------------------------------------------------------------------------

function computeResolution(
  media: MediaInfo,
  aspect: AspectRatio,
  maxDimension: number,
): { width: number; height: number } {
  const maxDim = fin(maxDimension) && maxDimension >= 2 ? Math.floor(maxDimension) : 1080;

  const rotation = fin(media.rotation) ? ((Math.round(media.rotation) % 360) + 360) % 360 : 0;
  const swap = rotation === 90 || rotation === 270;
  const rawW = fin(media.width) && media.width > 0 ? media.width : 1920;
  const rawH = fin(media.height) && media.height > 0 ? media.height : 1080;
  const srcW = swap ? rawH : rawW;
  const srcH = swap ? rawW : rawH;

  let ratio: number;
  let longEdge: number;
  if (aspect === "source") {
    ratio = srcW / srcH;
    // Keep the source aspect; never upscale past the source's own long edge.
    longEdge = Math.min(maxDim, Math.max(2, Math.round(Math.max(srcW, srcH))));
  } else {
    const parts = aspect.split(":");
    const aw = Number(parts[0]);
    const ah = Number(parts[1]);
    ratio = fin(aw) && fin(ah) && aw > 0 && ah > 0 ? aw / ah : srcW / srcH;
    longEdge = maxDim;
  }
  if (!fin(ratio) || ratio <= 0) ratio = 16 / 9;

  let width: number;
  let height: number;
  if (ratio >= 1) {
    width = longEdge;
    height = longEdge / ratio;
  } else {
    height = longEdge;
    width = longEdge * ratio;
  }
  return { width: evenDim(width), height: evenDim(height) };
}

// ---------------------------------------------------------------------------
// Length / aspect
// ---------------------------------------------------------------------------

function inferPreset(target: number): LengthPreset {
  if (target <= LENGTH_PRESETS.short.maxSec) return "short";
  if (target <= LENGTH_PRESETS.medium.maxSec) return "medium";
  return "long";
}

function resolveLengthPreset(
  brief: Brief,
  modelPreset: string | null,
  modelTarget: number | null,
): LengthPreset {
  if (brief.lengthPreset !== null && LENGTH_PRESET_KEYS.includes(brief.lengthPreset)) {
    return brief.lengthPreset;
  }
  if (modelPreset !== null) {
    const trimmed = modelPreset.trim() as LengthPreset;
    if (LENGTH_PRESET_KEYS.includes(trimmed)) return trimmed;
  }
  const hinted =
    brief.targetDurationSec !== null && fin(brief.targetDurationSec)
      ? brief.targetDurationSec
      : modelTarget;
  if (hinted !== null && fin(hinted) && hinted > 0) return inferPreset(hinted);
  return "medium";
}

function resolveTargetDuration(
  brief: Brief,
  preset: LengthPreset,
  modelTarget: number | null,
  duration: number,
): number {
  const window = LENGTH_PRESETS[preset];
  let target = window.defaultSec;
  if (modelTarget !== null && modelTarget > 0) target = modelTarget;
  if (brief.targetDurationSec !== null && fin(brief.targetDurationSec) && brief.targetDurationSec > 0) {
    target = brief.targetDurationSec;
  }

  // "long" has no real upper bound, so the source itself is the ceiling.
  const maxSec =
    preset === "long" && duration > 0 ? Math.min(window.maxSec, duration) : window.maxSec;
  return clamp(target, window.minSec, maxSec);
}

function resolveAspectRatio(brief: Brief, modelAspect: string | null): AspectRatio {
  if (brief.aspectRatio !== null && ASPECT_RATIOS.includes(brief.aspectRatio)) {
    return brief.aspectRatio;
  }
  return oneOf(modelAspect, ASPECT_RATIOS, "source");
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

function sanitizeClips(entries: unknown[], durationLimit: number): Clip[] {
  const parsed: Clip[] = [];

  for (const entry of entries) {
    const result = rawClipSchema.safeParse(entry);
    if (!result.success) continue;
    const raw = result.data;
    if (raw.sourceStart === null || raw.sourceEnd === null) continue;

    const sourceStart = clamp(raw.sourceStart, 0, durationLimit);
    const sourceEnd = clamp(raw.sourceEnd, 0, durationLimit);
    // Drops inverted and hair-thin spans in one check.
    if (sourceEnd - sourceStart < MIN_CLIP_SEC) continue;

    const clip: Clip = { sourceStart, sourceEnd };
    const reason = trimmedOrUndefined(raw.reason, MAX_REASON_CHARS);
    if (reason !== undefined) clip.reason = reason;
    if (raw.speedFactor !== null) clip.speedFactor = clamp(raw.speedFactor, 0.5, 4);
    parsed.push(clip);
  }

  parsed.sort((a, b) => a.sourceStart - b.sourceStart);

  const merged: Clip[] = [];
  for (const clip of parsed) {
    const last = merged.length > 0 ? merged[merged.length - 1] : undefined;
    if (last !== undefined && clip.sourceStart <= last.sourceEnd + MERGE_EPSILON) {
      if (clip.sourceEnd > last.sourceEnd) last.sourceEnd = clip.sourceEnd;
      if (last.reason === undefined && clip.reason !== undefined) last.reason = clip.reason;
      if (last.speedFactor === undefined && clip.speedFactor !== undefined) {
        last.speedFactor = clip.speedFactor;
      }
      continue;
    }
    merged.push({ ...clip });
  }

  if (merged.length <= MAX_CLIPS) return merged;

  // Too many cuts: keep the meatiest ones, then restore chronological order.
  const longest = [...merged]
    .sort((a, b) => b.sourceEnd - b.sourceStart - (a.sourceEnd - a.sourceStart))
    .slice(0, MAX_CLIPS);
  longest.sort((a, b) => a.sourceStart - b.sourceStart);
  return longest;
}

/**
 * Last resort when the model gave us nothing usable: take the longest stretch
 * of the source that is not silence, capped at the target duration.
 */
function synthesizeClip(
  silences: SilenceRange[],
  duration: number,
  targetDurationSec: number,
): Clip {
  const span = duration > 0 ? duration : Math.max(targetDurationSec, MIN_CLIP_SEC);
  const cap = Math.max(MIN_CLIP_SEC, Math.min(targetDurationSec, span));

  const usable = silences
    .filter((s) => fin(s.start) && fin(s.end))
    .map((s) => ({ start: clamp(s.start, 0, span), end: clamp(s.end, 0, span) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  if (usable.length === 0) {
    return { sourceStart: 0, sourceEnd: cap, reason: "Fallback: opening of the source." };
  }

  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const silence of usable) {
    if (silence.start > cursor) gaps.push({ start: cursor, end: silence.start });
    cursor = Math.max(cursor, silence.end);
  }
  if (span > cursor) gaps.push({ start: cursor, end: span });

  let best: { start: number; end: number } | null = null;
  for (const gap of gaps) {
    if (best === null || gap.end - gap.start > best.end - best.start) best = gap;
  }
  if (best === null || best.end - best.start < MIN_CLIP_SEC) {
    return { sourceStart: 0, sourceEnd: cap, reason: "Fallback: opening of the source." };
  }

  return {
    sourceStart: best.start,
    sourceEnd: Math.min(best.end, best.start + cap),
    reason: "Fallback: longest continuous stretch of speech.",
  };
}

// ---------------------------------------------------------------------------
// Captions / zooms / transitions / audio
// ---------------------------------------------------------------------------

type RawCaptions = z.infer<typeof rawCaptionsSchema>;

function sanitizeCaptions(raw: RawCaptions, hasTranscript: boolean): CaptionStyle {
  const style: CaptionStyle = { ...DEFAULT_CAPTIONS };

  if (raw !== null) {
    if (raw.enabled !== null) style.enabled = raw.enabled;
    style.preset = oneOf(raw.preset, CAPTION_PRESETS, DEFAULT_CAPTIONS.preset);
    style.position = oneOf(raw.position, CAPTION_POSITIONS, DEFAULT_CAPTIONS.position);

    const family = trimmedOrUndefined(raw.fontFamily, 64);
    if (family !== undefined) style.fontFamily = family;

    if (raw.fontSizePct !== null) style.fontSizePct = clamp(raw.fontSizePct, 2, 15);
    if (raw.maxWordsPerLine !== null) {
      style.maxWordsPerLine = Math.round(clamp(raw.maxWordsPerLine, 1, 12));
    }
    if (raw.uppercase !== null) style.uppercase = raw.uppercase;

    style.primaryColor = pickColor(raw.primaryColor, DEFAULT_CAPTIONS.primaryColor);
    style.highlightColor = pickColor(raw.highlightColor, DEFAULT_CAPTIONS.highlightColor);
    style.outlineColor = pickColor(raw.outlineColor, DEFAULT_CAPTIONS.outlineColor);
  }

  // Nothing to caption without a transcript.
  if (!hasTranscript) {
    style.enabled = false;
    style.preset = "none";
  } else if (style.preset === "none") {
    style.enabled = false;
  }

  return style;
}

function sanitizeZooms(entries: unknown[]): ZoomEffect[] {
  const zooms: ZoomEffect[] = [];
  for (const entry of entries) {
    if (zooms.length >= MAX_ZOOMS) break;
    const result = rawZoomSchema.safeParse(entry);
    if (!result.success) continue;
    const raw = result.data;
    if (raw.start === null || raw.end === null) continue;

    const start = Math.max(0, raw.start);
    const end = raw.end;
    if (end <= start) continue;

    zooms.push({
      start,
      end,
      fromScale: raw.fromScale === null ? 1 : clamp(raw.fromScale, 1, 3),
      toScale: raw.toScale === null ? 1 : clamp(raw.toScale, 1, 3),
      focusX: raw.focusX === null ? 0.5 : clamp(raw.focusX, 0, 1),
      focusY: raw.focusY === null ? 0.5 : clamp(raw.focusY, 0, 1),
    });
  }
  return zooms;
}

function sanitizeTransitions(entries: unknown[], clipCount: number): TransitionSpec[] {
  const transitions: TransitionSpec[] = [];
  const seen = new Set<number>();

  for (const entry of entries) {
    if (transitions.length >= clipCount) break;
    const result = rawTransitionSchema.safeParse(entry);
    if (!result.success) continue;
    const raw = result.data;
    if (raw.atClipIndex === null) continue;

    const index = Math.round(raw.atClipIndex);
    if (!Number.isInteger(index) || index < 1 || index >= clipCount) continue;
    if (seen.has(index)) continue;
    seen.add(index);

    transitions.push({
      atClipIndex: index,
      type: oneOf(raw.type, TRANSITION_TYPES, "cut"),
      durationSec: raw.durationSec === null ? 0.3 : clamp(raw.durationSec, 0.05, 1.5),
    });
  }

  transitions.sort((a, b) => a.atClipIndex - b.atClipIndex);
  return transitions;
}

/**
 * Expand the planner's single `transitionStyle` into one spec per join.
 *
 * The model picks one style for the whole edit rather than an object per cut:
 * a short clip that fades, then dissolves, then whips looks amateurish, and
 * the per-cut array was a large share of the structured-output grammar (which
 * the API rejects once it grows too big). "cut" means hard cuts — no specs.
 */
function transitionsFromStyle(
  style: string,
  clipCount: number,
): TransitionSpec[] {
  const type = oneOf(style, TRANSITION_TYPES, "cut");
  if (type === "cut" || clipCount < 2) return [];

  const specs: TransitionSpec[] = [];
  for (let index = 1; index < clipCount; index += 1) {
    specs.push({ atClipIndex: index, type, durationSec: 0.3 });
  }
  return specs;
}

function sanitizeMusic(raw: z.infer<typeof rawMusicSchema>, brief: Brief): MusicSpec {
  const music: MusicSpec = { ...DEFAULT_MUSIC };

  if (raw !== null) {
    if (raw.enabled !== null) music.enabled = raw.enabled;
    music.trackId = trimmedOrUndefined(raw.trackId, 128) ?? null;
    music.url = trimmedOrUndefined(raw.url, 2048) ?? null;
    if (raw.volumeDb !== null) music.volumeDb = clamp(raw.volumeDb, -40, 0);
    if (raw.duckDb !== null) music.duckDb = clamp(raw.duckDb, -30, 0);
    if (raw.fadeInSec !== null) music.fadeInSec = clamp(raw.fadeInSec, 0, 5);
    if (raw.fadeOutSec !== null) music.fadeOutSec = clamp(raw.fadeOutSec, 0, 5);
  }

  // No attached track means no music bed, whatever the model claimed.
  if (brief.musicSourceId === null) music.enabled = false;

  return music;
}

function sanitizeRemoveSilence(raw: z.infer<typeof rawRemoveSilenceSchema>): SilenceRemovalSpec {
  const spec: SilenceRemovalSpec = { ...DEFAULT_REMOVE_SILENCE };
  if (raw === null) return spec;

  if (raw.enabled !== null) spec.enabled = raw.enabled;
  if (raw.thresholdDb !== null) spec.thresholdDb = clamp(raw.thresholdDb, -60, -10);
  if (raw.minSilenceSec !== null) spec.minSilenceSec = clamp(raw.minSilenceSec, 0.1, 5);
  if (raw.paddingSec !== null) spec.paddingSec = clamp(raw.paddingSec, 0, 1);
  return spec;
}

function sanitizeRemoveFillers(raw: z.infer<typeof rawRemoveFillersSchema>): FillerRemovalSpec {
  if (raw === null) return { enabled: true, words: [...DEFAULT_FILLER_WORDS] };

  const words: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.words) {
    if (typeof entry !== "string") continue;
    const word = entry.toLowerCase().replace(/\s+/g, " ").trim();
    if (word.length === 0 || seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }

  return {
    enabled: raw.enabled === null ? true : raw.enabled,
    words: words.length > 0 ? words : [...DEFAULT_FILLER_WORDS],
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Coerce whatever the planner emitted into a fully valid EditPlan.
 *
 * Never throws: unusable input degrades to defaults plus a synthesized clip,
 * so the caller can always decide whether the result is good enough to render.
 */
export function sanitizePlan(
  raw: unknown,
  args: { jobId: string; sourceId: string; brief: Brief; analysis: Analysis },
): EditPlan {
  const { jobId, sourceId, brief, analysis } = args;
  const parsed = rawPlanSchema.parse(raw);

  const media = analysis.media;
  const duration = fin(media.durationSec) && media.durationSec > 0 ? media.durationSec : 0;
  // With an unknown duration we cannot clamp meaningfully; trust the model.
  const durationLimit = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;

  const lengthPreset = resolveLengthPreset(brief, parsed.lengthPreset, parsed.targetDurationSec);
  const targetDurationSec = resolveTargetDuration(
    brief,
    lengthPreset,
    parsed.targetDurationSec,
    duration,
  );
  const aspectRatio = resolveAspectRatio(brief, parsed.aspectRatio);
  const resolution = computeResolution(media, aspectRatio, RENDER_DEFAULTS.maxDimension);

  let clips = sanitizeClips(parsed.clips, durationLimit);
  if (clips.length === 0) {
    clips = [synthesizeClip(analysis.silences, duration, targetDurationSec)];
  }

  const plan: EditPlan = {
    version: 1,
    jobId,
    sourceId,
    lengthPreset,
    targetDurationSec,
    aspectRatio,
    resolution,
    clips,
    captions: sanitizeCaptions(parsed.captions, analysis.transcript !== null),
    zooms: sanitizeZooms(parsed.zooms),
    // `transitionStyle` is what the current schema asks for; the per-cut array
    // is still honoured so a hand-written or older plan keeps working.
    transitions:
      parsed.transitionStyle !== null
        ? transitionsFromStyle(parsed.transitionStyle, clips.length)
        : sanitizeTransitions(parsed.transitions, clips.length),
    music: sanitizeMusic(parsed.music, brief),
    removeSilence: sanitizeRemoveSilence(parsed.removeSilence),
    removeFillers: sanitizeRemoveFillers(parsed.removeFillers),
  };

  const title = trimmedOrUndefined(parsed.title, MAX_TITLE_CHARS);
  if (title !== undefined) plan.title = title;
  const summary = trimmedOrUndefined(parsed.summary, MAX_SUMMARY_CHARS);
  if (summary !== undefined) plan.summary = summary;

  return plan;
}

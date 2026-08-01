/**
 * Render engine: EditPlan -> final MP4.
 *
 * Staged pipeline:
 *   Stage 0 — refineClips: clamp/merge plan clips, subtract silences + fillers.
 *   Stage 1 — encode each refined clip to a uniform intermediate (same codec,
 *             size, fps, audio layout) so joining is safe.
 *   Stage 2 — join: concat demuxer for hard cuts, or one xfade/acrossfade
 *             filter_complex when the plan asks for transitions.
 *   Stage 3 — finish: burn captions and/or mix the music bed, faststart.
 *
 * Fallback ladder: zoom fails -> retry clip without zoom; transitions fail ->
 * plain concat; ducking fails -> simple mix; captions fail -> no subtitles.
 * The job only fails when the plain cut+concat+encode path itself fails.
 *
 * Server-only module — never import from client code.
 */

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { RENDER_DEFAULTS } from "@/lib/config";
import {
  escapeFilterPath,
  parseProgressSeconds,
  runFfmpeg,
  runFfprobe,
} from "@/lib/ffmpeg/exec";
import { buildAssSubtitles, buildOutputTimeline } from "@/lib/render/captions";
import {
  DEFAULT_FILLER_WORDS,
  type AspectRatio,
  type Clip,
  type EditPlan,
  type MediaInfo,
  type MusicSpec,
  type SilenceRange,
  type Transcript,
  type TransitionSpec,
  type Word,
  type ZoomEffect,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface RenderInputs {
  plan: EditPlan;
  media: MediaInfo;
  transcript: Transcript | null;
  silences: SilenceRange[];
  workDir: string; // exists, exclusive to this job
  outputPath: string; // final mp4 destination
  musicPath?: string | null;
  onProgress?: (fraction: number, message: string) => void;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Plan clips shorter than this are dropped outright in stage 0. */
const MIN_CLIP_SEC = 0.15;
/** Cutting never leaves a fragment shorter than this. */
const MIN_FRAGMENT_SEC = 0.4;
/** Padding added around a filler word before cutting it. */
const FILLER_PAD_SEC = 0.04;
/** Filler cut spans shorter than this are ignored. */
const MIN_FILLER_SPAN_SEC = 0.12;
/** Words further apart than this never form one multi-word filler. */
const MAX_WORD_GAP_SEC = 0.75;
/** Uniform intermediate audio format. */
const AUDIO_RATE = 48000;
/** Speed clamps — must match the captions module's timeline math. */
const MIN_SPEED = 0.5;
const MAX_SPEED = 4;
/** Zoom scale clamps. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
/** Progress split: stage 1 gets 70%, join 15%, finish 15%. */
const P_STAGE1 = 0.7;
const P_JOIN_END = 0.85;
const P_FINISH_END = 0.99;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

interface Range {
  start: number;
  end: number;
}

function fin(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

/** Seconds for ffmpeg CLI args / filter options — fixed 3 decimals, never negative. */
function fmtSec(n: number): string {
  return Math.max(0, n).toFixed(3);
}

/** Plain number for filter expressions — no exponent notation. */
function fmtNum(n: number): string {
  const rounded = Math.round(n * 10_000) / 10_000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(4);
}

function evenDim(n: number): number {
  return Math.max(2, 2 * Math.round(n / 2));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stageError(context: string, err: unknown): Error {
  return new Error(
    `${context}: ${errMsg(err)}`,
    err instanceof Error ? { cause: err } : undefined,
  );
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Render cancelled");
}

async function safeUnlink(p: string | null | undefined): Promise<void> {
  if (!p) return;
  try {
    await fsp.unlink(p);
  } catch {
    // Best effort — cleanup must never fail a render.
  }
}

async function ensureNonEmpty(p: string, context: string): Promise<void> {
  const st = await fsp.stat(p).catch(() => null);
  if (!st || st.size <= 0) {
    throw new Error(`${context}: ffmpeg produced no output at ${p}`);
  }
}

/** rename, falling back to copy+unlink for cross-device destinations. */
async function moveFile(src: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(src, dest);
  } catch {
    await fsp.copyFile(src, dest);
    await safeUnlink(src);
  }
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges
    .filter((r) => fin(r.start) && fin(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 0.01) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// STAGE 0 — refineClips
// ---------------------------------------------------------------------------

/**
 * Subtract cut ranges from one kept span while never leaving a fragment
 * shorter than MIN_FRAGMENT_SEC: a too-small remainder is absorbed into the
 * cut; when both remainders would be too small the cut is skipped entirely.
 */
function subtractRanges(span: Range, cuts: Range[]): Range[] {
  let pieces: Range[] = [{ start: span.start, end: span.end }];
  for (const cut of cuts) {
    const next: Range[] = [];
    for (const p of pieces) {
      const cs = Math.max(cut.start, p.start);
      const ce = Math.min(cut.end, p.end);
      if (ce - cs <= 0.001) {
        next.push(p);
        continue;
      }
      const leftLen = cs - p.start;
      const rightLen = p.end - ce;
      const leftOk = leftLen >= MIN_FRAGMENT_SEC;
      const rightOk = rightLen >= MIN_FRAGMENT_SEC;
      if (leftOk && rightOk) {
        next.push({ start: p.start, end: cs }, { start: ce, end: p.end });
      } else if (leftOk) {
        // Right remainder too small — extend the cut to the end of the piece.
        next.push({ start: p.start, end: cs });
      } else if (rightOk) {
        // Left remainder too small — extend the cut back to the piece start.
        next.push({ start: ce, end: p.end });
      } else {
        // Cutting would destroy the piece: keep it whole instead.
        next.push(p);
      }
    }
    pieces = next;
  }
  return pieces;
}

function normalizeToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "")
    .trim();
}

function findFillerSpans(transcript: Transcript, fillerWords: string[]): Range[] {
  const list = fillerWords.length > 0 ? fillerWords : DEFAULT_FILLER_WORDS;
  const phrases = list
    .map((w) =>
      w
        .toLowerCase()
        .split(/\s+/)
        .map(normalizeToken)
        .filter((t) => t.length > 0),
    )
    .filter((tokens) => tokens.length > 0 && tokens.length <= 6)
    // Longer phrases first so "you know" wins over a lone "know"/"you".
    .sort((a, b) => b.length - a.length);
  if (phrases.length === 0) return [];

  const words: Word[] =
    transcript.words.length > 0
      ? transcript.words
      : transcript.segments.flatMap((s) => s.words);
  if (words.length === 0) return [];

  const spans: Range[] = [];
  let i = 0;
  while (i < words.length) {
    let advanced = false;
    for (const tokens of phrases) {
      const n = tokens.length;
      if (i + n > words.length) continue;
      let ok = true;
      for (let k = 0; k < n; k++) {
        const w = words[i + k];
        if (!w || normalizeToken(w.text) !== tokens[k]) {
          ok = false;
          break;
        }
        if (k > 0) {
          const prev = words[i + k - 1];
          if (!prev || !fin(prev.end) || !fin(w.start) || w.start - prev.end > MAX_WORD_GAP_SEC) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      const first = words[i];
      const last = words[i + n - 1];
      if (first && last && fin(first.start) && fin(last.end)) {
        const start = Math.max(0, first.start - FILLER_PAD_SEC);
        const end = last.end + FILLER_PAD_SEC;
        if (end - start >= MIN_FILLER_SPAN_SEC) spans.push({ start, end });
      }
      i += n;
      advanced = true;
      break;
    }
    if (!advanced) i++;
  }
  return mergeRanges(spans);
}

export function refineClips(
  plan: EditPlan,
  silences: SilenceRange[],
  transcript: Transcript | null,
  mediaDuration: number,
): Clip[] {
  const dur = fin(mediaDuration) && mediaDuration > 0 ? mediaDuration : 0;
  if (dur <= 0) return [];

  // 1. Clamp, drop invalid/tiny, sort, merge overlaps.
  const base: Clip[] = [];
  for (const c of plan.clips ?? []) {
    if (!c || !fin(c.sourceStart) || !fin(c.sourceEnd)) continue;
    const start = clamp(c.sourceStart, 0, dur);
    const end = clamp(c.sourceEnd, 0, dur);
    if (end - start < MIN_CLIP_SEC) continue;
    base.push({
      sourceStart: start,
      sourceEnd: end,
      reason: c.reason,
      speedFactor: c.speedFactor,
    });
  }
  base.sort((a, b) => a.sourceStart - b.sourceStart);

  const merged: Clip[] = [];
  for (const c of base) {
    const last = merged[merged.length - 1];
    if (last && c.sourceStart < last.sourceEnd - 1e-6) {
      last.sourceEnd = Math.max(last.sourceEnd, c.sourceEnd);
    } else {
      merged.push({ ...c });
    }
  }
  if (merged.length === 0) return [];

  // 2. Silence removal.
  let fragments: Clip[] = merged;
  if (plan.removeSilence?.enabled && silences.length > 0) {
    const minSilence = fin(plan.removeSilence.minSilenceSec)
      ? Math.max(0.1, plan.removeSilence.minSilenceSec)
      : 0.6;
    const pad = fin(plan.removeSilence.paddingSec)
      ? Math.max(0, plan.removeSilence.paddingSec)
      : 0.15;
    const out: Clip[] = [];
    for (const clip of fragments) {
      const cuts: Range[] = [];
      for (const s of silences) {
        if (!fin(s.start) || !fin(s.end)) continue;
        const fullyInside =
          s.start >= clip.sourceStart - 1e-3 && s.end <= clip.sourceEnd + 1e-3;
        if (!fullyInside || s.end - s.start <= minSilence) continue;
        const cutStart = s.start + pad;
        const cutEnd = s.end - pad;
        if (cutEnd - cutStart > 0.01) cuts.push({ start: cutStart, end: cutEnd });
      }
      const pieces = subtractRanges(
        { start: clip.sourceStart, end: clip.sourceEnd },
        mergeRanges(cuts),
      );
      for (const p of pieces) {
        out.push({
          sourceStart: p.start,
          sourceEnd: p.end,
          reason: clip.reason,
          speedFactor: clip.speedFactor,
        });
      }
    }
    fragments = out;
  }

  // 3. Filler removal.
  if (plan.removeFillers?.enabled && transcript) {
    const spans = findFillerSpans(transcript, plan.removeFillers.words ?? []);
    if (spans.length > 0) {
      const out: Clip[] = [];
      for (const clip of fragments) {
        const pieces = subtractRanges(
          { start: clip.sourceStart, end: clip.sourceEnd },
          spans,
        );
        for (const p of pieces) {
          out.push({
            sourceStart: p.start,
            sourceEnd: p.end,
            reason: clip.reason,
            speedFactor: clip.speedFactor,
          });
        }
      }
      fragments = out;
    }
  }

  const final = fragments.filter((c) => c.sourceEnd - c.sourceStart >= MIN_CLIP_SEC);
  // If cutting removed everything, fall back to the un-cut clips: a render
  // with silences kept beats no render at all.
  return final.length > 0 ? final : merged;
}

// ---------------------------------------------------------------------------
// Output geometry
// ---------------------------------------------------------------------------

export function computeOutputSize(
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
    // Keep the source AR; never upscale past the source's own long edge.
    longEdge = Math.min(maxDim, Math.max(2, Math.round(Math.max(srcW, srcH))));
  } else {
    const parts = aspect.split(":");
    const aw = Number(parts[0]);
    const ah = Number(parts[1]);
    ratio = fin(aw) && fin(ah) && aw > 0 && ah > 0 ? aw / ah : srcW / srcH;
    longEdge = maxDim;
  }

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
// STAGE 1 — per-clip intermediates
// ---------------------------------------------------------------------------

const VIDEO_ENC: readonly string[] = [
  "-c:v",
  "libx264",
  "-preset",
  RENDER_DEFAULTS.preset,
  "-crf",
  String(RENDER_DEFAULTS.crf),
  "-pix_fmt",
  "yuv420p",
];

const AUDIO_ENC: readonly string[] = [
  "-c:a",
  "aac",
  "-b:a",
  RENDER_DEFAULTS.audioBitrate,
  "-ar",
  String(AUDIO_RATE),
  "-ac",
  "2",
];

function clampSpeed(speed: number | undefined): number {
  if (!fin(speed) || speed <= 0) return 1;
  return clamp(speed, MIN_SPEED, MAX_SPEED);
}

/** atempo only accepts [0.5, 2] per instance — chain when faster than 2x. */
function atempoChain(speed: number): string[] {
  const parts: string[] = [];
  let rest = clamp(speed, MIN_SPEED, MAX_SPEED);
  while (rest > 2 + 1e-9) {
    parts.push("atempo=2");
    rest /= 2;
  }
  if (Math.abs(rest - 1) > 1e-6) parts.push(`atempo=${fmtNum(rest)}`);
  return parts;
}

function pickZoom(zooms: ZoomEffect[], outStart: number, outEnd: number): ZoomEffect | null {
  let best: ZoomEffect | null = null;
  let bestOverlap = 0.05; // require at least 50ms of overlap
  for (const z of zooms) {
    if (!z || !fin(z.start) || !fin(z.end) || z.end <= z.start) continue;
    const overlap = Math.min(z.end, outEnd) - Math.max(z.start, outStart);
    if (overlap > bestOverlap) {
      best = z;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * Build a zoompan filter for the part of `zoom` that overlaps this clip's
 * output window. Returns null when the maths would be degenerate.
 */
function buildZoomFilter(
  zoom: ZoomEffect,
  outStart: number,
  outEnd: number,
  fps: number,
  width: number,
  height: number,
): string | null {
  const dur = outEnd - outStart;
  if (!(dur > 0)) return null;
  const totalFrames = Math.round(dur * fps);
  if (totalFrames < 2) return null;

  const f0 = clamp(Math.round((Math.max(zoom.start, outStart) - outStart) * fps), 0, totalFrames);
  const f1 = clamp(Math.round((Math.min(zoom.end, outEnd) - outStart) * fps), 0, totalFrames);
  const span = f1 - f0;
  if (span < 2) return null;

  const from = fin(zoom.fromScale) ? clamp(zoom.fromScale, MIN_ZOOM, MAX_ZOOM) : 1;
  const to = fin(zoom.toScale) ? clamp(zoom.toScale, MIN_ZOOM, MAX_ZOOM) : 1;
  if (Math.abs(from - 1) < 0.005 && Math.abs(to - 1) < 0.005) return null;
  const fx = fin(zoom.focusX) ? clamp(zoom.focusX, 0, 1) : 0.5;
  const fy = fin(zoom.focusY) ? clamp(zoom.focusY, 0, 1) : 0.5;

  const zExpr = `clip(${fmtNum(from)}+(${fmtNum(to - from)})*clip((on-${f0})/${span},0,1),${MIN_ZOOM},${MAX_ZOOM})`;
  return (
    `zoompan=z='${zExpr}'` +
    `:x='(iw-iw/zoom)*${fmtNum(fx)}'` +
    `:y='(ih-ih/zoom)*${fmtNum(fy)}'` +
    `:d=1:s=${width}x${height}:fps=${fps}`
  );
}

interface SegmentArgsOpts {
  sourcePath: string;
  hasAudio: boolean;
  clip: Clip;
  speed: number;
  outDur: number;
  width: number;
  height: number;
  fps: number;
  zoomFilter: string | null;
  destPath: string;
}

function buildSegmentArgs(opts: SegmentArgsOpts): string[] {
  const { sourcePath, hasAudio, clip, speed, outDur, width, height, fps, zoomFilter, destPath } =
    opts;

  const vf: string[] = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
    `setpts=(PTS-STARTPTS)/${fmtNum(speed)}`,
    `fps=${fps}`,
  ];
  if (zoomFilter) vf.push(zoomFilter);
  vf.push("format=yuv420p");

  const af: string[] = [];
  if (hasAudio) {
    af.push("asetpts=PTS-STARTPTS", `aresample=${AUDIO_RATE}`);
    if (Math.abs(speed - 1) > 1e-4) af.push(...atempoChain(speed));
    af.push("aformat=sample_fmts=fltp:channel_layouts=stereo", "apad");
  } else {
    af.push("aformat=sample_fmts=fltp:channel_layouts=stereo");
  }

  const args: string[] = [
    "-ss",
    fmtSec(clip.sourceStart),
    "-to",
    fmtSec(clip.sourceEnd),
    "-i",
    sourcePath,
  ];
  if (!hasAudio) {
    args.push(
      "-f",
      "lavfi",
      "-t",
      fmtSec(outDur),
      "-i",
      `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_RATE}`,
    );
  }
  args.push(
    "-map",
    "0:v:0",
    "-map",
    hasAudio ? "0:a:0" : "1:a:0",
    "-vf",
    vf.join(","),
    "-af",
    af.join(","),
    "-t",
    fmtSec(outDur),
    ...VIDEO_ENC,
    ...AUDIO_ENC,
    "-movflags",
    "+faststart",
    destPath,
  );
  return args;
}

// ---------------------------------------------------------------------------
// STAGE 2 — join
// ---------------------------------------------------------------------------

/**
 * Map plan transitions (indexed against plan.clips) to boundaries between the
 * refined segments. Transition k lands on the boundary entering the first
 * refined fragment of plan clip k; unmappable transitions are dropped.
 */
function mapTransitionsToSegments(plan: EditPlan, refined: Clip[]): Map<number, TransitionSpec> {
  const map = new Map<number, TransitionSpec>();
  const planClips = plan.clips ?? [];
  const transitions = plan.transitions ?? [];
  if (refined.length < 2 || transitions.length === 0) return map;

  for (const t of transitions) {
    if (!t || t.type === "cut" || !fin(t.atClipIndex)) continue;
    const idx = Math.round(t.atClipIndex);
    if (idx < 1) continue;

    let segIdx = -1;
    const target = idx < planClips.length ? planClips[idx] : undefined;
    if (target && fin(target.sourceStart)) {
      segIdx = refined.findIndex((c) => c.sourceStart >= target.sourceStart - 1e-3);
    }
    if (segIdx < 0 && idx < refined.length) segIdx = idx;
    if (segIdx >= 1 && segIdx < refined.length && !map.has(segIdx)) {
      map.set(segIdx, t);
    }
  }
  return map;
}

interface XfadeGraph {
  filter: string;
  vOut: string;
  aOut: string;
  finalDuration: number;
}

/**
 * Build the chained xfade/acrossfade graph that joins the stage 1 segments.
 *
 * `segDurs` MUST be the measured durations of the encoded segments, not the
 * durations the plan asked for. Two properties of xfade drive everything here:
 *
 *  1. xfade emits exactly `offset + len(second input)`. It throws away whatever
 *     is left of the first input once the transition ends.
 *  2. If the transition reaches the real end of the first input, xfade stops
 *     there and silently drops the second input altogether — no error, just a
 *     truncated render.
 *
 * So every join overlaps by `visual + one frame`, keeping a frame of the
 * accumulated stream alive past the end of the blend, and the running total is
 * taken straight from property 1 rather than re-derived.
 */
function buildXfadeGraph(
  segDurs: number[],
  boundaries: Map<number, TransitionSpec>,
  fps: number,
): XfadeGraph {
  const n = segDurs.length;
  const frame = 1 / fps;
  const parts: string[] = [];
  let vPrev = "[0:v]";
  let aPrev = "[0:a]";
  let cum = segDurs[0] ?? 0;

  for (let i = 1; i < n; i++) {
    const dCur = segDurs[i] ?? 0;
    const spec = boundaries.get(i);

    // Cap at min(1.5s, 40% of the shorter side) and always leave the frame of
    // headroom that property 2 demands.
    const shorter = Math.min(cum, dCur);
    const maxVisual = Math.min(1.5, 0.4 * shorter, shorter - frame);
    if (!(maxVisual >= frame)) {
      // Clips this short cannot be crossfaded at all; the caller falls back to
      // a plain concat, which is always correct.
      throw new Error(
        `segment ${i} is too short (${fmtSec(dCur)}s) to crossfade at ${fps}fps`,
      );
    }

    let visual = frame; // a "cut" boundary becomes an imperceptible 1-frame blend
    let kind = "fade";
    if (spec && spec.type !== "cut") {
      const want = fin(spec.durationSec) && spec.durationSec > 0 ? spec.durationSec : 0.5;
      visual = clamp(want, frame, maxVisual);
      kind = spec.type === "whip" ? "wipeleft" : "fade";
    }

    const overlap = visual + frame;
    const offset = Math.max(0, cum - overlap);

    parts.push(
      `${vPrev}[${i}:v]xfade=transition=${kind}:duration=${fmtSec(visual)}:offset=${fmtSec(offset)}[vx${i}]`,
    );
    // The audio crossfade matches the OVERLAP, not the visual blend length —
    // acrossfade emits len1 + len2 - d, so d must equal the amount of the first
    // input xfade discarded or the two streams drift apart down the chain.
    parts.push(`${aPrev}[${i}:a]acrossfade=d=${fmtSec(overlap)}[ax${i}]`);
    vPrev = `[vx${i}]`;
    aPrev = `[ax${i}]`;
    cum = offset + dCur;
  }
  return { filter: parts.join(";"), vOut: vPrev, aOut: aPrev, finalDuration: cum };
}

/**
 * Measured duration of an encoded segment.
 *
 * Stage 1 quantises every segment to whole frames, so its real length is never
 * quite the float the plan asked for (2.139s at 30fps encodes to 64 frames =
 * 2.133s). Those few milliseconds are enough to push an xfade offset past the
 * end of the stream, so the join must be built from what is actually on disk.
 */
async function probeSegmentDuration(file: string, fallback: number): Promise<number> {
  const read = async (args: string[]): Promise<number | null> => {
    try {
      const { stdout } = await runFfprobe([
        "-v",
        "error",
        ...args,
        "-of",
        "default=nw=1:nokey=1",
        file,
      ]);
      const n = Number.parseFloat(stdout.trim().split(/\s+/)[0] ?? "");
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  };
  // Prefer the video stream: it is what xfade actually consumes.
  return (
    (await read(["-select_streams", "v:0", "-show_entries", "stream=duration"])) ??
    (await read(["-show_entries", "format=duration"])) ??
    fallback
  );
}

function concatListLine(p: string): string {
  return `file '${p.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// STAGE 3 — finish pass
// ---------------------------------------------------------------------------

interface FinishOpts {
  joinedPath: string;
  destPath: string;
  /** Burn these subtitles when non-null. */
  assPath: string | null;
  /** Mix this music file when non-null. */
  musicPath: string | null;
  musicMode: "duck" | "simple";
  music: MusicSpec;
  durationSec: number;
}

function buildFinishArgs(opts: FinishOpts): string[] {
  const { joinedPath, destPath, assPath, musicPath, musicMode, music, durationSec } = opts;
  const args: string[] = ["-i", joinedPath];
  const parts: string[] = [];
  let vMap = "0:v:0";
  let vEncode = false;
  let aMap = "0:a:0";
  let aEncode = false;

  if (musicPath) {
    args.push("-stream_loop", "-1", "-i", musicPath);
    const volumeDb = fin(music.volumeDb) ? clamp(music.volumeDb, -60, 12) : -18;
    const duckDb = fin(music.duckDb) ? clamp(music.duckDb, -60, 0) : -10;
    const fadeIn = fin(music.fadeInSec) ? clamp(music.fadeInSec, 0, durationSec / 2) : 0;
    const fadeOut = fin(music.fadeOutSec) ? clamp(music.fadeOutSec, 0, durationSec / 2) : 0;

    const musChain: string[] = [
      `atrim=0:${fmtSec(durationSec)}`,
      `aresample=${AUDIO_RATE}`,
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
      `volume=${fmtNum(musicMode === "simple" ? volumeDb + duckDb : volumeDb)}dB`,
    ];
    if (fadeIn > 0.01) musChain.push(`afade=t=in:st=0:d=${fmtSec(fadeIn)}`);
    if (fadeOut > 0.01) {
      musChain.push(
        `afade=t=out:st=${fmtSec(Math.max(0, durationSec - fadeOut))}:d=${fmtSec(fadeOut)}`,
      );
    }

    if (musicMode === "duck") {
      parts.push(
        "[0:a]aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[spmix][spsc]",
        `[1:a]${musChain.join(",")}[mus]`,
        "[mus][spsc]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=250[musduck]",
        "[spmix][musduck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]",
      );
    } else {
      parts.push(
        `[1:a]${musChain.join(",")}[mus]`,
        "[0:a][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]",
      );
    }
    aMap = "[aout]";
    aEncode = true;
  }

  if (assPath) {
    parts.push(`[0:v]ass='${escapeFilterPath(assPath)}'[vout]`);
    vMap = "[vout]";
    vEncode = true;
  }

  if (parts.length > 0) args.push("-filter_complex", parts.join(";"));
  args.push("-map", vMap, "-map", aMap);
  if (vEncode) args.push(...VIDEO_ENC);
  else args.push("-c:v", "copy");
  if (aEncode) args.push(...AUDIO_ENC);
  else args.push("-c:a", "copy");
  // Belt and braces: the looped music input must never extend the output.
  if (musicPath) args.push("-shortest");
  args.push("-movflags", "+faststart", destPath);
  return args;
}

// ---------------------------------------------------------------------------
// renderPlan — the whole pipeline
// ---------------------------------------------------------------------------

export async function renderPlan(inputs: RenderInputs): Promise<void> {
  const { plan, media, transcript, silences, workDir, outputPath, musicPath, onProgress, signal } =
    inputs;
  const fps = RENDER_DEFAULTS.fps;

  let lastFraction = 0;
  const report = (fraction: number, message: string): void => {
    lastFraction = Math.max(lastFraction, clamp01(fraction));
    try {
      onProgress?.(lastFraction, message);
    } catch {
      // A broken progress listener must never kill the render.
    }
  };

  if (!fin(media.durationSec) || media.durationSec <= 0) {
    throw new Error("renderPlan: media duration is unknown or zero");
  }
  await fsp.mkdir(workDir, { recursive: true });
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  report(0, "Preparing edit");
  assertNotAborted(signal);

  // ---- STAGE 0: refine clips ----------------------------------------------
  let clips = refineClips(plan, silences ?? [], transcript, media.durationSec);
  if (clips.length === 0) {
    clips = [{ sourceStart: 0, sourceEnd: media.durationSec }];
  }
  const { width, height } = computeOutputSize(media, plan.aspectRatio, RENDER_DEFAULTS.maxDimension);
  const timeline = buildOutputTimeline(clips);
  const totalOutDur = timeline.length > 0 ? timeline[timeline.length - 1]!.outEnd : 0;
  if (totalOutDur <= 0.05) {
    throw new Error("renderPlan: refined edit has no duration");
  }

  // ---- STAGE 1: per-clip intermediates -------------------------------------
  const segPaths: string[] = [];
  let doneOut = 0;
  for (let i = 0; i < clips.length; i++) {
    assertNotAborted(signal);
    const clip = clips[i]!;
    const entry = timeline[i]!;
    const speed = clampSpeed(entry.speed);
    const outDur = Math.max(0.02, entry.outEnd - entry.outStart);
    const segPath = path.join(workDir, `seg${String(i).padStart(3, "0")}.mp4`);
    const zoom = pickZoom(plan.zooms ?? [], entry.outStart, entry.outEnd);
    const zoomFilter = zoom
      ? buildZoomFilter(zoom, entry.outStart, entry.outEnd, fps, width, height)
      : null;

    const label = `Rendering clip ${i + 1}/${clips.length}`;
    report((P_STAGE1 * doneOut) / totalOutDur, label);
    const onStderr = (chunk: string): void => {
      const t = parseProgressSeconds(chunk);
      if (t !== null) {
        report((P_STAGE1 * (doneOut + Math.min(t, outDur))) / totalOutDur, label);
      }
    };

    const makeArgs = (withZoom: boolean): string[] =>
      buildSegmentArgs({
        sourcePath: media.path,
        hasAudio: media.hasAudio,
        clip,
        speed,
        outDur,
        width,
        height,
        fps,
        zoomFilter: withZoom ? zoomFilter : null,
        destPath: segPath,
      });

    try {
      await runFfmpeg(makeArgs(zoomFilter !== null), { signal, onStderr });
    } catch (err) {
      if (signal?.aborted || !zoomFilter) {
        throw stageError(`stage 1 clip ${i} failed`, err);
      }
      // Fallback: retry this clip without the zoom effect.
      console.error(
        `[renderer] zoom failed on clip ${i}, retrying without zoompan: ${errMsg(err)}`,
      );
      try {
        await runFfmpeg(makeArgs(false), { signal, onStderr });
      } catch (err2) {
        throw stageError(`stage 1 clip ${i} failed`, err2);
      }
    }
    await ensureNonEmpty(segPath, `stage 1 clip ${i}`);
    segPaths.push(segPath);
    doneOut += outDur;
  }

  // ---- STAGE 2: join --------------------------------------------------------
  assertNotAborted(signal);
  const plannedDurs = timeline.map((e) => Math.max(0.02, e.outEnd - e.outStart));
  const listPath = path.join(workDir, "list.txt");
  const concatDest = path.join(workDir, "joined_concat.mp4");
  const xfadeDest = path.join(workDir, "joined_xfade.mp4");

  const joinWithConcat = async (): Promise<void> => {
    const listBody = segPaths.map(concatListLine).join("\n") + "\n";
    await fsp.writeFile(listPath, listBody, "utf8");
    await runFfmpeg(
      ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", concatDest],
      { signal },
    );
  };

  let joinedPath: string;
  let joinedDur = totalOutDur;

  if (segPaths.length === 1) {
    joinedPath = segPaths[0]!;
  } else {
    const boundaries = mapTransitionsToSegments(plan, clips);
    const hasRealTransition = [...boundaries.values()].some((t) => t.type !== "cut");

    if (hasRealTransition) {
      try {
        // Measured, not planned: frame quantisation in stage 1 shifts every
        // segment by a few ms, and xfade offsets built on the planned numbers
        // overrun the real streams.
        const segDurs = await Promise.all(
          segPaths.map((p, i) => probeSegmentDuration(p, plannedDurs[i] ?? 0.02)),
        );
        const graph = buildXfadeGraph(segDurs, boundaries, fps);
        const args: string[] = [];
        for (const p of segPaths) args.push("-i", p);
        args.push(
          "-filter_complex",
          graph.filter,
          "-map",
          graph.vOut,
          "-map",
          graph.aOut,
          ...VIDEO_ENC,
          ...AUDIO_ENC,
          "-movflags",
          "+faststart",
          xfadeDest,
        );
        await runFfmpeg(args, {
          signal,
          onStderr: (chunk) => {
            const t = parseProgressSeconds(chunk);
            if (t !== null) {
              report(
                P_STAGE1 + (P_JOIN_END - P_STAGE1) * clamp01(t / Math.max(0.1, graph.finalDuration)),
                "Adding transitions",
              );
            }
          },
        });
        joinedPath = xfadeDest;
        joinedDur = graph.finalDuration;
      } catch (err) {
        if (signal?.aborted) throw stageError("stage 2 (transitions) failed", err);
        // Fallback: transitions must never fail the job — use hard cuts.
        console.error(`[renderer] transition join failed, falling back to cuts: ${errMsg(err)}`);
        await safeUnlink(xfadeDest);
        try {
          await joinWithConcat();
        } catch (err2) {
          throw stageError("stage 2 (concat) failed", err2);
        }
        joinedPath = concatDest;
        joinedDur = totalOutDur;
      }
    } else {
      try {
        await joinWithConcat();
      } catch (err) {
        throw stageError("stage 2 (concat) failed", err);
      }
      joinedPath = concatDest;
    }

    await ensureNonEmpty(joinedPath, "stage 2");
    // Success: the segments are no longer needed.
    for (const p of segPaths) await safeUnlink(p);
    await safeUnlink(listPath);
  }
  report(P_JOIN_END, "Clips joined");

  // ---- STAGE 3: finish pass -------------------------------------------------
  assertNotAborted(signal);

  let assPath: string | null = null;
  if (plan.captions?.enabled && plan.captions.preset !== "none" && transcript) {
    try {
      const ass = buildAssSubtitles({
        transcript,
        clips,
        style: plan.captions,
        outputWidth: width,
        outputHeight: height,
      });
      if (ass.trim().length > 0) {
        assPath = path.join(workDir, "subs.ass");
        await fsp.writeFile(assPath, ass, "utf8");
      }
    } catch (err) {
      console.error(`[renderer] caption build failed, continuing without captions: ${errMsg(err)}`);
      assPath = null;
    }
  }

  const musicFile: string | null =
    plan.music?.enabled && typeof musicPath === "string" && musicPath.length > 0 && fs.existsSync(musicPath)
      ? musicPath
      : null;

  if (!assPath && !musicFile) {
    try {
      await moveFile(joinedPath, outputPath);
    } catch (err) {
      throw stageError("stage 3 (deliver) failed", err);
    }
  } else {
    const finalTmp = path.join(workDir, "final.mp4");
    // Fallback ladder: captions+duck -> captions+simple -> no captions, etc.
    const combos: { ass: string | null; mus: "duck" | "simple" | null }[] = [];
    if (assPath && musicFile) {
      combos.push(
        { ass: assPath, mus: "duck" },
        { ass: assPath, mus: "simple" },
        { ass: null, mus: "duck" },
        { ass: null, mus: "simple" },
      );
    } else if (assPath) {
      combos.push({ ass: assPath, mus: null });
    } else {
      combos.push({ ass: null, mus: "duck" }, { ass: null, mus: "simple" });
    }

    let finished = false;
    for (const combo of combos) {
      assertNotAborted(signal);
      const args = buildFinishArgs({
        joinedPath,
        destPath: finalTmp,
        assPath: combo.ass,
        musicPath: combo.mus !== null ? musicFile : null,
        musicMode: combo.mus ?? "simple",
        music: plan.music,
        durationSec: joinedDur,
      });
      try {
        report(P_JOIN_END, "Finishing");
        await runFfmpeg(args, {
          signal,
          onStderr: (chunk) => {
            const t = parseProgressSeconds(chunk);
            if (t !== null) {
              report(
                P_JOIN_END + (P_FINISH_END - P_JOIN_END) * clamp01(t / Math.max(0.1, joinedDur)),
                "Finishing",
              );
            }
          },
        });
        await ensureNonEmpty(finalTmp, "stage 3");
        finished = true;
        break;
      } catch (err) {
        if (signal?.aborted) throw stageError("stage 3 (finish) failed", err);
        console.error(
          `[renderer] finish pass failed (captions=${combo.ass !== null}, music=${combo.mus ?? "none"}): ${errMsg(err)}`,
        );
        await safeUnlink(finalTmp);
      }
    }

    try {
      if (finished) {
        await moveFile(finalTmp, outputPath);
        await safeUnlink(joinedPath);
        await safeUnlink(assPath);
      } else {
        // Every finish variant failed — deliver the plain cut rather than fail.
        console.error("[renderer] all finish passes failed; delivering cut without captions/music");
        await moveFile(joinedPath, outputPath);
      }
    } catch (err) {
      throw stageError("stage 3 (deliver) failed", err);
    }
  }

  // ---- Validate -------------------------------------------------------------
  const st = await fsp.stat(outputPath).catch(() => null);
  if (!st || st.size <= 0) {
    throw new Error("renderPlan: output file is missing or empty after render");
  }
  report(1, "Render complete");
}

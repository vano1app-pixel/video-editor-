import fs from "node:fs/promises";
import path from "node:path";
import type { MediaInfo, Scene, SilenceRange } from "@/lib/types";
import {
  FfmpegError,
  parseProgressSeconds,
  runFfmpeg,
  runFfprobe,
} from "@/lib/ffmpeg/exec";

/**
 * Media analysis: probing, audio extraction, scene detection, and silence
 * detection. Everything here shells out to ffmpeg/ffprobe via exec.ts and
 * parses their output defensively — ffmpeg logs are noisy and vary between
 * builds, so all parsing is regex-per-line and tolerant of garbage.
 */

// ---------------------------------------------------------------------------
// ffprobe JSON shapes (only the fields we read; everything optional)
// ---------------------------------------------------------------------------

interface FfprobeSideData {
  side_data_type?: string;
  rotation?: number | string;
}

interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string | number;
  disposition?: Record<string, number>;
  side_data_list?: FfprobeSideData[];
  tags?: Record<string, string>;
}

interface FfprobeFormat {
  duration?: string | number;
  size?: string | number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse an ffprobe frame-rate fraction like "30000/1001" into a number
 * (29.97). Also accepts a plain number string ("30"). Returns 0 for
 * missing/degenerate input ("", "0/0", "N/A").
 */
export function fpsFromFraction(frac: string): number {
  const trimmed = frac.trim();
  if (!trimmed || trimmed === "N/A") return 0;

  const slash = trimmed.indexOf("/");
  let value: number;
  if (slash === -1) {
    value = Number.parseFloat(trimmed);
  } else {
    const num = Number.parseFloat(trimmed.slice(0, slash));
    const den = Number.parseFloat(trimmed.slice(slash + 1));
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
    value = num / den;
  }
  if (!Number.isFinite(value) || value <= 0) return 0;
  // 30000/1001 -> 29.97, 24000/1001 -> 23.976
  return Math.round(value * 1000) / 1000;
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Normalize any rotation value (e.g. -90, 450, "270") to 0/90/180/270. */
function normalizeRotation(raw: unknown): number {
  const n = toFiniteNumber(raw);
  if (n === null) return 0;
  // Snap to the nearest multiple of 90, then wrap into [0, 360).
  const snapped = Math.round(n / 90) * 90;
  return ((snapped % 360) + 360) % 360;
}

/** Parse "Duration: 00:01:23.45" style timestamps into seconds. */
function parseClockTime(h: string, m: string, s: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number.parseFloat(s);
}

/**
 * ffmpeg writes to stderr in chunks that split lines arbitrarily (and uses
 * \r for progress updates). This buffers chunks and emits whole lines, so
 * regex parsing never sees a line torn in half. Call flush() after the run
 * completes to emit any trailing partial line.
 */
function lineSplitter(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let carry = "";
  return {
    push(chunk: string): void {
      carry += chunk;
      const parts = carry.split(/\r\n|\r|\n/);
      carry = parts.pop() ?? "";
      for (const line of parts) {
        if (line.length > 0) onLine(line);
      }
    },
    flush(): void {
      if (carry.length > 0) onLine(carry);
      carry = "";
    },
  };
}

/** True when an ffmpeg failure means "this input has no usable audio". */
function isNoAudioFailure(err: unknown): boolean {
  if (!(err instanceof FfmpegError)) return false;
  const text = `${err.message}\n${err.stderr}`;
  return /does not contain any stream|matches no streams|Stream specifier .* matches no streams|no audio streams?/i.test(
    text,
  );
}

// ---------------------------------------------------------------------------
// probeMedia
// ---------------------------------------------------------------------------

export async function probeMedia(filePath: string): Promise<MediaInfo> {
  const { stdout } = await runFfprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new Error(
      `ffprobe returned unparseable JSON for ${filePath}: ${stdout.slice(0, 300)}`,
    );
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const format = parsed.format ?? {};

  // Pick the real video stream, skipping attached cover art (mjpeg/png
  // thumbnails embedded in audio files show up as video streams with the
  // attached_pic disposition).
  const videoStreams = streams.filter((s) => s.codec_type === "video");
  const videoStream =
    videoStreams.find((s) => (s.disposition?.attached_pic ?? 0) !== 1) ??
    videoStreams[0] ??
    null;
  const audioStream = streams.find((s) => s.codec_type === "audio") ?? null;

  // Duration: container first, then per-stream fallbacks.
  const durationSec =
    toFiniteNumber(format.duration) ??
    toFiniteNumber(videoStream?.duration) ??
    toFiniteNumber(audioStream?.duration) ??
    0;

  // Rotation lives either in the display-matrix side data or a legacy
  // tags.rotate entry, depending on the muxer.
  let rotation = 0;
  if (videoStream) {
    const sideData = Array.isArray(videoStream.side_data_list)
      ? videoStream.side_data_list
      : [];
    const withRotation = sideData.find((sd) => sd.rotation !== undefined);
    if (withRotation) {
      rotation = normalizeRotation(withRotation.rotation);
    } else if (videoStream.tags?.rotate !== undefined) {
      rotation = normalizeRotation(videoStream.tags.rotate);
    }
  }

  // ffprobe reports coded dimensions; ffmpeg auto-rotates on decode. Report
  // display orientation so downstream layout math never has to think about it
  // (rotation is still surfaced so the renderer knows a rotation applies).
  let width = videoStream?.width ?? 0;
  let height = videoStream?.height ?? 0;
  if (rotation === 90 || rotation === 270) {
    const w = width;
    width = height;
    height = w;
  }

  // Frame rate: r_frame_rate first, avg_frame_rate as fallback (r_frame_rate
  // can be a wild guess for VFR files, but it is the conventional source).
  let fps = 0;
  if (videoStream) {
    fps = fpsFromFraction(videoStream.r_frame_rate ?? "");
    if (fps <= 0) fps = fpsFromFraction(videoStream.avg_frame_rate ?? "");
  }

  let sizeBytes = toFiniteNumber(format.size) ?? 0;
  if (sizeBytes <= 0) {
    try {
      const stat = await fs.stat(filePath);
      sizeBytes = stat.size;
    } catch {
      sizeBytes = 0;
    }
  }

  return {
    path: filePath,
    durationSec: Math.max(0, durationSec),
    width: Math.max(0, Math.trunc(width)),
    height: Math.max(0, Math.trunc(height)),
    fps,
    hasAudio: audioStream !== null,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    sizeBytes,
    rotation,
  };
}

// ---------------------------------------------------------------------------
// extractAudio
// ---------------------------------------------------------------------------

/**
 * Extract mono 16 kHz PCM audio for transcription. Sources with no audio
 * stream get a silent wav of matching duration, so downstream (whisper etc.)
 * never has to special-case "no audio".
 */
export async function extractAudio(
  videoPath: string,
  outWavPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(outWavPath), { recursive: true });

  let hasAudio = true;
  let durationSec = 0;
  try {
    const info = await probeMedia(videoPath);
    hasAudio = info.hasAudio;
    durationSec = info.durationSec;
  } catch {
    // Probe failed — optimistically attempt extraction and fall back on the
    // ffmpeg error if the file really has no audio.
  }

  if (hasAudio) {
    try {
      await runFfmpeg([
        "-i",
        videoPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        outWavPath,
      ]);
      return;
    } catch (err) {
      if (!isNoAudioFailure(err)) throw err;
      // No usable audio after all — generate silence below.
    }
  }

  // anullsrc refuses -t 0; keep a floor so we always produce a valid wav.
  const silentDuration = Math.max(durationSec, 0.1);
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=16000:cl=mono",
    "-t",
    silentDuration.toFixed(3),
    "-c:a",
    "pcm_s16le",
    outWavPath,
  ]);
}

// ---------------------------------------------------------------------------
// detectScenes
// ---------------------------------------------------------------------------

const MAX_SCENES = 500;
/** Two cuts closer than this are the same cut. */
const CUT_DEDUPE_EPSILON = 0.02;

/**
 * Detect scene cuts with ffmpeg's `select=gt(scene,T)` scoring, downscaled to
 * 320px wide so long sources stay fast. Returns scenes spanning [0, duration].
 * Never throws for an empty/failed detection — falls back to one full-length
 * scene, because "no cuts found" is a valid answer for static footage.
 */
export async function detectScenes(
  videoPath: string,
  durationSec: number,
  opts?: { threshold?: number },
): Promise<Scene[]> {
  const duration = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  const fallback: Scene[] = [{ start: 0, end: duration, score: 0 }];
  if (duration <= 0) return fallback;

  const rawThreshold = opts?.threshold ?? 0.3;
  const threshold = Math.min(
    0.99,
    Math.max(0.01, Number.isFinite(rawThreshold) ? rawThreshold : 0.3),
  );

  // metadata=print logs `pts_time:` on one line and `lavfi.scene_score=` on
  // the next; pair them up as they stream past. Collecting via onStderr keeps
  // us immune to exec.ts capping retained stderr on chatty runs.
  const cuts: Array<{ time: number; score: number }> = [];
  let pendingPts: number | null = null;

  const splitter = lineSplitter((line) => {
    const pts = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    const ptsValue = pts?.[1];
    if (ptsValue !== undefined) {
      pendingPts = Number.parseFloat(ptsValue);
    }
    const score =
      /lavfi\.scene_score[=:]\s*(-?\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(line);
    const scoreValue = score?.[1];
    if (scoreValue !== undefined && pendingPts !== null) {
      const s = Number.parseFloat(scoreValue);
      if (Number.isFinite(pendingPts) && Number.isFinite(s)) {
        cuts.push({
          time: pendingPts,
          score: Math.min(1, Math.max(0, s)),
        });
      }
      pendingPts = null;
    }
  });

  try {
    await runFfmpeg(
      [
        "-i",
        videoPath,
        "-vf",
        `scale=320:-2,select='gt(scene,${threshold})',metadata=print`,
        "-an",
        "-f",
        "null",
        "-",
      ],
      { onStderr: splitter.push },
    );
    splitter.flush();
  } catch {
    // Scene detection is best-effort; a decode error must not sink the job.
    splitter.flush();
    if (cuts.length === 0) return fallback;
  }

  // Clean the cut list: in-bounds, sorted, deduped.
  const cleaned: Array<{ time: number; score: number }> = [];
  const sorted = cuts
    .filter((c) => c.time > CUT_DEDUPE_EPSILON && c.time < duration - 1e-3)
    .sort((a, b) => a.time - b.time);
  for (const cut of sorted) {
    const prev = cleaned[cleaned.length - 1];
    if (prev !== undefined && cut.time - prev.time < CUT_DEDUPE_EPSILON) {
      // Same cut reported twice — keep the stronger score.
      prev.score = Math.max(prev.score, cut.score);
    } else {
      cleaned.push({ time: cut.time, score: cut.score });
    }
  }

  if (cleaned.length === 0) return fallback;

  // Build contiguous scenes: the first opens at 0 with score 0, each cut
  // closes the previous scene and opens the next with the cut's score.
  const scenes: Scene[] = [];
  let cursor = 0;
  let openingScore = 0;
  for (const cut of cleaned) {
    scenes.push({ start: cursor, end: cut.time, score: openingScore });
    cursor = cut.time;
    openingScore = cut.score;
  }
  scenes.push({ start: cursor, end: duration, score: openingScore });

  // Cap at MAX_SCENES by repeatedly merging the shortest scene into a
  // neighbour, preserving full [0, duration] coverage.
  while (scenes.length > MAX_SCENES) {
    let smallest = 0;
    let smallestLen = Number.POSITIVE_INFINITY;
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      if (s === undefined) continue;
      const len = s.end - s.start;
      if (len < smallestLen) {
        smallestLen = len;
        smallest = i;
      }
    }
    const victim = scenes[smallest];
    if (victim === undefined) break;
    if (smallest === 0) {
      const next = scenes[1];
      if (next === undefined) break;
      next.start = victim.start;
      next.score = victim.score;
      scenes.splice(0, 1);
    } else {
      const prev = scenes[smallest - 1];
      if (prev === undefined) break;
      prev.end = victim.end;
      scenes.splice(smallest, 1);
    }
  }

  return scenes;
}

// ---------------------------------------------------------------------------
// detectSilences
// ---------------------------------------------------------------------------

/** Ranges closer than this merge into one. */
const SILENCE_MERGE_EPSILON = 1e-3;

/**
 * Find silent stretches with ffmpeg's silencedetect filter. Returns ranges
 * sorted by start, with overlaps merged. A trailing `silence_start` with no
 * matching end means the file goes quiet through EOF; the range is closed at
 * the best-known end-of-media timestamp. Inputs with no audio stream yield [].
 */
export async function detectSilences(
  mediaPath: string,
  opts?: { thresholdDb?: number; minSilenceSec?: number },
): Promise<SilenceRange[]> {
  const rawThreshold = opts?.thresholdDb;
  const thresholdDb =
    typeof rawThreshold === "number" && Number.isFinite(rawThreshold)
      ? rawThreshold
      : -34;
  const rawMin = opts?.minSilenceSec;
  const minSilenceSec =
    typeof rawMin === "number" && Number.isFinite(rawMin) && rawMin > 0
      ? rawMin
      : 0.35;

  const ranges: SilenceRange[] = [];
  let pendingStart: number | null = null;
  // Track the furthest timestamp ffmpeg mentions (Duration header + progress
  // lines) so a trailing silence can be closed at EOF.
  let eofSec = 0;

  const splitter = lineSplitter((line) => {
    const dur = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
    if (dur?.[1] !== undefined && dur[2] !== undefined && dur[3] !== undefined) {
      eofSec = Math.max(eofSec, parseClockTime(dur[1], dur[2], dur[3]));
    }
    const progress = parseProgressSeconds(line);
    if (progress !== null) eofSec = Math.max(eofSec, progress);

    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    const startValue = start?.[1];
    if (startValue !== undefined) {
      const t = Number.parseFloat(startValue);
      if (Number.isFinite(t)) pendingStart = Math.max(0, t);
      return;
    }

    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    const endValue = end?.[1];
    if (endValue !== undefined) {
      const endT = Number.parseFloat(endValue);
      if (!Number.isFinite(endT)) return;
      eofSec = Math.max(eofSec, endT);
      let startT = pendingStart;
      pendingStart = null;
      if (startT === null) {
        // Tolerate a missing start line: reconstruct from silence_duration
        // when present, otherwise assume silence from the beginning.
        const durMatch = /silence_duration:\s*(-?\d+(?:\.\d+)?)/.exec(line);
        const durValue = durMatch?.[1];
        const d =
          durValue !== undefined ? Number.parseFloat(durValue) : Number.NaN;
        startT = Number.isFinite(d) ? Math.max(0, endT - d) : 0;
      }
      if (endT > startT) ranges.push({ start: startT, end: endT });
    }
  });

  try {
    await runFfmpeg(
      [
        "-i",
        mediaPath,
        "-vn",
        "-af",
        `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSec}`,
        "-f",
        "null",
        "-",
      ],
      { onStderr: splitter.push },
    );
    splitter.flush();
  } catch (err) {
    splitter.flush();
    // No audio stream => nothing to measure. Anything else is a real failure
    // unless we already got usable detections before the crash.
    if (!isNoAudioFailure(err) && ranges.length === 0 && pendingStart === null) {
      throw err;
    }
  }

  // Close a trailing silence that ran to EOF. silencedetect only reports a
  // start after the silence has lasted `d` seconds, so the range is at least
  // that long even when no EOF timestamp was seen.
  if (pendingStart !== null) {
    const trailingStart: number = pendingStart;
    const end = Math.max(eofSec, trailingStart + minSilenceSec);
    if (end > trailingStart) ranges.push({ start: trailingStart, end });
  }

  // Sort and merge overlapping/touching ranges.
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SilenceRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r.start <= last.end + SILENCE_MERGE_EPSILON) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }

  return merged;
}

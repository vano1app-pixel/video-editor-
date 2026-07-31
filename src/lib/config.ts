import path from "node:path";
import fs from "node:fs";

/**
 * Central config. Everything that reads an env var or resolves a path on disk
 * does it here, so there is one place to look when a deploy misbehaves.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Root for all generated files. Mount a volume here in production. */
export const STORAGE_ROOT =
  process.env.STORAGE_ROOT ?? path.join(process.cwd(), "storage");

export const PATHS = {
  root: STORAGE_ROOT,
  uploads: path.join(STORAGE_ROOT, "uploads"),
  audio: path.join(STORAGE_ROOT, "audio"),
  work: path.join(STORAGE_ROOT, "work"),
  outputs: path.join(STORAGE_ROOT, "outputs"),
  jobs: path.join(STORAGE_ROOT, "jobs"),
} as const;

export function ensureStorageDirs(): void {
  for (const dir of Object.values(PATHS)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Max upload size in bytes. Default 2 GB. */
export const MAX_UPLOAD_BYTES = envInt("MAX_UPLOAD_MB", 2048) * 1024 * 1024;

export const ALLOWED_VIDEO_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".avi",
  ".mpg",
  ".mpeg",
  ".wmv",
  ".flv",
  ".3gp",
];

/** How many jobs may render at once. ffmpeg is CPU-bound; keep this small. */
export const MAX_CONCURRENT_JOBS = envInt("MAX_CONCURRENT_JOBS", 1);

/** Wall-clock ceiling for a single ffmpeg invocation. */
export const FFMPEG_TIMEOUT_MS = envInt("FFMPEG_TIMEOUT_MIN", 60) * 60 * 1000;

// --- AI -------------------------------------------------------------------

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

/**
 * Claude Opus 5 is the default. It plans the edit from the transcript, which is
 * the part of the pipeline where reasoning quality actually shows up in the cut.
 */
export const PLANNER_MODEL = process.env.PLANNER_MODEL ?? "claude-opus-5";

/** Effort for planner calls. `high` is the API default; `low` is cheaper. */
export const PLANNER_EFFORT = process.env.PLANNER_EFFORT ?? "high";

/**
 * Cap on transcript characters sent to the planner in one request. Beyond this
 * the transcript is summarised into a segment index instead of sent verbatim.
 */
export const MAX_TRANSCRIPT_CHARS = envInt("MAX_TRANSCRIPT_CHARS", 400_000);

// --- Transcription --------------------------------------------------------

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
export const OPENAI_TRANSCRIBE_MODEL =
  process.env.OPENAI_TRANSCRIBE_MODEL ?? "whisper-1";

/** Path to a whisper.cpp / faster-whisper compatible CLI, if self-hosting. */
export const LOCAL_WHISPER_BIN = process.env.LOCAL_WHISPER_BIN ?? "";
export const LOCAL_WHISPER_MODEL = process.env.LOCAL_WHISPER_MODEL ?? "";

/**
 * Preferred transcription backend: "auto" picks the first available of
 * openai -> local. Set explicitly to force one.
 */
export const TRANSCRIBE_PROVIDER = (process.env.TRANSCRIBE_PROVIDER ??
  "auto") as "auto" | "openai" | "local" | "none";

// --- Render defaults ------------------------------------------------------

export const RENDER_DEFAULTS = {
  /** Long edge of the output. 1080 keeps renders fast; 1920 for delivery. */
  maxDimension: envInt("RENDER_MAX_DIMENSION", 1080),
  fps: envInt("RENDER_FPS", 30),
  videoBitrate: process.env.RENDER_VIDEO_BITRATE ?? "6M",
  audioBitrate: process.env.RENDER_AUDIO_BITRATE ?? "192k",
  /** x264 preset. "veryfast" trades ~15% size for a big speed win. */
  preset: process.env.RENDER_PRESET ?? "veryfast",
  crf: envInt("RENDER_CRF", 20),
} as const;

/** Public base URL, used to build absolute links in responses. */
export const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

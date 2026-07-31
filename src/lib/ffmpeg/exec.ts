import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { FFMPEG_TIMEOUT_MS } from "@/lib/config";

const require = createRequire(import.meta.url);

/**
 * Resolve the ffmpeg/ffprobe binaries.
 *
 * A system build wins when FFMPEG_PATH / FFPROBE_PATH is set — production
 * images usually ship a build with hardware encoders and newer filters. The
 * npm static binaries are the fallback so `npm install && npm run dev` works
 * on a bare machine with no ffmpeg.
 */
function resolveBinary(
  envVar: string,
  staticPkg: string,
  fallbackName: string,
): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;

  try {
    const mod = require(staticPkg);
    const p = typeof mod === "string" ? mod : (mod?.path ?? mod?.default);
    if (typeof p === "string" && p.length > 0) return p;
  } catch {
    // Package not installed — fall through to PATH lookup.
  }
  return fallbackName;
}

export const FFMPEG_BIN = resolveBinary("FFMPEG_PATH", "ffmpeg-static", "ffmpeg");
export const FFPROBE_BIN = resolveBinary(
  "FFPROBE_PATH",
  "ffprobe-static",
  "ffprobe",
);

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
    readonly args: string[],
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

export interface RunOptions {
  /** Called with each stderr chunk. ffmpeg writes progress to stderr. */
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Cap retained stderr so a chatty run can't grow unbounded. */
  maxStderrChars?: number;
}

function run(
  bin: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const {
    onStderr,
    signal,
    timeoutMs = FFMPEG_TIMEOUT_MS,
    maxStderrChars = 200_000,
  } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        new FfmpegError(
          `${bin} timed out after ${Math.round(timeoutMs / 1000)}s`,
          -1,
          stderr,
          args,
        ),
      );
    }, timeoutMs);

    const onAbort = () => {
      child.kill("SIGKILL");
      finish(new FfmpegError(`${bin} aborted`, -1, stderr, args));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(err: Error | null, result?: RunResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(result!);
    }

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });

    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      onStderr?.(s);
      stderr += s;
      // Keep the tail — the useful diagnostics are at the end of an ffmpeg run.
      if (stderr.length > maxStderrChars) {
        stderr = stderr.slice(-maxStderrChars);
      }
    });

    child.on("error", (err) => {
      finish(
        new FfmpegError(
          `Failed to start ${bin}: ${err.message}. ` +
            `Install ffmpeg or set FFMPEG_PATH/FFPROBE_PATH.`,
          -1,
          stderr,
          args,
        ),
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish(null, { stdout, stderr, code: 0 });
      } else {
        finish(
          new FfmpegError(
            `${bin} exited with code ${code}: ${lastMeaningfulLine(stderr)}`,
            code ?? -1,
            stderr,
            args,
          ),
        );
      }
    });
  });
}

function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("frame=") && !l.startsWith("size="));
  return lines.at(-1) ?? "no output";
}

export function runFfmpeg(args: string[], opts?: RunOptions): Promise<RunResult> {
  // -nostdin stops ffmpeg swallowing the parent's stdin; -y overwrites outputs.
  return run(FFMPEG_BIN, ["-hide_banner", "-nostdin", "-y", ...args], opts);
}

export function runFfprobe(args: string[], opts?: RunOptions): Promise<RunResult> {
  return run(FFPROBE_BIN, ["-hide_banner", ...args], opts);
}

/**
 * Parse `time=00:01:23.45` out of an ffmpeg progress line.
 * Returns seconds, or null when the chunk carries no timestamp.
 */
export function parseProgressSeconds(chunk: string): number | null {
  const m = /time=(\d+):(\d{2}):(\d{2})\.(\d{1,3})/.exec(chunk);
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  return (
    Number(h) * 3600 +
    Number(mm) * 60 +
    Number(ss) +
    Number(frac.padEnd(3, "0")) / 1000
  );
}

/** Shell-safe-ish escape for values embedded in an ffmpeg filtergraph. */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** Escape a filesystem path for use inside a filter option (e.g. subtitles=). */
export function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,");
}

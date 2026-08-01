import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LOCAL_WHISPER_BIN, LOCAL_WHISPER_MODEL } from "@/lib/config";
import type {
  Transcript,
  TranscriptSegment,
  TranscriptionProvider,
  Word,
} from "@/lib/types";

/**
 * Local transcription via a whisper.cpp compatible CLI.
 *
 * Invocation:
 *   <bin> -m <model> -f <wav> --output-json-full --output-file <workbase> -np
 *
 * The CLI writes <workbase>.json. Two JSON shapes are supported:
 *  - "transcription" entries with "offsets" {from,to} in milliseconds only —
 *    word timings are interpolated evenly across the segment text.
 *  - the same entries plus a "tokens" array carrying per-token offsets —
 *    words are rebuilt from the tokens (special tokens are skipped).
 */

const LOCAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_STDERR_CHARS = 100_000;

// --- whisper.cpp JSON shapes -------------------------------------------------

interface WhisperOffsets {
  from?: number;
  to?: number;
}

interface WhisperTimestamps {
  from?: string;
  to?: string;
}

interface WhisperToken {
  text?: string;
  offsets?: WhisperOffsets;
  p?: number;
}

interface WhisperTranscriptionEntry {
  text?: string;
  offsets?: WhisperOffsets;
  timestamps?: WhisperTimestamps;
  tokens?: WhisperToken[];
}

interface WhisperJson {
  result?: { language?: string };
  params?: { language?: string };
  transcription?: WhisperTranscriptionEntry[];
}

// --- helpers -------------------------------------------------------------------

/** Parse a whisper.cpp "HH:MM:SS,mmm" timestamp into seconds. */
function parseClockTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
  if (!m) return null;
  return (
    Number(m[1]) * 3600 +
    Number(m[2]) * 60 +
    Number(m[3]) +
    Number(m[4].padEnd(3, "0")) / 1000
  );
}

function entryRange(
  entry: WhisperTranscriptionEntry,
): { start: number; end: number } | null {
  const from = entry.offsets?.from;
  const to = entry.offsets?.to;
  if (typeof from === "number" && typeof to === "number") {
    return { start: from / 1000, end: Math.max(to, from) / 1000 };
  }
  const start = parseClockTimestamp(entry.timestamps?.from);
  const end = parseClockTimestamp(entry.timestamps?.to);
  if (start !== null && end !== null) {
    return { start, end: Math.max(end, start) };
  }
  return null;
}

/** True for whisper special tokens like "[_BEG_]", "[_TT_123]". */
function isSpecialToken(text: string): boolean {
  const trimmed = text.trim();
  return /^\[_.*_\]$/.test(trimmed) || trimmed.startsWith("[_");
}

/** Evenly spread the segment's whitespace-split text across its time range. */
function interpolateWords(text: string, start: number, end: number): Word[] {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const step = (end - start) / tokens.length;
  return tokens.map((tok, i) => ({
    text: tok,
    start: start + i * step,
    end: start + (i + 1) * step,
  }));
}

/**
 * Rebuild words from whisper.cpp tokens. Tokens are sub-word pieces; a new
 * word starts when a token begins with whitespace. Special tokens are skipped.
 */
function wordsFromTokens(
  tokens: WhisperToken[],
  segStart: number,
  segEnd: number,
): Word[] {
  interface Building {
    text: string;
    start: number;
    end: number;
    pSum: number;
    pCount: number;
  }

  const words: Word[] = [];
  let current: Building | null = null;

  const flush = () => {
    if (!current) return;
    const text = current.text.trim();
    if (text.length > 0) {
      const word: Word = {
        text,
        start: current.start,
        end: Math.max(current.end, current.start),
      };
      if (current.pCount > 0) word.confidence = current.pSum / current.pCount;
      words.push(word);
    }
    current = null;
  };

  for (const token of tokens) {
    const raw = token.text ?? "";
    if (raw.length === 0 || isSpecialToken(raw)) continue;

    const from = token.offsets?.from;
    const to = token.offsets?.to;
    const hasTiming = typeof from === "number" && typeof to === "number";
    const tokStart = hasTiming ? from / 1000 : null;
    const tokEnd = hasTiming ? Math.max(to, from) / 1000 : null;

    const startsNewWord = /^\s/.test(raw) || current === null;
    if (startsNewWord) {
      flush();
      current = {
        text: raw,
        start: tokStart ?? segStart,
        end: tokEnd ?? tokStart ?? segStart,
        pSum: typeof token.p === "number" ? token.p : 0,
        pCount: typeof token.p === "number" ? 1 : 0,
      };
    } else {
      const cur = current as Building;
      cur.text += raw;
      if (tokEnd !== null) cur.end = Math.max(cur.end, tokEnd);
      if (typeof token.p === "number") {
        cur.pSum += token.p;
        cur.pCount += 1;
      }
    }
  }
  flush();

  // Clamp into the segment range so a stray token offset can't escape it.
  for (const w of words) {
    if (w.start < segStart) w.start = segStart;
    if (w.end > segEnd) w.end = Math.max(segEnd, w.start);
    if (w.end < w.start) w.end = w.start;
  }
  return words;
}

function buildTranscript(json: WhisperJson): Transcript {
  const languageRaw = json.result?.language ?? json.params?.language;
  const language =
    typeof languageRaw === "string" && languageRaw.trim().length > 0
      ? languageRaw.trim()
      : "unknown";

  const segments: TranscriptSegment[] = [];

  for (const entry of json.transcription ?? []) {
    const range = entryRange(entry);
    if (!range) continue;
    const text = (entry.text ?? "").trim();
    if (!text) continue;

    let words: Word[] = [];
    if (Array.isArray(entry.tokens) && entry.tokens.length > 0) {
      words = wordsFromTokens(entry.tokens, range.start, range.end);
    }
    if (words.length === 0) {
      words = interpolateWords(text, range.start, range.end);
    }

    segments.push({
      id: 0, // renumbered below
      start: range.start,
      end: range.end,
      text,
      words,
    });
  }

  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  segments.forEach((seg, i) => {
    seg.id = i;
  });

  const allWords: Word[] = segments.flatMap((s) => s.words);
  const text = segments.map((s) => s.text).join(" ");

  return {
    language,
    text,
    segments,
    words: allWords,
    provider: "local",
  };
}

// --- process handling ------------------------------------------------------------

function runWhisper(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(LOCAL_WHISPER_BIN, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, LOCAL_TIMEOUT_MS);

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > MAX_STDERR_CHARS) {
        stderr = stderr.slice(-MAX_STDERR_CHARS);
      }
    });

    child.on("error", (err) => {
      finish(
        new Error(
          `Failed to start local whisper binary "${LOCAL_WHISPER_BIN}": ${err.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish(
          new Error(
            `Local whisper timed out after ${LOCAL_TIMEOUT_MS / 60000} minutes and was killed`,
          ),
        );
      } else if (code === 0) {
        finish(null);
      } else {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        finish(
          new Error(
            `Local whisper exited with code ${code ?? -1}${tail ? `: ${tail}` : ""}`,
          ),
        );
      }
    });
  });
}

// --- provider ----------------------------------------------------------------------

export const localProvider: TranscriptionProvider = {
  name: "local",

  async isAvailable(): Promise<boolean> {
    if (!LOCAL_WHISPER_BIN || !LOCAL_WHISPER_MODEL) return false;
    try {
      await fsp.access(LOCAL_WHISPER_BIN, fs.constants.X_OK);
      return true;
    } catch {
      // Some setups mark the binary non-executable but runnable via shebang;
      // fall back to a plain existence check.
      try {
        await fsp.access(LOCAL_WHISPER_BIN, fs.constants.F_OK);
        return true;
      } catch {
        return false;
      }
    }
  },

  async transcribe(
    audioPath: string,
    opts?: { language?: string },
  ): Promise<Transcript> {
    if (!LOCAL_WHISPER_BIN || !LOCAL_WHISPER_MODEL) {
      throw new Error(
        "Local transcription requires LOCAL_WHISPER_BIN and LOCAL_WHISPER_MODEL to be set",
      );
    }
    try {
      await fsp.access(audioPath, fs.constants.R_OK);
    } catch {
      throw new Error(`Audio file not found or unreadable: ${audioPath}`);
    }

    const dir = path.dirname(audioPath);
    const base = path.basename(audioPath, path.extname(audioPath));
    const workBase = path.join(dir, `${base}.whisper-${randomUUID().slice(0, 8)}`);
    const jsonPath = `${workBase}.json`;

    const args = [
      "-m",
      LOCAL_WHISPER_MODEL,
      "-f",
      audioPath,
      "--output-json-full",
      "--output-file",
      workBase,
      "-np",
    ];
    if (opts?.language) {
      args.push("-l", opts.language);
    }

    try {
      await runWhisper(args);

      let raw: string;
      try {
        raw = await fsp.readFile(jsonPath, "utf8");
      } catch {
        throw new Error(
          `Local whisper finished but did not write its JSON output (${jsonPath})`,
        );
      }

      let json: WhisperJson;
      try {
        json = JSON.parse(raw) as WhisperJson;
      } catch {
        throw new Error(`Local whisper produced unparseable JSON at ${jsonPath}`);
      }

      return buildTranscript(json);
    } finally {
      await fsp.unlink(jsonPath).catch(() => undefined);
    }
  },
};

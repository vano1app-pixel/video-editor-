import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OPENAI_API_KEY, OPENAI_TRANSCRIBE_MODEL } from "@/lib/config";
import { runFfmpeg, runFfprobe } from "@/lib/ffmpeg/exec";
import type {
  Transcript,
  TranscriptSegment,
  TranscriptionProvider,
  Word,
} from "@/lib/types";

/**
 * OpenAI Whisper API transcription provider.
 *
 * Uses the raw REST endpoint via global fetch — no SDK. The wav input is first
 * transcoded to mono 32 kbps Opus (ogg), which keeps ~1.7 hours of audio under
 * the API's 25 MB upload limit. Anything still larger is split into 20-minute
 * chunks that are transcribed sequentially and stitched back together with
 * accurate per-chunk time offsets.
 */

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const CHUNK_SECONDS = 1200; // 20 minutes
const MAX_RETRIES = 2; // retries after the first attempt, for 429/5xx

// --- verbose_json response shapes ------------------------------------------

interface VerboseWord {
  word?: string;
  start?: number;
  end?: number;
}

interface VerboseSegment {
  id?: number;
  start?: number;
  end?: number;
  text?: string;
}

interface VerboseResponse {
  language?: string;
  text?: string;
  duration?: number;
  words?: VerboseWord[];
  segments?: VerboseSegment[];
}

// --- helpers ----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function probeDurationSec(filePath: string): Promise<number> {
  const res = await runFfprobe([
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    filePath,
  ]);
  let parsed: { format?: { duration?: string } };
  try {
    parsed = JSON.parse(res.stdout) as { format?: { duration?: string } };
  } catch {
    throw new Error(`ffprobe returned unparseable output for ${filePath}`);
  }
  const dur = Number.parseFloat(parsed.format?.duration ?? "");
  if (!Number.isFinite(dur) || dur < 0) {
    throw new Error(`Could not determine duration of ${filePath}`);
  }
  return dur;
}

async function fileSize(filePath: string): Promise<number> {
  const st = await fsp.stat(filePath);
  return st.size;
}

/**
 * Remove every temp file created for this transcription run. The work base
 * carries a random suffix, so a prefix sweep only ever matches our own files —
 * including chunk files left behind when ffmpeg fails mid-split.
 */
async function cleanupWorkFiles(workBase: string): Promise<void> {
  const dir = path.dirname(workBase);
  const prefix = path.basename(workBase);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((n) => n.startsWith(prefix))
      .map((n) => fsp.unlink(path.join(dir, n)).catch(() => undefined)),
  );
}

/**
 * POST one audio file to the transcription endpoint. Retries 429/5xx (and
 * transport-level failures) up to MAX_RETRIES times with exponential backoff.
 */
async function requestTranscription(
  audioPath: string,
  language?: string,
): Promise<VerboseResponse> {
  const data = await fsp.readFile(audioPath);
  // Copy into a plain ArrayBuffer-backed view so it satisfies BlobPart in
  // every @types/node revision.
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  const fileName = path.basename(audioPath);

  const buildForm = (): FormData => {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "audio/ogg" }), fileName);
    form.append("model", OPENAI_TRANSCRIBE_MODEL);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
    if (language) form.append("language", language);
    return form;
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));

    let response: Response;
    try {
      response = await fetch(OPENAI_TRANSCRIBE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: buildForm(),
      });
    } catch (err) {
      lastError = new Error(
        `OpenAI transcription request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (response.ok) {
      const json = (await response.json()) as VerboseResponse;
      return json;
    }

    const bodyText = await response.text().catch(() => "");
    const message = `OpenAI transcription failed (HTTP ${response.status}): ${truncate(bodyText, 500)}`;

    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(message);
      continue;
    }
    // 4xx other than 429 will not get better on retry.
    throw new Error(message);
  }

  throw lastError ?? new Error("OpenAI transcription failed after retries");
}

// --- response mapping --------------------------------------------------------

interface ChunkResult {
  response: VerboseResponse;
  offsetSec: number;
}

/** Merge chunk responses into a single Transcript, renumbering globally. */
function buildTranscript(chunks: ChunkResult[]): Transcript {
  const segments: TranscriptSegment[] = [];
  const allWords: Word[] = [];
  let language = "";

  for (const { response, offsetSec } of chunks) {
    if (!language && typeof response.language === "string") {
      language = response.language;
    }

    for (const seg of response.segments ?? []) {
      const start = typeof seg.start === "number" ? seg.start : null;
      const end = typeof seg.end === "number" ? seg.end : null;
      if (start === null || end === null) continue;
      const text = (seg.text ?? "").trim();
      if (!text) continue;
      segments.push({
        id: 0, // renumbered below
        start: start + offsetSec,
        end: Math.max(end, start) + offsetSec,
        text,
        words: [],
      });
    }

    for (const w of response.words ?? []) {
      const start = typeof w.start === "number" ? w.start : null;
      const end = typeof w.end === "number" ? w.end : null;
      const text = (w.word ?? "").trim();
      if (start === null || end === null || !text) continue;
      allWords.push({
        text,
        start: start + offsetSec,
        end: Math.max(end, start) + offsetSec,
      });
    }
  }

  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  allWords.sort((a, b) => a.start - b.start || a.end - b.end);

  // If the model returned words but no segments, synthesize one segment.
  if (segments.length === 0 && allWords.length > 0) {
    const first = allWords[0];
    const last = allWords[allWords.length - 1];
    segments.push({
      id: 0,
      start: first.start,
      end: last.end,
      text: allWords.map((w) => w.text).join(" "),
      words: [],
    });
  }

  // If segments exist but word timestamps are missing, interpolate them evenly
  // across each segment's text so downstream captioning still works.
  if (allWords.length === 0 && segments.length > 0) {
    for (const seg of segments) {
      const tokens = seg.text.split(/\s+/).filter((t) => t.length > 0);
      if (tokens.length === 0) continue;
      const step = (seg.end - seg.start) / tokens.length;
      tokens.forEach((tok, i) => {
        allWords.push({
          text: tok,
          start: seg.start + i * step,
          end: seg.start + (i + 1) * step,
        });
      });
    }
    allWords.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  // Renumber segments globally and assign words by time containment
  // (a word belongs to the segment its midpoint falls into).
  segments.forEach((seg, i) => {
    seg.id = i;
  });
  let segIdx = 0;
  for (const word of allWords) {
    if (segments.length === 0) break;
    const mid = (word.start + word.end) / 2;
    while (segIdx < segments.length - 1 && mid >= segments[segIdx].end) {
      segIdx++;
    }
    segments[segIdx].words.push(word);
  }

  const text = segments
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0)
    .join(" ");

  return {
    language: language || "unknown",
    text,
    segments,
    words: allWords,
    provider: "openai",
  };
}

// --- audio preparation --------------------------------------------------------

/** Transcode to mono 32 kbps Opus in an ogg container next to the source. */
async function transcodeToOpus(wavPath: string, workBase: string): Promise<string> {
  const oggPath = `${workBase}.ogg`;
  await runFfmpeg([
    "-i",
    wavPath,
    "-vn",
    "-ac",
    "1",
    "-c:a",
    "libopus",
    "-b:a",
    "32k",
    oggPath,
  ]);
  return oggPath;
}

/** Split an ogg into ~20-minute chunks; returns absolute paths in order. */
async function splitIntoChunks(oggPath: string, workBase: string): Promise<string[]> {
  const pattern = `${workBase}-chunk-%03d.ogg`;
  await runFfmpeg([
    "-i",
    oggPath,
    "-map",
    "0:a",
    "-c",
    "copy",
    "-f",
    "segment",
    "-segment_time",
    String(CHUNK_SECONDS),
    pattern,
  ]);

  const dir = path.dirname(workBase);
  const prefix = `${path.basename(workBase)}-chunk-`;
  const names = await fsp.readdir(dir);
  const chunks = names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".ogg"))
    .sort()
    .map((n) => path.join(dir, n));

  if (chunks.length === 0) {
    throw new Error("ffmpeg produced no audio chunks while splitting for upload");
  }
  return chunks;
}

// --- provider -----------------------------------------------------------------

export const openaiProvider: TranscriptionProvider = {
  name: "openai",

  async isAvailable(): Promise<boolean> {
    return OPENAI_API_KEY.trim().length > 0;
  },

  async transcribe(
    audioPath: string,
    opts?: { language?: string },
  ): Promise<Transcript> {
    if (OPENAI_API_KEY.trim().length === 0) {
      throw new Error("OpenAI transcription requires OPENAI_API_KEY to be set");
    }
    try {
      await fsp.access(audioPath, fs.constants.R_OK);
    } catch {
      throw new Error(`Audio file not found or unreadable: ${audioPath}`);
    }

    const dir = path.dirname(audioPath);
    const base = path.basename(audioPath, path.extname(audioPath));
    const workBase = path.join(dir, `${base}.tx-${randomUUID().slice(0, 8)}`);

    try {
      const oggPath = await transcodeToOpus(audioPath, workBase);

      if ((await fileSize(oggPath)) <= UPLOAD_LIMIT_BYTES) {
        const response = await requestTranscription(oggPath, opts?.language);
        return buildTranscript([{ response, offsetSec: 0 }]);
      }

      // Still over the limit — split into 20-minute chunks and transcribe
      // sequentially. Chunk boundaries drift from index * 1200 because the
      // segmenter cuts on packet boundaries, so probe each chunk's real
      // duration and accumulate offsets.
      const chunkPaths = await splitIntoChunks(oggPath, workBase);

      const results: ChunkResult[] = [];
      let offsetSec = 0;
      for (const chunkPath of chunkPaths) {
        const response = await requestTranscription(chunkPath, opts?.language);
        results.push({ response, offsetSec });
        offsetSec += await probeDurationSec(chunkPath);
      }
      return buildTranscript(results);
    } finally {
      await cleanupWorkFiles(workBase);
    }
  },
};

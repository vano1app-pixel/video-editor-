import { TRANSCRIBE_PROVIDER } from "@/lib/config";
import type {
  Transcript,
  TranscriptSegment,
  TranscriptionProvider,
  Word,
} from "@/lib/types";
import { openaiProvider } from "./openai";
import { localProvider } from "./local";

/**
 * Transcription entry point.
 *
 * Provider selection respects TRANSCRIBE_PROVIDER:
 *  - "auto"   -> first available of openai, local
 *  - "openai" / "local" -> that provider, or null when it is not configured
 *  - "none"   -> null (transcription disabled)
 */

/** Resolve the active transcription provider, or null when none is usable. */
export async function getTranscriptionProvider(): Promise<TranscriptionProvider | null> {
  switch (TRANSCRIBE_PROVIDER) {
    case "none":
      return null;
    case "openai":
      return (await openaiProvider.isAvailable()) ? openaiProvider : null;
    case "local":
      return (await localProvider.isAvailable()) ? localProvider : null;
    case "auto":
    default: {
      for (const provider of [openaiProvider, localProvider]) {
        if (await provider.isAvailable()) return provider;
      }
      return null;
    }
  }
}

/**
 * Transcribe a wav file with the configured provider.
 *
 * Returns null — never throws — when no provider is available, so the
 * pipeline can proceed without a transcript. Real transcription failures
 * (API errors, broken binaries, unreadable output) DO throw.
 */
export async function transcribeAudio(wavPath: string): Promise<Transcript | null> {
  const provider = await getTranscriptionProvider();
  if (!provider) return null;
  const transcript = await provider.transcribe(wavPath);
  return normalizeTranscript(transcript);
}

/**
 * Normalize a transcript so downstream consumers can rely on:
 *  - `words` sorted by start time and non-overlapping
 *    (each word's start is clamped to >= the previous word's end),
 *  - segments sorted and renumbered 0..n-1 with `words` assigned by
 *    time containment,
 *  - `text` equal to the joined segment text.
 *
 * The input is not mutated.
 */
export function normalizeTranscript(t: Transcript): Transcript {
  // Collect words: prefer the flattened list, fall back to segment words.
  const sourceWords: Word[] =
    t.words.length > 0 ? t.words : t.segments.flatMap((s) => s.words);

  const sorted = sourceWords
    .filter((w) => w.text.trim().length > 0)
    .map((w) => ({ ...w, text: w.text.trim() }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  // Clamp so words never overlap: start >= previous end, end >= start.
  const words: Word[] = [];
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (const w of sorted) {
    const start = Math.max(w.start, prevEnd);
    const end = Math.max(w.end, start);
    const clamped: Word = { text: w.text, start, end };
    if (typeof w.confidence === "number") clamped.confidence = w.confidence;
    words.push(clamped);
    prevEnd = end;
  }

  // Rebuild segments: sorted, renumbered, text trimmed.
  let segments: TranscriptSegment[] = t.segments
    .map((s) => ({
      id: 0,
      start: s.start,
      end: Math.max(s.end, s.start),
      text: s.text.trim(),
      words: [] as Word[],
    }))
    .filter((s) => s.text.length > 0)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  // No segments but words present: synthesize one covering everything.
  if (segments.length === 0 && words.length > 0) {
    const first = words[0];
    const last = words[words.length - 1];
    segments = [
      {
        id: 0,
        start: first.start,
        end: last.end,
        text: words.map((w) => w.text).join(" "),
        words: [],
      },
    ];
  }

  segments.forEach((seg, i) => {
    seg.id = i;
  });

  // Assign each word to the segment its midpoint falls into (words past the
  // last segment's end stick to the last segment).
  let segIdx = 0;
  for (const word of words) {
    if (segments.length === 0) break;
    const mid = (word.start + word.end) / 2;
    while (segIdx < segments.length - 1 && mid >= segments[segIdx].end) {
      segIdx++;
    }
    segments[segIdx].words.push(word);
  }

  const joined = segments
    .map((s) => s.text)
    .filter((s) => s.length > 0)
    .join(" ");

  return {
    language: t.language,
    text: joined.length > 0 ? joined : t.text.trim(),
    segments,
    words,
    provider: t.provider,
  };
}

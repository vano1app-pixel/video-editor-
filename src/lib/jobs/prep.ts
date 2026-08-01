import path from "node:path";

import { PATHS, ensureStorageDirs } from "@/lib/config";
import {
  detectScenes,
  detectSilences,
  extractAudio,
  probeMedia,
} from "@/lib/ffmpeg/analyze";
import {
  getAnalysis,
  getSource,
  saveAnalysis,
  saveSource,
  setPrepStatus,
} from "@/lib/jobs/store";
import { transcribeAudio } from "@/lib/transcribe";
import {
  JOB_STAGE_LABELS,
  type Analysis,
  type Scene,
  type SilenceRange,
  type Source,
  type Transcript,
} from "@/lib/types";

/**
 * Source preparation: probe -> audio -> transcript -> scenes/silences.
 *
 * This runs once per uploaded source and is completely independent of any job,
 * so the expensive part of the pipeline is already warm by the time the user
 * finishes describing the edit they want. It is fire-and-forget and never
 * throws at the caller — failures land in the prep status and in `isPrepFailed`.
 */

const NO_PROVIDER_MESSAGE =
  "No transcription provider configured — planning from scenes only";

const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 600_000;

interface PrepState {
  inFlight: Map<string, Promise<void>>;
  failures: Map<string, string>;
}

const GLOBAL_KEY = "__editai_prep";

type GlobalWithPrep = typeof globalThis & {
  [GLOBAL_KEY]?: PrepState;
};

function state(): PrepState {
  const g = globalThis as GlobalWithPrep;
  let prep = g[GLOBAL_KEY];
  if (!prep) {
    prep = {
      inFlight: new Map<string, Promise<void>>(),
      failures: new Map<string, string>(),
    };
    g[GLOBAL_KEY] = prep;
  }
  return prep;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  const text = String(err).trim();
  return text.length > 0 ? text : "Unknown error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// startPrep
// ---------------------------------------------------------------------------

/**
 * Kick off analysis for a source. Idempotent: a no-op when the analysis is
 * already cached or a run is in flight. Never awaited by callers.
 */
export function startPrep(sourceId: string): void {
  const prep = state();

  if (getAnalysis(sourceId) !== null) return;
  if (prep.inFlight.has(sourceId)) return;

  const source = getSource(sourceId);
  if (!source) {
    fail(sourceId, `Unknown source: ${sourceId}`);
    return;
  }

  prep.failures.delete(sourceId);

  const run = runPrep(source).finally(() => {
    prep.inFlight.delete(sourceId);
  });
  prep.inFlight.set(sourceId, run);

  // runPrep swallows its own errors; this is belt-and-braces so a rejection can
  // never surface as an unhandled promise and take the server down.
  run.catch((err: unknown) => {
    console.error(`[prep] unexpected failure for ${sourceId}:`, err);
  });
}

function fail(sourceId: string, message: string): void {
  state().failures.set(sourceId, message);
  setPrepStatus(sourceId, {
    stage: "failed",
    overall: 0,
    stageProgress: 0,
    message,
  });
}

async function runPrep(source: Source): Promise<void> {
  const sourceId = source.id;

  try {
    ensureStorageDirs();

    // 1. Probe -------------------------------------------------------------
    setPrepStatus(sourceId, {
      stage: "probing",
      overall: 0.05,
      stageProgress: 0,
      message: JOB_STAGE_LABELS.probing,
    });
    const media = await probeMedia(source.path);
    source.media = media;
    saveSource(source);

    // 2. Audio -------------------------------------------------------------
    setPrepStatus(sourceId, {
      stage: "extracting_audio",
      overall: 0.15,
      stageProgress: 0,
      message: JOB_STAGE_LABELS.extracting_audio,
    });
    const wavPath = path.join(PATHS.audio, `${sourceId}.wav`);
    await extractAudio(source.path, wavPath);

    // 3. Transcribe --------------------------------------------------------
    // A missing provider (or a provider that blows up) is survivable: the
    // planner and renderer both work from scenes and silences alone.
    setPrepStatus(sourceId, {
      stage: "transcribing",
      overall: 0.3,
      stageProgress: 0,
      message: JOB_STAGE_LABELS.transcribing,
    });
    let transcript: Transcript | null = null;
    try {
      transcript = await transcribeAudio(wavPath);
      if (transcript === null) {
        setPrepStatus(sourceId, {
          stage: "transcribing",
          overall: 0.8,
          stageProgress: 1,
          message: NO_PROVIDER_MESSAGE,
        });
      }
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[prep] transcription failed for ${sourceId}:`, err);
      transcript = null;
      setPrepStatus(sourceId, {
        stage: "transcribing",
        overall: 0.8,
        stageProgress: 1,
        message: `Transcription failed — continuing without captions (${message})`,
      });
    }

    // 4. Scenes + silences -------------------------------------------------
    setPrepStatus(sourceId, {
      stage: "analyzing",
      overall: 0.85,
      stageProgress: 0,
      message: JOB_STAGE_LABELS.analyzing,
    });
    const [scenes, silences]: [Scene[], SilenceRange[]] = await Promise.all([
      detectScenes(source.path, media.durationSec),
      detectSilences(source.path),
    ]);

    // 5. Done --------------------------------------------------------------
    const analysis: Analysis = { media, transcript, scenes, silences };
    saveAnalysis(sourceId, analysis);
    state().failures.delete(sourceId);
    setPrepStatus(sourceId, {
      stage: "done",
      overall: 1,
      stageProgress: 1,
      message: "Ready",
    });
  } catch (err) {
    const message = errorMessage(err);
    console.error(`[prep] failed for ${sourceId}:`, err);
    fail(sourceId, message);
  }
}

// ---------------------------------------------------------------------------
// waitForAnalysis
// ---------------------------------------------------------------------------

/**
 * Resolve with the source's analysis, starting prep if it is not running yet.
 * Rejects with the prep error, or on timeout (default 10 minutes).
 */
export async function waitForAnalysis(
  sourceId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Analysis> {
  startPrep(sourceId);

  const limit =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + limit;

  for (;;) {
    const analysis = getAnalysis(sourceId);
    if (analysis !== null) return analysis;

    const failure = isPrepFailed(sourceId);
    if (failure !== null) throw new Error(failure);

    if (Date.now() >= deadline) {
      throw new Error("Timed out preparing the video");
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// isPrepFailed
// ---------------------------------------------------------------------------

/** The recorded prep error for a source, or null when it has not failed. */
export function isPrepFailed(sourceId: string): string | null {
  return state().failures.get(sourceId) ?? null;
}

import fs from "node:fs";
import path from "node:path";

import { PATHS, ensureStorageDirs } from "@/lib/config";
import { startRetentionSweeper } from "@/lib/jobs/retention";
import type { Analysis, Job, JobProgress, JobStage, Source } from "@/lib/types";

/**
 * Process-wide state for sources, jobs and analyses.
 *
 * Route handlers are re-evaluated constantly in dev (HMR) and may be spread
 * across module instances, so the single source of truth lives on a
 * `globalThis` singleton rather than in module scope. Everything is mirrored to
 * disk as JSON under `PATHS.jobs` so a restart does not lose uploads or
 * finished renders.
 *
 * Disk is a mirror, never the authority: a failed write is logged and the
 * in-memory value still stands. Reads return the stored object directly (no
 * cloning) — callers mutate a job and call `saveJob` to persist.
 */

interface StoreState {
  sources: Map<string, Source>;
  jobs: Map<string, Job>;
  analyses: Map<string, Analysis>;
  prepStatus: Map<string, JobProgress>;
  hydrated: boolean;
}

const GLOBAL_KEY = "__editai_store";

type GlobalWithStore = typeof globalThis & {
  [GLOBAL_KEY]?: StoreState;
};

const DEFAULT_PREP_STATUS: JobProgress = {
  stage: "queued",
  overall: 0,
  stageProgress: 0,
  message: "Waiting",
};

const TERMINAL_STAGES: ReadonlySet<JobStage> = new Set<JobStage>([
  "done",
  "failed",
  "cancelled",
]);

/**
 * Shown for a job that was mid-flight when the process died. Rendering state
 * lives entirely in memory (ffmpeg child processes, abort controllers, the
 * render semaphore), so there is nothing left to resume after a restart.
 */
const INTERRUPTED_MESSAGE =
  "EditAi restarted while this edit was rendering. Please try again.";

// ---------------------------------------------------------------------------
// Singleton + hydration
// ---------------------------------------------------------------------------

function state(): StoreState {
  const g = globalThis as GlobalWithStore;
  let store = g[GLOBAL_KEY];
  if (!store) {
    store = {
      sources: new Map<string, Source>(),
      jobs: new Map<string, Job>(),
      analyses: new Map<string, Analysis>(),
      prepStatus: new Map<string, JobProgress>(),
      hydrated: false,
    };
    g[GLOBAL_KEY] = store;
  }
  if (!store.hydrated) {
    // Set first: hydration failures must not retry on every single read.
    // It also makes the calls below safe — they re-enter `state()` and must
    // see a hydrated store rather than recursing back into hydration.
    store.hydrated = true;
    hydrateFromDisk(store);

    // A job that was rendering when the process died can never make progress
    // again, so fail it once, here, while the store is cold. Doing it on a
    // later read would kill jobs that are legitimately in flight right now.
    try {
      const recovered = recoverInterruptedJobs();
      if (recovered > 0) {
        console.warn(
          `[store] failed ${recovered} job(s) interrupted by a restart`,
        );
      }
    } catch (err) {
      console.error("[store] job recovery failed:", err);
    }

    // Retention is opt-out and must never be able to break a cold start.
    try {
      startRetentionSweeper();
    } catch (err) {
      console.error("[store] could not start the retention sweeper:", err);
    }
  }
  return store;
}

function readJsonFile(file: string): unknown {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (err) {
    console.warn(`[store] skipping unreadable state file ${file}:`, err);
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `<prefix><id>.json` -> id, or null when the name does not match. */
function idFromFileName(name: string, prefix: string): string | null {
  if (!name.startsWith(prefix) || !name.endsWith(".json")) return null;
  const id = name.slice(prefix.length, name.length - ".json".length);
  return id.length > 0 ? id : null;
}

function hydrateFromDisk(store: StoreState): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(PATHS.jobs);
  } catch {
    // No storage dir yet — nothing persisted, which is a normal cold start.
    return;
  }

  for (const name of entries) {
    const file = path.join(PATHS.jobs, name);

    const sourceId = idFromFileName(name, "source-");
    if (sourceId !== null) {
      const parsed = readJsonFile(file);
      if (isRecord(parsed) && typeof parsed.id === "string") {
        store.sources.set(parsed.id, parsed as unknown as Source);
      }
      continue;
    }

    const jobId = idFromFileName(name, "job-");
    if (jobId !== null) {
      const parsed = readJsonFile(file);
      // A job without a progress block cannot be reported on or recovered, so
      // it is worse than useless in memory — skip it rather than hand callers
      // a half-shaped Job.
      if (
        isRecord(parsed) &&
        typeof parsed.id === "string" &&
        isRecord(parsed.progress) &&
        typeof parsed.progress.stage === "string"
      ) {
        store.jobs.set(parsed.id, parsed as unknown as Job);
      } else if (parsed !== null) {
        console.warn(`[store] skipping malformed job record ${file}`);
      }
      continue;
    }

    const analysisId = idFromFileName(name, "analysis-");
    if (analysisId !== null) {
      const parsed = readJsonFile(file);
      if (isRecord(parsed) && isRecord(parsed.media)) {
        store.analyses.set(analysisId, parsed as unknown as Analysis);
        // A persisted analysis means prep already finished for that source.
        store.prepStatus.set(analysisId, {
          stage: "done",
          overall: 1,
          stageProgress: 1,
          message: "Ready",
        });
      }
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Write pretty JSON through a temp file so a crash mid-write can never leave a
 * truncated document where a valid one used to be.
 */
function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  try {
    ensureStorageDirs();
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`[store] failed to persist ${file}:`, err);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort cleanup; the next successful write overwrites it anyway.
    }
  }
}

/** Delete a mirrored record. A record that was never written is not an error. */
function removeJson(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    console.error(`[store] failed to delete ${file}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export function getSource(id: string): Source | null {
  return state().sources.get(id) ?? null;
}

export function saveSource(s: Source): void {
  state().sources.set(s.id, s);
  writeJson(path.join(PATHS.jobs, `source-${s.id}.json`), s);
}

export function listSources(): Source[] {
  return [...state().sources.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Drop every trace of a source: the in-memory entry, its cached analysis and
 * prep status, and the JSON records mirroring them. Used by the retention
 * sweeper once the underlying media has aged out — an analysis is worthless
 * (and multi-megabyte) without the file it describes.
 */
export function forgetSource(id: string): void {
  const store = state();
  store.sources.delete(id);
  store.analyses.delete(id);
  store.prepStatus.delete(id);
  removeJson(path.join(PATHS.jobs, `source-${id}.json`));
  removeJson(path.join(PATHS.jobs, `analysis-${id}.json`));
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export function getJob(id: string): Job | null {
  return state().jobs.get(id) ?? null;
}

export function saveJob(j: Job): void {
  j.updatedAt = Date.now();
  state().jobs.set(j.id, j);
  writeJson(path.join(PATHS.jobs, `job-${j.id}.json`), j);
}

export function listJobs(): Job[] {
  return [...state().jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Drop a job from memory and delete its JSON record. */
export function forgetJob(id: string): void {
  state().jobs.delete(id);
  removeJson(path.join(PATHS.jobs, `job-${id}.json`));
}

/**
 * Fail every job left in a non-terminal stage, and persist the change.
 *
 * Called once during hydration: a job persisted as "rendering" belongs to a
 * process that no longer exists, and nothing resumes it, so a client would
 * poll it forever. Terminal jobs (done/failed/cancelled) are untouched.
 *
 * Safe to call directly, but only ever call it when no job is genuinely in
 * flight in this process — it cannot tell the difference.
 *
 * @returns how many jobs were rewritten.
 */
export function recoverInterruptedJobs(): number {
  const store = state();
  let recovered = 0;

  for (const job of store.jobs.values()) {
    if (TERMINAL_STAGES.has(job.progress.stage)) continue;

    job.error = INTERRUPTED_MESSAGE;
    job.progress = {
      stage: "failed",
      overall: job.progress.overall,
      stageProgress: 0,
      message: INTERRUPTED_MESSAGE,
    };
    saveJob(job);
    recovered += 1;
  }

  return recovered;
}

// ---------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------

export function getAnalysis(sourceId: string): Analysis | null {
  return state().analyses.get(sourceId) ?? null;
}

export function saveAnalysis(sourceId: string, a: Analysis): void {
  state().analyses.set(sourceId, a);
  // Can be multi-megabyte once a transcript is attached — that is expected.
  writeJson(path.join(PATHS.jobs, `analysis-${sourceId}.json`), a);
}

// ---------------------------------------------------------------------------
// Prep status (in-memory only — it is rebuilt from the analysis on restart)
// ---------------------------------------------------------------------------

export function getPrepStatus(sourceId: string): JobProgress {
  return state().prepStatus.get(sourceId) ?? { ...DEFAULT_PREP_STATUS };
}

export function setPrepStatus(sourceId: string, p: JobProgress): void {
  state().prepStatus.set(sourceId, p);
}

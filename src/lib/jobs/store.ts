import fs from "node:fs";
import path from "node:path";

import { PATHS, ensureStorageDirs } from "@/lib/config";
import type { Analysis, Job, JobProgress, Source } from "@/lib/types";

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
    store.hydrated = true;
    hydrateFromDisk(store);
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
      if (isRecord(parsed) && typeof parsed.id === "string") {
        store.jobs.set(parsed.id, parsed as unknown as Job);
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

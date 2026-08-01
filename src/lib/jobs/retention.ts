import fs from "node:fs";
import path from "node:path";
import {
  setInterval as setNodeInterval,
  setTimeout as setNodeTimeout,
} from "node:timers";

import { PATHS, RETENTION_ENABLED, RETENTION_HOURS } from "@/lib/config";
import { forgetJob, forgetSource, getSource, listJobs } from "@/lib/jobs/store";
import type { JobStage } from "@/lib/types";

/**
 * Storage retention.
 *
 * Every upload, extracted WAV, per-job work directory and render stays on disk
 * until something removes it. On a long-lived instance that is a slow leak with
 * a hard ending: the volume fills and then *every* job fails at the first
 * ffmpeg write. This module sweeps anything older than RETENTION_HOURS.
 *
 * Two rules govern the sweep:
 *   1. It never throws. A sweep is best-effort background maintenance; a single
 *      unreadable directory must not abort the rest of it, let alone bubble
 *      into a request. Per-entry failures land in `SweepResult.errors`.
 *   2. It never touches anything belonging to a job that is still running in
 *      this process. On an instance that has been up longer than the retention
 *      window, a render in progress can easily be working against files that
 *      are technically older than the cutoff.
 */

export interface SweepResult {
  /** Filesystem entries considered for deletion. */
  scanned: number;
  /** Entries actually removed (a work directory counts as one). */
  deleted: number;
  freedBytes: number;
  /** One `path: reason` line per entry that could not be swept. */
  errors: string[];
}

/** Wait this long after boot before the first sweep, so startup stays fast. */
const FIRST_SWEEP_DELAY_MS = 30_000;
/** Then sweep on this cadence for as long as the process lives. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const SWEEPER_KEY = "__editai_retention_sweeper";

type GlobalWithSweeper = typeof globalThis & {
  [SWEEPER_KEY]?: boolean;
};

const TERMINAL_STAGES: ReadonlySet<JobStage> = new Set<JobStage>([
  "done",
  "failed",
  "cancelled",
]);

// ---------------------------------------------------------------------------
// Small helpers — every one of them swallows its own failures
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  const text = String(err).trim();
  return text.length > 0 ? text : "Unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for "it is already gone", which is a success for a sweeper. */
function isMissing(err: unknown): boolean {
  return isRecord(err) && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

/** `<prefix><id>.json` -> id, or null when the name does not match. */
function idFromRecordName(name: string, prefix: string): string | null {
  if (!name.startsWith(prefix) || !name.endsWith(".json")) return null;
  const id = name.slice(prefix.length, name.length - ".json".length);
  return id.length > 0 ? id : null;
}

/** `<id>.<ext>` -> id. Media files are always named after their owner. */
function idFromMediaName(name: string): string {
  const ext = path.extname(name);
  return ext.length > 0 ? name.slice(0, name.length - ext.length) : name;
}

async function sizeOf(file: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(file);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

async function readRecord(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Latest of `createdAt` / `updatedAt`, or null when neither is usable. */
function recordTimestamp(record: Record<string, unknown> | null): number | null {
  if (!record) return null;
  let newest: number | null = null;
  for (const key of ["createdAt", "updatedAt"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      newest = newest === null ? value : Math.max(newest, value);
    }
  }
  return newest;
}

/**
 * Total bytes and most recent mtime anywhere in a tree. The newest mtime is
 * what decides staleness: a work directory's own mtime stops moving once its
 * last file is created, but the file itself may still be growing.
 */
async function inspectTree(
  root: string,
): Promise<{ bytes: number; newestMtimeMs: number }> {
  let bytes = 0;
  let newestMtimeMs = 0;

  const visit = async (target: string): Promise<void> => {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(target);
    } catch {
      return;
    }
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
    if (stat.isFile()) {
      bytes += stat.size;
      return;
    }
    if (!stat.isDirectory()) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      await visit(path.join(target, entry.name));
    }
  };

  await visit(root);
  return { bytes, newestMtimeMs };
}

// ---------------------------------------------------------------------------
// What the sweep must not touch
// ---------------------------------------------------------------------------

interface Protection {
  /** Absolute paths that must survive regardless of age. */
  paths: Set<string>;
  jobIds: Set<string>;
  sourceIds: Set<string>;
}

/** Everything owned by a job that has not reached a terminal stage. */
function activeProtection(): Protection {
  const guard: Protection = {
    paths: new Set<string>(),
    jobIds: new Set<string>(),
    sourceIds: new Set<string>(),
  };

  for (const job of listJobs()) {
    if (TERMINAL_STAGES.has(job.progress.stage)) continue;

    guard.jobIds.add(job.id);
    guard.sourceIds.add(job.sourceId);
    guard.paths.add(path.resolve(PATHS.work, job.id));
    guard.paths.add(path.resolve(PATHS.outputs, `${job.id}.mp4`));
    guard.paths.add(path.resolve(PATHS.audio, `${job.sourceId}.wav`));
    if (job.outputPath) guard.paths.add(path.resolve(job.outputPath));

    const source = getSource(job.sourceId);
    if (source) guard.paths.add(path.resolve(source.path));
  }

  return guard;
}

// ---------------------------------------------------------------------------
// Media directories
// ---------------------------------------------------------------------------

/**
 * Remove a stale file or directory tree, accounting for what it freed.
 * Returns true when something was deleted.
 */
async function removeIfStale(
  target: string,
  isDirectory: boolean,
  cutoff: number,
  result: SweepResult,
): Promise<boolean> {
  if (isDirectory) {
    const { bytes, newestMtimeMs } = await inspectTree(target);
    if (newestMtimeMs === 0 || newestMtimeMs >= cutoff) return false;
    await fs.promises.rm(target, { recursive: true, force: true });
    result.deleted += 1;
    result.freedBytes += bytes;
    return true;
  }

  const stat = await fs.promises.stat(target);
  if (stat.mtimeMs >= cutoff) return false;
  await fs.promises.unlink(target);
  result.deleted += 1;
  result.freedBytes += stat.size;
  return true;
}

/**
 * Sweep one media directory. `owner` says whose id the entry names encode, so
 * a file can be spared even if its owning record has gone missing.
 */
async function sweepMediaDir(
  dir: string,
  owner: "job" | "source",
  cutoff: number,
  guard: Protection,
  result: SweepResult,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A directory that was never created holds nothing to sweep.
    if (!isMissing(err)) {
      result.errors.push(`${dir}: ${errorMessage(err)}`);
    }
    return;
  }

  const protectedIds = owner === "job" ? guard.jobIds : guard.sourceIds;

  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    result.scanned += 1;

    try {
      if (guard.paths.has(path.resolve(target))) continue;
      if (protectedIds.has(idFromMediaName(entry.name))) continue;
      await removeIfStale(target, entry.isDirectory(), cutoff, result);
    } catch (err) {
      if (isMissing(err)) continue;
      result.errors.push(`${target}: ${errorMessage(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// JSON records
// ---------------------------------------------------------------------------

interface RecordEntry {
  id: string;
  file: string;
}

/**
 * Expire job, source and analysis records, dropping them from memory as well as
 * from disk. Order matters: jobs go first so that a source still referenced by
 * a surviving job keeps its record (and its preview keeps resolving).
 */
async function sweepRecords(
  cutoff: number,
  guard: Protection,
  result: SweepResult,
): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(PATHS.jobs);
  } catch (err) {
    if (!isMissing(err)) {
      result.errors.push(`${PATHS.jobs}: ${errorMessage(err)}`);
    }
    return;
  }

  const jobRecords: RecordEntry[] = [];
  const sourceRecords: RecordEntry[] = [];
  const analysisRecords: RecordEntry[] = [];
  const scratchFiles: string[] = [];

  for (const name of names) {
    const file = path.join(PATHS.jobs, name);
    result.scanned += 1;

    const jobId = idFromRecordName(name, "job-");
    if (jobId !== null) {
      jobRecords.push({ id: jobId, file });
      continue;
    }
    const sourceId = idFromRecordName(name, "source-");
    if (sourceId !== null) {
      sourceRecords.push({ id: sourceId, file });
      continue;
    }
    const analysisId = idFromRecordName(name, "analysis-");
    if (analysisId !== null) {
      analysisRecords.push({ id: analysisId, file });
      continue;
    }
    // Leftover `*.json.tmp` from a write that was interrupted mid-rename.
    if (name.endsWith(".tmp")) scratchFiles.push(file);
  }

  // --- Jobs ---------------------------------------------------------------
  const referencedSourceIds = new Set<string>(guard.sourceIds);

  for (const { id, file } of jobRecords) {
    try {
      const record = await readRecord(file);
      const sourceId =
        record && typeof record.sourceId === "string" ? record.sourceId : null;
      const timestamp = recordTimestamp(record) ?? (await mtimeOf(file));
      const expired = timestamp !== null && timestamp < cutoff;

      if (guard.jobIds.has(id) || !expired) {
        if (sourceId) referencedSourceIds.add(sourceId);
        continue;
      }

      const bytes = await sizeOf(file);
      forgetJob(id);
      result.deleted += 1;
      result.freedBytes += bytes;
    } catch (err) {
      result.errors.push(`${file}: ${errorMessage(err)}`);
    }
  }

  // --- Sources (and the analysis hanging off each) -------------------------
  const forgottenSourceIds = new Set<string>();

  for (const { id, file } of sourceRecords) {
    try {
      if (referencedSourceIds.has(id)) continue;

      const record = await readRecord(file);
      const timestamp = recordTimestamp(record) ?? (await mtimeOf(file));
      if (timestamp === null || timestamp >= cutoff) continue;

      const bytes =
        (await sizeOf(file)) +
        (await sizeOf(path.join(PATHS.jobs, `analysis-${id}.json`)));
      forgetSource(id);
      forgottenSourceIds.add(id);
      result.deleted += 1;
      result.freedBytes += bytes;
    } catch (err) {
      result.errors.push(`${file}: ${errorMessage(err)}`);
    }
  }

  // --- Orphaned analyses ---------------------------------------------------
  // An analysis whose source record is already gone describes media nobody can
  // reach. These are the largest records on disk, so they are worth chasing.
  for (const { id, file } of analysisRecords) {
    try {
      if (forgottenSourceIds.has(id)) continue;
      if (referencedSourceIds.has(id) || getSource(id) !== null) continue;

      const timestamp = await mtimeOf(file);
      if (timestamp === null || timestamp >= cutoff) continue;

      const bytes = await sizeOf(file);
      forgetSource(id);
      result.deleted += 1;
      result.freedBytes += bytes;
    } catch (err) {
      result.errors.push(`${file}: ${errorMessage(err)}`);
    }
  }

  // --- Interrupted writes --------------------------------------------------
  for (const file of scratchFiles) {
    try {
      await removeIfStale(file, false, cutoff, result);
    } catch (err) {
      if (isMissing(err)) continue;
      result.errors.push(`${file}: ${errorMessage(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// sweepStorage
// ---------------------------------------------------------------------------

/**
 * Delete everything older than RETENTION_HOURS across `storage/`, plus the
 * matching in-memory entries. A no-op returning a zeroed result when retention
 * is disabled (RETENTION_HOURS=0). Never throws.
 *
 * @param now Clock override, for tests and for sweeping against a fixed instant.
 */
export async function sweepStorage(now: number = Date.now()): Promise<SweepResult> {
  const result: SweepResult = {
    scanned: 0,
    deleted: 0,
    freedBytes: 0,
    errors: [],
  };
  if (!RETENTION_ENABLED) return result;

  const cutoff = now - RETENTION_HOURS * 3600e3;

  let guard: Protection;
  try {
    guard = activeProtection();
  } catch (err) {
    // Without the guard the sweep could delete a live render's inputs, so bail
    // out rather than run unprotected — the next sweep tries again.
    result.errors.push(`protection: ${errorMessage(err)}`);
    return result;
  }

  try {
    await sweepMediaDir(PATHS.uploads, "source", cutoff, guard, result);
    await sweepMediaDir(PATHS.audio, "source", cutoff, guard, result);
    await sweepMediaDir(PATHS.outputs, "job", cutoff, guard, result);
    await sweepMediaDir(PATHS.work, "job", cutoff, guard, result);
    await sweepRecords(cutoff, guard, result);
  } catch (err) {
    // Defensive: the helpers above are already total, so reaching here is a bug
    // rather than an expected I/O failure. Report it, never propagate it.
    result.errors.push(`sweep: ${errorMessage(err)}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// startRetentionSweeper
// ---------------------------------------------------------------------------

function runSweep(): void {
  void sweepStorage()
    .then((result) => {
      if (result.deleted > 0) {
        const mb = (result.freedBytes / (1024 * 1024)).toFixed(1);
        console.info(
          `[retention] removed ${result.deleted} of ${result.scanned} entries, freed ${mb} MB`,
        );
      }
      for (const message of result.errors) {
        console.warn(`[retention] ${message}`);
      }
    })
    .catch((err: unknown) => {
      console.error("[retention] sweep failed:", err);
    });
}

/**
 * Start the background sweeper: once shortly after boot, then every six hours.
 *
 * Idempotent — every store hydration calls it, and dev HMR re-evaluates this
 * module constantly, so the flag lives on `globalThis`. Both timers are
 * `unref`'d: retention must never be the reason a process refuses to exit.
 */
export function startRetentionSweeper(): void {
  if (!RETENTION_ENABLED) return;

  const g = globalThis as GlobalWithSweeper;
  if (g[SWEEPER_KEY] === true) return;
  g[SWEEPER_KEY] = true;

  setNodeTimeout(runSweep, FIRST_SWEEP_DELAY_MS).unref();
  setNodeInterval(runSweep, SWEEP_INTERVAL_MS).unref();
}

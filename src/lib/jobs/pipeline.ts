import fs from "node:fs";
import path from "node:path";

import { nanoid } from "nanoid";

import { MAX_CONCURRENT_JOBS, PATHS, ensureStorageDirs } from "@/lib/config";
import { waitForAnalysis } from "@/lib/jobs/prep";
import { getJob, getPrepStatus, getSource, saveJob } from "@/lib/jobs/store";
import { plannerAvailable, runPlannerTurn } from "@/lib/planner";
import { renderPlan } from "@/lib/render/renderer";
import {
  JOB_STAGE_LABELS,
  type Analysis,
  type ChatMessage,
  type CreateJobRequest,
  type EditPlan,
  type Job,
  type JobStage,
} from "@/lib/types";

/**
 * Job pipeline: analysis -> plan -> render.
 *
 * Jobs are created synchronously (so the HTTP response carries a real job id)
 * and then run detached. Rendering is the only genuinely expensive step, so a
 * FIFO semaphore caps it at MAX_CONCURRENT_JOBS while planning and analysis
 * stay unthrottled. Every job owns an AbortController so `cancelJob` can kill
 * ffmpeg mid-render.
 */

/** Fraction of the overall bar owned by analysis. */
const ANALYSIS_SHARE = 0.25;
/** Where rendering starts on the overall bar. */
const RENDER_START = 0.3;
const RENDER_SHARE = 0.7;
/** How often job progress mirrors prep progress while waiting for analysis. */
const MIRROR_INTERVAL_MS = 500;

const NO_PLANNER_MESSAGE = "EditAi needs an ANTHROPIC_API_KEY to plan edits.";
const NOT_READY_MESSAGE =
  "EditAi needs more detail before it can edit — open the chat and answer its questions.";

const TERMINAL_STAGES: ReadonlySet<JobStage> = new Set<JobStage>([
  "done",
  "failed",
  "cancelled",
]);

interface PipelineState {
  /** Render slots currently held. */
  running: number;
  /** FIFO of waiters, each resolving its acquire() call. */
  queue: Array<() => void>;
  controllers: Map<string, AbortController>;
}

const GLOBAL_KEY = "__editai_pipeline";

type GlobalWithPipeline = typeof globalThis & {
  [GLOBAL_KEY]?: PipelineState;
};

function state(): PipelineState {
  const g = globalThis as GlobalWithPipeline;
  let pipeline = g[GLOBAL_KEY];
  if (!pipeline) {
    pipeline = {
      running: 0,
      queue: [],
      controllers: new Map<string, AbortController>(),
    };
    g[GLOBAL_KEY] = pipeline;
  }
  return pipeline;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  const text = String(err).trim();
  return text.length > 0 ? text : "Unknown error";
}

function maxConcurrent(): number {
  return Number.isFinite(MAX_CONCURRENT_JOBS) && MAX_CONCURRENT_JOBS > 0
    ? Math.floor(MAX_CONCURRENT_JOBS)
    : 1;
}

/** Take a render slot, queueing behind anyone already waiting. */
function acquire(): Promise<void> {
  const pipeline = state();
  if (pipeline.running < maxConcurrent()) {
    pipeline.running += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    pipeline.queue.push(resolve);
  });
}

/** Hand the slot to the next waiter, or give it back to the pool. */
function release(): void {
  const pipeline = state();
  const next = pipeline.queue.shift();
  if (next) {
    next();
    return;
  }
  pipeline.running = Math.max(0, pipeline.running - 1);
}

class JobCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "JobCancelledError";
  }
}

// ---------------------------------------------------------------------------
// createAndStartJob
// ---------------------------------------------------------------------------

/** Create a job, start it in the background, and return it immediately. */
export function createAndStartJob(req: CreateJobRequest): Job {
  const now = Date.now();
  const job: Job = {
    id: nanoid(10),
    sourceId: req.sourceId,
    createdAt: now,
    updatedAt: now,
    progress: {
      stage: "queued",
      overall: 0,
      stageProgress: 0,
      message: "Queued",
    },
    brief: req.brief,
    media: null,
    transcript: null,
    scenes: [],
    silences: [],
    plan: null,
    outputPath: null,
    outputUrl: null,
    error: null,
  };
  saveJob(job);

  const controller = new AbortController();
  state().controllers.set(job.id, controller);

  runJob(job, req, controller).catch((err: unknown) => {
    // runJob handles its own failures; this only catches bugs in the handler.
    console.error(`[pipeline] unexpected failure for job ${job.id}:`, err);
  });

  return job;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function runJob(
  job: Job,
  req: CreateJobRequest,
  controller: AbortController,
): Promise<void> {
  const update = (
    stage: JobStage,
    overall: number,
    message: string,
    stageProgress = 0,
  ): void => {
    // Once cancelled, nothing may resurrect the job.
    if (job.progress.stage === "cancelled") return;
    job.progress = {
      stage,
      overall: clamp01(overall),
      stageProgress: clamp01(stageProgress),
      message,
    };
    saveJob(job);
  };

  const throwIfCancelled = (): void => {
    if (controller.signal.aborted) throw new JobCancelledError();
  };

  try {
    throwIfCancelled();

    // --- Analysis -------------------------------------------------------
    // Prep may already be running (or finished) for this source; mirror its
    // progress into the first quarter of the job's bar while we wait.
    update("queued", 0, JOB_STAGE_LABELS.queued);

    const mirror = setInterval(() => {
      if (controller.signal.aborted) return;
      const prep = getPrepStatus(req.sourceId);
      if (prep.stage === "done" || prep.stage === "failed") return;
      update(
        prep.stage,
        clamp01(prep.overall) * ANALYSIS_SHARE,
        prep.message,
        prep.stageProgress,
      );
    }, MIRROR_INTERVAL_MS);

    let analysis: Analysis;
    try {
      analysis = await waitForAnalysis(req.sourceId);
    } finally {
      clearInterval(mirror);
    }

    throwIfCancelled();

    job.media = analysis.media;
    job.transcript = analysis.transcript;
    job.scenes = analysis.scenes;
    job.silences = analysis.silences;
    update("analyzing", ANALYSIS_SHARE, JOB_STAGE_LABELS.analyzing, 1);

    // --- Plan -----------------------------------------------------------
    let plan: EditPlan;
    if (req.plan) {
      // Caller supplied a plan (chat already produced one, or a re-render):
      // trust it, but keep the identifiers pointing at THIS job.
      plan = { ...req.plan, jobId: job.id, sourceId: req.sourceId };
    } else {
      update("planning", ANALYSIS_SHARE, JOB_STAGE_LABELS.planning);
      if (!plannerAvailable()) throw new Error(NO_PLANNER_MESSAGE);

      const messages: ChatMessage[] = [
        {
          id: "seed",
          role: "user",
          content:
            req.brief.request || "Make the best short edit of this video.",
          createdAt: Date.now(),
        },
      ];

      const turn = await runPlannerTurn({
        brief: req.brief,
        messages,
        analysis,
        jobId: job.id,
        sourceId: req.sourceId,
      });

      if (!turn.plan) throw new Error(NOT_READY_MESSAGE);
      plan = { ...turn.plan, jobId: job.id, sourceId: req.sourceId };
    }

    job.plan = plan;
    saveJob(job);
    throwIfCancelled();

    const musicPath = req.brief.musicSourceId
      ? (getSource(req.brief.musicSourceId)?.path ?? null)
      : null;

    // --- Render ---------------------------------------------------------
    await acquire();
    try {
      throwIfCancelled();
      update("rendering", RENDER_START, JOB_STAGE_LABELS.rendering);

      ensureStorageDirs();
      const workDir = path.join(PATHS.work, job.id);
      fs.mkdirSync(workDir, { recursive: true });
      const outputPath = path.join(PATHS.outputs, `${job.id}.mp4`);

      await renderPlan({
        plan,
        media: analysis.media,
        transcript: analysis.transcript,
        silences: analysis.silences,
        workDir,
        outputPath,
        musicPath,
        signal: controller.signal,
        onProgress: (fraction: number, message: string) => {
          const f = clamp01(fraction);
          update("rendering", RENDER_START + RENDER_SHARE * f, message, f);
        },
      });

      throwIfCancelled();

      job.outputPath = outputPath;
      job.outputUrl = `/api/jobs/${job.id}/output`;
      update("done", 1, "Your edit is ready", 1);
    } finally {
      release();
    }
  } catch (err) {
    if (controller.signal.aborted || err instanceof JobCancelledError) {
      job.progress = {
        stage: "cancelled",
        overall: job.progress.overall,
        stageProgress: 0,
        message: "Cancelled",
      };
      saveJob(job);
    } else {
      const message = errorMessage(err);
      console.error(`[pipeline] job ${job.id} failed:`, err);
      job.error = message;
      job.progress = {
        stage: "failed",
        overall: job.progress.overall,
        stageProgress: 0,
        message,
      };
      saveJob(job);
    }
  } finally {
    state().controllers.delete(job.id);
  }
}

// ---------------------------------------------------------------------------
// cancelJob
// ---------------------------------------------------------------------------

/**
 * Abort a running job. Returns true when something was actually cancelled —
 * false for unknown jobs and for jobs that already finished.
 */
export function cancelJob(jobId: string): boolean {
  const pipeline = state();
  let cancelled = false;

  const controller = pipeline.controllers.get(jobId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
    cancelled = true;
  }

  const job = getJob(jobId);
  if (job && !TERMINAL_STAGES.has(job.progress.stage)) {
    job.progress = {
      stage: "cancelled",
      overall: job.progress.overall,
      stageProgress: 0,
      message: "Cancelled",
    };
    saveJob(job);
    cancelled = true;
  }

  return cancelled;
}

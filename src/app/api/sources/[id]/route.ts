import { NextResponse } from "next/server";

import { getAnalysis, getPrepStatus, getSource } from "@/lib/jobs/store";
import { isPrepFailed, startPrep } from "@/lib/jobs/prep";
import type { ApiError, JobStage } from "@/lib/types";

export const runtime = "nodejs";

const TERMINAL_STAGES: ReadonlySet<JobStage> = new Set<JobStage>([
  "done",
  "failed",
  "cancelled",
]);

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;

    const source = getSource(id);
    if (!source) {
      const body: ApiError = { error: "Source not found" };
      return NextResponse.json(body, { status: 404 });
    }

    // Deliberate side effect on a GET: self-heal a stalled prep.
    //
    // Prep lives in memory. A source uploaded just before a restart keeps a
    // half-finished prep status but has no promise driving it any more, so the
    // client would poll a bar that never moves and never errors. This poll is
    // the signal that someone still cares about the source, so restart prep
    // here. `startPrep` is idempotent and returns immediately: it no-ops when
    // the analysis is already cached or a run is in flight, which is the case
    // for every request on the happy path.
    if (
      getAnalysis(id) === null &&
      isPrepFailed(id) === null &&
      !TERMINAL_STAGES.has(getPrepStatus(id).stage)
    ) {
      startPrep(id);
    }

    return NextResponse.json(
      {
        source,
        prep: getPrepStatus(id),
        prepError: isPrepFailed(id),
        analysisReady: getAnalysis(id) !== null,
      },
      { status: 200 },
    );
  } catch (err) {
    const body: ApiError = {
      error: "Could not load that source.",
      detail: String(err),
    };
    return NextResponse.json(body, { status: 500 });
  }
}

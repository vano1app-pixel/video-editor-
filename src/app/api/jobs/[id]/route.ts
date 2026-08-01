import { NextResponse } from "next/server";

import { getJob } from "@/lib/jobs/store";
import { cancelJob } from "@/lib/jobs/pipeline";
import type { ApiError, Job } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;

    const job = getJob(id);
    if (!job) {
      const body: ApiError = { error: "Job not found" };
      return NextResponse.json(body, { status: 404 });
    }

    // Strip the heavy analysis payloads: the client polls this ~every 1.2s and
    // only needs plan/progress/error/outputUrl/media.
    const light: Job = {
      ...job,
      transcript: null,
      scenes: [],
      silences: [],
    };

    return NextResponse.json({ job: light }, { status: 200 });
  } catch (err) {
    const body: ApiError = {
      error: "Could not load that job.",
      detail: String(err),
    };
    return NextResponse.json(body, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ cancelled: cancelJob(id) }, { status: 200 });
  } catch (err) {
    const body: ApiError = {
      error: "Could not cancel that job.",
      detail: String(err),
    };
    return NextResponse.json(body, { status: 500 });
  }
}

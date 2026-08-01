import { NextResponse } from "next/server";

import { getSource } from "@/lib/jobs/store";
import { createAndStartJob } from "@/lib/jobs/pipeline";
import { emptyBrief } from "@/lib/types";
import type { ApiError, CreateJobRequest, CreateJobResponse } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    let body: Partial<CreateJobRequest>;
    try {
      body = (await req.json()) as Partial<CreateJobRequest>;
    } catch (parseErr) {
      const err: ApiError = {
        error: "Request body must be valid JSON.",
        detail: String(parseErr),
      };
      return NextResponse.json(err, { status: 400 });
    }

    const sourceId = body.sourceId;
    if (typeof sourceId !== "string" || sourceId.trim() === "") {
      const err: ApiError = { error: "`sourceId` is required." };
      return NextResponse.json(err, { status: 400 });
    }

    if (!getSource(sourceId)) {
      const err: ApiError = { error: "Source not found" };
      return NextResponse.json(err, { status: 404 });
    }

    const request: CreateJobRequest = {
      sourceId,
      brief: body.brief ?? emptyBrief(),
      ...(body.plan ? { plan: body.plan } : {}),
    };

    const job = createAndStartJob(request);

    const payload: CreateJobResponse = { job };
    return NextResponse.json(payload, { status: 201 });
  } catch (err) {
    const body: ApiError = {
      error: "Could not start that render.",
      detail: String(err),
    };
    return NextResponse.json(body, { status: 500 });
  }
}

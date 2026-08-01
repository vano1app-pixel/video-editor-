import { NextResponse } from "next/server";

import { getAnalysis, getSource } from "@/lib/jobs/store";
import { isPrepFailed, startPrep } from "@/lib/jobs/prep";
import { plannerAvailable, runPlannerTurn } from "@/lib/planner";
import { emptyBrief } from "@/lib/types";
import type { ApiError, ChatRequest, ChatResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  try {
    let body: Partial<ChatRequest>;
    try {
      body = (await req.json()) as Partial<ChatRequest>;
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

    if (!Array.isArray(body.messages)) {
      const err: ApiError = { error: "`messages` must be an array." };
      return NextResponse.json(err, { status: 400 });
    }
    const messages = body.messages;

    const source = getSource(sourceId);
    if (!source) {
      const err: ApiError = { error: "Source not found" };
      return NextResponse.json(err, { status: 404 });
    }

    if (!plannerAvailable()) {
      const err: ApiError = {
        error: "EditAi isn't configured with an AI key yet.",
      };
      return NextResponse.json(err, { status: 503 });
    }

    const analysis = getAnalysis(sourceId);
    if (!analysis) {
      const prepError = isPrepFailed(sourceId);
      if (prepError) {
        const err: ApiError = {
          error: "We couldn't prepare that video.",
          detail: prepError,
        };
        return NextResponse.json(err, { status: 500 });
      }
      // Idempotent: a no-op when prep is cached or already in flight. This
      // restarts prep for a source whose run was lost to a server restart,
      // so "still_preparing" is always actually true.
      startPrep(sourceId);
      const err: ApiError = { error: "still_preparing" };
      return NextResponse.json(err, { status: 409 });
    }

    const brief = body.brief ?? emptyBrief();

    const turn = await runPlannerTurn({
      brief,
      messages,
      analysis,
      jobId: "chat",
      sourceId,
    });

    const payload: ChatResponse = { turn };
    return NextResponse.json(payload, { status: 200 });
  } catch (err) {
    const body: ApiError = {
      error: "The planner couldn't answer that.",
      detail: String(err),
    };
    return NextResponse.json(body, { status: 500 });
  }
}

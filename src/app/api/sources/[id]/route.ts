import { NextResponse } from "next/server";

import { getAnalysis, getPrepStatus, getSource } from "@/lib/jobs/store";
import { isPrepFailed } from "@/lib/jobs/prep";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";

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

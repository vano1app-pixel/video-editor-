import { NextResponse } from "next/server";

import { listVideos } from "@/lib/drive/client";
import { getValidAccessToken } from "@/lib/drive/oauth";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";

/**
 * One page of the user's Drive videos, newest first.
 * `?q=` filters by name, `?pageToken=` walks the pages.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const accessToken = await getValidAccessToken();
    if (accessToken === null) {
      const body: ApiError = { error: "not_connected" };
      return NextResponse.json(body, { status: 401 });
    }

    const params = new URL(req.url).searchParams;
    const query = params.get("q");
    const pageToken = params.get("pageToken");
    const pageSizeRaw = params.get("pageSize");
    const pageSize =
      pageSizeRaw === null ? Number.NaN : Number.parseInt(pageSizeRaw, 10);

    const result = await listVideos(accessToken, {
      query: query ?? undefined,
      pageToken: pageToken ?? undefined,
      pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const body: ApiError = {
      error: "Couldn't list your Google Drive videos.",
      detail: String(err),
    };
    return NextResponse.json(body, { status: 500 });
  }
}

import fs from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";

import { getJob } from "@/lib/jobs/store";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Serve a file with HTTP Range support so <video> scrubbing works.
 * Deliberately duplicated in the source-file route: API routes must not import
 * from one another.
 */
async function rangeResponse(
  filePath: string,
  rangeHeader: string | null,
  contentType: string,
): Promise<Response> {
  const stat = await fs.promises.stat(filePath);
  const size = stat.size;

  if (!rangeHeader) {
    const stream = Readable.toWeb(fs.createReadStream(filePath));
    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  const startRaw = match ? match[1] : "";
  const endRaw = match ? match[2] : "";

  const start = startRaw === "" ? Number.NaN : Number.parseInt(startRaw, 10);
  const parsedEnd = endRaw === "" ? size - 1 : Number.parseInt(endRaw, 10);
  const end = Number.isNaN(parsedEnd) ? size - 1 : Math.min(parsedEnd, size - 1);

  if (!match || Number.isNaN(start) || start >= size || end < start) {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${size}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
  return new Response(stream as unknown as ReadableStream, {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;

    const job = getJob(id);
    if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
      const body: ApiError = { error: "Render not ready" };
      return NextResponse.json(body, { status: 404 });
    }

    const res = await rangeResponse(
      job.outputPath,
      req.headers.get("range"),
      "video/mp4",
    );
    res.headers.set(
      "Content-Disposition",
      `inline; filename="editai-${id}.mp4"`,
    );
    return res;
  } catch (err) {
    const body: ApiError = {
      error: "Could not stream the render.",
      detail: String(err),
    };
    return NextResponse.json(body, { status: 500 });
  }
}

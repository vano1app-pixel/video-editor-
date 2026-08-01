import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";

import { getSource } from "@/lib/jobs/store";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Serve a file with HTTP Range support so <video> scrubbing works.
 * Deliberately duplicated in the job-output route: API routes must not import
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

    const source = getSource(id);
    if (!source) {
      const body: ApiError = { error: "Source not found" };
      return NextResponse.json(body, { status: 404 });
    }

    if (!fs.existsSync(source.path)) {
      const body: ApiError = {
        error: "Source file is no longer on disk.",
        detail: source.path,
      };
      return NextResponse.json(body, { status: 404 });
    }

    return await rangeResponse(
      source.path,
      req.headers.get("range"),
      contentTypeFor(source.path),
    );
  } catch (err) {
    const body: ApiError = {
      error: "Could not stream that file.",
      detail: String(err),
    };
    return NextResponse.json(body, { status: 500 });
  }
}

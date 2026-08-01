import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";
import { nanoid } from "nanoid";

import {
  ALLOWED_VIDEO_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  PATHS,
  ensureStorageDirs,
} from "@/lib/config";
import { saveSource } from "@/lib/jobs/store";
import { startPrep } from "@/lib/jobs/prep";
import type { ApiError, Source, UploadResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const ALLOWED_AUDIO_EXTENSIONS = [
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".ogg",
  ".opus",
  ".flac",
];

const TOO_LARGE = "TOO_LARGE";

/** Strip anything that is not a word char, dot, dash or space; cap the length. */
function sanitizeFilename(raw: string): string {
  const base = path.basename(raw).replace(/[^\w.\- ]/g, "_").trim();
  const safe = base.length > 0 ? base : "upload";
  return safe.length > 120 ? safe.slice(safe.length - 120) : safe;
}

/** A pass-through that aborts the pipeline once the byte budget is blown. */
function byteCounter(limit: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer | string, _enc, callback): void {
      const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      total += len;
      if (total > limit) {
        callback(new Error(TOO_LARGE));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function unlinkQuiet(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // The file may never have been created; nothing to clean up.
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const filenameParam = url.searchParams.get("filename");
    const kindParam = url.searchParams.get("kind") ?? "video";

    if (!filenameParam || filenameParam.trim() === "") {
      const body: ApiError = {
        error: "Missing `filename` query parameter.",
      };
      return NextResponse.json(body, { status: 400 });
    }

    if (kindParam !== "video" && kindParam !== "audio") {
      const body: ApiError = {
        error: "`kind` must be either \"video\" or \"audio\".",
      };
      return NextResponse.json(body, { status: 400 });
    }
    const kind: "video" | "audio" = kindParam;

    const originalName = sanitizeFilename(filenameParam);
    const ext = path.extname(originalName).toLowerCase();
    const allowed =
      kind === "video" ? ALLOWED_VIDEO_EXTENSIONS : ALLOWED_AUDIO_EXTENSIONS;

    if (!ext || !allowed.includes(ext)) {
      const body: ApiError = {
        error:
          kind === "video"
            ? `That file type isn't supported. Try one of: ${ALLOWED_VIDEO_EXTENSIONS.join(", ")}.`
            : `That audio type isn't supported. Try one of: ${ALLOWED_AUDIO_EXTENSIONS.join(", ")}.`,
        detail: ext ? `Unsupported extension "${ext}".` : "File has no extension.",
      };
      return NextResponse.json(body, { status: 415 });
    }

    if (!req.body) {
      const body: ApiError = {
        error: "Request had no body — nothing to upload.",
      };
      return NextResponse.json(body, { status: 400 });
    }

    ensureStorageDirs();

    const id = nanoid(10);
    const dest = path.join(PATHS.uploads, `${id}${ext}`);

    const nodeStream = Readable.fromWeb(req.body as never);
    const counter = byteCounter(MAX_UPLOAD_BYTES);

    try {
      await pipeline(nodeStream, counter, fs.createWriteStream(dest));
    } catch (streamErr) {
      await unlinkQuiet(dest);
      if (streamErr instanceof Error && streamErr.message === TOO_LARGE) {
        const body: ApiError = {
          error: `That file is larger than the ${Math.round(
            MAX_UPLOAD_BYTES / (1024 * 1024),
          )} MB limit.`,
        };
        return NextResponse.json(body, { status: 413 });
      }
      throw streamErr;
    }

    const stat = await fs.promises.stat(dest);

    const source: Source = {
      id,
      origin: "upload",
      originalName,
      path: dest,
      sizeBytes: stat.size,
      createdAt: Date.now(),
      media: null,
      url: `/api/sources/${id}/file`,
    };

    saveSource(source);

    if (kind === "video") {
      startPrep(id);
    }

    const payload: UploadResponse = { source };
    return NextResponse.json(payload, { status: 201 });
  } catch (err) {
    const body: ApiError = {
      error: "Upload failed.",
      detail: String(err),
    };
    return NextResponse.json(body, { status: 500 });
  }
}

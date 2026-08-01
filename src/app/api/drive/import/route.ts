import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";
import { nanoid } from "nanoid";

import {
  ALLOWED_VIDEO_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  PATHS,
  ensureStorageDirs,
} from "@/lib/config";
import { downloadFile } from "@/lib/drive/client";
import { getValidAccessToken } from "@/lib/drive/oauth";
import { startPrep } from "@/lib/jobs/prep";
import { saveSource } from "@/lib/jobs/store";
import type { ApiError, Source, UploadResponse } from "@/lib/types";

export const runtime = "nodejs";
/** A multi-gigabyte Drive file can take minutes to pull down. */
export const maxDuration = 300;

const FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const META_FIELDS =
  "id,name,mimeType,size,modifiedTime,thumbnailLink,videoMediaMetadata(durationMillis)";
const RETRY_DELAYS_MS = [500, 1500];

const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

interface DriveMeta {
  name: string;
  mimeType: string;
  sizeBytes: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max = 300): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Mirrors the sanitiser in /api/upload so both origins name files the same way. */
function sanitizeFilename(raw: string): string {
  const base = path.basename(raw).replace(/[^\w.\- ]/g, "_").trim();
  const safe = base.length > 0 ? base : "drive-video";
  return safe.length > 120 ? safe.slice(safe.length - 120) : safe;
}

/**
 * Drive names are arbitrary; keep a recognised video extension and otherwise
 * fall back to .mp4 so ffmpeg (and the /file route's content type) behave.
 */
function extensionFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ALLOWED_VIDEO_EXTENSIONS.includes(ext) ? ext : ".mp4";
}

async function unlinkQuiet(filePath: string): Promise<void> {
  await fs.promises.unlink(filePath).catch(() => undefined);
}

/**
 * files.get for one id. Returns null when Drive says the file is gone, so the
 * caller can answer 404 rather than a generic failure. Retries 429/5xx twice.
 */
async function fetchMeta(
  accessToken: string,
  fileId: string,
): Promise<DriveMeta | null> {
  const params = new URLSearchParams({
    fields: META_FIELDS,
    supportsAllDrives: "true",
  });
  const url = `${FILES_ENDPOINT}/${encodeURIComponent(fileId)}?${params.toString()}`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      });
    } catch (err) {
      lastError = new Error(`Google Drive request failed: ${String(err)}`);
      continue;
    }

    if (res.status === 404) return null;

    if (res.ok) {
      const body = (await res.json()) as unknown;
      if (!isRecord(body)) {
        throw new Error("Google Drive returned unexpected file metadata.");
      }
      const rawSize = body.size;
      const size =
        typeof rawSize === "number"
          ? rawSize
          : typeof rawSize === "string" && rawSize.trim() !== ""
            ? Number(rawSize)
            : Number.NaN;
      return {
        name:
          typeof body.name === "string" && body.name.trim() !== ""
            ? body.name
            : "drive-video.mp4",
        mimeType: typeof body.mimeType === "string" ? body.mimeType : "",
        sizeBytes: Number.isFinite(size) && size >= 0 ? size : null,
      };
    }

    const detail = truncate(await res.text().catch(() => ""));
    const failure = new Error(
      `Google Drive request failed (${res.status}): ${detail}`,
    );
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      lastError = failure;
      continue;
    }
    throw failure;
  }

  throw lastError ?? new Error("Google Drive request failed.");
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

/**
 * Pull one Drive file into local storage and register it as a Source, exactly
 * as an upload would — same id scheme, same uploads directory, same prep kick.
 */
export async function POST(req: Request): Promise<Response> {
  let dest: string | null = null;

  try {
    let fileId = "";
    try {
      const parsed = (await req.json()) as unknown;
      if (isRecord(parsed) && typeof parsed.fileId === "string") {
        fileId = parsed.fileId.trim();
      }
    } catch {
      // Malformed JSON is reported as a missing fileId below.
    }

    if (fileId === "") {
      const body: ApiError = { error: "Missing `fileId` in the request body." };
      return NextResponse.json(body, { status: 400 });
    }

    const accessToken = await getValidAccessToken();
    if (accessToken === null) {
      const body: ApiError = { error: "not_connected" };
      return NextResponse.json(body, { status: 401 });
    }

    const meta = await fetchMeta(accessToken, fileId);
    if (meta === null) {
      const body: ApiError = {
        error: "That file isn't in your Google Drive any more.",
      };
      return NextResponse.json(body, { status: 404 });
    }

    if (meta.sizeBytes !== null && meta.sizeBytes > MAX_UPLOAD_BYTES) {
      const body: ApiError = {
        error: `That video is larger than the ${MAX_UPLOAD_MB} MB limit.`,
        detail: `${meta.name} is ${Math.round(meta.sizeBytes / (1024 * 1024))} MB.`,
      };
      return NextResponse.json(body, { status: 413 });
    }

    const originalName = sanitizeFilename(meta.name);
    const id = nanoid(10);

    ensureStorageDirs();
    dest = path.join(PATHS.uploads, `${id}${extensionFor(originalName)}`);

    await downloadFile(accessToken, fileId, dest);

    const stat = await fs.promises.stat(dest);

    // Drive omits `size` for a few file types; the transferred bytes are the
    // last word on whether this fits.
    if (stat.size > MAX_UPLOAD_BYTES) {
      await unlinkQuiet(dest);
      dest = null;
      const body: ApiError = {
        error: `That video is larger than the ${MAX_UPLOAD_MB} MB limit.`,
      };
      return NextResponse.json(body, { status: 413 });
    }

    const source: Source = {
      id,
      origin: "drive",
      originalName,
      path: dest,
      sizeBytes: stat.size,
      createdAt: Date.now(),
      media: null,
      url: `/api/sources/${id}/file`,
    };

    saveSource(source);
    startPrep(id);

    const payload: UploadResponse = { source };
    return NextResponse.json(payload, { status: 201 });
  } catch (err) {
    if (dest !== null) await unlinkQuiet(dest);
    console.error("[drive] import failed:", err);
    const body: ApiError = {
      error: "Couldn't import that video from Google Drive.",
      detail: String(err),
    };
    return NextResponse.json(body, { status: 500 });
  }
}

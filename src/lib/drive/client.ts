import fs from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Google Drive REST calls, over plain fetch.
 *
 * Two operations are all EditAi needs: list the user's videos, and stream one
 * to disk. Downloads are piped straight to a file — a 2 GB source must never be
 * buffered in memory — and a failed transfer leaves no partial file behind.
 */

const FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";

/** Everything the picker and the importer need, and nothing else. */
const LIST_FIELDS =
  "nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink,videoMediaMetadata(durationMillis))";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/** Backoff for retryable (429/5xx/network) Drive requests. */
const RETRY_DELAYS_MS = [500, 1500];

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Drive reports size as a string; null for files that have no byte size. */
  sizeBytes: number | null;
  modifiedTime: string;
  thumbnailLink: string | null;
  durationMillis: number | null;
}

/** Not exported: the public surface here is DriveFile, listVideos, downloadFile. */
interface ListVideosOptions {
  query?: string;
  pageToken?: string;
  pageSize?: number;
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

/**
 * Escape a value for a Drive `q` string literal. Drive uses backslash escaping
 * inside single-quoted terms, so a backslash must be doubled before quotes are
 * escaped — otherwise `\'` typed by the user would close the literal.
 */
function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toDriveFile(raw: unknown): DriveFile | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id === "") return null;

  const meta = isRecord(raw.videoMediaMetadata) ? raw.videoMediaMetadata : null;

  return {
    id: raw.id,
    name:
      typeof raw.name === "string" && raw.name.trim() !== ""
        ? raw.name
        : "Untitled video",
    mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "video/mp4",
    sizeBytes: toNumber(raw.size),
    modifiedTime: typeof raw.modifiedTime === "string" ? raw.modifiedTime : "",
    thumbnailLink:
      typeof raw.thumbnailLink === "string" && raw.thumbnailLink !== ""
        ? raw.thumbnailLink
        : null,
    durationMillis: meta === null ? null : toNumber(meta.durationMillis),
  };
}

/**
 * Authorised GET with retries on 429/5xx and transport errors. Returns the
 * response with its body untouched, so callers can stream it.
 */
async function driveFetch(url: string, accessToken: string): Promise<Response> {
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

    if (res.ok) return res;

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
// listVideos
// ---------------------------------------------------------------------------

/** Newest-first page of the user's videos, optionally filtered by name. */
export async function listVideos(
  accessToken: string,
  opts: ListVideosOptions = {},
): Promise<{ files: DriveFile[]; nextPageToken: string | null }> {
  const clauses = ["mimeType contains 'video/'", "trashed = false"];

  const query = typeof opts.query === "string" ? opts.query.trim() : "";
  if (query !== "") {
    clauses.push(`name contains '${escapeQueryValue(query)}'`);
  }

  const requested =
    typeof opts.pageSize === "number" && Number.isFinite(opts.pageSize)
      ? Math.floor(opts.pageSize)
      : DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requested));

  const params = new URLSearchParams({
    q: clauses.join(" and "),
    orderBy: "modifiedTime desc",
    pageSize: String(pageSize),
    fields: LIST_FIELDS,
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (typeof opts.pageToken === "string" && opts.pageToken !== "") {
    params.set("pageToken", opts.pageToken);
  }

  const res = await driveFetch(`${FILES_ENDPOINT}?${params.toString()}`, accessToken);
  const body = (await res.json()) as unknown;
  if (!isRecord(body)) {
    throw new Error("Google Drive returned an unexpected listing.");
  }

  const rawFiles = Array.isArray(body.files) ? body.files : [];
  const files: DriveFile[] = [];
  for (const raw of rawFiles) {
    const file = toDriveFile(raw);
    if (file !== null) files.push(file);
  }

  return {
    files,
    nextPageToken:
      typeof body.nextPageToken === "string" && body.nextPageToken !== ""
        ? body.nextPageToken
        : null,
  };
}

// ---------------------------------------------------------------------------
// downloadFile
// ---------------------------------------------------------------------------

/**
 * Stream a Drive file to `destPath`. `onProgress` is called with the running
 * byte count and the total when Drive sends a content-length (it usually does).
 * A failed transfer deletes the partial file before rethrowing.
 */
export async function downloadFile(
  accessToken: string,
  fileId: string,
  destPath: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<void> {
  const url = `${FILES_ENDPOINT}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const res = await driveFetch(url, accessToken);

  if (!res.body) {
    throw new Error("Google Drive returned an empty response body.");
  }

  const header = res.headers.get("content-length");
  const parsedTotal = header === null ? Number.NaN : Number(header);
  const total =
    Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : null;

  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer | string, _enc, callback): void {
      const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      received += len;
      if (onProgress) {
        try {
          onProgress(received, total);
        } catch {
          // A broken progress listener must never abort a good download.
        }
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body as never),
      counter,
      fs.createWriteStream(destPath),
    );
  } catch (err) {
    await fs.promises.unlink(destPath).catch(() => undefined);
    throw err;
  }
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";

import type { ApiError, Source, UploadResponse } from "@/lib/types";

/**
 * Google Drive picker.
 *
 * Three states, decided by GET /api/drive/status: not configured (show the
 * console checklist), configured but not connected (one button to consent), or
 * connected (search + import). Everything Drive-shaped is fetched through our
 * own API routes — the browser never sees a Google access token.
 */

/**
 * Mirrors `DriveFile` in "@/lib/drive/client". That module imports node:fs, so
 * it can never be pulled into a client bundle; the shape is restated here and
 * comes straight off /api/drive/files.
 */
interface DriveVideo {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  modifiedTime: string;
  thumbnailLink: string | null;
  durationMillis: number | null;
}

interface DriveStatus {
  configured: boolean;
  connected: boolean;
}

interface DriveFilesPayload {
  files: DriveVideo[];
  nextPageToken: string | null;
}

type PickerPhase = "checking" | "unconfigured" | "disconnected" | "connected";

const SEARCH_DEBOUNCE_MS = 400;

const CONNECT_ERROR_REASONS: Record<string, string> = {
  denied: "You cancelled the Google sign-in. Nothing was connected.",
  state: "That sign-in link expired. Start the connection again.",
  no_code: "Google didn't send back an authorisation code. Try once more.",
  exchange: "Google rejected the sign-in. Check your client ID and secret.",
};

export interface DrivePickerProps {
  /** Called once a Drive file has landed on disk as a Source. */
  onImported: (source: Source) => void;
  /** Dismiss the picker. */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatDuration(millis: number | null): string | null {
  if (millis === null || !Number.isFinite(millis) || millis <= 0) return null;
  const totalSeconds = Math.round(millis / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function metaLine(file: DriveVideo): string {
  const parts = [formatSize(file.sizeBytes), formatDuration(file.durationMillis)];
  const shown = parts.filter((part): part is string => part !== null);
  return shown.length > 0 ? shown.join(" · ") : "Video";
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as Partial<ApiError>;
    if (typeof body.error === "string" && body.error.trim() !== "") {
      return body.error;
    }
  } catch {
    // Non-JSON error body — use the caller's wording.
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function DriveIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="h-5 w-5">
      <path d="M8.4 3h7.2l6.4 11.1-3.6 6.2-3.6-6.2H4.8L8.4 3Z" opacity={0.55} />
      <path d="m2 17.3 3.6-6.2h7.2l-3.6 6.2H2Z" />
    </svg>
  );
}

function FilmIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M7 5v14M17 5v14M2.5 12h19M2.5 8.5h4.5M2.5 15.5h4.5M17 8.5h4.5M17 15.5h4.5" />
    </svg>
  );
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
      className="h-4 w-4"
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  );
}

function XIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      className="h-4 w-4"
    >
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </svg>
  );
}

function Spinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={clsx("animate-spin", className ?? "h-4 w-4")}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={2.5} opacity={0.25} />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DrivePicker({
  onImported,
  onClose,
}: DrivePickerProps): React.JSX.Element {
  const [phase, setPhase] = useState<PickerPhase>("checking");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [connectNotice, setConnectNotice] = useState<string | null>(null);
  const [redirectUri, setRedirectUri] = useState(
    "http://localhost:3000/api/drive/callback",
  );

  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");

  const [files, setFiles] = useState<DriveVideo[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  /** Starts true: the first page request fires the moment we know we're connected. */
  const [listing, setListing] = useState(true);
  const [brokenThumbs, setBrokenThumbs] = useState<string[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [importingId, setImportingId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  /** Guards against a slow search response overwriting a newer one. */
  const listSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // --- Status --------------------------------------------------------------

  const checkStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const res = await fetch("/api/drive/status", { cache: "no-store" });
      if (!res.ok) {
        if (!mountedRef.current) return;
        setStatusError(
          await readError(res, `Couldn't reach Google Drive (error ${res.status}).`),
        );
        setPhase("disconnected");
        return;
      }
      const data = (await res.json()) as Partial<DriveStatus>;
      if (!mountedRef.current) return;
      if (data.configured !== true) {
        setPhase("unconfigured");
        return;
      }
      setPhase(data.connected === true ? "connected" : "disconnected");
    } catch {
      if (!mountedRef.current) return;
      setStatusError("EditAi couldn't be reached. Check your connection.");
      setPhase("disconnected");
    }
  }, []);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  // Surface the reason when the OAuth round trip bounced back with an error,
  // and show the real callback URL for the console checklist.
  useEffect(() => {
    setRedirectUri(`${window.location.origin}/api/drive/callback`);
    const params = new URLSearchParams(window.location.search);
    if (params.get("drive") !== "error") return;
    const reason = params.get("reason") ?? "";
    setConnectNotice(
      CONNECT_ERROR_REASONS[reason] ??
        "That Google Drive connection didn't finish. Try again.",
    );
  }, []);

  // --- Listing -------------------------------------------------------------

  const fetchPage = useCallback(
    async (search: string, pageToken: string | null) => {
      const seq = listSeqRef.current + 1;
      listSeqRef.current = seq;

      if (pageToken === null) setListing(true);
      else setLoadingMore(true);
      setListError(null);

      try {
        const params = new URLSearchParams();
        if (search.trim() !== "") params.set("q", search.trim());
        if (pageToken !== null) params.set("pageToken", pageToken);
        const qs = params.toString();

        const res = await fetch(`/api/drive/files${qs === "" ? "" : `?${qs}`}`, {
          cache: "no-store",
        });

        if (!mountedRef.current || listSeqRef.current !== seq) return;

        if (res.status === 401) {
          setPhase("disconnected");
          setFiles([]);
          setNextPageToken(null);
          setConnectNotice(
            "Your Google Drive connection expired. Connect again to keep browsing.",
          );
          return;
        }

        if (!res.ok) {
          setListError(
            await readError(res, `Couldn't load your Drive videos (error ${res.status}).`),
          );
          return;
        }

        const data = (await res.json()) as Partial<DriveFilesPayload>;
        if (!mountedRef.current || listSeqRef.current !== seq) return;

        const page = Array.isArray(data.files) ? data.files : [];
        setFiles((prev) => (pageToken === null ? page : [...prev, ...page]));
        setNextPageToken(
          typeof data.nextPageToken === "string" && data.nextPageToken !== ""
            ? data.nextPageToken
            : null,
        );
      } catch {
        if (!mountedRef.current || listSeqRef.current !== seq) return;
        setListError("EditAi couldn't be reached. Check your connection.");
      } finally {
        if (mountedRef.current && listSeqRef.current === seq) {
          setListing(false);
          setLoadingMore(false);
        }
      }
    },
    [],
  );

  // Debounce the search box so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(rawQuery);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [rawQuery]);

  useEffect(() => {
    if (phase !== "connected") return;
    void fetchPage(query, null);
  }, [phase, query, fetchPage]);

  // --- Import --------------------------------------------------------------

  const importFile = useCallback(
    async (file: DriveVideo) => {
      if (importingId !== null) return;
      setImportingId(file.id);
      setImportError(null);

      try {
        const res = await fetch("/api/drive/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId: file.id }),
        });

        if (res.status === 401) {
          if (!mountedRef.current) return;
          setPhase("disconnected");
          setConnectNotice(
            "Your Google Drive connection expired. Connect again to import.",
          );
          return;
        }

        if (!res.ok) {
          if (!mountedRef.current) return;
          setImportError(
            await readError(
              res,
              `Couldn't import ${file.name} (error ${res.status}).`,
            ),
          );
          return;
        }

        const data = (await res.json()) as Partial<UploadResponse>;
        if (!data.source) {
          if (!mountedRef.current) return;
          setImportError("EditAi couldn't read the server's reply. Try again.");
          return;
        }
        onImported(data.source);
      } catch {
        if (!mountedRef.current) return;
        setImportError(
          "The import didn't finish — check your connection and try again.",
        );
      } finally {
        if (mountedRef.current) setImportingId(null);
      }
    },
    [importingId, onImported],
  );

  // --- Chrome --------------------------------------------------------------

  const header = (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <DriveIcon />
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold sm:text-lg">
            Google Drive
          </h2>
          <p className="truncate text-xs text-muted">
            Import a video straight from your Drive
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close Google Drive"
        className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
      >
        <XIcon />
      </button>
    </div>
  );

  const shell = (children: React.ReactNode): React.JSX.Element => (
    <section
      aria-label="Google Drive"
      className="w-full rounded-2xl border border-line bg-panel p-4 sm:p-5"
    >
      {header}
      <div className="mt-4">{children}</div>
    </section>
  );

  // --- Checking ------------------------------------------------------------

  if (phase === "checking") {
    return shell(
      <p className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
        <Spinner />
        Checking your Google Drive connection…
      </p>,
    );
  }

  // --- Not configured ------------------------------------------------------

  if (phase === "unconfigured") {
    return shell(
      <div>
        <p className="text-sm font-semibold">Google Drive isn&apos;t set up yet</p>
        <p className="mt-1 text-sm text-muted">
          It takes about five minutes in the Google Cloud console:
        </p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted marker:text-accent">
          <li>
            Create (or open) a project at{" "}
            <span className="text-fg">console.cloud.google.com</span>.
          </li>
          <li>
            Enable the <span className="text-fg">Google Drive API</span> for that
            project.
          </li>
          <li>
            Configure the OAuth consent screen and add yourself as a test user.
          </li>
          <li>
            Create an <span className="text-fg">OAuth client ID</span> of type
            &ldquo;Web application&rdquo; with the redirect URI{" "}
            <code className="break-all rounded bg-white/[0.06] px-1.5 py-0.5 text-xs text-fg">
              {redirectUri}
            </code>
            .
          </li>
          <li>
            Put the credentials in <span className="text-fg">.env</span> as{" "}
            <code className="rounded bg-white/[0.06] px-1.5 py-0.5 text-xs text-fg">
              GOOGLE_CLIENT_ID
            </code>{" "}
            and{" "}
            <code className="rounded bg-white/[0.06] px-1.5 py-0.5 text-xs text-fg">
              GOOGLE_CLIENT_SECRET
            </code>
            , then restart EditAi.
          </li>
        </ol>
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] rounded-full border border-line px-5 text-sm font-medium text-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => {
              setPhase("checking");
              void checkStatus();
            }}
            className="min-h-[44px] rounded-full px-5 text-sm font-medium text-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
          >
            I&apos;ve done this — check again
          </button>
        </div>
      </div>,
    );
  }

  // --- Configured, not connected -------------------------------------------

  if (phase === "disconnected") {
    return shell(
      <div>
        <p className="text-sm text-muted">
          EditAi reads your Drive to list videos. It never changes or deletes
          anything.
        </p>
        {connectNotice !== null ? (
          <p className="mt-3 text-sm text-danger" role="status">
            {connectNotice}
          </p>
        ) : null}
        {statusError !== null ? (
          <p className="mt-3 text-sm text-danger" role="status">
            {statusError}
          </p>
        ) : null}
        <a
          href="/api/drive/auth"
          className="mt-4 inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-full bg-accent px-6 text-base font-semibold text-white transition-colors duration-200 hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel sm:w-auto"
        >
          <DriveIcon />
          Connect Google Drive
        </a>
      </div>,
    );
  }

  // --- Connected -----------------------------------------------------------

  const busy = importingId !== null;

  return shell(
    <div>
      <label htmlFor="drive-search" className="sr-only">
        Search your Drive videos
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
          <SearchIcon />
        </span>
        <input
          id="drive-search"
          type="search"
          value={rawQuery}
          onChange={(event) => setRawQuery(event.target.value)}
          placeholder="Search your videos"
          autoComplete="off"
          className="min-h-[44px] w-full rounded-xl border border-line bg-white/[0.03] pl-9 pr-3 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
        />
      </div>

      {listError !== null ? (
        <p className="mt-3 text-sm text-danger" role="status">
          {listError}
        </p>
      ) : null}
      {importError !== null ? (
        <p className="mt-3 text-sm text-danger" role="status">
          {importError}
        </p>
      ) : null}

      {listing ? (
        <p
          className="flex items-center gap-2 py-8 text-sm text-muted"
          role="status"
        >
          <Spinner />
          Looking through your Drive…
        </p>
      ) : files.length === 0 ? (
        <p className="py-8 text-sm text-muted">
          {query.trim() === ""
            ? "No videos in your Drive yet."
            : `No videos match “${query.trim()}”.`}
        </p>
      ) : (
        <ul className="scrollbar-thin mt-3 max-h-[min(60vh,420px)] space-y-1 overflow-y-auto pr-1">
          {files.map((file) => {
            const active = importingId === file.id;
            return (
              <li key={file.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void importFile(file);
                  }}
                  className={clsx(
                    "flex min-h-[60px] w-full items-center gap-3 rounded-xl border border-transparent px-2 py-2 text-left transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel",
                    busy && !active
                      ? "opacity-45"
                      : "hover:border-line hover:bg-white/[0.05]",
                  )}
                >
                  <span className="flex h-11 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-black text-muted">
                    {file.thumbnailLink !== null &&
                    !brokenThumbs.includes(file.id) ? (
                      // Drive thumbnails are short-lived signed URLs on Google's
                      // CDN — next/image would need a remote host allow-list.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={file.thumbnailLink}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                        onError={() => {
                          setBrokenThumbs((prev) =>
                            prev.includes(file.id) ? prev : [...prev, file.id],
                          );
                        }}
                      />
                    ) : (
                      <FilmIcon />
                    )}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">
                      {file.name}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted tabular-nums">
                      {metaLine(file)}
                    </span>
                  </span>

                  {active ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-accent">
                      <Spinner className="h-3.5 w-3.5" />
                      Importing…
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {nextPageToken !== null && !listing ? (
        <button
          type="button"
          disabled={loadingMore || busy}
          onClick={() => {
            void fetchPage(query, nextPageToken);
          }}
          className="mt-3 min-h-[44px] w-full rounded-full border border-line px-5 text-sm font-medium text-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}

      <p className="mt-3 text-xs text-muted">
        Big files take a moment — EditAi copies the video before it starts
        editing.
      </p>
    </div>,
  );
}

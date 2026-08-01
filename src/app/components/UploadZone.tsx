"use client";

import { useCallback, useRef, useState } from "react";
import clsx from "clsx";

import ProgressBar from "./ProgressBar";

/**
 * Kept in sync with ALLOWED_VIDEO_EXTENSIONS in "@/lib/config". That module
 * touches node:fs, so it can never be imported into a client component — the
 * list is mirrored here and validated again server-side on upload.
 */
const ACCEPTED_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".avi",
  ".mpg",
  ".mpeg",
  ".wmv",
  ".flv",
  ".3gp",
];

const ACCEPT_ATTR = `video/*,${ACCEPTED_EXTENSIONS.join(",")}`;

export type UploadZoneStatus = "idle" | "uploading" | "error";

export interface UploadZoneProps {
  status: UploadZoneStatus;
  /** Name of the file currently uploading or the one that failed. */
  fileName: string | null;
  loadedBytes: number;
  totalBytes: number;
  errorMessage: string | null;
  onFileSelected: (file: File) => void;
  /** Re-runs the last upload. */
  onRetry: () => void;
  /** Clears the error and returns to the drop target. */
  onDismissError: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function UploadArrowIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-7 w-7"
    >
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

export default function UploadZone({
  status,
  fileName,
  loadedBytes,
  totalBytes,
  errorMessage,
  onFileSelected,
  onRetry,
  onDismissError,
}: UploadZoneProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [driveNote, setDriveNote] = useState(false);

  const accept = useCallback(
    (file: File | undefined | null) => {
      if (!file) return;
      if (!hasAcceptedExtension(file.name)) {
        setLocalError(
          `${file.name} isn't a video EditAi can open. Try MP4, MOV, WEBM or MKV.`,
        );
        return;
      }
      setLocalError(null);
      onFileSelected(file);
    },
    [onFileSelected],
  );

  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  // --- Uploading -----------------------------------------------------------
  if (status === "uploading") {
    const fraction = totalBytes > 0 ? loadedBytes / totalBytes : 0;
    const pct = Math.min(100, Math.round(fraction * 100));
    return (
      <div className="flex min-h-[320px] w-full flex-col items-center justify-center gap-5 rounded-3xl border border-line bg-panel px-6 py-10 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-accent">
          <UploadArrowIcon />
        </div>
        <div className="w-full max-w-md">
          <p className="text-2xl font-semibold tabular-nums">{pct}%</p>
          <p className="mt-1 truncate text-sm text-muted">
            {fileName ?? "Uploading your video"}
          </p>
          <ProgressBar
            value={fraction}
            size="md"
            label="Upload progress"
            className="mt-4"
          />
          <p className="mt-3 text-sm text-muted tabular-nums">
            {formatBytes(loadedBytes)} of {formatBytes(totalBytes)}
          </p>
        </div>
        <p className="text-sm text-muted">
          Hang tight — you can describe your edit as soon as this lands.
        </p>
      </div>
    );
  }

  // --- Failed --------------------------------------------------------------
  if (status === "error") {
    return (
      <div className="flex min-h-[320px] w-full flex-col items-center justify-center gap-5 rounded-3xl border border-danger/30 bg-danger/[0.07] px-6 py-10 text-center">
        <h2 className="text-xl font-semibold">That upload didn&apos;t finish</h2>
        <p className="max-w-md text-sm text-muted">
          {errorMessage ?? "Something went wrong on the way up. Give it another go."}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={onRetry}
            className="min-h-[48px] rounded-full bg-accent px-6 text-base font-semibold text-white transition-colors duration-200 hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => {
              setLocalError(null);
              onDismissError();
            }}
            className="min-h-[48px] rounded-full border border-line px-6 text-base font-medium text-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
          >
            Pick another video
          </button>
        </div>
      </div>
    );
  }

  // --- Idle drop target ----------------------------------------------------
  return (
    <div className="w-full">
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop a video here or click to browse"
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openPicker();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          accept(event.dataTransfer.files.item(0));
        }}
        className={clsx(
          "flex min-h-[320px] w-full cursor-pointer flex-col items-center justify-center gap-4 rounded-3xl border-2 border-dashed px-6 py-12 text-center transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink",
          dragging
            ? "border-accent bg-accent/[0.12]"
            : "border-white/15 bg-panel hover:border-accent/60 hover:bg-panel-2",
        )}
      >
        <div
          className={clsx(
            "flex h-16 w-16 items-center justify-center rounded-2xl transition-colors duration-200",
            dragging ? "bg-accent text-white" : "bg-accent/15 text-accent",
          )}
        >
          <UploadArrowIcon />
        </div>
        <p className="text-xl font-semibold sm:text-2xl">
          {dragging ? "Drop it right here" : "Drop your video here"}
        </p>
        <p className="text-sm text-muted sm:text-base">
          or{" "}
          <span className="font-medium text-accent underline underline-offset-4">
            click to browse
          </span>
        </p>
        <p className="mt-1 max-w-sm text-xs text-muted">
          MP4, MOV, M4V, WEBM, MKV, AVI, MPG, WMV, FLV, 3GP — up to 2 GB
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(event) => {
            accept(event.target.files?.item(0));
            // Allow re-picking the same file after an error.
            event.target.value = "";
          }}
        />
      </div>

      {localError !== null ? (
        <p className="mt-3 text-center text-sm text-danger">{localError}</p>
      ) : null}

      <div className="mt-5 flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={() => setDriveNote(true)}
          className="min-h-[44px] rounded-full border border-line px-5 text-sm font-medium text-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
        >
          Connect Google Drive
        </button>
        {driveNote ? (
          <p className="text-xs text-muted" role="status">
            Coming soon — drag and drop works today
          </p>
        ) : null}
      </div>
    </div>
  );
}

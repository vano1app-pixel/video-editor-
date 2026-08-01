"use client";

import type { Job } from "@/lib/types";

export interface ResultPlayerProps {
  job: Job;
  /** Keeps the same video, clears the conversation and plan. */
  onAnother: () => void;
  /** Full reset back to the drop screen. */
  onStartOver: () => void;
  /** Re-runs the render with the same plan. */
  onRetry: () => void;
}

function DownloadIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <path d="M12 4v11" />
      <path d="m7 12 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

export default function ResultPlayer({
  job,
  onAnother,
  onStartOver,
  onRetry,
}: ResultPlayerProps): React.JSX.Element {
  const failed = job.progress.stage === "failed" || job.progress.stage === "cancelled";

  if (failed) {
    return (
      <div className="mx-auto w-full max-w-2xl rounded-2xl border border-danger/30 bg-danger/[0.08] p-6 text-center sm:p-8">
        <h2 className="text-xl font-semibold sm:text-2xl">
          {job.progress.stage === "cancelled"
            ? "That edit was cancelled"
            : "That edit didn't finish"}
        </h2>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted">
          {job.error ?? job.progress.message ?? "Something went wrong while rendering."}
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={onRetry}
            className="min-h-[52px] rounded-2xl bg-accent px-6 text-base font-semibold text-white transition-colors duration-200 hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={onStartOver}
            className="min-h-[52px] rounded-2xl border border-line px-6 text-base font-medium text-fg/85 transition-colors duration-200 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
          >
            Start over
          </button>
        </div>
      </div>
    );
  }

  const outputUrl = job.outputUrl ?? `/api/jobs/${job.id}/output`;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="text-center">
        <h2 className="text-2xl font-semibold sm:text-3xl">Your edit is ready</h2>
        <p className="mt-2 text-sm text-muted">
          Have a watch, then download it or ask for another cut.
        </p>
      </div>

      <div className="mt-6 overflow-hidden rounded-2xl border border-line bg-panel p-2 sm:p-3">
        <video
          key={outputUrl}
          controls
          autoPlay
          muted
          playsInline
          src={outputUrl}
          className="w-full rounded-xl bg-black"
        />
      </div>

      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <a
          href={outputUrl}
          download={`editai-${job.id}.mp4`}
          className="flex min-h-[56px] flex-1 items-center justify-center gap-2 rounded-2xl bg-accent px-6 text-base font-semibold text-white transition-colors duration-200 hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
        >
          <DownloadIcon />
          Download
        </a>
        <button
          type="button"
          onClick={onAnother}
          className="min-h-[56px] rounded-2xl border border-line px-6 text-base font-medium text-fg/85 transition-colors duration-200 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
        >
          Make another edit
        </button>
      </div>

      <div className="mt-3 text-center">
        <button
          type="button"
          onClick={onStartOver}
          className="min-h-[44px] rounded-full px-4 text-sm text-muted transition-colors duration-200 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
        >
          Start over with a different video
        </button>
      </div>
    </div>
  );
}

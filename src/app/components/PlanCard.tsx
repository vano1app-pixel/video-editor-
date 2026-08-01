"use client";

import type { AspectRatio, Clip, EditPlan } from "@/lib/types";

export interface PlanCardProps {
  plan: EditPlan;
  /** True while the render request is in flight. */
  starting: boolean;
  errorMessage: string | null;
  onStart: () => void;
  /** Puts the cursor back in the composer so the user can ask for a tweak. */
  onChange: () => void;
}

const ASPECT_LABELS: Record<AspectRatio, string> = {
  "16:9": "Wide 16:9",
  "9:16": "Tall 9:16",
  "1:1": "Square 1:1",
  "4:5": "Portrait 4:5",
  source: "Original shape",
};

/** Output length of one clip in seconds, honouring the renderer's speed clamp. */
function clipOutputSeconds(clip: Clip): number {
  const raw = Math.max(0, clip.sourceEnd - clip.sourceStart);
  const speed = Math.min(4, Math.max(0.5, clip.speedFactor ?? 1));
  return raw / speed;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function Badge({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-full border border-line bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-fg/85">
      {children}
    </span>
  );
}

export default function PlanCard({
  plan,
  starting,
  errorMessage,
  onStart,
  onChange,
}: PlanCardProps): React.JSX.Element {
  const durations = plan.clips.map(clipOutputSeconds);
  const totalSeconds = durations.reduce((sum, value) => sum + value, 0);
  const hasTimeline = plan.clips.length > 0 && totalSeconds > 0;

  return (
    <div className="rounded-2xl border border-accent/30 bg-accent/[0.06] p-4 sm:p-5">
      <h2 className="text-lg font-semibold">{plan.title ?? "Your edit"}</h2>

      {plan.summary ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">
          {plan.summary}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Badge>{formatDuration(totalSeconds)} final</Badge>
        <Badge>
          {plan.clips.length} {plan.clips.length === 1 ? "clip" : "clips"}
        </Badge>
        <Badge>{ASPECT_LABELS[plan.aspectRatio]}</Badge>
        <Badge>{plan.captions.enabled ? "Captions on" : "Captions off"}</Badge>
        {plan.music.enabled ? <Badge>Music</Badge> : null}
      </div>

      <div className="mt-4">
        <div
          className="flex h-10 w-full gap-[2px] overflow-hidden rounded-lg bg-white/[0.05] p-[3px]"
          role="img"
          aria-label={`Timeline with ${plan.clips.length} clips, ${formatDuration(
            totalSeconds,
          )} total`}
        >
          {hasTimeline ? (
            plan.clips.map((clip, index) => (
              <div
                key={`clip-${index}-${clip.sourceStart}-${clip.sourceEnd}`}
                title={
                  clip.reason ??
                  `${clip.sourceStart.toFixed(1)}s - ${clip.sourceEnd.toFixed(1)}s`
                }
                style={{ flexGrow: Math.max(durations[index], 0.01), flexBasis: 0 }}
                className="h-full min-w-[3px] rounded-[5px] bg-accent"
              />
            ))
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-muted">
              No clips yet
            </div>
          )}
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-muted tabular-nums">
          <span>0s</span>
          <span>{formatClock(totalSeconds)}</span>
        </div>
      </div>

      {errorMessage !== null ? (
        <p className="mt-4 rounded-xl border border-danger/30 bg-danger/[0.08] p-3 text-sm text-fg">
          {errorMessage}
        </p>
      ) : null}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          className="min-h-[52px] flex-1 rounded-2xl bg-accent px-6 text-base font-semibold text-white transition-colors duration-200 hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:cursor-not-allowed disabled:opacity-60"
        >
          {starting ? "Starting…" : "✂️ Edit my video"}
        </button>
        <button
          type="button"
          onClick={onChange}
          disabled={starting}
          className="min-h-[52px] rounded-2xl border border-line px-6 text-base font-medium text-fg/85 transition-colors duration-200 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-60"
        >
          Change something
        </button>
      </div>
    </div>
  );
}

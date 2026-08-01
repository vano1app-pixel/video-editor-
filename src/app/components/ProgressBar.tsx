"use client";

import clsx from "clsx";

export interface ProgressBarProps {
  /** 0..1. Values outside the range are clamped; NaN is treated as 0. */
  value: number;
  /** Accessible name, e.g. "Upload progress". */
  label?: string;
  className?: string;
  /** Slightly taller bar for the hero/rendering screens. */
  size?: "sm" | "md";
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export default function ProgressBar({
  value,
  label,
  className,
  size = "sm",
}: ProgressBarProps): React.JSX.Element {
  const pct = Math.round(clampFraction(value) * 1000) / 10;

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={label ?? "Progress"}
      className={clsx(
        "w-full overflow-hidden rounded-full bg-white/[0.08]",
        size === "md" ? "h-3" : "h-2",
        className,
      )}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

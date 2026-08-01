"use client";

import { useCallback, useRef, useState } from "react";
import clsx from "clsx";

import { LENGTH_PRESETS } from "@/lib/types";
import type {
  ApiError,
  AspectRatio,
  Brief,
  LengthPreset,
  UploadResponse,
} from "@/lib/types";

const LENGTH_OPTIONS: ReadonlyArray<{ value: LengthPreset; label: string }> = [
  { value: "short", label: "Under 20s" },
  { value: "medium", label: "About 50s" },
  { value: "long", label: "Full length" },
];

const SHAPE_OPTIONS: ReadonlyArray<{ value: AspectRatio | null; label: string }> = [
  { value: null, label: "Auto" },
  { value: "16:9", label: "Wide 16:9" },
  { value: "9:16", label: "Tall 9:16" },
  { value: "1:1", label: "Square 1:1" },
];

const AUDIO_ACCEPT = "audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac";

export interface BriefBarProps {
  brief: Brief;
  /** Local caption preference — the planner picks the final style. */
  captionsOn: boolean;
  /** Display name of the attached music track, if any. */
  musicName: string | null;
  onBriefChange: (patch: Partial<Brief>) => void;
  onCaptionsChange: (on: boolean) => void;
  onMusicChange: (sourceId: string | null, name: string | null) => void;
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
      className="h-3.5 w-3.5"
    >
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </svg>
  );
}

function Pill({
  selected,
  label,
  title,
  onClick,
  disabled,
}: {
  selected: boolean;
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "min-h-[44px] rounded-full px-4 text-sm font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-50",
        selected
          ? "bg-accent text-white"
          : "border border-line bg-white/[0.03] text-fg/80 hover:bg-white/[0.08]",
      )}
    >
      {label}
    </button>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <p className="text-sm font-semibold">{label}</p>
      <div className="mt-2 flex flex-wrap gap-2">{children}</div>
      <p className="mt-2 text-xs text-muted">{hint}</p>
    </div>
  );
}

export default function BriefBar({
  brief,
  captionsOn,
  musicName,
  onBriefChange,
  onCaptionsChange,
  onMusicChange,
}: BriefBarProps): React.JSX.Element {
  const musicInputRef = useRef<HTMLInputElement | null>(null);
  const [musicUploading, setMusicUploading] = useState(false);
  const [musicError, setMusicError] = useState<string | null>(null);

  const uploadMusic = useCallback(
    async (file: File) => {
      setMusicUploading(true);
      setMusicError(null);
      try {
        const res = await fetch(
          `/api/upload?filename=${encodeURIComponent(file.name)}&kind=audio`,
          { method: "POST", body: file },
        );
        if (!res.ok) {
          let message = `Couldn't add that track (${res.status}).`;
          try {
            const body = (await res.json()) as Partial<ApiError>;
            if (typeof body.error === "string" && body.error.trim() !== "") {
              message = body.error;
            }
          } catch {
            // Non-JSON error body — keep the generic message.
          }
          setMusicError(message);
          return;
        }
        const body = (await res.json()) as Partial<UploadResponse>;
        if (!body.source) {
          setMusicError("Couldn't add that track. Please try another file.");
          return;
        }
        onMusicChange(body.source.id, body.source.originalName);
      } catch {
        setMusicError("Your connection dropped while adding the music.");
      } finally {
        setMusicUploading(false);
      }
    },
    [onMusicChange],
  );

  return (
    <section
      aria-label="Edit settings"
      className="rounded-2xl border border-line bg-panel p-5 sm:p-6"
    >
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <Row label="How long?" hint="Short clips work best for TikTok and Reels.">
          {LENGTH_OPTIONS.map((option) => (
            <Pill
              key={option.value}
              label={option.label}
              title={LENGTH_PRESETS[option.value].label}
              selected={brief.lengthPreset === option.value}
              onClick={() =>
                onBriefChange({
                  lengthPreset:
                    brief.lengthPreset === option.value ? null : option.value,
                })
              }
            />
          ))}
        </Row>

        <Row label="Shape?" hint="Tall for phones, wide for YouTube.">
          {SHAPE_OPTIONS.map((option) => (
            <Pill
              key={option.value ?? "auto"}
              label={option.label}
              selected={brief.aspectRatio === option.value}
              onClick={() => onBriefChange({ aspectRatio: option.value })}
            />
          ))}
        </Row>

        <Row label="Captions?" hint="Big readable subtitles burned into the video.">
          <Pill
            label="On"
            selected={captionsOn}
            onClick={() => onCaptionsChange(true)}
          />
          <Pill
            label="Off"
            selected={!captionsOn}
            onClick={() => onCaptionsChange(false)}
          />
        </Row>
      </div>

      <div className="mt-5 border-t border-line pt-4">
        {musicName !== null && brief.musicSourceId !== null ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex max-w-full items-center gap-2 rounded-full bg-accent/15 px-3 py-2 text-sm text-fg">
              <span className="truncate">♪ {musicName}</span>
              <button
                type="button"
                aria-label="Remove music"
                onClick={() => {
                  setMusicError(null);
                  onMusicChange(null, null);
                }}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-200 hover:bg-white/10 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <XIcon />
              </button>
            </span>
          </div>
        ) : (
          <button
            type="button"
            disabled={musicUploading}
            onClick={() => musicInputRef.current?.click()}
            className="min-h-[44px] rounded-full px-3 text-sm font-medium text-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-60"
          >
            {musicUploading ? "Adding music…" : "+ Add music (optional)"}
          </button>
        )}

        {musicError !== null ? (
          <p className="mt-2 text-xs text-danger">{musicError}</p>
        ) : null}

        <input
          ref={musicInputRef}
          type="file"
          accept={AUDIO_ACCEPT}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.item(0);
            event.target.value = "";
            if (file) void uploadMusic(file);
          }}
        />
      </div>
    </section>
  );
}

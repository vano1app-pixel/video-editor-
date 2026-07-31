/**
 * Shared contracts for the whole app.
 *
 * Every module — ffmpeg pipeline, transcriber, AI planner, renderer, API routes,
 * and the UI — imports its types from here. Nothing else defines these shapes.
 */

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export interface MediaInfo {
  /** Absolute path on disk to the source file. */
  path: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  sizeBytes: number;
  /** Rotation metadata in degrees (0/90/180/270). Phone footage is often 90. */
  rotation: number;
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

export interface Word {
  text: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface Transcript {
  language: string;
  /** Full plain-text transcript. */
  text: string;
  segments: TranscriptSegment[];
  /** Flattened word list across all segments, in time order. */
  words: Word[];
  /** Which provider produced this. */
  provider: TranscriptionProviderName;
}

export type TranscriptionProviderName = "openai" | "local" | "none";

export interface TranscriptionProvider {
  name: TranscriptionProviderName;
  /** True when the provider has everything it needs (API key, binary, model). */
  isAvailable(): Promise<boolean>;
  transcribe(audioPath: string, opts?: { language?: string }): Promise<Transcript>;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface Scene {
  start: number;
  end: number;
  /** ffmpeg scene-change score at the cut that opened this scene (0..1). */
  score: number;
}

/** A stretch of audio below the silence threshold. */
export interface SilenceRange {
  start: number;
  end: number;
}

export interface Analysis {
  media: MediaInfo;
  transcript: Transcript | null;
  scenes: Scene[];
  silences: SilenceRange[];
}

// ---------------------------------------------------------------------------
// Edit plan — the AI's output and the renderer's input
// ---------------------------------------------------------------------------

export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:5" | "source";

export type LengthPreset = "short" | "medium" | "long";

/** Target windows for each preset, in seconds. */
export const LENGTH_PRESETS: Record<
  LengthPreset,
  { label: string; minSec: number; maxSec: number; defaultSec: number }
> = {
  short: { label: "Short (under 20s)", minSec: 5, maxSec: 20, defaultSec: 15 },
  medium: { label: "Medium (~50s)", minSec: 20, maxSec: 70, defaultSec: 50 },
  long: { label: "Long form", minSec: 70, maxSec: 3600, defaultSec: 180 },
};

/** One kept span of the source timeline. Clips render in array order. */
export interface Clip {
  sourceStart: number;
  sourceEnd: number;
  /** Short human-readable justification from the planner. Shown in the UI. */
  reason?: string;
  /** 1 = realtime. 1.5 = 1.5x faster. Clamped to [0.5, 4] by the renderer. */
  speedFactor?: number;
}

export type CaptionPreset = "karaoke" | "block" | "minimal" | "none";

export interface CaptionStyle {
  enabled: boolean;
  preset: CaptionPreset;
  fontFamily: string;
  /** Font size as a percentage of output height, so it scales with resolution. */
  fontSizePct: number;
  /** "#RRGGBB" */
  primaryColor: string;
  /** "#RRGGBB" — active word colour in karaoke mode. */
  highlightColor: string;
  outlineColor: string;
  position: "top" | "center" | "bottom";
  maxWordsPerLine: number;
  uppercase: boolean;
}

/** A Ken Burns style punch-in over a time range of the OUTPUT timeline. */
export interface ZoomEffect {
  start: number;
  end: number;
  fromScale: number;
  toScale: number;
  /** Focus point in normalised output coords, 0..1. Centre is 0.5/0.5. */
  focusX: number;
  focusY: number;
}

export type TransitionType = "cut" | "fade" | "dissolve" | "whip";

export interface TransitionSpec {
  /** Transition happens entering the clip at this index (>=1). */
  atClipIndex: number;
  type: TransitionType;
  durationSec: number;
}

export interface MusicSpec {
  enabled: boolean;
  /** Id of a bundled track from MUSIC_LIBRARY, or null when using `url`. */
  trackId: string | null;
  /** Absolute path or URL to a user-supplied track. */
  url: string | null;
  /** Music bed level in dB relative to source, e.g. -18. */
  volumeDb: number;
  /** Extra attenuation applied while speech is present, e.g. -10. */
  duckDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}

export interface SilenceRemovalSpec {
  enabled: boolean;
  /** Noise floor in dB, e.g. -34. */
  thresholdDb: number;
  /** Only cut silences longer than this. */
  minSilenceSec: number;
  /** Breathing room kept on each side of a cut. */
  paddingSec: number;
}

export interface FillerRemovalSpec {
  enabled: boolean;
  words: string[];
}

export interface EditPlan {
  version: 1;
  jobId: string;
  sourceId: string;
  lengthPreset: LengthPreset;
  targetDurationSec: number;
  aspectRatio: AspectRatio;
  resolution: { width: number; height: number };
  clips: Clip[];
  captions: CaptionStyle;
  zooms: ZoomEffect[];
  transitions: TransitionSpec[];
  music: MusicSpec;
  removeSilence: SilenceRemovalSpec;
  removeFillers: FillerRemovalSpec;
  title?: string;
  /** One-paragraph description of the edit, shown to the user. */
  summary?: string;
}

export const DEFAULT_FILLER_WORDS = [
  "um",
  "uh",
  "erm",
  "ah",
  "like",
  "you know",
  "i mean",
  "sort of",
  "kind of",
  "basically",
  "actually",
  "literally",
  "right",
  "so yeah",
];

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type JobStage =
  | "queued"
  | "probing"
  | "extracting_audio"
  | "transcribing"
  | "analyzing"
  | "planning"
  | "rendering"
  | "done"
  | "failed"
  | "cancelled";

export const JOB_STAGE_LABELS: Record<JobStage, string> = {
  queued: "Queued",
  probing: "Reading video",
  extracting_audio: "Extracting audio",
  transcribing: "Transcribing",
  analyzing: "Finding scenes and silences",
  planning: "AI planning the edit",
  rendering: "Rendering",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export interface JobProgress {
  stage: JobStage;
  /** 0..1 across the whole pipeline. */
  overall: number;
  /** 0..1 within the current stage. */
  stageProgress: number;
  message: string;
}

export interface Job {
  id: string;
  sourceId: string;
  createdAt: number;
  updatedAt: number;
  progress: JobProgress;
  /** The user's request in their own words, plus answers to clarifiers. */
  brief: Brief;
  media: MediaInfo | null;
  transcript: Transcript | null;
  scenes: Scene[];
  silences: SilenceRange[];
  plan: EditPlan | null;
  /** Absolute path to the rendered file, once rendering succeeds. */
  outputPath: string | null;
  /** URL the browser can fetch the render from. */
  outputUrl: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Sources (uploaded or Drive-imported media)
// ---------------------------------------------------------------------------

export type SourceOrigin = "upload" | "drive";

export interface Source {
  id: string;
  origin: SourceOrigin;
  originalName: string;
  /** Absolute path on disk. */
  path: string;
  sizeBytes: number;
  createdAt: number;
  media: MediaInfo | null;
  /** URL the browser can use to preview the original. */
  url: string;
}

// ---------------------------------------------------------------------------
// Chat / briefing
// ---------------------------------------------------------------------------

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
}

export type QuestionKind = "single" | "multi" | "text";

/** A clarifying question the planner asks before it commits to an edit. */
export interface ClarifyingQuestion {
  id: string;
  question: string;
  kind: QuestionKind;
  /** Suggested answers. Empty for `text` questions. */
  options: string[];
  /** Why the planner needs this — shown as helper text. */
  rationale?: string;
}

export interface Answer {
  questionId: string;
  /** Free text, or the chosen option label(s) joined by ", ". */
  value: string;
}

/** Everything the planner knows about what the user wants. */
export interface Brief {
  /** The user's original free-text request. */
  request: string;
  answers: Answer[];
  /** Locked-in choices the user made in the UI, which override AI inference. */
  lengthPreset: LengthPreset | null;
  targetDurationSec: number | null;
  aspectRatio: AspectRatio | null;
  /** Source id of an uploaded music track, when the user attached one. */
  musicSourceId: string | null;
}

export function emptyBrief(request = ""): Brief {
  return {
    request,
    answers: [],
    lengthPreset: null,
    targetDurationSec: null,
    aspectRatio: null,
    musicSourceId: null,
  };
}

/**
 * One turn of the planner conversation. The planner either asks for more
 * information or declares itself ready and emits a plan.
 */
export interface PlannerTurn {
  /** What to say to the user. */
  reply: string;
  /** Non-empty when the planner still needs input. */
  questions: ClarifyingQuestion[];
  /** True once the planner has enough to render. */
  ready: boolean;
  /** Present iff `ready` is true. */
  plan: EditPlan | null;
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export interface UploadResponse {
  source: Source;
}

export interface ChatRequest {
  sourceId: string;
  messages: ChatMessage[];
  brief: Brief;
}

export interface ChatResponse {
  turn: PlannerTurn;
}

export interface CreateJobRequest {
  sourceId: string;
  brief: Brief;
  /** Skip the planner and render this plan verbatim. */
  plan?: EditPlan;
}

export interface CreateJobResponse {
  job: Job;
}

export interface ApiError {
  error: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Bundled music
// ---------------------------------------------------------------------------

export interface MusicTrack {
  id: string;
  name: string;
  mood: string;
  bpm: number;
  /** Path relative to the public directory. */
  file: string;
}

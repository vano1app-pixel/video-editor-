/**
 * Hand-written JSON schema for the planner's structured output.
 *
 * Constraints imposed by the structured-output API:
 * - every object carries `additionalProperties: false`
 * - every object's `required` lists ALL of its properties
 * - no minimum/maximum/minLength/pattern keywords
 * - no recursion
 * - optionality is expressed as type unions like ["string", "null"]
 *
 * The plan sub-schema mirrors EditPlan from "@/lib/types", minus
 * version/jobId/sourceId which sanitizePlan() fills server-side.
 */

const CLIP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sourceStart", "sourceEnd", "reason", "speedFactor"],
  properties: {
    sourceStart: {
      type: "number",
      description: "Seconds into the SOURCE video where this kept span starts.",
    },
    sourceEnd: {
      type: "number",
      description:
        "Seconds into the SOURCE video where this kept span ends. Must be greater than sourceStart and within the media duration.",
    },
    reason: {
      type: ["string", "null"],
      description:
        "One short sentence explaining why this moment made the cut. Shown in the UI.",
    },
    speedFactor: {
      type: ["number", "null"],
      description:
        "Playback speed for this clip. null or 1 = realtime; 1.5 = 50% faster. Useful range 0.5-4.",
    },
  },
};

const CAPTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "enabled",
    "preset",
    "fontFamily",
    "fontSizePct",
    "primaryColor",
    "highlightColor",
    "outlineColor",
    "position",
    "maxWordsPerLine",
    "uppercase",
  ],
  properties: {
    enabled: { type: "boolean" },
    preset: {
      type: "string",
      enum: ["karaoke", "block", "minimal", "none"],
      description:
        'Use "karaoke" for short/medium vertical output, "block" for long-form or 16:9, "none" when there is no transcript.',
    },
    fontFamily: { type: "string" },
    fontSizePct: {
      type: "number",
      description: "Font size as a percentage of output height, e.g. 4.5.",
    },
    primaryColor: { type: "string", description: '"#RRGGBB", e.g. "#FFFFFF".' },
    highlightColor: {
      type: "string",
      description: '"#RRGGBB" active-word colour in karaoke mode, e.g. "#FFD400".',
    },
    outlineColor: { type: "string", description: '"#RRGGBB", e.g. "#000000".' },
    position: { type: "string", enum: ["top", "center", "bottom"] },
    maxWordsPerLine: { type: "integer" },
    uppercase: { type: "boolean" },
  },
};

const ZOOM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["start", "end", "fromScale", "toScale", "focusX", "focusY"],
  properties: {
    start: {
      type: "number",
      description: "Seconds on the OUTPUT timeline (after cutting) where the punch-in starts.",
    },
    end: {
      type: "number",
      description: "Seconds on the OUTPUT timeline where the punch-in ends.",
    },
    fromScale: { type: "number", description: "Starting zoom scale, usually 1.0." },
    toScale: { type: "number", description: "Ending zoom scale, usually 1.12 for a subtle punch-in." },
    focusX: { type: "number", description: "Focus point X in normalised 0..1 output coords. Centre is 0.5." },
    focusY: { type: "number", description: "Focus point Y in normalised 0..1 output coords. Centre is 0.5." },
  },
};

const TRANSITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["atClipIndex", "type", "durationSec"],
  properties: {
    atClipIndex: {
      type: "integer",
      description: "The transition plays entering the clip at this index (must be >= 1).",
    },
    type: { type: "string", enum: ["cut", "fade", "dissolve", "whip"] },
    durationSec: { type: "number", description: "Transition duration in seconds, e.g. 0.3." },
  },
};

const MUSIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "trackId", "url", "volumeDb", "duckDb", "fadeInSec", "fadeOutSec"],
  properties: {
    enabled: {
      type: "boolean",
      description: "true ONLY when the context block says a music track is attached.",
    },
    trackId: { type: ["string", "null"], description: "Id of a bundled track, or null." },
    url: { type: ["string", "null"], description: "User-supplied track path/URL, or null." },
    volumeDb: { type: "number", description: "Music bed level in dB relative to source, e.g. -18." },
    duckDb: { type: "number", description: "Extra attenuation while speech is present, e.g. -10." },
    fadeInSec: { type: "number" },
    fadeOutSec: { type: "number" },
  },
};

const REMOVE_SILENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "thresholdDb", "minSilenceSec", "paddingSec"],
  properties: {
    enabled: { type: "boolean", description: "Default true." },
    thresholdDb: { type: "number", description: "Noise floor in dB, default -34." },
    minSilenceSec: { type: "number", description: "Only cut silences longer than this, default 0.6." },
    paddingSec: { type: "number", description: "Breathing room kept on each side of a cut, default 0.12." },
  },
};

const REMOVE_FILLERS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "words"],
  properties: {
    enabled: { type: "boolean", description: "Default true." },
    words: { type: "array", items: { type: "string" }, description: "Filler words to remove." },
  },
};

const PLAN_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  required: [
    "lengthPreset",
    "targetDurationSec",
    "aspectRatio",
    "resolution",
    "clips",
    "captions",
    "zooms",
    "transitions",
    "music",
    "removeSilence",
    "removeFillers",
    "title",
    "summary",
  ],
  description: "The complete edit plan. MUST be null while ready is false.",
  properties: {
    lengthPreset: { type: "string", enum: ["short", "medium", "long"] },
    targetDurationSec: {
      type: "number",
      description: "Target output duration in seconds, inside the preset window.",
    },
    aspectRatio: { type: "string", enum: ["16:9", "9:16", "1:1", "4:5", "source"] },
    resolution: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height"],
      properties: {
        width: { type: "integer", description: "Output width in pixels (even)." },
        height: { type: "integer", description: "Output height in pixels (even)." },
      },
    },
    clips: {
      type: "array",
      items: CLIP_SCHEMA,
      description: "Kept spans of the source timeline, rendered in array order. Hook first.",
    },
    captions: CAPTIONS_SCHEMA,
    zooms: { type: "array", items: ZOOM_SCHEMA },
    transitions: {
      type: "array",
      items: TRANSITION_SCHEMA,
      description: "Usually empty (hard cuts). At most one fade when tone calls for it.",
    },
    music: MUSIC_SCHEMA,
    removeSilence: REMOVE_SILENCE_SCHEMA,
    removeFillers: REMOVE_FILLERS_SCHEMA,
    title: { type: ["string", "null"], description: "Short title for the edit, or null." },
    summary: {
      type: ["string", "null"],
      description: "One-paragraph description of the edit, shown to the user. null if not ready.",
    },
  },
};

/** Schema for one full planner turn: reply + questions or a finished plan. */
export const PLANNER_TURN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "ready", "questions", "plan"],
  properties: {
    reply: {
      type: "string",
      description: "Short, friendly message shown to the user. When ready, 2-3 sentences summarising the edit.",
    },
    ready: {
      type: "boolean",
      description: "true only when plan is complete and no more input is needed.",
    },
    questions: {
      type: "array",
      description: "Clarifying questions. MUST be [] when ready is true. At most 3.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "question", "kind", "options", "rationale"],
        properties: {
          id: { type: "string", description: 'Stable id like "q1".' },
          question: { type: "string" },
          kind: { type: "string", enum: ["single", "multi", "text"] },
          options: {
            type: "array",
            items: { type: "string" },
            description: '2-6 clickable suggested answers. [] only for kind "text".',
          },
          rationale: {
            type: ["string", "null"],
            description: "Why the planner needs this. Shown as helper text.",
          },
        },
      },
    },
    plan: PLAN_SCHEMA,
  },
};

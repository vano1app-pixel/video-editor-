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
 * KEEP THIS SCHEMA SMALL. The API compiles it into a decoding grammar and
 * rejects the request outright once that grammar gets too large:
 *
 *   400 invalid_request_error — "The compiled grammar is too large, which
 *   would cause performance issues. Simplify your tool schemas..."
 *
 * The first version asked the model for every field of EditPlan — caption
 * colours, font size, dB levels, fade times, per-cut transition objects — and
 * tripped that limit on the very first real call. So the rule here is: the
 * model only chooses what is genuinely a creative decision. Everything else
 * has a sensible default that sanitizePlan() fills in, and asking a model to
 * pick an outline colour nobody mentioned is a worse edit anyway, not a better
 * one. sanitizePlan treats every field as optional, so trimming a property
 * here needs no change there.
 */

const CLIP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sourceStart", "sourceEnd", "reason"],
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
  },
};

/**
 * Captions: on/off and which look. Colours, font, size and position are
 * styling defaults, not editorial choices — sanitizePlan supplies them.
 */
const CAPTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "preset"],
  properties: {
    enabled: {
      type: "boolean",
      description:
        "Burn subtitles into the video. Only true when a transcript exists.",
    },
    preset: {
      type: "string",
      enum: ["karaoke", "block", "minimal", "none"],
      description:
        'Caption look. "karaoke" highlights each word as it is spoken and suits short social clips.',
    },
  },
};

/** A single toggle. Levels, fades and thresholds are defaulted server-side. */
const ENABLED_ONLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
  },
};

const PLAN_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  required: [
    "lengthPreset",
    "targetDurationSec",
    "aspectRatio",
    "clips",
    "captions",
    "transitionStyle",
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
    aspectRatio: {
      type: "string",
      enum: ["16:9", "9:16", "1:1", "4:5", "source"],
    },
    clips: {
      type: "array",
      items: CLIP_SCHEMA,
      description:
        "Kept spans of the source timeline, rendered in array order. Strongest moment first.",
    },
    captions: CAPTIONS_SCHEMA,
    /**
     * One style for every join, rather than an array of per-cut objects. A
     * mixed bag of transitions across a single short clip looks amateurish,
     * and collapsing this to one enum is a large chunk of the grammar saved.
     */
    transitionStyle: {
      type: "string",
      enum: ["cut", "fade", "dissolve", "whip"],
      description:
        'How to join clips. "cut" (hard cuts) is right for most short social edits.',
    },
    music: ENABLED_ONLY_SCHEMA,
    removeSilence: ENABLED_ONLY_SCHEMA,
    removeFillers: ENABLED_ONLY_SCHEMA,
    title: {
      type: ["string", "null"],
      description: "Short title for the edit, or null.",
    },
    summary: {
      type: ["string", "null"],
      description:
        "One-paragraph description of the edit, shown to the user. null if not ready.",
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
      description:
        "Short, friendly message shown to the user. When ready, 2-3 sentences summarising the edit.",
    },
    ready: {
      type: "boolean",
      description: "true only when plan is complete and no more input is needed.",
    },
    questions: {
      type: "array",
      description:
        "Clarifying questions. MUST be [] when ready is true. At most 3.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "question", "kind", "options"],
        properties: {
          id: { type: "string", description: 'Stable id like "q1".' },
          question: { type: "string" },
          kind: { type: "string", enum: ["single", "multi", "text"] },
          options: {
            type: "array",
            items: { type: "string" },
            description:
              '2-6 clickable suggested answers. [] only for kind "text".',
          },
        },
      },
    },
    plan: PLAN_SCHEMA,
  },
};
